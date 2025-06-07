/**
 * Quick Link Modal - allows users to create links from selected text
 * User selects text, opens this modal, searches for a file, and creates [[file|selected-text]] link
 */

import { App, SuggestModal, setIcon, Notice, TFile, Editor, MarkdownView } from 'obsidian';
import BetterCommandPalettePlugin from '../main';
import { Match } from '../types/types';
import { PaletteMatch, createPaletteMatchesFromFilePath } from '../utils';
import { logger } from '../utils/logger';

interface QuickLinkMatch {
  id: string;
  text: string;
  file: TFile | null;
  isUnresolved: boolean;
}

export class QuickLinkModal extends SuggestModal<QuickLinkMatch> {
  plugin: BetterCommandPalettePlugin;
  private selectedText: string;
  private sourceFile: TFile;
  private editor: Editor;
  private isSearching = false;
  private currentResults: QuickLinkMatch[] = [];
  private lastQuery = '';
  private allFiles: QuickLinkMatch[] = [];
  private isInitialLoad = true; // Track if this is the initial load or user has started typing
  private hasPerformedInitialSearch = false; // Track if we've done the initial search with selected text
  private initialSearchResults: QuickLinkMatch[] = []; // Store the initial search results based on selected text

  constructor(
    app: App, 
    plugin: BetterCommandPalettePlugin, 
    selectedText: string, 
    sourceFile: TFile,
    editor: Editor
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
    
    // Set placeholder text
    this.setPlaceholder(`Showing results for "${this.truncateText(selectedText, 30)}" (or type to search differently)`);
    
    // Set instructions
    this.setInstructions([
      { command: '↑↓', purpose: 'Navigate' },
      { command: '↵', purpose: 'Create link' },
      { command: 'Ctrl+↵', purpose: 'Create new file and link' },
      { command: 'esc', purpose: 'Cancel' }
    ]);

    // Initialize file list
    this.initializeFiles();
  }

