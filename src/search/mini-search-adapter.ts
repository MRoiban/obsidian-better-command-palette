import MiniSearch from 'minisearch';
import {
    SearchIndex, FileMetadata, SearchResult, IndexStats,
} from './interfaces';
import { TermFrequencyIndex } from './term-frequency-index';
import { logger } from '../utils/logger';

/**
 * Maximum number of characters of note body indexed per document. Generous so
 * words late in long notes stay searchable; files above `maxFileSize` are
 * skipped entirely by the indexing service.
 */
export const MAX_INDEXED_CONTENT_CHARS = 50_000;

/** Hard upper bound on results returned by a single index query. */
const MAX_SEARCH_RESULTS = 200;

export interface MiniSearchAdapterOptions {
    typoTolerance: number;
    foldAccents: boolean;
    enableStemming: boolean;
    synonyms: string[];
}

/**
 * MiniSearch adapter implementing the SearchIndex interface
 * Provides full-text search capabilities with fuzzy matching and boosting
 */
export class MiniSearchAdapter implements SearchIndex {
    private index: MiniSearch;

    private indexOptions: any;

    private searchOptions: any;

    private options: MiniSearchAdapterOptions;

    private synonymMap: Map<string, string[]> = new Map();

    private documents = new Map<string, FileMetadata>();

    private searchDocuments = new Map<string, any>();

    private documentCount = 0;

    private lastUpdated = Date.now();

    private termFrequencyIndex: TermFrequencyIndex | null = null;

    constructor(options: Partial<MiniSearchAdapterOptions> = {}) {
        this.options = {
            typoTolerance: 1,
            foldAccents: true,
            enableStemming: false,
            synonyms: [],
            ...options,
        };

        this.indexOptions = {
            fields: ['content', 'title', 'headings', 'tags', 'aliases'],
            storeFields: ['title', 'path'],
            idField: 'id',
            tokenize: (text: string, _fieldName?: string) => this.tokenizeText(text),
            processTerm: (term: string, _fieldName?: string) => this.processTerm(term),
        };

        this.synonymMap = this.buildSynonymMap(this.options.synonyms);
        this.searchOptions = this.buildSearchOptions();

        this.index = new MiniSearch(this.indexOptions);
    }

    updateOptions(options: Partial<MiniSearchAdapterOptions>): void {
        this.options = {
            ...this.options,
            ...options,
        };

        this.synonymMap = this.buildSynonymMap(this.options.synonyms);
        this.searchOptions = this.buildSearchOptions();
    }

    /**
     * Set the term frequency index for IDF-based term weighting
     */
    setTermFrequencyIndex(index: TermFrequencyIndex): void {
        this.termFrequencyIndex = index;
    }

    /**
     * Get the term frequency index
     */
    getTermFrequencyIndex(): TermFrequencyIndex | null {
        return this.termFrequencyIndex;
    }

    /**
     * Add or update a document in the search index
     */
    async addDocument(id: string, content: string, metadata: FileMetadata): Promise<void> {
        try {
            const doc = this.createSearchDocument(id, content, metadata);

            if (this.index.has(id)) {
                this.removeIndexedDocument(id);
                this.index.add(doc);
            } else {
                this.index.add(doc);
                this.documentCount++;
            }

            this.documents.set(id, metadata);
            this.searchDocuments.set(id, doc);
            this.lastUpdated = Date.now();

            // Track term frequencies for IDF calculation
            if (this.termFrequencyIndex) {
                const terms = this.tokenizeText(content);
                this.termFrequencyIndex.addDocument(id, terms);

                // Log progress - first doc and every 100 documents
                const stats = this.termFrequencyIndex.getStats();
                if (stats.totalDocuments === 1) {
                    logger.debug(`[TFI] First document indexed: ${id} (${terms.length} terms extracted)`);
                } else if (stats.totalDocuments % 100 === 0) {
                    logger.debug(`[TFI] Progress: ${stats.totalDocuments} docs, ${stats.uniqueTerms} unique terms`);
                }
            }
        } catch (error) {
            logger.error(`Failed to add document ${id} to search index:`, error);
            throw error;
        }
    }

