import { UsageTracker } from './interfaces';
import { logger } from '../utils/logger';

/**
 * Stored data format for file access tracking
 */
interface FileAccessData {
    count: number;
    lastOpened: number;
    firstOpened: number;
}

/**
 * Bounce tracking data for pogo-sticking detection
 */
interface BounceData {
    /** Number of bounces (quick returns to search) */
    bounceCount: number;
    /** Total opens for this file (for calculating bounce rate) */
    openCount: number;
    /** Timestamp of last bounce */
    lastBounce: number;
}

/**
 * Storage format for persistence
 */
interface StorageData {
    version: string;
    fileAccess: Array<{ path: string } & FileAccessData>;
    bounceData?: Array<{ path: string } & BounceData>;
}

/**
 * Usage tracker implementation that monitors file access patterns
 * and search behavior to improve ranking and user experience.
 * 
 * Enhanced with pogo-sticking detection to identify poor search results.
 */
export class FileUsageTracker implements UsageTracker {
    private fileAccess = new Map<string, FileAccessData>();

    private searchHistory: Array<{ query: string; timestamp: number; selectedPath?: string }> = [];

    private maxSearchHistory = 1000;

    private storageKey = 'better-command-palette-usage';

    private saveTimeoutId: number | null = null;

    private readonly SAVE_DEBOUNCE_MS = 1500;

    /** Storage version for migrations */
    private readonly STORAGE_VERSION = '2.0.0';

    /** Alias for backwards compatibility */
    private readonly STORAGE_KEY = this.storageKey;

    /**
     * Bounce tracking for pogo-sticking detection.
     * Key: file path, Value: bounce statistics
     */
    private bounceData = new Map<string, BounceData>();

    /**
     * Tracks the last file opened from a search result.
     * Used to detect when user quickly returns to search (pogo-sticking).
     */
    private lastSearchResult: { path: string; timestamp: number; query: string } | null = null;

    /** Threshold in ms for detecting a bounce (quick return to search) */
    private readonly BOUNCE_THRESHOLD_MS = 5000;

    constructor() {
        this.loadFromStorage();
    }

    /**
     * Record when a file is opened
     */
    recordFileOpen(path: string): void {
        if (!path || typeof path !== 'string') {
            return;
        }

        const now = Date.now();
        const existing = this.fileAccess.get(path);

        if (existing) {
            existing.count++;
            existing.lastOpened = now;
        } else {
            this.fileAccess.set(path, {
                count: 1,
                lastOpened: now,
                firstOpened: now,
            });
        }

        this.queueSave();
    }

    /**
     * Record when a file is opened from a search result.
     * This enables pogo-sticking detection when the user returns to search quickly.
     */
    recordSearchResultOpen(path: string, query: string): void {
        this.recordFileOpen(path);

        this.lastSearchResult = {
            path,
            query,
            timestamp: Date.now(),
        };

        // Track opens for bounce rate calculation
        const bounce = this.bounceData.get(path) ?? {
            bounceCount: 0,
            openCount: 0,
            lastBounce: 0,
        };
        bounce.openCount++;
        this.bounceData.set(path, bounce);
    }

    /**
     * Record when the search modal is opened.
     * If this happens shortly after opening a file from search,
     * it indicates a "bounce" (pogo-sticking).
     */
    recordSearchModalOpen(): void {
        if (!this.lastSearchResult) {
            return;
        }

        const now = Date.now();
        const timeSinceOpen = now - this.lastSearchResult.timestamp;

        if (timeSinceOpen < this.BOUNCE_THRESHOLD_MS) {
            // This is a bounce - user returned to search quickly
            const path = this.lastSearchResult.path;
            const bounce = this.bounceData.get(path) ?? {
                bounceCount: 0,
                openCount: 1,
                lastBounce: 0,
            };

            bounce.bounceCount++;
            bounce.lastBounce = now;
            this.bounceData.set(path, bounce);

            logger.debug(`Bounce detected for ${path} (returned after ${timeSinceOpen}ms)`);
            this.queueSave();
        }

        // Clear the tracking
        this.lastSearchResult = null;
    }

