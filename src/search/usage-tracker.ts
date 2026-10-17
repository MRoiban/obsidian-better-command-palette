import { App } from 'obsidian';
import { UsageTracker } from './interfaces';
import { logger } from '../utils/logger';
import { readVaultScopedLocalStorage, writeVaultScopedLocalStorage } from '../utils/vault-storage';

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
 * Explicit user relevance feedback for a result.
 */
interface FeedbackData {
    upvotes: number;
    downvotes: number;
    lastUpdated: number;
}

/**
 * Storage format for persistence
 */
interface StorageData {
    version: string;
    fileAccess: Array<{ path: string } & FileAccessData>;
    bounceData?: Array<{ path: string } & BounceData>;
    feedbackData?: Array<{ key: string } & FeedbackData>;
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
    private readonly STORAGE_VERSION = '2.1.0';

    /** Alias for backwards compatibility */
    private readonly STORAGE_KEY = this.storageKey;

    /**
     * Bounce tracking for pogo-sticking detection.
     * Key: file path, Value: bounce statistics
     */
    private bounceData = new Map<string, BounceData>();

    /**
     * Explicit result feedback.
     * Query-specific keys carry most of the signal; global path keys act as a weak prior.
     */
    private feedbackData = new Map<string, FeedbackData>();

    /**
     * Tracks the last file opened from a search result.
     * Used to detect when user quickly returns to search (pogo-sticking).
     */
    private lastSearchResult: { path: string; timestamp: number; query: string } | null = null;

    /** Threshold in ms for detecting a bounce (quick return to search) */
    private readonly BOUNCE_THRESHOLD_MS = 5000;

    private readonly FEEDBACK_KEY_SEPARATOR = '\u0000';

    private readonly GLOBAL_FEEDBACK_QUERY = '*';

    private readonly FEEDBACK_CONFIDENCE_OFFSET = 4;

    private readonly FEEDBACK_DECAY_HALF_LIFE_DAYS = 90;

    /** Used to scope localStorage to the current vault; legacy global key when absent. */
    private readonly app: App | null;

