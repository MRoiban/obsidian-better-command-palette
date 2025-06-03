/**
 * Performance monitoring for the enhanced search system
 * Tracks search latency, memory usage, and system health
 */
export class SearchPerformanceMonitor {
    private searchLatencies: number[] = [];
    private indexingLatencies: number[] = [];
    private memoryUsage: number[] = [];
    private maxSamples = 100;
    private performanceMarks = new Map<string, number>();

    /**
     * Start timing an operation
     */
    startTiming(operationId: string): void {
        this.performanceMarks.set(operationId, performance.now());
    }

    /**
     * End timing an operation and record the duration
     */
    endTiming(operationId: string, operationType: 'search' | 'indexing' = 'search'): number {
        const startTime = this.performanceMarks.get(operationId);
        if (!startTime) {
            console.warn(`No start time found for operation: ${operationId}`);
            return 0;
        }

        const duration = performance.now() - startTime;
        this.performanceMarks.delete(operationId);

        // Record the latency
        if (operationType === 'search') {
            this.recordSearchLatency(duration);
        } else {
            this.recordIndexingLatency(duration);
        }

        return duration;
    }

    /**
     * Record search latency
     */
    recordSearchLatency(latency: number): void {
        this.searchLatencies.push(latency);
        if (this.searchLatencies.length > this.maxSamples) {
            this.searchLatencies.shift();
        }
    }

    /**
     * Record indexing latency
     */
    recordIndexingLatency(latency: number): void {
        this.indexingLatencies.push(latency);
        if (this.indexingLatencies.length > this.maxSamples) {
            this.indexingLatencies.shift();
        }
    }

    /**
     * Record memory usage
     */
    recordMemoryUsage(): void {
        if ('memory' in performance) {
            const memInfo = (performance as any).memory;
            this.memoryUsage.push(memInfo.usedJSHeapSize);
            if (this.memoryUsage.length > this.maxSamples) {
                this.memoryUsage.shift();
            }
        }
    }

    /**
     * Get search performance statistics
     */
    getSearchStats(): {
        averageLatency: number;
        medianLatency: number;
        p95Latency: number;
        maxLatency: number;
        sampleCount: number;
    } {
        if (this.searchLatencies.length === 0) {
            return {
                averageLatency: 0,
                medianLatency: 0,
                p95Latency: 0,
                maxLatency: 0,
                sampleCount: 0
            };
        }

        const sorted = [...this.searchLatencies].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, val) => acc + val, 0);

        return {
            averageLatency: sum / sorted.length,
            medianLatency: sorted[Math.floor(sorted.length / 2)],
            p95Latency: sorted[Math.floor(sorted.length * 0.95)],
            maxLatency: Math.max(...sorted),
            sampleCount: sorted.length
        };
    }

    /**
     * Get indexing performance statistics
     */
    getIndexingStats(): {
        averageLatency: number;
        medianLatency: number;
        maxLatency: number;
        sampleCount: number;
    } {
        if (this.indexingLatencies.length === 0) {
            return {
                averageLatency: 0,
                medianLatency: 0,
                maxLatency: 0,
                sampleCount: 0
            };
        }

        const sorted = [...this.indexingLatencies].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, val) => acc + val, 0);

        return {
            averageLatency: sum / sorted.length,
            medianLatency: sorted[Math.floor(sorted.length / 2)],
            maxLatency: Math.max(...sorted),
            sampleCount: sorted.length
        };
    }

    /**
     * Get memory usage statistics
     */
    getMemoryStats(): {
        averageUsage: number;
        peakUsage: number;
        currentUsage: number;
        sampleCount: number;
    } {
        if (this.memoryUsage.length === 0) {
            return {
                averageUsage: 0,
                peakUsage: 0,
                currentUsage: 0,
                sampleCount: 0
            };
        }

        const sum = this.memoryUsage.reduce((acc, val) => acc + val, 0);
        const currentUsage = 'memory' in performance ? 
            (performance as any).memory.usedJSHeapSize : 0;

        return {
            averageUsage: sum / this.memoryUsage.length,
            peakUsage: Math.max(...this.memoryUsage),
            currentUsage,
            sampleCount: this.memoryUsage.length
        };
    }

    /**
     * Get comprehensive performance report
     */
    getPerformanceReport(): {
        search: ReturnType<SearchPerformanceMonitor['getSearchStats']>;
        indexing: ReturnType<SearchPerformanceMonitor['getIndexingStats']>;
        memory: ReturnType<SearchPerformanceMonitor['getMemoryStats']>;
        healthScore: number;
    } {
        const searchStats = this.getSearchStats();
        const indexingStats = this.getIndexingStats();
        const memoryStats = this.getMemoryStats();

        // Calculate health score (0-100)
        let healthScore = 100;

        // Penalize slow search performance (target: < 100ms)
        if (searchStats.averageLatency > 100) {
            healthScore -= Math.min(50, (searchStats.averageLatency - 100) / 10);
        }

        // Penalize slow indexing (target: < 1000ms per file)
        if (indexingStats.averageLatency > 1000) {
            healthScore -= Math.min(30, (indexingStats.averageLatency - 1000) / 100);
        }

        // Penalize high memory usage (target: < 50MB)
        const memoryMB = memoryStats.currentUsage / (1024 * 1024);
        if (memoryMB > 50) {
            healthScore -= Math.min(20, (memoryMB - 50) / 10);
        }

        return {
            search: searchStats,
            indexing: indexingStats,
            memory: memoryStats,
            healthScore: Math.max(0, Math.round(healthScore))
        };
    }

    /**
     * Check if search performance is within acceptable limits
     */
    isPerformanceAcceptable(): boolean {
        const searchStats = this.getSearchStats();
        
        // Search should be fast enough for real-time use
        if (searchStats.averageLatency > 200) return false;
        if (searchStats.p95Latency > 500) return false;
        
        return true;
    }

    /**
     * Clear all performance data
     */
    clear(): void {
        this.searchLatencies = [];
        this.indexingLatencies = [];
        this.memoryUsage = [];
        this.performanceMarks.clear();
    }

    /**
     * Generate performance recommendations
     */
    getRecommendations(): string[] {
        const recommendations: string[] = [];
        const searchStats = this.getSearchStats();
        const indexingStats = this.getIndexingStats();
        const memoryStats = this.getMemoryStats();

        if (searchStats.averageLatency > 100) {
            recommendations.push('Consider reducing the maximum number of indexed files to improve search speed.');
        }

        if (searchStats.p95Latency > 300) {
            recommendations.push('Search performance is inconsistent. Try increasing the search timeout or reducing content preview length.');
        }

        if (indexingStats.averageLatency > 2000) {
            recommendations.push('File indexing is slow. Consider increasing the indexing debounce time to batch updates.');
        }

        const memoryMB = memoryStats.currentUsage / (1024 * 1024);
        if (memoryMB > 100) {
            recommendations.push('High memory usage detected. Consider reducing the maximum indexed files or disabling full content search.');
        }

        if (recommendations.length === 0) {
            recommendations.push('Search performance is optimal!');
        }

        return recommendations;
    }
}

// Singleton instance for global performance monitoring
export const performanceMonitor = new SearchPerformanceMonitor();
