import {
    Plugin, Notice, TFile, EventRef,
} from 'obsidian';

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
import type { SemanticSearchSettings } from './search/semantic/types';
import type { EmbeddingProviderId } from './search/semantic/providers/types';
import { describeEmbeddingModel } from './search/semantic/embedding-fingerprint';
import { HybridSearchService } from './search/hybrid/hybrid-search-service';
import { FileUsageTracker } from './search/usage-tracker';
import { LinkGraphService } from './search/link-graph-service';
import { FileMatchCacheService } from './search/file-match-cache-service';
import { QuickLinkModal } from './ui/quick-link-modal';
import { logger } from './utils/logger';
import { SuggestionsWorkerFallback } from './web-workers/suggestions-worker-fallback';
import SuggestionsWorker from 'web-worker:./web-workers/suggestions-worker';
import './styles.scss';

export default class BetterCommandPalettePlugin extends Plugin {
    app!: UnsafeAppInterface;

    settings!: BetterCommandPalettePluginSettings;

    prevCommands!: OrderedSet<Match>;

    prevTags!: OrderedSet<Match>;

    suggestionsWorker!: Worker;

    searchService!: EnhancedSearchService;

    fileMatchCache!: FileMatchCacheService;

    // Semantic search components (present only while semantic search is running)
    embeddingService?: EmbeddingService;

    semanticSearchEngine?: SemanticSearchEngine;

    semanticIndexingCoordinator?: SemanticIndexingCoordinator;

    // Hybrid search service
    hybridSearchService?: HybridSearchService;

    usageTracker!: FileUsageTracker;

    // Link graph service for PageRank scoring
    linkGraphService?: LinkGraphService;

    // Last queries for preserve query functionality
    lastSemanticQuery: string = '';

    lastFileQuery: string = '';

    private lightweightSettingsSaveTimer?: number;

    private settingsSaveTimer?: number;

    private linkGraphEventsRegistered = false;

    private appliedSettingsSnapshot?: BetterCommandPalettePluginSettings;

    /** Vault listeners owned by the semantic services; removed on shutdown. */
    private semanticEventRefs: EventRef[] = [];

    /** Serializes semantic start/stop so concurrent toggles cannot interleave. */
    private semanticTransition: Promise<void> = Promise.resolve();

    private semanticRibbonEl?: HTMLElement;

