# Obsidian Plugin Template

Use this template as a development checklist and quick reference for building any Obsidian plugin. Adapt each section to match the complexity of your feature set.

## 1. Quick-Start Checklist
- Install dependencies (`npm`, `pnpm`, or `bun`) and a bundler (Rollup, Vite, esbuild) configured for Obsidian’s API.
- Create the required distribution files: `manifest.json`, `main.js`, and optionally `styles.css`.
- Implement a plugin class that extends `Plugin`, hook into `onload()` and `onunload()`.
- Register commands, settings, views/modals, and workspace or vault event handlers.
- Persist settings with `this.loadData()`/`this.saveData()`.
- Package releases as a zip containing `manifest.json`, `main.js`, and `styles.css`.

## 2. Repository Layout (Suggested)
```
obsidian-plugin/
  manifest.json        // Required metadata
  versions.json        // Optional version map for community releases
  src/
    main.ts            // Plugin entry point
    settings.ts        // Settings types & tab implementation
    ui/                // Modals, views, components
    services/          // Business logic, data access
    workers/           // Web workers for heavy tasks
    styles/            // SCSS or CSS modules
  styles.scss          // Bundled into styles.css
  rollup.config.js     // Or Vite/esbuild equivalent
  package.json
  README.md
```
Adjust folders as needed, but keep UI, services, and utilities separated for clarity.

## 3. `manifest.json` Essentials
```json
{
  "id": "your-plugin-id",
  "name": "Your Plugin",
  "version": "1.0.0",
  "minAppVersion": "1.2.0",
  "description": "Short summary of what your plugin does.",
  "author": "Your Name",
  "authorUrl": "https://example.com",
  "fundingUrl": "https://buymeacoffee.com/example",
  "isDesktopOnly": false
}
```
- `id` must be unique and lowercase with dashes.
- Keep `version` synchronized with `package.json` and release tags.
- Set `isDesktopOnly` to `true` if the plugin relies on desktop-only APIs.

## 4. Plugin Entry Point Skeleton (`src/main.ts`)
```ts
import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, ExampleSettingTab, ExampleSettings } from './settings';

export default class ExamplePlugin extends Plugin {
    settings!: ExampleSettings;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new ExampleSettingTab(this.app, this));

        this.addCommand({
            id: 'example-command',
            name: 'Run example command',
            callback: () => this.runExample(),
        });

        // Register other resources here (events, views, intervals, workers)
    }

    onunload() {
        // Clean up intervals, listeners, workers, or temp files
    }

    private runExample() {
        // Feature entry point
    }

    private async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}
```

## 5. Settings Integration
```ts
// settings.ts
import { App, PluginSettingTab, Setting } from 'obsidian';
import ExamplePlugin from './main';

export interface ExampleSettings {
    enableFeature: boolean;
    apiKey: string;
}

export const DEFAULT_SETTINGS: ExampleSettings = {
    enableFeature: true,
    apiKey: '',
};

export class ExampleSettingTab extends PluginSettingTab {
    plugin: ExamplePlugin;

    constructor(app: App, plugin: ExamplePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Example Plugin Settings' });

        new Setting(containerEl)
            .setName('Enable feature')
            .setDesc('Toggle the core functionality on or off.')
            .addToggle((toggle) => toggle
                .setValue(this.plugin.settings.enableFeature)
                .onChange(async (value) => {
                    this.plugin.settings.enableFeature = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('API key')
            .setDesc('Used for remote requests.')
            .addText((text) => text
                .setPlaceholder('Enter key')
                .setValue(this.plugin.settings.apiKey)
                .onChange(async (value) => {
                    this.plugin.settings.apiKey = value.trim();
                    await this.plugin.saveSettings();
                }));
    }
}
```
- Call `this.addSettingTab(new ExampleSettingTab(this.app, this));` in `onload()`.
- Always persist changes via `saveSettings()` to keep the UI and data in sync.

## 6. Common Hook Patterns
- **Commands**: `this.addCommand({ id, name, callback, hotkeys })`.
- **Status bar items**: `this.addStatusBarItem()` for contextual indicators.
- **Ribbon icons**: `this.addRibbonIcon('dice', 'Roll dice', () => {...});`
- **Views/Leaves**: `this.registerView(viewType, (leaf) => new ExampleView(leaf));`
- **Workspace events**: `this.registerEvent(this.app.workspace.on('file-open', ...));`
- **Vault events**: `this.registerEvent(this.app.vault.on('modify', ...));`
- **Intervals**: `this.registerInterval(window.setInterval(() => {...}, 1000));`
- **DOM elements**: Keep references and detach or dispose them in `onunload()`.

## 7. Handling Data & Storage
- Use `this.app.vault` for reading/writing vault files (markdown, JSON, attachments).
- Store plugin-specific state with `this.loadData()`/`this.saveData()`; data is saved to `.obsidian/plugins/<id>/data.json`.
- For larger datasets, consider a lightweight database (indexedDB/localStorage) or custom index files inside the plugin’s folder.
- When migrating settings, guard against missing properties and maintain backward compatibility.

## 8. Asynchronous & Background Work
- Wrap async operations in `try/catch` and surface errors via `new Notice()` or logs.
- Use web workers (via Rollup’s `worker` plugin or similar) for CPU-heavy tasks to keep the UI responsive.
- Throttle or debounce file-system watchers to avoid excessive re-indexing during vault changes.

## 9. Styling Guidelines
- Define plugin styles in `styles.scss` (or `styles.css`) and import from `main.ts` so bundlers emit `styles.css`.
- Scope selectors under a unique class (e.g., `.example-plugin`) to avoid clashing with Obsidian core styles.
- Prefer CSS variables provided by Obsidian for light/dark theme compatibility (`var(--text-normal)`, etc.).

## 10. Build & Tooling
- Bundle TypeScript/ES modules to a single `main.js` targeting ES2020 (Obsidian runs on Electron).
- Example Rollup plugins: `@rollup/plugin-node-resolve`, `@rollup/plugin-commonjs`, `rollup-plugin-terser`, `rollup-plugin-postcss` for styles.
- Typical scripts in `package.json`:
```json
{
  "scripts": {
    "dev": "rollup -c --watch",
    "build": "rollup -c",
    "test": "vitest run",
    "lint": "eslint 'src/**/*.ts'"
  }
}
```
- Use `npm run dev` (or equivalent) while developing; it should output compiled files into your test vault or `dist/`.

## 11. Testing & Quality
- Lint with ESLint + TypeScript to maintain consistent style.
- Use a testing framework (Vitest/Jest) for logic; consider Playwright or custom scripts for end-to-end verification inside a test vault.
- Manual testing tips:
  - Enable the plugin in a sandbox vault loaded via Obsidian’s developer mode.
  - Reload the plugin (CTRL/CMD+R) after each build to test changes quickly.

## 12. Packaging & Distribution
- Release artifacts typically include `manifest.json`, `main.js`, and `styles.css` zipped at the repo root.
- Update `versions.json` to map each release to the minimum compatible Obsidian version.
- Publish on GitHub with tagged releases; submit to the Obsidian community plugin directory by following their contribution guidelines.
- Document installation, configuration, and feature usage in `README.md`.

## 13. Useful References
- Official docs: <https://docs.obsidian.md/Plugins/Getting+Started>
- Sample code snippets: <https://github.com/obsidianmd/obsidian-api>
- Community discussions and plugin examples: <https://forum.obsidian.md/c/plugins/>

Adapt this template to your plugin’s scope. Keep lifecycle management tidy, respect Obsidian’s APIs, and always clean up resources in `onunload()` to provide a reliable experience for users.
