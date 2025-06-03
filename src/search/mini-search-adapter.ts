import MiniSearch from 'minisearch';
import { SearchIndex, FileMetadata, SearchResult, IndexStats } from './interfaces';

/**
 * MiniSearch adapter implementing the SearchIndex interface
 * Provides full-text search capabilities with fuzzy matching and boosting
 */
export class MiniSearchAdapter implements SearchIndex {
    private index: MiniSearch;
    private indexOptions: any;
    private searchOptions: any;
    private documents = new Map<string, FileMetadata>();
    private documentCount = 0;
    private lastUpdated = Date.now();

    constructor() {
        this.indexOptions = {
            fields: ['content', 'title', 'headings', 'tags', 'aliases'],
            storeFields: ['title', 'path'],
            // Custom tokenizer to handle markdown-specific content
            tokenize: (text: string, _fieldName?: string) => {
                return this.tokenizeText(text);
            },
            // Custom term processor to normalize terms
            processTerm: (term: string, _fieldName?: string) => {
                return this.processTerm(term);
            }
        };

        this.searchOptions = {
            boost: { 
                title: 3,       // Title matches are most important
                headings: 2,    // Heading matches are important
                aliases: 2,     // Alias matches are important  
                tags: 1.5,      // Tag matches are moderately important
                content: 1      // Content matches are baseline
            },
            fuzzy: 0.2,         // Allow some fuzzy matching
            prefix: true,       // Enable prefix matching
            combineWith: 'AND', // All terms should match
            weights: {
                fuzzy: 0.2,     // Lower weight for fuzzy matches
                prefix: 0.5     // Medium weight for prefix matches
            }
        };

        this.index = new MiniSearch(this.indexOptions);
    }

    /**
     * Add or update a document in the search index
     */
    async addDocument(id: string, content: string, metadata: FileMetadata): Promise<void> {
        try {
            const doc = this.createSearchDocument(id, content, metadata);
            
            // Remove existing document if it exists
            if (this.index.has(id)) {
                this.index.replace(doc);
            } else {
                this.index.add(doc);
                this.documentCount++;
            }
            
            this.documents.set(id, metadata);
            this.lastUpdated = Date.now();
        } catch (error) {
            console.error(`Failed to add document ${id} to search index:`, error);
            throw error;
        }
    }

    /**
     * Remove a document from the search index
     */
    async removeDocument(id: string): Promise<void> {
        try {
            if (this.index.has(id)) {
                this.index.remove(id);
                this.documentCount--;
            }
            
            this.documents.delete(id);
            this.lastUpdated = Date.now();
        } catch (error) {
            console.error(`Failed to remove document ${id} from search index:`, error);
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

            const results = this.index.search(query, { 
                limit: Math.min(limit, 200), // Cap at 200 to prevent performance issues
                ...this.searchOptions
            });

            return results.map(result => ({
                id: result.id,
                score: result.score,
                matches: result.match || {},
                metadata: this.documents.get(result.id)!,
                snippet: this.generateSnippet(result.id, query, result.match)
            }));
        } catch (error) {
            console.error('Search failed:', error);
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
            version: '1.0.0'
        };
    }

    /**
     * Clear the entire index
     */
    async clear(): Promise<void> {
        this.index = new MiniSearch(this.indexOptions);
        this.documents.clear();
        this.documentCount = 0;
        this.lastUpdated = Date.now();
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

    /**
     * Create a search document from content and metadata
     */
    private createSearchDocument(id: string, content: string, metadata: FileMetadata): any {
        const doc = {
            id,
            content: this.truncateContent(content, 2000), // Limit content size for performance
            title: metadata.title || this.extractTitle(content) || '',
            headings: this.extractHeadings(content).join(' '),
            tags: (metadata.tags || []).join(' '),
            aliases: (metadata.aliases || []).join(' '),
            path: metadata.path
        };

        return doc;
    }

    /**
     * Custom tokenizer for better markdown handling
     */
    private tokenizeText(text: string): string[] {
        if (!text) return [];

        // Remove markdown syntax
        const cleaned = text
            .replace(/[#*_`\[\]()]/g, ' ')  // Remove markdown characters
            .replace(/\bhttps?:\/\/\S+/g, ' ') // Remove URLs
            .replace(/\s+/g, ' ')           // Normalize whitespace
            .trim();

        // Split on word boundaries and filter out short/empty tokens
        return cleaned
            .split(/\W+/)
            .filter(token => token.length >= 2)
            .map(token => token.toLowerCase());
    }

    /**
     * Custom term processor to normalize search terms
     */
    private processTerm(term: string): string | null {
        if (!term || term.length < 2) {
            return null;
        }

        // Convert to lowercase and remove special characters
        const processed = term
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .trim();

        return processed || null;
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

        return headingMatches.map(match => {
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
            stats: this.getStats()
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
            this.documentCount = data.stats?.documentCount || this.documents.size;
            this.lastUpdated = data.stats?.lastUpdated || Date.now();
        } catch (error) {
            console.error('Failed to import index:', error);
            throw error;
        }
    }

    /**
     * Load index from data (alias for importIndex for compatibility)
     */
    async loadFromData(data: any): Promise<void> {
        return this.importIndex(data);
    }
}
