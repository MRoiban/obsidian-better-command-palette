/**
 * Single, updating Notice while the reranker downloads/loads its model. Same behaviour
 * as the embedding model notice: quick (cached) loads stay silent, and a load that
 * fails while the progress Notice is visible turns it into the error message.
 */

import { Notice } from 'obsidian';
import type { ProviderStatus, ProviderStatusListener } from '../providers/types';

const SHOW_AFTER_MS = 1500;
const READY_NOTICE_MS = 3000;
const ERROR_NOTICE_MS = 10000;

export interface StatusSource {
    getStatus(): ProviderStatus;
    onStatusChange(listener: ProviderStatusListener): () => void;
}

export function attachRerankerLoadNotice(source: StatusSource, title = 'Reranker'): () => void {
    let notice: Notice | undefined;
    let showTimer: number | undefined;
    let latest: ProviderStatus = source.getStatus();

    const clearShowTimer = () => {
        if (showTimer !== undefined) {
            window.clearTimeout(showTimer);
            showTimer = undefined;
        }
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
        if (status.state === 'ready' || status.state === 'error') {
            current.setMessage(`${title}: ${status.message}`);
            window.setTimeout(() => current.hide(), status.state === 'ready' ? READY_NOTICE_MS : ERROR_NOTICE_MS);
        } else {
            current.hide();
        }
    };

    const unsubscribe = source.onStatusChange(onStatus);
    return () => {
        unsubscribe();
        clearShowTimer();
        notice?.hide();
        notice = undefined;
    };
}
