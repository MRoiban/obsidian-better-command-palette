/**
 * Link Graph Service
 *
 * Implements PageRank-style link importance scoring by analyzing
 * the link graph within an Obsidian vault. Files that are linked
 * to by many other files (especially "authoritative" files) receive
 * higher scores.
 */

import { App, TFile, MetadataCache, Vault } from 'obsidian';
import { logger } from '../utils/logger';
import { SmartScheduler } from '../utils/smart-scheduler';

/**
 * Configuration for PageRank calculation
 */
export interface LinkGraphSettings {
    /** Damping factor for PageRank (0-1, default: 0.85) */
    dampingFactor: number;
    /** Number of iterations for PageRank convergence (default: 20) */
    maxIterations: number;
    /** Convergence threshold (default: 0.0001) */
    convergenceThreshold: number;
    /** Enable link graph scoring */
    enabled: boolean;
    /** Weight for link score in final ranking (0-1) */
    weight: number;
}

export const DEFAULT_LINK_GRAPH_SETTINGS: LinkGraphSettings = {
    dampingFactor: 0.85,
    maxIterations: 20,
    convergenceThreshold: 0.0001,
    enabled: true,
    weight: 0.15,
};

/**
 * Represents a node in the link graph
 */
interface GraphNode {
    path: string;
    outLinks: Set<string>; // Files this node links to
    inLinks: Set<string>; // Files that link to this node
    pageRank: number;
}

/**
 * Link Graph Service for computing PageRank-style importance scores
 */
export class LinkGraphService {
    private vault: Vault;

    private metadataCache: MetadataCache;

    private settings: LinkGraphSettings;

    private graph: Map<string, GraphNode> = new Map();

    private pageRanks: Map<string, number> = new Map();

    private isComputed = false;

    private lastComputeTime = 0;



    private storageKey = 'better-command-palette-link-graph';

    /** Smart scheduler for throttle + debounce update processing */
    private scheduler: SmartScheduler;

    constructor(
        app: App,
        settings: LinkGraphSettings = DEFAULT_LINK_GRAPH_SETTINGS,
    ) {
        this.vault = app.vault;
        this.metadataCache = app.metadataCache;
        this.settings = settings;

        // Use SmartScheduler for debounce-only pattern
        this.scheduler = new SmartScheduler(
            () => this.processScheduledRecompute(),
            {
                throttleMs: 60000,   // Effectively disabled
                debounceMs: 10000,   // 10s of inactivity before recompute
                name: 'LinkGraph',
            },
        );

        this.loadFromStorage();
    }

    /**
     * Update settings
     */
    updateSettings(settings: Partial<LinkGraphSettings>): void {
        this.settings = { ...this.settings, ...settings };
        // Invalidate cache if settings changed
        this.isComputed = false;
    }

    /**
     * Get the PageRank score for a file (0-1 normalized)
     */
    getPageRankScore(path: string): number {
        if (!this.settings.enabled) {
            return 0;
        }

        // Always return cached value - never trigger recompute during lookup
        // The scheduler handles background recomputation after file changes
        return this.pageRanks.get(path) ?? 0;
    }

    /**
     * Get the raw backlink count for a file
     * Uses Obsidian's internal API for real-time accuracy
     */
    getBacklinkCount(path: string): number {
        // Try to get real-time count from Obsidian's API
        const file = this.vault.getAbstractFileByPath(path);
        if (file && file instanceof TFile) {
            // @ts-ignore - getBacklinksForFile is not in public API but exists
            const backlinksData = this.metadataCache.getBacklinksForFile(file);
            if (backlinksData && backlinksData.count) {
                return backlinksData.count();
            }
        }

        // Fallback to cached graph data
        const node = this.graph.get(path);
        return node?.inLinks.size ?? 0;
    }

    /**
     * Get top files by PageRank
     */
    getTopByPageRank(limit = 10): Array<{ path: string; score: number; backlinks: number }> {
        const entries = Array.from(this.pageRanks.entries())
            .map(([path, score]) => ({
                path,
                score,
                backlinks: this.getBacklinkCount(path),
            }))
            .sort((a, b) => b.score - a.score);

        return entries.slice(0, limit);
    }

