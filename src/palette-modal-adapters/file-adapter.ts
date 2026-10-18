import { Instruction, Notice, TFile } from 'obsidian';
import {
    generateHotKeyText,
    getOrCreateFile,
    openFileWithEventKeys,
    OrderedSet,
    PaletteMatch, SuggestModalAdapter,
    createPaletteMatchesFromFilePath,
} from 'src/utils';
import { Match, UnsafeAppInterface } from 'src/types/types';
import { ActionType } from 'src/utils/constants';
import { logger } from '../utils/logger';
import { SuggestionRowOptions } from '../ui/suggestion-row';
import { buildAliasRow, buildFileRow, buildUnresolvedRow } from '../ui/file-row';
import { getAliasTarget, getQueryTerms } from '../ui/suggestion-format';

export default class BetterCommandPaletteFileAdapter extends SuggestModalAdapter {
    modeLabel = 'Files';

    emptyStateText: string;

    // Unsafe interface
    app: UnsafeAppInterface;

    allItems: Match[];

    unresolvedItems: OrderedSet<Match>;

    fileSearchPrefix: string;

    initialize() {
        super.initialize();

        this.emptyStateText = 'No matching files.';
        this.fileSearchPrefix = this.plugin.settings.fileSearchPrefix;

        this.hiddenIds = this.plugin.settings.hiddenFiles;
        this.hiddenIdsSettingsKey = 'hiddenFiles';

        this.allItems = [];

        this.unresolvedItems = new OrderedSet<Match>();

        // Actually returns all files in the cache even if there are no unresolved links
        this.app.metadataCache.getCachedFiles()
            .forEach((filePath: string) => {
                // Validate file path
                if (!filePath || typeof filePath !== 'string') {
                    return;
                }

                const badfileType = this.plugin.settings.fileTypeExclusion.some((suf) => filePath.endsWith(`.${suf}`));

                // If we shouldn't show the file type just return right now
                if (badfileType) return;

                const matches = createPaletteMatchesFromFilePath(this.app.metadataCache, filePath);
                this.allItems = this.allItems.concat(matches);

                // Add unresolved links with validation
                const unresolvedLinks = this.app.metadataCache.unresolvedLinks[filePath];
                if (unresolvedLinks && typeof unresolvedLinks === 'object') {
                    Object.keys(unresolvedLinks).forEach((p) => {
                        if (p && typeof p === 'string' && p.trim()) {
                            this.unresolvedItems.add(new PaletteMatch(p, p));
                        }
                    });
                }
            });

        // Add the deduped links to all items
        this.allItems = this.allItems.concat(Array.from(this.unresolvedItems.values())).reverse();

        // Use obsidian's last open files as the previous items
        [...this.app.workspace.getLastOpenFiles()].reverse().forEach((filePath) => {
            const matches = createPaletteMatchesFromFilePath(this.app.metadataCache, filePath);

            // For previous items we only want the actual file, not any aliases
            if (matches[0]) {
                this.prevItems.add(matches[0]);
            }
        });
    }

    mount(): void {
        this.keymapHandlers = [
            this.palette.scope.register(['Mod'], this.plugin.settings.commandSearchHotkey, () => this.palette.changeActionType(ActionType.Commands)),
            this.palette.scope.register(['Mod'], this.plugin.settings.tagSearchHotkey, () => this.palette.changeActionType(ActionType.Tags)),
        ];
    }

    getInstructions(): Instruction[] {
        const { openInNewTabMod, createNewFileMod } = this.plugin.settings;
        return [
            { command: generateHotKeyText({ modifiers: [], key: 'ENTER' }, this.plugin.settings), purpose: 'Open file' },
            { command: generateHotKeyText({ modifiers: [openInNewTabMod], key: 'ENTER' }, this.plugin.settings), purpose: 'Open file in new pane' },
            { command: generateHotKeyText({ modifiers: [createNewFileMod], key: 'ENTER' }, this.plugin.settings), purpose: 'Create file' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.commandSearchHotkey }, this.plugin.settings), purpose: 'Search commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.tagSearchHotkey }, this.plugin.settings), purpose: 'Search tags' },
        ];
    }

    cleanQuery(query: string): string {
        // Only strip a leading prefix so cleaning is idempotent and paths keep their slashes
        return query.startsWith(this.fileSearchPrefix)
            ? query.slice(this.fileSearchPrefix.length)
            : query;
    }

    getSuggestionRow(match: Match): SuggestionRowOptions {
        const highlights = getQueryTerms(this.cleanQuery(this.palette.inputEl.value.trim()));

        if (this.unresolvedItems.has(match)) {
            return buildUnresolvedRow(match.text, highlights);
        }

        const aliasTarget = match.id.includes(':') ? getAliasTarget(match.id) : null;
        if (aliasTarget) {
            return buildAliasRow(match.text, aliasTarget, this.plugin.settings, highlights);
        }

        return buildFileRow({
            path: match.text,
            settings: this.plugin.settings,
            tags: match.tags,
            highlights,
        });
    }

    async onChooseSuggestion(match: Match | null, event?: MouseEvent | KeyboardEvent): Promise<void> {
        if (!match && event) {
            // Create new file
            const input = this.palette.inputEl;
            const filename = this.cleanQuery(input.value);

            if (filename) {
                try {
                    const file = await getOrCreateFile(this.app, filename);
                    if (!file) {
                        logger.warn('No file was created or found');
                        return;
                    }
                    openFileWithEventKeys(this.app, this.plugin.settings, file, event);
                } catch (error) {
                    logger.error('Error choosing file suggestion:', error);
                }
            }
            return;
        }

        if (!match) return;

        // Handle file or alias selection
        let filePath = match.text;
        if (match.id.includes(':')) {
            filePath = getAliasTarget(match.id) || filePath;
        }

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file) {
            new Notice(`File not found: ${filePath}`);
            return;
        }

        // Ensure it's a TFile before passing to openFileWithEventKeys
        if (!(file instanceof TFile)) {
            new Notice(`Path is not a file: ${filePath}`);
            return;
        }

        try {
            openFileWithEventKeys(this.app, this.plugin.settings, file, event);

            // Add to previous items
            this.prevItems.add(match);
        } catch (error) {
            new Notice(`Failed to open file: ${error.message}`);
        }
    }
}
