import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column } from "./helpers.js";

describe("plan caching", () => {
  it("reuses a prepared plan with different parameters", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b'), ('c');");
    const stmt = db.prepare("SELECT v FROM t WHERE id = ?");
    expect(stmt.get([1])).toEqual({ v: "a" });
    expect(stmt.get([3])).toEqual({ v: "c" });
    expect(stmt.get([9])).toBeUndefined();
    expect(() => stmt.get([])).toThrow(/Missing value for parameter 1/);
    expect(stmt.get([2])).toEqual({ v: "b" });
  });

  it("re-evaluates uncorrelated subqueries and CTEs on every execution", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
    const sub = db.prepare("SELECT (SELECT MAX(x) FROM t) AS m");
    const cte = db.prepare("WITH c AS (SELECT COUNT(*) AS n FROM t) SELECT n FROM c");
    const inList = db.prepare("SELECT COUNT(*) AS n FROM t WHERE x IN (SELECT x FROM t WHERE x > ?)");
    expect(sub.get()).toEqual({ m: 1 });
    expect(cte.get()).toEqual({ n: 1 });
    expect(inList.get([0])).toEqual({ n: 1 });
    db.exec("INSERT INTO t VALUES (5), (7)");
    expect(sub.get()).toEqual({ m: 7 });
    expect(cte.get()).toEqual({ n: 3 });
    expect(inList.get([4])).toEqual({ n: 2 });
  });

  it("re-evaluates recursive CTEs that depend on parameters", () => {
    const db = new Database();
    const stmt = db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) SELECT COUNT(*) AS c FROM n");
    expect(stmt.get([3])).toEqual({ c: 3 });
    expect(stmt.get([10])).toEqual({ c: 10 });
  });

  it("replans after the schema changes", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
    const all = db.prepare("SELECT * FROM t");
    expect(all.execute().columns).toEqual(["a"]);
    db.exec("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'x'");
    expect(all.all()).toEqual([{ a: 1, b: "x" }]);
    db.exec("DROP TABLE t; CREATE TABLE t (z REAL); INSERT INTO t VALUES (2.5);");
    expect(all.all()).toEqual([{ z: 2.5 }]);
    db.exec("DROP TABLE t");
    expect(() => all.all()).toThrow(/No such table: t/);
  });

  it("starts using a new index without becoming stale", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (k INTEGER, v TEXT)");
    for (let i = 0; i < 100; i++) db.run("INSERT INTO t VALUES (?, ?)", [i % 10, `v${i}`]);
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM t WHERE k = ?");
    expect(stmt.get([3])).toEqual({ n: 10 });
    db.exec("CREATE INDEX idx_k ON t (k)");
    expect(stmt.get([3])).toEqual({ n: 10 });
    db.exec("INSERT INTO t VALUES (3, 'extra')");
    expect(stmt.get([3])).toEqual({ n: 11 });
    db.exec("DROP INDEX idx_k");
    expect(stmt.get([3])).toEqual({ n: 11 });
  });

  it("replans after a rolled-back schema change", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);");
    const stmt = db.prepare("SELECT * FROM t");
    db.exec("BEGIN; ALTER TABLE t ADD COLUMN b INTEGER DEFAULT 2;");
    expect(stmt.all()).toEqual([{ a: 1, b: 2 }]);
    db.exec("ROLLBACK");
    expect(stmt.all()).toEqual([{ a: 1 }]);
  });

  it("caches DML plans", () => {
    const db = new Database();
    db.exec("CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER CHECK (n < 5))");
    const bump = db.prepare("INSERT INTO counters VALUES (?, 1) ON CONFLICT (name) DO UPDATE SET n = n + 1 RETURNING n");
    expect(bump.get(["a"])).toEqual({ n: 1 });
    expect(bump.get(["a"])).toEqual({ n: 2 });
    expect(bump.get(["b"])).toEqual({ n: 1 });
    const del = db.prepare("DELETE FROM counters WHERE name = ?");
    expect(del.run(["a"]).changes).toBe(1);
    expect(del.run(["a"]).changes).toBe(0);
    expect(bump.get(["a"])).toEqual({ n: 1 });
    db.exec("UPDATE counters SET n = 4");
    expect(() => bump.get(["a"])).toThrow(/CHECK constraint failed/);
  });

  it("caches statements executed through exec() by their SQL text", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER)");
    for (let i = 0; i < 50; i++) db.run("INSERT INTO t VALUES (?)", [i]);
    expect(column(db, "SELECT SUM(x) FROM t WHERE x < ?", [10])).toEqual([45]);
    expect(column(db, "SELECT SUM(x) FROM t WHERE x < ?", [5])).toEqual([10]);
    // A cached multi-statement script still runs every statement.
    const script = "INSERT INTO t VALUES (100); SELECT MAX(x) FROM t;";
    expect(db.exec(script)[1]!.rows).toEqual([[100]]);
    expect(db.exec(script)[1]!.rows).toEqual([[100]]);
    expect(column(db, "SELECT COUNT(*) FROM t WHERE x = 100")).toEqual([2]);
  });

  it("evicts old entries from the statement cache", () => {
    const db = new Database();
    for (let i = 0; i < 300; i++) expect(column(db, `SELECT ${i}`)).toEqual([i]);
    expect(column(db, "SELECT 0")).toEqual([0]);
  });

  it("rejects parameters in views", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER)");
    expect(() => db.exec("CREATE VIEW v AS SELECT x FROM t WHERE x > ?", [1])).toThrow(/Parameters are not allowed in views/);
  });
});
