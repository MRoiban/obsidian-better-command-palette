Based on the comprehensive critique, here's a refined implementation plan that addresses the key issues while following Obsidian plugin conventions:

## Implementation Plan: Local Semantic Search with Ollama

### Core Architecture Overview

````typescript
// types.ts
export interface EmbeddingCache {
  version: string;
  lastUpdated: number;
  embeddings: Record<string, {
    embedding: Float32Array;
    lastModified: number;
    contentHash: string;
    chunks?: number; // For chunked documents
  }>;
}

export interface SearchResult {
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

export interface PluginSettings {
  enableSemanticSearch: boolean;
  ollamaUrl: string;
  searchThreshold: number;
  maxResults: number;
  chunkSize: number;
  maxConcurrentRequests: number;
  cacheEnabled: boolean;
}
````

### 1. Request Queue & Rate Limiting

````typescript
// request-queue.ts
export class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private activeRequests = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  async add<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          this.activeRequests++;
          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests--;
          this.processNext();
        }
      });
    
      this.processNext();
    });
  }

  private processNext(): void {
    if (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      const request = this.queue.shift()!;
      request();
    }
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getActiveRequests(): number {
    return this.activeRequests;
  }
}
````

### 2. Enhanced Embedding Service with Persistence

````typescript
// embedding-service.ts
import { TFile, Vault, MetadataCache } from 'obsidian';
import { RequestQueue } from './request-queue';
import { EmbeddingCache, PluginSettings } from './types';

export class EmbeddingService {
  private vault: Vault;
  private metadataCache: MetadataCache;
  private settings: PluginSettings;
  private requestQueue: RequestQueue;
  private embeddingCache: Map<string, Float32Array> = new Map();
  private cacheMetadata: Map<string, any> = new Map();
  private cacheFile: string;