    /**
     * Build the link graph from all markdown files in the vault
     * Uses Obsidian's APIs for accurate link detection:
     * - getFileCache for outgoing links
     * - getBacklinksForFile for incoming links (backlinks)
     */
    async buildGraph(): Promise<void> {
        const startTime = Date.now();
        logger.debug('[LinkGraph] Building graph from vault...');

        this.graph.clear();
        const markdownFiles = this.vault.getMarkdownFiles();
        logger.debug(`[LinkGraph] Found ${markdownFiles.length} markdown files`);

        // Initialize nodes for all files
        for (const file of markdownFiles) {
            this.graph.set(file.path, {
                path: file.path,
                outLinks: new Set(),
                inLinks: new Set(),
                pageRank: 1 / markdownFiles.length, // Initial uniform distribution
            });
        }

        // Build outgoing links using getFileCache
        let totalOutLinks = 0;
        for (const file of markdownFiles) {
            const cache = this.metadataCache.getFileCache(file);
            if (!cache) continue;

            const sourceNode = this.graph.get(file.path)!;
            const links = [...(cache.links ?? []), ...(cache.embeds ?? [])];

            for (const link of links) {
                // Resolve the link to a file path
                const resolvedFile = this.metadataCache.getFirstLinkpathDest(
                    link.link,
                    file.path,
                );

                if (resolvedFile && resolvedFile instanceof TFile) {
                    const targetPath = resolvedFile.path;
                    if (targetPath !== file.path && this.graph.has(targetPath)) {
                        sourceNode.outLinks.add(targetPath);
                        totalOutLinks++;
                    }
                }
            }
        }

        // Build incoming links (backlinks) using getBacklinksForFile
        let totalBacklinks = 0;
        for (const file of markdownFiles) {
            const node = this.graph.get(file.path)!;

            // Get backlinks using Obsidian's internal API
            // @ts-ignore - getBacklinksForFile is not in public API but exists
            const backlinksData = this.metadataCache.getBacklinksForFile(file);

            if (backlinksData && backlinksData.keys) {
                for (const sourcePath of backlinksData.keys()) {
                    // sourcePath is the file that links TO this file
                    if (sourcePath !== file.path && this.graph.has(sourcePath)) {
                        node.inLinks.add(sourcePath);
                        totalBacklinks++;
                    }
                }
            }
        }

        const elapsed = Date.now() - startTime;
        logger.debug(`[LinkGraph] Built graph: ${markdownFiles.length} nodes, ${totalOutLinks} outLinks, ${totalBacklinks} backlinks in ${elapsed}ms`);

        // Log some stats about top linked files
        const topLinked = Array.from(this.graph.values())
            .map(n => ({ path: n.path, inLinks: n.inLinks.size, outLinks: n.outLinks.size }))
            .sort((a, b) => b.inLinks - a.inLinks)
            .slice(0, 5);
        logger.debug('[LinkGraph] Top linked files:', topLinked);

        logger.debug(`Link graph: Built graph with ${markdownFiles.length} nodes, ${totalOutLinks} outLinks, ${totalBacklinks} backlinks in ${elapsed}ms`);
    }

