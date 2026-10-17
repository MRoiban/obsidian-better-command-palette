/**
 * Semantic search engine with multi-factor ranking
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchResult, SemanticSearchSettings } from './types';
import { LruCache } from './lru-cache';
import type { RerankService } from './rerank/rerank-service';
import { buildRerankPassage } from './rerank/rerank-passage';
import { sigmoid } from './rerank/rerank-blend';
import { logger } from '../../utils/logger';

const SEARCH_CACHE_MAX_SIZE = 100;
const QUERY_EMBEDDING_CACHE_MAX_SIZE = 64;

/** Weight of the semantic term in the relevance score (the rest are metadata bonuses). */
const SIMILARITY_WEIGHT = 0.6;

export interface SemanticSearchOptions {
    limit?: number;
    threshold?: number;
    useCache?: boolean;
    signal?: AbortSignal;
    /**
     * Apply the second-pass reranker when one is configured (default true). Hybrid
     * search passes false and reranks its fused list instead.
     */
    rerank?: boolean;
}

export class SemanticSearchEngine {
    private embeddingService: EmbeddingService;

    private vault: Vault;

    private metadataCache: MetadataCache;

    private settings: SemanticSearchSettings;

    private searchCache: Map<string, SemanticSearchResult[]> = new Map();

    /** Index version / model the search cache was built against; any change invalidates it. */
    private searchCacheIndexVersion = -1;

    private searchCacheFingerprint = '';

    /** Query text -> query vector, so the same query with a different limit/threshold is not re-embedded. */
    private queryEmbeddingCache = new LruCache<string, Float32Array>(QUERY_EMBEDDING_CACHE_MAX_SIZE);

    /** Optional cross-encoder for the second pass; owned (created/disposed) by the plugin. */
    private reranker: RerankService | null = null;

    constructor(embeddingService: EmbeddingService, vault: Vault, metadataCache: MetadataCache, settings: SemanticSearchSettings) {
        this.embeddingService = embeddingService;
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
    }

    setReranker(reranker: RerankService | null): void {
        this.reranker = reranker;
    }

    /**
     * First-pass vector search (cached), then, when a reranker is set, a cross-encoder
     * pass over the top-K within its time budget. Without a loaded model, or when the
     * budget is exceeded, the first-pass order is returned unchanged.
     */
    async search(query: string, options: SemanticSearchOptions = {}): Promise<SemanticSearchResult[]> {
        const { rerank = true, ...firstPassOptions } = options;
        const results = await this.searchFirstPass(query, firstPassOptions);
        const { reranker } = this;
        if (!rerank || !reranker || results.length < 2 || options.signal?.aborted) {
            return results;
        }
        return this.applyRerank(reranker, query, results, options.signal);
    }

    /**
     * Rescore the top-K: the reranker's relevance probability replaces the cosine
     * similarity term of the relevance score; metadata bonuses are kept (see rerank-blend.ts).
     */
    private async applyRerank(
        reranker: RerankService,
        query: string,
        results: SemanticSearchResult[],
        signal?: AbortSignal,
    ): Promise<SemanticSearchResult[]> {
        const topK = Math.min(reranker.getTopK(), results.length);
        const window = results.slice(0, topK);
        const outcome = await reranker.rerank(query, window.map((result) => ({
            id: result.file.path,
            passage: buildRerankPassage(result.file, this.metadataCache, result.matchedChunkText ?? result.excerpt),
        })), { signal });

        if (outcome.status !== 'applied') {
            logger.debug(`Semantic search: Rerank skipped (${outcome.status}) after ${outcome.elapsedMs}ms`);
            return results;
        }

        const reranked = window
            .map((result, index) => {
                const logit = outcome.scores.get(result.file.path);
                const relevanceScore = logit === undefined
                    ? result.relevanceScore
                    : Math.min(SIMILARITY_WEIGHT * sigmoid(logit) + this.calculateRelevanceBonus(result.file, query), 1.0);
                return { result: { ...result, relevanceScore }, index };
            })
            .sort((a, b) => (b.result.relevanceScore - a.result.relevanceScore) || (a.index - b.index))
            .map((entry) => entry.result);

        logger.debug(`Semantic search: Reranked top ${topK} in ${outcome.elapsedMs}ms`);
        return [...reranked, ...results.slice(topK)];
    }