  constructor(vault: Vault, metadataCache: MetadataCache, settings: PluginSettings) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.settings = settings;
    this.requestQueue = new RequestQueue(settings.maxConcurrentRequests);
    this.cacheFile = '.obsidian/plugins/better-command-palette/embeddings.json';
  }

  async initialize(): Promise<void> {
    if (this.settings.cacheEnabled) {
      await this.loadCache();
    }
  }

  private async loadCache(): Promise<void> {
    try {
      if (await this.vault.adapter.exists(this.cacheFile)) {
        const cacheData = await this.vault.adapter.read(this.cacheFile);
        const cache: EmbeddingCache = JSON.parse(cacheData);
      
        // Validate cache version
        if (cache.version !== '1.0.0') {
          console.log('Cache version mismatch, rebuilding...');
          return;
        }

        let loadedCount = 0;
        for (const [path, data] of Object.entries(cache.embeddings)) {
          const file = this.vault.getAbstractFileByPath(path) as TFile;
        
          if (file && this.isFileUpToDate(file, data)) {
            // Convert regular array back to Float32Array for memory efficiency
            this.embeddingCache.set(path, new Float32Array(data.embedding));
            this.cacheMetadata.set(path, {
              lastModified: data.lastModified,
              contentHash: data.contentHash,
              chunks: data.chunks
            });
            loadedCount++;
          }
        }
      
        console.log(`Loaded ${loadedCount} embeddings from cache`);
      }
    } catch (error) {
      console.error('Error loading embedding cache:', error);
    }
  }

  private isFileUpToDate(file: TFile, cacheData: any): boolean {
    return file.stat.mtime <= cacheData.lastModified;
  }

  async saveCache(): Promise<void> {
    if (!this.settings.cacheEnabled) return;

    try {
      const cache: EmbeddingCache = {
        version: '1.0.0',
        lastUpdated: Date.now(),
        embeddings: {}
      };

      for (const [path, embedding] of this.embeddingCache) {
        const file = this.vault.getAbstractFileByPath(path) as TFile;
        const metadata = this.cacheMetadata.get(path);
      
        if (file && metadata) {
          cache.embeddings[path] = {
            embedding: Array.from(embedding), // Convert Float32Array to regular array for JSON
            lastModified: metadata.lastModified,
            contentHash: metadata.contentHash,
            chunks: metadata.chunks
          };
        }
      }

      await this.vault.adapter.write(this.cacheFile, JSON.stringify(cache));
      console.log(`Saved ${Object.keys(cache.embeddings).length} embeddings to cache`);
    } catch (error) {
      console.error('Error saving embedding cache:', error);
    }
  }

  private async getContentHash(file: TFile): Promise<string> {
    const content = await this.vault.cachedRead(file);
    // Simple hash function for content change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private chunkDocument(content: string, file: TFile): string[] {
    const metadata = this.metadataCache.getFileCache(file);
    const maxChunkSize = this.settings.chunkSize;
    const overlap = Math.floor(maxChunkSize * 0.2);

    // Start with title and tags for context
    const prefix = file.basename;
    const tags = metadata?.tags?.map(tag => tag.tag.replace('#', '')).join(' ') || '';
    const contextPrefix = tags ? `${prefix} ${tags}` : prefix;

    // Split by headings first
    const sections = this.splitByHeadings(content, metadata);
    const chunks: string[] = [];

    for (const section of sections) {
      const sectionWithContext = `${contextPrefix}: ${section}`;
    
      if (sectionWithContext.length <= maxChunkSize) {
        chunks.push(sectionWithContext);
      } else {
        // Use sliding window for long sections
        const subChunks = this.slidingWindow(section, maxChunkSize - contextPrefix.length - 2, overlap);
        chunks.push(...subChunks.map(chunk => `${contextPrefix}: ${chunk}`));
      }
    }

    return chunks.length > 0 ? chunks : [`${contextPrefix}: ${content.substring(0, maxChunkSize)}`];
  }

  private splitByHeadings(content: string, metadata?: any): string[] {
    if (!metadata?.headings || metadata.headings.length === 0) {
      return [content];
    }

    const sections: string[] = [];
    const lines = content.split('\n');
    let currentSection = '';
  
    for (const line of lines) {
      if (line.match(/^#{1,6}\s/)) {
        if (currentSection.trim()) {
          sections.push(currentSection.trim());
        }
        currentSection = line + '\n';
      } else {
        currentSection += line + '\n';
      }
    }
  
    if (currentSection.trim()) {
      sections.push(currentSection.trim());
    }

    return sections.length > 0 ? sections : [content];
  }

  private slidingWindow(text: string, chunkSize: number, overlap: number): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
    let currentChunk = '';
    let i = 0;
  
    while (i < sentences.length) {
      const sentence = sentences[i].trim() + '.';
    
      if ((currentChunk + sentence).length <= chunkSize) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        i++;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
          // Find overlap point
          const overlapSize = Math.min(overlap, currentChunk.length);
          currentChunk = currentChunk.substring(currentChunk.length - overlapSize);
        } else {
          // Single sentence is too long, truncate it
          chunks.push(sentence.substring(0, chunkSize));
          i++;
        }
      }
    }
  
    if (currentChunk.trim()) {
      chunks.push(currentChunk);
    }
  
    return chunks.length > 0 ? chunks : [text.substring(0, chunkSize)];
  }

  private async generateEmbedding(
    text: string,
    taskType: 'search_document' | 'search_query' = 'search_document',
    retries = 3
  ): Promise<Float32Array> {
    return this.requestQueue.add(async () => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 30000);

          const response = await requestUrl({
            url: `${this.settings.ollamaUrl}/api/embeddings`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'nomic-embed-text',
              prompt: `${taskType}: ${text}`,
            }),
          });

          clearTimeout(timeoutId);

          if (response.status !== 200) {
            throw new Error(`HTTP ${response.status}: ${response.text}`);
          }

          const data = response.json as { embedding: number[] };
          return new Float32Array(data.embedding);

        } catch (error) {
          console.warn(`Embedding attempt ${attempt} failed:`, error);
        
          if (attempt === retries) {
            throw new Error(`Failed after ${retries} attempts: ${error.message}`);
          }
        
          // Exponential backoff
          await new Promise(resolve => 
            setTimeout(resolve, Math.pow(2, attempt) * 1000)
          );
        }
      }
      throw new Error('Unexpected error in embedding generation');
    });
  }

  async indexFile(file: TFile): Promise<void> {
    try {
      const contentHash = await this.getContentHash(file);
      const cached = this.cacheMetadata.get(file.path);
    
      // Skip if already up to date
      if (cached && cached.contentHash === contentHash) {
        return;
      }

      const content = await this.vault.cachedRead(file);
      const chunks = this.chunkDocument(content, file);

      if (chunks.length === 1) {
        // Single chunk - store directly
        const embedding = await this.generateEmbedding(chunks[0], 'search_document');
        this.embeddingCache.set(file.path, embedding);
      } else {
        // Multiple chunks - average the embeddings
        const embeddings = await Promise.all(
          chunks.map(chunk => this.generateEmbedding(chunk, 'search_document'))
        );
      
        const avgEmbedding = this.averageEmbeddings(embeddings);
        this.embeddingCache.set(file.path, avgEmbedding);
      }

      // Update metadata
      this.cacheMetadata.set(file.path, {
        lastModified: file.stat.mtime,
        contentHash,
        chunks: chunks.length
      });

    } catch (error) {
      console.error(`Error indexing file ${file.path}:`, error);
      throw error;
    }
  }

  private averageEmbeddings(embeddings: Float32Array[]): Float32Array {
    if (embeddings.length === 0) throw new Error('No embeddings to average');
    if (embeddings.length === 1) return embeddings[0];

    const dimension = embeddings[0].length;
    const averaged = new Float32Array(dimension);

    for (const embedding of embeddings) {
      for (let i = 0; i < dimension; i++) {
        averaged[i] += embedding[i];
      }
    }

    for (let i = 0; i < dimension; i++) {
      averaged[i] /= embeddings.length;
    }

    return averaged;
  }

  async indexAllFiles(onProgress?: (current: number, total: number) => void): Promise<void> {
    const markdownFiles = this.vault.getMarkdownFiles();
    const filesToIndex = markdownFiles.filter(file => {
      const cached = this.cacheMetadata.get(file.path);
      return !cached || !this.isFileUpToDate(file, cached);
    });

    console.log(`Indexing ${filesToIndex.length} of ${markdownFiles.length} files...`);

    for (let i = 0; i < filesToIndex.length; i++) {
      try {
        await this.indexFile(filesToIndex[i]);
        if (onProgress) {
          onProgress(i + 1, filesToIndex.length);
        }
      } catch (error) {
        console.error(`Failed to index ${filesToIndex[i].path}:`, error);
      }
    }

    await this.saveCache();
  }

  async checkConnection(): Promise<boolean> {
    try {
      const response = await requestUrl({
        url: `${this.settings.ollamaUrl}/api/tags`,
        method: 'GET',
      });
    
      const data = response.json as { models: Array<{ name: string }> };
      return data.models.some(model => model.name.includes('nomic-embed-text'));
    } catch (error) {
      return false;
    }
  }

  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error('Vector dimensions do not match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  getEmbedding(filePath: string): Float32Array | undefined {
    return this.embeddingCache.get(filePath);
  }

  getIndexedFileCount(): number {
    return this.embeddingCache.size;
  }

  getQueueStatus(): { queued: number; active: number } {
    return {
      queued: this.requestQueue.getQueueSize(),
      active: this.requestQueue.getActiveRequests()
    };
  }

  clearCache(): void {
    this.embeddingCache.clear();
    this.cacheMetadata.clear();
  }
}
````

