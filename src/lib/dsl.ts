/**
 * Validator for the strict application DSL (MVP subset): metric card, data
 * table, bar chart, line chart, filter control.
 *
 * Strict means a specification that validates is one a renderer can draw
 * without guessing: every component carries the fields its type needs, and an
 * unrecognised property is an error rather than something silently dropped —
 * a misspelled `filtr` should fail here, not render a table with no filter.
 *
 * Returns structured error strings; an empty array means valid.
 */

import { MAX_ROW_LIMIT } from "./queries.ts";

export const SUPPORTED_DSL_VERSIONS = ["1.0"];

export const PAGE_TYPES = ["dashboard"];

/** What each component type requires, and everything it may carry. */
interface ComponentContract {
  /** Reads rows from a saved query. */
  source: boolean;
  required: string[];
  optional: string[];
}

/**
 * `source` is `{ type, query, parameters?, limit?, offset?, sort? }`. Paging and
 * ordering belong to the specification because the component knows how many rows
 * it needs and in what order; without them a table over the default cap draws
 * its first page and says nothing about the rest, and a renderer has to invent
 * the numbers in its own code.
 */
const COMPONENTS: Record<string, ComponentContract> = {
  metric_card: { source: true, required: ["value"], optional: ["title", "format"] },
  data_table: { source: true, required: [], optional: ["title", "columns", "filter"] },
  bar_chart: { source: true, required: ["mapping"], optional: ["title", "format"] },
  line_chart: { source: true, required: ["mapping"], optional: ["title", "format"] },
  filter: { source: false, required: ["field", "control"], optional: ["label", "optionsQuery"] },
};

export const COMPONENT_TYPES = Object.keys(COMPONENTS);

const FILTER_CONTROLS = ["select", "text", "number", "date", "daterange"];
const FILTER_OPERATORS = ["eq", "neq", "lt", "lte", "gt", "gte", "contains"];
const CHART_AXES = ["x", "y"];

const TOP_LEVEL = [
  "dslVersion", "id", "title", "navigation", "pages", "savedQueries", "actions", "theme",
];
const PAGE_KEYS = ["id", "type", "title", "components"];
const SAVED_QUERY_KEYS = ["name", "sql", "description", "parameters"];
const NAVIGATION_KEYS = ["label", "page", "icon"];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reports any property outside the known set, so typos surface here. */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${label}: unknown property "${key}". Allowed: ${allowed.join(", ")}.`);
    }
  }
}

export function validateApplication(spec: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(spec)) return ["Application specification must be a JSON object."];
  const app = spec;

  rejectUnknownKeys(app, TOP_LEVEL, "application", errors);

  if (typeof app.dslVersion !== "string") {
    errors.push('Missing required string field "dslVersion".');
  } else if (!SUPPORTED_DSL_VERSIONS.includes(app.dslVersion)) {
    errors.push(
      `Unsupported dslVersion "${app.dslVersion}". Supported: ${SUPPORTED_DSL_VERSIONS.join(", ")}.`,
    );
  }
  if (typeof app.id !== "string" || !ID_PATTERN.test(app.id)) {
    errors.push('Field "id" must be a lowercase kebab-case string.');
  }
  if (typeof app.title !== "string" || app.title.length === 0) {
    errors.push('Field "title" must be a non-empty string.');
  }

  const savedQueryNames = validateSavedQueries(app.savedQueries, errors);
  const pageIds = validatePages(app.pages, savedQueryNames, errors);
  validateNavigation(app.navigation, pageIds, errors);

  return errors;
}

function validateSavedQueries(value: unknown, errors: string[]): Set<string> {
  const names = new Set<string>();
  if (value === undefined) return names;
  if (!Array.isArray(value)) {
    errors.push('Field "savedQueries" must be an array.');
    return names;
  }

  value.forEach((entry, i) => {
    const label = `savedQueries[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    rejectUnknownKeys(entry, SAVED_QUERY_KEYS, label, errors);

    if (typeof entry.name !== "string" || entry.name.length === 0) {
      errors.push(`${label} is missing a "name".`);
    } else if (names.has(entry.name)) {
      // Two queries under one name make every reference to it ambiguous.
      errors.push(`${label}: duplicate saved query name "${entry.name}".`);
    } else {
      names.add(entry.name);
    }
    if (typeof entry.sql !== "string" || entry.sql.trim().length === 0) {
      errors.push(`${label} is missing "sql".`);
    }
  });
  return names;
}

