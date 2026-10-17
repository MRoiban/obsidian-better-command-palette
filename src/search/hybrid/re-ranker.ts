/**
 * Re-ranker for hybrid search results
 * 
 * Takes the top N fused results and applies additional scoring signals
 * to refine the ranking. This is inspired by Google's approach of using
 * a two-stage ranking system: fast initial retrieval + slower re-ranking.
 * 
 * Enhanced with:
 * - PageRank scoring: Files linked to by many other files rank higher
 * - Bounce detection: Files users quickly return from rank lower
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
import {
    FusedResult,
    HybridSearchResult,
    HybridSearchSettings,
    HybridMatchDetails,
} from './types';
import {
    HybridRelevanceScorer,
    HybridRetrievalContext,
    HybridReRankSignals,
    HybridFinalScore,
} from './relevance-scorer';
import { FileUsageTracker } from '../usage-tracker';
import { LinkGraphService } from '../link-graph-service';
import { TermFrequencyIndex } from '../term-frequency-index';
import { SegmentedQuery } from './query-segmenter';
import { logger } from '../../utils/logger';

export interface HybridReRankSession {
    contentCache: Map<string, string>;
    excerptCache: Map<string, string>;
    scoredContentCache: Map<string, string>;
}

/** Shortest query term that counts for lexical signals (keeps "AI", "UX"). */
const MIN_QUERY_TERM_LENGTH = 2;

/**
 * Split a lowercased query into unique lexical terms.
 * Duplicates are removed so "data data science" behaves like "data science".
 */
export function extractQueryTerms(queryLower: string): string[] {
    const terms = queryLower
        .split(/\s+/)
        .filter((term) => term.length >= MIN_QUERY_TERM_LENGTH);
    return [...new Set(terms)];
}

/**
 * Count non-overlapping literal occurrences of term in text, stopping at maxCount.
 */
export function countOccurrences(text: string, term: string, maxCount = Infinity): number {
    if (!term) {
        return 0;
    }

    let count = 0;
    let idx = text.indexOf(term);
    while (idx !== -1 && count < maxCount) {
        count++;
        idx = text.indexOf(term, idx + term.length);
    }
    return count;
}

/**
 * Re-ranker that refines hybrid search results using multiple signals
 */
export class HybridReRanker {
    private static readonly MAX_SCORING_CONTENT_CHARS = 12000;

    private static readonly PREFIX_SCORING_CONTENT_CHARS = 4000;

    /** Upper bound on how much of a large note is scanned to locate the query focus. */
    private static readonly FOCAL_SEARCH_MAX_CHARS = 200000;

    private vault: Vault;

    private metadataCache: MetadataCache;

    private usageTracker: FileUsageTracker;

    private linkGraphService: LinkGraphService | null = null;

    private termFrequencyIndex: TermFrequencyIndex | null = null;

    private settings: HybridSearchSettings;

    private relevanceScorer: HybridRelevanceScorer;

