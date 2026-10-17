/**
 * Search-facing reranking: cache, time budget and background model loading on top
 * of a LocalReranker.
 *
 * rerank() never makes a search wait for a download: when the model is not loaded
 * yet it starts loading in the background and reports 'loading', so callers keep
 * their first-pass order. When scoring exceeds the time budget the caller also keeps
 * its first-pass order, but the work continues in the worker and fills the score
 * cache, so the same query (next keystroke, streaming phase, reopening) is instant.
 */

import { LruCache } from '../lru-cache';
import { isAbortError, withAbortAndTimeout } from '../providers/abort-utils';
import type { ProviderStatus, ProviderStatusListener } from '../providers/types';
import { generateContentHash } from '../../../utils/hash';
import { logger } from '../../../utils/logger';
import type { LocalReranker, RerankerLoadInfo } from './local-reranker';
import { sigmoid } from './rerank-blend';

/** Hard budget for scoring during a search (model already loaded). */
export const RERANK_TIME_BUDGET_MS = 1500;

const SCORE_CACHE_MAX_SIZE = 2000;

export interface RerankCandidate {
    /** Stable id of the result (file path). */
    id: string;
    passage: string;
}

export type RerankStatus = 'applied' | 'loading' | 'timeout' | 'aborted' | 'error' | 'disabled';

export interface RerankOutcome {
    status: RerankStatus;
    /** Raw logits by candidate id (complete when status is 'applied'). */
    scores: Map<string, number>;
    elapsedMs: number;
}

export interface RerankTestResult {
    load: RerankerLoadInfo;
    /** Relevance probability of a matching and an unrelated passage for a sample query. */
    relevantScore: number;
    irrelevantScore: number;
    inferenceMs: number;
}

export interface RerankServiceOptions {
    topK: number;
    timeBudgetMs?: number;
}

interface BackgroundJob {
    query: string;
    controller: AbortController;
}

export class RerankService {
    private readonly cache = new LruCache<string, number>(SCORE_CACHE_MAX_SIZE);

    private topK: number;

    private readonly timeBudgetMs: number;

    /** Scoring that outlived its budget and keeps filling the cache for its query. */
    private backgroundJob?: BackgroundJob;

    private disposed = false;

    constructor(private readonly reranker: LocalReranker, options: RerankServiceOptions) {
        this.topK = options.topK;
        this.timeBudgetMs = options.timeBudgetMs ?? RERANK_TIME_BUDGET_MS;
    }

    get label(): string {
        return this.reranker.label;
    }

    getTopK(): number {
        return this.topK;
    }

    setTopK(topK: number): void {
        this.topK = Math.max(1, Math.round(topK));
    }

    isReady(): boolean {
        return !this.disposed && this.reranker.isReady();
    }

    getStatus(): ProviderStatus {
        return this.reranker.getStatus();
    }

    onStatusChange(listener: ProviderStatusListener): () => void {
        return this.reranker.onStatusChange(listener);
    }

    /** Start loading the model in the background (no-op when loaded or loading). */
    warmup(): void {
        if (this.disposed || this.reranker.isReady() || this.reranker.isLoading()) {
            return;
        }
        this.reranker.load().catch((error) => {
            logger.debug('Reranker: Background load failed', error);
        });
    }

    /**
     * Score candidates against the query within the time budget. Callers rerank only
     * when status is 'applied'; otherwise they keep their first-pass order.
     */
    async rerank(query: string, candidates: RerankCandidate[], options: { signal?: AbortSignal } = {}): Promise<RerankOutcome> {
        const start = Date.now();
        const outcome = (status: RerankStatus, scores = new Map<string, number>()): RerankOutcome => ({
            status, scores, elapsedMs: Date.now() - start,
        });

        if (this.disposed) {
            return outcome('disabled');
        }
        if (options.signal?.aborted) {
            return outcome('aborted');
        }
        if (!this.reranker.isReady()) {
            this.warmup();
            return outcome('loading');
        }

        const scores = new Map<string, number>();
        const missing: Array<{ candidate: RerankCandidate; key: string }> = [];
        candidates.forEach((candidate) => {
            const key = this.cacheKey(query, candidate);
            const cached = this.cache.get(key);
            if (cached === undefined) {
                missing.push({ candidate, key });
            } else {
                scores.set(candidate.id, cached);
            }
        });
        if (missing.length === 0) {
            return outcome('applied', scores);
        }

        // Work for an older query is useless now; free the worker for this one.
        if (this.backgroundJob && this.backgroundJob.query !== query) {
            this.backgroundJob.controller.abort();
            this.backgroundJob = undefined;
        }

        const controller = new AbortController();
        const onCallerAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onCallerAbort, { once: true });

        const job = this.reranker.score(query, missing.map((entry) => entry.candidate.passage), { signal: controller.signal })
            .then((result) => {
                missing.forEach((entry, index) => {
                    this.cache.set(entry.key, result.scores[index] ?? 0);
                });
                logger.debug(`Reranker: Scored ${missing.length} passages in ${result.inferenceMs}ms`);
                return result;
            });
        // Late failures of background work are expected (aborts, shutdown).
        job.catch(() => undefined);

        try {
            const result = await withAbortAndTimeout(job, this.timeBudgetMs, options.signal, 'Rerank time budget exceeded');
            missing.forEach((entry, index) => scores.set(entry.candidate.id, result.scores[index] ?? 0));
            return outcome('applied', scores);
        } catch (error) {
            if (isAbortError(error) || options.signal?.aborted) {
                return outcome('aborted');
            }
            if (!controller.signal.aborted && error instanceof Error && error.message === 'Rerank time budget exceeded') {
                logger.debug(`Reranker: Budget of ${this.timeBudgetMs}ms exceeded for ${missing.length} passages; keeping first-pass order`);
                const background: BackgroundJob = { query, controller };
                this.backgroundJob = background;
                job.finally(() => {
                    if (this.backgroundJob === background) {
                        this.backgroundJob = undefined;
                    }
                }).catch(() => undefined);
                return outcome('timeout');
            }
            logger.warn('Reranker: Scoring failed; keeping first-pass order', error);
            return outcome('error');
        } finally {
            options.signal?.removeEventListener('abort', onCallerAbort);
        }
    }

    /**
     * Load the model now (downloading on first use) and score a sample pair, for the
     * settings "Download & test" button. Throws when the model cannot be loaded.
     */
    async test(): Promise<RerankTestResult> {
        const load = await this.reranker.load(true);
        const query = 'How do plants produce energy from sunlight?';
        const result = await this.reranker.score(query, [
            'Photosynthesis: plants convert light energy, water and carbon dioxide into glucose and oxygen in their chloroplasts.',
            'The French Revolution began in 1789 with the storming of the Bastille.',
        ]);
        return {
            load,
            relevantScore: sigmoid(result.scores[0] ?? 0),
            irrelevantScore: sigmoid(result.scores[1] ?? 0),
            inferenceMs: result.inferenceMs,
        };
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.backgroundJob?.controller.abort();
        this.backgroundJob = undefined;
        this.cache.clear();
        this.reranker.dispose();
    }

    private cacheKey(query: string, candidate: RerankCandidate): string {
        return `${query}\u0001${candidate.id}\u0001${generateContentHash(candidate.passage)}`;
    }
}
