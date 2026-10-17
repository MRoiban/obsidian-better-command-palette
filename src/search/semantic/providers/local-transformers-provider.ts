/**
 * In-plugin embeddings with Transformers.js running in a dedicated Web Worker.
 *
 * - The model is loaded lazily (first request, warmup() or checkAvailability()).
 * - At most one batch is in flight in the worker; queued queries are dispatched
 *   before queued document batches so search stays responsive during indexing.
 * - Small document requests are coalesced into one worker batch.
 * - Aborted/timed-out requests are rejected immediately; a batch already running
 *   in the worker finishes and its result is discarded.
 */

import {
    EmbedOptions, EmbeddingKind, EmbeddingProvider, ProviderAvailability, ProviderStatus, ProviderStatusListener,
} from './types';
import {
    LocalDeviceSetting, LocalDtype, LocalModelDefinition, formatEmbeddingInput,
} from './model-registry';
import {
    LocalResolvedDevice, LocalWorkerEmbeddingsResponse, LocalWorkerReadyResponse, LocalWorkerRequest, LocalWorkerResponse,
} from './local-embedding-protocol';
import { ProviderStatusEmitter } from './status-emitter';
import { createAbortError, throwIfAborted } from './abort-utils';
import { NonRetryableEmbeddingError } from '../http-utils';
import { logger } from '../../../utils/logger';

export interface LocalTransformersProviderConfig {
    model: LocalModelDefinition;
    dtype: LocalDtype;
    device: LocalDeviceSetting;
    /** Reads the onnxruntime WASM binary shipped with the plugin. */
    loadWasmBinary: () => Promise<ArrayBuffer>;
    createWorker: () => Worker;
}

/**
 * Texts per worker batch. WebGPU benefits from batching; single-threaded WASM does not,
 * and a smaller batch bounds how long a query waits behind indexing (~0.5 s vs ~2 s).
 */
const MAX_BATCH_SIZE_WEBGPU = 16;
const MAX_BATCH_SIZE_WASM = 4;

/** File-level indexing tasks worth running; the provider still runs one batch at a time. */
const MAX_INDEXING_CONCURRENCY = 3;

/** After a failed load, fail fast for this long instead of re-downloading per request. */
const LOAD_RETRY_COOLDOWN_MS = 30000;

const DEFAULT_TIMEOUT_MS = 30000;

interface EmbedJob {
    texts: string[];
    kind: EmbeddingKind;
    timeoutMs: number;
    signal?: AbortSignal;
    resolve: (vectors: Float32Array[]) => void;
    reject: (error: unknown) => void;
    settled: boolean;
    timer?: number;
    removeAbortListener?: () => void;
}

interface WorkerRequestHandlers {
    resolve: (response: LocalWorkerResponse) => void;
    reject: (error: Error) => void;
}

