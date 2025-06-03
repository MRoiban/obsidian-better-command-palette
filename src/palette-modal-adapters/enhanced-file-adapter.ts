import {
    Instruction, Notice, setIcon, TFile,
} from 'obsidian';
import {
    generateHotKeyText,
    getOrCreateFile,
    openFileWithEventKeys,
    PaletteMatch, SuggestModalAdapter,
} from '../utils';
import { Match, UnsafeAppInterface } from '../types/types';
import { ActionType } from '../utils/constants';
import { EnhancedSearchService } from '../search/enhanced-search-service';
import { SearchResultItem } from '../ui/search-result-item';

/**
 * Enhanced file adapter that uses the new search system
 */
export default class EnhancedFileAdapter extends SuggestModalAdapter {
    titleText: string;
    emptyStateText: string;
    app: UnsafeAppInterface;
    allItems: Match[];
    fileSearchPrefix: string;
    private searchService?: EnhancedSearchService;

    constructor(app: any, prevItems: any, plugin: any, palette: any, searchService?: EnhancedSearchService) {
        super(app, prevItems, plugin, palette);
        this.searchService = searchService;
    }

    initialize(): void {
        super.initialize();

        this.titleText = 'Better Command Palette: Files (Enhanced)';
        this.emptyStateText = 'No matching files.';
        this.fileSearchPrefix = this.plugin.settings.fileSearchPrefix;

        this.hiddenIds = this.plugin.settings.hiddenFiles;
        this.hiddenIdsSettingsKey = 'hiddenFiles';

        // Initialize with all files (fallback for when search service isn't available)
        this.allItems = [];
        this.loadAllFiles();
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
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.commandSearchHotkey }, this.plugin.settings), purpose: 'Search Commands' },
            { command: generateHotKeyText({ modifiers: ['Mod'], key: this.plugin.settings.tagSearchHotkey }, this.plugin.settings), purpose: 'Search Tags' },
        ];
    }

    cleanQuery(query: string): string {
        return query.replace(this.fileSearchPrefix, '');
    }

    /**
     * Override to use enhanced search when available
     */
    async getSearchResults(query: string): Promise<Match[]> {
        if (!this.searchService) {
            // Fallback to original behavior
            return this.getSortedItems().filter(item => 
                item.text.toLowerCase().includes(query.toLowerCase())
            );
        }

        try {
            const cleanQuery = this.cleanQuery(query);
            if (!cleanQuery.trim()) {
                return this.getSortedItems();
            }

            const enhancedResults = await this.searchService.search(cleanQuery, this.plugin.settings.suggestionLimit);
            
            // Convert enhanced results back to Match format
            return enhancedResults.map(result => new PaletteMatch(
                result.id,
                result.metadata.path,
                [] // Tags handled differently in enhanced results
            ));
        } catch (error) {
            console.error('Enhanced search failed, falling back to basic search:', error);
            return this.getSortedItems().filter(item => 
                item.text.toLowerCase().includes(query.toLowerCase())
            );
        }
    }

    renderSuggestion(match: Match, content: HTMLElement, aux?: HTMLElement): void {
        if (this.searchService && aux) {
            // For basic Match objects, create a minimal enhanced result
            const enhancedResult = {
                id: match.id,
                score: 1.0,
                matches: {},
                metadata: {
                    path: match.text,
                    title: match.text.split('/').pop()?.replace('.md', '') || match.text,
                    lastModified: Date.now()
                },
                combinedScore: 1.0,
                contentScore: 1.0,
                usageScore: 0,
                recencyScore: 0
            };

            // Use enhanced rendering with search result item
            const searchResultItem = new SearchResultItem(
                enhancedResult,
                (result, event) => {
                    // Handle selection
                    this.onChooseSuggestion(match, event as MouseEvent | KeyboardEvent);
                }
            );
            
            searchResultItem.render(content);
        } else {
            // Fallback to original rendering
            this.renderOriginalSuggestion(match, content);
        }
    }

    private renderOriginalSuggestion(match: Match, content: HTMLElement): void {
        let noteName = match.text;

        // Build the displayed note name without its full path if required in settings
        if (this.plugin.settings.displayOnlyNotesNames) {
            noteName = match.text.split("/").pop() || match.text;
        }

        // Build the displayed note name without its Markdown extension if required in settings
        if (this.plugin.settings.hideMdExtension && noteName.endsWith(".md")) {
            noteName = noteName.slice(0, -3);
        }

        const suggestionEl = content.createEl('div', {
            cls: 'suggestion-title',
            text: noteName
        });

        if (match.id.includes(':')) {
            // Set Icon will destroy the first element in a node. So we need to add one back
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

        content.createEl('div', {
            cls: 'suggestion-note',
            text: `${match.tags.join(' ')}`,
        });
    }

    async onChooseSuggestion(match: Match, event?: MouseEvent | KeyboardEvent): Promise<void> {
        // Record file access in search service
        if (this.searchService && match) {
            this.searchService.recordFileAccess(match.text);
        }

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

        // Handle file or alias selection
        let filePath = match.text;
        if (match.id.includes(':')) {
            const [, path] = match.id.split(':');
            filePath = path;
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
            this.prevItems.add(match);
        } catch (error) {
            new Notice(`Failed to open file: ${error.message}`);
        }
    }

    /**
     * Indicates this adapter uses enhanced search and should bypass worker-based search
     */
    usesEnhancedSearch(): boolean {
        return this.searchService !== null;
    }

    /**
     * Perform enhanced search and update modal suggestions directly
     */
    async performEnhancedSearch(query: string): Promise<void> {
        if (!this.searchService) {
            console.log('Enhanced search: No search service available');
            return;
        }

        try {
            const cleanQuery = this.cleanQuery(query);
            console.log('Enhanced search: Searching for:', cleanQuery);
            
            if (!cleanQuery.trim()) {
                // For empty query, use all files sorted by recency/usage
                const allFiles = this.getSortedItems();
                this.palette.currentSuggestions = allFiles.slice(0, this.plugin.settings.suggestionLimit);
                this.palette.limit = this.palette.currentSuggestions.length;
                this.palette.updateSuggestions();
                return;
            }

            const enhancedResults = await this.searchService.search(cleanQuery, this.plugin.settings.suggestionLimit);
            console.log('Enhanced search: Found', enhancedResults.length, 'results');
            
            // Convert enhanced results back to Match format for compatibility
            const matches = enhancedResults.map(result => new PaletteMatch(
                result.id,
                result.metadata.path,
                result.metadata.tags || []
            ));

            this.palette.currentSuggestions = matches;
            this.palette.limit = matches.length;
            this.palette.updateSuggestions();
        } catch (error) {
            console.error('Enhanced search failed:', error);
            // Fallback to original search behavior
            this.palette.getSuggestionsAsync(query);
        }
    }

    private loadAllFiles(): void {
        // Get all markdown files and create matches
        const files = this.app.vault.getMarkdownFiles();
        
        this.allItems = files
            .filter(file => {
                // Apply file type exclusions
                const badfileType = this.plugin.settings.fileTypeExclusion.some(
                    (suffix) => file.path.endsWith(`.${suffix}`)
                );
                return !badfileType;
            })
            .flatMap(file => {
                const matches: Match[] = [];
                
                // Add main file
                matches.push(new PaletteMatch(file.path, file.path));
                
                // Add aliases if any
                const metadata = this.app.metadataCache.getFileCache(file);
                if (metadata?.frontmatter?.aliases) {
                    const aliases = Array.isArray(metadata.frontmatter.aliases) 
                        ? metadata.frontmatter.aliases 
                        : [metadata.frontmatter.aliases];
                    
                    aliases.forEach((alias: string) => {
                        if (alias && typeof alias === 'string') {
                            matches.push(new PaletteMatch(`${alias}:${file.path}`, alias));
                        }
                    });
                }
                
                return matches;
            });
    }
}
