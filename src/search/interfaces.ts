/**
 * Core interfaces for the enhanced content search system
 *
 * These interfaces define the contract for content storage, search indexing,
 * usage tracking, and ranking algorithms used throughout the search system.
 */

export interface FileMetadata {
    path: string;
    title?: string;
    headings?: Array<{ heading: string; level: number }>;
    frontmatter?: Record<string, any>;
    tags?: string[];
    aliases?: string[];
    links?: string[];
    size?: number;
    lastModified: number;
    contentHash?: string;
}

export interface SearchResult {
    id: string;
    score: number;
    matches: Record<string, string[]>;
    metadata: FileMetadata;
    snippet?: string;
}

export interface EnhancedSearchResult extends SearchResult {
    combinedScore: number;
    contentScore: number;
    usageScore: number;
    recencyScore: number;
    lastOpened?: number;
}

export interface IndexStats {
    documentCount: number;
    indexSize: number;
    lastUpdated: number;
    version: string;
}

/**
 * Content storage interface for persisting file content
 */
export interface ContentStore {
    get(fileId: string): Promise<string>;
    set(fileId: string, content: string): Promise<void>;
    delete(fileId: string): Promise<void>;
    clear(): Promise<void>;
    getStats(): Promise<{ count: number; size: number }>;
}

/**
 * Search index interface for full-text search capabilities
 */
export interface SearchIndex {
    addDocument(id: string, content: string, metadata: FileMetadata): Promise<void>;
    removeDocument(id: string): Promise<void>;
    updateDocument(id: string, content: string, metadata: FileMetadata): Promise<void>;
    hasDocument(id: string): boolean;
    search(query: string, limit?: number): Promise<SearchResult[]>;
    getStats(): IndexStats;
    clear(): Promise<void>;
    serialize(): Promise<any>;
    loadFromData(data: any): Promise<void>;
    updateOptions?(options: any): void;
}

/**
 * Usage tracking interface for behavioral data
 */
export interface UsageTracker {
    recordFileOpen(path: string): void;
    recordSearch(query: string, selectedPath?: string): void;
    recordFileCreate(path: string): void;
    getUsageScore(path: string): number;
    getRecencyScore(path: string): number;
    getLastOpened(path: string): number | undefined;
    getSearchHistory(limit?: number): Array<{ query: string; timestamp: number; selectedPath?: string }>;
    reset(): Promise<void>;
    getStats(): Promise<{ totalOpens: number; totalSearches: number; uniqueFiles: number }>;
}

/**
 * Context object for ranking calculations
 */
export interface RankingContext {
    query: string;
    contentScore: number;
    usageScore: number;
    recencyScore: number;
    metadata: FileMetadata;
    lastOpened?: number;
    /** PageRank score from link graph analysis (0-1) */
    pageRankScore?: number;
    /** Negative feedback score from pogo-sticking detection (0-1) */
    bounceScore?: number;
}

/**
 * Settings interface for search configuration
 */
export interface SearchSettings {
    scoreWeights: {
        relevance: number; // Content relevance weight (0-1, default: 0.5)
        recency: number; // Recency weight (0-1, default: 0.2)
        frequency: number; // Usage frequency weight (0-1, default: 0.15)
        linkImportance: number; // PageRank/link importance weight (0-1, default: 0.15)
    };
    recencyHalfLife: number; // Time in ms for recency decay (default: 7 days)
    maxUsageScore: number; // Maximum usage score for normalization (default: 100)
    maxIndexedFiles: number; // Limit for indexed files (default: 10000)
    enableUsageTracking: boolean; // Enable/disable usage tracking (default: true)
    indexingDebounceMs: number; // Debounce time for indexing updates (default: 500ms)
    searchTimeoutMs: number; // Search timeout (default: 5000ms)
    contentPreviewLength: number; // Length of content previews (default: 200)
    enableContentSearch: boolean; // Enable full content search (default: true)
    preserveQuery: boolean; // Preserve search query when switching modes (default: false)

    // Performance settings
    indexingBatchSize: number; // Files per batch during indexing (default: 3)
    indexingDelayMs: number; // Delay between files (default: 50ms)
    indexingBatchDelayMs: number; // Delay between batches (default: 200ms)
    maxFileSize: number; // Maximum file size to index in bytes (default: 1MB)

    // Matching and normalization
    typoTolerance: number; // Levenshtein distance for fuzzy matches (0-2, default: 1)
    foldAccents: boolean; // Normalize diacritics for accent-insensitive matching
    enableStemming: boolean; // Apply light, language-agnostic stemming during indexing/search
    synonyms: string[]; // User-provided synonym entries (e.g., "color=colour,couleur")
}

/**
 * Worker message types for background processing
 */
export interface WorkerMessage {
    type: 'INDEX_FILE' | 'SEARCH' | 'REMOVE_FILE' | 'CLEAR_INDEX' | 'GET_STATS' | 'EXPORT_INDEX' | 'IMPORT_INDEX';
    payload: any;
    requestId?: string;
}

export interface WorkerResponse {
    type: 'INDEX_COMPLETE'
    | 'SEARCH_RESULTS'
    | 'REMOVE_COMPLETE'
    | 'CLEAR_COMPLETE'
    | 'STATS_RESULT'
    | 'EXPORT_RESULT'
    | 'IMPORT_COMPLETE'
    | 'ERROR';
    payload: any;
    requestId?: string;
}
