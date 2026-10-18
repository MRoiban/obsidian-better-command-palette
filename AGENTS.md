# AGENTS.md

Better Command Palette is an Obsidian plugin (TypeScript, bundled with rollup) that replaces the command palette with command, file, tag, semantic and hybrid search. It is a personal-use plugin, not published to the community store.

This file is the shared brief for every coding agent (Codex, Claude Code, others). If the user's request conflicts with it, the user wins. If something here turns out to be wrong, say so in your summary and fix the line.

## Working agreement

- Treat a request as an instruction to act. Work out the scope, finish the change, verify it, then report. Don't stop to offer next steps you could just take.
- Keep going without checking in for routine, reversible steps: reading code, editing files in this repo, building, linting, deploying to the Palace vault.
- Stop and ask only when you can't continue without a decision from the user, or before anything hard to undo: deleting data or user files, force-pushing, rewriting published history, pushing to `master`, or touching files outside this repo (other than the deploy target below).
- If an instruction in this file makes you pause, quote the line in your question so it can be fixed.

## Commands

Use `bun`, never `npm`. The lockfile is `bun.lock`.

| Command | What it does |
| --- | --- |
| `bun install` | Install dependencies (required before the first build: it provides the onnxruntime WASM file). |
| `bun run build` | Production build into `dist/` (`main.js`, `styles.css`, the WASM asset). |
| `bun run dev` | Watch build into `test-vault/.obsidian/plugins/...` (created on demand). |
| `bun run test:typecheck` | `tsc --noEmit`. Rollup builds with type checking off, so run this separately. |
| `bun run test:lint` | ESLint (`.eslintrc.cjs`). Must end with 0 errors; the existing warnings are known. |
| `bun run deploy` | Build, then copy `dist/` into the Palace vault plugin folder. Keeps `data.json` and the embedding store. |

There is no automated test suite; verification is typecheck, lint, build, and checking the change in Obsidian.

## Definition of done

A change is done when typecheck and lint pass, `bun run build` succeeds, and the behaviour has been checked in the running app when it is user-visible (deploy, then reload the plugin). Commit the rebuilt `dist/main.js` and `dist/styles.css` with the source change; this repo tracks the build output.

Match verification to the change. Don't write tests or harnesses for small, reversible edits that would only restate the implementation.

## Architecture

- `src/main.ts`: `BetterCommandPalettePlugin`. Lifecycle, command registration, service setup and teardown in `onunload()`.
- `src/palette.ts`: `BetterCommandPaletteModal` (extends `SuggestModal`). Delegates each mode to an adapter.
- `src/palette-modal-adapters/`: one adapter per mode (`command`, `file`, `enhanced-file`, `tag`, `hybrid`), all implementing `SuggestModalAdapter` from `src/utils/suggest-modal-adapter.ts`. Adapters return row data from `getSuggestionRow(match)`; they don't build DOM.
- `src/ui/`: shared rendering. `suggestion-row.ts` renders every palette row, `suggestion-format.ts` holds the text formatters, `prompt-chrome.ts` the mode label and status line.
- `src/search/`: keyword search. `EnhancedSearchService` coordinates `IndexingCoordinator`, `MiniSearchAdapter`, the scorer, link graph and `UsageTracker`.
- `src/search/semantic/`: embeddings and vector search. Embeddings run in-plugin by default (`providers/local-transformers-provider.ts`, transformers.js on WebGPU in a worker); Ollama is an optional provider. `rerank/` holds the local cross-encoder reranker.
- `src/search/hybrid/`: query parsing, fusion of keyword and semantic results, re-ranking, clustering.
- `src/web-workers/`: suggestion, search, embedding and reranker workers, inlined by `rollup-plugin-web-worker-loader`.
- `src/settings.ts`: the settings interface and `DEFAULT_SETTINGS`. `src/settings/`: the settings tab, one file per tab under `tabs/`, shared helpers in `utils/setting-helpers.ts`.
- `src/styles.scss` imports `src/styles/_palette.scss` and `_settings.scss`.

## Conventions

- Keep features in small, focused modules and extend the existing seams (a new search mode is a new adapter; a new settings section is a new tab or group) instead of growing `palette.ts` or `main.ts`.
- Log through `logger` from `src/utils/logger.ts`, never `console`.
- New settings: add the field to the interface and `DEFAULT_SETTINGS` in `src/settings.ts`, add the control in the matching tab, and make sure the change reaches the services that read it.
- Search work goes through `EnhancedSearchService` or the semantic/hybrid services, not ad-hoc vault scans. Keep memory use in mind; the main vault has over 1,200 notes.
- Clean up workers, listeners and intervals in `onunload()`.
- TypeScript is not fully strict (`strictNullChecks` is off, `noUncheckedIndexedAccess` is on). Follow the patterns in nearby code.

## UI rules

The plugin must look native in whatever theme is active (the user runs Minimal with the Flexoki scheme).

- Use Obsidian's own markup: `suggestion-item mod-complex`, `suggestion-content`, `suggestion-title`, `suggestion-note`, `suggestion-aux`, `suggestion-flair`, `suggestion-hotkey`, `suggestion-highlight`, `clickable-icon`.
- Settings use the native `SettingGroup` API (`setHeading`, `addSetting`). No custom cards, collapsible groups or icons in headings.
- Style only with Obsidian CSS variables (`--text-muted`, `--size-4-*`, `--background-modifier-hover`, ...). No hex or rgb values in `src/styles/`, no custom fonts, no hard-coded radii or shadows.
- Plugin classes use the `bcp-` prefix.

## Obsidian specifics

- `dist/manifest.json` is the only manifest. `bun run version` bumps it and `versions.json`; dev and local builds copy it into their output.
- The code uses `SettingGroup` (Obsidian 1.11+), but `minAppVersion` still says `0.12.0`.
- Vaults: `Palace` is the deploy and test vault. `The-Academia` is read-only; never write to it.
- The `obsidian` CLI (`obsidian vault=Palace eval|dev:screenshot|plugin:reload ...`) can drive the app. Settings open in a separate popout window, so `activeWindow` is not the main window: set `activeWindow = window; activeDocument = document` before opening a modal you want to screenshot. The CLI can hang; cap how long you wait on it.
