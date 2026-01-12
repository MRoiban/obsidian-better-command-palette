import { App, Setting, setIcon } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import { BaseSettingsTab } from './base-tab';
import { HelperModal } from '../utils/helper-modal';

export class MacrosTab implements BaseSettingsTab {
    id = 'macros';
    title = 'Macros';
    icon = 'terminal-square';

    display(containerEl: HTMLElement, app: App, plugin: BetterCommandPalettePlugin): void {
        const { settings } = plugin;

        if (settings.macros.length === 0) {
            const emptyEl = containerEl.createEl('div', { cls: 'settings-empty' });
            emptyEl.createEl('p', {
                text: 'No macros created yet. Macros allow you to chain multiple commands together.',
            });
        }

        new Setting(containerEl)
            .setName('Create New Macro')
            .setDesc('Add a new command sequence macro')
            .addButton((button) => button
                .setButtonText('+ Add Macro')
                .setCta()
                .onClick(async () => {
                    await this.createNewMacro(plugin, () => this.display(containerEl, app, plugin));
                }));

        settings.macros.forEach((macro, index) => {
            const macroContainer = containerEl.createEl('div', { cls: 'macro-container' });

            new Setting(macroContainer)
                .setName(`${macro.name}`)
                .setDesc(`${macro.commandIds.length} commands • ${macro.delay}ms delay`)
                .addButton((button) => button
                    .setButtonText('Delete')
                    .setWarning()
                    .onClick(async () => {
                        settings.macros.splice(index, 1);
                        await plugin.saveSettings();
                        this.display(containerEl, app, plugin);
                    }));

            // Details
            const detailsEl = macroContainer.createEl('div', { cls: 'macro-details' });

            new Setting(detailsEl)
                .setName('Macro Name')
                .addText((text) => text
                    .setValue(macro.name)
                    .onChange(async (value) => {
                        if (value.trim()) {
                            settings.macros[index].name = value;
                            await plugin.saveSettings();
                        }
                    }));

            new Setting(detailsEl)
                .setName('Delay Between Commands (ms)')
                .addSlider((slider) => slider
                    .setLimits(0, 1000, 50)
                    .setValue(macro.delay)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        settings.macros[index].delay = value;
                        await plugin.saveSettings();
                    }));

            // Command List
            if (macro.commandIds.length > 0) {
                const commandsEl = detailsEl.createEl('div', { cls: 'macro-commands' });
                commandsEl.createEl('h4', { text: 'Commands:', cls: 'macro-commands-title' });

                macro.commandIds.forEach((commandId, commandIndex) => {
                    const command = (app as any).commands.findCommand(commandId);
                    const commandEl = commandsEl.createEl('div', { cls: 'macro-command-item' });

                    commandEl.createEl('span', {
                        text: `${commandIndex + 1}. ${command?.name || 'Unknown Command'}`,
                        cls: 'macro-command-name',
                    });

                    const removeBtn = commandEl.createEl('button', {
                        cls: 'macro-command-remove',
                    });
                    setIcon(removeBtn, 'trash');
                    removeBtn.addEventListener('click', async () => {
                        settings.macros[index].commandIds.splice(commandIndex, 1);
                        await plugin.saveSettings();
                        this.display(containerEl, app, plugin);
                    });
                });
            }

            new Setting(detailsEl)
                .setName('Add Command')
                .addButton((button) => button
                    .setButtonText('+ Add Command')
                    .onClick(async () => {
                        // Using a helper modal to select commands
                        const modal = new HelperModal(app, async (command: any) => {
                            settings.macros[index].commandIds.push(command.id);
                            await plugin.saveSettings();
                            this.display(containerEl, app, plugin);
                        });
                        modal.open();
                    }));
        });
    }

    private async createNewMacro(plugin: BetterCommandPalettePlugin, refresh: () => void): Promise<void> {
        plugin.settings.macros.push({
            name: `Macro ${plugin.settings.macros.length + 1}`,
            commandIds: [],
            delay: 100,
        });
        await plugin.saveSettings();
        refresh();
    }
}
