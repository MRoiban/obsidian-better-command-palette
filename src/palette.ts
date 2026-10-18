import { App, SuggestModal } from 'obsidian';
import {
    generateHotKeyText,
    getRecentLabel,
    OrderedSet, PaletteMatch, SuggestModalAdapter,
} from 'src/utils';
import {
    Match,
    SuggestionsWorkerResultMessage,
    UnsafeSuggestModalInterface,
    WorkerMode,
} from 'src/types/types';
import {
    BetterCommandPaletteCommandAdapter,
    BetterCommandPaletteFileAdapter,
    BetterCommandPaletteTagAdapter,
} from 'src/palette-modal-adapters';
import EnhancedFileAdapter from 'src/palette-modal-adapters/enhanced-file-adapter';
import HybridSearchAdapter from 'src/palette-modal-adapters/hybrid-adapter';
import BetterCommandPalettePlugin from 'src/main';
import { EnhancedSearchService } from 'src/search/enhanced-search-service';
import { HybridSearchService } from 'src/search/hybrid/hybrid-search-service';
import { FileMatchCacheService } from 'src/search/file-match-cache-service';
import { ActionType } from './utils/constants';
import { logger } from './utils/logger';
import { renderSuggestionRow } from './ui/suggestion-row';
import { installRenderHook, PromptChrome } from './ui/prompt-chrome';
import { isSameStatus } from './ui/semantic-status';
import type { PromptStatus } from './ui/prompt-chrome';

/** How often the status line is refreshed while it may change (indexing, model loading) */
const STATUS_POLL_MS = 1000;

/**
 * Obsidian's chooser exposes the rendered values and the selected index at runtime,
 * but they are not part of the public typings.
 */
type SelectableChooser = UnsafeSuggestModalInterface['chooser'] & {
    values?: Match[] | null;
    selectedItem?: number;
    setSelectedItem?: (index: number, scrollIntoView?: boolean) => void;
};

/**
 * The suggestions worker is shared by every palette instance, so request ids must be
 * unique across instances. Otherwise a late reply addressed to a closed modal could
 * match the active request id of a newly opened one.
 */
let nextWorkerRequestId = 0;

class BetterCommandPaletteModal extends SuggestModal<Match> implements UnsafeSuggestModalInterface {
    // Unsafe interface
    chooser!: UnsafeSuggestModalInterface['chooser'];

    updateSuggestions!: UnsafeSuggestModalInterface['updateSuggestions'];

    plugin!: BetterCommandPalettePlugin;

    actionType!: ActionType;

    fileSearchPrefix!: string;

    tagSearchPrefix!: string;

    suggestionsWorker!: Worker;

    currentSuggestions!: Match[];

    lastQuery!: string;

    /** Mode label, status line and hidden-items toggle */
    chrome!: PromptChrome;

    private currentStatus: PromptStatus | null = null;

    private statusPollTimer: number | null = null;

    showHiddenItems!: boolean;

    initialInputValue!: string;

    commandAdapter!: BetterCommandPaletteCommandAdapter;

    fileAdapter!: BetterCommandPaletteFileAdapter | EnhancedFileAdapter;

    tagAdapter!: BetterCommandPaletteTagAdapter;

    hybridAdapter!: HybridSearchAdapter;

    currentAdapter!: SuggestModalAdapter;

    suggestionLimit!: number;

    hybridSearchPrefix!: string;

    currentSearchAbortController?: AbortController;

    /**
     * Mode used when the input has no prefix. Only acts as a default until the user
     * changes mode (hotkey or typed prefix), after which it is cleared.
     */
    initialMode?: ActionType;

    private registeredWorkerCorpusVersions = new Map<WorkerMode, number>();

    /** Id of the worker request whose reply we are waiting for (0 = none). */
    private activeWorkerRequestId = 0;

    /** Incremented for every new query so stale async search results can be dropped. */
    private searchSequence = 0;

    private searchDebounceTimer: number | null = null;