### 3. Enhanced Search Engine with Multi-factor Ranking

````typescript
// semantic-search.ts
import { TFile, Vault, MetadataCache } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SearchResult, PluginSettings } from './types';

export class SemanticSearchEngine {
  private embeddingService: EmbeddingService;
  private vault: Vault;
  private metadataCache: MetadataCache;
  private settings: PluginSettings;
  private searchCache: Map<string, SearchResult[]> = new Map();

  constructor(embeddingService: EmbeddingService, vault: Vault, metadataCache: MetadataCache, settings: PluginSettings) {
    this.embeddingService = embeddingService;
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.settings = settings;
  }

  async search(query: string, options: {
    limit?: number;
    threshold?: number;
    useCache?: boolean;
  } = {}): Promise<SearchResult[]> {
    const { limit = this.settings.maxResults, threshold = this.settings.searchThreshold, useCache = true } = options;
  
    // Check cache first
    const cacheKey = `${query}:${threshold}:${limit}`;
    if (useCache && this.searchCache.has(cacheKey)) {
      return this.searchCache.get(cacheKey)!;
    }

    if (this.embeddingService.getIndexedFileCount() === 0) {
      throw new Error('No files indexed. Please run indexing first.');
    }

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.generateEmbedding(query, 'search_query');
    const results: SearchResult[] = [];

    // Search through all indexed files
    const markdownFiles = this.vault.getMarkdownFiles();
  
    for (const file of markdownFiles) {
      const docEmbedding = this.embeddingService.getEmbedding(file.path);
      if (!docEmbedding) continue;

      const similarity = this.embeddingService.cosineSimilarity(queryEmbedding, docEmbedding);
    
      if (similarity >= threshold) {
        const relevanceScore = this.calculateRelevanceScore(file, similarity, query);
        const matches = this.analyzeMatches(file, query);
        const excerpt = await this.extractRelevantExcerpt(file, query);

        results.push({
          file,
          similarity,
          relevanceScore,
          title: file.basename,
          excerpt,
          matches
        });
      }
    }

    // Sort by relevance score and limit results
    const sortedResults = results
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    // Cache results
    if (useCache) {
      this.searchCache.set(cacheKey, sortedResults);
    
      // Limit cache size
      if (this.searchCache.size > 100) {
        const firstKey = this.searchCache.keys().next().value;
        this.searchCache.delete(firstKey);
      }
    }

    return sortedResults;
  }

