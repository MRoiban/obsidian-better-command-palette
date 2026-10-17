/**
 * Hybrid Search Service
 * 
 * Orchestrates keyword (MiniSearch) and semantic (embedding) search,
 * fuses results using RRF, and applies re-ranking for optimal results.
 * 
 * This provides a "Google-like" search experience by combining:
 * 1. Fast keyword matching for precise term lookups
 * 2. Semantic understanding for conceptual queries
 * 3. Multi-factor ranking for relevance
 * 4. PageRank-style link importance scoring
 * 5. User feedback signals (bounce detection)
 */

import { App, TFile } from 'obsidian';
import { EnhancedSearchService } from '../enhanced-search-service';
import { SemanticSearchEngine } from '../semantic/semantic-search-engine';
import { FileUsageTracker } from '../usage-tracker';
import { LinkGraphService } from '../link-graph-service';
import { normalizeKeywordResults, normalizeSemanticResults, fuseResults } from './fusion';
import { HybridReRanker } from './re-ranker';
import { QuerySegmenter } from './query-segmenter';
import {
    parseQueryFilters, evaluateAllFilters, getFrontmatter, serializeFilters, QueryFilter,
} from './query-filter-parser';
import { applyClusteringIfEnabled } from './result-clusterer';
import {
    FusedResult,
    HybridSearchResult,
    HybridSearchSettings,
    DEFAULT_HYBRID_SEARCH_SETTINGS,
} from './types';
import type { RerankService, RerankStatus } from '../semantic/rerank/rerank-service';
import { buildRerankPassage } from '../semantic/rerank/rerank-passage';
import { fuseRerankOrder, sigmoid } from '../semantic/rerank/rerank-blend';
import { logger } from '../../utils/logger';

export interface HybridSearchOptions {
    /** Maximum results to return */
    limit?: number;
    /** Minimum score threshold */
    threshold?: number;
    /** Skip keyword search (semantic only) */
    semanticOnly?: boolean;
    /** Skip semantic search (keyword only) */
    keywordOnly?: boolean;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}

/**
 * Main hybrid search service that combines keyword and semantic search
 */
export class HybridSearchService {
    private app: App;

    private keywordSearch: EnhancedSearchService;

    private semanticSearch: SemanticSearchEngine | null;

    private usageTracker: FileUsageTracker;

    private linkGraphService: LinkGraphService | null = null;

    private reRanker: HybridReRanker;

    /** Optional cross-encoder second pass over the final top-K; owned by the plugin. */
    private crossEncoder: RerankService | null = null;

    private querySegmenter: QuerySegmenter;

    private settings: HybridSearchSettings;

    private isInitialized = false;

    private searchCache: Map<string, { results: HybridSearchResult[]; timestamp: number }> = new Map();

    private readonly CACHE_TTL_MS = 30000; // 30 second cache

    private readonly KEYWORD_PHASE_RESULT_MULTIPLIER = 2;

    constructor(
        app: App,
        keywordSearch: EnhancedSearchService,
        semanticSearch: SemanticSearchEngine | null,
        usageTracker: FileUsageTracker,
        settings?: Partial<HybridSearchSettings>,
        linkGraphService?: LinkGraphService,
    ) {
        this.app = app;
        this.keywordSearch = keywordSearch;
        this.semanticSearch = semanticSearch;
        this.usageTracker = usageTracker;
        this.linkGraphService = linkGraphService ?? null;
        this.settings = { ...DEFAULT_HYBRID_SEARCH_SETTINGS, ...settings };

        this.reRanker = new HybridReRanker(
            app.vault,
            app.metadataCache,
            usageTracker,
            this.settings,
            this.linkGraphService ?? undefined,
        );

        // Wire up term frequency index for IDF-based term weighting
        const termFreqIndex = this.keywordSearch.getTermFrequencyIndex();
        this.reRanker.setTermFrequencyIndex(termFreqIndex);

        this.querySegmenter = new QuerySegmenter();

        logger.debug('HybridSearchService: Initialized');
    }

