/**
 * How reranker scores are combined with first-pass rankings. Pure functions.
 *
 * Semantic search: the cross-encoder estimates query/passage relevance strictly better
 * than embedding cosine similarity, so for the top-K it *replaces* the similarity term
 * of the relevance score (relevance = w * relevanceProbability + metadata bonuses);
 * title/tag/heading/recency bonuses are kept. See SemanticSearchEngine.
 *
 * Hybrid search: the final score mixes retrieval with personal signals (usage,
 * PageRank, feedback, recency) on a scale that is not comparable to reranker logits.
 * Rather than calibrating the two, the top-K window is reordered with weighted
 * reciprocal rank fusion of the reranker order and the existing order (the same
 * scale-free technique hybrid search uses to fuse keyword and semantic lists). The
 * reranker carries most of the weight, while a result that is strongly preferred by
 * the existing signals is not discarded. Ties fall back to the existing final score.
 *
 * In both cases only the top-K window is reordered and stays above the remaining
 * results, which were not scored.
 */

/** Logit -> relevance probability (rerankers are trained with a sigmoid/BCE head). */
export function sigmoid(logit: number): number {
    return 1 / (1 + Math.exp(-logit));
}

/** RRF constant for the small rerank window (smaller than fusion's 60: K is ~20, not ~100s). */
export const RERANK_RRF_K = 10;

/** Share of the hybrid window ordering decided by the reranker vs. the existing ranking. */
export const RERANK_ORDER_WEIGHT = 0.7;
export const FIRST_PASS_ORDER_WEIGHT = 0.3;

/**
 * Reorder `items` (already in first-pass order) by weighted RRF of their reranker rank
 * and first-pass rank. Items without a score keep their first-pass position relative
 * to the scored ones by receiving the worst reranker rank.
 */
export function fuseRerankOrder<T>(
    items: readonly T[],
    getScore: (item: T) => number | undefined,
    getFirstPassScore: (item: T) => number,
): T[] {
    const byRerank = items
        .map((item, index) => ({ index, score: getScore(item) }))
        .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    const rerankRank = new Map<number, number>();
    byRerank.forEach((entry, rank) => {
        rerankRank.set(entry.index, entry.score === undefined ? items.length : rank + 1);
    });

    return items
        .map((item, index) => ({
            item,
            index,
            fused: RERANK_ORDER_WEIGHT / (RERANK_RRF_K + (rerankRank.get(index) ?? items.length))
                + FIRST_PASS_ORDER_WEIGHT / (RERANK_RRF_K + index + 1),
        }))
        .sort((a, b) => (b.fused - a.fused)
            || (getFirstPassScore(b.item) - getFirstPassScore(a.item))
            || (a.index - b.index))
        .map((entry) => entry.item);
}
