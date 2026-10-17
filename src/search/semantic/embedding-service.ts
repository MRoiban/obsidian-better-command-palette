/**
 * Embedding service for generating and managing document embeddings.
 * Vectors come from an EmbeddingProvider (in-plugin local model or Ollama);
 * this service owns chunking, normalization, dimension tracking and caching.
 *
 * Version 2.0: Stores embeddings per-chunk instead of per-file for better semantic search
 */

import {
    App, TFile, Vault, MetadataCache,
} from 'obsidian';
import { RequestQueue } from './request-queue';
import { ChunkEmbedding, EmbeddingCache, SemanticSearchSettings } from './types';
import {
    EmbeddingIndexedDbStore, EmbeddingStoreMetadata, LEGACY_EMBEDDING_DB_NAME, StoredEmbeddingRecord,
    readLegacyEmbeddingRecords,
} from './embedding-store';
import {
    EmbeddingFingerprint, fingerprintKey, getSettingsFingerprint, isFingerprintCompatible, resolveEmbeddingModel,
} from './embedding-fingerprint';
import { NonRetryableEmbeddingError } from './http-utils';
import {
    EmbeddingKind, EmbeddingProvider, ProviderAvailability, ProviderStatus, ProviderStatusListener,
} from './providers/types';
import {
    EmbeddingProviderContext, createEmbeddingProvider, getProviderConfigKey,
} from './providers/provider-factory';
import { createAbortError, isAbortError, throwIfAborted } from './providers/abort-utils';
import { logger } from '../../utils/logger';
import { generateContentHashBase36 } from '../../utils/hash';
import { getVaultScopedName } from '../../utils/vault-storage';

/**
 * Runtime representation of a chunk embedding using Float32Array for performance
 */
export interface ChunkEmbeddingRuntime {
    embedding: Float32Array;
    text: string;
    startLine?: number;
}

interface EmbeddingRequestOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

export type EmbeddingProviderFactory = (
    settings: SemanticSearchSettings,
    context: EmbeddingProviderContext,
) => EmbeddingProvider;

export interface EmbeddingServiceOptions {
    /** Vault-relative plugin folder (manifest.dir); holds bundled runtime assets. */
    pluginDir?: string;
    /** Override provider construction (tests, tooling). */
    providerFactory?: EmbeddingProviderFactory;
}

interface SemanticIndexingOptions {
    signal?: AbortSignal;
}

/**
 * Outcome of indexing a single file.
 * - indexed: new vectors were generated
 * - unchanged: existing vectors are still valid (metadata may have been refreshed)
 * - skipped: nothing stored (excluded, empty, failed, or invalidated mid-flight)
 */
export type IndexFileResult = 'indexed' | 'unchanged' | 'skipped';

const CACHE_FORMAT_VERSION = '2.0.0';
const DEFAULT_SAVE_DEBOUNCE_MS = 2000;

export class EmbeddingService {
    private vault: Vault;

    private metadataCache: MetadataCache;

    private settings: SemanticSearchSettings;

    private requestQueue: RequestQueue;

    /**
     * Per-file chunk embeddings for semantic search
     * Key: file path, Value: array of chunk embeddings with text context
     */
    private chunkEmbeddingsCache: Map<string, ChunkEmbeddingRuntime[]> = new Map();

    private fileCentroidCache: Map<string, Float32Array> = new Map();

    private vectorNormCache = new WeakMap<Float32Array, number>();

    /**
     * Metadata for cache validation (lastModified, contentHash)
     */
    private cacheMetadata: Map<string, { lastModified: number; contentHash: string }> = new Map();

    private cacheFile: string;

    private embeddingStore: EmbeddingIndexedDbStore;

    private embeddingStoreAvailable = false;

    private dirtyFilePaths = new Set<string>();

    private removedFilePaths = new Set<string>();

    private migratedLegacyCache = false;

    // Track the expected embedding dimension to ensure consistency across operations
    private expectedDimension?: number;

    /**
     * Fingerprint key (model + input scheme) the in-memory vectors belong to.
     * Tracked separately from `settings` because the settings object is mutated in place.
     */
    private activeFingerprintKey: string;

    /** Incremented on every change to the indexed vectors; lets consumers invalidate derived caches. */
    private indexVersion = 0;

    /** Incremented whenever all vectors are invalidated; in-flight indexing from an older generation is discarded. */
    private generation = 0;

    /** Serializes cache saves so concurrent callers never interleave or drop dirty marks. */
    private saveChain: Promise<void> = Promise.resolve();

    private saveTimer?: number;

    private closed = false;

    private inFlightIndexing = new Map<string, Promise<IndexFileResult>>();

    private staleFileListener?: (file: TFile) => void;

    /** Set when cached vectors were discarded on load because the embedding fingerprint changed. */
    private invalidatedOnLoad = false;

    /** Created lazily; replaced when provider-relevant settings change. */
    private provider?: EmbeddingProvider;

    private providerConfigKey?: string;

    private readonly providerFactory: EmbeddingProviderFactory;

    private readonly providerContext: EmbeddingProviderContext;

    private providerStatusUnsubscribe?: () => void;

    private providerStatusListeners = new Set<ProviderStatusListener>();

    private lastAvailability?: ProviderAvailability;

    constructor(
        vault: Vault,
        metadataCache: MetadataCache,
        settings: SemanticSearchSettings,
        app?: App,
        options: EmbeddingServiceOptions = {},
    ) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
        this.requestQueue = new RequestQueue(
            settings.maxConcurrentRequests,
            settings.enableAdaptiveThrottling ?? true,
        );
        this.activeFingerprintKey = fingerprintKey(getSettingsFingerprint(settings));
        const defaultPluginDir = `${vault.configDir}/plugins/obsidian-better-command-palette`;
        const pluginDir = options.pluginDir ?? defaultPluginDir;
        this.cacheFile = `${defaultPluginDir}/embeddings.json`;
        this.providerFactory = options.providerFactory ?? createEmbeddingProvider;
        this.providerContext = { adapter: vault.adapter, pluginDir };
        this.applyProviderConcurrency();

        // Scope the database to this vault. Without `app`, fall back to the vault name
        // (getVaultId's own fallback) so storage is still per-vault.
        const scopeApp = app ?? ({ vault } as unknown as App);
        this.embeddingStore = new EmbeddingIndexedDbStore(getVaultScopedName(scopeApp, LEGACY_EMBEDDING_DB_NAME));

