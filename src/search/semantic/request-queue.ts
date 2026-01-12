/**
 * Request queue for rate limiting Ollama API calls with adaptive throttling
 */

import { logger } from '../../utils/logger';

export class RequestQueue {
    private queue: Array<() => Promise<any>> = [];

    private activeRequests = 0;

    private maxConcurrent: number;

    private userMaxConcurrent: number; // User-configured ceiling

    private enableAdaptive: boolean;

    // Adaptive throttling state
    private recentResponseTimes: number[] = [];

    private readonly responseTimeWindow = 10; // Track last N response times

    private readonly fastThresholdMs = 500; // Response under this = fast

    private readonly slowThresholdMs = 2000; // Response over this = slow

    private lastAdjustmentTime = 0;

    private readonly adjustmentCooldownMs = 5000; // Wait between adjustments

    constructor(maxConcurrent = 3, enableAdaptive = true) {
        this.maxConcurrent = Math.min(maxConcurrent, 10);
        this.userMaxConcurrent = Math.min(maxConcurrent, 10);
        this.enableAdaptive = enableAdaptive;
    }

    async add<T>(request: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push(async () => {
                const startTime = Date.now();
                try {
                    this.activeRequests++;
                    const result = await request();
                    this.recordResponseTime(Date.now() - startTime, true);
                    resolve(result);
                } catch (error) {
                    this.recordResponseTime(Date.now() - startTime, false);
                    reject(error);
                } finally {
                    this.activeRequests--;
                    this.processNext();
                }
            });

            this.processNext();
        });
    }

    private recordResponseTime(timeMs: number, success: boolean): void {
        if (!this.enableAdaptive) return;

        this.recentResponseTimes.push(timeMs);
        if (this.recentResponseTimes.length > this.responseTimeWindow) {
            this.recentResponseTimes.shift();
        }

        // Only adjust if we have enough samples and cooldown has passed
        const now = Date.now();
        if (this.recentResponseTimes.length >= 3 && now - this.lastAdjustmentTime > this.adjustmentCooldownMs) {
            this.adjustConcurrency(success);
            this.lastAdjustmentTime = now;
        }
    }

    private adjustConcurrency(lastSuccess: boolean): void {
        const avgTime = this.recentResponseTimes.reduce((a, b) => a + b, 0) / this.recentResponseTimes.length;

        // Count fast and slow responses
        const fastCount = this.recentResponseTimes.filter((t) => t < this.fastThresholdMs).length;
        const slowCount = this.recentResponseTimes.filter((t) => t > this.slowThresholdMs).length;

        const oldConcurrent = this.maxConcurrent;

        if (!lastSuccess) {
            // On error, reduce concurrency
            this.maxConcurrent = Math.max(1, this.maxConcurrent - 1);
        } else if (slowCount > this.recentResponseTimes.length / 2) {
            // If most responses are slow, reduce concurrency
            this.maxConcurrent = Math.max(1, this.maxConcurrent - 1);
        } else if (fastCount > this.recentResponseTimes.length * 0.7 && avgTime < this.fastThresholdMs) {
            // If 70%+ responses are fast and average is fast, increase concurrency
            this.maxConcurrent = Math.min(this.userMaxConcurrent, this.maxConcurrent + 1);
        }

        if (oldConcurrent !== this.maxConcurrent) {
            logger.debug(`[Semantic Search] Adaptive throttling: adjusted concurrency ${oldConcurrent} → ${this.maxConcurrent} (avg: ${avgTime.toFixed(0)}ms, fast: ${fastCount}, slow: ${slowCount})`);
        }
    }

    private processNext(): void {
        if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
            const request = this.queue.shift()!;
            request();
        }
    }

    getQueueSize(): number {
        return this.queue.length;
    }

    getActiveRequests(): number {
        return this.activeRequests;
    }

    getCurrentConcurrency(): number {
        return this.maxConcurrent;
    }

    clear(): void {
        this.queue = [];
    }

    updateConcurrentLimit(newLimit: number): void {
        const capped = Math.min(Math.max(1, newLimit), 10);
        this.userMaxConcurrent = capped;
        this.maxConcurrent = Math.min(this.maxConcurrent, capped);
        // Process any queued requests that can now run
        this.processNext();
    }

    setAdaptiveThrottling(enabled: boolean): void {
        this.enableAdaptive = enabled;
        if (!enabled) {
            // Reset to user max when disabling adaptive
            this.maxConcurrent = this.userMaxConcurrent;
            this.recentResponseTimes = [];
        }
    }

    getStats(): { avgResponseTime: number; currentConcurrency: number; userMax: number } {
        const avg = this.recentResponseTimes.length > 0
            ? this.recentResponseTimes.reduce((a, b) => a + b, 0) / this.recentResponseTimes.length
            : 0;
        return {
            avgResponseTime: avg,
            currentConcurrency: this.maxConcurrent,
            userMax: this.userMaxConcurrent,
        };
    }
}