    constructor(
        vault: Vault,
        metadataCache: MetadataCache,
        usageTracker: FileUsageTracker,
        settings: HybridSearchSettings,
        linkGraphService?: LinkGraphService,
    ) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.usageTracker = usageTracker;
        this.settings = settings;
        this.linkGraphService = linkGraphService ?? null;
        this.relevanceScorer = new HybridRelevanceScorer(settings);
    }

    /**
     * Set the link graph service (for dependency injection after construction)
     */
    setLinkGraphService(service: LinkGraphService): void {
        this.linkGraphService = service;
    }

    clearLinkGraphService(): void {
        this.linkGraphService = null;
    }

    /**
     * Update settings (called when settings change)
     */
    updateSettings(settings: HybridSearchSettings): void {
        this.settings = settings;
        this.relevanceScorer.updateSettings(settings);
    }

    /**
     * Set the term frequency index for IDF-based term weighting
     */
    setTermFrequencyIndex(index: TermFrequencyIndex | null): void {
        this.termFrequencyIndex = index;
    }

    /**
     * Create a per-search cache session so streaming phases can reuse reads and excerpts.
     */
    createSearchSession(): HybridReRankSession {
        return {
            contentCache: new Map(),
            excerptCache: new Map(),
            scoredContentCache: new Map(),
        };
    }

    /**
     * Re-rank the top results using additional signals
     */
    async reRank(
        fusedResults: FusedResult[],
        query: string,
        segmentedQuery?: SegmentedQuery,
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<HybridSearchResult[]> {
        const startTime = Date.now();
        const { reRankPoolSize, enableReRanking } = this.settings;

        // If re-ranking is disabled, just convert to HybridSearchResult
        if (!enableReRanking) {
            logger.debug('Hybrid re-ranker: Re-ranking disabled, using fusion scores only');
            return this.convertToHybridResults(fusedResults, query, session);
        }

        const retrievalContext = this.relevanceScorer.createRetrievalContext(fusedResults);

        // Take top N for re-ranking
        const poolToReRank = fusedResults.slice(0, reRankPoolSize);
        const remainder = fusedResults.slice(reRankPoolSize);

        logger.debug(`Hybrid re-ranker: Re-ranking top ${poolToReRank.length} results`);

        // Compute re-ranking scores for the pool
        const reRankedPool = await Promise.all(
            poolToReRank.map((result) => this.computeReRankScore(
                result,
                query,
                retrievalContext,
                segmentedQuery,
                session,
            )),
        );

        // Score the remainder with the same formula, using only signals that need no file reads
        const convertedRemainder = await Promise.all(
            remainder.map((result) => this.convertSingleResult(
                result,
                query,
                this.relevanceScorer.score(result, this.computeCheapSignals(result.file, query), retrievalContext),
                session,
            )),
        );

        // Sort the full list once so the output is ordered by final score
        const allResults = [...reRankedPool, ...convertedRemainder]
            .sort((a, b) => b.finalScore - a.finalScore);

        const elapsed = Date.now() - startTime;
        logger.debug(`Hybrid re-ranker: Completed in ${elapsed}ms`);

        return allResults;
    }

    /**
     * Convert fused results into UI results without reading file content.
     *
     * Used for the fast streaming phase. When re-ranking is enabled the same
     * final-score formula as {@link reRank} is applied (with only the cheap,
     * IO-free signals) so scores stay on one scale and results do not reshuffle
     * just because the scale changed when the complete phase arrives.
     */
    async buildResults(
        fusedResults: FusedResult[],
        query: string,
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<HybridSearchResult[]> {
        if (!this.settings.enableReRanking) {
            return this.convertToHybridResults(fusedResults, query, session);
        }

        const retrievalContext = this.relevanceScorer.createRetrievalContext(fusedResults);
        const results = await Promise.all(
            fusedResults.map((result) => this.convertSingleResult(
                result,
                query,
                this.relevanceScorer.score(result, this.computeCheapSignals(result.file, query), retrievalContext),
                session,
            )),
        );
        return results.sort((a, b) => b.finalScore - a.finalScore);
    }

    /**
     * Build results for a filter-only query (frontmatter filters, no text).
     * Input order is preserved.
     */
    async buildFilterOnlyResults(
        files: TFile[],
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<HybridSearchResult[]> {
        const relevanceScore = this.relevanceScorer.scoreFilterMatch();
        return Promise.all(files.map(async (file) => {
            const fusedResult: FusedResult = {
                path: file.path,
                file,
                fusionScore: 0,
                source: 'keyword',
            };
            const result = await this.convertSingleResult(fusedResult, '', relevanceScore, session);
            return {
                ...result,
                matches: {
                    ...result.matches,
                    titleMatch: false,
                    tagMatch: false,
                    keywordMatches: [],
                    matchReason: 'Matched by frontmatter filters',
                },
            };
        }));
    }

    /**
     * Signals that can be computed without reading file content.
     * Content density is unknown (0); proximity is only known to be neutral for
     * single-term queries, otherwise it is treated as unmeasured (0).
     */
    private computeCheapSignals(file: TFile, query: string): HybridReRankSignals {
        const queryLower = query.toLowerCase();
        return {
            title: this.computeTitleScore(file, queryLower),
            recency: this.computeRecencyScore(file),
            usage: this.computeUsageScore(file.path),
            content: 0,
            pageRank: this.computePageRankScore(file.path),
            proximity: extractQueryTerms(queryLower).length <= 1 ? 0.5 : 0,
            bounce: this.computeBounceScore(file.path),
            feedback: this.computeFeedbackScore(file.path, query),
        };
    }

    /**
     * Compute re-ranking score for a single result
     */
    private async computeReRankScore(
        fusedResult: FusedResult,
        query: string,
        retrievalContext: HybridRetrievalContext,
        segmentedQuery?: SegmentedQuery,
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<HybridSearchResult> {
        const file = fusedResult.file;
        const queryLower = query.toLowerCase();

        // 1. Title match score
        const titleScore = this.computeTitleScore(file, queryLower);

        // 2. Recency score
        const recencyScore = this.computeRecencyScore(file);

        // 3. Usage score (from usage tracker)
        const usageScore = this.computeUsageScore(file.path);

        // 4. Content density score (how much of the query appears in content)
        const contentScore = await this.computeContentDensityScore(file, queryLower, fusedResult, session);

        // 5. PageRank score (link importance)
        const pageRankScore = this.computePageRankScore(file.path);

        // 6. Proximity score (how close query terms appear to each other)
        const proximityScore = await this.computeProximityScore(file, queryLower, fusedResult, segmentedQuery, session);

        // 7. Bounce penalty (negative signal from pogo-sticking)
        const bounceScore = this.computeBounceScore(file.path);

        // 8. Explicit user feedback from upvotes/downvotes
        const feedbackScore = this.computeFeedbackScore(file.path, query);

        const signals: HybridReRankSignals = {
            title: titleScore,
            recency: recencyScore,
            usage: usageScore,
            content: contentScore,
            pageRank: pageRankScore,
            proximity: proximityScore,
            bounce: bounceScore,
            feedback: feedbackScore,
        };

        const relevanceScore = this.relevanceScorer.score(fusedResult, signals, retrievalContext);

        logger.debug(`Re-ranker: ${file.path} - fusion: ${fusedResult.fusionScore.toFixed(4)} -> ${relevanceScore.breakdown.normalizedFusionScore.toFixed(3)}, raw: ${relevanceScore.breakdown.rawScore.toFixed(3)}, retrieval: ${relevanceScore.breakdown.retrievalScore.toFixed(3)}, boost: ${relevanceScore.reRankBoost.toFixed(3)}, pageRank: ${pageRankScore.toFixed(3)}, proximity: ${proximityScore.toFixed(3)}, bounce: ${bounceScore.toFixed(3)}, feedback: ${feedbackScore.toFixed(3)}, final: ${relevanceScore.finalScore.toFixed(3)}`);

        return this.convertSingleResult(fusedResult, query, relevanceScore, session);
    }

    /**
     * Compute PageRank score (0-1) from link graph
     */
    private computePageRankScore(path: string): number {
        if (!this.linkGraphService) {
            return 0;
        }
        return this.linkGraphService.getPageRankScore(path);
    }

    /**
     * Compute bounce score (0-1) from usage tracker
     * Higher score means more bounces (bad signal)
     */
    private computeBounceScore(path: string): number {
        return this.usageTracker.getBounceScore(path);
    }

    /**
     * Compute explicit feedback score (-1 to 1) from upvotes/downvotes.
     */
    private computeFeedbackScore(path: string, query: string): number {
        return this.usageTracker.getResultFeedbackScore(path, query);
    }

    /**
     * Compute proximity score (0-1) measuring how close query terms appear to each other.
     * Uses the minimum span window algorithm to find the smallest text region
     * containing all query terms, then scores inversely to span size.
     * 
     * When segments are provided, prioritizes terms within same segment being close.
     * Inspired by Marginalia Search's term proximity scoring.
     */
    private async computeProximityScore(
        file: TFile,
        queryLower: string,
        fusedResult: FusedResult,
        segmentedQuery?: SegmentedQuery,
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<number> {
        // Use segments if available, otherwise fall back to simple word split
        const segments = segmentedQuery?.segments || [];
        const queryTerms = extractQueryTerms(queryLower);

        // Single term or no valid terms - no proximity to measure
        if (queryTerms.length <= 1) {
            return 0.5; // Neutral score
        }

        try {
            const content = await this.getScoringContent(file, queryLower, fusedResult, session);
            const contentLower = content.toLowerCase();

            // Find all positions of each query term
            const termPositions: Map<string, number[]> = new Map();
            for (const term of queryTerms) {
                const positions: number[] = [];
                let idx = contentLower.indexOf(term);
                while (idx !== -1) {
                    positions.push(idx);
                    idx = contentLower.indexOf(term, idx + 1);
                }
                if (positions.length > 0) {
                    termPositions.set(term, positions);
                }
            }

            // If not all terms are found, score based on coverage
            if (termPositions.size < queryTerms.length) {
                const coverage = termPositions.size / queryTerms.length;
                return coverage * 0.3; // Partial score for partial matches
            }

            // If we have segments with phrases, compute segment-aware proximity
            if (segments.length > 0 && segments.some((s) => s.isPhrase)) {
                return this.computeSegmentAwareProximity(contentLower, segments, termPositions);
            }

            // Fall back to standard minimum span
            const minSpan = this.findMinimumSpan(termPositions, queryTerms);

            if (minSpan === Infinity) {
                return 0;
            }

            // Calculate expected minimum span (terms adjacent)
            const expectedMinSpan = queryTerms.reduce((sum, t) => sum + t.length, 0)
                + (queryTerms.length - 1);

            // Score inversely proportional to span size
            const spanRatio = minSpan / expectedMinSpan;
            const score = 1 / (1 + Math.log(Math.max(1, spanRatio)));

            return Math.min(1, Math.max(0, score));
        } catch {
            return 0;
        }
    }

    /**
     * Compute segment-aware proximity score.
     * Terms within the same segment should appear close together.
     */
    private computeSegmentAwareProximity(
        contentLower: string,
        segments: Array<{ text: string; isPhrase: boolean }>,
        termPositions: Map<string, number[]>,
    ): number {
        let totalScore = 0;
        let segmentCount = 0;

        for (const segment of segments) {
            if (!segment.isPhrase) {
                // Single word segment - check if it exists
                if (termPositions.has(segment.text)) {
                    totalScore += 1.0; // Full score for found single terms
                    segmentCount++;
                }
                continue;
            }

            // Multi-word phrase segment - check if phrase appears in content
            const phraseIndex = contentLower.indexOf(segment.text);
            if (phraseIndex !== -1) {
                // Phrase found exactly - perfect score for this segment
                totalScore += 1.0;
            } else {
                // Phrase not found exactly - compute proximity of segment words
                const segmentWords = extractQueryTerms(segment.text);
                if (segmentWords.length > 1) {
                    // Build positions map for just this segment's words
                    const segmentTermPositions = new Map<string, number[]>();
                    for (const word of segmentWords) {
                        const positions = termPositions.get(word);
                        if (positions) {
                            segmentTermPositions.set(word, positions);
                        }
                    }

                    if (segmentTermPositions.size === segmentWords.length) {
                        // All segment words found - compute span
                        const minSpan = this.findMinimumSpan(segmentTermPositions, segmentWords);
                        const expectedSpan = segmentWords.reduce((sum, t) => sum + t.length, 0)
                            + (segmentWords.length - 1);
                        const spanRatio = minSpan / expectedSpan;
                        const segmentScore = 1 / (1 + Math.log(Math.max(1, spanRatio)));
                        totalScore += segmentScore;
                    } else {
                        // Some words missing - partial score
                        const coverage = segmentTermPositions.size / segmentWords.length;
                        totalScore += coverage * 0.3;
                    }
                }
            }
            segmentCount++;
        }

        if (segmentCount === 0) return 0.5;
        return Math.min(1, Math.max(0, totalScore / segmentCount));
    }

    /**
     * Find the minimum span window containing at least one occurrence of each term.
     * Uses a sliding window approach over all term positions.
     */
    private findMinimumSpan(
        termPositions: Map<string, number[]>,
        queryTerms: string[],
    ): number {
        // Merge all positions into a single sorted list with term labels
        const allPositions: Array<{ pos: number; term: string; endPos: number }> = [];
        for (const term of queryTerms) {
            const positions = termPositions.get(term);
            if (positions) {
                for (const pos of positions) {
                    allPositions.push({ pos, term, endPos: pos + term.length });
                }
            }
        }

        if (allPositions.length === 0) {
            return Infinity;
        }

        // Sort by position
        allPositions.sort((a, b) => a.pos - b.pos);

        // Sliding window to find minimum span
        const termCount = new Map<string, number>();
        let uniqueTerms = 0;
        const requiredTerms = queryTerms.length;
        let minSpan = Infinity;
        let left = 0;

        for (let right = 0; right < allPositions.length; right++) {
            const rightItem = allPositions[right];
            const rightCount = termCount.get(rightItem.term) || 0;
            if (rightCount === 0) {
                uniqueTerms++;
            }
            termCount.set(rightItem.term, rightCount + 1);

            // Contract window from left while still valid
            while (uniqueTerms === requiredTerms && left <= right) {
                const span = allPositions[right].endPos - allPositions[left].pos;
                minSpan = Math.min(minSpan, span);

                const leftItem = allPositions[left];
                const leftCount = termCount.get(leftItem.term) || 0;
                termCount.set(leftItem.term, leftCount - 1);
                if (leftCount - 1 === 0) {
                    uniqueTerms--;
                }
                left++;
            }
        }

        return minSpan;
    }

    /**
     * Compute title match score (0-1)
     */
    private computeTitleScore(file: TFile, queryLower: string): number {
        const titleLower = file.basename.toLowerCase();

        // Exact match
        if (titleLower === queryLower) {
            return 1.0;
        }

        // Title starts with query
        if (titleLower.startsWith(queryLower)) {
            return 0.8;
        }

        // Title contains query
        if (titleLower.includes(queryLower)) {
            return 0.6;
        }

        // Check individual query words
        const queryWords = extractQueryTerms(queryLower);
        const matchedWords = queryWords.filter((word) => titleLower.includes(word));
        if (matchedWords.length > 0) {
            return 0.4 * (matchedWords.length / queryWords.length);
        }

        return 0;
    }

    /**
     * Compute recency score (0-1)
     * Uses exponential decay based on last ACCESS time (from usage tracker)
     * This is based on when the user actually opened the file, not modification time.
     * 
     * Once the decayed score falls below the threshold, it snaps to 0 (no boost).
     */
    private computeRecencyScore(file: TFile): number {
        const RECENCY_FLOOR_THRESHOLD = 0.1; // Below this, no recency boost

        // Get recency score from usage tracker (based on last access)
        const accessRecency = this.usageTracker.getRecencyScore(file.path);

        // If never accessed, no recency boost
        if (accessRecency === 0) {
            return 0;
        }

        // Apply floor: if decayed value is below threshold, snap to 0
        return accessRecency >= RECENCY_FLOOR_THRESHOLD ? accessRecency : 0;
    }

    /**
     * Compute usage score from usage tracker (0-1)
     */
    private computeUsageScore(path: string): number {
        // FileUsageTracker.getUsageScore is already normalized to 0-1
        const score = this.usageTracker.getUsageScore(path);
        return Math.max(0, Math.min(score, 1.0));
    }

    /**
     * Get file content with caching to avoid redundant reads within a search.
     */
    private async getFileContent(file: TFile, session: HybridReRankSession): Promise<string> {
        const cached = session.contentCache.get(file.path);
        if (cached !== undefined) {
            return cached;
        }
        const content = await this.vault.cachedRead(file);
        session.contentCache.set(file.path, content);
        return content;
    }

    /**
     * Re-ranking only needs a bounded content window. Keep the file prefix plus a query-relevant window.
     */
    private async getScoringContent(
        file: TFile,
        queryLower: string,
        fusedResult: FusedResult,
        session: HybridReRankSession,
    ): Promise<string> {
        const cacheKey = `${file.path}::${queryLower}`;
        const cached = session.scoredContentCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const content = await this.getFileContent(file, session);
        const scoredContent = this.limitContentForScoring(content, queryLower, fusedResult);
        session.scoredContentCache.set(cacheKey, scoredContent);
        return scoredContent;
    }

    private limitContentForScoring(content: string, queryLower: string, fusedResult: FusedResult): string {
        const maxChars = HybridReRanker.MAX_SCORING_CONTENT_CHARS;
        if (content.length <= maxChars) {
            return content;
        }

        const focalIndex = this.findFocalContentIndex(content, queryLower, fusedResult);
        if (focalIndex < 0) {
            return content.slice(0, maxChars);
        }

        const prefixChars = Math.min(HybridReRanker.PREFIX_SCORING_CONTENT_CHARS, maxChars);
        const windows: Array<{ start: number; end: number }> = [
            { start: 0, end: prefixChars },
        ];

        const secondaryChars = Math.max(maxChars - prefixChars, 0);
        if (secondaryChars > 0) {
            const halfWindow = Math.floor(secondaryChars / 2);
            const start = Math.max(0, focalIndex - halfWindow);
            const end = Math.min(content.length, start + secondaryChars);
            windows.push({
                start: Math.max(0, end - secondaryChars),
                end,
            });
        }

        const mergedWindows = windows
            .sort((a, b) => a.start - b.start)
            .reduce<Array<{ start: number; end: number }>>((acc, window) => {
                const previous = acc[acc.length - 1];
                if (!previous || window.start > previous.end) {
                    acc.push({ ...window });
                    return acc;
                }

                previous.end = Math.max(previous.end, window.end);
                return acc;
            }, []);

        return mergedWindows
            .map((window) => content.slice(window.start, window.end))
            .join('\n...\n');
    }

    private findFocalContentIndex(content: string, queryLower: string, fusedResult: FusedResult): number {
        // Only lowercase/scan a bounded prefix so very large notes stay cheap per query
        const contentLower = content.length > HybridReRanker.FOCAL_SEARCH_MAX_CHARS
            ? content.slice(0, HybridReRanker.FOCAL_SEARCH_MAX_CHARS).toLowerCase()
            : content.toLowerCase();
        const semanticChunk = fusedResult.semanticResult?.matchedChunkText?.toLowerCase().trim();

        if (semanticChunk) {
            const semanticPrefix = semanticChunk.slice(0, 250);
            const semanticIndex = contentLower.indexOf(semanticPrefix);
            if (semanticIndex !== -1) {
                return semanticIndex;
            }
        }

        const fullQueryIndex = contentLower.indexOf(queryLower);
        if (fullQueryIndex !== -1) {
            return fullQueryIndex;
        }

        const queryTerms = extractQueryTerms(queryLower)
            .sort((a, b) => b.length - a.length);

        for (const term of queryTerms) {
            const termIndex = contentLower.indexOf(term);
            if (termIndex !== -1) {
                return termIndex;
            }
        }

        return -1;
    }

    /**
     * Compute content density score (0-1)
     * Measures how many query terms appear in the content, weighted by IDF.
     * Rare terms contribute more to the score than common terms.
     */
    private async computeContentDensityScore(
        file: TFile,
        queryLower: string,
        fusedResult: FusedResult,
        session: HybridReRankSession,
    ): Promise<number> {
        try {
            const content = await this.getScoringContent(file, queryLower, fusedResult, session);
            const contentLower = content.toLowerCase();

            const queryWords = extractQueryTerms(queryLower);
            if (queryWords.length === 0) return 0;

            // Get IDF weights for query terms (or uniform weights if no index)
            const termWeights = this.termFrequencyIndex?.getTermWeights(queryWords)
                ?? new Map(queryWords.map((w) => [w, 1 / queryWords.length]));

            // Compute IDF-weighted score
            let weightedScore = 0;
            let totalWeight = 0;

            for (const word of queryWords) {
                const weight = termWeights.get(word) ?? (1 / queryWords.length);
                totalWeight += weight;

                // Literal match (query terms like "c++" or "s.i" are not patterns)
                const occurrences = countOccurrences(contentLower, word, 5);
                if (occurrences > 0) {
                    // Score based on occurrence count (capped) weighted by IDF
                    // More occurrences = better, but diminishing returns after 5
                    const occurrenceScore = Math.min(occurrences / 5, 1);
                    weightedScore += weight * occurrenceScore;
                }
            }

            return totalWeight > 0 ? weightedScore / totalWeight : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Build match details for a result
     */
    private buildMatchDetails(
        fusedResult: FusedResult,
        query: string,
    ): HybridMatchDetails {
        const queryLower = query.toLowerCase();
        const file = fusedResult.file;

        // Title match
        const titleMatch = file.basename.toLowerCase().includes(queryLower);

        // Tag match
        const metadata = this.metadataCache.getFileCache(file);
        const tagMatch = metadata?.tags?.some(
            (tag) => tag.tag.toLowerCase().includes(queryLower),
        ) || false;

        // Recently modified (within 7 days)
        const recentlyModified = (Date.now() - file.stat.mtime) < (7 * 24 * 60 * 60 * 1000);

        // Keyword matches from keyword search
        const keywordMatches: string[] = [];
        if (fusedResult.keywordResult?.matches) {
            Object.values(fusedResult.keywordResult.matches).forEach((matches) => {
                keywordMatches.push(...matches);
            });
        }

        // Build match reason
        const matchReason = this.buildMatchReason(fusedResult, titleMatch, tagMatch);

        return {
            titleMatch,
            tagMatch,
            recentlyModified,
            keywordMatches: [...new Set(keywordMatches)].slice(0, 5), // Dedupe and limit
            semanticSimilarity: fusedResult.semanticResult?.similarity,
            matchReason,
        };
    }

    /**
     * Build human-readable match reason
     */
    private buildMatchReason(
        fusedResult: FusedResult,
        titleMatch: boolean,
        tagMatch: boolean,
    ): string {
        const reasons: string[] = [];

        if (fusedResult.source === 'both') {
            reasons.push('Matched by keywords and meaning');
        } else if (fusedResult.source === 'keyword') {
            reasons.push('Matched by keywords');
        } else {
            reasons.push('Matched by meaning');
        }

        if (titleMatch) {
            reasons.push('title matches');
        }

        if (tagMatch) {
            reasons.push('tag matches');
        }

        if (fusedResult.semanticResult?.similarity && fusedResult.semanticResult.similarity > 0.7) {
            reasons.push('highly relevant content');
        }

        return reasons.join(' • ');
    }

    /**
     * Convert fused results to HybridSearchResult without re-ranking
     */
    private async convertToHybridResults(
        fusedResults: FusedResult[],
        query: string,
        session: HybridReRankSession,
    ): Promise<HybridSearchResult[]> {
        const retrievalContext = this.relevanceScorer.createRetrievalContext(fusedResults);
        const results = await Promise.all(
            fusedResults.map((result) => {
                const relevanceScore = this.relevanceScorer.scoreWithoutReRanking(result, retrievalContext);
                return this.convertSingleResult(result, query, relevanceScore, session);
            }),
        );
        return results.sort((a, b) => b.finalScore - a.finalScore);
    }

    /**
     * Convert a single fused result to HybridSearchResult
     */
    private async convertSingleResult(
        fusedResult: FusedResult,
        query: string,
        relevanceScore: HybridFinalScore,
        session: HybridReRankSession = this.createSearchSession(),
    ): Promise<HybridSearchResult> {
        const file = fusedResult.file;

        // Get excerpt from semantic result or keyword snippet
        let excerpt = fusedResult.semanticResult?.excerpt
            || fusedResult.keywordResult?.snippet
            || '';

        // If no excerpt, generate one
        if (!excerpt) {
            excerpt = await this.generateExcerpt(file, query, 150, session);
        }

        const matches = this.buildMatchDetails(fusedResult, query);

        // Scores are already normalized by HybridRelevanceScorer.
        const normalizedFinalScore = relevanceScore.finalScore;

        return {
            file,
            path: fusedResult.path,
            title: file.basename,
            excerpt,
            finalScore: normalizedFinalScore,
            keywordScore: fusedResult.keywordResult?.normalizedScore ?? 0,
            semanticScore: fusedResult.semanticResult?.normalizedScore ?? 0,
            fusionScore: fusedResult.fusionScore,
            reRankBoost: relevanceScore.reRankBoost,
            scoreBreakdown: relevanceScore.breakdown,
            source: fusedResult.source,
            keywordRank: fusedResult.keywordResult?.rank,
            semanticRank: fusedResult.semanticResult?.rank,
            semanticMatchedChunkIndex: fusedResult.semanticResult?.matchedChunkIndex,
            matches,
            metadata: fusedResult.keywordResult?.metadata,
            lastModified: file.stat.mtime,
        };
    }

    /**
     * Generate an excerpt for a file
     */
    private async generateExcerpt(
        file: TFile,
        query: string,
        maxLength = 150,
        session: HybridReRankSession,
    ): Promise<string> {
        try {
            const cached = session.excerptCache.get(file.path);
            if (cached !== undefined) {
                return cached;
            }

            const content = await this.getFileContent(file, session);
            const queryWords = extractQueryTerms(query.toLowerCase());

            // Find the first sentence containing a query word
            const sentences = queryWords.length === 0
                ? []
                : content.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);

            for (const sentence of sentences) {
                const sentenceLower = sentence.toLowerCase();
                if (queryWords.some((word) => sentenceLower.includes(word))) {
                    const excerpt = sentence.length > maxLength
                        ? `${sentence.substring(0, maxLength)}...`
                        : sentence;
                    session.excerptCache.set(file.path, excerpt);
                    return excerpt;
                }
            }

            // Fallback to beginning of content
            const firstContent = content.substring(0, maxLength).trim();
            const excerpt = firstContent ? `${firstContent}...` : 'No preview available';
            session.excerptCache.set(file.path, excerpt);
            return excerpt;
        } catch {
            return 'Could not load preview';
        }
    }
}
