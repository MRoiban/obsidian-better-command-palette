import { App, TFile, Notice } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchSettings } from './types';
import { describeEmbeddingModel, fingerprintKey, getSettingsFingerprint } from './embedding-fingerprint';
import { getProviderConfigKey } from './providers/provider-factory';
import { logger } from '../../utils/logger';
import { SmartScheduler } from '../../utils/smart-scheduler';

interface CoordinatorIndexAllOptions {
    /** Suppress success/cancel notices (used for background catch-up). */
    silent?: boolean;
}

/** Quiet period after a model change before the rebuild starts (settings fields save per keystroke). */
const MODEL_CHANGE_REINDEX_DELAY_MS = 3000;

/** Debounce for persisting incremental edits. */
const INCREMENTAL_SAVE_DELAY_MS = 2000;

/**
 * Coordinates background semantic indexing of files
 * Handles debouncing, error recovery, and performance monitoring for semantic search
 */
export class SemanticIndexingCoordinator {
    private app: App;

    private embeddingService: EmbeddingService;

    private settings: SemanticSearchSettings;

    private scheduler: SmartScheduler;

    private readonly schedulerDebounceMs: number;

    private isInitialized = false;

    private isShutdown = false;

    private isIndexing = false;

    private onProgressCallback?: (current: number, total: number) => void;

    private currentIndexingAbortController?: AbortController;

    private currentIndexingRun?: Promise<void>;

    /** Aborted on shutdown; covers scheduled incremental indexing and background tasks. */
    private lifecycleAbortController = new AbortController();

    private modelReindexTimer?: number;

    /** Fingerprint of the model the index was built for (settings object is mutated in place). */
    private activeFingerprintKey: string;

    /** Provider configuration (includes device), to restart indexing on a worker swap. */
    private activeProviderConfigKey: string;

    constructor(
        app: App,
        embeddingService: EmbeddingService,
        settings: SemanticSearchSettings,
        options: { throttleMs?: number; debounceMs?: number } = {},
    ) {
        this.app = app;
        this.embeddingService = embeddingService;
        this.settings = settings;
        this.schedulerDebounceMs = options.debounceMs ?? 10000;
        this.activeFingerprintKey = fingerprintKey(getSettingsFingerprint(settings));
        this.activeProviderConfigKey = getProviderConfigKey(settings);
        this.scheduler = this.createScheduler();
    }

    private createScheduler(): SmartScheduler {
        // Use SmartScheduler for debounce-only pattern
        return new SmartScheduler(
            (filePaths) => this.processScheduledFiles(filePaths),
            {
                throttleMs: 60000, // Effectively disabled
                debounceMs: this.schedulerDebounceMs, // inactivity before reindex
                name: 'SemanticIndexing',
            },
        );
    }

    /**
     * Initialize the semantic indexing coordinator.
     * May be called again after shutdown() to resume work with the same instances.
     */
    async initialize(): Promise<void> {
        logger.info('SemanticIndexingCoordinator: Initializing semantic indexing coordination');
        if (this.isInitialized) {
            return;
        }

        try {
            if (this.isShutdown) {
                this.scheduler = this.createScheduler();
                this.lifecycleAbortController = new AbortController();
                this.activeFingerprintKey = fingerprintKey(getSettingsFingerprint(this.settings));
                this.activeProviderConfigKey = getProviderConfigKey(this.settings);
                await this.embeddingService.initialize();
                this.isShutdown = false;
            }

            this.embeddingService.setStaleFileListener((file) => {
                this.indexFile(file).catch((error) => {
                    logger.warn(`Semantic indexing: Failed to re-queue ${file.path}:`, error);
                });
            });
            this.isInitialized = true;
        } catch (error) {
            logger.error('Failed to initialize semantic indexing coordinator:', error);
            throw error;
        }
    }

