import { App, PluginSettingTab } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './tabs/base-tab';
import { GeneralTab } from './tabs/general-tab';
import { SearchTab } from './tabs/search-tab';
import { SemanticTab } from './tabs/semantic-tab';
import { HybridTab } from './tabs/hybrid-tab';
import { QuickLinkTab } from './tabs/quick-link-tab';
import { MacrosTab } from './tabs/macros-tab';
import { DangerZoneTab } from './tabs/danger-zone-tab';

/**
 * Plugin settings page. Renders every module as native `SettingGroup`s in one flat
 * list (General first, no heading); the theme draws all of the chrome.
 */
export class BetterCommandPaletteSettingTab extends PluginSettingTab {
    plugin: BetterCommandPalettePlugin;
    private tabs: BaseSettingsTab[] = [];

    constructor(app: App, plugin: BetterCommandPalettePlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.initializeTabs();
    }

    private initializeTabs(): void {
        this.tabs = [
            new GeneralTab(),
            new SearchTab(),
            new SemanticTab(),
            new HybridTab(),
            new QuickLinkTab(),
            new MacrosTab(),
            new DangerZoneTab(() => this.display()),
        ];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        this.tabs.forEach((tab) => tab.display(containerEl, this.app, this.plugin));
    }
}
