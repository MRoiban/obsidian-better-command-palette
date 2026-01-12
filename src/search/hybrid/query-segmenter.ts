/**
 * Query Segmenter
 * 
 * Breaks multi-word queries into conceptual groups using a phrase lexicon
 * built from the vault. Inspired by Marginalia Search's query segmentation.
 * 
 * Example: "machine learning notes" → ["machine learning", "notes"]
 */

import { App } from 'obsidian';
import { logger } from '../../utils/logger';

/**
 * A segment represents a conceptual phrase or single term from a query
 */
export interface QuerySegment {
    /** The text of the segment */
    text: string;
    /** Whether this segment was found in the phrase lexicon */
    isPhrase: boolean;
    /** Start position in original query */
    startIndex: number;
    /** End position in original query */
    endIndex: number;
}

/**
 * Result of query segmentation
 */
export interface SegmentedQuery {
    /** Original query string */
    original: string;
    /** Array of segments */
    segments: QuerySegment[];
    /** Flattened terms for traditional search */
    terms: string[];
}

/**
 * Query segmenter that uses a phrase lexicon to identify multi-word concepts
 */
export class QuerySegmenter {
    private phraseLexicon: Set<string> = new Set();

    private phrasesByFirstWord: Map<string, string[]> = new Map();

    private maxPhraseLength = 0;

    private isBuilt = false;

    /**
     * Build the phrase lexicon from the vault
     */
    async buildLexicon(app: App): Promise<void> {
        const startTime = Date.now();
        this.phraseLexicon.clear();
        this.phrasesByFirstWord.clear();

        const files = app.vault.getMarkdownFiles();

        for (const file of files) {
            // Add note title (basename) if it contains multiple words
            this.addPhraseIfMultiWord(file.basename);

            // Get metadata for aliases and links
            const metadata = app.metadataCache.getFileCache(file);

            if (metadata) {
                // Add aliases
                if (metadata.frontmatter?.aliases) {
                    const aliases = Array.isArray(metadata.frontmatter.aliases)
                        ? metadata.frontmatter.aliases
                        : [metadata.frontmatter.aliases];

                    for (const alias of aliases) {
                        if (typeof alias === 'string') {
                            this.addPhraseIfMultiWord(alias);
                        }
                    }
                }

                // Add link display texts
                if (metadata.links) {
                    for (const link of metadata.links) {
                        // Use display text if different from link
                        if (link.displayText && link.displayText !== link.link) {
                            this.addPhraseIfMultiWord(link.displayText);
                        }
                        // Also add the link target (note name)
                        this.addPhraseIfMultiWord(link.link);
                    }
                }

                // Add headings
                if (metadata.headings) {
                    for (const heading of metadata.headings) {
                        this.addPhraseIfMultiWord(heading.heading);
                    }
                }
            }
        }

        // Build index by first word for faster lookup
        this.buildFirstWordIndex();

        this.isBuilt = true;
        const elapsed = Date.now() - startTime;
        logger.debug(`[QuerySegmenter] Built lexicon with ${this.phraseLexicon.size} phrases from ${files.length} files in ${elapsed}ms`);
    }

    /**
     * Add a phrase to the lexicon if it contains multiple words
     */
    private addPhraseIfMultiWord(text: string): void {
        if (!text) return;

        const normalized = this.normalizePhrase(text);
        const words = normalized.split(/\s+/).filter((w) => w.length > 0);

        // Only add phrases with 2+ words
        if (words.length >= 2) {
            this.phraseLexicon.add(normalized);
            this.maxPhraseLength = Math.max(this.maxPhraseLength, words.length);
        }
    }

    /**
     * Normalize a phrase for consistent matching
     */
    private normalizePhrase(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s'-]/gu, ' ') // Keep letters, numbers, spaces, hyphens, apostrophes
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Build an index of phrases by their first word for faster lookup
     */
    private buildFirstWordIndex(): void {
        this.phrasesByFirstWord.clear();

        for (const phrase of this.phraseLexicon) {
            const firstWord = phrase.split(/\s+/)[0];
            if (firstWord) {
                const existing = this.phrasesByFirstWord.get(firstWord) || [];
                existing.push(phrase);
                this.phrasesByFirstWord.set(firstWord, existing);
            }
        }

        // Sort phrases by length (longest first) for greedy matching
        for (const [key, phrases] of this.phrasesByFirstWord) {
            phrases.sort((a, b) => b.length - a.length);
            this.phrasesByFirstWord.set(key, phrases);
        }
    }

    /**
     * Segment a query into conceptual groups
     * Uses greedy longest-match-first algorithm
     */
    segmentQuery(query: string): SegmentedQuery {
        const normalized = this.normalizePhrase(query);
        const words = normalized.split(/\s+/).filter((w) => w.length > 0);

        if (words.length === 0) {
            return {
                original: query,
                segments: [],
                terms: [],
            };
        }

        const segments: QuerySegment[] = [];
        let i = 0;
        let charIndex = 0;

        while (i < words.length) {
            const currentWord = words[i];
            let matchedPhrase: string | null = null;
            let matchedLength = 1;

            // Look for longest matching phrase starting with this word
            if (this.isBuilt) {
                const candidatePhrases = this.phrasesByFirstWord.get(currentWord) || [];

                for (const phrase of candidatePhrases) {
                    const phraseWords = phrase.split(/\s+/);

                    // Check if we have enough words left
                    if (i + phraseWords.length <= words.length) {
                        // Check if all words match
                        let matches = true;
                        for (let j = 0; j < phraseWords.length; j++) {
                            if (words[i + j] !== phraseWords[j]) {
                                matches = false;
                                break;
                            }
                        }

                        if (matches) {
                            matchedPhrase = phrase;
                            matchedLength = phraseWords.length;
                            break; // Greedy: take first (longest) match
                        }
                    }
                }
            }

            // Create segment
            const segmentWords = words.slice(i, i + matchedLength);
            const segmentText = segmentWords.join(' ');
            const startIndex = charIndex;
            const endIndex = charIndex + segmentText.length;

            segments.push({
                text: segmentText,
                isPhrase: matchedPhrase !== null,
                startIndex,
                endIndex,
            });

            // Advance position
            charIndex = endIndex + 1; // +1 for space
            i += matchedLength;
        }

        return {
            original: query,
            segments,
            terms: words,
        };
    }

    /**
     * Get the phrase lexicon size (for debugging/stats)
     */
    getLexiconSize(): number {
        return this.phraseLexicon.size;
    }

    /**
     * Check if lexicon has been built
     */
    isReady(): boolean {
        return this.isBuilt;
    }

    /**
     * Clear the lexicon
     */
    clear(): void {
        this.phraseLexicon.clear();
        this.phrasesByFirstWord.clear();
        this.maxPhraseLength = 0;
        this.isBuilt = false;
    }
}
