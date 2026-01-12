/**
 * Types for semantic search functionality using Ollama embeddings
 */

import { TFile } from 'obsidian';

export interface EmbeddingCache {
    version: string; // "2.0.0" for chunk-based embeddings
    lastUpdated: number;
    // Optional metadata about the embedding configuration
    model?: string;
    dimension?: number;
    embeddings: Record<string, FileEmbeddingData>;
}

/**
 * Embedding data for a single file, containing multiple chunk embeddings
 */
export interface FileEmbeddingData {
    lastModified: number;
    contentHash: string;
    chunks: ChunkEmbedding[];
}

/**
 * A single chunk's embedding with its source text for context
 */
export interface ChunkEmbedding {
    embedding: number[]; // Store as regular array for JSON serialization
    text: string; // Original chunk text (for excerpts and context)
    startLine?: number; // Optional: line position in file for navigation
}

export interface SemanticSearchResult {
    file: TFile;
    similarity: number;
    relevanceScore: number;
    title: string;
    excerpt: string;
    matchedChunkIndex?: number; // Which chunk matched best
    matchedChunkText?: string;  // The matched chunk's content
    matches: {
        titleMatch: boolean;
        tagMatch: boolean;
        recentlyModified: boolean;
    };
}

export interface SemanticSearchSettings {
    enableSemanticSearch: boolean;
    ollamaUrl: string;
    embeddingModel?: string; // Embedding model name in Ollama (e.g., nomic-embed-text, bge-m3)
    searchThreshold: number;
    maxResults: number;
    chunkSize: number;
    // Concurrency settings
    maxConcurrentRequests: number; // User-configurable ceiling (1-10)
    enableAdaptiveThrottling: boolean; // Smart throttling that adjusts based on Ollama response times
    cacheEnabled: boolean;
    excludePatterns: string[]; // Array of glob patterns to exclude from indexing
    preserveQuery: boolean; // Preserve search query when switching modes (default: false)
}
