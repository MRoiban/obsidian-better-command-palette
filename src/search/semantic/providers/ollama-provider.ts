/**
 * Embeddings from an Ollama server (`/api/embeddings`), one request per text.
 * Transient failures (network, 5xx, 408, 429) are retried with exponential
 * backoff; other 4xx responses fail fast as NonRetryableEmbeddingError.
 */

// @ts-ignore
import { requestUrl } from 'obsidian';
import {
    EmbedOptions, EmbeddingKind, EmbeddingProvider, ProviderAvailability, ProviderStatus, ProviderStatusListener,
} from './types';
import { ProviderStatusEmitter } from './status-emitter';
import {
    delayWithAbort, isAbortError, throwIfAborted, withAbortAndTimeout,
} from './abort-utils';
import {
    NonRetryableEmbeddingError, getErrorHttpStatus, isRetryableHttpStatus, redactUrlCredentials,
} from '../http-utils';
import { logger } from '../../../utils/logger';

export interface OllamaProviderConfig {
    url: string;
    model: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 3;

export class OllamaProvider implements EmbeddingProvider {
    readonly id = 'ollama' as const;

    readonly label: string;

    readonly maxBatchSize = 1;

    readonly maxConcurrency = undefined;

    readonly supportsAdaptiveThrottling = true;

    private readonly config: OllamaProviderConfig;

    private readonly status = new ProviderStatusEmitter({ state: 'idle', message: 'Not checked yet', device: 'ollama' });

    constructor(config: OllamaProviderConfig) {
        this.config = config;
        this.label = `Ollama ${config.model}`;
    }

    async embed(texts: string[], _kind: EmbeddingKind, options: EmbedOptions = {}): Promise<Float32Array[]> {
        const vectors: Float32Array[] = [];
        for (const text of texts) {
            // eslint-disable-next-line no-await-in-loop
            vectors.push(await this.embedOne(text, options));
        }
        return vectors;
    }

    private async embedOne(text: string, options: EmbedOptions): Promise<Float32Array> {
        const timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const retries = Math.max(1, options.retries ?? DEFAULT_RETRIES);

        for (let attempt = 1; attempt <= retries; attempt++) {
            throwIfAborted(options.signal);

            try {
                // Ollama's /api/embeddings endpoint takes 'prompt', not 'input'
                // eslint-disable-next-line no-await-in-loop
                const response = await withAbortAndTimeout(
                    requestUrl({
                        url: `${this.config.url}/api/embeddings`,
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: this.config.model,
                            prompt: text,
                        }),
                        // Inspect the status ourselves so 4xx can be classified as non-retryable
                        throw: false,
                    }),
                    timeoutMs,
                    options.signal,
                );

                if (response.status !== 200) {
                    const message = `HTTP ${response.status}: ${getResponseSnippet(response)}`;
                    if (!isRetryableHttpStatus(response.status)) {
                        throw new NonRetryableEmbeddingError(message, response.status);
                    }
                    throw new Error(message);
                }

                // Ollama /api/embeddings returns { embedding: number[] }
                const data = response.json as any;
                const rawEmbedding: number[] | undefined = Array.isArray(data?.embedding)
                    ? (data.embedding as number[])
                    : undefined;

                if (!rawEmbedding || rawEmbedding.length === 0) {
                    logger.error(
                        `[Semantic Search] Invalid embedding response (missing/empty vector). Status: ${response.status}. Body snippet: ${getResponseSnippet(response)}`,
                    );
                    throw new Error('Invalid embedding response: missing or empty embedding');
                }

                if (this.status.get().state !== 'ready') {
                    this.status.set({
                        state: 'ready', message: `Connected to Ollama (${this.config.model})`, device: 'ollama', dimension: rawEmbedding.length,
                    });
                }
                return new Float32Array(rawEmbedding);
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }

                const status = error instanceof NonRetryableEmbeddingError ? error.status : getErrorHttpStatus(error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                const retryable = !(error instanceof NonRetryableEmbeddingError)
                    && (status === undefined || isRetryableHttpStatus(status));

                logger.warn(`[Semantic Search] Embedding attempt ${attempt}/${retries} failed${retryable ? '' : ' (not retryable)'}:`, error);

                if (!retryable) {
                    throw error instanceof NonRetryableEmbeddingError
                        ? error
                        : new NonRetryableEmbeddingError(errorMessage, status);
                }

                if (attempt === retries) {
                    throw new Error(`Failed after ${retries} attempts: ${errorMessage}`);
                }
                // Exponential backoff
                // eslint-disable-next-line no-await-in-loop
                await delayWithAbort(2 ** attempt * 1000, options.signal);
            }
        }
        throw new Error('Unexpected error in embedding generation');
    }

    async checkAvailability(): Promise<ProviderAvailability> {
        const baseUrl = this.config.url;
        const safeUrl = redactUrlCredentials(baseUrl);
        try {
            logger.debug(`[Semantic Search] Checking connection to ${safeUrl}/api/tags...`);
            const response = await requestUrl({
                url: `${baseUrl}/api/tags`,
                method: 'GET',
            });

            const data = response.json as { models?: Array<{ name: string }> };
            const models = Array.isArray(data?.models) ? data.models : [];
            const modelName = this.config.model;
            const availableModels = models.map((m) => m.name);
            logger.debug(`[Semantic Search] Available models: ${availableModels.join(', ')}`);
            logger.debug(`[Semantic Search] Looking for model: ${modelName}`);

            // Match exactly or by tag ("nomic-embed-text" matches "nomic-embed-text:latest"), so a
            // partially typed model name does not count as available.
            const found = availableModels.some((name) => name === modelName || name.startsWith(`${modelName}:`));
            logger.debug(`[Semantic Search] Model found: ${found}`);

            if (!found) {
                const message = `Embedding model "${modelName}" is not available in Ollama at ${safeUrl}. Pull it with "ollama pull ${modelName}".`;
                this.status.set({ state: 'error', message, device: 'ollama' });
                return { ok: false, message };
            }

            const message = `Ollama is reachable and has "${modelName}"`;
            this.status.set({ state: 'ready', message, device: 'ollama' });
            return { ok: true, message };
        } catch (error) {
            logger.warn(`[Semantic Search] Connection check to ${safeUrl} failed:`, error);
            const message = `Ollama is not reachable at ${safeUrl}. Make sure Ollama is running.`;
            this.status.set({ state: 'error', message, device: 'ollama' });
            return { ok: false, message };
        }
    }

    getStatus(): ProviderStatus {
        return this.status.get();
    }

    onStatusChange(listener: ProviderStatusListener): () => void {
        return this.status.subscribe(listener);
    }

    dispose(): void {
        this.status.clear();
    }
}

function getResponseSnippet(response: { text: string }): string {
    try {
        return typeof response.text === 'string' ? response.text.slice(0, 200) : '';
    } catch {
        return '';
    }
}
