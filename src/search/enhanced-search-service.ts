import {
    App, TFile, TAbstractFile, debounce, Debouncer, EventRef,
} from 'obsidian';
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
import { IndexPersistence, LoadedSearchIndex } from './persistence';
import { FileUsageTracker } from './usage-tracker';
import type { LinkGraphService } from './link-graph-service';
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

    private debouncedCacheSave: Debouncer<[], Promise<void>>;

    private cacheSavePending = false;

    private bulkIndexingActive = false;

    /** Promise of the in-flight vault indexing run, if any. */
    private activeIndexingRun: Promise<void> | null = null;

    /** Aborts the in-flight vault indexing run (rebuild, shutdown). */
    private indexingAbort: AbortController | null = null;

    /** Set when indexing work was skipped/interrupted while paused; reconciled on resume. */
    private reconcileOnResume = false;

    /** Renames observed while indexing was paused, replayed on resume. */
    private pendingRenames: Array<{ oldPath: string; newPath: string }> = [];

    /**
     * Time the loaded cache snapshot was taken. Files indexed after this point
     * may be missing/stale in the snapshot. Cleared once the first full
     * reconciliation pass has inspected every file.
     */
    private cacheSnapshotTime: number | null = null;

    /** Paths whose cached index entry may be stale and must be reindexed. */
    private staleCachedPaths = new Set<string>();

    private linkGraphService: LinkGraphService | null = null;

    private lastIndexOptions: MiniSearchAdapterOptions;

    private fileWatcherRefs: EventRef[] = [];

    private scheduledTimeouts = new Set<ReturnType<typeof setTimeout>>();

    private scheduledIdleCallbacks = new Set<number>();

    private isShuttingDown = false;

    constructor(
        app: App,
        settings: SearchSettings,
        usageTracker?: FileUsageTracker,
        linkGraphService?: LinkGraphService,
    ) {
        this.app = app;
        this.settings = settings;
        this.linkGraphService = linkGraphService ?? null;

        // Initialize term frequency index FIRST (before createSearchIndex uses it)
        this.termFrequencyIndex = new TermFrequencyIndex();

        this.searchIndex = this.createSearchIndex();
        this.persistence = new IndexPersistence(app);
        this.usageTracker = usageTracker ?? new FileUsageTracker(app);
        this.scorer = new ContentSearchScorer(settings);
        this.lastIndexOptions = this.getMiniSearchOptions();

        this.indexingCoordinator = new IndexingCoordinator(
            this.app,
            this.searchIndex,
            this.persistence,
            this.usageTracker,
            this.persistence,
            this.performFileIndexing.bind(this),
            settings.indexingDebounceMs,
            { enableContentSearch: false },
        );

        // Create debounced cache save function to avoid excessive saves
        this.debouncedCacheSave = debounce(() => this.saveIndexToCache(), 2000);
    }

    /**
     * Provide the link graph so PageRank feeds the `linkImportance` weight.
     */
    setLinkGraphService(service: LinkGraphService): void {
        this.linkGraphService = service;
    }

    clearLinkGraphService(): void {
        this.linkGraphService = null;
    }

    /**
     * Fingerprint of options that change how documents are tokenized at index
     * time. A persisted index built with different options is discarded.
     */
    private getIndexCompatibilityKey(): string {
        const { foldAccents, enableStemming, synonyms } = this.lastIndexOptions;
        const normalizedSynonyms = (synonyms || [])
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .sort();

        return JSON.stringify({
            foldAccents,
            enableStemming,
            synonyms: normalizedSynonyms,
        });
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
        // typoTolerance is query-time only and applied through updateOptions
        const baseChanged = previous.foldAccents !== next.foldAccents
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
        if (this.bulkIndexingActive) {
            this.cacheSavePending = true;
            return;
        }

        if (this.cacheSavePending) {
            return;
        }

        this.cacheSavePending = true;
        this.debouncedCacheSave();
    }

    private runWhenIdle(callback: () => Promise<void>, timeout = 1000): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.isShuttingDown) {
                resolve();
                return;
            }

            const executor = () => {
                if (this.isShuttingDown) {
                    resolve();
                    return;
                }
                callback().then(resolve).catch(reject);
            };

            if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
                const idleId = requestIdleCallback(() => {
                    this.scheduledIdleCallbacks.delete(idleId);
                    executor();
                }, { timeout });
                this.scheduledIdleCallbacks.add(idleId);
            } else {
                const timeoutId = globalThis.setTimeout(() => {
                    this.scheduledTimeouts.delete(timeoutId);
                    executor();
                }, 0);
                this.scheduledTimeouts.add(timeoutId);
            }
        });
    }

    private sleep(delay: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, delay);
        });
    }

    private scheduleTimeout(callback: () => void, delayMs: number): void {
        if (this.isShuttingDown) {
            return;
        }

        const timeoutId = globalThis.setTimeout(() => {
            this.scheduledTimeouts.delete(timeoutId);
            if (!this.isShuttingDown) {
                callback();
            }
        }, delayMs);

        this.scheduledTimeouts.add(timeoutId);
    }

    private scheduleIdle(callback: () => Promise<void>, timeout = 1000): void {
        if (this.isShuttingDown) {
            return;
        }

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
            const idleId = window.requestIdleCallback(() => {
                this.scheduledIdleCallbacks.delete(idleId);
                if (!this.isShuttingDown) {
                    callback().catch((error) => {
                        logger.error('Enhanced search: Idle task failed:', error);
                    });
                }
            }, { timeout });
            this.scheduledIdleCallbacks.add(idleId);
            return;
        }

        this.scheduleTimeout(() => {
            callback().catch((error) => {
                logger.error('Enhanced search: Deferred task failed:', error);
            });
        }, 0);
    }

    private clearScheduledWork(): void {
        this.scheduledTimeouts.forEach((timeoutId) => globalThis.clearTimeout(timeoutId));
        this.scheduledTimeouts.clear();

        if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
            this.scheduledIdleCallbacks.forEach((idleId) => window.cancelIdleCallback(idleId));
        }
        this.scheduledIdleCallbacks.clear();
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
        const pageRankScore = this.linkGraphService?.getPageRankScore(result.metadata.path) ?? 0;

        const combinedScore = this.scorer.calculateCombinedScore({
            query,
            contentScore: result.score,
            usageScore,
            recencyScore,
            metadata: result.metadata,
            lastOpened,
            pageRankScore,
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

        if (!this.settings.enableUsageTracking) {
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

        // Don't let a pending save persist the pre-rebuild index under new options
        this.debouncedCacheSave.cancel();
        this.cacheSavePending = false;

        // Stop any in-flight run first; otherwise indexVault() would join a run
        // that started before the clear and leave the rebuilt index incomplete.
        while (this.activeIndexingRun) {
            // eslint-disable-next-line no-await-in-loop
            await this.cancelActiveIndexing();
        }

        if (this.isShuttingDown) {
            return;
        }

        this.cacheSnapshotTime = null;
        this.staleCachedPaths.clear();
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
        this.isShuttingDown = true;
        this.fileWatcherRefs.forEach((ref) => this.app.vault.offref(ref));
        this.fileWatcherRefs = [];
        this.clearScheduledWork();
        this.debouncedCacheSave.cancel();
        this.pendingRenames = [];

        if (this.indexingCoordinator) {
            await this.indexingCoordinator.shutdown();
        }

        // Wait for the bulk run to observe the abort before closing persistence.
        await this.cancelActiveIndexing();

        if (this.cacheSavePending) {
            await this.saveIndexToCache();
        }

        this.persistence.close();
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
        if (this.activeIndexingRun) {
            // The bulk run stops at the next file boundary.
            this.reconcileOnResume = true;
        }
        logger.debug('Enhanced search: Indexing paused');
    }

    /**
     * Resume indexing, replaying renames and reconciling changes skipped while paused
     */
    resumeIndexing(): void {
        this.indexingPaused = false;
        logger.debug('Enhanced search: Indexing resumed');

        if (!this.isInitialized || this.isShuttingDown) {
            return;
        }

        const renames = this.pendingRenames;
        this.pendingRenames = [];
        renames.forEach(({ oldPath, newPath }) => {
            this.handleFileRename(oldPath, newPath).catch((error) => {
                logger.error(`Enhanced search: Failed to replay rename ${oldPath} -> ${newPath}:`, error);
            });
        });

        if (this.reconcileOnResume) {
            this.reconcileOnResume = false;
            const reconcile = () => {
                this.indexVault().catch((error) => {
                    logger.error('Enhanced search: Reconciliation after resume failed:', error);
                });
            };

            // A run that has not yet observed the pause simply continues; a fresh
            // pass afterwards picks up edits skipped while paused.
            if (this.activeIndexingRun) {
                this.activeIndexingRun.then(reconcile, reconcile);
            } else {
                reconcile();
            }
        }
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
            isIndexing: this.activeIndexingRun !== null,
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

    /**
     * Load the persisted index. A schema-compatible, readable cache is always
     * kept; staleness is reconciled incrementally by indexVault(). The cache is
     * only discarded when its schema/options are incompatible or it is corrupt.
     */
    private async loadPersistedData(): Promise<void> {
        let loaded: LoadedSearchIndex;
        try {
            loaded = await this.persistence.loadSearchIndex(this.getIndexCompatibilityKey());
        } catch (error) {
            logger.warn('Enhanced search: Failed to read cached search index:', error);
            await this.discardPersistedIndex('cache unreadable');
            return;
        }

        if (loaded.status === 'missing') {
            logger.debug('Enhanced search: No cached index found, will build from scratch');
            return;
        }

        if (loaded.status === 'incompatible') {
            await this.discardPersistedIndex(loaded.reason);
            return;
        }

        try {
            const indexData = loaded.data;
            if (!indexData.index || !Array.isArray(indexData.documents)) {
                throw new Error('Cached index has an unexpected shape');
            }

            await this.searchIndex.loadFromData(indexData);

            const snapshotAt = Number(indexData.snapshotAt) || loaded.savedAt;
            this.cacheSnapshotTime = snapshotAt;
            logger.debug(`Enhanced search: Loaded cached index with ${indexData.documents.length} documents (snapshot ${new Date(snapshotAt).toISOString()}); changes will be reconciled incrementally`);
        } catch (error) {
            logger.warn('Enhanced search: Cached index is corrupt, rebuilding:', error);
            await this.discardPersistedIndex('corrupt cache');
        }
    }

    /**
     * Drop the in-memory index and all persisted index data so the next
     * indexVault() run rebuilds from scratch.
     */
    private async discardPersistedIndex(reason: string): Promise<void> {
        logger.debug(`Enhanced search: Discarding cached index (${reason})`);
        this.cacheSnapshotTime = null;
        this.staleCachedPaths.clear();
        await this.searchIndex.clear();

        try {
            // Clears per-file metadata and the serialized index record.
            await this.persistence.clear();
        } catch (error) {
            logger.warn('Enhanced search: Failed to clear cached metadata:', error);
        }
    }

    private getIndexableMarkdownFiles(files = this.app.vault.getMarkdownFiles()): TFile[] {
        const maxIndexedFiles = Math.max(0, this.settings.maxIndexedFiles || files.length);
        const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));

        if (maxIndexedFiles <= 0) {
            return sortedFiles;
        }

        return sortedFiles.slice(0, maxIndexedFiles);
    }

    /**
     * Save the current search index to cache
     */
    private async saveIndexToCache(): Promise<void> {
        try {
            // Taken before serializing: everything indexed before this instant
            // is part of the snapshot (see doesFileNeedIndexing).
            const snapshotAt = Date.now();
            const indexData = await this.searchIndex.serialize();
            if (indexData && typeof indexData === 'object') {
                indexData.snapshotAt = snapshotAt;
            }
            await this.persistence.saveSearchIndex(indexData, this.getIndexCompatibilityKey());
            logger.debug('Enhanced search: Index saved to cache');
        } catch (error) {
            logger.warn('Enhanced search: Failed to save index to cache:', error);
        } finally {
            this.cacheSavePending = false;
        }
    }

    private setupFileWatchers(): void {
        if (this.fileWatcherRefs.length > 0) {
            return;
        }

        // Watch for file modifications
        this.fileWatcherRefs.push(this.app.vault.on('modify', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileChange(file.path, 'modify');
            }
        }));

        // Watch for file creation
        this.fileWatcherRefs.push(this.app.vault.on('create', (file: TAbstractFile) => {
            if (file instanceof TFile && file.extension === 'md') {
                this.handleFileChange(file.path, 'create');
                if (this.settings.enableUsageTracking) {
                    this.usageTracker.recordFileCreate(file.path);
                }
            }
        }));

        // Watch for file deletion
        this.fileWatcherRefs.push(this.app.vault.on('delete', (file: TAbstractFile) => {
            if (!(file instanceof TFile)) {
                return;
            }

            // Usage data is kept for any file type (non-markdown files can be opened too)
            this.usageTracker.deleteFile(file.path);

            if (file.extension === 'md') {
                this.handleFileChange(file.path, 'delete');
            }
        }));

        // Watch for file renames
        this.fileWatcherRefs.push(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            if (!(file instanceof TFile)) {
                return;
            }

            this.usageTracker.renameFile(oldPath, file.path);

            // Also handle extension changes away from .md so the old entry is removed
            if (file.extension === 'md' || oldPath.endsWith('.md')) {
                this.handleFileRename(oldPath, file.path);
            }
        }));
    }

    private async handleFileChange(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        try {
            // Skip indexing if paused (except for deletes which should always be processed)
            if (this.indexingPaused && operation !== 'delete') {
                logger.debug(`Enhanced search: Deferring ${operation} for ${filePath} (indexing paused)`);
                this.reconcileOnResume = true;
                return;
            }

            // Use requestIdleCallback with a longer timeout to ensure indexing happens
            // during idle periods, preventing UI lag during active file switching
            const scheduleIndexing = () => {
                this.scheduleIdle(async () => {
                    await this.indexingCoordinator.scheduleFileUpdate(filePath, operation);
                }, 2000);
            };

            // For delete operations, schedule immediately but still async
            if (operation === 'delete') {
                scheduleIndexing();
            } else {
                // For create/modify operations, add additional delay to reduce impact on file switching
                this.scheduleTimeout(scheduleIndexing, 200);
            }
        } catch (error) {
            logger.error(`Failed to handle file change for ${filePath}:`, error);
        }
    }

    private async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        try {
            // Queue while paused so the old path does not linger in the index
            if (this.indexingPaused) {
                logger.debug(`Enhanced search: Queueing rename ${oldPath} -> ${newPath} (indexing paused)`);
                this.pendingRenames.push({ oldPath, newPath });
                return;
            }

            // Use requestIdleCallback with a longer timeout to ensure indexing happens
            // during idle periods, preventing UI lag during active file switching
            const scheduleIndexing = () => {
                this.scheduleIdle(async () => {
                    await this.indexingCoordinator.renameFile(oldPath, newPath);
                }, 2000);
            };

            // Schedule the rename operation
            scheduleIndexing();
        } catch (error) {
            logger.error(`Failed to handle file rename for ${oldPath} to ${newPath}:`, error);
        }
    }

    /**
     * Start a vault indexing run, or join the one already in progress.
     * Use cancelActiveIndexing() first when a fresh run is required.
     */
    private indexVault(): Promise<void> {
        if (this.activeIndexingRun) {
            logger.debug('Enhanced search: Indexing already in progress, joining current run');
            return this.activeIndexingRun;
        }

        if (this.isShuttingDown) {
            return Promise.resolve();
        }

        const controller = new AbortController();
        this.indexingAbort = controller;

        const run = this.runVaultIndexing(controller.signal).finally(() => {
            if (this.activeIndexingRun === run) {
                this.activeIndexingRun = null;
                this.indexingAbort = null;
            }
        });
        this.activeIndexingRun = run;
        return run;
    }

    /**
     * Abort the in-flight indexing run (if any) and wait for it to stop.
     */
    private async cancelActiveIndexing(): Promise<void> {
        const run = this.activeIndexingRun;
        if (!run) {
            return;
        }

        this.indexingAbort?.abort();
        try {
            await run;
        } catch {
            // Failure is already logged by the run itself
        }
    }

    private shouldStopIndexing(signal: AbortSignal): boolean {
        return signal.aborted || this.isShuttingDown || this.indexingPaused;
    }

    private async runVaultIndexing(signal: AbortSignal): Promise<void> {
        const operationId = `index-vault-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            // Check if vault is ready
            if (!this.app.vault) {
                logger.warn('Enhanced search: Vault not available yet');
                return;
            }

            const files = this.app.vault.getMarkdownFiles();
            const allFiles = this.getIndexableMarkdownFiles(files);
            logger.debug(`Enhanced search: Found ${files.length} markdown files to check`);

            if (files.length === 0) {
                logger.warn('Enhanced search: No markdown files found. This might indicate the vault is not fully loaded yet.');
                // Try again after a short delay
                this.scheduleTimeout(() => {
                    logger.debug('Enhanced search: Retrying vault indexing...');
                    this.indexVault().catch((error) => {
                        logger.error('Enhanced search: Retry failed:', error);
                    });
                }, 2000);
                return;
            }

            if (allFiles.length < files.length) {
                logger.warn(`Indexing limited to ${this.settings.maxIndexedFiles} files out of ${files.length} total`);
            }

            await this.removeStaleIndexedDocuments(allFiles, signal);
            if (this.shouldStopIndexing(signal)) {
                this.noteInterruptedRun();
                return;
            }

            // Filter out files that are already indexed and up-to-date
            const filesToIndex = await this.getFilesNeedingIndexing(allFiles, signal);
            if (this.shouldStopIndexing(signal)) {
                this.noteInterruptedRun();
                return;
            }

            // Every file has now been compared against the loaded snapshot; the
            // ones it could not vouch for are tracked in staleCachedPaths.
            this.cacheSnapshotTime = null;

            if (filesToIndex.length === 0) {
                logger.debug('Enhanced search: All files are already indexed and up-to-date');
                if (this.cacheSavePending) {
                    await this.saveIndexToCache();
                }
                return;
            }

            logger.debug(`Enhanced search: Found ${filesToIndex.length} files that need indexing (${allFiles.length - filesToIndex.length} already cached)`);
            this.bulkIndexingActive = true;

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
                    // Stop on pause, rebuild (abort) or shutdown
                    if (this.shouldStopIndexing(signal)) {
                        logger.debug('Enhanced search: Vault indexing interrupted (paused, cancelled or shutting down)');
                        this.noteInterruptedRun();
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

            if (this.shouldStopIndexing(signal)) {
                this.noteInterruptedRun();
                return;
            }

            logger.debug('Enhanced search: Vault indexing completed');

            // Save the index to cache after successful indexing
            await this.saveIndexToCache();
        } catch (error) {
            logger.error('Failed to index vault:', error);
            throw error;
        } finally {
            performanceMonitor.endTiming(operationId, 'indexing');
            this.bulkIndexingActive = false;
            // Saves requested during the bulk run were deferred; flush them now
            // unless the run already saved or we are shutting down.
            if (this.cacheSavePending && !this.isShuttingDown) {
                this.debouncedCacheSave();
            }
        }
    }

    /**
     * Record that a run stopped early so resuming reconciles the remainder.
     */
    private noteInterruptedRun(): void {
        if (this.indexingPaused) {
            this.reconcileOnResume = true;
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
                await this.removeFromIndex(filePath);
                logger.debug(`Enhanced search: Removed ${filePath} from index (${Date.now() - startTime}ms)`);
                return;
            }

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!file || !(file instanceof TFile) || file.extension !== 'md') {
                return;
            }

            const maxFileSize = this.settings.maxFileSize || (512 * 1024);
            if (file.stat.size > maxFileSize) {
                logger.warn(`Enhanced search: Skipping large file ${filePath} (${Math.round(file.stat.size / 1024)}KB)`);
                // Drop any previously indexed (now stale) content
                await this.removeFromIndexIfPresent(filePath);
                return;
            }

            // For indexVault loop, better to read content sequentially than Promise.all which might race
            const metadata = this.extractFileMetadata(file);
            const content = await this.app.vault.read(file);
            const contentHash = generateContentHashBase36(content);

            if (!content || content.trim().length === 0) {
                // A note edited down to nothing should no longer match old content
                await this.removeFromIndexIfPresent(filePath);
                return;
            }

            const existingMetadata = await this.persistence.getMetadata(filePath);
            if (operation === 'modify'
                && existingMetadata
                && existingMetadata.contentHash === contentHash
                && this.searchIndex.hasDocument(filePath)
                && !this.staleCachedPaths.has(filePath)) {
                await this.persistence.setMetadata(filePath, {
                    ...existingMetadata,
                    lastModified: file.stat.mtime,
                    indexedAt: Date.now(),
                });
                return;
            }

            await this.indexDocumentAsync(filePath, content, metadata, contentHash);
            this.staleCachedPaths.delete(filePath);

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
     * Remove a document and its indexing metadata.
     */
    private async removeFromIndex(filePath: string): Promise<void> {
        await this.searchIndex.removeDocument(filePath);
        this.staleCachedPaths.delete(filePath);

        try {
            await this.persistence.delete(filePath);
        } catch (error) {
            logger.warn(`Failed to clean up metadata for ${filePath}:`, error);
        }

        this.requestCacheSave();
    }

    private async removeFromIndexIfPresent(filePath: string): Promise<void> {
        if (this.searchIndex.hasDocument(filePath)) {
            await this.removeFromIndex(filePath);
            return;
        }

        this.staleCachedPaths.delete(filePath);
    }

    /**
     * Index a document asynchronously with yield points
     * Also saves cache periodically for incremental updates and stores indexing metadata
     */
    private async indexDocumentAsync(
        filePath: string,
        content: string,
        metadata: any,
        contentHash = generateContentHashBase36(content),
    ): Promise<void> {
        // Index the document with correct signature: (id, content, metadata)
        await this.searchIndex.addDocument(filePath, content, metadata);

        // Store metadata about when this file was indexed
        await this.persistence.setMetadata(filePath, {
            lastModified: metadata.lastModified,
            indexedAt: Date.now(),
            contentHash,
            size: content.length,
        });

        // MiniSearch keeps the searchable text it needs; avoid persisting full file content.
    }

    /**
     * Check if cache is available and contains data
     */
    private async isCacheAvailable(): Promise<boolean> {
        try {
            const loaded = await this.persistence.loadSearchIndex(this.getIndexCompatibilityKey());
            return loaded.status === 'ok' && !!loaded.data?.index;
        } catch (error) {
            return false;
        }
    }

    private async removeStaleIndexedDocuments(currentMarkdownFiles: TFile[], signal?: AbortSignal): Promise<void> {
        if (!this.searchIndex.getDocumentIds) {
            return;
        }

        const currentPaths = new Set(currentMarkdownFiles.map((file) => file.path));
        const indexedPaths = this.searchIndex.getDocumentIds();
        const stalePaths = indexedPaths.filter((path) => !currentPaths.has(path));

        if (stalePaths.length === 0) {
            return;
        }

        logger.debug(`Enhanced search: Removing ${stalePaths.length} stale indexed documents`);
        for (const path of stalePaths) {
            if (signal && this.shouldStopIndexing(signal)) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop
            await this.performFileIndexingInternal(path, 'delete');
        }
    }

    /**
     * Get files that need indexing (new or modified since last index)
     */
    private async getFilesNeedingIndexing(allFiles: TFile[], signal?: AbortSignal): Promise<TFile[]> {
        const filesToIndex: TFile[] = [];
        logger.debug(`Enhanced search: Checking ${allFiles.length} files for indexing needs`);

        if (allFiles.length === 0) {
            return filesToIndex;
        }

        let cursor = 0;
        const concurrency = Math.min(8, Math.max(1, Math.ceil(allFiles.length / 100)));

        const workers = Array.from({ length: concurrency }, async () => {
            while (cursor < allFiles.length) {
                if (signal && this.shouldStopIndexing(signal)) {
                    return;
                }

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
            if (this.staleCachedPaths.has(file.path)) {
                return true;
            }

            const metadata = await this.persistence.getMetadata(file.path);

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

            // Indexed after the loaded snapshot was taken (e.g. the debounced
            // cache save never ran): the cached entry may hold old content.
            if (this.cacheSnapshotTime !== null && metadata.indexedAt > this.cacheSnapshotTime) {
                logger.debug(`Enhanced search: File ${file.path} was indexed after the cached snapshot, needs reindexing`);
                this.staleCachedPaths.add(file.path);
                return true;
            }

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