    /**
     * Get the bounce score for a file (0-1).
     * Higher score means the file has more bounces relative to opens.
     */
    getBounceScore(path: string): number {
        const data = this.bounceData.get(path);
        if (!data || data.openCount === 0) {
            return 0;
        }

        // Bounce rate: bounces / opens, capped at 1
        const bounceRate = Math.min(data.bounceCount / data.openCount, 1);

        // Apply decay based on time since last bounce (stale bounces matter less)
        const now = Date.now();
        const daysSinceLastBounce = (now - data.lastBounce) / (1000 * 60 * 60 * 24);
        const decayFactor = Math.exp(-daysSinceLastBounce / 14); // 14-day half-life

        return bounceRate * decayFactor;
    }

    /**
     * Get files with highest bounce rates (potential poor search results)
     */
    getHighBounceFiles(limit = 10): Array<{ path: string; bounceRate: number; bounceCount: number }> {
        return Array.from(this.bounceData.entries())
            .filter(([, data]) => data.openCount >= 3) // Only files with enough data
            .map(([path, data]) => ({
                path,
                bounceRate: data.bounceCount / data.openCount,
                bounceCount: data.bounceCount,
            }))
            .sort((a, b) => b.bounceRate - a.bounceRate)
            .slice(0, limit);
    }

    /**
     * Record when a search is performed
     */
    recordSearch(query: string, selectedPath?: string): void {
        if (!query || typeof query !== 'string') {
            return;
        }

        const searchRecord = {
            query: query.trim(),
            timestamp: Date.now(),
            selectedPath,
        };

        this.searchHistory.push(searchRecord);

        // Trim history if it gets too long
        if (this.searchHistory.length > this.maxSearchHistory) {
            this.searchHistory = this.searchHistory.slice(-this.maxSearchHistory);
        }

        this.queueSave();
    }

    /**
     * Record when a file is created
     */
    recordFileCreate(path: string): void {
        // Creating a file is like opening it for the first time
        this.recordFileOpen(path);
    }

    /**
     * Get usage score for a file (normalized 0-1)
     */
    getUsageScore(path: string): number {
        const access = this.fileAccess.get(path);
        if (!access) {
            return 0;
        }

        // Apply logarithmic scaling to prevent very high usage files from dominating
        const rawScore = Math.log(1 + access.count);
        const maxScore = Math.log(1 + this.getMaxUsageCount());

        return maxScore > 0 ? rawScore / maxScore : 0;
    }

    /**
     * Get recency score for a file (normalized 0-1)
     */
    getRecencyScore(path: string): number {
        const access = this.fileAccess.get(path);
        if (!access) {
            return 0;
        }

        const now = Date.now();
        const dayInMs = 24 * 60 * 60 * 1000;
        const timeDiff = now - access.lastOpened;

        // Exponential decay with 7-day half-life
        const halfLife = 7 * dayInMs;
        return Math.exp(-timeDiff / halfLife);
    }

    /**
     * Get the last opened timestamp for a file
     */
    getLastOpened(path: string): number | undefined {
        const access = this.fileAccess.get(path);
        return access?.lastOpened;
    }

    /**
     * Get search history with optional limit
     */
    getSearchHistory(limit?: number): Array<{ query: string; timestamp: number; selectedPath?: string }> {
        const history = [...this.searchHistory].reverse(); // Most recent first
        return limit ? history.slice(0, limit) : history;
    }

