import { App, TFile, debounce } from 'obsidian';
import {
    SearchSettings,
    EnhancedSearchResult,
    FileMetadata,
    SearchIndex,
    IndexStats,
    SearchResult,
} from './interfaces';
import { MiniSearchAdapter, MiniSearchAdapterOptions } from './mini-search-adapter';
import { TermFrequencyIndex } from './term-frequency-index';
import { IndexingCoordinator } from './indexing-coordinator';
import { IndexPersistence } from './persistence';
import { FileUsageTracker } from './usage-tracker';
import { ContentSearchScorer } from './scorer';
import { performanceMonitor } from './performance-monitor';
import { logger } from '../utils/logger';
import { generateContentHashBase36 } from '../utils/hash';

/**
 * Main search service that coordinates all enhanced search components
 */
export class EnhancedSearchService {
    private app: App;

    private settings: SearchSettings;

    private searchIndex: SearchIndex;

    private indexingCoordinator: IndexingCoordinator;

    private persistence: IndexPersistence;

    private usageTracker: FileUsageTracker;

    private scorer: ContentSearchScorer;

    private isInitialized = false;

    private indexingPaused = false;

    private termFrequencyIndex: TermFrequencyIndex;

    /**
     * Check if the search service is ready to handle queries.
     * Use this before calling search() to avoid errors during initialization.
     */
    isReady(): boolean {
        return this.isInitialized;
    }

    private debouncedCacheSave: () => void;

    private cacheSavePending = false;

    private isIndexing = false;

    private lastIndexOptions: MiniSearchAdapterOptions;

    constructor(app: App, settings: SearchSettings) {
        this.app = app;
        this.settings = settings;

        // Initialize term frequency index FIRST (before createSearchIndex uses it)
        this.termFrequencyIndex = new TermFrequencyIndex();

        this.searchIndex = this.createSearchIndex();
        this.persistence = new IndexPersistence();
        this.usageTracker = new FileUsageTracker();
        this.scorer = new ContentSearchScorer(settings);
        this.lastIndexOptions = this.getMiniSearchOptions();

        this.indexingCoordinator = new IndexingCoordinator(
            this.app,
            this.searchIndex,
            this.persistence,
            this.usageTracker,
            this.persistence,
            debounce(this.performFileIndexing.bind(this), settings.indexingDebounceMs),
            settings.indexingDebounceMs,
            { enableContentSearch: settings.enableContentSearch },
        );

        // Create debounced cache save function to avoid excessive saves
        this.debouncedCacheSave = debounce(this.saveIndexToCache.bind(this), 2000);
    }

    private createSearchIndex(): SearchIndex {
        logger.debug('Enhanced search: Using in-memory MiniSearch index');
        const adapter = new MiniSearchAdapter(this.getMiniSearchOptions());

        // Wire up term frequency index for IDF-based scoring
        adapter.setTermFrequencyIndex(this.termFrequencyIndex);

        return adapter;
    }

    private getMiniSearchOptions(): MiniSearchAdapterOptions {
        const {
            typoTolerance,
            foldAccents,
            enableStemming,
            synonyms,
        } = this.settings;

        return {
            typoTolerance,
            foldAccents,
            enableStemming,
            synonyms: synonyms || [],
        };
    }

    private haveIndexOptionsChanged(previous: MiniSearchAdapterOptions, next: MiniSearchAdapterOptions): boolean {
        const baseChanged = previous.typoTolerance !== next.typoTolerance
            || previous.foldAccents !== next.foldAccents
            || previous.enableStemming !== next.enableStemming;

        if (baseChanged) return true;

        const prevSynonyms = (previous.synonyms || []).map((s) => s.trim()).filter((s) => s.length > 0);
        const nextSynonyms = (next.synonyms || []).map((s) => s.trim()).filter((s) => s.length > 0);

        if (prevSynonyms.length !== nextSynonyms.length) {
            return true;
        }

        const prevSorted = [...prevSynonyms].sort().join('\n');
        const nextSorted = [...nextSynonyms].sort().join('\n');

        return prevSorted !== nextSorted;
    }

    private requestCacheSave(): void {
        if (this.cacheSavePending) {
            return;
        }

        this.cacheSavePending = true;
        this.debouncedCacheSave();
    }

