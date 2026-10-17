/**
 * Result Clusterer for Hybrid Search
 *
 * Groups semantically similar search results together to reduce redundancy.
 * Uses bounded embedding comparisons so large notes cannot block Obsidian's UI.
 */

import { EmbeddingService, ChunkEmbeddingRuntime } from '../semantic/embedding-service';
import { HybridSearchResult, HybridSearchSettings } from './types';
import { logger } from '../../utils/logger';

const MAX_EXACT_CHUNK_COMPARISONS = 4096;
const MAX_TOTAL_CHUNK_COMPARISONS = 25000;
const MAX_REPRESENTATIVE_CHUNKS = 32;
const HIGH_CONFIDENCE_CENTROID_MARGIN = 0.06;
const COSINE_CALLS_BEFORE_YIELD = 2048;
const YIELD_INTERVAL_MS = 12;
const SIMILARITY_CACHE_LIMIT = 2000;

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

interface ClusterOptions {
    signal?: AbortSignal;
}

interface FileEmbeddingContext {
    result: HybridSearchResult;
    chunks?: ChunkEmbeddingRuntime[];
    centroid?: Float32Array;
    matchedChunk?: ChunkEmbeddingRuntime;
    representativeChunks?: ChunkEmbeddingRuntime[];
}

interface ClusteringMetrics {
    filePairs: number;
    exactPairs: number;
    budgetedPairs: number;
    representativePairs: number;
    centroidAccepts: number;
    budgetExhaustedPairs: number;
    cacheHits: number;
    cosineCalls: number;
    largestChunkCount: number;
    yields: number;
    lastYieldAt: number;
}

const similarityCache = new Map<string, number>();

function vectorSignature(vector?: Float32Array): string {
    if (!vector || vector.length === 0) {
        return 'none';
    }

    const first = vector[0] ?? 0;
    const middle = vector[Math.floor(vector.length / 2)] ?? 0;
    const last = vector[vector.length - 1] ?? 0;
    return `${vector.length}:${first.toFixed(5)}:${middle.toFixed(5)}:${last.toFixed(5)}`;
}

