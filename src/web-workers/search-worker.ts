import { MiniSearchAdapter } from '../search/mini-search-adapter';
import { WorkerMessage, WorkerResponse } from '../search/interfaces';

/**
 * Web Worker for background search indexing and querying
 * Handles search operations without blocking the main thread
 */

let searchIndex: MiniSearchAdapter;
let isInitialized = false;

// Initialize the search index
function initialize() {
    if (!isInitialized) {
        searchIndex = new MiniSearchAdapter();
        isInitialized = true;
    }
}

// Handle messages from the main thread
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
    const { type, payload, requestId } = event.data;

    try {
        let result: any;

        switch (type) {
            case 'INDEX_FILE':
                initialize();
                await searchIndex.addDocument(payload.id, payload.content, payload.metadata);
                result = { success: true };
                sendResponse('INDEX_COMPLETE', result, requestId);
                break;

            case 'SEARCH':
                initialize();
                result = await searchIndex.search(payload.query, payload.limit);
                sendResponse('SEARCH_RESULTS', result, requestId);
                break;

            case 'REMOVE_FILE':
                initialize();
                await searchIndex.removeDocument(payload.id);
                result = { success: true };
                sendResponse('REMOVE_COMPLETE', result, requestId);
                break;

            case 'CLEAR_INDEX':
                initialize();
                await searchIndex.clear();
                result = { success: true };
                sendResponse('CLEAR_COMPLETE', result, requestId);
                break;

            case 'GET_STATS':
                initialize();
                result = searchIndex.getStats();
                sendResponse('STATS_RESULT', result, requestId);
                break;

            default:
                throw new Error(`Unknown message type: ${type}`);
        }
    } catch (error) {
        sendResponse('ERROR', { 
            message: error instanceof Error ? error.message : 'Unknown error',
            type: type 
        }, requestId);
    }
};

// Send response back to main thread
function sendResponse(type: WorkerResponse['type'], payload: any, requestId?: string) {
    const response: WorkerResponse = {
        type,
        payload,
        requestId
    };
    
    self.postMessage(response);
}

// Handle errors
self.onerror = (error) => {
    sendResponse('ERROR', { 
        message: error.message || 'Worker error',
        filename: error.filename,
        lineno: error.lineno 
    });
};

// Export for TypeScript
export {};
