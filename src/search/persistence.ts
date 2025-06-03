import { ContentStore } from './interfaces';

/**
 * IndexedDB-based persistence layer for content storage
 * Provides reliable, client-side storage for indexed content
 */
export class IndexPersistence implements ContentStore {
    private dbName = 'better-command-palette-index';
    private dbVersion = 1;
    private db: IDBDatabase | null = null;
    private isInitialized = false;

    /**
     * Initialize the IndexedDB database
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = () => {
                reject(new Error(`Failed to open IndexedDB: ${request.error?.message || 'Unknown error'}`));
            };
            
            request.onsuccess = () => {
                this.db = request.result;
                this.isInitialized = true;
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                this.createObjectStores(db);
            };
        });
    }

    /**
     * Create object stores during database upgrade
     */
    private createObjectStores(db: IDBDatabase): void {
        // Content store for file content
        if (!db.objectStoreNames.contains('content')) {
            const contentStore = db.createObjectStore('content', { keyPath: 'id' });
            contentStore.createIndex('timestamp', 'timestamp');
            contentStore.createIndex('size', 'size');
        }

        // Index metadata store
        if (!db.objectStoreNames.contains('index_metadata')) {
            const indexStore = db.createObjectStore('index_metadata', { keyPath: 'id' });
            indexStore.createIndex('lastModified', 'lastModified');
            indexStore.createIndex('contentHash', 'contentHash');
        }

        // Usage statistics store
        if (!db.objectStoreNames.contains('usage_stats')) {
            const usageStore = db.createObjectStore('usage_stats', { keyPath: 'id' });
            usageStore.createIndex('lastAccessed', 'lastAccessed');
            usageStore.createIndex('accessCount', 'accessCount');
        }
    }

    /**
     * Ensure database is initialized before operations
     */
    private ensureInitialized(): void {
        if (!this.isInitialized || !this.db) {
            throw new Error('IndexPersistence not initialized. Call initialize() first.');
        }
    }

