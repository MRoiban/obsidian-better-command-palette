/**
 * Builds the embedding provider described by the semantic search settings.
 */

import { DataAdapter } from 'obsidian';
import { createLocalEmbeddingWorker } from '../../../web-workers/local-embedding-worker-factory';
import { EmbeddingProvider } from './types';
import { OllamaProvider } from './ollama-provider';
import { LocalTransformersProvider } from './local-transformers-provider';
import { resolveLocalDtype, resolveLocalModel } from './model-registry';
import { loadOrtWasmBinary } from './runtime-assets';
import { attachModelLoadNotice } from './model-load-notice';
import { SemanticSearchSettings } from '../types';
import { resolveEmbeddingProviderId, resolveOllamaModel } from '../embedding-fingerprint';

export interface EmbeddingProviderContext {
    adapter: DataAdapter;
    /** Vault-relative plugin folder containing main.js and the bundled runtime assets. */
    pluginDir: string;
}

type ProviderSettings = Pick<SemanticSearchSettings, 'ollamaUrl' | 'embeddingModel' | 'embeddingProvider'
    | 'localModel' | 'localCustomModelId' | 'localDevice' | 'localDtype'>;

/**
 * Everything that requires a new provider instance when it changes. Broader than the
 * fingerprint: e.g. switching device needs a new worker but keeps the index.
 */
export function getProviderConfigKey(settings: ProviderSettings): string {
    if (resolveEmbeddingProviderId(settings) === 'local') {
        const model = resolveLocalModel(settings);
        return ['local', model.hfModelId, resolveLocalDtype(model, settings.localDtype, settings.localDevice), settings.localDevice ?? 'auto'].join('|');
    }
    return ['ollama', settings.ollamaUrl, resolveOllamaModel(settings)].join('|');
}

export function createEmbeddingProvider(settings: ProviderSettings, context: EmbeddingProviderContext): EmbeddingProvider {
    if (resolveEmbeddingProviderId(settings) === 'local') {
        const model = resolveLocalModel(settings);
        const provider = new LocalTransformersProvider({
            model,
            dtype: resolveLocalDtype(model, settings.localDtype, settings.localDevice),
            device: settings.localDevice ?? 'auto',
            loadWasmBinary: () => loadOrtWasmBinary(context.adapter, context.pluginDir),
            createWorker: createLocalEmbeddingWorker,
        });
        // Listeners are dropped when the provider is disposed.
        attachModelLoadNotice(provider);
        return provider;
    }

    return new OllamaProvider({
        url: settings.ollamaUrl,
        model: resolveOllamaModel(settings),
    });
}
