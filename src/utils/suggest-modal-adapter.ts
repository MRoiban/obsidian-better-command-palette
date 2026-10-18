import { App, Instruction, KeymapEventHandler } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import BetterCommandPaletteModal from 'src/palette';
import { Match, WorkerMode } from 'src/types/types';
import OrderedSet from 'src/utils/ordered-set';
import type { SuggestionRowOptions } from 'src/ui/suggestion-row';
import type { PromptStatus } from 'src/ui/prompt-chrome';

/**
 * A class that can be used by the palette modal to abstact away item specific logic between:
 * Commands, Files, and Tags
 */
export default abstract class SuggestModalAdapter {
    app: App;

    plugin: BetterCommandPalettePlugin;

    palette: BetterCommandPaletteModal;

    prevItems: OrderedSet<Match>;

    recentAbovePinned: boolean;

    pinnedItems: Match[];

    initialized: boolean;

    allItems: Match[];

    hiddenIds: string[];

    hiddenIdsSettingsKey: 'hiddenCommands' | 'hiddenFiles' | 'hiddenTags';

    keymapHandlers: KeymapEventHandler[];

    private sortedItemsCache: Match[];

    private workerCorpusVersion: number;

    /** Faint label shown in the input row (Commands, Files, Tags, Hybrid) */
    abstract modeLabel: string;

    abstract emptyStateText: string;

    /**
     * Describe how a match renders. The palette adds the shared parts (recent label
     * when auxText is unset, hide/unhide flair when flair is undefined, hidden state)
     * and draws it with the shared row renderer.
     */
    abstract getSuggestionRow(match: Match): SuggestionRowOptions;
    abstract onChooseSuggestion(match: Match | null, event: MouseEvent | KeyboardEvent): void;

    /**
     * Method to indicate if this adapter uses enhanced search
     * Returns false by default, can be overridden by adapters that support enhanced search
     */
    usesEnhancedSearch(): boolean {
        return false;
    }

    /**
     * Whether enhanced search can serve this non-empty, cleaned query right now.
     * When false, the palette falls back to the fuzzy suggestions worker (if the
     * adapter has a worker mode) or shows the empty state.
     */
    canUseEnhancedSearch(_query: string): boolean {
        return this.usesEnhancedSearch();
    }

    /**
     * Debounce applied by the palette before running an enhanced search for a new query.
     */
    getSearchDebounceMs(): number {
        return 0;
    }

    /**
     * Optional method for adapters that support enhanced search
     * Should return search results using the adapter's enhanced search capabilities
     */
    getSearchResults?(query: string): Promise<Match[]>;

    /**
     * Optional streaming search hook. Implementers may emit an initial best-so-far
     * list and must call onUpdate with done=true when complete. The palette redraws at
     * most twice per query (first update and final update). Throwing makes the palette
     * fall back to the fuzzy suggestions worker.
     */
    streamSearchResults?(
        query: string,
        options: {
            limit: number;
            signal?: AbortSignal;
            onUpdate: (matches: Match[], done: boolean) => void;
        },
    ): Promise<void> | void;

    constructor(
        app: App,
        prevItems: OrderedSet<Match>,
        plugin: BetterCommandPalettePlugin,
        palette: BetterCommandPaletteModal,
    ) {
        this.app = app;
        this.prevItems = prevItems;
        this.recentAbovePinned = plugin.settings.recentAbovePinned;
        this.plugin = plugin;
        this.palette = palette;
        this.allItems = [];
        this.pinnedItems = [];
        this.initialized = false;
        this.hiddenIds = [];
        this.keymapHandlers = [];
        this.sortedItemsCache = [];
        this.workerCorpusVersion = 0;
    }

    getModeLabel(): string {
        return this.modeLabel;
    }

    /**
     * Status line shown above the results (indexing, model loading, reranking).
     * Null by default.
     */
    getStatus(): PromptStatus | null {
        return null;
    }

    getEmptyStateText(): string {
        return this.emptyStateText;
    }

    getInstructions(): Instruction[] {
        return [];
    }

    checkInitialized() {
        if (!this.initialized) {
            throw new Error('This adapter has not been initialized');
        }
    }

    initialize() {
        this.initialized = true;
    }

    mount() {}

    unmount() {
        this.keymapHandlers.forEach((kh) => this.palette.scope.unregister(kh));
        this.keymapHandlers = [];
    }

    cleanQuery(query: string) {
        return query;
    }

    getWorkerMode(): WorkerMode | null {
        return null;
    }

    getWorkerCorpusVersion(): number {
        return this.workerCorpusVersion;
    }

    getWorkerItems(): Match[] {
        return this.getSortedItems();
    }

    getPinnedItems(): Match[] {
        this.checkInitialized();
        return this.pinnedItems;
    }

    getItems(): Match[] {
        this.checkInitialized();
        return this.allItems;
    }

    getPrevItems(): OrderedSet<Match> {
        return this.prevItems;
    }

    getSortedItems(): Match[] {
        this.checkInitialized();
        return this.sortedItemsCache;
    }

    protected setItems(items: Match[]): void {
        this.allItems = items;
        this.rebuildSortedItems();
    }

    protected setPinnedItems(items: Match[]): void {
        this.pinnedItems = items;
        this.rebuildSortedItems();
    }

    protected recordRecentMatch(match: Match): void {
        this.prevItems.add(match);
        this.rebuildSortedItems();
    }

    protected rebuildSortedItems(): void {
        const allItems = new OrderedSet(this.getItems());

        const firstItems = this.recentAbovePinned
            ? this.getPrevItems().values() : this.getPinnedItems();
        const secondItems = !this.recentAbovePinned
            ? this.getPrevItems().values() : this.getPinnedItems();

        [secondItems, firstItems].forEach((itemsToAdd) => {
            itemsToAdd.forEach((item) => {
                if (allItems.has(item)) {
                    allItems.add(item);
                }
            });
        });

        this.sortedItemsCache = allItems.valuesByLastAdd();
        this.workerCorpusVersion += 1;
    }

    toggleHideId(id: string) {
        if (this.hiddenIds.includes(id)) {
            this.hiddenIds = this.hiddenIds.filter((idToCheck) => id !== idToCheck);
        } else {
            this.hiddenIds.push(id);
        }

        this.plugin.settings[this.hiddenIdsSettingsKey] = [...this.hiddenIds];
        this.palette.updateSuggestions();
        this.plugin.scheduleLightweightSettingsSave();
    }
}