    /** Forces the next getSuggestions call to search even if the query is unchanged. */
    private forceNextSearch = false;

    /** True once onOpen has applied the initial input value for the current open. */
    private initialInputApplied = false;

    private readonly handleWorkerMessage = (msg: MessageEvent) => this.receivedSuggestions(msg);

    constructor(
        app: App,
        prevCommands: OrderedSet<Match>,
        prevTags: OrderedSet<Match>,
        plugin: BetterCommandPalettePlugin,
        suggestionsWorker: Worker,
        searchService: EnhancedSearchService,
        hybridSearchService?: HybridSearchService,
        initialInputValue = '',
        initialMode?: ActionType,
        fileMatchCache?: FileMatchCacheService,
    ) {
        super(app);

        // General instance variables
        this.fileSearchPrefix = plugin.settings.fileSearchPrefix;
        this.tagSearchPrefix = plugin.settings.tagSearchPrefix;
        this.hybridSearchPrefix = '?'; // Use ? for hybrid search
        this.suggestionLimit = plugin.settings.suggestionLimit;
        this.initialInputValue = initialInputValue;
        this.initialMode = initialMode;

        this.plugin = plugin;

        this.modalEl.addClass('better-command-palette');

        // Set up all of our different adapters
        this.commandAdapter = new BetterCommandPaletteCommandAdapter(
            app,
            prevCommands,
            plugin,
            this,
        );

        // Use enhanced file adapter which will fallback to original behavior if needed
        this.fileAdapter = new EnhancedFileAdapter(
            app,
            new OrderedSet<Match>(),
            plugin,
            this,
            searchService,
            fileMatchCache,
        );

        this.tagAdapter = new BetterCommandPaletteTagAdapter(
            app,
            prevTags,
            plugin,
            this,
        );

        // Hybrid search adapter (combines keyword + semantic)
        this.hybridAdapter = new HybridSearchAdapter(
            app,
            new OrderedSet<Match>(),
            plugin,
            this,
            hybridSearchService,
        );

        // Lets us do the suggestion fuzzy search in a different thread.
        // The message handler is attached in onOpen because close() detaches it.
        this.suggestionsWorker = suggestionsWorker;

        // Mode label in the input row, status line and hidden toggle in the results
        this.showHiddenItems = false;
        this.chrome = new PromptChrome(this, this.toggleHiddenItems);
        installRenderHook(this, () => this.afterRender());

        // If we have an initial input value, we need to set it early so action type detection works
        if (this.initialInputValue) {
            this.inputEl.value = this.initialInputValue;
        }

        // Set the action type so the mode label, placeholder and empty state are correct
        this.updateActionType();

        // Set our scopes for the modal
        this.setScopes(plugin);
    }

    close(evt?: KeyboardEvent) {
        // Save current query if preserve query is enabled and we're in file search mode
        if (this.plugin.settings.enhancedSearch.preserveQuery && this.actionType === ActionType.Files) {
            const currentQuery = this.inputEl.value;
            // Remove the file search prefix to get just the query part
            const cleanQuery = this.fileAdapter.cleanQuery(currentQuery);
            this.plugin.lastFileQuery = cleanQuery;
        }

        super.close();

        if (evt) {
            evt.preventDefault();
        }

        this.cancelPendingSearch();
        this.stopStatusPolling();

        // Only detach our own handler; another palette instance may own the worker now
        if (this.suggestionsWorker.onmessage === this.handleWorkerMessage) {
            this.suggestionsWorker.onmessage = null;
        }
    }

