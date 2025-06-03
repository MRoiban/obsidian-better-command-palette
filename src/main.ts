import { Plugin, Notice, debounce, TFile } from 'obsidian';

import SuggestionsWorker from 'web-worker:./web-workers/suggestions-worker';
import { OrderedSet, MacroCommand } from 'src/utils';
import BetterCommandPaletteModal from 'src/palette';
import { Match, UnsafeAppInterface } from 'src/types/types';
import { BetterCommandPalettePluginSettings, BetterCommandPaletteSettingTab, DEFAULT_SETTINGS } from 'src/settings';
import { MACRO_COMMAND_ID_PREFIX } from './utils/constants';
import { EnhancedSearchService } from './search/enhanced-search-service';
import { EmbeddingService, SemanticSearchEngine, SemanticSearchModal, SemanticIndexingCoordinator } from './search/semantic';
import './styles.scss';

export default class BetterCommandPalettePlugin extends Plugin {
    app: UnsafeAppInterface;

    settings: BetterCommandPalettePluginSettings;

    prevCommands: OrderedSet<Match>;

    prevTags: OrderedSet<Match>;

    suggestionsWorker: Worker;

    searchService: EnhancedSearchService;

    // Semantic search components
    embeddingService: EmbeddingService;
    semanticSearchEngine: SemanticSearchEngine;
    semanticIndexingCoordinator: SemanticIndexingCoordinator;
    private indexingInProgress = false;

