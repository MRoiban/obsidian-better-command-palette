/**
 * Modal for semantic search interface that matches the file search window UI
 */

import { App, SuggestModal, TFile } from 'obsidian';
import BetterCommandPalettePlugin from '../../main';
import { SemanticSearchResult } from './types';
import { logger } from '../../utils/logger';
import { renderSuggestionRow } from '../../ui/suggestion-row';
import { buildFileRow } from '../../ui/file-row';
import {
    formatRecentLabel, formatScore, toSingleLine,
} from '../../ui/suggestion-format';
import { installRenderHook, PromptChrome, PromptStatus } from '../../ui/prompt-chrome';
import { getSemanticStatus, isSameStatus, openPluginSettings } from '../../ui/semantic-status';

interface SemanticMatch {
    id: string;
    text: string;
    excerpt?: string;
    similarity: number;
    file: TFile;
    /** Set for default suggestions shown for an empty query (not search results) */
    defaultKind?: 'recent' | 'modified';
    matches: {
        titleMatch: boolean;
        tagMatch: boolean;
        recentlyModified: boolean;
    };
}

/** Delay after the last keystroke before a query is embedded. */
const SEARCH_DEBOUNCE_MS = 200;

/** How often the status line is refreshed while the modal is open */
const STATUS_POLL_MS = 1000;

const EMPTY_STATE_TEXT = 'No matching notes.';

const UNAVAILABLE_STATE_TEXT = 'Semantic search is unavailable.';

export class SemanticSearchModal extends SuggestModal<SemanticMatch> {
    plugin: BetterCommandPalettePlugin;

    private currentResults: SemanticMatch[] = [];

    /** Query whose results are in `currentResults`. */
    private lastCompletedQuery = '';

    /** Query that is debounced or currently being searched. */
    private pendingQuery: string | null = null;

    private searchDebounceTimer?: number;

    /** Incremented per search; only the latest search may apply its results. */
    private searchSequence = 0;

    private searchAbortController?: AbortController;

    private isClosed = false;

    private readonly chrome: PromptChrome;

    /** Status from a failed search (shown until the next search) */
    private searchErrorStatus: PromptStatus | null = null;

    private currentStatus: PromptStatus | null = null;

    private statusPollTimer: number | null = null;

    private unsubscribeProviderStatus?: () => void;

    constructor(app: App, plugin: BetterCommandPalettePlugin) {
        super(app);
        this.plugin = plugin;

        // Add the same CSS class as the file search modal
        this.modalEl.addClass('better-command-palette');
        this.modalEl.setAttribute('palette-mode', 'semantic-search');

        this.setPlaceholder('Search for concepts, ideas, or topics…');
        this.emptyStateText = EMPTY_STATE_TEXT;

        this.chrome = new PromptChrome(this);
        this.chrome.setModeLabel('Semantic');
        installRenderHook(this, () => {
            this.refreshStatus();
            this.chrome.attach();
        });

        // Set instructions to match file search
        this.setInstructions([
            { command: '↑↓', purpose: 'Navigate' },
            { command: '↵', purpose: 'Open file' },
            { command: 'esc', purpose: 'Close' },
        ]);
    }

    // Convert semantic search results to the format expected by SuggestModal
    private convertToMatches(results: SemanticSearchResult[]): SemanticMatch[] {
        return results.map((result) => ({
            id: result.file.path,
            text: result.title,
            excerpt: result.excerpt,
            // Results are ordered by relevance (similarity + metadata, or the reranker),
            // so show that score; raw similarity would read out of order.
            similarity: result.relevanceScore,
            file: result.file,
            matches: result.matches,
        }));
    }

    getSuggestions(query: string): SemanticMatch[] {
        if (!query || query.length < 3) {
            // Drop any pending/in-flight search so its results cannot replace the defaults
            this.cancelPendingSearch();
            this.lastCompletedQuery = '';
            // Show helpful suggestions when no query provided
            return this.getDefaultSuggestions();
        }

        // Results for this exact query are already shown
        if (query === this.lastCompletedQuery) {
            if (this.pendingQuery !== null) {
                // User typed back to the completed query; the pending search is obsolete
                this.cancelPendingSearch();
            }
            return this.currentResults;
        }

        this.scheduleSearch(query);

        // Keep showing the previous results until the new search completes
        return this.currentResults;
    }

