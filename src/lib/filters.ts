/**
 * Filtering a query's result.
 *
 * The vocabulary exists in two forms for two audiences: words in JSON, because
 * a specification is read by people and validators, and symbols on a command
 * line, because `--filter price>=150` is what a shell user reaches for. They map
 * one to one, so a filter means the same thing wherever it is written.
 *
 * Conditions are joined with AND. Nested boolean trees are deliberately absent —
 * they buy an expression language and its parser, and nothing yet needs one.
 */
import { CliError } from "./config.ts";
import { quoteIdent } from "./db.ts";

export const FILTER_OPERATORS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Symbol spellings, longest first so a left-to-right scan cannot stop on the
 * `=` inside `!=` or `>=`. `parseFilterToken` depends on this order.
 */
const SYMBOLS: [string, FilterOperator][] = [
  ["!=", "neq"],
  ["<=", "lte"],
  [">=", "gte"],
  ["=", "eq"],
  ["<", "lt"],
  [">", "gt"],
  ["~", "contains"],
];

/** The token that means SQL NULL, so a bare `null` stays the literal text. */
export const NULL_TOKEN = "@null";

export interface QueryFilter {
  field: string;
  operator: FilterOperator;
  value: string | number | boolean | null;
}

export const FILTER_SYMBOLS = SYMBOLS.map(([symbol]) => symbol);

/**
 * `status=open`, `price>=150`, `notes~a=b`.
 *
 * The operator is the one appearing *earliest*, longest first at that position.
 * Scanning by operator rather than by position would split `notes~a=b` on the
 * `=` and leave a field named `notes~a`.
 */
export function parseFilterToken(token: string): QueryFilter {
  let best: { at: number; symbol: string; operator: FilterOperator } | undefined;
  for (const [symbol, operator] of SYMBOLS) {
    const at = token.indexOf(symbol);
    if (at < 1) continue;
    if (!best || at < best.at || (at === best.at && symbol.length > best.symbol.length)) {
      best = { at, symbol, operator };
    }
  }
  if (!best) {
    throw new CliError(
      `--filter must be <column><operator><value>, got "${token}". ` +
        `Operators: ${FILTER_SYMBOLS.join(" ")}.`,
    );
  }
  const raw = token.slice(best.at + best.symbol.length);
  return { field: token.slice(0, best.at), operator: best.operator, value: raw === NULL_TOKEN ? null : raw };
}

const COMPARISONS: Record<Exclude<FilterOperator, "contains">, string> = {
  eq: "=",
  neq: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
};

/** A caller-supplied filter problem: an unknown column or an impossible comparison. */
export class FilterError extends CliError {}

/**
 * Builds the WHERE terms and their bindings, checking every field against the
 * columns the query actually returns.
 *
 * Placeholders are named rather than positional so they cannot be confused with
 * the parameters the saved query itself declares, and the prefix is reserved:
 * a saved query using it would make the two indistinguishable.
 */
export function compileQueryFilters(
  filters: QueryFilter[],
  columns: string[],
  prefix: string,
): { clause: string; bindings: Record<string, string | number | null> } {
  const parts: string[] = [];
  const bindings: Record<string, string | number | null> = {};

  filters.forEach((filter, i) => {
    if (!columns.includes(filter.field)) {
      throw new FilterError(
        `Cannot filter on "${filter.field}" — the query returns: ${columns.join(", ")}.`,
      );
    }
    const ident = quoteIdent(filter.field);

    if (filter.value === null) {
      // Only equality can test null; the rest have no meaning against it and
      // would silently match nothing.
      if (filter.operator !== "eq" && filter.operator !== "neq") {
        throw new FilterError(
          `Cannot use "${filter.operator}" with ${NULL_TOKEN} on "${filter.field}"; use eq or neq.`,
        );
      }
      parts.push(`${ident} IS ${filter.operator === "neq" ? "NOT " : ""}NULL`);
      return;
    }

    const token = `${prefix}${i}`;
    bindings[`:${token}`] = typeof filter.value === "boolean" ? Number(filter.value) : filter.value;
    if (filter.operator === "contains") {
      // instr() rather than LIKE, so the caller's % and _ stay literal.
      parts.push(`instr(${ident}, :${token}) > 0`);
      return;
    }
    parts.push(`${ident} ${COMPARISONS[filter.operator]} :${token}`);
  });

  return { clause: parts.join(" AND "), bindings };
}
