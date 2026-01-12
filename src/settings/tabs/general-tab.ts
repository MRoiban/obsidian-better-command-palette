import { App, Setting } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';

export class GeneralTab implements BaseSettingsTab {
    id = 'general';
    title = 'General';
    icon = 'settings-2';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        new Setting(containerEl)
            .setName('Close on Backspace')
            .setDesc('Close the palette when there is no text and backspace is pressed')
            .addToggle((toggle) => toggle
                .setValue(settings.closeWithBackspace)
                .onChange(async (value) => {
                    settings.closeWithBackspace = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Plugin Name')
            .setDesc('Display the plugin name in commands for easier identification')
            .addToggle((toggle) => toggle
                .setValue(settings.showPluginName)
                .onChange(async (value) => {
                    settings.showPluginName = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Recent Above Pinned')
            .setDesc('Prioritize recently used items over pinned items in search results')
            .addToggle((toggle) => toggle
                .setValue(settings.recentAbovePinned)
                .onChange(async (value) => {
                    settings.recentAbovePinned = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Recently Used Label')
            .setDesc('Custom text displayed next to recently used items')
            .addText((text) => text
                .setPlaceholder('(recently used)')
                .setValue(settings.recentlyUsedText)
                .onChange(async (value) => {
                    if (value.trim()) {
                        settings.recentlyUsedText = value;
                        await plugin.saveSettings();
                    }
                }));

        // Display Options
        containerEl.createEl('h3', { text: 'Display Options' });

        new Setting(containerEl)
            .setName('Display Only Note Names')
            .setDesc('Show only file names instead of full paths in search results')
            .addToggle((toggle) => toggle
                .setValue(settings.displayOnlyNotesNames)
                .onChange(async (value) => {
                    settings.displayOnlyNotesNames = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Hide .md Extensions')
            .setDesc('Remove .md extensions from note names in search results')
            .addToggle((toggle) => toggle
                .setValue(settings.hideMdExtension)
                .onChange(async (value) => {
                    settings.hideMdExtension = value;
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Suggestion Limit')
            .setDesc('Maximum number of suggestions to display')
            .addSlider((slider) => slider
                .setLimits(10, 100, 5)
                .setValue(settings.suggestionLimit)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    settings.suggestionLimit = value;
                    await plugin.saveSettings();
                }));

        // Keyboard Shortcuts
        containerEl.createEl('h3', { text: 'Shortcuts' });

        new Setting(containerEl)
            .setName('Hyper Key Override')
            .setDesc('Use caps lock icon (⇪) instead of ⌥ ^ ⌘ ⇧ for hyper key users')
            .addToggle((toggle) => toggle
                .setValue(settings.hyperKeyOverride)
                .onChange(async (value) => {
                    settings.hyperKeyOverride = value;
                    await plugin.saveSettings();
                }));

        // Prefixes & Hotkeys
        containerEl.createEl('h3', { text: 'Prefixes & Hotkeys' });

        new Setting(containerEl)
            .setName('File Search Prefix')
            .setDesc('Character to trigger file search in command palette')
            .addText((text) => text
                .setValue(settings.fileSearchPrefix)
                .onChange(async (value) => {
                    settings.fileSearchPrefix = value || '/';
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Tag Search Prefix')
            .setDesc('Character to trigger tag search in command palette')
            .addText((text) => text
                .setValue(settings.tagSearchPrefix)
                .onChange(async (value) => {
                    settings.tagSearchPrefix = value || '#';
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Command Search Hotkey')
            .setDesc('Key to open command search (with Cmd/Ctrl)')
            .addText((text) => text
                .setValue(settings.commandSearchHotkey)
                .onChange(async (value) => {
                    settings.commandSearchHotkey = value || 'p';
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('File Search Hotkey')
            .setDesc('Key to open file search (with Cmd/Ctrl)')
            .addText((text) => text
                .setValue(settings.fileSearchHotkey)
                .onChange(async (value) => {
                    settings.fileSearchHotkey = value || 'o';
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Tag Search Hotkey')
            .setDesc('Key to open tag search (with Cmd/Ctrl)')
            .addText((text) => text
                .setValue(settings.tagSearchHotkey)
                .onChange(async (value) => {
                    settings.tagSearchHotkey = value || 't';
                    await plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Reverse File Creation Shortcut')
            .setDesc('Use Shift to create files and Cmd/Ctrl to open in new tab (matches default quick switcher)')
            .addToggle((toggle) => toggle
                .setValue(settings.createNewFileMod === 'Shift')
                .onChange(async (value) => {
                    settings.createNewFileMod = value ? 'Shift' : 'Mod';
                    settings.openInNewTabMod = value ? 'Mod' : 'Shift';
                    await plugin.saveSettings();
                }));
    }
}