    /**
     * Set the link graph service (for dependency injection after construction)
     */
    setLinkGraphService(service: LinkGraphService): void {
        this.linkGraphService = service;
        this.reRanker.setLinkGraphService(service);
        logger.debug('HybridSearchService: LinkGraphService set');
    }

    clearLinkGraphService(): void {
        this.linkGraphService = null;
        this.reRanker.clearLinkGraphService();
        this.clearCache();
        logger.debug('HybridSearchService: LinkGraphService cleared');
    }

    /**
     * Initialize the hybrid search service
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        logger.debug('HybridSearchService: Starting initialization...');

        // Keyword search should already be initialized by the plugin
        if (!this.keywordSearch.isReady()) {
            logger.warn('HybridSearchService: Keyword search not ready, hybrid search may be limited');
        }

        // Semantic search is optional
        if (!this.semanticSearch) {
            logger.debug('HybridSearchService: No semantic search engine provided, will use keyword-only mode');
        }

        // Link graph computation is owned by the plugin lifecycle so startup does not
        // accidentally recompute it twice.
        if (this.linkGraphService) {
            logger.debug('HybridSearchService: Link graph available');
        }

        // Build query segmenter lexicon from vault
        await this.querySegmenter.buildLexicon(this.app);
        logger.debug(`HybridSearchService: Query segmenter ready with ${this.querySegmenter.getLexiconSize()} phrases`);

        this.isInitialized = true;
        logger.debug('HybridSearchService: Initialization complete');
    }

    /**
     * Check if the service is ready
     */
    isReady(): boolean {
        return this.isInitialized;
    }

    /**
     * Check if semantic search is available
     */
    hasSemanticSearch(): boolean {
        return this.semanticSearch !== null;
    }

    /**
     * Update settings
     */
    updateSettings(settings: Partial<HybridSearchSettings>): void {
        this.settings = { ...this.settings, ...settings };
        this.reRanker.updateSettings(this.settings);
        this.clearCache();
        logger.debug('HybridSearchService: Settings updated');
    }

