/**
 * Builds the passage text a cross-encoder scores against the query.
 */

import type { MetadataCache, TFile } from 'obsidian';

/**
 * Passages are cut to this many characters (~150 tokens) before tokenization.
 * Inference time is roughly linear in total characters: measured on WebGPU with
 * mxbai-rerank-xsmall, 20 passages take ~1.1 s at 600 chars vs ~2.1 s at 1200,
 * so 600 keeps the default top-20 inside RERANK_TIME_BUDGET_MS. It also keeps
 * query + passage under the token limit, so the tokenizer rarely truncates
 * (which would drop the closing separator token).
 */
export const MAX_RERANK_PASSAGE_CHARS = 600;

/** Frontmatter `title` when present, otherwise the file name without extension. */
export function getNoteTitle(file: TFile, metadataCache: MetadataCache): string {
    const title = metadataCache.getFileCache(file)?.frontmatter?.title;
    if (typeof title === 'string' && title.trim()) {
        return title.trim();
    }
    return file.basename;
}

/**
 * "<note title>\n<body>", where body is the best-matching chunk (or a snippet).
 * Most embedding models store chunks as "<basename> tags: <text>", which already
 * carries the title; those are used as-is so the title is not doubled. Title-aware
 * models (e.g. EmbeddingGemma) store the bare chunk, which gets the title prepended.
 */
export function buildRerankPassage(file: TFile, metadataCache: MetadataCache, body: string | undefined): string {
    const text = (body ?? '').replace(/\s+/g, ' ').trim();
    const startsWithTitle = text.toLowerCase().startsWith(file.basename.toLowerCase());
    const passage = startsWithTitle || !text
        ? text || getNoteTitle(file, metadataCache)
        : `${getNoteTitle(file, metadataCache)}\n${text}`;
    return passage.length > MAX_RERANK_PASSAGE_CHARS ? passage.slice(0, MAX_RERANK_PASSAGE_CHARS) : passage;
}