        logger.debug(`Semantic search: EmbeddingService initialized with cache file: ${this.cacheFile}, database: ${this.embeddingStore.getName()}`);
        logger.debug(`Semantic search: Cache enabled: ${settings.cacheEnabled}`);
        logger.debug(`Semantic search: Max concurrent requests: ${settings.maxConcurrentRequests}, adaptive: ${settings.enableAdaptiveThrottling ?? true}`);
    }

    async initialize(): Promise<void> {
        logger.debug('Semantic search: Initializing EmbeddingService...');
        this.closed = false;
        // Settings may have changed (mutated in place) since construction; the cache load
        // below discards vectors that don't match this fingerprint.
        this.activeFingerprintKey = fingerprintKey(getSettingsFingerprint(this.settings));
        if (this.settings.cacheEnabled) {
            logger.debug('Semantic search: Cache is enabled, attempting to load existing cache...');
            await this.loadCache();
        } else {
            logger.debug('Semantic search: Cache is disabled, skipping cache load');
        }
        logger.debug(`Semantic search: EmbeddingService initialization complete. ${this.chunkEmbeddingsCache.size} files loaded from cache.`);
        if (this.expectedDimension !== undefined) {
            logger.debug(`Semantic search: Expected embedding dimension: ${this.expectedDimension}`);
        }
    }

    private getCurrentFingerprint(): EmbeddingFingerprint {
        return { ...getSettingsFingerprint(this.settings), dimension: this.expectedDimension };
    }

    private async loadCache(): Promise<void> {
        try {
            this.embeddingStoreAvailable = await this.embeddingStore.initialize();

            if (this.embeddingStoreAvailable) {
                let records = await this.embeddingStore.loadAll();
                if (records.length === 0) {
                    records = await this.migrateFromLegacyDatabase();
                }
                if (records.length > 0) {
                    const metadata = await this.embeddingStore.loadMetadata();
                    this.loadStoredEmbeddingRecords(records, metadata);
                    return;
                }
            }

            await this.loadLegacyJsonCache();
        } catch (error) {
            logger.error('Semantic search: Error loading embedding cache:', error);
        }
    }

    /**
     * One-time copy from the pre-vault-scoped shared database. Only records whose
     * path exists in this vault and whose content hash matches the current file are
     * copied, so same-named notes from other vaults are never adopted.
     * The legacy database is left in place for other vaults.
     */
    private async migrateFromLegacyDatabase(): Promise<StoredEmbeddingRecord[]> {
        try {
            if (await this.embeddingStore.hasMigrationMarker()) {
                return [];
            }

            const legacyRecords = await readLegacyEmbeddingRecords();
            const migrated: StoredEmbeddingRecord[] = [];

            if (legacyRecords && legacyRecords.length > 0) {
                logger.info(`Semantic search: Migrating embeddings from shared database (${legacyRecords.length} candidate records)`);
                for (const record of legacyRecords) {
                    const file = this.vault.getAbstractFileByPath(record.id);
                    if (!(file instanceof TFile) || !record.chunks?.length) {
                        continue;
                    }

                    // eslint-disable-next-line no-await-in-loop
                    const content = await this.vault.cachedRead(file);
                    if (generateContentHashBase36(content) !== record.contentHash) {
                        continue;
                    }

                    migrated.push({
                        ...record,
                        // Content is verified identical, so the vectors are current for this mtime.
                        lastModified: Math.max(record.lastModified, file.stat.mtime),
                    });
                }

                await this.embeddingStore.saveRecords(migrated);
                logger.info(`Semantic search: Migrated ${migrated.length}/${legacyRecords.length} embedding records into ${this.embeddingStore.getName()}`);
            }

            await this.embeddingStore.setMigrationMarker(migrated.length);
            return migrated;
        } catch (error) {
            logger.warn('Semantic search: Failed to migrate legacy embedding database:', error);
            return [];
        }
    }

    private async loadLegacyJsonCache(): Promise<void> {
        logger.debug(`Semantic search: Attempting to load legacy cache from ${this.cacheFile}`);
        if (!(await this.vault.adapter.exists(this.cacheFile))) {
            logger.debug('Semantic search: Cache file does not exist, starting fresh');
            return;
        }

        const cacheData = await this.vault.adapter.read(this.cacheFile);
        const cache: EmbeddingCache = JSON.parse(cacheData);

        logger.debug(`Semantic search: Cache loaded with version ${cache.version}, ${Object.keys(cache.embeddings).length} files`);

        // Only accept version 2.0.0 (chunk-based embeddings)
        // Old versions (1.0.0, 1.1.0) used averaged embeddings and must be rebuilt
        if (cache.version !== CACHE_FORMAT_VERSION) {
            logger.warn(`Semantic search: Cache version ${cache.version} is outdated. Chunk-based embeddings require v2.0.0. Will rebuild index.`);
            return;
        }

        const current = this.getCurrentFingerprint();
        if (!isFingerprintCompatible({ model: cache.model, dimension: cache.dimension }, current)) {
            logger.warn(`Semantic search: Legacy cache was built with model "${cache.model}", current model is "${current.model}". Rebuilding index.`);
            this.invalidatedOnLoad = true;
            return;
        }

        let loadedCount = 0;
        let staleCount = 0;
        let skippedCount = 0;
        let dimensionMismatches = 0;
        let totalChunks = 0;

        for (const [path, fileData] of Object.entries(cache.embeddings)) {
            const file = this.vault.getAbstractFileByPath(path);

            if (!(file instanceof TFile)) {
                logger.debug(`Semantic search: File ${path} no longer exists, skipping cache entry`);
                skippedCount++;
                continue;
            }

            if (!fileData.chunks || fileData.chunks.length === 0) {
                logger.debug(`Semantic search: No chunks for ${path}, skipping`);
                skippedCount++;
                continue;
            }

            // Convert chunk embeddings from regular array to Float32Array
            const chunkEmbeddings: ChunkEmbeddingRuntime[] = [];
            let hasValidChunks = true;

            for (const chunk of fileData.chunks) {
                const arr = this.normalizeVector(new Float32Array(chunk.embedding));

                // Initialize expected dimension if not set
                if (this.expectedDimension === undefined) {
                    this.expectedDimension = cache.dimension ?? arr.length;
                    logger.debug(`Semantic search: Derived expected dimension ${this.expectedDimension} from cache`);
                }

                // Validate dimension
                if (this.expectedDimension !== arr.length) {
                    logger.warn(`Semantic search: Skipping chunk in ${path} due to dimension mismatch (${arr.length} != ${this.expectedDimension})`);
                    dimensionMismatches++;
                    hasValidChunks = false;
                    break;
                }

                chunkEmbeddings.push({
                    embedding: arr,
                    text: chunk.text,
                    startLine: chunk.startLine,
                });
            }

            if (!hasValidChunks) {
                skippedCount++;
                continue;
            }

            // Stale entries (file modified since) are kept so search keeps working until
            // the file is re-embedded; their old lastModified marks them for reindexing.
            if (!this.isFileUpToDate(file, fileData)) {
                staleCount++;
            }

            this.chunkEmbeddingsCache.set(path, chunkEmbeddings);
            this.cacheMetadata.set(path, {
                lastModified: fileData.lastModified,
                contentHash: fileData.contentHash,
            });
            this.fileCentroidCache.set(path, this.computeCentroid(chunkEmbeddings));
            this.dirtyFilePaths.add(path);
            loadedCount++;
            totalChunks += chunkEmbeddings.length;
        }

        if (loadedCount > 0) {
            this.bumpIndexVersion();
        }
        logger.debug(`Semantic search: Loaded ${loadedCount} files (${totalChunks} total chunks, ${staleCount} stale) from cache, skipped ${skippedCount}`);
        this.migratedLegacyCache = loadedCount > 0;
        if (dimensionMismatches > 0) {
            logger.warn(`Semantic search: Skipped ${dimensionMismatches} chunks due to dimension mismatch. Consider re-indexing.`);
        }
    }

    private loadStoredEmbeddingRecords(records: StoredEmbeddingRecord[], metadata?: EmbeddingStoreMetadata): void {
        const current = this.getCurrentFingerprint();

        if (metadata && !isFingerprintCompatible(metadata, current)) {
            logger.warn(`Semantic search: Stored embeddings were built with "${metadata.model}" (${metadata.scheme ?? 'raw-v1'}), current is "${current.model}" (${current.scheme}). Clearing and rebuilding index.`);
            this.invalidatedOnLoad = true;
            this.enqueueStoreClear();
            return;
        }

        let loadedCount = 0;
        let staleCount = 0;
        let incompatibleCount = 0;
        let skippedCount = 0;
        let totalChunks = 0;

        for (const record of records) {
            const file = this.vault.getAbstractFileByPath(record.id);
            if (!(file instanceof TFile) || !record.chunks?.length) {
                // Prune records for files that no longer exist on the next save.
                this.removedFilePaths.add(record.id);
                skippedCount++;
                continue;
            }

            if (!isFingerprintCompatible(record, { ...current, dimension: this.expectedDimension })) {
                this.removedFilePaths.add(record.id);
                incompatibleCount++;
                continue;
            }

            const chunkEmbeddings = record.chunks.map((chunk) => ({
                embedding: this.normalizeVector(new Float32Array(chunk.embedding)),
                text: chunk.text,
                startLine: chunk.startLine,
            }));

            const firstChunk = chunkEmbeddings[0];
            if (firstChunk && this.expectedDimension === undefined) {
                this.expectedDimension = record.dimension ?? firstChunk.embedding.length;
            }

            if (this.expectedDimension !== undefined
                && chunkEmbeddings.some((chunk) => chunk.embedding.length !== this.expectedDimension)) {
                this.removedFilePaths.add(record.id);
                incompatibleCount++;
                continue;
            }

            // Keep stale vectors until they are replaced; reconciliation re-embeds them.
            if (!this.isFileUpToDate(file, record)) {
                staleCount++;
            }

            this.chunkEmbeddingsCache.set(record.id, chunkEmbeddings);
            this.cacheMetadata.set(record.id, {
                lastModified: record.lastModified,
                contentHash: record.contentHash,
            });
            this.fileCentroidCache.set(record.id, this.computeCentroid(chunkEmbeddings));
            loadedCount++;
            totalChunks += chunkEmbeddings.length;
        }

        if (loadedCount === 0 && incompatibleCount > 0) {
            this.invalidatedOnLoad = true;
        }
        if (loadedCount > 0) {
            this.bumpIndexVersion();
        }

        logger.debug(`Semantic search: Loaded ${loadedCount} files (${totalChunks} chunks, ${staleCount} stale) from IndexedDB, skipped ${skippedCount}, incompatible ${incompatibleCount}`);
    }

    private computeCentroid(chunks: ChunkEmbeddingRuntime[]): Float32Array {
        const firstChunk = chunks[0];
        if (!firstChunk) {
            return new Float32Array();
        }

        const centroid = new Float32Array(firstChunk.embedding.length);
        chunks.forEach((chunk) => {
            for (let i = 0; i < centroid.length; i++) {
                centroid[i] += chunk.embedding[i] || 0;
            }
        });

        for (let i = 0; i < centroid.length; i++) {
            centroid[i] /= chunks.length;
        }

        return this.normalizeVector(centroid);
    }

    private computeVectorNorm(vector: Float32Array): number {
        const cachedNorm = this.vectorNormCache.get(vector);
        if (cachedNorm !== undefined) {
            return cachedNorm;
        }

        let normSquared = 0;
        for (let i = 0; i < vector.length; i++) {
            const value = vector[i] || 0;
            normSquared += value * value;
        }

        const norm = Math.sqrt(normSquared);
        this.vectorNormCache.set(vector, norm);
        return norm;
    }

    private normalizeVector(vector: Float32Array): Float32Array {
        const norm = this.computeVectorNorm(vector);
        if (norm === 0) {
            return vector;
        }

        for (let i = 0; i < vector.length; i++) {
            vector[i] = (vector[i] || 0) / norm;
        }

        this.vectorNormCache.set(vector, 1);
        return vector;
    }

    private isFileUpToDate(file: TFile, cacheData: { lastModified: number }): boolean {
        return file.stat.mtime <= cacheData.lastModified;
    }

    private bumpIndexVersion(): void {
        this.indexVersion++;
    }

    private markDirty(path: string): void {
        this.dirtyFilePaths.add(path);
        this.removedFilePaths.delete(path);
    }

    /** Whether there are in-memory changes not yet persisted. */
    hasUnsavedChanges(): boolean {
        return this.dirtyFilePaths.size > 0 || this.removedFilePaths.size > 0 || this.migratedLegacyCache;
    }

    /**
     * Persist dirty embeddings. Saves are serialized: each call waits for any
     * in-progress save and then writes the changes accumulated so far.
     */
    saveCache(): Promise<void> {
        this.cancelScheduledSave();
        const run = this.saveChain.then(() => this.performSave());
        this.saveChain = run.catch(() => undefined);
        return run;
    }

    /** Debounced save, e.g. after incremental edits. */
    scheduleSave(delayMs = DEFAULT_SAVE_DEBOUNCE_MS): void {
        if (this.closed || !this.settings.cacheEnabled) {
            return;
        }

        this.cancelScheduledSave();
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = undefined;
            this.saveCache().catch((error) => {
                logger.warn('Semantic search: Scheduled cache save failed:', error);
            });
        }, delayMs);
    }

    cancelScheduledSave(): void {
        if (this.saveTimer !== undefined) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
    }

    private async performSave(): Promise<void> {
        if (!this.settings.cacheEnabled) {
            logger.debug('Semantic search: Cache is disabled, skipping save');
            return;
        }

        if (this.closed) {
            return;
        }

        // Snapshot-and-swap: marks added while this save is awaiting go to the next save.
        const dirty = this.dirtyFilePaths;
        const removed = this.removedFilePaths;
        this.dirtyFilePaths = new Set();
        this.removedFilePaths = new Set();

        try {
            if (!this.embeddingStoreAvailable) {
                this.embeddingStoreAvailable = await this.embeddingStore.initialize();
            }

            if (!this.embeddingStoreAvailable) {
                await this.saveLegacyJsonCache();
                this.migratedLegacyCache = false;
                return;
            }

            let savedCount = 0;
            let removedCount = 0;
            const model = resolveEmbeddingModel(this.settings);
            const { scheme } = getSettingsFingerprint(this.settings);

            for (const path of removed) {
                if (this.chunkEmbeddingsCache.has(path)) {
                    // Re-indexed since removal; the dirty set will write it.
                    continue;
                }
                // eslint-disable-next-line no-await-in-loop
                await this.embeddingStore.deleteFile(path);
                removedCount++;
            }

            for (const path of dirty) {
                const chunkEmbeddings = this.chunkEmbeddingsCache.get(path);
                const file = this.vault.getAbstractFileByPath(path);
                const metadata = this.cacheMetadata.get(path);

                if (!chunkEmbeddings || !(file instanceof TFile) || !metadata) {
                    // eslint-disable-next-line no-await-in-loop
                    await this.embeddingStore.deleteFile(path);
                    removedCount++;
                    continue;
                }

                const chunks: ChunkEmbedding[] = chunkEmbeddings.map((chunk) => ({
                    embedding: Array.from(chunk.embedding), // Convert Float32Array to regular array
                    text: chunk.text,
                    startLine: chunk.startLine,
                }));

                // eslint-disable-next-line no-await-in-loop
                await this.embeddingStore.saveFile(path, {
                    lastModified: metadata.lastModified,
                    contentHash: metadata.contentHash,
                    chunks,
                }, model, this.expectedDimension, scheme);
                savedCount++;
            }

            await this.embeddingStore.saveMetadata({
                version: CACHE_FORMAT_VERSION,
                lastUpdated: Date.now(),
                model,
                dimension: this.expectedDimension,
                scheme,
            });

            if (savedCount > 0 || removedCount > 0 || this.migratedLegacyCache) {
                logger.debug(`Semantic search: Saved ${savedCount} dirty embedding records, removed ${removedCount}`);
            }
            this.migratedLegacyCache = false;
        } catch (error) {
            // Restore marks so the next save retries them.
            dirty.forEach((path) => this.dirtyFilePaths.add(path));
            removed.forEach((path) => {
                if (!this.chunkEmbeddingsCache.has(path)) {
                    this.removedFilePaths.add(path);
                }
            });
            logger.error('Semantic search: Error saving embedding cache:', error);
        }
    }

    private async saveLegacyJsonCache(): Promise<void> {
        logger.debug(`Semantic search: IndexedDB unavailable, saving legacy cache with ${this.chunkEmbeddingsCache.size} files`);

        const cache: EmbeddingCache = {
            version: CACHE_FORMAT_VERSION,
            lastUpdated: Date.now(),
            model: resolveEmbeddingModel(this.settings),
            dimension: this.expectedDimension,
            embeddings: {},
        };

        for (const [path, chunkEmbeddings] of this.chunkEmbeddingsCache) {
            const metadata = this.cacheMetadata.get(path);
            if (!metadata) {
                continue;
            }

            cache.embeddings[path] = {
                lastModified: metadata.lastModified,
                contentHash: metadata.contentHash,
                chunks: chunkEmbeddings.map((chunk) => ({
                    embedding: Array.from(chunk.embedding),
                    text: chunk.text,
                    startLine: chunk.startLine,
                })),
            };
        }

        await this.vault.adapter.write(this.cacheFile, JSON.stringify(cache));
    }

    /** Queue a store wipe behind any in-progress save so it cannot be overwritten by stale data. */
    private enqueueStoreClear(): void {
        this.saveChain = this.saveChain
            .then(() => this.embeddingStore.clear())
            .catch((error) => {
                logger.warn('Semantic search: Failed to clear embedding store:', error);
            });
    }

    /**
     * Chunk document into semantic units of 2-4 sentences (~300-400 tokens each)
     * Each chunk includes the file title and tags for context
     */
    private chunkDocument(content: string, file: TFile): string[] {
        const metadata = this.metadataCache.getFileCache(file);
        const targetChunkSize = this.settings.chunkSize || 400; // ~300-400 tokens target

        // Build context prefix with title and tags
        const prefix = file.basename;
        const tags = metadata?.tags?.map((tag) => tag.tag.replace('#', '')).join(' ') || '';
        const contextPrefix = tags ? `${prefix} ${tags}` : prefix;
        const prefixLength = contextPrefix.length + 2; // +2 for ": "

        // Split content into sentences
        const sentences = this.splitIntoSentences(content);

        if (sentences.length === 0) {
            return [`${contextPrefix}: ${content.substring(0, targetChunkSize)}`];
        }

        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentLength = 0;
        const minSentences = 2;
        const maxSentences = 4;

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            if (!sentence) continue;

            const sentenceLength = sentence.length;

            // Check if adding this sentence would exceed target size
            const wouldExceed = currentLength + sentenceLength > targetChunkSize - prefixLength;
            const hasMinSentences = currentChunk.length >= minSentences;
            const hasMaxSentences = currentChunk.length >= maxSentences;

            // Finalize current chunk if we have enough sentences or would exceed size
            if ((wouldExceed && hasMinSentences) || hasMaxSentences) {
                if (currentChunk.length > 0) {
                    chunks.push(`${contextPrefix}: ${currentChunk.join(' ')}`);
                }
                currentChunk = [];
                currentLength = 0;
            }

            // Add sentence to current chunk
            currentChunk.push(sentence);
            currentLength += sentenceLength + 1; // +1 for space
        }

        // Don't forget the last chunk
        if (currentChunk.length > 0) {
            chunks.push(`${contextPrefix}: ${currentChunk.join(' ')}`);
        }

        return chunks.length > 0 ? chunks : [`${contextPrefix}: ${content.substring(0, targetChunkSize)}`];
    }

    /**
     * Split text into sentences using multiple delimiters
     * Handles common edge cases like abbreviations and numbers
     */
    private splitIntoSentences(text: string): string[] {
        // Remove frontmatter (YAML between ---)
        const withoutFrontmatter = text.replace(/^---[\s\S]*?---\n?/, '');

        // Split by sentence-ending punctuation, keeping the punctuation
        // This regex handles: . ! ? and common abbreviations
        const rawSentences = withoutFrontmatter
            .replace(/([.!?])\s+/g, '$1\n') // Add newline after sentence-ending punctuation
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        // Filter out very short fragments (likely not real sentences)
        return rawSentences.filter((s) => s.length > 10);
    }

    private isAbortError(error: unknown): boolean {
        return isAbortError(error);
    }

    private throwIfAborted(signal?: AbortSignal): void {
        throwIfAborted(signal);
    }

    // --- Provider management ---

    /** Current embedding provider, created on first use from the settings. */
    getProvider(): EmbeddingProvider {
        if (!this.provider) {
            this.provider = this.providerFactory(this.settings, this.providerContext);
            this.providerConfigKey = getProviderConfigKey(this.settings);
            this.lastAvailability = undefined;
            this.providerStatusUnsubscribe = this.provider.onStatusChange((status) => this.emitProviderStatus(status));
            this.applyProviderConcurrency();
            logger.debug(`Semantic search: Using embedding provider ${this.provider.label}`);
            this.emitProviderStatus(this.provider.getStatus());
        }
        return this.provider;
    }

    private disposeProvider(): void {
        const { provider } = this;
        if (!provider) {
            return;
        }
        this.providerStatusUnsubscribe?.();
        this.providerStatusUnsubscribe = undefined;
        this.provider = undefined;
        this.providerConfigKey = undefined;
        this.lastAvailability = undefined;
        provider.dispose();
        this.emitProviderStatus({ state: 'idle', message: 'Model not loaded yet' });
    }

    /** Status of the current provider (model download/loading, readiness, errors). */
    getProviderStatus(): ProviderStatus {
        return this.provider?.getStatus() ?? { state: 'idle', message: 'Model not loaded yet' };
    }

    /** Subscribe to provider status; survives provider replacement. Returns an unsubscribe function. */
    onProviderStatusChange(listener: ProviderStatusListener): () => void {
        this.providerStatusListeners.add(listener);
        return () => {
            this.providerStatusListeners.delete(listener);
        };
    }

    private emitProviderStatus(status: ProviderStatus): void {
        this.providerStatusListeners.forEach((listener) => {
            try {
                listener(status);
            } catch (error) {
                logger.warn('Semantic search: Provider status listener failed:', error);
            }
        });
    }

    /** Start loading the provider's model in the background (no-op for remote providers). */
    async warmup(): Promise<void> {
        if (this.closed) {
            return;
        }
        await this.getProvider().warmup?.();
    }

    /**
     * File-level indexing concurrency: the provider's ceiling (local models run one
     * batch at a time) or the user setting. Adaptive throttling only for providers
     * where response times reflect server load.
     */
    private applyProviderConcurrency(): void {
        const provider = this.provider;
        const userMax = Math.max(1, this.settings.maxConcurrentRequests || 1);
        const limit = provider?.maxConcurrency !== undefined ? provider.maxConcurrency : userMax;
        const adaptive = (this.settings.enableAdaptiveThrottling ?? true) && (provider?.supportsAdaptiveThrottling ?? true);
        this.requestQueue.updateConcurrentLimit(limit);
        // Disabling adaptive throttling also restores the full limit
        this.requestQueue.setAdaptiveThrottling(adaptive);
    }

    private toEmbeddingKind(taskType: 'search_document' | 'search_query'): EmbeddingKind {
        return taskType === 'search_query' ? 'query' : 'document';
    }

    async generateEmbedding(
        text: string,
        taskType: 'search_document' | 'search_query' = 'search_document',
        retries = 3,
        options: EmbeddingRequestOptions = {},
    ): Promise<Float32Array> {
        const [vector] = await this.generateEmbeddings([text], taskType, retries, options);
        if (!vector) {
            throw new Error('Embedding provider returned no vector');
        }
        return vector;
    }

    /**
     * Embed several texts with one provider call. Vectors are normalized; the first
     * vector of a generation defines the expected dimension.
     */
    async generateEmbeddings(
        texts: string[],
        taskType: 'search_document' | 'search_query' = 'search_document',
        retries = 3,
        options: EmbeddingRequestOptions = {},
    ): Promise<Float32Array[]> {
        // NOTE: Do not wrap this in requestQueue.add() - the queue is managed at the file level
        // in indexAllFiles to avoid deadlocks from nested queue entries
        this.throwIfAborted(options.signal);
        if (this.closed) {
            throw createAbortError('Embedding service closed');
        }

        const timeoutMs = Math.max(500, options.timeoutMs ?? this.settings.searchTimeoutMs ?? 8000);
        const generationAtStart = this.generation;
        const rawVectors = await this.getProvider().embed(texts, this.toEmbeddingKind(taskType), {
            signal: options.signal,
            timeoutMs,
            retries,
        });

        if (rawVectors.length !== texts.length) {
            throw new Error(`Embedding provider returned ${rawVectors.length} vectors for ${texts.length} inputs`);
        }

        return rawVectors.map((raw) => {
            if (raw.length === 0) {
                throw new Error('Invalid embedding response: missing or empty embedding');
            }
            const vec = this.normalizeVector(raw);
            if (this.expectedDimension === undefined) {
                // Do not let a response from before an invalidation define the new dimension
                if (generationAtStart === this.generation) {
                    this.expectedDimension = vec.length;
                    logger.debug(`[Semantic Search] Set expected embedding dimension to ${this.expectedDimension}`);
                }
            } else if (this.expectedDimension !== vec.length) {
                logger.warn(`[Semantic Search] Generated embedding dimension ${vec.length} differs from expected ${this.expectedDimension}`);
            }
            return vec;
        });
    }

    /**
   * Check if a file should be excluded from indexing based on exclusion patterns
   */
    public shouldExcludeFile(file: TFile): boolean {
        if (!this.settings.excludePatterns || this.settings.excludePatterns.length === 0) {
            return false;
        }

        // Check if file path matches any exclusion pattern
        return this.settings.excludePatterns.some((pattern) => {
            try {
                // Convert glob pattern to regex more accurately
                let regexPattern = pattern
                    .replace(/\./g, '\\.') // Escape dots
                    .replace(/\*\*\//g, '__DOUBLESTARSLASH__') // Temporarily replace **/
                    .replace(/\*\*/g, '__DOUBLESTAR__') // Temporarily replace **
                    .replace(/\*/g, '[^/]*') // Convert single * to match anything except path separators
                    .replace(/__DOUBLESTARSLASH__/g, '.*') // Convert **/ to match everything including path separators
                    .replace(/__DOUBLESTAR__/g, '[^/]*') // Convert ** to match everything including path separators (if not followed by /)
                    .replace(/\?/g, '[^/]') // Convert ? to match single character except path separator
                    .replace(/\//g, '\\/'); // Escape forward slashes

                // Ensure pattern matches from start if it starts with **/ or /
                if (pattern.startsWith('**/') || pattern.startsWith('/')) {
                    regexPattern = `^${regexPattern}`;
                } else {
                    // If pattern doesn't start with **/ or /, match anywhere in path
                    regexPattern = `(^|/)${regexPattern}`;
                }

                // Ensure pattern matches to end if it doesn't end with **
                if (!pattern.endsWith('**')) {
                    regexPattern = `${regexPattern}$`;
                }

                const regex = new RegExp(regexPattern);
                return regex.test(file.path);
            } catch (e) {
                logger.warn(`Semantic search: Invalid exclusion pattern: ${pattern}`, e);
                return false;
            }
        });
    }

    private getMaxFileSize(): number {
        return Math.max(0, this.settings.maxFileSize ?? 512 * 1024);
    }

    private getMaxIndexedFiles(): number {
        return Math.max(0, this.settings.maxIndexedFiles ?? 2000);
    }

    public canIndexFile(file: TFile): boolean {
        if (this.shouldExcludeFile(file)) {
            return false;
        }

        const maxFileSize = this.getMaxFileSize();
        if (maxFileSize > 0 && file.stat.size > maxFileSize) {
            return false;
        }

        return true;
    }

    private getIndexableMarkdownFiles(markdownFiles = this.vault.getMarkdownFiles()): TFile[] {
        const sortedFiles = [...markdownFiles]
            .filter((file) => this.canIndexFile(file))
            .sort((a, b) => a.path.localeCompare(b.path));
        const maxIndexedFiles = this.getMaxIndexedFiles();

        if (maxIndexedFiles <= 0) {
            return sortedFiles;
        }

        return sortedFiles.slice(0, maxIndexedFiles);
    }

    private pruneCachedFilesOutsideActiveSet(activePaths: Set<string>): number {
        let prunedCount = 0;

        for (const filePath of this.chunkEmbeddingsCache.keys()) {
            if (!activePaths.has(filePath)) {
                this.removeFromCache(filePath);
                prunedCount++;
            }
        }

        return prunedCount;
    }

    /**
     * Files within the indexing guardrails that are missing from the index or whose
     * cached vectors are older than the file.
     */
    getFilesNeedingIndex(): TFile[] {
        return this.getIndexableMarkdownFiles().filter((file) => {
            const cached = this.cacheMetadata.get(file.path);
            return !cached || !this.isFileUpToDate(file, cached);
        });
    }

    /** Drop cached entries outside the current guardrails (exclusions, size, max files). */
    pruneInactiveEntries(): number {
        const activePaths = new Set(this.getIndexableMarkdownFiles().map((file) => file.path));
        return this.pruneCachedFilesOutsideActiveSet(activePaths);
    }

    /**
     * Register a callback for files that changed while they were being embedded
     * (or otherwise ended up stale after indexing) so they can be re-queued.
     */
    setStaleFileListener(listener?: (file: TFile) => void): void {
        this.staleFileListener = listener;
    }

    /**
     * Index a single file. Concurrent calls for the same path share one run; if the
     * file changed while it was being embedded, the stale-file listener is notified.
     */
    async indexFile(file: TFile, options: SemanticIndexingOptions = {}): Promise<IndexFileResult> {
        const inFlight = this.inFlightIndexing.get(file.path);
        if (inFlight) {
            return inFlight;
        }

        const run = this.indexFileInternal(file, options);
        this.inFlightIndexing.set(file.path, run);

        try {
            const result = await run;
            this.notifyIfStale(file);
            return result;
        } finally {
            if (this.inFlightIndexing.get(file.path) === run) {
                this.inFlightIndexing.delete(file.path);
            }
        }
    }

    private notifyIfStale(file: TFile): void {
        if (this.closed || !this.staleFileListener) {
            return;
        }

        const metadata = this.cacheMetadata.get(file.path);
        if (metadata && !this.isFileUpToDate(file, metadata)) {
            logger.debug(`Semantic search: ${file.path} changed during indexing, re-queueing`);
            this.staleFileListener(file);
        }
    }

    private async indexFileInternal(file: TFile, options: SemanticIndexingOptions): Promise<IndexFileResult> {
        try {
            this.throwIfAborted(options.signal);

            // Skip excluded files, and don't mix vectors from a model change that isn't applied yet
            if (!this.canIndexFile(file) || this.hasPendingModelChange()) {
                return 'skipped';
            }

            const generationAtStart = this.generation;
            // Capture mtime before reading so edits made while embedding are detected afterwards
            const mtimeAtStart = file.stat.mtime;

            // Check if file is already up-to-date
            const existingMetadata = this.cacheMetadata.get(file.path);
            if (existingMetadata && mtimeAtStart <= existingMetadata.lastModified) {
                return 'unchanged';
            }

            const content = await this.vault.cachedRead(file);
            this.throwIfAborted(options.signal);
            if (generationAtStart !== this.generation) {
                return 'skipped';
            }

            // Check if content actually changed
            const contentHash = generateContentHashBase36(content);
            if (existingMetadata && existingMetadata.contentHash === contentHash
                && this.chunkEmbeddingsCache.has(file.path)) {
                this.cacheMetadata.set(file.path, {
                    lastModified: mtimeAtStart,
                    contentHash,
                });
                // Persist the new mtime, otherwise the record looks stale after restart
                this.markDirty(file.path);
                return 'unchanged';
            }

            if (!content || content.trim().length === 0) {
                if (this.chunkEmbeddingsCache.has(file.path)) {
                    // Note was emptied: its old vectors no longer describe it
                    this.removeFromCache(file.path);
                }
                return 'skipped';
            }

            const chunks = this.chunkDocument(content, file);

            if (chunks.length === 0 || (chunks.length === 1 && chunks[0]?.trim().length === 0)) {
                return 'skipped';
            }

            // Generate embeddings for all chunks (store each one, not averaged!).
            // Chunks are sent in provider-sized batches (1 for Ollama, several for local models).
            const chunkEmbeddings: ChunkEmbeddingRuntime[] = [];
            const texts = chunks.filter((chunkText): chunkText is string => !!chunkText);
            const batchSize = Math.max(1, this.getProvider().maxBatchSize);

            for (let start = 0; start < texts.length; start += batchSize) {
                const batch = texts.slice(start, start + batchSize);
                const batchLabel = batch.length === 1
                    ? `chunk ${start + 1}`
                    : `chunks ${start + 1}-${start + batch.length}`;

                try {
                    this.throwIfAborted(options.signal);
                    // eslint-disable-next-line no-await-in-loop
                    const embeddings = await this.generateEmbeddings(batch, 'search_document', 3, {
                        signal: options.signal,
                        timeoutMs: this.settings.indexingRequestTimeoutMs ?? 30000,
                    });

                    if (generationAtStart !== this.generation) {
                        logger.debug(`Semantic search: Embeddings invalidated while indexing ${file.path}, discarding`);
                        return 'skipped';
                    }

                    embeddings.forEach((embedding, offset) => {
                        // Initialize expected dimension if needed
                        if (this.expectedDimension === undefined) {
                            this.expectedDimension = embedding.length;
                        }

                        // Validate dimension
                        if (this.expectedDimension !== embedding.length) {
                            logger.warn(`[Semantic Search] Dimension mismatch for chunk ${start + offset + 1} of ${file.path}: got ${embedding.length}, expected ${this.expectedDimension}`);
                            return;
                        }

                        chunkEmbeddings.push({
                            embedding,
                            text: batch[offset]!,
                            // Could calculate startLine here from content if needed
                        });
                    });
                } catch (error) {
                    if (this.isAbortError(error) || error instanceof NonRetryableEmbeddingError) {
                        // Abort, or a request error that every remaining chunk would hit too
                        throw error;
                    }
                    logger.error(`[Semantic Search] Failed to generate embedding for ${batchLabel} of ${file.path}:`, error);
                }
            }

            if (generationAtStart !== this.generation) {
                return 'skipped';
            }

            if (chunkEmbeddings.length === 0) {
                logger.warn(`[Semantic Search] No embeddings generated for ${file.path}`);
                return 'skipped';
            }

            // Store all chunk embeddings for this file (not averaged!)
            this.chunkEmbeddingsCache.set(file.path, chunkEmbeddings);
            this.cacheMetadata.set(file.path, {
                lastModified: mtimeAtStart,
                contentHash,
            });
            this.fileCentroidCache.set(file.path, this.computeCentroid(chunkEmbeddings));
            this.markDirty(file.path);
            this.bumpIndexVersion();

            logger.debug(`Semantic search: Indexed ${file.path} with ${chunkEmbeddings.length} chunks`);
            return 'indexed';
        } catch (error) {
            if (this.isAbortError(error)) {
                logger.debug(`Semantic search: Indexing aborted for ${file.path}`);
                throw error;
            }
            logger.error(`[Semantic Search] Error indexing file ${file.path}:`, error);
            throw error;
        }
    }


    async indexAllFiles(
        onProgress?: (current: number, total: number) => void,
        options: SemanticIndexingOptions = {},
    ): Promise<void> {
        // A full index run is an explicit request to adopt the configured model
        this.applyModelChange();
        // Create the provider first so the queue runs at its concurrency
        this.getProvider();
        const startTime = Date.now();
        const markdownFiles = this.vault.getMarkdownFiles();
        const indexableFiles = this.getIndexableMarkdownFiles(markdownFiles);
        const activePaths = new Set(indexableFiles.map((file) => file.path));
        const prunedCount = this.pruneCachedFilesOutsideActiveSet(activePaths);

        logger.debug(`[Semantic Search] Starting index scan of ${markdownFiles.length} total markdown files...`);
        if (indexableFiles.length !== markdownFiles.length) {
            logger.debug(`[Semantic Search] Guardrails limited indexing to ${indexableFiles.length}/${markdownFiles.length} markdown files`);
        }
        if (prunedCount > 0) {
            logger.debug(`[Semantic Search] Pruned ${prunedCount} cached files outside current semantic indexing guardrails`);
        }

        const filesToIndex = indexableFiles.filter((file) => {
            const cached = this.cacheMetadata.get(file.path);
            const needsReindex = !cached || !this.isFileUpToDate(file, cached);
            return needsReindex;
        });

        const cachedCount = indexableFiles.length - filesToIndex.length;
        const skippedByGuardrails = markdownFiles.length - indexableFiles.length;
        const stats = this.requestQueue.getStats();

        logger.debug(`[Semantic Search] Files to index: ${filesToIndex.length} (${cachedCount} cached, ${skippedByGuardrails} skipped by guardrails)`);
        logger.debug(`[Semantic Search] Concurrency: ${stats.currentConcurrency}/${stats.userMax} (adaptive: ${this.settings.enableAdaptiveThrottling ?? true})`);

        if (filesToIndex.length === 0) {
            logger.debug('[Semantic Search] All files are already indexed or excluded, nothing to do');
            if (prunedCount > 0) {
                await this.saveCache();
            }
            return;
        }

        logger.debug(`[Semantic Search] Starting to index ${filesToIndex.length} files...`);

        let processedCount = 0;
        let errorCount = 0;
        const saveInterval = 10; // Save cache every N files
        let nextFileIndex = 0;
        const workerCount = Math.max(
            1,
            Math.min(filesToIndex.length, this.requestQueue.getCurrentConcurrency()),
        );

        // Process files in parallel using the request queue
        // The queue handles concurrency limits and adaptive throttling
        const indexPromises = Array.from({ length: workerCount }, () => this.requestQueue.add(async () => {
            while (nextFileIndex < filesToIndex.length) {
                this.throwIfAborted(options.signal);

                const file = filesToIndex[nextFileIndex];
                nextFileIndex++;

                if (!file) {
                    continue;
                }

                try {
                    const fileStartTime = Date.now();
                    await this.indexFile(file, options);
                    const fileTime = Date.now() - fileStartTime;

                    processedCount++;
                    const queueStats = this.requestQueue.getStats();
                    logger.debug(`[Semantic Search] Indexed ${processedCount}/${filesToIndex.length}: ${file.path} (${fileTime}ms, concurrency: ${queueStats.currentConcurrency})`);

                    if (onProgress) {
                        onProgress(processedCount, filesToIndex.length);
                    }

                    // Periodically save cache to avoid losing progress
                    if (processedCount % saveInterval === 0) {
                        await this.saveCache().catch((error) => {
                            logger.warn('Semantic search: Failed to save intermediate cache:', error);
                        });
                    }
                } catch (error) {
                    if (this.isAbortError(error)) {
                        throw error;
                    }
                    errorCount++;
                    logger.error(`Semantic search: Failed to index ${file.path}:`, error);
                }
            }
        }));

        // Wait for all files to be processed
        try {
            await Promise.all(indexPromises);
        } catch (error) {
            if (this.isAbortError(error)) {
                logger.info(`[Semantic Search] Indexing cancelled after ${processedCount}/${filesToIndex.length} files`);
                await this.saveCache().catch((saveError) => {
                    logger.warn('Semantic search: Failed to save cache after cancellation:', saveError);
                });
                throw error;
            }
            throw error;
        }

        // Final cache save
        await this.saveCache();

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const finalStats = this.requestQueue.getStats();
        logger.debug(`[Semantic Search] ✅ Indexing complete: ${processedCount} files, ${errorCount} errors, ${totalTime}s`);
        logger.debug(`[Semantic Search] Final concurrency: ${finalStats.currentConcurrency}/${finalStats.userMax}, avg response: ${finalStats.avgResponseTime.toFixed(0)}ms`);
    }

    /**
     * Whether the configured provider can produce embeddings right now. For the local
     * provider this loads (and on first use downloads) the model. The explanation is
     * available from getAvailabilityMessage().
     */
    async checkConnection(): Promise<boolean> {
        if (this.closed) {
            return false;
        }
        const provider = this.getProvider();
        const availability = await provider.checkAvailability();
        // Ignore results for a provider that was replaced while checking
        if (this.provider === provider) {
            this.lastAvailability = availability;
        }
        if (!availability.ok) {
            logger.warn(`[Semantic Search] Embedding provider unavailable: ${availability.message}`);
        }
        return availability.ok;
    }

    /** Explanation from the most recent checkConnection(), if any. */
    getAvailabilityMessage(): string | undefined {
        return this.lastAvailability?.message;
    }

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length !== b.length) {
            logger.warn(`Semantic search: Cosine similarity dimension mismatch (${a.length} vs ${b.length}). Returning 0.`);
            return 0;
        }

        let dotProduct = 0;
        const normA = this.computeVectorNorm(a);
        const normB = this.computeVectorNorm(b);

        if (normA === 0 || normB === 0) {
            return 0;
        }

        for (let i = 0; i < a.length; i++) {
            const aValue = a[i];
            const bValue = b[i];

            if (aValue !== undefined && bValue !== undefined) {
                dotProduct += aValue * bValue;
            }
        }

        return dotProduct / (normA * normB);
    }

    /**
     * Get all chunk embeddings for a file
     * Returns undefined if file is not indexed
     */
    getChunkEmbeddings(filePath: string): ChunkEmbeddingRuntime[] | undefined {
        return this.chunkEmbeddingsCache.get(filePath);
    }

    getFileCentroid(filePath: string): Float32Array | undefined {
        return this.fileCentroidCache.get(filePath);
    }

    getIndexedFilePaths(): string[] {
        return Array.from(this.chunkEmbeddingsCache.keys());
    }

    getCandidateFilePaths(
        queryEmbedding: Float32Array,
        maxCandidates: number,
        threshold = 0,
        signal?: AbortSignal,
    ): string[] {
        const scored: Array<{ path: string; similarity: number }> = [];
        const candidateThreshold = Math.max(0, threshold * 0.5);

        for (const [path, centroid] of this.fileCentroidCache) {
            if (signal?.aborted) {
                break;
            }

            if (centroid.length !== queryEmbedding.length) {
                continue;
            }

            const similarity = this.cosineSimilarity(queryEmbedding, centroid);
            if (similarity >= candidateThreshold) {
                scored.push({ path, similarity });
            }
        }

        if (scored.length === 0 && this.fileCentroidCache.size > 0) {
            for (const path of this.fileCentroidCache.keys()) {
                scored.push({ path, similarity: 0 });
                if (scored.length >= maxCandidates) {
                    break;
                }
            }
        }

        return scored
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, maxCandidates)
            .map((item) => item.path);
    }

    /**
     * @deprecated Use getChunkEmbeddings instead for chunk-based search
     * Kept for backward compatibility - returns the first chunk's embedding
     */
    getEmbedding(filePath: string): Float32Array | undefined {
        const chunks = this.chunkEmbeddingsCache.get(filePath);
        if (!chunks || chunks.length === 0) return undefined;
        const firstChunk = chunks[0];
        if (!firstChunk) return undefined;
        if (this.expectedDimension !== undefined && firstChunk.embedding.length !== this.expectedDimension) {
            logger.warn(`Semantic search: Cached embedding for ${filePath} has wrong dimension (${firstChunk.embedding.length} != ${this.expectedDimension}). Ignoring.`);
            return undefined;
        }
        return firstChunk.embedding;
    }

    getIndexedFileCount(): number {
        return this.chunkEmbeddingsCache.size;
    }

    /**
     * Get total number of chunks across all indexed files
     */
    getTotalChunkCount(): number {
        let total = 0;
        for (const chunks of this.chunkEmbeddingsCache.values()) {
            total += chunks.length;
        }
        return total;
    }

    getQueueStatus(): { queued: number; active: number; currentConcurrency: number } {
        const stats = this.requestQueue.getStats();
        return {
            queued: this.requestQueue.getQueueSize(),
            active: this.requestQueue.getActiveRequests(),
            currentConcurrency: stats.currentConcurrency,
        };
    }

    cancelPendingRequests(reason = 'Semantic indexing cancelled'): void {
        this.requestQueue.clear(reason);
    }

    /** Monotonic counter that changes whenever indexed vectors change. */
    getIndexVersion(): number {
        return this.indexVersion;
    }

    /** Key identifying the current embedding space (model + input scheme). */
    getModelFingerprintKey(): string {
        return fingerprintKey(getSettingsFingerprint(this.settings));
    }

    /**
     * Returns true once if cached vectors were discarded on load because they were built
     * with a different model/scheme, meaning a rebuild is needed regardless of auto-index settings.
     */
    consumeLoadInvalidation(): boolean {
        const invalidated = this.invalidatedOnLoad;
        this.invalidatedOnLoad = false;
        return invalidated;
    }

    clearCache(): void {
        this.cancelPendingRequests('Semantic cache cleared');
        this.invalidateAllEmbeddings('cache cleared');
    }

    /**
     * Drop every vector (memory and storage). In-flight indexing started before this
     * call is discarded when it completes.
     */
    private invalidateAllEmbeddings(reason: string): void {
        logger.info(`Semantic search: Invalidating all embeddings (${reason})`);
        this.generation++;
        this.chunkEmbeddingsCache.clear();
        this.cacheMetadata.clear();
        this.fileCentroidCache.clear();
        this.vectorNormCache = new WeakMap<Float32Array, number>();
        this.dirtyFilePaths.clear();
        this.removedFilePaths.clear();
        this.migratedLegacyCache = false;
        this.expectedDimension = undefined;
        this.bumpIndexVersion();
        this.enqueueStoreClear();
        this.enqueueLegacyJsonRemoval();
    }

    /** The per-vault legacy JSON cache would otherwise be re-loaded when IndexedDB is empty. */
    private enqueueLegacyJsonRemoval(): void {
        this.saveChain = this.saveChain
            .then(async () => {
                if (await this.vault.adapter.exists(this.cacheFile)) {
                    await this.vault.adapter.remove(this.cacheFile);
                }
            })
            .catch((error) => {
                logger.warn('Semantic search: Failed to remove legacy embedding cache file:', error);
            });
    }

    removeFromCache(filePath: string): void {
        const existed = this.chunkEmbeddingsCache.delete(filePath);
        this.cacheMetadata.delete(filePath);
        this.fileCentroidCache.delete(filePath);
        this.dirtyFilePaths.delete(filePath);
        this.removedFilePaths.add(filePath);
        if (existed) {
            this.bumpIndexVersion();
        }
    }

    /**
     * True when the configured model/scheme differs from the one the cached vectors
     * belong to. Search and indexing are paused until applyModelChange() runs.
     */
    hasPendingModelChange(): boolean {
        return fingerprintKey(getSettingsFingerprint(this.settings)) !== this.activeFingerprintKey;
    }

    /**
     * Drop vectors from the previous model and adopt the configured one. Deferred from
     * updateSettings so a half-typed model name doesn't wipe the index.
     * Returns true if vectors were invalidated.
     */
    applyModelChange(): boolean {
        const nextFingerprintKey = fingerprintKey(getSettingsFingerprint(this.settings));
        if (nextFingerprintKey === this.activeFingerprintKey) {
            return false;
        }

        const previousFingerprintKey = this.activeFingerprintKey;
        this.activeFingerprintKey = nextFingerprintKey;
        this.invalidateAllEmbeddings(`embedding model changed: ${previousFingerprintKey} -> ${nextFingerprintKey}`);
        return true;
    }

    /**
     * Update settings for the embedding service.
     * Returns true if the embedding model/scheme now differs from the cached vectors.
     * Vectors are kept until applyModelChange() so reverting the model restores them.
     */
    updateSettings(newSettings: SemanticSearchSettings): boolean {
        this.settings = newSettings;

        if (this.provider && this.providerConfigKey !== getProviderConfigKey(newSettings)) {
            // Provider, model, precision or device changed: stop the old worker/connection.
            // In-flight requests are rejected as aborted; the next request creates the new provider.
            logger.info(`Semantic search: Embedding provider settings changed (${this.providerConfigKey} -> ${getProviderConfigKey(newSettings)})`);
            this.disposeProvider();
        }

        this.applyProviderConcurrency();
        logger.debug(`Semantic search: Settings updated - concurrency: ${newSettings.maxConcurrentRequests}, adaptive: ${newSettings.enableAdaptiveThrottling ?? true}`);

        if (!this.hasPendingModelChange()) {
            return false;
        }

        this.cancelPendingRequests('Embedding model changed');
        this.bumpIndexVersion();
        return true;
    }

    /** Stop all background work. Safe to call more than once; initialize() reopens. */
    close(): void {
        this.closed = true;
        this.cancelScheduledSave();
        this.staleFileListener = undefined;
        this.requestQueue.clear('Embedding service closed');
        this.disposeProvider();
        this.embeddingStore.close();
        this.embeddingStoreAvailable = false;
    }
}
