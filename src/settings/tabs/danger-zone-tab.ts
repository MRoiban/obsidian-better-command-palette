import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { DEFAULT_SETTINGS } from 'src/settings';
import { BaseSettingsTab } from './base-tab';

export class DangerZoneTab implements BaseSettingsTab {
    id = 'danger-zone';
    title = 'Danger Zone';
    icon = 'alert-triangle';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Excluded File Types')
            .setDesc('Comma-separated list of file extensions to exclude from search')
            .addText((text) => text
                .setPlaceholder('pdf,jpg,png')
                .setValue(settings.fileTypeExclusion.join(','))
                .onChange(async (value) => {
                    const extensions = value.split(',').map((ext) => ext.trim().toLowerCase()).filter(e => e.length > 0);
                    settings.fileTypeExclusion = extensions;
                    await plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Hidden Items' });

        const createHiddenSetting = (type: string, items: string[]) => {
            new Setting(containerEl)
                .setName(`Hidden ${type}`)
                .setDesc(`${items.length} ${type.toLowerCase()} currently hidden`)
                .addButton((button) => button
                    .setButtonText(`Manage ${type}`)
                    .onClick(() => {
                        new Notice(`Hidden ${type} management coming soon`);
                    }));
        };

        createHiddenSetting('Commands', settings.hiddenCommands);
        createHiddenSetting('Files', settings.hiddenFiles);
        createHiddenSetting('Tags', settings.hiddenTags);

        containerEl.createEl('h3', { text: 'Reset' });

        new Setting(containerEl)
            .setName('Reset All Settings')
            .setDesc('Reset all plugin settings to default values')
            .addButton((button) => button
                .setButtonText('Reset All')
                .setWarning()
                .onClick(async () => {
                    if (confirm('Are you sure you want to reset all settings?')) {
                        plugin.settings = { ...DEFAULT_SETTINGS };
                        await plugin.saveSettings();
                        new Notice('All settings reset to defaults.');
                        // Force refresh if feasible, or just notify to reload
                    }
                }));
    }
}
