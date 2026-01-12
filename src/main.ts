import { Plugin, Notice, TFile } from 'obsidian';

import SuggestionsWorker from 'web-worker:./web-workers/suggestions-worker';
import { OrderedSet, MacroCommand } from 'src/utils';
import BetterCommandPaletteModal from 'src/palette';
import { Match, UnsafeAppInterface } from 'src/types/types';
import { BetterCommandPalettePluginSettings, DEFAULT_SETTINGS } from 'src/settings';
import { BetterCommandPaletteSettingTab } from 'src/settings/settings-tab';
import { MACRO_COMMAND_ID_PREFIX, ActionType } from './utils/constants';
import { EnhancedSearchService } from './search/enhanced-search-service';
import {
    EmbeddingService, SemanticSearchEngine, SemanticSearchModal, SemanticIndexingCoordinator,
} from './search/semantic';
import { HybridSearchService } from './search/hybrid/hybrid-search-service';
import { FileUsageTracker } from './search/usage-tracker';
import { LinkGraphService } from './search/link-graph-service';
import { QuickLinkModal } from './ui/quick-link-modal';
import { logger, LogLevel } from './utils/logger';
import './styles.scss';

export default class BetterCommandPalettePlugin extends Plugin {
    app!: UnsafeAppInterface;

    settings!: BetterCommandPalettePluginSettings;

    prevCommands!: OrderedSet<Match>;

    prevTags!: OrderedSet<Match>;

    suggestionsWorker!: Worker;

    searchService!: EnhancedSearchService;

    // Semantic search components
    embeddingService!: EmbeddingService;

    semanticSearchEngine!: SemanticSearchEngine;

    semanticIndexingCoordinator!: SemanticIndexingCoordinator;

    // Hybrid search service
    hybridSearchService!: HybridSearchService;

    usageTracker!: FileUsageTracker;

    // Link graph service for PageRank scoring
    linkGraphService!: LinkGraphService;

    // Last queries for preserve query functionality
    lastSemanticQuery: string = '';

    lastFileQuery: string = '';

