import {
    PluginSettingTab, Plugin, Command, Hotkey, MetadataCache, App, SuggestModal,
} from 'obsidian';
import { OrderedSet } from 'src/utils';

interface MacroCommandInterface {
    /** Stable id used to build the command id; survives reordering and deletion */
    id?: string,
    commandIds: string[],
    name: string,
    delay: number,
}

export interface BetterCommandPaletteInterface extends Plugin {
    settings: PluginSettingTab;

    prevCommands: OrderedSet<Match>;

    prevFiles: OrderedSet<Match>;

    prevTags: OrderedSet<Match>;

    suggestionsWorker: Worker;
}

export interface Comparable {
    value: () => string;
}

export interface Match extends Comparable {
    text: string,
    id: string,
    tags: string[],
}

export type WorkerMode = 'commands' | 'files' | 'tags';

export type SuggestionsWorkerRegisterMessage = {
    type: 'register',
    mode: WorkerMode,
    items: Match[],
};

export type SuggestionsWorkerQueryMessage = {
    type: 'query',
    mode: WorkerMode,
    query: string,
    requestId: number,
    limit?: number,
};

export type SuggestionsWorkerResultMessage = {
    type: 'result',
    mode: WorkerMode,
    requestId: number,
    items: Match[],
};

// Unsafe Interfaces
// Ideally we would not have to use these, but as far as I can tell
// they are the only way for certain functionality.
// Copied this pattern from Another Quick Switcher: https://github.com/tadashi-aikawa/obsidian-another-quick-switcher/blob/master/src/ui/AnotherQuickSwitcherModal.ts#L109

export interface UnsafeSuggestModalInterface extends SuggestModal<Match> {
    chooser: {
        useSelectedItem(ev: Partial<KeyboardEvent>): void;
        values?: Match[] | null;
        selectedItem?: number;
        setSelectedItem?(index: number, scroll?: boolean): void;
    }
    updateSuggestions(): void;
}

interface UnsafeMetadataCacheInterface extends MetadataCache {
    getCachedFiles(): string[],
    getTags(): Record<string, number>;
}

export interface UnsafeAppInterface extends App {
    commands: {
        listCommands(): Command[],
        findCommand(id: string): Command | undefined,
        removeCommand(id: string): void,
        executeCommandById(id: string): boolean,
        commands: Record<string, Command>,
    },
    hotkeyManager: {
        getHotkeys(id: string): Hotkey[],
        getDefaultHotkeys(id: string): Hotkey[],
    },
    metadataCache: UnsafeMetadataCacheInterface,
    internalPlugins: {
        getPluginById(id: string): { instance: { options: { pinned: [] } } },
    }
}

type HotkeyStyleType = 'auto' | 'mac' | 'windows';
