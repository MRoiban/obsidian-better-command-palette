import { App, SuggestModal, Command } from 'obsidian';

export class HelperModal extends SuggestModal<Command> {
    private onChoose: (command: Command) => void;

    constructor(app: App, onChoose: (command: Command) => void) {
        super(app);
        this.onChoose = onChoose;
    }

    getSuggestions(query: string): Command[] {
        const commands = (this.app as any).commands.listCommands();
        return commands.filter((cmd: Command) =>
            cmd.name.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(command: Command, el: HTMLElement) {
        el.createEl('div', { text: command.name });
    }

    onChooseSuggestion(command: Command, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(command);
    }
}
