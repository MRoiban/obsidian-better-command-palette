/**
 * "Embedding provider" part of the Semantic settings tab: provider choice,
 * local (in-plugin) model/device/precision, or Ollama connection settings.
 *
 * Changes are saved through plugin.saveSettings(), which pushes them to the running
 * EmbeddingService / SemanticIndexingCoordinator (provider swap, reindex when the
 * embedding fingerprint changes) without a restart.
 */

import { Notice, Setting } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import {
    CUSTOM_LOCAL_MODEL_ID, DEFAULT_LOCAL_MODEL_ID, LOCAL_DTYPE_LABELS, LOCAL_MODELS, LocalDeviceSetting, LocalDtype,
    LocalDtypeSetting, LocalModelDefinition, describeLocalModel, getLocalModelDefinition, isValidHfModelId,
    resolveLocalDtype, resolveLocalModel,
} from 'src/search/semantic/providers/model-registry';
import type { EmbeddingProviderId } from 'src/search/semantic/providers/types';
import { DEFAULT_EMBEDDING_MODEL } from 'src/search/semantic/embedding-fingerprint';
import { SemanticSearchSettings } from 'src/search/semantic/types';

const PROVIDER_LABELS: Record<EmbeddingProviderId, string> = {
    local: 'Local (in Obsidian)',
    ollama: 'Ollama',
};

const DEVICE_LABELS: Record<LocalDeviceSetting, string> = {
    auto: 'Auto (WebGPU when available)',
    webgpu: 'WebGPU',
    wasm: 'CPU (WASM)',
};

const HF_ID_HINT = 'Expected "owner/model", e.g. Xenova/bge-base-en-v1.5. The repository needs ONNX weights in an "onnx/" folder.';

function describe(build: (fragment: DocumentFragment) => void): DocumentFragment {
    const fragment = document.createDocumentFragment();
    build(fragment);
    return fragment;
}

export class EmbeddingProviderSection {
    /**
     * "Custom" picked in the model dropdown but no valid Hub id entered yet. Kept in the
     * UI only, so the saved model (and the index built from it) stays untouched meanwhile.
     */
    private pendingCustomModel = false;

    constructor(
        private readonly plugin: BetterCommandPalettePlugin,
        private readonly rerender: () => void,
    ) {}

    private get settings(): SemanticSearchSettings {
        return this.plugin.settings.semanticSearch;
    }

    /** Persist and apply immediately, then redraw dependent options. */
    private async saveAndRerender(): Promise<void> {
        await this.plugin.saveSettings();
        this.rerender();
    }

    render(containerEl: HTMLElement): void {
        const provider: EmbeddingProviderId = this.settings.embeddingProvider === 'ollama' ? 'ollama' : 'local';

        new Setting(containerEl).setName('Embeddings').setHeading();

        new Setting(containerEl)
            .setName('Embedding provider')
            .setDesc(provider === 'local'
                ? 'Runs the embedding model inside Obsidian. The model is downloaded once from Hugging Face and cached; no external server needed.'
                : 'Uses an Ollama server running alongside Obsidian.')
            .addDropdown((dropdown) => {
                (Object.keys(PROVIDER_LABELS) as EmbeddingProviderId[]).forEach((id) => {
                    dropdown.addOption(id, PROVIDER_LABELS[id]);
                });
                dropdown
                    .setValue(provider)
                    .onChange(async (value) => {
                        this.settings.embeddingProvider = value === 'ollama' ? 'ollama' : 'local';
                        this.pendingCustomModel = false;
                        await this.saveAndRerender();
                    });
            });

        if (provider === 'local') {
            this.renderLocal(containerEl);
        } else {
            this.renderOllama(containerEl);
        }
    }

    // --- Local provider ---

