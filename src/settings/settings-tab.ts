import { App, PluginSettingTab, Setting, debounce } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './tabs/base-tab';
import { GeneralTab } from './tabs/general-tab';
import { SearchTab } from './tabs/search-tab';
import { SemanticTab } from './tabs/semantic-tab';
import { HybridTab } from './tabs/hybrid-tab';
import { QuickLinkTab } from './tabs/quick-link-tab';
import { MacrosTab } from './tabs/macros-tab';
import { DangerZoneTab } from './tabs/danger-zone-tab';
import { CollapsibleSettingGroup } from './collapsible-setting-group';

export class BetterCommandPaletteSettingTab extends PluginSettingTab {
    plugin: BetterCommandPalettePlugin;
    private tabs: BaseSettingsTab[] = [];
    private searchInput: HTMLInputElement | null = null;
    private groups: Map<string, CollapsibleSettingGroup> = new Map();

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
            new DangerZoneTab(),
        ];
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('bcp-settings-container');

        // Header & Search
        const headerContainer = containerEl.createDiv({ cls: 'bcp-settings-header-container' });

        new Setting(headerContainer)
            .setName('Better Command Palette')
            .setDesc('Configure search, appearance, and advanced features')
            .addSearch((cb) => {
                cb.setPlaceholder('Search settings...')
                    .onChange(debounce((value) => {
                        this.searchSettings(value);
                    }, 300));
                this.searchInput = cb.inputEl;
            });

        // Controls (Expand/Collapse All)
        const controlsContainer = headerContainer.createDiv({ cls: 'bcp-settings-global-controls' });

        const expandAll = controlsContainer.createSpan({ cls: 'bcp-control-link' });
        expandAll.setText('Expand all');
        expandAll.onclick = () => this.toggleAllSections(true);

        const collapseAll = controlsContainer.createSpan({ cls: 'bcp-control-link' });
        collapseAll.setText('Collapse all');
        collapseAll.onclick = () => this.toggleAllSections(false);

        // Sections using CollapsibleSettingGroup
        this.groups.clear();
        const contentContainer = containerEl.createDiv({ cls: 'bcp-settings-content' });

        this.tabs.forEach(tab => {
            this.renderSection(contentContainer, tab);
        });
    }

    private renderSection(container: HTMLElement, tab: BaseSettingsTab): void {
        // Create collapsible group using the new wrapper
        const group = new CollapsibleSettingGroup(container, {
            title: tab.title,
            icon: tab.icon,
            defaultCollapsed: true
        });

        // Have the tab render its content into the group's content area
        tab.display(group.content, this.app, this.plugin);

        // Store reference for expand/collapse all and search
        this.groups.set(tab.id, group);
    }

    private toggleAllSections(expand: boolean): void {
        this.groups.forEach((group) => {
            if (expand) {
                group.expand();
            } else {
                group.collapse();
            }
        });
    }

    private searchSettings(query: string): void {
        const normalizedQuery = query.toLowerCase().trim();

        if (!normalizedQuery) {
            // Reset view - show all sections and items
            this.groups.forEach((group) => {
                group.element.style.display = 'block';
                const items = group.content.querySelectorAll('.setting-item');
                items.forEach((item) => (item as HTMLElement).style.display = 'flex');
            });
            return;
        }

        this.groups.forEach((group, id) => {
            const content = group.content;
            let hasMatch = false;

            // Search in setting items
            const items = content.querySelectorAll('.setting-item');
            items.forEach((item) => {
                const itemEl = item as HTMLElement;
                const name = itemEl.querySelector('.setting-item-name')?.textContent?.toLowerCase() || '';
                const desc = itemEl.querySelector('.setting-item-description')?.textContent?.toLowerCase() || '';

                if (name.includes(normalizedQuery) || desc.includes(normalizedQuery)) {
                    itemEl.style.display = 'flex';
                    hasMatch = true;
                } else {
                    itemEl.style.display = 'none';
                }
            });

            // Check section title too
            const sectionTitle = group.header.textContent?.toLowerCase() || '';
            if (sectionTitle.includes(normalizedQuery)) {
                hasMatch = true;
                items.forEach((item) => (item as HTMLElement).style.display = 'flex');
            }

            if (hasMatch) {
                group.element.style.display = 'block';
                group.expand(); // Auto expand matching sections
            } else {
                group.element.style.display = 'none';
            }
        });
    }
}
