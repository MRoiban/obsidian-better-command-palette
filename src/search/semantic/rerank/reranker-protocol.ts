/**
 * Messages exchanged between LocalReranker (main thread) and the reranker Web Worker.
 * Type-only module: safe to import from both sides.
 */

import type { LocalDeviceSetting, LocalDtype } from '../providers/model-registry';
import type { LocalResolvedDevice } from '../providers/local-embedding-protocol';

export interface RerankerWorkerModelConfig {
    hfModelId: string;
    maxTokens: number;
    /** ONNX file base name when it differs from the dtype's standard name. */
    modelFileName?: string;
}

export interface RerankerWorkerInitRequest {
    type: 'init';
    requestId: number;
    model: RerankerWorkerModelConfig;
    device: LocalDeviceSetting;
    /** Transformers.js dtype passed to from_pretrained (selects the file suffix). */
    dtype: LocalDtype;
    /** onnxruntime-web WASM binary read from the plugin folder (transferred). */
    wasmBinary?: ArrayBuffer;
}

export interface RerankerWorkerScoreRequest {
    type: 'score';
    requestId: number;
    query: string;
    passages: string[];
    /** Pairs per model call; remaining batches are skipped once the request is cancelled. */
    batchSize: number;
}

/** Handled as soon as it arrives (not queued), so a running score request stops after its current batch. */
export interface RerankerWorkerCancelRequest {
    type: 'cancel';
    requestId: number;
}

export interface RerankerWorkerDisposeRequest {
    type: 'dispose';
}

export type RerankerWorkerRequest =
    | RerankerWorkerInitRequest
    | RerankerWorkerScoreRequest
    | RerankerWorkerCancelRequest
    | RerankerWorkerDisposeRequest;

export interface RerankerWorkerProgressResponse {
    type: 'progress';
    requestId: number;
    /** Aggregate progress over all files being fetched (0-100). */
    progress: number;
    loaded: number;
    total: number;
}

export interface RerankerWorkerReadyResponse {
    type: 'ready';
    requestId: number;
    device: LocalResolvedDevice;
    dtype: LocalDtype;
    /** Set when the requested device failed and the worker fell back. */
    fallbackReason?: string;
    loadTimeMs: number;
}

export interface RerankerWorkerScoresResponse {
    type: 'scores';
    requestId: number;
    /** Raw relevance logits, one per passage, in input order (transferred). */
    scores: Float32Array;
    inferenceMs: number;
}

export interface RerankerWorkerErrorResponse {
    type: 'error';
    requestId: number;
    message: string;
    /** True when the request was cancelled before completing. */
    cancelled?: boolean;
}

export type RerankerWorkerResponse =
    | RerankerWorkerProgressResponse
    | RerankerWorkerReadyResponse
    | RerankerWorkerScoresResponse
    | RerankerWorkerErrorResponse;
