/**
 * Registry of local (in-plugin) embedding models.
 *
 * Each entry encodes how a model expects its input (query/document prefixes),
 * how token vectors are pooled, and which ONNX precisions are published.
 * Pure module (no Obsidian imports) so it can be reused by tooling and tests.
 */

import { generateContentHash } from '../../../utils/hash';

export type LocalDtype = 'fp32' | 'fp16' | 'q8' | 'q4';
export type LocalDtypeSetting = 'auto' | LocalDtype;
export type LocalDeviceSetting = 'auto' | 'webgpu' | 'wasm';

/**
 * - mean/cls: pool `last_hidden_state` with the attention mask / first token
 * - model: the ONNX graph already outputs `sentence_embedding` (pooling + projection)
 * - auto: use `sentence_embedding` when present, otherwise mean pooling
 */
export type LocalPooling = 'mean' | 'cls' | 'model' | 'auto';

export interface LocalModelDefinition {
    /** Stable registry id stored in settings. */
    id: string;
    /** Hugging Face Hub repository with ONNX weights. */
    hfModelId: string;
    label: string;
    description: string;
    /** Output dimension, when known ahead of time. */
    dimension?: number;
    languages: string;
    /** Inputs are truncated to this many tokens. */
    maxTokens: number;
    queryPrefix: string;
    /** Prepended to document chunks. Ignored when `documentTemplate` is set. */
    documentPrefix: string;
    /**
     * Full document input template with `{title}` and `{text}` placeholders, for models
     * trained with a separate title field (e.g. EmbeddingGemma). When the template uses
     * `{title}`, the note title is passed separately and not repeated in the chunk text.
     */
    documentTemplate?: string;
    /**
     * Output sizes the model was trained to be truncated to (Matryoshka representation
     * learning), largest first. Truncated vectors must be re-normalized.
     */
    matryoshkaDimensions?: number[];
    pooling: LocalPooling;
    /**
     * Precision used when the precision setting is 'auto' and the device setting is
     * 'auto'/'webgpu'. Quantized (q8) graphs fall back to the CPU under WebGPU and are
     * ~10x slower there, so GPU defaults are fp32/fp16 (or q4, which has GPU kernels).
     */
    defaultDtype: LocalDtype;
    /** Precision used when the precision setting is 'auto' and the device setting is 'wasm'. */
    wasmDefaultDtype: LocalDtype;
    supportedDtypes: LocalDtype[];
    /**
     * Alternative ONNX file base names to load on the WASM backend, per precision
     * (e.g. ops without a WASM kernel). Same weights and outputs, different graph.
     */
    wasmModelFileNames?: Partial<Record<LocalDtype, string>>;
    /** Approximate download size per precision. */
    downloadSizes?: Partial<Record<LocalDtype, string>>;
}

export const DEFAULT_LOCAL_MODEL_ID = 'bge-small-en-v1.5';
export const CUSTOM_LOCAL_MODEL_ID = 'custom';

export const LOCAL_DTYPE_LABELS: Record<LocalDtype, string> = {
    fp32: 'fp32 (full precision)',
    fp16: 'fp16 (half precision, WebGPU)',
    q8: 'q8 (8-bit quantized)',
    q4: 'q4 (4-bit quantized)',
};

