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

import { MAX_ROW_LIMIT, declaredParameters } from "./queries.ts";
import { FILTER_OPERATORS as QUERY_FILTER_OPERATORS } from "./filters.ts";

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
  filter: {
    source: false,
    required: ["field", "control", "targets"],
    optional: ["label", "optionsQuery", "operator"],
  },
};

export const COMPONENT_TYPES = Object.keys(COMPONENTS);

const FILTER_CONTROLS = ["select", "text", "number", "date", "daterange"];
const FILTER_OPERATORS: string[] = [...QUERY_FILTER_OPERATORS];
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

  const savedQueries = validateSavedQueries(app.savedQueries, errors);
  const pageIds = validatePages(app.pages, savedQueries, errors);
  validateNavigation(app.navigation, pageIds, errors);

  return errors;
}

function validateSavedQueries(value: unknown, errors: string[]): Map<string, string> {
  const names = new Map<string, string>();
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
      names.set(entry.name, typeof entry.sql === "string" ? entry.sql : "");
    }
    if (typeof entry.sql !== "string" || entry.sql.trim().length === 0) {
      errors.push(`${label} is missing "sql".`);
    }
  });
  return names;
}

function validatePages(value: unknown, savedQueries: Map<string, string>, errors: string[]): Set<string> {
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
      validateComponent(component, `${label}.components[${j}]`, savedQueries, componentIds, errors);
    });

    // Targets are resolved after the whole page is known, so a filter may name a
    // component declared below it.
    const onPage = new Map<string, Record<string, unknown>>();
    for (const component of page.components) {
      if (isObject(component) && typeof component.id === "string") onPage.set(component.id, component);
    }
    page.components.forEach((component, j) => {
      if (isObject(component) && component.type === "filter") {
        validateTargets(component, `${label}.components[${j}]`, onPage, savedQueries, errors);
      }
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
  savedQueries: Map<string, string>,
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

  if (contract.source) validateSource(component.source, label, savedQueries, errors);
  if (component.mapping !== undefined) validateMapping(component.mapping, label, errors);
  if (component.filter !== undefined) validateFilter(component.filter, label, errors);
  if (component.format !== undefined && !isObject(component.format)) {
    errors.push(`${label}: "format" must be an object.`);
  }

  if (component.type === "filter") {
    if (
      component.operator !== undefined &&
      (typeof component.operator !== "string" || !FILTER_OPERATORS.includes(component.operator))
    ) {
      errors.push(`${label}: "operator" must be one of: ${FILTER_OPERATORS.join(", ")}.`);
    }
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
  savedQueries: Map<string, string>,
  errors: string[],
): void {
  if (!isObject(value)) {
    errors.push(`${label}: data components require a "source" object.`);
    return;
  }
  rejectUnknownKeys(
    value,
    ["type", "query", "parameters", "limit", "offset", "sort", "filter"],
    `${label}.source`,
    errors,
  );
  if (value.type !== "saved_query") {
    errors.push(`${label}: source.type must be "saved_query".`);
    return;
  }
  if (typeof value.query !== "string") {
    errors.push(`${label}: source.query must be a saved query name.`);
  } else if (savedQueries.size > 0 && !savedQueries.has(value.query)) {
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
  if (value.filter !== undefined) {
    if (!Array.isArray(value.filter) || value.filter.length === 0) {
      errors.push(`${label}: source.filter must be a non-empty array of conditions.`);
    } else {
      value.filter.forEach((entry, i) => {
        validateFilterCondition(entry, `${label}.source.filter[${i}]`, errors);
      });
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

/**
 * Where a filter control sends its value.
 *
 * A target either narrows a component's result — the filter's own `field` and
 * `operator` applied to it — or binds one of the component's declared query
 * parameters. Without this a filter renders a control that changes nothing,
 * which is the failure this DSL exists to make impossible.
 */
function validateTargets(
  component: Record<string, unknown>,
  label: string,
  onPage: Map<string, Record<string, unknown>>,
  savedQueries: Map<string, string>,
  errors: string[],
): void {
  const targets = component.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    errors.push(`${label}: "targets" must be a non-empty array — a filter that drives nothing.`);
    return;
  }

  targets.forEach((entry, i) => {
    const at = `${label}.targets[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${at} must be an object.`);
      return;
    }
    rejectUnknownKeys(entry, ["component", "parameter"], at, errors);

    if (typeof entry.component !== "string" || !onPage.has(entry.component)) {
      errors.push(
        `${at}: "component" must name a component on this page. ` +
          `Available: ${[...onPage.keys()].join(", ") || "none"}.`,
      );
      return;
    }
    if (entry.component === component.id) {
      errors.push(`${at}: a filter cannot target itself.`);
      return;
    }

    const target = onPage.get(entry.component)!;
    const source = isObject(target.source) ? target.source : undefined;
    if (!source) {
      errors.push(`${at}: "${entry.component}" reads no data, so it cannot be filtered.`);
      return;
    }
    if (entry.parameter === undefined) return;

    if (typeof entry.parameter !== "string" || entry.parameter.length === 0) {
      errors.push(`${at}: "parameter" must name a parameter of the target's query.`);
      return;
    }
    const sql = typeof source.query === "string" ? savedQueries.get(source.query) : undefined;
    if (sql === undefined) return; // the unknown query is already reported
    const declared = [...declaredParameters(sql).keys()];
    if (!declared.includes(entry.parameter)) {
      errors.push(
        `${at}: query "${source.query}" declares no parameter "${entry.parameter}". ` +
          `Declared: ${declared.join(", ") || "none"}.`,
      );
    }
  });
}

/** One `{ field, operator, value }` condition, wherever it appears. */
function validateFilterCondition(value: unknown, label: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  rejectUnknownKeys(value, ["field", "operator", "value"], label, errors);
  if (typeof value.field !== "string" || value.field.length === 0) {
    errors.push(`${label}: "field" must name a column.`);
  }
  if (typeof value.operator !== "string" || !FILTER_OPERATORS.includes(value.operator)) {
    errors.push(`${label}: "operator" must be one of: ${FILTER_OPERATORS.join(", ")}.`);
  }
  if (value.value === undefined) {
    errors.push(`${label}: "value" is required.`);
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