    /**
     * Remove a document from the search index
     */
    async removeDocument(id: string): Promise<void> {
        try {
            if (this.index.has(id)) {
                this.removeIndexedDocument(id);
                this.documentCount--;
            }

            this.documents.delete(id);
            this.searchDocuments.delete(id);
            this.lastUpdated = Date.now();

            // Update term frequency index
            if (this.termFrequencyIndex) {
                this.termFrequencyIndex.removeDocument(id);
            }
        } catch (error) {
            logger.error(`Failed to remove document ${id} from search index:`, error);
            throw error;
        }
    }

    /**
     * Update an existing document
     */
    async updateDocument(id: string, content: string, metadata: FileMetadata): Promise<void> {
        await this.addDocument(id, content, metadata);
    }

    /**
     * Search the index for documents matching the query
     */
    async search(query: string, limit = 50): Promise<SearchResult[]> {
        try {
            if (!query.trim()) {
                return [];
            }

            // MiniSearch has no `limit` option; results are already sorted by
            // score, so take the top K before any per-result mapping work.
            const maxResults = Math.max(0, Math.min(limit, MAX_SEARCH_RESULTS));
            const results = this.index.search(query, this.searchOptions).slice(0, maxResults);

            return results.map((result) => ({
                id: result.id,
                score: result.score,
                matches: result.match || {},
                metadata: this.documents.get(result.id)!,
                snippet: this.generateSnippet(result.id, query, result.match),
            }));
        } catch (error) {
            logger.error('Search failed:', error);
            return [];
        }
    }

    /**
     * Get index statistics
     */
    getStats(): IndexStats {
        return {
            documentCount: this.documentCount,
            indexSize: this.calculateIndexSize(),
            lastUpdated: this.lastUpdated,
            version: '1.1.0',
        };
    }

    /**
     * Clear the entire index
     */
    async clear(): Promise<void> {
        this.index = new MiniSearch(this.indexOptions);
        this.documents.clear();
        this.searchDocuments.clear();
        this.documentCount = 0;
        this.lastUpdated = Date.now();

        // Also clear TermFrequencyIndex
        if (this.termFrequencyIndex) {
            this.termFrequencyIndex.clear();
            logger.debug('[MiniSearchAdapter] Cleared index and TermFrequencyIndex - will rebuild');
        }
    }

    /**
     * Check if a document exists in the index
     */
    hasDocument(id: string): boolean {
        return this.index.has(id);
    }

    /**
     * Check if a document exists in the index (legacy method)
     */
    has(id: string): boolean {
        return this.index.has(id);
    }

    getDocumentIds(): string[] {
        return Array.from(this.documents.keys());
    }

    private removeIndexedDocument(id: string): void {
        const existingDocument = this.searchDocuments.get(id);

        if (existingDocument) {
            try {
                this.index.remove(existingDocument);
                return;
            } catch (error) {
                logger.warn(`MiniSearchAdapter: Falling back to discard for ${id}:`, error);
            }
        }

        const discard = (this.index as any).discard;
        if (typeof discard === 'function') {
            discard.call(this.index, id);
            return;
        }

        this.index.remove({ id } as any);
    }

    /**
     * Create a search document from content and metadata
     */
    private createSearchDocument(id: string, content: string, metadata: FileMetadata): any {
        const doc = {
            id,
            content: this.truncateContent(content, MAX_INDEXED_CONTENT_CHARS),
            title: metadata.title || this.extractTitle(content) || '',
            headings: this.extractHeadings(content).join(' '),
            tags: (metadata.tags || []).join(' '),
            aliases: this.normalizeAliasesArray(metadata.aliases).join(' '),
            path: metadata.path,
        };

        return doc;
    }

