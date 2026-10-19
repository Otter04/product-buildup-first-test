// Keeps the examples in README.md honest.
import { describe, expect, it } from "vitest";
import { Database, SqlConstraintError } from "../src/index.js";

describe("README examples", () => {
  it("library API walkthrough", () => {
    const db = new Database();
    db.exec(`
      CREATE TABLE users (
        id    INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name  TEXT,
        karma INTEGER DEFAULT 0 CHECK (karma >= 0)
      )
    `);
    expect(db.run("INSERT INTO users (email, name) VALUES (?, ?)", ["ada@example.com", "Ada"])).toEqual({ changes: 1, lastInsertRowId: 1 });
    expect(db.query("SELECT * FROM users WHERE karma >= :min", { min: 0 })).toEqual([{ id: 1, email: "ada@example.com", name: "Ada", karma: 0 }]);
    expect(db.get("SELECT COUNT(*) AS n FROM users")).toEqual({ n: 1 });
    const [result] = db.exec("SELECT id, name FROM users");
    expect(result!.columns).toEqual(["id", "name"]);
    expect(result!.rows).toEqual([[1, "Ada"]]);

    const upsertKarma = db.prepare(`
      INSERT INTO users (email, karma) VALUES (?, ?)
      ON CONFLICT (email) DO UPDATE SET karma = users.karma + excluded.karma
      RETURNING karma
    `);
    expect(upsertKarma.get(["ada@example.com", 5])).toEqual({ karma: 5 });

    expect(() =>
      db.transaction((tx) => {
        tx.run("UPDATE users SET karma = karma - 10 WHERE id = 1");
      }),
    ).toThrow(SqlConstraintError);
    expect(db.get("SELECT karma FROM users WHERE id = 1")).toEqual({ karma: 5 });
  });

  it("SQL reference snippets parse and run", () => {
    const db = new Database();
    db.exec(`
      CREATE TABLE sales (region TEXT, month TEXT, amount REAL);
      INSERT INTO sales VALUES ('north', '2024-01', 10), ('north', '2024-02', 20), ('north', '2024-03', 15), ('south', '2024-01', 7);
      CREATE TABLE categories (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT);
      INSERT INTO categories VALUES (1, NULL, 'root'), (2, 1, 'books'), (3, 2, 'sci-fi');
      CREATE TABLE employees (name TEXT, salary INTEGER, dept_id INTEGER);
      INSERT INTO employees VALUES ('a', 10, 1), ('b', 20, 1), ('c', 5, 2);
      CREATE TABLE inventory (sku TEXT PRIMARY KEY, qty INTEGER);
    `);
    expect(
      db.query(`SELECT month, amount,
         SUM(amount) OVER (ORDER BY month) AS running_total,
         AVG(amount) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg,
         amount - LAG(amount) OVER (ORDER BY month) AS change
         FROM sales WHERE region = 'north'`),
    ).toEqual([
      { month: "2024-01", amount: 10, running_total: 10, moving_avg: 10, change: null },
      { month: "2024-02", amount: 20, running_total: 30, moving_avg: 15, change: 10 },
      { month: "2024-03", amount: 15, running_total: 45, moving_avg: 15, change: -5 },
    ]);
    expect(
      db.query(`SELECT * FROM (
        SELECT region, month, amount, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn FROM sales
      ) ranked WHERE rn <= 1 ORDER BY region`),
    ).toEqual([
      { region: "north", month: "2024-02", amount: 20, rn: 1 },
      { region: "south", month: "2024-01", amount: 7, rn: 1 },
    ]);
    expect(
      db.query(`WITH RECURSIVE path(id, name, depth) AS (
        SELECT id, name, 0 FROM categories WHERE parent_id IS NULL
        UNION ALL
        SELECT c.id, p.name || ' / ' || c.name, p.depth + 1 FROM categories c JOIN path p ON c.parent_id = p.id
      ) SELECT name, depth FROM path ORDER BY name`),
    ).toEqual([
      { name: "root", depth: 0 },
      { name: "root / books", depth: 1 },
      { name: "root / books / sci-fi", depth: 2 },
    ]);
    expect(db.query("SELECT name FROM employees e WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id)")).toEqual([{ name: "b" }]);
    const upsert = `INSERT INTO inventory (sku, qty) VALUES ('A-1', 5)
      ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + excluded.qty RETURNING sku, qty`;
    expect(db.query(upsert)).toEqual([{ sku: "A-1", qty: 5 }]);
    expect(db.query(upsert)).toEqual([{ sku: "A-1", qty: 10 }]);
    const [dates] = db.exec("SELECT DATE('2024-01-31', '+1 month'), STRFTIME('%Y-W%W', 'now'), DATETIME('now', 'start of day')");
    expect(dates!.rows[0]![0]).toBe("2024-03-02");
    expect(dates!.rows[0]![1]).toMatch(/^\d{4}-W\d{2}$/);
    expect(dates!.rows[0]![2]).toMatch(/^\d{4}-\d{2}-\d{2} 00:00:00$/);
  });
});