function validatePages(value: unknown, savedQueryNames: Set<string>, errors: string[]): Set<string> {
  const pageIds = new Set<string>();
  if (!Array.isArray(value)) {
    errors.push('Field "pages" must be an array.');
    return pageIds;
  }

  value.forEach((entry, i) => {
    if (!isObject(entry)) {
      errors.push(`pages[${i}] must be an object.`);
      return;
    }
    const page = entry;
    const label = `pages[${i}]${typeof page.id === "string" ? ` ("${page.id}")` : ""}`;
    rejectUnknownKeys(page, PAGE_KEYS, label, errors);

    if (typeof page.id !== "string" || !ID_PATTERN.test(page.id)) {
      errors.push(`${label}: "id" must be a lowercase kebab-case string.`);
    } else if (pageIds.has(page.id)) {
      errors.push(`${label}: duplicate page id.`);
    } else {
      pageIds.add(page.id);
    }
    if (typeof page.type !== "string" || !PAGE_TYPES.includes(page.type)) {
      errors.push(`${label}: "type" must be one of: ${PAGE_TYPES.join(", ")}.`);
    }
    if (typeof page.title !== "string" || page.title.length === 0) {
      errors.push(`${label}: "title" must be a non-empty string.`);
    }

    if (!Array.isArray(page.components)) {
      errors.push(`${label}: "components" must be an array.`);
      return;
    }
    const componentIds = new Set<string>();
    page.components.forEach((component, j) => {
      validateComponent(component, `${label}.components[${j}]`, savedQueryNames, componentIds, errors);
    });
  });
  return pageIds;
}

