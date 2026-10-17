/**
 * IndexedDB persistence for semantic embeddings.
 *
 * Each vault gets its own database (see getVaultScopedName). Older plugin
 * versions used one shared database for every vault; that legacy database is
 * only read (for one-time migration) and never deleted automatically, because
 * other vaults may still need to migrate from it. Users can delete it explicitly
 * (deleteLegacyEmbeddingDatabase).
 */

import { FileEmbeddingData } from './types';
import { logger } from '../../utils/logger';
import { DatabaseDeleteOutcome, deleteIndexedDatabase } from '../../utils/indexed-db';

export const LEGACY_EMBEDDING_DB_NAME = 'better-command-palette-embeddings';

const EMBEDDINGS_STORE = 'embeddings';
const METADATA_STORE = 'metadata';
const METADATA_KEY = '__metadata__';
const MIGRATION_KEY = '__migration__';
const DB_VERSION = 1;

export interface StoredEmbeddingRecord extends FileEmbeddingData {
    id: string;
    model: string;
    dimension?: number;
    /** Embedding input scheme (e.g. task prefixes). Missing on records written before it existed. */
    scheme?: string;
    updatedAt: number;
}

export interface EmbeddingStoreMetadata {
    id: string;
    version: string;
    lastUpdated: number;
    model: string;
    dimension?: number;
    scheme?: string;
}

function requestToPromise<T>(request: IDBRequest<T>, errorMessage: string): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(`${errorMessage}: ${request.error?.message || 'Unknown error'}`));
    });
}

function transactionToPromise(transaction: IDBTransaction, errorMessage: string): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error(`${errorMessage}: ${transaction.error?.message || 'Unknown error'}`));
        transaction.onabort = () => reject(new Error(`${errorMessage}: ${transaction.error?.message || 'Transaction aborted'}`));
    });
}

/**
 * Open an existing database read-only style without creating it.
 * Resolves null if the database does not exist or cannot be opened.
 */
