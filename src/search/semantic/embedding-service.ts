/**
 * Embedding service for generating and managing document embeddings using Ollama
 * 
 * Version 2.0: Stores embeddings per-chunk instead of per-file for better semantic search
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
// @ts-ignore
import { requestUrl } from 'obsidian';
import { RequestQueue } from './request-queue';
import { ChunkEmbedding, EmbeddingCache, SemanticSearchSettings } from './types';
import { logger } from '../../utils/logger';
import { generateContentHashBase36 } from '../../utils/hash';

/**
 * Runtime representation of a chunk embedding using Float32Array for performance
 */
export interface ChunkEmbeddingRuntime {
    embedding: Float32Array;
    text: string;
    startLine?: number;
}


export class EmbeddingService {
    private vault: Vault;

    private metadataCache: MetadataCache;

    private settings: SemanticSearchSettings;

    private requestQueue: RequestQueue;

    /**
     * Per-file chunk embeddings for semantic search
     * Key: file path, Value: array of chunk embeddings with text context
     */
    private chunkEmbeddingsCache: Map<string, ChunkEmbeddingRuntime[]> = new Map();

    /**
     * Metadata for cache validation (lastModified, contentHash)
     */
    private cacheMetadata: Map<string, { lastModified: number; contentHash: string }> = new Map();

    private cacheFile: string;

    // Track the expected embedding dimension to ensure consistency across operations
    private expectedDimension?: number;

    // Default embedding model identifier (recorded in cache for validation)
    private readonly defaultModelId: string = 'nomic-embed-text';


    constructor(vault: Vault, metadataCache: MetadataCache, settings: SemanticSearchSettings) {
        this.vault = vault;
        this.metadataCache = metadataCache;
        this.settings = settings;
        this.requestQueue = new RequestQueue(
            settings.maxConcurrentRequests,
            settings.enableAdaptiveThrottling ?? true,
        );
        this.cacheFile = '.obsidian/plugins/obsidian-better-command-palette/embeddings.json';

        logger.debug(`Semantic search: EmbeddingService initialized with cache file: ${this.cacheFile}`);
        logger.debug(`Semantic search: Cache enabled: ${settings.cacheEnabled}`);
        logger.debug(`Semantic search: Max concurrent requests: ${settings.maxConcurrentRequests}, adaptive: ${settings.enableAdaptiveThrottling ?? true}`);
    }

    async initialize(): Promise<void> {
        logger.debug('Semantic search: Initializing EmbeddingService...');
        if (this.settings.cacheEnabled) {
            logger.debug('Semantic search: Cache is enabled, attempting to load existing cache...');
            await this.loadCache();
        } else {
            logger.debug('Semantic search: Cache is disabled, skipping cache load');
        }
        logger.debug(`Semantic search: EmbeddingService initialization complete. ${this.chunkEmbeddingsCache.size} files loaded from cache.`);
        if (this.expectedDimension !== undefined) {
            logger.debug(`Semantic search: Expected embedding dimension: ${this.expectedDimension}`);
        }
    }

