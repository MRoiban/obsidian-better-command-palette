# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

### Package Manager
Use `bun` instead of `npm` for all package operations.

### Development Commands
- `bun run dev` - Start development build with auto-rebuild and test vault
- `bun run build` - Production build (outputs to `dist/`)
- `bun run build-local` - Local build for manual installation
- `bun run test:lint` - Run ESLint
- `bun run test:e2e` - Run end-to-end tests
- `bun run tool:gen-files` - Generate test files

### Linting & Quality
Always run `bun run test:lint` after making changes to ensure code quality.

## Architecture Overview

### Core Plugin Structure
- **Main Entry**: `src/main.ts` - BetterCommandPalettePlugin class handles plugin lifecycle, command registration, and service initialization
- **Primary Modal**: `src/palette.ts` - BetterCommandPaletteModal extends SuggestModal, manages different search modes (commands/files/tags)
- **Settings Management**: `src/settings.ts` - Centralized configuration with type-safe defaults

### Search Architecture
The plugin implements a sophisticated multi-layer search system:

#### Enhanced Search System (`src/search/`)
- **EnhancedSearchService** - Main search coordinator with indexing, caching, and performance monitoring
- **IndexingCoordinator** - Manages file indexing lifecycle and incremental updates
- **MiniSearchAdapter** - Integrates MiniSearch library for full-text indexing
- **UsageTracker** - Tracks search patterns for relevance scoring

#### Semantic Search System (`src/search/semantic/`)
- **EmbeddingService** - Handles text embeddings via external APIs
- **SemanticSearchEngine** - Vector similarity search implementation
- **SemanticIndexingCoordinator** - Manages semantic indexing lifecycle
- **RequestQueue** - Batches and throttles API requests

### Adapter Pattern for Search Modes
Located in `src/palette-modal-adapters/`:
- **CommandAdapter** - Handles Obsidian commands with macro support
- **FileAdapter** - Basic file search functionality
- **EnhancedFileAdapter** - Advanced file search with indexing fallback
- **TagAdapter** - Tag-based file filtering

### Utility Systems
- **Web Workers** (`src/web-workers/`) - Background processing for suggestions and search
- **Macro System** (`src/utils/macro.ts`) - Custom command sequences with delays
- **Logger** (`src/utils/logger.ts`) - Centralized logging (use instead of console)

## Development Guidelines

### Code Style
- Use the existing logger (`src/utils/logger.ts`) instead of console methods
- Follow TypeScript strict patterns established in the codebase
- Implement proper async/await patterns for search operations
- Use dependency injection for service initialization

### Search Integration
When adding new search features:
1. Check if EnhancedSearchService supports the use case
2. Consider semantic search integration for content-based queries
3. Implement proper caching and performance monitoring
4. Follow the adapter pattern for modal integration

### Settings Integration
- Add new settings to the interface in `src/settings.ts`
- Provide sensible defaults in `DEFAULT_SETTINGS`
- Update settings tab UI for new configuration options
- Ensure settings changes trigger appropriate service updates

### Performance Considerations
- The plugin uses multiple indexing strategies (text-based and semantic)
- Implement proper cleanup in `onunload()` for services and workers
- Use IndexingCoordinator for file change monitoring
- Consider memory usage for large vaults

### Modal Development
- Extend existing modal patterns from `palette.ts`
- Use SuggestModalAdapter interface for consistency
- Implement proper keyboard navigation and shortcuts
- Follow the action type system (Commands/Files/Tags)

## Testing
- E2E tests located in `test/e2e/` with utilities in `test-utils.ts`
- Test vault automatically created during development (`test-vault/`)
- Use the tool commands to generate test files for comprehensive testing

## Key Dependencies
- **obsidian** - Core Obsidian API (external)
- **fuzzysort** - Fuzzy search implementation
- **minisearch** - Full-text search engine
- **minimatch** - File pattern matching for filtering