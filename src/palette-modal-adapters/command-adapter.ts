import { Command, Instruction } from 'obsidian';
import {
    generateHotKeyText, PaletteMatch, SuggestModalAdapter,
} from 'src/utils';
import { Match, UnsafeAppInterface, WorkerMode } from 'src/types/types';
import { ActionType } from 'src/utils/constants';
import { SuggestionRowOptions } from 'src/ui/suggestion-row';
import { logger } from '../utils/logger';

export default class BetterCommandPaletteCommandAdapter extends SuggestModalAdapter {
    modeLabel = 'Commands';

    emptyStateText: string;

    COMMAND_PLUGIN_NAME_SEPARATOR = ': ';

    // Unsafe Interfaces
    app: UnsafeAppInterface;

    allItems: Match[];

    pinnedItems: Match[];

    getWorkerMode(): WorkerMode {
        return 'commands';
    }

    initialize() {
        super.initialize();

        this.emptyStateText = 'No matching commands.';

        this.hiddenIds = [...this.plugin.settings.hiddenCommands];
        this.hiddenIdsSettingsKey = 'hiddenCommands';

        this.setItems(this.app.commands.listCommands()
            .sort((a: Command, b: Command) => b.name.localeCompare(a.name))
            .map((c: Command): Match => new PaletteMatch(c.id, c.name)));

        const pinnedCommands = this.app.internalPlugins.getPluginById('command-palette').instance.options.pinned || [];
        this.setPinnedItems(pinnedCommands.reduce(
            (acc: Match[], id: string): Match[] => {
                const command = this.app.commands.findCommand(id);

                // If a command was pinned and then the plugin removed we won't have a command here
                if (command) {
                    acc.push(new PaletteMatch(id, command.name));
                }

                return acc;
            },
            [],
        ).reverse());
    }

    mount(): void {
        this.keymapHandlers = [
            this.palette.scope.register(['Mod'], this.plugin.settings.fileSearchHotkey, () => this.palette.changeActionType(ActionType.Files)),
            this.palette.scope.register(['Mod'], this.plugin.settings.tagSearchHotkey, () => this.palette.changeActionType(ActionType.Tags)),
        ];
    }

    getInstructions(): Instruction[] {
        return [
            { command: generateHotKeyText({ modifiers: [], key: 'ENTER' }, this.plugin.settings), purpose: 'Run command' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.fileSearchHotkey }, this.plugin.settings), purpose: 'Search files' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.tagSearchHotkey }, this.plugin.settings), purpose: 'Search tags' },
        ];
    }

    getSuggestionRow(match: Match): SuggestionRowOptions {
        const command = this.app.commands.findCommand(match.id);

        // If hotkeys have been customized in some way (add new, deleted default)
        // customHotkeys will be an array, otherwise undefined
        // If there is a default hotkey defaultHotkeys will be an array
        // (does not check any customization), otherwise undefined.
        const customHotkeys = command ? this.app.hotkeyManager.getHotkeys(command.id) : undefined;
        const defaultHotkeys = command ? this.app.hotkeyManager.getDefaultHotkeys(command.id) : undefined;
        const hotkeys = customHotkeys || defaultHotkeys || [];

        let { text } = match;
        let prefix = '';

        // Has a plugin name prefix. This is also how the core command palette splits it.
        if (text.includes(this.COMMAND_PLUGIN_NAME_SEPARATOR)) {
            const split = text.split(this.COMMAND_PLUGIN_NAME_SEPARATOR);
            prefix = split.shift() ?? '';
            text = split.join(this.COMMAND_PLUGIN_NAME_SEPARATOR);
        }

        return {
            title: text,
            titlePrefix: prefix && this.plugin.settings.showPluginName
                ? `${prefix}${this.COMMAND_PLUGIN_NAME_SEPARATOR}`
                : undefined,
            hotkeys: hotkeys.map((hotkey) => generateHotKeyText(hotkey, this.plugin.settings)),
            pinned: this.getPinnedItems().some((item) => item.id === match.id),
        };
    }

    async onChooseSuggestion(match: Match | null, _event?: MouseEvent | KeyboardEvent): Promise<void> {
        if (!match) return;

        try {
            const command = this.app.commands.commands[match.id];
            if (command) {
                await this.app.commands.executeCommandById(match.id);

                // Add to previous items
                this.recordRecentMatch(match);
            }
        } catch (error) {
            logger.error('Error executing command:', error);
        }
    }
}
