/**
 * Types for hybrid search functionality
 * Combines keyword (MiniSearch) and semantic (embedding) search results
 */

import { TFile } from 'obsidian';
import { EnhancedSearchResult, FileMetadata } from '../interfaces';
import { SemanticSearchResult } from '../semantic/types';

/**
 * Source of a search result in hybrid search
 */
export type HybridResultSource = 'keyword' | 'semantic' | 'both';

/**
 * Phase of streaming search results
 * - 'keyword': Fast initial results from keyword search only
 * - 'complete': Final fused & re-ranked results
 */
export type StreamingPhase = 'keyword' | 'complete';

/**
 * Match details for explaining why a result was returned
 */
export interface HybridMatchDetails {
    /** Whether the title matched the query */
    titleMatch: boolean;
    /** Whether tags matched the query */
    tagMatch: boolean;
    /** Whether the file was recently modified */
    recentlyModified: boolean;
    /** Keywords that matched in the content */
    keywordMatches: string[];
    /** Semantic similarity score (0-1) */
    semanticSimilarity?: number;
    /** Explanation of why this result was returned */
    matchReason: string;
}

/**
 * Result from hybrid search combining keyword and semantic results
 */
export interface HybridSearchResult {
    /** The file this result refers to */
    file: TFile;
    /** File path (for compatibility with existing interfaces) */
    path: string;
    /** Display title */
    title: string;
    /** Content excerpt/snippet */
    excerpt: string;

    // Scoring
    /** Final combined score after fusion and re-ranking (0-1) */
    finalScore: number;
    /** Score from keyword search (0-1, normalized) */
    keywordScore: number;
    /** Score from semantic search (0-1) */
    semanticScore: number;
    /** Score from RRF fusion before re-ranking */
    fusionScore: number;
    /** Re-ranking adjustment applied */
    reRankBoost: number;

    // Source tracking
    /** Which search system(s) returned this result */
    source: HybridResultSource;
    /** Rank in keyword results (undefined if not in keyword results) */
    keywordRank?: number;
    /** Rank in semantic results (undefined if not in semantic results) */
    semanticRank?: number;

    // Match details for UI
    matches: HybridMatchDetails;

    // Metadata
    metadata?: FileMetadata;
    /** Last modification time */
    lastModified: number;
}

/**
 * Configuration for hybrid search behavior
 */
export interface HybridSearchSettings {
    /** Enable hybrid search mode */
    enabled: boolean;

    // Fusion settings
    /** RRF k parameter - higher values give more weight to lower-ranked items (default: 60) */
    rrfK: number;
    /** Weight for keyword results in fusion (0-1, default: 0.5) */
    keywordWeight: number;
    /** Weight for semantic results in fusion (0-1, default: 0.5) */
    semanticWeight: number;

    // Re-ranking settings
    /** Enable re-ranking step (default: true) */
    enableReRanking: boolean;
    /** Number of top results to re-rank (default: 20) */
    reRankPoolSize: number;
    /** Weight for title match in re-ranking (default: 0.25) */
    reRankTitleWeight: number;
    /** Weight for recency in re-ranking (default: 0.15) */
    reRankRecencyWeight: number;
    /** Weight for usage/frequency in re-ranking (default: 0.15) */
    reRankUsageWeight: number;
    /** Weight for content density in re-ranking (default: 0.25) */
    reRankContentWeight: number;
    /** Weight for PageRank/link importance in re-ranking (default: 0.2) */
    reRankPageRankWeight: number;
    /** Weight for term proximity in re-ranking (default: 0.15) */
    reRankProximityWeight: number;

    // Search behavior
    /** Maximum results to return (default: 20) */
    maxResults: number;
    /** Minimum score threshold for results (default: 0.1) */
    minScoreThreshold: number;
    /** Timeout for search in milliseconds (default: 5000) */
    searchTimeoutMs: number;

    // UI settings
    /** Show match explanations in results (default: true) */
    showMatchReasons: boolean;
    /** Hotkey for hybrid search (default: 'h') */
    searchHotkey: string;

    // Clustering settings
    /** Enable result clustering to group similar notes (default: false) */
    enableClustering: boolean;
    /** Similarity threshold for clustering (0-1, higher = more similar required, default: 0.85) */
    clusterSimilarityThreshold: number;
}

/**
 * Internal result from keyword search, normalized for fusion
 */
export interface NormalizedKeywordResult {
    path: string;
    file: TFile;
    score: number;
    normalizedScore: number;
    rank: number;
    matches: Record<string, string[]>;
    metadata?: FileMetadata;
    snippet?: string;
}

/**
 * Internal result from semantic search, normalized for fusion
 */
export interface NormalizedSemanticResult {
    path: string;
    file: TFile;
    score: number;
    normalizedScore: number;
    rank: number;
    similarity: number;
    excerpt: string;
    matches: {
        titleMatch: boolean;
        tagMatch: boolean;
        recentlyModified: boolean;
    };
}

/**
 * Fused result before re-ranking
 */
export interface FusedResult {
    path: string;
    file: TFile;
    fusionScore: number;
    keywordResult?: NormalizedKeywordResult;
    semanticResult?: NormalizedSemanticResult;
    source: HybridResultSource;
}

/**
 * Default settings for hybrid search
 */
export const DEFAULT_HYBRID_SEARCH_SETTINGS: HybridSearchSettings = {
    enabled: false, // Disabled by default until user enables
    rrfK: 60,
    keywordWeight: 0.5,
    semanticWeight: 0.5,
    enableReRanking: true,
    reRankPoolSize: 20,
    reRankTitleWeight: 0.25,
    reRankRecencyWeight: 0.15,
    reRankUsageWeight: 0.15,
    reRankContentWeight: 0.25,
    reRankPageRankWeight: 0.2,
    reRankProximityWeight: 0.15,
    maxResults: 20,
    minScoreThreshold: 0.1,
    searchTimeoutMs: 5000,
    showMatchReasons: true,
    searchHotkey: 'h',
    enableClustering: false,
    clusterSimilarityThreshold: 0.85,
};
