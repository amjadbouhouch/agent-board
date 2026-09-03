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
    { id: "f", type: "filter", field: "a", control: "select", label: "A", optionsQuery: "q" },
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
