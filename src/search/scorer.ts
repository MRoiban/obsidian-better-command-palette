import {
    RankingContext, SearchSettings, UsageTracker, FileMetadata,
} from './interfaces';
import { logger } from '../utils/logger';

/**
 * Content search scorer implementing BM25F-style relevance scoring
 * combined with usage frequency and recency signals.
 */
export class ContentSearchScorer {
    private settings: SearchSettings;

    constructor(settings: SearchSettings) {
        this.settings = settings;
    }

    /**
     * Calculate the combined score for a search result
     * Uses weighted combination of content relevance, usage frequency, recency, and link importance
     */
    calculateCombinedScore(context: RankingContext): number {
        const weights = this.settings.scoreWeights;

        // Normalize BM25 score to 0-1 range
        const relevanceScore = this.normalizeBM25(context.contentScore);

        // Exponential decay for recency (more recent = higher score)
        const recencyScore = this.calculateRecencyScore(context.lastOpened);

        // Logarithmic scale for usage frequency
        const frequencyScore = this.calculateFrequencyScore(context.usageScore);

        // PageRank/link importance score (already normalized 0-1)
        const linkImportanceScore = context.pageRankScore ?? 0;

        // Apply bounce penalty if present (reduces score for files users bounce from)
        const bouncePenalty = context.bounceScore ?? 0;

        // Weighted combination
        const combinedScore = (
            weights.relevance * relevanceScore
            + weights.recency * recencyScore
            + weights.frequency * frequencyScore
            + (weights.linkImportance ?? 0) * linkImportanceScore
            - (0.1 * bouncePenalty) // Penalty for pogo-sticking
        );

        return Math.max(0, Math.min(1, combinedScore));
    }

    /**
     * Normalize BM25 score to 0-1 range
     * BM25 scores are typically in range [0, inf), this normalizes them
     */
    private normalizeBM25(score: number): number {
        if (score <= 0) return 0;

        // Use a sigmoid-like function to normalize BM25 scores
        // This maps [0, inf) to [0, 1) with most scores in a reasonable range
        return score / (score + 1);
    }

    /**
     * Calculate recency score with exponential decay
     * More recently opened files get higher scores
     */
    private calculateRecencyScore(lastOpened?: number): number {
        if (!lastOpened || !this.settings.enableUsageTracking) {
            return 0;
        }

        const now = Date.now();
        const timeDiff = now - lastOpened;

        // Exponential decay: score = e^(-t/halfLife)
        // Half-life determines how quickly the score decays
        const decayRate = timeDiff / this.settings.recencyHalfLife;
        return Math.exp(-decayRate);
    }

    /**
     * Calculate frequency score using logarithmic scaling
     * Higher usage frequency gets higher scores with diminishing returns
     */
    private calculateFrequencyScore(usageCount: number): number {
        if (usageCount <= 0 || !this.settings.enableUsageTracking) {
            return 0;
        }

        // Logarithmic scaling with base adjustment for smoother curve
        // log(1 + x) / log(1 + maxValue) maps [0, maxValue] to [0, 1]
        const normalizedScore = Math.log(1 + usageCount) / Math.log(1 + this.settings.maxUsageScore);
        return Math.min(1, normalizedScore);
    }

    /**
     * Update scorer settings
     */
    updateSettings(newSettings: SearchSettings): void {
        this.settings = newSettings;
        this.validateSettings();
    }

    /**
     * Validate that settings are within acceptable ranges
     */
    private validateSettings(): void {
        const { scoreWeights } = this.settings;

        // Ensure weights sum to approximately 1.0 (within tolerance)
        const weightSum = scoreWeights.relevance + scoreWeights.recency
            + scoreWeights.frequency + (scoreWeights.linkImportance ?? 0);
        const tolerance = 0.01;

        if (Math.abs(weightSum - 1.0) > tolerance) {
            logger.warn(`Score weights sum to ${weightSum.toFixed(3)}, expected ~1.0`);
        }

        // Ensure individual weights are in valid range
        Object.entries(scoreWeights).forEach(([key, value]) => {
            if (value < 0 || value > 1) {
                logger.warn(`Score weight ${key} is ${value}, should be between 0 and 1`);
            }
        });

        // Ensure other settings are reasonable
        if (this.settings.recencyHalfLife <= 0) {
            logger.warn('Recency half-life should be positive');
        }

        if (this.settings.maxUsageScore <= 0) {
            logger.warn('Max usage score should be positive');
        }
    }

    /**
     * Get current settings
     */
    getSettings(): SearchSettings {
        return { ...this.settings };
    }

    /**
     * Calculate individual score components for debugging
     */
    getScoreBreakdown(context: RankingContext): {
        relevance: number;
        recency: number;
        frequency: number;
        linkImportance: number;
        combined: number;
    } {
        const relevance = this.normalizeBM25(context.contentScore);
        const recency = this.calculateRecencyScore(context.lastOpened);
        const frequency = this.calculateFrequencyScore(context.usageScore);
        const linkImportance = context.pageRankScore ?? 0;
        const combined = this.calculateCombinedScore(context);

        return {
            relevance,
            recency,
            frequency,
            linkImportance,
            combined,
        };
    }
}
