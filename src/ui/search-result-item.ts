import { EnhancedSearchResult } from '../search/interfaces';

/**
 * UI component for rendering enhanced search results
 * Shows content relevance, usage patterns, and match highlights
 */
export class SearchResultItem {
    private result: EnhancedSearchResult;

    private onSelect: (result: EnhancedSearchResult, event: KeyboardEvent | MouseEvent) => void;

    private onHover?: (result: EnhancedSearchResult) => void;

    constructor(
        result: EnhancedSearchResult,
        onSelect: (result: EnhancedSearchResult, event: KeyboardEvent | MouseEvent) => void,
        onHover?: (result: EnhancedSearchResult) => void,
    ) {
        this.result = result;
        this.onSelect = onSelect;
        this.onHover = onHover;
    }

    /**
     * Render the search result item
     */
    render(container: HTMLElement): HTMLElement {
        const item = container.createDiv({ cls: 'enhanced-search-result-item' });

        // Add data attributes for styling and interaction
        item.setAttribute('data-file-id', this.result.id);
        item.setAttribute('data-score', this.result.combinedScore.toString());

        // Create main content structure
        this.renderHeader(item);
        this.renderSnippet(item);
        this.renderMetadata(item);
        this.renderScores(item);

        // Add event listeners
        this.setupEventListeners(item);

        return item;
    }

    /**
     * Render the header with file path and type indicator
     */
    private renderHeader(container: HTMLElement): void {
        const header = container.createDiv({ cls: 'search-result-header' });

        // File path with smart truncation
        const pathEl = header.createDiv({ cls: 'search-result-path' });
        this.renderSmartPath(pathEl, this.result.metadata.path);

        // Score indicator
        const scoreEl = header.createDiv({ cls: 'search-result-score' });
        const percentage = Math.round(this.result.combinedScore * 100);
        scoreEl.textContent = `${percentage}%`;
        scoreEl.title = `Relevance: ${percentage}%`;

        // File type indicator
        if (this.result.metadata.path) {
            const extension = this.getFileExtension(this.result.metadata.path);
            if (extension) {
                const typeEl = header.createDiv({ cls: 'search-result-type' });
                typeEl.textContent = extension.toUpperCase();
                typeEl.title = `File type: ${extension}`;
            }
        }
    }

    /**
     * Render content snippet with highlighted matches
     */
    private renderSnippet(container: HTMLElement): void {
        if (!this.result.snippet) {
            return;
        }

        const snippetEl = container.createDiv({ cls: 'search-result-snippet' });

        // Enhanced snippet with match highlighting
        const highlighted = this.highlightMatches(this.result.snippet, this.result.matches);
        snippetEl.innerHTML = highlighted;

        // Add truncation if snippet is too long
        if (this.result.snippet.length > 200) {
            snippetEl.addClass('truncated');

            const expandBtn = snippetEl.createEl('button', {
                cls: 'snippet-expand-btn',
                text: 'Show more',
            });

            expandBtn.onclick = (e) => {
                e.stopPropagation();
                snippetEl.removeClass('truncated');
                expandBtn.remove();
            };
        }
    }

    /**
     * Render metadata section
     */
    private renderMetadata(container: HTMLElement): void {
        const metadata = container.createDiv({ cls: 'search-result-metadata' });

        // Tags
        if (this.result.metadata.tags && this.result.metadata.tags.length > 0) {
            const tagsEl = metadata.createDiv({ cls: 'search-result-tags' });
            this.result.metadata.tags.slice(0, 3).forEach((tag) => {
                const tagEl = tagsEl.createEl('span', { cls: 'tag', text: tag });
                tagEl.title = `Tag: ${tag}`;
            });

            if (this.result.metadata.tags.length > 3) {
                tagsEl.createEl('span', {
                    cls: 'tag-more',
                    text: `+${this.result.metadata.tags.length - 3}`,
                });
            }
        }

        // Last modified
        if (this.result.metadata.lastModified) {
            const modifiedEl = metadata.createDiv({ cls: 'search-result-modified' });
            modifiedEl.textContent = this.formatDate(this.result.metadata.lastModified);
            modifiedEl.title = `Last modified: ${new Date(this.result.metadata.lastModified).toLocaleString()}`;
        }
    }