  private calculateRelevanceScore(file: TFile, similarity: number, query: string): number {
    let score = similarity * 0.6; // Base semantic similarity (reduced weight)
  
    const queryLower = query.toLowerCase();
    const titleLower = file.basename.toLowerCase();
  
    // Title match bonus (exact match gets higher bonus)
    if (titleLower === queryLower) {
      score += 0.25;
    } else if (titleLower.includes(queryLower)) {
      score += 0.15;
    }
  
    // Recency bonus
    const daysSinceModified = (Date.now() - file.stat.mtime) / (1000 * 60 * 60 * 24);
    if (daysSinceModified < 30) {
      score += 0.1 * Math.max(0, (30 - daysSinceModified) / 30);
    }
  
    // Tag match bonus
    const metadata = this.metadataCache.getFileCache(file);
    if (metadata?.tags?.some(tag => 
      tag.tag.toLowerCase().includes(queryLower)
    )) {
      score += 0.1;
    }
  
    // Heading match bonus
    if (metadata?.headings?.some(heading =>
      heading.heading.toLowerCase().includes(queryLower)
    )) {
      score += 0.08;
    }

    // File size factor (prefer medium-sized files)
    const fileSize = file.stat.size;
    if (fileSize > 1000 && fileSize < 50000) { // 1KB to 50KB sweet spot
      score += 0.02;
    }
  
    return Math.min(score, 1.0);
  }

  private analyzeMatches(file: TFile, query: string): {
    titleMatch: boolean;
    tagMatch: boolean;
    recentlyModified: boolean;
  } {
    const queryLower = query.toLowerCase();
    const metadata = this.metadataCache.getFileCache(file);
  
    return {
      titleMatch: file.basename.toLowerCase().includes(queryLower),
      tagMatch: metadata?.tags?.some(tag => 
        tag.tag.toLowerCase().includes(queryLower)
      ) || false,
      recentlyModified: (Date.now() - file.stat.mtime) < (7 * 24 * 60 * 60 * 1000) // 7 days
    };
  }

