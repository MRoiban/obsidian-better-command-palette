import {
    Instruction, Notice, setIcon,
} from 'obsidian';
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

export default class BetterCommandPaletteFileAdapter extends SuggestModalAdapter {
    titleText: string;

    emptyStateText: string;

    // Unsafe interface
    app: UnsafeAppInterface;

    allItems: Match[];

    unresolvedItems: OrderedSet<Match>;

    fileSearchPrefix: string;

    initialize() {
        super.initialize();

        this.titleText = 'Better Command Palette: Files';
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
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.commandSearchHotkey }, this.plugin.settings), purpose: 'Search Commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.tagSearchHotkey }, this.plugin.settings), purpose: 'Search Tags' },
        ];
    }

    cleanQuery(query: string): string {
        const newQuery = query.replace(this.fileSearchPrefix, '');
        return newQuery;
    }

    renderSuggestion(match: Match, content: HTMLElement): void {
        let noteName = match.text;

        // Build the displayed note name without its full path if required in settings
        if (this.plugin.settings.displayOnlyNotesNames) {
            noteName = match.text.split('/').pop() || match.text;
        }

        // Build the displayed note name without its Markdown extension if required in settings
        if (this.plugin.settings.hideMdExtension && noteName.endsWith('.md')) {
            noteName = noteName.slice(0, -3);
        }

        // Create main title container
        const suggestionEl = content.createEl('div', {
            cls: 'suggestion-title',
        });

        // Add file type indicator
        this.addFileTypeIndicator(suggestionEl, match.text);

        // Smart path rendering - show folder structure more intelligently
        if (!this.plugin.settings.displayOnlyNotesNames && match.text.includes('/')) {
            this.renderSmartPath(suggestionEl, match.text, noteName);
        } else {
            suggestionEl.createEl('span', {
                cls: 'path-part filename',
                text: noteName,
            });
        }

        // Add unresolved styling if this is an unresolved link
        if (this.unresolvedItems.has(match)) {
            suggestionEl.addClass('unresolved');
        }

        // Handle aliases
        if (match.id.includes(':')) {
            suggestionEl.createEl('span', {
                cls: 'suggestion-name',
                text: match.text,
            }).ariaLabel = 'Alias';

            setIcon(suggestionEl, 'right-arrow-with-tail');

            const [, path] = match.id.split(':');
            suggestionEl.createEl('span', {
                cls: 'suggestion-note',
                text: path,
            });
        }

        // Enhanced tag rendering
        if (match.tags && match.tags.length > 0) {
            const tagsEl = content.createEl('div', {
                cls: 'suggestion-note',
            });

            match.tags.forEach((tag) => {
                if (tag.trim()) {
                    tagsEl.createEl('span', {
                        cls: 'tag',
                        text: tag.startsWith('#') ? tag : `#${tag}`,
                    });
                }
            });
        }
    }

    /**
     * Add file type indicator based on file extension
     */
    private addFileTypeIndicator(container: HTMLElement, filePath: string): void {
        const extension = this.getFileExtension(filePath);
        if (!extension) return;

        let typeClass = 'md';
        let typeText = 'MD';

        switch (extension.toLowerCase()) {
            case 'md':
                typeClass = 'md';
                typeText = 'MD';
                break;
            case 'txt':
                typeClass = 'txt';
                typeText = 'TXT';
                break;
            case 'pdf':
                typeClass = 'pdf';
                typeText = 'PDF';
                break;
            case 'png':
            case 'jpg':
            case 'jpeg':
            case 'gif':
            case 'svg':
                typeClass = 'img';
                typeText = 'IMG';
                break;
            default:
                typeText = extension.toUpperCase().substring(0, 3);
        }

        container.createEl('span', {
            cls: `file-type-indicator ${typeClass}`,
            text: typeText,
        });
    }

    /**
     * Get file extension from path
     */
    private getFileExtension(path: string): string | null {
        const match = path.match(/\.([^.]+)$/);
        return match ? match[1] : null;
    }

    /**
     * Smart path rendering that emphasizes filename while showing context
     * Now relies on CSS text-overflow: ellipsis for clipping
     */
    private renderSmartPath(container: HTMLElement, fullPath: string, displayName: string): void {
        // Simply set the full path and let CSS handle the ellipsis
        container.textContent = fullPath;

        // Always set the full path as tooltip
        container.title = fullPath;
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
            const [, path] = match.id.split(':');
            filePath = path;
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
