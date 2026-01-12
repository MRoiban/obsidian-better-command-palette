import {
    Modifier,
} from 'obsidian';
import { HotkeyStyleType, MacroCommandInterface } from './types/types';
import { SearchSettings } from './search/interfaces';
import { SemanticSearchSettings } from './search/semantic/types';
import { HybridSearchSettings, DEFAULT_HYBRID_SEARCH_SETTINGS } from './search/hybrid/types';
import { LinkGraphSettings, DEFAULT_LINK_GRAPH_SETTINGS } from './search/link-graph-service';

export interface BetterCommandPalettePluginSettings {
    closeWithBackspace: boolean,
    showPluginName: boolean,
    fileSearchPrefix: string,
    tagSearchPrefix: string,
    commandSearchHotkey: string,
    fileSearchHotkey: string,
    tagSearchHotkey: string,
    suggestionLimit: number,
    recentAbovePinned: boolean,
    hyperKeyOverride: boolean,
    displayOnlyNotesNames: boolean,
    hideMdExtension: boolean,
    recentlyUsedText: string,
    macros: MacroCommandInterface[],
    hotkeyStyle: HotkeyStyleType;
    createNewFileMod: Modifier,
    openInNewTabMod: Modifier,
    hiddenCommands: string[],
    hiddenFiles: string[],
    hiddenTags: string[],
    fileTypeExclusion: string[],
    enhancedSearch: SearchSettings,
    semanticSearch: SemanticSearchSettings,
    hybridSearch: HybridSearchSettings,
    linkGraph: LinkGraphSettings,
    quickLink: {
        enabled: boolean,
        defaultHotkey: string,
        autoCloseModal: boolean,
        searchEngine: 'enhanced' | 'semantic' | 'hybrid',
    },
}

export const DEFAULT_SETTINGS: BetterCommandPalettePluginSettings = {
    closeWithBackspace: true,
    showPluginName: true,
    fileSearchPrefix: '/',
    tagSearchPrefix: '#',
    commandSearchHotkey: 'p',
    fileSearchHotkey: 'o',
    tagSearchHotkey: 't',
    suggestionLimit: 50,
    recentAbovePinned: false,
    hyperKeyOverride: false,
    displayOnlyNotesNames: false,
    hideMdExtension: false,
    recentlyUsedText: '(recently used)',
    macros: [],
    hotkeyStyle: 'auto',
    createNewFileMod: 'Mod',
    openInNewTabMod: 'Shift',
    hiddenCommands: [],
    hiddenFiles: [],
    hiddenTags: [],
    fileTypeExclusion: [],
    enhancedSearch: {
        scoreWeights: {
            relevance: 0.5,
            recency: 0.2,
            frequency: 0.15,
            linkImportance: 0.15,
        },
        recencyHalfLife: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
        maxUsageScore: 100,
        maxIndexedFiles: 10000,
        enableUsageTracking: true,
        indexingDebounceMs: 1000, // Increased debounce for less frequent updates
        searchTimeoutMs: 5000,
        contentPreviewLength: 200,
        enableContentSearch: true,
        preserveQuery: false, // Preserve search query when switching modes
        // Performance settings for smoother indexing
        indexingBatchSize: 2, // Small batches for better responsiveness
        indexingDelayMs: 150, // Longer delay between files
        indexingBatchDelayMs: 400, // Longer delay between batches
        maxFileSize: 512 * 1024, // 512KB limit for better performance
        typoTolerance: 1,
        foldAccents: true,
        enableStemming: false,
        synonyms: [],
    },
    semanticSearch: {
        enableSemanticSearch: false, // Disabled by default until user configures Ollama
        ollamaUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
        searchThreshold: 0.3,
        maxResults: 10,
        chunkSize: 1000,
        maxConcurrentRequests: 5, // Default concurrent requests (max 10)
        enableAdaptiveThrottling: true, // Smart throttling enabled by default
        cacheEnabled: true,
        excludePatterns: ['**/node_modules/**', '**/.git/**', '**/.*/**', '**/*.excalidraw.md', '**/*.sfile.md'], // Default exclusions
        preserveQuery: false, // Preserve search query when switching modes
    },
    hybridSearch: DEFAULT_HYBRID_SEARCH_SETTINGS,
    linkGraph: DEFAULT_LINK_GRAPH_SETTINGS,
    quickLink: {
        enabled: true,
        defaultHotkey: 'l',
        autoCloseModal: true,
        searchEngine: 'enhanced',
    },
};
