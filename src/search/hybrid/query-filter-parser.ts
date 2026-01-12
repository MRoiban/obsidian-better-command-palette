/**
 * Query Filter Parser for Hybrid Search
 * 
 * Parses frontmatter field operators from search queries.
 * Supports operators like `rating:>4`, `status:done`, `author:~john`.
 */

import { TFile, MetadataCache } from 'obsidian';
import { logger } from '../../utils/logger';

/**
 * Filter operators supported in queries
 */
export type FilterOperator =
    | 'eq'       // Exact match (field:value)
    | 'gt'       // Greater than (field:>value)
    | 'lt'       // Less than (field:<value)
    | 'gte'      // Greater than or equal (field:>=value)
    | 'lte'      // Less than or equal (field:<=value)
    | 'contains' // Contains substring (field:~value)
    | 'neq';     // Not equal (field:-value)

/**
 * A parsed filter from the query
 */
export interface QueryFilter {
    /** The frontmatter field to filter on */
    field: string;
    /** The comparison operator */
    operator: FilterOperator;
    /** The value to compare against */
    value: string | number;
    /** Original raw value string from query */
    rawValue: string;
    /** The original matched string for removal from query */
    rawMatch: string;
}

/**
 * Result of parsing a query for filters
 */
export interface ParsedQuery {
    /** The query text with filters removed */
    textQuery: string;
    /** Extracted filters */
    filters: QueryFilter[];
}

/**
 * Regex pattern for matching filter expressions
 * Matches: field:>=value, field:<=value, field:>value, field:<value, field:~value, field:-value, field:value
 * ORDER MATTERS: Check >= and <= before > and <
 */
const FILTER_REGEX = /(\w+):(>=|<=|>|<|~|-)?("[^"]+"|'[^']+'|[^\s]+)/g;

/**
 * Map operator symbols to FilterOperator type
 */
function parseOperator(symbol: string | undefined): FilterOperator {
    switch (symbol) {
        case '>=': return 'gte';
        case '<=': return 'lte';
        case '>': return 'gt';
        case '<': return 'lt';
        case '~': return 'contains';
        case '-': return 'neq';
        default: return 'eq';
    }
}

/**
 * Parse the value, handling quoted strings and numbers
 */
function parseValue(rawValue: string): string | number {
    // Remove quotes if present
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
    }

    // Try to parse as number
    const numValue = parseFloat(value);
    if (!isNaN(numValue) && isFinite(numValue)) {
        return numValue;
    }

    return value;
}

/**
 * Parse a search query to extract frontmatter filters
 * 
 * @param query The full search query string
 * @returns ParsedQuery with filters extracted and clean text query
 * 
 * @example
 * parseQueryFilters("rating:>4 machine learning")
 * // Returns: { textQuery: "machine learning", filters: [{ field: "rating", operator: "gt", value: 4 }] }
 */
export function parseQueryFilters(query: string): ParsedQuery {
    const filters: QueryFilter[] = [];
    let textQuery = query;

    // Reset regex state
    FILTER_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = FILTER_REGEX.exec(query)) !== null) {
        const [rawMatch, field, operatorSymbol, rawValue] = match;

        const filter: QueryFilter = {
            field: field.toLowerCase(),
            operator: parseOperator(operatorSymbol),
            value: parseValue(rawValue),
            rawValue,
            rawMatch,
        };

        filters.push(filter);
        logger.debug(`Query filter parsed:`, filter);
    }

    // Remove all filter expressions from query
    for (const filter of filters) {
        textQuery = textQuery.replace(filter.rawMatch, '');
    }

    // Clean up extra whitespace
    textQuery = textQuery.replace(/\s+/g, ' ').trim();

    if (filters.length > 0) {
        logger.debug(`Parsed ${filters.length} filters from query. Remaining text query: "${textQuery}"`);
    }

    return { textQuery, filters };
}

/**
 * Evaluate a single filter against frontmatter data
 * 
 * @param filter The filter to evaluate
 * @param frontmatter The file's frontmatter (can be undefined)
 * @returns true if the filter passes, false otherwise
 */
export function evaluateFilter(
    filter: QueryFilter,
    frontmatter: Record<string, any> | undefined,
): boolean {
    // If no frontmatter, fail all filters
    if (!frontmatter) {
        return false;
    }

    const fieldValue = frontmatter[filter.field];

    // Check if field exists
    if (fieldValue === undefined || fieldValue === null) {
        // For 'neq' operator, missing field means "not equal" - so it passes
        return filter.operator === 'neq';
    }

    const filterValue = filter.value;

    switch (filter.operator) {
        case 'eq':
            return compareEqual(fieldValue, filterValue);

        case 'neq':
            return !compareEqual(fieldValue, filterValue);

        case 'gt':
            return compareNumeric(fieldValue, filterValue, (a, b) => a > b);

        case 'lt':
            return compareNumeric(fieldValue, filterValue, (a, b) => a < b);

        case 'gte':
            return compareNumeric(fieldValue, filterValue, (a, b) => a >= b);

        case 'lte':
            return compareNumeric(fieldValue, filterValue, (a, b) => a <= b);

        case 'contains':
            return compareContains(fieldValue, filterValue);

        default:
            logger.warn(`Unknown filter operator: ${filter.operator}`);
            return false;
    }
}

