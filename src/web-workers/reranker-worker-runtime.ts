/**
 * Transformers.js runtime helpers for the reranker worker: onnxruntime-web setup,
 * device resolution and download-progress aggregation.
 *
 * Mirrors the local embedding worker's setup (bundled WASM binary, no CDN, single
 * thread, WebGPU when an adapter exists) so both workers behave the same.
 */

import { env } from '@huggingface/transformers';
import type { LocalDeviceSetting } from '../search/semantic/providers/model-registry';
import type { LocalResolvedDevice } from '../search/semantic/providers/local-embedding-protocol';

export function configureTransformersRuntime(wasmBinary?: ArrayBuffer): void {
    // Models come from the Hugging Face Hub and are cached with the browser Cache API.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    const wasm = (env.backends as any).onnx?.wasm;
    if (!wasm) {
        return;
    }
    // Use the WASM binary shipped with the plugin; clearing wasmPaths drops the CDN default.
    if (wasmBinary) {
        wasm.wasmBinary = wasmBinary;
        wasm.wasmPaths = undefined;
    }
    // Multi-threading needs cross-origin isolation (SharedArrayBuffer), which Obsidian lacks.
    wasm.numThreads = 1;
    wasm.proxy = false;
}

export async function resolveTransformersDevice(setting: LocalDeviceSetting): Promise<LocalResolvedDevice> {
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
        throw new Error('WebGPU is not available in this environment. Choose "Auto" or "CPU (WASM)" as the device.');
    }
    return 'wasm';
}

export interface DownloadProgress {
    loaded: number;
    total: number;
    /** 0-100 over all files seen so far. */
    progress: number;
}

/** Aggregates Transformers.js per-file progress events, throttled to one report per 200 ms. */
export function createProgressCallback(report: (progress: DownloadProgress) => void): (info: any) => void {
    const files: Record<string, { loaded: number; total: number }> = {};
    let lastReport = 0;

    return (info: any) => {
        if (info?.status !== 'progress' || !info.file) {
            return;
        }
        files[info.file] = { loaded: info.loaded ?? 0, total: info.total ?? 0 };
        const now = Date.now();
        if (now - lastReport < 200 && info.loaded !== info.total) {
            return;
        }
        lastReport = now;
        const loaded = Object.values(files).reduce((sum, file) => sum + file.loaded, 0);
        const total = Object.values(files).reduce((sum, file) => sum + file.total, 0);
        report({ loaded, total, progress: total > 0 ? (loaded / total) * 100 : 0 });
    };
}

/** Release ONNX tensors held in a model input/output record. */
export function disposeTensors(value: unknown): void {
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
