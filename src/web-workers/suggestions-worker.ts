/* eslint-disable no-restricted-globals */
import { logger } from '../utils/logger';
import { processSuggestionsWorkerMessage } from './suggestions-worker-runner';

self.onmessage = (msg: MessageEvent) => {
    try {
        const result = processSuggestionsWorkerMessage(msg.data);
        if (result) {
            self.postMessage(result);
        }
    } catch (error) {
        logger.error('Worker error:', error);
    }
};
