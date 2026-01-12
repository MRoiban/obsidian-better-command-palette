/**
 * Hybrid Search Module
 * 
 * Exports all hybrid search functionality for use by other modules.
 */

export { HybridSearchService } from './hybrid-search-service';
export type { HybridSearchOptions } from './hybrid-search-service';
export { HybridReRanker } from './re-ranker';
export {
    fuseResults,
    normalizeKeywordResults,
    normalizeSemanticResults,
    computeBlendedScore,
} from './fusion';
export type {
    HybridSearchResult,
    HybridSearchSettings,
    HybridMatchDetails,
    HybridResultSource,
    FusedResult,
    NormalizedKeywordResult,
    NormalizedSemanticResult,
} from './types';
export { DEFAULT_HYBRID_SEARCH_SETTINGS } from './types';
export {
    parseQueryFilters,
    evaluateAllFilters,
    evaluateFilter,
    getFrontmatter,
} from './query-filter-parser';
export type {
    QueryFilter,
    ParsedQuery,
    FilterOperator,
} from './query-filter-parser';
export {
    clusterResults,
    flattenClusters,
    applyClusteringIfEnabled,
} from './result-clusterer';
export type {
    ResultCluster,
    ClusteredSearchResult,
} from './result-clusterer';
