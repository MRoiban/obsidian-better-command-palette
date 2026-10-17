/**
 * Quick Link Modal - allows users to create links from selected text
 * User selects text, opens this modal, searches for a file, and creates [[file|selected-text]] link
 */

import {
    App, SuggestModal, setIcon, Notice, TFile, Editor, Keymap, Platform,
} from 'obsidian';
import BetterCommandPalettePlugin from '../main';
import { logger } from '../utils/logger';

interface QuickLinkMatch {
    id: string;
    text: string;
    file: TFile | null;
    isUnresolved: boolean;
}

/** SuggestModal internals that exist at runtime but are not in the public typings */
interface SuggestModalInternals {
    updateSuggestions(): void;
    chooser: {
        useSelectedItem(evt: KeyboardEvent): void;
    };
}

const SEARCH_DEBOUNCE_MS = 150;

const MAX_RESULTS = 50;

export class QuickLinkModal extends SuggestModal<QuickLinkMatch> {
    plugin: BetterCommandPalettePlugin;

    private selectedText: string;

    private sourceFile: TFile;

    private editor: Editor;

    private currentResults: QuickLinkMatch[] = [];

    private lastQuery = '';

    private allFiles: QuickLinkMatch[] = [];

    private isInitialLoad = true; // Track if this is the initial load or user has started typing

    private hasPerformedInitialSearch = false; // Track if we've done the initial search with selected text

    private initialSearchResults: QuickLinkMatch[] = []; // Store the initial search results based on selected text

    private ignoredSuggestionIds = new Set<string>();

    /** Incremented for every new user query so stale async results are dropped */
    private searchSequence = 0;

    private searchDebounceTimer: number | null = null;

    constructor(
        app: App,
        plugin: BetterCommandPalettePlugin,
        selectedText: string,
        sourceFile: TFile,
        editor: Editor,
    ) {
        super(app);
        this.plugin = plugin;
        this.selectedText = selectedText;
        this.sourceFile = sourceFile;
        this.editor = editor;

        // Add CSS class for styling
        this.modalEl.addClass('better-command-palette');
        this.modalEl.addClass('quick-link-modal');
        this.modalEl.setAttribute('palette-mode', 'quick-link');

        const searchEngine = plugin.settings.quickLink.searchEngine;
        this.modalEl.setAttribute('search-engine', searchEngine);

        this.setPlaceholder(`Showing results for "${this.truncateText(selectedText, 25)}" (or type to search)`);

        // Set instructions
        this.setInstructions([
            { command: '↑↓', purpose: 'Navigate' },
            { command: '↵', purpose: 'Create link' },
            { command: Platform.isMacOS ? '⌘↵' : 'Ctrl+↵', purpose: 'Create new file and link' },
            { command: 'esc', purpose: 'Cancel' },
        ]);

        // SuggestModal only handles plain Enter; route Mod+Enter through the chooser
        // so onChooseSuggestion receives the event and can create a new file
        this.scope.register(['Mod'], 'Enter', (evt: KeyboardEvent) => {
            (this as unknown as SuggestModalInternals).chooser.useSelectedItem(evt);
            return false;
        });

        // Initialize file list
        this.initializeFiles();
    }

    /**
     * Re-render the list from the current state (after async results arrive)
     */
    private refreshSuggestions(): void {
        (this as unknown as SuggestModalInternals).updateSuggestions();
    }

