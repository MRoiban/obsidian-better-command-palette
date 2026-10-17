/**
 * Creates the local embedding worker (inlined into main.js by rollup-plugin-web-worker-loader).
 * Kept next to the worker: a `web-worker:` specifier containing `../` is resolved by
 * node-resolve as a plain module instead of being bundled as a worker.
 */

import LocalEmbeddingWorker from 'web-worker:./local-embedding-worker';

export function createLocalEmbeddingWorker(): Worker {
    return new LocalEmbeddingWorker({});
}
