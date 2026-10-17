/**
 * Small IndexedDB helpers shared by the stores (database listing and deletion).
 */

/**
 * - deleted: the database is gone (or never existed)
 * - blocked: another connection (window, vault) still has it open; the deletion stays
 *   queued by the browser and completes once that connection closes
 */
export type DatabaseDeleteOutcome = 'deleted' | 'blocked';

export interface DeleteDatabaseOptions {
    /** How long to wait after a 'blocked' event before reporting 'blocked'. */
    blockedTimeoutMs?: number;
}

const DEFAULT_BLOCKED_TIMEOUT_MS = 3000;

/**
 * Delete an IndexedDB database by exact name. Rejects on error. When the deletion
 * is blocked and does not complete within the timeout, resolves 'blocked'.
 */
export function deleteIndexedDatabase(name: string, options: DeleteDatabaseOptions = {}): Promise<DatabaseDeleteOutcome> {
    if (typeof indexedDB === 'undefined') {
        return Promise.reject(new Error('IndexedDB is not available'));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let blockedTimer: number | undefined;
        const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            if (blockedTimer !== undefined) window.clearTimeout(blockedTimer);
            finish();
        };

        let request: IDBOpenDBRequest;
        try {
            request = indexedDB.deleteDatabase(name);
        } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
        }

        request.onsuccess = () => settle(() => resolve('deleted'));
        request.onerror = () => settle(() => reject(new Error(`Failed to delete database "${name}": ${request.error?.message || 'Unknown error'}`)));
        request.onblocked = () => {
            if (blockedTimer !== undefined) return;
            blockedTimer = window.setTimeout(
                () => settle(() => resolve('blocked')),
                options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS,
            );
        };
    });
}

/**
 * Names of the databases that exist for this origin, or null when the browser
 * cannot list them (indexedDB.databases is not universally supported).
 */
export async function listIndexedDatabaseNames(): Promise<Set<string> | null> {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
        return null;
    }
    try {
        const databases = await indexedDB.databases();
        return new Set(databases.map((db) => db.name).filter((name): name is string => !!name));
    } catch {
        return null;
    }
}