    /**
   * Initialize the list of all available files
   */
    private initializeFiles(): void {
        this.allFiles = [];

        try {
            const cachedFiles = this.app.vault.getFiles().map((file) => file.path);

            for (const filePath of cachedFiles) {
                if (!filePath || typeof filePath !== 'string') continue;

                // Skip files with excluded extensions
                const badFileType = this.plugin.settings.fileTypeExclusion.some(
                    (suf) => filePath.endsWith(`.${suf}`),
                );
                if (badFileType) continue;

                const file = this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    this.allFiles.push({
                        id: file.path,
                        text: file.basename,
                        file,
                        isUnresolved: false,
                    });
                }
            }

            // Add unresolved links from the current file
            const unresolvedLinks = this.app.metadataCache.unresolvedLinks[this.sourceFile.path];
            if (unresolvedLinks && typeof unresolvedLinks === 'object') {
                Object.keys(unresolvedLinks).forEach((linkText) => {
                    if (linkText && typeof linkText === 'string' && linkText.trim()) {
                        this.allFiles.push({
                            id: linkText,
                            text: linkText,
                            file: null,
                            isUnresolved: true,
                        });
                    }
                });
            }

            // Sort files: recently accessed first, then alphabetically
            const recentFiles = new Set(this.app.workspace.getLastOpenFiles());
            this.allFiles.sort((a, b) => {
                const aIsRecent = a.file && recentFiles.has(a.file.path);
                const bIsRecent = b.file && recentFiles.has(b.file.path);

                if (aIsRecent && !bIsRecent) return -1;
                if (!aIsRecent && bIsRecent) return 1;

                return a.text.localeCompare(b.text);
            });
        } catch (error) {
            logger.error('[QuickLink] Error initializing files:', error);
        }
    }

    getSuggestions(query: string): QuickLinkMatch[] {
        // Handle initial load: if no query and we haven't performed the initial search yet,
        // search using the selected text in the background
        if (this.isInitialLoad && (!query || query.length === 0) && !this.hasPerformedInitialSearch) {
            this.hasPerformedInitialSearch = true;
            // Perform background search using selected text
            this.performInitialSearch();
            // Return recent files immediately while search is happening
            return this.getRecentFiles();
        }

        // If user has started typing (query exists), switch to user search mode
        if (query && query.length > 0) {
            this.isInitialLoad = false;
        }

        // Handle empty query after initial load - show initial search results based on selected text
        if (!query || query.length === 0) {
            // Drop any pending user search; its results are no longer relevant
            this.cancelPendingSearch();
            this.lastQuery = '';
            // If we have initial search results, show those; otherwise show recent files
            return this.initialSearchResults.length > 0 ? this.initialSearchResults : this.getRecentFiles();
        }

        // Same query: return results (refreshed once the async search completes)
        if (query === this.lastQuery) {
            return this.currentResults;
        }

        // Debounced search with user's query; keep showing the previous results meanwhile
        this.scheduleSearch(query);
        return this.currentResults;
    }

    private cancelPendingSearch(): void {
        this.searchSequence += 1;

        if (this.searchDebounceTimer !== null) {
            window.clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = null;
        }
    }

    private scheduleSearch(query: string): void {
        this.cancelPendingSearch();
        this.lastQuery = query;

        const sequence = this.searchSequence;
        this.searchDebounceTimer = window.setTimeout(() => {
            this.searchDebounceTimer = null;
            this.performSearch(query, sequence);
        }, SEARCH_DEBOUNCE_MS);
    }

    /**
   * Perform initial search using the selected text as query
   */
    private async performInitialSearch(): Promise<void> {
        if (!this.selectedText || this.selectedText.trim().length === 0) {
            return;
        }

        // Use the selected text as the search query for the initial search
        const searchQuery = this.selectedText.trim();
        logger.debug('[QuickLink] Performing initial search with selected text:', searchQuery);

        this.initialSearchResults = await this.findMatches(searchQuery);

        // Only re-render if the initial results are what's on screen
        if (this.inputEl && this.inputEl.value === '') {
            this.refreshSuggestions();
        }
    }

    /**
     * Perform search through files using the configured search engine.
     * Results are dropped if a newer query was issued in the meantime.
     */
    private async performSearch(query: string, sequence: number): Promise<void> {
        const results = await this.findMatches(query);

        if (sequence !== this.searchSequence) {
            return;
        }

        this.currentResults = results;
        this.refreshSuggestions();
    }

    /**
     * Search with the configured engine, falling back to a simple name match
     * when the engine fails or finds nothing.
     */
    private async findMatches(query: string): Promise<QuickLinkMatch[]> {
        try {
            const results = await this.performEngineSearch(query, MAX_RESULTS);

            if (results.length > 0) {
                return this.filterIgnoredResults(results
                    .filter((result) => result.path !== this.sourceFile.path)
                    .map((result) => {
                        const file = this.app.vault.getAbstractFileByPath(result.path);
                        return {
                            id: result.path,
                            text: file instanceof TFile ? file.basename : result.path,
                            file: file instanceof TFile ? file : null,
                            isUnresolved: false,
                        };
                    }));
            }
        } catch (error) {
            logger.warn('[QuickLink] Engine search failed, falling back to fuzzy search:', error);
        }

        // Fallback to name matching
        const lowerQuery = query.toLowerCase();
        return this.filterIgnoredResults(this.allFiles
            .filter((item) => {
                if (item.file?.path === this.sourceFile.path) return false;
                return item.text.toLowerCase().includes(lowerQuery);
            })
            .slice(0, MAX_RESULTS));
    }

    /**
     * Perform search using the configured search engine
     * Returns normalized results with path property
     */
    private async performEngineSearch(query: string, limit: number): Promise<{ path: string; score?: number }[]> {
        const searchEngine = this.plugin.settings.quickLink.searchEngine;

        logger.debug(`[QuickLink] Using search engine: ${searchEngine}`);

        if (searchEngine === 'semantic') {
            const semanticEngine = this.plugin.getSemanticSearchEngine();
            if (semanticEngine) {
                const results = await semanticEngine.search(query);
                return results.slice(0, limit).map((r) => ({
                    path: r.file.path,
                    score: r.similarity,
                }));
            }
            logger.warn('[QuickLink] Semantic engine not available, falling back to enhanced');
        }

        if (searchEngine === 'hybrid') {
            if (this.plugin.hybridSearchService?.isReady()) {
                const results = await this.plugin.hybridSearchService.search(query, { limit });
                return results.map((r) => ({
                    path: r.path,
                    score: r.finalScore,
                }));
            }
            logger.warn('[QuickLink] Hybrid engine not ready, falling back to enhanced');
        }

        if (this.plugin.searchService) {
            const results = await this.plugin.searchService.search(query, limit);
            return results.map((r) => ({
                path: r.metadata.path,
                score: r.score,
            }));
        }

        return [];
    }

    /**
   * Get recently accessed files as default suggestions
   */
    private getRecentFiles(): QuickLinkMatch[] {
        const recentPaths = this.app.workspace.getLastOpenFiles().slice(0, 10);
        const suggestions: QuickLinkMatch[] = [];

        for (const path of recentPaths) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile && path !== this.sourceFile.path) {
                const suggestion = {
                    id: file.path,
                    text: file.basename,
                    file,
                    isUnresolved: false,
                };

                if (!this.isIgnored(suggestion)) {
                    suggestions.push(suggestion);
                }
            }
        }

        return suggestions;
    }

    renderSuggestion(match: QuickLinkMatch, el: HTMLElement): void {
        el.addClass('mod-complex');

        const suggestionContent = el.createEl('span', 'suggestion-content');
        const suggestionAux = el.createEl('span', 'suggestion-aux');
        const flairContainer = suggestionAux.createEl('span', 'suggestion-flair');

        setIcon(flairContainer, 'cross');
        flairContainer.ariaLabel = 'Ignore suggestion';
        flairContainer.onClickEvent((event) => {
            event.preventDefault();
            event.stopPropagation();
            this.ignoreSuggestion(match);
        });

        this.renderFileSearchStyle(match, suggestionContent);
    }

    /**
   * Render suggestion using the same style as file search modal
   */
    private renderFileSearchStyle(match: QuickLinkMatch, el: HTMLElement): void {
        let noteName = match.text;

        // Build the displayed note name without its full path if required in settings
        if (this.plugin.settings.displayOnlyNotesNames) {
            noteName = match.text.split('/').pop() || match.text;
        }

        // Build the displayed note name without its Markdown extension if required in settings
        if (this.plugin.settings.hideMdExtension && noteName.endsWith('.md')) {
            noteName = noteName.slice(0, -3);
        }

        // Create main title container
        const suggestionEl = el.createEl('div', {
            cls: 'suggestion-title',
        });

        // Add recently accessed indicator if applicable
        if (match.file && this.isRecentlyAccessed(match)) {
            suggestionEl.createEl('div', { cls: 'recent-indicator' });
        }

        // Smart path rendering - show folder structure more intelligently
        if (!this.plugin.settings.displayOnlyNotesNames && match.file && match.file.path.includes('/')) {
            this.renderSmartPath(suggestionEl, match.file.path, noteName);
        } else {
            suggestionEl.createEl('span', {
                cls: 'path-part filename',
                text: noteName,
            });
        }

        // Add unresolved styling if this is an unresolved link
        if (match.isUnresolved) {
            suggestionEl.addClass('unresolved');
        }

        // Handle aliases (if we ever need them)
        if (match.id.includes(':')) {
            suggestionEl.createEl('span', {
                cls: 'suggestion-name',
                text: match.text,
            }).ariaLabel = 'Alias';

            setIcon(suggestionEl, 'right-arrow-with-tail');

            const [, path] = match.id.split(':');
            suggestionEl.createEl('span', {
                cls: 'suggestion-note',
                text: path,
            });
        }

    }

    /**
   * Render smart path showing folder structure
   */
    private renderSmartPath(container: HTMLElement, fullPath: string, displayName: string): void {
        if (!fullPath.includes('/')) {
            container.createEl('span', {
                cls: 'path-part filename',
                text: displayName,
            });
            return;
        }

        const pathParts = fullPath.split('/');
        const fileName = pathParts.pop() || displayName;

        // Show folder structure
        if (pathParts.length > 0) {
            const folderPath = pathParts.join('/');
            container.createEl('span', {
                cls: 'path-part folder',
                text: `${folderPath}/`,
            });
        }

        // Show filename
        container.createEl('span', {
            cls: 'path-part filename',
            text: this.plugin.settings.hideMdExtension && fileName.endsWith('.md')
                ? fileName.slice(0, -3)
                : fileName,
        });
    }

    /**
   * Check if file was recently accessed
   */
    private isRecentlyAccessed(match: QuickLinkMatch): boolean {
        if (!match.file) return false;
        const recentFiles = this.app.workspace.getLastOpenFiles();
        return recentFiles.includes(match.file.path);
    }

    private isIgnored(match: QuickLinkMatch): boolean {
        return this.ignoredSuggestionIds.has(match.id);
    }

    private filterIgnoredResults(results: QuickLinkMatch[]): QuickLinkMatch[] {
        return results.filter((result) => !this.isIgnored(result));
    }

    private ignoreSuggestion(match: QuickLinkMatch): void {
        this.ignoredSuggestionIds.add(match.id);

        this.allFiles = this.filterIgnoredResults(this.allFiles);
        this.initialSearchResults = this.filterIgnoredResults(this.initialSearchResults);
        this.currentResults = this.filterIgnoredResults(this.currentResults);
        this.refreshSuggestions();
    }

    /**
   * Handle suggestion selection - create the link
   */
    onChooseSuggestion(match: QuickLinkMatch | null, evt: MouseEvent | KeyboardEvent): void {
        if (!match) return;

        // Ctrl on Windows/Linux, Cmd on macOS
        const shouldCreateNewFile = !!evt && !!Keymap.isModEvent(evt);

        if (shouldCreateNewFile && match.isUnresolved) {
            this.createNewFileAndLink(match.text);
        } else {
            this.createLink(match);
        }
    }

    /**
   * Create a link to an existing file
   */
    private createLink(match: QuickLinkMatch): void {
        try {
            let linkText: string;

            if (match.file) {
                // Use Obsidian's built-in link generation for proper relative paths
                linkText = this.app.fileManager.generateMarkdownLink(
                    match.file,
                    this.sourceFile.path,
                    '#',
                    this.selectedText,
                );
            } else {
                // Unresolved link
                linkText = `[[${match.text}|${this.selectedText}]]`;
            }

            // Replace the selected text with the link
            this.editor.replaceSelection(linkText);

            new Notice(`Created link: ${linkText}`, 3000);
            logger.info('[QuickLink] Created link:', linkText);

            // Auto-close modal if setting is enabled
            if (this.plugin.settings.quickLink.autoCloseModal) {
                this.close();
            }
        } catch (error) {
            logger.error('[QuickLink] Error creating link:', error);
            new Notice('Failed to create link');
        }
    }

    /**
   * Create a new file and link to it
   */
    private async createNewFileAndLink(fileName: string): Promise<void> {
        try {
            // Ensure .md extension
            if (!fileName.endsWith('.md')) {
                fileName += '.md';
            }

            // Create the new file
            const newFile = await this.app.vault.create(fileName, '');

            // Create link to the new file
            const linkText = this.app.fileManager.generateMarkdownLink(
                newFile,
                this.sourceFile.path,
                '#',
                this.selectedText,
            );

            // Replace the selected text with the link
            this.editor.replaceSelection(linkText);

            new Notice(`Created new file and link: ${linkText}`, 3000);
            logger.info('[QuickLink] Created new file and link:', linkText);

            // Auto-close modal if setting is enabled
            if (this.plugin.settings.quickLink.autoCloseModal) {
                this.close();
            }
        } catch (error) {
            logger.error('[QuickLink] Error creating new file and link:', error);
            new Notice('Failed to create new file and link');
        }
    }

    /**
   * Truncate text for display
   */
    private truncateText(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return `${text.substring(0, maxLength)}...`;
    }

    onOpen(): void {
        super.onOpen();
        logger.debug('[QuickLink] Modal opened for selected text:', this.selectedText);
    }

    onClose(): void {
        this.cancelPendingSearch();
        super.onClose();
        logger.debug('[QuickLink] Modal closed');
    }
}
