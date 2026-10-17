/* eslint-disable no-restricted-globals */
/**
 * Web Worker running Transformers.js (onnxruntime-web) for local embeddings, so
 * model download/compilation and inference never block Obsidian's UI thread.
 *
 * Protocol: see src/search/semantic/providers/local-embedding-protocol.ts.
 * Requests are processed one at a time in arrival order.
 */

// Must stay the first import: hides Node globals before the libraries below evaluate.
import './local-embedding-worker-env';
import {
    AutoModel, AutoTokenizer, env, mean_pooling,
} from '@huggingface/transformers';
import type {
    LocalResolvedDevice, LocalWorkerEmbedRequest, LocalWorkerInitRequest, LocalWorkerModelConfig, LocalWorkerRequest,
    LocalWorkerResponse,
} from '../search/semantic/providers/local-embedding-protocol';

type LoadedModel = {
    tokenizer: any;
    model: any;
    config: LocalWorkerModelConfig;
};

let loaded: LoadedModel | undefined;
let queue: Promise<void> = Promise.resolve();

const post = (message: LocalWorkerResponse, transfer: Transferable[] = []) => {
    (self as any).postMessage(message, transfer);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function configureRuntime(wasmBinary?: ArrayBuffer): void {
    // Models come from the Hugging Face Hub and are cached with the browser Cache API.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    const onnxEnv = (env.backends as any).onnx;
    const wasm = onnxEnv?.wasm;
    if (!wasm) {
        return;
    }

    // The bundled onnxruntime build embeds its JS glue; supplying the WASM binary
    // directly means nothing is fetched from a CDN. Clearing wasmPaths removes the
    // jsDelivr default Transformers.js sets at import time.
    if (wasmBinary) {
        wasm.wasmBinary = wasmBinary;
        wasm.wasmPaths = undefined;
    }
    // Multi-threading needs cross-origin isolation (SharedArrayBuffer), which Obsidian lacks.
    wasm.numThreads = 1;
    wasm.proxy = false;
}

async function resolveDevice(setting: LocalWorkerInitRequest['device']): Promise<LocalResolvedDevice> {
    if (setting === 'wasm') {
        return 'wasm';
    }

    const gpu = (navigator as any).gpu;
    let adapter: unknown = null;
    if (gpu?.requestAdapter) {
        try {
            adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        } catch {
            adapter = null;
        }
    }

    if (adapter) {
        return 'webgpu';
    }
    if (setting === 'webgpu') {
        throw new Error('WebGPU is not available in this environment. Choose "Auto" or "WASM" as the device.');
    }
    return 'wasm';
}

async function loadModel(request: LocalWorkerInitRequest, device: LocalResolvedDevice): Promise<LoadedModel> {
    const files: Record<string, { loaded: number; total: number }> = {};
    let lastReport = 0;

    const progressCallback = (info: any) => {
        if (info?.status !== 'progress' || !info.file) {
            return;
        }
        files[info.file] = { loaded: info.loaded ?? 0, total: info.total ?? 0 };
        const now = Date.now();
        if (now - lastReport < 200 && info.loaded !== info.total) {
            return;
        }
        lastReport = now;
        const loadedBytes = Object.values(files).reduce((sum, f) => sum + f.loaded, 0);
        const totalBytes = Object.values(files).reduce((sum, f) => sum + f.total, 0);
        post({
            type: 'progress',
            requestId: request.requestId,
            loaded: loadedBytes,
            total: totalBytes,
            progress: totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0,
            file: info.file,
        });
    };

    const tokenizer = await AutoTokenizer.from_pretrained(request.model.hfModelId, {
        progress_callback: progressCallback,
    });
    const modelFileName = device === 'wasm' ? request.model.wasmModelFileNames?.[request.dtype] : undefined;
    const model = await AutoModel.from_pretrained(request.model.hfModelId, {
        device,
        dtype: request.dtype,
        progress_callback: progressCallback,
        ...(modelFileName ? { model_file_name: modelFileName } : {}),
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

async function handleInit(request: LocalWorkerInitRequest): Promise<void> {
    const start = Date.now();
    try {
        await disposeLoaded();
        configureRuntime(request.wasmBinary);

        let device = await resolveDevice(request.device);
        let fallbackReason: string | undefined;

        try {
            loaded = await loadModel(request, device);
        } catch (error) {
            if (device !== 'webgpu' || request.device !== 'auto') {
                throw error;
            }
            // Auto mode: WebGPU adapter exists but the session failed (driver, unsupported op, ...).
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

function disposeTensors(value: unknown): void {
    if (!value || typeof value !== 'object') {
        return;
    }
    Object.values(value as Record<string, any>).forEach((tensor) => {
        if (tensor && typeof tensor.dispose === 'function') {
            try {
                tensor.dispose();
            } catch {
                // Already released.
            }
        }
    });
}

async function handleEmbed(request: LocalWorkerEmbedRequest): Promise<void> {
    if (!loaded) {
        post({ type: 'error', requestId: request.requestId, message: 'Local embedding model is not loaded' });
        return;
    }

    let inputs: any;
    let outputs: any;
    try {
        const { tokenizer, model, config } = loaded;
        inputs = tokenizer(request.texts, {
            padding: true,
            truncation: true,
            max_length: config.maxTokens,
        });
        outputs = await model(inputs);

        let pooled: any;
        const useModelPooling = config.pooling === 'model'
            || (config.pooling === 'auto' && outputs.sentence_embedding);
        if (useModelPooling) {
            pooled = outputs.sentence_embedding;
            if (!pooled) {
                throw new Error('Model does not output "sentence_embedding"');
            }
        } else {
            const hidden = outputs.last_hidden_state ?? outputs.token_embeddings ?? outputs.logits;
            if (!hidden) {
                throw new Error('Model output has no token embeddings');
            }
            pooled = config.pooling === 'cls'
                ? hidden.slice(null, 0)
                : mean_pooling(hidden, inputs.attention_mask);
        }

        const normalized = pooled.normalize(2, -1);
        const asFloat32 = normalized.type === 'float32' ? normalized : normalized.to('float32');
        const dims: number[] = asFloat32.dims;
        const count = dims[0] ?? request.texts.length;
        const dimension = dims[dims.length - 1] ?? 0;
        // Copy out of the tensor's buffer so it can be transferred.
        const data = new Float32Array(asFloat32.data as Float32Array);

        post({
            type: 'embeddings', requestId: request.requestId, count, dimension, data,
        }, [data.buffer]);
    } catch (error) {
        post({ type: 'error', requestId: request.requestId, message: errorMessage(error) });
    } finally {
        disposeTensors(outputs);
        disposeTensors(inputs);
    }
}

async function handleMessage(message: LocalWorkerRequest): Promise<void> {
    switch (message.type) {
        case 'init':
            await handleInit(message);
            break;
        case 'embed':
            await handleEmbed(message);
            break;
        case 'dispose':
            await disposeLoaded();
            self.close();
            break;
        default:
            break;
    }
}

self.onmessage = (event: MessageEvent<LocalWorkerRequest>) => {
    const message = event.data;
    queue = queue.then(() => handleMessage(message)).catch((error) => {
        const requestId = (message as { requestId?: number }).requestId ?? -1;
        post({ type: 'error', requestId, message: errorMessage(error) });
    });
};