function createAbortError(): Error {
    const error = new Error('Result clustering aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

async function yieldToMainThread(): Promise<void> {
    await new Promise<void>((resolve) => {
        if (typeof window !== 'undefined') {
            window.setTimeout(resolve, 0);
        } else {
            setTimeout(resolve, 0);
        }
    });
}

function shouldYield(metrics: ClusteringMetrics, signal?: AbortSignal): boolean {
    throwIfAborted(signal);

    const now = Date.now();
    if (metrics.cosineCalls % COSINE_CALLS_BEFORE_YIELD !== 0
        && now - metrics.lastYieldAt < YIELD_INTERVAL_MS) {
        return false;
    }

    metrics.yields++;
    metrics.lastYieldAt = now;
    return true;
}

function getMatchedChunk(result: HybridSearchResult, chunks: ChunkEmbeddingRuntime[]): ChunkEmbeddingRuntime | undefined {
    const index = result.semanticMatchedChunkIndex;
    if (index === undefined || index < 0 || index >= chunks.length) {
        return undefined;
    }

    return chunks[index];
}

function addRepresentativeChunk(
    chunks: ChunkEmbeddingRuntime[],
    index: number,
    representatives: ChunkEmbeddingRuntime[],
    seenIndexes: Set<number>,
): void {
    const chunk = chunks[index];
    if (!chunk || seenIndexes.has(index) || representatives.length >= MAX_REPRESENTATIVE_CHUNKS) {
        return;
    }

    representatives.push(chunk);
    seenIndexes.add(index);
}

function getRepresentativeChunks(context: FileEmbeddingContext): ChunkEmbeddingRuntime[] {
    if (context.representativeChunks) {
        return context.representativeChunks;
    }

    const chunks = context.chunks ?? [];
    if (chunks.length <= MAX_REPRESENTATIVE_CHUNKS) {
        context.representativeChunks = chunks;
        return chunks;
    }

    const representatives: ChunkEmbeddingRuntime[] = [];
    const seenIndexes = new Set<number>();
    const matchedIndex = context.result.semanticMatchedChunkIndex;

    if (matchedIndex !== undefined) {
        addRepresentativeChunk(chunks, matchedIndex, representatives, seenIndexes);
    }

    addRepresentativeChunk(chunks, 0, representatives, seenIndexes);
    addRepresentativeChunk(chunks, chunks.length - 1, representatives, seenIndexes);

    const slotsRemaining = MAX_REPRESENTATIVE_CHUNKS - representatives.length;
    const stride = Math.max(1, Math.floor(chunks.length / Math.max(1, slotsRemaining)));

    for (let index = Math.floor(stride / 2);
        index < chunks.length && representatives.length < MAX_REPRESENTATIVE_CHUNKS;
        index += stride) {
        addRepresentativeChunk(chunks, index, representatives, seenIndexes);
    }

    for (let index = 0; index < chunks.length && representatives.length < MAX_REPRESENTATIVE_CHUNKS; index++) {
        addRepresentativeChunk(chunks, index, representatives, seenIndexes);
    }

    context.representativeChunks = representatives;
    return representatives;
}

function buildSimilarityCacheKey(contextA: FileEmbeddingContext, contextB: FileEmbeddingContext): string {
    const keyA = [
        contextA.result.path,
        contextA.result.lastModified,
        contextA.chunks?.length ?? 0,
        contextA.result.semanticMatchedChunkIndex ?? 'none',
        vectorSignature(contextA.centroid),
    ].join('|');
    const keyB = [
        contextB.result.path,
        contextB.result.lastModified,
        contextB.chunks?.length ?? 0,
        contextB.result.semanticMatchedChunkIndex ?? 'none',
        vectorSignature(contextB.centroid),
    ].join('|');

    return keyA < keyB ? `${keyA}::${keyB}` : `${keyB}::${keyA}`;
}

function rememberSimilarity(cacheKey: string, similarity: number): number {
    if (similarityCache.has(cacheKey)) {
        similarityCache.delete(cacheKey);
    }

    similarityCache.set(cacheKey, similarity);

    if (similarityCache.size > SIMILARITY_CACHE_LIMIT) {
        const oldestKey = similarityCache.keys().next().value;
        if (oldestKey) {
            similarityCache.delete(oldestKey);
        }
    }

    return similarity;
}

function capBelowThreshold(similarity: number, threshold: number): number {
    if (similarity < threshold) {
        return similarity;
    }

    return Math.max(0, threshold - Number.EPSILON);
}

async function computeMaxChunkSimilarity(
    chunksA: ChunkEmbeddingRuntime[],
    chunksB: ChunkEmbeddingRuntime[],
    embeddingService: EmbeddingService,
    metrics: ClusteringMetrics,
    signal?: AbortSignal,
): Promise<number> {
    let maxSimilarity = 0;

    for (const chunkA of chunksA) {
        for (const chunkB of chunksB) {
            metrics.cosineCalls++;
            const similarity = embeddingService.cosineSimilarity(
                chunkA.embedding,
                chunkB.embedding,
            );
            if (similarity > maxSimilarity) {
                maxSimilarity = similarity;
            }

            if (shouldYield(metrics, signal)) {
                // eslint-disable-next-line no-await-in-loop
                await yieldToMainThread();
                throwIfAborted(signal);
            }
        }
    }

    return maxSimilarity;
}

/**
 * Compute similarity between two files using query-focused chunks first, then
 * exact chunk comparisons only while they fit the budget. Large files fall back
 * to representative chunks plus centroid comparison.
 */
async function computeFileSimilarity(
    contextA: FileEmbeddingContext,
    contextB: FileEmbeddingContext,
    embeddingService: EmbeddingService,
    threshold: number,
    metrics: ClusteringMetrics,
    signal?: AbortSignal,
): Promise<number> {
    const chunksA = contextA.chunks ?? [];
    const chunksB = contextB.chunks ?? [];

    if (contextA.result.path === contextB.result.path) {
        return 1;
    }

    if (chunksA.length === 0 || chunksB.length === 0) {
        return 0;
    }

    const cacheKey = buildSimilarityCacheKey(contextA, contextB);
    const cached = similarityCache.get(cacheKey);
    if (cached !== undefined) {
        metrics.cacheHits++;
        return cached;
    }

    metrics.filePairs++;
    let maxSimilarity = 0;

    if (contextA.matchedChunk && contextB.matchedChunk) {
        metrics.cosineCalls++;
        maxSimilarity = embeddingService.cosineSimilarity(
            contextA.matchedChunk.embedding,
            contextB.matchedChunk.embedding,
        );
        if (shouldYield(metrics, signal)) {
            await yieldToMainThread();
            throwIfAborted(signal);
        }

        if (maxSimilarity >= threshold) {
            return rememberSimilarity(cacheKey, maxSimilarity);
        }
    }

    if (contextA.centroid && contextB.centroid) {
        metrics.cosineCalls++;
        const centroidSimilarity = embeddingService.cosineSimilarity(contextA.centroid, contextB.centroid);
        if (shouldYield(metrics, signal)) {
            await yieldToMainThread();
            throwIfAborted(signal);
        }

        if (centroidSimilarity > maxSimilarity) {
            maxSimilarity = centroidSimilarity;
        }

        if (centroidSimilarity >= threshold + HIGH_CONFIDENCE_CENTROID_MARGIN) {
            metrics.centroidAccepts++;
            return rememberSimilarity(cacheKey, centroidSimilarity);
        }
    }

    const exactComparisonCount = chunksA.length * chunksB.length;
    if (exactComparisonCount <= MAX_EXACT_CHUNK_COMPARISONS) {
        if (metrics.cosineCalls + exactComparisonCount > MAX_TOTAL_CHUNK_COMPARISONS) {
            metrics.budgetExhaustedPairs++;
            return capBelowThreshold(maxSimilarity, threshold);
        }

        metrics.exactPairs++;
        const exactSimilarity = await computeMaxChunkSimilarity(
            chunksA,
            chunksB,
            embeddingService,
            metrics,
            signal,
        );
        maxSimilarity = Math.max(maxSimilarity, exactSimilarity);
        return rememberSimilarity(cacheKey, maxSimilarity);
    }

    metrics.budgetedPairs++;
    metrics.representativePairs++;
    const representativeChunksA = getRepresentativeChunks(contextA);
    const representativeChunksB = getRepresentativeChunks(contextB);
    const representativeComparisonCount = representativeChunksA.length * representativeChunksB.length;

    if (metrics.cosineCalls + representativeComparisonCount > MAX_TOTAL_CHUNK_COMPARISONS) {
        metrics.budgetExhaustedPairs++;
        return capBelowThreshold(maxSimilarity, threshold);
    }

    const representativeSimilarity = await computeMaxChunkSimilarity(
        representativeChunksA,
        representativeChunksB,
        embeddingService,
        metrics,
        signal,
    );

    maxSimilarity = Math.max(maxSimilarity, representativeSimilarity);
    return rememberSimilarity(cacheKey, maxSimilarity);
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
 * @param options Abort signal for stale interactive searches
 * @returns Array of clusters
 */
export async function clusterResults(
    results: HybridSearchResult[],
    embeddingService: EmbeddingService,
    threshold: number = 0.85,
    options: ClusterOptions = {},
): Promise<ResultCluster[]> {
    if (results.length === 0) {
        return [];
    }

    const startTime = Date.now();
    const clusters: ResultCluster[] = [];
    const clustered = new Set<string>(); // Track which results are already clustered
    const metrics: ClusteringMetrics = {
        filePairs: 0,
        exactPairs: 0,
        budgetedPairs: 0,
        representativePairs: 0,
        centroidAccepts: 0,
        budgetExhaustedPairs: 0,
        cacheHits: 0,
        cosineCalls: 0,
        largestChunkCount: 0,
        yields: 0,
        lastYieldAt: startTime,
    };

    const embeddingsMap = new Map<string, FileEmbeddingContext>();
    for (const result of results) {
        const chunks = embeddingService.getChunkEmbeddings(result.path);
        metrics.largestChunkCount = Math.max(metrics.largestChunkCount, chunks?.length ?? 0);
        embeddingsMap.set(result.path, {
            result,
            chunks,
            centroid: embeddingService.getFileCentroid(result.path),
            matchedChunk: chunks ? getMatchedChunk(result, chunks) : undefined,
        });
    }

    const embeddedResultCount = Array.from(embeddingsMap.values()).filter((context) => (
        (context.chunks?.length ?? 0) > 0
    )).length;

    logger.debug(`Result clustering: Processing ${results.length} results, ${embeddedResultCount} have embeddings`);

    for (const result of results) {
        throwIfAborted(options.signal);

        // Skip if already clustered
        if (clustered.has(result.path)) {
            continue;
        }

        const resultContext = embeddingsMap.get(result.path);

        // If no embeddings, treat as standalone result
        if (!resultContext?.chunks?.length) {
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
            const primaryContext = embeddingsMap.get(cluster.primary.path);
            if (!primaryContext?.chunks?.length) continue;

            // eslint-disable-next-line no-await-in-loop
            const similarity = await computeFileSimilarity(
                resultContext,
                primaryContext,
                embeddingService,
                threshold,
                metrics,
                options.signal,
            );

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
    logger.debug(
        `Result clustering: Created ${clusters.length} clusters, ${multiClusters.length} have multiple results `
        + `in ${Date.now() - startTime}ms `
        + `(pairs=${metrics.filePairs}, exact=${metrics.exactPairs}, budgeted=${metrics.budgetedPairs}, `
        + `representative=${metrics.representativePairs}, centroidAccepts=${metrics.centroidAccepts}, `
        + `budgetExhausted=${metrics.budgetExhaustedPairs}, cacheHits=${metrics.cacheHits}, cosineCalls=${metrics.cosineCalls}, `
        + `largestChunks=${metrics.largestChunkCount}, yields=${metrics.yields})`,
    );

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
 * Returns original results if clustering is disabled, aborted, or no embeddings are available.
 */
export async function applyClusteringIfEnabled(
    results: HybridSearchResult[],
    embeddingService: EmbeddingService | null,
    settings: HybridSearchSettings,
    options: ClusterOptions = {},
): Promise<ClusteredSearchResult[]> {
    // Return original results if clustering disabled or no embedding service
    if (!settings.enableClustering || !embeddingService) {
        return results.map(r => ({ ...r }));
    }

    if (results.length <= 1) {
        return results.map(r => ({ ...r }));
    }

    try {
        const clusters = await clusterResults(
            results,
            embeddingService,
            settings.clusterSimilarityThreshold,
            options,
        );

        return flattenClusters(clusters);
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('Result clustering: Aborted stale clustering run');
            return results.map(r => ({ ...r }));
        }

        throw error;
    }
}
