import { test, expect, beforeEach, afterEach } from "bun:test";
import { newProject, runCli, type Project } from "./helpers.ts";

/**
 * The DSL is the contract a renderer relies on: if a specification validates,
 * every component must carry what it needs to be drawn. A bar chart without a
 * mapping has nothing to plot, so the validator — not the renderer — is where
 * that has to fail.
 */
let project: Project;

beforeEach(async () => {
  project = await newProject();
});

afterEach(() => project.cleanup());

const BASE = {
  dslVersion: "1.0",
  id: "d",
  title: "T",
  navigation: [],
  savedQueries: [{ name: "q", sql: "SELECT 1 AS a" }],
};

const SOURCE = { type: "saved_query", query: "q" };

/** Validates a spec built from one page holding the given components. */
async function validateWith(components: unknown[], overrides: Record<string, unknown> = {}) {
  const spec = {
    ...BASE,
    ...overrides,
    pages: [{ id: "p", type: "dashboard", title: "P", components }],
  };
  await project.write("s.json", spec);
  return runCli(project.dir, ["validate", "s.json"]);
}

test("a bar chart without a mapping is rejected", async () => {
  const result = await validateWith([{ id: "c", type: "bar_chart", title: "C", source: SOURCE }]);

  expect(result.stderr).toContain("mapping");
  expect(result.code).toBe(1);
});

test("a chart mapping missing an axis is rejected", async () => {
  const result = await validateWith([
    { id: "c", type: "bar_chart", title: "C", source: SOURCE, mapping: { x: "a" } },
  ]);

  expect(result.stderr).toContain("y");
  expect(result.code).toBe(1);
});

test("a metric card without a value field is rejected", async () => {
  const result = await validateWith([{ id: "c", type: "metric_card", title: "C", source: SOURCE }]);

  expect(result.stderr).toContain("value");
  expect(result.code).toBe(1);
});

test("a filter control without a field is rejected", async () => {
  const result = await validateWith([{ id: "c", type: "filter", control: "select" }]);

  expect(result.stderr).toContain("field");
  expect(result.code).toBe(1);
});

test("a filter control with an unknown control type is rejected", async () => {
  const result = await validateWith([{ id: "c", type: "filter", field: "a", control: "hologram" }]);

  expect(result.stderr).toContain("control");
  expect(result.code).toBe(1);
});

test("duplicate saved-query names are rejected", async () => {
  const result = await validateWith([], {
    savedQueries: [
      { name: "q", sql: "SELECT 1" },
      { name: "q", sql: "SELECT 2" },
    ],
  });

  expect(result.stderr).toContain("q");
  expect(result.code).toBe(1);
});

test("duplicate component ids on a page are rejected", async () => {
  const result = await validateWith([
    { id: "c", type: "data_table", title: "A", source: SOURCE },
    { id: "c", type: "data_table", title: "B", source: SOURCE },
  ]);

  expect(result.stderr).toContain("duplicate");
  expect(result.code).toBe(1);
});

test("a misspelled component property is rejected rather than ignored", async () => {
  const result = await validateWith([
    { id: "c", type: "data_table", title: "C", source: SOURCE, filtr: {} },
  ]);

  expect(result.stderr).toContain("filtr");
  expect(result.code).toBe(1);
});

test("a misspelled top-level property is rejected", async () => {
  const result = await validateWith([], { savedQuerys: [] });

  expect(result.stderr).toContain("savedQuerys");
  expect(result.code).toBe(1);
});

test("a data_table filter with an unknown operator is rejected", async () => {
  const result = await validateWith([
    {
      id: "c",
      type: "data_table",
      title: "C",
      source: SOURCE,
      filter: { field: "a", operator: "approximately", value: 1 },
    },
  ]);

  expect(result.stderr).toContain("operator");
  expect(result.code).toBe(1);
});