/**
 * Compare for equality (handles arrays, case-insensitive strings)
 */
function compareEqual(fieldValue: any, filterValue: string | number): boolean {
    // If field is an array, check if any element matches
    if (Array.isArray(fieldValue)) {
        return fieldValue.some(item => compareEqual(item, filterValue));
    }

    // Numeric comparison
    if (typeof fieldValue === 'number' && typeof filterValue === 'number') {
        return fieldValue === filterValue;
    }

    // Boolean comparison
    if (typeof fieldValue === 'boolean') {
        const boolValue = String(filterValue).toLowerCase();
        return (fieldValue === true && (boolValue === 'true' || boolValue === '1')) ||
            (fieldValue === false && (boolValue === 'false' || boolValue === '0'));
    }

    // String comparison (case-insensitive)
    return String(fieldValue).toLowerCase() === String(filterValue).toLowerCase();
}

/**
 * Compare numerically or as dates
 */
function compareNumeric(
    fieldValue: any,
    filterValue: string | number,
    comparator: (a: number, b: number) => boolean,
): boolean {
    // Try numeric comparison first
    const fieldNum = typeof fieldValue === 'number' ? fieldValue : parseFloat(String(fieldValue));
    const filterNum = typeof filterValue === 'number' ? filterValue : parseFloat(String(filterValue));

    if (!isNaN(fieldNum) && !isNaN(filterNum)) {
        return comparator(fieldNum, filterNum);
    }

    // Try date comparison
    const fieldDate = tryParseDate(fieldValue);
    const filterDate = tryParseDate(filterValue);

    if (fieldDate !== null && filterDate !== null) {
        return comparator(fieldDate, filterDate);
    }

    // If all else fails, compare as strings
    logger.debug(`Falling back to string comparison for filter value: ${filterValue}`);
    return comparator(
        String(fieldValue).localeCompare(String(filterValue)),
        0
    );
}

/**
 * Try to parse a value as a date, returning timestamp or null
 */
function tryParseDate(value: any): number | null {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === 'string') {
        // Handle YYYY, YYYY-MM, YYYY-MM-DD formats
        const dateMatch = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
        if (dateMatch) {
            const [, year, month = '01', day = '01'] = dateMatch;
            const parsed = Date.parse(`${year}-${month}-${day}`);
            if (!isNaN(parsed)) {
                return parsed;
            }
        }

        // Try general date parsing
        const parsed = Date.parse(value);
        if (!isNaN(parsed)) {
            return parsed;
        }
    }

    if (typeof value === 'number') {
        // Could be a year like 2024
        if (value >= 1900 && value <= 2100) {
            return Date.parse(`${value}-01-01`);
        }
        // Could be a timestamp
        if (value > 1e10) {
            return value;
        }
    }

    return null;
}

/**
 * Check if field value contains the filter value (substring)
 */
function compareContains(fieldValue: any, filterValue: string | number): boolean {
    // If field is an array, check if any element contains
    if (Array.isArray(fieldValue)) {
        return fieldValue.some(item => compareContains(item, filterValue));
    }

    const fieldStr = String(fieldValue).toLowerCase();
    const filterStr = String(filterValue).toLowerCase();

    return fieldStr.includes(filterStr);
}

/**
 * Evaluate all filters against frontmatter (AND logic)
 * All filters must pass for the result to be included
 * 
 * @param filters Array of filters to evaluate
 * @param frontmatter The file's frontmatter
 * @returns true if all filters pass, false otherwise
 */
export function evaluateAllFilters(
    filters: QueryFilter[],
    frontmatter: Record<string, any> | undefined,
): boolean {
    // No filters = passes
    if (filters.length === 0) {
        return true;
    }

    // All filters must pass (AND logic)
    return filters.every(filter => evaluateFilter(filter, frontmatter));
}

/**
 * Get frontmatter from a file using Obsidian's metadata cache
 */
export function getFrontmatter(
    file: TFile,
    metadataCache: MetadataCache,
): Record<string, any> | undefined {
    const cache = metadataCache.getFileCache(file);
    return cache?.frontmatter;
}
