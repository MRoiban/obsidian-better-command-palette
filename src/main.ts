import { Plugin, Notice } from 'obsidian';

import SuggestionsWorker from 'web-worker:./web-workers/suggestions-worker';
import { OrderedSet, MacroCommand } from 'src/utils';
import BetterCommandPaletteModal from 'src/palette';
import { Match, UnsafeAppInterface } from 'src/types/types';
import { BetterCommandPalettePluginSettings, BetterCommandPaletteSettingTab, DEFAULT_SETTINGS } from 'src/settings';
import { MACRO_COMMAND_ID_PREFIX } from './utils/constants';
import { EnhancedSearchService } from './search/enhanced-search-service';
import './styles.scss';

export default class BetterCommandPalettePlugin extends Plugin {
    app: UnsafeAppInterface;

    settings: BetterCommandPalettePluginSettings;

    prevCommands: OrderedSet<Match>;

    prevTags: OrderedSet<Match>;

    suggestionsWorker: Worker;

    searchService: EnhancedSearchService;

    async onload() {
        // eslint-disable-next-line no-console
        console.log('Loading plugin: Better Command Palette');

        await this.loadSettings();

        this.prevCommands = new OrderedSet<Match>();
        this.prevTags = new OrderedSet<Match>();
        this.suggestionsWorker = new SuggestionsWorker({});

        // Initialize enhanced search service
        this.searchService = new EnhancedSearchService(this.app, this.settings.enhancedSearch);
        
        // Wait for workspace to be ready before initializing search service
        if (this.app.workspace.layoutReady) {
            // If layout is already ready, initialize immediately
            this.searchService.initialize().catch(error => {
                console.error('Failed to initialize enhanced search service:', error);
            });
        } else {
            // Otherwise wait for layout ready event
            this.app.workspace.onLayoutReady(() => {
                this.searchService.initialize().catch(error => {
                    console.error('Failed to initialize enhanced search service:', error);
                });
            });
        }

        this.addCommand({
            id: 'open-better-command-palette',
            name: 'Open better command palette',
            // Generally I would not set a hotkey, but since it is a
            // command palette I think it makes sense
            // Can still be overwritten in the hotkey settings
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'p' }],
            callback: () => {
                new BetterCommandPaletteModal(
                    this.app,
                    this.prevCommands,
                    this.prevTags,
                    this,
                    this.suggestionsWorker,
                    this.searchService,
                ).open();
            },
        });

        this.addCommand({
            id: 'open-better-command-palette-file-search',
            name: 'Open better command palette: File Search',
            hotkeys: [],
            callback: () => {
                new BetterCommandPaletteModal(
                    this.app,
                    this.prevCommands,
                    this.prevTags,
                    this,
                    this.suggestionsWorker,
                    this.searchService,
                    this.settings.fileSearchPrefix,
                ).open();
            },
        });

        this.addCommand({
            id: 'open-better-command-palette-tag-search',
            name: 'Open better command palette: Tag Search',
            hotkeys: [],
            callback: () => {
                new BetterCommandPaletteModal(
                    this.app,
                    this.prevCommands,
                    this.prevTags,
                    this,
                    this.suggestionsWorker,
                    this.searchService,
                    this.settings.tagSearchPrefix,
                ).open();
            },
        });

        // Add debugging command for manual indexing
        this.addCommand({
            id: 'trigger-enhanced-search-indexing',
            name: 'Enhanced Search: Trigger Manual Indexing',
            callback: async () => {
                if (this.searchService) {
                    await this.searchService.triggerVaultIndexing();
                }
            },
        });

        // Add command to pause indexing for better performance
        this.addCommand({
            id: 'pause-enhanced-search-indexing',
            name: 'Enhanced Search: Pause Indexing',
            callback: () => {
                if (this.searchService) {
                    this.searchService.pauseIndexing();
                    new Notice('Enhanced search indexing paused');
                }
            },
        });

        // Add command to resume indexing
        this.addCommand({
            id: 'resume-enhanced-search-indexing',
            name: 'Enhanced Search: Resume Indexing',
            callback: () => {
                if (this.searchService) {
                    this.searchService.resumeIndexing();
                    new Notice('Enhanced search indexing resumed');
                }
            },
        });

        this.addSettingTab(new BetterCommandPaletteSettingTab(this.app, this));
    }

    onunload(): void {
        this.suggestionsWorker.terminate();
        
        // Cleanup search service
        if (this.searchService) {
            this.searchService.shutdown().catch(error => {
                console.error('Error shutting down search service:', error);
            });
        }
    }

    loadMacroCommands() {
        this.settings.macros.forEach((macroData, index) => {
            if (!macroData.name || !macroData.commandIds.length) {
                return;
            }

            const macro = new MacroCommand(
                this.app,
                `${MACRO_COMMAND_ID_PREFIX}${index}`,
                macroData.name,
                macroData.commandIds,
                macroData.delay,
            );

            this.addCommand(macro);

            if (this.prevCommands) {
                this.prevCommands = this.prevCommands.values().reduce((acc, match) => {
                    if (match.id === macro.id && match.text !== macro.name) return acc;

                    acc.add(match);

                    return acc;
                }, new OrderedSet<Match>());
            }
        });
    }

    deleteMacroCommands() {
        const macroCommandIds = Object.keys(this.app.commands.commands)
            .filter((id) => id.includes(MACRO_COMMAND_ID_PREFIX));

        macroCommandIds.forEach((id) => {
            this.app.commands.removeCommand(id);
        });
    }

    async loadSettings() {
        this.settings = { ...DEFAULT_SETTINGS, ...await this.loadData() };
        this.loadMacroCommands();
    }

    async saveSettings() {
        this.deleteMacroCommands();
        await this.saveData(this.settings);
        this.loadMacroCommands();
    }
}
