/**
 * Small HTTP helpers for talking to the embedding backend.
 */

/** Error that should not be retried (e.g. 400/404 from a bad model name). */
export class NonRetryableEmbeddingError extends Error {
    readonly status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = 'NonRetryableEmbeddingError';
        this.status = status;
    }
}

/** 5xx, 408 (timeout) and 429 (rate limited) are worth retrying; other 4xx are not. */
export function isRetryableHttpStatus(status: number): boolean {
    if (status >= 500) return true;
    if (status === 408 || status === 429) return true;
    return status < 400;
}

/** Extract an HTTP status from an error thrown by requestUrl, if any. */
export function getErrorHttpStatus(error: unknown): number | undefined {
    if (error && typeof error === 'object' && 'status' in error) {
        const { status } = error as { status?: unknown };
        if (typeof status === 'number') {
            return status;
        }
    }
    return undefined;
}

/** Remove `user:password@` from a URL so it can be logged safely. */
export function redactUrlCredentials(url: string): string {
    try {
        const parsed = new URL(url);
        if (!parsed.username && !parsed.password) {
            return url;
        }
        parsed.username = '';
        parsed.password = '';
        return parsed.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
    } catch {
        return url.replace(/\/\/[^/@]*@/, '//');
    }
}