    /**
     * Custom tokenizer for better markdown handling
     */
    private tokenizeText(text: string): string[] {
        if (!text) return [];

        const cleaned = text
            .replace(/[#*_`\[\]()]/g, ' ')
            .replace(/\bhttps?:\/\/\S+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        return cleaned
            .split(/[^\p{L}\p{N}'-]+/u)
            .map((token) => this.normalizeTerm(token))
            .filter((token): token is string => Boolean(token));
    }

    private processTerm(term: string): string | string[] | null {
        const normalized = this.normalizeTerm(term);
        if (!normalized) return null;

        const synonyms = this.synonymMap.get(normalized);
        if (!synonyms || synonyms.length === 0) {
            return normalized;
        }

        const expanded = new Set<string>([normalized]);
        synonyms.forEach((syn) => {
            const normalizedSyn = this.normalizeTerm(syn);
            if (normalizedSyn) {
                expanded.add(normalizedSyn);
            }
        });

        return Array.from(expanded);
    }

    private normalizeTerm(term: string): string | null {
        if (!term) return null;

        const lowerCased = term.toLocaleLowerCase();
        const withoutDiacritics = this.options.foldAccents
            ? this.removeDiacritics(lowerCased)
            : lowerCased;

        const cleaned = withoutDiacritics
            .replace(/[^\p{L}\p{N}'-]+/gu, '')
            .trim();

        if (cleaned.length < 2) {
            return null;
        }

        const stemmed = this.options.enableStemming ? this.stem(cleaned) : cleaned;
        return stemmed || null;
    }

    private removeDiacritics(value: string): string {
        return value.normalize('NFD').replace(/\p{M}+/gu, '');
    }

    private stem(term: string): string {
        if (term.length <= 3) return term;

        const strippedPossessive = term.replace(/'s$/u, '');
        if (strippedPossessive.length <= 3) return strippedPossessive;

        if (strippedPossessive.endsWith('es') && strippedPossessive.length > 4) {
            return strippedPossessive.slice(0, -2);
        }

        if (strippedPossessive.endsWith('s') && strippedPossessive.length > 3) {
            return strippedPossessive.slice(0, -1);
        }

        return strippedPossessive;
    }

    private buildSearchOptions(): any {
        const fuzzyEnabled = this.options.typoTolerance > 0;

        return {
            boost: {
                title: 3,
                headings: 2,
                aliases: 2,
                tags: 1.5,
                content: 1,
            },
            fuzzy: fuzzyEnabled ? this.options.typoTolerance : false,
            prefix: true,
            combineWith: 'AND',
            weights: {
                fuzzy: fuzzyEnabled ? 0.2 : 0,
                prefix: 0.5,
            },
        };
    }

    private buildSynonymMap(entries: string[]): Map<string, string[]> {
        const map = new Map<string, string[]>();

        entries.forEach((entry) => {
            const [rawBase, rawVariants] = entry.split('=');
            const base = this.normalizeTerm(rawBase || '');
            if (!base || !rawVariants) return;

            const variants = rawVariants
                .split(',')
                .map((variant) => this.normalizeTerm(variant || ''))
                .filter((variant): variant is string => Boolean(variant));

            if (variants.length === 0) return;

            const unique = Array.from(new Set(variants.filter((variant) => variant !== base)));

            if (unique.length > 0) {
                map.set(base, unique);
                unique.forEach((variant) => {
                    const existing = map.get(variant) || [];
                    map.set(variant, Array.from(new Set([...existing, base])));
                });
            }
        });

        return map;
    }

    /**
     * Extract title from content
     */
    private extractTitle(content: string): string {
        // Look for first heading
        const titleMatch = content.match(/^#\s+(.+)$/m);
        if (titleMatch) {
            return titleMatch[1].trim();
        }

        // Look for frontmatter title
        const frontmatterMatch = content.match(/^---[\s\S]*?title:\s*(.+)$/m);
        if (frontmatterMatch) {
            return frontmatterMatch[1].trim().replace(/['"]/g, '');
        }

        return '';
    }

    /**
     * Extract headings from content
     */
    private extractHeadings(content: string): string[] {
        const headingMatches = content.match(/^#{1,6}\s+(.+)$/gm);
        if (!headingMatches) return [];

        return headingMatches.map((match) => {
            const heading = match.replace(/^#+\s*/, '').trim();
            return heading;
        });
    }

    /**
     * Truncate content to prevent memory issues
     */
    private truncateContent(content: string, maxLength: number): string {
        if (content.length <= maxLength) {
            return content;
        }

        // Try to truncate at word boundary
        const truncated = content.substring(0, maxLength);
        const lastSpace = truncated.lastIndexOf(' ');

        if (lastSpace > maxLength * 0.8) {
            return truncated.substring(0, lastSpace);
        }

        return truncated;
    }

    /**
     * Generate a highlighted snippet around matched terms
     */
    private generateSnippet(id: string, query: string, matches?: Record<string, string[]>): string {
        const metadata = this.documents.get(id);
        if (!metadata) return '';

        // For now, return a simple snippet
        // In a full implementation, this would highlight matched terms
        const snippetLength = 200;

        // Try to get content from somewhere (would need to be passed in or cached)
        // For now, return title or path as snippet
        return metadata.title || metadata.path || '';
    }

    /**
     * Calculate approximate index size in bytes
     */
    private calculateIndexSize(): number {
        // Rough approximation based on document count
        // In a real implementation, this could be more accurate
        return this.documentCount * 1024; // Estimate 1KB per document
    }

    /**
     * Export index data for persistence
     */
    async exportIndex(): Promise<any> {
        return {
            index: this.index.toJSON(),
            documents: Array.from(this.documents.entries()),
            searchDocuments: Array.from(this.searchDocuments.entries()),
            stats: this.getStats(),
            termFrequencyIndex: this.termFrequencyIndex?.serialize() ?? null,
        };
    }

    /**
     * Serialize index data (alias for exportIndex for interface compatibility)
     */
    async serialize(): Promise<any> {
        return this.exportIndex();
    }

    /**
     * Import index data from persistence
     */
    async importIndex(data: any): Promise<void> {
        try {
            this.index = MiniSearch.loadJSON(JSON.stringify(data.index), this.indexOptions);
            this.documents = new Map(data.documents);
            this.searchDocuments = new Map(data.searchDocuments || []);
            this.documentCount = data.stats?.documentCount || this.documents.size;
            this.lastUpdated = data.stats?.lastUpdated || Date.now();

            // Restore TermFrequencyIndex. It must stay in sync with the index,
            // so a missing or unreadable copy makes the whole cache unusable.
            if (this.termFrequencyIndex) {
                const loaded = !!data.termFrequencyIndex
                    && this.termFrequencyIndex.deserialize(data.termFrequencyIndex);
                if (!loaded) {
                    throw new Error('Cached TermFrequencyIndex is missing or incompatible');
                }
                const stats = this.termFrequencyIndex.getStats();
                logger.debug(`[TermFrequencyIndex] Loaded from cache: ${stats.totalDocuments} docs, ${stats.uniqueTerms} terms`);
            }
        } catch (error) {
            logger.error('Failed to import index:', error);
            throw error;
        }
    }

    /**
     * Load index from data (alias for importIndex for compatibility)
     */
    async loadFromData(data: any): Promise<void> {
        return this.importIndex(data);
    }

    /**
     * Normalize aliases to ensure it's always an array for safe joining
     */
    private normalizeAliasesArray(aliases: any): string[] {
        if (!aliases) {
            return [];
        }
        if (Array.isArray(aliases)) {
            return aliases.filter((alias) => typeof alias === 'string');
        }
        if (typeof aliases === 'string') {
            return [aliases];
        }
        return [];
    }
}
