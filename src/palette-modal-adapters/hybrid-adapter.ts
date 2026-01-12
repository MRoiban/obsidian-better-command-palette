/**
 * Hybrid Search Adapter for the palette modal
 * 
 * Provides a Google-like search experience by combining keyword and semantic search.
 * Uses RRF fusion and re-ranking for optimal results.
 */

import {
    Instruction, Notice, setIcon, TFile, Menu,
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
    titleText: string;

    emptyStateText: string;

    app: UnsafeAppInterface;

    allItems: Match[];

    private hybridSearchService?: HybridSearchService;

    private hybridSearchPrefix: string;

    private lastSearchResults: HybridMatch[] = [];

    private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    private readonly SEARCH_DEBOUNCE_MS = 150;

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

        this.titleText = 'Better Command Palette: Hybrid Search';
        this.emptyStateText = 'Search for concepts, keywords, or topics...';
        this.hybridSearchPrefix = '?'; // Use ? prefix for hybrid search

        this.hiddenIds = this.plugin.settings.hiddenFiles;
        this.hiddenIdsSettingsKey = 'hiddenFiles';

        this.allItems = [];
        this.lastSearchResults = [];

        // Load recent files as initial suggestions
        this.loadRecentFiles();
    }

    /**
     * Load recent files for when no search query is provided
     */
    private loadRecentFiles(): void {
        const recentFiles = this.app.workspace.getLastOpenFiles().slice(0, 10);

        recentFiles.forEach((filePath: string) => {
            if (!filePath || typeof filePath !== 'string') return;

            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const displayPath = this.processDisplayPath(filePath);
                const match = new PaletteMatch(filePath, displayPath) as HybridMatch;
                this.prevItems.add(match);
                this.allItems.push(match);
            }
        });
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

    /**
     * Get hybrid search results
     */
    async getSearchResults(query: string): Promise<Match[]> {
        logger.debug('HybridSearchAdapter: getSearchResults called with:', query);

        const cleanQuery = this.cleanQuery(query);
        if (cleanQuery.length < 2) {
            return [];
        }

        if (!this.hybridSearchService?.isReady()) {
            logger.debug('HybridSearchAdapter: Service not ready');
            return [];
        }

        try {
            const results = await this.hybridSearchService.search(cleanQuery, {
                limit: this.plugin.settings.suggestionLimit,
            });

            logger.debug('HybridSearchAdapter: Found', results.length, 'results');

            // Convert to HybridMatch format
            this.lastSearchResults = results.map((result) => {
                const displayPath = this.processDisplayPath(result.path);
                const match = new PaletteMatch(
                    result.path,
                    displayPath,
                    result.metadata?.tags || [],
                ) as HybridMatch;
                match.hybridResult = result;
                return match;
            });

            return this.lastSearchResults;
        } catch (error) {
            logger.error('HybridSearchAdapter: Search failed', error);
            return [];
        }
    }

    /**
     * Stream search results for better UX
     * Shows keyword results immediately, then blends in semantic results as they arrive
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
        if (cleanQuery.length < 2 || !this.hybridSearchService?.isReady()) {
            options.onUpdate([], true);
            return;
        }

        // Clear any pending search
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
            this.searchDebounceTimer = null;
        }

        // Return a promise that resolves after the debounced search completes
        return new Promise((resolve) => {
            this.searchDebounceTimer = setTimeout(async () => {
                if (options.signal?.aborted) {
                    options.onUpdate([], true);
                    resolve();
                    return;
                }

                try {
                    await this.hybridSearchService!.searchStream(cleanQuery, {
                        limit: options.limit,
                        signal: options.signal,
                        onUpdate: (results, phase) => {
                            if (options.signal?.aborted) return;

                            this.lastSearchResults = results.map((result) => {
                                const displayPath = this.processDisplayPath(result.path);
                                const match = new PaletteMatch(
                                    result.path,
                                    displayPath,
                                    result.metadata?.tags || [],
                                ) as HybridMatch;
                                match.hybridResult = result;
                                return match;
                            });

                            // Emit results; done=true only when phase is 'complete'
                            options.onUpdate(this.lastSearchResults, phase === 'complete');
                        },
                    });
                    resolve();
                } catch (error) {
                    if (options.signal?.aborted) {
                        resolve();
                        return;
                    }
                    logger.error('HybridSearchAdapter: Stream search failed', error);
                    options.onUpdate([], true);
                    resolve();
                }
            }, this.SEARCH_DEBOUNCE_MS);
        });
    }

    /**
     * Render a hybrid search result with match indicators
     */
    renderSuggestion(match: Match, content: HTMLElement, aux?: HTMLElement): void {
        const hybridMatch = match as HybridMatch;
        const result = hybridMatch.hybridResult;

        // Clear default styling
        content.addClass('hybrid-suggestion-content');

        const file = this.app.vault.getAbstractFileByPath(match.id);

        // --- ROW 1: Title & Meta ---
        const headerEl = content.createEl('div', { cls: 'hybrid-result-header' });

        // Title (Left)
        // Always extract basename for the "Clean" layout, ignoring 'displayOnlyNotesNames' setting 
        // because we have a dedicated path row now.
        let displayName = match.text.split('/').pop() || match.text;

        if (this.plugin.settings.hideMdExtension && displayName.endsWith('.md')) {
            displayName = displayName.slice(0, -3);
        }

        // Capitalize first letter
        if (displayName.length > 0) {
            displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);
        }

        headerEl.createEl('span', {
            cls: 'hybrid-result-title',
            text: displayName,
        });

        // Spacer
        headerEl.createEl('span', { cls: 'hybrid-header-spacer' });

        // Meta (Right)
        const metaEl = headerEl.createEl('span', { cls: 'hybrid-result-meta' });

        // Rating Star
        if (file instanceof TFile) {
            const metadata = this.app.metadataCache.getFileCache(file);
            const ratingRaw = metadata?.frontmatter?.rating;

            if (ratingRaw !== undefined && ratingRaw !== null) {
                const ratingNum = parseFloat(String(ratingRaw));
                if (!isNaN(ratingNum)) {
                    // Normalize from scale of 7 to scale of 5
                    // e.g. 6/7 -> 4.28
                    const normalized = (ratingNum / 7) * 5;
                    const displayRating = normalized.toFixed(1); // e.g. "4.8"

                    const ratingContainer = metaEl.createEl('span', { cls: 'hybrid-rating' });

                    // Stars: 5 stars, filled if index < round(normalized) or similar logic
                    // User requested "stars show correctly". Let's use simple rounding for filled stars.
                    const rounded = Math.round(normalized);
                    let starsStr = '';
                    for (let i = 0; i < 5; i++) {
                        starsStr += i < rounded ? '★' : '☆';
                    }

                    ratingContainer.createEl('span', { cls: 'hybrid-rating-stars', text: starsStr });
                    ratingContainer.createEl('span', { cls: 'hybrid-rating-text', text: ` Rating: ${displayRating}/5` });
                }
            }
        }

        if (result) {
            // Confidence Score
            this.addConfidenceMeter(metaEl, result.finalScore);
        }

        // More Options Icon (Vertical dots)
        const menuIcon = metaEl.createEl('span', { cls: 'hybrid-menu-icon' });
        setIcon(menuIcon, 'more-vertical');

        menuIcon.onClickEvent((event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const menu = new Menu(this.app); // Using Obsidian Menu

            // Toggle Ignore/Hide
            const isHidden = this.hiddenIds.includes(match.id);
            menu.addItem((item) => {
                item
                    .setTitle(isHidden ? 'Unhide Item' : 'Ignore Item')
                    .setIcon(isHidden ? 'eye' : 'eye-off')
                    .onClick(() => {
                        this.toggleHideId(match.id);
                        // Force update to reflect change immediately if needed, 
                        // though toggleHideId usually triggers update.
                    });
            });

            menu.showAtMouseEvent(event);
        });

        // --- ROW 2: Path ---
        const fullPath = match.text;
        const lastSlashIndex = fullPath.lastIndexOf('/');
        if (lastSlashIndex > 0) {
            const folderPath = fullPath.substring(0, lastSlashIndex);
            const formattedPath = folderPath.replace(/\//g, ' > ');

            content.createEl('div', {
                cls: 'hybrid-result-path',
                text: formattedPath
            });
        }

        // --- ROW 3: Context (Date Pill + Snippet) ---
        const bodyEl = content.createEl('div', { cls: 'hybrid-result-body' });

        // Date Pill
        const dateText = file instanceof TFile ? window.moment(file.stat.mtime).format('MMM D, YYYY') : '';

        if (dateText) {
            bodyEl.createEl('span', {
                cls: 'hybrid-date-pill',
                text: dateText
            });
        }

        // Excerpt / Snippet
        if (result?.excerpt) {
            const excerptEl = bodyEl.createEl('span', {
                cls: 'hybrid-excerpt',
            });
            // highlight keywords
            this.renderExcerptWithHighlights(excerptEl, result.excerpt, result.matches?.keywordMatches || []);
            // Add "..See more" suffix
            excerptEl.createEl('span', { cls: 'hybrid-excerpt-more', text: '..See more' });
        } else if (match.tags && match.tags.length > 0) {
            // Fallback to tags if no excerpt
            match.tags.slice(0, 3).forEach((tag) => {
                bodyEl.createEl('span', { cls: 'hybrid-tag', text: tag.startsWith('#') ? tag : `#${tag}` });
            });
        }
    }

    /**
     * Render excerpt with keyword highlights
     */
    private renderExcerptWithHighlights(container: HTMLElement, text: string, keywords: string[]) {
        if (!keywords.length) {
            container.textContent = text;
            return;
        }

        // Simple case-insensitive highlight
        // Note: This is a basic implementation. For production, efficient regex construction is better.
        const regex = new RegExp(`(${keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
        const parts = text.split(regex);

        parts.forEach(part => {
            if (keywords.some(k => k.toLowerCase() === part.toLowerCase())) {
                container.createEl('span', { cls: 'hybrid-highlight', text: part });
            } else {
                container.appendText(part);
            }
        });
    }

    /**
     * Add confidence meter
     */
    private addConfidenceMeter(container: HTMLElement, score: number) {
        // Score is 0-1
        const meter = container.createEl('span', { cls: 'hybrid-confidence-meter' });
        meter.title = `Relevance Score: ${(score * 100).toFixed(1)}%`;

        // 5 bars
        const bars = 5;
        const filled = Math.round(score * bars);

        for (let i = 0; i < bars; i++) {
            meter.createEl('span', {
                cls: `meter-bar ${i < filled ? 'filled' : 'empty'}`
            });
        }
    }

    /**
            setIcon(indicator, 'brain-circuit'); // Or 'sparkles' if brain not avail. 'brain' is lucide.
            // basic obsidian set might not have brain-circuit. 'star' or 'sparkle' is safer?
            // standard obsidian icons: https://lucide.dev/ (Obsidian uses Lucide mostly now)
            // Let's try 'sparkles' for semantic, 'zap' for both.

            // Fallback logic if icons fail isn't easy here without runtime check, 
            // but 'search' and 'link' and 'star' are safe. 
            // Let's use 'search' (keyword), 'sparkles' (semantic), 'zap' (both).
        }

        // Re-do specific icon logic:
        indicator.innerHTML = ''; // clear
        if (result.source === 'both') {
            setIcon(indicator, 'zap');
        } else if (result.source === 'keyword') {
            setIcon(indicator, 'search');
        } else {
            setIcon(indicator, 'sparkles');
        }
    }

    /**
     * Handle file selection
     */
    async onChooseSuggestion(match: Match | null, event?: MouseEvent | KeyboardEvent): Promise<void> {
        if (!match) return;

        const hybridMatch = match as HybridMatch;
        const filePath = match.id;

        // Record selection for improved future rankings
        if (this.hybridSearchService && this.palette.inputEl) {
            const query = this.cleanQuery(this.palette.inputEl.value);
            if (query) {
                this.hybridSearchService.recordSelection(query, filePath);
            }
        }

        // Record for pogo-sticking detection
        if (this.plugin.usageTracker && this.palette.inputEl) {
            const query = this.cleanQuery(this.palette.inputEl.value);
            this.plugin.usageTracker.recordSearchResultOpen(filePath, query);
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
