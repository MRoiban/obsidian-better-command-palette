import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class SemanticTab implements BaseSettingsTab {
    id = 'semantic';
    title = 'Semantic';
    icon = 'brain-circuit';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Enable Semantic Search')
            .setDesc('Activate AI-powered semantic search using Ollama embeddings')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.enableSemanticSearch)
                .onChange(async (value) => {
                    settings.semanticSearch.enableSemanticSearch = value;
                    await plugin.saveSettings();
                    // Refresh view to show/hide options
                    this.display(containerEl, app, plugin);
                }));

        if (!settings.semanticSearch.enableSemanticSearch) {
            const infoEl = containerEl.createEl('div', { cls: 'settings-info' });
            infoEl.createEl('p', {
                text: 'Semantic search requires Ollama to be installed and running. Enable this feature to configure advanced AI-powered search capabilities.',
            });
            return;
        }

        containerEl.createEl('h3', { text: 'Connection Settings' });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama server')
            .addText((text) => text
                .setPlaceholder('http://localhost:11434')
                .setValue(settings.semanticSearch.ollamaUrl)
                .onChange(async (value) => {
                    settings.semanticSearch.ollamaUrl = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Embedding Model')
            .setDesc('Model to use for embeddings (e.g., nomic-embed-text, bge-m3)')
            .addText((text) => text
                .setPlaceholder('nomic-embed-text')
                .setValue(settings.semanticSearch.embeddingModel || 'nomic-embed-text')
                .onChange(async (value) => {
                    settings.semanticSearch.embeddingModel = value.trim() || 'nomic-embed-text';
                    await plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Search Parameters' });

        new Setting(containerEl)
            .setName('Search Threshold')
            .setDesc('Minimum similarity score for search results (lower = more results)')
            .addSlider((slider) => slider
                .setLimits(0.1, 0.9, 0.05)
                .setValue(settings.semanticSearch.searchThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.searchThreshold = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum Results')
            .setDesc('Maximum number of semantic search results to return')
            .addSlider((slider) => slider
                .setLimits(5, 50, 5)
                .setValue(settings.semanticSearch.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.maxResults = value;
                    await plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Performance' });

        new Setting(containerEl)
            .setName('Chunk Size')
            .setDesc('Text chunk size for embedding (larger = more context, slower)')
            .addSlider((slider) => slider
                .setLimits(500, 2000, 100)
                .setValue(settings.semanticSearch.chunkSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.chunkSize = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Concurrent Requests')
            .setDesc('Maximum simultaneous requests to Ollama (1-10)')
            .addSlider((slider) => slider
                .setLimits(1, 10, 1)
                .setValue(settings.semanticSearch.maxConcurrentRequests)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.maxConcurrentRequests = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Adaptive Throttling')
            .setDesc('Automatically adjust concurrency based on Ollama response times')
            .addToggle((toggle) => toggle
                .setValue(settings.semanticSearch.enableAdaptiveThrottling ?? true)
                .onChange(async (value) => {
                    settings.semanticSearch.enableAdaptiveThrottling = value;
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

        containerEl.createEl('h3', { text: 'Exclusions' });

        new Setting(containerEl)
            .setName('Exclude Patterns')
            .setDesc('Glob patterns to exclude from indexing (one per line)')
            .addTextArea((text) => {
                text.inputEl.rows = 4;
                text.inputEl.cols = 40;
                text.setPlaceholder('**/templates/**\n**/daily-notes/**')
                    .setValue(settings.semanticSearch.excludePatterns.join('\n'))
                    .onChange(async (value) => {
                        settings.semanticSearch.excludePatterns = value
                            .split('\n')
                            .map(p => p.trim())
                            .filter(p => p.length > 0);
                        await plugin.saveSettings();
                    });
            });

        containerEl.createEl('h3', { text: 'Actions' });

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
