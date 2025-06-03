import {
    App, Command, Hotkey, Modifier, normalizePath, parseFrontMatterAliases,
    parseFrontMatterTags, Platform, TFile, TFolder
} from 'obsidian';
import { BetterCommandPalettePluginSettings } from 'src/settings';
import { Match, UnsafeMetadataCacheInterface } from 'src/types/types';
import PaletteMatch from './palette-match';
import OrderedSet from './ordered-set';
import {
    BASIC_MODIFIER_ICONS, HYPER_KEY_MODIFIERS_SET, MAC_MODIFIER_ICONS, SPECIAL_KEYS,
} from './constants';
import { logger } from './logger';

/**
 * Determines if the modifiers of a hotkey could be a hyper key command.
 * @param {Modifier[]} modifiers An array of modifiers
 * @returns {boolean} Do the modifiers make up a hyper key command
 */
function isHyperKey (modifiers: Modifier[]): boolean {
    if (modifiers.length !== 4) {
        return false;
    }

    return modifiers.every((m) => HYPER_KEY_MODIFIERS_SET.has(m));
}

/**
 * A utility that generates the text of a Hotkey for UIs
 * @param {Hotkey} hotkey The hotkey to generate text for
 * @returns {string} The hotkey text
 */
export function generateHotKeyText (
    hotkey: Hotkey,
    settings: BetterCommandPalettePluginSettings,
): string {
    let modifierIcons = Platform.isMacOS ? MAC_MODIFIER_ICONS : BASIC_MODIFIER_ICONS;

    if (settings.hotkeyStyle === 'mac') {
        modifierIcons = MAC_MODIFIER_ICONS;
    } else if (settings.hotkeyStyle === 'windows') {
        modifierIcons = BASIC_MODIFIER_ICONS;
    }

    const hotKeyStrings: string[] = [];

    if (settings.hyperKeyOverride && isHyperKey(hotkey.modifiers)) {
        hotKeyStrings.push(modifierIcons.Hyper);
    } else {
        hotkey.modifiers.forEach((mod: Modifier) => {
            hotKeyStrings.push(modifierIcons[mod]);
        });
    }

    const key = hotkey.key.toUpperCase();
    hotKeyStrings.push(SPECIAL_KEYS[key] || key);

    return hotKeyStrings.join(' ');
}

export function renderPrevItems (settings: BetterCommandPalettePluginSettings, match: Match, el: HTMLElement, prevItems: OrderedSet<Match>) {
    if (prevItems.has(match)) {
        el.addClass('recent');
        el.createEl('span', {
            cls: 'suggestion-note',
            text: settings.recentlyUsedText,
        });
    }
}

export function getCommandText (item: Command): string {
    return item.name;
}

/**
 * Validates and sanitizes user input for file paths
 */
export function validateFilePath(path: string): string {
    if (!path || typeof path !== 'string') {
        throw new Error('File path must be a non-empty string');
    }

    const sanitized = path.trim();
    
    if (!sanitized) {
        throw new Error('File path cannot be empty');
    }

    // Check for invalid characters (basic validation)
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(sanitized)) {
        throw new Error('File path contains invalid characters');
    }

    return sanitized;
}

export async function getOrCreateFile(app: App, path: string): Promise<TFile> {
    let file = app.metadataCache.getFirstLinkpathDest(path, '');

    if (!file) {
        const normalizedPath = normalizePath(`${path}.md`);
        const dirOnlyPath = normalizedPath.split('/').slice(0, -1).join('/');

        // Create directory if needed
        if (dirOnlyPath) {
            try {
                await app.vault.createFolder(dirOnlyPath);
            } catch (e) {
                // Only ignore "folder already exists" errors
                if (!e.message?.includes('already exists') && !e.message?.includes('Folder already exists')) {
                    logger.error('Failed to create directory:', e);
                    throw new Error(`Could not create directory: ${dirOnlyPath}`);
                }
            }
        }

        // Create file with better error handling
        try {
            file = await app.vault.create(normalizedPath, '');
        } catch (e) {
            logger.error('Failed to create file:', e);
            throw new Error(`Could not create file: ${normalizedPath}. ${e.message || 'Unknown error'}`);
        }
    }

    return file;
}

export function openFileWithEventKeys (
    app: App,
    settings: BetterCommandPalettePluginSettings,
    file: TFile,
    event: MouseEvent | KeyboardEvent,
) {
    // Figure if the file should be opened in a new tab
    const openInNewTab = settings.openInNewTabMod === 'Shift' ? event.shiftKey : event.metaKey || event.ctrlKey;

    // Open the file
    app.workspace.openLinkText(file.path, file.path, openInNewTab);
}

export function matchTag (tags: string[], tagQueries: string[]): boolean {
    for (let i = 0; i < tagQueries.length; i += 1) {
        const tagSearch = tagQueries[i];

        for (let ii = 0; ii < tags.length; ii += 1) {
            const tag = tags[ii];

            // If they are equal we have matched it
            if (tag === tagSearch) return true;

            // Check if the query could be a prefix for a nested tag
            const prefixQuery = `${tagSearch}/`;
            if (tag.startsWith(prefixQuery)) return true;
        }
    }
    return false;
}

export function createPaletteMatchesFromFilePath (
    metadataCache: UnsafeMetadataCacheInterface,
    filePath: string,
): PaletteMatch[] {
    // Get the cache item for the file so that we can extract its tags
    const fileCache = metadataCache.getCache(filePath);

    // Sometimes the cache keeps files that have been deleted
    if (!fileCache) return [];

    const cacheTags = (fileCache.tags || []).map((tc) => tc.tag);
    const frontmatterTags = parseFrontMatterTags(fileCache.frontmatter) || [];
    const tags = cacheTags.concat(frontmatterTags);

    const aliases = parseFrontMatterAliases(fileCache.frontmatter) || [];

    // Make the palette match
    return [
        new PaletteMatch(
            filePath,
            filePath, // Concat our aliases and path to make searching easy
            tags,
        ),
        ...aliases.map((alias: string) => new PaletteMatch(
            `${alias}:${filePath}`,
            alias,
            tags,
        )),
    ];
}

export async function createFolderIfNotExists(app: App, folderPath: string): Promise<void> {
    try {
        const folder = app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await app.vault.createFolder(folderPath);
        }
    } catch (e) {
        logger.error('Failed to create directory:', e);
        throw e;
    }
}

export async function createFileIfNotExists(app: App, filePath: string, content: string = ''): Promise<TFile> {
    try {
        let file = app.vault.getAbstractFileByPath(filePath) as TFile;
        if (!file) {
            file = await app.vault.create(filePath, content);
        }
        return file;
    } catch (e) {
        logger.error('Failed to create file:', e);
        throw e;
    }
}
