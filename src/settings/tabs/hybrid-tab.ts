import { App, Setting } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class HybridTab implements BaseSettingsTab {
    id = 'hybrid';
    title = 'Hybrid';
    icon = 'layers';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Enable Hybrid Search')
            .setDesc('Combine keyword and semantic search for Google-like results')
            .addToggle((toggle) => toggle
                .setValue(settings.hybridSearch.enabled)
                .onChange(async (value) => {
                    settings.hybridSearch.enabled = value;
                    await plugin.saveSettings();
                    this.display(containerEl, app, plugin);
                }));

        if (!settings.hybridSearch.enabled) {
            containerEl.createEl('div', { cls: 'settings-info', text: 'Enable hybrid search to access advanced configuration.' });
            return;
        }

        if (!settings.semanticSearch.enableSemanticSearch) {
            containerEl.createEl('div', { cls: 'settings-warning', text: '⚠️ Semantic search is not enabled. Hybrid search works best when Semantic Search is active.' });
        }

        // --- Fusion Settings ---
        containerEl.createEl('h3', { text: 'Fusion Settings' });

        new Setting(containerEl)
            .setName('RRF K Parameter')
            .setDesc('Balance between high-ranking and low-ranking items (default: 60)')
            .addSlider((slider) => slider
                .setLimits(1, 100, 1)
                .setValue(settings.hybridSearch.rrfK)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.rrfK = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Keyword Weight')
            .setDesc('Importance of keyword matches (0-1)')
            .addSlider((slider) => slider
                .setLimits(0, 1, 0.1)
                .setValue(settings.hybridSearch.keywordWeight)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.keywordWeight = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Semantic Weight')
            .setDesc('Importance of semantic matches (0-1)')
            .addSlider((slider) => slider
                .setLimits(0, 1, 0.1)
                .setValue(settings.hybridSearch.semanticWeight)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.semanticWeight = value;
                    await plugin.saveSettings();
                }));

        // --- Re-ranking Settings ---
        containerEl.createEl('h3', { text: 'Re-ranking' });

        new Setting(containerEl)
            .setName('Enable Re-ranking')
            .setDesc('Apply smart scoring to refine top results')
            .addToggle((toggle) => toggle
                .setValue(settings.hybridSearch.enableReRanking)
                .onChange(async (value) => {
                    settings.hybridSearch.enableReRanking = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Re-rank Pool Size')
            .setDesc('How many results to re-rank (default: 20)')
            .addSlider((slider) => slider
                .setLimits(5, 50, 5)
                .setValue(settings.hybridSearch.reRankPoolSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.reRankPoolSize = value;
                    await plugin.saveSettings();
                }));

        // Re-ranking weights
        const createWeightSetting = (name: string, desc: string, key: keyof typeof settings.hybridSearch) => {
            new Setting(containerEl)
                .setName(name)
                .setDesc(desc)
                .addSlider((slider) => slider
                    .setLimits(0, 1, 0.1)
                    // @ts-ignore
                    .setValue(settings.hybridSearch[key] as number)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        // @ts-ignore
                        settings.hybridSearch[key] = value;
                        await plugin.saveSettings();
                    }));
        };

        createWeightSetting('Title Match Weight', 'Boost title matches', 'reRankTitleWeight');
        createWeightSetting('Recency Weight', 'Boost recently modified files', 'reRankRecencyWeight');
        createWeightSetting('Usage Weight', 'Boost frequently accessed files', 'reRankUsageWeight');
        createWeightSetting('Link Importance Weight', 'Boost well-connected files (PageRank)', 'reRankPageRankWeight');
        createWeightSetting('Content Density Weight', 'Boost files with more matching content', 'reRankContentWeight');
        createWeightSetting('Term Proximity Weight', 'Boost files where terms appear close together', 'reRankProximityWeight');

        // --- Search Behavior ---
        containerEl.createEl('h3', { text: 'Search Behavior' });

        new Setting(containerEl)
            .setName('Maximum Results')
            .setDesc('Maximum number of search results to return')
            .addSlider((slider) => slider
                .setLimits(5, 50, 5)
                .setValue(settings.hybridSearch.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.maxResults = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Minimum Score Threshold')
            .setDesc('Exclude results below this score (0-1)')
            .addSlider((slider) => slider
                .setLimits(0, 0.5, 0.05)
                .setValue(settings.hybridSearch.minScoreThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.minScoreThreshold = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Match Reasons')
            .setDesc('Display explanations for why results matched')
            .addToggle((toggle) => toggle
                .setValue(settings.hybridSearch.showMatchReasons)
                .onChange(async (value) => {
                    settings.hybridSearch.showMatchReasons = value;
                    await plugin.saveSettings();
                }));

        // --- Clustering Settings ---
        containerEl.createEl('h3', { text: 'Result Clustering' });

        new Setting(containerEl)
            .setName('Enable Result Clustering')
            .setDesc('Group similar notes together in search results')
            .addToggle((toggle) => toggle
                .setValue(settings.hybridSearch.enableClustering)
                .onChange(async (value) => {
                    settings.hybridSearch.enableClustering = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Cluster Similarity Threshold')
            .setDesc('How similar notes must be to cluster (higher = stricter)')
            .addSlider((slider) => slider
                .setLimits(0.7, 0.95, 0.05)
                .setValue(settings.hybridSearch.clusterSimilarityThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.hybridSearch.clusterSimilarityThreshold = value;
                    await plugin.saveSettings();
                }));
    }
}