    /**
     * Check if auto-indexing should be triggered and start it if needed.
     *
     * - Empty index: full build, only if auto-index on startup is enabled (or the cache was
     *   invalidated by a model change, which needs a rebuild regardless).
     * - Non-empty index: catch up on notes created/changed while Obsidian was closed.
     *
     * Indexing runs in the background; this method returns once the decision is made.
     */
    async checkForAutoIndexing(): Promise<void> {
        logger.debug('[Semantic Search] Checking if auto-indexing is needed...');

        try {
            if (!this.isInitialized || this.isShutdown || !this.settings.enableSemanticSearch) {
                return;
            }

            const invalidatedOnLoad = this.embeddingService.consumeLoadInvalidation();
            const prunedCount = this.embeddingService.pruneInactiveEntries();
            if (prunedCount > 0 || this.embeddingService.hasUnsavedChanges()) {
                this.embeddingService.scheduleSave(INCREMENTAL_SAVE_DELAY_MS);
            }

            const indexedCount = this.embeddingService.getIndexedFileCount();
            const filesNeedingIndex = this.embeddingService.getFilesNeedingIndex();
            logger.debug(`[Semantic Search] Currently indexed: ${indexedCount} files, ${filesNeedingIndex.length} missing or stale`);

            if (filesNeedingIndex.length === 0) {
                logger.debug('[Semantic Search] Semantic index is up to date');
                return;
            }

            const isFullBuild = indexedCount === 0;
            if (isFullBuild && !invalidatedOnLoad && !this.settings.autoIndexOnStartup) {
                logger.debug('[Semantic Search] Auto-index on startup is disabled; waiting for manual semantic index rebuild');
                return;
            }

            this.runInBackground(async (signal) => {
                // Make sure the provider works before auto-indexing (loads/downloads a local model)
                const isAvailable = await this.embeddingService.checkConnection();
                if (signal.aborted) return;
                logger.debug(`[Semantic Search] Embedding provider available: ${isAvailable}`);

                if (!isAvailable) {
                    const reason = this.embeddingService.getAvailabilityMessage() ?? 'Embedding provider not available';
                    logger.warn(`[Semantic Search] ${reason}; skipping auto-indexing.`);
                    if (isFullBuild) {
                        new Notice(`Semantic search: ${reason}`, 8000);
                    }
                    return;
                }

                logger.debug(`[Semantic Search] Starting ${isFullBuild ? 'full' : 'catch-up'} indexing of ${filesNeedingIndex.length} files...`);
                await this.indexAllFiles(undefined, { silent: !isFullBuild });
            });
        } catch (error) {
            logger.error('[Semantic Search] Error in auto-indexing check:', error);
        }
    }

    private runInBackground(task: (signal: AbortSignal) => Promise<void>): void {
        const { signal } = this.lifecycleAbortController;
        task(signal).catch((error) => {
            if (!this.isAbortError(error) && !signal.aborted) {
                logger.error('[Semantic Search] Background indexing task failed:', error);
            }
        });
    }

    /**
     * Index all files with proper coordination and progress tracking
     */
    async indexAllFiles(
        onProgress?: (current: number, total: number) => void,
        options: CoordinatorIndexAllOptions = {},
    ): Promise<void> {
        if (this.isShutdown) {
            logger.debug('Semantic indexing: Coordinator is shut down, skipping indexing');
            return;
        }

        if (this.isIndexing) {
            logger.debug('Semantic indexing: Indexing already in progress, skipping');
            return;
        }

        const controller = new AbortController();
        this.isIndexing = true;
        this.onProgressCallback = onProgress;
        this.currentIndexingAbortController = controller;

        const run = this.runIndexAll(controller.signal, options);
        this.currentIndexingRun = run;

        try {
            await run;
        } finally {
            // A cancelled run must not reset state that belongs to a newer run
            if (this.currentIndexingRun === run) {
                this.isIndexing = false;
                this.onProgressCallback = undefined;
                this.currentIndexingAbortController = undefined;
                this.currentIndexingRun = undefined;
            }
        }
    }

    private async runIndexAll(signal: AbortSignal, options: CoordinatorIndexAllOptions): Promise<void> {
        const { silent = false } = options;

        try {
            logger.info('Semantic indexing: Starting coordinated indexing of all files');

            await this.embeddingService.indexAllFiles((current, total) => {
                // Update progress occasionally without blocking UI
                if (current % 5 === 0 || current === total) {
                    logger.debug(`Semantic indexing: Progress ${current}/${total} files`);
                }

                if (this.onProgressCallback) {
                    this.onProgressCallback(current, total);
                }
            }, { signal });

            const indexedCount = this.embeddingService.getIndexedFileCount();
            logger.info(`Semantic indexing: Completed, ${indexedCount} files indexed`);
            if (!silent) {
                new Notice(`✅ Semantic search: Successfully indexed ${indexedCount} files`, 3000);
            }
        } catch (error) {
            if (this.isAbortError(error) || signal.aborted) {
                logger.info('Semantic indexing: Indexing cancelled');
                if (!silent && !this.isShutdown) {
                    new Notice('Semantic search indexing cancelled', 3000);
                }
                return;
            }

            logger.error('Semantic indexing: Failed:', error);
            if (!silent) {
                new Notice(`❌ Semantic search indexing failed: ${error.message}`, 5000);
            }
            throw error;
        }
    }

    /**
     * Index a single file using Smart Scheduler (throttle + debounce)
     * This ensures responsive updates during active editing while
     * guaranteeing a final cleanup after activity stops.
     */
    async indexFile(file: TFile): Promise<void> {
        if (this.isShutdown) {
            return;
        }

        if (!this.isInitialized) {
            logger.warn('Semantic indexing: Coordinator not initialized, skipping file indexing');
            return;
        }

        if (this.embeddingService.shouldExcludeFile(file)) {
            logger.debug(`Semantic indexing: Skipping excluded file ${file.path}`);
            return;
        }

        // Schedule the file for processing via SmartScheduler
        this.scheduler.schedule(file.path);
    }

