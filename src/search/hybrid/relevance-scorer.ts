import {
    FusedResult,
    HybridScoreBreakdown,
    HybridSearchSettings,
} from './types';

export interface HybridRetrievalContext {
    hasKeywordResults: boolean;
    hasSemanticResults: boolean;
}

export interface HybridReRankSignals {
    title: number;
    recency: number;
    usage: number;
    content: number;
    pageRank: number;
    proximity: number;
    bounce: number;
    feedback: number;
}

interface NormalizedReRankWeights {
    title: number;
    recency: number;
    usage: number;
    content: number;
    pageRank: number;
    proximity: number;
}

export interface HybridRetrievalScore {
    normalizedFusionScore: number;
    rawScore: number;
    sourceCoverage: number;
    retrievalScore: number;
}

export interface HybridFinalScore {
    finalScore: number;
    reRankBoost: number;
    breakdown: HybridScoreBreakdown;
}

const clamp01 = (score: number): number => Math.max(0, Math.min(1, score));
const clampSigned = (score: number): number => Math.max(-1, Math.min(1, score));

/**
 * Central scoring model for hybrid search.
 *
 * The scorer keeps retrieval fusion and re-ranking math explicit so the system
 * can be tuned without scattering relevance formulas across the search path.
 */
export class HybridRelevanceScorer {
    private settings: HybridSearchSettings;

    constructor(settings: HybridSearchSettings) {
        this.settings = settings;
    }

    updateSettings(settings: HybridSearchSettings): void {
        this.settings = settings;
    }

    createRetrievalContext(fusedResults: FusedResult[]): HybridRetrievalContext {
        return {
            hasKeywordResults: fusedResults.some((result) => Boolean(result.keywordResult)),
            hasSemanticResults: fusedResults.some((result) => Boolean(result.semanticResult)),
        };
    }

    score(
        fusedResult: FusedResult,
        signals: HybridReRankSignals,
        context: HybridRetrievalContext,
    ): HybridFinalScore {
        const retrieval = this.computeRetrievalScore(fusedResult, context);
        const reRankSignalScore = this.computeReRankSignalScore(signals);
        const penaltyScore = clamp01(0.1 * signals.bounce);
        const feedbackScore = clampSigned(signals.feedback);
        const feedbackAdjustment = 0.2 * feedbackScore;
        const reRankBoost = reRankSignalScore + feedbackAdjustment - penaltyScore;

        const finalScore = clamp01(
            (0.65 * retrieval.retrievalScore)
            + (0.35 * reRankBoost),
        );

        return {
            finalScore,
            reRankBoost,
            breakdown: {
                ...retrieval,
                reRankSignalScore,
                penaltyScore,
                feedbackScore,
                reRankBoost,
                finalScore,
                signals,
            },
        };
    }

    scoreWithoutReRanking(
        fusedResult: FusedResult,
        context: HybridRetrievalContext,
    ): HybridFinalScore {
        const neutralSignals: HybridReRankSignals = {
            title: 0,
            recency: 0,
            usage: 0,
            content: 0,
            pageRank: 0,
            proximity: 0,
            bounce: 0,
            feedback: 0,
        };
        const retrieval = this.computeRetrievalScore(fusedResult, context);

        return {
            finalScore: retrieval.retrievalScore,
            reRankBoost: 0,
            breakdown: {
                ...retrieval,
                reRankSignalScore: 0,
                penaltyScore: 0,
                feedbackScore: 0,
                reRankBoost: 0,
                finalScore: retrieval.retrievalScore,
                signals: neutralSignals,
            },
        };
    }

    /**
     * Score for results selected purely by frontmatter filters (no text query).
     * Every match is equally relevant; callers order them (e.g. by mtime).
     */
    scoreFilterMatch(): HybridFinalScore {
        const finalScore = 1;
        return {
            finalScore,
            reRankBoost: 0,
            breakdown: {
                normalizedFusionScore: 0,
                rawScore: 0,
                sourceCoverage: 0,
                retrievalScore: 0,
                reRankSignalScore: 0,
                penaltyScore: 0,
                feedbackScore: 0,
                reRankBoost: 0,
                finalScore,
                signals: {
                    title: 0,
                    recency: 0,
                    usage: 0,
                    content: 0,
                    pageRank: 0,
                    proximity: 0,
                    bounce: 0,
                    feedback: 0,
                },
            },
        };
    }

