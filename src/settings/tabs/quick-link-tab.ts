import { App, Notice, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class QuickLinkTab implements BaseSettingsTab {
    id = 'quick-link';
    title = 'Quick link';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;
        const semanticEnabled = settings.semanticSearch.enableSemanticSearch;
        const hybridEnabled = settings.hybridSearch.enabled;

        new SettingGroup(containerEl)
            .setHeading('Quick link')
            .addSetting((setting) => setting
                .setName('Enable quick link')
                .setDesc('Enable quick link creation from selected text.')
                .addToggle((toggle) => toggle
                    .setValue(settings.quickLink.enabled)
                    .onChange(async (value) => {
                        settings.quickLink.enabled = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Auto close quick link modal')
                .setDesc('Automatically close the quick link modal after opening.')
                .addToggle((toggle) => toggle
                    .setValue(settings.quickLink.autoCloseModal)
                    .onChange(async (value) => {
                        settings.quickLink.autoCloseModal = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Search engine')
                .setDesc('Choose which search engine to use for finding files in quick link.')
                .addDropdown((dropdown) => {
                    dropdown.addOption('enhanced', 'Enhanced (keyword)');
                    dropdown.addOption('semantic', semanticEnabled ? 'Semantic' : 'Semantic (enable in settings)');
                    dropdown.addOption('hybrid', hybridEnabled ? 'Hybrid' : 'Hybrid (enable in settings)');
                    dropdown.setValue(settings.quickLink.searchEngine);
                    dropdown.onChange(async (value: 'enhanced' | 'semantic' | 'hybrid') => {
                        if (value === 'semantic' && !semanticEnabled) {
                            new Notice('Please enable semantic search in settings first');
                            dropdown.setValue(settings.quickLink.searchEngine);
                            return;
                        }
                        if (value === 'hybrid' && !hybridEnabled) {
                            new Notice('Please enable hybrid search in settings first');
                            dropdown.setValue(settings.quickLink.searchEngine);
                            return;
                        }
                        settings.quickLink.searchEngine = value;
                        await plugin.saveSettings();
                    });
                }));
    }
}
