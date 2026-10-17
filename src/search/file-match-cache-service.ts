import {
    TAbstractFile, TFile, parseFrontMatterAliases, parseFrontMatterTags,
} from 'obsidian';
import { BetterCommandPalettePluginSettings } from 'src/settings';
import { Match, UnsafeAppInterface } from 'src/types/types';
import PaletteMatch from 'src/utils/palette-match';

type FileEntry = {
    primary: Match;
    matches: Match[];
};

export class FileMatchCacheService {
    private app: UnsafeAppInterface;

    private settings: BetterCommandPalettePluginSettings;

    private fileEntries = new Map<string, FileEntry>();

    private unresolvedLinksBySource = new Map<string, Set<string>>();

    private unresolvedCounts = new Map<string, number>();

    private combinedMatches: Match[] = [];

    private version = 0;

    private combinedDirty = true;

    constructor(app: UnsafeAppInterface, settings: BetterCommandPalettePluginSettings) {
        this.app = app;
        this.settings = settings;
    }

    initialize(): void {
        this.fileEntries.clear();
        this.unresolvedLinksBySource.clear();
        this.unresolvedCounts.clear();

        this.app.vault.getFiles().forEach((file) => {
            this.upsertFile(file);
        });

        Object.keys(this.app.metadataCache.unresolvedLinks).forEach((sourcePath) => {
            this.updateUnresolvedLinksForSource(sourcePath);
        });

        this.markChanged();
    }

    updateSettings(settings: BetterCommandPalettePluginSettings): void {
        this.settings = settings;
    }

    rebuild(): void {
        this.initialize();
    }

    getVersion(): number {
        return this.version;
    }

    getAllMatches(): Match[] {
        if (this.combinedDirty) {
            const fileMatches = Array.from(this.fileEntries.entries())
                .sort(([left], [right]) => left.localeCompare(right))
                .flatMap(([, entry]) => entry.matches);

            const unresolvedMatches = Array.from(this.unresolvedCounts.keys())
                .sort((left, right) => left.localeCompare(right))
                .map((linkText) => new PaletteMatch(linkText, linkText));

            this.combinedMatches = fileMatches.concat(unresolvedMatches).reverse();
            this.combinedDirty = false;
        }

        return this.combinedMatches;
    }

    getPrimaryMatch(filePath: string): Match | undefined {
        return this.fileEntries.get(filePath)?.primary;
    }

    isUnresolvedId(id: string): boolean {
        return this.unresolvedCounts.has(id);
    }

    onCreate(file: TAbstractFile): void {
        if (!(file instanceof TFile)) {
            return;
        }

        this.upsertFile(file);
    }

    onMetadataChanged(file: TFile): void {
        this.upsertFile(file);
        this.updateUnresolvedLinksForSource(file.path);
    }

    onDelete(file: TAbstractFile): void {
        if (!(file instanceof TFile)) {
            return;
        }

        const didRemove = this.fileEntries.delete(file.path);
        const didRemoveUnresolved = this.clearUnresolvedLinksForSource(file.path);

        if (didRemove || didRemoveUnresolved) {
            this.markChanged();
        }
    }

    onRename(file: TAbstractFile, oldPath: string): void {
        const didRemove = this.fileEntries.delete(oldPath);
        const didRemoveUnresolved = this.clearUnresolvedLinksForSource(oldPath);

        if (file instanceof TFile) {
            this.upsertFile(file);
            this.updateUnresolvedLinksForSource(file.path);
            return;
        }

        if (didRemove || didRemoveUnresolved) {
            this.markChanged();
        }
    }

    private upsertFile(file: TFile): void {
        if (this.isExcluded(file.path)) {
            if (this.fileEntries.delete(file.path)) {
                this.markChanged();
            }
            return;
        }

        const fileCache = this.app.metadataCache.getFileCache(file)
            || this.app.metadataCache.getCache(file.path);
        const cacheTags = (fileCache?.tags || []).map((tagCache) => tagCache.tag);
        const frontmatterTags = parseFrontMatterTags(fileCache?.frontmatter) || [];
        const tags = cacheTags.concat(frontmatterTags);
        const aliases = parseFrontMatterAliases(fileCache?.frontmatter) || [];

        const primary = new PaletteMatch(file.path, file.path, tags);
        const matches = [
            primary,
            ...aliases
                .filter((alias): alias is string => typeof alias === 'string' && alias.trim().length > 0)
                .map((alias) => new PaletteMatch(`${alias}:${file.path}`, alias, tags)),
        ];

        const previous = this.fileEntries.get(file.path);
        this.fileEntries.set(file.path, { primary, matches });

        if (!previous || !this.areMatchListsEqual(previous.matches, matches)) {
            this.markChanged();
        }
    }

    private updateUnresolvedLinksForSource(sourcePath: string): void {
        const unresolvedLinks = this.app.metadataCache.unresolvedLinks[sourcePath];
        const nextLinks = new Set(
            unresolvedLinks && typeof unresolvedLinks === 'object'
                ? Object.keys(unresolvedLinks).filter((linkText) => linkText.trim().length > 0)
                : [],
        );

        this.replaceUnresolvedLinksForSource(sourcePath, nextLinks);
    }

    private clearUnresolvedLinksForSource(sourcePath: string): boolean {
        return this.replaceUnresolvedLinksForSource(sourcePath, new Set<string>());
    }

    private replaceUnresolvedLinksForSource(sourcePath: string, nextLinks: Set<string>): boolean {
        const previousLinks = this.unresolvedLinksBySource.get(sourcePath) || new Set<string>();
        let changed = previousLinks.size !== nextLinks.size;

        previousLinks.forEach((linkText) => {
            if (!nextLinks.has(linkText)) {
                changed = true;
                this.decrementUnresolvedCount(linkText);
            }
        });

        nextLinks.forEach((linkText) => {
            if (!previousLinks.has(linkText)) {
                changed = true;
                this.incrementUnresolvedCount(linkText);
            }
        });

        if (!changed) {
            return false;
        }

        if (nextLinks.size > 0) {
            this.unresolvedLinksBySource.set(sourcePath, nextLinks);
        } else {
            this.unresolvedLinksBySource.delete(sourcePath);
        }

        this.markChanged();
        return true;
    }

    private incrementUnresolvedCount(linkText: string): void {
        this.unresolvedCounts.set(linkText, (this.unresolvedCounts.get(linkText) || 0) + 1);
    }

    private decrementUnresolvedCount(linkText: string): void {
        const nextCount = (this.unresolvedCounts.get(linkText) || 0) - 1;

        if (nextCount > 0) {
            this.unresolvedCounts.set(linkText, nextCount);
            return;
        }

        this.unresolvedCounts.delete(linkText);
    }

    private isExcluded(filePath: string): boolean {
        return this.settings.fileTypeExclusion.some((suffix) => filePath.endsWith(`.${suffix}`));
    }

    private markChanged(): void {
        this.version += 1;
        this.combinedDirty = true;
    }

    private areMatchListsEqual(left: Match[], right: Match[]): boolean {
        if (left.length !== right.length) {
            return false;
        }

        return left.every((match, index) => {
            const other = right[index];
            return match.id === other.id
                && match.text === other.text
                && match.tags.length === other.tags.length
                && match.tags.every((tag, tagIndex) => tag === other.tags[tagIndex]);
        });
    }
}
