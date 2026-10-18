/**
 * Hybrid Search Adapter for the palette modal
 * 
 * Provides a Google-like search experience by combining keyword and semantic search.
 * Uses RRF fusion and re-ranking for optimal results.
 */

import {
    Instruction, Notice, TFile, Menu, parseFrontMatterTags,
} from 'obsidian';
import {
    generateHotKeyText,
    openFileWithEventKeys,
    OrderedSet,
    PaletteMatch,
    SuggestModalAdapter,
} from '../utils';
import { Match, UnsafeAppInterface } from '../types/types';
import { ActionType } from '../utils/constants';
import { HybridSearchService } from '../search/hybrid/hybrid-search-service';
import { HybridSearchResult } from '../search/hybrid/types';
import { logger } from '../utils/logger';
import { SuggestionNotePart, SuggestionRowFlair, SuggestionRowOptions } from '../ui/suggestion-row';
import { buildFileRow } from '../ui/file-row';
import {
    formatDate, formatFileTitle, formatTags, getQueryTerms, toSingleLine,
} from '../ui/suggestion-format';
import { PromptStatus } from '../ui/prompt-chrome';
import { getSemanticStatus } from '../ui/semantic-status';

/**
 * Extended match type for hybrid search results with extra metadata
 */
interface HybridMatch extends Match {
    hybridResult?: HybridSearchResult;
}

/**
 * Adapter for hybrid search mode in the command palette
 */
export default class HybridSearchAdapter extends SuggestModalAdapter {
    modeLabel = 'Hybrid';

    emptyStateText: string;

    app: UnsafeAppInterface;

    allItems: Match[];

    private hybridSearchService?: HybridSearchService;

    private hybridSearchPrefix: string;

    private lastSearchResults: HybridMatch[] = [];

    /** True while the cross-encoder reranks the first-pass results */
    private isRefining = false;

    /** Debounce applied by the palette before searching (semantic search is expensive) */
    private readonly SEARCH_DEBOUNCE_MS = 150;

    private readonly MIN_QUERY_LENGTH = 2;

    constructor(
        app: any,
        prevItems: OrderedSet<Match>,
        plugin: any,
        palette: any,
        hybridSearchService?: HybridSearchService,
    ) {
        super(app, prevItems, plugin, palette);
        this.hybridSearchService = hybridSearchService;
        this.allItems = [];
    }

    initialize(): void {
        super.initialize();

        this.emptyStateText = 'No matching notes.';
        this.hybridSearchPrefix = '?'; // Use ? prefix for hybrid search

        this.hiddenIds = this.plugin.settings.hiddenFiles;
        this.hiddenIdsSettingsKey = 'hiddenFiles';

        this.lastSearchResults = [];

        // Load recent files as initial suggestions
        this.loadRecentFiles();
    }

    /**
     * Load recent files for when no search query is provided
     */
    private loadRecentFiles(): void {
        const recentFiles = this.app.workspace.getLastOpenFiles().slice(0, 10);
        const items: HybridMatch[] = [];

        // getLastOpenFiles is most-recent-first; add oldest first so the most recent
        // file ends up on top of the sorted (last-added-first) list
        [...recentFiles].reverse().forEach((filePath: string) => {
            if (!filePath || typeof filePath !== 'string') return;

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const displayPath = this.processDisplayPath(filePath);
                const match = new PaletteMatch(filePath, displayPath) as HybridMatch;
                this.prevItems.add(match);
                items.push(match);
            }
        });

