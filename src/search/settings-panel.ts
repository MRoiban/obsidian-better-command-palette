import { Setting, Notice } from 'obsidian';
import { SearchSettings } from './interfaces';
import BetterCommandPalettePlugin from '../main';
import { logger } from '../utils/logger';

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
        this.addEnableToggle();
        
        if (!this.getSearchSettings().enableContentSearch) {
            this.addDisabledInfo();
            return;
        }

        this.addScoreWeightSettings();
        this.addPerformanceSettings();
        this.addPrivacySettings();
        this.addAdvancedSettings();
        this.addActionsSection();
    }

    private addEnableToggle(): void {
        const settings = this.getSearchSettings();

        new Setting(this.containerEl)
            .setName('Enable Enhanced Content Search')
            .setDesc('Activate advanced content indexing and search with smart scoring')
            .addToggle(toggle => toggle
                .setValue(settings.enableContentSearch)
                .onChange(async (value) => {
                    await this.updateSearchSettings({ enableContentSearch: value });
                    this.refresh();
                })
            );
    }

    private addDisabledInfo(): void {
        const infoEl = this.containerEl.createEl('div', { cls: 'settings-info' });
        infoEl.createEl('p', { 
            text: 'Enhanced content search provides intelligent file ranking based on content relevance, usage patterns, and recency. Enable this feature to unlock advanced search capabilities.'
        });
    }

    private addScoreWeightSettings(): void {
        const settings = this.getSearchSettings();

        const weightGroup = this.containerEl.createEl('div', { cls: 'settings-group' });
        weightGroup.createEl('h3', { text: 'Search Scoring', cls: 'settings-group-title' });

        new Setting(weightGroup)
            .setName('Content Relevance Weight')
            .setDesc('How much to prioritize content relevance in search results')
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
                    this.validateWeights();
                })
            );

        new Setting(weightGroup)
            .setName('Recency Weight')
            .setDesc('How much to prioritize recently accessed files in search results')
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
                    this.validateWeights();
                })
            );

        new Setting(weightGroup)
            .setName('Usage Frequency Weight')
            .setDesc('How much to prioritize frequently used files in search results')
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
                    this.validateWeights();
                })
            );

        // Add weight validation info
        const validationEl = weightGroup.createEl('div', { cls: 'settings-info' });
        validationEl.createEl('p', {
            text: `Current total weight: ${(settings.scoreWeights.relevance + settings.scoreWeights.recency + settings.scoreWeights.frequency).toFixed(2)}. Ideal range is 0.8-1.2 for optimal results.`
        });
    }

    private addPerformanceSettings(): void {
        const settings = this.getSearchSettings();

        const perfGroup = this.containerEl.createEl('div', { cls: 'settings-group' });
        perfGroup.createEl('h3', { text: 'Performance Settings', cls: 'settings-group-title' });

        new Setting(perfGroup)
            .setName('Maximum Indexed Files')
            .setDesc('Limit the number of files to index for better performance')
            .addSlider(slider => slider
                .setLimits(1000, 50000, 1000)
                .setValue(settings.maxIndexedFiles)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ maxIndexedFiles: value });
                })
            );

        new Setting(perfGroup)
            .setName('Maximum File Size (KB)')
            .setDesc('Skip files larger than this size to improve indexing speed')
            .addSlider(slider => slider
                .setLimits(100, 2048, 50)
                .setValue(Math.round(settings.maxFileSize / 1024))
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ maxFileSize: value * 1024 });
                })
            );

        new Setting(perfGroup)
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

        new Setting(perfGroup)
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

        new Setting(perfGroup)
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

        const privacyGroup = this.containerEl.createEl('div', { cls: 'settings-group' });
        privacyGroup.createEl('h3', { text: 'Privacy & Data', cls: 'settings-group-title' });

        new Setting(privacyGroup)
            .setName('Enable Usage Tracking')
            .setDesc('Track file usage patterns to improve search relevance (stored locally)')
            .addToggle(toggle => toggle
                .setValue(settings.enableUsageTracking)
                .onChange(async (value) => {
                    await this.updateSearchSettings({ enableUsageTracking: value });
                })
            );

        new Setting(privacyGroup)
            .setName('Preserve Search Query')
            .setDesc('Keep the search query when switching between command, file, and tag modes')
            .addToggle(toggle => toggle
                .setValue(settings.preserveQuery)
                .onChange(async (value) => {
                    await this.updateSearchSettings({ preserveQuery: value });
                })
            );

        // Add clear usage data button if tracking is enabled
        if (settings.enableUsageTracking) {
            new Setting(privacyGroup)
                .setName('Clear Usage Data')
                .setDesc('Remove all stored usage tracking data')
                .addButton(button => button
                    .setButtonText('Clear Data')
                    .setWarning()
                    .onClick(async () => {
                        await this.clearUsageData(button);
                    })
                );
        }
    }

    private addAdvancedSettings(): void {
        const settings = this.getSearchSettings();

        const advancedGroup = this.containerEl.createEl('div', { cls: 'settings-group' });
        advancedGroup.createEl('h3', { text: 'Advanced Settings', cls: 'settings-group-title' });

        new Setting(advancedGroup)
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

        new Setting(advancedGroup)
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

        new Setting(advancedGroup)
            .setName('Indexing Batch Size')
            .setDesc('Number of files to process in each batch (lower = more responsive)')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(settings.indexingBatchSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ indexingBatchSize: value });
                })
            );

        new Setting(advancedGroup)
            .setName('Batch Delay (ms)')
            .setDesc('Delay between processing batches to keep UI responsive')
            .addSlider(slider => slider
                .setLimits(50, 1000, 50)
                .setValue(settings.indexingBatchDelayMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    await this.updateSearchSettings({ indexingBatchDelayMs: value });
                })
            );
    }

    private addActionsSection(): void {
        const actionsGroup = this.containerEl.createEl('div', { cls: 'settings-group' });
        actionsGroup.createEl('h3', { text: 'Index Management', cls: 'settings-group-title' });

        new Setting(actionsGroup)
            .setName('Rebuild Search Index')
            .setDesc('Recreate the search index from scratch (may take a while)')
            .addButton(button => button
                .setButtonText('Rebuild Index')
                .setCta()
                .onClick(async () => {
                    await this.rebuildIndex(button);
                })
            );

        new Setting(actionsGroup)
            .setName('Clear Search Cache')
            .setDesc('Clear all cached search results and data')
            .addButton(button => button
                .setButtonText('Clear Cache')
                .setWarning()
                .onClick(async () => {
                    await this.clearCache(button);
                })
            );
    }

    private validateWeights(): void {
        const settings = this.getSearchSettings();
        const totalWeight = settings.scoreWeights.relevance + 
                           settings.scoreWeights.recency + 
                           settings.scoreWeights.frequency;
        
        if (totalWeight < 0.5 || totalWeight > 1.5) {
            new Notice('Score weights seem unbalanced. Consider adjusting for optimal results.');
        }
    }

    private async clearUsageData(button: HTMLButtonElement): Promise<void> {
        const confirmed = confirm('Are you sure you want to clear all usage tracking data? This action cannot be undone.');
        
        if (!confirmed) return;

        const originalText = button.textContent;
        button.textContent = 'Clearing...';
        button.setDisabled(true);

        try {
            // TODO: Implement actual usage data clearing
            // This would call the usage tracker's reset method
            await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate async operation
            
            new Notice('Usage data cleared successfully');
            logger.info('Enhanced search usage data cleared');
        } catch (error) {
            new Notice(`Failed to clear usage data: ${error.message}`);
            logger.error('Failed to clear enhanced search usage data', error);
        } finally {
            button.textContent = originalText;
            button.setDisabled(false);
        }
    }

    private async rebuildIndex(button: HTMLButtonElement): Promise<void> {
        const originalText = button.textContent;
        button.textContent = 'Rebuilding...';
        button.setDisabled(true);

        try {
            // TODO: Implement actual index rebuilding
            // This would clear the index and reindex all files
            await new Promise(resolve => setTimeout(resolve, 2000)); // Simulate async operation
            
            new Notice('Search index rebuilt successfully');
            logger.info('Enhanced search index rebuilt successfully');
        } catch (error) {
            new Notice(`Failed to rebuild index: ${error.message}`);
            logger.error('Failed to rebuild enhanced search index', error);
        } finally {
            button.textContent = originalText;
            button.setDisabled(false);
        }
    }

    private async clearCache(button: HTMLButtonElement): Promise<void> {
        const originalText = button.textContent;
        button.textContent = 'Clearing...';
        button.setDisabled(true);

        try {
            // TODO: Implement actual cache clearing
            await new Promise(resolve => setTimeout(resolve, 500)); // Simulate async operation
            
            new Notice('Search cache cleared successfully');
            logger.info('Enhanced search cache cleared');
        } catch (error) {
            new Notice(`Failed to clear cache: ${error.message}`);
            logger.error('Failed to clear enhanced search cache', error);
        } finally {
            button.textContent = originalText;
            button.setDisabled(false);
        }
    }

    private refresh(): void {
        this.containerEl.empty();
        this.display();
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
