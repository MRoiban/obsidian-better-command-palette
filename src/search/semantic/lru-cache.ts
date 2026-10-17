/**
 * Minimal LRU cache built on Map insertion order.
 */
export class LruCache<K, V> {
    private readonly entries = new Map<K, V>();

    constructor(private readonly maxSize: number) {}

    get(key: K): V | undefined {
        const value = this.entries.get(key);
        if (value === undefined) {
            return undefined;
        }
        // Refresh recency
        this.entries.delete(key);
        this.entries.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        if (this.entries.has(key)) {
            this.entries.delete(key);
        }
        this.entries.set(key, value);

        while (this.entries.size > this.maxSize) {
            const oldest = this.entries.keys().next();
            if (oldest.done) break;
            this.entries.delete(oldest.value);
        }
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}