    async onload() {
        // Enable verbose debug logging during development
        logger.setLogLevel(LogLevel.DEBUG);
        logger.info('Loading plugin: Better Command Palette');

        await this.loadSettings();

        this.prevCommands = new OrderedSet<Match>();
        this.prevTags = new OrderedSet<Match>();
        this.suggestionsWorker = new SuggestionsWorker({});

        // Initialize enhanced search service
        this.searchService = new EnhancedSearchService(this.app, this.settings.enhancedSearch);

        // Initialize usage tracker (shared between services)
        this.usageTracker = new FileUsageTracker();

        // Initialize link graph service (shared between services)
        this.linkGraphService = new LinkGraphService(this.app, this.settings.linkGraph);
        this.registerLinkGraphEvents();

        // Wait for workspace to be ready before initializing search services
        if (this.app.workspace.layoutReady) {
            // If layout is already ready, initialize immediately
            logger.debug('Workspace layout already ready, initializing search services immediately');

            // Start link graph computation
            this.linkGraphService.recompute().catch((error) => {
                logger.error('Failed to compute link graph:', error);
            });

            this.searchService.initialize().catch((error) => {
                logger.error('Failed to initialize enhanced search service:', error);
            });

            // Initialize semantic search if enabled
            if (this.settings.semanticSearch.enableSemanticSearch) {
                logger.debug('Semantic search enabled, initializing immediately');
                this.initializeSemanticSearch().then(() => {
                    // Initialize hybrid search after semantic search is ready
                    this.initializeHybridSearch();
                }).catch((error) => {
                    logger.error('Failed to initialize semantic search:', error);
                    // Still initialize hybrid search without semantic
                    this.initializeHybridSearch();
                });
            } else {
                // Initialize hybrid search without semantic
                this.initializeHybridSearch();
            }
        } else {
            // Otherwise wait for layout ready event
            logger.debug('Workspace layout not ready, waiting for layout-ready event before initializing search services');
            this.app.workspace.onLayoutReady(() => {
                logger.debug('Workspace layout ready event received, initializing search services');

                // Start link graph computation
                this.linkGraphService.recompute().catch((error) => {
                    logger.error('Failed to compute link graph:', error);
                });

                this.searchService.initialize().catch((error) => {
                    logger.error('Failed to initialize enhanced search service:', error);
                });

                // Initialize semantic search if enabled
                if (this.settings.semanticSearch.enableSemanticSearch) {
                    logger.debug('Semantic search enabled, initializing after workspace ready');
                    this.initializeSemanticSearch().then(() => {
                        // Initialize hybrid search after semantic search is ready
                        this.initializeHybridSearch();
                    }).catch((error) => {
                        logger.error('Failed to initialize semantic search:', error);
                        // Still initialize hybrid search without semantic
                        this.initializeHybridSearch();
                    });
                } else {
                    // Initialize hybrid search without semantic
                    this.initializeHybridSearch();
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
                    this.hybridSearchService,
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
                    this.hybridSearchService,
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
                    this.hybridSearchService,
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

        // Add hybrid search command
        this.addCommand({
            id: 'open-hybrid-search',
            name: 'Open hybrid search (keyword + semantic)',
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: this.settings.hybridSearch.searchHotkey }],
            callback: () => {
                if (this.settings.hybridSearch.enabled && this.hybridSearchService?.isReady()) {
                    new BetterCommandPaletteModal(
                        this.app,
                        this.prevCommands,
                        this.prevTags,
                        this,
                        this.suggestionsWorker,
                        this.searchService,
                        this.hybridSearchService,
                        '', // No prefix when opened directly via hotkey
                        ActionType.Hybrid, // Force hybrid mode
                    ).open();
                } else {
                    new Notice('Hybrid search is not enabled or not initialized');
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

        // Add Quick Link command
        this.addCommand({
            id: 'create-quick-link',
            name: 'Create quick link from selection',
            hotkeys: this.settings.quickLink.enabled ? [{ modifiers: ['Mod', 'Shift'], key: this.settings.quickLink.defaultHotkey }] : [],
            editorCallback: (editor, view) => {
                if (!this.settings.quickLink.enabled) {
                    new Notice('Quick Link feature is disabled in settings');
                    return;
                }

                const selectedText = editor.getSelection();
                if (!selectedText) {
                    new Notice('Please select text first');
                    return;
                }

                if (!view.file) {
                    new Notice('No active file');
                    return;
                }

                new QuickLinkModal(this.app, this, selectedText, view.file, editor).open();
            },
        });

        this.addCommand({
            id: 'debug-semantic-search-settings',
            name: 'Debug semantic search settings',
            callback: () => {
                if (this.settings.semanticSearch) {
                    logger.debug('Current semantic search settings:', this.settings.semanticSearch);
                    logger.debug('Exclusion patterns:', this.settings.semanticSearch.excludePatterns);
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
            this.searchService.shutdown().catch((error) => {
                logger.error('Error shutting down search service:', error);
            });
        }

        // Cleanup hybrid search service
        if (this.hybridSearchService) {
            this.hybridSearchService.destroy();
        }

        // Cleanup semantic search services using the coordinator
        if (this.semanticIndexingCoordinator) {
            this.semanticIndexingCoordinator.shutdown().catch((error) => {
                logger.error('Error shutting down semantic indexing coordinator:', error);
            });
        }
    }

    /**
     * Initialize semantic search components
     */
    async initializeSemanticSearch(): Promise<void> {
        try {
            logger.debug('Semantic search: Initializing after workspace is ready...');

            this.embeddingService = new EmbeddingService(
                this.app.vault,
                this.app.metadataCache,
                this.settings.semanticSearch,
            );

            await this.embeddingService.initialize();

            this.semanticSearchEngine = new SemanticSearchEngine(
                this.embeddingService,
                this.app.vault,
                this.app.metadataCache,
                this.settings.semanticSearch,
            );

            // Initialize the semantic indexing coordinator
            this.semanticIndexingCoordinator = new SemanticIndexingCoordinator(
                this.app,
                this.embeddingService,
                this.settings.semanticSearch,
            );

            await this.semanticIndexingCoordinator.initialize();

            // Register file change events for incremental indexing using the coordinator
            this.registerEvent(
                this.app.vault.on('create', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.indexFile(file);
                    }
                }),
            );

            this.registerEvent(
                this.app.vault.on('modify', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.indexFile(file);
                    }
                }),
            );

            this.registerEvent(
                this.app.vault.on('delete', (file) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.removeFile(file.path);
                    }
                }),
            );

            this.registerEvent(
                this.app.vault.on('rename', (file, oldPath) => {
                    if (file instanceof TFile && file.extension === 'md') {
                        this.semanticIndexingCoordinator.renameFile(oldPath, file.path);
                    }
                }),
            );

            logger.debug('Semantic search: Initialization completed successfully after workspace ready');

            // Auto-index files if cache is empty using the coordinator
            await this.semanticIndexingCoordinator.checkForAutoIndexing();
        } catch (error) {
            logger.error('Semantic search: Failed to initialize after workspace ready:', error);
            new Notice('Failed to initialize semantic search. Check console for details.');
        }
    }

    /**
     * Initialize hybrid search service
     * Combines keyword search and semantic search using RRF fusion and re-ranking
     */
    private initializeHybridSearch(): void {
        try {
            logger.debug('Hybrid search: Initializing...');

            // Create hybrid search service with available components
            this.hybridSearchService = new HybridSearchService(
                this.app,
                this.searchService,
                this.semanticSearchEngine || null, // May be null if semantic not enabled
                this.usageTracker,
                this.settings.hybridSearch,
                this.linkGraphService,
            );

            this.hybridSearchService.initialize().then(async () => {
                logger.debug('Hybrid search: Initialization complete');

                // Update hybrid search when semantic becomes available later
                if (!this.semanticSearchEngine && this.settings.semanticSearch.enableSemanticSearch) {
                    logger.debug('Hybrid search: Semantic search not yet ready, will update when available');
                }
            }).catch((error) => {
                logger.error('Hybrid search: Failed to initialize:', error);
            });
        } catch (error) {
            logger.error('Hybrid search: Failed to create service:', error);
        }
    }

    /**
     * Register file events for link graph updates
     */
    private registerLinkGraphEvents(): void {
        // Update link graph when files are created
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] vault.create event:', file.path);
                    logger.debug(`Link graph: File created - ${file.path}`);
                    this.linkGraphService.onFileCreate(file);
                }
            }),
        );

        // Listen to metadata cache changes (fires after links are parsed)
        // This is the primary trigger for link graph updates
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] metadataCache.changed event:', file.path);
                    logger.debug(`Link graph: Metadata changed - ${file.path}`);
                    this.linkGraphService.onFileModify(file);
                }
            }),
        );



        // Update link graph when files are deleted
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] vault.delete event:', file.path);
                    logger.debug(`Link graph: File deleted - ${file.path}`);
                    this.linkGraphService.onFileDelete(file.path);
                }
            }),
        );

        // Update link graph when files are renamed
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] vault.rename event:', oldPath, '->', file.path);
                    logger.debug(`Link graph: File renamed - ${oldPath} -> ${file.path}`);
                    this.linkGraphService.onFileRename(oldPath, file.path);
                }
            }),
        );

        logger.debug('[Main] Link graph file events registered');
        logger.debug('Link graph: File events registered');
    }

    /**
     * Update hybrid search with semantic engine once it's available
     */
    public updateHybridSearchWithSemantic(): void {
        if (this.hybridSearchService && this.semanticSearchEngine) {
            this.hybridSearchService.setSemanticSearch(this.semanticSearchEngine);
            logger.debug('Hybrid search: Updated with semantic search engine');
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

    /**
     * Quick health check for the embedding pipeline
     */
    public async testSemanticEmbedding(): Promise<string> {
        if (!this.settings.semanticSearch.enableSemanticSearch) {
            throw new Error('Semantic search is not enabled');
        }

        if (!this.embeddingService) {
            await this.initializeSemanticSearch();
        }

        if (!this.embeddingService) {
            throw new Error('Embedding service not initialized');
        }

        const start = Date.now();
        const vec = await this.embeddingService.generateEmbedding('hello world', 'search_query', 1);
        const ms = Date.now() - start;
        return `Embedding OK: ${vec.length} dims via ${this.settings.semanticSearch.embeddingModel || 'nomic-embed-text'} in ${ms}ms`;
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
        const savedData = await this.loadData();
        this.settings = {
            ...DEFAULT_SETTINGS,
            ...savedData,
            // Deep-merge enhancedSearch to preserve new default properties for existing users
            enhancedSearch: {
                ...DEFAULT_SETTINGS.enhancedSearch,
                ...(savedData?.enhancedSearch ?? {}),
            },
            // Deep-merge semanticSearch to preserve new default properties for existing users
            semanticSearch: {
                ...DEFAULT_SETTINGS.semanticSearch,
                ...(savedData?.semanticSearch ?? {}),
            },
            // Deep-merge hybridSearch to preserve new default properties for existing users
            hybridSearch: {
                ...DEFAULT_SETTINGS.hybridSearch,
                ...(savedData?.hybridSearch ?? {}),
            },
            // Deep-merge quickLink to preserve new default properties for existing users
            quickLink: {
                ...DEFAULT_SETTINGS.quickLink,
                ...(savedData?.quickLink ?? {}),
            },
            linkGraph: {
                ...DEFAULT_SETTINGS.linkGraph,
                ...(savedData?.linkGraph ?? {}),
            },
        };
        this.loadMacroCommands();
    }

    async saveSettings() {
        this.deleteMacroCommands();
        await this.saveData(this.settings);
        this.loadMacroCommands();

        // Update search settings if initialized
        this.updateSearchSettings();
    }

    /**
     * Update search settings across all components
     */
    private updateSearchSettings(): void {
        // Update semantic search settings
        if (this.embeddingService) {
            this.embeddingService.updateSettings(this.settings.semanticSearch);
        }

        if (this.semanticSearchEngine) {
            this.semanticSearchEngine.updateSettings(this.settings.semanticSearch);
        }

        if (this.semanticIndexingCoordinator) {
            this.semanticIndexingCoordinator.updateSettings(this.settings.semanticSearch);
        }

        // Update hybrid search settings
        if (this.hybridSearchService) {
            this.hybridSearchService.updateSettings(this.settings.hybridSearch);
        }

        // Update link graph settings
        if (this.linkGraphService) {
            this.linkGraphService.updateSettings(this.settings.linkGraph);
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
