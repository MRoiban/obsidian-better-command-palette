import { Vault } from 'obsidian';
import { MultiFileCache } from './multi-file-cache';
import { ContentStore } from './interfaces';
import { logger } from '../utils/logger';

/**
 * Multi-file cache for enhanced search content storage
 * Replaces localStorage persistence with multi-file approach
 */
export class MultiFileContentCache extends MultiFileCache<{
    content: string;
    metadata?: any;
    usageStats?: any;
}> implements ContentStore {
    private searchIndex: any = null;

    constructor(vault: Vault, cacheDirectory: string = '.obsidian/plugins/obsidian-better-command-palette/content-cache') {
        super(vault, cacheDirectory, 'content', 5 * 1024 * 1024); // 5MB per file
    }

    // ContentStore interface implementation

    async get(fileId: string): Promise<string> {
        const entry = super.get(fileId);
        return entry?.content || '';
    }

    async set(fileId: string, content: string): Promise<void> {
        const existing = super.get(fileId);
        super.set(fileId, {
            content,
            metadata: existing?.metadata,
            usageStats: existing?.usageStats
        });
    }

    async delete(fileId: string): Promise<void> {
        super.delete(fileId);
    }

    async clear(): Promise<void> {
        super.clear();
        this.searchIndex = null;
    }

    async getStats(): Promise<{ count: number; size: number }> {
        let totalSize = 0;
        for (const entry of this.values()) {
            totalSize += entry.content.length;
        }
        return {
            count: this.size(),
            size: totalSize
        };
    }

    // Metadata methods
    async setMetadata(fileId: string, metadata: any): Promise<void> {
        const existing = super.get(fileId);
        super.set(fileId, {
            content: existing?.content || '',
            metadata,
            usageStats: existing?.usageStats
        });
    }

    async getMetadata(fileId: string): Promise<any> {
        const entry = super.get(fileId);
        return entry?.metadata || null;
    }

    // Usage statistics methods
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        const existing = super.get(fileId);
        super.set(fileId, {
            content: existing?.content || '',
            metadata: existing?.metadata,
            usageStats: stats
        });
    }

    async getUsageStats(fileId: string): Promise<any> {
        const entry = super.get(fileId);
        return entry?.usageStats || null;
    }

    async getAllUsageStats(): Promise<Record<string, any>> {
        const stats: Record<string, any> = {};
        for (const [fileId, entry] of this.entries()) {
            if (entry.usageStats) {
                stats[fileId] = entry.usageStats;
            }
        }
        return stats;
    }

    // Search index serialization
    async loadSearchIndex(): Promise<any> {
        return this.searchIndex;
    }

    async saveSearchIndex(indexData: any): Promise<void> {
        this.searchIndex = indexData;
    }

    close(): void {
        // No cleanup needed for file-based storage
    }

    // Implementation of abstract methods from MultiFileCache

    protected validateCacheData(data: any): boolean {
        return data && 
               typeof data.version === 'string' && 
               data.version === '1.0.0' &&
               typeof data.lastUpdated === 'number' &&
               data.entries &&
               typeof data.entries === 'object';
    }

    protected async processCacheData(data: any): Promise<void> {
        let loadedCount = 0;

        for (const [fileId, entryData] of Object.entries(data.entries)) {
            if (typeof entryData === 'object' && entryData !== null) {
                const entry = entryData as any;
                super.set(fileId, {
                    content: entry.content || '',
                    metadata: entry.metadata,
                    usageStats: entry.usageStats
                });
                loadedCount++;
            }
        }

        logger.debug(`Multi-file content cache: Loaded ${loadedCount} entries`);
    }

    protected createEmptyFileStructure(): any {
        return {
            version: '1.0.0',
            lastUpdated: Date.now(),
            entries: {}
        };
    }

    protected serializeEntry(key: string, value: {
        content: string;
        metadata?: any;
        usageStats?: any;
    }): any {
        return {
            content: value.content,
            metadata: value.metadata,
            usageStats: value.usageStats
        };
    }

    protected addEntryToFile(file: any, key: string, entry: any): void {
        file.entries[key] = entry;
    }

    protected getFileEntryCount(file: any): number {
        return Object.keys(file.entries || {}).length;
    }

    /**
     * Legacy compatibility method for migrating from localStorage
     */
    async migrateLegacyData(keyPrefix: string): Promise<void> {
        try {
            if (typeof localStorage === 'undefined') {
                return;
            }

            logger.info('Multi-file content cache: Migrating from localStorage');
            let migratedCount = 0;

            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith(keyPrefix)) {
                    const value = localStorage.getItem(key);
                    if (value) {
                        const fileId = key.replace(keyPrefix, '');
                        
                        // Try to decompress if it was compressed
                        let content = value;
                        try {
                            content = decodeURIComponent(escape(atob(value)));
                        } catch {
                            // If decompression fails, use original value
                        }

                        await this.set(fileId, content);
                        migratedCount++;
                    }
                }
            }

            if (migratedCount > 0) {
                await this.saveCache();
                logger.info(`Multi-file content cache: Migrated ${migratedCount} entries from localStorage`);
            }
        } catch (error) {
            logger.error('Multi-file content cache: Failed to migrate from localStorage:', error);
        }
    }
} 