/**
 * Smart Scheduler
 * 
 * Combines throttling and debouncing for optimal update scheduling:
 * - Throttle: Guarantees updates every N ms during active changes (keeps UI responsive)
 * - Debounce: Final cleanup update after activity stops (ensures accuracy)
 * 
 * This is the "Smart Scheduler" pattern that provides the best UX for
 * real-time search indexing during active editing.
 */

import { logger } from './logger';

export interface SmartSchedulerOptions {
    /** Minimum time between throttled flushes (default: 200ms) */
    throttleMs?: number;
    /** Time to wait after last update before final flush (default: 500ms) */
    debounceMs?: number;
    /** Name for logging purposes */
    name?: string;
}

const DEFAULT_OPTIONS: Required<SmartSchedulerOptions> = {
    throttleMs: 200,
    debounceMs: 500,
    name: 'SmartScheduler',
};

/**
 * Smart Scheduler that combines throttle + debounce for optimal update scheduling
 */
export class SmartScheduler {
    private throttleTimer: ReturnType<typeof setTimeout> | null = null;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingItems = new Set<string>();
    private options: Required<SmartSchedulerOptions>;
    private isDestroyed = false;

    constructor(
        private onFlush: (items: string[]) => void | Promise<void>,
        options: SmartSchedulerOptions = {},
    ) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Schedule an item for processing
     * @param itemId - Unique identifier for the item (e.g., file path)
     */
    schedule(itemId: string): void {
        if (this.isDestroyed) return;

        this.pendingItems.add(itemId);
        logger.debug(`[${this.options.name}] 📥 Scheduled: ${itemId} (${this.pendingItems.size} pending)`);
        logger.debug(`[${this.options.name}] Scheduled: ${itemId} (${this.pendingItems.size} pending)`);

        // Throttle: Ensure we run at least once every throttleMs during activity
        if (!this.throttleTimer) {
            logger.debug(`[${this.options.name}] ⏱️ Throttle timer started (${this.options.throttleMs}ms)`);
            this.throttleTimer = setTimeout(() => {
                this.throttleTimer = null;
                if (this.pendingItems.size > 0) {
                    this.performFlush('throttle');
                }
            }, this.options.throttleMs);
        }

        // Debounce: Reset the cleanup timer on every new item
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            if (this.pendingItems.size > 0) {
                this.performFlush('debounce');
            }
        }, this.options.debounceMs);
    }

    /**
     * Force immediate flush of all pending items
     */
    async flush(): Promise<void> {
        if (this.pendingItems.size > 0) {
            await this.performFlush('manual');
        }
    }

    /**
     * Get the number of pending items
     */
    get pendingCount(): number {
        return this.pendingItems.size;
    }

    /**
     * Check if there are pending items
     */
    get hasPending(): boolean {
        return this.pendingItems.size > 0;
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.isDestroyed = true;

        if (this.throttleTimer) {
            clearTimeout(this.throttleTimer);
            this.throttleTimer = null;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }

        this.pendingItems.clear();
        logger.debug(`[${this.options.name}] 🛑 Destroyed`);
        logger.debug(`[${this.options.name}] Destroyed`);
    }

    /**
     * Perform the flush operation
     */
    private async performFlush(trigger: 'throttle' | 'debounce' | 'manual'): Promise<void> {
        if (this.pendingItems.size === 0) return;

        const items = Array.from(this.pendingItems);
        this.pendingItems.clear();

        const emoji = trigger === 'throttle' ? '⚡' : trigger === 'debounce' ? '✅' : '🔄';
        logger.debug(`[${this.options.name}] ${emoji} Flush (${trigger}): Processing ${items.length} items:`, items);
        logger.debug(`[${this.options.name}] Flush (${trigger}): ${items.length} items`);

        try {
            await this.onFlush(items);
            logger.debug(`[${this.options.name}] ✓ Flush complete`);
        } catch (error) {
            console.error(`[${this.options.name}] ✗ Flush failed:`, error);
            logger.error(`[${this.options.name}] Flush failed:`, error);
        }
    }
}