    private renderLocal(containerEl: HTMLElement): void {
        const { settings } = this;
        const device: LocalDeviceSetting = settings.localDevice ?? 'auto';
        const model = resolveLocalModel(settings);
        const dtype = resolveLocalDtype(model, settings.localDtype, device);
        const showCustom = this.pendingCustomModel || settings.localModel === CUSTOM_LOCAL_MODEL_ID;
        const savedCustomInvalid = settings.localModel === CUSTOM_LOCAL_MODEL_ID
            && !isValidHfModelId(settings.localCustomModelId);

        let selectedModel: string;
        if (showCustom) {
            selectedModel = CUSTOM_LOCAL_MODEL_ID;
        } else {
            selectedModel = getLocalModelDefinition(settings.localModel)?.id ?? DEFAULT_LOCAL_MODEL_ID;
        }

        new Setting(containerEl)
            .setName('Model')
            .setDesc(describe((fragment) => {
                if (this.pendingCustomModel || savedCustomInvalid) {
                    fragment.createDiv({
                        text: `Enter a Hugging Face model id below. Until then ${model.label} stays in use.`,
                    });
                } else {
                    fragment.createDiv({ text: model.description });
                    fragment.createDiv({ text: describeLocalModel(model, dtype) });
                }
                fragment.createDiv({ text: 'Changing the model rebuilds the semantic index.' });
            }))
            .addDropdown((dropdown) => {
                LOCAL_MODELS.forEach((definition) => dropdown.addOption(definition.id, definition.label));
                dropdown.addOption(CUSTOM_LOCAL_MODEL_ID, 'Custom Hugging Face model');
                dropdown
                    .setValue(selectedModel)
                    .onChange(async (value) => this.selectLocalModel(value));
            });

        if (showCustom) {
            this.renderCustomModelId(containerEl, savedCustomInvalid);
        }

        this.renderDevice(containerEl, model, device);
        this.renderPrecision(containerEl, model, device, dtype);

        this.renderPrepareButton(containerEl, 'Download & test model', 'Download (first use only) and load the selected model now, instead of on the first search');
    }

    private async selectLocalModel(value: string): Promise<void> {
        const { settings } = this;

        if (value === CUSTOM_LOCAL_MODEL_ID) {
            if (isValidHfModelId(settings.localCustomModelId)) {
                // Re-select the previously entered custom model
                this.pendingCustomModel = false;
                settings.localModel = CUSTOM_LOCAL_MODEL_ID;
                await this.saveAndRerender();
            } else {
                this.pendingCustomModel = true;
                this.rerender();
            }
            return;
        }

        this.pendingCustomModel = false;
        settings.localModel = value;
        this.dropUnsupportedDtype(resolveLocalModel(settings));
        await this.saveAndRerender();
    }

    private renderCustomModelId(containerEl: HTMLElement, savedInvalid: boolean): void {
        const { settings } = this;
        let warningEl: HTMLElement | undefined;

        const setting = new Setting(containerEl)
            .setName('Hugging Face model id')
            .setDesc(describe((fragment) => {
                fragment.createDiv({ text: HF_ID_HINT });
                fragment.createDiv({ text: 'Applied when you press Enter or leave the field.' });
                warningEl = fragment.createDiv({ cls: 'mod-warning' });
            }));

        const showWarning = (value: string) => {
            if (!warningEl) return;
            const trimmed = value.trim();
            if (trimmed && !isValidHfModelId(trimmed)) {
                warningEl.setText(`"${trimmed}" is not a valid Hugging Face model id.`);
            } else if (!trimmed && savedInvalid) {
                warningEl.setText('No custom model id set.');
            } else {
                warningEl.setText('');
            }
        };

        setting.addText((text) => {
            text
                .setPlaceholder('owner/model-name')
                .setValue(settings.localCustomModelId ?? '')
                .onChange((value) => showWarning(value));

            // Commit on Enter/blur only: every keystroke would otherwise swap the model
            // (and schedule a reindex) for half-typed ids.
            text.inputEl.addEventListener('change', () => {
                void this.commitCustomModelId(text.inputEl.value);
            });
            showWarning(text.inputEl.value);
        });
    }

    private async commitCustomModelId(raw: string): Promise<void> {
        const { settings } = this;
        const value = raw.trim();
        if (!value) {
            return;
        }
        if (!isValidHfModelId(value)) {
            new Notice(`Semantic search: "${value}" is not a valid Hugging Face model id. ${HF_ID_HINT}`, 6000);
            return;
        }
        if (value === settings.localCustomModelId && settings.localModel === CUSTOM_LOCAL_MODEL_ID) {
            return;
        }

        settings.localCustomModelId = value;
        settings.localModel = CUSTOM_LOCAL_MODEL_ID;
        this.pendingCustomModel = false;
        this.dropUnsupportedDtype(resolveLocalModel(settings));
        await this.saveAndRerender();
    }

