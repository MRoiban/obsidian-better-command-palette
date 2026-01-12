# AGENTS

This document keeps the guidance for the different coding agents that work on this repository in one place. All agents should start with the shared repository guidelines and then check their agent-specific notes.

## Development Principles

- Make sure that when adding new feature, to modularize them to allow extensibility and building on top
- Make sure to use bun and typescript
- Make sure future components that are built will use the theming service
- Keep code split across focused modules so it stays modular, extensible, hackable, and readable.


## Shared Repository Guidelines

### Build & Development Commands
- Use `bun` instead of `npm` for all package operations.
- `bun run dev` – Start the development build with auto-rebuild and the test vault.
- `bun run build` – Production build (outputs to `dist/`).
- `bun run build-local` – Local build for manual installation.
- `bun run test:lint` – Run ESLint (always run this after making changes).
- `bun run test:e2e` – Run end-to-end tests.
- `bun run tool:gen-files` – Generate test files.

### Architecture Overview
- **Main Entry (`src/main.ts`)**: `BetterCommandPalettePlugin` manages the plugin lifecycle, command registration, and service initialization.
- **Primary Modal (`src/palette.ts`)**: `BetterCommandPaletteModal` extends `SuggestModal` and drives the command/file/tag search modes.
- **Settings (`src/settings.ts`)**: Centralized configuration with type-safe defaults.

#### Enhanced Search System (`src/search/`)
- `EnhancedSearchService` coordinates indexing, caching, and performance monitoring.
- `IndexingCoordinator` manages the file indexing lifecycle and incremental updates.
- `MiniSearchAdapter` integrates the MiniSearch library for full-text indexing.
- `UsageTracker` tracks search patterns for relevance scoring.

#### Semantic Search System (`src/search/semantic/`)
- `EmbeddingService` handles text embeddings via external APIs.
- `SemanticSearchEngine` provides vector similarity search.
- `SemanticIndexingCoordinator` manages the semantic indexing lifecycle.
- `RequestQueue` batches and throttles API requests.

### Adapter Pattern for Modal Search Modes (`src/palette-modal-adapters/`)
- `CommandAdapter` – Obsidian commands with macro support.
- `FileAdapter` – Baseline file search.
- `EnhancedFileAdapter` – Advanced file search with indexing fallback.
- `TagAdapter` – Tag-based file filtering.

### Utility Systems
- **Web Workers (`src/web-workers/`)** – Background processing for suggestions and search.
- **Macro System (`src/utils/macro.ts`)** – Custom command sequences with delays.
- **Logger (`src/utils/logger.ts`)** – Centralized logging (use this instead of `console`).

### Development Guidelines
- Follow the strict TypeScript patterns established in the codebase.
- Prefer async/await patterns for search operations and respect dependency injection where used.
- New search features should go through `EnhancedSearchService` when possible, consider semantic integration, implement caching/performance monitoring, and fit the modal adapter pattern.
- When adding settings, update the interface in `src/settings.ts`, set defaults in `DEFAULT_SETTINGS`, update the settings tab UI, and ensure changes trigger the right service updates.
- Clean up services and workers in `onunload()`, coordinate file change monitoring with `IndexingCoordinator`, and keep large-vault memory usage in mind.
- Modal work should extend the patterns in `palette.ts`, use the `SuggestModalAdapter` interface, maintain keyboard navigation/shortcuts, and follow the existing action type system (Commands/Files/Tags).

### Testing
- E2E tests live under `test/e2e/` with helpers in `test-utils.ts`.
- Development creates a `test-vault/` automatically.
- Use the tooling commands to generate comprehensive test files.

### Key Dependencies
- `obsidian` – Core Obsidian API (external).
- `fuzzysort` – Fuzzy search implementation.
- `minisearch` – Full-text search engine.
- `minimatch` – File pattern matching for filtering.

## Agent Notes

### Claude Code (claude.ai/code)
- Follow all shared repository guidelines above.
- This section mirrors the expectations from `CLAUDE.md`; keep both files in sync when guidance changes.

### OpenAI Codex (Codex CLI)
- Follow the shared repository guidelines above.
- Prefer `rg`/`rg --files` for searches, avoid using `cd` in shell commands (set `workdir` instead), stick to ASCII when editing, and add only brief, high-value comments.
- Run `bun run test:lint` before handing work off, or call out if it was skipped.
- Coordinate with the plan/update workflow provided by the CLI when tasks are non-trivial.


## Again: Development Principles

- Make sure that when adding new feature, to modularize them to allow extensibility and building on top
- Make sure to use bun and typescript
- Make sure future components that are built will use the theming service
- Keep code split across focused modules so it stays modular, extensible, hackable, and readable.