    private runWhenIdle(callback: () => Promise<void>, timeout = 1000): Promise<void> {
        return new Promise((resolve, reject) => {
            const executor = () => {
                callback().then(resolve).catch(reject);
            };

            if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
                requestIdleCallback(() => {
                    executor();
                }, { timeout });
            } else {
                setTimeout(() => {
                    executor();
                }, 0);
            }
        });
    }

    private sleep(delay: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, delay);
        });
    }

    /**
     * Initialize the search service
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        logger.debug('Enhanced search: Starting initialization...');

        try {
            // Initialize persistence layer
            await this.persistence.initialize();
            logger.debug('Enhanced search: Persistence initialized');

            // Initialize indexing coordinator
            await this.indexingCoordinator.initialize();
            logger.debug('Enhanced search: IndexingCoordinator initialized');

            // Load existing index and usage data
            await this.loadPersistedData();
            logger.debug('Enhanced search: Data loaded');

            // Log TFI state after loading
            const tfiAfterLoad = this.termFrequencyIndex.getStats();
            logger.debug(`[EnhancedSearchService] After loadPersistedData - TFI: ${tfiAfterLoad.totalDocuments} docs, ${tfiAfterLoad.uniqueTerms} terms`);

            // Set up file getter for indexing coordinator
            this.indexingCoordinator.setFileGetter((path: string) => {
                const file = this.app.vault.getAbstractFileByPath(path);
                return (file instanceof TFile) ? file : null;
            });

            // Set up file system watchers
            this.setupFileWatchers();
            logger.debug('Enhanced search: File watchers set up');

            // Mark as initialized BEFORE vault indexing so search can work
            // with cached/partial results while indexing continues in background
            this.isInitialized = true;
            logger.debug('Enhanced search: Service ready (indexing will continue in background)');

            // Start background indexing for any new/changed files
            // Don't await - let it run in the background
            this.indexVault().then(() => {
                const tfiAfterIndex = this.termFrequencyIndex.getStats();
                logger.debug(`[EnhancedSearchService] After indexVault - TFI: ${tfiAfterIndex.totalDocuments} docs, ${tfiAfterIndex.uniqueTerms} terms`);
                logger.debug('Enhanced search: Background vault indexing complete');
            }).catch((error) => {
                logger.error('Enhanced search: Background vault indexing failed:', error);
            });
        } catch (error) {
            logger.error('Enhanced search: Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Perform enhanced search with combined scoring
     */
    async search(query: string, limit = 50): Promise<EnhancedSearchResult[]> {
        if (!this.isInitialized) {
            throw new Error('Search service not initialized');
        }

        logger.debug(`Enhanced search: Searching for "${query}" with limit ${limit}`);

        const operationId = `search-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            // Get basic search results from the index
            const searchResults = await this.searchIndex.search(query, limit * 2); // Get more results for better ranking
            logger.debug(`Enhanced search: MiniSearch returned ${searchResults.length} results`);

            // Enhance results with usage and recency scoring
            const enhancedResults: EnhancedSearchResult[] = searchResults.map(
                (result) => this.buildEnhancedResult(query, result),
            );

            // Sort by combined score
            enhancedResults.sort((a, b) => b.combinedScore - a.combinedScore);

            // Record search performance
            const duration = performanceMonitor.endTiming(operationId, 'search');
            if (duration > 1000) {
                logger.debug(`Enhanced search: Long search took ${duration}ms`);
            }

            // Record search in usage tracker
            if (this.settings.enableUsageTracking) {
                this.usageTracker.recordSearch(query);
            }

            return enhancedResults.slice(0, limit);
        } catch (error) {
            performanceMonitor.endTiming(operationId, 'search');
            logger.error('Search failed:', error);
            throw error;
        }
    }

    private buildEnhancedResult(query: string, result: SearchResult): EnhancedSearchResult {
        const usageScore = this.settings.enableUsageTracking
            ? this.usageTracker.getUsageScore(result.metadata.path) : 0;
        const recencyScore = this.settings.enableUsageTracking
            ? this.usageTracker.getRecencyScore(result.metadata.path) : 0;
        const lastOpened = this.usageTracker.getLastOpened(result.metadata.path);

        const combinedScore = this.scorer.calculateCombinedScore({
            query,
            contentScore: result.score,
            usageScore,
            recencyScore,
            metadata: result.metadata,
            lastOpened,
        });

        return {
            ...result,
            combinedScore,
            contentScore: result.score,
            usageScore,
            recencyScore,
            lastOpened,
        };
    }

    async searchStream(
        query: string,
        limit = 50,
        options: {
            chunkSize?: number;
            signal?: AbortSignal;
            onChunk?: (
                results: EnhancedSearchResult[],
                status: { done: boolean; received: number; total: number },
            ) => void;
        } = {},
    ): Promise<void> {
        if (!this.isInitialized) {
            throw new Error('Search service not initialized');
        }

        const { chunkSize = 10, signal, onChunk } = options;
        const operationId = `search-stream-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            const searchResults = await this.searchIndex.search(query, limit * 2);
            if (searchResults.length === 0) {
                if (this.settings.enableUsageTracking && !signal?.aborted) {
                    this.usageTracker.recordSearch(query);
                }
                onChunk?.([], { done: true, received: 0, total: 0 });
                performanceMonitor.endTiming(operationId, 'search');
                return;
            }

            const enhancedResults: EnhancedSearchResult[] = [];
            const total = searchResults.length;

            for (let i = 0; i < searchResults.length && enhancedResults.length < limit; i += 1) {
                if (signal?.aborted) {
                    break;
                }

                enhancedResults.push(this.buildEnhancedResult(query, searchResults[i]));

                const shouldEmit = (enhancedResults.length % chunkSize === 0)
                    || i === searchResults.length - 1
                    || enhancedResults.length >= limit;

                if (shouldEmit) {
                    const bestSoFar = [...enhancedResults]
                        .sort((a, b) => b.combinedScore - a.combinedScore)
                        .slice(0, limit);

                    onChunk?.(bestSoFar, {
                        done: i === searchResults.length - 1 || enhancedResults.length >= limit,
                        received: enhancedResults.length,
                        total,
                    });

                    await this.sleep(0);
                }
            }

            if (this.settings.enableUsageTracking && !signal?.aborted) {
                this.usageTracker.recordSearch(query);
            }

            const duration = performanceMonitor.endTiming(operationId, 'search');
            if (duration > 1000) {
                logger.debug(`Enhanced search: Long streaming search took ${duration}ms`);
            }
        } catch (error) {
            performanceMonitor.endTiming(operationId, 'search');
            logger.error('Search stream failed:', error);
            throw error;
        }
    }

    /**
     * Record file access for usage tracking
     */
    recordFileAccess(filePath: string): void {
        if (this.settings.enableUsageTracking) {
            this.usageTracker.recordFileOpen(filePath);
        }
    }

    /**
     * Record search selection for analytics
     */
    recordSearchSelection(query: string, selectedPath: string): void {
        if (!this.isInitialized) {
            logger.warn('Enhanced search: Cannot record search selection - service not initialized');
            return;
        }

        this.usageTracker.recordSearch(query, selectedPath);
    }

    /**
     * Get the last opened time for a file
     */
    getLastOpened(path: string): number | undefined {
        if (!this.isInitialized) {
            return undefined;
        }

        return this.usageTracker.getLastOpened(path);
    }

    /**
     * Update search settings
     */
    updateSettings(newSettings: Partial<SearchSettings>): void {
        const previousOptions = this.lastIndexOptions;

        this.settings = { ...this.settings, ...newSettings };
        this.scorer = new ContentSearchScorer(this.settings);

        const nextOptions = this.getMiniSearchOptions();
        this.lastIndexOptions = nextOptions;

        if (this.searchIndex.updateOptions) {
            this.searchIndex.updateOptions(nextOptions);
        }

        const matchingChanged = this.haveIndexOptionsChanged(previousOptions, nextOptions);

        if (matchingChanged && this.isInitialized) {
            this.rebuildIndex().catch((error) => {
                logger.error('Enhanced search: Failed to rebuild index after setting changes', error);
            });
        }
    }

    /**
     * Get search statistics
     */
    getSearchStats(): {
        indexStats: IndexStats;
        usageStats: any;
        performanceStats: ReturnType<typeof performanceMonitor.getPerformanceReport>;
    } {
        return {
            indexStats: this.searchIndex.getStats(),
            usageStats: {}, // TODO: Implement usage stats
            performanceStats: performanceMonitor.getPerformanceReport(),
        };
    }

    /**
     * Clear all search data
     */
    async clearAllData(): Promise<void> {
        await this.searchIndex.clear();
        await this.persistence.clear();
        await this.usageTracker.reset();
        performanceMonitor.clear();
    }

    /**
     * Rebuild the entire search index
     */
    async rebuildIndex(): Promise<void> {
        logger.debug('Enhanced search: Rebuilding entire index...');
        await this.searchIndex.clear();

        // Clear the cached index as well
        try {
            await this.persistence.saveSearchIndex(null);
            logger.debug('Enhanced search: Cleared cached index');
        } catch (error) {
            logger.warn('Enhanced search: Failed to clear cached index:', error);
        }

        await this.indexVault();
    }

    /**
     * Cleanup and shutdown
     */
    async shutdown(): Promise<void> {
        if (this.indexingCoordinator) {
            await this.indexingCoordinator.shutdown();
        }
        this.isInitialized = false;
    }

    /**
     * Manually trigger vault indexing (useful if initial indexing failed)
     */
    async triggerVaultIndexing(): Promise<void> {
        if (!this.isInitialized) {
            logger.warn('Enhanced search: Service not initialized yet');
            return;
        }
        logger.debug('Enhanced search: Manually triggering vault indexing...');
        await this.indexVault();
    }

    /**
     * Pause indexing to improve performance
     */
    pauseIndexing(): void {
        this.indexingPaused = true;
        logger.debug('Enhanced search: Indexing paused');
    }

    /**
     * Resume indexing
     */
    resumeIndexing(): void {
        this.indexingPaused = false;
        logger.debug('Enhanced search: Indexing resumed');
    }

    /**
     * Check if indexing is currently paused
     */
    isIndexingPaused(): boolean {
        return this.indexingPaused;
    }

    /**
     * Get the current indexing progress
     */
    getIndexingProgress(): {
        isIndexing: boolean;
        currentStats: IndexStats;
        isPaused: boolean;
    } {
        return {
            isIndexing: this.isIndexing,
            currentStats: this.searchIndex.getStats(),
            isPaused: this.indexingPaused,
        };
    }

    /**
     * Force a cache save (useful for testing or manual operations)
     */
    async forceCacheSave(): Promise<void> {
        await this.saveIndexToCache();
    }

    /**
     * Get the term frequency index for IDF-based term weighting
     */
    getTermFrequencyIndex(): TermFrequencyIndex {
        return this.termFrequencyIndex;
    }

    private async loadPersistedData(): Promise<void> {
        try {
            // Load search index
            const indexData = await this.persistence.loadSearchIndex();
            if (indexData && indexData.index) {
                logger.debug('Enhanced search: Loading cached search index...');
                await this.searchIndex.loadFromData(indexData);
                logger.debug(`Enhanced search: Loaded cached index with ${indexData.stats?.documentCount || 0} documents`);

                // Verify cache is still valid by checking file modifications
                const cacheValid = await this.validateCache(indexData);
                if (!cacheValid) {
                    logger.debug('[Enhanced Search] Cache is outdated, clearing index for rebuild');
                    logger.debug('Enhanced search: Cache is outdated, will rebuild index');
                    await this.searchIndex.clear();
                    // Also clear metadata to avoid inconsistent state
                    try {
                        await this.persistence.clear();
                        logger.debug('[Enhanced Search] Cleared persistence metadata');
                        logger.debug('Enhanced search: Cleared cached metadata to match cleared index');
                    } catch (error) {
                        logger.warn('Enhanced search: Failed to clear cached metadata:', error);
                    }
                } else {
                    logger.debug('Enhanced search: Cache is valid, skipping full reindex');
                    // Cache is valid, no need to reindex everything
                }
            } else {
                logger.debug('Enhanced search: No cached index found, will build from scratch');
            }

            // Usage data is loaded automatically by the tracker
        } catch (error) {
            logger.warn('Failed to load persisted search data:', error);
            // If loading fails, we'll just rebuild from scratch
            await this.searchIndex.clear();
        }
    }

    /**
     * Validate if the cached index is still valid by checking file modifications
     * Uses sampling to avoid checking every file for large vaults
     */
    private async validateCache(indexData: any): Promise<boolean> {
        try {
            if (!indexData.stats?.lastUpdated) {
                return false; // No timestamp, cache is invalid
            }

            // Check if TermFrequencyIndex data exists (required for IDF-based scoring)
            if (!indexData.termFrequencyIndex) {
                logger.debug('[Enhanced Search] Cache missing TermFrequencyIndex data, will rebuild');
                return false;
            }

            // Log TermFrequencyIndex stats from cache
            try {
                const tfStats = indexData.termFrequencyIndex;
                logger.debug(`[Enhanced Search] Cache has TermFrequencyIndex: version=${tfStats.version}, docs=${tfStats.totalDocuments}, terms=${tfStats.termDocCount?.length ?? 0}`);
            } catch (e) {
                logger.debug('[Enhanced Search] Failed to log TermFrequencyIndex stats:', e);
            }

            const cacheTimestamp = indexData.stats.lastUpdated;
            const files = this.app.vault.getMarkdownFiles();

            // Check if the number of files has changed significantly first (quick check)
            const currentFileCount = files.length;
            const cachedFileCount = indexData.stats?.documentCount || 0;

            if (Math.abs(currentFileCount - cachedFileCount) > Math.max(1, currentFileCount * 0.1)) {
                logger.debug(`Enhanced search: File count changed significantly (${currentFileCount} vs ${cachedFileCount})`);
                return false;
            }

            // For large vaults, only check a sample of files to avoid long validation times
            const sampleSize = Math.min(files.length, 50); // Check max 50 files
            const filesToCheck = files.length > sampleSize
                ? this.sampleArray(files, sampleSize) : files;

            logger.debug(`Enhanced search: Checking ${filesToCheck.length} files for modifications (sampling from ${files.length} total)`);

            // Check if any sampled files have been modified since the cache was created
            for (const file of filesToCheck) {
                if (file.stat.mtime > cacheTimestamp) {
                    logger.debug(`Enhanced search: File ${file.path} modified since cache (${new Date(file.stat.mtime).toISOString()} > ${new Date(cacheTimestamp).toISOString()})`);
                    return false;
                }
            }

            logger.debug(`Enhanced search: Cache is valid (${cachedFileCount} files, last updated ${new Date(cacheTimestamp).toISOString()})`);
            return true;
        } catch (error) {
            logger.warn('Enhanced search: Failed to validate cache:', error);
            return false;
        }
    }

    /**
     * Sample an array to get a representative subset
     */
    private sampleArray<T>(array: T[], sampleSize: number): T[] {
        if (array.length <= sampleSize) {
            return array;
        }

        const sampled: T[] = [];
        const step = array.length / sampleSize;

        for (let i = 0; i < sampleSize; i++) {
            const index = Math.floor(i * step);
            sampled.push(array[index]);
        }

        return sampled;
    }

    /**
     * Save the current search index to cache
     */
    private async saveIndexToCache(): Promise<void> {
        try {
            const indexData = await this.searchIndex.serialize();
            await this.persistence.saveSearchIndex(indexData);
            logger.debug('Enhanced search: Index saved to cache');
        } catch (error) {
            logger.warn('Enhanced search: Failed to save index to cache:', error);
        } finally {
            this.cacheSavePending = false;
        }
    }

    private setupFileWatchers(): void {
        // Watch for file modifications
        this.app.vault.on('modify', (file: TFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileChange(file.path, 'modify');
            }
        });

        // Watch for file creation
        this.app.vault.on('create', (file: TFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileChange(file.path, 'create');
                if (this.settings.enableUsageTracking) {
                    this.usageTracker.recordFileCreate(file.path);
                }
            }
        });

        // Watch for file deletion
        this.app.vault.on('delete', (file: TFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileChange(file.path, 'delete');
            }
        });

        // Watch for file renames
        this.app.vault.on('rename', (file: TFile, oldPath: string) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileRename(oldPath, file.path);
            }
        });
    }

    private async handleFileChange(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        try {
            // Skip indexing if paused (except for deletes which should always be processed)
            if (this.indexingPaused && operation !== 'delete') {
                logger.debug(`Enhanced search: Skipping ${operation} for ${filePath} (indexing paused)`);
                return;
            }

            // Use requestIdleCallback with a longer timeout to ensure indexing happens
            // during idle periods, preventing UI lag during active file switching
            const scheduleIndexing = () => {
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(async () => {
                        try {
                            await this.indexingCoordinator.scheduleFileUpdate(filePath, operation);
                        } catch (error) {
                            logger.error(`Failed to schedule file update for ${filePath}:`, error);
                        }
                    }, { timeout: 2000 }); // 2 second timeout for important updates
                } else {
                    // Fallback for environments without requestIdleCallback
                    setTimeout(async () => {
                        try {
                            await this.indexingCoordinator.scheduleFileUpdate(filePath, operation);
                        } catch (error) {
                            logger.error(`Failed to schedule file update for ${filePath}:`, error);
                        }
                    }, 50); // Small delay to let UI update first
                }
            };

            // For delete operations, schedule immediately but still async
            if (operation === 'delete') {
                scheduleIndexing();
            } else {
                // For create/modify operations, add additional delay to reduce impact on file switching
                setTimeout(scheduleIndexing, 200);
            }
        } catch (error) {
            logger.error(`Failed to handle file change for ${filePath}:`, error);
        }
    }

    private async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        try {
            // Skip indexing if paused
            if (this.indexingPaused) {
                logger.debug(`Enhanced search: Skipping rename for ${oldPath} to ${newPath} (indexing paused)`);
                return;
            }

            // Use requestIdleCallback with a longer timeout to ensure indexing happens
            // during idle periods, preventing UI lag during active file switching
            const scheduleIndexing = () => {
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(async () => {
                        try {
                            await this.indexingCoordinator.renameFile(oldPath, newPath);
                        } catch (error) {
                            logger.error(`Failed to handle file rename for ${oldPath} to ${newPath}:`, error);
                        }
                    }, { timeout: 2000 }); // 2 second timeout for important updates
                } else {
                    // Fallback for environments without requestIdleCallback
                    setTimeout(async () => {
                        try {
                            await this.indexingCoordinator.renameFile(oldPath, newPath);
                        } catch (error) {
                            logger.error(`Failed to handle file rename for ${oldPath} to ${newPath}:`, error);
                        }
                    }, 50); // Small delay to let UI update first
                }
            };

            // Schedule the rename operation
            scheduleIndexing();
        } catch (error) {
            logger.error(`Failed to handle file rename for ${oldPath} to ${newPath}:`, error);
        }
    }

    private async indexVault(): Promise<void> {
        if (this.isIndexing) {
            logger.debug('Enhanced search: Indexing already in progress, skipping');
            return;
        }

        this.isIndexing = true;
        const operationId = `index-vault-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            // Check if vault is ready
            if (!this.app.vault) {
                logger.warn('Enhanced search: Vault not available yet');
                return;
            }

            const files = this.app.vault.getMarkdownFiles();
            logger.debug(`Enhanced search: Found ${files.length} markdown files to check`);

            if (files.length === 0) {
                logger.warn('Enhanced search: No markdown files found. This might indicate the vault is not fully loaded yet.');
                // Try again after a short delay
                setTimeout(() => {
                    logger.debug('Enhanced search: Retrying vault indexing...');
                    this.indexVault().catch((error) => {
                        logger.error('Enhanced search: Retry failed:', error);
                    });
                }, 2000);
                return;
            }

            // Limit the number of files to index based on settings
            const allFiles = files.slice(0, this.settings.maxIndexedFiles);

            if (allFiles.length < files.length) {
                logger.warn(`Indexing limited to ${this.settings.maxIndexedFiles} files out of ${files.length} total`);
            }

            // Filter out files that are already indexed and up-to-date
            logger.debug(`[Enhanced Search] Checking ${allFiles.length} files for indexing needs...`);
            const filesToIndex = await this.getFilesNeedingIndexing(allFiles);
            logger.debug(`[Enhanced Search] getFilesNeedingIndexing returned ${filesToIndex.length} files to index`);

            if (filesToIndex.length === 0) {
                logger.debug('[Enhanced Search] No files need indexing - this is unexpected after cache clear!');
                logger.debug('Enhanced search: All files are already indexed and up-to-date');
                performanceMonitor.endTiming(operationId, 'indexing');
                return;
            }

            logger.debug(`[Enhanced Search] Starting to index ${filesToIndex.length} files`);
            logger.debug(`Enhanced search: Found ${filesToIndex.length} files that need indexing (${allFiles.length - filesToIndex.length} already cached)`);
            logger.debug(`Enhanced search: Starting to index ${filesToIndex.length} files`);

            const baseBatchSize = Math.max(1, this.settings.indexingBatchSize || 3);
            const dynamicBatchSize = filesToIndex.length > 200
                ? Math.min(baseBatchSize * 2, 20)
                : baseBatchSize;
            const batchSize = dynamicBatchSize;

            const baseFileDelay = Math.max(0, this.settings.indexingDelayMs ?? 50);
            const baseBatchDelay = Math.max(0, this.settings.indexingBatchDelayMs ?? 200);
            const delayBetweenFiles = filesToIndex.length > 200
                ? Math.floor(baseFileDelay / 2)
                : baseFileDelay;
            const delayBetweenBatches = filesToIndex.length > 200
                ? Math.floor(baseBatchDelay / 2)
                : baseBatchDelay;
            let indexedCount = 0;

            for (let i = 0; i < filesToIndex.length; i += batchSize) {
                const batch = filesToIndex.slice(i, i + batchSize);
                logger.debug(`Enhanced search: Indexing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(filesToIndex.length / batchSize)} (files ${indexedCount + 1}-${indexedCount + batch.length})`);

                // Process files sequentially within batch to reduce load
                for (const file of batch) {
                    // Check if indexing has been paused
                    if (this.indexingPaused) {
                        logger.debug('Enhanced search: Indexing paused by user, stopping vault indexing');
                        return;
                    }


                    try {
                        // Call internal method directly to avoid double runWhenIdle wrapper
                        // The loop already manages timing via sleep calls
                        // eslint-disable-next-line no-await-in-loop
                        await this.performFileIndexingInternal(file.path, 'create');

                        indexedCount++;

                        if (delayBetweenFiles > 0) {
                            // eslint-disable-next-line no-await-in-loop
                            await this.sleep(delayBetweenFiles);
                        }
                    } catch (error) {
                        logger.error(`Enhanced search: Failed to index ${file.path}:`, error);
                    }
                }

                if (delayBetweenBatches > 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await this.sleep(delayBetweenBatches);
                }

                // Log progress every 5 files (more frequent updates)
                if (indexedCount % 5 === 0 || indexedCount === filesToIndex.length) {
                    logger.debug(`Enhanced search: Progress ${indexedCount}/${filesToIndex.length} files indexed`);
                }
            }

            logger.debug('Enhanced search: Vault indexing completed');

            // Save the index to cache after successful indexing
            await this.saveIndexToCache();

            performanceMonitor.endTiming(operationId, 'indexing');
        } catch (error) {
            performanceMonitor.endTiming(operationId, 'indexing');
            logger.error('Failed to index vault:', error);
            throw error;
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * actually perform the file indexing (called by debounced callback)
     * Uses requestIdleCallback to avoid blocking the UI
     */
    private async performFileIndexing(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        await this.runWhenIdle(async () => {
            await this.performFileIndexingInternal(filePath, operation);
        }, 1000);
    }

    /**
     * Internal method to perform file indexing without scheduling wrapper
     */
    private async performFileIndexingInternal(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        const startTime = Date.now();
        try {
            if (operation === 'delete') {
                await this.searchIndex.removeDocument(filePath);

                try {
                    await this.persistence.delete(filePath);
                } catch (error) {
                    logger.warn(`Failed to clean up metadata for deleted file ${filePath}:`, error);
                }

                logger.debug(`Enhanced search: Removed ${filePath} from index (${Date.now() - startTime}ms)`);
                this.requestCacheSave();
                return;
            }

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!file || !(file instanceof TFile) || file.extension !== 'md') {
                return;
            }

            const maxFileSize = this.settings.maxFileSize || (512 * 1024);
            if (file.stat.size > maxFileSize) {
                logger.warn(`Enhanced search: Skipping large file ${filePath} (${Math.round(file.stat.size / 1024)}KB)`);
                return;
            }

            // For indexVault loop, better to read content sequentially than Promise.all which might race
            const metadata = this.extractFileMetadata(file);
            const content = await this.app.vault.read(file);

            if (!content || content.trim().length === 0) {
                return;
            }

            await this.indexDocumentAsync(filePath, content, metadata);

            const duration = Date.now() - startTime;
            if (duration > 100) {
                logger.debug(`Enhanced search: Indexed ${filePath} (${duration}ms, ${Math.round(content.length / 1024)}KB)`);
            }
            this.requestCacheSave();
        } catch (error) {
            logger.error(`Enhanced search: Failed to index ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Index a document asynchronously with yield points
     * Also saves cache periodically for incremental updates and stores indexing metadata
     */
    private async indexDocumentAsync(filePath: string, content: string, metadata: any): Promise<void> {
        // Index the document with correct signature: (id, content, metadata)
        await this.searchIndex.addDocument(filePath, content, metadata);

        // Store metadata about when this file was indexed
        await this.persistence.setMetadata(filePath, {
            lastModified: metadata.lastModified,
            indexedAt: Date.now(),
            contentHash: generateContentHashBase36(content),
            size: content.length,
        });

        // Store content if enabled (but don't block on it)
        if (this.settings.enableContentSearch) {
            this.persistence.set(filePath, content).catch((error) => {
                logger.warn(`Failed to store content for ${filePath}:`, error);
            });
        }

        // Periodically save cache for incremental updates (every 50 files) to reduce write churn
        const stats = this.searchIndex.getStats();
        if (stats.documentCount % 50 === 0) {
            // Schedule cache save in background, don't block indexing
            this.requestCacheSave();
        }
    }

    /**
     * Check if cache is available and contains data
     */
    private async isCacheAvailable(): Promise<boolean> {
        try {
            const indexData = await this.persistence.loadSearchIndex();
            return !!(indexData && indexData.index);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get files that need indexing (new or modified since last index)
     */
    private async getFilesNeedingIndexing(allFiles: TFile[]): Promise<TFile[]> {
        const filesToIndex: TFile[] = [];
        logger.debug(`Enhanced search: Checking ${allFiles.length} files for indexing needs`);

        if (allFiles.length === 0) {
            return filesToIndex;
        }

        let cursor = 0;
        const concurrency = Math.min(8, Math.max(1, Math.ceil(allFiles.length / 100)));

        const workers = Array.from({ length: concurrency }, async () => {
            while (cursor < allFiles.length) {
                const index = cursor;
                cursor += 1;

                const file = allFiles[index];
                if (!file) {
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop
                if (await this.doesFileNeedIndexing(file)) {
                    filesToIndex.push(file);
                }
            }
        });

        await Promise.all(workers);

        logger.debug(`Enhanced search: ${filesToIndex.length} files need indexing out of ${allFiles.length} total`);
        return filesToIndex;
    }

    private async doesFileNeedIndexing(file: TFile): Promise<boolean> {
        try {
            const metadata = await this.persistence.getMetadata(file.path);
            logger.debug(`Enhanced search: Metadata check for ${file.path}:`, metadata ? 'found' : 'not found');

            if (!metadata) {
                logger.debug(`Enhanced search: File ${file.path} has no metadata, needs indexing`);
                return true;
            }

            if (file.stat.mtime > metadata.indexedAt) {
                logger.debug(`Enhanced search: File ${file.path} needs reindexing (modified ${new Date(file.stat.mtime).toISOString()} > indexed ${new Date(metadata.indexedAt).toISOString()})`);
                return true;
            }

            if (!this.searchIndex.hasDocument(file.path)) {
                logger.debug(`Enhanced search: File ${file.path} not found in search index, needs indexing`);
                return true;
            }

            logger.debug(`Enhanced search: File ${file.path} is up to date (indexed ${new Date(metadata.indexedAt).toISOString()})`);
            return false;
        } catch (error) {
            logger.warn(`Enhanced search: Error checking metadata for ${file.path}, will reindex:`, error);
            return true;
        }
    }

    private extractFileMetadata(file: TFile): FileMetadata {
        const metadata = this.app.metadataCache.getFileCache(file);

        return {
            path: file.path,
            title: metadata?.frontmatter?.title || file.basename,
            headings: metadata?.headings?.map((h) => ({ heading: h.heading, level: h.level })) || [],
            frontmatter: metadata?.frontmatter || {},
            tags: metadata?.tags?.map((t) => t.tag) || [],
            aliases: this.normalizeAliases(metadata?.frontmatter?.aliases),
            links: metadata?.links?.map((l) => l.link) || [],
            size: file.stat.size,
            lastModified: file.stat.mtime,
        };
    }

    /**
     * Normalize aliases to always return an array
     * In Obsidian frontmatter, aliases can be either a string or an array
     */
    private normalizeAliases(aliases: any): string[] {
        if (!aliases) {
            return [];
        }
        if (Array.isArray(aliases)) {
            return aliases.filter((alias) => typeof alias === 'string');
        }
        if (typeof aliases === 'string') {
            return [aliases];
        }
        return [];
    }
}