    /**
     * Compute PageRank scores using iterative algorithm
     */
    computePageRank(): void {
        if (!this.settings.enabled) {
            return;
        }

        const startTime = Date.now();
        const { dampingFactor, maxIterations, convergenceThreshold } = this.settings;

        const nodes = Array.from(this.graph.values());
        const nodeCount = nodes.length;

        if (nodeCount === 0) {
            logger.debug('Link graph: No nodes to compute PageRank');
            return;
        }

        // Initialize scores
        const initialScore = 1 / nodeCount;
        for (const node of nodes) {
            node.pageRank = initialScore;
        }

        // Iterative PageRank calculation
        for (let iteration = 0; iteration < maxIterations; iteration++) {
            let maxDelta = 0;

            // Calculate new scores
            const newScores = new Map<string, number>();

            for (const node of nodes) {
                let incomingScore = 0;

                // Sum contributions from all pages linking to this one
                for (const inLinkPath of node.inLinks) {
                    const inNode = this.graph.get(inLinkPath);
                    if (inNode && inNode.outLinks.size > 0) {
                        incomingScore += inNode.pageRank / inNode.outLinks.size;
                    }
                }

                // Apply damping factor
                const newScore = ((1 - dampingFactor) / nodeCount)
                    + (dampingFactor * incomingScore);

                newScores.set(node.path, newScore);

                // Track convergence
                const delta = Math.abs(newScore - node.pageRank);
                maxDelta = Math.max(maxDelta, delta);
            }

            // Update scores
            for (const node of nodes) {
                node.pageRank = newScores.get(node.path)!;
            }

            // Check convergence
            if (maxDelta < convergenceThreshold) {
                logger.debug(`Link graph: PageRank converged after ${iteration + 1} iterations`);
                break;
            }
        }

        // Normalize scores to 0-1 range and store
        this.normalizeAndStoreScores();

        const elapsed = Date.now() - startTime;
        this.lastComputeTime = Date.now();
        this.isComputed = true;

        logger.debug(`Link graph: Computed PageRank for ${nodeCount} nodes in ${elapsed}ms`);
        this.saveToStorage();
    }

    /**
     * Normalize PageRank scores to 0-1 range
     */
    private normalizeAndStoreScores(): void {
        let maxScore = 0;
        for (const node of this.graph.values()) {
            maxScore = Math.max(maxScore, node.pageRank);
        }

        this.pageRanks.clear();

        if (maxScore > 0) {
            for (const node of this.graph.values()) {
                this.pageRanks.set(node.path, node.pageRank / maxScore);
            }
        }
    }

    /**
     * Full recomputation: build graph and compute PageRank
     */
    async recompute(): Promise<void> {
        await this.buildGraph();
        this.computePageRank();
    }



    /**
     * Handle file creation - add to graph
     */
    onFileCreate(file: TFile): void {
        if (file.extension !== 'md') return;

        this.graph.set(file.path, {
            path: file.path,
            outLinks: new Set(),
            inLinks: new Set(),
            pageRank: 0,
        });

        this.isComputed = false;
        this.queueUpdate(file.path);
    }

    /**
     * Handle file deletion - remove from graph
     */
    onFileDelete(path: string): void {
        const node = this.graph.get(path);
        if (!node) return;

        // Remove inbound references from other nodes
        for (const outPath of node.outLinks) {
            const outNode = this.graph.get(outPath);
            outNode?.inLinks.delete(path);
        }

        // Remove outbound references from other nodes
        for (const inPath of node.inLinks) {
            const inNode = this.graph.get(inPath);
            inNode?.outLinks.delete(path);
        }

        this.graph.delete(path);
        this.pageRanks.delete(path);
        this.isComputed = false;
        this.queueUpdate(path);
    }

    /**
     * Handle file rename - update graph
     */
    onFileRename(oldPath: string, newPath: string): void {
        const node = this.graph.get(oldPath);
        if (!node) return;

        // Update the node's path
        node.path = newPath;

        // Move to new key
        this.graph.delete(oldPath);
        this.graph.set(newPath, node);

        // Update references in other nodes
        for (const outPath of node.outLinks) {
            const outNode = this.graph.get(outPath);
            if (outNode) {
                outNode.inLinks.delete(oldPath);
                outNode.inLinks.add(newPath);
            }
        }

        for (const inPath of node.inLinks) {
            const inNode = this.graph.get(inPath);
            if (inNode) {
                inNode.outLinks.delete(oldPath);
                inNode.outLinks.add(newPath);
            }
        }

        // Move PageRank score
        const score = this.pageRanks.get(oldPath);
        if (score !== undefined) {
            this.pageRanks.delete(oldPath);
            this.pageRanks.set(newPath, score);
        }
    }

