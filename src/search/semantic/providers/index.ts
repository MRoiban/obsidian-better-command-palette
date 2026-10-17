/**
 * Embedding providers (local in-plugin model, Ollama) and their model registry.
 */

export type {
    EmbeddingProvider, EmbeddingProviderId, EmbeddingKind, EmbedOptions, ProviderAvailability, ProviderStatus,
    ProviderStatusListener, ProviderState,
} from './types';
export { OllamaProvider } from './ollama-provider';
export { LocalTransformersProvider } from './local-transformers-provider';
export { createEmbeddingProvider, getProviderConfigKey } from './provider-factory';
export type { EmbeddingProviderContext } from './provider-factory';
export * from './model-registry';
