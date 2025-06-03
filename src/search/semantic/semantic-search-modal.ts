/**
 * Modal for semantic search interface that matches the file search window UI
 */

import { App, SuggestModal, setIcon, Notice, TFile } from 'obsidian';
import BetterCommandPalettePlugin from '../../main';
import { SemanticSearchResult } from './types';

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
      return [];
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

  private async performAsyncSearch(query: string): Promise<void> {
    if (this.isSearching) {
      return;
    }

    this.isSearching = true;
    this.lastQuery = query;
    
    try {
      console.log('[SemanticSearch] Starting search for:', query);
      const searchEngine = this.plugin.getSemanticSearchEngine();
      if (!searchEngine) {
        console.warn('[SemanticSearch] Search engine not available');
        new Notice('Semantic search not available');
        return;
      }

      const results = await searchEngine.search(query);
      console.log(`[SemanticSearch] Found ${results.length} results`);
      
      const matches = this.convertToMatches(results);
      this.currentResults = matches;
      
      // Trigger a re-render by simulating input change
      if (this.inputEl && this.inputEl.value === query) {
        // Dispatch an input event to trigger suggestions update
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
    } catch (error) {
      console.error('[SemanticSearch] Search error:', error);
      new Notice(`Search error: ${error.message}`);
      this.currentResults = [];
    } finally {
      this.isSearching = false;
    }
  }

  renderSuggestion(match: SemanticMatch, el: HTMLElement): void {
    // Use the exact same structure as Obsidian's file search modal
    el.addClass('mod-complex');

    const suggestionContent = el.createEl('div', 'suggestion-content');
    const suggestionAux = el.createEl('div', 'suggestion-aux');

    // Title - use the same styling as file search
    const titleEl = suggestionContent.createEl('div', {
      cls: 'suggestion-title',
      text: match.text
    });

    // Add file icon (same as file search)
    const iconEl = titleEl.createEl('span', 'suggestion-flair');
    setIcon(iconEl, 'document');

    // Excerpt if available (similar to file search note)
    if (match.excerpt && match.excerpt.trim()) {
      suggestionContent.createEl('div', {
        cls: 'suggestion-note',
        text: match.excerpt
      });
    }

    // File path (exactly like file search)
    const pathEl = suggestionContent.createEl('div', {
      cls: 'suggestion-note suggestion-note-secondary',
      text: match.file.path
    });

    // Similarity score and badges in aux section
    const scoreEl = suggestionAux.createEl('span', {
      cls: 'suggestion-hotkey',
      text: `${Math.round(match.similarity * 100)}%`
    });

    // Add match type badges
    const badges: string[] = [];
    if (match.matches.titleMatch) badges.push('title');
    if (match.matches.tagMatch) badges.push('tag');
    if (match.matches.recentlyModified) badges.push('recent');
    
    if (badges.length > 0) {
      const badgeEl = suggestionAux.createEl('span', {
        cls: 'suggestion-flair',
        text: badges.join(' • ')
      });
    }
  }

  onChooseSuggestion(match: SemanticMatch, evt: MouseEvent | KeyboardEvent): void {
    console.log('[SemanticSearch] Opening file:', match.file.path);
    // Open the file exactly like in the file search modal
    this.app.workspace.openLinkText(match.file.path, '', false);
    this.close();
  }

  onOpen(): void {
    super.onOpen();
    console.log('[SemanticSearch] Modal opened');
    
    // Add a hint when modal opens (similar to file search empty state)
    const hint = this.resultContainerEl.createEl('div', {
      cls: 'suggestion-empty',
      text: 'Type at least 3 characters to start semantic search...'
    });
    
    // Remove hint when user starts typing
    const removeHint = () => {
      if (this.inputEl.value.length >= 3) {
        hint.remove();
        this.inputEl.removeEventListener('input', removeHint);
      }
    };
    
    this.inputEl.addEventListener('input', removeHint);
  }

  onClose(): void {
    super.onClose();
    console.log('[SemanticSearch] Modal closed');
    this.currentResults = [];
    this.isSearching = false;
    this.lastQuery = '';
  }
}
