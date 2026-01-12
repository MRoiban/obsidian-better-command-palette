/**
 * Result Clusterer for Hybrid Search
 * 
 * Groups semantically similar search results together to reduce redundancy.
 * Uses embedding similarity to identify clusters.
 */

import { EmbeddingService, ChunkEmbeddingRuntime } from '../semantic/embedding-service';
import { HybridSearchResult, HybridSearchSettings } from './types';
import { logger } from '../../utils/logger';

/**
 * A cluster of similar search results
 */
export interface ResultCluster {
    /** The primary (highest-scoring) result in this cluster */
    primary: HybridSearchResult;
    /** Related results that are similar to the primary */
    related: HybridSearchResult[];
    /** Cluster ID for tracking */
    clusterId: string;
}

/**
 * Extended result with cluster metadata
 */
export interface ClusteredSearchResult extends HybridSearchResult {
    /** Unique cluster identifier */
    clusterId?: string;
    /** Whether this is the primary result in its cluster */
    isClusterPrimary?: boolean;
    /** Number of results in this cluster (including primary) */
    clusterSize?: number;
}

/**
 * Compute average similarity between two files using their chunk embeddings
 * Uses the maximum chunk similarity (best matching chunks)
 */
function computeFileSimilarity(
    chunksA: ChunkEmbeddingRuntime[],
    chunksB: ChunkEmbeddingRuntime[],
    embeddingService: EmbeddingService,
): number {
    if (chunksA.length === 0 || chunksB.length === 0) {
        return 0;
    }

    // Find the maximum similarity between any pair of chunks
    // This captures the "most similar" aspect between two documents
    let maxSimilarity = 0;

    for (const chunkA of chunksA) {
        for (const chunkB of chunksB) {
            const similarity = embeddingService.cosineSimilarity(
                chunkA.embedding,
                chunkB.embedding,
            );
            if (similarity > maxSimilarity) {
                maxSimilarity = similarity;
            }
        }
    }

    return maxSimilarity;
}

/**
 * Cluster search results by semantic similarity
 * 
 * Algorithm:
 * 1. Results are already sorted by score (highest first)
 * 2. For each result, check if it's similar to any existing cluster's primary
 * 3. If similar enough (> threshold), add to that cluster
 * 4. Otherwise, start a new cluster with this result as primary
 * 
 * @param results Sorted search results (highest score first)
 * @param embeddingService Service to get embeddings and compute similarity
 * @param threshold Similarity threshold (0-1, default 0.85)
 * @returns Array of clusters
 */
export function clusterResults(
    results: HybridSearchResult[],
    embeddingService: EmbeddingService,
    threshold: number = 0.85,
): ResultCluster[] {
    if (results.length === 0) {
        return [];
    }

    const clusters: ResultCluster[] = [];
    const clustered = new Set<string>(); // Track which results are already clustered

    // Pre-fetch all embeddings for efficiency
    const embeddingsMap = new Map<string, ChunkEmbeddingRuntime[]>();
    for (const result of results) {
        const chunks = embeddingService.getChunkEmbeddings(result.path);
        if (chunks && chunks.length > 0) {
            embeddingsMap.set(result.path, chunks);
        }
    }

    logger.debug(`Result clustering: Processing ${results.length} results, ${embeddingsMap.size} have embeddings`);

    for (const result of results) {
        // Skip if already clustered
        if (clustered.has(result.path)) {
            continue;
        }

        const resultChunks = embeddingsMap.get(result.path);

        // If no embeddings, treat as standalone result
        if (!resultChunks) {
            clusters.push({
                primary: result,
                related: [],
                clusterId: `cluster-${clusters.length}`,
            });
            clustered.add(result.path);
            continue;
        }

        // Check similarity with existing cluster primaries
        let assignedCluster: ResultCluster | null = null;

        for (const cluster of clusters) {
            const primaryChunks = embeddingsMap.get(cluster.primary.path);
            if (!primaryChunks) continue;

            const similarity = computeFileSimilarity(resultChunks, primaryChunks, embeddingService);

            if (similarity >= threshold) {
                // Similar enough - add to this cluster
                assignedCluster = cluster;
                logger.debug(`Result clustering: ${result.path} similar to ${cluster.primary.path} (${(similarity * 100).toFixed(1)}%)`);
                break;
            }
        }

        if (assignedCluster) {
            // Add to existing cluster as related
            assignedCluster.related.push(result);
            clustered.add(result.path);
        } else {
            // Start new cluster with this as primary
            clusters.push({
                primary: result,
                related: [],
                clusterId: `cluster-${clusters.length}`,
            });
            clustered.add(result.path);
        }
    }

    const multiClusters = clusters.filter(c => c.related.length > 0);
    logger.debug(`Result clustering: Created ${clusters.length} clusters, ${multiClusters.length} have multiple results`);

    return clusters;
}

/**
 * Flatten clusters back to a result array with cluster metadata
 * Primary results come first, with cluster info attached
 */
export function flattenClusters(clusters: ResultCluster[]): ClusteredSearchResult[] {
    const results: ClusteredSearchResult[] = [];

    for (const cluster of clusters) {
        const clusterSize = 1 + cluster.related.length;

        // Add primary with cluster info
        results.push({
            ...cluster.primary,
            clusterId: cluster.clusterId,
            isClusterPrimary: true,
            clusterSize,
        });

        // Optionally add related results (hidden by default in UI)
        // For now, we only show primaries - related are tracked but not displayed
        // This reduces visual clutter while maintaining the grouping info
    }

    return results;
}

/**
 * Apply clustering to search results if enabled
 * Returns original results if clustering is disabled or no embeddings available
 */
export function applyClusteringIfEnabled(
    results: HybridSearchResult[],
    embeddingService: EmbeddingService | null,
    settings: HybridSearchSettings,
): ClusteredSearchResult[] {
    // Return original results if clustering disabled or no embedding service
    if (!settings.enableClustering || !embeddingService) {
        return results.map(r => ({ ...r }));
    }

    if (results.length <= 1) {
        return results.map(r => ({ ...r }));
    }

    const clusters = clusterResults(
        results,
        embeddingService,
        settings.clusterSimilarityThreshold,
    );

    return flattenClusters(clusters);
}
