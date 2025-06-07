import {
    App, Command, Modifier, PluginSettingTab, setIcon, Setting, Notice
} from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { HotkeyStyleType, MacroCommandInterface, UnsafeAppInterface } from './types/types';
import { SettingsCommandSuggestModal } from './utils';
import { SearchSettings } from './search/interfaces';
import { SearchSettingsPanel } from './search/settings-panel';
import { SemanticSearchSettings } from './search/semantic/types';
import { logger } from './utils/logger';

export interface BetterCommandPalettePluginSettings {
    closeWithBackspace: boolean,
    showPluginName: boolean,
    fileSearchPrefix: string,
    tagSearchPrefix: string,
    commandSearchHotkey: string,
    fileSearchHotkey: string,
    tagSearchHotkey: string,
    suggestionLimit: number,
    recentAbovePinned: boolean,
    hyperKeyOverride: boolean,
    displayOnlyNotesNames: boolean,
    hideMdExtension: boolean,
    recentlyUsedText: string,
    macros: MacroCommandInterface[],
    hotkeyStyle: HotkeyStyleType;
    createNewFileMod: Modifier,
    openInNewTabMod: Modifier,
    hiddenCommands: string[],
    hiddenFiles: string[],
    hiddenTags: string[],
    fileTypeExclusion: string[],
    enhancedSearch: SearchSettings,
    semanticSearch: SemanticSearchSettings,
    quickLink: {
        enabled: boolean,
        defaultHotkey: string,
        autoCloseModal: boolean,
    },
}

export const DEFAULT_SETTINGS: BetterCommandPalettePluginSettings = {
    closeWithBackspace: true,
    showPluginName: true,
    fileSearchPrefix: '/',
    tagSearchPrefix: '#',
    commandSearchHotkey: 'p',
    fileSearchHotkey: 'o',
    tagSearchHotkey: 't',
    suggestionLimit: 50,
    recentAbovePinned: false,
    hyperKeyOverride: false,
    displayOnlyNotesNames: false,
    hideMdExtension: false,
    recentlyUsedText: '(recently used)',
    macros: [],
    hotkeyStyle: 'auto',
    createNewFileMod: 'Mod',
    openInNewTabMod: 'Shift',
    hiddenCommands: [],
    hiddenFiles: [],
    hiddenTags: [],
    fileTypeExclusion: [],
    enhancedSearch: {
        scoreWeights: {
            relevance: 0.6,
            recency: 0.25,
            frequency: 0.15
        },
        recencyHalfLife: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
        maxUsageScore: 100,
        maxIndexedFiles: 10000,
        enableUsageTracking: true,
        indexingDebounceMs: 1000,        // Increased debounce for less frequent updates
        searchTimeoutMs: 5000,
        contentPreviewLength: 200,
        enableContentSearch: true,
        preserveQuery: false,            // Preserve search query when switching modes
        // Performance settings for smoother indexing
        indexingBatchSize: 2,            // Small batches for better responsiveness
        indexingDelayMs: 150,            // Longer delay between files
        indexingBatchDelayMs: 400,       // Longer delay between batches
        maxFileSize: 512 * 1024          // 512KB limit for better performance
    },
    semanticSearch: {
        enableSemanticSearch: false,     // Disabled by default until user configures Ollama
        ollamaUrl: 'http://localhost:11434',
        searchThreshold: 0.3,
        maxResults: 10,
        chunkSize: 1000,
        maxConcurrentRequests: 3,
        cacheEnabled: true,
        excludePatterns: ['**/node_modules/**', '**/.git/**', '**/.*/**', '**/*.excalidraw.md', '**/*.sfile.md'], // Default exclusions
        preserveQuery: false             // Preserve search query when switching modes
    },
    quickLink: {
        enabled: true,
        defaultHotkey: 'l',
        autoCloseModal: true,
    },
};

interface SettingsSection {
    id: string;
    title: string;
    description?: string;
    collapsed: boolean;
}

