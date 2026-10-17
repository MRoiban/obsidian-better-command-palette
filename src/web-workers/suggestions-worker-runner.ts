import * as fuzzySearch from 'fuzzysort';
import {
    Match,
    SuggestionsWorkerQueryMessage,
    SuggestionsWorkerRegisterMessage,
    SuggestionsWorkerResultMessage,
    WorkerMode,
} from 'src/types/types';
import { matchTag } from 'src/utils';
import { QUERY_OR, QUERY_TAG } from 'src/utils/constants';

const corpora = new Map<WorkerMode, Match[]>();

/**
 * Query message with an optional result cap so only the rows the palette can show
 * are copied back to the main thread.
 */
type LimitedQueryMessage = SuggestionsWorkerQueryMessage & { limit?: number };

function getResultLimit(message: LimitedQueryMessage): number | undefined {
    const { limit } = message;
    return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : undefined;
}

export function processSuggestionsWorkerMessage(
    data: unknown,
): SuggestionsWorkerResultMessage | null {
    if (!data || typeof data !== 'object') {
        return null;
    }

    if ((data as { type?: string }).type === 'register') {
        const registerMessage = data as SuggestionsWorkerRegisterMessage;
        if (!registerMessage.items || !Array.isArray(registerMessage.items)) {
            return null;
        }

        corpora.set(registerMessage.mode, registerMessage.items);
        return null;
    }

    const queryMessage = data as LimitedQueryMessage;
    if (queryMessage.type !== 'query' || typeof queryMessage.query !== 'string') {
        return null;
    }

    const items = corpora.get(queryMessage.mode) || [];
    const query = queryMessage.query;
    const [mainQuery, ...tagQueries] = query.split(QUERY_TAG);
    const limit = getResultLimit(queryMessage);

    let results = items;

    if (mainQuery.includes(QUERY_OR)) {
        const subqueries = mainQuery.split(QUERY_OR).map((q) => q.trim());
        results = items.filter((item) => subqueries.some((subquery) => item.text.includes(subquery)));
    } else if (mainQuery !== '') {
        results = fuzzySearch
            // Tag filtering happens afterwards, so only cap here when there is none
            .go(mainQuery, items, { key: 'text', limit: tagQueries.length ? undefined : limit })
            .map((result) => result.obj);
    }

    if (tagQueries.length) {
        results = results.filter((result) => matchTag(result.tags, tagQueries));
    }

    return {
        type: 'result',
        mode: queryMessage.mode,
        requestId: queryMessage.requestId,
        items: limit === undefined ? results : results.slice(0, limit),
    };
}
