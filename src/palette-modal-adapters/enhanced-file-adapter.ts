import { Instruction, Notice, TFile } from 'obsidian';
import {
    generateHotKeyText,
    getOrCreateFile,
    openFileWithEventKeys,
    PaletteMatch, SuggestModalAdapter,
} from '../utils';
import { Match, UnsafeAppInterface, WorkerMode } from '../types/types';
import { ActionType, QUERY_OR, QUERY_TAG } from '../utils/constants';
import { EnhancedSearchService } from '../search/enhanced-search-service';
import { FileMatchCacheService } from '../search/file-match-cache-service';
import { logger } from '../utils/logger';
import { SuggestionRowOptions } from '../ui/suggestion-row';
import { buildAliasRow, buildFileRow, buildUnresolvedRow } from '../ui/file-row';
import { getAliasTarget, getQueryTerms } from '../ui/suggestion-format';

/** Queries shorter than this are served by the fuzzy worker instead of the index */
const MIN_ENHANCED_QUERY_LENGTH = 2;

/** Debounce for content search while typing */
const SEARCH_DEBOUNCE_MS = 100;

/**
 * Enhanced file adapter that uses the new search system
 */
export default class EnhancedFileAdapter extends SuggestModalAdapter {
    modeLabel = 'Files';

    emptyStateText: string;

    app: UnsafeAppInterface;

    allItems: Match[];

    fileSearchPrefix: string;

    private searchService?: EnhancedSearchService;

    private fileMatchCache: FileMatchCacheService;

    private syncedCacheVersion: number;

    constructor(
        app: any,
        prevItems: any,
        plugin: any,
        palette: any,
        searchService?: EnhancedSearchService,
        fileMatchCache?: FileMatchCacheService,
    ) {
        super(app, prevItems, plugin, palette);
        this.searchService = searchService;
        this.fileMatchCache = fileMatchCache!;
        this.allItems = [];
        this.syncedCacheVersion = -1;
    }

    getWorkerMode(): WorkerMode {
        return 'files';
    }

    initialize(): void {
        super.initialize();

        this.emptyStateText = 'No matching files.';
        this.fileSearchPrefix = this.plugin.settings.fileSearchPrefix;

        this.hiddenIds = [...this.plugin.settings.hiddenFiles];
        this.hiddenIdsSettingsKey = 'hiddenFiles';

        this.syncFromCache();

        // Use obsidian's last open files as the previous items
        [...this.app.workspace.getLastOpenFiles()].reverse().forEach((filePath) => {
            const primaryMatch = this.fileMatchCache.getPrimaryMatch(filePath);

            if (primaryMatch) {
                this.prevItems.add(primaryMatch);
            }
        });

        this.rebuildSortedItems();
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

    /**
     * Use the index only when it is ready and the query is something it can answer.
     * Short queries and tag (@) / OR (||) syntax go to the fuzzy worker.
     * Like the search hooks below, receives the query already cleaned by the palette.
     */
    canUseEnhancedSearch(cleanQuery: string): boolean {
        if (cleanQuery.length < MIN_ENHANCED_QUERY_LENGTH) {
            return false;
        }

        if (cleanQuery.includes(QUERY_TAG) || cleanQuery.includes(QUERY_OR)) {
            return false;
        }

        return this.searchService?.isReady() ?? false;
    }

    getSearchDebounceMs(): number {
        return SEARCH_DEBOUNCE_MS;
    }

    /**
     * Override to use enhanced search when available
     */
    async getSearchResults(query: string): Promise<Match[]> {
        logger.debug('Enhanced search: getSearchResults called with:', query);
        this.syncFromCache();

        const cleanQuery = query;
        if (cleanQuery.length < 2) {
            return [];
        }

        // Check if search service is ready before attempting search
        if (!this.searchService?.isReady()) {
            logger.debug('Enhanced search: Service not ready, returning empty results');
            return [];
        }

        try {
            const enhancedResults = await this.searchService.search(cleanQuery, 50);
            logger.debug('Enhanced search: Found', enhancedResults.length, 'results for query:', cleanQuery);

            return enhancedResults.map((result) => new PaletteMatch(
                result.metadata.path,
                result.metadata.path,
                result.metadata.tags || [],
            ));
        } catch (error) {
            logger.error('Enhanced search failed:', error);
            return [];
        }
    }

    async streamSearchResults(
        query: string,
        options: {
            limit: number;
            signal?: AbortSignal;
            onUpdate: (matches: Match[], done: boolean) => void;
        },
    ): Promise<void> {
        logger.debug('Enhanced search: streamSearchResults called with:', query);
        this.syncFromCache();

        const cleanQuery = query;
        if (!this.searchService || !this.canUseEnhancedSearch(cleanQuery)) {
            // Let the palette fall back to the fuzzy worker
            throw new Error('Enhanced search is not available for this query');
        }

        try {
            await this.searchService.searchStream(cleanQuery, options.limit, {
                signal: options.signal,
                onChunk: (results, status) => {
                    // Intermediate chunks are partial and quickly superseded;
                    // only emit the final list so the view redraws once per query
                    if (options.signal?.aborted || !status.done) {
                        return;
                    }

                    const seen = new Set<string>();
                    const matches = results.reduce<Match[]>((acc, result) => {
                        if (seen.has(result.metadata.path)) {
                            return acc;
                        }
                        seen.add(result.metadata.path);

                        acc.push(new PaletteMatch(
                            result.metadata.path,
                            result.metadata.path,
                            result.metadata.tags || [],
                        ));
                        return acc;
                    }, []);

                    options.onUpdate(matches, status.done);
                },
            });
        } catch (error) {
            if (options.signal?.aborted) {
                return;
            }
            logger.error('Enhanced search streaming failed:', error);
            // Rethrow so the palette can fall back to the fuzzy worker
            throw error;
        }
    }

    getSuggestionRow(match: Match): SuggestionRowOptions {
        this.syncFromCache();
        const highlights = getQueryTerms(this.cleanQuery(this.palette.inputEl.value.trim()));

        if (this.fileMatchCache?.isUnresolvedId(match.id)) {
            return buildUnresolvedRow(match.text, highlights);
        }

        const aliasTarget = match.id.includes(':') ? getAliasTarget(match.id) : null;
        if (aliasTarget) {
            return buildAliasRow(match.text, aliasTarget, this.plugin.settings, highlights);
        }

        return buildFileRow({
            path: this.getResolvedFilePath(match),
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
                    openFileWithEventKeys(this.app, this.plugin.settings, file, event);
                } catch (error) {
                    new Notice(`Failed to create file: ${error.message}`);
                }
            }
            return;
        }

        if (!match) return;

        // For enhanced search results, the match.id contains the original file path
        // while match.text might be a processed display name
        this.syncFromCache();
        const filePath = this.getResolvedFilePath(match);

        // Record file access in search service using the original path
        if (this.searchService) {
            this.searchService.recordFileAccess(filePath);
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
            const recentMatch = this.fileMatchCache.getPrimaryMatch(filePath)
                || new PaletteMatch(filePath, filePath, match.tags);
            this.recordRecentMatch(recentMatch);
        } catch (error) {
            new Notice(`Failed to open file: ${error.message}`);
        }
    }

