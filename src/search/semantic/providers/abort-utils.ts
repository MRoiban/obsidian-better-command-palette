/**
 * Abort/timeout helpers shared by embedding providers and the embedding service.
 */

export function createAbortError(message = 'Embedding request aborted'): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw createAbortError();
    }
}

export function delayWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        let timeoutId: number | undefined;
        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };
        const cleanup = () => {
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
            signal?.removeEventListener('abort', onAbort);
        };

        timeoutId = window.setTimeout(() => {
            cleanup();
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Settle with `promise`, or reject on timeout/abort, whichever comes first.
 * The underlying work is not cancelled; its late result is ignored.
 */
export function withAbortAndTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
    timeoutMessage = `Embedding request timed out after ${timeoutMs}ms`,
): Promise<T> {
    throwIfAborted(signal);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId: number | undefined;
        const onAbort = () => rejectOnce(createAbortError());
        const cleanup = () => {
            if (timeoutId !== undefined) {
                window.clearTimeout(timeoutId);
            }
            signal?.removeEventListener('abort', onAbort);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        };
        const resolveOnce = (value: T) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(value);
        };

        timeoutId = window.setTimeout(() => {
            rejectOnce(new Error(timeoutMessage));
        }, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(resolveOnce, rejectOnce);
    });
}