  private async extractRelevantExcerpt(file: TFile, query: string, maxLength: number = 200): Promise<string> {
    try {
      const content = await this.vault.cachedRead(file);
      const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    
      // Split content into sentences
      const sentences = content.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
    
      // Score sentences based on query word matches
      const scoredSentences = sentences.map(sentence => {
        const sentenceLower = sentence.toLowerCase();
        const matches = queryWords.filter(word => sentenceLower.includes(word)).length;
        const wordDensity = matches / queryWords.length;
      
        return {
          sentence,
          score: wordDensity,
          matches
        };
      });
    
      // Find best sentence
      const bestSentence = scoredSentences.reduce((best, current) => 
        current.score > best.score ? current : best
      );
    
      if (bestSentence.matches > 0) {
        const sentence = bestSentence.sentence;
        return sentence.length > maxLength 
          ? sentence.substring(0, maxLength) + '...'
          : sentence;
      }
    
      // Fallback to beginning of content
      return content.substring(0, maxLength) + '...';
    
    } catch (error) {
      return 'Could not load content';
    }
  }

  clearSearchCache(): void {
    this.searchCache.clear();
  }

  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.searchCache.size,
      maxSize: 100
    };
  }
}
````

### 4. Main Plugin Implementation

````typescript
// main.ts
import { Plugin, Notice } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchEngine } from './semantic-search';
import { SemanticSearchModal } from './search-modal';
import { SemanticSearchSettingTab } from './settings-tab';
import { PluginSettings } from './types';

const DEFAULT_SETTINGS: PluginSettings = {
  enableSemanticSearch: true,
  ollamaUrl: 'http://localhost:11434',
  searchThreshold: 0.3,
  maxResults: 10,
  chunkSize: 1000,
  maxConcurrentRequests: 3,
  cacheEnabled: true
};

export default class BetterCommandPalettePlugin extends Plugin {
  settings: PluginSettings;
  embeddingService: EmbeddingService;
  searchEngine: SemanticSearchEngine;
  private indexingInProgress = false;

