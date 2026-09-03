import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyMigration, createWorkspace, newProject, runCli, type Project } from "./helpers.ts";

/**
 * CRUD over rows, driven through the CLI exactly as an agent would.
 *
 * Migrations carry schema; data is manipulated here. The two halves of that
 * split are what these tests hold in place.
 */
describe("rows", () => {
  let project: Project;
  let ws: string;

  const SCHEMA = `
    CREATE TABLE products (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      category TEXT NOT NULL,
      price    INTEGER NOT NULL,
      discontinued INTEGER
    );
  `;

  const seed = (rows: unknown[]) =>
    runCli(project.dir, ["rows", "insert", ws, "products", "--data", JSON.stringify(rows)]);

  const rowsIn = async (table: string): Promise<Record<string, unknown>[]> => {
    const result = await runCli(project.dir, [
      "query", ws, `SELECT * FROM ${table} ORDER BY id`, "--json", "--limit", "5000",
    ]);
    if (result.code !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout).rows;
  };

  /** Pulls the receipt token out of a preview so the apply can present it. */
  const receiptOf = (stdout: string): string => {
    const match = stdout.match(/receipt:\s*(\S+)/);
    if (!match) throw new Error(`no receipt in output:\n${stdout}`);
    return match[1]!;
  };

  beforeEach(async () => {
    project = await newProject();
    ws = await createWorkspace(project);
    await applyMigration(project, ws, "0001_products.sql", SCHEMA);
  });

  afterEach(() => project.cleanup());

  describe("insert", () => {
    test("adds rows and reports how many", async () => {
      const result = await seed([
        { id: 1, name: "Keyboard", category: "hardware", price: 1200 },
        { id: 2, name: "Cable", category: "accessories", price: 900 },
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("2");
      expect(await rowsIn("products")).toHaveLength(2);
    });

    test("accepts a single object as well as an array", async () => {
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "products",
        "--data", JSON.stringify({ id: 1, name: "Keyboard", category: "hardware", price: 1 }),
      ]);
      expect(result.code).toBe(0);
      expect(await rowsIn("products")).toHaveLength(1);
    });

    test("reads a batch from a file, so bulk data never passes through an argument list", async () => {
      const batch = Array.from({ length: 250 }, (_, i) => ({
        id: i + 1, name: `Item ${i + 1}`, category: "hardware", price: (i + 1) * 10,
      }));
      const file = await project.write("batch.json", batch);
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "products", "--data-file", file,
      ]);
      expect(result.code).toBe(0);
      expect(await rowsIn("products")).toHaveLength(250);
    });

    test("names the unknown column rather than failing deep in the driver", async () => {
      const result = await seed([{ id: 1, name: "x", category: "hardware", price: 1, colour: "red" }]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("colour");
      expect(result.stderr).toContain("price");
    });

    test("refuses a non-numeric value for an integer column instead of storing it as text", async () => {
      // A thousands separator is enough: SQLite's affinity rules store this
      // as text in an INTEGER column, and every later SUM() is silently wrong.
      const result = await seed([
        { id: 1, name: "Keyboard", category: "hardware", price: "1,200" },
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("price");
      expect(await rowsIn("products")).toHaveLength(0);
    });

    test("applies the whole batch or none of it", async () => {
      const result = await seed([
        { id: 1, name: "ok", category: "hardware", price: 1 },
        { id: 2, name: "bad", category: "hardware", price: "not a number" },
      ]);
      expect(result.code).toBe(1);
      expect(await rowsIn("products")).toHaveLength(0);
    });

    test("refuses a platform-owned table", async () => {
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "_agentboard_migrations",
        "--data", JSON.stringify([{ version: 99, name: "x", checksum: "y", sql: "z" }]),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/platform|protected/i);
    });

    test("names the table when it does not exist", async () => {
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "missing", "--data", JSON.stringify([{ a: 1 }]),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("missing");
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await seed([
        { id: 1, name: "Keyboard", category: "hardware", price: 100 },
        { id: 2, name: "Cable", category: "accessories", price: 200 },
        { id: 3, name: "Monitor", category: "hardware", price: 300 },
      ]);
    });

    test("previews by default and writes nothing", async () => {
      const result = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=999", "--where", "category=hardware",
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/2/);
      expect(result.stdout).toMatch(/receipt:/);
      const prices = (await rowsIn("products")).map((row) => row.price);
      expect(prices).toEqual([100, 200, 300]);
    });

    test("applies when the preview receipt is presented", async () => {
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=999", "--where", "category=hardware",
      ]);
      const result = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=999", "--where", "category=hardware",
        "--apply", receiptOf(preview.stdout),
      ]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const prices = (await rowsIn("products")).map((row) => row.price);
      expect(prices).toEqual([999, 200, 999]);
    });

    test("refuses a receipt whose matched rows have since changed", async () => {
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=999", "--where", "category=hardware",
      ]);
      // A fourth row joins the matched set between the preview and the apply.
      await seed([{ id: 4, name: "Webcam", category: "hardware", price: 400 }]);

      const result = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=999", "--where", "category=hardware",
        "--apply", receiptOf(preview.stdout),
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/changed since|re-?run the preview/i);
      const prices = (await rowsIn("products")).map((row) => row.price);
      expect(prices).toEqual([100, 200, 300, 400]);
    });

    test("refuses an unbounded update", async () => {
      const result = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=0",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--where/);
    });

    test("rejects an unknown column in --set", async () => {
      const result = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "colour=red", "--where", "id=1",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("colour");
    });

    test("supports comparison operators in --where", async () => {
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "discontinued=1", "--where", "price>150",
      ]);
      await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "discontinued=1", "--where", "price>150",
        "--apply", receiptOf(preview.stdout),
      ]);
      const flags = (await rowsIn("products")).map((row) => row.discontinued);
      expect(flags).toEqual([null, 1, 1]);
    });
  });

  describe("delete", () => {
    beforeEach(async () => {
      await seed([
        { id: 1, name: "Keyboard", category: "hardware", price: 100 },
        { id: 2, name: "Cable", category: "accessories", price: 200 },
      ]);
    });

    test("previews by default and writes nothing", async () => {
      const result = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
      ]);
      expect(result.code).toBe(0);
      expect(await rowsIn("products")).toHaveLength(2);
    });

    test("applies when the preview receipt is presented", async () => {
      const preview = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
      ]);
      const result = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
        "--apply", receiptOf(preview.stdout),
      ]);
      expect(result.code).toBe(0);
      expect(await rowsIn("products")).toHaveLength(1);
    });

    test("refuses an unbounded delete", async () => {
      const result = await runCli(project.dir, ["rows", "delete", ws, "products"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--where/);
      expect(await rowsIn("products")).toHaveLength(2);
    });
  });

  describe("blast radius", () => {
    test("refuses to apply beyond the cap without --force", async () => {
      const batch = Array.from({ length: 1200 }, (_, i) => ({
        id: i + 1, name: `Item ${i + 1}`, category: "hardware", price: 10,
      }));
      await runCli(project.dir, [
        "rows", "insert", ws, "products",
        "--data-file", await project.write("many.json", batch),
      ]);

      const preview = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
      ]);
      expect(preview.stdout).toContain("1200");

      const refused = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
        "--apply", receiptOf(preview.stdout),
      ]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/--force/);
      expect(await rowsIn("products")).toHaveLength(1200);

      const forced = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "category=hardware",
        "--apply", receiptOf(preview.stdout), "--force",
      ]);
      expect(forced.code).toBe(0);
      expect(await rowsIn("products")).toHaveLength(0);
    });
  });

  describe("audit", () => {
    test("records every applied change, and nothing for a preview", async () => {
      await seed([{ id: 1, name: "Keyboard", category: "hardware", price: 100 }]);
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=150", "--where", "id=1",
      ]);
      expect(await rowsIn("_audit_row_changes")).toHaveLength(1); // the insert only

      await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "price=150", "--where", "id=1",
        "--apply", receiptOf(preview.stdout),
      ]);
      const audit = await rowsIn("_audit_row_changes");
      expect(audit).toHaveLength(2);
      expect(audit[1]!.operation).toBe("update");
      expect(audit[1]!.table_name).toBe("products");
      expect(audit[1]!.affected).toBe(1);
    });
  });

  describe("filter parsing", () => {
    beforeEach(async () => {
      await seed([
        { id: 1, name: "a=b", category: "hardware", price: 10 },
        { id: 2, name: "plain", category: "hardware", price: 20 },
        { id: 3, name: "null", category: "hardware", price: 30 },
      ]);
    });

    test("picks the operator that appears first, so a value may contain '='", async () => {
      // Scanning by operator rather than by position split this on the "=",
      // leaving a column named "name~a".
      const result = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "name~a=b",
      ]);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("1 row");
    });

    test("prefers the longer operator when two start at the same place", async () => {
      const result = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "price>=20",
      ]);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("2 rows");
    });

    test("@null means SQL NULL and a bare null is the literal text", async () => {
      await runCli(project.dir, [
        "rows", "insert", ws, "products",
        "--data", JSON.stringify({ id: 4, name: "x", category: "hardware", price: 1 }),
      ]);
      const literal = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "name=null",
      ]);
      expect(literal.stdout).toContain("1 row"); // the row whose name is the text "null"

      const isNull = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "discontinued=@null",
      ]);
      expect(isNull.stdout).toContain("4 rows"); // every row, none of them flagged
    });

    test("refuses @null with an operator that cannot test null", async () => {
      const result = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "name~@null",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/cannot use "~"/);
    });

    test("writes a real NULL for --set <col>=@null", async () => {
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "discontinued=@null", "--where", "id=1",
      ]);
      await runCli(project.dir, [
        "rows", "update", ws, "products", "--set", "discontinued=@null", "--where", "id=1",
        "--apply", receiptOf(preview.stdout),
      ]);
      expect((await rowsIn("products"))[0]!.discontinued).toBeNull();
    });
  });

  describe("misplaced flags", () => {
    test("refuses a flag that does not apply, rather than ignoring it", async () => {
      // `--apply` on an insert reads as "write it"; dropping it silently would
      // confirm a belief that was never true.
      const onInsert = await runCli(project.dir, [
        "rows", "insert", ws, "products",
        "--data", JSON.stringify({ id: 1, name: "x", category: "hardware", price: 1 }),
        "--apply", "deadbeef",
      ]);
      expect(onInsert.code).toBe(1);
      expect(onInsert.stderr).toContain("--apply");
      expect(await rowsIn("products")).toHaveLength(0);

      const forced = await runCli(project.dir, [
        "rows", "insert", ws, "products",
        "--data", JSON.stringify({ id: 1, name: "x", category: "hardware", price: 1 }),
        "--force",
      ]);
      expect(forced.code).toBe(1);
      expect(forced.stderr).toContain("--force");

      const onDelete = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "id=1", "--set", "price=1",
      ]);
      expect(onDelete.code).toBe(1);
      expect(onDelete.stderr).toContain("--set");
    });
  });

  describe("audit before-image", () => {
    test("keeps what a delete removed, so the rows are recoverable", async () => {
      await seed([{ id: 1, name: "Keyboard", category: "hardware", price: 100 }]);
      const preview = await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "id=1",
      ]);
      await runCli(project.dir, [
        "rows", "delete", ws, "products", "--where", "id=1",
        "--apply", receiptOf(preview.stdout),
      ]);

      const audit = await rowsIn("_audit_row_changes");
      const entry = audit.at(-1)!;
      expect(entry.operation).toBe("delete");
      const before = JSON.parse(entry.before as string);
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]).toMatchObject({ id: 1, name: "Keyboard", price: 100 });
      expect(before.truncated).toBe(false);
    });

    test("records nothing for an insert, which removed nothing", async () => {
      await seed([{ id: 1, name: "Keyboard", category: "hardware", price: 100 }]);
      expect((await rowsIn("_audit_row_changes"))[0]!.before).toBeNull();
    });
  });

  /**
   * Generated keys and timestamps: the two things a table supplies for itself.
   * Both are schema features, so these prove the runtime does not get in their
   * way — and, for updated_at, that the trigger recipe the README gives works.
   */
  describe("generated columns", () => {
    const GENERATED = `
      CREATE TABLE events (
        id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        label      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TRIGGER events_touch AFTER UPDATE ON events
      BEGIN
        UPDATE events SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = NEW.id;
      END;
    `;

    beforeEach(() => applyMigration(project, ws, "0002_events.sql", GENERATED));

    test("--returning hands back the key the database generated", async () => {
      // Without this the caller cannot name the row it just created: a random
      // default leaves nothing to query back by.
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "events", "--data", JSON.stringify({ label: "alpha" }),
        "--returning", "--json",
      ]);
      expect(result.code).toBe(0);
      const [row] = JSON.parse(result.stdout).rows;
      expect(row.id).toMatch(/^[0-9a-f]{32}$/);
      expect(row.label).toBe("alpha");
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("returns every row of a batch, in order", async () => {
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "events",
        "--data", JSON.stringify([{ label: "a" }, { label: "b" }, { label: "c" }]),
        "--returning", "--json",
      ]);
      const { rows } = JSON.parse(result.stdout);
      expect(rows.map((r: { label: string }) => r.label)).toEqual(["a", "b", "c"]);
      expect(new Set(rows.map((r: { id: string }) => r.id)).size).toBe(3);
    });

    test("stays quiet unless asked, so a bulk load is not held twice", async () => {
      const result = await runCli(project.dir, [
        "rows", "insert", ws, "events", "--data", JSON.stringify({ label: "alpha" }), "--json",
      ]);
      expect(JSON.parse(result.stdout).rows).toBeUndefined();
    });

    test("an AFTER UPDATE trigger keeps updated_at current", async () => {
      // `rows update` deliberately does not touch a column because of its name;
      // the schema says what a column means, so the trigger is the mechanism.
      await runCli(project.dir, [
        "rows", "insert", ws, "events", "--data", JSON.stringify({ label: "alpha" }),
      ]);
      const before = (await rowsIn("events"))[0]!;

      await Bun.sleep(5);
      const preview = await runCli(project.dir, [
        "rows", "update", ws, "events", "--set", "label=beta", "--where", "label=alpha",
      ]);
      await runCli(project.dir, [
        "rows", "update", ws, "events", "--set", "label=beta", "--where", "label=alpha",
        "--apply", receiptOf(preview.stdout),
      ]);

      const after = (await rowsIn("events"))[0]!;
      expect(after.created_at).toBe(before.created_at);
      expect(after.updated_at as string > (before.updated_at as string)).toBe(true);
    });
  });

  describe("read-only path is unchanged", () => {
    test("query still refuses a write", async () => {
      const result = await runCli(project.dir, ["query", ws, "DELETE FROM products"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("read-only");
    });

    test("a constraint violation reports a message, not a driver stack trace", async () => {
      await seed([{ id: 1, name: "Keyboard", category: "hardware", price: 100 }]);
      const result = await seed([{ id: 1, name: "Duplicate", category: "hardware", price: 1 }]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("UNIQUE constraint failed");
      expect(result.stderr).not.toContain("SQLiteError");
      expect(result.stderr).not.toContain("      at ");
    });

    test("a broken query reports a message, not a driver stack trace", async () => {
      const result = await runCli(project.dir, ["query", ws, "SELECT * FROM nope"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("no such table: nope");
      expect(result.stderr).not.toContain("SQLiteError");
      expect(result.stderr).not.toContain("at ");
    });
  });
});
