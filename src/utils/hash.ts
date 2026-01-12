/**
 * Generates a simple hash from a string using a djb2-like algorithm.
 * This is used for content fingerprinting and cache invalidation.
 *
 * @param content - The string content to hash
 * @param base - The base to use for string conversion (default: 36)
 * @returns A hash string representation
 */
export function generateContentHash(content: string, base: number = 36): string {
    let hash = 0;

    if (!content || content.length === 0) {
        return '0';
    }

    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash &= hash; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString(base);
}

/**
 * Generates a hash using base 16 (hexadecimal) encoding
 */
export function generateContentHashHex(content: string): string {
    return generateContentHash(content, 16);
}

/**
 * Generates a hash using base 36 encoding (default)
 */
export function generateContentHashBase36(content: string): string {
    return generateContentHash(content, 36);
}

/**
 * Combines multiple strings and generates a hash from the result
 */
export function generateCombinedHash(...contents: string[]): string {
    const combined = contents.join('|');
    return generateContentHash(combined);
}