function formatMegabytes(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class LocalTransformersProvider implements EmbeddingProvider {
    readonly id = 'local' as const;

    readonly label: string;

    get maxBatchSize(): number {
        return this.device === 'wasm' ? MAX_BATCH_SIZE_WASM : MAX_BATCH_SIZE_WEBGPU;
    }

    readonly maxConcurrency = MAX_INDEXING_CONCURRENCY;

    readonly supportsAdaptiveThrottling = false;

    private readonly config: LocalTransformersProviderConfig;

    private readonly status = new ProviderStatusEmitter({ state: 'idle', message: 'Model not loaded yet' });

    private worker?: Worker;

    private ready = false;

    private disposed = false;

    private loadPromise?: Promise<void>;

    private loadFailure?: { at: number; error: Error };

    private device?: LocalResolvedDevice;

    private dimension?: number;

    private readyMessage = '';

    private nextRequestId = 1;

    private workerRequests = new Map<number, WorkerRequestHandlers>();

    private jobs: EmbedJob[] = [];

    private batchInFlight = false;

    constructor(config: LocalTransformersProviderConfig) {
        this.config = config;
        this.label = `local ${config.model.hfModelId} (${config.dtype})`;
    }

    embed(texts: string[], kind: EmbeddingKind, options: EmbedOptions = {}): Promise<Float32Array[]> {
        if (this.disposed) {
            return Promise.reject(createAbortError('Local embedding provider was shut down'));
        }
        throwIfAborted(options.signal);
        if (texts.length === 0) {
            return Promise.resolve([]);
        }

        return new Promise<Float32Array[]>((resolve, reject) => {
            const job: EmbedJob = {
                texts: texts.map((text) => formatEmbeddingInput(this.config.model, text, kind)),
                kind,
                timeoutMs: Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
                signal: options.signal,
                resolve,
                reject,
                settled: false,
            };

            if (options.signal) {
                const onAbort = () => this.failJob(job, createAbortError());
                options.signal.addEventListener('abort', onAbort, { once: true });
                job.removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort);
            }

            // Queries count model loading toward their timeout so search fails fast while a
            // model downloads; document batches only start their clock once dispatched.
            if (kind === 'query') {
                this.startJobTimer(job);
            }

            this.enqueue(job);
            this.pump();
        });
    }

    async checkAvailability(): Promise<ProviderAvailability> {
        try {
            await this.ensureLoaded(true);
            return { ok: true, message: `Local model ${this.config.model.hfModelId} is ready (${this.readyMessage})` };
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return { ok: false, message: `Local embedding model "${this.config.model.hfModelId}" could not be loaded: ${reason}` };
        }
    }

    async warmup(): Promise<void> {
        try {
            await this.ensureLoaded(true);
        } catch (error) {
            logger.warn('Semantic search: Local embedding model warmup failed:', error);
        }
    }

    getStatus(): ProviderStatus {
        return this.status.get();
    }

    onStatusChange(listener: ProviderStatusListener): () => void {
        return this.status.subscribe(listener);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        const error = createAbortError('Local embedding provider was shut down');
        [...this.jobs].forEach((job) => this.failJob(job, error));
        this.jobs = [];
        this.terminateWorker(error);
        this.status.set({ state: 'idle', message: 'Provider shut down' });
        this.status.clear();
    }

    // --- Scheduling ---

    private enqueue(job: EmbedJob): void {
        if (job.kind === 'query') {
            // Behind other queries, ahead of document batches.
            const firstDocument = this.jobs.findIndex((queued) => queued.kind !== 'query');
            if (firstDocument === -1) {
                this.jobs.push(job);
            } else {
                this.jobs.splice(firstDocument, 0, job);
            }
        } else {
            this.jobs.push(job);
        }
    }

    private startJobTimer(job: EmbedJob): void {
        if (job.timer !== undefined) {
            return;
        }
        job.timer = window.setTimeout(() => {
            const loading = !this.ready && this.status.get().state === 'loading';
            const message = loading
                ? `Local embedding model is still loading (${this.status.get().message})`
                : `Local embedding request timed out after ${job.timeoutMs}ms`;
            this.failJob(job, new Error(message));
        }, job.timeoutMs);
    }

    private takeBatch(): EmbedJob[] {
        const batch: EmbedJob[] = [];
        let size = 0;
        while (this.jobs.length > 0) {
            const next = this.jobs[0]!;
            if (batch.length > 0 && (next.kind !== batch[0]!.kind || size + next.texts.length > this.maxBatchSize)) {
                break;
            }
            this.jobs.shift();
            batch.push(next);
            size += next.texts.length;
        }
        return batch;
    }

    private async pump(): Promise<void> {
        if (this.batchInFlight || this.disposed || this.jobs.length === 0) {
            return;
        }
        this.batchInFlight = true;

        try {
            try {
                await this.ensureLoaded(false);
            } catch (error) {
                const failure = error instanceof Error ? error : new Error(String(error));
                [...this.jobs].forEach((job) => this.failJob(job, failure));
                this.jobs = [];
                return;
            }

            const batch = this.takeBatch();
            if (batch.length === 0) {
                return;
            }
            batch.forEach((job) => this.startJobTimer(job));

            try {
                const vectors = await this.runBatch(batch.flatMap((job) => job.texts));
                let offset = 0;
                batch.forEach((job) => {
                    const slice = vectors.slice(offset, offset + job.texts.length);
                    offset += job.texts.length;
                    this.resolveJob(job, slice);
                });
            } catch (error) {
                batch.forEach((job) => this.failJob(job, error));
            }
        } finally {
            this.batchInFlight = false;
            if (this.jobs.length > 0 && !this.disposed) {
                void this.pump();
            }
        }
    }

    private resolveJob(job: EmbedJob, vectors: Float32Array[]): void {
        if (job.settled) {
            return;
        }
        this.settleJob(job);
        job.resolve(vectors);
    }

    private failJob(job: EmbedJob, error: unknown): void {
        if (job.settled) {
            return;
        }
        this.settleJob(job);
        const index = this.jobs.indexOf(job);
        if (index !== -1) {
            this.jobs.splice(index, 1);
        }
        job.reject(error);
    }

    private settleJob(job: EmbedJob): void {
        job.settled = true;
        if (job.timer !== undefined) {
            window.clearTimeout(job.timer);
            job.timer = undefined;
        }
        job.removeAbortListener?.();
    }

    // --- Worker lifecycle ---

    private ensureLoaded(force: boolean): Promise<void> {
        if (this.disposed) {
            return Promise.reject(createAbortError('Local embedding provider was shut down'));
        }
        if (this.ready) {
            return Promise.resolve();
        }
        if (this.loadPromise) {
            return this.loadPromise;
        }
        if (!force && this.loadFailure && Date.now() - this.loadFailure.at < LOAD_RETRY_COOLDOWN_MS) {
            return Promise.reject(this.loadFailure.error);
        }

        const run = this.load()
            .then(() => {
                this.ready = true;
                this.loadFailure = undefined;
            })
            .catch((error) => {
                const failure = error instanceof NonRetryableEmbeddingError
                    ? error
                    : new NonRetryableEmbeddingError(error instanceof Error ? error.message : String(error));
                if (!this.disposed) {
                    this.loadFailure = { at: Date.now(), error: failure };
                    this.terminateWorker(failure);
                    this.status.set({ state: 'error', message: failure.message });
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

    private async load(): Promise<void> {
        const { model, dtype, device } = this.config;
        this.status.set({ state: 'loading', message: 'Loading model…' });
        logger.info(`Semantic search: Loading local embedding model ${model.hfModelId} (${dtype}, device: ${device})`);

        const wasmBinary = await this.config.loadWasmBinary();
        if (this.disposed) {
            throw createAbortError('Local embedding provider was shut down');
        }

        const requestId = this.nextRequestId++;
        const response = await this.sendRequest({
            type: 'init',
            requestId,
            model: {
                hfModelId: model.hfModelId,
                pooling: model.pooling,
                maxTokens: model.maxTokens,
                wasmModelFileNames: model.wasmModelFileNames,
            },
            device,
            dtype,
            wasmBinary,
        }, requestId, [wasmBinary]) as LocalWorkerReadyResponse;

        this.device = response.device;
        this.readyMessage = `${response.device.toUpperCase()}, ${response.dtype}`;
        if (response.fallbackReason) {
            logger.warn(`Semantic search: ${response.fallbackReason}`);
            this.readyMessage += ` — ${response.fallbackReason}`;
        }
        logger.info(`Semantic search: Local embedding model ready in ${response.loadTimeMs}ms (${this.readyMessage})`);
        this.status.set({
            state: 'ready',
            message: `Ready (${this.readyMessage})`,
            device: this.device,
            dimension: this.dimension ?? model.dimension,
        });
    }

    private async runBatch(texts: string[]): Promise<Float32Array[]> {
        const requestId = this.nextRequestId++;
        const response = await this.sendRequest({ type: 'embed', requestId, texts }, requestId) as LocalWorkerEmbeddingsResponse;

        const { count, dimension, data } = response;
        if (count !== texts.length || dimension <= 0 || data.length !== count * dimension) {
            throw new Error(`Local embedding worker returned ${count}x${dimension} vectors for ${texts.length} inputs`);
        }

        if (this.dimension !== dimension) {
            this.dimension = dimension;
            this.status.set({ ...this.status.get(), dimension });
        }

        const vectors: Float32Array[] = [];
        for (let i = 0; i < count; i++) {
            vectors.push(data.slice(i * dimension, (i + 1) * dimension));
        }
        return vectors;
    }

    private getWorker(): Worker {
        if (this.worker) {
            return this.worker;
        }

        const worker = this.config.createWorker();
        worker.onmessage = (event: MessageEvent<LocalWorkerResponse>) => this.handleWorkerMessage(event.data);
        worker.onerror = (event: ErrorEvent) => {
            event.preventDefault?.();
            const error = new NonRetryableEmbeddingError(`Local embedding worker crashed: ${event.message || 'unknown error'}`);
            logger.error('Semantic search: Local embedding worker error:', event);
            this.ready = false;
            this.terminateWorker(error);
            this.status.set({ state: 'error', message: error.message });
        };
        worker.onmessageerror = () => {
            logger.warn('Semantic search: Local embedding worker sent an unreadable message');
        };
        this.worker = worker;
        return worker;
    }

    private sendRequest(message: LocalWorkerRequest, requestId: number, transfer: Transferable[] = []): Promise<LocalWorkerResponse> {
        return new Promise((resolve, reject) => {
            this.workerRequests.set(requestId, { resolve, reject });
            try {
                this.getWorker().postMessage(message, transfer);
            } catch (error) {
                this.workerRequests.delete(requestId);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }

    private handleWorkerMessage(message: LocalWorkerResponse): void {
        if (message.type === 'progress') {
            this.handleProgress(message.loaded, message.total, message.progress);
            return;
        }

        const handlers = this.workerRequests.get(message.requestId);
        if (!handlers) {
            return;
        }
        this.workerRequests.delete(message.requestId);

        if (message.type === 'error') {
            handlers.reject(new Error(message.message));
        } else {
            handlers.resolve(message);
        }
    }

    private handleProgress(loaded: number, total: number, progress: number): void {
        if (this.ready) {
            return;
        }
        const percent = Math.max(0, Math.min(100, Math.round(progress)));
        const message = total > 0
            ? `Fetching model… ${percent}% (${formatMegabytes(loaded)} / ${formatMegabytes(total)})`
            : 'Fetching model…';
        this.status.set({
            state: 'loading',
            message,
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
        const pending = [...this.workerRequests.values()];
        this.workerRequests.clear();
        pending.forEach((handlers) => handlers.reject(error));
    }
}
