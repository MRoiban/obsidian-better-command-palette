import { App, setIcon, SuggestModal } from 'obsidian';
import {
    generateHotKeyText,
    OrderedSet, PaletteMatch, renderPrevItems, SuggestModalAdapter,
} from 'src/utils';
import { Match, UnsafeSuggestModalInterface } from 'src/types/types';
import {
    BetterCommandPaletteCommandAdapter,
    BetterCommandPaletteFileAdapter,
    BetterCommandPaletteTagAdapter,
} from 'src/palette-modal-adapters';
import EnhancedFileAdapter from 'src/palette-modal-adapters/enhanced-file-adapter';
import BetterCommandPalettePlugin from 'src/main';
import { EnhancedSearchService } from 'src/search/enhanced-search-service';
import { ActionType } from './utils/constants';
import { logger } from './utils/logger';

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

    modalTitleEl!: HTMLElement;

    hiddenItemsHeaderEl!: HTMLElement;

    showHiddenItems!: boolean;

    initialInputValue!: string;

    commandAdapter!: BetterCommandPaletteCommandAdapter;

    fileAdapter!: BetterCommandPaletteFileAdapter | EnhancedFileAdapter;

    tagAdapter!: BetterCommandPaletteTagAdapter;

    currentAdapter!: SuggestModalAdapter;

    suggestionLimit!: number;

    constructor (
        app: App,
        prevCommands: OrderedSet<Match>,
        prevTags: OrderedSet<Match>,
        plugin: BetterCommandPalettePlugin,
        suggestionsWorker: Worker,
        searchService: EnhancedSearchService,
        initialInputValue = '',
    ) {
        super(app);

        // General instance variables
        this.fileSearchPrefix = plugin.settings.fileSearchPrefix;
        this.tagSearchPrefix = plugin.settings.tagSearchPrefix;
        this.suggestionLimit = plugin.settings.suggestionLimit;
        this.initialInputValue = initialInputValue;

        this.plugin = plugin;

        this.modalEl.addClass('better-command-palette');

        // The only time the input will be empty will be when we are searching commands
        this.setPlaceholder('Select a command');

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
        );
        
        this.tagAdapter = new BetterCommandPaletteTagAdapter(
            app,
            prevTags,
            plugin,
            this,
        );

        // Lets us do the suggestion fuzzy search in a different thread
        this.suggestionsWorker = suggestionsWorker;
        this.suggestionsWorker.onmessage = (msg: MessageEvent) => this.receivedSuggestions(msg);

        // Add our custom title element
        this.modalTitleEl = createEl('p', {
            cls: 'better-command-palette-title',
        });

        // If we have an initial input value, we need to set it early so action type detection works
        if (this.initialInputValue) {
            this.inputEl.value = this.initialInputValue;
        }

        // Update our action type before adding in our title element so the text is correct
        this.updateActionType();

        // Add in the title element
        this.modalEl.insertBefore(this.modalTitleEl, this.modalEl.firstChild);

        this.hiddenItemsHeaderEl = createEl('p', 'hidden-items-header');
        this.showHiddenItems = false;

        this.hiddenItemsHeaderEl.onClickEvent(this.toggleHiddenItems);

        this.modalEl.insertBefore(this.hiddenItemsHeaderEl, this.resultContainerEl);

        // Set our scopes for the modal
        this.setScopes(plugin);
    }

    close (evt?: KeyboardEvent) {
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
    }

    setScopes (plugin: BetterCommandPalettePlugin) {
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
            if (this.actionType === ActionType.Files && this.currentSuggestions.length) {
                const promptResults = document.querySelector(".better-command-palette .prompt-results");
                const selected = document.querySelector(".better-command-palette .is-selected");
                
                // Add null checks to prevent runtime errors
                if (promptResults && selected) {
                    const selectedIndex = Array.from(promptResults.children).indexOf(selected);
                    if (selectedIndex >= 0 && selectedIndex < this.currentSuggestions.length) {
                        const selectedMatch = this.currentSuggestions[selectedIndex] || null;
                        this.currentAdapter.onChooseSuggestion(selectedMatch, event);
                        this.close(event);
                    }
                }
            }
        });

        this.scope.register(['Mod'], 'I', this.toggleHiddenItems);
    }

    toggleHiddenItems = () => {
        this.showHiddenItems = !this.showHiddenItems;
        this.updateSuggestions();
    };

    onOpen () {
        super.onOpen();

        // Add the initial value to the input
        // TODO: Figure out if there is a way to bypass the first seach
        // result flickering before this is set
        // As far as I can tell onOpen resets the value of the input so this is the first place
        if (this.initialInputValue) {
            // Check if we should restore the last query for file search
            if (this.plugin.settings.enhancedSearch.preserveQuery && 
                this.initialInputValue === this.plugin.settings.fileSearchPrefix && 
                this.plugin.lastFileQuery) {
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
    }

    changeActionType (actionType: ActionType) {
        let prefix = '';
        if (actionType === ActionType.Files) {
            prefix = this.plugin.settings.fileSearchPrefix;
        } else if (actionType === ActionType.Tags) {
            prefix = this.plugin.settings.tagSearchPrefix;
        }
        
        const currentQuery: string = this.inputEl.value;
        
        // Check if we should preserve the query based on settings
        const shouldPreserveQuery = this.plugin.settings.enhancedSearch.preserveQuery || 
                                   this.plugin.settings.semanticSearch.preserveQuery;
        
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

    setQuery (
        newQuery: string,
        cursorPosition: number = -1,
    ) {
        this.inputEl.value = newQuery;

        if (cursorPosition > -1) {
            this.inputEl.setSelectionRange(cursorPosition, cursorPosition);
        }

        this.updateSuggestions();
    }

    updateActionType (): boolean {
        const text: string = this.inputEl.value;
        let nextAdapter;
        let type;

        if (text.startsWith(this.fileSearchPrefix)) {
            type = ActionType.Files;
            nextAdapter = this.fileAdapter;
            this.modalEl.setAttribute("palette-mode", "files");
        } else if (text.startsWith(this.tagSearchPrefix)) {
            type = ActionType.Tags;
            nextAdapter = this.tagAdapter;
            this.modalEl.setAttribute("palette-mode", "tags");
        } else {
            type = ActionType.Commands;
            nextAdapter = this.commandAdapter;
            this.modalEl.setAttribute("palette-mode", "commands");
        }

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
            this.updateTitleText();
            this.updateInstructions();
            this.currentSuggestions = this.currentAdapter
                .getSortedItems()
                .slice(0, this.suggestionLimit);
        }

        return wasUpdated;
    }

    updateTitleText () {
        if (this.plugin.settings.showPluginName) {
            this.modalTitleEl.setText(this.currentAdapter.getTitleText());
        } else {
            this.modalTitleEl.setText('');
        }
    }

    updateEmptyStateText () {
        this.emptyStateText = this.currentAdapter.getEmptyStateText();
    }

    updateInstructions () {
        Array.from(this.modalEl.getElementsByClassName('prompt-instructions'))
            .forEach((instruction) => {
                this.modalEl.removeChild(instruction);
            });

        this.setInstructions([
            ...this.currentAdapter.getInstructions(),
            { command: generateHotKeyText({ modifiers: [], key: 'ESC' }, this.plugin.settings), purpose: 'Close palette' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: 'I' }, this.plugin.settings), purpose: 'Toggle Hidden Items' },
        ]);
    }

    getItems (): Match[] {
        return this.currentAdapter.getSortedItems();
    }

    receivedSuggestions (msg: MessageEvent) {
        const results = [];
        let hiddenCount = 0;

        for (
            let i = 0;
            i < msg.data.length && results.length < this.suggestionLimit + hiddenCount;
            i += 1
        ) {
            results.push(msg.data[i]);

            if (this.currentAdapter.hiddenIds.includes(msg.data[i].id)) {
                hiddenCount += 1;
            }
        }

        const matches = results.map((r: Match) => new PaletteMatch(r.id, r.text, r.tags));

        // Sort the suggestions so that previously searched items are first
        const prevItems = this.currentAdapter.getPrevItems();
        matches.sort((a, b) => (+prevItems.has(b)) - (+prevItems.has(a)));

        this.currentSuggestions = matches;
        this.limit = this.currentSuggestions.length;
        this.updateSuggestions();
    }

    getSuggestionsAsync (query: string) {
        const items = this.getItems();
        this.suggestionsWorker.postMessage({
            query,
            items,
        });
   }

    async getEnhancedSearchResults(query: string) {
        try {
            if (this.currentAdapter.getSearchResults) {
                const results = await this.currentAdapter.getSearchResults(query);
                
                // Convert to the format expected by the UI
                const matches = results.map((r: Match) => new PaletteMatch(r.id, r.text, r.tags));
                
                // Sort the suggestions so that previously searched items are first
                const prevItems = this.currentAdapter.getPrevItems();
                matches.sort((a, b) => (+prevItems.has(b)) - (+prevItems.has(a)));
                
                this.currentSuggestions = matches.slice(0, this.suggestionLimit);
                this.limit = this.currentSuggestions.length;
                
                // Don't call updateSuggestions() here to avoid infinite loop
                // The UI will be updated when getSuggestions() returns the new currentSuggestions
            } else {
                // Fallback to worker-based search if getSearchResults is not available
                this.getSuggestionsAsync(query);
            }
        } catch (error) {
            logger.error('Enhanced search failed:', error);
            // Fallback to worker-based search on error
            this.getSuggestionsAsync(query);
        }
    }

    getSuggestions (query: string): Match[] {
        // Handle the case where getSuggestions is called before onOpen sets the initial input value
        // This can happen when the base SuggestModal calls getSuggestions("") immediately upon opening
        let effectiveQuery = query;
        if (this.initialInputValue && query === "" && this.inputEl.value !== this.initialInputValue) {
            // Use the initial input value if the query is empty and input hasn't been set yet
            effectiveQuery = this.initialInputValue;
            this.inputEl.value = this.initialInputValue;
        }

        // The action type might have changed
        const actionTypeChanged = this.updateActionType();

        // Initialize the adapter if it hasn't been initialized yet
        if (!this.currentAdapter.initialized) {
            this.currentAdapter.initialize();
        }
        
        const getNewSuggestions = effectiveQuery !== this.lastQuery || this.currentSuggestions.length === 0 || actionTypeChanged;
        this.lastQuery = effectiveQuery;
        const fixedQuery = this.currentAdapter.cleanQuery(effectiveQuery.trim());

        if (getNewSuggestions) {
            // If the action type changed, clear current suggestions to avoid showing wrong adapter's results
            if (actionTypeChanged) {
                this.currentSuggestions = [];
            }
            
            // Check if the adapter supports enhanced search
            if (this.currentAdapter.usesEnhancedSearch && this.currentAdapter.usesEnhancedSearch()) {
                // Use enhanced search directly
                this.getEnhancedSearchResults(fixedQuery);
                
                // If we don't have suggestions yet and this is an empty/initial query, 
                // return some initial suggestions from the adapter
                if (this.currentSuggestions.length === 0) {
                    this.currentSuggestions = this.currentAdapter
                        .getSortedItems()
                        .slice(0, this.suggestionLimit);
                }
            } else {
                // Use worker-based search for other adapters
                this.getSuggestionsAsync(fixedQuery);
            }
        }

        const visibleItems = this.currentSuggestions.filter(
            (match) => !this.currentAdapter.hiddenIds.includes(match.id),
        );

        const hiddenItemCount = this.currentSuggestions.length - visibleItems.length;

        this.updateHiddenItemCountHeader(hiddenItemCount);

        return this.showHiddenItems ? this.currentSuggestions : visibleItems;
    }

    updateHiddenItemCountHeader (hiddenItemCount: number) {
        this.hiddenItemsHeaderEl.empty();

        if (hiddenItemCount !== 0) {
            const text = `${this.showHiddenItems ? 'Hide' : 'Show'} hidden items (${hiddenItemCount})`;
            this.hiddenItemsHeaderEl.setText(text);
        }
    }

    renderSuggestion (match: Match, el: HTMLElement) {
        el.addClass('mod-complex');

        const isHidden = this.currentAdapter.hiddenIds.includes(match.id);

        if (isHidden) {
            el.addClass('hidden');
        }

        const icon = 'cross';

        const suggestionContent = el.createEl('span', 'suggestion-content');
        const suggestionAux = el.createEl('span', 'suggestion-aux');

        const flairContainer = suggestionAux.createEl('span', 'suggestion-flair');
        renderPrevItems(this.plugin.settings, match, suggestionContent, this.currentAdapter.getPrevItems());

        setIcon(flairContainer, icon, 13);
        flairContainer.ariaLabel = isHidden ? 'Click to Unhide' : 'Click to Hide';
        flairContainer.setAttr('data-id', match.id);

        flairContainer.onClickEvent((event) => {
            event.preventDefault();
            event.stopPropagation();

            const hideEl = event.target as HTMLElement;
            const dataId = hideEl.getAttr('data-id');
            
            if (dataId) {
                this.currentAdapter.toggleHideId(dataId);
            }
        });

        this.currentAdapter.renderSuggestion(match, suggestionContent, suggestionAux);
    }

    async onChooseSuggestion (item: Match, event: MouseEvent | KeyboardEvent) {
        this.currentAdapter.onChooseSuggestion(item, event);
    }

    private async performEnhancedSearch(query: string): Promise<void> {
        try {
            if (!this.enhancedSearchService) {
                return;
            }

            const results = await this.enhancedSearchService.search(query, this.currentLimit);
            
            // Convert enhanced results to suggestion format
            const enhancedSuggestions = results.map(result => ({
                text: result.metadata.path,
                score: result.relevanceScore,
                metadata: result.metadata
            }));

            // Merge with existing suggestions
            this.currentSuggestions = [...this.currentSuggestions, ...enhancedSuggestions];
            
            // Remove duplicates and sort by score
            const uniqueSuggestions = this.currentSuggestions.filter((suggestion, index, self) => 
                index === self.findIndex(s => s.text === suggestion.text)
            );
            
            this.currentSuggestions = uniqueSuggestions
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .slice(0, this.currentLimit);

        } catch (error) {
            logger.error('Enhanced search failed:', error);
        }
    }
}

export default BetterCommandPaletteModal;
