/**
 * Minimal validator for the strict application DSL (MVP subset):
 * metric card, data table, bar chart, line chart, filter components.
 * Returns structured error strings; empty array means valid.
 */

export const SUPPORTED_DSL_VERSIONS = ["1.0"];

export const PAGE_TYPES = ["dashboard"];

export const COMPONENT_TYPES = [
  "metric_card",
  "data_table",
  "bar_chart",
  "line_chart",
  "filter",
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function validateApplication(spec: unknown): string[] {
  const errors: string[] = [];
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return ["Application specification must be a JSON object."];
  }
  const app = spec as Record<string, unknown>;

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

  const savedQueryNames = new Set<string>();
  if (app.savedQueries !== undefined) {
    if (!Array.isArray(app.savedQueries)) {
      errors.push('Field "savedQueries" must be an array.');
    } else {
      app.savedQueries.forEach((q, i) => {
        if (typeof q !== "object" || q === null) {
          errors.push(`savedQueries[${i}] must be an object.`);
          return;
        }
        const query = q as Record<string, unknown>;
        if (typeof query.name !== "string" || query.name.length === 0) {
          errors.push(`savedQueries[${i}] is missing a "name".`);
        } else {
          savedQueryNames.add(query.name);
        }
        if (typeof query.sql !== "string" || query.sql.trim().length === 0) {
          errors.push(`savedQueries[${i}] ("${query.name}") is missing "sql".`);
        }
      });
    }
  }

  if (!Array.isArray(app.pages)) {
    errors.push('Field "pages" must be an array.');
    return errors;
  }

  const pageIds = new Set<string>();
  app.pages.forEach((p, i) => {
    if (typeof p !== "object" || p === null) {
      errors.push(`pages[${i}] must be an object.`);
      return;
    }
    const page = p as Record<string, unknown>;
    const label = `pages[${i}]${typeof page.id === "string" ? ` ("${page.id}")` : ""}`;
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
    page.components.forEach((c, j) => {
      validateComponent(c, `${label}.components[${j}]`, savedQueryNames, errors);
    });
  });

  if (app.navigation !== undefined) {
    if (!Array.isArray(app.navigation)) {
      errors.push('Field "navigation" must be an array.');
    } else {
      app.navigation.forEach((n, i) => {
        const nav = n as Record<string, unknown>;
        if (typeof nav?.page !== "string" || !pageIds.has(nav.page)) {
          errors.push(`navigation[${i}] references unknown page "${nav?.page}".`);
        }
      });
    }
  }

  return errors;
}

function validateComponent(
  c: unknown,
  label: string,
  savedQueryNames: Set<string>,
  errors: string[],
): void {
  if (typeof c !== "object" || c === null) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const component = c as Record<string, unknown>;
  if (typeof component.id !== "string" || !ID_PATTERN.test(component.id)) {
    errors.push(`${label}: "id" must be a lowercase kebab-case string.`);
  }
  if (typeof component.type !== "string" || !COMPONENT_TYPES.includes(component.type)) {
    errors.push(
      `${label}: unknown component type "${component.type}". Allowed: ${COMPONENT_TYPES.join(", ")}.`,
    );
    return;
  }
  if (component.type === "filter") return; // Filters have no data source.

  const source = component.source as Record<string, unknown> | undefined;
  if (typeof source !== "object" || source === null) {
    errors.push(`${label}: data components require a "source" object.`);
    return;
  }
  if (source.type !== "saved_query") {
    errors.push(`${label}: source.type must be "saved_query" (MVP).`);
    return;
  }
  if (typeof source.query !== "string") {
    errors.push(`${label}: source.query must be a saved query name.`);
  } else if (savedQueryNames.size > 0 && !savedQueryNames.has(source.query)) {
    errors.push(`${label}: source.query references unknown saved query "${source.query}".`);
  }
}
