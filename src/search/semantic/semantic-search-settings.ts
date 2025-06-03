/**
 * Settings tab for semantic search configuration
 */

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from '../../main';

export class SemanticSearchSettingTab extends PluginSettingTab {
  plugin: BetterCommandPalettePlugin;

  constructor(app: App, plugin: BetterCommandPalettePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Semantic Search Settings' });

    this.addConnectionSettings();
    this.addSearchSettings();
    this.addPerformanceSettings();
    this.addIndexingControls();
  }

  private addConnectionSettings(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;

    containerEl.createEl('h3', { text: 'Ollama Connection' });

    new Setting(containerEl)
      .setName('Enable semantic search')
      .setDesc('Enable semantic search using Ollama embeddings')
      .addToggle(toggle => toggle
        .setValue(settings.semanticSearch?.enableSemanticSearch ?? true)
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.enableSemanticSearch = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Ollama URL')
      .setDesc('URL for your Ollama instance')
      .addText(text => text
        .setPlaceholder('http://localhost:11434')
        .setValue(settings.semanticSearch?.ollamaUrl ?? 'http://localhost:11434')
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.ollamaUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Test connection to Ollama and verify nomic-embed-text model')
      .addButton(button => button
        .setButtonText('Test')
        .setCta()
        .onClick(async () => {
          button.setButtonText('Testing...');
          button.setDisabled(true);
          
          try {
            const embeddingService = this.plugin.getEmbeddingService();
            if (embeddingService) {
              const isConnected = await embeddingService.checkConnection();
              if (isConnected) {
                new Notice('✅ Connection successful! nomic-embed-text model found.');
              } else {
                new Notice('❌ Connection failed or nomic-embed-text model not found.\nRun: ollama pull nomic-embed-text');
              }
            } else {
              new Notice('❌ Semantic search service not initialized');
            }
          } catch (error) {
            new Notice(`❌ Connection error: ${error.message}`);
          } finally {
            button.setButtonText('Test');
            button.setDisabled(false);
          }
        }));
  }

  private addSearchSettings(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;

    containerEl.createEl('h3', { text: 'Search Configuration' });

    new Setting(containerEl)
      .setName('Search threshold')
      .setDesc('Minimum similarity score for results (0.0-1.0)')
      .addSlider(slider => slider
        .setLimits(0, 1, 0.1)
        .setValue(settings.semanticSearch?.searchThreshold ?? 0.3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.searchThreshold = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Max results')
      .setDesc('Maximum number of search results to return')
      .addSlider(slider => slider
        .setLimits(5, 50, 5)
        .setValue(settings.semanticSearch?.maxResults ?? 10)
        .setDynamicTooltip()
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.maxResults = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Chunk size')
      .setDesc('Size of text chunks for processing large documents')
      .addSlider(slider => slider
        .setLimits(500, 2000, 100)
        .setValue(settings.semanticSearch?.chunkSize ?? 1000)
        .setDynamicTooltip()
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.chunkSize = value;
          await this.plugin.saveSettings();
        }));
  }

  private addPerformanceSettings(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;

    containerEl.createEl('h3', { text: 'Performance' });

    new Setting(containerEl)
      .setName('Concurrent requests')
      .setDesc('Maximum concurrent requests to Ollama')
      .addSlider(slider => slider
        .setLimits(1, 5, 1)
        .setValue(settings.semanticSearch?.maxConcurrentRequests ?? 3)
        .setDynamicTooltip()
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.maxConcurrentRequests = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable caching')
      .setDesc('Cache embeddings to disk for faster startup')
      .addToggle(toggle => toggle
        .setValue(settings.semanticSearch?.cacheEnabled ?? true)
        .onChange(async (value) => {
          if (!settings.semanticSearch) {
            settings.semanticSearch = this.getDefaultSettings();
          }
          settings.semanticSearch.cacheEnabled = value;
          await this.plugin.saveSettings();
        }));
  }

  private addIndexingControls(): void {
    const { containerEl } = this;

    containerEl.createEl('h3', { text: 'Index Management' });

    const statusDiv = containerEl.createDiv('semantic-search-status');
    this.updateStatus(statusDiv);

    new Setting(containerEl)
      .setName('Reindex all files')
      .setDesc('Rebuild the semantic search index for all markdown files')
      .addButton(button => button
        .setButtonText('Reindex')
        .setWarning()
        .onClick(async () => {
          const embeddingService = this.plugin.getEmbeddingService();
          if (!embeddingService) {
            new Notice('❌ Semantic search service not available');
            return;
          }

          button.setButtonText('Indexing...');
          button.setDisabled(true);

          try {
            await this.plugin.reindexSemanticSearch();
            this.updateStatus(statusDiv);
          } finally {
            button.setButtonText('Reindex');
            button.setDisabled(false);
          }
        }));

    new Setting(containerEl)
      .setName('Clear cache')
      .setDesc('Clear all cached embeddings and search results')
      .addButton(button => button
        .setButtonText('Clear')
        .setWarning()
        .onClick(async () => {
          const embeddingService = this.plugin.getEmbeddingService();
          const searchEngine = this.plugin.getSemanticSearchEngine();
          
          if (embeddingService) {
            embeddingService.clearCache();
          }
          if (searchEngine) {
            searchEngine.clearSearchCache();
          }
          
          new Notice('🗑️ Semantic search cache cleared');
          this.updateStatus(statusDiv);
        }));
  }

  private updateStatus(statusDiv: HTMLElement): void {
    statusDiv.empty();
    
    const embeddingService = this.plugin.getEmbeddingService();
    if (!embeddingService) {
      statusDiv.createEl('p', { text: 'Semantic search service not available' });
      return;
    }

    const indexedCount = embeddingService.getIndexedFileCount();
    const queueStatus = embeddingService.getQueueStatus();
    
    statusDiv.createEl('p', { text: `📊 Indexed files: ${indexedCount}` });
    
    if (queueStatus.active > 0 || queueStatus.queued > 0) {
      statusDiv.createEl('p', { 
        text: `⏳ Queue: ${queueStatus.active} active, ${queueStatus.queued} waiting`
      });
    }
  }

  private getDefaultSettings() {
    return {
      enableSemanticSearch: true,
      ollamaUrl: 'http://localhost:11434',
      searchThreshold: 0.3,
      maxResults: 10,
      chunkSize: 1000,
      maxConcurrentRequests: 3,
      cacheEnabled: true,
      excludePatterns: ['**/node_modules/**', '**/.git/**', '**/.*/**', '**/*.excalidraw.md', '**/*.sfile.md'] // Default exclusions
    };
  }
}
