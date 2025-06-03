/**
 * Embedding service for generating and managing document embeddings using Ollama
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
// @ts-ignore
import { requestUrl } from 'obsidian';
import { RequestQueue } from './request-queue';
import { EmbeddingCache, SemanticSearchSettings } from './types';
import { logger } from '../../utils/logger';
import { generateContentHashBase36 } from '../../utils/hash';

export class EmbeddingService {
  private vault: Vault;
  private metadataCache: MetadataCache;
  private settings: SemanticSearchSettings;
  private requestQueue: RequestQueue;
  private embeddingCache: Map<string, Float32Array> = new Map();
  private cacheMetadata: Map<string, any> = new Map();
  private cacheFile: string;

  constructor(vault: Vault, metadataCache: MetadataCache, settings: SemanticSearchSettings) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.settings = settings;
    this.requestQueue = new RequestQueue(settings.maxConcurrentRequests);
    this.cacheFile = '.obsidian/plugins/obsidian-better-command-palette/embeddings.json';
    
    logger.debug(`Semantic search: EmbeddingService initialized with cache file: ${this.cacheFile}`);
    logger.debug(`Semantic search: Cache enabled: ${settings.cacheEnabled}`);
  }

  async initialize(): Promise<void> {
    logger.debug('Semantic search: Initializing EmbeddingService...');
    if (this.settings.cacheEnabled) {
      logger.debug('Semantic search: Cache is enabled, attempting to load existing cache...');
      await this.loadCache();
    } else {
      logger.debug('Semantic search: Cache is disabled, skipping cache load');
    }
    logger.debug(`Semantic search: EmbeddingService initialization complete. ${this.embeddingCache.size} embeddings loaded from cache.`);
  }

  private async loadCache(): Promise<void> {
    try {
      logger.debug(`Semantic search: Attempting to load cache from ${this.cacheFile}`);
      
      if (await this.vault.adapter.exists(this.cacheFile)) {
        logger.debug('Semantic search: Cache file exists, reading...');
        const cacheData = await this.vault.adapter.read(this.cacheFile);
        const cache: EmbeddingCache = JSON.parse(cacheData);
        
        logger.debug(`Semantic search: Cache loaded with version ${cache.version}, ${Object.keys(cache.embeddings).length} embeddings`);
      
        // Validate cache version
        if (cache.version !== '1.0.0') {
          logger.debug('Semantic search: Cache version mismatch, rebuilding...');
          return;
        }

        let loadedCount = 0;
        let skippedCount = 0;
        for (const [path, data] of Object.entries(cache.embeddings)) {
          const file = this.vault.getAbstractFileByPath(path) as TFile;
        
          if (!file) {
            logger.debug(`Semantic search: File ${path} no longer exists, skipping cache entry`);
            skippedCount++;
            continue;
          }
          
          if (this.isFileUpToDate(file, data)) {
            // Convert regular array back to Float32Array for memory efficiency
            this.embeddingCache.set(path, new Float32Array(data.embedding));
            this.cacheMetadata.set(path, {
              lastModified: data.lastModified,
              contentHash: data.contentHash,
              chunks: data.chunks
            });
            loadedCount++;
            logger.debug(`Semantic search: Loaded cached embedding for ${path} (modified: ${new Date(data.lastModified).toISOString()})`);
          } else {
            logger.debug(`Semantic search: File ${path} is newer than cache (file: ${new Date(file.stat.mtime).toISOString()}, cache: ${new Date(data.lastModified).toISOString()}), skipping`);
            skippedCount++;
          }
        }
      
        logger.debug(`Semantic search: Loaded ${loadedCount} embeddings from cache, skipped ${skippedCount}`);
      } else {
        logger.debug('Semantic search: Cache file does not exist, starting fresh');
      }
    } catch (error) {
      logger.error('Semantic search: Error loading embedding cache:', error);
    }
  }

  private isFileUpToDate(file: TFile, cacheData: any): boolean {
    return file.stat.mtime <= cacheData.lastModified;
  }

  async saveCache(): Promise<void> {
    if (!this.settings.cacheEnabled) {
      logger.debug('Semantic search: Cache is disabled, skipping save');
      return;
    }

    try {
      logger.debug(`Semantic search: Starting cache save with ${this.embeddingCache.size} embeddings in memory`);
      logger.debug(`Semantic search: Saving cache to: ${this.cacheFile}`);
      
      const cache: EmbeddingCache = {
        version: '1.0.0',
        lastUpdated: Date.now(),
        embeddings: {}
      };

      let savedCount = 0;
      let skippedCount = 0;
      
      for (const [path, embedding] of this.embeddingCache) {
        const file = this.vault.getAbstractFileByPath(path) as TFile;
        const metadata = this.cacheMetadata.get(path);
        
        if (!file) {
          logger.debug(`Semantic search: File ${path} no longer exists, skipping cache save`);
          skippedCount++;
          continue;
        }
        
        if (!metadata) {
          logger.debug(`Semantic search: No metadata for ${path}, skipping cache save`);
          skippedCount++;
          continue;
        }
      
        cache.embeddings[path] = {
          embedding: Array.from(embedding), // Convert Float32Array to regular array for JSON
          lastModified: metadata.lastModified,
          contentHash: metadata.contentHash,
          chunks: metadata.chunks
        };
        savedCount++;
        logger.debug(`Semantic search: Prepared ${path} for cache save (${embedding.length} dimensions, ${metadata.chunks} chunks)`);
      }

      logger.debug(`Semantic search: Writing cache file with ${savedCount} embeddings (${skippedCount} skipped) to ${this.cacheFile}`);
      
      await this.vault.adapter.write(this.cacheFile, JSON.stringify(cache));
      logger.debug(`Semantic search: Successfully saved ${savedCount} embeddings to cache file`);
      
      // Verify the file was created
      const exists = await this.vault.adapter.exists(this.cacheFile);
      logger.debug(`Semantic search: Cache file exists after write: ${exists}`);
      if (exists) {
        const stat = await this.vault.adapter.stat(this.cacheFile);
        logger.debug(`Semantic search: Cache file size: ${stat?.size} bytes`);
      }
    } catch (error) {
      logger.error('Semantic search: Error saving embedding cache:', error);
      logger.error('Semantic search: Cache file path:', this.cacheFile);
      logger.error('Semantic search: Error details:', error);
    }
  }

  private async getContentHash(file: TFile): Promise<string> {
    const content = await this.vault.cachedRead(file);
    return generateContentHashBase36(content);
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
    if (!text || text.length === 0) {
      return [''];
    }

    const chunks: string[] = [];
    // Split by sentences more carefully, handling edge cases
    const sentences = text.split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => s + '.');

    if (sentences.length === 0) {
      return [text.substring(0, chunkSize)];
    }

    let currentChunk = '';
    let i = 0;

    while (i < sentences.length) {
      const sentence = sentences[i];
      
      // Check if sentence exists and handle undefined case
      if (!sentence) {
        i++;
        continue;
      }
      
      // If a single sentence is longer than chunkSize, split it
      if (sentence.length > chunkSize) {
        if (currentChunk) {
          chunks.push(currentChunk);
          currentChunk = '';
        }
        // Split long sentence into smaller chunks
        for (let j = 0; j < sentence.length; j += chunkSize) {
          chunks.push(sentence.substring(j, j + chunkSize));
        }
        i++;
        continue;
      }

      // Normal case: add sentence to current chunk if it fits
      if ((currentChunk + (currentChunk ? ' ' : '') + sentence).length <= chunkSize) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
        i++;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
          // Find overlap point, ensuring we don't exceed chunkSize
          const overlapSize = Math.min(overlap, currentChunk.length);
          currentChunk = currentChunk.substring(currentChunk.length - overlapSize);
        } else {
          // This should never happen due to the sentence length check above,
          // but adding as a safety measure
          chunks.push(sentence);
          i++;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk);
    }

    return chunks.length > 0 ? chunks : [text.substring(0, chunkSize)];
  }

  async generateEmbedding(
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
          logger.warn(`Semantic search: Embedding attempt ${attempt} failed:`, error);
        
          if (attempt === retries) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed after ${retries} attempts: ${errorMessage}`);
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

  /**
   * Check if a file should be excluded from indexing based on exclusion patterns
   */
  public shouldExcludeFile(file: TFile): boolean {
    if (!this.settings.excludePatterns || this.settings.excludePatterns.length === 0) {
      logger.debug(`Semantic search: No exclusion patterns configured for ${file.path}`);
      return false;
    }

    logger.debug(`Semantic search: Checking exclusion patterns for ${file.path}`);
    logger.debug(`Semantic search: Available patterns: [${this.settings.excludePatterns.join(', ')}]`);

    // Check if file path matches any exclusion pattern
    return this.settings.excludePatterns.some(pattern => {
      try {
        // Convert glob pattern to regex more accurately
        let regexPattern = pattern
          .replace(/\./g, '\\.') // Escape dots
          .replace(/\*\*/g, '__DOUBLESTAR__') // Temporarily replace ** 
          .replace(/\*/g, '[^/]*') // Convert single * to match anything except path separators
          .replace(/__DOUBLESTAR__/g, '.*') // Convert ** to match everything including path separators
          .replace(/\?/g, '[^/]') // Convert ? to match single character except path separator
          .replace(/\//g, '\\/'); // Escape forward slashes
        
        // Ensure pattern matches from start if it starts with **/ or /
        if (pattern.startsWith('**/') || pattern.startsWith('/')) {
          regexPattern = '^' + regexPattern;
        } else {
          // If pattern doesn't start with **/ or /, match anywhere in path
          regexPattern = '(^|/)' + regexPattern;
        }
        
        // Ensure pattern matches to end if it doesn't end with **
        if (!pattern.endsWith('**')) {
          regexPattern = regexPattern + '$';
        }
        
        const regex = new RegExp(regexPattern);
        const matches = regex.test(file.path);
        
        logger.debug(`Semantic search: Pattern "${pattern}" -> Regex "${regexPattern}" -> Match: ${matches} for ${file.path}`);
        
        if (matches) {
          logger.debug(`Semantic search: File ${file.path} excluded by pattern: ${pattern}`);
        }
        
        return matches;
      } catch (e) {
        logger.warn(`Semantic search: Invalid exclusion pattern: ${pattern}`, e);
        return false;
      }
    });
  }

  async indexFile(file: TFile): Promise<void> {
    try {
      const startTime = Date.now();
      
      // Skip excluded files
      if (this.shouldExcludeFile(file)) {
        logger.debug(`Semantic search: Skipping excluded file ${file.path}`);
        return;
      }

      logger.debug(`Semantic search: Starting indexing of ${file.path}...`);
      
      // Check if file is already up-to-date
      const existingMetadata = this.cacheMetadata.get(file.path);
      if (existingMetadata && this.isFileUpToDate(file, existingMetadata)) {
        logger.debug(`Semantic search: File ${file.path} is already up-to-date in cache`);
        return;
      }

      // Get content hash for change detection
      const contentHash = await this.getContentHash(file);
      logger.debug(`Semantic search: Content hash for ${file.path}: ${contentHash}`);
      
      // Check if content actually changed
      if (existingMetadata && existingMetadata.contentHash === contentHash) {
        logger.debug(`Semantic search: Content unchanged for ${file.path}, updating metadata only`);
        this.cacheMetadata.set(file.path, {
          ...existingMetadata,
          lastModified: file.stat.mtime
        });
        return;
      }

      // Read and chunk the document
      const content = await this.vault.cachedRead(file);
      logger.debug(`Semantic search: Read ${content.length} characters from ${file.path}`);
      
      if (!content || content.trim().length === 0) {
        logger.debug(`Semantic search: Skipping empty file ${file.path}`);
        return;
      }

      const chunks = this.chunkDocument(content, file);
      logger.debug(`Semantic search: Split ${file.path} into ${chunks.length} chunks`);

      if (chunks.length === 0 || (chunks.length === 1 && chunks[0]?.trim().length === 0)) {
        logger.debug(`Semantic search: No meaningful content in ${file.path}, skipping`);
        return;
      }

      // Generate embeddings for all chunks
      const embeddings: Float32Array[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) {
          continue; // Skip undefined chunks
        }
        
        logger.debug(`Semantic search: Generating embedding for chunk ${i + 1}/${chunks.length} of ${file.path} (${chunk.length} chars)`);
        
        try {
          const embedding = await this.generateEmbedding(chunk, 'search_document');
          embeddings.push(embedding);
          logger.debug(`Semantic search: Generated embedding for chunk ${i + 1}/${chunks.length} of ${file.path}`);
        } catch (error) {
          logger.error(`Semantic search: Failed to generate embedding for chunk ${i + 1} of ${file.path}:`, error);
        }
      }

      if (embeddings.length === 0) {
        logger.warn(`Semantic search: No embeddings generated for ${file.path}`);
        return;
      }

      // Average embeddings
      logger.debug(`Semantic search: Averaging ${embeddings.length} embeddings for ${file.path}`);
      let finalEmbedding: Float32Array;
      
      if (embeddings.length === 1) {
        const firstEmbedding = embeddings[0];
        if (!firstEmbedding) {
          logger.warn(`Semantic search: First embedding is undefined for ${file.path}`);
          return;
        }
        finalEmbedding = firstEmbedding;
      } else {
        finalEmbedding = this.averageEmbeddings(embeddings);
      }

      // Store in cache
      this.embeddingCache.set(file.path, finalEmbedding);
      this.cacheMetadata.set(file.path, {
        lastModified: file.stat.mtime,
        contentHash,
        chunks: chunks.length
      });

      const indexTime = Date.now() - startTime;
      logger.debug(`Semantic search: Successfully indexed ${file.path} (${indexTime}ms, ${chunks.length} chunks, ${embeddings.length} embeddings)`);
      logger.debug(`Semantic search: Stored embedding and metadata for ${file.path} (embedding size: ${finalEmbedding.length}, lastModified: ${new Date(file.stat.mtime).toISOString()})`);
      
      // Save cache immediately after indexing this file
      logger.debug(`Semantic search: Saving cache after indexing ${file.path}...`);
      await this.saveCache().catch(error => {
        logger.warn(`Semantic search: Failed to save cache after indexing ${file.path}:`, error);
      });
      
    } catch (error) {
      logger.error(`Semantic search: Error indexing file ${file.path}:`, error);
      throw error;
    }
  }

  private averageEmbeddings(embeddings: Float32Array[]): Float32Array {
    if (embeddings.length === 0) throw new Error('No embeddings to average');
    
    const firstEmbedding = embeddings[0];
    if (!firstEmbedding) throw new Error('First embedding is undefined');
    
    if (embeddings.length === 1) return firstEmbedding;

    const dimension = firstEmbedding.length;
    const averaged = new Float32Array(dimension);

    for (const embedding of embeddings) {
      if (!embedding) continue; // Skip undefined embeddings
      for (let i = 0; i < dimension; i++) {
        const embeddingValue = embedding[i];
        const averagedValue = averaged[i];
        if (embeddingValue !== undefined && averagedValue !== undefined) {
          averaged[i] = averagedValue + embeddingValue;
        }
      }
    }

    for (let i = 0; i < dimension; i++) {
      const averagedValue = averaged[i];
      if (averagedValue !== undefined) {
        averaged[i] = averagedValue / embeddings.length;
      }
    }

    return averaged;
  }

  async indexAllFiles(onProgress?: (current: number, total: number) => void): Promise<void> {
    const startTime = Date.now();
    const markdownFiles = this.vault.getMarkdownFiles();
    
    logger.debug(`Semantic search: Starting index scan of ${markdownFiles.length} total files...`);
    
    const filesToIndex = markdownFiles.filter(file => {
      // Skip excluded files
      if (this.shouldExcludeFile(file)) {
        logger.debug(`Semantic search: Excluding file ${file.path} (matches exclusion pattern)`);
        return false;
      }
      
      const cached = this.cacheMetadata.get(file.path);
      const needsReindex = !cached || !this.isFileUpToDate(file, cached);
      
      if (needsReindex) {
        logger.debug(`Semantic search: File ${file.path} needs indexing (${cached ? 'modified since cache' : 'not in cache'})`);
      } else {
        logger.debug(`Semantic search: File ${file.path} already up-to-date in cache`);
      }
      
      return needsReindex;
    });

    const excludedCount = markdownFiles.length - filesToIndex.length - this.embeddingCache.size;
    logger.debug(`Semantic search: Found ${filesToIndex.length} files to index (${this.embeddingCache.size} already cached, ${excludedCount} excluded)`);

    if (filesToIndex.length === 0) {
      logger.debug('Semantic search: All files are already indexed and up-to-date');
      return;
    }

    // Process files in batches with delays to prevent UI blocking
    const batchSize = 3; // Small batches for better responsiveness
    const batchDelay = 200; // Delay between batches
    const fileDelay = 50; // Delay between files within a batch
    
    let processedCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < filesToIndex.length; i += batchSize) {
      const batch = filesToIndex.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(filesToIndex.length / batchSize);
      
      logger.debug(`Semantic search: Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)`);
      
      // Process files in batch sequentially to avoid overwhelming the system
      for (const file of batch) {
        try {
          const fileStartTime = Date.now();
          await this.indexFile(file);
          const fileTime = Date.now() - fileStartTime;
          
          processedCount++;
          logger.debug(`Semantic search: Indexed ${file.path} (${processedCount}/${filesToIndex.length}) - ${fileTime}ms`);
          
          if (onProgress) {
            onProgress(processedCount, filesToIndex.length);
          }
          
          // Small delay between files to allow UI updates
          if (fileDelay > 0 && processedCount < filesToIndex.length) {
            await new Promise(resolve => setTimeout(resolve, fileDelay));
          }
          
        } catch (error) {
          errorCount++;
          logger.error(`Semantic search: Failed to index ${file.path} (${errorCount} errors so far):`, error);
        }
      }
      
      // Longer delay between batches to ensure UI responsiveness
      if (i + batchSize < filesToIndex.length && batchDelay > 0) {
        logger.debug(`Semantic search: Waiting ${batchDelay}ms before next batch...`);
        await new Promise(resolve => setTimeout(resolve, batchDelay));
      }
      
      // Save cache after each batch to avoid losing progress
      logger.debug(`Semantic search: Saving cache after batch ${batchNumber}/${totalBatches} (${processedCount} files processed)...`);
      await this.saveCache().catch(error => {
        logger.warn('Semantic search: Failed to save intermediate cache after batch:', error);
      });
    }

    // Final cache save (in case the last batch didn't trigger a save)
    logger.debug(`Semantic search: Final cache save with ${this.embeddingCache.size} embeddings...`);
    await this.saveCache();
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.debug(`Semantic search: Indexing complete - ${processedCount} processed, ${errorCount} errors, ${totalTime}s total`);
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
      const aValue = a[i];
      const bValue = b[i];
      
      if (aValue !== undefined && bValue !== undefined) {
        dotProduct += aValue * bValue;
        normA += aValue * aValue;
        normB += bValue * bValue;
      }
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

  removeFromCache(filePath: string): void {
    this.embeddingCache.delete(filePath);
    this.cacheMetadata.delete(filePath);
  }

  /**
   * Update settings for the embedding service
   */
  updateSettings(newSettings: SemanticSearchSettings): void {
    this.settings = newSettings;
    this.requestQueue.updateConcurrentLimit(newSettings.maxConcurrentRequests);
    logger.debug('Semantic search: Settings updated, exclusion patterns refreshed');
  }
}
