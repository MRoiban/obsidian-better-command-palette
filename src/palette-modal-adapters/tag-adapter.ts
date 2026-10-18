import { Instruction } from 'obsidian';
import {
    generateHotKeyText,
    PaletteMatch, SuggestModalAdapter,
}
    from 'src/utils';
import { ActionType, QUERY_TAG } from 'src/utils/constants';
import { Match, UnsafeAppInterface, WorkerMode } from '../types/types';
import { SuggestionRowOptions } from '../ui/suggestion-row';
import { formatNoteCount, getQueryTerms } from '../ui/suggestion-format';

export default class BetterCommandPaletteTagAdapter extends SuggestModalAdapter {
    modeLabel = 'Tags';

    emptyStateText: string;

    // Unsafe interface
    app: UnsafeAppInterface;

    allItems: Match[];

    tagSearchPrefix: string;

    getWorkerMode(): WorkerMode {
        return 'tags';
    }

    initialize(): void {
        super.initialize();

        this.hiddenIds = [...this.plugin.settings.hiddenTags];
        this.hiddenIdsSettingsKey = 'hiddenTags';

        this.tagSearchPrefix = this.plugin.settings.tagSearchPrefix;
        this.emptyStateText = 'No matching tags.';

        this.setItems(Object.entries(this.app.metadataCache.getTags())
            .map(([tag, count]) => new PaletteMatch(tag, tag, [String(count)])));
    }

    mount(): void {
        this.keymapHandlers = [
            this.palette.scope.register(['Mod'], this.plugin.settings.commandSearchHotkey, () => this.palette.changeActionType(ActionType.Commands)),
            this.palette.scope.register(['Mod'], this.plugin.settings.fileSearchHotkey, () => this.palette.changeActionType(ActionType.Files)),
        ];
    }

    getInstructions(): Instruction[] {
        return [
            { command: generateHotKeyText({ modifiers: [], key: 'ENTER' }, this.plugin.settings), purpose: 'See file usage' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.commandSearchHotkey }, this.plugin.settings), purpose: 'Search commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.fileSearchHotkey }, this.plugin.settings), purpose: 'Search files' },
        ];
    }

    cleanQuery(query: string): string {
        return query.startsWith(this.tagSearchPrefix)
            ? query.slice(this.tagSearchPrefix.length)
            : query;
    }

    getSuggestionRow(match: Match): SuggestionRowOptions {
        const count = parseInt(match.tags[0] ?? '0', 10);
        const query = this.cleanQuery(this.palette.inputEl.value.trim());

        return {
            title: match.text,
            highlights: getQueryTerms(query, 1),
            auxText: formatNoteCount(count),
        };
    }

    async onChooseSuggestion(match: Match | null) {
        if (!match) {
            // Tags don't support creating new items
            return;
        }

        this.recordRecentMatch(match);
        this.palette.open();
        this.palette.setQuery(`${this.plugin.settings.fileSearchPrefix}${QUERY_TAG}${match.text}`, 1);
    }
}
