import { App, TFile } from 'obsidian';
import {
    ContentStore, SearchIndex, UsageTracker, FileMetadata, SearchResult,
} from './interfaces';
import { logger } from '../utils/logger';
import { generateContentHashBase36 } from '../utils/hash';

/**
 * Coordinates background indexing of files using web workers
 * Handles debouncing, error recovery, and performance monitoring
 */
export class IndexingCoordinator {
    private app: App;

    private searchIndex: SearchIndex;

    private contentStore: ContentStore;

    private usageTracker: UsageTracker;

    private persistence: any;

    private debounceCallback: (filePath: string, operation: string) => void;

    private pendingUpdates = new Map<string, NodeJS.Timeout>();

    private isInitialized = false;

    private debounceMs: number;

    private enableContentSearch: boolean;

    private getFileByPath?: (path: string) => TFile | null;

    constructor(
        app: App,
        searchIndex: SearchIndex,
        contentStore: ContentStore,
        usageTracker: UsageTracker,
        persistence: any,
        debounceCallback: (filePath: string, operation: string) => void,
        debounceMs = 500,
        options: { enableContentSearch?: boolean } = {},
    ) {
        this.app = app;
        this.searchIndex = searchIndex;
        this.contentStore = contentStore;
        this.usageTracker = usageTracker;
        this.persistence = persistence;
        this.debounceCallback = debounceCallback;
        this.debounceMs = debounceMs;
        this.enableContentSearch = options.enableContentSearch ?? true;
    }

    /**
     * Initialize the indexing system
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;
    }

    /**
     * Index a file with debouncing to handle rapid updates
     * Includes content change detection to optimize reindexing
     */
    async indexFile(file: TFile, content?: string): Promise<void> {
        // Clear any pending update for this file
        if (this.pendingUpdates.has(file.path)) {
            clearTimeout(this.pendingUpdates.get(file.path)!);
        }

        // Debounce the update
        this.pendingUpdates.set(file.path, setTimeout(async () => {
            try {
                const fileContent = content || await this.readFileContent(file);
                const newMetadata = this.extractMetadata(file, fileContent);

                // Check if content has actually changed to avoid unnecessary reindexing
                const shouldReindex = await this.shouldReindexFile(file.path, newMetadata);

                if (!shouldReindex) {
                    logger.debug(`Enhanced search: Skipping reindex of ${file.path} - content unchanged`);
                    this.pendingUpdates.delete(file.path);
                    return;
                }

                logger.debug(`Enhanced search: Reindexing ${file.path} due to content changes`);

                // Store content for persistence when enabled
                if (this.enableContentSearch) {
                    await this.contentStore.set(file.path, fileContent);
                }

                await this.searchIndex.addDocument(
                    file.path,
                    fileContent,
                    newMetadata,
                );

                // Update the last indexed time and content hash in persistence
                await this.updateIndexMetadata(file.path, newMetadata);

                this.pendingUpdates.delete(file.path);

                // Trigger debounced callback to notify about the indexing
                this.debounceCallback(file.path, 'modify');
            } catch (error) {
                logger.error(`Failed to index file ${file.path}:`, error);
                this.pendingUpdates.delete(file.path);
            }
        }, this.debounceMs));
    }

