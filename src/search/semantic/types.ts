/**
 * Types for semantic search functionality using Ollama embeddings
 */

import { TFile } from 'obsidian';

export interface EmbeddingCache {
  version: string;
  lastUpdated: number;
  embeddings: Record<string, {
    embedding: number[]; // Store as regular array for JSON serialization
    lastModified: number;
    contentHash: string;
    chunks?: number; // For chunked documents
  }>;
}

export interface SemanticSearchResult {
  file: TFile;
  similarity: number;
  relevanceScore: number;
  title: string;
  excerpt: string;
  matches: {
    titleMatch: boolean;
    tagMatch: boolean;
    recentlyModified: boolean;
  };
}

export interface SemanticSearchSettings {
  enableSemanticSearch: boolean;
  ollamaUrl: string;
  searchThreshold: number;
  maxResults: number;
  chunkSize: number;
  maxConcurrentRequests: number;
  cacheEnabled: boolean;
  excludePatterns: string[]; // Array of glob patterns to exclude from indexing
}
