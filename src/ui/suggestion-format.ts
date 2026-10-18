/**
 * Formatting helpers shared by every suggestion row (palette modes, semantic and
 * quick link modals). Pure functions so they stay easy to reuse and test.
 */

import { QUERY_OR, QUERY_TAG } from 'src/utils/constants';

export interface FileTitle {
    /** Basename shown as the row title */
    title: string;
    /** Extension shown as a native `.nav-file-tag` for non-Markdown files */
    fileTag?: string;
}

/** Minimal settings needed to format file rows */
export interface FileDisplaySettings {
    hideMdExtension: boolean;
    displayOnlyNotesNames: boolean;
}

/**
 * Split a vault path into folder, basename (without extension) and extension.
 */
export function splitPath(path: string): { folder: string; name: string; extension: string } {
    const slash = path.lastIndexOf('/');
    const folder = slash > 0 ? path.slice(0, slash) : '';
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) {
        return { folder, name: fileName, extension: '' };
    }
    return { folder, name: fileName.slice(0, dot), extension: fileName.slice(dot + 1) };
}

/**
 * Title for a file row: the basename, respecting `hideMdExtension` for Markdown
 * files. Other file types show their extension as a tag instead.
 */
export function formatFileTitle(path: string, settings: FileDisplaySettings): FileTitle {
    const { name, extension } = splitPath(path);
    if (!extension) {
        return { title: name };
    }
    if (extension.toLowerCase() === 'md') {
        return { title: settings.hideMdExtension ? name : `${name}.${extension}` };
    }
    return { title: name, fileTag: extension };
}

/**
 * Folder part of the note line. Empty for root files or when only note names are shown.
 */
export function formatFolder(path: string, settings: FileDisplaySettings): string {
    if (settings.displayOnlyNotesNames) {
        return '';
    }
    return splitPath(path).folder;
}

/**
 * Full path without the Markdown extension when `hideMdExtension` is on (alias targets).
 */
export function formatPath(path: string, settings: FileDisplaySettings): string {
    if (settings.hideMdExtension && path.toLowerCase().endsWith('.md')) {
        return path.slice(0, -3);
    }
    return path;
}

/**
 * Tags as plain `#tag` text separated by spaces (no pills).
 */
export function formatTags(tags: readonly string[] | undefined): string {
    if (!tags || tags.length === 0) {
        return '';
    }
    const unique = new Set<string>();
    tags.forEach((tag) => {
        const trimmed = tag?.trim();
        if (trimmed) {
            unique.add(trimmed.startsWith('#') ? trimmed : `#${trimmed}`);
        }
    });
    return Array.from(unique).join(' ');
}

/** Date in the note line, e.g. `Dec 28, 2025`. */
export function formatDate(timestamp: number | undefined): string {
    if (!timestamp || !Number.isFinite(timestamp)) {
        return '';
    }
    return window.moment(timestamp).format('MMM D, YYYY');
}

/** Relevance score (0-1) as `NN%`. */
export function formatScore(score: number | undefined): string {
    if (score === undefined || !Number.isFinite(score)) {
        return '';
    }
    const clamped = Math.max(0, Math.min(1, score));
    return `${Math.round(clamped * 100)}%`;
}

/** `N notes` for tag rows. */
export function formatNoteCount(count: number): string {
    const safe = Number.isFinite(count) ? count : 0;
    return `${safe} ${safe === 1 ? 'note' : 'notes'}`;
}

/**
 * Recent label as stored in settings, with one pair of surrounding parentheses
 * stripped so legacy values like `(recently used)` render as plain aux text.
 */
export function formatRecentLabel(text: string | undefined): string {
    const trimmed = (text ?? '').trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

/** Leading Markdown list, quote and heading markers ("- ", "1. ", "> ", "## "). */
const LEADING_MARKDOWN_MARKER = /^(?:[-*+\u2022]|\d+[.)]|>|#{1,6})\s+/;

/** Inline Markdown that reads as noise in a one-line excerpt. */
const MARKDOWN_EMBED = /!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_WIKILINK = /\[\[([^\]|]*\|)?([^\]]*)\]\]/g;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MARKDOWN_EMPHASIS = /(\*\*|__|~~|==|`)/g;
const MARKDOWN_INLINE_HEADING = /(^|\s)#{1,6}\s+/g;

/** Plain text of an excerpt: embeds dropped, links reduced to their text, emphasis removed. */
export function stripInlineMarkdown(text: string): string {
    return text
        .replace(MARKDOWN_EMBED, ' ')
        .replace(MARKDOWN_WIKILINK, '$2')
        .replace(MARKDOWN_LINK, '$1')
        .replace(MARKDOWN_EMPHASIS, '')
        .replace(MARKDOWN_INLINE_HEADING, '$1');
}

/** Plain one-line excerpt: Markdown stripped, whitespace collapsed, no leading list marker. */
export function toSingleLine(text: string | undefined): string {
    return stripInlineMarkdown(text ?? '').replace(/\s+/g, ' ').trim().replace(LEADING_MARKDOWN_MARKER, '');
}

/** Words too common to be worth highlighting in natural-language queries. */
const HIGHLIGHT_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
    'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'why', 'with', 'you', 'your',
]);

/**
 * Plain search terms of a query for highlighting. Drops tag (`@`) and OR (`||`)
 * syntax, stopwords and very short terms that would highlight noise.
 */
export function getQueryTerms(query: string | undefined, minLength = 2): string[] {
    if (!query) {
        return [];
    }
    return query
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= minLength
            && !term.startsWith(QUERY_TAG)
            && term !== QUERY_OR
            && !HIGHLIGHT_STOPWORDS.has(term.toLowerCase()));
}

/**
 * Alias matches use the id `${alias}:${path}`. Paths cannot contain `:`, so the
 * target is everything after the last colon.
 */
export function getAliasTarget(id: string): string | null {
    const colon = id.lastIndexOf(':');
    if (colon < 0) {
        return null;
    }
    return id.slice(colon + 1) || null;
}