    async onload() {
        // eslint-disable-next-line no-console
        console.log('Loading plugin: Better Command Palette');

        await this.loadSettings();

        this.prevCommands = new OrderedSet<Match>();
        this.prevTags = new OrderedSet<Match>();
        this.suggestionsWorker = new SuggestionsWorker({});

        // Initialize enhanced search service
        this.searchService = new EnhancedSearchService(this.app, this.settings.enhancedSearch);
        
        // Wait for workspace to be ready before initializing search services
        if (this.app.workspace.layoutReady) {
            // If layout is already ready, initialize immediately
            console.log('Workspace layout already ready, initializing search services immediately');
            this.searchService.initialize().catch(error => {
                console.error('Failed to initialize enhanced search service:', error);
            });
            
            // Initialize semantic search if enabled
            if (this.settings.semanticSearch.enableSemanticSearch) {
                console.log('Semantic search enabled, initializing immediately');
                this.initializeSemanticSearch().catch(error => {
                    console.error('Failed to initialize semantic search:', error);
                });
            }
        } else {
            // Otherwise wait for layout ready event
            console.log('Workspace layout not ready, waiting for layout-ready event before initializing search services');
            this.app.workspace.onLayoutReady(() => {
                console.log('Workspace layout ready event received, initializing search services');
                this.searchService.initialize().catch(error => {
                    console.error('Failed to initialize enhanced search service:', error);
                });
                
                // Initialize semantic search if enabled
                if (this.settings.semanticSearch.enableSemanticSearch) {
                    console.log('Semantic search enabled, initializing after workspace ready');
                    this.initializeSemanticSearch().catch(error => {
                        console.error('Failed to initialize semantic search:', error);
                    });
                }
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

        // Add semantic search commands
        this.addCommand({
            id: 'open-semantic-search',
            name: 'Open semantic search',
            hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 's' }],
            callback: () => {
                if (this.settings.semanticSearch.enableSemanticSearch && this.semanticSearchEngine) {
                    new SemanticSearchModal(this.app, this).open();
                } else {
                    new Notice('Semantic search is not enabled or not initialized');
                }
            },
        });

        this.addCommand({
            id: 'reindex-semantic-search',
            name: 'Reindex semantic search',
            callback: async () => {
                await this.reindexSemanticSearch();
            },
        });

        this.addCommand({
            id: 'clear-and-reindex-semantic-search',
            name: 'Clear semantic search cache and reindex',
            callback: async () => {
                if (this.embeddingService) {
                    this.embeddingService.clearCache();
                    new Notice('Semantic search cache cleared. Starting reindex...');
                    await this.reindexSemanticSearch();
                } else {
                    new Notice('Semantic search is not initialized');
                }
            },
        });

        this.addCommand({
            id: 'debug-semantic-search-settings',
            name: 'Debug semantic search settings',
            callback: () => {
                if (this.settings.semanticSearch) {
                    console.log('Current semantic search settings:', this.settings.semanticSearch);
                    console.log('Exclusion patterns:', this.settings.semanticSearch.excludePatterns);
                    new Notice(`Exclusion patterns: ${this.settings.semanticSearch.excludePatterns.join(', ')}`);
                } else {
                    new Notice('Semantic search settings not found');
                }
            },
        });

        // Add ribbon icon for semantic search
        if (this.settings.semanticSearch.enableSemanticSearch) {
            this.addRibbonIcon('search', 'Open semantic search', () => {
                if (this.semanticSearchEngine) {
                    new SemanticSearchModal(this.app, this).open();
                } else {
                    new Notice('Semantic search is not initialized');
                }
            });
        }

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

        // Cleanup semantic search services using the coordinator
        if (this.semanticIndexingCoordinator) {
            this.semanticIndexingCoordinator.shutdown().catch(error => {
                console.error('Error shutting down semantic indexing coordinator:', error);
            });
        }
    }

    /**
     * Initialize semantic search components
     */
    async initializeSemanticSearch(): Promise<void> {
        try {
            console.log('Semantic search: Initializing after workspace is ready...');
            
            this.embeddingService = new EmbeddingService(
                this.app.vault,
                this.app.metadataCache,
                this.settings.semanticSearch
            );

            await this.embeddingService.initialize();

            this.semanticSearchEngine = new SemanticSearchEngine(
                this.embeddingService,
                this.app.vault,
                this.app.metadataCache,
                this.settings.semanticSearch
            );

            // Initialize the semantic indexing coordinator
            this.semanticIndexingCoordinator = new SemanticIndexingCoordinator(
                this.app,
                this.embeddingService,
                this.settings.semanticSearch
            );

            await this.semanticIndexingCoordinator.initialize();

            // Register file change events for incremental indexing using the coordinator
            this.registerEvent(
                this.app.vault.on('create', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.indexFile(file);
                    }
                })
            );

            this.registerEvent(
                this.app.vault.on('modify', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.indexFile(file);
                    }
                })
            );

            this.registerEvent(
                this.app.vault.on('delete', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.removeFile(file.path);
                    }
                })
            );

            this.registerEvent(
                this.app.vault.on('rename', (file, oldPath) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.renameFile(oldPath, file.path);
                    }
                })
            );

            console.log('Semantic search: Initialization completed successfully after workspace ready');
            
            // Auto-index files if cache is empty using the coordinator
            await this.semanticIndexingCoordinator.checkAndAutoIndex();
            
        } catch (error) {
            console.error('Semantic search: Failed to initialize after workspace ready:', error);
            new Notice('Failed to initialize semantic search. Check console for details.');
        }
    }

    /**
     * Reindex all files for semantic search
     */
    public async reindexSemanticSearch(): Promise<void> {
        if (!this.settings.semanticSearch.enableSemanticSearch) {
            throw new Error('Semantic search is not enabled');
        }

        if (!this.semanticIndexingCoordinator) {
            await this.initializeSemanticSearch();
        }

        if (!this.semanticIndexingCoordinator) {
            throw new Error('Failed to initialize semantic indexing coordinator');
        }

        // Use the coordinator for reindexing
        await this.semanticIndexingCoordinator.indexAllFiles();
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
        
        // Update semantic search settings if initialized
        this.updateSemanticSearchSettings();
    }

    /**
     * Update semantic search settings across all components
     */
    private updateSemanticSearchSettings(): void {
        if (this.embeddingService) {
            this.embeddingService.updateSettings(this.settings.semanticSearch);
        }
        
        if (this.semanticSearchEngine) {
            this.semanticSearchEngine.updateSettings(this.settings.semanticSearch);
        }
        
        if (this.semanticIndexingCoordinator) {
            this.semanticIndexingCoordinator.updateSettings(this.settings.semanticSearch);
        }
    }

    /**
     * Returns the embedding service instance for semantic search.
     */
    public getEmbeddingService(): EmbeddingService | undefined {
        return this.embeddingService;
    }

    /**
     * Returns the semantic search engine instance.
     */
    public getSemanticSearchEngine(): SemanticSearchEngine | undefined {
        return this.semanticSearchEngine;
    }
}