    computeRetrievalScore(
        fusedResult: FusedResult,
        context: HybridRetrievalContext,
    ): HybridRetrievalScore {
        const normalizedFusionScore = this.normalizeFusionScore(fusedResult, context);
        const rawScore = this.computeRawSourceScore(fusedResult);
        const sourceCoverage = this.computeSourceCoverage(fusedResult, context);

        const retrievalScore = clamp01(
            (0.6 * normalizedFusionScore)
            + (0.3 * rawScore)
            + (0.1 * sourceCoverage),
        );

        return {
            normalizedFusionScore,
            rawScore,
            sourceCoverage,
            retrievalScore,
        };
    }

    private normalizeFusionScore(
        fusedResult: FusedResult,
        context: HybridRetrievalContext,
    ): number {
        const activeWeight = this.getActiveSourceWeight(context);
        const maxRRFScore = activeWeight / (this.settings.rrfK + 1);

        if (maxRRFScore <= 0) {
            return 0;
        }

        return clamp01(fusedResult.fusionScore / maxRRFScore);
    }

    private computeRawSourceScore(fusedResult: FusedResult): number {
        let weightedScore = 0;
        let totalWeight = 0;

        if (fusedResult.keywordResult) {
            weightedScore += this.settings.keywordWeight * fusedResult.keywordResult.normalizedScore;
            totalWeight += this.settings.keywordWeight;
        }

        if (fusedResult.semanticResult) {
            weightedScore += this.settings.semanticWeight * fusedResult.semanticResult.normalizedScore;
            totalWeight += this.settings.semanticWeight;
        }

        if (totalWeight <= 0) {
            return 0;
        }

        return clamp01(weightedScore / totalWeight);
    }

    private computeSourceCoverage(
        fusedResult: FusedResult,
        context: HybridRetrievalContext,
    ): number {
        const activeWeight = this.getActiveSourceWeight(context);
        if (activeWeight <= 0) {
            return 0;
        }

        let matchedWeight = 0;
        if (fusedResult.keywordResult && context.hasKeywordResults) {
            matchedWeight += this.settings.keywordWeight;
        }

        if (fusedResult.semanticResult && context.hasSemanticResults) {
            matchedWeight += this.settings.semanticWeight;
        }

        return clamp01(matchedWeight / activeWeight);
    }

    private getActiveSourceWeight(context: HybridRetrievalContext): number {
        let activeWeight = 0;

        if (context.hasKeywordResults) {
            activeWeight += this.settings.keywordWeight;
        }

        if (context.hasSemanticResults) {
            activeWeight += this.settings.semanticWeight;
        }

        return activeWeight;
    }

    private computeReRankSignalScore(signals: HybridReRankSignals): number {
        const weights = this.getNormalizedReRankWeights();

        return clamp01(
            weights.title * signals.title
            + weights.recency * signals.recency
            + weights.usage * signals.usage
            + weights.content * signals.content
            + weights.pageRank * signals.pageRank
            + weights.proximity * signals.proximity,
        );
    }

    private getNormalizedReRankWeights(): NormalizedReRankWeights {
        const {
            reRankTitleWeight,
            reRankRecencyWeight,
            reRankUsageWeight,
            reRankContentWeight,
            reRankPageRankWeight,
            reRankProximityWeight,
        } = this.settings;

        const sum = reRankTitleWeight
            + reRankRecencyWeight
            + reRankUsageWeight
            + reRankContentWeight
            + reRankPageRankWeight
            + reRankProximityWeight;

        if (sum <= 0) {
            const fallbackWeight = 1 / 6;
            return {
                title: fallbackWeight,
                recency: fallbackWeight,
                usage: fallbackWeight,
                content: fallbackWeight,
                pageRank: fallbackWeight,
                proximity: fallbackWeight,
            };
        }

        return {
            title: reRankTitleWeight / sum,
            recency: reRankRecencyWeight / sum,
            usage: reRankUsageWeight / sum,
            content: reRankContentWeight / sum,
            pageRank: reRankPageRankWeight / sum,
            proximity: reRankProximityWeight / sum,
        };
    }
}