    /**
     * Get frequently searched queries
     */
    getFrequentQueries(limit = 10): Array<{ query: string; count: number; lastUsed: number }> {
        const queryMap = new Map<string, { count: number; lastUsed: number }>();

        this.searchHistory.forEach((search) => {
            const existing = queryMap.get(search.query);
            if (existing) {
                existing.count++;
                existing.lastUsed = Math.max(existing.lastUsed, search.timestamp);
            } else {
                queryMap.set(search.query, {
                    count: 1,
                    lastUsed: search.timestamp,
                });
            }
        });

        return Array.from(queryMap.entries())
            .map(([query, data]) => ({ query, ...data }))
            .sort((a, b) => b.count - a.count || b.lastUsed - a.lastUsed)
            .slice(0, limit);
    }

    /**
     * Get recently accessed files
     */
    getRecentFiles(limit = 10): Array<{ path: string; lastOpened: number; count: number }> {
        return Array.from(this.fileAccess.entries())
            .map(([path, data]) => ({ path, lastOpened: data.lastOpened, count: data.count }))
            .sort((a, b) => b.lastOpened - a.lastOpened)
            .slice(0, limit);
    }

    /**
     * Get most frequently accessed files
     */
    getFrequentFiles(limit = 10): Array<{ path: string; count: number; lastOpened: number }> {
        return Array.from(this.fileAccess.entries())
            .map(([path, data]) => ({ path, count: data.count, lastOpened: data.lastOpened }))
            .sort((a, b) => b.count - a.count || b.lastOpened - a.lastOpened)
            .slice(0, limit);
    }

    /**
     * Get files that haven't been accessed recently
     */
    getStaleFiles(daysSinceAccess = 30): Array<{ path: string; lastOpened: number; count: number }> {
        const cutoff = Date.now() - (daysSinceAccess * 24 * 60 * 60 * 1000);

        return Array.from(this.fileAccess.entries())
            .filter(([path, data]) => data.lastOpened < cutoff)
            .map(([path, data]) => ({ path, lastOpened: data.lastOpened, count: data.count }))
            .sort((a, b) => a.lastOpened - b.lastOpened);
    }

    /**
     * Reset all usage data
     */
    async reset(): Promise<void> {
        this.fileAccess.clear();
        this.searchHistory = [];
        this.bounceData.clear();
        this.lastSearchResult = null;
        this.flushPendingSave();
        this.saveToStorage();
    }

    /**
     * Reset usage data for a specific file
     */
    resetFileUsage(path: string): void {
        this.fileAccess.delete(path);
        this.bounceData.delete(path);
        this.queueSave();
    }

    /**
     * Get usage statistics
     */
    async getStats(): Promise<{ totalOpens: number; totalSearches: number; uniqueFiles: number }> {
        const totalOpens = Array.from(this.fileAccess.values())
            .reduce((sum, data) => sum + data.count, 0);

        return {
            totalOpens,
            totalSearches: this.searchHistory.length,
            uniqueFiles: this.fileAccess.size,
        };
    }

    /**
     * Get the maximum usage count for normalization
     */
    private getMaxUsageCount(): number {
        let max = 0;
        for (const data of this.fileAccess.values()) {
            max = Math.max(max, data.count);
        }
        return max || 1; // Avoid division by zero
    }

    /**
     * Save data to localStorage
     */
    private saveToStorage(): void {
        try {
            // Explicitly extract only primitive values to avoid circular references
            const fileAccessArray: Array<{ path: string } & FileAccessData> = [];
            for (const [path, access] of this.fileAccess.entries()) {
                if (typeof path === 'string') {
                    fileAccessArray.push({
                        path,
                        count: Number(access.count) || 0,
                        lastOpened: Number(access.lastOpened) || 0,
                        firstOpened: Number(access.firstOpened) || 0,
                    });
                }
            }

            const bounceDataArray: Array<{ path: string } & BounceData> = [];
            for (const [path, bounce] of this.bounceData.entries()) {
                if (typeof path === 'string') {
                    bounceDataArray.push({
                        path,
                        bounceCount: Number(bounce.bounceCount) || 0,
                        openCount: Number(bounce.openCount) || 0,
                        lastBounce: Number(bounce.lastBounce) || 0,
                    });
                }
            }

            const data: StorageData = {
                version: this.STORAGE_VERSION,
                fileAccess: fileAccessArray,
                bounceData: bounceDataArray,
            };

            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
        } catch (error) {
            logger.error('Failed to save usage data to localStorage:', error);
        }
    }

