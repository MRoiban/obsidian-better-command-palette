/**
 * Query Filter Parser for Hybrid Search
 *
 * Parses frontmatter field operators from search queries.
 *
 * Syntax (a filter must start a whitespace-separated token):
 *   field:value       exact match (case-insensitive; arrays match any element)
 *   field:>value      greater than      field:>=value   greater than or equal
 *   field:<value      less than         field:<=value   less than or equal
 *   field:~value      contains substring
 *   field:!=value     not equal
 *   -field:value      negates any filter (e.g. `-status:done`, `-rating:>3`)
 *   field:"a b"       quoted values may contain spaces
 *
 * A value starting with `-` is a literal value, so `temp:-5` means "temp equals -5".
 * Values are compared numerically when both sides are plain numbers, as dates when
 * both sides parse as dates (e.g. `date:>2024-06-01`), and as strings otherwise
 * (`version:>1.2.3` uses natural ordering).
 *
 * Tokens that look like URLs (`https://...`) or times (`10:30`) are not filters.
 * Field names are matched against frontmatter keys case-insensitively.
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
    | 'neq';     // Not equal (field:!=value)

/**
 * A parsed filter from the query
 */
export interface QueryFilter {
    /** The frontmatter field to filter on (original case; lookup is case-insensitive) */
    field: string;
    /** The comparison operator */
    operator: FilterOperator;
    /** The value to compare against */
    value: string | number;
    /** Original raw value string from query */
    rawValue: string;
    /** The original matched string for removal from query */
    rawMatch: string;
    /** True when the filter was prefixed with `-` and its result is inverted */
    negated?: boolean;
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
 * Regex pattern for matching filter expressions.
 * Groups: 1 = negation prefix, 2 = field, 3 = operator, 4 = value.
 * ORDER MATTERS: Check >=, <= and != before > and <.
 */
const FILTER_REGEX = /(?<=^|\s)(-)?([\p{L}\p{N}_][\p{L}\p{N}_-]*):(>=|<=|!=|>|<|~)?("[^"]+"|'[^']+'|\S+)/gu;

const LEADING_DIGIT_FIELD_REGEX = /^\p{N}/u;

const NUMBER_REGEX = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const ISO_DATE_REGEX = /^\d{4}(?:-\d{2}(?:-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)?)?$/;

/**
 * Map operator symbols to FilterOperator type
 */
function parseOperator(symbol: string | undefined): FilterOperator {
    switch (symbol) {
        case '>=': return 'gte';
        case '<=': return 'lte';
        case '!=': return 'neq';
        case '>': return 'gt';
        case '<': return 'lt';
        case '~': return 'contains';
        default: return 'eq';
    }
}

/**
 * Parse a whole string as a finite number, or return null.
 * Unlike parseFloat, "2024-06-01" and "1.2.3" are not numbers.
 */
function parseStrictNumber(value: string): number | null {
    const trimmed = value.trim();
    if (!NUMBER_REGEX.test(trimmed)) {
        return null;
    }
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
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

    const numValue = parseStrictNumber(value);
    return numValue ?? value;
}

/**
 * Whether a regex match is a real filter rather than a URL, time, or similar token.
 */
function isFilterCandidate(field: string, operatorSymbol: string | undefined, rawValue: string): boolean {
    // Times/ratios like 10:30 or 2024-06-01T10:30 (field names never start with a digit)
    if (LEADING_DIGIT_FIELD_REGEX.test(field)) {
        return false;
    }

    // URL schemes like https://example.com or obsidian://open
    if (!operatorSymbol && rawValue.startsWith('//')) {
        return false;
    }

    return true;
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
    const textParts: string[] = [];
    let cursor = 0;

    // Reset regex state
    FILTER_REGEX.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = FILTER_REGEX.exec(query)) !== null) {
        const [rawMatch, negation, field, operatorSymbol, rawValue] = match;

        if (!isFilterCandidate(field, operatorSymbol, rawValue)) {
            continue;
        }

        const filter: QueryFilter = {
            field,
            operator: parseOperator(operatorSymbol),
            value: parseValue(rawValue),
            rawValue,
            rawMatch,
        };
        if (negation) {
            filter.negated = true;
        }

        filters.push(filter);
        textParts.push(query.slice(cursor, match.index));
        cursor = match.index + rawMatch.length;
    }
    textParts.push(query.slice(cursor));

    // Remove filter expressions by position and clean up extra whitespace
    const textQuery = textParts.join(' ').replace(/\s+/g, ' ').trim();

    if (filters.length > 0) {
        logger.debug(`Parsed ${filters.length} filters from query. Remaining text query: "${textQuery}"`);
    }

    return { textQuery, filters };
}

