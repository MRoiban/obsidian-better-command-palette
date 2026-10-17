/**
 * Registry of local cross-encoder rerankers (second-pass relevance models).
 *
 * A cross-encoder reads (query, passage) together and outputs one relevance logit,
 * which is far more precise than comparing two independent embeddings, but costs a
 * full model pass per candidate. It is therefore only applied to the top first-pass
 * results. Pure module (no Obsidian imports) so it can be reused by tooling and tests.
 *
 * All entries were checked against the Hugging Face Hub: each repository publishes a
 * tokenizer.json and ONNX weights in "onnx/" usable by Transformers.js
 * (AutoModelForSequenceClassification) and outputs a single logit per pair.
 */

import type { LocalDeviceSetting, LocalDtype } from '../providers/model-registry';

export interface RerankerModelDefinition {
    /** Stable registry id stored in settings (`rerankerModel`). */
    id: string;
    /** Hugging Face Hub repository with ONNX weights. */
    hfModelId: string;
    label: string;
    description: string;
    languages: string;
    /** (query + passage) inputs are truncated to this many tokens. */
    maxTokens: number;
    /** Precision used on WebGPU (device setting 'auto'/'webgpu'). */
    defaultDtype: LocalDtype;
    /** Precision used on the CPU (device setting 'wasm'). */
    wasmDefaultDtype: LocalDtype;
    supportedDtypes: LocalDtype[];
    /** Approximate download size per precision. */
    downloadSizes: Partial<Record<LocalDtype, string>>;
    /**
     * Precisions published under non-standard ONNX file names: the file base name to load
     * and the Transformers.js dtype that maps to it (e.g. 'fp32' = no suffix).
     */
    fileOverrides?: Partial<Record<LocalDtype, { fileName: string; loadAs: LocalDtype }>>;
    license: string;
}

export const DEFAULT_RERANKER_MODEL_ID = 'mxbai-rerank-xsmall-v1';

export const RERANKER_MODELS: readonly RerankerModelDefinition[] = [
    {
        id: 'mxbai-rerank-xsmall-v1',
        hfModelId: 'mixedbread-ai/mxbai-rerank-xsmall-v1',
        label: 'mxbai rerank xsmall (English)',
        description: 'Small, fast English reranker (DeBERTa-v3 xsmall). Recommended default.',
        languages: 'English',
        maxTokens: 512,
        // Only fp32 and an 8-bit export are published (onnx/model.onnx, onnx/model_quantized.onnx).
        defaultDtype: 'fp32',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'q8'],
        downloadSizes: { fp32: '284 MB', q8: '87 MB' },
        license: 'Apache-2.0',
    },
    {
        id: 'mmarco-mminilmv2-l12-h384',
        hfModelId: 'cross-encoder/mmarco-mMiniLMv2-L12-H384-v1',
        label: 'mMiniLM mMARCO (multilingual, fast)',
        description: 'Small multilingual reranker trained on mMARCO (14 languages incl. French). Fast on the CPU.',
        languages: 'Multilingual (14 languages incl. English, French)',
        maxTokens: 512,
        defaultDtype: 'fp32',
        wasmDefaultDtype: 'q8',
        supportedDtypes: ['fp32', 'q8'],
        downloadSizes: { fp32: '471 MB', q8: '119 MB' },
        // The 8-bit export is published as onnx/model_qint8_arm64.onnx (no "_quantized" file).
        fileOverrides: { q8: { fileName: 'model_qint8_arm64', loadAs: 'fp32' } },
        license: 'Apache-2.0',
    },
    {
        id: 'bge-reranker-v2-m3',
        hfModelId: 'onnx-community/bge-reranker-v2-m3-ONNX',
        label: 'BGE reranker v2 m3 (multilingual, quality)',
        description: 'Highest quality, 100+ languages, but large (568M parameters). Needs WebGPU to stay within the time budget.',
        languages: 'Multilingual (100+ languages)',
        maxTokens: 512,
        defaultDtype: 'fp16',
        wasmDefaultDtype: 'q8',
        // fp32 is stored as external data (>2 GB) and is not offered.
        supportedDtypes: ['fp16', 'q8'],
        downloadSizes: { fp16: '1.14 GB', q8: '571 MB' },
        license: 'Apache-2.0',
    },
];

export function getRerankerModelDefinition(id: string | undefined): RerankerModelDefinition | undefined {
    return RERANKER_MODELS.find((model) => model.id === id);
}

/** Configured reranker, or the default for unknown ids. */
export function resolveRerankerModel(id: string | undefined): RerankerModelDefinition {
    return getRerankerModelDefinition(id) ?? getRerankerModelDefinition(DEFAULT_RERANKER_MODEL_ID)!;
}

/** Precision to load for the configured device (rerankers have no precision setting). */
export function resolveRerankerDtype(model: RerankerModelDefinition, device: LocalDeviceSetting | undefined): LocalDtype {
    return device === 'wasm' ? model.wasmDefaultDtype : model.defaultDtype;
}

/** Download size for the precision used on the given device, e.g. "87 MB". */
export function getRerankerDownloadSize(model: RerankerModelDefinition, device: LocalDeviceSetting | undefined): string | undefined {
    return model.downloadSizes[resolveRerankerDtype(model, device)];
}

/** One-line summary for settings, e.g. "English · ~87 MB download (q8 on CPU) · Apache-2.0". */
export function describeRerankerModel(model: RerankerModelDefinition, device: LocalDeviceSetting | undefined): string {
    const gpuDtype = model.defaultDtype;
    const cpuDtype = model.wasmDefaultDtype;
    const sizes = device === 'wasm' || gpuDtype === cpuDtype
        ? `~${model.downloadSizes[cpuDtype] ?? '?'} download (${cpuDtype})`
        : `~${model.downloadSizes[gpuDtype] ?? '?'} download on GPU (${gpuDtype}), ~${model.downloadSizes[cpuDtype] ?? '?'} on CPU (${cpuDtype})`;
    return [model.languages, sizes, model.license].join(' · ');
}