    private renderDevice(containerEl: HTMLElement, model: LocalModelDefinition, device: LocalDeviceSetting): void {
        const { settings } = this;
        // With precision on Auto, CPU and GPU may resolve to different precisions (= different index)
        const autoDtypeDiffers = (settings.localDtype ?? 'auto') === 'auto'
            && model.defaultDtype !== model.wasmDefaultDtype;

        new Setting(containerEl)
            .setName('Device')
            .setDesc(describe((fragment) => {
                fragment.createDiv({ text: 'Where the model runs. Auto uses the GPU (WebGPU) when available and falls back to the CPU.' });
                fragment.createDiv({
                    text: autoDtypeDiffers
                        ? `Changing the device restarts the model. With precision on Auto, CPU uses ${model.wasmDefaultDtype} and Auto/WebGPU use ${model.defaultDtype}, so switching between CPU and the others rebuilds the index.`
                        : 'Changing the device restarts the model but keeps the semantic index.',
                });
            }))
            .addDropdown((dropdown) => {
                (Object.keys(DEVICE_LABELS) as LocalDeviceSetting[]).forEach((id) => {
                    dropdown.addOption(id, DEVICE_LABELS[id]);
                });
                dropdown
                    .setValue(device)
                    .onChange(async (value) => {
                        settings.localDevice = value as LocalDeviceSetting;
                        await this.saveAndRerender();
                    });
            });
    }

    private renderPrecision(
        containerEl: HTMLElement,
        model: LocalModelDefinition,
        device: LocalDeviceSetting,
        resolved: LocalDtype,
    ): void {
        const { settings } = this;
        const configured = settings.localDtype ?? 'auto';
        const current: LocalDtypeSetting = configured !== 'auto' && model.supportedDtypes.includes(configured)
            ? configured
            : 'auto';
        const autoDtype = resolveLocalDtype(model, 'auto', device);

        new Setting(containerEl)
            .setName('Precision')
            .setDesc(describe((fragment) => {
                fragment.createDiv({ text: `Model weight precision. Smaller is faster to download and run on the CPU; fp32/fp16 are fastest on WebGPU. In use: ${resolved}.` });
                fragment.createDiv({ text: 'Changing the precision rebuilds the semantic index.' });
            }))
            .addDropdown((dropdown) => {
                dropdown.addOption('auto', `Auto (${autoDtype})`);
                model.supportedDtypes.forEach((dtype) => dropdown.addOption(dtype, LOCAL_DTYPE_LABELS[dtype]));
                dropdown
                    .setValue(current)
                    .onChange(async (value) => {
                        settings.localDtype = value as LocalDtypeSetting;
                        await this.saveAndRerender();
                    });
            });
    }

    /** Precision not published for the selected model: fall back to Auto so the dropdown matches. */
    private dropUnsupportedDtype(model: LocalModelDefinition): void {
        const dtype = this.settings.localDtype;
        if (dtype && dtype !== 'auto' && !model.supportedDtypes.includes(dtype)) {
            this.settings.localDtype = 'auto';
        }
    }

    // --- Ollama provider ---

    private renderOllama(containerEl: HTMLElement): void {
        const { settings, plugin } = this;

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('URL of your Ollama server')
            .addText((text) => text
                .setPlaceholder('http://localhost:11434')
                .setValue(settings.ollamaUrl)
                .onChange((value) => {
                    settings.ollamaUrl = value;
                    plugin.scheduleSettingsSave();
                }));

        new Setting(containerEl)
            .setName('Embedding model')
            .setDesc('Ollama model to use for embeddings (e.g., nomic-embed-text, bge-m3). Changing it rebuilds the semantic index.')
            .addText((text) => text
                .setPlaceholder(DEFAULT_EMBEDDING_MODEL)
                .setValue(settings.embeddingModel || DEFAULT_EMBEDDING_MODEL)
                .onChange((value) => {
                    settings.embeddingModel = value.trim() || DEFAULT_EMBEDDING_MODEL;
                    plugin.scheduleSettingsSave();
                }));

        this.renderPrepareButton(containerEl, 'Test connection', 'Check that Ollama is reachable and the model produces embeddings');
    }

    // --- Shared ---

    private renderPrepareButton(containerEl: HTMLElement, label: string, desc: string): void {
        const { plugin } = this;

        new Setting(containerEl)
            .setName(label)
            .setDesc(desc)
            .addButton((button) => button
                .setButtonText(label)
                .onClick(async () => {
                    button.setDisabled(true);
                    button.setButtonText('Working...');
                    try {
                        // Flush any debounced text edits so the current values are tested
                        await plugin.saveSettings();
                        const result = await plugin.prepareEmbeddingModel();
                        new Notice(`Semantic search: ${result.message}`, result.ok ? 5000 : 8000);
                    } catch (error) {
                        new Notice(`Semantic search: ${error instanceof Error ? error.message : String(error)}`, 8000);
                    } finally {
                        button.setDisabled(false);
                        button.setButtonText(label);
                    }
                }));
    }
}