    setScopes(plugin: BetterCommandPalettePlugin) {
        const closeModal = (event: KeyboardEvent) => {
            // Have to cast this to access `value`
            const el = event.target as HTMLInputElement;

            if (plugin.settings.closeWithBackspace && el.value === '') {
                this.close(event);
            }
        };

        const { openInNewTabMod, createNewFileMod } = plugin.settings;

        this.scope.register([], 'Backspace', (event: KeyboardEvent) => {
            closeModal(event);
        });

        this.scope.register(['Mod'], 'Backspace', (event: KeyboardEvent) => {
            closeModal(event);
        });

        this.scope.register([createNewFileMod], 'Enter', (event: KeyboardEvent) => {
            if (this.actionType === ActionType.Files) {
                this.currentAdapter.onChooseSuggestion(null, event);
                this.close(event);
            }
        });

        this.scope.register([createNewFileMod, openInNewTabMod], 'Enter', (event: KeyboardEvent) => {
            if (this.actionType === ActionType.Files) {
                this.currentAdapter.onChooseSuggestion(null, event);
                this.close(event);
            }
        });

        this.scope.register([openInNewTabMod], 'Enter', (event: KeyboardEvent) => {
            if (this.actionType !== ActionType.Files && this.actionType !== ActionType.Hybrid) {
                return;
            }

            // Use the chooser's own selection: the rendered list can differ from
            // currentSuggestions (e.g. hidden items are filtered out)
            const selectedMatch = this.getSelectedMatch();
            if (selectedMatch) {
                this.currentAdapter.onChooseSuggestion(selectedMatch, event);
                this.close(event);
            }
        });

        this.scope.register(['Mod'], 'I', this.toggleHiddenItems);
    }

    toggleHiddenItems = () => {
        this.showHiddenItems = !this.showHiddenItems;
        this.updateSuggestions();
    };

    /** Runs after every render: refresh the status line and re-attach the chrome. */
    private afterRender(): void {
        this.refreshStatus();
        this.chrome.attach();
    }

    /** Re-read the current adapter's status (indexing, model loading, reranking). */
    refreshStatus(): void {
        const status = this.currentAdapter?.getStatus() ?? null;
        if (!isSameStatus(status, this.currentStatus)) {
            this.currentStatus = status;
            this.chrome.setStatus(status);
        }
    }

    private startStatusPolling(): void {
        this.stopStatusPolling();
        this.statusPollTimer = window.setInterval(() => this.refreshStatus(), STATUS_POLL_MS);
    }

    private stopStatusPolling(): void {
        if (this.statusPollTimer !== null) {
            window.clearInterval(this.statusPollTimer);
            this.statusPollTimer = null;
        }
    }

    private getSelectedMatch(): Match | null {
        const chooser = this.chooser as SelectableChooser;
        const index = chooser.selectedItem ?? -1;
        return chooser.values?.[index] ?? null;
    }

    onOpen() {
        // The modal can be reopened (e.g. from the tag adapter), so reset per-open state
        this.initialInputApplied = false;
        this.forceNextSearch = true;
        // Another palette instance may have registered a different corpus in the shared worker
        this.registeredWorkerCorpusVersions.clear();
        this.suggestionsWorker.onmessage = this.handleWorkerMessage;

        super.onOpen();
        this.startStatusPolling();

        // Record modal open for pogo-sticking detection
        if (this.plugin.usageTracker) {
            this.plugin.usageTracker.recordSearchModalOpen();
        }

        // Add the initial value to the input
        // TODO: Figure out if there is a way to bypass the first seach
        // result flickering before this is set
        // As far as I can tell onOpen resets the value of the input so this is the first place
        if (this.initialInputValue) {
            // Check if we should restore the last query for file search
            if (this.plugin.settings.enhancedSearch.preserveQuery
                && this.initialInputValue === this.plugin.settings.fileSearchPrefix
                && this.plugin.lastFileQuery) {
                // Restore the last file search query
                this.inputEl.value = this.initialInputValue + this.plugin.lastFileQuery;
            } else {
                // Instead of just setting the query, we need to:
                // 1. Set the input value directly
                this.inputEl.value = this.initialInputValue;
            }
            // 2. Update the action type based on the prefix BEFORE any suggestions are generated
            this.updateActionType();
            // 3. Initialize the adapter if needed before updating suggestions
            if (!this.currentAdapter.initialized) {
                this.currentAdapter.initialize();
            }
            // 4. Force an immediate suggestion update with correct adapter
            this.updateSuggestions();
        }

        this.initialInputApplied = true;
    }

