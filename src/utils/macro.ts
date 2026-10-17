import {
    App, Command, Notice,
} from 'obsidian';
import { MacroCommandInterface, UnsafeAppInterface } from 'src/types/types';
import { logger } from './logger';

export default class MacroCommand implements Command, MacroCommandInterface {
    app: UnsafeAppInterface;

    id: string;

    name: string;

    commandIds: string[];

    delay: number;

    constructor(
        app: App,
        id: string,
        name: string,
        commandIds: string[] = [],
        delay: number = 200,
    ) {
        this.app = app as UnsafeAppInterface;
        this.id = id;
        this.name = name;
        this.commandIds = commandIds;
        this.delay = delay;
    }

    addCommand(commandId: string) {
        this.commandIds.push(commandId);
    }

    removeCommand(commandId: string) {
        this.commandIds = this.commandIds.filter((c) => c !== commandId);
    }

    commandIsAvailable(id: string): boolean {
        const command = this.app.commands.findCommand(id);

        // The command may belong to a plugin that has since been disabled or removed
        if (!command) {
            return false;
        }

        return !command.checkCallback || !!command.checkCallback(true);
    }

    async callAllCommands(): Promise<boolean> {
        const notice = new Notice(`Running "${this.name}"...`, 10000);

        for (let i = 0; i < this.commandIds.length; i += 1) {
            const commandId = this.commandIds[i];
            const command = this.app.commands.findCommand(commandId);

            if (!command) {
                notice.setMessage(`Error: command "${commandId}" no longer exists. The macro is stopping.`);
                return false;
            }

            if (!this.commandIsAvailable(commandId)) {
                notice.setMessage(`Error: "${command.name}" cannot be used in this context. The macro is stopping.`);
                return false;
            }

            notice.setMessage(`Running "${command.name}"`);

            try {
                // At runtime Obsidian returns false when the command could not run;
                // the typings declare void, so widen before checking
                // eslint-disable-next-line no-await-in-loop
                const executed: unknown = await (
                    this.app.commands.executeCommandById(commandId) as unknown
                );
                if (executed === false) {
                    notice.setMessage(`Error: "${command.name}" could not be run. The macro is stopping.`);
                    return false;
                }
            } catch (error) {
                logger.error(`Macro "${this.name}" failed on command "${commandId}":`, error);
                notice.setMessage(`Error: "${command.name}" failed. The macro is stopping.`);
                return false;
            }

            // Give our commands some time to complete
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, this.delay);
            });
        }

        notice.hide();
        // eslint-disable-next-line no-new
        new Notice(`Successfully ran "${this.name}"`);

        return true;
    }

    checkCallback(checking: boolean): boolean | void {
        if (checking) {
            // Commands later in the macro may depend on earlier ones having run (e.g. one
            // opens an editor the next needs), so only the first command can be checked
            // reliably up front. Every command must at least still exist.
            return this.commandIds.length > 0
                && this.commandIds.every((id) => !!this.app.commands.findCommand(id))
                && this.commandIsAvailable(this.commandIds[0]);
        }

        this.callAllCommands().catch((error) => {
            logger.error(`Macro "${this.name}" failed:`, error);
        });
        return true;
    }
}