    /**
     * Load data from localStorage
     */
    private loadFromStorage(): void {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            if (!stored) {
                return;
            }

            const data: StorageData = JSON.parse(stored);

            // Check version compatibility - allow v1.x to migrate to v2.x
            const majorVersion = data.version?.split('.')[0];
            const currentMajor = this.STORAGE_VERSION.split('.')[0];
            if (majorVersion && majorVersion !== currentMajor && majorVersion !== '1') {
                logger.debug('Usage data version mismatch, resetting data');
                return;
            }

            // Load file access data
            if (data.fileAccess) {
                for (const item of data.fileAccess) {
                    this.fileAccess.set(item.path, {
                        count: item.count,
                        lastOpened: item.lastOpened,
                        firstOpened: item.firstOpened,
                    });
                }
            }

            // Load bounce data (new in v2)
            if (data.bounceData) {
                for (const item of data.bounceData) {
                    this.bounceData.set(item.path, {
                        bounceCount: item.bounceCount,
                        openCount: item.openCount,
                        lastBounce: item.lastBounce,
                    });
                }
            }
        } catch (error) {
            logger.error('Failed to load usage data from localStorage:', error);
        }
    }

    /**
     * Export usage data for backup
     */
    exportData(): any {
        return {
            fileAccess: Array.from(this.fileAccess.entries()),
            searchHistory: this.searchHistory,
            version: '1.0.0',
            exportDate: Date.now(),
        };
    }

    /**
     * Import usage data from backup
     */
    importData(data: any): void {
        try {
            if (data.version && data.fileAccess && data.searchHistory) {
                this.fileAccess = new Map(data.fileAccess);
                this.searchHistory = data.searchHistory;
                this.flushPendingSave();
                this.saveToStorage();
            } else {
                throw new Error('Invalid data format');
            }
        } catch (error) {
            logger.error('Failed to import usage data:', error);
            throw error;
        }
    }

    /**
     * Get data size estimation
     */
    getDataSize(): { fileAccessSize: number; searchHistorySize: number; totalSize: number } {
        const fileAccessSize = this.fileAccess.size * 100; // Rough estimate
        const searchHistorySize = this.searchHistory.length * 80; // Rough estimate

        return {
            fileAccessSize,
            searchHistorySize,
            totalSize: fileAccessSize + searchHistorySize,
        };
    }

    private queueSave(): void {
        if (this.saveTimeoutId !== null) {
            return;
        }

        const schedule = (typeof window !== 'undefined' ? window.setTimeout : setTimeout) as unknown as (handler: () => void, timeout: number) => number;
        this.saveTimeoutId = schedule(() => {
            this.saveTimeoutId = null;
            this.saveToStorage();
        }, this.SAVE_DEBOUNCE_MS);
    }

    private flushPendingSave(): void {
        if (this.saveTimeoutId === null) {
            return;
        }

        const cancel = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
        cancel(this.saveTimeoutId);
        this.saveTimeoutId = null;
    }

    /**
     * Import usage data
     */
    importUsageData(data: any): void {
        try {
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid usage data format');
            }

            // Import file access data
            if (data.fileAccess && Array.isArray(data.fileAccess)) {
                for (const item of data.fileAccess) {
                    if (item.path && typeof item.path === 'string') {
                        this.fileAccess.set(item.path, {
                            count: item.count || 0,
                            lastOpened: item.lastOpened || Date.now(),
                            firstOpened: item.firstOpened || Date.now(),
                        });
                    }
                }
            }

            this.flushPendingSave();
            this.saveToStorage();
        } catch (error) {
            logger.error('Failed to import usage data:', error);
            throw error;
        }
    }
}