    /**
     * Handle file modification - update links
     */
    async onFileModify(file: TFile): Promise<void> {
        logger.debug('[LinkGraph] onFileModify called:', file.path);
        if (file.extension !== 'md') return;

        const node = this.graph.get(file.path);
        if (!node) {
            this.onFileCreate(file);
            return;
        }

        // Remove old outgoing links from targets
        for (const outPath of node.outLinks) {
            const outNode = this.graph.get(outPath);
            outNode?.inLinks.delete(file.path);
        }

        // Clear and rebuild outgoing links
        node.outLinks.clear();

        const cache = this.metadataCache.getFileCache(file);
        if (cache?.links) {
            for (const link of cache.links) {
                const resolvedFile = this.metadataCache.getFirstLinkpathDest(
                    link.link,
                    file.path,
                );

                if (resolvedFile && resolvedFile instanceof TFile) {
                    const targetPath = resolvedFile.path;
                    const targetNode = this.graph.get(targetPath);

                    if (targetNode && targetPath !== file.path) {
                        node.outLinks.add(targetPath);
                        targetNode.inLinks.add(file.path);
                    }
                }
            }
        }

        this.isComputed = false;
        this.queueUpdate(file.path);
    }

    /**
     * Queue a file for update processing
     * Uses SmartScheduler for throttle + debounce pattern
     */
    private queueUpdate(path: string): void {
        logger.debug(`[LinkGraph] Queued update for ${path}`);
        logger.debug(`Link graph: Queued update for ${path}`);
        this.scheduler.schedule(path);
    }

    /**
     * Process scheduled updates and recompute PageRank
     */
    private async processScheduledRecompute(): Promise<void> {
        logger.debug('[LinkGraph] processScheduledRecompute called');
        logger.debug('Link graph: Processing scheduled recompute');

        // Recompute the entire graph
        // (For large vaults, could optimize to only update affected nodes)
        try {
            logger.debug('[LinkGraph] Starting recompute...');
            await this.recompute();
            logger.debug('[LinkGraph] Recompute complete!');
            logger.debug('Link graph: Recompute complete');
        } catch (error) {
            console.error('[LinkGraph] Recompute failed:', error);
            logger.error('Link graph: Failed to recompute after updates', error);
        }
    }

    /**
     * Force immediate processing of pending updates
     */
    async flushUpdates(): Promise<void> {
        await this.scheduler.flush();
    }

    /**
     * Get statistics about the link graph
     */
    getStats(): {
        nodeCount: number;
        edgeCount: number;
        isComputed: boolean;
        avgBacklinks: number;
        maxBacklinks: number;
    } {
        let totalBacklinks = 0;
        let maxBacklinks = 0;
        let edgeCount = 0;

        for (const node of this.graph.values()) {
            const backlinks = node.inLinks.size;
            totalBacklinks += backlinks;
            maxBacklinks = Math.max(maxBacklinks, backlinks);
            edgeCount += node.outLinks.size;
        }

        const nodeCount = this.graph.size;

        return {
            nodeCount,
            edgeCount,
            isComputed: this.isComputed,
            avgBacklinks: nodeCount > 0 ? totalBacklinks / nodeCount : 0,
            maxBacklinks,
        };
    }

    /**
     * Save PageRank scores to localStorage for faster loading
     */
    private saveToStorage(): void {
        try {
            const data = {
                version: '1.0.0',
                timestamp: Date.now(),
                scores: Array.from(this.pageRanks.entries()),
            };
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        } catch (error) {
            logger.warn('Link graph: Failed to save to storage', error);
        }
    }

    /**
     * Load PageRank scores from localStorage
     */
    private loadFromStorage(): void {
        try {
            const stored = localStorage.getItem(this.storageKey);
            if (!stored) return;

            const data = JSON.parse(stored);
            if (data.version === '1.0.0' && data.scores) {
                this.pageRanks = new Map(data.scores);
                // Consider cached data valid for 1 hour
                const cacheAge = Date.now() - (data.timestamp || 0);
                if (cacheAge < 60 * 60 * 1000) {
                    this.isComputed = true;
                    logger.debug('Link graph: Loaded cached PageRank scores');
                }
            }
        } catch (error) {
            logger.warn('Link graph: Failed to load from storage', error);
        }
    }

    /**
     * Clear all data and reset state
     */
    reset(): void {
        this.graph.clear();
        this.pageRanks.clear();
        this.isComputed = false;
        localStorage.removeItem(this.storageKey);
    }
}
