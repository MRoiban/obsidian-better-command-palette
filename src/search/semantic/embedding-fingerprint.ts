/**
 * Identity of the embedding space. Vectors produced under different
 * fingerprints are not comparable and must never be mixed in one index.
 */

import { SemanticSearchSettings } from './types';
import type { EmbeddingProviderId } from './providers/types';
import {
    LocalModelDefinition, getLocalInputScheme, resolveLocalDtype, resolveLocalModel, resolveMatryoshkaDimension,
} from './providers/model-registry';

export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

/**
 * Version of how text is turned into embedding input (task prefixes, chunk
 * context, etc.). Bump this whenever that changes so cached vectors are rebuilt.
 * 'raw-v1' = chunk text sent as-is, no task prefixes.
 * Local models append their own prefix scheme (see getLocalInputScheme) and, when
 * vectors are truncated (Matryoshka), the truncated size.
 */
export const EMBEDDING_INPUT_SCHEME = 'raw-v1';

/** Prefix of stored model identities produced by the in-plugin provider. */
export const LOCAL_MODEL_IDENTITY_PREFIX = 'local:';

export type FingerprintSettings = Pick<SemanticSearchSettings, 'embeddingModel'>
    & Partial<Pick<SemanticSearchSettings, 'embeddingProvider' | 'localModel' | 'localCustomModelId' | 'localDtype' | 'localDevice' | 'localEmbeddingDimension'>>;

export interface EmbeddingFingerprint {
    provider: EmbeddingProviderId;
    /** Provider-qualified model identity, e.g. "nomic-embed-text" or "local:Xenova/bge-small-en-v1.5@q8". */
    model: string;
    scheme: string;
    /** Unknown until the first embedding is produced or loaded. */
    dimension?: number;
}

/** Settings saved before providers existed are Ollama settings. */
export function resolveEmbeddingProviderId(settings: Partial<Pick<SemanticSearchSettings, 'embeddingProvider'>>): EmbeddingProviderId {
    return settings.embeddingProvider === 'local' ? 'local' : 'ollama';
}

/** Model name to request from Ollama. */
export function resolveOllamaModel(settings: Pick<SemanticSearchSettings, 'embeddingModel'>): string {
    return settings.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
}

/**
 * Stored model identity for the configured provider. Ollama identities are the bare
 * model name (unchanged from before providers existed, so existing indexes stay valid);
 * local identities carry the provider prefix, Hub repository and precision.
 */
export function resolveEmbeddingModel(settings: FingerprintSettings): string {
    if (resolveEmbeddingProviderId(settings) === 'local') {
        const model = resolveLocalModel(settings);
        return `${LOCAL_MODEL_IDENTITY_PREFIX}${model.hfModelId}@${resolveLocalDtype(model, settings.localDtype, settings.localDevice)}`;
    }
    return resolveOllamaModel(settings);
}

/** Human-readable model name for messages. */
export function describeEmbeddingModel(settings: FingerprintSettings): string {
    if (resolveEmbeddingProviderId(settings) === 'local') {
        const model = resolveLocalModel(settings);
        const truncation = resolveMatryoshkaDimension(model, settings.localEmbeddingDimension);
        const details: string[] = [resolveLocalDtype(model, settings.localDtype, settings.localDevice)];
        if (truncation !== undefined) {
            details.push(`${truncation} dims`);
        }
        details.push('in-plugin');
        return `${model.hfModelId} (${details.join(', ')})`;
    }
    return `${resolveOllamaModel(settings)} (Ollama)`;
}

/** The configured local model, or undefined when another provider is active. */
export function resolveActiveLocalModel(settings: FingerprintSettings): LocalModelDefinition | undefined {
    return resolveEmbeddingProviderId(settings) === 'local' ? resolveLocalModel(settings) : undefined;
}

/**
 * Size vectors are truncated to (Matryoshka), or undefined for the model's full output.
 * Only local models that declare the requested size support it.
 */
export function resolveEmbeddingTruncation(settings: FingerprintSettings): number | undefined {
    const model = resolveActiveLocalModel(settings);
    return model ? resolveMatryoshkaDimension(model, settings.localEmbeddingDimension) : undefined;
}

/** Fingerprint derivable from settings alone (provider + model + input scheme). */
export function getSettingsFingerprint(settings: FingerprintSettings): EmbeddingFingerprint {
    const provider = resolveEmbeddingProviderId(settings);
    let scheme = EMBEDDING_INPUT_SCHEME;
    if (provider === 'local') {
        scheme += `+${getLocalInputScheme(resolveLocalModel(settings))}`;
        const truncation = resolveEmbeddingTruncation(settings);
        if (truncation !== undefined) {
            scheme += `+mrl-${truncation}`;
        }
    }

    return {
        provider,
        model: resolveEmbeddingModel(settings),
        scheme,
    };
}

/** Stable string form, e.g. for cache keys. */
export function fingerprintKey(fingerprint: EmbeddingFingerprint): string {
    return `${fingerprint.provider}|${fingerprint.model}|${fingerprint.scheme}`;
}

/**
 * Whether stored vectors (described by `stored`) are usable under `current`.
 * Records written before the scheme existed are treated as the original raw scheme.
 * The provider is part of the stored model identity (local models are prefixed).
 * Dimensions are only compared when both are known.
 */
export function isFingerprintCompatible(
    stored: { model?: string; scheme?: string; dimension?: number },
    current: EmbeddingFingerprint,
): boolean {
    if (stored.model !== undefined && stored.model !== current.model) {
        return false;
    }
    if ((stored.scheme ?? 'raw-v1') !== current.scheme) {
        return false;
    }
    if (stored.dimension !== undefined && current.dimension !== undefined && stored.dimension !== current.dimension) {
        return false;
    }
    return true;
}
