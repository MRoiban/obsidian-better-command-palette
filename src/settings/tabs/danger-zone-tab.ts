import { App, Setting, Notice } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { deleteLegacyDatabases, findLegacyDatabases, summarizeLegacyDeleteResults } from '../../search/legacy-storage';

export class DangerZoneTab implements BaseSettingsTab {
    id = 'danger-zone';
    title = 'Danger Zone';
    icon = 'alert-triangle';

    /** Called after a reset so the settings UI can re-render against the new settings object. */
    private onReset?: () => void;

    constructor(onReset?: () => void) {
        this.onReset = onReset;
    }

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

        this.displayLegacyStorage(containerEl, app);

        containerEl.createEl('h3', { text: 'Reset' });

        new Setting(containerEl)
            .setName('Reset All Settings')
            .setDesc('Reset all plugin settings to default values')
            .addButton((button) => button
                .setButtonText('Reset All')
                .setWarning()
                .onClick(async () => {
                    if (confirm('Are you sure you want to reset all settings?')) {
                        await plugin.resetSettings();
                        new Notice('All settings reset to defaults.');
                        this.onReset?.();
                    }
                }));
    }

    private displayLegacyStorage(containerEl: HTMLElement, app: App): void {
        containerEl.createEl('h3', { text: 'Storage' });

        const baseDesc = 'Delete the shared databases written by plugin versions before per-vault storage. '
            + 'This vault\'s current indexes are not touched.';
        const setting = new Setting(containerEl)
            .setName('Delete legacy databases')
            .setDesc(baseDesc);

        const describe = async () => {
            const found = await findLegacyDatabases();
            if (!setting.descEl.isConnected) return;
            if (found === null) {
                setting.setDesc(baseDesc);
            } else if (found.length === 0) {
                setting.setDesc(`${baseDesc} None found.`);
            } else {
                setting.setDesc(`${baseDesc} Found: ${found.map((db) => db.label).join(', ')}.`);
            }
        };

        setting.addButton((button) => button
            .setButtonText('Delete legacy')
            .setWarning()
            .onClick(async () => {
                const confirmed = confirm(
                    'Delete the legacy (pre per-vault) semantic embeddings and keyword index databases?\n\n'
                    + 'Other vaults that have not been opened since the per-vault storage update will lose '
                    + 'their migration source and rebuild their indexes from scratch. '
                    + 'This vault\'s current indexes are kept.',
                );
                if (!confirmed) return;

                button.setDisabled(true);
                try {
                    const results = await deleteLegacyDatabases(app);
                    new Notice(summarizeLegacyDeleteResults(results), 8000);
                } finally {
                    button.setDisabled(false);
                    void describe();
                }
            }));

        void describe();
    }
}