    /**
     * Set or update the semantic search engine
     */
    setSemanticSearch(semanticSearch: SemanticSearchEngine | null): void {
        this.semanticSearch = semanticSearch;
        this.clearCache();
        logger.debug(`HybridSearchService: Semantic search ${semanticSearch ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set or clear the cross-encoder reranker applied to the final ordering
     */
    setReranker(reranker: RerankService | null): void {
        this.crossEncoder = reranker;
        this.clearCache();
        logger.debug(`HybridSearchService: Cross-encoder reranker ${reranker ? 'enabled' : 'disabled'}`);
    }

    /**
     * Perform hybrid search
     */
    async search(
        query: string,
        options: HybridSearchOptions = {},
    ): Promise<HybridSearchResult[]> {
        const startTime = Date.now();
        const {
            limit = this.settings.maxResults,
            threshold = this.settings.minScoreThreshold,
            semanticOnly = false,
            keywordOnly = false,
            signal,
        } = options;

        // Parse frontmatter filters from query
        const { textQuery, filters } = parseQueryFilters(query.trim());

        // Validate query (allow filter-only queries if we have filters)
        if ((!textQuery || textQuery.length < 2) && filters.length === 0) {
            logger.debug('HybridSearchService: Query too short and no filters');
            return [];
        }

        const hasTextQuery = textQuery.length >= 2;
        const trimmedQuery = hasTextQuery ? textQuery : '';
        logger.debug(`HybridSearchService: Searching for "${trimmedQuery}" with ${filters.length} filters (limit: ${limit})`);

        // Check cache (include filters and threshold in cache key)
        const cacheKey = this.buildCacheKey(trimmedQuery, limit, threshold, semanticOnly, keywordOnly, filters);
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            logger.debug('HybridSearchService: Returning cached results');
            return cached;
        }

        // Check for cancellation
        if (signal?.aborted) {
            return [];
        }

        try {
            // Filter-only query: list files whose frontmatter matches, newest first
            if (!hasTextQuery) {
                const filterResults = await this.searchByFiltersOnly(filters, limit);
                if (signal?.aborted) {
                    return [];
                }
                this.addToCache(cacheKey, filterResults);
                return filterResults;
            }

            // Run searches in parallel
            const [keywordResults, semanticResults] = await Promise.all([
                this.runKeywordSearch(trimmedQuery, limit, semanticOnly, signal),
                this.runSemanticSearch(trimmedQuery, limit, keywordOnly, signal),
            ]);

            // Check for cancellation after searches
            if (signal?.aborted) {
                return [];
            }

            logger.debug(`HybridSearchService: Got ${keywordResults.length} keyword and ${semanticResults.length} semantic results`);

            // Normalize results for fusion
            const normalizedKeyword = normalizeKeywordResults(keywordResults, this.app.vault);
            const normalizedSemantic = normalizeSemanticResults(semanticResults);

            logger.debug(`HybridSearchService: Normalized ${normalizedKeyword.length} keyword and ${normalizedSemantic.length} semantic results`);

            // Fuse results using RRF
            const fusedResults = fuseResults(normalizedKeyword, normalizedSemantic, this.settings);
            logger.debug(`HybridSearchService: Fused into ${fusedResults.length} results`);
            if (fusedResults.length > 0) {
                logger.debug(`HybridSearchService: Top fused result:`, {
                    path: fusedResults[0].file.path,
                    fusionScore: fusedResults[0].fusionScore,
                });
            }

            // Segment query for improved proximity scoring
            const segmentedQuery = this.querySegmenter.segmentQuery(trimmedQuery);
            const searchSession = this.reRanker.createSearchSession();

            // Apply re-ranking to get final results
            const reRankedResults = await this.reRanker.reRank(fusedResults, trimmedQuery, segmentedQuery, searchSession);
            logger.debug(`HybridSearchService: Re-ranked ${reRankedResults.length} results`);
            if (reRankedResults.length > 0) {
                logger.debug(`HybridSearchService: Top re-ranked result:`, {
                    path: reRankedResults[0].file.path,
                    finalScore: reRankedResults[0].finalScore,
                });
            }

            // Filter by threshold, frontmatter filters, and limit
            logger.debug(`HybridSearchService: Filtering with threshold ${threshold} and ${filters.length} frontmatter filters`);
            const filteredResults = this.filterAndLimitResults(reRankedResults, threshold, filters, limit);

            // Cross-encoder second pass over the top-K (first-pass order if unavailable/over budget)
            const crossEncoded = await this.applyCrossEncoder(trimmedQuery, filteredResults, fusedResults, signal);

            // Apply clustering if enabled
            const embeddingService = this.semanticSearch?.getEmbeddingService() ?? null;
            const finalResults = await applyClusteringIfEnabled(
                crossEncoded.results,
                embeddingService,
                this.settings,
                { signal },
            );

            if (signal?.aborted) {
                return [];
            }

            // Cache results (searches are recorded on selection, not per keystroke). Results
            // that should have been reranked are not cached, so the next search retries.
            if (crossEncoded.status !== 'skipped-pending') {
                this.addToCache(cacheKey, finalResults);
            }

            const elapsed = Date.now() - startTime;
            logger.debug(`HybridSearchService: Search completed in ${elapsed}ms, returning ${finalResults.length} results`);

            return finalResults;
        } catch (error) {
            logger.error('HybridSearchService: Search failed', error);
            throw error;
        }
    }

    /**
     * Stream hybrid search results for progressive rendering
     * Emits keyword results first, then fused results when semantic completes
     */
    async searchStream(
        query: string,
        options: HybridSearchOptions & {
            onUpdate: (results: HybridSearchResult[], phase: import('./types').StreamingPhase) => void;
        },
    ): Promise<void> {
        const startTime = Date.now();
        const {
            limit = this.settings.maxResults,
            threshold = this.settings.minScoreThreshold,
            semanticOnly = false,
            keywordOnly = false,
            signal,
            onUpdate,
        } = options;

        // Parse frontmatter filters from query
        const { textQuery, filters } = parseQueryFilters(query.trim());

        // Validate query (allow filter-only queries if we have filters)
        if ((!textQuery || textQuery.length < 2) && filters.length === 0) {
            logger.debug('HybridSearchService: Query too short and no filters');
            onUpdate([], 'complete');
            return;
        }

        const hasTextQuery = textQuery.length >= 2;
        const trimmedQuery = hasTextQuery ? textQuery : '';
        logger.debug(`HybridSearchService: Stream searching for "${trimmedQuery}" with ${filters.length} filters (limit: ${limit})`);

        // Check cache - if cached, emit immediately as complete (include filters and threshold in cache key)
        const cacheKey = this.buildCacheKey(trimmedQuery, limit, threshold, semanticOnly, keywordOnly, filters);
        const cached = this.getFromCache(cacheKey);
        if (cached) {
            logger.debug('HybridSearchService: Returning cached results');
            onUpdate(cached, 'complete');
            return;
        }

        if (signal?.aborted) {
            onUpdate([], 'complete');
            return;
        }

        try {
            // Filter-only query: list files whose frontmatter matches, newest first
            if (!hasTextQuery) {
                const filterResults = await this.searchByFiltersOnly(filters, limit);
                if (signal?.aborted) {
                    return;
                }
                this.addToCache(cacheKey, filterResults);
                onUpdate(filterResults, 'complete');
                return;
            }

            // Track completion state
            let keywordResults: Awaited<ReturnType<typeof this.runKeywordSearch>> = [];
            let semanticResults: Awaited<ReturnType<typeof this.runSemanticSearch>> = [];
            let semanticDone = false;
            let normalizedKeyword: ReturnType<typeof normalizeKeywordResults> = [];

            const segmentedQuery = this.querySegmenter.segmentQuery(trimmedQuery);
            const searchSession = this.reRanker.createSearchSession();

            // Start both searches concurrently
            const keywordPromise = this.runKeywordSearch(trimmedQuery, limit, semanticOnly, signal)
                .then((results) => {
                    keywordResults = results;
                    return results;
                });

            const semanticPromise = this.runSemanticSearch(trimmedQuery, limit, keywordOnly, signal)
                .then((results) => {
                    semanticResults = results;
                    semanticDone = true;
                    return results;
                });

            // Wait for keyword results first (typically faster)
            await keywordPromise;

            if (signal?.aborted) {
                onUpdate([], 'complete');
                return;
            }

            // Emit keyword-only results immediately if semantic isn't done yet
            if (!semanticDone && keywordResults.length > 0 && !semanticOnly) {
                const keywordElapsed = Date.now() - startTime;
                logger.debug(`HybridSearchService: Keyword results ready in ${keywordElapsed}ms, emitting phase: keyword`);

                // Create quick results from keyword only without reading file content.
                // buildResults uses the same final-score formula as reRank so scores stay comparable.
                normalizedKeyword = normalizeKeywordResults(keywordResults, this.app.vault);
                const keywordOnlyFused = fuseResults(normalizedKeyword, [], this.settings);
                const quickResults = await this.reRanker.buildResults(keywordOnlyFused, trimmedQuery, searchSession);
                const filteredQuick = this.filterAndLimitResults(quickResults, threshold, filters, limit);

                if (filteredQuick.length > 0) {
                    onUpdate(filteredQuick, 'keyword');
                }
            }

            // Wait for semantic to complete
            await semanticPromise;

            if (signal?.aborted) {
                return;
            }

            // Now compute full fused + re-ranked results
            logger.debug(`HybridSearchService: Got ${keywordResults.length} keyword and ${semanticResults.length} semantic results`);

            if (normalizedKeyword.length === 0) {
                normalizedKeyword = normalizeKeywordResults(keywordResults, this.app.vault);
            }
            const normalizedSemantic = normalizeSemanticResults(semanticResults);
            const fusedResults = fuseResults(normalizedKeyword, normalizedSemantic, this.settings);
            const reRankedResults = await this.reRanker.reRank(fusedResults, trimmedQuery, segmentedQuery, searchSession);
            const filteredResults = this.filterAndLimitResults(reRankedResults, threshold, filters, limit);

            // Apply clustering if enabled
            const embeddingService = this.semanticSearch?.getEmbeddingService() ?? null;
            let finalResults = await applyClusteringIfEnabled(
                filteredResults,
                embeddingService,
                this.settings,
                { signal },
            );

            if (signal?.aborted) {
                return;
            }

            // Cross-encoder second pass: show the first-pass order now, then the reranked order
            let cacheable = true;
            if (this.crossEncoder && filteredResults.length > 1) {
                if (this.crossEncoder.isReady()) {
                    onUpdate(finalResults, 'fused');
                }
                const crossEncoded = await this.applyCrossEncoder(trimmedQuery, filteredResults, fusedResults, signal);
                if (signal?.aborted) {
                    return;
                }
                cacheable = crossEncoded.status !== 'skipped-pending';
                if (crossEncoded.status === 'applied') {
                    finalResults = await applyClusteringIfEnabled(
                        crossEncoded.results,
                        embeddingService,
                        this.settings,
                        { signal },
                    );
                    if (signal?.aborted) {
                        return;
                    }
                }
            }

            // Cache results (searches are recorded on selection, not per keystroke)
            if (cacheable) {
                this.addToCache(cacheKey, finalResults);
            }

            const elapsed = Date.now() - startTime;
            logger.debug(`HybridSearchService: Stream search completed in ${elapsed}ms, returning ${finalResults.length} results (phase: complete)`);

            onUpdate(finalResults, 'complete');
        } catch (error) {
            logger.error('HybridSearchService: Stream search failed', error);
            onUpdate([], 'complete');
        }
    }

    /**
     * Reorder the top-K results with the cross-encoder (see rerank-blend.ts for the
     * blending rationale). Passages use the best semantic chunk when semantic search
     * matched the note, else the title and excerpt/snippet.
     *
     * Status 'skipped-pending' means a reranker is configured but could not score in
     * time (model loading, budget exceeded, error): results keep their first-pass order
     * and should not be cached.
     */
    private async applyCrossEncoder(
        query: string,
        results: HybridSearchResult[],
        fusedResults: FusedResult[],
        signal?: AbortSignal,
    ): Promise<{ results: HybridSearchResult[]; status: 'applied' | 'not-configured' | 'skipped-pending' | 'aborted' }> {
        const reranker = this.crossEncoder;
        if (!reranker || results.length < 2) {
            return { results, status: 'not-configured' };
        }

        const chunkByPath = new Map<string, string>();
        fusedResults.forEach((fused) => {
            const chunk = fused.semanticResult?.matchedChunkText;
            if (chunk) {
                chunkByPath.set(fused.path, chunk);
            }
        });

        const topK = Math.min(reranker.getTopK(), results.length);
        const window = results.slice(0, topK);
        const outcome = await reranker.rerank(query, window.map((result) => ({
            id: result.path,
            passage: buildRerankPassage(result.file, this.app.metadataCache, chunkByPath.get(result.path) ?? result.excerpt),
        })), { signal });

        if (outcome.status !== 'applied') {
            logger.debug(`HybridSearchService: Cross-encoder skipped (${outcome.status}) after ${outcome.elapsedMs}ms`);
            return { results, status: HybridSearchService.toSkipStatus(outcome.status) };
        }

        const scored = window.map((result) => {
            const logit = outcome.scores.get(result.path);
            return logit === undefined ? result : { ...result, rerankScore: sigmoid(logit) };
        });
        const reordered = fuseRerankOrder(scored, (result) => result.rerankScore, (result) => result.finalScore);
        logger.debug(`HybridSearchService: Cross-encoder reranked top ${topK} in ${outcome.elapsedMs}ms`);
        return { results: [...reordered, ...results.slice(topK)], status: 'applied' };
    }

    private static toSkipStatus(status: RerankStatus): 'skipped-pending' | 'aborted' | 'not-configured' {
        if (status === 'aborted') {
            return 'aborted';
        }
        return status === 'disabled' ? 'not-configured' : 'skipped-pending';
    }

    /**
     * Run keyword search
     */
    private async runKeywordSearch(
        query: string,
        limit: number,
        skip: boolean,
        signal?: AbortSignal,
    ): Promise<ReturnType<EnhancedSearchService['search']> extends Promise<infer T> ? T : never> {
        logger.debug(`HybridSearchService: runKeywordSearch called (skip=${skip}, keywordReady=${this.keywordSearch.isReady()})`);

        if (skip) {
            logger.debug('HybridSearchService: Skipping keyword search (semanticOnly mode)');
            return [];
        }

        if (!this.keywordSearch.isReady()) {
            logger.warn('HybridSearchService: Keyword search not ready');
            return [];
        }

        if (signal?.aborted) {
            logger.debug('HybridSearchService: Keyword search aborted');
            return [];
        }

        try {
            const searchLimit = limit * this.KEYWORD_PHASE_RESULT_MULTIPLIER;
            logger.debug(`HybridSearchService: Running keyword search for "${query}" with limit ${searchLimit}`);
            const results = await this.keywordSearch.search(query, searchLimit);
            logger.debug(`HybridSearchService: Keyword search returned ${results.length} results`);
            return results;
        } catch (error) {
            logger.error('HybridSearchService: Keyword search failed', error);
            return [];
        }
    }

    /**
     * Run semantic search
     */
    private async runSemanticSearch(
        query: string,
        limit: number,
        skip: boolean,
        signal?: AbortSignal,
    ): Promise<Awaited<ReturnType<SemanticSearchEngine['search']>>> {
        logger.debug(`HybridSearchService: runSemanticSearch called (skip=${skip}, hasSemanticEngine=${!!this.semanticSearch})`);

        if (skip) {
            logger.debug('HybridSearchService: Skipping semantic search (keywordOnly mode)');
            return [];
        }

        if (!this.semanticSearch) {
            logger.debug('HybridSearchService: No semantic search engine available');
            return [];
        }

        if (signal?.aborted) {
            logger.debug('HybridSearchService: Semantic search aborted');
            return [];
        }

        try {
            const searchLimit = limit * this.KEYWORD_PHASE_RESULT_MULTIPLIER;
            logger.debug(`HybridSearchService: Running semantic search for "${query}" with limit ${searchLimit}`);
            const results = await this.semanticSearch.search(query, {
                limit: searchLimit,
                useCache: true,
                signal,
                // The cross-encoder runs once on the final hybrid ordering instead
                rerank: false,
            });
            logger.debug(`HybridSearchService: Semantic search returned ${results.length} results`);
            return results;
        } catch (error) {
            logger.error('HybridSearchService: Semantic search failed', error);
            return [];
        }
    }

    /**
     * Return files whose frontmatter matches all filters, most recently modified first.
     */
    private async searchByFiltersOnly(filters: QueryFilter[], limit: number): Promise<HybridSearchResult[]> {
        const matchingFiles: TFile[] = this.app.vault.getMarkdownFiles()
            .filter((file) => evaluateAllFilters(filters, getFrontmatter(file, this.app.metadataCache)));

        matchingFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

        const limited = matchingFiles.slice(0, Math.max(0, limit));
        logger.debug(`HybridSearchService: Filter-only query matched ${matchingFiles.length} files, returning ${limited.length}`);

        return this.reRanker.buildFilterOnlyResults(limited, this.reRanker.createSearchSession());
    }

    private buildCacheKey(
        query: string,
        limit: number,
        threshold: number,
        semanticOnly: boolean,
        keywordOnly: boolean,
        filters: QueryFilter[],
    ): string {
        return [query, limit, threshold, semanticOnly, keywordOnly, serializeFilters(filters)].join('\u0002');
    }

    private filterAndLimitResults(
        results: HybridSearchResult[],
        threshold: number,
        filters: QueryFilter[],
        limit: number,
    ): HybridSearchResult[] {
        return results
            .filter((result) => this.passesThresholdAndFilters(result, threshold, filters))
            .slice(0, limit);
    }

    private passesThresholdAndFilters(
        result: HybridSearchResult,
        threshold: number,
        filters: QueryFilter[],
    ): boolean {
        if (result.finalScore < threshold) {
            logger.debug(`HybridSearchService: Filtered out ${result.file.path} (score ${result.finalScore} < ${threshold})`);
            return false;
        }

        if (filters.length === 0) {
            return true;
        }

        const frontmatter = getFrontmatter(result.file, this.app.metadataCache);
        const passesFilters = evaluateAllFilters(filters, frontmatter);
        if (!passesFilters) {
            logger.debug(`HybridSearchService: Filtered out ${result.file.path} (failed frontmatter filters)`);
        }

        return passesFilters;
    }

    /**
     * Get from cache if not expired
     */
    private getFromCache(key: string): HybridSearchResult[] | null {
        const cached = this.searchCache.get(key);
        if (!cached) return null;

        if (Date.now() - cached.timestamp > this.CACHE_TTL_MS) {
            this.searchCache.delete(key);
            return null;
        }

        return cached.results;
    }

    /**
     * Add to cache
     */
    private addToCache(key: string, results: HybridSearchResult[]): void {
        this.searchCache.set(key, {
            results,
            timestamp: Date.now(),
        });

        // Limit cache size
        if (this.searchCache.size > 50) {
            const firstKey = this.searchCache.keys().next().value;
            if (firstKey) {
                this.searchCache.delete(firstKey);
            }
        }
    }

    /**
     * Clear search cache
     */
    clearCache(): void {
        this.searchCache.clear();
        logger.debug('HybridSearchService: Cache cleared');
    }

    /**
     * Invalidate cached results after a vault change (create/modify/delete/rename).
     * Wired from the plugin's vault event hooks.
     */
    onVaultChange(): void {
        if (this.searchCache.size > 0) {
            this.searchCache.clear();
        }
    }

    /**
     * Record that a user selected a specific result
     * This helps improve future rankings
     */
    recordSelection(query: string, selectedPath: string): void {
        this.usageTracker.recordSearch(query, selectedPath);
        this.usageTracker.recordSearchResultOpen(selectedPath, query);
    }

    /**
     * Record explicit relevance feedback for a result.
     */
    recordResultFeedback(query: string, path: string, vote: 1 | -1): void {
        this.usageTracker.recordResultFeedback(path, query, vote);
        this.clearCache();
    }

    /**
     * Get statistics about the hybrid search system
     */
    getStats(): {
        isReady: boolean;
        hasSemanticSearch: boolean;
        cacheSize: number;
        settings: HybridSearchSettings;
    } {
        return {
            isReady: this.isInitialized,
            hasSemanticSearch: this.semanticSearch !== null,
            cacheSize: this.searchCache.size,
            settings: this.settings,
        };
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.clearCache();
        this.crossEncoder = null;
        this.linkGraphService = null;
        this.isInitialized = false;
        logger.debug('HybridSearchService: Destroyed');
    }
}
