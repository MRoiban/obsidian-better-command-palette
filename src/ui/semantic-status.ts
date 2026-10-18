/**
 * Status line text for modes that depend on semantic search (semantic and hybrid):
 * model loading, model errors and indexing progress. Uses real service state.
 */

import type BetterCommandPalettePlugin from 'src/main';
import { PromptStatus } from './prompt-chrome';

/** Obsidian's settings modal is available at runtime but not in the public typings. */
interface AppWithSettingModal {
    setting?: {
        open(): void;
        openTabById(id: string): void;
    };
}

/** Open this plugin's settings tab. */
export function openPluginSettings(plugin: BetterCommandPalettePlugin): void {
    const { setting } = plugin.app as unknown as AppWithSettingModal;
    if (!setting) {
        return;
    }
    setting.open();
    setting.openTabById(plugin.manifest.id);
}

function formatCount(value: number): string {
    return value.toLocaleString();
}

/**
 * Current semantic status, or null when there is nothing to report
 * (semantic search off, model ready and index idle).
 */
export function getSemanticStatus(plugin: BetterCommandPalettePlugin): PromptStatus | null {
    if (!plugin.settings.semanticSearch.enableSemanticSearch) {
        return null;
    }

    const service = plugin.getEmbeddingService();
    if (!service) {
        return null;
    }

    const provider = service.getProviderStatus();
    if (provider.state === 'loading') {
        const progress = typeof provider.progress === 'number' && provider.progress > 0 && provider.progress < 100
            ? ` (${Math.round(provider.progress)}%)`
            : '';
        return { text: `Loading the embedding model${progress}…` };
    }

    if (provider.state === 'error') {
        return {
            text: 'Couldn\'t load the embedding model.',
            isError: true,
            action: { label: 'Open settings', onClick: () => openPluginSettings(plugin) },
        };
    }

    const coordinator = plugin.semanticIndexingCoordinator;
    if (coordinator?.isIndexingInProgress()) {
        const indexed = coordinator.getStats().indexedFiles;
        const total = indexed + service.getFilesNeedingIndex().length;
        return { text: `Indexing ${formatCount(indexed)} of ${formatCount(total)} notes. Results may be incomplete.` };
    }

    return null;
}

/** Statuses are compared by content so unchanged polls don't touch the DOM. */
export function isSameStatus(a: PromptStatus | null, b: PromptStatus | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.text === b.text && !!a.isError === !!b.isError && a.action?.label === b.action?.label;
}
