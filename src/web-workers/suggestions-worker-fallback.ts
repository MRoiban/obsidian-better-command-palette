import { SuggestionsWorkerResultMessage } from 'src/types/types';
import { logger } from '../utils/logger';
import { processSuggestionsWorkerMessage } from './suggestions-worker-runner';

/**
 * Main-thread fallback used when the bundled worker factory cannot be resolved
 * by Obsidian's runtime loader.
 */
export class SuggestionsWorkerFallback {
    onmessage: ((this: Worker, ev: MessageEvent) => any) | null = null;

    postMessage(data: unknown): void {
        window.setTimeout(() => {
            try {
                const result = processSuggestionsWorkerMessage(data);
                if (!result || !this.onmessage) {
                    return;
                }

                this.onmessage?.call(this as unknown as Worker, {
                    data: result,
                } as MessageEvent<SuggestionsWorkerResultMessage>);
            } catch (error) {
                logger.error('Suggestions worker fallback error:', error);
            }
        }, 0);
    }

    terminate(): void {
        this.onmessage = null;
    }
}
