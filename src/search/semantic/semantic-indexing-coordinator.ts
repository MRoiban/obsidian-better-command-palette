import { App, TFile, Notice } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchSettings } from './types';
import { logger } from '../../utils/logger';

/**
 * Coordinates background semantic indexing of files
 * Handles debouncing, error recovery, and performance monitoring for semantic search
 */
export class SemanticIndexingCoordinator {
    private app: App;
    private embeddingService: EmbeddingService;
    private settings: SemanticSearchSettings;
    private pendingUpdates = new Map<string, NodeJS.Timeout>();
    private isInitialized = false;
    private isIndexing = false;
    private debounceMs: number;
    private onProgressCallback?: (current: number, total: number) => void;

    constructor(
        app: App,
        embeddingService: EmbeddingService,
        settings: SemanticSearchSettings,
        debounceMs = 2000  // Longer debounce for semantic indexing due to API calls
    ) {
        this.app = app;
        this.embeddingService = embeddingService;
        this.settings = settings;
        this.debounceMs = debounceMs;
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
        logger.debug('Semantic indexing: Checking if auto-indexing is needed...');
        
        try {
            const indexedCount = this.embeddingService.getIndexedFileCount();
            
            if (indexedCount === 0) {
                logger.info('Semantic indexing: No files indexed, checking connection and starting auto-indexing...');
                
                // Check if Ollama is available before auto-indexing
                const isAvailable = await this.embeddingService.checkOllamaConnection();
                if (isAvailable) {
                    logger.info('Semantic indexing: Starting auto-indexing of all files');
                    await this.indexAllFiles();
                } else {
                    logger.warn('Semantic indexing: Ollama not available, skipping auto-indexing');
                }
            } else {
                // Check if we have a reasonable number of files indexed
                const markdownFiles = this.embeddingService.getMarkdownFiles();
                const threshold = Math.min(markdownFiles.length * 0.8, 50); // 80% or 50 files max
                
                if (indexedCount < threshold && markdownFiles.length > 10) {
                    logger.info(`Semantic indexing: ${indexedCount} files already indexed, no auto-indexing needed`);
                }
            }
        } catch (error) {
            logger.error('Semantic indexing: Error in auto-indexing check:', error);
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
     * Index a single file with debouncing to handle rapid updates
     */
    async indexFile(file: TFile): Promise<void> {
        if (!this.isInitialized) {
            logger.warn('Semantic indexing: Coordinator not initialized, skipping file indexing');
            return;
        }

        // Clear any pending update for this file
        if (this.pendingUpdates.has(file.path)) {
            clearTimeout(this.pendingUpdates.get(file.path)!);
        }

        // Debounce the update - semantic indexing is more expensive
        this.pendingUpdates.set(file.path, setTimeout(async () => {
            try {
                logger.debug(`Semantic indexing: Processing file ${file.path}`);
                
                if (this.embeddingService.shouldExcludeFile(file)) {
                    logger.debug(`Semantic indexing: Skipping excluded file ${file.path}`);
                    this.pendingUpdates.delete(file.path);
                    return;
                }

                await this.embeddingService.indexFile(file);
                logger.debug(`Semantic indexing: Successfully indexed ${file.path}`);
                
                this.pendingUpdates.delete(file.path);
                
            } catch (error) {
                logger.error(`Semantic indexing: Failed to index file ${file.path}:`, error);
                this.pendingUpdates.delete(file.path);
            }
        }, this.debounceMs));
    }

    /**
     * Remove a file from the semantic index
     */
    async removeFile(filePath: string): Promise<void> {
        // Cancel any pending updates
        if (this.pendingUpdates.has(filePath)) {
            clearTimeout(this.pendingUpdates.get(filePath)!);
            this.pendingUpdates.delete(filePath);
        }

        try {
            logger.debug(`Semantic indexing: Removing file ${filePath}`);
            this.embeddingService.removeEmbedding(filePath);
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
            this.embeddingService.removeEmbedding(oldPath);
            
            // Find the new file and index it
            const file = this.embeddingService.getFileByPath(newPath);
            if (file) {
                await this.indexFile(file);
            }
        } catch (error) {
            logger.error(`Semantic indexing: Error handling file rename from ${oldPath} to ${newPath}:`, error);
        }
    }

    /**
     * Force reindex of a specific file (bypass debouncing)
     */
    async forceReindexFile(file: TFile): Promise<void> {
        try {
            logger.debug(`Semantic indexing: Force reindexing file ${file.path}`);
            
            // Remove existing embedding first
            this.embeddingService.removeEmbedding(file.path);
            
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
            pendingUpdates: this.pendingUpdates.size
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
            await this.embeddingService.clearAllEmbeddings();
            
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