/**
 * Row descriptions for file-like suggestions (files, aliases, unresolved links).
 * Shared by the file, hybrid, semantic and quick link views so they look identical.
 */

import { SuggestionNotePart, SuggestionRowOptions } from './suggestion-row';
import {
    FileDisplaySettings, formatFileTitle, formatFolder, formatPath, formatTags,
} from './suggestion-format';

export interface FileRowInput {
    path: string;
    settings: FileDisplaySettings;
    /** Tags shown as plain `#tag` text after the folder */
    tags?: readonly string[];
    /** Terms highlighted in the title */
    highlights?: string[];
    /** Note parts after the folder; replaces the tags when given */
    details?: SuggestionNotePart[];
}

/** Title is the basename (plus extension tag), note is `folder · tags` or `folder · details`. */
export function buildFileRow(input: FileRowInput): SuggestionRowOptions {
    const { title, fileTag } = formatFileTitle(input.path, input.settings);
    const details = input.details ?? [formatTags(input.tags)];

    return {
        title,
        fileTag,
        highlights: input.highlights,
        noteParts: [formatFolder(input.path, input.settings), ...details],
    };
}

/** Alias: forward icon + alias text, note is the target path. */
export function buildAliasRow(
    alias: string,
    targetPath: string,
    settings: FileDisplaySettings,
    highlights?: string[],
): SuggestionRowOptions {
    return {
        title: alias,
        titleIcon: 'forward',
        titleIconLabel: 'Alias',
        highlights,
        noteParts: [formatPath(targetPath, settings)],
    };
}

/** Unresolved link: muted title, note says it doesn't exist yet. */
export function buildUnresolvedRow(linkText: string, highlights?: string[]): SuggestionRowOptions {
    return {
        title: linkText,
        highlights,
        unresolved: true,
        noteParts: ['Not created yet'],
    };
}
