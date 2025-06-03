import { TFile } from 'obsidian';
import { ContentStore, SearchIndex, UsageTracker, FileMetadata, SearchResult, WorkerMessage, WorkerResponse } from './interfaces';

/**
 * Coordinates background indexing of files using web workers
 * Handles debouncing, error recovery, and performance monitoring
 */
export class IndexingCoordinator {
    private worker: Worker;
    private searchIndex: SearchIndex;
    private contentStore: ContentStore;
    private usageTracker: UsageTracker;
    private persistence: any;
    private debounceCallback: (filePath: string, operation: string) => void;
    private pendingUpdates = new Map<string, NodeJS.Timeout>();
    private pendingRequests = new Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }>();
    private isInitialized = false;
    private debounceMs: number;
    private requestTimeout: number;
    private getFileByPath?: (path: string) => TFile | null;

    constructor(
        searchIndex: SearchIndex,
        contentStore: ContentStore,
        usageTracker: UsageTracker,
        persistence: any,
        debounceCallback: (filePath: string, operation: string) => void,
        debounceMs = 500,
        requestTimeout = 5000
    ) {
        this.searchIndex = searchIndex;
        this.contentStore = contentStore;
        this.usageTracker = usageTracker;
        this.persistence = persistence;
        this.debounceCallback = debounceCallback;
        this.debounceMs = debounceMs;
        this.requestTimeout = requestTimeout;
    }

    /**
     * Initialize the indexing system
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            // Test worker communication
            await this.sendWorkerMessage({ type: 'GET_STATS', payload: {} });
            this.isInitialized = true;
        } catch (error) {
            console.error('Failed to initialize indexing coordinator:', error);
            throw error;
        }
    }

    /**
     * Setup event handlers for worker communication
     */
    private setupEventHandlers(): void {
        this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
            this.handleWorkerMessage(event.data);
        };

        this.worker.onerror = (error: ErrorEvent) => {
            console.error('Worker error:', error);
            this.rejectAllPendingRequests(new Error(`Worker error: ${error.message}`));
        };

        // Handle worker termination
        this.worker.addEventListener('error', () => {
            this.rejectAllPendingRequests(new Error('Worker terminated unexpectedly'));
        });
    }

    /**
     * Handle messages from the worker
     */
    private handleWorkerMessage(response: WorkerResponse): void {
        if (response.requestId) {
            const pending = this.pendingRequests.get(response.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                this.pendingRequests.delete(response.requestId);

                if (response.type === 'ERROR') {
                    pending.reject(new Error(response.payload.message || 'Unknown worker error'));
                } else {
                    pending.resolve(response.payload);
                }
            }
        }
    }

    /**
     * Send a message to the worker and wait for response
     */
    private async sendWorkerMessage(message: WorkerMessage): Promise<any> {
        if (!this.isInitialized && message.type !== 'GET_STATS') {
            throw new Error('IndexingCoordinator not initialized');
        }

        const requestId = this.generateRequestId();
        const messageWithId: WorkerMessage = { ...message, requestId };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Worker request timeout after ${this.requestTimeout}ms`));
            }, this.requestTimeout);

            this.pendingRequests.set(requestId, { resolve, reject, timeout });
            this.worker.postMessage(messageWithId);
        });
    }

    /**
     * Generate a unique request ID
     */
    private generateRequestId(): string {
        return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
                    console.log(`Enhanced search: Skipping reindex of ${file.path} - content unchanged`);
                    this.pendingUpdates.delete(file.path);
                    return;
                }

                console.log(`Enhanced search: Reindexing ${file.path} due to content changes`);

                // Store content for persistence
                await this.contentStore.set(file.path, fileContent);

                // Send to worker for indexing
                await this.sendWorkerMessage({
                    type: 'INDEX_FILE',
                    payload: { id: file.path, content: fileContent, metadata: newMetadata }
                });

                // Update the last indexed time and content hash in persistence
                await this.updateIndexMetadata(file.path, newMetadata);

                this.pendingUpdates.delete(file.path);
                
                // Trigger debounced callback to notify about the indexing
                this.debounceCallback(file.path, 'modify');
            } catch (error) {
                console.error(`Failed to index file ${file.path}:`, error);
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
            await this.sendWorkerMessage({
                type: 'REMOVE_FILE',
                payload: { id: filePath }
            });
        } catch (error) {
            console.error(`Failed to remove file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Search the index
     */
    async search(query: string, limit = 50): Promise<SearchResult[]> {
        try {
            const results = await this.sendWorkerMessage({
                type: 'SEARCH',
                payload: { query, limit }
            });

            // Enhance results with usage data
            return this.enhanceResultsWithUsage(results, query);
        } catch (error) {
            console.error('Search failed:', error);
            return [];
        }
    }

    /**
     * Enhance search results with usage and recency data
     */
    private enhanceResultsWithUsage(results: SearchResult[], query: string): SearchResult[] {
        return results.map(result => {
            const usageScore = this.usageTracker.getUsageScore(result.id);
            const lastOpened = this.usageTracker.getLastOpened(result.id);
            
            return {
                ...result,
                usageScore,
                lastOpened,
                recencyScore: this.usageTracker.getRecencyScore(result.id)
            };
        });
    }

    /**
     * Get index statistics
     */
    async getStats(): Promise<any> {
        try {
            return await this.sendWorkerMessage({
                type: 'GET_STATS',
                payload: {}
            });
        } catch (error) {
            console.error('Failed to get index stats:', error);
            return { documentCount: 0, indexSize: 0, lastUpdated: 0, version: 'unknown' };
        }
    }

    /**
     * Clear the entire index
     */
    async clearIndex(): Promise<void> {
        // Cancel all pending updates
        this.pendingUpdates.forEach(timeout => clearTimeout(timeout));
        this.pendingUpdates.clear();

        try {
            await this.contentStore.clear();
            await this.sendWorkerMessage({
                type: 'CLEAR_INDEX',
                payload: {}
            });
        } catch (error) {
            console.error('Failed to clear index:', error);
            throw error;
        }
    }

    /**
     * Read file content safely
     */
    private async readFileContent(file: TFile): Promise<string> {
        // In a real Obsidian plugin, this would use app.vault.read(file)
        // For now, we'll return a placeholder
        return `Content of ${file.path}`;
    }

    /**
     * Extract metadata from file and content
     */
    private extractMetadata(file: TFile, content: string): FileMetadata {
        // This would extract frontmatter, headings, links, etc.
        // For now, return basic metadata
        return {
            path: file.path,
            title: this.extractTitle(content) || file.basename,
            lastModified: file.stat?.mtime || Date.now(),
            size: file.stat?.size || content.length,
            contentHash: this.simpleHash(content)
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
     * Simple hash function for content
     */
    private simpleHash(content: string): string {
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString(16);
    }

    /**
     * Reject all pending requests (cleanup)
     */
    private rejectAllPendingRequests(error: Error): void {
        this.pendingRequests.forEach(pending => {
            clearTimeout(pending.timeout);
            pending.reject(error);
        });
        this.pendingRequests.clear();
    }

    /**
     * Schedule a file update with debouncing
     * Ensures proper handling of file edits and modifications
     */
    async scheduleFileUpdate(filePath: string, operation: 'create' | 'modify' | 'delete'): Promise<void> {
        console.log(`Enhanced search: Scheduling ${operation} operation for ${filePath}`);
        
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

        // Clear all pending requests
        for (const request of this.pendingRequests.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Coordinator is shutting down'));
        }
        this.pendingRequests.clear();

        this.isInitialized = false;
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        // Cancel all pending updates
        this.pendingUpdates.forEach(timeout => clearTimeout(timeout));
        this.pendingUpdates.clear();

        // Reject all pending requests
        this.rejectAllPendingRequests(new Error('IndexingCoordinator destroyed'));

        // Terminate worker
        this.worker.terminate();
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
                console.log(`Enhanced search: Content hash changed for ${filePath}`);
                return true;
            }

            // Compare last modified times
            if (existingMetadata.lastModified !== newMetadata.lastModified) {
                console.log(`Enhanced search: Last modified time changed for ${filePath}`);
                return true;
            }

            // Compare file sizes
            if (existingMetadata.size !== newMetadata.size) {
                console.log(`Enhanced search: File size changed for ${filePath}`);
                return true;
            }

            return false;
        } catch (error) {
            console.warn(`Enhanced search: Error checking if file should be reindexed ${filePath}:`, error);
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
                    indexedAt: Date.now()
                };
                await this.persistence.setMetadata(filePath, indexedMetadata);
            }
        } catch (error) {
            console.warn(`Enhanced search: Failed to update index metadata for ${filePath}:`, error);
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

            console.log(`Enhanced search: Force reindexing ${file.path}`);

            // Store content for persistence
            await this.contentStore.set(file.path, fileContent);

            // Send to worker for indexing
            await this.sendWorkerMessage({
                type: 'INDEX_FILE',
                payload: { id: file.path, content: fileContent, metadata }
            });

            // Update the last indexed time and content hash in persistence
            await this.updateIndexMetadata(file.path, metadata);

            // Trigger debounced callback to notify about the indexing
            this.debounceCallback(file.path, 'modify');
        } catch (error) {
            console.error(`Failed to force reindex file ${file.path}:`, error);
            throw error;
        }
    }
}