test("the fully specified components every renderer needs still validate", async () => {
  const result = await validateWith([
    { id: "m", type: "metric_card", title: "M", source: SOURCE, value: "a", format: { value: "percent" } },
    { id: "t", type: "data_table", title: "T", source: SOURCE, filter: { field: "a", operator: "lt", value: 0.8 } },
    { id: "b", type: "bar_chart", title: "B", source: SOURCE, mapping: { x: "a", y: "a" }, format: { y: "percent" } },
    { id: "l", type: "line_chart", title: "L", source: SOURCE, mapping: { x: "a", y: "a" } },
    { id: "f", type: "filter", field: "a", control: "select", label: "A", optionsQuery: "q",
      operator: "eq", targets: [{ component: "t" }] },
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

/**
 * A table over more rows than the default cap used to have no way to say so:
 * the runtime could return them, but the specification could not ask, so a
 * 460-row catalogue silently rendered its first 100.
 */
test("a source may declare the row limit its component needs", async () => {
  const result = await validateWith([
    { id: "t", type: "data_table", title: "T", source: { ...SOURCE, limit: 500 } },
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

test("a source limit beyond the runtime ceiling is rejected", async () => {
  const result = await validateWith([
    { id: "t", type: "data_table", title: "T", source: { ...SOURCE, limit: 50_000 } },
  ]);

  expect(result.stderr).toContain("source.limit");
  expect(result.stderr).toContain("10000");
  expect(result.code).toBe(1);
});

test("a source limit that is not a whole count is rejected", async () => {
  for (const limit of [0, -5, 1.5, "500"]) {
    const result = await validateWith([
      { id: "t", type: "data_table", title: "T", source: { ...SOURCE, limit } },
    ]);
    expect(result.stderr).toContain("source.limit");
    expect(result.code).toBe(1);
  }
});

test("a source may declare ordering and an offset", async () => {
  const result = await validateWith([
    {
      id: "t", type: "data_table", title: "T",
      source: { ...SOURCE, limit: 100, offset: 200, sort: ["-a", "a"] },
    },
  ]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

test("a sort that is not a list of column names is rejected", async () => {
  for (const sort of ["a", [], [""], ["-"], [1], ["a", 2]]) {
    const result = await validateWith([
      { id: "t", type: "data_table", title: "T", source: { ...SOURCE, sort } },
    ]);
    expect(result.stderr).toContain("source.sort");
    expect(result.code).toBe(1);
  }
});

test("a negative or fractional offset is rejected", async () => {
  for (const offset of [-1, 1.5, "10"]) {
    const result = await validateWith([
      { id: "t", type: "data_table", title: "T", source: { ...SOURCE, offset } },
    ]);
    expect(result.stderr).toContain("source.offset");
    expect(result.code).toBe(1);
  }
});

test("a source may declare the rows it wants", async () => {
  const result = await validateWith([
    {
      id: "t", type: "data_table", title: "T",
      source: { ...SOURCE, filter: [{ field: "a", operator: "gte", value: 10 }] },
    },
  ]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

test("a malformed source filter is rejected", async () => {
  const bad: unknown[] = [
    "a=1",
    [],
    [{ field: "a" }],
    [{ field: "a", operator: "approximately", value: 1 }],
    [{ field: "a", operator: "eq", value: 1, extra: true }],
  ];
  for (const filter of bad) {
    const result = await validateWith([
      { id: "t", type: "data_table", title: "T", source: { ...SOURCE, filter } },
    ]);
    expect(result.stderr).toContain("source.filter");
    expect(result.code).toBe(1);
  }
});

/**
 * A filter control has to say what it drives. One that names nothing renders a
 * control the user can change to no effect, which is the class of failure this
 * validator exists to catch.
 */
test("a filter without targets is rejected", async () => {
  const result = await validateWith([
    { id: "t", type: "data_table", title: "T", source: SOURCE },
    { id: "f", type: "filter", field: "a", control: "select" },
  ]);
  expect(result.stderr).toContain("targets");
  expect(result.code).toBe(1);
});

test("a target may be declared after the filter that names it", async () => {
  const result = await validateWith([
    { id: "f", type: "filter", field: "a", control: "select", targets: [{ component: "t" }] },
    { id: "t", type: "data_table", title: "T", source: SOURCE },
  ]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});

test("a target must be a component on the same page", async () => {
  const result = await validateWith([
    { id: "t", type: "data_table", title: "T", source: SOURCE },
    { id: "f", type: "filter", field: "a", control: "select", targets: [{ component: "ghost" }] },
  ]);
  expect(result.stderr).toContain("must name a component on this page");
  expect(result.stderr).toContain("t, f");
  expect(result.code).toBe(1);
});

test("a filter cannot target itself", async () => {
  const result = await validateWith([
    { id: "f", type: "filter", field: "a", control: "select", targets: [{ component: "f" }] },
  ]);
  expect(result.stderr).toContain("cannot target itself");
  expect(result.code).toBe(1);
});

test("a target that reads no data cannot be filtered", async () => {
  const result = await validateWith([
    { id: "g", type: "filter", field: "a", control: "text", targets: [{ component: "f" }] },
    { id: "f", type: "filter", field: "a", control: "select", targets: [{ component: "g" }] },
  ]);
  expect(result.stderr).toContain("reads no data");
  expect(result.code).toBe(1);
});

test("binding a target parameter checks the target's query declares it", async () => {
  const spec = {
    ...BASE,
    savedQueries: [{ name: "q", sql: "SELECT 1 AS a WHERE 1 = :wanted" }],
    pages: [{
      id: "p", type: "dashboard", title: "P",
      components: [
        { id: "t", type: "data_table", title: "T", source: { type: "saved_query", query: "q" } },
        { id: "f", type: "filter", field: "a", control: "select",
          targets: [{ component: "t", parameter: "missing" }] },
      ],
    }],
  };
  await project.write("s.json", spec);
  const result = await runCli(project.dir, ["validate", "s.json"]);

  expect(result.stderr).toContain('declares no parameter "missing"');
  expect(result.stderr).toContain("wanted");
  expect(result.code).toBe(1);
});

test("a filter bound to a declared parameter validates", async () => {
  const spec = {
    ...BASE,
    savedQueries: [{ name: "q", sql: "SELECT 1 AS a WHERE 1 = :wanted" }],
    pages: [{
      id: "p", type: "dashboard", title: "P",
      components: [
        { id: "t", type: "data_table", title: "T",
          source: { type: "saved_query", query: "q", parameters: { wanted: "1" } } },
        { id: "f", type: "filter", field: "a", control: "select",
          targets: [{ component: "t", parameter: "wanted" }] },
      ],
    }],
  };
  await project.write("s.json", spec);
  const result = await runCli(project.dir, ["validate", "s.json"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
});
