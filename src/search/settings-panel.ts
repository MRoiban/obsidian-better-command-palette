import { Setting } from 'obsidian';
import { SearchSettings } from './interfaces';
import BetterCommandPalettePlugin from '../main';

/**
 * Search settings panel for configuring enhanced content search
 */
export class SearchSettingsPanel {
    private plugin: BetterCommandPalettePlugin;
    private containerEl: HTMLElement;

    constructor(plugin: BetterCommandPalettePlugin, containerEl: HTMLElement) {
        this.plugin = plugin;
        this.containerEl = containerEl;
    }

    display(): void {
        this.containerEl.createEl('h3', { text: 'Enhanced Content Search' });

        this.addScoreWeightSettings();
        this.addPerformanceSettings();
        this.addPrivacySettings();
        this.addAdvancedSettings();
    }

    private addScoreWeightSettings(): void {
        const settings = this.getSearchSettings();

        new Setting(this.containerEl)
            .setName('Content Relevance Weight')
            .setDesc('How much to weight content relevance in search results (0.0 - 1.0)')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(settings.scoreWeights.relevance)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ 
                        scoreWeights: { 
                            ...settings.scoreWeights, 
                            relevance: value 
                        } 
                    });
                })
            );

        new Setting(this.containerEl)
            .setName('Recency Weight')
            .setDesc('How much to weight recently accessed files in search results (0.0 - 1.0)')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(settings.scoreWeights.recency)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ 
                        scoreWeights: { 
                            ...settings.scoreWeights, 
                            recency: value 
                        } 
                    });
                })
            );

        new Setting(this.containerEl)
            .setName('Usage Frequency Weight')
            .setDesc('How much to weight frequently used files in search results (0.0 - 1.0)')
            .addSlider(slider => slider
                .setLimits(0, 1, 0.05)
                .setValue(settings.scoreWeights.frequency)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ 
                        scoreWeights: { 
                            ...settings.scoreWeights, 
                            frequency: value 
                        } 
                    });
                })
            );
    }

    private addPerformanceSettings(): void {
        const settings = this.getSearchSettings();

        new Setting(this.containerEl)
            .setName('Maximum Indexed Files')
            .setDesc('Limit the number of files to index for performance')
            .addSlider(slider => slider
                .setLimits(1000, 50000, 1000)
                .setValue(settings.maxIndexedFiles)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ maxIndexedFiles: value });
                })
            );

        new Setting(this.containerEl)
            .setName('Indexing Debounce (ms)')
            .setDesc('Delay before reindexing after file changes to reduce CPU usage')
            .addSlider(slider => slider
                .setLimits(100, 2000, 100)
                .setValue(settings.indexingDebounceMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ indexingDebounceMs: value });
                })
            );

        new Setting(this.containerEl)
            .setName('Search Timeout (ms)')
            .setDesc('Maximum time to wait for search results')
            .addSlider(slider => slider
                .setLimits(1000, 10000, 500)
                .setValue(settings.searchTimeoutMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ searchTimeoutMs: value });
                })
            );

        new Setting(this.containerEl)
            .setName('Content Preview Length')
            .setDesc('Number of characters to show in content previews')
            .addSlider(slider => slider
                .setLimits(50, 500, 25)
                .setValue(settings.contentPreviewLength)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ contentPreviewLength: value });
                })
            );
    }

    private addPrivacySettings(): void {
        const settings = this.getSearchSettings();

        new Setting(this.containerEl)
            .setName('Enable Usage Tracking')
            .setDesc('Track file usage patterns to improve search relevance')
            .addToggle(toggle => toggle
                .setValue(settings.enableUsageTracking)
                .onChange(async (value) => {
                    await this.updateSearchSettings({ enableUsageTracking: value });
                })
            );

        new Setting(this.containerEl)
            .setName('Enable Full Content Search')
            .setDesc('Index and search within file content (may impact performance)')
            .addToggle(toggle => toggle
                .setValue(settings.enableContentSearch)
                .onChange(async (value) => {
                    await this.updateSearchSettings({ enableContentSearch: value });
                })
            );

        // Add button to clear usage data
        new Setting(this.containerEl)
            .setName('Clear Usage Data')
            .setDesc('Remove all stored usage tracking data')
            .addButton(button => button
                .setButtonText('Clear Data')
                .setWarning()
                .onClick(async () => {
                    // TODO: Implement clear usage data functionality
                    // This would call the usage tracker's reset method
                })
            );
    }

    private addAdvancedSettings(): void {
        const settings = this.getSearchSettings();

        new Setting(this.containerEl)
            .setName('Recency Half-Life (days)')
            .setDesc('Number of days for recency score to decay by half')
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(settings.recencyHalfLife / (24 * 60 * 60 * 1000)) // Convert ms to days
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ 
                        recencyHalfLife: value * 24 * 60 * 60 * 1000 // Convert days to ms
                    });
                })
            );

        new Setting(this.containerEl)
            .setName('Maximum Usage Score')
            .setDesc('Upper limit for usage score normalization')
            .addSlider(slider => slider
                .setLimits(10, 1000, 10)
                .setValue(settings.maxUsageScore)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ maxUsageScore: value });
                })
            );

        // Add button to rebuild search index
        new Setting(this.containerEl)
            .setName('Rebuild Search Index')
            .setDesc('Recreate the search index from scratch (may take a while)')
            .addButton(button => button
                .setButtonText('Rebuild Index')
                .onClick(async () => {
                    // TODO: Implement rebuild index functionality
                    // This would clear the index and reindex all files
                })
            );
    }

    private getSearchSettings(): SearchSettings {
        return this.plugin.settings.enhancedSearch;
    }

    private async updateSearchSettings(updates: Partial<SearchSettings>): Promise<void> {
        this.plugin.settings.enhancedSearch = { 
            ...this.plugin.settings.enhancedSearch, 
            ...updates 
        };
        await this.plugin.saveSettings();
        
        // Update the search service if it exists
        if ((this.plugin as any).searchService) {
            (this.plugin as any).searchService.updateSettings(this.plugin.settings.enhancedSearch);
        }
    }
}
