import { App, TFile, Notice } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchSettings } from './types';
import { logger } from '../../utils/logger';
import { SmartScheduler } from '../../utils/smart-scheduler';

/**
 * Coordinates background semantic indexing of files
 * Handles debouncing, error recovery, and performance monitoring for semantic search
 */
export class SemanticIndexingCoordinator {
    private app: App;

    private embeddingService: EmbeddingService;

    private settings: SemanticSearchSettings;

    private scheduler: SmartScheduler;

    private isInitialized = false;

    private isIndexing = false;

    private onProgressCallback?: (current: number, total: number) => void;

    constructor(
        app: App,
        embeddingService: EmbeddingService,
        settings: SemanticSearchSettings,
        options: { throttleMs?: number; debounceMs?: number } = {},
    ) {
        this.app = app;
        this.embeddingService = embeddingService;
        this.settings = settings;

        // Use SmartScheduler for debounce-only pattern
        this.scheduler = new SmartScheduler(
            (filePaths) => this.processScheduledFiles(filePaths),
            {
                throttleMs: 60000,   // Effectively disabled
                debounceMs: 10000,   // 10s of inactivity before reindex
                name: 'SemanticIndexing',
            },
        );
    }

    /**
     * Initialize the semantic indexing coordinator
     */
    async initialize(): Promise<void> {
        logger.info('SemanticIndexingCoordinator: Initializing semantic indexing coordination');
        if (this.isInitialized) {
            return;
        }

        try {
            this.isInitialized = true;
        } catch (error) {
            logger.error('Failed to initialize semantic indexing coordinator:', error);
            throw error;
        }
    }

    /**
     * Check if auto-indexing should be triggered and start it if needed
     */
    async checkForAutoIndexing(): Promise<void> {
        logger.debug('[Semantic Search] Checking if auto-indexing is needed...');

        try {
            const indexedCount = this.embeddingService.getIndexedFileCount();
            logger.debug(`[Semantic Search] Currently indexed: ${indexedCount} files`);

            if (indexedCount === 0) {
                logger.debug('[Semantic Search] No files indexed, checking Ollama connection...');

                // Check if Ollama is available before auto-indexing
                const isAvailable = await this.embeddingService.checkConnection();
                logger.debug(`[Semantic Search] Ollama available: ${isAvailable}`);

                if (isAvailable) {
                    logger.debug('[Semantic Search] Starting auto-indexing of all files...');
                    await this.indexAllFiles();
                } else {
                    console.warn('[Semantic Search] Ollama not available, skipping auto-indexing. Make sure Ollama is running.');
                    new Notice('Semantic search: Ollama not available. Please start Ollama and reload the plugin.');
                }
            } else {
                logger.debug(`[Semantic Search] ${indexedCount} files already indexed, skipping auto-indexing`);
            }
        } catch (error) {
            console.error('[Semantic Search] Error in auto-indexing check:', error);
        }
    }

    /**
     * Index all files with proper coordination and progress tracking
     */
    async indexAllFiles(onProgress?: (current: number, total: number) => void): Promise<void> {
        if (this.isIndexing) {
            logger.debug('Semantic indexing: Indexing already in progress, skipping');
            return;
        }

        this.isIndexing = true;
        this.onProgressCallback = onProgress;

        try {
            logger.info('Semantic indexing: Starting coordinated indexing of all files');

            await this.embeddingService.indexAllFiles((current, total) => {
                // Update progress occasionally without blocking UI
                if (current % 5 === 0 || current === total) {
                    logger.debug(`Semantic indexing: Progress ${current}/${total} files`);
                }

                if (this.onProgressCallback) {
                    this.onProgressCallback(current, total);
                }
            });

            const indexedCount = this.embeddingService.getIndexedFileCount();
            logger.info(`Semantic indexing: Completed, ${indexedCount} files indexed`);
            new Notice(`✅ Semantic search: Successfully indexed ${indexedCount} files`, 3000);
        } catch (error) {
            logger.error('Semantic indexing: Failed:', error);
            new Notice(`❌ Semantic search indexing failed: ${error.message}`, 5000);
            throw error;
        } finally {
            this.isIndexing = false;
            this.onProgressCallback = undefined;
        }
    }