    /**
     * Render score breakdown for debugging/advanced users
     */
    private renderScores(container: HTMLElement): void {
        if (!this.shouldShowScores()) {
            return;
        }

        const scoresEl = container.createDiv({ cls: 'search-result-scores' });

        // Content relevance
        const contentScore = Math.round(this.result.contentScore * 100);
        this.createScoreBar(scoresEl, 'Content', contentScore, 'content-score');

        // Usage frequency
        if (this.result.usageScore > 0) {
            const usageScore = Math.round(this.result.usageScore * 100);
            this.createScoreBar(scoresEl, 'Usage', usageScore, 'usage-score');
        }

        // Recency
        if (this.result.recencyScore > 0) {
            const recencyScore = Math.round(this.result.recencyScore * 100);
            this.createScoreBar(scoresEl, 'Recent', recencyScore, 'recency-score');
        }

        // Last opened indicator
        if (this.result.lastOpened) {
            const lastOpenedEl = scoresEl.createDiv({ cls: 'last-opened' });
            lastOpenedEl.textContent = `Opened ${this.formatRelativeTime(this.result.lastOpened)}`;
            lastOpenedEl.title = `Last opened: ${new Date(this.result.lastOpened).toLocaleString()}`;
        }
    }

    /**
     * Create a score bar visualization
     */
    private createScoreBar(container: HTMLElement, label: string, score: number, className: string): void {
        const scoreEl = container.createDiv({ cls: `score-bar ${className}` });

        const labelEl = scoreEl.createEl('span', { cls: 'score-label', text: label });

        const barEl = scoreEl.createDiv({ cls: 'score-bar-container' });
        const fillEl = barEl.createDiv({ cls: 'score-bar-fill' });
        fillEl.style.width = `${score}%`;

        const valueEl = scoreEl.createEl('span', { cls: 'score-value', text: `${score}%` });

        scoreEl.title = `${label}: ${score}%`;
    }

    /**
     * Setup event listeners for interaction
     */
    private setupEventListeners(item: HTMLElement): void {
        // Click handler
        item.addEventListener('click', (e) => {
            this.onSelect(this.result, e);
        });

        // Hover handler
        if (this.onHover) {
            item.addEventListener('mouseenter', () => {
                this.onHover!(this.result);
            });
        }

        // Keyboard navigation
        item.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.onSelect(this.result, e);
            }
        });

        // Focus management
        item.tabIndex = 0;

        item.addEventListener('focus', () => {
            item.addClass('focused');
            if (this.onHover) {
                this.onHover(this.result);
            }
        });

        item.addEventListener('blur', () => {
            item.removeClass('focused');
        });
    }

    /**
     * Render smart path that shows important parts
     * Now relies on CSS text-overflow: ellipsis for clipping
     */
    private renderSmartPath(container: HTMLElement, path: string): void {
        // Simply set the full path and let CSS handle the ellipsis
        container.textContent = path;

        // Always set the full path as tooltip
        container.title = path;
    }

    /**
     * Highlight matched terms in text
     */
    private highlightMatches(text: string, matches: Record<string, string[]>): string {
        if (!matches || Object.keys(matches).length === 0) {
            return this.escapeHtml(text);
        }

        let highlightedText = this.escapeHtml(text);

        // Collect all match terms
        const allTerms = new Set<string>();
        Object.values(matches).forEach((terms) => {
            terms.forEach((term) => allTerms.add(term.toLowerCase()));
        });

        // Sort terms by length (longest first) to avoid overlapping highlights
        const sortedTerms = Array.from(allTerms).sort((a, b) => b.length - a.length);

        // Apply highlights
        sortedTerms.forEach((term) => {
            const regex = new RegExp(`\\b(${this.escapeRegex(term)})`, 'gi');
            highlightedText = highlightedText.replace(regex, '<mark class="search-highlight">$1</mark>');
        });

        return highlightedText;
    }

    /**
     * Get file extension from path
     */
    private getFileExtension(path: string): string | null {
        const match = path.match(/\.([^.]+)$/);
        return match ? match[1] : null;
    }

    /**
     * Format date for display
     */
    private formatDate(timestamp: number): string {
        const date = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) {
            return 'Today';
        } if (diffDays === 1) {
            return 'Yesterday';
        } if (diffDays < 7) {
            return `${diffDays} days ago`;
        }
        return date.toLocaleDateString();
    }

    /**
     * Format relative time
     */
    private formatRelativeTime(timestamp: number): string {
        const now = Date.now();
        const diffMs = now - timestamp;
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffMinutes < 60) {
            return diffMinutes <= 1 ? 'just now' : `${diffMinutes}m ago`;
        } if (diffHours < 24) {
            return `${diffHours}h ago`;
        } if (diffDays < 30) {
            return `${diffDays}d ago`;
        }
        return new Date(timestamp).toLocaleDateString();
    }

    /**
     * Check if scores should be shown (debug mode or advanced settings)
     */
    private shouldShowScores(): boolean {
        // In a real implementation, this would check user preferences
        // For now, show scores if the result has usage data
        return this.result.usageScore > 0 || this.result.recencyScore > 0;
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

    /**
     * Update the result data (for live updates)
     */
    updateResult(newResult: EnhancedSearchResult): void {
        this.result = newResult;
    }

    /**
     * Get the current result
     */
    getResult(): EnhancedSearchResult {
        return this.result;
    }
}
