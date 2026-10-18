import { App, Notice, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { configureSlider } from '../utils/setting-helpers';

type ScoreWeightKey = keyof BetterCommandPalettePlugin['settings']['enhancedSearch']['scoreWeights'];

export class SearchTab implements BaseSettingsTab {
    id = 'search';
    title = 'Search';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        // Own a root element so re-renders replace the tab content instead of appending to it
        this.render(containerEl.createDiv({ cls: 'bcp-settings-section' }), app, plugin);
    }

    private render(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        containerEl.empty();
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .setHeading('Search')
            .addSetting((setting) => setting
                .setName('Enable enhanced content search')
                .setDesc('Activate content indexing and smart scoring.')
                .addToggle((toggle) => toggle
                    .setValue(settings.enhancedSearch.enableContentSearch)
                    .onChange(async (value) => {
                        settings.enhancedSearch.enableContentSearch = value;
                        await plugin.saveSettings();
                        this.render(containerEl, app, plugin);
                    })));

        if (!settings.enhancedSearch.enableContentSearch) {
            return;
        }

        this.renderScoringWeights(containerEl, plugin);
        this.renderLinkGraph(containerEl, plugin);
        this.renderMatching(containerEl, plugin);
        this.renderPerformance(containerEl, plugin);
    }

    private renderScoringWeights(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { scoreWeights } = plugin.settings.enhancedSearch;
        const group = new SettingGroup(containerEl).setHeading('Scoring weights');

        const addWeight = (name: string, key: ScoreWeightKey) => {
            group.addSetting((setting) => configureSlider(setting, {
                name,
                min: 0,
                max: 1,
                step: 0.05,
                value: scoreWeights[key] || 0,
                onChange: (value) => {
                    scoreWeights[key] = value;
                    plugin.scheduleSettingsSave();
                },
            }));
        };

        addWeight('Content relevance', 'relevance');
        addWeight('Recency', 'recency');
        addWeight('Frequency', 'frequency');
        addWeight('Link importance', 'linkImportance');
    }

    private renderLinkGraph(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { linkGraph } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Link graph')
            .addSetting((setting) => setting
                .setName('Enable link graph')
                .setDesc('Compute page importance based on links (PageRank).')
                .addToggle((toggle) => toggle
                    .setValue(linkGraph.enabled)
                    .onChange(async (value) => {
                        linkGraph.enabled = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Damping factor',
                desc: 'Probability of continuing to follow links (0.85 is standard).',
                min: 0.5,
                max: 0.99,
                step: 0.01,
                value: linkGraph.dampingFactor,
                onChange: (value) => {
                    linkGraph.dampingFactor = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Max iterations',
                desc: 'Maximum number of calculation steps.',
                min: 10,
                max: 100,
                step: 5,
                value: linkGraph.maxIterations,
                onChange: (value) => {
                    linkGraph.maxIterations = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Link graph weight',
                desc: 'Weight of link importance in final scoring (0-1).',
                min: 0,
                max: 1,
                step: 0.05,
                value: linkGraph.weight,
                onChange: (value) => {
                    linkGraph.weight = value;
                    plugin.scheduleSettingsSave();
                },
            }));
    }

    private renderMatching(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { enhancedSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Matching')
            .addSetting((setting) => configureSlider(setting, {
                name: 'Typo tolerance',
                desc: 'Fuzzy matching level (0 = exact, 1 = minor typos, 2 = more lenient).',
                min: 0,
                max: 2,
                step: 1,
                value: enhancedSearch.typoTolerance,
                onChange: (value) => {
                    enhancedSearch.typoTolerance = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => setting
                .setName('Accent folding')
                .setDesc('Treat accented characters as equivalent (e.g., é = e).')
                .addToggle((toggle) => toggle
                    .setValue(enhancedSearch.foldAccents)
                    .onChange(async (value) => {
                        enhancedSearch.foldAccents = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Enable stemming')
                .setDesc('Match word variations (e.g., running = run).')
                .addToggle((toggle) => toggle
                    .setValue(enhancedSearch.enableStemming)
                    .onChange(async (value) => {
                        enhancedSearch.enableStemming = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Preserve query')
                .setDesc('Keep the search query when switching between search modes.')
                .addToggle((toggle) => toggle
                    .setValue(enhancedSearch.preserveQuery)
                    .onChange(async (value) => {
                        enhancedSearch.preserveQuery = value;
                        await plugin.saveSettings();
                    })));
    }

    private renderPerformance(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { enhancedSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Search performance')
            .addSetting((setting) => setting
                .setName('Enable usage tracking')
                .setDesc('Track file access for smarter ranking.')
                .addToggle((toggle) => toggle
                    .setValue(enhancedSearch.enableUsageTracking)
                    .onChange(async (value) => {
                        enhancedSearch.enableUsageTracking = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Maximum indexed files',
                min: 1000,
                max: 50000,
                step: 1000,
                value: enhancedSearch.maxIndexedFiles,
                onChange: (value) => {
                    enhancedSearch.maxIndexedFiles = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Indexing debounce (ms)',
                desc: 'Wait time after file changes before re-indexing.',
                min: 100,
                max: 5000,
                step: 100,
                value: enhancedSearch.indexingDebounceMs,
                onChange: (value) => {
                    enhancedSearch.indexingDebounceMs = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Max file size (KB)',
                desc: 'Skip indexing files larger than this (for performance).',
                min: 128,
                max: 2048,
                step: 128,
                value: Math.round(enhancedSearch.maxFileSize / 1024),
                onChange: (value) => {
                    enhancedSearch.maxFileSize = value * 1024;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Content preview length',
                desc: 'Length of content snippets in search results.',
                min: 50,
                max: 500,
                step: 50,
                value: enhancedSearch.contentPreviewLength,
                onChange: (value) => {
                    enhancedSearch.contentPreviewLength = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => setting
                .setName('Maintenance')
                .setDesc('Manage the search index.')
                .addButton((button) => button
                    .setButtonText('Rebuild index')
                    .onClick(async () => {
                        new Notice('Rebuilding index...');
                        // TODO: Call actual rebuild
                        setTimeout(() => new Notice('Done'), 1000);
                    }))
                .addButton((button) => button
                    .setButtonText('Clear cache')
                    .setWarning()
                    .onClick(async () => {
                        new Notice('Cache cleared');
                    })));
    }
}
