import { App, TFile, debounce } from 'obsidian';
import { SearchSettings, EnhancedSearchResult, FileMetadata } from './interfaces';
import { MiniSearchAdapter } from './mini-search-adapter';
import { IndexingCoordinator } from './indexing-coordinator';
import { IndexPersistence } from './persistence';
import { FileUsageTracker } from './usage-tracker';
import { ContentSearchScorer } from './scorer';
import { performanceMonitor } from './performance-monitor';

/**
 * Main search service that coordinates all enhanced search components
 */
export class EnhancedSearchService {
    private app: App;
    private settings: SearchSettings;
    private searchIndex: MiniSearchAdapter;
    private indexingCoordinator: IndexingCoordinator;
    private persistence: IndexPersistence;
    private usageTracker: FileUsageTracker;
    private scorer: ContentSearchScorer;
    private isInitialized = false;
    private indexingPaused = false;
    private debouncedCacheSave: () => void;
    private isIndexing = false;

    constructor(app: App, settings: SearchSettings) {
        this.app = app;
        this.settings = settings;
        this.searchIndex = new MiniSearchAdapter();
        this.persistence = new IndexPersistence();
        this.usageTracker = new FileUsageTracker();
        this.scorer = new ContentSearchScorer(settings);
        
        this.indexingCoordinator = new IndexingCoordinator(
            this.searchIndex,
            this.persistence,
            this.usageTracker,
            this.persistence,
            debounce(this.performFileIndexing.bind(this), settings.indexingDebounceMs)
        );

        // Create debounced cache save function to avoid excessive saves
        this.debouncedCacheSave = debounce(this.saveIndexToCache.bind(this), 2000);
    }

    /**
     * Initialize the search service
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        console.log('Enhanced search: Starting initialization...');

        try {
            // Initialize persistence layer
            await this.persistence.initialize();
            console.log('Enhanced search: Persistence initialized');

            // Load existing index and usage data
            await this.loadPersistedData();
            console.log('Enhanced search: Data loaded');

            // Set up file system watchers
            this.setupFileWatchers();
            console.log('Enhanced search: File watchers set up');

            // Start background indexing for any new/changed files
            await this.indexVault();
            console.log('Enhanced search: Vault indexing complete');

            this.isInitialized = true;
            console.log('Enhanced search: Initialization complete');
        } catch (error) {
            console.error('Enhanced search: Failed to initialize:', error);
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

        console.log(`Enhanced search: Searching for "${query}" with limit ${limit}`);

        const operationId = `search-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            // Get basic search results from the index
            const searchResults = await this.searchIndex.search(query, limit * 2); // Get more results for better ranking
            console.log(`Enhanced search: MiniSearch returned ${searchResults.length} results`);

            // Enhance results with usage and recency scoring
            const enhancedResults: EnhancedSearchResult[] = [];

            for (const result of searchResults) {
                const usageScore = this.settings.enableUsageTracking ? 
                    this.usageTracker.getUsageScore(result.metadata.path) : 0;
                const recencyScore = this.settings.enableUsageTracking ? 
                    this.usageTracker.getRecencyScore(result.metadata.path) : 0;
                const lastOpened = this.usageTracker.getLastOpened(result.metadata.path);

                // Calculate combined score
                const combinedScore = this.scorer.calculateCombinedScore({
                    query,
                    contentScore: result.score,
                    usageScore,
                    recencyScore,
                    metadata: result.metadata,
                    lastOpened
                });

                enhancedResults.push({
                    ...result,
                    combinedScore,
                    contentScore: result.score,
                    usageScore,
                    recencyScore,
                    lastOpened
                });
            }

            // Sort by combined score
            enhancedResults.sort((a, b) => b.combinedScore - a.combinedScore);

            // Record search performance
            const duration = performanceMonitor.endTiming(operationId, 'search');
            
            // Record search in usage tracker
            if (this.settings.enableUsageTracking) {
                this.usageTracker.recordSearch(query);
            }

            return enhancedResults.slice(0, limit);

        } catch (error) {
            performanceMonitor.endTiming(operationId, 'search');
            console.error('Search failed:', error);
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
     * Record search selection for usage tracking
     */
    recordSearchSelection(query: string, selectedPath: string): void {
        if (this.settings.enableUsageTracking) {
            this.usageTracker.recordSearch(query, selectedPath);
        }
    }

