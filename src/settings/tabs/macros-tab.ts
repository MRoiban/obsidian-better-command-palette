import { App, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { HelperModal } from '../utils/helper-modal';

type Macro = BetterCommandPalettePlugin['settings']['macros'][number];

/**
 * Macros group: one native row per macro (edit / delete extra buttons). Editing expands
 * the macro's rows inline in the same group, using native `Setting` rows.
 */
export class MacrosTab implements BaseSettingsTab {
    id = 'macros';
    title = 'Macros';

    /** Macro currently expanded for editing. */
    private editing: Macro | null = null;

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        this.editing = null;
        // Own a root element so re-renders replace the tab content instead of appending to it
        this.render(containerEl.createDiv({ cls: 'bcp-settings-section' }), app, plugin);
    }

    private render(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        containerEl.empty();
        const { settings } = plugin;
        const refresh = () => this.render(containerEl, app, plugin);

        const group = new SettingGroup(containerEl)
            .setHeading('Macros')
            .addExtraButton((button) => button
                .setIcon('plus')
                .setTooltip('Add macro')
                .onClick(async () => {
                    this.editing = await this.createNewMacro(plugin);
                    refresh();
                }));

        if (settings.macros.length === 0) {
            group.addSetting((setting) => setting
                .setName('No macros yet')
                .setDesc('Macros chain several commands together. Use the + button to add one.'));
            return;
        }

        settings.macros.forEach((macro) => {
            group.addSetting((setting) => setting
                .setName(macro.name)
                .setDesc(this.describeMacro(macro))
                .addExtraButton((button) => button
                    .setIcon('pencil')
                    .setTooltip(this.editing === macro ? 'Done editing' : 'Edit')
                    .onClick(() => {
                        this.editing = this.editing === macro ? null : macro;
                        refresh();
                    }))
                .addExtraButton((button) => button
                    .setIcon('trash')
                    .setTooltip('Delete')
                    .onClick(async () => {
                        const index = settings.macros.indexOf(macro);
                        if (index === -1) return;
                        settings.macros.splice(index, 1);
                        if (this.editing === macro) this.editing = null;
                        await plugin.saveSettings();
                        refresh();
                    })));

            if (this.editing === macro) {
                this.renderMacroEditor(group, macro, app, plugin, refresh);
            }
        });
    }

    private describeMacro(macro: Macro): string {
        const count = macro.commandIds.length;
        const commands = `${count} ${count === 1 ? 'command' : 'commands'}`;
        return macro.delay > 0 ? `${commands}, ${macro.delay} ms delay` : `${commands}, no delay`;
    }

    private renderMacroEditor(
        group: SettingGroup,
        macro: Macro,
        app: App,
        plugin: BetterCommandPalettePlugin,
        refresh: () => void,
    ): void {
        group
            .addSetting((setting) => setting
                .setName('Macro name')
                .addText((text) => text
                    .setValue(macro.name)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            macro.name = value;
                            await plugin.saveSettings();
                        }
                    })))
            .addSetting((setting) => setting
                .setName('Delay between commands (ms)')
                .addSlider((slider) => slider
                    .setLimits(0, 1000, 50)
                    .setValue(macro.delay)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        macro.delay = value;
                        await plugin.saveSettings();
                    })));

        macro.commandIds.forEach((commandId, commandIndex) => {
            const command = (app as any).commands.findCommand(commandId);
            group.addSetting((setting) => setting
                .setName(`${commandIndex + 1}. ${command?.name || 'Unknown command'}`)
                .addExtraButton((button) => button
                    .setIcon('trash')
                    .setTooltip('Remove command')
                    .onClick(async () => {
                        macro.commandIds.splice(commandIndex, 1);
                        await plugin.saveSettings();
                        refresh();
                    })));
        });

        group.addSetting((setting) => setting
            .setName('Add command')
            .addButton((button) => button
                .setButtonText('Add command')
                .onClick(() => {
                    // Using a helper modal to select commands
                    const modal = new HelperModal(app, async (command) => {
                        macro.commandIds.push(command.id);
                        await plugin.saveSettings();
                        refresh();
                    });
                    modal.open();
                })));
    }

    private async createNewMacro(plugin: BetterCommandPalettePlugin): Promise<Macro> {
        const macro: Macro = {
            id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: `Macro ${plugin.settings.macros.length + 1}`,
            commandIds: [],
            delay: 100,
        };
        plugin.settings.macros.push(macro);
        await plugin.saveSettings();
        return macro;
    }
}
