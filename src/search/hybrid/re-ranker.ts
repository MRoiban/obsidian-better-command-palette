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
import { FusedResult, HybridSearchResult, HybridSearchSettings, HybridMatchDetails } from './types';
import { FileUsageTracker } from '../usage-tracker';
import { LinkGraphService } from '../link-graph-service';
import { TermFrequencyIndex } from '../term-frequency-index';
import { SegmentedQuery } from './query-segmenter';
import { logger } from '../../utils/logger';

/**
 * Re-ranker that refines hybrid search results using multiple signals
 */
export class HybridReRanker {
    private vault: Vault;

    private metadataCache: MetadataCache;

    private usageTracker: FileUsageTracker;

    private linkGraphService: LinkGraphService | null = null;

    private termFrequencyIndex: TermFrequencyIndex | null = null;

    private settings: HybridSearchSettings;

    // Per-search content cache to avoid redundant file reads
    private contentCache: Map<string, string> = new Map();

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
    }

    /**
     * Set the link graph service (for dependency injection after construction)
     */
    setLinkGraphService(service: LinkGraphService): void {
        this.linkGraphService = service;
    }

    /**
     * Update settings (called when settings change)
     */
    updateSettings(settings: HybridSearchSettings): void {
        this.settings = settings;
    }

    /**
     * Set the term frequency index for IDF-based term weighting
     */
    setTermFrequencyIndex(index: TermFrequencyIndex | null): void {
        this.termFrequencyIndex = index;
    }

    /**
     * Re-rank the top results using additional signals
     */
    async reRank(
        fusedResults: FusedResult[],
        query: string,
        segmentedQuery?: SegmentedQuery,
    ): Promise<HybridSearchResult[]> {
        const startTime = Date.now();
        const { reRankPoolSize, enableReRanking } = this.settings;

        // If re-ranking is disabled, just convert to HybridSearchResult
        if (!enableReRanking) {
            logger.debug('Hybrid re-ranker: Re-ranking disabled, using fusion scores only');
            return this.convertToHybridResults(fusedResults, query, false);
        }

        // Take top N for re-ranking
        const poolToReRank = fusedResults.slice(0, reRankPoolSize);
        const remainder = fusedResults.slice(reRankPoolSize);

        // Clear content cache for this search operation
        this.contentCache.clear();

        logger.debug(`Hybrid re-ranker: Re-ranking top ${poolToReRank.length} results`);

        // Compute re-ranking scores for the pool
        const reRankedPool = await Promise.all(
            poolToReRank.map((result) => this.computeReRankScore(result, query, segmentedQuery)),
        );

        // Sort by final score
        reRankedPool.sort((a, b) => b.finalScore - a.finalScore);

        // Convert remainder without re-ranking
        const convertedRemainder = await Promise.all(
            remainder.map((result) => this.convertSingleResult(result, query, 0)),
        );

        const allResults = [...reRankedPool, ...convertedRemainder];

        const elapsed = Date.now() - startTime;
        logger.debug(`Hybrid re-ranker: Completed in ${elapsed}ms`);

        return allResults;
    }

    /**
     * Compute re-ranking score for a single result
     */
    private async computeReRankScore(
        fusedResult: FusedResult,
        query: string,
        segmentedQuery?: SegmentedQuery,
    ): Promise<HybridSearchResult> {
        const {
            reRankTitleWeight,
            reRankRecencyWeight,
            reRankUsageWeight,
            reRankContentWeight,
            reRankPageRankWeight,
            reRankProximityWeight,
        } = this.settings;

        const file = fusedResult.file;
        const queryLower = query.toLowerCase();

        // 1. Title match score
        const titleScore = this.computeTitleScore(file, queryLower);

        // 2. Recency score
        const recencyScore = this.computeRecencyScore(file);

        // 3. Usage score (from usage tracker)
        const usageScore = this.computeUsageScore(file.path);

        // 4. Content density score (how much of the query appears in content)
        const contentScore = await this.computeContentDensityScore(file, queryLower);

        // 5. PageRank score (link importance)
        const pageRankScore = this.computePageRankScore(file.path);

        // 6. Proximity score (how close query terms appear to each other)
        const proximityScore = await this.computeProximityScore(file, queryLower, segmentedQuery);

        // 7. Bounce penalty (negative signal from pogo-sticking)
        const bounceScore = this.computeBounceScore(file.path);

        // Combine re-ranking signals (each score is 0-1)
        // PageRank weight defaults to 0 if not set
        const pageRankWeight = reRankPageRankWeight ?? 0.1;
        const proximityWeight = reRankProximityWeight ?? 0.15;
        const adjustedWeights = this.normalizeWeights(
            reRankTitleWeight,
            reRankRecencyWeight,
            reRankUsageWeight,
            reRankContentWeight,
            pageRankWeight,
            proximityWeight,
        );

        const reRankBoost = (
            adjustedWeights.title * titleScore
            + adjustedWeights.recency * recencyScore
            + adjustedWeights.usage * usageScore
            + adjustedWeights.content * contentScore
            + adjustedWeights.pageRank * pageRankScore
            + adjustedWeights.proximity * proximityScore
            - (0.1 * bounceScore) // Penalty for high bounce rate
        );

        // Final score: Scale fusion score to 0-1 range and combine with re-rank signals
        // RRF fusion score is typically in 0-0.03 range, so multiply by ~30 to normalize
        // Then blend 60% normalized fusion + 40% re-rank boost for final 0-1 score
        const normalizedFusionScore = Math.min(1, fusedResult.fusionScore * 30);
        const finalScore = Math.max(0, (0.6 * normalizedFusionScore) + (0.4 * reRankBoost));

        logger.debug(`Re-ranker: ${file.path} - fusion: ${fusedResult.fusionScore.toFixed(4)} -> ${normalizedFusionScore.toFixed(3)}, boost: ${reRankBoost.toFixed(3)}, pageRank: ${pageRankScore.toFixed(3)}, proximity: ${proximityScore.toFixed(3)}, bounce: ${bounceScore.toFixed(3)}, final: ${finalScore.toFixed(3)}`);

        return this.convertSingleResult(fusedResult, query, reRankBoost, finalScore);
    }

    /**
     * Normalize weights to ensure they sum to approximately 1
     */
    private normalizeWeights(
        title: number,
        recency: number,
        usage: number,
        content: number,
        pageRank: number,
        proximity: number,
    ): { title: number; recency: number; usage: number; content: number; pageRank: number; proximity: number } {
        const sum = title + recency + usage + content + pageRank + proximity;
        if (sum <= 0) {
            return { title: 1 / 6, recency: 1 / 6, usage: 1 / 6, content: 1 / 6, pageRank: 1 / 6, proximity: 1 / 6 };
        }
        return {
            title: title / sum,
            recency: recency / sum,
            usage: usage / sum,
            content: content / sum,
            pageRank: pageRank / sum,
            proximity: proximity / sum,
        };
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
        segmentedQuery?: SegmentedQuery,
    ): Promise<number> {
        // Use segments if available, otherwise fall back to simple word split
        const segments = segmentedQuery?.segments || [];
        const queryTerms = queryLower.split(/\s+/).filter((w) => w.length > 2);

        // Single term or no valid terms - no proximity to measure
        if (queryTerms.length <= 1) {
            return 0.5; // Neutral score
        }

        try {
            const content = await this.getFileContent(file);
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
                const segmentWords = segment.text.split(/\s+/).filter((w) => w.length > 2);
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
        const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
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
        const rawScore = this.usageTracker.getUsageScore(path);
        // Normalize to 0-1 range (assuming max usage score of 100)
        return Math.min(rawScore / 100, 1.0);
    }

    /**
     * Get file content with caching to avoid redundant reads within a single search
     */
    private async getFileContent(file: TFile): Promise<string> {
        const cached = this.contentCache.get(file.path);
        if (cached !== undefined) {
            return cached;
        }
        const content = await this.vault.cachedRead(file);
        this.contentCache.set(file.path, content);
        return content;
    }

    /**
     * Compute content density score (0-1)
     * Measures how many query terms appear in the content, weighted by IDF.
     * Rare terms contribute more to the score than common terms.
     */
    private async computeContentDensityScore(file: TFile, queryLower: string): Promise<number> {
        try {
            const content = await this.getFileContent(file);
            const contentLower = content.toLowerCase();

            const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
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

                const regex = new RegExp(word, 'gi');
                const matches = contentLower.match(regex);
                if (matches && matches.length > 0) {
                    // Score based on occurrence count (capped) weighted by IDF
                    // More occurrences = better, but diminishing returns after 5
                    const occurrenceScore = Math.min(matches.length / 5, 1);
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
        withReRank: boolean,
    ): Promise<HybridSearchResult[]> {
        return Promise.all(
            fusedResults.map((result) => {
                // Normalize fusion score to 0-1 range even without re-ranking
                const normalizedFusionScore = Math.min(1, result.fusionScore * 30);
                return this.convertSingleResult(result, query, 0, normalizedFusionScore);
            }),
        );
    }

    /**
     * Convert a single fused result to HybridSearchResult
     */
    private async convertSingleResult(
        fusedResult: FusedResult,
        query: string,
        reRankBoost: number,
        finalScore?: number,
    ): Promise<HybridSearchResult> {
        const file = fusedResult.file;

        // Get excerpt from semantic result or keyword snippet
        let excerpt = fusedResult.semanticResult?.excerpt
            || fusedResult.keywordResult?.snippet
            || '';

        // If no excerpt, generate one
        if (!excerpt) {
            excerpt = await this.generateExcerpt(file, query);
        }

        const matches = this.buildMatchDetails(fusedResult, query);

        // Always normalize the final score to 0-1 range
        const normalizedFinalScore = finalScore ?? Math.min(1, fusedResult.fusionScore * 30);

        return {
            file,
            path: fusedResult.path,
            title: file.basename,
            excerpt,
            finalScore: normalizedFinalScore,
            keywordScore: fusedResult.keywordResult?.normalizedScore ?? 0,
            semanticScore: fusedResult.semanticResult?.normalizedScore ?? 0,
            fusionScore: fusedResult.fusionScore,
            reRankBoost,
            source: fusedResult.source,
            keywordRank: fusedResult.keywordResult?.rank,
            semanticRank: fusedResult.semanticResult?.rank,
            matches,
            metadata: fusedResult.keywordResult?.metadata,
            lastModified: file.stat.mtime,
        };
    }

    /**
     * Generate an excerpt for a file
     */
    private async generateExcerpt(file: TFile, query: string, maxLength = 150): Promise<string> {
        try {
            const content = await this.vault.cachedRead(file);
            const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

            // Find the first sentence containing a query word
            const sentences = content.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);

            for (const sentence of sentences) {
                const sentenceLower = sentence.toLowerCase();
                if (queryWords.some((word) => sentenceLower.includes(word))) {
                    return sentence.length > maxLength
                        ? `${sentence.substring(0, maxLength)}...`
                        : sentence;
                }
            }

            // Fallback to beginning of content
            const firstContent = content.substring(0, maxLength).trim();
            return firstContent ? `${firstContent}...` : 'No preview available';
        } catch {
            return 'Could not load preview';
        }
    }
}