    changeActionType(actionType: ActionType) {
        // An explicit mode change ends the initial (hotkey) mode default
        this.initialMode = undefined;

        let prefix = '';
        if (actionType === ActionType.Files) {
            prefix = this.plugin.settings.fileSearchPrefix;
        } else if (actionType === ActionType.Tags) {
            prefix = this.plugin.settings.tagSearchPrefix;
        } else if (actionType === ActionType.Hybrid) {
            prefix = this.hybridSearchPrefix;
        }

        const currentQuery: string = this.inputEl.value;

        // Check if we should preserve the query based on settings
        const shouldPreserveQuery = this.plugin.settings.enhancedSearch.preserveQuery
            || this.plugin.settings.semanticSearch.preserveQuery;

        if (shouldPreserveQuery) {
            // Only clean the current query to preserve the user's search
            const cleanQuery = this.currentAdapter.cleanQuery(currentQuery);
            this.inputEl.value = prefix + cleanQuery;
        } else {
            // Original behavior: clear query when switching modes
            this.inputEl.value = prefix;
        }

        this.updateSuggestions();
    }

    setQuery(
        newQuery: string,
        cursorPosition: number = -1,
    ) {
        this.inputEl.value = newQuery;

        if (cursorPosition > -1) {
            this.inputEl.setSelectionRange(cursorPosition, cursorPosition);
        }

        this.updateSuggestions();
    }

    private getPrefixActionType(text: string): ActionType | null {
        if (text.startsWith(this.hybridSearchPrefix)) return ActionType.Hybrid;
        if (text.startsWith(this.fileSearchPrefix)) return ActionType.Files;
        if (text.startsWith(this.tagSearchPrefix)) return ActionType.Tags;
        return null;
    }

    private getAdapterForActionType(type: ActionType): SuggestModalAdapter {
        switch (type) {
            case ActionType.Hybrid: return this.hybridAdapter;
            case ActionType.Files: return this.fileAdapter;
            case ActionType.Tags: return this.tagAdapter;
            default: return this.commandAdapter;
        }
    }

    private static getModeAttribute(type: ActionType): string {
        switch (type) {
            case ActionType.Hybrid: return 'hybrid';
            case ActionType.Files: return 'files';
            case ActionType.Tags: return 'tags';
            default: return 'commands';
        }
    }

    updateActionType(): boolean {
        const text: string = this.inputEl.value;
        const prefixType = this.getPrefixActionType(text);

        // Typing a prefix for another mode ends the initial (hotkey) mode default
        if (prefixType !== null && this.initialMode !== undefined && prefixType !== this.initialMode) {
            this.initialMode = undefined;
        }

        const type = prefixType ?? this.initialMode ?? ActionType.Commands;
        const nextAdapter = this.getAdapterForActionType(type);
        this.modalEl.setAttribute('palette-mode', BetterCommandPaletteModal.getModeAttribute(type));

        if (type !== this.actionType) {
            this.currentAdapter?.unmount();
            this.currentAdapter = nextAdapter;
            this.currentAdapter.mount();
        }

        if (!this.currentAdapter.initialized) {
            this.currentAdapter.initialize();
        }

        const wasUpdated = type !== this.actionType;
        this.actionType = type;

        if (wasUpdated) {
            this.updateEmptyStateText();
            this.updateModeLabel();
            this.updatePlaceholder();
            this.updateInstructions();
            this.refreshStatus();
            this.setCurrentSuggestions(this.currentAdapter
                .getSortedItems()
                .slice(0, this.getResultLimit()));
        }

        return wasUpdated;
    }

    updateModeLabel() {
        this.chrome.setModeLabel(this.currentAdapter.getModeLabel());
    }

