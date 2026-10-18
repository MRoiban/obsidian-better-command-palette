/**
 * "Reranking" part of the Semantic settings tab: optional local cross-encoder that
 * re-scores the top semantic/hybrid results.
 *
 * Changes are saved through plugin.saveSettings(), which creates, replaces or disposes
 * the reranker at runtime (see BetterCommandPalettePlugin.syncReranker); no restart.
 */

import { Notice, SettingGroup } from 'obsidian';
import BetterCommandPalettePlugin from 'src/main';
import {
    RERANKER_MODELS, RERANK_TIME_BUDGET_MS, RERANK_TOP_K_MAX, RERANK_TOP_K_MIN, clampRerankTopK, describeRerankerModel,
    getRerankerDownloadSize, resolveRerankerModel,
} from 'src/search/semantic/rerank';
import { SemanticSearchSettings } from 'src/search/semantic/types';
import { configureSlider, createStatus, describe } from '../../utils/setting-helpers';

export class RerankerSection {
    constructor(
        private readonly plugin: BetterCommandPalettePlugin,
        private readonly rerender: () => void,
    ) {}

    private get settings(): SemanticSearchSettings {
        return this.plugin.settings.semanticSearch;
    }

    render(containerEl: HTMLElement): void {
        const { settings } = this;
        const device = settings.localDevice ?? 'auto';
        const model = resolveRerankerModel(settings.rerankerModel);
        const size = getRerankerDownloadSize(model, device);

        const group = new SettingGroup(containerEl).setHeading('Reranking');

        group.addSetting((setting) => setting
            .setName('Rerank top results')
            .setDesc(describe((fragment) => {
                fragment.createDiv({
                    text: 'Re-scores the best matches with a local cross-encoder, which reads the query and each note together for a more precise order (semantic and hybrid search).',
                });
                fragment.createDiv({
                    text: `Downloads a second model once from Hugging Face (${model.label}: ~${size ?? '?'}). Results show in the usual order first; reranking is skipped when it takes longer than ${(RERANK_TIME_BUDGET_MS / 1000).toFixed(1)} s.`,
                });
            }))
            .addToggle((toggle) => toggle
                .setValue(settings.enableReranker)
                .onChange(async (value) => {
                    settings.enableReranker = value;
                    await this.saveAndRerender();
                })));

        if (!settings.enableReranker) {
            return;
        }

        group
            .addSetting((setting) => setting
                .setName('Reranker model')
                .setDesc(describe((fragment) => {
                    fragment.createDiv({ text: model.description });
                    fragment.createDiv({ text: describeRerankerModel(model, device) });
                    fragment.createDiv({ text: 'Runs on the device chosen for embeddings above.' });
                }))
                .addDropdown((dropdown) => {
                    RERANKER_MODELS.forEach((definition) => dropdown.addOption(definition.id, definition.label));
                    dropdown
                        .setValue(model.id)
                        .onChange(async (value) => {
                            settings.rerankerModel = value;
                            await this.saveAndRerender();
                        });
                }))
            .addSetting((setting) => configureSlider(setting, {
                name: 'Results to rerank',
                desc: 'How many top results the reranker re-scores. More can surface better matches but takes longer (each result is one model pass).',
                min: RERANK_TOP_K_MIN,
                max: RERANK_TOP_K_MAX,
                step: 5,
                value: clampRerankTopK(settings.rerankerTopK),
                onChange: (value) => {
                    settings.rerankerTopK = value;
                    this.plugin.scheduleSettingsSave();
                },
            }));

        this.renderTestButton(group);
    }

    private renderTestButton(group: SettingGroup): void {
        const { plugin } = this;
        const label = 'Download and test reranker';

        group.addSetting((setting) => {
            let resultEl: HTMLElement | undefined;

            setting
                .setName(label)
                .setDesc(describe((fragment) => {
                    fragment.createDiv({ text: 'Download (first use only) and load the reranker now, then score a sample query, instead of waiting for the first search.' });
                    resultEl = createStatus(fragment.createDiv());
                }))
                .addButton((button) => button
                    .setButtonText(label)
                    .onClick(async () => {
                        button.setDisabled(true);
                        button.setButtonText('Working...');
                        resultEl?.setText('');
                        try {
                            // Apply any pending (debounced) changes first so the current model is tested
                            await plugin.saveSettings();
                            const result = await plugin.testReranker();
                            const message = `Loaded in ${result.load.loadTimeMs} ms (${result.load.device.toUpperCase()}, ${result.load.dtype}). `
                                + `Sample scores: relevant ${result.relevantScore.toFixed(3)}, unrelated ${result.irrelevantScore.toFixed(3)} (${result.inferenceMs} ms).`;
                            resultEl?.setText(message);
                            new Notice(`Reranker: ${message}`, 6000);
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            resultEl?.setText(`Failed: ${message}`);
                            new Notice(`Reranker: ${message}`, 8000);
                        } finally {
                            button.setDisabled(false);
                            button.setButtonText(label);
                        }
                    }));
        });
    }

    private async saveAndRerender(): Promise<void> {
        await this.plugin.saveSettings();
        this.rerender();
    }
}
