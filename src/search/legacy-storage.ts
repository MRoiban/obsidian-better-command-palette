/**
 * Cleanup of the un-scoped IndexedDB databases written by plugin versions before
 * per-vault storage. They are kept automatically because other vaults may still
 * migrate from them; this module lets the user delete them explicitly.
 */

import { App } from 'obsidian';
import { INDEX_DB_BASE_NAME, IndexPersistence } from './persistence';
import { LEGACY_EMBEDDING_DB_NAME, deleteLegacyEmbeddingDatabase } from './semantic/embedding-store';
import { DatabaseDeleteOutcome, listIndexedDatabaseNames } from '../utils/indexed-db';
import { getVaultScopedName } from '../utils/vault-storage';
import { logger } from '../utils/logger';

export interface LegacyDatabase {
    /** Exact (un-scoped) IndexedDB name. */
    name: string;
    label: string;
    remove: () => Promise<DatabaseDeleteOutcome>;
}

export const LEGACY_DATABASES: readonly LegacyDatabase[] = [
    {
        name: LEGACY_EMBEDDING_DB_NAME,
        label: 'semantic embeddings',
        remove: deleteLegacyEmbeddingDatabase,
    },
    {
        name: INDEX_DB_BASE_NAME,
        label: 'keyword search index',
        remove: () => IndexPersistence.deleteDatabase(INDEX_DB_BASE_NAME),
    },
];

/**
 * - missing: the browser lists databases and this one does not exist
 * - skipped: the name matches a current vault database, which is never deleted
 * - error: deletion failed (see `error`)
 */
export type LegacyDeleteOutcome = DatabaseDeleteOutcome | 'missing' | 'skipped' | 'error';

export interface LegacyDeleteResult {
    database: LegacyDatabase;
    outcome: LegacyDeleteOutcome;
    error?: string;
}

/** Names of this vault's current databases; never deleted by this module. */
function getCurrentVaultDatabaseNames(app: App): Set<string> {
    return new Set([
        getVaultScopedName(app, LEGACY_EMBEDDING_DB_NAME),
        getVaultScopedName(app, INDEX_DB_BASE_NAME),
    ]);
}

/** Legacy databases that still exist, or null when the browser cannot list databases. */
export async function findLegacyDatabases(): Promise<LegacyDatabase[] | null> {
    const existing = await listIndexedDatabaseNames();
    return existing ? LEGACY_DATABASES.filter((db) => existing.has(db.name)) : null;
}

/** Delete every legacy database. Never throws; per-database outcomes are returned. */
export async function deleteLegacyDatabases(app: App): Promise<LegacyDeleteResult[]> {
    const existing = await listIndexedDatabaseNames();
    const protectedNames = getCurrentVaultDatabaseNames(app);
    const results: LegacyDeleteResult[] = [];

    for (const database of LEGACY_DATABASES) {
        if (protectedNames.has(database.name)) {
            // Defensive: a legacy name must never resolve to a current vault database
            results.push({ database, outcome: 'skipped' });
            continue;
        }
        if (existing && !existing.has(database.name)) {
            results.push({ database, outcome: 'missing' });
            continue;
        }
        try {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await database.remove();
            logger.info(`Legacy storage: ${database.name} -> ${outcome}`);
            results.push({ database, outcome });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn(`Legacy storage: Failed to delete ${database.name}:`, error);
            results.push({ database, outcome: 'error', error: message });
        }
    }

    return results;
}

/** One-line summary for a Notice. */
export function summarizeLegacyDeleteResults(results: LegacyDeleteResult[]): string {
    const labels = (outcome: LegacyDeleteOutcome) => results
        .filter((result) => result.outcome === outcome)
        .map((result) => result.database.label);

    const parts: string[] = [];
    const deleted = labels('deleted');
    const blocked = labels('blocked');
    const failed = results.filter((result) => result.outcome === 'error');
    if (deleted.length > 0) {
        parts.push(`Deleted legacy ${deleted.join(' and ')} database${deleted.length > 1 ? 's' : ''}.`);
    }
    if (blocked.length > 0) {
        parts.push(`Deletion of the legacy ${blocked.join(' and ')} database is pending: another window or vault still has it open. It completes once that is closed.`);
    }
    failed.forEach((result) => {
        parts.push(`Could not delete the legacy ${result.database.label} database: ${result.error}`);
    });
    if (parts.length === 0) {
        return 'No legacy databases found. Nothing to delete.';
    }
    return parts.join(' ');
}
