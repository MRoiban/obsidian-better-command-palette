import { App, TFile, Notice } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchSettings } from './types';

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
        if (this.isInitialized) {
            return;
        }

        try {
            console.log('SemanticIndexingCoordinator: Initializing semantic indexing coordination');
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize semantic indexing coordinator:', error);
            throw error;
        }
    }

    /**
     * Check if auto-indexing should be triggered and start it if needed
     */
    async checkAndAutoIndex(): Promise<void> {
        try {
            console.log('Semantic indexing: Checking if auto-indexing is needed...');
            
            // Small delay to ensure all vault files are properly loaded
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            if (this.embeddingService.getIndexedFileCount() === 0) {
                console.log('Semantic indexing: No files indexed, checking connection and starting auto-indexing...');
                
                const isConnected = await this.embeddingService.checkConnection();
                if (isConnected) {
                    new Notice('Auto-indexing files for semantic search...', 3000);
                    console.log('Semantic indexing: Starting auto-indexing of all files');
                    
                    // Start indexing in the background without blocking
                    await this.indexAllFiles();
                } else {
                    console.log('Semantic indexing: Ollama not available, skipping auto-indexing');
                    new Notice(
                        'Ollama not available. Semantic search disabled.\nInstall Ollama and run: ollama pull nomic-embed-text',
                        8000
                    );
                }
            } else {
                const indexedCount = this.embeddingService.getIndexedFileCount();
                console.log(`Semantic indexing: ${indexedCount} files already indexed, no auto-indexing needed`);
            }
        } catch (error) {
            console.error('Semantic indexing: Error during auto-index check:', error);
        }
    }

    /**
     * Index all files with proper coordination and progress tracking
     */
    async indexAllFiles(onProgress?: (current: number, total: number) => void): Promise<void> {
        if (this.isIndexing) {
            console.log('Semantic indexing: Indexing already in progress, skipping');
            return;
        }

        this.isIndexing = true;
        this.onProgressCallback = onProgress;

        try {
            console.log('Semantic indexing: Starting coordinated indexing of all files');
            
            await this.embeddingService.indexAllFiles((current, total) => {
                // Update progress occasionally without blocking UI
                if (current % 5 === 0 || current === total) {
                    console.log(`Semantic indexing: Progress ${current}/${total} files`);
                }
                
                if (this.onProgressCallback) {
                    this.onProgressCallback(current, total);
                }
            });

            const indexedCount = this.embeddingService.getIndexedFileCount();
            console.log(`Semantic indexing: Completed, ${indexedCount} files indexed`);
            new Notice(`✅ Semantic search: Successfully indexed ${indexedCount} files`, 3000);

        } catch (error) {
            console.error('Semantic indexing: Failed:', error);
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
            console.warn('Semantic indexing: Coordinator not initialized, skipping file indexing');
            return;
        }

        // Clear any pending update for this file
        if (this.pendingUpdates.has(file.path)) {
            clearTimeout(this.pendingUpdates.get(file.path)!);
        }

        // Debounce the update - semantic indexing is more expensive
        this.pendingUpdates.set(file.path, setTimeout(async () => {
            try {
                console.log(`Semantic indexing: Processing file ${file.path}`);
                
                // Check if file should be excluded
                if (this.embeddingService.shouldExcludeFile(file)) {
                    console.log(`Semantic indexing: Skipping excluded file ${file.path}`);
                    this.pendingUpdates.delete(file.path);
                    return;
                }

                await this.embeddingService.indexFile(file);
                console.log(`Semantic indexing: Successfully indexed ${file.path}`);
                
                this.pendingUpdates.delete(file.path);
                
            } catch (error) {
                console.error(`Semantic indexing: Failed to index file ${file.path}:`, error);
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
            console.log(`Semantic indexing: Removing file ${filePath}`);
            this.embeddingService.removeFromCache(filePath);
        } catch (error) {
            console.error(`Semantic indexing: Failed to remove file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Handle file rename operations
     */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        try {
            console.log(`Semantic indexing: Handling file rename from ${oldPath} to ${newPath}`);
            
            // Remove old file from cache
            await this.removeFile(oldPath);
            
            // Index the file at its new location
            const file = this.app.vault.getAbstractFileByPath(newPath) as TFile;
            if (file && file.extension === 'md') {
                await this.indexFile(file);
            }
        } catch (error) {
            console.error(`Semantic indexing: Failed to handle file rename from ${oldPath} to ${newPath}:`, error);
            throw error;
        }
    }

    /**
     * Force reindex of a specific file (bypass debouncing)
     */
    async forceReindexFile(file: TFile): Promise<void> {
        try {
            console.log(`Semantic indexing: Force reindexing file ${file.path}`);
            
            // Cancel any pending updates
            if (this.pendingUpdates.has(file.path)) {
                clearTimeout(this.pendingUpdates.get(file.path)!);
                this.pendingUpdates.delete(file.path);
            }

            await this.embeddingService.indexFile(file);
            console.log(`Semantic indexing: Successfully force reindexed ${file.path}`);
            
        } catch (error) {
            console.error(`Semantic indexing: Failed to force reindex file ${file.path}:`, error);
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
            console.log('Semantic indexing: Clearing entire index');
            
            // Cancel all pending updates
            this.pendingUpdates.forEach(timeout => clearTimeout(timeout));
            this.pendingUpdates.clear();

            this.embeddingService.clearCache();
            
            console.log('Semantic indexing: Index cleared successfully');
        } catch (error) {
            console.error('Semantic indexing: Failed to clear index:', error);
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
            console.log('Semantic indexing: Shutting down coordinator');
            
            // Cancel all pending updates
            this.pendingUpdates.forEach(timeout => clearTimeout(timeout));
            this.pendingUpdates.clear();
            
            // Save the embedding cache
            if (this.embeddingService) {
                await this.embeddingService.saveCache();
            }
            
            this.isInitialized = false;
            console.log('Semantic indexing: Coordinator shutdown complete');
        } catch (error) {
            console.error('Semantic indexing: Error during shutdown:', error);
        }
    }

    /**
     * Update settings for the coordinator
     */
    updateSettings(newSettings: SemanticSearchSettings): void {
        this.settings = newSettings;
        console.log('Semantic indexing: Coordinator settings updated');
    }
} 