export class BetterCommandPaletteSettingTab extends PluginSettingTab {
    plugin: BetterCommandPalettePlugin;
    app!: UnsafeAppInterface;
    private sections: Map<string, SettingsSection> = new Map();
    private sectionElements: Map<string, HTMLElement> = new Map();

    constructor(app: App, plugin: BetterCommandPalettePlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.initializeSections();
    }

    private initializeSections(): void {
        const sections: SettingsSection[] = [
            {
                id: 'general',
                title: 'General Settings',
                description: 'Basic plugin behavior and display options',
                collapsed: false
            },
            {
                id: 'search',
                title: 'Search & Navigation',
                description: 'Configure search prefixes, hotkeys, and display options',
                collapsed: false
            },
            {
                id: 'quick-link',
                title: 'Quick Link',
                description: 'Create links from selected text with file search',
                collapsed: false
            },
            {
                id: 'enhanced-search',
                title: 'Enhanced Content Search',
                description: 'Advanced search with content indexing and smart scoring',
                collapsed: true
            },
            {
                id: 'semantic-search',
                title: 'Semantic Search',
                description: 'AI-powered semantic search using Ollama embeddings',
                collapsed: true
            },
            {
                id: 'macros',
                title: 'Command Macros',
                description: 'Create and manage custom command sequences',
                collapsed: true
            },
            {
                id: 'advanced',
                title: 'Advanced Options',
                description: 'File exclusions, hidden items, and advanced customization',
                collapsed: true
            }
        ];

        sections.forEach(section => {
            this.sections.set(section.id, section);
        });
    }

    display(): void {
        this.containerEl.empty();
        this.createHeader();
        this.createSettingsSections();
    }

    private createHeader(): void {
        const headerEl = this.containerEl.createEl('div', { cls: 'settings-header' });
        
        const titleEl = headerEl.createEl('h1', { 
            text: 'Better Command Palette',
            cls: 'settings-title'
        });
        
        const subtitleEl = headerEl.createEl('p', {
            text: 'Enhance your Obsidian workflow with improved command palette, search, and navigation',
            cls: 'settings-subtitle'
        });

        // Add quick stats
        const statsEl = headerEl.createEl('div', { cls: 'settings-stats' });
        const macroCount = this.plugin.settings.macros.length;
        const hiddenCount = this.plugin.settings.hiddenCommands.length + 
                           this.plugin.settings.hiddenFiles.length + 
                           this.plugin.settings.hiddenTags.length;
        
        statsEl.createEl('span', { 
            text: `${macroCount} macros`, 
            cls: 'stat-item' 
        });
        statsEl.createEl('span', { 
            text: `${hiddenCount} hidden items`, 
            cls: 'stat-item' 
        });
    }

    private createSettingsSections(): void {
        this.sections.forEach((section, sectionId) => {
            this.createSection(sectionId, section);
        });
    }

    private createSection(sectionId: string, section: SettingsSection): void {
        const sectionContainer = this.containerEl.createEl('div', { 
            cls: 'settings-section-container' 
        });

        // Section header
        const headerEl = sectionContainer.createEl('div', { 
            cls: 'settings-section-header'
        });
        
        const titleEl = headerEl.createEl('h2', { 
            text: section.title,
            cls: 'settings-section-title'
        });

        if (section.description) {
            headerEl.createEl('p', {
                text: section.description,
                cls: 'settings-section-description'
            });
        }

        // Collapse toggle
        const toggleEl = headerEl.createEl('div', { 
            cls: `settings-section-toggle ${section.collapsed ? 'collapsed' : ''}` 
        });
        setIcon(toggleEl, 'chevron-down');

        // Section content
        const contentEl = sectionContainer.createEl('div', { 
            cls: `settings-section-content ${section.collapsed ? 'collapsed' : ''}` 
        });

        this.sectionElements.set(sectionId, contentEl);

        // Toggle functionality
        headerEl.addEventListener('click', () => {
            const isCollapsed = section.collapsed;
            section.collapsed = !isCollapsed;
            
            toggleEl.toggleClass('collapsed', section.collapsed);
            contentEl.toggleClass('collapsed', section.collapsed);
        });

        // Populate section content
        this.populateSection(sectionId, contentEl);
    }