/**
 * Stable string form of filters, used for cache keys.
 */
export function serializeFilters(filters: QueryFilter[]): string {
    return filters
        .map((f) => `${f.negated ? '-' : ''}${f.field}\u0000${f.operator}\u0000${typeof f.value}\u0000${f.value}`)
        .join('\u0001');
}

/**
 * Look up a frontmatter field, preferring an exact key match and falling back
 * to a case-insensitive match (frontmatter keys are case-sensitive in YAML).
 */
function getFieldValue(frontmatter: Record<string, unknown>, field: string): unknown {
    if (Object.prototype.hasOwnProperty.call(frontmatter, field)) {
        return frontmatter[field];
    }

    const fieldLower = field.toLowerCase();
    for (const key of Object.keys(frontmatter)) {
        if (key.toLowerCase() === fieldLower) {
            return frontmatter[key];
        }
    }

    return undefined;
}

/**
 * Evaluate a single filter against frontmatter data
 *
 * Missing frontmatter is treated exactly like an empty frontmatter object:
 * a missing field fails every operator except `neq`, and negation inverts that.
 *
 * @param filter The filter to evaluate
 * @param frontmatter The file's frontmatter (can be undefined)
 * @returns true if the filter passes, false otherwise
 */
export function evaluateFilter(
    filter: QueryFilter,
    frontmatter: Record<string, any> | undefined,
): boolean {
    const result = evaluateOperator(filter, frontmatter ?? {});
    return filter.negated ? !result : result;
}

function evaluateOperator(
    filter: QueryFilter,
    frontmatter: Record<string, any>,
): boolean {
    const fieldValue = getFieldValue(frontmatter, filter.field);

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
            return compareOrdered(fieldValue, filterValue, (a, b) => a > b);

        case 'lt':
            return compareOrdered(fieldValue, filterValue, (a, b) => a < b);

        case 'gte':
            return compareOrdered(fieldValue, filterValue, (a, b) => a >= b);

        case 'lte':
            return compareOrdered(fieldValue, filterValue, (a, b) => a <= b);

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
function compareEqual(fieldValue: unknown, filterValue: string | number): boolean {
    // If field is an array, check if any element matches
    if (Array.isArray(fieldValue)) {
        return fieldValue.some(item => compareEqual(item, filterValue));
    }

    // Numeric comparison (frontmatter strings like "4" still count as numbers)
    if (typeof filterValue === 'number') {
        const fieldNum = toStrictNumber(fieldValue);
        if (fieldNum !== null) {
            return fieldNum === filterValue;
        }
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

function toStrictNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        return parseStrictNumber(value);
    }
    return null;
}

/**
 * Compare numerically, then as dates, then as strings (natural order).
 */
function compareOrdered(
    fieldValue: unknown,
    filterValue: string | number,
    comparator: (a: number, b: number) => boolean,
): boolean {
    // If field is an array, check if any element satisfies the comparison
    if (Array.isArray(fieldValue)) {
        return fieldValue.some(item => compareOrdered(item, filterValue, comparator));
    }

    const fieldNum = toStrictNumber(fieldValue);
    const filterNum = toStrictNumber(filterValue);

    if (fieldNum !== null && filterNum !== null) {
        return comparator(fieldNum, filterNum);
    }

    // Try date comparison
    const fieldDate = tryParseDate(fieldValue);
    const filterDate = tryParseDate(filterValue);

    if (fieldDate !== null && filterDate !== null) {
        return comparator(fieldDate, filterDate);
    }

    // If all else fails, compare as strings with natural number ordering (1.10 > 1.9)
    return comparator(
        String(fieldValue).localeCompare(String(filterValue), undefined, { numeric: true, sensitivity: 'base' }),
        0,
    );
}

/**
 * Try to parse a value as a date, returning timestamp or null
 */
function tryParseDate(value: unknown): number | null {
    if (value instanceof Date) {
        const time = value.getTime();
        return isNaN(time) ? null : time;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!ISO_DATE_REGEX.test(trimmed)) {
            return null;
        }

        // Handle YYYY and YYYY-MM by padding to a full date
        const [, year, month = '01'] = trimmed.match(/^(\d{4})(?:-(\d{2}))?$/) ?? [];
        const parsed = year ? Date.parse(`${year}-${month}-01`) : Date.parse(trimmed);
        return isNaN(parsed) ? null : parsed;
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
function compareContains(fieldValue: unknown, filterValue: string | number): boolean {
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