function validateNavigation(value: unknown, pageIds: Set<string>, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push('Field "navigation" must be an array.');
    return;
  }
  value.forEach((entry, i) => {
    const label = `navigation[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    rejectUnknownKeys(entry, NAVIGATION_KEYS, label, errors);
    if (typeof entry.page !== "string" || !pageIds.has(entry.page)) {
      errors.push(`${label} references unknown page "${entry.page}".`);
    }
  });
}

function validateComponent(
  value: unknown,
  label: string,
  savedQueryNames: Set<string>,
  componentIds: Set<string>,
  errors: string[],
): void {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const component = value;

  if (typeof component.type !== "string" || !(component.type in COMPONENTS)) {
    errors.push(
      `${label}: unknown component type "${component.type}". Allowed: ${COMPONENT_TYPES.join(", ")}.`,
    );
    return;
  }
  const contract = COMPONENTS[component.type]!;

  if (typeof component.id !== "string" || !ID_PATTERN.test(component.id)) {
    errors.push(`${label}: "id" must be a lowercase kebab-case string.`);
  } else if (componentIds.has(component.id)) {
    errors.push(`${label}: duplicate component id "${component.id}" on this page.`);
  } else {
    componentIds.add(component.id);
  }

  const allowed = ["id", "type", ...contract.required, ...contract.optional];
  if (contract.source) allowed.push("source");
  rejectUnknownKeys(component, allowed, label, errors);

  for (const field of contract.required) {
    if (component[field] === undefined) {
      errors.push(`${label}: "${component.type}" requires "${field}".`);
    }
  }

  if (contract.source) validateSource(component.source, label, savedQueryNames, errors);
  if (component.mapping !== undefined) validateMapping(component.mapping, label, errors);
  if (component.filter !== undefined) validateFilter(component.filter, label, errors);
  if (component.format !== undefined && !isObject(component.format)) {
    errors.push(`${label}: "format" must be an object.`);
  }

  if (component.type === "filter") {
    if (component.field !== undefined && typeof component.field !== "string") {
      errors.push(`${label}: "field" must be a string.`);
    }
    if (
      component.control !== undefined &&
      (typeof component.control !== "string" || !FILTER_CONTROLS.includes(component.control))
    ) {
      errors.push(`${label}: "control" must be one of: ${FILTER_CONTROLS.join(", ")}.`);
    }
  }

  if (component.type === "metric_card" && component.value !== undefined) {
    if (typeof component.value !== "string") {
      errors.push(`${label}: "value" must be the name of a column.`);
    }
  }
}

function validateSource(
  value: unknown,
  label: string,
  savedQueryNames: Set<string>,
  errors: string[],
): void {
  if (!isObject(value)) {
    errors.push(`${label}: data components require a "source" object.`);
    return;
  }
  rejectUnknownKeys(
    value,
    ["type", "query", "parameters", "limit", "offset", "sort"],
    `${label}.source`,
    errors,
  );
  if (value.type !== "saved_query") {
    errors.push(`${label}: source.type must be "saved_query".`);
    return;
  }
  if (typeof value.query !== "string") {
    errors.push(`${label}: source.query must be a saved query name.`);
  } else if (savedQueryNames.size > 0 && !savedQueryNames.has(value.query)) {
    errors.push(`${label}: source.query references unknown saved query "${value.query}".`);
  }
  if (value.offset !== undefined) {
    if (typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0) {
      errors.push(
        `${label}: source.offset must be a whole count of rows to skip, got ${JSON.stringify(value.offset)}.`,
      );
    }
  }
  if (value.sort !== undefined) {
    // Paging an unordered query repeats rows on one page and skips them on the
    // next, so an offset without a sort is a bug waiting to be reported.
    if (!Array.isArray(value.sort) || value.sort.length === 0) {
      errors.push(`${label}: source.sort must be a non-empty array of column names.`);
    } else {
      for (const entry of value.sort) {
        const name = typeof entry === "string" && entry.startsWith("-") ? entry.slice(1) : entry;
        if (typeof name !== "string" || name.length === 0) {
          errors.push(
            `${label}: source.sort entries must name a column, "-column" for descending; got ${JSON.stringify(entry)}.`,
          );
        }
      }
    }
  }
  if (value.limit !== undefined) {
    if (
      typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > MAX_ROW_LIMIT
    ) {
      errors.push(
        `${label}: source.limit must be an integer from 1 to ${MAX_ROW_LIMIT}, got ${JSON.stringify(value.limit)}.`,
      );
    }
  }
}

/** Charts plot one column against another, so both axes must name one. */
function validateMapping(value: unknown, label: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${label}: "mapping" must be an object.`);
    return;
  }
  rejectUnknownKeys(value, CHART_AXES, `${label}.mapping`, errors);
  for (const axis of CHART_AXES) {
    if (typeof value[axis] !== "string" || (value[axis] as string).length === 0) {
      errors.push(`${label}: mapping."${axis}" must name a column.`);
    }
  }
}

function validateFilter(value: unknown, label: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${label}: "filter" must be an object.`);
    return;
  }
  rejectUnknownKeys(value, ["field", "operator", "value"], `${label}.filter`, errors);
  if (typeof value.field !== "string") {
    errors.push(`${label}: filter."field" must name a column.`);
  }
  if (typeof value.operator !== "string" || !FILTER_OPERATORS.includes(value.operator)) {
    errors.push(`${label}: filter."operator" must be one of: ${FILTER_OPERATORS.join(", ")}.`);
  }
  if (value.value === undefined) {
    errors.push(`${label}: filter."value" is required.`);
  }
}
