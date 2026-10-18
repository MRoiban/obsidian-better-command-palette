import { App, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class GeneralTab implements BaseSettingsTab {
    id = 'general';
    title = 'General';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        this.renderGeneral(containerEl, plugin);
        this.renderDisplay(containerEl, plugin);
        this.renderShortcuts(containerEl, plugin);
        this.renderPrefixes(containerEl, plugin);
    }

    /** First group: no heading, like native settings tabs. */
    private renderGeneral(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .addSetting((setting) => setting
                .setName('Close on backspace')
                .setDesc('Close the palette when there is no text and backspace is pressed.')
                .addToggle((toggle) => toggle
                    .setValue(settings.closeWithBackspace)
                    .onChange(async (value) => {
                        settings.closeWithBackspace = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Show plugin name')
                .setDesc('Display the plugin name in commands for easier identification.')
                .addToggle((toggle) => toggle
                    .setValue(settings.showPluginName)
                    .onChange(async (value) => {
                        settings.showPluginName = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Recent above pinned')
                .setDesc('Prioritize recently used items over pinned items in search results.')
                .addToggle((toggle) => toggle
                    .setValue(settings.recentAbovePinned)
                    .onChange(async (value) => {
                        settings.recentAbovePinned = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Recently used label')
                .setDesc('Text shown at the right of recently used items.')
                .addText((text) => text
                    .setPlaceholder('recent')
                    .setValue(settings.recentlyUsedText)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            settings.recentlyUsedText = value;
                            await plugin.saveSettings();
                        }
                    })));
    }

    private renderDisplay(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .setHeading('Display')
            .addSetting((setting) => setting
                .setName('Display only note names')
                .setDesc('Show only file names instead of full paths in search results.')
                .addToggle((toggle) => toggle
                    .setValue(settings.displayOnlyNotesNames)
                    .onChange(async (value) => {
                        settings.displayOnlyNotesNames = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Hide .md extensions')
                .setDesc('Remove .md extensions from note names in search results.')
                .addToggle((toggle) => toggle
                    .setValue(settings.hideMdExtension)
                    .onChange(async (value) => {
                        settings.hideMdExtension = value;
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Suggestion limit')
                .setDesc('Maximum number of suggestions to display.')
                .addSlider((slider) => slider
                    .setLimits(10, 100, 5)
                    .setValue(settings.suggestionLimit)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        settings.suggestionLimit = value;
                        await plugin.saveSettings();
                    })));
    }

    private renderShortcuts(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .setHeading('Shortcuts')
            .addSetting((setting) => setting
                .setName('Hyper key override')
                .setDesc('Use the caps lock icon (⇪) instead of ⌥ ^ ⌘ ⇧ for hyper key users.')
                .addToggle((toggle) => toggle
                    .setValue(settings.hyperKeyOverride)
                    .onChange(async (value) => {
                        settings.hyperKeyOverride = value;
                        await plugin.saveSettings();
                    })));
    }

    private renderPrefixes(containerEl: HTMLElement, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new SettingGroup(containerEl)
            .setHeading('Prefixes and hotkeys')
            .addSetting((setting) => setting
                .setName('File search prefix')
                .setDesc('Character to trigger file search in the command palette.')
                .addText((text) => text
                    .setValue(settings.fileSearchPrefix)
                    .onChange(async (value) => {
                        settings.fileSearchPrefix = value || '/';
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Tag search prefix')
                .setDesc('Character to trigger tag search in the command palette.')
                .addText((text) => text
                    .setValue(settings.tagSearchPrefix)
                    .onChange(async (value) => {
                        settings.tagSearchPrefix = value || '#';
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Command search hotkey')
                .setDesc('Key to open command search (with Cmd/Ctrl).')
                .addText((text) => text
                    .setValue(settings.commandSearchHotkey)
                    .onChange(async (value) => {
                        settings.commandSearchHotkey = value || 'p';
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('File search hotkey')
                .setDesc('Key to open file search (with Cmd/Ctrl).')
                .addText((text) => text
                    .setValue(settings.fileSearchHotkey)
                    .onChange(async (value) => {
                        settings.fileSearchHotkey = value || 'o';
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Tag search hotkey')
                .setDesc('Key to open tag search (with Cmd/Ctrl).')
                .addText((text) => text
                    .setValue(settings.tagSearchHotkey)
                    .onChange(async (value) => {
                        settings.tagSearchHotkey = value || 't';
                        await plugin.saveSettings();
                    })))
            .addSetting((setting) => setting
                .setName('Reverse file creation shortcut')
                .setDesc('Use Shift to create files and Cmd/Ctrl to open in a new tab (matches the default quick switcher).')
                .addToggle((toggle) => toggle
                    .setValue(settings.createNewFileMod === 'Shift')
                    .onChange(async (value) => {
                        settings.createNewFileMod = value ? 'Shift' : 'Mod';
                        settings.openInNewTabMod = value ? 'Mod' : 'Shift';
                        await plugin.saveSettings();
                    })));
    }
}
