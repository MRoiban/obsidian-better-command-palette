import { Vault, TFile } from 'obsidian';
import { MultiFileCache } from '../multi-file-cache';
import { EmbeddingCache } from './types';
import { logger } from '../../utils/logger';

/**
 * Multi-file cache specifically for semantic search embeddings
 * Handles embedding storage across multiple files with size limits
 */
export class MultiFileEmbeddingCache extends MultiFileCache<{
    embedding: Float32Array;
    metadata: {
        lastModified: number;
        contentHash: string;
        chunks: number;
    };
}> {
    private cacheMetadata: Map<string, any> = new Map();

    constructor(vault: Vault, cacheDirectory: string = '.obsidian/plugins/obsidian-better-command-palette/semantic-cache') {
        super(vault, cacheDirectory, 'embeddings', 5 * 1024 * 1024); // 5MB per file
    }

    /**
     * Get embedding for a file path
     */
    getEmbedding(filePath: string): Float32Array | undefined {
        const entry = this.get(filePath);
        return entry?.embedding;
    }

    /**
     * Set embedding with metadata
     */
    setEmbedding(filePath: string, embedding: Float32Array, metadata: {
        lastModified: number;
        contentHash: string;
        chunks: number;
    }): void {
        this.set(filePath, { embedding, metadata });
        this.cacheMetadata.set(filePath, metadata);
    }

    /**
     * Get metadata for a file path
     */
    getMetadata(filePath: string): any {
        const entry = this.get(filePath);
        return entry?.metadata || this.cacheMetadata.get(filePath);
    }

    /**
     * Check if file is up to date in cache
     */
    isFileUpToDate(file: TFile, cachedData?: any): boolean {
        const metadata = cachedData || this.getMetadata(file.path);
        if (!metadata) return false;
        return file.stat.mtime <= metadata.lastModified;
    }

    /**
     * Remove embedding from cache
     */
    removeEmbedding(filePath: string): void {
        this.delete(filePath);
        this.cacheMetadata.delete(filePath);
    }

    /**
     * Clear all embeddings and metadata
     */
    clearAll(): void {
        this.clear();
        this.cacheMetadata.clear();
    }

    /**
     * Get stats about the cache
     */
    getStats(): { count: number; totalSize: number } {
        let totalSize = 0;
        for (const entry of this.values()) {
            totalSize += entry.embedding.length * 4; // Float32Array uses 4 bytes per element
        }
        return {
            count: this.size(),
            totalSize
        };
    }

    // Implementation of abstract methods from MultiFileCache

    protected validateCacheData(data: any): boolean {
        return data && 
               typeof data.version === 'string' && 
               data.version === '1.0.0' &&
               typeof data.lastUpdated === 'number' &&
               data.embeddings &&
               typeof data.embeddings === 'object';
    }

    protected async processCacheData(data: EmbeddingCache): Promise<void> {
        let loadedCount = 0;
        let skippedCount = 0;

        for (const [path, embeddingData] of Object.entries(data.embeddings)) {
            const file = this.vault.getAbstractFileByPath(path) as TFile;

            if (!file) {
                logger.debug(`Multi-file embedding cache: File ${path} no longer exists, skipping`);
                skippedCount++;
                continue;
            }

            if (this.isFileUpToDate(file, embeddingData)) {
                // Convert regular array back to Float32Array for memory efficiency
                const embedding = new Float32Array(embeddingData.embedding);
                const metadata = {
                    lastModified: embeddingData.lastModified,
                    contentHash: embeddingData.contentHash,
                    chunks: embeddingData.chunks || 1
                };

                this.set(path, { embedding, metadata });
                this.cacheMetadata.set(path, metadata);
                loadedCount++;
                logger.debug(`Multi-file embedding cache: Loaded embedding for ${path}`);
            } else {
                logger.debug(`Multi-file embedding cache: File ${path} is newer than cache, skipping`);
                skippedCount++;
            }
        }

        logger.debug(`Multi-file embedding cache: Loaded ${loadedCount} embeddings, skipped ${skippedCount}`);
    }

    protected createEmptyFileStructure(): any {
        return {
            version: '1.0.0',
            lastUpdated: Date.now(),
            embeddings: {}
        };
    }

    protected serializeEntry(key: string, value: {
        embedding: Float32Array;
        metadata: {
            lastModified: number;
            contentHash: string;
            chunks: number;
        };
    }): any {
        return {
            embedding: Array.from(value.embedding), // Convert Float32Array to regular array for JSON
            lastModified: value.metadata.lastModified,
            contentHash: value.metadata.contentHash,
            chunks: value.metadata.chunks
        };
    }

    protected addEntryToFile(file: any, key: string, entry: any): void {
        file.embeddings[key] = entry;
    }

    /**
     * Legacy compatibility method for migrating from single-file cache
     */
    async migrateLegacyCache(legacyCacheFile: string): Promise<void> {
        try {
            if (await this.vault.adapter.exists(legacyCacheFile)) {
                logger.info('Multi-file embedding cache: Migrating from legacy single-file cache');
                
                const content = await this.vault.adapter.read(legacyCacheFile);
                const legacyData = JSON.parse(content);
                
                if (this.validateCacheData(legacyData)) {
                    await this.processCacheData(legacyData);
                    await this.saveCache();
                    
                    // Remove legacy cache file after successful migration
                    await this.vault.adapter.remove(legacyCacheFile);
                    logger.info('Multi-file embedding cache: Legacy cache migrated and removed');
                }
            }
        } catch (error) {
            logger.error('Multi-file embedding cache: Failed to migrate legacy cache:', error);
        }
    }
} 