    private async loadCache(): Promise<void> {
        try {
            logger.debug(`Semantic search: Attempting to load cache from ${this.cacheFile}`);

            if (await this.vault.adapter.exists(this.cacheFile)) {
                logger.debug('Semantic search: Cache file exists, reading...');
                const cacheData = await this.vault.adapter.read(this.cacheFile);
                const cache: EmbeddingCache = JSON.parse(cacheData);

                logger.debug(`Semantic search: Cache loaded with version ${cache.version}, ${Object.keys(cache.embeddings).length} files`);

                // Only accept version 2.0.0 (chunk-based embeddings)
                // Old versions (1.0.0, 1.1.0) used averaged embeddings and must be rebuilt
                if (cache.version !== '2.0.0') {
                    logger.warn(`Semantic search: Cache version ${cache.version} is outdated. Chunk-based embeddings require v2.0.0. Will rebuild index.`);
                    return;
                }

                let loadedCount = 0;
                let skippedCount = 0;
                let dimensionMismatches = 0;
                let totalChunks = 0;

                for (const [path, fileData] of Object.entries(cache.embeddings)) {
                    const file = this.vault.getAbstractFileByPath(path) as TFile;

                    if (!file) {
                        logger.debug(`Semantic search: File ${path} no longer exists, skipping cache entry`);
                        skippedCount++;
                        continue;
                    }

                    if (this.isFileUpToDate(file, fileData)) {
                        // Validate chunks exist
                        if (!fileData.chunks || fileData.chunks.length === 0) {
                            logger.debug(`Semantic search: No chunks for ${path}, skipping`);
                            skippedCount++;
                            continue;
                        }

                        // Convert chunk embeddings from regular array to Float32Array
                        const chunkEmbeddings: ChunkEmbeddingRuntime[] = [];
                        let hasValidChunks = true;

                        for (const chunk of fileData.chunks) {
                            const arr = new Float32Array(chunk.embedding);

                            // Initialize expected dimension if not set
                            if (this.expectedDimension === undefined) {
                                this.expectedDimension = cache.dimension ?? arr.length;
                                logger.debug(`Semantic search: Derived expected dimension ${this.expectedDimension} from cache`);
                            }

                            // Validate dimension
                            if (this.expectedDimension !== arr.length) {
                                logger.warn(`Semantic search: Skipping chunk in ${path} due to dimension mismatch (${arr.length} != ${this.expectedDimension})`);
                                dimensionMismatches++;
                                hasValidChunks = false;
                                break;
                            }

                            chunkEmbeddings.push({
                                embedding: arr,
                                text: chunk.text,
                                startLine: chunk.startLine,
                            });
                        }

                        if (!hasValidChunks) {
                            skippedCount++;
                            continue;
                        }

                        // Store chunk embeddings and metadata
                        this.chunkEmbeddingsCache.set(path, chunkEmbeddings);
                        this.cacheMetadata.set(path, {
                            lastModified: fileData.lastModified,
                            contentHash: fileData.contentHash,
                        });
                        loadedCount++;
                        totalChunks += chunkEmbeddings.length;
                        logger.debug(`Semantic search: Loaded ${chunkEmbeddings.length} chunks for ${path}`);
                    } else {
                        logger.debug(`Semantic search: File ${path} is newer than cache, skipping`);
                        skippedCount++;
                    }
                }

                logger.debug(`Semantic search: Loaded ${loadedCount} files (${totalChunks} total chunks) from cache, skipped ${skippedCount}`);
                if (dimensionMismatches > 0) {
                    logger.warn(`Semantic search: Skipped ${dimensionMismatches} chunks due to dimension mismatch. Consider re-indexing.`);
                }
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
            logger.debug(`Semantic search: Starting cache save with ${this.chunkEmbeddingsCache.size} files in memory`);
            logger.debug(`Semantic search: Saving cache to: ${this.cacheFile}`);

            const cache: EmbeddingCache = {
                version: '2.0.0', // Chunk-based embeddings
                lastUpdated: Date.now(),
                model: this.settings.embeddingModel || this.defaultModelId,
                dimension: this.expectedDimension,
                embeddings: {},
            };

            let savedCount = 0;
            let skippedCount = 0;
            let totalChunks = 0;

            for (const [path, chunkEmbeddings] of this.chunkEmbeddingsCache) {
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

                // Convert chunk embeddings to serializable format
                const chunks: ChunkEmbedding[] = chunkEmbeddings.map((chunk) => ({
                    embedding: Array.from(chunk.embedding), // Convert Float32Array to regular array
                    text: chunk.text,
                    startLine: chunk.startLine,
                }));

                cache.embeddings[path] = {
                    lastModified: metadata.lastModified,
                    contentHash: metadata.contentHash,
                    chunks,
                };
                savedCount++;
                totalChunks += chunks.length;
                logger.debug(`Semantic search: Prepared ${path} for cache save (${chunks.length} chunks)`);
            }

            logger.debug(`Semantic search: Writing cache file with ${savedCount} files (${totalChunks} chunks, ${skippedCount} skipped) to ${this.cacheFile}`);

            await this.vault.adapter.write(this.cacheFile, JSON.stringify(cache));
            logger.debug(`Semantic search: Successfully saved ${savedCount} files to cache file`);

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

    /**
     * Chunk document into semantic units of 2-4 sentences (~300-400 tokens each)
     * Each chunk includes the file title and tags for context
     */
    private chunkDocument(content: string, file: TFile): string[] {
        const metadata = this.metadataCache.getFileCache(file);
        const targetChunkSize = this.settings.chunkSize || 400; // ~300-400 tokens target

        // Build context prefix with title and tags
        const prefix = file.basename;
        const tags = metadata?.tags?.map((tag) => tag.tag.replace('#', '')).join(' ') || '';
        const contextPrefix = tags ? `${prefix} ${tags}` : prefix;
        const prefixLength = contextPrefix.length + 2; // +2 for ": "

        // Split content into sentences
        const sentences = this.splitIntoSentences(content);

        if (sentences.length === 0) {
            return [`${contextPrefix}: ${content.substring(0, targetChunkSize)}`];
        }

        const chunks: string[] = [];
        let currentChunk: string[] = [];
        let currentLength = 0;
        const minSentences = 2;
        const maxSentences = 4;

        for (let i = 0; i < sentences.length; i++) {
            const sentence = sentences[i];
            if (!sentence) continue;

            const sentenceLength = sentence.length;

            // Check if adding this sentence would exceed target size
            const wouldExceed = currentLength + sentenceLength > targetChunkSize - prefixLength;
            const hasMinSentences = currentChunk.length >= minSentences;
            const hasMaxSentences = currentChunk.length >= maxSentences;

            // Finalize current chunk if we have enough sentences or would exceed size
            if ((wouldExceed && hasMinSentences) || hasMaxSentences) {
                if (currentChunk.length > 0) {
                    chunks.push(`${contextPrefix}: ${currentChunk.join(' ')}`);
                }
                currentChunk = [];
                currentLength = 0;
            }

            // Add sentence to current chunk
            currentChunk.push(sentence);
            currentLength += sentenceLength + 1; // +1 for space
        }

        // Don't forget the last chunk
        if (currentChunk.length > 0) {
            chunks.push(`${contextPrefix}: ${currentChunk.join(' ')}`);
        }

        return chunks.length > 0 ? chunks : [`${contextPrefix}: ${content.substring(0, targetChunkSize)}`];
    }

    /**
     * Split text into sentences using multiple delimiters
     * Handles common edge cases like abbreviations and numbers
     */
    private splitIntoSentences(text: string): string[] {
        // Remove frontmatter (YAML between ---)
        const withoutFrontmatter = text.replace(/^---[\s\S]*?---\n?/, '');

        // Split by sentence-ending punctuation, keeping the punctuation
        // This regex handles: . ! ? and common abbreviations
        const rawSentences = withoutFrontmatter
            .replace(/([.!?])\s+/g, '$1\n') // Add newline after sentence-ending punctuation
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

        // Filter out very short fragments (likely not real sentences)
        return rawSentences.filter((s) => s.length > 10);
    }


    async generateEmbedding(
        text: string,
        _taskType: 'search_document' | 'search_query' = 'search_document',
        retries = 3,
    ): Promise<Float32Array> {
        // NOTE: Do not wrap this in requestQueue.add() - the queue is managed at the file level
        // in indexAllFiles to avoid deadlocks from nested queue entries
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // Use Ollama's /api/embeddings endpoint with 'prompt' field
                const response = await requestUrl({
                    url: `${this.settings.ollamaUrl}/api/embeddings`,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.settings.embeddingModel || this.defaultModelId,
                        prompt: text, // Ollama uses 'prompt', not 'input'
                    }),
                });

                if (response.status !== 200) {
                    throw new Error(`HTTP ${response.status}: ${response.text}`);
                }

                // Ollama /api/embeddings returns { embedding: number[] }
                const data = response.json as any;
                const rawEmbedding: number[] | undefined = Array.isArray(data?.embedding)
                    ? (data.embedding as number[])
                    : undefined;

                if (!rawEmbedding || rawEmbedding.length === 0) {
                    const snippet = typeof response.text === 'string' ? response.text.slice(0, 200) : '';
                    console.error(
                        `[Semantic Search] Invalid embedding response (missing/empty vector). Status: ${response.status}. Body snippet: ${snippet}`,
                    );
                    throw new Error('Invalid embedding response: missing or empty embedding');
                }

                const vec = new Float32Array(rawEmbedding);
                if (this.expectedDimension === undefined) {
                    this.expectedDimension = vec.length;
                    logger.debug(`[Semantic Search] Set expected embedding dimension to ${this.expectedDimension}`);
                } else if (this.expectedDimension !== vec.length) {
                    console.warn(`[Semantic Search] Generated embedding dimension ${vec.length} differs from expected ${this.expectedDimension}`);
                }
                return vec;
            } catch (error) {
                console.warn(`[Semantic Search] Embedding attempt ${attempt}/${retries} failed:`, error);

                if (attempt === retries) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    throw new Error(`Failed after ${retries} attempts: ${errorMessage}`);
                }
                // Exponential backoff
                await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
            }
        }
        throw new Error('Unexpected error in embedding generation');
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
        return this.settings.excludePatterns.some((pattern) => {
            try {
                // Convert glob pattern to regex more accurately
                let regexPattern = pattern
                    .replace(/\./g, '\\.') // Escape dots
                    .replace(/\*\*\//g, '__DOUBLESTARSLASH__') // Temporarily replace **/
                    .replace(/\*\*/g, '__DOUBLESTAR__') // Temporarily replace **
                    .replace(/\*/g, '[^/]*') // Convert single * to match anything except path separators
                    .replace(/__DOUBLESTARSLASH__/g, '.*') // Convert **/ to match everything including path separators
                    .replace(/__DOUBLESTAR__/g, '[^/]*') // Convert ** to match everything including path separators (if not followed by /)
                    .replace(/\?/g, '[^/]') // Convert ? to match single character except path separator
                    .replace(/\//g, '\\/'); // Escape forward slashes

                // Ensure pattern matches from start if it starts with **/ or /
                if (pattern.startsWith('**/') || pattern.startsWith('/')) {
                    regexPattern = `^${regexPattern}`;
                } else {
                    // If pattern doesn't start with **/ or /, match anywhere in path
                    regexPattern = `(^|/)${regexPattern}`;
                }

                // Ensure pattern matches to end if it doesn't end with **
                if (!pattern.endsWith('**')) {
                    regexPattern = `${regexPattern}$`;
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
            // Skip excluded files
            if (this.shouldExcludeFile(file)) {
                return;
            }

            // Check if file is already up-to-date
            const existingMetadata = this.cacheMetadata.get(file.path);
            if (existingMetadata && this.isFileUpToDate(file, existingMetadata)) {
                return;
            }

            // Get content hash for change detection
            const contentHash = await this.getContentHash(file);

            // Check if content actually changed
            if (existingMetadata && existingMetadata.contentHash === contentHash) {
                this.cacheMetadata.set(file.path, {
                    lastModified: file.stat.mtime,
                    contentHash: existingMetadata.contentHash,
                });
                return;
            }

            // Read and chunk the document
            const content = await this.vault.cachedRead(file);

            if (!content || content.trim().length === 0) {
                return;
            }

            const chunks = this.chunkDocument(content, file);

            if (chunks.length === 0 || (chunks.length === 1 && chunks[0]?.trim().length === 0)) {
                return;
            }

            // Generate embeddings for all chunks (store each one, not averaged!)
            const chunkEmbeddings: ChunkEmbeddingRuntime[] = [];

            for (let i = 0; i < chunks.length; i++) {
                const chunkText = chunks[i];
                if (!chunkText) {
                    continue;
                }

                try {
                    const embedding = await this.generateEmbedding(chunkText, 'search_document');

                    // Initialize expected dimension if needed
                    if (this.expectedDimension === undefined) {
                        this.expectedDimension = embedding.length;
                    }

                    // Validate dimension
                    if (this.expectedDimension !== embedding.length) {
                        console.warn(`[Semantic Search] Dimension mismatch for chunk ${i + 1} of ${file.path}: got ${embedding.length}, expected ${this.expectedDimension}`);
                        continue;
                    }

                    chunkEmbeddings.push({
                        embedding,
                        text: chunkText,
                        // Could calculate startLine here from content if needed
                    });
                } catch (error) {
                    console.error(`[Semantic Search] Failed to generate embedding for chunk ${i + 1} of ${file.path}:`, error);
                }
            }

            if (chunkEmbeddings.length === 0) {
                console.warn(`[Semantic Search] No embeddings generated for ${file.path}`);
                return;
            }

            // Store all chunk embeddings for this file (not averaged!)
            this.chunkEmbeddingsCache.set(file.path, chunkEmbeddings);
            this.cacheMetadata.set(file.path, {
                lastModified: file.stat.mtime,
                contentHash,
            });

            logger.debug(`Semantic search: Indexed ${file.path} with ${chunkEmbeddings.length} chunks`);
        } catch (error) {
            console.error(`[Semantic Search] Error indexing file ${file.path}:`, error);
            throw error;
        }
    }


    async indexAllFiles(onProgress?: (current: number, total: number) => void): Promise<void> {
        const startTime = Date.now();
        const markdownFiles = this.vault.getMarkdownFiles();

        logger.debug(`[Semantic Search] Starting index scan of ${markdownFiles.length} total markdown files...`);

        const filesToIndex = markdownFiles.filter((file) => {
            // Skip excluded files
            if (this.shouldExcludeFile(file)) {
                return false;
            }

            const cached = this.cacheMetadata.get(file.path);
            const needsReindex = !cached || !this.isFileUpToDate(file, cached);
            return needsReindex;
        });

        const cachedCount = this.chunkEmbeddingsCache.size;
        const excludedCount = markdownFiles.length - filesToIndex.length - cachedCount;
        const stats = this.requestQueue.getStats();

        logger.debug(`[Semantic Search] Files to index: ${filesToIndex.length} (${cachedCount} cached, ${excludedCount} excluded)`);
        logger.debug(`[Semantic Search] Concurrency: ${stats.currentConcurrency}/${stats.userMax} (adaptive: ${this.settings.enableAdaptiveThrottling ?? true})`);

        if (filesToIndex.length === 0) {
            logger.debug('[Semantic Search] All files are already indexed or excluded, nothing to do');
            return;
        }

        logger.debug(`[Semantic Search] Starting to index ${filesToIndex.length} files...`);

        let processedCount = 0;
        let errorCount = 0;
        const saveInterval = 10; // Save cache every N files

        // Process files in parallel using the request queue
        // The queue handles concurrency limits and adaptive throttling
        const indexPromises = filesToIndex.map((file) => this.requestQueue.add(async () => {
            try {
                const fileStartTime = Date.now();
                await this.indexFile(file);
                const fileTime = Date.now() - fileStartTime;

                processedCount++;
                const queueStats = this.requestQueue.getStats();
                logger.debug(`[Semantic Search] Indexed ${processedCount}/${filesToIndex.length}: ${file.path} (${fileTime}ms, concurrency: ${queueStats.currentConcurrency})`);

                if (onProgress) {
                    onProgress(processedCount, filesToIndex.length);
                }

                // Periodically save cache to avoid losing progress
                if (processedCount % saveInterval === 0) {
                    await this.saveCache().catch((error) => {
                        logger.warn('Semantic search: Failed to save intermediate cache:', error);
                    });
                }
            } catch (error) {
                errorCount++;
                logger.error(`Semantic search: Failed to index ${file.path}:`, error);
            }
        }));

        // Wait for all files to be processed
        await Promise.all(indexPromises);

        // Final cache save
        await this.saveCache();

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        const finalStats = this.requestQueue.getStats();
        logger.debug(`[Semantic Search] ✅ Indexing complete: ${processedCount} files, ${errorCount} errors, ${totalTime}s`);
        logger.debug(`[Semantic Search] Final concurrency: ${finalStats.currentConcurrency}/${finalStats.userMax}, avg response: ${finalStats.avgResponseTime.toFixed(0)}ms`);
    }

    async checkConnection(): Promise<boolean> {
        try {
            logger.debug(`[Semantic Search] Checking connection to ${this.settings.ollamaUrl}/api/tags...`);
            const response = await requestUrl({
                url: `${this.settings.ollamaUrl}/api/tags`,
                method: 'GET',
            });

            const data = response.json as { models: Array<{ name: string }> };
            const modelName = this.settings.embeddingModel || this.defaultModelId;
            const availableModels = data.models.map((m) => m.name);
            logger.debug(`[Semantic Search] Available models: ${availableModels.join(', ')}`);
            logger.debug(`[Semantic Search] Looking for model: ${modelName}`);

            const found = data.models.some((model) => model.name.includes(modelName));
            logger.debug(`[Semantic Search] Model found: ${found}`);
            return found;
        } catch (error) {
            console.error('[Semantic Search] Connection check failed:', error);
            return false;
        }
    }

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length !== b.length) {
            logger.warn(`Semantic search: Cosine similarity dimension mismatch (${a.length} vs ${b.length}). Returning 0.`);
            return 0;
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

    /**
     * Get all chunk embeddings for a file
     * Returns undefined if file is not indexed
     */
    getChunkEmbeddings(filePath: string): ChunkEmbeddingRuntime[] | undefined {
        return this.chunkEmbeddingsCache.get(filePath);
    }

    /**
     * @deprecated Use getChunkEmbeddings instead for chunk-based search
     * Kept for backward compatibility - returns the first chunk's embedding
     */
    getEmbedding(filePath: string): Float32Array | undefined {
        const chunks = this.chunkEmbeddingsCache.get(filePath);
        if (!chunks || chunks.length === 0) return undefined;
        const firstChunk = chunks[0];
        if (!firstChunk) return undefined;
        if (this.expectedDimension !== undefined && firstChunk.embedding.length !== this.expectedDimension) {
            logger.warn(`Semantic search: Cached embedding for ${filePath} has wrong dimension (${firstChunk.embedding.length} != ${this.expectedDimension}). Ignoring.`);
            return undefined;
        }
        return firstChunk.embedding;
    }

    getIndexedFileCount(): number {
        return this.chunkEmbeddingsCache.size;
    }

    /**
     * Get total number of chunks across all indexed files
     */
    getTotalChunkCount(): number {
        let total = 0;
        for (const chunks of this.chunkEmbeddingsCache.values()) {
            total += chunks.length;
        }
        return total;
    }

    getQueueStatus(): { queued: number; active: number; currentConcurrency: number } {
        const stats = this.requestQueue.getStats();
        return {
            queued: this.requestQueue.getQueueSize(),
            active: this.requestQueue.getActiveRequests(),
            currentConcurrency: stats.currentConcurrency,
        };
    }

    clearCache(): void {
        this.chunkEmbeddingsCache.clear();
        this.cacheMetadata.clear();
        this.expectedDimension = undefined;
    }

    removeFromCache(filePath: string): void {
        this.chunkEmbeddingsCache.delete(filePath);
        this.cacheMetadata.delete(filePath);
    }

    /**
    * Update settings for the embedding service
    */
    updateSettings(newSettings: SemanticSearchSettings): void {
        this.settings = newSettings;
        this.requestQueue.updateConcurrentLimit(newSettings.maxConcurrentRequests);
        this.requestQueue.setAdaptiveThrottling(newSettings.enableAdaptiveThrottling ?? true);
        logger.debug(`Semantic search: Settings updated - concurrency: ${newSettings.maxConcurrentRequests}, adaptive: ${newSettings.enableAdaptiveThrottling ?? true}`);
    }
}
