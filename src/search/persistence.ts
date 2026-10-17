import { App } from 'obsidian';
import { ContentStore } from './interfaces';
import { logger } from '../utils/logger';
import { getVaultScopedName } from '../utils/vault-storage';

/** Base IndexedDB name; scoped per vault via {@link IndexPersistence.getDatabaseName}. */
export const INDEX_DB_BASE_NAME = 'better-command-palette-index';

/**
 * Version of the persisted search index format. Bump whenever tokenization,
 * indexed fields, content limits or the serialized shape change so stale
 * caches are discarded instead of silently reused.
 *
 * 2: vault-scoped DB, larger indexed content cap, tokenizer changes.
 */
export const SEARCH_INDEX_SCHEMA_VERSION = 2;

export type LoadedSearchIndex =
    | { status: 'missing' }
    | { status: 'incompatible'; reason: string }
    | { status: 'ok'; data: any; savedAt: number };

/**
 * IndexedDB-based persistence layer for content storage
 * Provides reliable, client-side storage for indexed content
 */
export class IndexPersistence implements ContentStore {
    private dbName: string;

    private dbVersion = 1;

    private db: IDBDatabase | null = null;

    private isInitialized = false;

    /**
     * @param app When provided, the database name is scoped to the current vault.
     */
    constructor(app?: App) {
        this.dbName = IndexPersistence.getDatabaseName(app);
    }

    /**
     * Resolve the IndexedDB name, scoped to the vault when an App is available.
     */
    static getDatabaseName(app?: App): string {
        return app ? getVaultScopedName(app, INDEX_DB_BASE_NAME) : INDEX_DB_BASE_NAME;
    }

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
                const { result } = request;
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
                compressed: false, // Could implement compression in the future
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
                timestamp: Date.now(),
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
                lastUpdated: Date.now(),
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
     * Load the serialized search index data.
     * Caches written with a different schema version or compatibility key
     * are reported as incompatible so callers can discard them.
     */
    async loadSearchIndex(expectedCompatibilityKey?: string): Promise<LoadedSearchIndex> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readonly');
            const store = transaction.objectStore('index_metadata');
            const request = store.get('__search_index__');

            request.onsuccess = () => {
                const record = request.result;
                if (!record || !record.data) {
                    resolve({ status: 'missing' });
                    return;
                }

                if (record.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION) {
                    resolve({
                        status: 'incompatible',
                        reason: `schema version ${String(record.schemaVersion ?? 'none')} != ${SEARCH_INDEX_SCHEMA_VERSION}`,
                    });
                    return;
                }

                if (expectedCompatibilityKey !== undefined
                    && record.compatibilityKey !== expectedCompatibilityKey) {
                    resolve({ status: 'incompatible', reason: 'index options changed' });
                    return;
                }

                resolve({ status: 'ok', data: record.data, savedAt: Number(record.timestamp) || 0 });
            };

            request.onerror = () => {
                reject(new Error(`Failed to load search index: ${request.error?.message}`));
            };
        });
    }

    /**
     * Save the serialized search index data
     */
    async saveSearchIndex(indexData: any, compatibilityKey?: string): Promise<void> {
        this.ensureInitialized();

        return new Promise((resolve, reject) => {
            const transaction = this.db!.transaction(['index_metadata'], 'readwrite');
            const store = transaction.objectStore('index_metadata');

            const data = {
                id: '__search_index__',
                data: indexData,
                schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
                compatibilityKey,
                timestamp: Date.now(),
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
     * Delete the entire database. Pass the App to target the current vault's
     * database, or an explicit name (defaults to the legacy un-scoped name).
     */
    static async deleteDatabase(target: App | string = INDEX_DB_BASE_NAME): Promise<void> {
        const dbName = typeof target === 'string' ? target : IndexPersistence.getDatabaseName(target);
        return new Promise((resolve, reject) => {
            const deleteRequest = indexedDB.deleteDatabase(dbName);

            deleteRequest.onsuccess = () => {
                resolve();
            };

            deleteRequest.onerror = () => {
                reject(new Error(`Failed to delete database: ${deleteRequest.error?.message}`));
            };

            deleteRequest.onblocked = () => {
                logger.warn('Database deletion blocked. Close all tabs using this database.');
            };
        });
    }

    private async handleDatabaseBlocked(): Promise<void> {
        logger.warn('Database deletion blocked. Close all tabs using this database.');
        // Handle the blocked deletion - could show user notification
        // For now, we'll just log and continue
    }
}