    /**
     * Indicates this adapter uses enhanced search and should bypass worker-based search
     */
    usesEnhancedSearch(): boolean {
        return this.searchService !== undefined; // Return true if we have a search service
    }

    /**
     * Perform enhanced search and update modal suggestions directly
     */
    async performEnhancedSearch(query: string): Promise<void> {
        if (!this.searchService) {
            logger.debug('Enhanced search: No search service available');
            return;
        }

        try {
            const cleanQuery = this.cleanQuery(query);
            logger.debug('Enhanced search: Searching for:', cleanQuery);

            const startTime = Date.now();
            const enhancedResults = await this.searchService.search(cleanQuery, this.plugin.settings.suggestionLimit);
            const searchTime = Date.now() - startTime;

            logger.debug('Enhanced search: Search completed in', searchTime, 'ms');

            if (enhancedResults.length === 0) {
                return;
            }

            logger.debug('Enhanced search: Found', enhancedResults.length, 'results');

            const suggestions: Match[] = [];
            const processedPaths = new Set<string>();

            for (const result of enhancedResults.slice(0, this.plugin.settings.suggestionLimit)) {
                if (processedPaths.has(result.metadata.path)) {
                    continue;
                }
                processedPaths.add(result.metadata.path);

                const file = this.app.vault.getAbstractFileByPath(result.metadata.path) as TFile;
                if (!file) {
                    continue;
                }

                const suggestion = new PaletteMatch(
                    result.metadata.path,
                    result.metadata.path,
                    result.metadata.tags || [],
                );
                if (suggestion) {
                    suggestions.push(suggestion);
                }
            }

            this.palette.currentSuggestions = suggestions;
            this.palette.limit = suggestions.length;
        } catch (error) {
            logger.error('Enhanced search: Error during search:', error);
            // Fallback to original search behavior
            this.palette.getSuggestionsAsync(query);
        }
    }

    getItems(): Match[] {
        this.syncFromCache();
        return super.getItems();
    }

    getSortedItems(): Match[] {
        this.syncFromCache();
        return super.getSortedItems();
    }

    private syncFromCache(): void {
        if (!this.fileMatchCache || this.syncedCacheVersion === this.fileMatchCache.getVersion()) {
            return;
        }

        this.syncedCacheVersion = this.fileMatchCache.getVersion();
        this.setItems(this.fileMatchCache.getAllMatches());
    }

    private getResolvedFilePath(match: Match): string {
        if (!match.id.includes(':')) {
            return match.id;
        }

        return getAliasTarget(match.id) || match.id;
    }
}
