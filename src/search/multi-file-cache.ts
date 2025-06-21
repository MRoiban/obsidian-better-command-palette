import { Vault } from 'obsidian';
import { logger } from '../utils/logger';

/**
 * Base class for multi-file caching with size limits
 * Automatically splits cache across multiple files when size limits are exceeded
 */
export abstract class MultiFileCache<T> {
    protected vault: Vault;
    protected cacheDirectory: string;
    protected cacheBaseName: string;
    protected maxFileSize: number;
    protected cache: Map<string, T> = new Map();
    protected isInitialized = false;

    constructor(
        vault: Vault,
        cacheDirectory: string,
        cacheBaseName: string,
        maxFileSize: number = 4 * 1024 * 1024 // 4MB default
    ) {
        this.vault = vault;
        this.cacheDirectory = cacheDirectory;
        this.cacheBaseName = cacheBaseName;
        this.maxFileSize = maxFileSize;
    }

    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        try {
            // Ensure cache directory exists
            if (!await this.vault.adapter.exists(this.cacheDirectory)) {
                await this.vault.adapter.mkdir(this.cacheDirectory);
                logger.debug(`Multi-file cache: Created directory ${this.cacheDirectory}`);
            }

            await this.loadAllCacheFiles();
            this.isInitialized = true;
            logger.info(`Multi-file cache: Initialized with ${this.cache.size} entries`);
        } catch (error) {
            logger.error('Multi-file cache: Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Load all cache files from the cache directory
     */
    private async loadAllCacheFiles(): Promise<void> {
        try {
            const files = await this.vault.adapter.list(this.cacheDirectory);
            const cacheFiles = files.files
                .filter(file => file.startsWith(`${this.cacheDirectory}/${this.cacheBaseName}-`) && file.endsWith('.json'))
                .sort();

            logger.debug(`Multi-file cache: Found ${cacheFiles.length} cache files to load`);

            for (const filePath of cacheFiles) {
                await this.loadCacheFile(filePath);
            }
        } catch (error) {
            logger.warn('Multi-file cache: Error loading cache files:', error);
        }
    }

    /**
     * Load a single cache file
     */
    private async loadCacheFile(filePath: string): Promise<void> {
        try {
            if (await this.vault.adapter.exists(filePath)) {
                const content = await this.vault.adapter.read(filePath);
                const data = JSON.parse(content);
                
                if (this.validateCacheData(data)) {
                    await this.processCacheData(data);
                    logger.debug(`Multi-file cache: Loaded cache file ${filePath}`);
                } else {
                    logger.warn(`Multi-file cache: Invalid cache data in ${filePath}, skipping`);
                }
            }
        } catch (error) {
            logger.warn(`Multi-file cache: Failed to load cache file ${filePath}:`, error);
        }
    }

    /**
     * Save cache to multiple files based on size limits
     */
    async saveCache(): Promise<void> {
        if (!this.isInitialized) {
            throw new Error('Multi-file cache not initialized');
        }

        try {
            // Clear existing cache files
            await this.clearCacheFiles();

            // Group entries into files based on size
            const cacheFiles = await this.groupEntriesIntoFiles();
            
            // Save each file
            for (let i = 0; i < cacheFiles.length; i++) {
                const filePath = `${this.cacheDirectory}/${this.cacheBaseName}-${String(i + 1).padStart(3, '0')}.json`;
                const content = JSON.stringify(cacheFiles[i], null, 2);
                await this.vault.adapter.write(filePath, content);
                logger.debug(`Multi-file cache: Saved cache file ${filePath} (${content.length} bytes)`);
            }

            logger.info(`Multi-file cache: Saved ${this.cache.size} entries across ${cacheFiles.length} files`);
        } catch (error) {
            logger.error('Multi-file cache: Failed to save cache:', error);
            throw error;
        }
    }

    /**
     * Clear all existing cache files
     */
    private async clearCacheFiles(): Promise<void> {
        try {
            const files = await this.vault.adapter.list(this.cacheDirectory);
            const cacheFiles = files.files
                .filter(file => file.startsWith(`${this.cacheDirectory}/${this.cacheBaseName}-`) && file.endsWith('.json'));

            for (const filePath of cacheFiles) {
                await this.vault.adapter.remove(filePath);
                logger.debug(`Multi-file cache: Removed old cache file ${filePath}`);
            }
        } catch (error) {
            logger.warn('Multi-file cache: Error clearing cache files:', error);
        }
    }

    /**
     * Group cache entries into files based on size limits
     */
    private async groupEntriesIntoFiles(): Promise<any[]> {
        const files: any[] = [];
        let currentFile = this.createEmptyFileStructure();
        let currentSize = JSON.stringify(currentFile).length;

        for (const [key, value] of this.cache) {
            const entry = this.serializeEntry(key, value);
            const entrySize = JSON.stringify(entry).length;

            // If adding this entry would exceed the size limit, start a new file
            if (currentSize + entrySize > this.maxFileSize && this.getFileEntryCount(currentFile) > 0) {
                files.push(currentFile);
                currentFile = this.createEmptyFileStructure();
                currentSize = JSON.stringify(currentFile).length;
            }

            this.addEntryToFile(currentFile, key, entry);
            currentSize += entrySize;
        }

        // Add the last file if it has entries
        if (this.getFileEntryCount(currentFile) > 0) {
            files.push(currentFile);
        }

        return files;
    }

    /**
     * Get an entry from the cache
     */
    get(key: string): T | undefined {
        return this.cache.get(key);
    }

    /**
     * Set an entry in the cache
     */
    set(key: string, value: T): void {
        this.cache.set(key, value);
    }

    /**
     * Delete an entry from the cache
     */
    delete(key: string): void {
        this.cache.delete(key);
    }

    /**
     * Clear all cache entries
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Get cache size
     */
    size(): number {
        return this.cache.size;
    }

    /**
     * Check if cache has a key
     */
    has(key: string): boolean {
        return this.cache.has(key);
    }

    /**
     * Get all keys
     */
    keys(): IterableIterator<string> {
        return this.cache.keys();
    }

    /**
     * Get all values
     */
    values(): IterableIterator<T> {
        return this.cache.values();
    }

    /**
     * Get all entries
     */
    entries(): IterableIterator<[string, T]> {
        return this.cache.entries();
    }

    // Abstract methods to be implemented by subclasses
    protected abstract validateCacheData(data: any): boolean;
    protected abstract processCacheData(data: any): Promise<void>;
    protected abstract createEmptyFileStructure(): any;
    protected abstract serializeEntry(key: string, value: T): any;
    protected abstract addEntryToFile(file: any, key: string, entry: any): void;
    protected abstract getFileEntryCount(file: any): number;
} 