    private populateSection(sectionId: string, containerEl: HTMLElement): void {
        switch (sectionId) {
            case 'general':
                this.createGeneralSettings(containerEl);
                break;
            case 'search':
                this.createSearchSettings(containerEl);
                break;
            case 'quick-link':
                this.createQuickLinkSettings(containerEl);
                break;
            case 'enhanced-search':
                this.createEnhancedSearchSettings(containerEl);
                break;
            case 'semantic-search':
                this.createSemanticSearchSettings(containerEl);
                break;
            case 'macros':
                this.createMacroSettings(containerEl);
                break;
            case 'advanced':
                this.createAdvancedSettings(containerEl);
                break;
        }
    }

    private createGeneralSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        new Setting(containerEl)
            .setName('Close on Backspace')
            .setDesc('Close the palette when there is no text and backspace is pressed')
            .addToggle(toggle => toggle
                .setValue(settings.closeWithBackspace)
                .onChange(async (value) => {
                    settings.closeWithBackspace = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Show Plugin Name')
            .setDesc('Display the plugin name in commands for easier identification')
            .addToggle(toggle => toggle
                .setValue(settings.showPluginName)
                .onChange(async (value) => {
                    settings.showPluginName = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Recent Above Pinned')
            .setDesc('Prioritize recently used items over pinned items in search results')
            .addToggle(toggle => toggle
                .setValue(settings.recentAbovePinned)
                .onChange(async (value) => {
                    settings.recentAbovePinned = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Recently Used Label')
            .setDesc('Custom text displayed next to recently used items')
            .addText(text => text
                .setPlaceholder('(recently used)')
                .setValue(settings.recentlyUsedText)
                .onChange(async (value) => {
                    if (value.trim()) {
                        settings.recentlyUsedText = value;
                        await this.plugin.saveSettings();
                    }
                })
            );
    }

    private createSearchSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        // Search Prefixes
        const prefixGroup = containerEl.createEl('div', { cls: 'settings-group' });
        prefixGroup.createEl('h3', { text: 'Search Prefixes', cls: 'settings-group-title' });

        new Setting(prefixGroup)
            .setName('File Search Prefix')
            .setDesc('Character to trigger file search mode')
            .addText(text => text
                .setPlaceholder('/')
                .setValue(settings.fileSearchPrefix)
                .onChange(async (value) => {
                    if (this.validatePrefix(value)) {
                        settings.fileSearchPrefix = value;
                        await this.plugin.saveSettings();
                    }
                })
            );

        new Setting(prefixGroup)
            .setName('Tag Search Prefix')
            .setDesc('Character to trigger tag search mode')
            .addText(text => text
                .setPlaceholder('#')
                .setValue(settings.tagSearchPrefix)
                .onChange(async (value) => {
                    if (this.validatePrefix(value)) {
                        settings.tagSearchPrefix = value;
                        await this.plugin.saveSettings();
                    }
                })
            );

        // Display Options
        const displayGroup = containerEl.createEl('div', { cls: 'settings-group' });
        displayGroup.createEl('h3', { text: 'Display Options', cls: 'settings-group-title' });

        new Setting(displayGroup)
            .setName('Display Only Note Names')
            .setDesc('Show only file names instead of full paths in search results')
            .addToggle(toggle => toggle
                .setValue(settings.displayOnlyNotesNames)
                .onChange(async (value) => {
                    settings.displayOnlyNotesNames = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(displayGroup)
            .setName('Hide .md Extensions')
            .setDesc('Remove .md extensions from note names in search results')
            .addToggle(toggle => toggle
                .setValue(settings.hideMdExtension)
                .onChange(async (value) => {
                    settings.hideMdExtension = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(displayGroup)
            .setName('Suggestion Limit')
            .setDesc('Maximum number of suggestions to display')
            .addSlider(slider => slider
                .setLimits(10, 100, 5)
                .setValue(settings.suggestionLimit)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.suggestionLimit = value;
                    await this.plugin.saveSettings();
                })
            );

        // Keyboard Shortcuts
        const keyboardGroup = containerEl.createEl('div', { cls: 'settings-group' });
        keyboardGroup.createEl('h3', { text: 'Keyboard Shortcuts', cls: 'settings-group-title' });

        new Setting(keyboardGroup)
            .setName('Hyper Key Override')
            .setDesc('Use caps lock icon (⇪) instead of ⌥ ^ ⌘ ⇧ for hyper key users')
            .addToggle(toggle => toggle
                .setValue(settings.hyperKeyOverride)
                .onChange(async (value) => {
                    settings.hyperKeyOverride = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(keyboardGroup)
            .setName('Reverse File Creation Shortcut')
            .setDesc('Use Shift to create files and Cmd/Ctrl to open in new tab (matches default quick switcher)')
            .addToggle(toggle => toggle
                .setValue(settings.createNewFileMod === 'Shift')
                .onChange(async (value) => {
                    settings.createNewFileMod = value ? 'Shift' : 'Mod';
                    settings.openInNewTabMod = value ? 'Mod' : 'Shift';
                    await this.plugin.saveSettings();
                })
            );
    }

    private createQuickLinkSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        new Setting(containerEl)
            .setName('Quick Link Enabled')
            .setDesc('Enable quick link creation from selected text')
            .addToggle(toggle => toggle
                .setValue(settings.quickLink.enabled)
                .onChange(async (value) => {
                    settings.quickLink.enabled = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Auto Close Quick Link Modal')
            .setDesc('Automatically close quick link modal after opening')
            .addToggle(toggle => toggle
                .setValue(settings.quickLink.autoCloseModal)
                .onChange(async (value) => {
                    settings.quickLink.autoCloseModal = value;
                    await this.plugin.saveSettings();
                })
            );
    }

    private createEnhancedSearchSettings(containerEl: HTMLElement): void {
        const searchSettingsPanel = new SearchSettingsPanel(this.plugin, containerEl);
        searchSettingsPanel.display();
    }

    private createSemanticSearchSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        // Enable/Disable Toggle
        new Setting(containerEl)
            .setName('Enable Semantic Search')
            .setDesc('Activate AI-powered semantic search using Ollama embeddings')
            .addToggle(toggle => toggle
                .setValue(settings.semanticSearch.enableSemanticSearch)
                .onChange(async (value) => {
                    settings.semanticSearch.enableSemanticSearch = value;
                    await this.plugin.saveSettings();
                    this.refreshSemanticSection();
                })
            );

        if (!settings.semanticSearch.enableSemanticSearch) {
            const infoEl = containerEl.createEl('div', { cls: 'settings-info' });
            infoEl.createEl('p', { 
                text: 'Semantic search requires Ollama to be installed and running. Enable this feature to configure advanced AI-powered search capabilities.'
            });
            return;
        }

        // Connection Settings
        const connectionGroup = containerEl.createEl('div', { cls: 'settings-group' });
        connectionGroup.createEl('h3', { text: 'Connection Settings', cls: 'settings-group-title' });

        new Setting(connectionGroup)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama server')
            .addText(text => text
                .setPlaceholder('http://localhost:11434')
                .setValue(settings.semanticSearch.ollamaUrl)
                .onChange(async (value) => {
                    if (this.validateUrl(value)) {
                        settings.semanticSearch.ollamaUrl = value;
                        await this.plugin.saveSettings();
                    }
                })
            );

        // Search Parameters
        const searchGroup = containerEl.createEl('div', { cls: 'settings-group' });
        searchGroup.createEl('h3', { text: 'Search Parameters', cls: 'settings-group-title' });

        new Setting(searchGroup)
            .setName('Search Threshold')
            .setDesc('Minimum similarity score for search results (lower = more results)')
            .addSlider(slider => slider
                .setLimits(0.1, 0.9, 0.05)
                .setValue(settings.semanticSearch.searchThreshold)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.searchThreshold = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(searchGroup)
            .setName('Maximum Results')
            .setDesc('Maximum number of semantic search results to return')
            .addSlider(slider => slider
                .setLimits(5, 50, 5)
                .setValue(settings.semanticSearch.maxResults)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.maxResults = value;
                    await this.plugin.saveSettings();
                })
            );

        // Performance Settings
        const perfGroup = containerEl.createEl('div', { cls: 'settings-group' });
        perfGroup.createEl('h3', { text: 'Performance Settings', cls: 'settings-group-title' });

        new Setting(perfGroup)
            .setName('Chunk Size')
            .setDesc('Text chunk size for embedding (larger = more context, slower)')
            .addSlider(slider => slider
                .setLimits(500, 2000, 100)
                .setValue(settings.semanticSearch.chunkSize)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.chunkSize = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(perfGroup)
            .setName('Max Concurrent Requests')
            .setDesc('Maximum simultaneous requests to Ollama')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(settings.semanticSearch.maxConcurrentRequests)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.semanticSearch.maxConcurrentRequests = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(perfGroup)
            .setName('Enable Cache')
            .setDesc('Cache embeddings to improve performance (recommended)')
            .addToggle(toggle => toggle
                .setValue(settings.semanticSearch.cacheEnabled)
                .onChange(async (value) => {
                    settings.semanticSearch.cacheEnabled = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(perfGroup)
            .setName('Preserve Search Query')
            .setDesc('Keep the search query when switching between command, file, and tag modes')
            .addToggle(toggle => toggle
                .setValue(settings.semanticSearch.preserveQuery)
                .onChange(async (value) => {
                    settings.semanticSearch.preserveQuery = value;
                    await this.plugin.saveSettings();
                })
            );

        // Exclusion Patterns
        new Setting(containerEl)
            .setName('Exclude Patterns')
            .setDesc('File patterns to exclude from semantic indexing (one per line)')
            .addTextArea(textArea => textArea
                .setPlaceholder('**/node_modules/**\n**/.git/**\n**/.*/**')
                .setValue(settings.semanticSearch.excludePatterns.join('\n'))
                .onChange(async (value) => {
                    settings.semanticSearch.excludePatterns = value
                        .split('\n')
                        .map(line => line.trim())
                        .filter(line => line.length > 0);
                    await this.plugin.saveSettings();
                })
            );

        // Actions
        const actionsGroup = containerEl.createEl('div', { cls: 'settings-group' });
        actionsGroup.createEl('h3', { text: 'Actions', cls: 'settings-group-title' });

        new Setting(actionsGroup)
            .setName('Rebuild Semantic Index')
            .setDesc('Recreate the semantic search index from scratch')
            .addButton(button => button
                .setButtonText('Rebuild Index')
                .setCta()
                .onClick(async () => {
                    await this.rebuildSemanticIndex(button);
                })
            );
    }

    private createMacroSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        if (settings.macros.length === 0) {
            const emptyEl = containerEl.createEl('div', { cls: 'settings-empty' });
            emptyEl.createEl('p', { 
                text: 'No macros created yet. Macros allow you to chain multiple commands together for quick execution.'
            });
        }

        // Add new macro button
        new Setting(containerEl)
            .setName('Create New Macro')
            .setDesc('Add a new command sequence macro')
            .addButton(button => button
                .setButtonText('+ Add Macro')
                .setCta()
                .onClick(async () => {
                    await this.createNewMacro();
                })
            );

        // Display existing macros
        settings.macros.forEach((macro, index) => {
            this.createMacroSetting(containerEl, macro, index);
        });
    }

    private createAdvancedSettings(containerEl: HTMLElement): void {
        const { settings } = this.plugin;

        // File Type Exclusions
        const exclusionGroup = containerEl.createEl('div', { cls: 'settings-group' });
        exclusionGroup.createEl('h3', { text: 'File Exclusions', cls: 'settings-group-title' });

        new Setting(exclusionGroup)
            .setName('Excluded File Types')
            .setDesc('Comma-separated list of file extensions to exclude from search (e.g., pdf,jpg,png)')
            .addText(text => text
                .setPlaceholder('pdf,jpg,png,gif,svg')
                .setValue(settings.fileTypeExclusion.join(','))
                .onChange(async (value) => {
                    const extensions = value
                        .split(',')
                        .map(ext => ext.trim().toLowerCase())
                        .filter(ext => ext.length > 0);
                    settings.fileTypeExclusion = extensions;
                    await this.plugin.saveSettings();
                })
            );

        // Hidden Items Management
        const hiddenGroup = containerEl.createEl('div', { cls: 'settings-group' });
        hiddenGroup.createEl('h3', { text: 'Hidden Items', cls: 'settings-group-title' });

        this.createHiddenItemsSetting(hiddenGroup, 'Commands', settings.hiddenCommands, 'hiddenCommands');
        this.createHiddenItemsSetting(hiddenGroup, 'Files', settings.hiddenFiles, 'hiddenFiles');
        this.createHiddenItemsSetting(hiddenGroup, 'Tags', settings.hiddenTags, 'hiddenTags');

        // Reset Section
        const resetGroup = containerEl.createEl('div', { cls: 'settings-group' });
        resetGroup.createEl('h3', { text: 'Reset Options', cls: 'settings-group-title' });

        new Setting(resetGroup)
            .setName('Reset All Settings')
            .setDesc('Reset all plugin settings to default values')
            .addButton(button => button
                .setButtonText('Reset All')
                .setWarning()
                .onClick(async () => {
                    await this.resetAllSettings();
                })
            );
    }

    // Helper methods

    private validatePrefix(prefix: string): boolean {
        if (!prefix || prefix.length !== 1) {
            new Notice('Search prefix must be exactly one character');
            return false;
        }
        return true;
    }

    private validateUrl(url: string): boolean {
        try {
            new URL(url);
            return true;
        } catch {
            new Notice('Please enter a valid URL');
            return false;
        }
    }

    private refreshSemanticSection(): void {
        const sectionEl = this.sectionElements.get('semantic-search');
        if (sectionEl) {
            sectionEl.empty();
            this.createSemanticSearchSettings(sectionEl);
        }
    }

    private async rebuildSemanticIndex(button: any): Promise<void> {
        const originalText = button.buttonEl?.textContent || button.textContent;
        if (button.buttonEl) {
            button.buttonEl.textContent = 'Rebuilding...';
            button.setDisabled(true);
        } else {
            button.textContent = 'Rebuilding...';
            button.disabled = true;
        }

        try {
            await this.plugin.reindexSemanticSearch();
            new Notice('Semantic search index rebuilt successfully');
            logger.info('Semantic search index rebuilt successfully');
        } catch (error) {
            const errorMsg = `Failed to rebuild index: ${error.message}`;
            new Notice(errorMsg);
            logger.error('Failed to rebuild semantic search index', error);
        } finally {
            if (button.buttonEl) {
                button.buttonEl.textContent = originalText;
                button.setDisabled(false);
            } else {
                button.textContent = originalText;
                button.disabled = false;
            }
        }
    }

    private async createNewMacro(): Promise<void> {
        const newMacro: MacroCommandInterface = {
            name: `Macro ${this.plugin.settings.macros.length + 1}`,
            commandIds: [],
            delay: 100
        };

        this.plugin.settings.macros.push(newMacro);
        await this.plugin.saveSettings();
        this.refreshMacroSection();
    }

    private createMacroSetting(containerEl: HTMLElement, macro: MacroCommandInterface, index: number): void {
        const macroContainer = containerEl.createEl('div', { cls: 'macro-container' });
        
        // Macro header
        const headerSetting = new Setting(macroContainer)
            .setName(`${macro.name}`)
            .setDesc(`${macro.commandIds.length} commands • ${macro.delay}ms delay`)
            .addButton(button => button
                .setButtonText('Delete')
                .setWarning()
                .onClick(async () => {
                    await this.deleteMacro(index);
                })
            );

        // Macro details
        const detailsEl = macroContainer.createEl('div', { cls: 'macro-details' });
        
        new Setting(detailsEl)
            .setName('Macro Name')
            .addText(text => text
                .setValue(macro.name)
                .onChange(async (value) => {
                    if (value.trim()) {
                        this.plugin.settings.macros[index].name = value;
                        await this.plugin.saveSettings();
                        this.refreshMacroSection();
                    }
                })
            );

        new Setting(detailsEl)
            .setName('Delay Between Commands (ms)')
            .addSlider(slider => slider
                .setLimits(0, 1000, 50)
                .setValue(macro.delay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.macros[index].delay = value;
                    await this.plugin.saveSettings();
                })
            );

        // Commands list
        if (macro.commandIds.length > 0) {
            const commandsEl = detailsEl.createEl('div', { cls: 'macro-commands' });
            commandsEl.createEl('h4', { text: 'Commands:', cls: 'macro-commands-title' });
            
            macro.commandIds.forEach((commandId, commandIndex) => {
                const command = this.app.commands.findCommand(commandId);
                const commandEl = commandsEl.createEl('div', { cls: 'macro-command-item' });
                
                commandEl.createEl('span', { 
                    text: `${commandIndex + 1}. ${command?.name || 'Unknown Command'}`,
                    cls: 'macro-command-name'
                });
                
                const removeBtn = commandEl.createEl('button', { 
                    cls: 'macro-command-remove' 
                });
                setIcon(removeBtn, 'trash');
                removeBtn.addEventListener('click', async () => {
                    await this.removeCommandFromMacro(index, commandIndex);
                });
            });
        }

        // Add command button
        new Setting(detailsEl)
            .setName('Add Command')
            .addButton(button => button
                .setButtonText('+ Add Command')
                .onClick(async () => {
                    await this.addCommandToMacro(index);
                })
            );
    }

    private async deleteMacro(index: number): Promise<void> {
        this.plugin.settings.macros.splice(index, 1);
        await this.plugin.saveSettings();
        this.refreshMacroSection();
    }

    private async removeCommandFromMacro(macroIndex: number, commandIndex: number): Promise<void> {
        this.plugin.settings.macros[macroIndex].commandIds.splice(commandIndex, 1);
        await this.plugin.saveSettings();
        this.refreshMacroSection();
    }

    private async addCommandToMacro(macroIndex: number): Promise<void> {
        const modal = new SettingsCommandSuggestModal(
            this.app,
            async (command: Command) => {
                this.plugin.settings.macros[macroIndex].commandIds.push(command.id);
                await this.plugin.saveSettings();
                this.refreshMacroSection();
            }
        );
        modal.open();
    }

    private refreshMacroSection(): void {
        const sectionEl = this.sectionElements.get('macros');
        if (sectionEl) {
            sectionEl.empty();
            this.createMacroSettings(sectionEl);
        }
    }

    private createHiddenItemsSetting(
        containerEl: HTMLElement, 
        type: string, 
        items: string[], 
        settingsKey: keyof BetterCommandPalettePluginSettings
    ): void {
        new Setting(containerEl)
            .setName(`Hidden ${type}`)
            .setDesc(`${items.length} ${type.toLowerCase()} currently hidden`)
            .addButton(button => button
                .setButtonText(`Manage Hidden ${type}`)
                .onClick(() => {
                    // TODO: Implement hidden items management modal
                    new Notice(`Hidden ${type} management coming soon`);
                })
            );
    }

    private async resetAllSettings(): Promise<void> {
        const confirmed = confirm(
            'Are you sure you want to reset all settings to their default values? This action cannot be undone.'
        );
        
        if (confirmed) {
            this.plugin.settings = { ...DEFAULT_SETTINGS };
            await this.plugin.saveSettings();
            this.display();
            new Notice('All settings have been reset to defaults');
        }
    }
}