    private async searchFirstPass(query: string, options: Omit<SemanticSearchOptions, 'rerank'> = {}): Promise<SemanticSearchResult[]> {
        const startTime = Date.now();
        const { limit = this.settings.maxResults, threshold = this.settings.searchThreshold, useCache = true, signal } = options;

        logger.debug(`Semantic search: Starting search for "${query}" (limit: ${limit}, threshold: ${threshold})`);

        if (signal?.aborted) {
            return [];
        }

        // Avoid hitting the embedding API with trivial queries
        if (!query || query.trim().length < 2) {
            logger.debug('Semantic search: Query too short, skipping semantic lookup');
            return [];
        }

        // Check cache first (dropped whenever the index or model changed)
        this.validateSearchCache();
        const indexVersionAtStart = this.embeddingService.getIndexVersion();
        const cacheKey = `${query}:${threshold}:${limit}`;
        if (useCache && this.searchCache.has(cacheKey)) {
            logger.debug(`Semantic search: Returning cached results for "${query}"`);
            return this.searchCache.get(cacheKey)!;
        }

        if (this.embeddingService.hasPendingModelChange()) {
            logger.debug('Semantic search: Embedding model changed; waiting for reindex');
            return [];
        }

        const indexedCount = this.embeddingService.getIndexedFileCount();
        if (indexedCount === 0) {
            logger.warn('Semantic search: No files indexed. Please run indexing first.');
            return [];
        }

        logger.debug(`Semantic search: Searching through ${indexedCount} indexed files`);

        // Generate query embedding
        logger.debug(`Semantic search: Generating embedding for query "${query}"`);
        let queryEmbedding: Float32Array;
        try {
            queryEmbedding = await this.getQueryEmbedding(query, signal);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                logger.debug(`Semantic search: Query embedding aborted for "${query}"`);
                return [];
            }
            throw error;
        }
        logger.debug(`Semantic search: Query embedding generated (${queryEmbedding.length} dimensions)`);

        if (signal?.aborted) {
            return [];
        }

        // Guard against empty or mismatched query embedding to avoid noisy logs
        if (queryEmbedding.length === 0) {
            logger.warn('Semantic search: Query embedding is empty. Aborting search. Check embedding API/model.');
            return [];
        }

        const results: SemanticSearchResult[] = [];
        const maxCandidates = Math.min(
            indexedCount,
            Math.max(limit * 50, 250),
        );
        const candidatePaths = this.embeddingService.getCandidateFilePaths(
            queryEmbedding,
            maxCandidates,
            threshold,
            signal,
        );
        let checkedFiles = 0;
        let matchingFiles = 0;
        let totalChunksChecked = 0;

        logger.debug(`Semantic search: Scanning ${candidatePaths.length}/${indexedCount} candidate files`);

