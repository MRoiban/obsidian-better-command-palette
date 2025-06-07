/**
 * Modal for semantic search interface that matches the file search window UI
 */

import { App, SuggestModal, setIcon, Notice, TFile } from 'obsidian';
import BetterCommandPalettePlugin from '../../main';
import { SemanticSearchResult } from './types';
import { logger } from '../../utils/logger';

interface SemanticMatch {
  id: string;
  text: string;
  excerpt?: string;
  similarity: number;
  file: TFile;
  matches: {
    titleMatch: boolean;
    tagMatch: boolean;
    recentlyModified: boolean;
  };
}

export class SemanticSearchModal extends SuggestModal<SemanticMatch> {
  plugin: BetterCommandPalettePlugin;
  private isSearching = false;
  private currentResults: SemanticMatch[] = [];
  private lastQuery = '';

  constructor(app: App, plugin: BetterCommandPalettePlugin) {
    super(app);
    this.plugin = plugin;
    
    // Add the same CSS class as the file search modal
    this.modalEl.addClass('better-command-palette');
    this.modalEl.setAttribute('palette-mode', 'semantic-search');
    
    // Set the placeholder to match file search
    this.setPlaceholder('Search for concepts, ideas, or topics...');
    
    // Set instructions to match file search
    this.setInstructions([
      { command: '↑↓', purpose: 'Navigate' },
      { command: '↵', purpose: 'Open file' },
      { command: 'esc', purpose: 'Close' }
    ]);
  }

  // Convert semantic search results to the format expected by SuggestModal
  private convertToMatches(results: SemanticSearchResult[]): SemanticMatch[] {
    return results.map(result => ({
      id: result.file.path,
      text: result.title,
      excerpt: result.excerpt,
      similarity: result.similarity,
      file: result.file,
      matches: result.matches
    }));
  }

