/**
 * Environment fix-up for the local embedding worker. Must be imported before
 * @huggingface/transformers and onnxruntime-web are evaluated.
 *
 * Obsidian desktop enables `nodeIntegrationInWorker`, so `process` exists inside
 * Web Workers. Transformers.js and onnxruntime-web would then take their Node.js
 * code paths (onnxruntime-node, fs), which are not bundled. Hiding `process`
 * makes both libraries use their browser backends (WebGPU / WASM).
 */

const scope = globalThis as any;

if (typeof scope.process !== 'undefined') {
    try {
        scope.process = undefined;
    } catch {
        // Fall through to defineProperty below.
    }
    if (typeof scope.process !== 'undefined') {
        try {
            Object.defineProperty(scope, 'process', { value: undefined, configurable: true, writable: true });
        } catch {
            // Nothing else we can do; initialization will report the failure.
        }
    }
}

export {};