    private scheduleSearch(query: string): void {
        if (query === this.pendingQuery) {
            // Already debounced or running for this query
            return;
        }

        this.pendingQuery = query;
        this.clearSearchDebounce();
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = undefined;
            this.performAsyncSearch(query).catch((error) => {
                logger.error('[SemanticSearch] Search error:', error);
            });
        }, SEARCH_DEBOUNCE_MS);
    }

    private clearSearchDebounce(): void {
        if (this.searchDebounceTimer !== undefined) {
            window.clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = undefined;
        }
    }

    private cancelPendingSearch(): void {
        this.clearSearchDebounce();
        this.searchSequence++;
        this.searchAbortController?.abort();
        this.searchAbortController = undefined;
        this.pendingQuery = null;
    }

    /**
   * Get default suggestions when no query is provided
   * Shows recently accessed and recently modified files
   */
    private getDefaultSuggestions(): SemanticMatch[] {
        const suggestions: SemanticMatch[] = [];
        const processedPaths = new Set<string>();

        try {
            // Get recently opened files from workspace
            const recentFiles = this.app.workspace.getLastOpenFiles()
                .slice(0, 8) // Limit to 8 most recent
                .map((path) => this.app.vault.getAbstractFileByPath(path))
                .filter((file): file is TFile => file instanceof TFile);

            // Add recent files as suggestions
            for (const file of recentFiles) {
                if (processedPaths.has(file.path)) continue;
                processedPaths.add(file.path);

                suggestions.push({
                    id: file.path,
                    text: file.basename,
                    similarity: 1.0, // High relevance for recent files
                    file,
                    defaultKind: 'recent',
                    matches: {
                        titleMatch: false,
                        tagMatch: false,
                        recentlyModified: this.isRecentlyModified(file),
                    },
                });
            }

            // Fill remaining slots with recently modified files if we have space
            if (suggestions.length < 10) {
                const allFiles = this.app.vault.getMarkdownFiles()
                    .filter((file) => !processedPaths.has(file.path))
                    .sort((a, b) => b.stat.mtime - a.stat.mtime) // Sort by modification time
                    .slice(0, 10 - suggestions.length);

                for (const file of allFiles) {
                    suggestions.push({
                        id: file.path,
                        text: file.basename,
                        similarity: 0.8, // Good relevance for recently modified
                        file,
                        defaultKind: 'modified',
                        matches: {
                            titleMatch: false,
                            tagMatch: false,
                            recentlyModified: true,
                        },
                    });
                }
            }

            return suggestions;
        } catch (error) {
            logger.warn('[SemanticSearch] Error getting default suggestions:', error);
            return [];
        }
    }

    /**
   * Check if file was recently modified (within last 7 days)
   */
    private isRecentlyModified(file: TFile): boolean {
        const daysSince = (Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24);
        return daysSince <= 7;
    }

    private async performAsyncSearch(query: string): Promise<void> {
        if (this.isClosed) {
            return;
        }

        // Newer search supersedes any in-flight one
        const sequence = ++this.searchSequence;
        this.searchAbortController?.abort();
        const abortController = new AbortController();
        this.searchAbortController = abortController;
        const isLatest = () => !this.isClosed && sequence === this.searchSequence;

        try {
            logger.debug('[SemanticSearch] Starting search for:', query);
            const searchEngine = this.plugin.getSemanticSearchEngine();
            if (!searchEngine) {
                logger.warn('[SemanticSearch] Search engine not available');
                this.searchErrorStatus = {
                    text: 'Semantic search isn\'t available. Turn it on in settings.',
                    isError: true,
                    action: { label: 'Open settings', onClick: () => openPluginSettings(this.plugin) },
                };
                this.emptyStateText = UNAVAILABLE_STATE_TEXT;
                // Mark as completed so the re-render below does not retry in a loop
                this.currentResults = [];
                this.lastCompletedQuery = query;
                return;
            }

            this.searchErrorStatus = null;
            // Blank while the search (and possibly the model load) is in flight, so
            // "No matching notes." only appears for a finished search
            this.emptyStateText = '';
            const startTime = Date.now();
            const results = await searchEngine.search(query, { signal: abortController.signal });
            if (!isLatest()) {
                return;
            }

            logger.debug(`[SemanticSearch] Found ${results.length} results in ${Date.now() - startTime}ms`);
            this.currentResults = this.convertToMatches(results);
            this.emptyStateText = EMPTY_STATE_TEXT;
            this.lastCompletedQuery = query;
        } catch (error) {
            if (!isLatest() || (error instanceof Error && error.name === 'AbortError')) {
                return;
            }
            logger.error('[SemanticSearch] Search error:', error);
            this.searchErrorStatus = {
                text: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
            };
            this.currentResults = [];
            this.lastCompletedQuery = query;
        } finally {
            if (isLatest()) {
                if (this.pendingQuery === query) {
                    this.pendingQuery = null;
                }
                if (this.searchAbortController === abortController) {
                    this.searchAbortController = undefined;
                }
                // Re-render with whatever is typed now: shows these results if the input still
                // matches, otherwise schedules a search for the current input
                this.inputEl?.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }

    renderSuggestion(match: SemanticMatch, el: HTMLElement): void {
        const metadata = this.app.metadataCache.getFileCache(match.file);
        const tags = (metadata?.tags || []).map((tagRef) => tagRef.tag);

        if (match.defaultKind) {
            // Empty query: recent and recently modified files render as normal file rows
            renderSuggestionRow(el, {
                ...buildFileRow({ path: match.file.path, settings: this.plugin.settings, tags }),
                auxText: match.defaultKind === 'recent' ? formatRecentLabel(this.plugin.settings.recentlyUsedText) : undefined,
            });
            return;
        }

        const excerpt = toSingleLine(match.excerpt);
        renderSuggestionRow(el, {
            ...buildFileRow({
                path: match.file.path,
                settings: this.plugin.settings,
                // Snippet of the best-matching chunk; fall back to tags when there is none
                details: excerpt ? [excerpt] : undefined,
                tags,
            }),
            auxText: formatScore(match.similarity),
        });
    }

    /** Status line: search errors first, then model loading/errors and indexing progress. */
    private refreshStatus(): void {
        const status = this.searchErrorStatus ?? getSemanticStatus(this.plugin);
        if (!isSameStatus(status, this.currentStatus)) {
            this.currentStatus = status;
            this.chrome.setStatus(status);
        }
    }

    onChooseSuggestion(match: SemanticMatch | null, _evt: MouseEvent | KeyboardEvent): void {
        if (!match) {
            // Semantic search doesn't support creating new items
            return;
        }

        logger.debug('[SemanticSearch] Opening file:', match.file.path);
        // Open the file exactly like in the file search modal
        this.app.workspace.openLinkText(match.file.path, '', false);
        this.close();
    }

    onOpen(): void {
        logger.debug('[SemanticSearch] Modal opened');
        super.onOpen();
        this.isClosed = false;

        // Keep the status line current (model loading, indexing progress)
        this.unsubscribeProviderStatus = this.plugin.getEmbeddingService()
            ?.onProviderStatusChange(() => this.refreshStatus());
        this.statusPollTimer = window.setInterval(() => this.refreshStatus(), STATUS_POLL_MS);
        this.refreshStatus();

        // Load the local embedding model in the background so the first query is fast
        this.plugin.getEmbeddingService()?.warmup().catch((error) => {
            logger.debug('[SemanticSearch] Embedding model warmup failed', error);
        });

        // Restore last query if preserve query is enabled
        if (this.plugin.settings.semanticSearch.preserveQuery && this.plugin.lastSemanticQuery) {
            this.inputEl.value = this.plugin.lastSemanticQuery;
            // Trigger search with the restored query
            this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    onClose(): void {
        logger.debug('[SemanticSearch] Modal closed');

        // Save current query if preserve query is enabled
        if (this.plugin.settings.semanticSearch.preserveQuery) {
            this.plugin.lastSemanticQuery = this.inputEl.value;
        }

        super.onClose();
        this.isClosed = true;
        this.cancelPendingSearch();
        this.unsubscribeProviderStatus?.();
        this.unsubscribeProviderStatus = undefined;
        if (this.statusPollTimer !== null) {
            window.clearInterval(this.statusPollTimer);
            this.statusPollTimer = null;
        }
        this.searchErrorStatus = null;
        this.currentStatus = null;
        this.chrome.setStatus(null);
        this.currentResults = [];
        this.lastCompletedQuery = '';
    }
}