    /**
     * Remove a file from the index
     */
    async removeFile(filePath: string): Promise<void> {
        // Cancel any pending updates
        if (this.pendingUpdates.has(filePath)) {
            clearTimeout(this.pendingUpdates.get(filePath)!);
            this.pendingUpdates.delete(filePath);
        }

        try {
            // Remove from content store
            await this.contentStore.delete(filePath);

            // Remove from search index
            await this.searchIndex.removeDocument(filePath);
        } catch (error) {
            logger.error(`Failed to remove file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Handle file rename atomically to avoid duplicate entries
     */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        logger.debug(`Enhanced search: Handling file rename from ${oldPath} to ${newPath}`);

        // Cancel any pending updates for both paths
        if (this.pendingUpdates.has(oldPath)) {
            clearTimeout(this.pendingUpdates.get(oldPath)!);
            this.pendingUpdates.delete(oldPath);
        }
        if (this.pendingUpdates.has(newPath)) {
            clearTimeout(this.pendingUpdates.get(newPath)!);
            this.pendingUpdates.delete(newPath);
        }

        try {
            // First, get the new file to re-index it
            const newFile = this.getFileByPath?.(newPath);
            if (!newFile) {
                logger.warn(`Enhanced search: Could not find renamed file at ${newPath}`);
                // Just remove the old entry if we can't find the new one
                await this.removeFile(oldPath);
                return;
            }

            // Remove the old entry first
            await this.contentStore.delete(oldPath);
            await this.searchIndex.removeDocument(oldPath);

            // Index the file with its new path
            await this.indexFile(newFile);

            logger.debug(`Enhanced search: Successfully renamed file from ${oldPath} to ${newPath}`);
        } catch (error) {
            logger.error(`Enhanced search: Failed to rename file from ${oldPath} to ${newPath}:`, error);
            throw error;
        }
    }

    /**
     * Search the index
     */
    async search(query: string, limit = 50): Promise<SearchResult[]> {
        try {
            const results = await this.searchIndex.search(query, limit);

            return this.enhanceResultsWithUsage(results);
        } catch (error) {
            logger.error('Search failed:', error);
            return [];
        }
    }

    /**
     * Enhance search results with usage and recency data
     */
    private enhanceResultsWithUsage(results: SearchResult[]): SearchResult[] {
        return results.map((result) => {
            const usageScore = this.usageTracker.getUsageScore(result.id);
            const lastOpened = this.usageTracker.getLastOpened(result.id);

            return {
                ...result,
                usageScore,
                lastOpened,
                recencyScore: this.usageTracker.getRecencyScore(result.id),
            };
        });
    }

    /**
     * Get index statistics
     */
    async getStats(): Promise<any> {
        try {
            return this.searchIndex.getStats();
        } catch (error) {
            logger.error('Failed to get index stats:', error);
            return {
                documentCount: 0, indexSize: 0, lastUpdated: 0, version: 'unknown',
            };
        }
    }

    /**
     * Clear the entire index
     */
    async clearIndex(): Promise<void> {
        // Cancel all pending updates
        this.pendingUpdates.forEach((timeout) => clearTimeout(timeout));
        this.pendingUpdates.clear();

        try {
            await this.contentStore.clear();
            await this.searchIndex.clear();
        } catch (error) {
            logger.error('Failed to clear index:', error);
            throw error;
        }
    }

    /**
     * Read file content safely
     */
    private async readFileContent(file: TFile): Promise<string> {
        try {
            return await this.app.vault.read(file);
        } catch (error) {
            logger.error(`Enhanced search: Failed to read file ${file.path}:`, error);
            return '';
        }
    }

    /**
     * Extract metadata from file and content
     */
    private extractMetadata(file: TFile, content: string): FileMetadata {
        const cache = this.app.metadataCache.getFileCache(file);

        return {
            path: file.path,
            title: this.extractTitle(content) || file.basename,
            headings: cache?.headings?.map((h) => ({ heading: h.heading, level: h.level })) || [],
            frontmatter: cache?.frontmatter || {},
            tags: cache?.tags?.map((t) => t.tag) || [],
            aliases: this.normalizeAliases(cache?.frontmatter?.aliases),
            links: cache?.links?.map((l) => l.link) || [],
            size: file.stat.size,
            lastModified: file.stat.mtime,
            contentHash: generateContentHashBase36(content),
        };
    }

    /**
     * Extract title from content (simple implementation)
     */
    private extractTitle(content: string): string | undefined {
        // Look for # title or frontmatter title
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
            return titleMatch[1].trim();
        }

        const frontmatterMatch = content.match(/^---\s*\n(?:.*\n)*?title:\s*(.+)\n(?:.*\n)*?---/m);
        if (frontmatterMatch) {
            return frontmatterMatch[1].trim().replace(/['"]/g, '');
        }

        return undefined;
    }

    /**
     * Schedule a file update with debouncing
     * Ensures proper handling of file edits and modifications
     */
    async scheduleFileUpdate(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        logger.debug(`Enhanced search: Scheduling ${operation} operation for ${filePath}`);

        // For file modifications (edits), ensure we mark it for reindexing
        if (operation === 'modify') {
            // Get the actual TFile object to trigger proper reindexing
            const file = this.getFileByPath?.(filePath);
            if (file) {
                await this.indexFile(file);
                return;
            }
        }

        // For other operations or if we can't get the file object, use the callback
        this.debounceCallback(filePath, operation);
    }

    /**
     * Set a reference to the file getter function for accessing TFile objects
     */
    setFileGetter(getFileByPath: (path: string) => TFile | null): void {
        this.getFileByPath = getFileByPath;
    }

    /**
     * Shutdown the coordinator and cleanup resources
     */
    async shutdown(): Promise<void> {
        // Clear all pending updates
        for (const timeout of this.pendingUpdates.values()) {
            clearTimeout(timeout);
        }
        this.pendingUpdates.clear();

        this.isInitialized = false;
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        // Cancel all pending updates
        this.pendingUpdates.forEach((timeout) => clearTimeout(timeout));
        this.pendingUpdates.clear();
    }

    /**
     * Check if a file should be reindexed based on content changes
     */
    private async shouldReindexFile(filePath: string, newMetadata: FileMetadata): Promise<boolean> {
        try {
            // Check if we have existing metadata stored
            const existingMetadata = await this.persistence.getMetadata?.(filePath);

            if (!existingMetadata) {
                // No existing metadata means this is a new file or hasn't been indexed yet
                return true;
            }

            // Compare content hashes to detect changes
            if (existingMetadata.contentHash !== newMetadata.contentHash) {
                logger.debug(`Enhanced search: Content hash changed for ${filePath}`);
                return true;
            }

            // Compare last modified times
            if (existingMetadata.lastModified !== newMetadata.lastModified) {
                logger.debug(`Enhanced search: Last modified time changed for ${filePath}`);
                return true;
            }

            // Compare file sizes
            if (existingMetadata.size !== newMetadata.size) {
                logger.debug(`Enhanced search: File size changed for ${filePath}`);
                return true;
            }

            return false;
        } catch (error) {
            logger.warn(`Enhanced search: Error checking if file should be reindexed ${filePath}:`, error);
            // If we can't determine, err on the side of reindexing
            return true;
        }
    }

    /**
     * Update metadata in persistence after successful indexing
     */
    private async updateIndexMetadata(filePath: string, metadata: FileMetadata): Promise<void> {
        try {
            if (this.persistence.setMetadata) {
                const indexedMetadata = {
                    ...metadata,
                    indexedAt: Date.now(),
                };
                await this.persistence.setMetadata(filePath, indexedMetadata);
            }
        } catch (error) {
            logger.warn(`Enhanced search: Failed to update index metadata for ${filePath}:`, error);
        }
    }

    /**
     * Force reindexing of a file, bypassing content change detection
     */
    async forceReindexFile(file: TFile, content?: string): Promise<void> {
        // Clear any pending update for this file
        if (this.pendingUpdates.has(file.path)) {
            clearTimeout(this.pendingUpdates.get(file.path)!);
        }

        try {
            const fileContent = content || await this.readFileContent(file);
            const metadata = this.extractMetadata(file, fileContent);

            logger.debug(`Enhanced search: Force reindexing ${file.path}`);

            // Store content for persistence when enabled
            if (this.enableContentSearch) {
                await this.contentStore.set(file.path, fileContent);
            }

            // Send to worker for indexing
            await this.searchIndex.addDocument(file.path, fileContent, metadata);

            // Update the last indexed time and content hash in persistence
            await this.updateIndexMetadata(file.path, metadata);

            // Trigger debounced callback to notify about the indexing
            this.debounceCallback(file.path, 'modify');
        } catch (error) {
            logger.error(`Failed to force reindex file ${file.path}:`, error);
            throw error;
        }
    }

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

    private async handleFileChange(file: TFile, changeType: 'create' | 'modify' | 'delete'): Promise<void> {
        if (!this.shouldReindexFile(file.path, this.extractMetadata(file, await this.readFileContent(file)))) {
            return;
        }

        try {
            // Get current content for comparison
            const currentContent = changeType === 'delete' ? '' : await this.readFileContent(file);
            const contentHash = generateContentHashBase36(currentContent);

            // Check if content actually changed
            const existingMetadata = await this.persistence.getMetadata?.(file.path);
            if (existingMetadata && existingMetadata.contentHash === contentHash) {
                logger.debug(`Enhanced search: Skipping reindex of ${file.path} - content unchanged`);
                return;
            }

            logger.debug(`Enhanced search: Reindexing ${file.path} due to content changes`);

            // Perform the indexing operation
            switch (changeType) {
                case 'create':
                case 'modify':
                    await this.indexFile(file, currentContent);
                    break;
                case 'delete':
                    await this.removeFile(file.path);
                    break;
            }
        } catch (error) {
            logger.error(`Enhanced search: Failed to handle file change for ${file.path}:`, error);
        }
    }
}
