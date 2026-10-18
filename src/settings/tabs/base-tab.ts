import { App } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';

/**
 * A settings module. Each tab appends one or more native `SettingGroup`s to the
 * container; the settings tab renders them in sequence as one flat page.
 */
export interface BaseSettingsTab {
    id: string;
    title: string;
    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void;
}
