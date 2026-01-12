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

import { App } from 'obsidian';
import { EnhancedSearchService } from '../enhanced-search-service';
import { SemanticSearchEngine } from '../semantic/semantic-search-engine';
import { FileUsageTracker } from '../usage-tracker';
import { LinkGraphService } from '../link-graph-service';
import { normalizeKeywordResults, normalizeSemanticResults, fuseResults } from './fusion';
import { HybridReRanker } from './re-ranker';
import { QuerySegmenter } from './query-segmenter';
import { parseQueryFilters, evaluateAllFilters, getFrontmatter } from './query-filter-parser';
import { applyClusteringIfEnabled } from './result-clusterer';
import {
    HybridSearchResult,
    HybridSearchSettings,
    DEFAULT_HYBRID_SEARCH_SETTINGS,
} from './types';
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

    private querySegmenter: QuerySegmenter;

    private settings: HybridSearchSettings;

    private isInitialized = false;

    private searchCache: Map<string, { results: HybridSearchResult[]; timestamp: number }> = new Map();

    private readonly CACHE_TTL_MS = 30000; // 30 second cache

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

        // Initialize link graph if available
        if (this.linkGraphService) {
            await this.linkGraphService.recompute();
            logger.debug('HybridSearchService: Link graph initialized');
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

        const trimmedQuery = textQuery || '*'; // Use wildcard for filter-only queries
        logger.debug(`HybridSearchService: Searching for "${trimmedQuery}" with ${filters.length} filters (limit: ${limit})`);

        // Check cache (include filters in cache key)
        const filterKey = filters.map(f => `${f.field}${f.operator}${f.value}`).join(',');
        const cacheKey = `${trimmedQuery}:${limit}:${semanticOnly}:${keywordOnly}:${filterKey}`;
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
            // Run searches in parallel (only if we have a text query)
            const hasTextQuery = textQuery && textQuery.length >= 2;
            const [keywordResults, semanticResults] = await Promise.all([
                hasTextQuery ? this.runKeywordSearch(trimmedQuery, limit, semanticOnly, signal) : Promise.resolve([]),
                hasTextQuery ? this.runSemanticSearch(trimmedQuery, limit, keywordOnly, signal) : Promise.resolve([]),
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

            // Apply re-ranking to get final results
            const reRankedResults = await this.reRanker.reRank(fusedResults, trimmedQuery, segmentedQuery);
            logger.debug(`HybridSearchService: Re-ranked ${reRankedResults.length} results`);
            if (reRankedResults.length > 0) {
                logger.debug(`HybridSearchService: Top re-ranked result:`, {
                    path: reRankedResults[0].file.path,
                    finalScore: reRankedResults[0].finalScore,
                });
            }

            // Filter by threshold, frontmatter filters, and limit
            logger.debug(`HybridSearchService: Filtering with threshold ${threshold} and ${filters.length} frontmatter filters`);
            const filteredResults = reRankedResults
                .filter((r) => {
                    const passesScore = r.finalScore >= threshold;
                    if (!passesScore) {
                        logger.debug(`HybridSearchService: Filtered out ${r.file.path} (score ${r.finalScore} < ${threshold})`);
                        return false;
                    }

                    // Apply frontmatter filters
                    if (filters.length > 0) {
                        const frontmatter = getFrontmatter(r.file, this.app.metadataCache);
                        const passesFilters = evaluateAllFilters(filters, frontmatter);
                        if (!passesFilters) {
                            logger.debug(`HybridSearchService: Filtered out ${r.file.path} (failed frontmatter filters)`);
                            return false;
                        }
                    }

                    return true;
                })
                .slice(0, limit);

            // Apply clustering if enabled
            const embeddingService = this.semanticSearch?.getEmbeddingService() ?? null;
            const finalResults = applyClusteringIfEnabled(
                filteredResults,
                embeddingService,
                this.settings,
            );

            // Cache results
            this.addToCache(cacheKey, finalResults);

            // Record search for usage tracking
            this.usageTracker.recordSearch(trimmedQuery);

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

        const trimmedQuery = textQuery || '*';
        logger.debug(`HybridSearchService: Stream searching for "${trimmedQuery}" with ${filters.length} filters (limit: ${limit})`);

        // Check cache - if cached, emit immediately as complete (include filters in cache key)
        const filterKey = filters.map(f => `${f.field}${f.operator}${f.value}`).join(',');
        const cacheKey = `${trimmedQuery}:${limit}:${semanticOnly}:${keywordOnly}:${filterKey}`;
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
            // Track completion state
            let keywordResults: Awaited<ReturnType<typeof this.runKeywordSearch>> = [];
            let semanticResults: Awaited<ReturnType<typeof this.runSemanticSearch>> = [];
            let semanticDone = false;

            // Only run text search if we have a text query
            const hasTextQuery = textQuery && textQuery.length >= 2;

            // Start both searches concurrently (if we have text query)
            const keywordPromise = hasTextQuery
                ? this.runKeywordSearch(trimmedQuery, limit, semanticOnly, signal)
                    .then((results) => {
                        keywordResults = results;
                        return results;
                    })
                : Promise.resolve([]);

            const semanticPromise = hasTextQuery
                ? this.runSemanticSearch(trimmedQuery, limit, keywordOnly, signal)
                    .then((results) => {
                        semanticResults = results;
                        semanticDone = true;
                        return results;
                    })
                : Promise.resolve([]).then(() => { semanticDone = true; return []; });

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

                // Create quick results from keyword only (without full re-ranking)
                const normalizedKeyword = normalizeKeywordResults(keywordResults, this.app.vault);
                const keywordOnlyFused = fuseResults(normalizedKeyword, [], this.settings);
                const segmentedQuery = this.querySegmenter.segmentQuery(trimmedQuery);
                const quickResults = await this.reRanker.reRank(keywordOnlyFused, trimmedQuery, segmentedQuery);

                const filteredQuick = quickResults
                    .filter((r) => {
                        const passesScore = r.finalScore >= threshold;
                        if (!passesScore) return false;

                        if (filters.length > 0) {
                            const frontmatter = getFrontmatter(r.file, this.app.metadataCache);
                            if (!evaluateAllFilters(filters, frontmatter)) return false;
                        }
                        return true;
                    })
                    .slice(0, limit);

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

            const normalizedKeyword = normalizeKeywordResults(keywordResults, this.app.vault);
            const normalizedSemantic = normalizeSemanticResults(semanticResults);
            const fusedResults = fuseResults(normalizedKeyword, normalizedSemantic, this.settings);

            // Segment query for improved proximity scoring
            const segmentedQuery = this.querySegmenter.segmentQuery(trimmedQuery);

            const reRankedResults = await this.reRanker.reRank(fusedResults, trimmedQuery, segmentedQuery);

            const filteredResults = reRankedResults
                .filter((r) => {
                    const passesScore = r.finalScore >= threshold;
                    if (!passesScore) return false;

                    if (filters.length > 0) {
                        const frontmatter = getFrontmatter(r.file, this.app.metadataCache);
                        if (!evaluateAllFilters(filters, frontmatter)) return false;
                    }
                    return true;
                })
                .slice(0, limit);

            // Apply clustering if enabled
            const embeddingService = this.semanticSearch?.getEmbeddingService() ?? null;
            const finalResults = applyClusteringIfEnabled(
                filteredResults,
                embeddingService,
                this.settings,
            );

            // Cache results
            this.addToCache(cacheKey, finalResults);

            // Record search for usage tracking
            this.usageTracker.recordSearch(trimmedQuery);

            const elapsed = Date.now() - startTime;
            logger.debug(`HybridSearchService: Stream search completed in ${elapsed}ms, returning ${finalResults.length} results (phase: complete)`);

            onUpdate(finalResults, 'complete');
        } catch (error) {
            logger.error('HybridSearchService: Stream search failed', error);
            onUpdate([], 'complete');
        }
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
            logger.debug(`HybridSearchService: Running keyword search for "${query}" with limit ${limit * 2}`);
            const results = await this.keywordSearch.search(query, limit * 2);
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
            logger.debug(`HybridSearchService: Running semantic search for "${query}" with limit ${limit * 2}`);
            const results = await this.semanticSearch.search(query, {
                limit: limit * 2,
                useCache: true,
                signal,
            });
            logger.debug(`HybridSearchService: Semantic search returned ${results.length} results`);
            return results;
        } catch (error) {
            logger.error('HybridSearchService: Semantic search failed', error);
            return [];
        }
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
     * Record that a user selected a specific result
     * This helps improve future rankings
     */
    recordSelection(query: string, selectedPath: string): void {
        this.usageTracker.recordSearch(query, selectedPath);
        this.usageTracker.recordFileOpen(selectedPath);
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
        this.isInitialized = false;
        logger.debug('HybridSearchService: Destroyed');
    }
}
