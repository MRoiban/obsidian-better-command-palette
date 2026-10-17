/**
 * Main-thread client of the reranker Web Worker.
 *
 * - The model loads lazily (first score(), load() or the settings "Download & test").
 * - Score requests run one at a time in the worker, newest work queued behind older work.
 * - An aborted request is rejected immediately; if it is already running, the worker is
 *   told to stop after its current batch.
 */

import type { LocalDeviceSetting, LocalDtype } from '../providers/model-registry';
import type { ProviderStatus, ProviderStatusListener } from '../providers/types';
import { ProviderStatusEmitter } from '../providers/status-emitter';
import { createAbortError, throwIfAborted } from '../providers/abort-utils';
import type { RerankerModelDefinition } from './reranker-registry';
import type {
    RerankerWorkerReadyResponse, RerankerWorkerRequest, RerankerWorkerResponse, RerankerWorkerScoresResponse,
} from './reranker-protocol';
import { logger } from '../../../utils/logger';

export interface LocalRerankerConfig {
    model: RerankerModelDefinition;
    dtype: LocalDtype;
    device: LocalDeviceSetting;
    /** Tokens per (query, passage) input; capped by the model's own limit. */
    maxInputTokens: number;
    /** Reads the onnxruntime WASM binary shipped with the plugin. */
    loadWasmBinary: () => Promise<ArrayBuffer>;
    createWorker: () => Worker;
}

export interface RerankerLoadInfo {
    device: string;
    dtype: LocalDtype;
    loadTimeMs: number;
    fallbackReason?: string;
}

export interface RerankerScoreResult {
    /** Raw relevance logits in passage order. */
    scores: Float32Array;
    inferenceMs: number;
}

/** Pairs per model call. WebGPU benefits from batching; single-threaded WASM barely does. */
const BATCH_SIZE_WEBGPU = 16;
const BATCH_SIZE_WASM = 4;

/** After a failed load, fail fast for this long instead of re-downloading per request. */
const LOAD_RETRY_COOLDOWN_MS = 30000;

interface ScoreJob {
    query: string;
    passages: string[];
    signal?: AbortSignal;
    resolve: (result: RerankerScoreResult) => void;
    reject: (error: unknown) => void;
    settled: boolean;
    requestId?: number;
    removeAbortListener?: () => void;
}

interface PendingRequest {
    resolve: (response: RerankerWorkerResponse) => void;
    reject: (error: Error) => void;
}

function formatMegabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class LocalReranker {
    readonly label: string;

    private readonly config: LocalRerankerConfig;

    private readonly status = new ProviderStatusEmitter({ state: 'idle', message: 'Reranker not loaded yet' });

    private worker?: Worker;

    private ready = false;

    private disposed = false;

    private loadPromise?: Promise<RerankerLoadInfo>;

    private loadInfo?: RerankerLoadInfo;

    private loadFailure?: { at: number; error: Error };

    private nextRequestId = 1;

    private pending = new Map<number, PendingRequest>();

    private jobs: ScoreJob[] = [];

    private running = false;

    constructor(config: LocalRerankerConfig) {
        this.config = config;
        this.label = `${config.model.hfModelId} (${config.dtype})`;
    }

    isReady(): boolean {
        return this.ready && !this.disposed;
    }

    isLoading(): boolean {
        return !!this.loadPromise;
    }

    getLoadInfo(): RerankerLoadInfo | undefined {
        return this.loadInfo;
    }

    getStatus(): ProviderStatus {
        return this.status.get();
    }

    onStatusChange(listener: ProviderStatusListener): () => void {
        return this.status.subscribe(listener);
    }

    /**
     * Load (downloading on first use) the model. `force` retries immediately after a
     * recent failure instead of waiting for the cooldown.
     */
    load(force = false): Promise<RerankerLoadInfo> {
        if (this.disposed) {
            return Promise.reject(createAbortError('Reranker was shut down'));
        }
        if (this.ready && this.loadInfo) {
            return Promise.resolve(this.loadInfo);
        }
        if (this.loadPromise) {
            return this.loadPromise;
        }
        if (!force && this.loadFailure && Date.now() - this.loadFailure.at < LOAD_RETRY_COOLDOWN_MS) {
            return Promise.reject(this.loadFailure.error);
        }

        const run = this.startWorkerModel()
            .then((info) => {
                this.ready = true;
                this.loadInfo = info;
                this.loadFailure = undefined;
                return info;
            })
            .catch((error) => {
                const failure = error instanceof Error ? error : new Error(String(error));
                if (!this.disposed) {
                    this.loadFailure = { at: Date.now(), error: failure };
                    this.terminateWorker(failure);
                    this.status.set({ state: 'error', message: `Reranker failed to load: ${failure.message}` });
                }
                throw failure;
            })
            .finally(() => {
                if (this.loadPromise === run) {
                    this.loadPromise = undefined;
                }
            });
        this.loadPromise = run;
        return run;
    }

    /** Score each passage against the query. Requires (and waits for) the model. */
    score(query: string, passages: string[], options: { signal?: AbortSignal } = {}): Promise<RerankerScoreResult> {
        if (this.disposed) {
            return Promise.reject(createAbortError('Reranker was shut down'));
        }
        throwIfAborted(options.signal);
        if (passages.length === 0) {
            return Promise.resolve({ scores: new Float32Array(0), inferenceMs: 0 });
        }

        return new Promise<RerankerScoreResult>((resolve, reject) => {
            const job: ScoreJob = {
                query,
                passages,
                signal: options.signal,
                resolve,
                reject,
                settled: false,
            };
            if (options.signal) {
                const onAbort = () => this.failJob(job, createAbortError('Rerank request aborted'));
                options.signal.addEventListener('abort', onAbort, { once: true });
                job.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
            }
            this.jobs.push(job);
            void this.pump();
        });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const error = createAbortError('Reranker was shut down');
        [...this.jobs].forEach((job) => this.failJob(job, error));
        this.jobs = [];
        this.terminateWorker(error);
        this.status.set({ state: 'idle', message: 'Reranker shut down' });
        this.status.clear();
    }

    // --- Scheduling ---

    private async pump(): Promise<void> {
        if (this.running || this.disposed || this.jobs.length === 0) {
            return;
        }
        this.running = true;
        try {
            try {
                await this.load();
            } catch (error) {
                [...this.jobs].forEach((job) => this.failJob(job, error));
                this.jobs = [];
                return;
            }

            const job = this.jobs.shift();
            if (!job || job.settled) {
                return;
            }

            const requestId = this.nextRequestId++;
            job.requestId = requestId;
            try {
                const response = await this.sendRequest({
                    type: 'score',
                    requestId,
                    query: job.query,
                    passages: job.passages,
                    batchSize: this.loadInfo?.device === 'webgpu' ? BATCH_SIZE_WEBGPU : BATCH_SIZE_WASM,
                }, requestId) as RerankerWorkerScoresResponse;
                if (response.scores.length !== job.passages.length) {
                    throw new Error(`Reranker returned ${response.scores.length} scores for ${job.passages.length} passages`);
                }
                this.resolveJob(job, { scores: response.scores, inferenceMs: response.inferenceMs });
            } catch (error) {
                this.failJob(job, error);
            }
        } finally {
            this.running = false;
            if (this.jobs.length > 0 && !this.disposed) {
                void this.pump();
            }
        }
    }

    private resolveJob(job: ScoreJob, result: RerankerScoreResult): void {
        if (job.settled) {
            return;
        }
        this.settleJob(job);
        job.resolve(result);
    }

    private failJob(job: ScoreJob, error: unknown): void {
        if (job.settled) {
            return;
        }
        this.settleJob(job);
        const index = this.jobs.indexOf(job);
        if (index !== -1) {
            this.jobs.splice(index, 1);
        }
        // Already running in the worker: stop after the current batch.
        if (job.requestId !== undefined && this.pending.has(job.requestId)) {
            this.postMessage({ type: 'cancel', requestId: job.requestId });
        }
        job.reject(error);
    }

    private settleJob(job: ScoreJob): void {
        job.settled = true;
        job.removeAbortListener?.();
    }

    // --- Worker lifecycle ---

    private async startWorkerModel(): Promise<RerankerLoadInfo> {
        const {
            model, dtype, device, maxInputTokens,
        } = this.config;
        this.status.set({ state: 'loading', message: 'Loading reranker…' });
        logger.info(`Reranker: Loading ${model.hfModelId} (${dtype}, device: ${device})`);

        const wasmBinary = await this.config.loadWasmBinary();
        if (this.disposed) {
            throw createAbortError('Reranker was shut down');
        }

        const override = model.fileOverrides?.[dtype];
        const requestId = this.nextRequestId++;
        const response = await this.sendRequest({
            type: 'init',
            requestId,
            model: {
                hfModelId: model.hfModelId,
                maxTokens: Math.min(model.maxTokens, maxInputTokens),
                modelFileName: override?.fileName,
            },
            device,
            dtype: override?.loadAs ?? dtype,
            wasmBinary,
        }, requestId, [wasmBinary]) as RerankerWorkerReadyResponse;

        let message = `${response.device.toUpperCase()}, ${dtype}`;
        if (response.fallbackReason) {
            logger.warn(`Reranker: ${response.fallbackReason}`);
            message += ` — ${response.fallbackReason}`;
        }
        logger.info(`Reranker: Ready in ${response.loadTimeMs}ms (${message})`);
        this.status.set({ state: 'ready', message: `Ready (${message})`, device: response.device });

        return {
            device: response.device,
            dtype,
            loadTimeMs: response.loadTimeMs,
            fallbackReason: response.fallbackReason,
        };
    }

    private getWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }
        const worker = this.config.createWorker();
        worker.onmessage = (event: MessageEvent<RerankerWorkerResponse>) => this.handleWorkerMessage(event.data);
        worker.onerror = (event: ErrorEvent) => {
            event.preventDefault?.();
            const error = new Error(`Reranker worker crashed: ${event.message || 'unknown error'}`);
            logger.error('Reranker: Worker error:', event);
            this.terminateWorker(error);
            this.status.set({ state: 'error', message: error.message });
        };
        worker.onmessageerror = () => {
            logger.warn('Reranker: Worker sent an unreadable message');
        };
        this.worker = worker;
        return worker;
    }

    private postMessage(message: RerankerWorkerRequest, transfer: Transferable[] = []): void {
        this.getWorker().postMessage(message, transfer);
    }

    private sendRequest(message: RerankerWorkerRequest, requestId: number, transfer: Transferable[] = []): Promise<RerankerWorkerResponse> {
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try {
                this.postMessage(message, transfer);
            } catch (error) {
                this.pending.delete(requestId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private handleWorkerMessage(message: RerankerWorkerResponse): void {
        if (message.type === 'progress') {
            this.handleProgress(message.loaded, message.total, message.progress);
            return;
        }

        const handlers = this.pending.get(message.requestId);
        if (!handlers) {
            return;
        }
        this.pending.delete(message.requestId);

        if (message.type === 'error') {
            handlers.reject(message.cancelled ? createAbortError(message.message) : new Error(message.message));
        } else {
            handlers.resolve(message);
        }
    }

    private handleProgress(loaded: number, total: number, progress: number): void {
        if (this.ready) {
            return;
        }
        const percent = Math.max(0, Math.min(100, Math.round(progress)));
        this.status.set({
            state: 'loading',
            message: total > 0
                ? `Fetching reranker… ${percent}% (${formatMegabytes(loaded)} / ${formatMegabytes(total)})`
                : 'Fetching reranker…',
            progress: percent,
            loadedBytes: loaded,
            totalBytes: total,
        });
    }

    private terminateWorker(error: Error): void {
        const { worker } = this;
        this.worker = undefined;
        this.ready = false;
        if (worker) {
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
        }
        const pending = [...this.pending.values()];
        this.pending.clear();
        pending.forEach((handlers) => handlers.reject(error));
    }
}
