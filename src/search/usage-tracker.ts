import { UsageTracker, UsageData } from './interfaces';
import { logger } from '../utils/logger';

/**
 * Usage tracker implementation that monitors file access patterns
 * and search behavior to improve ranking and user experience
 */
export class FileUsageTracker implements UsageTracker {
    private fileAccess = new Map<string, { count: number; lastOpened: number; firstOpened: number }>();
    private searchHistory: Array<{ query: string; timestamp: number; selectedPath?: string }> = [];
    private maxSearchHistory = 1000;
    private storageKey = 'better-command-palette-usage';

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
                firstOpened: now
            });
        }

        this.saveToStorage();
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
            selectedPath
        };

        this.searchHistory.push(searchRecord);

        // Trim history if it gets too long
        if (this.searchHistory.length > this.maxSearchHistory) {
            this.searchHistory = this.searchHistory.slice(-this.maxSearchHistory);
        }

        this.saveToStorage();
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

        this.searchHistory.forEach(search => {
            const existing = queryMap.get(search.query);
            if (existing) {
                existing.count++;
                existing.lastUsed = Math.max(existing.lastUsed, search.timestamp);
            } else {
                queryMap.set(search.query, {
                    count: 1,
                    lastUsed: search.timestamp
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
        this.saveToStorage();
    }

    /**
     * Reset usage data for a specific file
     */
    resetFileUsage(path: string): void {
        this.fileAccess.delete(path);
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
            uniqueFiles: this.fileAccess.size
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
    private async saveToStorage(): Promise<void> {
        try {
            const data: StorageData = {
                version: this.STORAGE_VERSION,
                fileAccess: Array.from(this.fileAccess.entries()).map(([path, access]) => ({
                    path,
                    ...access
                }))
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
            
            // Check version compatibility
            if (data.version !== this.STORAGE_VERSION) {
                logger.debug('Usage data version mismatch, resetting data');
                return;
            }
            
            // Load file access data
            if (data.fileAccess) {
                for (const item of data.fileAccess) {
                    this.fileAccess.set(item.path, {
                        count: item.count,
                        lastOpened: item.lastOpened,
                        firstOpened: item.firstOpened
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
            exportDate: Date.now()
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
            totalSize: fileAccessSize + searchHistorySize
        };
    }

    /**
     * Import usage data
     */
    async importUsageData(data: any): Promise<void> {
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
                            firstOpened: item.firstOpened || Date.now()
                        });
                    }
                }
            }
            
            await this.saveToStorage();
        } catch (error) {
            logger.error('Failed to import usage data:', error);
            throw error;
        }
    }
}