export const LOCAL_MODELS: readonly LocalModelDefinition[] = [
    {
        id: 'bge-small-en-v1.5',
        hfModelId: 'Xenova/bge-small-en-v1.5',
        label: 'BGE small (English)',
        description: 'Fast, strong English retrieval model. Recommended default.',
        dimension: 384,
        languages: 'English',
        maxTokens: 512,
        queryPrefix: 'Represent this sentence for searching relevant passages: ',
        documentPrefix: '',
        pooling: 'cls',
        defaultDtype: 'fp32',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'fp16', 'q8', 'q4'],
        downloadSizes: {
            fp32: '133 MB', fp16: '67 MB', q8: '34 MB', q4: '62 MB',
        },
    },
    {
        id: 'mxbai-embed-xsmall-v1',
        hfModelId: 'mixedbread-ai/mxbai-embed-xsmall-v1',
        label: 'mxbai xsmall (English)',
        description: 'Very small English model with a long context window.',
        dimension: 384,
        languages: 'English',
        maxTokens: 512,
        queryPrefix: '',
        documentPrefix: '',
        pooling: 'mean',
        defaultDtype: 'fp32',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'fp16', 'q8', 'q4'],
        downloadSizes: {
            fp32: '96 MB', fp16: '48 MB', q8: '24 MB', q4: '60 MB',
        },
    },
    {
        id: 'all-minilm-l6-v2',
        hfModelId: 'Xenova/all-MiniLM-L6-v2',
        label: 'MiniLM L6 (English)',
        description: 'Smallest and fastest; lower retrieval quality, 256-token inputs.',
        dimension: 384,
        languages: 'English',
        maxTokens: 256,
        queryPrefix: '',
        documentPrefix: '',
        pooling: 'mean',
        defaultDtype: 'fp32',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'fp16', 'q8', 'q4'],
        downloadSizes: {
            fp32: '90 MB', fp16: '45 MB', q8: '23 MB', q4: '55 MB',
        },
    },
    {
        id: 'multilingual-e5-small',
        hfModelId: 'Xenova/multilingual-e5-small',
        label: 'E5 small (multilingual)',
        description: 'Small model covering ~100 languages (English, French, ...).',
        dimension: 384,
        languages: 'Multilingual (~100 languages)',
        maxTokens: 512,
        queryPrefix: 'query: ',
        documentPrefix: 'passage: ',
        pooling: 'mean',
        // Large multilingual vocabulary: fp16 halves the download and is fastest on WebGPU.
        defaultDtype: 'fp16',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'fp16', 'q8', 'q4'],
        downloadSizes: {
            fp32: '470 MB', fp16: '235 MB', q8: '118 MB', q4: '399 MB',
        },
    },
    {
        id: 'embeddinggemma-300m',
        hfModelId: 'onnx-community/embeddinggemma-300m-ONNX',
        label: 'EmbeddingGemma 300M (multilingual, quality)',
        description: 'Highest quality option, 100+ languages. Slower to index; WebGPU recommended.',
        dimension: 768,
        languages: 'Multilingual (100+ languages)',
        maxTokens: 512,
        queryPrefix: 'task: search result | query: ',
        documentPrefix: '',
        documentTemplate: 'title: {title} | text: {text}',
        matryoshkaDimensions: [768, 512, 256, 128],
        pooling: 'model',
        defaultDtype: 'q4',
        wasmDefaultDtype: 'q4',
        // Activations overflow in fp16, so half-precision variants are not offered.
        supportedDtypes: ['fp32', 'q8', 'q4'],
        // The WASM backend has no GatherBlockQuantized kernel; this export keeps the embedding table unquantized.
        wasmModelFileNames: { q4: 'model_no_gather' },
        downloadSizes: {
            fp32: '1.2 GB', q8: '309 MB', q4: '197 MB',
        },
    },
];

const HF_MODEL_ID_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export function isValidHfModelId(value: string | undefined): boolean {
    return !!value && HF_MODEL_ID_PATTERN.test(value.trim());
}

export function getLocalModelDefinition(id: string | undefined): LocalModelDefinition | undefined {
    return LOCAL_MODELS.find((model) => model.id === id);
}

export interface LocalModelSelection {
    localModel?: string;
    localCustomModelId?: string;
}

/**
 * Resolve the configured local model. A custom Hub id gets a generic definition
 * (no prefixes, automatic pooling); unknown ids fall back to the default model.
 */
export function resolveLocalModel(selection: LocalModelSelection): LocalModelDefinition {
    if (selection.localModel === CUSTOM_LOCAL_MODEL_ID) {
        const hfModelId = selection.localCustomModelId?.trim() ?? '';
        if (isValidHfModelId(hfModelId)) {
            return {
                id: CUSTOM_LOCAL_MODEL_ID,
                hfModelId,
                label: hfModelId,
                description: 'Custom Hugging Face model (needs ONNX weights in an "onnx/" folder).',
                languages: 'Unknown',
                maxTokens: 512,
                queryPrefix: '',
                documentPrefix: '',
                pooling: 'auto',
                defaultDtype: 'fp32',
                wasmDefaultDtype: 'q8',
                supportedDtypes: ['fp32', 'fp16', 'q8', 'q4'],
            };
        }
    }

    return getLocalModelDefinition(selection.localModel)
        ?? getLocalModelDefinition(DEFAULT_LOCAL_MODEL_ID)!;
}

/**
 * Precision to load: the configured one if the model publishes it, otherwise the model
 * default for the configured device. Derived from settings only (never from runtime GPU
 * detection) so the index identity cannot flip when a GPU is briefly unavailable.
 */