        // setItems rebuilds the sorted cache that the palette reads
        this.setItems(items);
    }

    mount(): void {
        this.keymapHandlers = [
            this.palette.scope.register(['Mod'], this.plugin.settings.commandSearchHotkey, () => this.palette.changeActionType(ActionType.Commands)),
            this.palette.scope.register(['Mod'], this.plugin.settings.fileSearchHotkey, () => this.palette.changeActionType(ActionType.Files)),
            this.palette.scope.register(['Mod'], this.plugin.settings.tagSearchHotkey, () => this.palette.changeActionType(ActionType.Tags)),
        ];
    }

    getInstructions(): Instruction[] {
        const { openInNewTabMod } = this.plugin.settings;
        return [
            { command: generateHotKeyText({ modifiers: [], key: 'ENTER' }, this.plugin.settings), purpose: 'Open file' },
            { command: generateHotKeyText({ modifiers: [openInNewTabMod], key: 'ENTER' }, this.plugin.settings), purpose: 'Open in new pane' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.commandSearchHotkey }, this.plugin.settings), purpose: 'Commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.fileSearchHotkey }, this.plugin.settings), purpose: 'Files' },
        ];
    }

    cleanQuery(query: string): string {
        // Remove hybrid search prefix if present
        if (query.startsWith(this.hybridSearchPrefix)) {
            return query.slice(this.hybridSearchPrefix.length).trim();
        }
        return query.trim();
    }

    /**
     * Process display path according to user settings
     */
    private processDisplayPath(filePath: string): string {
        let displayPath = filePath;

        if (this.plugin.settings.displayOnlyNotesNames) {
            displayPath = filePath.split('/').pop() || filePath;
        }

        if (this.plugin.settings.hideMdExtension && displayPath.endsWith('.md')) {
            displayPath = displayPath.slice(0, -3);
        }

        return displayPath;
    }

    /**
     * Indicate this adapter uses enhanced/hybrid search
     */
    usesEnhancedSearch(): boolean {
        return true;
    }

    canUseEnhancedSearch(query: string): boolean {
        return this.cleanQuery(query).length >= this.MIN_QUERY_LENGTH
            && !!this.hybridSearchService?.isReady();
    }

    getSearchDebounceMs(): number {
        return this.SEARCH_DEBOUNCE_MS;
    }

    private toHybridMatch(result: HybridSearchResult): HybridMatch {
        const displayPath = this.processDisplayPath(result.path);
        const match = new PaletteMatch(
            result.path,
            displayPath,
            result.metadata?.tags || [],
        ) as HybridMatch;
        match.hybridResult = result;
        return match;
    }

    /**
     * Get hybrid search results
     */
    async getSearchResults(query: string): Promise<Match[]> {
        logger.debug('HybridSearchAdapter: getSearchResults called with:', query);

        const cleanQuery = this.cleanQuery(query);
        if (!this.hybridSearchService || !this.canUseEnhancedSearch(cleanQuery)) {
            logger.debug('HybridSearchAdapter: Service not ready or query too short');
            return [];
        }

        try {
            const results = await this.hybridSearchService.search(cleanQuery, {
                limit: this.plugin.settings.hybridSearch.maxResults,
            });

            logger.debug('HybridSearchAdapter: Found', results.length, 'results');

            // Convert to HybridMatch format
            this.lastSearchResults = results.map((result) => this.toHybridMatch(result));

            return this.lastSearchResults;
        } catch (error) {
            logger.error('HybridSearchAdapter: Search failed', error);
            return [];
        }
    }

    /**
     * Stream search results for better UX
     * Shows keyword results immediately, then blends in semantic results as they arrive.
     * Debouncing is handled by the palette (see getSearchDebounceMs).
     */
    async streamSearchResults(
        query: string,
        options: {
            limit: number;
            signal?: AbortSignal;
            onUpdate: (matches: Match[], done: boolean) => void;
        },
    ): Promise<void> {
        const cleanQuery = this.cleanQuery(query);
        if (!this.hybridSearchService || !this.canUseEnhancedSearch(cleanQuery)) {
            options.onUpdate([], true);
            return;
        }

        try {
            await this.hybridSearchService.searchStream(cleanQuery, {
                limit: options.limit,
                signal: options.signal,
                onUpdate: (results, phase) => {
                    if (options.signal?.aborted) return;

                    this.lastSearchResults = results.map((result) => this.toHybridMatch(result));
                    // 'fused' is the first-pass order shown while the cross-encoder reranks
                    this.setRefining(phase === 'fused');

                    // Emit results; done=true only when phase is 'complete'
                    options.onUpdate(this.lastSearchResults, phase === 'complete');
                },
            });
        } catch (error) {
            if (options.signal?.aborted) {
                return;
            }
            logger.error('HybridSearchAdapter: Stream search failed', error);
            options.onUpdate([], true);
        } finally {
            if (!options.signal?.aborted) {
                this.setRefining(false);
            }
        }
    }

    /**
     * Describe a hybrid row: file title with query highlights, note line with
     * folder, date and excerpt, score at the right and a hover-only actions menu.
     */
    getSuggestionRow(match: Match): SuggestionRowOptions {
        const result = (match as HybridMatch).hybridResult;
        const { settings } = this.plugin;
        const queryTerms = getQueryTerms(this.cleanQuery(this.palette.inputEl?.value ?? ''));

        const actionsFlair: SuggestionRowFlair = {
            icon: 'more-horizontal',
            label: 'More options',
            kind: 'menu',
            onClick: (event) => this.openActionsMenu(match, event),
        };

        if (!result) {
            // Recent files (empty query): same as file rows; the palette adds the recent label
            const file = this.app.vault.getAbstractFileByPath(match.id);
            const tags = file instanceof TFile ? this.getFileTags(file) : match.tags;
            return {
                ...buildFileRow({ path: match.id, settings, tags }),
                flair: actionsFlair,
            };
        }

        const excerpt = toSingleLine(result.excerpt);
        const details: SuggestionNotePart[] = [formatDate(result.lastModified || result.file?.stat?.mtime)];
        if (excerpt) {
            details.push({ text: excerpt, highlights: getQueryTerms((result.matches?.keywordMatches || []).join(' ')) });
        } else {
            details.push(formatTags(match.tags));
        }

        return {
            ...buildFileRow({
                path: match.id,
                settings,
                highlights: queryTerms,
                details,
            }),
            // No percentage: after reranking, rows are ordered by fused rank, so a
            // per-row score would read out of order. The order is the signal.
            flair: actionsFlair,
        };
    }

    private getFileTags(file: TFile): string[] {
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache) return [];
        const inline = (cache.tags || []).map((tag) => tag.tag);
        return inline.concat(parseFrontMatterTags(cache.frontmatter) || []);
    }

    /**
     * Existing actions menu: vote on the result and hide/unhide it.
     */
    private openActionsMenu(match: Match, event: MouseEvent): void {
        const result = (match as HybridMatch).hybridResult;
        const displayName = formatFileTitle(match.id, this.plugin.settings).title;
        const menu = new Menu();

        if (result && this.hybridSearchService) {
            menu.addItem((item) => {
                item
                    .setTitle('Upvote result')
                    .setIcon('thumbs-up')
                    .onClick(() => {
                        this.recordResultFeedback(match.id, displayName, 1);
                    });
            });

            menu.addItem((item) => {
                item
                    .setTitle('Downvote result')
                    .setIcon('thumbs-down')
                    .onClick(() => {
                        this.recordResultFeedback(match.id, displayName, -1);
                    });
            });

            menu.addSeparator();
        }

        const isHidden = this.hiddenIds.includes(match.id);
        menu.addItem((item) => {
            item
                .setTitle(isHidden ? 'Unhide item' : 'Ignore item')
                .setIcon(isHidden ? 'eye' : 'eye-off')
                .onClick(() => {
                    this.toggleHideId(match.id);
                });
        });

        menu.showAtMouseEvent(event);
    }

    getStatus(): PromptStatus | null {
        if (this.isRefining) {
            return { text: 'Refining…' };
        }
        return getSemanticStatus(this.plugin);
    }

    private setRefining(refining: boolean): void {
        if (this.isRefining === refining) return;
        this.isRefining = refining;
        this.palette.refreshStatus();
    }

    private recordResultFeedback(path: string, displayName: string, vote: 1 | -1): void {
        if (!this.hybridSearchService || !this.palette.inputEl) {
            return;
        }

        const query = this.cleanQuery(this.palette.inputEl.value);
        if (!query) {
            new Notice('Search before voting on a result.');
            return;
        }

        this.hybridSearchService.recordResultFeedback(query, path, vote);
        // The query is unchanged, so force a fresh search to apply the new ranking
        this.palette.refreshSuggestions();

        const direction = vote > 0 ? 'more' : 'less';
        new Notice(`Marked "${displayName}" as ${direction} relevant for this search.`);
    }

    /**
     * Handle file selection
     */
    async onChooseSuggestion(match: Match | null, event?: MouseEvent | KeyboardEvent): Promise<void> {
        if (!match) return;

        const filePath = match.id;

        // Record selection for improved future rankings
        if (this.hybridSearchService && this.palette.inputEl) {
            const query = this.cleanQuery(this.palette.inputEl.value);
            if (query) {
                this.hybridSearchService.recordSelection(query, filePath);
            }
        }

        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file) {
            new Notice(`File not found: ${filePath}`);
            return;
        }

        if (!(file instanceof TFile)) {
            new Notice(`Path is not a file: ${filePath}`);
            return;
        }

        try {
            openFileWithEventKeys(this.app, this.plugin.settings, file, event);
        } catch (error) {
            logger.error('HybridSearchAdapter: Failed to open file', error);
            new Notice(`Failed to open file: ${error.message}`);
        }
    }
}
