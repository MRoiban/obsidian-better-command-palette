/**
 * Reciprocal Rank Fusion (RRF) algorithm for merging keyword and semantic search results
 * 
 * RRF is a simple but effective algorithm for combining ranked lists.
 * For each item, it computes: score = Σ (1 / (k + rank_i))
 * where k is a constant (typically 60) and rank_i is the rank in list i.
 */

import { TFile } from 'obsidian';
import { EnhancedSearchResult } from '../interfaces';
import { SemanticSearchResult } from '../semantic/types';
import {
    FusedResult,
    HybridSearchSettings,
    NormalizedKeywordResult,
    NormalizedSemanticResult,
} from './types';
import { logger } from '../../utils/logger';

/**
 * Normalizes keyword search results for fusion
 */
export function normalizeKeywordResults(
    results: EnhancedSearchResult[],
    vault: { getAbstractFileByPath: (path: string) => any },
): NormalizedKeywordResult[] {
    logger.debug(`Hybrid fusion: Normalizing ${results.length} keyword results`);
    
    if (results.length === 0) {
        logger.debug('Hybrid fusion: No keyword results to normalize');
        return [];
    }

    // Find min/max scores for normalization
    const scores = results.map((r) => r.combinedScore);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const scoreRange = maxScore - minScore || 1;

    logger.debug(`Hybrid fusion: Keyword score range: ${minScore.toFixed(4)} - ${maxScore.toFixed(4)}`);

    const normalized = results.map((result, index) => {
        const file = vault.getAbstractFileByPath(result.id);
        if (!file) {
            logger.debug(`Hybrid fusion: File not found for path: ${result.id}`);
        }
        return {
            path: result.id,
            file: file as TFile,
            score: result.combinedScore,
            normalizedScore: (result.combinedScore - minScore) / scoreRange,
            rank: index + 1,
            matches: result.matches,
            metadata: result.metadata,
            snippet: result.snippet,
        };
    }).filter((r) => r.file !== null);

    logger.debug(`Hybrid fusion: Normalized ${normalized.length} keyword results (${results.length - normalized.length} filtered out due to missing files)`);
    return normalized;
}

/**
 * Normalizes semantic search results for fusion
 */
export function normalizeSemanticResults(
    results: SemanticSearchResult[],
): NormalizedSemanticResult[] {
    logger.debug(`Hybrid fusion: Normalizing ${results.length} semantic results`);
    
    if (results.length === 0) {
        logger.debug('Hybrid fusion: No semantic results to normalize');
        return [];
    }

    // Semantic scores are already 0-1 similarity scores
    // But we still normalize within the result set for relative ranking
    const scores = results.map((r) => r.relevanceScore);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const scoreRange = maxScore - minScore || 1;

    logger.debug(`Hybrid fusion: Semantic score range: ${minScore.toFixed(4)} - ${maxScore.toFixed(4)}`);

    return results.map((result, index) => ({
        path: result.file.path,
        file: result.file,
        score: result.relevanceScore,
        normalizedScore: (result.relevanceScore - minScore) / scoreRange,
        rank: index + 1,
        similarity: result.similarity,
        excerpt: result.excerpt,
        matches: result.matches,
    }));
}

/**
 * Computes RRF score for a single item
 * score = weight * (1 / (k + rank))
 */
function computeRRFScore(rank: number, k: number, weight: number): number {
    return weight * (1 / (k + rank));
}

/**
 * Fuses keyword and semantic results using Reciprocal Rank Fusion
 */
export function fuseResults(
    keywordResults: NormalizedKeywordResult[],
    semanticResults: NormalizedSemanticResult[],
    settings: HybridSearchSettings,
): FusedResult[] {
    const { rrfK, keywordWeight, semanticWeight } = settings;

    logger.debug(`Hybrid fusion: Merging ${keywordResults.length} keyword and ${semanticResults.length} semantic results`);

    // Create maps for quick lookup by path
    const keywordMap = new Map<string, NormalizedKeywordResult>();
    const semanticMap = new Map<string, NormalizedSemanticResult>();

    keywordResults.forEach((r) => keywordMap.set(r.path, r));
    semanticResults.forEach((r) => semanticMap.set(r.path, r));

    // Collect all unique paths
    const allPaths = new Set<string>([
        ...keywordResults.map((r) => r.path),
        ...semanticResults.map((r) => r.path),
    ]);

    logger.debug(`Hybrid fusion: ${allPaths.size} unique files across both result sets`);

    // Compute fusion scores
    const fusedResults: FusedResult[] = [];

    allPaths.forEach((path) => {
        const keywordResult = keywordMap.get(path);
        const semanticResult = semanticMap.get(path);

        let fusionScore = 0;

        // Add keyword RRF contribution
        if (keywordResult) {
            fusionScore += computeRRFScore(keywordResult.rank, rrfK, keywordWeight);
        }

        // Add semantic RRF contribution
        if (semanticResult) {
            fusionScore += computeRRFScore(semanticResult.rank, rrfK, semanticWeight);
        }

        // Determine source
        let source: 'keyword' | 'semantic' | 'both';
        if (keywordResult && semanticResult) {
            source = 'both';
        } else if (keywordResult) {
            source = 'keyword';
        } else {
            source = 'semantic';
        }

        // Get file reference (prefer keyword result as it's more reliable)
        const file = keywordResult?.file || semanticResult?.file;

        if (file) {
            fusedResults.push({
                path,
                file,
                fusionScore,
                keywordResult,
                semanticResult,
                source,
            });
        }
    });

    // Sort by fusion score descending
    fusedResults.sort((a, b) => b.fusionScore - a.fusionScore);

    // Log top results for debugging
    if (fusedResults.length > 0) {
        const topResults = fusedResults.slice(0, 5);
        logger.debug('Hybrid fusion: Top 5 fused results:');
        topResults.forEach((r, i) => {
            logger.debug(`  ${i + 1}. ${r.path} (score: ${r.fusionScore.toFixed(4)}, source: ${r.source})`);
        });
    }

    return fusedResults;
}

/**
 * Computes a combined score that blends RRF with raw similarity/relevance scores
 * This provides more nuance than pure RRF by considering the actual score values
 */
export function computeBlendedScore(
    fusedResult: FusedResult,
    settings: HybridSearchSettings,
): number {
    const { keywordWeight, semanticWeight } = settings;

    let blendedScore = 0;
    let totalWeight = 0;

    // Blend in normalized keyword score
    if (fusedResult.keywordResult) {
        blendedScore += keywordWeight * fusedResult.keywordResult.normalizedScore;
        totalWeight += keywordWeight;
    }

    // Blend in semantic similarity score
    if (fusedResult.semanticResult) {
        blendedScore += semanticWeight * fusedResult.semanticResult.normalizedScore;
        totalWeight += semanticWeight;
    }

    // Normalize by actual weights used
    if (totalWeight > 0) {
        blendedScore /= totalWeight;
    }

    // Combine RRF and blended scores (70% RRF, 30% blended)
    const combinedScore = (0.7 * fusedResult.fusionScore) + (0.3 * blendedScore);

    return combinedScore;
}