    /**
     * Get content for a file
     */
    async get(fileId: string): Promise<string> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['content'], 'readonly');
            const store = transaction.objectStore('content');
            const request = store.get(fileId);
            
            request.onsuccess = () => {
                const result = request.result;
                resolve(result?.content || '');
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to get content for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Store content for a file
     */
    async set(fileId: string, content: string): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['content'], 'readwrite');
            const store = transaction.objectStore('content');
            
            const data = {
                id: fileId,
                content,
                timestamp: Date.now(),
                size: content.length,
                compressed: false // Could implement compression in the future
            };
            
            const request = store.put(data);
            
            request.onsuccess = () => {
                resolve();
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to store content for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Delete content for a file
     */
    async delete(fileId: string): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['content', 'index_metadata', 'usage_stats'], 'readwrite');
            
            // Delete from all stores
            const contentStore = transaction.objectStore('content');
            const metadataStore = transaction.objectStore('index_metadata');
            const usageStore = transaction.objectStore('usage_stats');
            
            const deleteContent = contentStore.delete(fileId);
            const deleteMetadata = metadataStore.delete(fileId);
            const deleteUsage = usageStore.delete(fileId);
            
            transaction.oncomplete = () => {
                resolve();
            };
            
            transaction.onerror = () => {
                reject(new Error(`Failed to delete ${fileId}: ${transaction.error?.message}`));
            };
        });
    }

    /**
     * Clear all stored content
     */
    async clear(): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['content', 'index_metadata', 'usage_stats'], 'readwrite');
            
            const clearContent = transaction.objectStore('content').clear();
            const clearMetadata = transaction.objectStore('index_metadata').clear();
            const clearUsage = transaction.objectStore('usage_stats').clear();
            
            transaction.oncomplete = () => {
                resolve();
            };
            
            transaction.onerror = () => {
                reject(new Error(`Failed to clear stores: ${transaction.error?.message}`));
            };
        });
    }

    /**
     * Get storage statistics
     */
    async getStats(): Promise<{ count: number; size: number }> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['content'], 'readonly');
            const store = transaction.objectStore('content');
            const cursor = store.openCursor();
            
            let count = 0;
            let totalSize = 0;
            
            cursor.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                
                if (cursor) {
                    count++;
                    totalSize += cursor.value.size || 0;
                    cursor.continue();
                } else {
                    resolve({ count, size: totalSize });
                }
            };
            
            cursor.onerror = () => {
                reject(new Error(`Failed to get stats: ${cursor.error?.message}`));
            };
        });
    }

    /**
     * Store index metadata
     */
    async setMetadata(fileId: string, metadata: any): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readwrite');
            const store = transaction.objectStore('index_metadata');
            
            const data = {
                id: fileId,
                ...metadata,
                timestamp: Date.now()
            };
            
            const request = store.put(data);
            
            request.onsuccess = () => {
                resolve();
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to store metadata for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Get index metadata
     */
    async getMetadata(fileId: string): Promise<any> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readonly');
            const store = transaction.objectStore('index_metadata');
            const request = store.get(fileId);
            
            request.onsuccess = () => {
                resolve(request.result || null);
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to get metadata for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Store usage statistics
     */
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['usage_stats'], 'readwrite');
            const store = transaction.objectStore('usage_stats');
            
            const data = {
                id: fileId,
                ...stats,
                lastUpdated: Date.now()
            };
            
            const request = store.put(data);
            
            request.onsuccess = () => {
                resolve();
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to store usage stats for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Get usage statistics
     */
    async getUsageStats(fileId: string): Promise<any> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['usage_stats'], 'readonly');
            const store = transaction.objectStore('usage_stats');
            const request = store.get(fileId);
            
            request.onsuccess = () => {
                resolve(request.result || null);
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to get usage stats for ${fileId}: ${request.error?.message}`));
            };
        });
    }

    /**
     * Get all usage statistics
     */
    async getAllUsageStats(): Promise<Record<string, any>> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['usage_stats'], 'readonly');
            const store = transaction.objectStore('usage_stats');
            const cursor = store.openCursor();
            
            const results: Record<string, any> = {};
            
            cursor.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest).result;
                
                if (cursor) {
                    results[cursor.value.id] = cursor.value;
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            
            cursor.onerror = () => {
                reject(new Error(`Failed to get all usage stats: ${cursor.error?.message}`));
            };
        });
    }

    /**
     * Load the serialized search index data
     */
    async loadSearchIndex(): Promise<any> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readonly');
            const store = transaction.objectStore('index_metadata');
            const request = store.get('__search_index__');
            
            request.onsuccess = () => {
                resolve(request.result?.data || null);
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to load search index: ${request.error?.message}`));
            };
        });
    }

    /**
     * Save the serialized search index data
     */
    async saveSearchIndex(indexData: any): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readwrite');
            const store = transaction.objectStore('index_metadata');
            
            const data = {
                id: '__search_index__',
                data: indexData,
                timestamp: Date.now()
            };
            
            const request = store.put(data);
            
            request.onsuccess = () => {
                resolve();
            };
            
            request.onerror = () => {
                reject(new Error(`Failed to save search index: ${request.error?.message}`));
            };
        });
    }

    /**
     * Close the database connection
     */
    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
            this.isInitialized = false;
        }
    }

    /**
     * Delete the entire database
     */
    static async deleteDatabase(dbName = 'better-command-palette-index'): Promise<void> {
        return new Promise((resolve, reject) => {
            const deleteRequest = indexedDB.deleteDatabase(dbName);
            
            deleteRequest.onsuccess = () => {
                resolve();
            };
            
            deleteRequest.onerror = () => {
                reject(new Error(`Failed to delete database: ${deleteRequest.error?.message}`));
            };
            
            deleteRequest.onblocked = () => {
                console.warn('Database deletion blocked. Close all tabs using this database.');
            };
        });
    }
}
