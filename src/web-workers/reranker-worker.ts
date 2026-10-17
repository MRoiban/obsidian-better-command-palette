/* eslint-disable no-restricted-globals */
/**
 * Web Worker running a Transformers.js cross-encoder (reranker), separate from the
 * embedding worker so reranking never delays query embeddings or indexing.
 *
 * Protocol: see src/search/semantic/rerank/reranker-protocol.ts.
 * init/score requests run one at a time in arrival order; 'cancel' is handled on
 * arrival and makes a running score request stop after its current batch.
 */

// Must stay the first import: hides Node globals before the libraries below evaluate.
import './local-embedding-worker-env';
import { AutoModelForSequenceClassification, AutoTokenizer } from '@huggingface/transformers';
import type {
    RerankerWorkerInitRequest, RerankerWorkerModelConfig, RerankerWorkerRequest, RerankerWorkerResponse,
    RerankerWorkerScoreRequest,
} from '../search/semantic/rerank/reranker-protocol';
import type { LocalResolvedDevice } from '../search/semantic/providers/local-embedding-protocol';
import {
    configureTransformersRuntime, createProgressCallback, disposeTensors, resolveTransformersDevice,
} from './reranker-worker-runtime';

type LoadedModel = {
    tokenizer: any;
    model: any;
    config: RerankerWorkerModelConfig;
};

let loaded: LoadedModel | undefined;
let queue: Promise<void> = Promise.resolve();
const cancelled = new Set<number>();

const post = (message: RerankerWorkerResponse, transfer: Transferable[] = []) => {
    (self as any).postMessage(message, transfer);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function loadModel(request: RerankerWorkerInitRequest, device: LocalResolvedDevice): Promise<LoadedModel> {
    const progressCallback = createProgressCallback(({ loaded: bytes, total, progress }) => {
        post({
            type: 'progress', requestId: request.requestId, loaded: bytes, total, progress,
        });
    });

    const tokenizer = await AutoTokenizer.from_pretrained(request.model.hfModelId, {
        progress_callback: progressCallback,
    });
    const model = await AutoModelForSequenceClassification.from_pretrained(request.model.hfModelId, {
        device,
        dtype: request.dtype,
        progress_callback: progressCallback,
        ...(request.model.modelFileName ? { model_file_name: request.model.modelFileName } : {}),
    } as any);

    return { tokenizer, model, config: request.model };
}

async function disposeLoaded(): Promise<void> {
    const current = loaded;
    loaded = undefined;
    if (current?.model?.dispose) {
        try {
            await current.model.dispose();
        } catch {
            // Ignore: the worker is being replaced or shut down.
        }
    }
}

async function handleInit(request: RerankerWorkerInitRequest): Promise<void> {
    const start = Date.now();
    try {
        await disposeLoaded();
        configureTransformersRuntime(request.wasmBinary);

        let device = await resolveTransformersDevice(request.device);
        let fallbackReason: string | undefined;
        try {
            loaded = await loadModel(request, device);
        } catch (error) {
            if (device !== 'webgpu' || request.device !== 'auto') {
                throw error;
            }
            // Auto mode: a WebGPU adapter exists but the session failed (driver, unsupported op, ...).
            fallbackReason = `WebGPU failed (${errorMessage(error)}); using WASM`;
            device = 'wasm';
            loaded = await loadModel(request, device);
        }

        post({
            type: 'ready',
            requestId: request.requestId,
            device,
            dtype: request.dtype,
            fallbackReason,
            loadTimeMs: Date.now() - start,
        });
    } catch (error) {
        loaded = undefined;
        post({ type: 'error', requestId: request.requestId, message: errorMessage(error) });
    }
}

/** One relevance logit per row; for multi-label heads the last column is "relevant". */
function readLogits(logits: any, count: number): number[] {
    const data = logits.data as ArrayLike<number>;
    const dims: number[] = logits.dims;
    const columns = dims[dims.length - 1] ?? 1;
    const scores: number[] = [];
    for (let row = 0; row < count; row++) {
        scores.push(Number(data[row * columns + (columns - 1)] ?? 0));
    }
    return scores;
}

async function handleScore(request: RerankerWorkerScoreRequest): Promise<void> {
    const { requestId } = request;
    if (!loaded) {
        post({ type: 'error', requestId, message: 'Reranker model is not loaded' });
        return;
    }

    const start = Date.now();
    const scores = new Float32Array(request.passages.length);
    const batchSize = Math.max(1, request.batchSize);

    try {
        for (let offset = 0; offset < request.passages.length; offset += batchSize) {
            if (cancelled.has(requestId)) {
                post({
                    type: 'error', requestId, message: 'Rerank request cancelled', cancelled: true,
                });
                return;
            }

            const passages = request.passages.slice(offset, offset + batchSize);
            let inputs: any;
            let outputs: any;
            try {
                const { tokenizer, model, config } = loaded;
                inputs = tokenizer(new Array(passages.length).fill(request.query), {
                    text_pair: passages,
                    padding: true,
                    truncation: true,
                    max_length: config.maxTokens,
                });
                outputs = await model(inputs);
                const logits = outputs.logits.type === 'float32' ? outputs.logits : outputs.logits.to('float32');
                readLogits(logits, passages.length).forEach((score, index) => {
                    scores[offset + index] = score;
                });
            } finally {
                disposeTensors(outputs);
                disposeTensors(inputs);
            }
        }

        post({
            type: 'scores', requestId, scores, inferenceMs: Date.now() - start,
        }, [scores.buffer]);
    } catch (error) {
        post({ type: 'error', requestId, message: errorMessage(error) });
    } finally {
        cancelled.delete(requestId);
    }
}

async function handleMessage(message: RerankerWorkerRequest): Promise<void> {
    switch (message.type) {
        case 'init':
            await handleInit(message);
            break;
        case 'score':
            if (cancelled.delete(message.requestId)) {
                post({
                    type: 'error', requestId: message.requestId, message: 'Rerank request cancelled', cancelled: true,
                });
                break;
            }
            await handleScore(message);
            break;
        case 'dispose':
            await disposeLoaded();
            self.close();
            break;
        default:
            break;
    }
}

self.onmessage = (event: MessageEvent<RerankerWorkerRequest>) => {
    const message = event.data;
    if (message.type === 'cancel') {
        cancelled.add(message.requestId);
        return;
    }
    queue = queue.then(() => handleMessage(message)).catch((error) => {
        const requestId = (message as { requestId?: number }).requestId ?? -1;
        post({ type: 'error', requestId, message: errorMessage(error) });
    });
};