    constructor(app?: App) {
        this.app = app ?? null;
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
    recordSearchResultOpen(
        path: string,
        query: string,
        options: { recordFileOpen?: boolean } = {},
    ): void {
        const { recordFileOpen = true } = options;

        if (recordFileOpen) {
            this.recordFileOpen(path);
        }

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
        this.queueSave();
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
     * Record explicit user feedback for a search result.
     */
    recordResultFeedback(path: string, query: string, vote: 1 | -1): void {
        if (!path || typeof path !== 'string') {
            return;
        }

        const normalizedVote: 1 | -1 = vote >= 0 ? 1 : -1;
        const queryKey = this.createFeedbackKey(path, query);
        this.applyFeedbackVote(queryKey, normalizedVote);

        const globalKey = this.createFeedbackKey(path);
        this.applyFeedbackVote(globalKey, normalizedVote);

        logger.debug(`Recorded ${normalizedVote > 0 ? 'positive' : 'negative'} feedback for ${path}`);
        this.queueSave();
    }

    /**
     * Get explicit feedback score for a file in the context of a query (-1 to 1).
     */
    getResultFeedbackScore(path: string, query?: string): number {
        if (!path || typeof path !== 'string') {
            return 0;
        }

        const normalizedQuery = this.normalizeFeedbackQuery(query);
        const globalScore = this.getFeedbackScoreForKey(this.createFeedbackKey(path));

        if (normalizedQuery === this.GLOBAL_FEEDBACK_QUERY) {
            return globalScore * 0.5;
        }

        const queryScore = this.getFeedbackScoreForKey(this.createFeedbackKey(path, normalizedQuery));
        return Math.max(-1, Math.min(1, (0.8 * queryScore) + (0.2 * globalScore)));
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
            .filter(([, data]) => data.lastOpened < cutoff)
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
        this.feedbackData.clear();
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
        this.deleteFeedbackForPath(path);
        this.queueSave();
    }

    /**
     * Move all usage data from oldPath to newPath after a file rename.
     */
    renameFile(oldPath: string, newPath: string): void {
        if (!oldPath || !newPath || oldPath === newPath) {
            return;
        }

        let changed = false;

        const access = this.fileAccess.get(oldPath);
        if (access) {
            this.fileAccess.delete(oldPath);
            this.fileAccess.set(newPath, access);
            changed = true;
        }

        const bounce = this.bounceData.get(oldPath);
        if (bounce) {
            this.bounceData.delete(oldPath);
            this.bounceData.set(newPath, bounce);
            changed = true;
        }

        const oldSuffix = `${this.FEEDBACK_KEY_SEPARATOR}${oldPath}`;
        for (const [key, feedback] of Array.from(this.feedbackData.entries())) {
            if (key.endsWith(oldSuffix)) {
                const prefix = key.slice(0, key.length - oldSuffix.length);
                this.feedbackData.delete(key);
                this.feedbackData.set(`${prefix}${this.FEEDBACK_KEY_SEPARATOR}${newPath}`, feedback);
                changed = true;
            }
        }

        for (const record of this.searchHistory) {
            if (record.selectedPath === oldPath) {
                record.selectedPath = newPath;
            }
        }

        if (this.lastSearchResult?.path === oldPath) {
            this.lastSearchResult.path = newPath;
        }

        if (changed) {
            this.queueSave();
        }
    }

    /**
     * Drop all usage data for a deleted file.
     */
    deleteFile(path: string): void {
        if (!path) {
            return;
        }

        const changed = this.fileAccess.has(path) || this.bounceData.has(path);
        const feedbackBefore = this.feedbackData.size;
        this.fileAccess.delete(path);
        this.bounceData.delete(path);
        this.deleteFeedbackForPath(path);

        if (this.lastSearchResult?.path === path) {
            this.lastSearchResult = null;
        }

        if (changed || this.feedbackData.size !== feedbackBefore) {
            this.queueSave();
        }
    }

    shutdown(): void {
        this.flushPendingSave();
        this.saveToStorage();
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

    private applyFeedbackVote(key: string, vote: 1 | -1): void {
        const feedback = this.feedbackData.get(key) ?? {
            upvotes: 0,
            downvotes: 0,
            lastUpdated: 0,
        };

        if (vote > 0) {
            feedback.upvotes++;
        } else {
            feedback.downvotes++;
        }

        feedback.lastUpdated = Date.now();
        this.feedbackData.set(key, feedback);
    }

    private getFeedbackScoreForKey(key: string): number {
        const feedback = this.feedbackData.get(key);
        if (!feedback) {
            return 0;
        }

        const totalVotes = feedback.upvotes + feedback.downvotes;
        if (totalVotes <= 0) {
            return 0;
        }

        const polarity = (feedback.upvotes - feedback.downvotes) / totalVotes;
        const confidence = totalVotes / (totalVotes + this.FEEDBACK_CONFIDENCE_OFFSET);
        const ageDays = (Date.now() - feedback.lastUpdated) / (1000 * 60 * 60 * 24);
        const decay = Math.exp(-ageDays / this.FEEDBACK_DECAY_HALF_LIFE_DAYS);

        return Math.max(-1, Math.min(1, polarity * confidence * decay));
    }

    private createFeedbackKey(path: string, query?: string): string {
        return `${this.normalizeFeedbackQuery(query)}${this.FEEDBACK_KEY_SEPARATOR}${path}`;
    }

    private normalizeFeedbackQuery(query?: string): string {
        const normalized = (query || '')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ');

        return normalized || this.GLOBAL_FEEDBACK_QUERY;
    }

    private deleteFeedbackForPath(path: string): void {
        const suffix = `${this.FEEDBACK_KEY_SEPARATOR}${path}`;
        for (const key of this.feedbackData.keys()) {
            if (key.endsWith(suffix)) {
                this.feedbackData.delete(key);
            }
        }
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

            const feedbackDataArray: Array<{ key: string } & FeedbackData> = [];
            for (const [key, feedback] of this.feedbackData.entries()) {
                if (typeof key === 'string') {
                    feedbackDataArray.push({
                        key,
                        upvotes: Number(feedback.upvotes) || 0,
                        downvotes: Number(feedback.downvotes) || 0,
                        lastUpdated: Number(feedback.lastUpdated) || 0,
                    });
                }
            }

            const data: StorageData = {
                version: this.STORAGE_VERSION,
                fileAccess: fileAccessArray,
                bounceData: bounceDataArray,
                feedbackData: feedbackDataArray,
            };

            const serialized = JSON.stringify(data);
            if (this.app) {
                writeVaultScopedLocalStorage(this.app, this.STORAGE_KEY, serialized);
            } else {
                window.localStorage.setItem(this.STORAGE_KEY, serialized);
            }
        } catch (error) {
            logger.error('Failed to save usage data to localStorage:', error);
        }
    }

    /**
     * Load data from localStorage
     */
    private loadFromStorage(): void {
        try {
            const stored = this.app
                ? readVaultScopedLocalStorage(this.app, this.STORAGE_KEY)
                : window.localStorage.getItem(this.STORAGE_KEY);
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

            if (data.feedbackData) {
                for (const item of data.feedbackData) {
                    this.feedbackData.set(item.key, {
                        upvotes: item.upvotes,
                        downvotes: item.downvotes,
                        lastUpdated: item.lastUpdated,
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
            feedbackData: Array.from(this.feedbackData.entries()),
            searchHistory: this.searchHistory,
            version: this.STORAGE_VERSION,
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
                this.feedbackData = new Map(data.feedbackData ?? []);
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

            if (data.feedbackData && Array.isArray(data.feedbackData)) {
                this.feedbackData = new Map(data.feedbackData);
            }

            this.flushPendingSave();
            this.saveToStorage();
        } catch (error) {
            logger.error('Failed to import usage data:', error);
            throw error;
        }
    }
}