    /**
     * Process files scheduled by SmartScheduler
     */
    private async processScheduledFiles(filePaths: string[]): Promise<void> {
        if (this.isShutdown) {
            return;
        }

        const { signal } = this.lifecycleAbortController;
        logger.debug(`Semantic indexing: Processing ${filePaths.length} scheduled files`);

        for (const filePath of filePaths) {
            if (signal.aborted) {
                return;
            }

            try {
                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (!(file instanceof TFile)) {
                    logger.debug(`Semantic indexing: File not found or not a TFile: ${filePath}`);
                    continue;
                }

                // eslint-disable-next-line no-await-in-loop
                const result = await this.embeddingService.indexFile(file, { signal });
                logger.debug(`Semantic indexing: ${filePath} -> ${result}`);
            } catch (error) {
                if (signal.aborted) {
                    return;
                }
                if (this.isAbortError(error)) {
                    // Shared an in-flight run that was cancelled (e.g. model change); it will be re-queued later
                    logger.debug(`Semantic indexing: Indexing of ${filePath} was cancelled`);
                    continue;
                }
                logger.error(`Semantic indexing: Failed to index file ${filePath}:`, error);
            }
        }

        this.scheduleSaveIfNeeded();
    }

    private scheduleSaveIfNeeded(): void {
        if (!this.isShutdown && this.embeddingService.hasUnsavedChanges()) {
            this.embeddingService.scheduleSave(INCREMENTAL_SAVE_DELAY_MS);
        }
    }