  /**
   * Initialize the list of all available files
   */
  private initializeFiles(): void {
    this.allFiles = [];
    
    try {
      // Get all cached files
      const cachedFiles = this.app.metadataCache.getCachedFiles();
      
      for (const filePath of cachedFiles) {
        if (!filePath || typeof filePath !== 'string') continue;
        
        // Skip files with excluded extensions
        const badFileType = this.plugin.settings.fileTypeExclusion.some(
          (suf) => filePath.endsWith(`.${suf}`)
        );
        if (badFileType) continue;
        
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          this.allFiles.push({
            id: file.path,
            text: file.basename,
            file: file,
            isUnresolved: false
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
              isUnresolved: true
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
      // If we have initial search results, show those; otherwise show recent files
      return this.initialSearchResults.length > 0 ? this.initialSearchResults : this.getRecentFiles();
    }

    // If same query and not searching, return cached results
    if (query === this.lastQuery && !this.isSearching) {
      return this.currentResults;
    }

    // Perform search with user's query
    this.performSearch(query);
    return this.currentResults;
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
    
    try {
      // Try enhanced search first if available
      if (this.plugin.searchService) {
        this.isSearching = true;
        const enhancedResults = await this.plugin.searchService.search(searchQuery, 50);
        
        const filteredResults = enhancedResults
          .filter(result => result.metadata.path !== this.sourceFile.path)
          .map(result => {
            const file = this.app.vault.getAbstractFileByPath(result.metadata.path);
            return {
              id: result.id,
              text: file instanceof TFile ? file.basename : result.id,
              file: file instanceof TFile ? file : null,
              isUnresolved: false
            };
          });
        
        // Store the initial search results separately
        this.initialSearchResults = filteredResults;
        
        // Update current results if we're still in initial load mode
        if (this.isInitialLoad) {
          this.currentResults = filteredResults;
        }
        
        this.isSearching = false;
        
        // Force UI update by triggering input event
        if (this.inputEl && this.inputEl.value === '') {
          this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
    } catch (error) {
      logger.warn('[QuickLink] Enhanced search failed in initial search, falling back to fuzzy search:', error);
      this.isSearching = false;
    }
    
    // Fallback to fuzzy search
    const lowerQuery = searchQuery.toLowerCase();
    const fuzzyResults = this.allFiles
      .filter(item => {
        if (item.file?.path === this.sourceFile.path) return false;
        return item.text.toLowerCase().includes(lowerQuery);
      })
      .slice(0, 50);
    
    // Store the initial search results separately
    this.initialSearchResults = fuzzyResults;
    
    // Update current results if we're still in initial load mode
    if (this.isInitialLoad) {
      this.currentResults = fuzzyResults;
    }
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
        suggestions.push({
          id: file.path,
          text: file.basename,
          file: file,
          isUnresolved: false
        });
      }
    }
    
    return suggestions;
  }

  /**
   * Perform search through files using enhanced search or fuzzy matching
   */
  private async performSearch(query: string): Promise<void> {
    this.lastQuery = query;
    const lowerQuery = query.toLowerCase();
    
    try {
      // Try enhanced search first if available
      if (this.plugin.searchService) {
        this.isSearching = true;
        const enhancedResults = await this.plugin.searchService.search(query, 50);
        
        this.currentResults = enhancedResults
          .filter(result => result.metadata.path !== this.sourceFile.path)
          .map(result => {
            const file = this.app.vault.getAbstractFileByPath(result.metadata.path);
            return {
              id: result.id,
              text: file instanceof TFile ? file.basename : result.id,
              file: file instanceof TFile ? file : null,
              isUnresolved: false
            };
          });
        
        this.isSearching = false;
        
        // Force UI update by triggering input event
        if (this.inputEl && this.inputEl.value === query) {
          this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return;
      }
    } catch (error) {
      logger.warn('[QuickLink] Enhanced search failed, falling back to fuzzy search:', error);
      this.isSearching = false;
    }
    
    // Fallback to fuzzy search
    this.currentResults = this.allFiles
      .filter(item => {
        if (item.file?.path === this.sourceFile.path) return false;
        return item.text.toLowerCase().includes(lowerQuery);
      })
      .slice(0, 50);
  }

  renderSuggestion(match: QuickLinkMatch, el: HTMLElement): void {
    // Use the same rendering style as the enhanced file adapter
    this.renderFileSearchStyle(match, el);
  }

  /**
   * Render suggestion using the same style as file search modal
   */
  private renderFileSearchStyle(match: QuickLinkMatch, el: HTMLElement): void {
    let noteName = match.text;

    // Build the displayed note name without its full path if required in settings
    if (this.plugin.settings.displayOnlyNotesNames) {
      noteName = match.text.split("/").pop() || match.text;
    }

    // Build the displayed note name without its Markdown extension if required in settings
    if (this.plugin.settings.hideMdExtension && noteName.endsWith(".md")) {
      noteName = noteName.slice(0, -3);
    }

    // Create main title container
    const suggestionEl = el.createEl('div', {
      cls: 'suggestion-title'
    });

    // Add file type indicator
    if (match.file) {
      this.addFileTypeIndicator(suggestionEl, match.file.path);
    } else {
      // Unresolved link indicator
      const indicator = suggestionEl.createDiv({ cls: 'file-type-indicator unresolved' });
      setIcon(indicator, 'link');
    }

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
        text: noteName
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
   * Add file type indicator icon
   */
  private addFileTypeIndicator(container: HTMLElement, filePath: string): void {
    const indicator = container.createDiv({ cls: 'file-type-indicator' });
    const extension = this.getFileExtension(filePath);
    
    let iconName = 'document';
    
    switch (extension) {
      case 'md':
        iconName = 'document';
        break;
      case 'pdf':
        iconName = 'file-text';
        break;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        iconName = 'image';
        break;
      default:
        iconName = 'file';
    }
    
    setIcon(indicator, iconName);
  }

  /**
   * Get file extension from path
   */
  private getFileExtension(path: string): string | null {
    const match = path.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Render smart path showing folder structure
   */
  private renderSmartPath(container: HTMLElement, fullPath: string, displayName: string): void {
    if (!fullPath.includes('/')) {
      container.createEl('span', {
        cls: 'path-part filename',
        text: displayName
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
        text: folderPath + '/'
      });
    }
    
    // Show filename
    container.createEl('span', {
      cls: 'path-part filename',
      text: this.plugin.settings.hideMdExtension && fileName.endsWith('.md') 
        ? fileName.slice(0, -3) 
        : fileName
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

  /**
   * Handle suggestion selection - create the link
   */
  onChooseSuggestion(match: QuickLinkMatch | null, evt: MouseEvent | KeyboardEvent): void {
    if (!match) return;
    
    const shouldCreateNewFile = evt && (evt as KeyboardEvent).ctrlKey;
    
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
          this.selectedText
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
        this.selectedText
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
    return text.substring(0, maxLength) + '...';
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  onOpen(): void {
    super.onOpen();
    logger.debug('[QuickLink] Modal opened for selected text:', this.selectedText);
  }

  onClose(): void {
    super.onClose();
    logger.debug('[QuickLink] Modal closed');
  }
} 