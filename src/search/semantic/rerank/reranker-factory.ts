/**
 * Builds the rerank service described by the semantic search settings.
 */

import { DataAdapter } from 'obsidian';
import { createRerankerWorker } from '../../../web-workers/reranker-worker-factory';
import { loadOrtWasmBinary } from '../providers/runtime-assets';
import type { SemanticSearchSettings } from '../types';
import { LocalReranker } from './local-reranker';
import { attachRerankerLoadNotice } from './reranker-load-notice';
import { resolveRerankerDtype, resolveRerankerModel } from './reranker-registry';
import { RerankService } from './rerank-service';

/** Tokens per (query, passage) input. Passages are ~150 tokens after MAX_RERANK_PASSAGE_CHARS. */
export const RERANK_MAX_INPUT_TOKENS = 256;

export const RERANK_TOP_K_MIN = 5;
export const RERANK_TOP_K_MAX = 50;

export interface RerankerContext {
    adapter: DataAdapter;
    /** Vault-relative plugin folder containing main.js and the bundled runtime assets. */
    pluginDir: string;
}

type RerankerSettings = Pick<SemanticSearchSettings, 'enableSemanticSearch' | 'enableReranker' | 'rerankerModel'
    | 'rerankerTopK' | 'localDevice'>;

export function isRerankerEnabled(settings: RerankerSettings): boolean {
    return !!settings.enableSemanticSearch && !!settings.enableReranker;
}

export function clampRerankTopK(value: number | undefined): number {
    const topK = Number.isFinite(value) ? Math.round(value as number) : 20;
    return Math.max(RERANK_TOP_K_MIN, Math.min(RERANK_TOP_K_MAX, topK));
}

/** Everything that needs a new reranker worker when it changes (top-K does not). */
export function getRerankerConfigKey(settings: RerankerSettings): string {
    const model = resolveRerankerModel(settings.rerankerModel);
    const device = settings.localDevice ?? 'auto';
    return [model.hfModelId, resolveRerankerDtype(model, device), device].join('|');
}

/** The reranker shares the embedding model's device setting (Auto / WebGPU / CPU). */
export function createRerankService(settings: RerankerSettings, context: RerankerContext): RerankService {
    const model = resolveRerankerModel(settings.rerankerModel);
    const device = settings.localDevice ?? 'auto';
    const reranker = new LocalReranker({
        model,
        dtype: resolveRerankerDtype(model, device),
        device,
        maxInputTokens: RERANK_MAX_INPUT_TOKENS,
        loadWasmBinary: () => loadOrtWasmBinary(context.adapter, context.pluginDir),
        createWorker: createRerankerWorker,
    });
    // Listeners are dropped when the reranker is disposed.
    attachRerankerLoadNotice(reranker);
    return new RerankService(reranker, { topK: clampRerankTopK(settings.rerankerTopK) });
}
