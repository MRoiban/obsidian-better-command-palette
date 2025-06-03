/**
 * Semantic search engine with multi-factor ranking
 */

import { TFile, Vault, MetadataCache } from 'obsidian';
import { EmbeddingService } from './embedding-service';
import { SemanticSearchResult, SemanticSearchSettings } from './types';

export class SemanticSearchEngine {
  private embeddingService: EmbeddingService;
  private vault: Vault;
  private metadataCache: MetadataCache;
  private settings: SemanticSearchSettings;
  private searchCache: Map<string, SemanticSearchResult[]> = new Map();

  constructor(embeddingService: EmbeddingService, vault: Vault, metadataCache: MetadataCache, settings: SemanticSearchSettings) {
    this.embeddingService = embeddingService;
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.settings = settings;
  }

  async search(query: string, options: {
    limit?: number;
    threshold?: number;
    useCache?: boolean;
  } = {}): Promise<SemanticSearchResult[]> {
    const startTime = Date.now();
    const { limit = this.settings.maxResults, threshold = this.settings.searchThreshold, useCache = true } = options;
  
    console.log(`Semantic search: Starting search for "${query}" (limit: ${limit}, threshold: ${threshold})`);
    
    // Check cache first
    const cacheKey = `${query}:${threshold}:${limit}`;
    if (useCache && this.searchCache.has(cacheKey)) {
      console.log(`Semantic search: Returning cached results for "${query}"`);
      return this.searchCache.get(cacheKey)!;
    }

    const indexedCount = this.embeddingService.getIndexedFileCount();
    if (indexedCount === 0) {
      console.warn('Semantic search: No files indexed. Please run indexing first.');
      return [];
    }

    console.log(`Semantic search: Searching through ${indexedCount} indexed files`);

    // Generate query embedding
    console.log(`Semantic search: Generating embedding for query "${query}"`);
    const queryEmbedding = await this.embeddingService.generateEmbedding(query, 'search_query');
    console.log(`Semantic search: Query embedding generated (${queryEmbedding.length} dimensions)`);
    
    const results: SemanticSearchResult[] = [];
    const markdownFiles = this.vault.getMarkdownFiles();
    let checkedFiles = 0;
    let matchingFiles = 0;
  
    for (const file of markdownFiles) {
      const docEmbedding = this.embeddingService.getEmbedding(file.path);
      checkedFiles++;
      
      if (!docEmbedding) {
        if (checkedFiles % 100 === 0) {
          console.log(`Semantic search: Progress ${checkedFiles}/${markdownFiles.length} files checked`);
        }
        continue;
      }

      const similarity = this.embeddingService.cosineSimilarity(queryEmbedding, docEmbedding);
    
      if (similarity >= threshold) {
        matchingFiles++;
        const relevanceScore = this.calculateRelevanceScore(file, similarity, query);
        const matches = this.analyzeMatches(file, query);
        const excerpt = await this.extractRelevantExcerpt(file, query);

        console.log(`Semantic search: Found match ${file.path} (similarity: ${similarity.toFixed(3)}, relevance: ${relevanceScore.toFixed(3)})`);

        results.push({
          file,
          similarity,
          relevanceScore,
          title: file.basename,
          excerpt,
          matches
        });
      }
      
      if (checkedFiles % 100 === 0) {
        console.log(`Semantic search: Progress ${checkedFiles}/${markdownFiles.length} files checked, ${matchingFiles} matches found`);
      }
    }

    console.log(`Semantic search: Found ${results.length} total matches from ${checkedFiles} files`);

    // Sort by relevance score and limit results
    const sortedResults = results
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, limit);

    console.log(`Semantic search: Returning top ${sortedResults.length} results (limited from ${results.length})`);

    // Cache results
    if (useCache) {
      this.searchCache.set(cacheKey, sortedResults);
    
      // Limit cache size
      if (this.searchCache.size > 100) {
        const firstKey = this.searchCache.keys().next().value;
        this.searchCache.delete(firstKey);
        console.log(`Semantic search: Cache size limited, removed oldest entry`);
      }
    }

    const searchTime = Date.now() - startTime;
    console.log(`Semantic search: Search completed in ${searchTime}ms`);

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
    console.log('Semantic search: Search cache cleared');
  }

  /**
   * Update settings for the search engine
   */
  updateSettings(newSettings: SemanticSearchSettings): void {
    this.settings = newSettings;
    // Clear search cache when settings change as threshold/maxResults may have changed
    this.clearSearchCache();
    console.log('Semantic search: Search engine settings updated');
  }

  getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.searchCache.size,
      maxSize: 100
    };
  }
}