function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.open(name);
        } catch {
            resolve(null);
            return;
        }

        request.onupgradeneeded = (event) => {
            // oldVersion 0 means the database did not exist; abort so we do not create it.
            if (event.oldVersion === 0) {
                request.transaction?.abort();
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
                db.close();
                resolve(null);
                return;
            }
            resolve(db);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

/**
 * Read every record from the legacy shared database, if it exists.
 * The legacy database is left untouched.
 */
export async function readLegacyEmbeddingRecords(): Promise<StoredEmbeddingRecord[] | null> {
    const db = await openExistingDatabase(LEGACY_EMBEDDING_DB_NAME);
    if (!db) {
        return null;
    }

    try {
        const transaction = db.transaction([EMBEDDINGS_STORE], 'readonly');
        const records = await requestToPromise<StoredEmbeddingRecord[]>(
            transaction.objectStore(EMBEDDINGS_STORE).getAll(),
            'Failed to read legacy embedding records',
        );
        return records || [];
    } catch (error) {
        logger.warn('Semantic search: Failed to read legacy embedding database:', error);
        return null;
    } finally {
        db.close();
    }
}

/**
 * Delete the legacy shared (un-scoped) database. Vaults that have not migrated yet
 * lose their migration source and re-embed from scratch.
 */
export function deleteLegacyEmbeddingDatabase(): Promise<DatabaseDeleteOutcome> {
    return deleteIndexedDatabase(LEGACY_EMBEDDING_DB_NAME);
}

export class EmbeddingIndexedDbStore {
    private readonly dbName: string;

    private db: IDBDatabase | null = null;

    private isInitialized = false;

    constructor(dbName: string) {
        this.dbName = dbName;
    }

    getName(): string {
        return this.dbName;
    }

    async initialize(): Promise<boolean> {
        if (this.isInitialized) {
            return true;
        }

        if (typeof indexedDB === 'undefined') {
            return false;
        }

        return new Promise((resolve) => {
            const request = indexedDB.open(this.dbName, DB_VERSION);

            request.onerror = () => {
                logger.warn(`Semantic search: Failed to open embedding IndexedDB: ${request.error?.message || 'Unknown error'}`);
                resolve(false);
            };

            request.onsuccess = () => {
                this.db = request.result;
                this.isInitialized = true;
                resolve(true);
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
                    db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(METADATA_STORE)) {
                    db.createObjectStore(METADATA_STORE, { keyPath: 'id' });
                }
            };
        });
    }

    async loadAll(): Promise<StoredEmbeddingRecord[]> {
        if (!this.db) {
            return [];
        }

        const transaction = this.db.transaction([EMBEDDINGS_STORE], 'readonly');
        const records = await requestToPromise<StoredEmbeddingRecord[]>(
            transaction.objectStore(EMBEDDINGS_STORE).getAll(),
            'Failed to load embedding records',
        );
        return records || [];
    }

    async saveFile(path: string, data: FileEmbeddingData, model: string, dimension?: number, scheme?: string): Promise<void> {
        if (!this.db) {
            return;
        }

        const record: StoredEmbeddingRecord = {
            id: path,
            ...data,
            model,
            dimension,
            scheme,
            updatedAt: Date.now(),
        };
        const transaction = this.db.transaction([EMBEDDINGS_STORE], 'readwrite');
        await requestToPromise(
            transaction.objectStore(EMBEDDINGS_STORE).put(record),
            `Failed to save embedding record for ${path}`,
        );
    }

    /** Write many records in one transaction (used by migration). */
    async saveRecords(records: StoredEmbeddingRecord[]): Promise<void> {
        if (!this.db || records.length === 0) {
            return;
        }

        const transaction = this.db.transaction([EMBEDDINGS_STORE], 'readwrite');
        const store = transaction.objectStore(EMBEDDINGS_STORE);
        records.forEach((record) => store.put(record));
        await transactionToPromise(transaction, 'Failed to save embedding records');
    }

    async deleteFile(path: string): Promise<void> {
        if (!this.db) {
            return;
        }

        const transaction = this.db.transaction([EMBEDDINGS_STORE], 'readwrite');
        await requestToPromise(
            transaction.objectStore(EMBEDDINGS_STORE).delete(path),
            `Failed to delete embedding record for ${path}`,
        );
    }

    async loadMetadata(): Promise<EmbeddingStoreMetadata | undefined> {
        if (!this.db) {
            return undefined;
        }

        const transaction = this.db.transaction([METADATA_STORE], 'readonly');
        return requestToPromise<EmbeddingStoreMetadata | undefined>(
            transaction.objectStore(METADATA_STORE).get(METADATA_KEY),
            'Failed to load embedding metadata',
        );
    }

    async saveMetadata(metadata: Omit<EmbeddingStoreMetadata, 'id'>): Promise<void> {
        if (!this.db) {
            return;
        }

        const transaction = this.db.transaction([METADATA_STORE], 'readwrite');
        await requestToPromise(
            transaction.objectStore(METADATA_STORE).put({ id: METADATA_KEY, ...metadata }),
            'Failed to save embedding metadata',
        );
    }

    async hasMigrationMarker(): Promise<boolean> {
        if (!this.db) {
            return false;
        }

        const transaction = this.db.transaction([METADATA_STORE], 'readonly');
        const marker = await requestToPromise(
            transaction.objectStore(METADATA_STORE).get(MIGRATION_KEY),
            'Failed to read embedding migration marker',
        );
        return marker !== undefined;
    }

    async setMigrationMarker(migratedCount: number): Promise<void> {
        if (!this.db) {
            return;
        }

        const transaction = this.db.transaction([METADATA_STORE], 'readwrite');
        await requestToPromise(
            transaction.objectStore(METADATA_STORE).put({ id: MIGRATION_KEY, migratedAt: Date.now(), migratedCount }),
            'Failed to save embedding migration marker',
        );
    }

    /**
     * Remove all embeddings and the cache metadata. The migration marker is kept
     * so a deliberately cleared cache is not re-populated from the legacy database.
     */
    async clear(): Promise<void> {
        if (!this.db) {
            return;
        }

        const transaction = this.db.transaction([EMBEDDINGS_STORE, METADATA_STORE], 'readwrite');
        transaction.objectStore(EMBEDDINGS_STORE).clear();
        transaction.objectStore(METADATA_STORE).delete(METADATA_KEY);
        await transactionToPromise(transaction, 'Failed to clear embedding store');
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.isInitialized = false;
    }
}
