/**
 * Small pieces of prompt chrome shared by the palette and the plugin's other
 * SuggestModals: the faint mode label inside the input row, the status line at the
 * top of the results and the hidden-items toggle at the bottom of the results.
 *
 * Obsidian empties `.prompt-results` on every render, so the status line and the
 * toggle are re-attached after each `updateSuggestions` call (see installRenderHook).
 */

export interface PromptStatusAction {
    label: string;
    onClick: () => void;
}

export interface PromptStatus {
    text: string;
    /** Render with `.mod-error` (uses --text-error) */
    isError?: boolean;
    action?: PromptStatusAction;
}

/** The parts of a SuggestModal the chrome needs. */
export interface PromptElements {
    inputEl: HTMLInputElement;
    resultContainerEl: HTMLElement;
}

interface RenderableModal {
    updateSuggestions: () => void;
}

/**
 * Run `afterRender` after every `updateSuggestions` call of a SuggestModal.
 * `updateSuggestions` exists at runtime but is not part of the public typings.
 */
export function installRenderHook(modal: object, afterRender: () => void): void {
    const target = modal as RenderableModal;
    const base = target.updateSuggestions;
    if (typeof base !== 'function') {
        return;
    }
    target.updateSuggestions = function updateSuggestionsWithChrome(this: RenderableModal) {
        base.call(this);
        afterRender();
    };
}

export class PromptChrome {
    private readonly elements: PromptElements;

    private readonly modeLabelEl: HTMLElement;

    private readonly statusEl: HTMLElement;

    private readonly hiddenToggleEl: HTMLElement;

    private status: PromptStatus | null = null;

    private hiddenToggleText = '';

    constructor(elements: PromptElements, onHiddenToggle?: () => void) {
        this.elements = elements;

        // Mode label sits in the input row, after the input and before the clear button
        this.modeLabelEl = createSpan({ cls: 'bcp-mode-label' });
        elements.inputEl.insertAdjacentElement('afterend', this.modeLabelEl);

        this.statusEl = createDiv({ cls: 'bcp-status' });

        this.hiddenToggleEl = createDiv({ cls: 'bcp-hidden-toggle' });
        if (onHiddenToggle) {
            this.hiddenToggleEl.addEventListener('click', (event) => {
                event.preventDefault();
                onHiddenToggle();
            });
        }
    }

    setModeLabel(text: string): void {
        this.modeLabelEl.setText(text);
        this.modeLabelEl.toggle(text.length > 0);
    }

    /** Update the status line. Pass null to remove it. */
    setStatus(status: PromptStatus | null): void {
        this.status = status && status.text ? status : null;
        this.statusEl.empty();
        this.statusEl.removeClass('mod-error');

        if (this.status) {
            this.statusEl.toggleClass('mod-error', !!this.status.isError);
            this.statusEl.createSpan({ text: this.status.text });
            const { action } = this.status;
            if (action) {
                const actionEl = this.statusEl.createSpan({ cls: 'bcp-status-action', text: action.label });
                actionEl.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    action.onClick();
                });
            }
        }

        this.attach();
    }

    /** Text of the hidden-items toggle; empty hides it. */
    setHiddenToggleText(text: string): void {
        this.hiddenToggleText = text;
        this.hiddenToggleEl.setText(text);
        this.attach();
    }

    /** Re-insert the status line and toggle after Obsidian re-rendered the results. */
    attach(): void {
        const container = this.elements.resultContainerEl;

        if (this.status) {
            if (container.firstChild !== this.statusEl) {
                container.prepend(this.statusEl);
            }
        } else {
            this.statusEl.detach();
        }

        if (this.hiddenToggleText) {
            if (container.lastChild !== this.hiddenToggleEl) {
                container.append(this.hiddenToggleEl);
            }
        } else {
            this.hiddenToggleEl.detach();
        }
    }
}
