import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class QuickLinkTab implements BaseSettingsTab {
    id = 'quick-link';
    title = 'Quick Link';
    icon = 'link';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Quick Link Enabled')
            .setDesc('Enable quick link creation from selected text')
            .addToggle((toggle) => toggle
                .setValue(settings.quickLink.enabled)
                .onChange(async (value) => {
                    settings.quickLink.enabled = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Auto Close Quick Link Modal')
            .setDesc('Automatically close quick link modal after opening')
            .addToggle((toggle) => toggle
                .setValue(settings.quickLink.autoCloseModal)
                .onChange(async (value) => {
                    settings.quickLink.autoCloseModal = value;
                    await plugin.saveSettings();
                }));

        const semanticEnabled = settings.semanticSearch.enableSemanticSearch;
        const hybridEnabled = settings.hybridSearch.enabled;

        new Setting(containerEl)
            .setName('Search Engine')
            .setDesc('Choose which search engine to use for finding files in Quick Link')
            .addDropdown((dropdown) => {
                dropdown.addOption('enhanced', 'Enhanced (Keyword)');
                dropdown.addOption('semantic', semanticEnabled ? 'Semantic (AI)' : 'Semantic (AI) - Enable in settings');
                dropdown.addOption('hybrid', hybridEnabled ? 'Hybrid (Combined)' : 'Hybrid (Combined) - Enable in settings');
                dropdown.setValue(settings.quickLink.searchEngine);
                dropdown.onChange(async (value: 'enhanced' | 'semantic' | 'hybrid') => {
                    if (value === 'semantic' && !semanticEnabled) {
                        new Notice('Please enable Semantic Search in settings first');
                        dropdown.setValue(settings.quickLink.searchEngine);
                        return;
                    }
                    if (value === 'hybrid' && !hybridEnabled) {
                        new Notice('Please enable Hybrid Search in settings first');
                        dropdown.setValue(settings.quickLink.searchEngine);
                        return;
                    }
                    settings.quickLink.searchEngine = value;
                    await plugin.saveSettings();
                });
            });
    }
}
