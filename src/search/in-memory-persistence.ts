import { ContentStore } from './interfaces';
import { logger } from '../utils/logger';

/**
 * Simple in-memory implementation of the ContentStore/IndexPersistence API.
 * This is used as a graceful fallback on platforms where IndexedDB is
 * unavailable or blocked (e.g. certain mobile WebViews). Data lives only for
 * the lifetime of the current session.
 */
export class InMemoryPersistence implements ContentStore {
    private content = new Map<string, string>();
    private metadata = new Map<string, any>();
    private usage = new Map<string, any>();

    // Keep the API consistent with IndexPersistence
    async initialize(): Promise<void> {
        logger.warn('In-memory persistence initialised – search data will not be persisted across sessions.');
    }

    async get(fileId: string): Promise<string> {
        return this.content.get(fileId) ?? '';
    }

    async set(fileId: string, content: string): Promise<void> {
        this.content.set(fileId, content);
    }

    async delete(fileId: string): Promise<void> {
        this.content.delete(fileId);
        this.metadata.delete(fileId);
        this.usage.delete(fileId);
    }

    async clear(): Promise<void> {
        this.content.clear();
        this.metadata.clear();
        this.usage.clear();
    }

    async getStats(): Promise<{ count: number; size: number }> {
        let size = 0;
        for (const text of this.content.values()) {
            size += text.length;
        }
        return { count: this.content.size, size };
    }

    /* Metadata helpers used by IndexingCoordinator */
    async setMetadata(fileId: string, data: any): Promise<void> {
        this.metadata.set(fileId, data);
    }

    async getMetadata(fileId: string): Promise<any> {
        return this.metadata.get(fileId);
    }

    /* Usage statistics – minimal implementation */
    async setUsageStats(fileId: string, stats: any): Promise<void> {
        this.usage.set(fileId, stats);
    }

    async getUsageStats(fileId: string): Promise<any> {
        return this.usage.get(fileId);
    }

    async getAllUsageStats(): Promise<Record<string, any>> {
        const obj: Record<string, any> = {};
        for (const [k, v] of this.usage.entries()) {
            obj[k] = v;
        }
        return obj;
    }

    /* Search index serialisation – not supported in memory version */
    async loadSearchIndex(): Promise<any> {
        return null;
    }

    async saveSearchIndex(_indexData: any): Promise<void> {
        /* no-op */
    }

    close(): void {
        /* no-op */
    }
} 