    /**
     * Update search settings
     */
    updateSettings(newSettings: Partial<SearchSettings>): void {
        this.settings = { ...this.settings, ...newSettings };
        this.scorer = new ContentSearchScorer(this.settings);
    }

    /**
     * Get search statistics
     */
    getSearchStats(): {
        indexStats: ReturnType<MiniSearchAdapter['getStats']>;
        usageStats: any;
        performanceStats: ReturnType<typeof performanceMonitor.getPerformanceReport>;
    } {
        return {
            indexStats: this.searchIndex.getStats(),
            usageStats: {}, // TODO: Implement usage stats
            performanceStats: performanceMonitor.getPerformanceReport()
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
        console.log('Enhanced search: Rebuilding entire index...');
        await this.searchIndex.clear();
        
        // Clear the cached index as well
        try {
            await this.persistence.saveSearchIndex(null);
            console.log('Enhanced search: Cleared cached index');
        } catch (error) {
            console.warn('Enhanced search: Failed to clear cached index:', error);
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
            console.warn('Enhanced search: Service not initialized yet');
            return;
        }
        console.log('Enhanced search: Manually triggering vault indexing...');
        await this.indexVault();
    }

    /**
     * Pause indexing to improve performance
     */
    pauseIndexing(): void {
        this.indexingPaused = true;
        console.log('Enhanced search: Indexing paused');
    }

    /**
     * Resume indexing
     */
    resumeIndexing(): void {
        this.indexingPaused = false;
        console.log('Enhanced search: Indexing resumed');
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
        currentStats: ReturnType<MiniSearchAdapter['getStats']>;
        isPaused: boolean;
    } {
        return {
            isIndexing: this.isIndexing,
            currentStats: this.searchIndex.getStats(),
            isPaused: this.indexingPaused
        };
    }

    /**
     * Force a cache save (useful for testing or manual operations)
     */
    async forceCacheSave(): Promise<void> {
        await this.saveIndexToCache();
    }

    private async loadPersistedData(): Promise<void> {
        try {
            // Load search index
            const indexData = await this.persistence.loadSearchIndex();
            if (indexData && indexData.index) {
                console.log('Enhanced search: Loading cached search index...');
                await this.searchIndex.loadFromData(indexData);
                console.log(`Enhanced search: Loaded cached index with ${indexData.stats?.documentCount || 0} documents`);
                
                // Verify cache is still valid by checking file modifications
                const cacheValid = await this.validateCache(indexData);
                if (!cacheValid) {
                    console.log('Enhanced search: Cache is outdated, will rebuild index');
                    await this.searchIndex.clear();
                } else {
                    console.log('Enhanced search: Cache is valid, skipping full reindex');
                    return; // Cache is valid, no need to reindex everything
                }
            } else {
                console.log('Enhanced search: No cached index found, will build from scratch');
            }

            // Usage data is loaded automatically by the tracker
        } catch (error) {
            console.warn('Failed to load persisted search data:', error);
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

            const cacheTimestamp = indexData.stats.lastUpdated;
            const files = this.app.vault.getMarkdownFiles();
            
            // Check if the number of files has changed significantly first (quick check)
            const currentFileCount = files.length;
            const cachedFileCount = indexData.stats?.documentCount || 0;
            
            if (Math.abs(currentFileCount - cachedFileCount) > Math.max(1, currentFileCount * 0.1)) {
                console.log(`Enhanced search: File count changed significantly (${currentFileCount} vs ${cachedFileCount})`);
                return false;
            }

            // For large vaults, only check a sample of files to avoid long validation times
            const sampleSize = Math.min(files.length, 50); // Check max 50 files
            const filesToCheck = files.length > sampleSize ? 
                this.sampleArray(files, sampleSize) : files;

            console.log(`Enhanced search: Checking ${filesToCheck.length} files for modifications (sampling from ${files.length} total)`);

            // Check if any sampled files have been modified since the cache was created
            for (const file of filesToCheck) {
                if (file.stat.mtime > cacheTimestamp) {
                    console.log(`Enhanced search: File ${file.path} modified since cache (${new Date(file.stat.mtime).toISOString()} > ${new Date(cacheTimestamp).toISOString()})`);
                    return false;
                }
            }

            console.log(`Enhanced search: Cache is valid (${cachedFileCount} files, last updated ${new Date(cacheTimestamp).toISOString()})`);
            return true;
        } catch (error) {
            console.warn('Enhanced search: Failed to validate cache:', error);
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
            const indexData = await this.searchIndex.exportIndex();
            await this.persistence.saveSearchIndex(indexData);
            console.log('Enhanced search: Index saved to cache');
        } catch (error) {
            console.warn('Enhanced search: Failed to save index to cache:', error);
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
                this.handleFileChange(oldPath, 'delete');
                this.handleFileChange(file.path, 'create');
            }
        });
    }

    private async handleFileChange(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        try {
            // Skip indexing if paused (except for deletes which should always be processed)
            if (this.indexingPaused && operation !== 'delete') {
                console.log(`Enhanced search: Skipping ${operation} for ${filePath} (indexing paused)`);
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
                            console.error(`Failed to schedule file update for ${filePath}:`, error);
                        }
                    }, { timeout: 2000 }); // 2 second timeout for important updates
                } else {
                    // Fallback for environments without requestIdleCallback
                    setTimeout(async () => {
                        try {
                            await this.indexingCoordinator.scheduleFileUpdate(filePath, operation);
                        } catch (error) {
                            console.error(`Failed to schedule file update for ${filePath}:`, error);
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
            console.error(`Failed to handle file change for ${filePath}:`, error);
        }
    }

    private async indexVault(): Promise<void> {
        if (this.isIndexing) {
            console.log('Enhanced search: Indexing already in progress, skipping');
            return;
        }

        this.isIndexing = true;
        const operationId = `index-vault-${Date.now()}`;
        performanceMonitor.startTiming(operationId);

        try {
            // Check if vault is ready
            if (!this.app.vault) {
                console.warn('Enhanced search: Vault not available yet');
                return;
            }

            const files = this.app.vault.getMarkdownFiles();
            console.log(`Enhanced search: Found ${files.length} markdown files to check`);
            
            if (files.length === 0) {
                console.warn('Enhanced search: No markdown files found. This might indicate the vault is not fully loaded yet.');
                // Try again after a short delay
                setTimeout(() => {
                    console.log('Enhanced search: Retrying vault indexing...');
                    this.indexVault().catch(error => {
                        console.error('Enhanced search: Retry failed:', error);
                    });
                }, 2000);
                return;
            }
            
            // Limit the number of files to index based on settings
            const allFiles = files.slice(0, this.settings.maxIndexedFiles);
            
            if (allFiles.length < files.length) {
                console.warn(`Indexing limited to ${this.settings.maxIndexedFiles} files out of ${files.length} total`);
            }

            // Filter out files that are already indexed and up-to-date
            const filesToIndex = await this.getFilesNeedingIndexing(allFiles);
            
            if (filesToIndex.length === 0) {
                console.log('Enhanced search: All files are already indexed and up-to-date');
                performanceMonitor.endTiming(operationId, 'indexing');
                return;
            }

            console.log(`Enhanced search: Found ${filesToIndex.length} files that need indexing (${allFiles.length - filesToIndex.length} already cached)`);
            console.log(`Enhanced search: Starting to index ${filesToIndex.length} files`);

            // Use even smaller batches and longer delays for better UI responsiveness
            const batchSize = Math.min(this.settings.indexingBatchSize || 2, 2); // Maximum 2 files per batch
            let indexedCount = 0;
            
            for (let i = 0; i < filesToIndex.length; i += batchSize) {
                const batch = filesToIndex.slice(i, i + batchSize);
                console.log(`Enhanced search: Indexing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(filesToIndex.length/batchSize)} (files ${indexedCount + 1}-${indexedCount + batch.length})`);
                
                // Process files sequentially within batch to reduce load
                for (const file of batch) {
                    // Check if indexing has been paused
                    if (this.indexingPaused) {
                        console.log('Enhanced search: Indexing paused by user, stopping vault indexing');
                        return;
                    }

                    try {
                        // Use requestIdleCallback or setTimeout to yield control
                        await new Promise<void>((resolve) => {
                            const scheduleWork = (callback: () => void) => {
                                if ('requestIdleCallback' in window) {
                                    requestIdleCallback(callback, { timeout: 500 });
                                } else {
                                    setTimeout(callback, 0);
                                }
                            };

                            scheduleWork(async () => {
                                try {
                                    await this.performFileIndexing(file.path, 'create');
                                    resolve();
                                } catch (error) {
                                    console.error(`Enhanced search: Failed to index ${file.path}:`, error);
                                    resolve(); // Continue with next file
                                }
                            });
                        });

                        indexedCount++;
                        
                        // Longer delay after each file to ensure UI responsiveness
                        await new Promise(resolve => setTimeout(resolve, this.settings.indexingDelayMs || 100));
                    } catch (error) {
                        console.error(`Enhanced search: Failed to index ${file.path}:`, error);
                    }
                }
                
                // Longer delay between batches to let UI catch up
                await new Promise(resolve => setTimeout(resolve, this.settings.indexingBatchDelayMs || 300));
                
                // Log progress every 5 files (more frequent updates)
                if (indexedCount % 5 === 0 || indexedCount === filesToIndex.length) {
                    console.log(`Enhanced search: Progress ${indexedCount}/${filesToIndex.length} files indexed`);
                }
            }

            console.log('Enhanced search: Vault indexing completed');
            
            // Save the index to cache after successful indexing
            await this.saveIndexToCache();
            
            performanceMonitor.endTiming(operationId, 'indexing');
        } catch (error) {
            performanceMonitor.endTiming(operationId, 'indexing');
            console.error('Failed to index vault:', error);
            throw error;
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Actually perform the file indexing (called by debounced callback)
     * Uses requestIdleCallback to avoid blocking the UI
     */
    private async performFileIndexing(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        const startTime = Date.now();
        
        return new Promise<void>((resolve, reject) => {
            // Use requestIdleCallback if available, otherwise setTimeout
            const scheduleWork = (callback: () => void) => {
                if ('requestIdleCallback' in window) {
                    requestIdleCallback(callback, { timeout: 1000 });
                } else {
                    setTimeout(callback, 0);
                }
            };

            scheduleWork(async () => {
                try {
                    if (operation === 'delete') {
                        await this.searchIndex.removeDocument(filePath);
                        
                        // Clean up metadata for deleted file
                        try {
                            await this.persistence.delete(filePath);
                        } catch (error) {
                            console.warn(`Failed to clean up metadata for deleted file ${filePath}:`, error);
                        }
                        
                        console.log(`Enhanced search: Removed ${filePath} from index (${Date.now() - startTime}ms)`);
                        
                        // Save cache after deletion to keep it current
                        this.debouncedCacheSave();
                        
                        resolve();
                        return;
                    }

                    // Get the file
                    const file = this.app.vault.getAbstractFileByPath(filePath);
                    if (!file || !(file instanceof TFile) || file.extension !== 'md') {
                        resolve(); // Silent skip for non-markdown files
                        return;
                    }

                    // Check file size to avoid indexing very large files that could block UI
                    const maxFileSize = this.settings.maxFileSize || (512 * 1024); // 512KB default (reduced from 1MB)
                    if (file.stat.size > maxFileSize) {
                        console.warn(`Enhanced search: Skipping large file ${filePath} (${Math.round(file.stat.size / 1024)}KB)`);
                        resolve();
                        return;
                    }

                    // Extract metadata and content efficiently
                    const [metadata, content] = await Promise.all([
                        Promise.resolve(this.extractFileMetadata(file)),
                        this.app.vault.read(file)
                    ]);
                    
                    // Skip empty files
                    if (!content || content.trim().length === 0) {
                        resolve();
                        return;
                    }

                    // For large content, break it into chunks to avoid blocking
                    if (content.length > 50000) // 50KB threshold
                    {
                        // Schedule the actual indexing work for next idle period
                        scheduleWork(async () => {
                            try {
                                await this.indexDocumentAsync(filePath, content, metadata);
                                const duration = Date.now() - startTime;
                                if (duration > 100) {
                                    console.log(`Enhanced search: Indexed ${filePath} (${duration}ms, ${Math.round(content.length / 1024)}KB)`);
                                }
                                resolve();
                            } catch (error) {
                                reject(error);
                            }
                        });
                    } else {
                        // Small files can be indexed immediately
                        await this.indexDocumentAsync(filePath, content, metadata);
                        const duration = Date.now() - startTime;
                        if (duration > 100) {
                            console.log(`Enhanced search: Indexed ${filePath} (${duration}ms, ${Math.round(content.length / 1024)}KB)`);
                        }
                        
                        // Save cache after each file update to keep it current
                        // Use a debounced approach to avoid excessive saves
                        this.debouncedCacheSave();
                        
                        resolve();
                    }

                } catch (error) {
                    console.error(`Enhanced search: Failed to index ${filePath}:`, error);
                    reject(error);
                }
            });
        });
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
            contentHash: this.generateContentHash(content),
            size: content.length
        });

        // Store content if enabled (but don't block on it)
        if (this.settings.enableContentSearch) {
            this.persistence.set(filePath, content).catch(error => {
                console.warn(`Failed to store content for ${filePath}:`, error);
            });
        }

        // Periodically save cache for incremental updates (every 10 files)
        // This ensures we don't lose too much progress if something goes wrong
        const stats = this.searchIndex.getStats();
        if (stats.documentCount % 10 === 0) {
            // Save cache in background, don't block indexing
            this.saveIndexToCache().catch(error => {
                console.warn('Failed to save incremental cache update:', error);
            });
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
        console.log(`Enhanced search: Checking ${allFiles.length} files for indexing needs`);
        
        for (const file of allFiles) {
            try {
                // Check if we have metadata for this file
                const metadata = await this.persistence.getMetadata(file.path);
                console.log(`Enhanced search: Metadata check for ${file.path}:`, metadata ? 'found' : 'not found', metadata);
                
                if (!metadata) {
                    // No metadata means file was never indexed
                    console.log(`Enhanced search: File ${file.path} has no metadata, needs indexing`);
                    filesToIndex.push(file);
                    continue;
                }
                
                // Check if file has been modified since last index
                if (file.stat.mtime > metadata.indexedAt) {
                    console.log(`Enhanced search: File ${file.path} needs reindexing (modified ${new Date(file.stat.mtime).toISOString()} > indexed ${new Date(metadata.indexedAt).toISOString()})`);
                    filesToIndex.push(file);
                    continue;
                }
                
                // Check if file is already in search index
                if (!this.searchIndex.hasDocument(file.path)) {
                    console.log(`Enhanced search: File ${file.path} not found in search index, needs indexing`);
                    filesToIndex.push(file);
                    continue;
                }
                
                // File is up to date
                console.log(`Enhanced search: File ${file.path} is up to date (indexed ${new Date(metadata.indexedAt).toISOString()})`);
                
            } catch (error) {
                console.warn(`Enhanced search: Error checking metadata for ${file.path}, will reindex:`, error);
                filesToIndex.push(file);
            }
        }
        
        console.log(`Enhanced search: ${filesToIndex.length} files need indexing out of ${allFiles.length} total`);
        return filesToIndex;
    }

    /**
     * Generate a simple hash of content for change detection
     */
    private generateContentHash(content: string): string {
        // Simple hash function for content change detection
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString(36);
    }

    private extractFileMetadata(file: TFile): FileMetadata {
        const metadata = this.app.metadataCache.getFileCache(file);
        
        return {
            path: file.path,
            title: metadata?.frontmatter?.title || file.basename,
            headings: metadata?.headings?.map(h => ({ heading: h.heading, level: h.level })) || [],
            frontmatter: metadata?.frontmatter || {},
            tags: metadata?.tags?.map(t => t.tag) || [],
            aliases: metadata?.frontmatter?.aliases || [],
            links: metadata?.links?.map(l => l.link) || [],
            size: file.stat.size,
            lastModified: file.stat.mtime
        };
    }
}
