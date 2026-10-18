import { App, Notice, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { EmbeddingProviderSection } from './semantic/provider-section';
import { RerankerSection } from './semantic/reranker-section';
import { configureSlider, createStatus, describe } from '../utils/setting-helpers';

export class SemanticTab implements BaseSettingsTab {
    id = 'semantic';
    title = 'Semantic search';

    private providerSection?: EmbeddingProviderSection;

    private rerankerSection?: RerankerSection;

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        // Own a root element so re-renders replace the tab content instead of appending to it
        const rootEl = containerEl.createDiv({ cls: 'bcp-settings-section' });
        this.providerSection = new EmbeddingProviderSection(plugin, () => this.render(rootEl, plugin));
        this.rerankerSection = new RerankerSection(plugin, () => this.render(rootEl, plugin));
        this.render(rootEl, plugin);
    }

    private render(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        containerEl.empty();
        const { settings } = plugin;
        const enabled = settings.semanticSearch.enableSemanticSearch;

        this.renderEnable(containerEl, plugin, enabled);

        if (!enabled) {
            return;
        }

        this.providerSection?.render(containerEl);
        this.renderParameters(containerEl, plugin);
        this.renderPerformance(containerEl, plugin);
        this.renderExclusions(containerEl, plugin);
        this.rerankerSection?.render(containerEl);
    }

    private renderEnable(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin, enabled: boolean): void {
        const { settings } = plugin;

        const group = new SettingGroup(containerEl)
            .setHeading('Semantic search')
            .addSetting((setting) => setting
                .setName('Enable semantic search')
                .setDesc(enabled
                    ? 'Find notes by meaning using text embeddings. Runs a local model inside Obsidian by default; Ollama is optional.'
                    : 'Find notes by meaning using text embeddings. Runs a small model inside Obsidian that is downloaded once from Hugging Face on first use, with no external server needed. An Ollama server can be used instead. Turn this on to configure it.')
                .addToggle((toggle) => toggle
                    .setValue(settings.semanticSearch.enableSemanticSearch)
                    .onChange(async (value) => {
                        settings.semanticSearch.enableSemanticSearch = value;
                        await plugin.saveSettings();
                        // Refresh view to show/hide options
                        this.render(containerEl, plugin);
                    })));

        if (!enabled) {
            return;
        }

        group.addSetting((setting) => {
            let statusEl: HTMLElement | undefined;
            const updateStatus = () => statusEl?.setText(this.describeIndex(plugin));

            setting
                .setName('Rebuild semantic index')
                .setDesc(describe((fragment) => {
                    fragment.createDiv({ text: 'Recreate the semantic search index from scratch.' });
                    statusEl = createStatus(fragment.createDiv(), this.describeIndex(plugin));
                }))
                .addButton((button) => button
                    .setButtonText('Rebuild index')
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
                            button.setButtonText('Rebuild index');
                            button.setDisabled(false);
                            updateStatus();
                        }
                    }));
        });
    }

    private describeIndex(plugin: BetterCommandPalettePlugin): string {
        const stats = plugin.semanticIndexingCoordinator?.getStats();
        if (!stats) {
            return 'Index not loaded yet.';
        }
        const notes = `${stats.indexedFiles.toLocaleString()} ${stats.indexedFiles === 1 ? 'note' : 'notes'} indexed.`;
        return stats.isIndexing ? `${notes} Indexing in progress.` : notes;
    }

    private renderParameters(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { semanticSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Semantic search parameters')
            .addSetting((setting) => configureSlider(setting, {
                name: 'Search threshold',
                desc: 'Minimum similarity score for search results (lower = more results).',
                min: 0.1,
                max: 0.9,
                step: 0.05,
                value: semanticSearch.searchThreshold,
                onChange: (value) => {
                    semanticSearch.searchThreshold = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Maximum results',
                desc: 'Maximum number of semantic search results to return.',
                min: 5,
                max: 50,
                step: 5,
                value: semanticSearch.maxResults,
                onChange: (value) => {
                    semanticSearch.maxResults = value;
                    plugin.scheduleSettingsSave();
                },
            }));
    }

    private renderPerformance(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { semanticSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Semantic performance')
            .addSetting((setting) => configureSlider(setting, {
                name: 'Chunk size',
                desc: 'Text chunk size for embedding (larger = more context, slower).',
                min: 500,
                max: 2000,
                step: 100,
                value: semanticSearch.chunkSize,
                onChange: (value) => {
                    semanticSearch.chunkSize = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Max indexed files',
                desc: 'Maximum number of markdown files included in semantic indexing.',
                min: 100,
                max: 10000,
                step: 100,
                value: semanticSearch.maxIndexedFiles,
                onChange: (value) => {
                    semanticSearch.maxIndexedFiles = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Max file size (KB)',
                desc: 'Skip larger files during semantic indexing.',
                min: 64,
                max: 4096,
                step: 64,
                value: Math.round(semanticSearch.maxFileSize / 1024),
                onChange: (value) => {
                    semanticSearch.maxFileSize = value * 1024;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Search timeout (ms)',
                desc: 'Maximum time to wait for an interactive semantic query embedding.',
                min: 1000,
                max: 30000,
                step: 1000,
                value: semanticSearch.searchTimeoutMs,
                onChange: (value) => {
                    semanticSearch.searchTimeoutMs = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Index request timeout (ms)',
                desc: 'Maximum time to wait for each document embedding request.',
                min: 5000,
                max: 120000,
                step: 5000,
                value: semanticSearch.indexingRequestTimeoutMs,
                onChange: (value) => {
                    semanticSearch.indexingRequestTimeoutMs = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Max concurrent requests',
                desc: 'Maximum simultaneous embedding requests to Ollama during indexing (1-10). The local model uses its own fixed limit.',
                min: 1,
                max: 10,
                step: 1,
                value: semanticSearch.maxConcurrentRequests,
                onChange: (value) => {
                    semanticSearch.maxConcurrentRequests = value;
                    plugin.scheduleSettingsSave();
                },
            }))
            .addSetting((setting) => setting
                .setName('Adaptive throttling')
                .setDesc('Automatically adjust concurrency based on Ollama response times (Ollama only).')
                .addToggle((toggle) => toggle
                    .setValue(semanticSearch.enableAdaptiveThrottling ?? true)
                    .onChange(async (value) => {
                        semanticSearch.enableAdaptiveThrottling = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Auto-index on startup')
                .setDesc('Automatically build an empty semantic index after startup when the embedding model is available.')
                .addToggle((toggle) => toggle
                    .setValue(semanticSearch.autoIndexOnStartup)
                    .onChange(async (value) => {
                        semanticSearch.autoIndexOnStartup = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Enable cache')
                .setDesc('Cache embeddings to improve performance (recommended).')
                .addToggle((toggle) => toggle
                    .setValue(semanticSearch.cacheEnabled)
                    .onChange(async (value) => {
                        semanticSearch.cacheEnabled = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Preserve query')
                .setDesc('Keep the search query when switching between search modes.')
                .addToggle((toggle) => toggle
                    .setValue(semanticSearch.preserveQuery)
                    .onChange(async (value) => {
                        semanticSearch.preserveQuery = value;
                        await plugin.saveSettings();
                    })));
    }

    private renderExclusions(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { semanticSearch } = plugin.settings;

        new SettingGroup(containerEl)
            .setHeading('Exclusions')
            .addSetting((setting) => setting
                .setName('Exclude patterns')
                .setDesc('Glob patterns to exclude from indexing (one per line).')
                .addTextArea((text) => {
                    text.inputEl.rows = 4;
                    text.inputEl.cols = 40;
                    text.setPlaceholder('**/templates/**\n**/daily-notes/**')
                        .setValue(semanticSearch.excludePatterns.join('\n'))
                        .onChange((value) => {
                            semanticSearch.excludePatterns = value
                                .split('\n')
                                .map((p) => p.trim())
                                .filter((p) => p.length > 0);
                            plugin.scheduleSettingsSave();
                        });
                }));
    }
}