export function resolveLocalDtype(
    model: LocalModelDefinition,
    setting: LocalDtypeSetting | undefined,
    device: LocalDeviceSetting | undefined,
): LocalDtype {
    if (setting && setting !== 'auto' && model.supportedDtypes.includes(setting)) {
        return setting;
    }
    return device === 'wasm' ? model.wasmDefaultDtype : model.defaultDtype;
}

/** Title used by title-aware templates when a document has none (EmbeddingGemma convention). */
export const MISSING_DOCUMENT_TITLE = 'none';

/** Whether the model takes the document title as a separate input field. */
export function usesDocumentTitle(model: LocalModelDefinition): boolean {
    return !!model.documentTemplate?.includes('{title}');
}

/**
 * Text actually fed to the model for a query or a document chunk.
 * `title` is only used by document templates with a `{title}` placeholder.
 */
export function formatEmbeddingInput(
    model: LocalModelDefinition,
    text: string,
    kind: 'query' | 'document',
    title?: string,
): string {
    if (kind === 'document' && model.documentTemplate) {
        const cleanTitle = title?.replace(/\s+/g, ' ').trim() || MISSING_DOCUMENT_TITLE;
        // Single pass so placeholders inside the title or text are never expanded.
        return model.documentTemplate.replace(/\{(title|text)\}/g, (_match, key: string) => (key === 'title' ? cleanTitle : text));
    }
    const prefix = kind === 'query' ? model.queryPrefix : model.documentPrefix;
    return prefix ? `${prefix}${text}` : text;
}

/**
 * Identifier of how inputs are prepared for this model (prefixes, pooling, truncation).
 * Changes whenever any of those change, so cached vectors are rebuilt.
 * Optional fields are only appended when set, so adding them leaves other models' ids unchanged.
 */
export function getLocalInputScheme(model: LocalModelDefinition): string {
    const parts: Array<string | number> = [model.queryPrefix, model.documentPrefix, model.pooling, model.maxTokens];
    if (model.documentTemplate) {
        parts.push(`template=${model.documentTemplate}`);
    }
    return `prefix-v1:${generateContentHash(parts.join('|'))}`;
}

/** Whether the model supports Matryoshka truncation. */
export function supportsMatryoshka(model: LocalModelDefinition): boolean {
    return (model.matryoshkaDimensions?.length ?? 0) > 0;
}

/**
 * Size to truncate vectors to, or undefined to keep the full output. Only sizes the
 * model was trained for and smaller than its full dimension are honored.
 */
export function resolveMatryoshkaDimension(model: LocalModelDefinition, requested: number | undefined): number | undefined {
    if (!requested || requested <= 0 || !model.matryoshkaDimensions?.includes(requested)) {
        return undefined;
    }
    if (model.dimension !== undefined && requested >= model.dimension) {
        return undefined;
    }
    return requested;
}

/**
 * Keep the first `dimension` components and re-normalize to unit length.
 * Returns the input unchanged when it is already that size or smaller.
 */
export function truncateEmbedding(vector: Float32Array, dimension: number | undefined): Float32Array {
    if (!dimension || vector.length <= dimension) {
        return vector;
    }
    // slice (not subarray) so the full-size buffer can be released
    const truncated = vector.slice(0, dimension);
    let normSquared = 0;
    for (let i = 0; i < truncated.length; i++) {
        const value = truncated[i] || 0;
        normSquared += value * value;
    }
    const norm = Math.sqrt(normSquared);
    if (norm > 0) {
        for (let i = 0; i < truncated.length; i++) {
            truncated[i] = (truncated[i] || 0) / norm;
        }
    }
    return truncated;
}

/**
 * One-line summary for settings, e.g. "384 dims · English · ~34 MB (q8)".
 * `dimension` overrides the model's output size (Matryoshka truncation).
 */
export function describeLocalModel(model: LocalModelDefinition, dtype: LocalDtype, dimension?: number): string {
    const parts: string[] = [];
    const dims = dimension ?? model.dimension;
    if (dims) {
        parts.push(model.dimension && dims !== model.dimension ? `${dims} of ${model.dimension} dims` : `${dims} dims`);
    }
    parts.push(model.languages);
    const size = model.downloadSizes?.[dtype];
    parts.push(size ? `~${size} download (${dtype})` : dtype);
    return parts.join(' · ');
}
