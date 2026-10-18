import { App, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { configureSlider, createWarning, describe } from '../utils/setting-helpers';

type HybridSettings = BetterCommandPalettePlugin['settings']['hybridSearch'];
type HybridWeightKey = {
    [K in keyof HybridSettings]: HybridSettings[K] extends number ? K : never;
}[keyof HybridSettings];

export class HybridTab implements BaseSettingsTab {
    id = 'hybrid';
    title = 'Hybrid search';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        // Own a root element so re-renders replace the tab content instead of appending to it
        this.render(containerEl.createDiv({ cls: 'bcp-settings-section' }), app, plugin);
    }

    private render(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        containerEl.empty();
        const { settings } = plugin;

        this.renderEnable(containerEl, app, plugin);

        if (!settings.hybridSearch.enabled) {
            return;
        }

        this.renderFusion(containerEl, plugin);
        this.renderReRanking(containerEl, plugin);
        this.renderBehaviour(containerEl, plugin);
        this.renderClustering(containerEl, plugin);
    }

    private renderEnable(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;
        const showSemanticWarning = settings.hybridSearch.enabled && !settings.semanticSearch.enableSemanticSearch;

        new SettingGroup(containerEl)
            .setHeading('Hybrid search')
            .addSetting((setting) => setting
                .setName('Enable hybrid search')
                .setDesc(describe((fragment) => {
                    fragment.createDiv({
                        text: settings.hybridSearch.enabled
                            ? 'Combine keyword and semantic search for Google-like results.'
                            : 'Combine keyword and semantic search for Google-like results. Turn this on to access advanced configuration.',
                    });
                    if (showSemanticWarning) {
                        createWarning(fragment.createDiv(), 'Semantic search is not enabled. Hybrid search works best when semantic search is active.');
                    }
                }))
                .addToggle((toggle) => toggle
                    .setValue(settings.hybridSearch.enabled)
                    .onChange(async (value) => {
                        settings.hybridSearch.enabled = value;
                        await plugin.saveSettings();
                        this.render(containerEl, app, plugin);
                    })));
    }

    private renderFusion(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { hybridSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Fusion')
            .addSetting((setting) => configureSlider(setting, {
                name: 'RRF K parameter',
                desc: 'Balance between high-ranking and low-ranking items (default: 60).',
                min: 1,
                max: 100,
                step: 1,
                value: hybridSearch.rrfK,
                onChange: (value) => {
                    hybridSearch.rrfK = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Keyword weight',
                desc: 'Importance of keyword matches (0-1).',
                min: 0,
                max: 1,
                step: 0.1,
                value: hybridSearch.keywordWeight,
                onChange: (value) => {
                    hybridSearch.keywordWeight = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Semantic weight',
                desc: 'Importance of semantic matches (0-1).',
                min: 0,
                max: 1,
                step: 0.1,
                value: hybridSearch.semanticWeight,
                onChange: (value) => {
                    hybridSearch.semanticWeight = value;
                    plugin.scheduleSettingsSave();
                },
            }));
    }

    /** Smart-scoring pass over the fused results (separate from the semantic cross-encoder reranker). */
    private renderReRanking(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { hybridSearch } = plugin.settings;
        const group = new SettingGroup(containerEl)
            .setHeading('Hybrid re-ranking')
            .addSetting((setting) => setting
                .setName('Enable re-ranking')
                .setDesc('Apply smart scoring to refine top results.')
                .addToggle((toggle) => toggle
                    .setValue(hybridSearch.enableReRanking)
                    .onChange(async (value) => {
                        hybridSearch.enableReRanking = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Re-rank pool size',
                desc: 'How many results to re-rank (default: 15).',
                min: 5,
                max: 50,
                step: 5,
                value: hybridSearch.reRankPoolSize,
                onChange: (value) => {
                    hybridSearch.reRankPoolSize = value;
                    plugin.scheduleSettingsSave();
                },
            }));

        const addWeight = (name: string, desc: string, key: HybridWeightKey) => {
            group.addSetting((setting) => configureSlider(setting, {
                name,
                desc,
                min: 0,
                max: 1,
                step: 0.1,
                value: hybridSearch[key],
                onChange: (value) => {
                    hybridSearch[key] = value;
                    plugin.scheduleSettingsSave();
                },
            }));
        };

        addWeight('Title match weight', 'Boost title matches.', 'reRankTitleWeight');
        addWeight('Recency weight', 'Boost recently modified files.', 'reRankRecencyWeight');
        addWeight('Usage weight', 'Boost frequently accessed files.', 'reRankUsageWeight');
        addWeight('Link importance weight', 'Boost well-connected files (PageRank).', 'reRankPageRankWeight');
        addWeight('Content density weight', 'Boost files with more matching content.', 'reRankContentWeight');
        addWeight('Term proximity weight', 'Boost files where terms appear close together.', 'reRankProximityWeight');
    }

    private renderBehaviour(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { hybridSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Hybrid behaviour')
            .addSetting((setting) => configureSlider(setting, {
                name: 'Maximum results',
                desc: 'Maximum number of search results to return.',
                min: 5,
                max: 50,
                step: 5,
                value: hybridSearch.maxResults,
                onChange: (value) => {
                    hybridSearch.maxResults = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Minimum score threshold',
                desc: 'Exclude results below this score (0-1).',
                min: 0,
                max: 0.5,
                step: 0.05,
                value: hybridSearch.minScoreThreshold,
                onChange: (value) => {
                    hybridSearch.minScoreThreshold = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => setting
                .setName('Show match reasons')
                .setDesc('Display explanations for why results matched.')
                .addToggle((toggle) => toggle
                    .setValue(hybridSearch.showMatchReasons)
                    .onChange(async (value) => {
                        hybridSearch.showMatchReasons = value;
                        await plugin.saveSettings();
                    })));
    }

    private renderClustering(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { hybridSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Result clustering')
            .addSetting((setting) => setting
                .setName('Enable result clustering')
                .setDesc('Group similar notes together in search results.')
                .addToggle((toggle) => toggle
                    .setValue(hybridSearch.enableClustering)
                    .onChange(async (value) => {
                        hybridSearch.enableClustering = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Cluster similarity threshold',
                desc: 'How similar notes must be to cluster (higher = stricter).',
                min: 0.7,
                max: 0.95,
                step: 0.05,
                value: hybridSearch.clusterSimilarityThreshold,
                onChange: (value) => {
                    hybridSearch.clusterSimilarityThreshold = value;
                    plugin.scheduleSettingsSave();
                },
            }));
    }
}
