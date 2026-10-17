/**
 * Embedding provider abstraction. A provider turns text into raw vectors;
 * EmbeddingService owns normalization, dimension tracking and caching.
 */

export type EmbeddingProviderId = 'local' | 'ollama';

/** Whether the text is a search query or a document chunk (models may prefix them differently). */
export type EmbeddingKind = 'query' | 'document';

export interface EmbedOptions {
    signal?: AbortSignal;
    /** Time budget for the request once it is actually running. */
    timeoutMs?: number;
    /** Attempts for transient failures. Providers without transient failures ignore this. */
    retries?: number;
    /**
     * Title of the document the texts belong to (document kind only). Used by models
     * whose input template has a separate title field; other providers ignore it.
     */
    title?: string;
}

export interface ProviderAvailability {
    ok: boolean;
    /** Human-readable explanation, suitable for a Notice. */
    message: string;
}

export type ProviderState = 'idle' | 'loading' | 'ready' | 'error';

export interface ProviderStatus {
    state: ProviderState;
    message: string;
    /** 0-100 while model files are being fetched. */
    progress?: number;
    loadedBytes?: number;
    totalBytes?: number;
    /** Resolved backend (e.g. 'webgpu', 'wasm', 'ollama'). */
    device?: string;
    dimension?: number;
}

export type ProviderStatusListener = (status: ProviderStatus) => void;

export interface EmbeddingProvider {
    readonly id: EmbeddingProviderId;
    /** Short description for logs and messages, e.g. "local bge-small-en-v1.5". */
    readonly label: string;
    /** Number of texts worth sending per embed() call. */
    readonly maxBatchSize: number;
    /**
     * Ceiling for file-level indexing concurrency against this provider.
     * Undefined means the user's "max concurrent requests" setting applies.
     */
    readonly maxConcurrency?: number;
    /** Whether response-time based adaptive throttling makes sense for this provider. */
    readonly supportsAdaptiveThrottling: boolean;

    /** Embed texts in order. Vectors are returned raw (callers normalize). */
    embed(texts: string[], kind: EmbeddingKind, options?: EmbedOptions): Promise<Float32Array[]>;

    /** Verify the provider can produce embeddings (may load/download a model). Never throws. */
    checkAvailability(): Promise<ProviderAvailability>;

    /** Start loading resources ahead of the first request. */
    warmup?(): Promise<void>;

    getStatus(): ProviderStatus;

    /** Subscribe to status changes; returns an unsubscribe function. */
    onStatusChange(listener: ProviderStatusListener): () => void;

    /** Release resources (workers, sessions). Pending requests are rejected. */
    dispose(): void;
}
