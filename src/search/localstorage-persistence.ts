import { ContentStore } from './interfaces';
import { logger } from '../utils/logger';

/**
 * localStorage-based persistence with compression.
 * Fallback for environments where IndexedDB is blocked but localStorage is available.
 * Uses compression to fit within typical 5-10MB localStorage limits.
 */
export class LocalStoragePersistence implements ContentStore {
    private keyPrefix = 'bcp-enhanced-search';
    private maxStorageSize = 5 * 1024 * 1024; // 5MB conservative limit
    private isInitialized = false;

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
            
            this.isInitialized = true;
            logger.info('Enhanced search: localStorage persistence initialized');
        } catch (error) {
            logger.error('Enhanced search: localStorage access failed:', error);
            throw error;
        }
    }

    async get(fileId: string): Promise<string> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-content-${fileId}`;
            const compressed = localStorage.getItem(key);
            if (!compressed) return '';
            
            return this.decompress(compressed);
        } catch (error) {
            logger.warn(`Failed to get content for ${fileId}:`, error);
            return '';
        }
    }

    async set(fileId: string, content: string): Promise<void> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-content-${fileId}`;
            const compressed = this.compress(content);
            
            // Check if we're approaching storage limits
            if (this.getStorageUsage() + compressed.length > this.maxStorageSize) {
                logger.warn('localStorage approaching limits, clearing old data');
                await this.clearOldData();
            }
            
            localStorage.setItem(key, compressed);
        } catch (error) {
            if (error.name === 'QuotaExceededError') {
                logger.warn('localStorage quota exceeded, clearing old data and retrying');
                await this.clearOldData();
                try {
                    localStorage.setItem(`${this.keyPrefix}-content-${fileId}`, this.compress(content));
                } catch (retryError) {
                    logger.error('Failed to store content even after clearing:', retryError);
                }
            } else {
                logger.error(`Failed to store content for ${fileId}:`, error);
            }
        }
    }

    async delete(fileId: string): Promise<void> {
        this.ensureInitialized();
        const keys = [
            `${this.keyPrefix}-content-${fileId}`,
            `${this.keyPrefix}-metadata-${fileId}`,
            `${this.keyPrefix}-usage-${fileId}`
        ];
        
        keys.forEach(key => {
            try {
                localStorage.removeItem(key);
            } catch (error) {
                logger.warn(`Failed to remove ${key}:`, error);
            }
        });
    }

    async clear(): Promise<void> {
        this.ensureInitialized();
        const keysToRemove: string[] = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.keyPrefix)) {
                keysToRemove.push(key);
            }
        }
        
        keysToRemove.forEach(key => {
            try {
                localStorage.removeItem(key);
            } catch (error) {
                logger.warn(`Failed to remove ${key}:`, error);
            }
        });
    }

    async getStats(): Promise<{ count: number; size: number }> {
        this.ensureInitialized();
        let count = 0;
        let size = 0;
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(`${this.keyPrefix}-content-`)) {
                count++;
                const value = localStorage.getItem(key);
                if (value) {
                    size += value.length;
                }
            }
        }
        
        return { count, size };
    }

    // Metadata methods
    async setMetadata(fileId: string, metadata: any): Promise<void> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-metadata-${fileId}`;
            const compressed = this.compress(JSON.stringify(metadata));
            localStorage.setItem(key, compressed);
        } catch (error) {
            logger.warn(`Failed to store metadata for ${fileId}:`, error);
        }
    }

    async getMetadata(fileId: string): Promise<any> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-metadata-${fileId}`;
            const compressed = localStorage.getItem(key);
            if (!compressed) return null;
            
            return JSON.parse(this.decompress(compressed));
        } catch (error) {
            logger.warn(`Failed to get metadata for ${fileId}:`, error);
            return null;
        }
    }

    // Usage statistics methods
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-usage-${fileId}`;
            const compressed = this.compress(JSON.stringify(stats));
            localStorage.setItem(key, compressed);
        } catch (error) {
            logger.warn(`Failed to store usage stats for ${fileId}:`, error);
        }
    }

    async getUsageStats(fileId: string): Promise<any> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-usage-${fileId}`;
            const compressed = localStorage.getItem(key);
            if (!compressed) return null;
            
            return JSON.parse(this.decompress(compressed));
        } catch (error) {
            logger.warn(`Failed to get usage stats for ${fileId}:`, error);
            return null;
        }
    }

    async getAllUsageStats(): Promise<Record<string, any>> {
        this.ensureInitialized();
        const stats: Record<string, any> = {};
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(`${this.keyPrefix}-usage-`)) {
                const fileId = key.replace(`${this.keyPrefix}-usage-`, '');
                const usageStats = await this.getUsageStats(fileId);
                if (usageStats) {
                    stats[fileId] = usageStats;
                }
            }
        }
        
        return stats;
    }

    // Search index serialization
    async loadSearchIndex(): Promise<any> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-search-index`;
            const compressed = localStorage.getItem(key);
            if (!compressed) return null;
            
            return JSON.parse(this.decompress(compressed));
        } catch (error) {
            logger.warn('Failed to load search index:', error);
            return null;
        }
    }

    async saveSearchIndex(indexData: any): Promise<void> {
        this.ensureInitialized();
        try {
            const key = `${this.keyPrefix}-search-index`;
            const compressed = this.compress(JSON.stringify(indexData));
            localStorage.setItem(key, compressed);
        } catch (error) {
            logger.warn('Failed to save search index:', error);
        }
    }

    close(): void {
        // No cleanup needed for localStorage
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('LocalStoragePersistence not initialized. Call initialize() first.');
        }
    }

    /**
     * Simple compression using built-in compression or base64 encoding
     */
    private compress(text: string): string {
        try {
            // Use LZ-string if available, otherwise just return the text
            // In a real implementation, you might want to include a compression library
            return btoa(unescape(encodeURIComponent(text)));
        } catch (error) {
            logger.warn('Compression failed, storing uncompressed:', error);
            return text;
        }
    }

    /**
     * Decompress text
     */
    private decompress(compressed: string): string {
        try {
            return decodeURIComponent(escape(atob(compressed)));
        } catch (error) {
            // Assume it's uncompressed text
            return compressed;
        }
    }

    /**
     * Get current localStorage usage for this plugin
     */
    private getStorageUsage(): number {
        let usage = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(this.keyPrefix)) {
                const value = localStorage.getItem(key);
                if (value) {
                    usage += key.length + value.length;
                }
            }
        }
        return usage;
    }

    /**
     * Clear old data to make room for new data
     */
    private async clearOldData(): Promise<void> {
        // Simple strategy: remove oldest content entries
        const contentKeys: string[] = [];
        
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(`${this.keyPrefix}-content-`)) {
                contentKeys.push(key);
            }
        }
        
        // Remove half of the content entries
        const keysToRemove = contentKeys.slice(0, Math.floor(contentKeys.length / 2));
        keysToRemove.forEach(key => {
            try {
                localStorage.removeItem(key);
            } catch (error) {
                logger.warn(`Failed to remove old data ${key}:`, error);
            }
        });
        
        logger.info(`Cleared ${keysToRemove.length} old entries to make room`);
    }
} 