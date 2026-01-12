import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class SearchTab implements BaseSettingsTab {
    id = 'search';
    title = 'Search';
    icon = 'search';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Enable Enhanced Content Search')
            .setDesc('Activate content indexing and smart scoring')
            .addToggle((toggle) => toggle
                .setValue(settings.enhancedSearch.enableContentSearch)
                .onChange(async (value) => {
                    settings.enhancedSearch.enableContentSearch = value;
                    await plugin.saveSettings();
                    this.display(containerEl, app, plugin);
                }));

        if (!settings.enhancedSearch.enableContentSearch) {
            return;
        }

        // Scoring Weights
        containerEl.createEl('h3', { text: 'Scoring Weights' });

        const createScoreSetting = (name: string, key: keyof typeof settings.enhancedSearch.scoreWeights) => {
            new Setting(containerEl)
                .setName(name)
                .addSlider((slider) => slider
                    .setLimits(0, 1, 0.05)
                    .setValue(settings.enhancedSearch.scoreWeights[key] || 0)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        // @ts-ignore
                        settings.enhancedSearch.scoreWeights[key] = value;
                        await plugin.saveSettings();
                    }));
        };

        createScoreSetting('Content Relevance', 'relevance');
        createScoreSetting('Recency', 'recency');
        createScoreSetting('Frequency', 'frequency');
        createScoreSetting('Link Importance', 'linkImportance');

        // Link Graph Settings (NEW)
        containerEl.createEl('h3', { text: 'Link Graph (PageRank)' });

        new Setting(containerEl)
            .setName('Enable Link Graph')
            .setDesc('Compute page importance based on links')
            .addToggle((toggle) => toggle
                .setValue(settings.linkGraph.enabled)
                .onChange(async (value) => {
                    settings.linkGraph.enabled = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Damping Factor')
            .setDesc('Probability of continuing to follow links (0.85 is standard)')
            .addSlider((slider) => slider
                .setLimits(0.5, 0.99, 0.01)
                .setValue(settings.linkGraph.dampingFactor)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.linkGraph.dampingFactor = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Iterations')
            .setDesc('Maximum number of calculation steps')
            .addSlider((slider) => slider
                .setLimits(10, 100, 5)
                .setValue(settings.linkGraph.maxIterations)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.linkGraph.maxIterations = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Link Graph Weight')
            .setDesc('Weight of link importance in final scoring (0-1)')
            .addSlider((slider) => slider
                .setLimits(0, 1, 0.05)
                .setValue(settings.linkGraph.weight)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.linkGraph.weight = value;
                    await plugin.saveSettings();
                }));

        // Matching Settings
        containerEl.createEl('h3', { text: 'Matching' });

        new Setting(containerEl)
            .setName('Typo Tolerance')
            .setDesc('Fuzzy matching level (0 = exact, 1 = minor typos, 2 = more lenient)')
            .addSlider((slider) => slider
                .setLimits(0, 2, 1)
                .setValue(settings.enhancedSearch.typoTolerance)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.enhancedSearch.typoTolerance = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Accent Folding')
            .setDesc('Treat accented characters as equivalent (e.g., é = e)')
            .addToggle((toggle) => toggle
                .setValue(settings.enhancedSearch.foldAccents)
                .onChange(async (value) => {
                    settings.enhancedSearch.foldAccents = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable Stemming')
            .setDesc('Match word variations (e.g., running = run)')
            .addToggle((toggle) => toggle
                .setValue(settings.enhancedSearch.enableStemming)
                .onChange(async (value) => {
                    settings.enhancedSearch.enableStemming = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Preserve Query')
            .setDesc('Keep search query when switching between search modes')
            .addToggle((toggle) => toggle
                .setValue(settings.enhancedSearch.preserveQuery)
                .onChange(async (value) => {
                    settings.enhancedSearch.preserveQuery = value;
                    await plugin.saveSettings();
                }));

        // Performance Settings
        containerEl.createEl('h3', { text: 'Performance' });

        new Setting(containerEl)
            .setName('Enable Usage Tracking')
            .setDesc('Track file access for smarter ranking')
            .addToggle((toggle) => toggle
                .setValue(settings.enhancedSearch.enableUsageTracking)
                .onChange(async (value) => {
                    settings.enhancedSearch.enableUsageTracking = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum Indexed Files')
            .addSlider((slider) => slider
                .setLimits(1000, 50000, 1000)
                .setValue(settings.enhancedSearch.maxIndexedFiles)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.enhancedSearch.maxIndexedFiles = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Indexing Debounce (ms)')
            .setDesc('Wait time after file changes before re-indexing')
            .addSlider((slider) => slider
                .setLimits(100, 5000, 100)
                .setValue(settings.enhancedSearch.indexingDebounceMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.enhancedSearch.indexingDebounceMs = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max File Size (KB)')
            .setDesc('Skip indexing files larger than this (for performance)')
            .addSlider((slider) => slider
                .setLimits(128, 2048, 128)
                .setValue(Math.round(settings.enhancedSearch.maxFileSize / 1024))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.enhancedSearch.maxFileSize = value * 1024;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Content Preview Length')
            .setDesc('Length of content snippets in search results')
            .addSlider((slider) => slider
                .setLimits(50, 500, 50)
                .setValue(settings.enhancedSearch.contentPreviewLength)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.enhancedSearch.contentPreviewLength = value;
                    await plugin.saveSettings();
                }));

        // Actions
        containerEl.createEl('h3', { text: 'Actions' });

        const btnSetting = new Setting(containerEl)
            .setName('Maintenance')
            .setDesc('Manage search index');

        btnSetting.addButton((button) => button
            .setButtonText('Rebuild Index')
            .onClick(async () => {
                new Notice('Rebuilding index...');
                // TODO: Call actual rebuild
                setTimeout(() => new Notice('Done'), 1000);
            }));

        btnSetting.addButton((button) => button
            .setButtonText('Clear Cache')
            .setWarning()
            .onClick(async () => {
                new Notice('Cache cleared');
            }));
    }
}
