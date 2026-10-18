/**
 * Shared suggestion row renderer.
 *
 * Every palette mode and modal renders its rows through `renderSuggestionRow` so
 * they all produce Obsidian's native markup and let the active theme style them:
 *
 *   .suggestion-item.mod-complex
 *     .suggestion-content
 *       .suggestion-title  [.bcp-row-icon] [.bcp-prefix] title [.nav-file-tag]
 *       .suggestion-note   part · part · part        (optional, one line)
 *     .suggestion-aux      [.bcp-aux-text] [kbd.suggestion-hotkey…] [pin] [flair]
 */

import { setIcon } from 'obsidian';

/** A piece of text with optional substring highlights. */
export interface HighlightedText {
    text: string;
    /** Case-insensitive terms rendered as `.suggestion-highlight` */
    highlights?: string[];
}

export type SuggestionNotePart = string | HighlightedText;

/** Action icon at the end of the aux area, shown on hover/selection only. */
export interface SuggestionRowFlair {
    /** Lucide icon id */
    icon: string;
    /** Accessible label and tooltip */
    label: string;
    /**
     * `flair` renders a native `.suggestion-flair` (hide/unhide);
     * `menu` renders a `.clickable-icon` (actions menu).
     */
    kind?: 'flair' | 'menu';
    onClick: (event: MouseEvent) => void;
}

export interface SuggestionRowOptions {
    /** Main title text */
    title: string;
    /** Muted text before the title, e.g. the command's plugin name ("Editor: ") */
    titlePrefix?: string;
    /** Lucide icon before the title (e.g. `forward` for aliases) */
    titleIcon?: string;
    /** Label for the title icon */
    titleIconLabel?: string;
    /** Extension tag for non-Markdown files */
    fileTag?: string;
    /** Terms highlighted in the title */
    highlights?: string[];
    /** Note line parts, joined with a separator dot; empty parts are skipped */
    noteParts?: SuggestionNotePart[];
    /** Faint text at the right: recent label, score, tag count */
    auxText?: string;
    /** Hotkey labels rendered as native `kbd.suggestion-hotkey` */
    hotkeys?: string[];
    /** Show the pin icon */
    pinned?: boolean;
    /** Hover/selection-only action; null renders none */
    flair?: SuggestionRowFlair | null;
    /** Dim the row (hidden item shown via the hidden toggle) */
    hidden?: boolean;
    /** Mute the title (unresolved link) */
    unresolved?: boolean;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Append text to `parent`, wrapping case-insensitive occurrences of `terms` that
 * start a word in native `.suggestion-highlight` spans ("in" marks "inbox", not
 * "thinking").
 */
export function appendHighlightedText(parent: HTMLElement, text: string, terms?: string[]): void {
    const usable = (terms ?? []).filter((term) => term && term.length > 0);
    if (!text || usable.length === 0) {
        parent.appendText(text ?? '');
        return;
    }

    // Longest terms first so overlapping terms prefer the longer match
    const pattern = usable
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp)
        .join('|');
    const regex = new RegExp(`(?<![\\p{L}\\p{N}])(${pattern})`, 'giu');
    const lowered = new Set(usable.map((term) => term.toLowerCase()));

    text.split(regex).forEach((part) => {
        if (!part) {
            return;
        }
        if (lowered.has(part.toLowerCase())) {
            parent.createSpan({ cls: 'suggestion-highlight', text: part });
        } else {
            parent.appendText(part);
        }
    });
}

function toHighlightedText(part: SuggestionNotePart): HighlightedText {
    return typeof part === 'string' ? { text: part } : part;
}

function renderTitle(content: HTMLElement, options: SuggestionRowOptions): void {
    const titleEl = content.createDiv({ cls: 'suggestion-title' });

    if (options.titleIcon) {
        const iconEl = titleEl.createSpan({ cls: 'bcp-row-icon' });
        setIcon(iconEl, options.titleIcon);
        if (options.titleIconLabel) {
            iconEl.setAttr('aria-label', options.titleIconLabel);
        }
    }

    const textEl = titleEl.createSpan({ cls: 'bcp-title-text' });
    if (options.titlePrefix) {
        textEl.createSpan({ cls: 'bcp-prefix', text: options.titlePrefix });
    }
    appendHighlightedText(textEl, options.title, options.highlights);

    if (options.fileTag) {
        titleEl.createSpan({ cls: 'nav-file-tag', text: options.fileTag });
    }
}

function renderNote(content: HTMLElement, parts: SuggestionNotePart[] | undefined): void {
    const visible = (parts ?? [])
        .map(toHighlightedText)
        .filter((part) => part.text && part.text.trim().length > 0);
    if (visible.length === 0) {
        return;
    }

    const noteEl = content.createDiv({ cls: 'suggestion-note' });
    visible.forEach((part, index) => {
        if (index > 0) {
            noteEl.createSpan({ cls: 'bcp-sep', text: '·' });
        }
        appendHighlightedText(noteEl, part.text, part.highlights);
    });
}

function renderFlair(aux: HTMLElement, flair: SuggestionRowFlair): void {
    const cls = flair.kind === 'menu'
        ? 'clickable-icon bcp-reveal'
        : 'suggestion-flair bcp-reveal';
    const flairEl = aux.createDiv({ cls });
    setIcon(flairEl, flair.icon);
    flairEl.setAttr('aria-label', flair.label);

    flairEl.addEventListener('click', (event: MouseEvent) => {
        // Keep the click from choosing the row
        event.preventDefault();
        event.stopPropagation();
        flair.onClick(event);
    });
}

function renderAux(el: HTMLElement, options: SuggestionRowOptions): void {
    const aux = el.createDiv({ cls: 'suggestion-aux' });

    if (options.auxText) {
        aux.createSpan({ cls: 'bcp-aux-text', text: options.auxText });
    }

    (options.hotkeys ?? []).forEach((hotkey) => {
        aux.createEl('kbd', { cls: 'suggestion-hotkey', text: hotkey });
    });

    if (options.pinned) {
        const pinEl = aux.createSpan({ cls: 'bcp-row-icon' });
        setIcon(pinEl, 'pin');
        pinEl.setAttr('aria-label', 'Pinned');
    }

    if (options.flair) {
        renderFlair(aux, options.flair);
    }
}

/**
 * Render one suggestion into the `.suggestion-item` element Obsidian created.
 */
export function renderSuggestionRow(el: HTMLElement, options: SuggestionRowOptions): void {
    el.addClass('mod-complex');
    el.toggleClass('bcp-is-hidden', !!options.hidden);
    el.toggleClass('bcp-is-unresolved', !!options.unresolved);

    const content = el.createDiv({ cls: 'suggestion-content' });
    renderTitle(content, options);
    renderNote(content, options.noteParts);
    renderAux(el, options);
}
