/**
 * Shows a single, updating Notice while a provider loads/downloads its model.
 * Quick loads (e.g. from cache) stay silent; a load that fails while the
 * progress Notice is visible turns that Notice into the error message.
 */

import { Notice } from 'obsidian';
import { EmbeddingProvider, ProviderStatus } from './types';

const SHOW_AFTER_MS = 1500;
const READY_NOTICE_MS = 3000;
const ERROR_NOTICE_MS = 10000;

export function attachModelLoadNotice(provider: EmbeddingProvider, title = 'Semantic search'): () => void {
    let notice: Notice | undefined;
    let showTimer: number | undefined;
    let latest: ProviderStatus = provider.getStatus();

    const clearShowTimer = () => {
        if (showTimer !== undefined) {
            window.clearTimeout(showTimer);
            showTimer = undefined;
        }
    };

    const closeLater = (current: Notice, delayMs: number) => {
        window.setTimeout(() => current.hide(), delayMs);
    };

    const onStatus = (status: ProviderStatus) => {
        latest = status;

        if (status.state === 'loading') {
            if (notice) {
                notice.setMessage(`${title}: ${status.message}`);
            } else if (showTimer === undefined) {
                showTimer = window.setTimeout(() => {
                    showTimer = undefined;
                    if (latest.state === 'loading') {
                        notice = new Notice(`${title}: ${latest.message}`, 0);
                    }
                }, SHOW_AFTER_MS);
            }
            return;
        }

        clearShowTimer();
        const current = notice;
        notice = undefined;
        if (!current) {
            return;
        }

        if (status.state === 'ready') {
            current.setMessage(`${title}: embedding model ${status.message.charAt(0).toLowerCase()}${status.message.slice(1)}`);
            closeLater(current, READY_NOTICE_MS);
        } else if (status.state === 'error') {
            current.setMessage(`${title}: ${status.message}`);
            closeLater(current, ERROR_NOTICE_MS);
        } else {
            current.hide();
        }
    };

    const unsubscribe = provider.onStatusChange(onStatus);
    return () => {
        unsubscribe();
        clearShowTimer();
        notice?.hide();
        notice = undefined;
    };
}
