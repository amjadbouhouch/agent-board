import { test, expect, beforeEach, afterEach } from "bun:test";
import { applyMigration, createWorkspace, newProject, runCli, type Project } from "./helpers.ts";

let project: Project;
let ws: string;

beforeEach(async () => {
  project = await newProject();
  ws = await createWorkspace(project, "Order Operations");
});

afterEach(() => project.cleanup());

/** An example schema and fulfilment-rate query. */
const SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','PAID','SHIPPED','DELIVERED')),
  due_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_orders_user_status ON orders(user_id, status);
INSERT INTO users (id, name) VALUES ('u1','Alice'), ('u2','Bob');
INSERT INTO orders (id, user_id, title, status) VALUES
  ('o1','u1','Keyboard','SHIPPED'),
  ('o2','u1','Monitor','PENDING'),
  ('o3','u2','Mouse','DELIVERED');
`;

const FULFILMENT_RATE = `
SELECT
  u.id AS user_id,
  u.name AS user_name,
  COUNT(o.id) AS total_orders,
  SUM(CASE WHEN o.status IN ('SHIPPED', 'DELIVERED') THEN 1 ELSE 0 END) AS fulfilled_orders,
  CASE
    WHEN COUNT(o.id) = 0 THEN NULL
    ELSE ROUND(
      1.0 * SUM(CASE WHEN o.status IN ('SHIPPED', 'DELIVERED') THEN 1 ELSE 0 END) / COUNT(o.id),
      4
    )
  END AS fulfilled_rate
FROM users u
LEFT JOIN orders o ON o.user_id = u.id
GROUP BY u.id, u.name
ORDER BY fulfilled_rate ASC
`;

function dashboard(title: string): Record<string, unknown> {
  return {
    dslVersion: "1.0",
    id: "order-operations",
    title,
    navigation: [{ label: "Overview", page: "overview" }],
    savedQueries: [{ name: "orders_by_user", sql: FULFILMENT_RATE }],
    pages: [
      {
        id: "overview",
        type: "dashboard",
        title: "Overview",
        components: [
          {
            id: "orders-by-user",
            type: "bar_chart",
            title: "Order Fulfilment by User",
            source: { type: "saved_query", query: "orders_by_user" },
            mapping: { x: "user_name", y: "fulfilled_rate" },
            format: { y: "percent" },
          },
          {
            id: "users-needing-attention",
            type: "data_table",
            title: "Users Needing Attention",
            source: { type: "saved_query", query: "orders_by_user" },
            filter: { field: "fulfilled_rate", operator: "lt", value: 0.8 },
          },
        ],
      },
    ],
  };
}

test("the example dashboard publishes against the example schema", async () => {
  await applyMigration(project, ws, "0001_initial.sql", SCHEMA);
  await project.write("app.json", dashboard("Order Operations"));

  const result = await runCli(project.dir, ["publish", ws, "app.json", "--reason", "initial dashboard"]);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect((await project.json("workspaces", ws, "metadata.json")).appVersion).toBe(1);
});

test("evolve the schema and dashboard, then restore a known working version pair", async () => {
  // 4. Create a schema and import example data.
  await applyMigration(project, ws, "0001_initial.sql", SCHEMA);
  // 5. Create a dashboard using the strict DSL.
  const firstDashboard = dashboard("Order Operations");
  await project.write("v1.json", firstDashboard);
  await runCli(project.dir, ["publish", ws, "v1.json", "--reason", "initial dashboard"]);

  // 8. Request a schema and dashboard modification.
  await applyMigration(
    project,
    ws,
    "0002_add_plan.sql",
    "CREATE TABLE plans (id TEXT PRIMARY KEY, name TEXT NOT NULL);",
  );
  const secondDashboard = dashboard("Order Operations v2");
  (secondDashboard.savedQueries as unknown[]).push({
    name: "plans",
    sql: "SELECT name FROM plans",
  });
  await project.write("v2.json", secondDashboard);
  const publishTwo = await runCli(project.dir, ["publish", ws, "v2.json", "--reason", "add plans"]);
  expect(publishTwo.stderr).toBe("");

  // 9. Inspect the migration and version history.
  const history = await runCli(project.dir, ["inspect", ws]);
  expect(history.stdout).toContain("database v2 + application v2");
  expect(history.stdout).toContain("v2  add_plan  applied");
  expect(history.stdout).toContain("initial dashboard");
  expect(history.stdout).toContain("add plans");

  // 10. Restore the previous working pair: database v1 + application v1.
  // Snapshot #3 was taken before migration 0002, when that pair was current.
  const restore = await runCli(project.dir, ["restore", ws, "3"]);
  expect(restore.stdout).toContain("database v1 + application v1");
  expect(restore.code).toBe(0);

  const after = await runCli(project.dir, ["inspect", ws]);
  expect(after.stdout).toContain("database v1 + application v1");
  expect(after.stdout).toContain("v2  add_plan  PENDING");
  expect(await project.json("workspaces", ws, "application.json")).toEqual(firstDashboard);

  // The rewound schema no longer supports the v2 dashboard, and publishing proves it.
  const stale = await runCli(project.dir, ["publish", ws, "v2.json"]);
  expect(stale.stderr).toContain("no such table: plans");
  expect(stale.code).toBe(1);
});