    /**
     * Remove a file from the semantic index
     */
    async removeFile(filePath: string): Promise<void> {
        // Note: We don't cancel scheduled updates here since the scheduler batches
        // and the file will simply be skipped if it doesn't exist anymore
        if (this.isShutdown) {
            return;
        }

        try {
            logger.debug(`Semantic indexing: Removing file ${filePath}`);
            this.embeddingService.removeFromCache(filePath);
            this.scheduleSaveIfNeeded();
        } catch (error) {
            logger.error(`Semantic indexing: Error removing file ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * Handle file rename operations
     */
    async handleFileRename(oldPath: string, newPath: string): Promise<void> {
        if (this.isShutdown) {
            return;
        }

        try {
            logger.debug(`Semantic indexing: Handling file rename from ${oldPath} to ${newPath}`);

            // Remove old embedding and index new file
            this.embeddingService.removeFromCache(oldPath);
            this.scheduleSaveIfNeeded();

            // Find the new file and index it
            const file = this.app.vault.getAbstractFileByPath(newPath);
            if (file instanceof TFile) {
                await this.indexFile(file);
            }
        } catch (error) {
            logger.error(`Semantic indexing: Error handling file rename from ${oldPath} to ${newPath}:`, error);
        }
    }

    /**
     * Handle file rename operations (alias for handleFileRename for compatibility)
     */
    async renameFile(oldPath: string, newPath: string): Promise<void> {
        await this.handleFileRename(oldPath, newPath);
    }

    /**
     * Force reindex of a specific file (bypass debouncing)
     */
    async forceReindexFile(file: TFile): Promise<void> {
        try {
            logger.debug(`Semantic indexing: Force reindexing file ${file.path}`);

            // Remove existing embedding first
            this.embeddingService.removeFromCache(file.path);

            // Then reindex
            await this.indexFile(file);
            logger.debug(`Semantic indexing: Successfully force reindexed ${file.path}`);
        } catch (error) {
            logger.error(`Semantic indexing: Error force reindexing file ${file.path}:`, error);
            throw error;
        }
    }

    /**
     * Get indexing statistics
     */
    getStats(): { indexedFiles: number; isIndexing: boolean; pendingUpdates: number } {
        return {
            indexedFiles: this.embeddingService.getIndexedFileCount(),
            isIndexing: this.isIndexing,
            pendingUpdates: this.scheduler.pendingCount,
        };
    }

    /**
     * Clear the entire semantic index
     */
    async clearIndex(): Promise<void> {
        try {
            logger.info('Semantic indexing: Clearing entire index');

            // Stop any ongoing indexing
            this.cancelModelReindex();
            this.cancelIndexing('Semantic index cleared');

            // Clear the embedding service index
            this.embeddingService.clearCache();

            logger.info('Semantic indexing: Index cleared successfully');
        } catch (error) {
            logger.error('Semantic indexing: Error clearing index:', error);
            throw error;
        }
    }

    /**
     * Check if indexing is currently in progress
     */
    isIndexingInProgress(): boolean {
        return this.isIndexing;
    }

    cancelIndexing(reason = 'Semantic indexing cancelled'): void {
        this.currentIndexingAbortController?.abort();
        this.currentIndexingAbortController = undefined;
        this.currentIndexingRun = undefined;
        this.onProgressCallback = undefined;
        this.embeddingService.cancelPendingRequests(reason);
        this.isIndexing = false;
    }

    private cancelModelReindex(): void {
        if (this.modelReindexTimer !== undefined) {
            window.clearTimeout(this.modelReindexTimer);
            this.modelReindexTimer = undefined;
        }
    }

    /**
     * Rebuild the index after the embedding model changed. Debounced because the model
     * name is a text field; the rebuild only starts once the provider can serve the new
     * model (Ollama has it / the local model downloaded and loaded), so a bad model name
     * never wipes the existing index.
     */
    private scheduleModelReindex(): void {
        this.cancelModelReindex();
        if (this.isShutdown || !this.settings.enableSemanticSearch) {
            return;
        }
        // The model was changed back to the one the cached vectors belong to
        if (!this.embeddingService.hasPendingModelChange()) {
            return;
        }

        this.modelReindexTimer = window.setTimeout(() => {
            this.modelReindexTimer = undefined;
            this.runInBackground(async (signal) => {
                const isAvailable = await this.embeddingService.checkConnection();
                if (signal.aborted) return;

                if (!isAvailable) {
                    const model = describeEmbeddingModel(this.settings);
                    const reason = this.embeddingService.getAvailabilityMessage() ?? `embedding model ${model} is not available`;
                    logger.warn(`[Semantic Search] Embedding model ${model} not available; semantic index not rebuilt`);
                    new Notice(`Semantic search: ${reason} Run "Reindex semantic search" once it is available.`, 8000);
                    return;
                }

                this.embeddingService.applyModelChange();
                await this.indexAllFiles();
            });
        }, MODEL_CHANGE_REINDEX_DELAY_MS);
    }

    /**
     * Shutdown the coordinator and cleanup resources.
     * Safe to call more than once: stops timers, aborts in-flight indexing,
     * persists pending changes and closes the embedding store.
     */
    async shutdown(): Promise<void> {
        if (this.isShutdown) {
            return;
        }
        this.isShutdown = true;
        this.isInitialized = false;

        try {
            logger.info('Semantic indexing: Shutting down coordinator');

            this.cancelModelReindex();
            this.lifecycleAbortController.abort();

            // Stop any ongoing indexing
            this.cancelIndexing('Semantic indexing coordinator shutdown');

            // Destroy the scheduler (clears its timers and pending items)
            this.scheduler.destroy();

            // Clean up the embedding service
            if (this.embeddingService) {
                this.embeddingService.setStaleFileListener(undefined);
                await this.embeddingService.saveCache();
                this.embeddingService.close();
            }

            logger.info('Semantic indexing: Coordinator shutdown complete');
        } catch (error) {
            logger.error('Semantic indexing: Error during shutdown:', error);
        }
    }

    /**
     * Update settings for the coordinator.
     * If the embedding model changed, cached vectors are invalidated and a rebuild is scheduled.
     */
    updateSettings(newSettings: SemanticSearchSettings): void {
        this.settings = newSettings;
        // Replaces the provider (stopping its worker) when provider/model/device changed
        this.embeddingService.updateSettings(newSettings);

        const nextFingerprintKey = fingerprintKey(getSettingsFingerprint(newSettings));
        const nextProviderConfigKey = getProviderConfigKey(newSettings);
        const providerReplaced = nextProviderConfigKey !== this.activeProviderConfigKey;
        this.activeProviderConfigKey = nextProviderConfigKey;

        if (nextFingerprintKey !== this.activeFingerprintKey) {
            logger.info(`Semantic indexing: Embedding model changed (${this.activeFingerprintKey} -> ${nextFingerprintKey}), rebuilding index`);
            this.activeFingerprintKey = nextFingerprintKey;
            this.cancelIndexing('Embedding model changed');
            this.scheduleModelReindex();
        } else if (providerReplaced && this.isIndexing) {
            // Same embedding space on a new worker (e.g. device change): resume where indexing stopped
            logger.info('Semantic indexing: Embedding provider restarted, resuming indexing');
            this.cancelIndexing('Embedding provider restarted');
            this.runInBackground(async (signal) => {
                if (!(await this.embeddingService.checkConnection()) || signal.aborted) return;
                await this.indexAllFiles(undefined, { silent: true });
            });
        }

        if (!newSettings.enableSemanticSearch) {
            this.cancelModelReindex();
        }

        logger.debug('Semantic indexing: Coordinator settings updated');
    }

    private isAbortError(error: unknown): boolean {
        return error instanceof Error && error.name === 'AbortError';
    }
}
