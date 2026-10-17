import { App } from 'obsidian';

/**
 * Helpers for scoping persistent storage (IndexedDB names, localStorage keys)
 * to the current vault. All Obsidian vaults share one browser origin, so
 * un-scoped names leak data between vaults.
 */

/** Stable per-vault identifier. `app.appId` is undocumented but present at runtime. */
export function getVaultId(app: App): string {
    const appId = (app as App & { appId?: string }).appId;
    if (appId) return appId;
    return app.vault.getName();
}

/** Append the vault id to a storage name, e.g. an IndexedDB database name. */
export function getVaultScopedName(app: App, baseName: string): string {
    return `${baseName}-${getVaultId(app)}`;
}

const MIGRATED_SUFFIX = '-migrated';

/**
 * Read a localStorage value under the vault-scoped key. The legacy un-scoped
 * value is read only on this vault's first run after the upgrade; a marker
 * then stops it from leaking back in (e.g. after the scoped key is removed).
 * The legacy key is left in place because other vaults may still need it.
 */
export function readVaultScopedLocalStorage(app: App, baseKey: string): string | null {
    const scopedKey = getVaultScopedName(app, baseKey);
    const scoped = window.localStorage.getItem(scopedKey);
    if (scoped !== null) return scoped;

    const markerKey = `${scopedKey}${MIGRATED_SUFFIX}`;
    if (window.localStorage.getItem(markerKey) !== null) return null;
    window.localStorage.setItem(markerKey, '1');
    return window.localStorage.getItem(baseKey);
}

export function writeVaultScopedLocalStorage(app: App, baseKey: string, value: string): void {
    window.localStorage.setItem(getVaultScopedName(app, baseKey), value);
}

export function removeVaultScopedLocalStorage(app: App, baseKey: string): void {
    window.localStorage.removeItem(getVaultScopedName(app, baseKey));
}