  getSuggestions(query: string): SemanticMatch[] {
    if (!query || query.length < 3) {
      // Show helpful suggestions when no query provided
      return this.getDefaultSuggestions();
    }

    // If same query and not searching, return cached results
    if (query === this.lastQuery && !this.isSearching) {
      return this.currentResults;
    }

    // If already searching, return current results
    if (this.isSearching) {
      return this.currentResults;
    }

    // Start async search
    this.performAsyncSearch(query);
    
    // Return current results (may be empty on first search)
    return this.currentResults;
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
        .map(path => this.app.vault.getAbstractFileByPath(path))
        .filter((file): file is TFile => file instanceof TFile);

      // Add recent files as suggestions
      for (const file of recentFiles) {
        if (processedPaths.has(file.path)) continue;
        processedPaths.add(file.path);

        suggestions.push({
          id: file.path,
          text: file.basename,
          similarity: 1.0, // High relevance for recent files
          file: file,
          matches: {
            titleMatch: false,
            tagMatch: false,
            recentlyModified: this.isRecentlyModified(file)
          }
        });
      }

      // Fill remaining slots with recently modified files if we have space
      if (suggestions.length < 10) {
        const allFiles = this.app.vault.getMarkdownFiles()
          .filter(file => !processedPaths.has(file.path))
          .sort((a, b) => b.stat.mtime - a.stat.mtime) // Sort by modification time
          .slice(0, 10 - suggestions.length);

        for (const file of allFiles) {
          suggestions.push({
            id: file.path,
            text: file.basename,
            similarity: 0.8, // Good relevance for recently modified
            file: file,
            matches: {
              titleMatch: false,
              tagMatch: false,
              recentlyModified: true
            }
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
    if (this.isSearching) {
      return;
    }

    this.isSearching = true;
    this.lastQuery = query;
    
    try {
      logger.debug('[SemanticSearch] Starting search for:', query);
      const searchEngine = this.plugin.getSemanticSearchEngine();
      if (!searchEngine) {
        logger.warn('[SemanticSearch] Search engine not available');
        new Notice('Semantic search not available');
        return;
      }

      const startTime = Date.now();
      const results = await searchEngine.search(query);
      const searchTime = Date.now() - startTime;

      logger.debug(`[SemanticSearch] Found ${results.length} results`);
      
      const matches = this.convertToMatches(results);
      this.currentResults = matches;
      
      // Trigger a re-render by simulating input change
      if (this.inputEl && this.inputEl.value === query) {
        // Dispatch an input event to trigger suggestions update
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
    } catch (error) {
      logger.error('[SemanticSearch] Search error:', error);
      new Notice(`Search error: ${error.message}`);
      this.currentResults = [];
    } finally {
      this.isSearching = false;
    }
  }

  renderSuggestion(match: SemanticMatch, el: HTMLElement): void {
    // Use the exact same structure as the file search modal
    el.addClass('mod-complex');

    const suggestionContent = el.createEl('div', 'suggestion-content');
    const suggestionAux = el.createEl('div', 'suggestion-aux');

    // Use the same rendering approach as enhanced file adapter
    this.renderFileSearchStyle(match, suggestionContent);

    // Add context-appropriate indicators in aux section
    if (match.similarity === 1.0) {
      // Recent file indicator
      const recentEl = suggestionAux.createEl('span', {
        cls: 'suggestion-hotkey recent',
        text: 'Recent'
      });
      recentEl.title = 'Recently opened file';
    } else if (match.similarity === 0.8) {
      // Recently modified indicator
      const modifiedEl = suggestionAux.createEl('span', {
        cls: 'suggestion-hotkey modified',
        text: 'Modified'
      });
      modifiedEl.title = 'Recently modified file';
    } else {
      // Semantic similarity score for actual search results
      const scoreEl = suggestionAux.createEl('span', {
        cls: 'suggestion-hotkey',
        text: `${Math.round(match.similarity * 100)}%`
      });
      scoreEl.title = `Semantic similarity: ${Math.round(match.similarity * 100)}%`;
    }

    // Add compact match type badges if they exist (for search results)
    if (match.similarity < 1.0 && match.similarity !== 0.8) {
      const badges: string[] = [];
      if (match.matches.titleMatch) badges.push('title');
      if (match.matches.tagMatch) badges.push('tag');
      if (match.matches.recentlyModified) badges.push('recent');
      
      if (badges.length > 0) {
        const badgeEl = suggestionAux.createEl('span', {
          cls: 'suggestion-flair',
          text: badges.join(' • ')
        });
        badgeEl.title = `Matches: ${badges.join(', ')}`;
      }
    }
  }

  /**
   * Render using the exact same style as file search
   */
  private renderFileSearchStyle(match: SemanticMatch, content: HTMLElement): void {
    let noteName = match.file.basename;

    // Remove .md extension for cleaner display
    if (noteName.endsWith('.md')) {
      noteName = noteName.slice(0, -3);
    }

    // Create main title container
    const suggestionEl = content.createEl('div', {
      cls: 'suggestion-title'
    });

    // Add file type indicator
    this.addFileTypeIndicator(suggestionEl, match.file.path);

    // Add recently accessed indicator if applicable
    if (this.isRecentlyAccessed(match)) {
      suggestionEl.createEl('div', { cls: 'recent-indicator' });
    }

    // Smart path rendering that emphasizes filename while showing context
    // Now relies on CSS text-overflow: ellipsis for clipping
    this.renderSmartPath(suggestionEl, match.file.path, noteName);

    // Enhanced tag rendering (same as file search)
    const metadata = this.app.metadataCache.getFileCache(match.file);
    if (metadata?.tags && metadata.tags.length > 0) {
      const tagsEl = content.createEl('div', {
        cls: 'suggestion-note'
      });

      metadata.tags.forEach(tagRef => {
        if (tagRef.tag.trim()) {
          tagsEl.createEl('span', {
            cls: 'tag',
            text: tagRef.tag
          });
        }
      });
    }
  }

  /**
   * Add file type indicator based on file extension
   */
  private addFileTypeIndicator(container: HTMLElement, filePath: string): void {
    const extension = this.getFileExtension(filePath);
    if (!extension) return;

    let typeClass = 'md';
    let typeText = 'MD';

    switch (extension.toLowerCase()) {
      case 'md':
        typeClass = 'md';
        typeText = 'MD';
        break;
      case 'txt':
        typeClass = 'txt';
        typeText = 'TXT';
        break;
      case 'pdf':
        typeClass = 'pdf';
        typeText = 'PDF';
        break;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        typeClass = 'img';
        typeText = 'IMG';
        break;
      default:
        typeText = extension.toUpperCase().substring(0, 3);
    }

    container.createEl('span', {
      cls: `file-type-indicator ${typeClass}`,
      text: typeText
    });
  }

  /**
   * Get file extension from path
   */
  private getFileExtension(path: string): string | null {
    const match = path.match(/\.([^.]+)$/);
    return match ? match[1] : null;
  }

  /**
   * Smart path rendering that emphasizes filename while showing context
   * Now relies on CSS text-overflow: ellipsis for clipping
   */
  private renderSmartPath(container: HTMLElement, fullPath: string, displayName: string): void {
    // Simply set the full path and let CSS handle the ellipsis
    container.textContent = fullPath;
    
    // Always set the full path as tooltip
    container.title = fullPath;
  }

  /**
   * Render truncated path for secondary display
   */
  private renderTruncatedPath(container: HTMLElement, path: string): void {
    const maxLength = 60;
    
    if (path.length <= maxLength) {
      container.textContent = path;
      return;
    }

    // Show beginning and end of path
    const parts = path.split('/');
    if (parts.length > 3) {
      const start = parts.slice(0, 2).join('/');
      const end = parts.slice(-2).join('/');
      container.innerHTML = `${start}/<span class="path-ellipsis">…</span>/${end}`;
    } else {
      // Truncate in the middle
      const truncated = path.substring(0, 30) + '…' + path.substring(path.length - 25);
      container.textContent = truncated;
    }
    
    container.title = path;
  }

  /**
   * Get display name (removing .md extension if needed)
   */
  private getDisplayName(filename: string): string {
    // Remove .md extension for cleaner display
    if (filename.endsWith('.md')) {
      return filename.slice(0, -3);
    }
    return filename;
  }

  /**
   * Check if file was recently accessed
   */
  private isRecentlyAccessed(match: SemanticMatch): boolean {
    // Consider files modified in the last 24 hours as recent
    const daysSince = (Date.now() - match.file.stat.mtime) / (1000 * 60 * 60 * 24);
    return daysSince < 1;
  }

  /**
   * Highlight matched terms in text
   */
  private highlightMatches(text: string, query: string): string {
    if (!query || query.length < 2) return this.escapeHtml(text);
    
    const escapedText = this.escapeHtml(text);
    const terms = query.toLowerCase().split(/\s+/).filter(term => term.length >= 2);
    
    let highlightedText = escapedText;
    
    for (const term of terms) {
      const regex = new RegExp(`(${this.escapeRegex(term)})`, 'gi');
      highlightedText = highlightedText.replace(regex, '<span class="snippet-highlight">$1</span>');
    }
    
    return highlightedText;
  }

  /**
   * Escape HTML characters
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  onChooseSuggestion(match: SemanticMatch | null, evt: MouseEvent | KeyboardEvent): void {
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
    this.currentResults = [];
    this.isSearching = false;
    this.lastQuery = '';
  }
}
