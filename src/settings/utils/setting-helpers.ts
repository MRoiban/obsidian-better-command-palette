import { Setting } from 'obsidian';

/** Small DOM helpers shared by the settings modules. */

/** Build a DocumentFragment for multi-line setting descriptions. */
export function describe(build: (fragment: DocumentFragment) => void): DocumentFragment {
    const fragment = document.createDocumentFragment();
    build(fragment);
    return fragment;
}

/** Muted, tabular-nums status text (index progress, test results) for a setting description. */
export function createStatus(parent: HTMLElement | DocumentFragment, text = ''): HTMLSpanElement {
    return parent.createSpan({ cls: 'bcp-setting-status', text });
}

/** Warning text for a setting description, rendered with the theme's error colour. */
export function createWarning(parent: HTMLElement | DocumentFragment, text: string): HTMLSpanElement {
    return parent.createSpan({ cls: 'mod-warning', text });
}

export interface SliderRow {
    name: string;
    desc?: string | DocumentFragment;
    min: number;
    max: number;
    step: number;
    value: number;
    onChange: (value: number) => void;
}

/** Configure a setting row as a labelled slider with a dynamic tooltip. */
export function configureSlider(setting: Setting, row: SliderRow): Setting {
    setting.setName(row.name);
    if (row.desc) setting.setDesc(row.desc);
    return setting.addSlider((slider) => slider
        .setLimits(row.min, row.max, row.step)
        .setValue(row.value)
        .setDynamicTooltip()
        .onChange(row.onChange));
}
