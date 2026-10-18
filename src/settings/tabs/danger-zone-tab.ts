import { App, Notice, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { deleteLegacyDatabases, findLegacyDatabases, summarizeLegacyDeleteResults } from '../../search/legacy-storage';

/** File type exclusions, hidden items, legacy storage cleanup and reset. */
export class DangerZoneTab implements BaseSettingsTab {
    id = 'danger-zone';
    title = 'Data and reset';

    /** Called after a reset so the settings UI can re-render against the new settings object. */
    private onReset?: () => void;

    constructor(onReset?: () => void) {
        this.onReset = onReset;
    }

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        this.displayFileTypes(containerEl, plugin);
        this.displayHiddenItems(containerEl, plugin);
        this.displayLegacyStorage(containerEl, app);
        this.displayReset(containerEl, plugin);
    }

    private displayFileTypes(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .setHeading('Excluded file types')
            .addSetting((setting) => setting
                .setName('Excluded file types')
                .setDesc('Comma-separated list of file extensions to exclude from search.')
                .addText((text) => text
                    .setPlaceholder('pdf,jpg,png')
                    .setValue(settings.fileTypeExclusion.join(','))
                    .onChange(async (value) => {
                        const extensions = value.split(',').map((ext) => ext.trim().toLowerCase()).filter((e) => e.length > 0);
                        settings.fileTypeExclusion = extensions;
                        await plugin.saveSettings();
                    })));
    }

    private displayHiddenItems(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;
        const group = new SettingGroup(containerEl).setHeading('Hidden items');

        const addHiddenSetting = (type: string, items: string[]) => {
            group.addSetting((setting) => setting
                .setName(`Hidden ${type}`)
                .setDesc(`${items.length} ${type} currently hidden.`)
                .addButton((button) => button
                    .setButtonText(`Manage ${type}`)
                    .onClick(() => {
                        new Notice(`Hidden ${type} management coming soon`);
                    })));
        };

        addHiddenSetting('commands', settings.hiddenCommands);
        addHiddenSetting('files', settings.hiddenFiles);
        addHiddenSetting('tags', settings.hiddenTags);
    }

    private displayLegacyStorage(containerEl: HTMLElement, app: App): void {
        const baseDesc = 'Delete the shared databases written by plugin versions before per-vault storage. '
            + 'This vault\'s current indexes are not touched.';

        new SettingGroup(containerEl)
            .setHeading('Storage')
            .addSetting((setting) => {
                setting
                    .setName('Delete legacy databases')
                    .setDesc(baseDesc);

                const describeFound = async () => {
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
                            void describeFound();
                        }
                    }));

                void describeFound();
            });
    }

    private displayReset(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        new SettingGroup(containerEl)
            .setHeading('Reset')
            .addSetting((setting) => setting
                .setName('Reset all settings')
                .setDesc('Reset all plugin settings to default values.')
                .addButton((button) => button
                    .setButtonText('Reset all')
                    .setWarning()
                    .onClick(async () => {
                        if (confirm('Are you sure you want to reset all settings?')) {
                            await plugin.resetSettings();
                            new Notice('All settings reset to defaults.');
                            this.onReset?.();
                        }
                    })));
    }
}
