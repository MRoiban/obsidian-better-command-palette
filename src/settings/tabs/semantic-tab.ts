import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { EmbeddingProviderSection } from './semantic/provider-section';
import { RerankerSection } from './semantic/reranker-section';

export class SemanticTab implements BaseSettingsTab {
    id = 'semantic';
    title = 'Semantic';
    icon = 'brain-circuit';

    private providerSection?: EmbeddingProviderSection;

    private rerankerSection?: RerankerSection;

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        // Own a root element so re-renders replace the tab content instead of appending to it
        const rootEl = containerEl.createDiv();
        this.providerSection = new EmbeddingProviderSection(plugin, () => this.render(rootEl, plugin));
        this.rerankerSection = new RerankerSection(plugin, () => this.render(rootEl, plugin));
        this.render(rootEl, plugin);
    }

    private render(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        containerEl.empty();
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Enable Semantic Search')
            .setDesc('Find notes by meaning using text embeddings. Runs a local model inside Obsidian by default; Ollama is optional.')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.enableSemanticSearch)
                .onChange(async (value) => {
                    settings.semanticSearch.enableSemanticSearch = value;
                    await plugin.saveSettings();
                    // Refresh view to show/hide options
                    this.render(containerEl, plugin);
                }));

        if (!settings.semanticSearch.enableSemanticSearch) {
            const infoEl = containerEl.createEl('div', { cls: 'settings-info' });
            infoEl.createEl('p', {
                text: 'Semantic search uses a small embedding model that runs inside Obsidian; it is downloaded once from Hugging Face on first use, no external server needed. An Ollama server can be used instead. Enable this feature to configure it.',
            });
            return;
        }

        this.providerSection?.render(containerEl);
        this.rerankerSection?.render(containerEl);

        new Setting(containerEl).setName('Search Parameters').setHeading();

        new Setting(containerEl)
            .setName('Search Threshold')
            .setDesc('Minimum similarity score for search results (lower = more results)')
            .addSlider((slider) => slider
                .setLimits(0.1, 0.9, 0.05)
                .setValue(settings.semanticSearch.searchThreshold)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.searchThreshold = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Maximum Results')
            .setDesc('Maximum number of semantic search results to return')
            .addSlider((slider) => slider
                .setLimits(5, 50, 5)
                .setValue(settings.semanticSearch.maxResults)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.maxResults = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl).setName('Performance').setHeading();

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('Text chunk size for embedding (larger = more context, slower)')
            .addSlider((slider) => slider
                .setLimits(500, 2000, 100)
                .setValue(settings.semanticSearch.chunkSize)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.chunkSize = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Max Indexed Files')
            .setDesc('Maximum number of markdown files included in semantic indexing')
            .addSlider((slider) => slider
                .setLimits(100, 10000, 100)
                .setValue(settings.semanticSearch.maxIndexedFiles)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.maxIndexedFiles = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Max File Size')
            .setDesc('Skip larger files during semantic indexing')
            .addSlider((slider) => slider
                .setLimits(64, 4096, 64)
                .setValue(Math.round(settings.semanticSearch.maxFileSize / 1024))
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.maxFileSize = value * 1024;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Search Timeout')
            .setDesc('Maximum time to wait for an interactive semantic query embedding')
            .addSlider((slider) => slider
                .setLimits(1000, 30000, 1000)
                .setValue(settings.semanticSearch.searchTimeoutMs)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.searchTimeoutMs = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Index Request Timeout')
            .setDesc('Maximum time to wait for each document embedding request')
            .addSlider((slider) => slider
                .setLimits(5000, 120000, 5000)
                .setValue(settings.semanticSearch.indexingRequestTimeoutMs)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.indexingRequestTimeoutMs = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Max Concurrent Requests')
            .setDesc('Maximum simultaneous embedding requests to Ollama during indexing (1-10). The local model uses its own fixed limit.')
            .addSlider((slider) => slider
                .setLimits(1, 10, 1)
                .setValue(settings.semanticSearch.maxConcurrentRequests)
                .setDynamicTooltip()
                .onChange((value) => {
                    settings.semanticSearch.maxConcurrentRequests = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Adaptive Throttling')
            .setDesc('Automatically adjust concurrency based on Ollama response times (Ollama only)')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.enableAdaptiveThrottling ?? true)
                .onChange(async (value) => {
                    settings.semanticSearch.enableAdaptiveThrottling = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto-index on Startup')
            .setDesc('Automatically build an empty semantic index after startup when the embedding model is available')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.autoIndexOnStartup)
                .onChange(async (value) => {
                    settings.semanticSearch.autoIndexOnStartup = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable Cache')
            .setDesc('Cache embeddings to improve performance (recommended)')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.cacheEnabled)
                .onChange(async (value) => {
                    settings.semanticSearch.cacheEnabled = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Preserve Query')
            .setDesc('Keep search query when switching between search modes')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.preserveQuery)
                .onChange(async (value) => {
                    settings.semanticSearch.preserveQuery = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl).setName('Exclusions').setHeading();

        new Setting(containerEl)
            .setName('Exclude Patterns')
            .setDesc('Glob patterns to exclude from indexing (one per line)')
            .addTextArea((text) => {
                text.inputEl.rows = 4;
                text.inputEl.cols = 40;
                text.setPlaceholder('**/templates/**\n**/daily-notes/**')
                    .setValue(settings.semanticSearch.excludePatterns.join('\n'))
                    .onChange((value) => {
                        settings.semanticSearch.excludePatterns = value
                            .split('\n')
                            .map(p => p.trim())
                            .filter(p => p.length > 0);
                        plugin.scheduleSettingsSave();
                    });
            });

        new Setting(containerEl).setName('Actions').setHeading();

        new Setting(containerEl)
            .setName('Rebuild Semantic Index')
            .setDesc('Recreate the semantic search index from scratch')
            .addButton((button) => button
                .setButtonText('Rebuild Index')
                .setCta()
                .onClick(async () => {
                    button.setButtonText('Rebuilding...');
                    button.setDisabled(true);
                    try {
                        await plugin.reindexSemanticSearch();
                        new Notice('Semantic search index rebuilt successfully');
                    } catch (e) {
                        new Notice(`Failed: ${e}`, 5000);
                    } finally {
                        button.setButtonText('Rebuild Index');
                        button.setDisabled(false);
                    }
                }));
    }
}