        for (const filePath of candidatePaths) {
            // Check for abort signal at start of each file iteration
            if (signal?.aborted) {
                logger.debug(`Semantic search: Aborted after ${checkedFiles} files`);
                return results.slice(0, limit); // Return partial results
            }

            const file = this.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile)) {
                continue;
            }

            // Get all chunk embeddings for this file
            const chunkEmbeddings = this.embeddingService.getChunkEmbeddings(file.path);
            checkedFiles++;

            if (!chunkEmbeddings || chunkEmbeddings.length === 0) {
                continue;
            }

            // Find the best matching chunk for this file
            let bestChunkIndex = 0;
            let bestSimilarity = -1;
            let bestChunkText = '';

            for (let i = 0; i < chunkEmbeddings.length; i++) {
                // Check abort signal periodically inside chunk loop (every 10 chunks)
                if (i % 10 === 0 && signal?.aborted) {
                    return results.slice(0, limit);
                }

                const chunk = chunkEmbeddings[i];
                if (!chunk) continue;

                totalChunksChecked++;
                const similarity = this.embeddingService.cosineSimilarity(queryEmbedding, chunk.embedding);

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                    bestChunkIndex = i;
                    bestChunkText = chunk.text;
                }
            }

            if (bestSimilarity >= threshold) {
                matchingFiles++;
                const relevanceScore = this.calculateRelevanceScore(file, bestSimilarity, query);
                const matches = this.analyzeMatches(file, query);

                // Use the matched chunk's text as the excerpt (already contains relevant context)
                // Strip the file prefix if present (format: "filename tags: content")
                let excerpt = bestChunkText;
                const colonIndex = excerpt.indexOf(': ');
                if (colonIndex !== -1 && colonIndex < 100) {
                    excerpt = excerpt.substring(colonIndex + 2);
                }
                // Limit excerpt length
                if (excerpt.length > 200) {
                    excerpt = excerpt.substring(0, 200) + '...';
                }

                logger.debug(`Semantic search: Found match ${file.path} chunk ${bestChunkIndex + 1}/${chunkEmbeddings.length} (similarity: ${bestSimilarity.toFixed(3)}, relevance: ${relevanceScore.toFixed(3)})`);

                results.push({
                    file,
                    similarity: bestSimilarity,
                    relevanceScore,
                    title: file.basename,
                    excerpt,
                    matches,
                    matchedChunkIndex: bestChunkIndex,
                    matchedChunkText: bestChunkText,
                });
            }

        }

        logger.debug(`Semantic search: Found ${results.length} total matches from ${checkedFiles} files (${totalChunksChecked} total chunks scanned)`);

        // Sort by relevance score in descending order (highest similarity/relevance first)
        // relevanceScore combines similarity with title matches, recency, tags, and headings
        const sortedResults = results
            .sort((a, b) => {
                // Primary sort: relevance score (descending)
                const relevanceDiff = b.relevanceScore - a.relevanceScore;
                if (Math.abs(relevanceDiff) > 0.001) { // Use small epsilon to handle floating point precision
                    return relevanceDiff;
                }

                // Secondary sort: raw similarity score (descending) for ties
                const similarityDiff = b.similarity - a.similarity;
                if (Math.abs(similarityDiff) > 0.001) {
                    return similarityDiff;
                }

                // Tertiary sort: alphabetical by filename for consistent ordering
                return a.file.basename.localeCompare(b.file.basename);
            })
            .slice(0, limit);

        logger.debug(`Semantic search: Returning top ${sortedResults.length} results (limited from ${results.length}) sorted by relevance score`);

        // Verify sorting worked correctly in debug mode
        if (sortedResults.length > 1) {
            const firstScore = sortedResults[0].relevanceScore;
            const lastScore = sortedResults[sortedResults.length - 1].relevanceScore;
            logger.debug(`Semantic search: Score range: ${firstScore.toFixed(3)} (highest) to ${lastScore.toFixed(3)} (lowest)`);
        }

        // Cache results, unless the index changed while this search was running
        if (useCache && this.embeddingService.getIndexVersion() === indexVersionAtStart) {
            this.validateSearchCache();
            this.searchCache.set(cacheKey, sortedResults);

            // Limit cache size
            if (this.searchCache.size > SEARCH_CACHE_MAX_SIZE) {
                const firstKey = this.searchCache.keys().next().value;
                this.searchCache.delete(firstKey);
                logger.debug('Semantic search: Cache size limited, removed oldest entry');
            }
        }

        const searchTime = Date.now() - startTime;
        logger.debug(`Semantic search: Search completed in ${searchTime}ms`);

        return sortedResults;
    }

    private validateSearchCache(): void {
        const indexVersion = this.embeddingService.getIndexVersion();
        const fingerprint = this.embeddingService.getModelFingerprintKey();
        if (indexVersion !== this.searchCacheIndexVersion || fingerprint !== this.searchCacheFingerprint) {
            if (this.searchCache.size > 0) {
                logger.debug('Semantic search: Index changed, clearing search result cache');
            }
            this.searchCache.clear();
            this.searchCacheIndexVersion = indexVersion;
            this.searchCacheFingerprint = fingerprint;
        }
    }

    private async getQueryEmbedding(query: string, signal?: AbortSignal): Promise<Float32Array> {
        // Keyed by model fingerprint so a model change never reuses old query vectors
        const key = `${this.embeddingService.getModelFingerprintKey()}::${query}`;
        const cached = this.queryEmbeddingCache.get(key);
        if (cached) {
            logger.debug(`Semantic search: Reusing cached query embedding for "${query}"`);
            return cached;
        }

        const embedding = await this.embeddingService.generateEmbedding(query, 'search_query', 1, {
            signal,
            timeoutMs: this.settings.searchTimeoutMs,
        });
        if (embedding.length > 0) {
            this.queryEmbeddingCache.set(key, embedding);
        }
        return embedding;
    }

    private calculateRelevanceScore(file: TFile, similarity: number, query: string): number {
        return Math.min(SIMILARITY_WEIGHT * similarity + this.calculateRelevanceBonus(file, query), 1.0);
    }

    /** Metadata part of the relevance score: title/tag/heading matches, recency, size. */
    private calculateRelevanceBonus(file: TFile, query: string): number {
        let score = 0;

        const queryLower = query.toLowerCase();
        const titleLower = file.basename.toLowerCase();

        // Title match bonus (exact match gets higher bonus)
        if (titleLower === queryLower) {
            score += 0.25;
        } else if (titleLower.includes(queryLower)) {
            score += 0.15;
        }

        // Recency bonus
        const daysSinceModified = (Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24);
        if (daysSinceModified < 30) {
            score += 0.1 * Math.max(0, (30 - daysSinceModified) / 30);
        }

        // Tag match bonus
        const metadata = this.metadataCache.getFileCache(file);
        if (metadata?.tags?.some((tag) => tag.tag.toLowerCase().includes(queryLower))) {
            score += 0.1;
        }

        // Heading match bonus
        if (metadata?.headings?.some((heading) => heading.heading.toLowerCase().includes(queryLower))) {
            score += 0.08;
        }

        // File size factor (prefer medium-sized files)
        const fileSize = file.stat.size;
        if (fileSize > 1000 && fileSize < 50000) { // 1KB to 50KB sweet spot
            score += 0.02;
        }

        return score;
    }

    private analyzeMatches(file: TFile, query: string): {
        titleMatch: boolean;
        tagMatch: boolean;
        recentlyModified: boolean;
    } {
        const queryLower = query.toLowerCase();
        const metadata = this.metadataCache.getFileCache(file);

        return {
            titleMatch: file.basename.toLowerCase().includes(queryLower),
            tagMatch: metadata?.tags?.some((tag) => tag.tag.toLowerCase().includes(queryLower)) || false,
            recentlyModified: (Date.now() - file.stat.mtime) < (7 * 24 * 60 * 60 * 1000), // 7 days
        };
    }

    private async extractRelevantExcerpt(file: TFile, query: string, maxLength: number = 200): Promise<string> {
        try {
            const content = await this.vault.cachedRead(file);
            const queryWords = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2);

            // Split content into sentences
            const sentences = content.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0);

            // Score sentences based on query word matches
            const scoredSentences = sentences.map((sentence) => {
                const sentenceLower = sentence.toLowerCase();
                const matches = queryWords.filter((word) => sentenceLower.includes(word)).length;
                const wordDensity = matches / queryWords.length;

                return {
                    sentence,
                    score: wordDensity,
                    matches,
                };
            });

            // Find best sentence
            const bestSentence = scoredSentences.reduce((best, current) => (current.score > best.score ? current : best));

            if (bestSentence.matches > 0) {
                const { sentence } = bestSentence;
                return sentence.length > maxLength
                    ? `${sentence.substring(0, maxLength)}...`
                    : sentence;
            }

            // Fallback to beginning of content
            return `${content.substring(0, maxLength)}...`;
        } catch (error) {
            return 'Could not load content';
        }
    }

    clearSearchCache(): void {
        this.searchCache.clear();
        logger.debug('Semantic search: Search cache cleared');
    }

    /**
   * Update settings for the search engine
   */
    updateSettings(newSettings: SemanticSearchSettings): void {
        this.settings = newSettings;
        // Clear search cache when settings change as threshold/maxResults may have changed
        this.clearSearchCache();
        logger.debug('Semantic search: Search engine settings updated');
    }

    getCacheStats(): { size: number; maxSize: number } {
        return {
            size: this.searchCache.size,
            maxSize: SEARCH_CACHE_MAX_SIZE,
        };
    }

    /**
     * Get the embedding service for clustering operations
     */
    getEmbeddingService(): EmbeddingService {
        return this.embeddingService;
    }
}
