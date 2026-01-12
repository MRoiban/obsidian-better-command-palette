import { App } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';

export interface BaseSettingsTab {
    id: string;
    title: string;
    icon: string;
    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void;
}
