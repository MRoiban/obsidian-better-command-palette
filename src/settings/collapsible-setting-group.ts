import {
    SettingGroup,
    Setting,
    SearchComponent,
    ExtraButtonComponent,
    setIcon,
    IconName
} from 'obsidian';

export interface CollapsibleSettingGroupOptions {
    title: string;
    icon?: IconName;
    defaultCollapsed?: boolean;
}

/**
 * A wrapper around Obsidian's SettingGroup that adds collapsible sections with icons.
 * Uses SettingGroup internally to maintain consistent styling with native Obsidian settings.
 */
export class CollapsibleSettingGroup {
    private containerEl: HTMLElement;
    private headerEl: HTMLElement;
    private contentEl: HTMLElement;
    private chevronEl: HTMLElement;
    private group: SettingGroup;
    private isCollapsed: boolean;

    readonly id: string;

    constructor(parentEl: HTMLElement, options: CollapsibleSettingGroupOptions) {
        this.id = options.title.toLowerCase().replace(/\s+/g, '-');
        this.isCollapsed = options.defaultCollapsed ?? true;

        // Main container
        this.containerEl = parentEl.createDiv({ cls: 'bcp-collapsible-group' });

        // Collapsible header
        this.headerEl = this.containerEl.createDiv({ cls: 'bcp-collapsible-header' });

        const titleGroup = this.headerEl.createDiv({ cls: 'bcp-collapsible-title-group' });

        if (options.icon) {
            const iconEl = titleGroup.createSpan({ cls: 'bcp-collapsible-icon' });
            setIcon(iconEl, options.icon);
        }

        titleGroup.createSpan({ cls: 'bcp-collapsible-title', text: options.title });

        this.chevronEl = this.headerEl.createSpan({ cls: 'bcp-collapsible-chevron' });
        this.updateChevron();

        // Content container
        this.contentEl = this.containerEl.createDiv({ cls: 'bcp-collapsible-content' });
        this.updateContentVisibility();

        // Use Obsidian's SettingGroup for the actual settings
        this.group = new SettingGroup(this.contentEl);

        // Toggle on header click
        this.headerEl.addEventListener('click', () => this.toggle());
    }

    private updateChevron(): void {
        setIcon(this.chevronEl, this.isCollapsed ? 'chevron-right' : 'chevron-down');
    }

    private updateContentVisibility(): void {
        this.contentEl.style.display = this.isCollapsed ? 'none' : 'block';
    }

    /**
     * Toggle the collapsed state
     */
    toggle(): this {
        this.isCollapsed = !this.isCollapsed;
        this.updateChevron();
        this.updateContentVisibility();
        return this;
    }

    /**
     * Expand the section
     */
    expand(): this {
        if (this.isCollapsed) {
            this.isCollapsed = false;
            this.updateChevron();
            this.updateContentVisibility();
        }
        return this;
    }

    /**
     * Collapse the section
     */
    collapse(): this {
        if (!this.isCollapsed) {
            this.isCollapsed = true;
            this.updateChevron();
            this.updateContentVisibility();
        }
        return this;
    }

    /**
     * Check if the section is collapsed
     */
    get collapsed(): boolean {
        return this.isCollapsed;
    }

    /**
     * Get the container element for CSS targeting
     */
    get element(): HTMLElement {
        return this.containerEl;
    }

    /**
     * Get the header element for CSS targeting
     */
    get header(): HTMLElement {
        return this.headerEl;
    }

    /**
     * Get the content element for CSS targeting
     */
    get content(): HTMLElement {
        return this.contentEl;
    }

    // --- SettingGroup delegation methods ---

    /**
     * Set a subheading within the group (delegates to SettingGroup.setHeading)
     */
    setSubheading(text: string | DocumentFragment): this {
        this.group.setHeading(text);
        return this;
    }

    /**
     * Add a CSS class to the internal SettingGroup
     */
    addClass(cls: string): this {
        this.group.addClass(cls);
        return this;
    }

    /**
     * Add a setting to the group
     */
    addSetting(cb: (setting: Setting) => void): this {
        this.group.addSetting(cb);
        return this;
    }

    /**
     * Add a search input at the beginning of the group
     */
    addSearch(cb: (component: SearchComponent) => void): this {
        this.group.addSearch(cb);
        return this;
    }

    /**
     * Add an extra button to the group header
     */
    addExtraButton(cb: (component: ExtraButtonComponent) => void): this {
        this.group.addExtraButton(cb);
        return this;
    }

    /**
     * Create a subgroup heading within this group.
     * Use this instead of containerEl.createEl('h3', ...) for consistent styling.
     */
    addSubheading(text: string): this {
        new Setting(this.contentEl)
            .setName(text)
            .setHeading();
        return this;
    }
}
