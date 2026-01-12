/**
 * Semantic search engine with multi-factor ranking
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchResult, SemanticSearchSettings } from './types';
import { logger } from '../../utils/logger';

export class SemanticSearchEngine {
    private embeddingService: EmbeddingService;

    private vault: Vault;

    private metadataCache: MetadataCache;

    private settings: SemanticSearchSettings;

    private searchCache: Map<string, SemanticSearchResult[]> = new Map();

    constructor(embeddingService: EmbeddingService, vault: Vault, metadataCache: MetadataCache, settings: SemanticSearchSettings) {
        this.embeddingService = embeddingService;
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
    }

    async search(query: string, options: {
        limit?: number;
        threshold?: number;
        useCache?: boolean;
        signal?: AbortSignal;
    } = {}): Promise<SemanticSearchResult[]> {
        const startTime = Date.now();
        const { limit = this.settings.maxResults, threshold = this.settings.searchThreshold, useCache = true, signal } = options;

        logger.debug(`Semantic search: Starting search for "${query}" (limit: ${limit}, threshold: ${threshold})`);

        // Avoid hitting the embedding API with trivial queries
        if (!query || query.trim().length < 2) {
            logger.debug('Semantic search: Query too short, skipping semantic lookup');
            return [];
        }

        // Check cache first
        const cacheKey = `${query}:${threshold}:${limit}`;
        if (useCache && this.searchCache.has(cacheKey)) {
            logger.debug(`Semantic search: Returning cached results for "${query}"`);
            return this.searchCache.get(cacheKey)!;
        }

        const indexedCount = this.embeddingService.getIndexedFileCount();
        if (indexedCount === 0) {
            logger.warn('Semantic search: No files indexed. Please run indexing first.');
            return [];
        }

        logger.debug(`Semantic search: Searching through ${indexedCount} indexed files`);

        // Generate query embedding
        logger.debug(`Semantic search: Generating embedding for query "${query}"`);
        const queryEmbedding = await this.embeddingService.generateEmbedding(query, 'search_query');
        logger.debug(`Semantic search: Query embedding generated (${queryEmbedding.length} dimensions)`);

        // Guard against empty or mismatched query embedding to avoid noisy logs
        if (queryEmbedding.length === 0) {
            logger.warn('Semantic search: Query embedding is empty. Aborting search. Check embedding API/model.');
            return [];
        }

        const results: SemanticSearchResult[] = [];
        const markdownFiles = this.vault.getMarkdownFiles();
        let checkedFiles = 0;
        let matchingFiles = 0;
        let totalChunksChecked = 0;

        for (const file of markdownFiles) {
            // Check for abort signal at start of each file iteration
            if (signal?.aborted) {
                logger.debug(`Semantic search: Aborted after ${checkedFiles} files`);
                return results.slice(0, limit); // Return partial results
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

        // Cache results
        if (useCache) {
            this.searchCache.set(cacheKey, sortedResults);

            // Limit cache size
            if (this.searchCache.size > 100) {
                const firstKey = this.searchCache.keys().next().value;
                this.searchCache.delete(firstKey);
                logger.debug('Semantic search: Cache size limited, removed oldest entry');
            }
        }

        const searchTime = Date.now() - startTime;
        logger.debug(`Semantic search: Search completed in ${searchTime}ms`);

        return sortedResults;
    }

    private calculateRelevanceScore(file: TFile, similarity: number, query: string): number {
        let score = similarity * 0.6; // Base semantic similarity (reduced weight)

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

        return Math.min(score, 1.0);
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
            maxSize: 100,
        };
    }

    /**
     * Get the embedding service for clustering operations
     */
    getEmbeddingService(): EmbeddingService {
        return this.embeddingService;
    }
}
