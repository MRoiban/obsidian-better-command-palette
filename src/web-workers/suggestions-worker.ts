/* eslint-disable no-restricted-globals */
// We need to accesss self in our web worker

import * as fuzzySearch from 'fuzzysort';
import { Message } from 'src/types/types';
import { matchTag } from 'src/utils';
import { QUERY_OR, QUERY_TAG } from 'src/utils/constants';
import { logger } from '../utils/logger';

self.onmessage = (msg: MessageEvent) => {
    try {
        // Validate message structure
        if (!msg.data || typeof msg.data !== 'object') {
            logger.warn('Invalid message received by suggestions worker');
            self.postMessage([]);
            return;
        }

        const { query, items } = msg.data;
        
        // Validate input data
        if (!items || !Array.isArray(items)) {
            logger.warn('Invalid items array received by suggestions worker');
            self.postMessage([]);
            return;
        }

        if (typeof query !== 'string') {
            logger.warn('Invalid query received by suggestions worker');
            self.postMessage([]);
            return;
        }

        const [mainQuery, ...tagQueries] = query.split(QUERY_TAG);

        let results = items;

        if (mainQuery.includes(QUERY_OR)) {
            const subqueries = mainQuery.split(QUERY_OR).map((q) => q.trim());
            results = items.filter((item) => subqueries.some((sq) => item.text.includes(sq)));
        } else if (mainQuery !== '') {
            results = fuzzySearch
                .go(mainQuery, items, { key: 'text' })
                .map((r) => r.obj);
        }

        if (tagQueries.length) {
            results = results.filter((r) => matchTag(r.tags, tagQueries));
        }

        return self.postMessage(results);
        
    } catch (error) {
        logger.error('Worker error:', error);
        // Always return empty array on error to prevent UI breakage
        self.postMessage([]);
    }
};