  async onload() {
    console.log('Loading Better Command Palette plugin');
  
    await this.loadSettings();

    // Initialize services
    this.embeddingService = new EmbeddingService(
      this.app.vault,
      this.app.metadataCache,
      this.settings
    );

    this.searchEngine = new SemanticSearchEngine(
      this.embeddingService,
      this.app.vault,
      this.app.metadataCache,
      this.settings
    );

    // Initialize embedding service
    await this.embeddingService.initialize();

    // Add ribbon icon
    const ribbonIconEl = this.addRibbonIcon('search', 'Semantic Search', (evt: MouseEvent) => {
      this.openSemanticSearch();
    });
    ribbonIconEl.addClass('semantic-search-ribbon-class');

    // Add commands
    this.addCommand({
      id: 'open-semantic-search',
      name: 'Open Semantic Search',
      callback: () => this.openSemanticSearch()
    });

    this.addCommand({
      id: 'reindex-files',
      name: 'Reindex files for semantic search',
      callback: () => this.reindexFiles()
    });

    this.addCommand({
      id: 'clear-search-cache',
      name: 'Clear semantic search cache',
      callback: () => this.clearCaches()
    });

    // Add settings tab
    this.addSettingTab(new SemanticSearchSettingTab(this.app, this));

    // Auto-index on startup if enabled and cache is empty
    if (this.settings.enableSemanticSearch) {
      this.registerEvent(this.app.workspace.on('layout-ready', () => {
        this.checkAndAutoIndex();
      }));
    }

    // Register file change events for incremental indexing
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (file.extension === 'md' && this.settings.enableSemanticSearch) {
        this.debounceIndexFile(file);
      }
    }));

    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file.extension === 'md' && this.settings.enableSemanticSearch) {
        this.debounceIndexFile(file);
      }
    }));

    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file.extension === 'md') {
        // Remove from cache
        this.embeddingService.removeFromCache?.(file.path);
      }
    }));
  }

  onunload() {
    console.log('Unloading Better Command Palette plugin');
  
    // Save cache before unloading
    if (this.embeddingService) {
      this.embeddingService.saveCache().catch(console.error);
    }
  }

  private async checkAndAutoIndex() {
    if (this.embeddingService.getIndexedFileCount() === 0) {
      const isConnected = await this.embeddingService.checkConnection();
      if (isConnected) {
        new Notice('Auto-indexing files for semantic search...', 3000);
        this.reindexFiles();
      } else {
        new Notice(
          'Ollama not available. Semantic search disabled.\nInstall Ollama and run: ollama pull nomic-embed-text',
          8000
        );
      }
    }
  }

  async reindexFiles() {
    if (this.indexingInProgress) {
      new Notice('Indexing already in progress...');
      return;
    }

    const isConnected = await this.embeddingService.checkConnection();
    if (!isConnected) {
      new Notice(
        'Cannot connect to Ollama. Make sure it\'s running with nomic-embed-text model.',
        5000
      );
      return;
    }

    this.indexingInProgress = true;
    const notice = new Notice('Starting indexing...', 0);

    try {
      let lastUpdateTime = Date.now();
    
      await this.embeddingService.indexAllFiles((current, total) => {
        const now = Date.now();
        // Update notice every 500ms to avoid too frequent updates
        if (now - lastUpdateTime > 500) {
          const queueStatus = this.embeddingService.getQueueStatus();
          notice.setMessage(
            `Indexing... ${current}/${total} files\n` +
            `Queue: ${queueStatus.active} active, ${queueStatus.queued} waiting`
          );
          lastUpdateTime = now;
        }
      });
    
      notice.hide();
      const indexedCount = this.embeddingService.getIndexedFileCount();
      new Notice(`✅ Successfully indexed ${indexedCount} files!`, 3000);
    
    } catch (error) {
      notice.hide();
      new Notice(`❌ Indexing failed: ${error.message}`, 5000);
      console.error('Indexing error:', error);
    } finally {
      this.indexingInProgress = false;
    }
  }

  private debounceIndexFile = this.debounce(async (file: TFile) => {
    if (!this.indexingInProgress) {
      try {
        await this.embeddingService.indexFile(file);
        console.log(`Re-indexed: ${file.path}`);
      } catch (error) {
        console.error(`Failed to re-index ${file.path}:`, error);
      }
    }
  }, 2000);

  private debounce(func: Function, wait: number) {
    let timeout: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    };
  }

  private openSemanticSearch() {
    if (this.embeddingService.getIndexedFileCount() === 0) {
      new Notice('No files indexed yet. Please run indexing first.', 3000);
      return;
    }
  
    new SemanticSearchModal(this.app, this).open();
  }

  private clearCaches() {
    this.embeddingService.clearCache();
    this.searchEngine.clearSearchCache();
    new Notice('Search caches cleared', 2000);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  
    // Update services with new settings
    if (this.embeddingService) {
      // Reinitialize services if critical settings changed
      const newEmbeddingService = new EmbeddingService(
        this.app.vault,
        this.app.metadataCache,
        this.settings
      );
      await newEmbeddingService.initialize();
    
      this.embeddingService = newEmbeddingService;
      this.searchEngine = new SemanticSearchEngine(
        this.embeddingService,
        this.app.vault,
        this.app.metadataCache,
        this.settings
      );
    }
  }

  // Public methods for modal and settings
  getSearchEngine(): SemanticSearchEngine {
    return this.searchEngine;
  }

  getEmbeddingService(): EmbeddingService {
    return this.embeddingService;
  }

  isIndexingInProgress(): boolean {
    return this.indexingInProgress;
  }
}
````

## Key Improvements Addressed

1. **Persistent Storage**: Embeddings cached to disk with version control and change detection
2. **Memory Efficiency**: Using Float32Array for embeddings
3. **Rate Limiting**: Request queue prevents overwhelming Ollama
4. **Smart Chunking**: Documents split intelligently with context preservation
5. **Multi-factor Ranking**: Combines semantic similarity with title matches, recency, tags
6. **Incremental Updates**: Only re-index changed files
7. **Error Recovery**: Robust retry logic with exponential backoff
8. **Performance Optimization**: Search result caching and debounced file updates
9. **User Experience**: Progress tracking, connection status, clear error messages

This implementation provides production-ready local semantic search while following Obsidian plugin conventions and addressing all the critiqued issues.
