/**
 * Creates the reranker worker (inlined into main.js by rollup-plugin-web-worker-loader).
 * Kept next to the worker: a `web-worker:` specifier containing `../` is resolved by
 * node-resolve as a plain module instead of being bundled as a worker.
 */

import RerankerWorker from 'web-worker:./reranker-worker';

export function createRerankerWorker(): Worker {
    return new RerankerWorker({});
}
