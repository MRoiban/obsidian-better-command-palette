/**
 * Messages exchanged between LocalTransformersProvider (main thread) and the
 * local embedding Web Worker. Type-only module: safe to import from both sides.
 */

import type { LocalDeviceSetting, LocalDtype, LocalPooling } from './model-registry';

export type LocalResolvedDevice = 'webgpu' | 'wasm';

export interface LocalWorkerModelConfig {
    hfModelId: string;
    pooling: LocalPooling;
    maxTokens: number;
    /** ONNX file base names to use on the WASM backend, per precision. */
    wasmModelFileNames?: Partial<Record<LocalDtype, string>>;
}

export interface LocalWorkerInitRequest {
    type: 'init';
    requestId: number;
    model: LocalWorkerModelConfig;
    device: LocalDeviceSetting;
    dtype: LocalDtype;
    /** onnxruntime-web WASM binary read from the plugin folder (transferred). */
    wasmBinary?: ArrayBuffer;
}

export interface LocalWorkerEmbedRequest {
    type: 'embed';
    requestId: number;
    /** Final model inputs (prefixes already applied). */
    texts: string[];
}

export interface LocalWorkerDisposeRequest {
    type: 'dispose';
}

export type LocalWorkerRequest = LocalWorkerInitRequest | LocalWorkerEmbedRequest | LocalWorkerDisposeRequest;

export interface LocalWorkerProgressResponse {
    type: 'progress';
    requestId: number;
    /** Aggregate progress over all files being fetched (0-100). */
    progress: number;
    loaded: number;
    total: number;
    file?: string;
}

export interface LocalWorkerReadyResponse {
    type: 'ready';
    requestId: number;
    device: LocalResolvedDevice;
    dtype: LocalDtype;
    /** Set when the requested device failed and the worker fell back. */
    fallbackReason?: string;
    loadTimeMs: number;
}

export interface LocalWorkerEmbeddingsResponse {
    type: 'embeddings';
    requestId: number;
    count: number;
    dimension: number;
    /** Row-major [count x dimension] vectors (transferred). */
    data: Float32Array;
}

export interface LocalWorkerErrorResponse {
    type: 'error';
    requestId: number;
    message: string;
}

export type LocalWorkerResponse =
    | LocalWorkerProgressResponse
    | LocalWorkerReadyResponse
    | LocalWorkerEmbeddingsResponse
    | LocalWorkerErrorResponse;
