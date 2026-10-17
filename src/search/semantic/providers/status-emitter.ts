import { ProviderStatus, ProviderStatusListener } from './types';
import { logger } from '../../../utils/logger';

/** Holds a provider's current status and notifies subscribers on change. */
export class ProviderStatusEmitter {
    private status: ProviderStatus;

    private listeners = new Set<ProviderStatusListener>();

    constructor(initial: ProviderStatus) {
        this.status = initial;
    }

    get(): ProviderStatus {
        return this.status;
    }

    set(status: ProviderStatus): void {
        this.status = status;
        this.listeners.forEach((listener) => {
            try {
                listener(status);
            } catch (error) {
                logger.warn('Semantic search: Provider status listener failed:', error);
            }
        });
    }

    subscribe(listener: ProviderStatusListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    clear(): void {
        this.listeners.clear();
    }
}
