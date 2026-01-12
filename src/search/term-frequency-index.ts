/**
 * Term Frequency Index
 * 
 * Tracks document frequency for each term to compute Inverse Document Frequency (IDF).
 * Used to weight query terms by their informativeness - rare terms get higher weight.
 * 
 * Inspired by Marginalia Search's approach to multi-term query ranking.
 */

import { logger } from '../utils/logger';

/**
 * Serializable format for persistence
 */
interface SerializedTermFrequencyIndex {
    version: string;
    totalDocuments: number;
    termDocCount: [string, number][];
    docTerms: [string, string[]][];
}

/**
 * Tracks term document frequencies for IDF-based term weighting
 */
export class TermFrequencyIndex {
    /** Map of term -> number of documents containing this term */
    private termDocCount: Map<string, number> = new Map();

    /** Map of docId -> terms in that document (for removal support) */
    private docTerms: Map<string, Set<string>> = new Map();

    /** Total number of documents indexed */
    private totalDocuments = 0;

    private static readonly VERSION = '1.0.0';

    /**
     * Add a document's terms to the index
     * @param docId Unique document identifier (file path)
     * @param terms Array of normalized terms from the document
     */
    addDocument(docId: string, terms: string[]): void {
        // If document already exists, remove it first to update counts
        if (this.docTerms.has(docId)) {
            this.removeDocument(docId);
        }

        // Get unique terms for this document
        const uniqueTerms = new Set(terms.filter((t) => t && t.length >= 2));

        // Store terms for this document
        this.docTerms.set(docId, uniqueTerms);
        this.totalDocuments++;

        // Update term document counts
        for (const term of uniqueTerms) {
            const currentCount = this.termDocCount.get(term) || 0;
            this.termDocCount.set(term, currentCount + 1);
        }
    }

    /**
     * Remove a document from the index
     * @param docId Document identifier to remove
     */
    removeDocument(docId: string): void {
        const terms = this.docTerms.get(docId);
        if (!terms) {
            return;
        }

        // Decrement document counts for each term
        for (const term of terms) {
            const currentCount = this.termDocCount.get(term) || 0;
            if (currentCount <= 1) {
                this.termDocCount.delete(term);
            } else {
                this.termDocCount.set(term, currentCount - 1);
            }
        }

        this.docTerms.delete(docId);
        this.totalDocuments = Math.max(0, this.totalDocuments - 1);
    }

    /**
     * Compute IDF for a term using smoothed formula
     * IDF = log((N + 1) / (df + 1)) where N = total docs, df = docs with term
     * 
     * @param term Normalized term to compute IDF for
     * @returns IDF value (higher = rarer term = more informative)
     */
    getIDF(term: string): number {
        const docFreq = this.termDocCount.get(term) || 0;

        // Smoothed IDF to handle edge cases (unknown terms, small corpus)
        // Adding 1 to both numerator and denominator prevents division by zero
        // and provides reasonable behavior for terms not in the corpus
        const idf = Math.log((this.totalDocuments + 1) / (docFreq + 1));

        return Math.max(0, idf);
    }

    /**
     * Get document frequency for a term
     * @param term Normalized term
     * @returns Number of documents containing this term
     */
    getDocumentFrequency(term: string): number {
        return this.termDocCount.get(term) || 0;
    }

    /**
     * Compute normalized IDF weights for a set of query terms
     * Weights sum to 1.0 for easy integration with existing scoring
     * 
     * @param terms Array of query terms
     * @returns Map of term -> normalized weight
     */
    getTermWeights(terms: string[]): Map<string, number> {
        const weights = new Map<string, number>();

        if (terms.length === 0) {
            return weights;
        }

        // Compute raw IDF for each term
        let totalIDF = 0;
        for (const term of terms) {
            const idf = this.getIDF(term);
            weights.set(term, idf);
            totalIDF += idf;
        }

        // Normalize weights to sum to 1
        if (totalIDF > 0) {
            for (const [term, idf] of weights) {
                weights.set(term, idf / totalIDF);
            }
        } else {
            // Fallback to uniform weights if all IDFs are 0
            const uniformWeight = 1 / terms.length;
            for (const term of terms) {
                weights.set(term, uniformWeight);
            }
        }

        return weights;
    }

    /**
     * Get statistics about the index
     */
    getStats(): { totalDocuments: number; uniqueTerms: number } {
        return {
            totalDocuments: this.totalDocuments,
            uniqueTerms: this.termDocCount.size,
        };
    }

    /**
     * Clear the entire index
     */
    clear(): void {
        this.termDocCount.clear();
        this.docTerms.clear();
        this.totalDocuments = 0;
    }

    /**
     * Serialize the index for persistence
     */
    serialize(): SerializedTermFrequencyIndex {
        return {
            version: TermFrequencyIndex.VERSION,
            totalDocuments: this.totalDocuments,
            termDocCount: Array.from(this.termDocCount.entries()),
            docTerms: Array.from(this.docTerms.entries()).map(
                ([docId, terms]) => [docId, Array.from(terms)],
            ),
        };
    }

    /**
     * Deserialize the index from persisted data
     */
    deserialize(data: SerializedTermFrequencyIndex): boolean {
        try {
            if (data.version !== TermFrequencyIndex.VERSION) {
                logger.warn(`[TermFrequencyIndex] Version mismatch: ${data.version} vs ${TermFrequencyIndex.VERSION}`);
                return false;
            }

            this.totalDocuments = data.totalDocuments;
            this.termDocCount = new Map(data.termDocCount);
            this.docTerms = new Map(
                data.docTerms.map(([docId, terms]) => [docId, new Set(terms)]),
            );

            logger.debug(`[TermFrequencyIndex] Loaded ${this.totalDocuments} docs, ${this.termDocCount.size} unique terms`);
            return true;
        } catch (error) {
            logger.error('[TermFrequencyIndex] Failed to deserialize:', error);
            return false;
        }
    }

    /**
     * Debug: Log IDF values for query terms
     */
    logQueryTermWeights(terms: string[]): void {
        const weights = this.getTermWeights(terms);
        const debugInfo = terms.map((term) => {
            const df = this.getDocumentFrequency(term);
            const idf = this.getIDF(term);
            const weight = weights.get(term) || 0;
            return `"${term}": df=${df}, idf=${idf.toFixed(2)}, weight=${(weight * 100).toFixed(1)}%`;
        });
        logger.debug(`[TermFrequencyIndex] Query term weights (N=${this.totalDocuments}):\n  ${debugInfo.join('\n  ')}`);
    }
}