    async onload() {
        logger.info('Loading plugin: Better Command Palette');

        await this.loadSettings();

        this.prevCommands = new OrderedSet<Match>();
        this.prevTags = new OrderedSet<Match>();
        this.suggestionsWorker = this.createSuggestionsWorker();
        this.fileMatchCache = new FileMatchCacheService(this.app, this.settings);
        this.fileMatchCache.initialize();
        this.registerFileMatchCacheEvents();
        this.registerHybridCacheEvents();

        // Initialize usage tracker (shared between services)
        this.usageTracker = new FileUsageTracker(this.app);

        // Initialize enhanced search service
        this.searchService = new EnhancedSearchService(this.app, this.settings.enhancedSearch, this.usageTracker);

        if (this.shouldUseLinkGraph()) {
            this.ensureLinkGraphService();
        }

        // Wait for workspace to be ready before initializing search services
        if (this.app.workspace.layoutReady) {
            logger.debug('Workspace layout already ready, initializing search services immediately');
            this.initializeWorkspaceServices();
        } else {
            // Otherwise wait for layout ready event
            logger.debug('Workspace layout not ready, waiting for layout-ready event before initializing search services');
            this.app.workspace.onLayoutReady(() => {
                logger.debug('Workspace layout ready event received, initializing search services');
                this.initializeWorkspaceServices();
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
                    '',
                    undefined,
                    this.fileMatchCache,
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
                    undefined,
                    this.fileMatchCache,
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
                    undefined,
                    this.fileMatchCache,
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
                        this.fileMatchCache,
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
                if (this.semanticIndexingCoordinator) {
                    await this.semanticIndexingCoordinator.clearIndex();
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
        this.updateSemanticRibbonIcon(this.settings.semanticSearch.enableSemanticSearch);

        this.addSettingTab(new BetterCommandPaletteSettingTab(this.app, this));
    }

    private createSuggestionsWorker(): Worker {
        try {
            return new SuggestionsWorker({});
        } catch (error) {
            logger.warn('Falling back to main-thread suggestions worker', error);
            return new SuggestionsWorkerFallback() as unknown as Worker;
        }
    }

    private initializeWorkspaceServices(): void {
        const linkGraphService = this.shouldUseLinkGraph()
            ? this.ensureLinkGraphService()
            : undefined;

        if (linkGraphService?.shouldRecomputeOnStartup()) {
            linkGraphService.recompute().catch((error) => {
                logger.error('Failed to compute link graph:', error);
            });
        } else if (linkGraphService) {
            logger.debug('Link graph: Using fresh cached PageRank scores on startup');
        }

        this.searchService.initialize().catch((error) => {
            logger.error('Failed to initialize enhanced search service:', error);
        });

        // Hybrid search is available immediately (keyword-only); the semantic engine
        // is attached once its services are up, and auto-indexing runs in the background.
        this.initializeHybridSearch();

        if (this.settings.semanticSearch.enableSemanticSearch) {
            logger.debug('Semantic search enabled, initializing');
            this.setSemanticEnabled(true).catch((error) => {
                logger.debug('Semantic search: startup initialization failed', error);
            });
        }
    }

    private shouldUseLinkGraph(): boolean {
        return this.settings.hybridSearch.enabled && this.settings.linkGraph.enabled;
    }

    private ensureLinkGraphService(): LinkGraphService {
        if (!this.linkGraphService) {
            this.linkGraphService = new LinkGraphService(this.app, this.settings.linkGraph);
        }
        this.searchService?.setLinkGraphService(this.linkGraphService);

        this.registerLinkGraphEvents();
        return this.linkGraphService;
    }

    onunload(): void {
        if (this.lightweightSettingsSaveTimer) {
            window.clearTimeout(this.lightweightSettingsSaveTimer);
            this.lightweightSettingsSaveTimer = undefined;
            void this.saveData(this.settings);
        }

        if (this.settingsSaveTimer) {
            window.clearTimeout(this.settingsSaveTimer);
            this.settingsSaveTimer = undefined;
            void this.saveData(this.settings);
        }

        this.suggestionsWorker.onmessage = null;
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

        if (this.linkGraphService) {
            this.linkGraphService.destroy();
        }

        if (this.usageTracker) {
            this.usageTracker.shutdown();
        }

        // Cleanup semantic search services (removes vault listeners, saves cache)
        this.updateSemanticRibbonIcon(false);
        this.setSemanticEnabled(false).catch((error) => {
            logger.error('Error shutting down semantic search:', error);
        });
    }

    /**
     * Start or stop the semantic search services. Idempotent and serialized:
     * enabling twice keeps one set of services and one set of vault listeners;
     * disabling detaches semantic from hybrid search, removes listeners and shuts
     * the coordinator down. Rejects if starting fails (the error is already logged).
     */
    public setSemanticEnabled(enabled: boolean): Promise<void> {
        return this.runSemanticTransition(() => (enabled
            ? this.startSemanticSearch({ autoIndex: true })
            : this.stopSemanticSearch()));
    }

    private runSemanticTransition(action: () => Promise<void>): Promise<void> {
        const run = this.semanticTransition.then(action);
        this.semanticTransition = run.catch(() => undefined);
        return run;
    }

    private async startSemanticSearch(options: { autoIndex: boolean }): Promise<void> {
        if (this.semanticIndexingCoordinator && this.semanticSearchEngine && this.embeddingService) {
            this.updateHybridSearchWithSemantic();
            return;
        }

        logger.debug('Semantic search: Initializing services...');
        const semanticSettings = this.settings.semanticSearch;
        let embeddingService: EmbeddingService | undefined;
        let coordinator: SemanticIndexingCoordinator;

        try {
            embeddingService = new EmbeddingService(
                this.app.vault,
                this.app.metadataCache,
                semanticSettings,
                this.app,
                // Bundled local-embedding runtime assets live next to main.js
                { pluginDir: this.manifest.dir },
            );
            await embeddingService.initialize();

            const semanticSearchEngine = new SemanticSearchEngine(
                embeddingService,
                this.app.vault,
                this.app.metadataCache,
                semanticSettings,
            );

            coordinator = new SemanticIndexingCoordinator(
                this.app,
                embeddingService,
                semanticSettings,
            );
            await coordinator.initialize();

            this.embeddingService = embeddingService;
            this.semanticSearchEngine = semanticSearchEngine;
            this.semanticIndexingCoordinator = coordinator;
        } catch (error) {
            logger.error('Semantic search: Failed to initialize:', error);
            new Notice('Failed to initialize semantic search. Check console for details.');
            embeddingService?.close();
            throw error;
        }

        this.registerSemanticEvents(coordinator);
        this.updateHybridSearchWithSemantic();
        logger.debug('Semantic search: Initialization completed');

        if (options.autoIndex) {
            // Auto-index (if the cache is empty) in the background so hybrid search stays usable.
            coordinator.checkForAutoIndexing().catch((error) => {
                logger.error('Semantic search: Auto-indexing failed:', error);
            });
        }
    }

    private async stopSemanticSearch(): Promise<void> {
        this.unregisterSemanticEvents();
        this.hybridSearchService?.setSemanticSearch(null);

        const coordinator = this.semanticIndexingCoordinator;
        const embeddingService = this.embeddingService;
        this.semanticIndexingCoordinator = undefined;
        this.semanticSearchEngine = undefined;
        this.embeddingService = undefined;

        if (coordinator) {
            // Cancels indexing, saves the embedding cache and closes the embedding service.
            await coordinator.shutdown();
            logger.debug('Semantic search: Services shut down');
        } else if (embeddingService) {
            embeddingService.close();
        }
    }

    private registerSemanticEvents(coordinator: SemanticIndexingCoordinator): void {
        this.unregisterSemanticEvents();

        const onError = (action: string) => (error: unknown) => {
            logger.error(`Semantic search: Failed to ${action}:`, error);
        };

        this.semanticEventRefs = [
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    coordinator.indexFile(file).catch(onError('index created file'));
                }
            }),
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    coordinator.indexFile(file).catch(onError('index modified file'));
                }
            }),
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    coordinator.removeFile(file.path).catch(onError('remove deleted file'));
                }
            }),
            this.app.vault.on('rename', (file, oldPath) => {
                if (file instanceof TFile && file.extension === 'md') {
                    coordinator.renameFile(oldPath, file.path).catch(onError('rename file'));
                }
            }),
        ];
    }

    private unregisterSemanticEvents(): void {
        this.semanticEventRefs.forEach((ref) => this.app.vault.offref(ref));
        this.semanticEventRefs = [];
    }

    private updateSemanticRibbonIcon(enabled: boolean): void {
        if (enabled && !this.semanticRibbonEl) {
            this.semanticRibbonEl = this.addRibbonIcon('search', 'Open semantic search', () => {
                if (this.semanticSearchEngine) {
                    new SemanticSearchModal(this.app, this).open();
                } else {
                    new Notice('Semantic search is not initialized');
                }
            });
        } else if (!enabled && this.semanticRibbonEl) {
            this.semanticRibbonEl.remove();
            this.semanticRibbonEl = undefined;
        }
    }

    /**
     * Initialize hybrid search service
     * Combines keyword search and semantic search using RRF fusion and re-ranking
     */
    private initializeHybridSearch(): void {
        try {
            if (!this.settings.hybridSearch.enabled) {
                if (this.hybridSearchService) {
                    this.hybridSearchService.destroy();
                    this.hybridSearchService = undefined;
                }
                logger.debug('Hybrid search: Disabled, skipping initialization');
                return;
            }

            logger.debug('Hybrid search: Initializing...');
            const linkGraphService = this.shouldUseLinkGraph()
                ? this.ensureLinkGraphService()
                : undefined;

            // Create hybrid search service with available components
            this.hybridSearchService?.destroy();
            this.hybridSearchService = new HybridSearchService(
                this.app,
                this.searchService,
                this.semanticSearchEngine ?? null, // Attached later by setSemanticEnabled when ready
                this.usageTracker,
                this.settings.hybridSearch,
                linkGraphService,
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
        if (this.linkGraphEventsRegistered) {
            return;
        }

        // Update link graph when files are created
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (this.shouldUseLinkGraph() && this.linkGraphService && file instanceof TFile && file.extension === 'md') {
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
                if (this.shouldUseLinkGraph() && this.linkGraphService && file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] metadataCache.changed event:', file.path);
                    logger.debug(`Link graph: Metadata changed - ${file.path}`);
                    this.linkGraphService.onFileModify(file);
                }
            }),
        );



        // Update link graph when files are deleted
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (this.shouldUseLinkGraph() && this.linkGraphService && file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] vault.delete event:', file.path);
                    logger.debug(`Link graph: File deleted - ${file.path}`);
                    this.linkGraphService.onFileDelete(file.path);
                }
            }),
        );

        // Update link graph when files are renamed
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (this.shouldUseLinkGraph() && this.linkGraphService && file instanceof TFile && file.extension === 'md') {
                    logger.debug('[Main] vault.rename event:', oldPath, '->', file.path);
                    logger.debug(`Link graph: File renamed - ${oldPath} -> ${file.path}`);
                    this.linkGraphService.onFileRename(oldPath, file.path);
                }
            }),
        );

        logger.debug('[Main] Link graph file events registered');
        logger.debug('Link graph: File events registered');
        this.linkGraphEventsRegistered = true;
    }

    /**
     * Attach the semantic engine to hybrid search once it's available
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

        // Ensure services are running without scheduling a competing auto-index
        await this.runSemanticTransition(() => this.startSemanticSearch({ autoIndex: false }));

        const coordinator = this.semanticIndexingCoordinator;
        if (!coordinator) {
            throw new Error('Failed to initialize semantic indexing coordinator');
        }

        // Use the coordinator for reindexing
        await coordinator.indexAllFiles();
    }

    /**
     * Quick health check for the embedding pipeline
     */
    public async testSemanticEmbedding(): Promise<string> {
        if (!this.settings.semanticSearch.enableSemanticSearch) {
            throw new Error('Semantic search is not enabled');
        }

        await this.setSemanticEnabled(true);

        const { embeddingService } = this;
        if (!embeddingService) {
            throw new Error('Embedding service not initialized');
        }

        const start = Date.now();
        const vec = await embeddingService.generateEmbedding('hello world', 'search_query', 1);
        const ms = Date.now() - start;
        return `Embedding OK: ${vec.length} dims via ${describeEmbeddingModel(this.settings.semanticSearch)} in ${ms}ms`;
    }

    /**
     * Load (and on first use download) the configured embedding model, starting the
     * semantic services if needed. Resolves with a human-readable result.
     */
    public async prepareEmbeddingModel(): Promise<{ ok: boolean; message: string }> {
        if (!this.settings.semanticSearch.enableSemanticSearch) {
            return { ok: false, message: 'Semantic search is not enabled' };
        }

        await this.setSemanticEnabled(true);
        const { embeddingService } = this;
        if (!embeddingService) {
            return { ok: false, message: 'Embedding service not initialized' };
        }

        const ok = await embeddingService.checkConnection();
        return {
            ok,
            message: embeddingService.getAvailabilityMessage() ?? (ok ? 'Embedding model ready' : 'Embedding model unavailable'),
        };
    }

    loadMacroCommands() {
        this.assignMacroIds();
        this.settings.macros.forEach((macroData) => {
            if (!macroData.name || !macroData.commandIds.length) {
                return;
            }

            const macro = new MacroCommand(
                this.app,
                `${MACRO_COMMAND_ID_PREFIX}${macroData.id}`,
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

    /**
     * Give every macro a unique stable id. Macros saved before ids existed keep
     * their list index so existing hotkeys keep working.
     */
    private assignMacroIds() {
        const usedIds = new Set<string>();
        this.settings.macros.forEach((macroData, index) => {
            if (!macroData.id || usedIds.has(macroData.id)) {
                const legacyId = String(index);
                macroData.id = usedIds.has(legacyId)
                    ? `m-${Date.now().toString(36)}-${index}`
                    : legacyId;
            }
            usedIds.add(macroData.id);
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
        const savedData = (await this.loadData() ?? {}) as Partial<BetterCommandPalettePluginSettings>;
        this.settings = BetterCommandPalettePlugin.mergeWithDefaults(savedData);
        this.appliedSettingsSnapshot = this.cloneSettings(this.settings);
        this.loadMacroCommands();
    }

    /**
     * Merge saved settings over a deep copy of the defaults so nested objects
     * never alias DEFAULT_SETTINGS and new default keys appear for existing users.
     */
    private static mergeWithDefaults(
        savedData: Partial<BetterCommandPalettePluginSettings>,
    ): BetterCommandPalettePluginSettings {
        const defaults = structuredClone(DEFAULT_SETTINGS);
        return {
            ...defaults,
            ...savedData,
            enhancedSearch: {
                ...defaults.enhancedSearch,
                ...(savedData.enhancedSearch ?? {}),
                scoreWeights: {
                    ...defaults.enhancedSearch.scoreWeights,
                    ...(savedData.enhancedSearch?.scoreWeights ?? {}),
                },
            },
            semanticSearch: {
                ...defaults.semanticSearch,
                ...(savedData.semanticSearch ?? {}),
                embeddingProvider: BetterCommandPalettePlugin.resolveSavedEmbeddingProvider(savedData.semanticSearch)
                    ?? defaults.semanticSearch.embeddingProvider,
            },
            hybridSearch: {
                ...defaults.hybridSearch,
                ...(savedData.hybridSearch ?? {}),
            },
            quickLink: {
                ...defaults.quickLink,
                ...(savedData.quickLink ?? {}),
            },
            linkGraph: {
                ...defaults.linkGraph,
                ...(savedData.linkGraph ?? {}),
            },
        };
    }

    /**
     * Provider for saved settings. Settings saved before providers existed keep using
     * Ollama when the user had configured it (non-default URL or model); otherwise the
     * in-plugin local model default applies.
     */
    private static resolveSavedEmbeddingProvider(
        saved: Partial<SemanticSearchSettings> | undefined,
    ): EmbeddingProviderId | undefined {
        if (!saved) {
            return undefined;
        }
        if (saved.embeddingProvider === 'local' || saved.embeddingProvider === 'ollama') {
            return saved.embeddingProvider;
        }

        const defaults = DEFAULT_SETTINGS.semanticSearch;
        const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, '');
        const customUrl = typeof saved.ollamaUrl === 'string' && saved.ollamaUrl.trim() !== ''
            && normalizeUrl(saved.ollamaUrl) !== normalizeUrl(defaults.ollamaUrl);
        const customModel = typeof saved.embeddingModel === 'string' && saved.embeddingModel.trim() !== ''
            && saved.embeddingModel.trim() !== defaults.embeddingModel;

        return customUrl || customModel ? 'ollama' : undefined;
    }

    /**
     * Reset every setting to a fresh copy of the defaults and apply the change to
     * all running services through the normal save path.
     */
    async resetSettings(): Promise<void> {
        this.settings = structuredClone(DEFAULT_SETTINGS);
        await this.saveSettings();
    }

    async saveSettings() {
        const previousSettings = this.appliedSettingsSnapshot;
        const macrosChanged = !previousSettings
            || this.settingsChanged(previousSettings.macros, this.settings.macros);

        if (macrosChanged) {
            this.deleteMacroCommands();
        }

        await this.saveData(this.settings);

        if (macrosChanged) {
            this.loadMacroCommands();
        }

        // Update search settings if initialized
        this.updateSearchSettings(previousSettings);
        this.appliedSettingsSnapshot = this.cloneSettings(this.settings);
    }

    private cloneSettings(settings: BetterCommandPalettePluginSettings): BetterCommandPalettePluginSettings {
        return JSON.parse(JSON.stringify(settings));
    }

    private settingsChanged(previousValue: unknown, nextValue: unknown): boolean {
        return JSON.stringify(previousValue) !== JSON.stringify(nextValue);
    }

    scheduleLightweightSettingsSave(delayMs = 250): void {
        if (this.lightweightSettingsSaveTimer) {
            window.clearTimeout(this.lightweightSettingsSaveTimer);
        }

        this.lightweightSettingsSaveTimer = window.setTimeout(() => {
            this.lightweightSettingsSaveTimer = undefined;
            this.saveData(this.settings).catch((error) => {
                logger.error('Failed to persist lightweight settings update:', error);
            });
        }, delayMs);
    }

    scheduleSettingsSave(delayMs = 400): void {
        if (this.settingsSaveTimer) {
            window.clearTimeout(this.settingsSaveTimer);
        }

        this.settingsSaveTimer = window.setTimeout(() => {
            this.settingsSaveTimer = undefined;
            this.saveSettings().catch((error) => {
                logger.error('Failed to persist scheduled settings update:', error);
            });
        }, delayMs);
    }

    /**
     * Update search settings across all components
     */
    private updateSearchSettings(previousSettings?: BetterCommandPalettePluginSettings): void {
        const fileMatchSettingsChanged = !previousSettings
            || this.settingsChanged(previousSettings.fileTypeExclusion, this.settings.fileTypeExclusion);
        const enhancedSettingsChanged = !previousSettings
            || this.settingsChanged(previousSettings.enhancedSearch, this.settings.enhancedSearch);
        const semanticSettingsChanged = !previousSettings
            || this.settingsChanged(previousSettings.semanticSearch, this.settings.semanticSearch);
        const hybridSettingsChanged = !previousSettings
            || this.settingsChanged(previousSettings.hybridSearch, this.settings.hybridSearch);
        const linkGraphSettingsChanged = !previousSettings
            || this.settingsChanged(previousSettings.linkGraph, this.settings.linkGraph);

        if (this.fileMatchCache) {
            this.fileMatchCache.updateSettings(this.settings);
            if (fileMatchSettingsChanged) {
                this.fileMatchCache.rebuild();
            }
        }

        // Update enhanced (keyword) search settings: typo tolerance, stemming, accents, synonyms...
        if (enhancedSettingsChanged && this.searchService) {
            this.searchService.updateSettings(this.settings.enhancedSearch);
            this.hybridSearchService?.clearCache();
        }

        // Start/stop semantic search when toggled; otherwise push settings to running services
        const semanticEnabled = this.settings.semanticSearch.enableSemanticSearch;
        const semanticToggled = !previousSettings
            || previousSettings.semanticSearch.enableSemanticSearch !== semanticEnabled;

        if (semanticToggled) {
            this.updateSemanticRibbonIcon(semanticEnabled);
            this.setSemanticEnabled(semanticEnabled).catch((error) => {
                logger.debug('Semantic search: toggle failed', error);
            });
        } else if (semanticSettingsChanged) {
            this.embeddingService?.updateSettings(this.settings.semanticSearch);
            this.semanticSearchEngine?.updateSettings(this.settings.semanticSearch);
            this.semanticIndexingCoordinator?.updateSettings(this.settings.semanticSearch);
        }

        // Update hybrid search settings
        if (hybridSettingsChanged && this.settings.hybridSearch.enabled && !this.hybridSearchService) {
            this.initializeHybridSearch();
        } else if (hybridSettingsChanged && !this.settings.hybridSearch.enabled && this.hybridSearchService) {
            this.hybridSearchService.destroy();
            this.hybridSearchService = undefined;
        } else if (hybridSettingsChanged && this.hybridSearchService) {
            this.hybridSearchService.updateSettings(this.settings.hybridSearch);
        }

        // Update link graph settings
        if (linkGraphSettingsChanged && this.linkGraphService) {
            this.linkGraphService.updateSettings(this.settings.linkGraph);
        }

        if (this.shouldUseLinkGraph()) {
            const linkGraphService = this.ensureLinkGraphService();
            this.hybridSearchService?.setLinkGraphService(linkGraphService);
            if (linkGraphSettingsChanged && linkGraphService.shouldRecomputeOnStartup()) {
                linkGraphService.recompute().catch((error) => {
                    logger.error('Failed to recompute link graph after settings update:', error);
                });
            }
        } else if (this.linkGraphService) {
            this.hybridSearchService?.clearLinkGraphService();
            this.searchService?.clearLinkGraphService();
            this.linkGraphService.destroy();
            this.linkGraphService = undefined;
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

    /**
     * Invalidate cached hybrid results whenever vault content changes.
     */
    private registerHybridCacheEvents(): void {
        const invalidate = () => this.hybridSearchService?.onVaultChange();
        this.registerEvent(this.app.vault.on('create', invalidate));
        this.registerEvent(this.app.vault.on('modify', invalidate));
        this.registerEvent(this.app.vault.on('delete', invalidate));
        this.registerEvent(this.app.vault.on('rename', invalidate));
        this.registerEvent(this.app.metadataCache.on('changed', invalidate));
    }

    private registerFileMatchCacheEvents(): void {
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                this.fileMatchCache.onCreate(file);
            }),
        );

        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (file instanceof TFile) {
                    this.fileMatchCache.onMetadataChanged(file);
                }
            }),
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                this.fileMatchCache.onDelete(file);
            }),
        );

        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                this.fileMatchCache.onRename(file, oldPath);
            }),
        );
    }
}