    /** Mode-specific placeholder; the prefix is already in the input for other modes */
    updatePlaceholder() {
        this.setPlaceholder(BetterCommandPaletteModal.getPlaceholder(this.actionType));
    }

    private static getPlaceholder(type: ActionType): string {
        switch (type) {
            case ActionType.Hybrid: return 'Search for concepts, keywords, or topics…';
            case ActionType.Files: return 'Find a file…';
            case ActionType.Tags: return 'Find a tag…';
            default: return 'Select a command…';
        }
    }

    updateEmptyStateText() {
        this.emptyStateText = this.currentAdapter.getEmptyStateText();
    }

    updateInstructions() {
        Array.from(this.modalEl.getElementsByClassName('prompt-instructions'))
            .forEach((instruction) => {
                this.modalEl.removeChild(instruction);
            });

        this.setInstructions([
            ...this.currentAdapter.getInstructions(),
            { command: generateHotKeyText({ modifiers: [], key: 'ESC' }, this.plugin.settings), purpose: 'Close palette' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: 'I' }, this.plugin.settings), purpose: 'Toggle hidden items' },
        ]);
    }

    getItems(): Match[] {
        return this.currentAdapter.getSortedItems();
    }

    /**
     * Maximum number of results to show for the current mode.
     * Hybrid search has its own configurable result count.
     */
    private getResultLimit(): number {
        if (this.actionType === ActionType.Hybrid) {
            return this.plugin.settings.hybridSearch.maxResults || this.suggestionLimit;
        }
        return this.suggestionLimit;
    }

    private setCurrentSuggestions(matches: Match[]): void {
        this.currentSuggestions = matches;
        this.limit = matches.length;
    }

    receivedSuggestions(msg: MessageEvent) {
        const result = msg.data as SuggestionsWorkerResultMessage;

        if (!result || result.type !== 'result') {
            return;
        }

        const currentMode = this.currentAdapter.getWorkerMode();
        if (
            this.activeWorkerRequestId === 0
            || result.requestId !== this.activeWorkerRequestId
            || result.mode !== currentMode
        ) {
            return;
        }

        this.activeWorkerRequestId = 0;

        const hiddenIds = new Set(this.currentAdapter.hiddenIds);
        const results = [];
        let hiddenCount = 0;

        for (
            let i = 0;
            i < result.items.length && results.length < this.suggestionLimit + hiddenCount;
            i += 1
        ) {
            results.push(result.items[i]);

            if (hiddenIds.has(result.items[i].id)) {
                hiddenCount += 1;
            }
        }

        const matches = results.map((r: Match) => new PaletteMatch(r.id, r.text, r.tags));

        this.setCurrentSuggestions(matches);
        this.updateSuggestions();
    }

    /**
     * Run a fuzzy search for the current adapter in the suggestions worker.
     * Returns false if the current adapter has no worker corpus.
     */
    getSuggestionsAsync(query: string): boolean {
        const mode = this.currentAdapter.getWorkerMode();
        if (!mode) {
            return false;
        }

        this.ensureWorkerCorpusRegistered(mode);
        nextWorkerRequestId += 1;
        this.activeWorkerRequestId = nextWorkerRequestId;
        this.suggestionsWorker.postMessage({
            type: 'query',
            mode,
            query,
            requestId: this.activeWorkerRequestId,
            // Headroom for hidden items, which are counted but filtered out of the view
            limit: this.suggestionLimit + this.currentAdapter.hiddenIds.length,
        });
        return true;
    }

    private applySearchResults(matches: Match[], preserveSelection = false) {
        // Use the original matches directly to preserve custom properties (like hybridResult)
        const uniqueById = new Map<string, Match>();

        matches.forEach((match) => {
            if (match.id) {
                uniqueById.set(match.id, match);
            }
        });

        const deduped = Array.from(uniqueById.values());

        // For hybrid search, recency is already factored into the scoring algorithm
        // via usageTracker.getRecencyScore(), so we don't need to front-sort by prevItems

        this.setCurrentSuggestions(deduped.slice(0, this.getResultLimit()));
        this.renderSuggestions(preserveSelection);
    }

    /**
     * Redraw the list. When preserveSelection is set, keep the user's selected item
     * selected if it is still present (the chooser otherwise resets to the first row).
     */
    private renderSuggestions(preserveSelection: boolean): void {
        const chooser = this.chooser as SelectableChooser;
        const previousId = preserveSelection && (chooser.selectedItem ?? 0) > 0
            ? this.getSelectedMatch()?.id
            : undefined;

        this.updateSuggestions();

        if (!previousId || typeof chooser.setSelectedItem !== 'function') {
            return;
        }

        const index = chooser.values?.findIndex((match) => match.id === previousId) ?? -1;
        if (index > 0) {
            chooser.setSelectedItem(index, false);
        }
    }

    /**
     * Cancel any in-flight or scheduled search so its results are ignored.
     */
    private cancelPendingSearch(): void {
        this.searchSequence += 1;
        this.activeWorkerRequestId = 0;

        if (this.searchDebounceTimer !== null) {
            window.clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = null;
        }

        if (this.currentSearchAbortController) {
            this.currentSearchAbortController.abort();
            this.currentSearchAbortController = undefined;
        }
    }

    /**
     * Start a search for the (already cleaned) query using the best available engine.
     * Results are applied asynchronously; anything synchronous is written to
     * currentSuggestions for the caller to return.
     */
    private requestSuggestions(query: string, immediate: boolean): void {
        const adapter = this.currentAdapter;
        this.cancelPendingSearch();

        if (!adapter.usesEnhancedSearch()) {
            this.getSuggestionsAsync(query);
            return;
        }

        if (query === '') {
            // No query: show the adapter's default ordering (recent/pinned first)
            this.setCurrentSuggestions(adapter.getSortedItems().slice(0, this.getResultLimit()));
            return;
        }

        if (!adapter.canUseEnhancedSearch(query)) {
            // Index not ready, query too short or query syntax the index can't handle:
            // fall back to the fuzzy worker, or show the empty state if there is none
            if (!this.getSuggestionsAsync(query)) {
                this.setCurrentSuggestions([]);
            }
            return;
        }

        const sequence = this.searchSequence;
        const delay = immediate ? 0 : adapter.getSearchDebounceMs();
        // Always defer so results are never applied re-entrantly from getSuggestions
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = null;
            this.getEnhancedSearchResults(query, adapter, sequence);
        }, delay);
    }

    async getEnhancedSearchResults(
        query: string,
        adapter: SuggestModalAdapter = this.currentAdapter,
        sequence: number = this.searchSequence,
    ): Promise<void> {
        const isStale = () => sequence !== this.searchSequence || adapter !== this.currentAdapter;

        try {
            if (adapter.streamSearchResults) {
                const controller = new AbortController();
                this.currentSearchAbortController = controller;
                let hasRendered = false;

                await adapter.streamSearchResults(query, {
                    limit: this.getResultLimit(),
                    signal: controller.signal,
                    onUpdate: (matches, done) => {
                        if (controller.signal.aborted || isStale()) {
                            return;
                        }

                        // Redraw at most twice per query: an initial partial list and the final list
                        if (done || !hasRendered) {
                            this.applySearchResults(matches, hasRendered);
                            hasRendered = true;
                        }

                        if (done && this.currentSearchAbortController === controller) {
                            this.currentSearchAbortController = undefined;
                        }
                    },
                });

                return;
            }

            if (adapter.getSearchResults) {
                const results = await adapter.getSearchResults(query);

                if (isStale()) {
                    return;
                }

                this.applySearchResults(results);
                return;
            }

            // Fallback to worker-based search if no enhanced search is available
            this.getSuggestionsAsync(query);
        } catch (error) {
            if (isStale()) {
                return;
            }

            this.currentSearchAbortController = undefined;
            logger.error('Enhanced search failed:', error);
            // Fallback to worker-based search on error, or show the empty state
            if (!this.getSuggestionsAsync(query)) {
                this.applySearchResults([]);
            }
        }
    }

    /**
     * Force a fresh search for the current query (e.g. after ranking feedback).
     */
    refreshSuggestions(): void {
        this.forceNextSearch = true;
        this.updateSuggestions();
    }

    getSuggestions(query: string): Match[] {
        // Handle the case where getSuggestions is called before onOpen sets the initial input value.
        // This can happen when the base SuggestModal calls getSuggestions("") immediately upon opening.
        // Only applies during opening so the user can still clear the prefix afterwards.
        let effectiveQuery = query;
        if (
            !this.initialInputApplied
            && this.initialInputValue
            && query === ''
            && this.inputEl.value !== this.initialInputValue
        ) {
            effectiveQuery = this.initialInputValue;
            this.inputEl.value = this.initialInputValue;
        }

        // The action type might have changed
        const actionTypeChanged = this.updateActionType();

        // Initialize the adapter if it hasn't been initialized yet
        if (!this.currentAdapter.initialized) {
            this.currentAdapter.initialize();
        }

        const forced = this.forceNextSearch;
        const getNewSuggestions = effectiveQuery !== this.lastQuery
            || actionTypeChanged
            || forced;

        this.forceNextSearch = false;
        this.lastQuery = effectiveQuery;

        if (getNewSuggestions) {
            const fixedQuery = this.currentAdapter.cleanQuery(effectiveQuery.trim());

            // If the action type changed, don't show the previous adapter's results (or the
            // unfiltered list) for a non-empty query while the new search runs
            if (actionTypeChanged && fixedQuery !== '') {
                this.setCurrentSuggestions([]);
            }

            this.requestSuggestions(fixedQuery, actionTypeChanged || forced);
        }

        const hiddenIds = new Set(this.currentAdapter.hiddenIds);
        const visibleItems = this.currentSuggestions.filter(
            (match) => !hiddenIds.has(match.id),
        );

        const hiddenItemCount = this.currentSuggestions.length - visibleItems.length;

        this.updateHiddenItemsToggle(hiddenItemCount);

        return this.showHiddenItems ? this.currentSuggestions : visibleItems;
    }

    updateHiddenItemsToggle(hiddenItemCount: number) {
        const text = hiddenItemCount !== 0
            ? `${this.showHiddenItems ? 'Hide' : 'Show'} hidden items (${hiddenItemCount})`
            : '';
        this.chrome.setHiddenToggleText(text);
    }

    renderSuggestion(match: Match, el: HTMLElement) {
        const adapter = this.currentAdapter;
        const isHidden = adapter.hiddenIds.includes(match.id);
        const row = adapter.getSuggestionRow(match);

        renderSuggestionRow(el, {
            ...row,
            auxText: row.auxText ?? getRecentLabel(this.plugin.settings, match, adapter.getPrevItems()),
            flair: row.flair !== undefined ? row.flair : {
                icon: isHidden ? 'eye' : 'x',
                label: isHidden ? 'Unhide' : 'Hide',
                onClick: () => adapter.toggleHideId(match.id),
            },
            hidden: isHidden,
        });
    }

    async onChooseSuggestion(item: Match, event: MouseEvent | KeyboardEvent) {
        this.currentAdapter.onChooseSuggestion(item, event);
    }

    private ensureWorkerCorpusRegistered(mode: WorkerMode): void {
        const version = this.currentAdapter.getWorkerCorpusVersion();
        if (this.registeredWorkerCorpusVersions.get(mode) === version) {
            return;
        }

        this.suggestionsWorker.postMessage({
            type: 'register',
            mode,
            items: this.currentAdapter.getWorkerItems(),
        });
        this.registeredWorkerCorpusVersions.set(mode, version);
    }
}

export default BetterCommandPaletteModal;
