import { ContentStore } from './interfaces';
import { MultiFileContentCache } from './multi-file-content-cache';
import { logger } from '../utils/logger';

/**
 * Multi-file localStorage-based persistence without compression.
 * Fallback for environments where IndexedDB is blocked but localStorage is available.
 * Uses multi-file approach to handle large datasets efficiently.
 */
export class LocalStoragePersistence implements ContentStore {
    private keyPrefix = 'bcp-enhanced-search';
    private contentCache: MultiFileContentCache;
    private isInitialized = false;

    constructor(vault?: any) {
        // For localStorage mode, we simulate the vault interface
        const mockVault = vault || {
            adapter: {
                exists: (path: string) => Promise.resolve(false),
                read: (path: string) => Promise.resolve('{}'),
                write: (path: string, data: string) => Promise.resolve(),
                remove: (path: string) => Promise.resolve(),
                mkdir: (path: string) => Promise.resolve(),
                list: (path: string) => Promise.resolve({ files: [], folders: [] })
            }
        };
        
        this.contentCache = new MultiFileContentCache(mockVault, `${this.keyPrefix}/cache`);
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        // Check if localStorage is available
        if (typeof localStorage === 'undefined') {
            throw new Error('localStorage is not available');
        }

        try {
            // Test localStorage access
            const testKey = `${this.keyPrefix}-test`;
            localStorage.setItem(testKey, 'test');
            localStorage.removeItem(testKey);
            
            // Initialize the multi-file cache
            await this.contentCache.initialize();
            
            // Migrate legacy data if it exists
            await this.contentCache.migrateLegacyData(`${this.keyPrefix}-content-`);
            
            this.isInitialized = true;
            logger.info('Enhanced search: Multi-file localStorage persistence initialized');
        } catch (error) {
            logger.error('Enhanced search: localStorage access failed:', error);
            throw error;
        }
    }

    async get(fileId: string): Promise<string> {
        this.ensureInitialized();
        try {
            return await this.contentCache.get(fileId);
        } catch (error) {
            logger.warn(`Failed to get content for ${fileId}:`, error);
            return '';
        }
    }

    async set(fileId: string, content: string): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.set(fileId, content);
            
            // Periodically save the cache
            if (Math.random() < 0.1) { // 10% chance to save on each set
                await this.contentCache.saveCache();
            }
        } catch (error) {
            logger.error(`Failed to store content for ${fileId}:`, error);
        }
    }

    async delete(fileId: string): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.delete(fileId);
        } catch (error) {
            logger.warn(`Failed to delete ${fileId}:`, error);
        }
    }

    async clear(): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.clear();
        } catch (error) {
            logger.warn('Failed to clear cache:', error);
        }
    }

    async getStats(): Promise<{ count: number; size: number }> {
        this.ensureInitialized();
        try {
            return await this.contentCache.getStats();
        } catch (error) {
            logger.warn('Failed to get stats:', error);
            return { count: 0, size: 0 };
        }
    }

    // Metadata methods
    async setMetadata(fileId: string, metadata: any): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.setMetadata(fileId, metadata);
        } catch (error) {
            logger.warn(`Failed to store metadata for ${fileId}:`, error);
        }
    }

    async getMetadata(fileId: string): Promise<any> {
        this.ensureInitialized();
        try {
            return await this.contentCache.getMetadata(fileId);
        } catch (error) {
            logger.warn(`Failed to get metadata for ${fileId}:`, error);
            return null;
        }
    }

    // Usage statistics methods
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.setUsageStats(fileId, stats);
        } catch (error) {
            logger.warn(`Failed to store usage stats for ${fileId}:`, error);
        }
    }

    async getUsageStats(fileId: string): Promise<any> {
        this.ensureInitialized();
        try {
            return await this.contentCache.getUsageStats(fileId);
        } catch (error) {
            logger.warn(`Failed to get usage stats for ${fileId}:`, error);
            return null;
        }
    }

    async getAllUsageStats(): Promise<Record<string, any>> {
        this.ensureInitialized();
        try {
            return await this.contentCache.getAllUsageStats();
        } catch (error) {
            logger.warn('Failed to get all usage stats:', error);
            return {};
        }
    }

    // Search index serialization
    async loadSearchIndex(): Promise<any> {
        this.ensureInitialized();
        try {
            return await this.contentCache.loadSearchIndex();
        } catch (error) {
            logger.warn('Failed to load search index:', error);
            return null;
        }
    }

    async saveSearchIndex(indexData: any): Promise<void> {
        this.ensureInitialized();
        try {
            await this.contentCache.saveSearchIndex(indexData);
        } catch (error) {
            logger.warn('Failed to save search index:', error);
        }
    }

    close(): void {
        // Save cache before closing
        if (this.isInitialized) {
            this.contentCache.saveCache().catch(error => {
                logger.warn('Failed to save cache on close:', error);
            });
        }
        this.contentCache.close();
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('LocalStoragePersistence not initialized. Call initialize() first.');
        }
    }
} 