    /**
     * Index a single file using Smart Scheduler (throttle + debounce)
     * This ensures responsive updates during active editing while 
     * guaranteeing a final cleanup after activity stops.
     */
    async indexFile(file: TFile): Promise<void> {
        if (!this.isInitialized) {
            logger.warn('Semantic indexing: Coordinator not initialized, skipping file indexing');
            return;
        }

        if (this.embeddingService.shouldExcludeFile(file)) {
            logger.debug(`Semantic indexing: Skipping excluded file ${file.path}`);
            return;
        }

        // Schedule the file for processing via SmartScheduler
        this.scheduler.schedule(file.path);
    }

    /**
     * Process files scheduled by SmartScheduler
     */
    private async processScheduledFiles(filePaths: string[]): Promise<void> {
        logger.debug(`Semantic indexing: Processing ${filePaths.length} scheduled files`);

        for (const filePath of filePaths) {
            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (!(file instanceof TFile)) {
                    logger.debug(`Semantic indexing: File not found or not a TFile: ${filePath}`);
                    continue;
                }

                await this.embeddingService.indexFile(file);
                logger.debug(`Semantic indexing: Successfully indexed ${filePath}`);
            } catch (error) {
                logger.error(`Semantic indexing: Failed to index file ${filePath}:`, error);
            }
        }
    }

    /**
     * Remove a file from the semantic index
     */
    async removeFile(filePath: string): Promise<void> {
        // Note: We don't cancel scheduled updates here since the scheduler batches
        // and the file will simply be skipped if it doesn't exist anymore

        try {
            logger.debug(`Semantic indexing: Removing file ${filePath}`);
            this.embeddingService.removeFromCache(filePath);
        } catch (error) {
            logger.error(`Semantic indexing: Error removing file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Handle file rename operations
     */
    async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        try {
            logger.debug(`Semantic indexing: Handling file rename from ${oldPath} to ${newPath}`);

            // Remove old embedding and index new file
            this.embeddingService.removeFromCache(oldPath);

            // Find the new file and index it
            const file = this.app.vault.getAbstractFileByPath(newPath) as TFile;
            if (file) {
                await this.indexFile(file);
            }
        } catch (error) {
            logger.error(`Semantic indexing: Error handling file rename from ${oldPath} to ${newPath}:`, error);
        }
    }

    /**
     * Handle file rename operations (alias for handleFileRename for compatibility)
     */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        await this.handleFileRename(oldPath, newPath);
    }

    /**
     * Force reindex of a specific file (bypass debouncing)
     */
    async forceReindexFile(file: TFile): Promise<void> {
        try {
            logger.debug(`Semantic indexing: Force reindexing file ${file.path}`);

            // Remove existing embedding first
            this.embeddingService.removeFromCache(file.path);

            // Then reindex
            await this.indexFile(file);
            logger.debug(`Semantic indexing: Successfully force reindexed ${file.path}`);
        } catch (error) {
            logger.error(`Semantic indexing: Error force reindexing file ${file.path}:`, error);
            throw error;
        }
    }

    /**
     * Get indexing statistics
     */
    getStats(): { indexedFiles: number; isIndexing: boolean; pendingUpdates: number } {
        return {
            indexedFiles: this.embeddingService.getIndexedFileCount(),
            isIndexing: this.isIndexing,
            pendingUpdates: this.scheduler.pendingCount,
        };
    }

    /**
     * Clear the entire semantic index
     */
    async clearIndex(): Promise<void> {
        try {
            logger.info('Semantic indexing: Clearing entire index');

            // Stop any ongoing indexing
            this.isIndexing = false;

            // Clear the embedding service index
            this.embeddingService.clearCache();

            logger.info('Semantic indexing: Index cleared successfully');
        } catch (error) {
            logger.error('Semantic indexing: Error clearing index:', error);
            throw error;
        }
    }

    /**
     * Check if indexing is currently in progress
     */
    isIndexingInProgress(): boolean {
        return this.isIndexing;
    }

    /**
     * Shutdown the coordinator and cleanup resources
     */
    async shutdown(): Promise<void> {
        try {
            logger.info('Semantic indexing: Shutting down coordinator');

            // Stop any ongoing indexing
            this.isIndexing = false;

            // Destroy the scheduler
            this.scheduler.destroy();

            // Clean up the embedding service
            if (this.embeddingService) {
                await this.embeddingService.saveCache();
            }

            logger.info('Semantic indexing: Coordinator shutdown complete');
        } catch (error) {
            logger.error('Semantic indexing: Error during shutdown:', error);
        }
    }

    /**
     * Update settings for the coordinator
     */
    updateSettings(newSettings: SemanticSearchSettings): void {
        this.settings = newSettings;
        this.embeddingService.updateSettings(newSettings);
        logger.debug('Semantic indexing: Coordinator settings updated');
    }
}
