import { Plugin } from 'obsidian';
import { ContentStore } from './interfaces';
import { logger } from '../utils/logger';

/**
 * Obsidian plugin data storage implementation.
 * Uses Obsidian's native loadData/saveData which works on all platforms including mobile.
 * Data is stored in the plugin's data folder and syncs with the vault.
 */
export class ObsidianPersistence implements ContentStore {
    private plugin: Plugin;
    private dataKey = 'enhanced-search-data';
    private data: {
        content: Record<string, string>;
        metadata: Record<string, any>;
        usage: Record<string, any>;
        searchIndex: any;
    } = {
        content: {},
        metadata: {},
        usage: {},
        searchIndex: null
    };
    private isInitialized = false;
    private saveTimeout: NodeJS.Timeout | null = null;

    constructor(plugin: Plugin) {
        this.plugin = plugin;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            // Load existing data from Obsidian's plugin storage
            const savedData = await this.plugin.loadData();
            if (savedData && savedData[this.dataKey]) {
                this.data = { ...this.data, ...savedData[this.dataKey] };
                logger.info(`Enhanced search: Loaded ${Object.keys(this.data.content).length} cached files from Obsidian storage`);
            }
            
            this.isInitialized = true;
            logger.info('Enhanced search: Obsidian persistence initialized successfully');
        } catch (error) {
            logger.error('Enhanced search: Failed to initialize Obsidian persistence:', error);
            throw error;
        }
    }

    async get(fileId: string): Promise<string> {
        this.ensureInitialized();
        return this.data.content[fileId] || '';
    }

    async set(fileId: string, content: string): Promise<void> {
        this.ensureInitialized();
        this.data.content[fileId] = content;
        this.scheduleSave();
    }

    async delete(fileId: string): Promise<void> {
        this.ensureInitialized();
        delete this.data.content[fileId];
        delete this.data.metadata[fileId];
        delete this.data.usage[fileId];
        this.scheduleSave();
    }

    async clear(): Promise<void> {
        this.ensureInitialized();
        this.data = {
            content: {},
            metadata: {},
            usage: {},
            searchIndex: null
        };
        await this.forceSave();
    }

    async getStats(): Promise<{ count: number; size: number }> {
        this.ensureInitialized();
        let size = 0;
        const content = this.data.content;
        for (const text of Object.values(content)) {
            size += text.length;
        }
        return { count: Object.keys(content).length, size };
    }

    // Metadata methods
    async setMetadata(fileId: string, metadata: any): Promise<void> {
        this.ensureInitialized();
        this.data.metadata[fileId] = metadata;
        this.scheduleSave();
    }

    async getMetadata(fileId: string): Promise<any> {
        this.ensureInitialized();
        return this.data.metadata[fileId] || null;
    }

    // Usage statistics methods
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        this.ensureInitialized();
        this.data.usage[fileId] = stats;
        this.scheduleSave();
    }

    async getUsageStats(fileId: string): Promise<any> {
        this.ensureInitialized();
        return this.data.usage[fileId] || null;
    }

    async getAllUsageStats(): Promise<Record<string, any>> {
        this.ensureInitialized();
        return { ...this.data.usage };
    }

    // Search index serialization
    async loadSearchIndex(): Promise<any> {
        this.ensureInitialized();
        return this.data.searchIndex;
    }

    async saveSearchIndex(indexData: any): Promise<void> {
        this.ensureInitialized();
        this.data.searchIndex = indexData;
        this.scheduleSave();
    }

    close(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.forceSave();
        }
    }

    private ensureInitialized(): void {
        if (!this.isInitialized) {
            throw new Error('ObsidianPersistence not initialized. Call initialize() first.');
        }
    }

    /**
     * Schedule a save operation (debounced to avoid excessive writes)
     */
    private scheduleSave(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        
        // Save after 2 seconds of no changes
        this.saveTimeout = setTimeout(() => {
            this.forceSave();
        }, 2000);
    }

    /**
     * Force immediate save to Obsidian's plugin storage
     */
    private async forceSave(): Promise<void> {
        try {
            // Load current plugin data to avoid overwriting other data
            const currentData = await this.plugin.loadData() || {};
            currentData[this.dataKey] = this.data;
            
            await this.plugin.saveData(currentData);
            
            if (this.saveTimeout) {
                clearTimeout(this.saveTimeout);
                this.saveTimeout = null;
            }
        } catch (error) {
            logger.error('Enhanced search: Failed to save data to Obsidian storage:', error);
        }
    }
} 