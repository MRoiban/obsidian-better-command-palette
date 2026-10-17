/**
 * Locates the onnxruntime-web runtime shipped with the plugin.
 *
 * The JS part of onnxruntime-web is bundled into the worker inside main.js.
 * Its WASM binary (~27 MB) is copied next to main.js at build time
 * (see rollup.config.js) and read through the vault adapter, which works on
 * desktop and mobile without any network access or custom URL schemes.
 */

import { DataAdapter, normalizePath } from 'obsidian';

/**
 * Must match the WASM flavour whose JS glue is embedded in the
 * `onnxruntime-web/webgpu` bundle (the asyncify build covers both WebGPU and WASM).
 */
export const ORT_WASM_FILENAME = 'ort-wasm-simd-threaded.asyncify.wasm';

export async function loadOrtWasmBinary(adapter: DataAdapter, pluginDir: string): Promise<ArrayBuffer> {
    const path = normalizePath(`${pluginDir}/${ORT_WASM_FILENAME}`);
    if (!(await adapter.exists(path))) {
        throw new Error(`Local embedding runtime not found: "${path}". Copy ${ORT_WASM_FILENAME} from the plugin build next to main.js.`);
    }
    return adapter.readBinary(path);
}
