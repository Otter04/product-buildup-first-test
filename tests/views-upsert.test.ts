import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column, rows, sampleDb, scalar } from "./helpers.js";

describe("views", () => {
  it("can be queried like tables", () => {
    const db = sampleDb();
    db.exec(`
      CREATE VIEW payroll AS
        SELECT d.name AS dept, COUNT(*) AS headcount, SUM(e.salary) AS total
        FROM employees e JOIN departments d ON d.id = e.dept_id
        GROUP BY d.name
    `);
    expect(rows(db, "SELECT dept, total FROM payroll WHERE headcount > 1 ORDER BY total DESC")).toEqual([
      ["Engineering", 425000],
      ["Sales", 160000],
    ]);
    expect(rows(db, "SELECT p.dept, d.budget FROM payroll p JOIN departments d ON d.name = p.dept WHERE p.dept = 'Sales'")).toEqual([["Sales", 250000]]);
  });

  it("reflects later changes to the underlying tables", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); CREATE VIEW big AS SELECT x FROM t WHERE x > 10;");
    expect(column(db, "SELECT * FROM big")).toEqual([]);
    db.exec("INSERT INTO t VALUES (5), (50)");
    expect(column(db, "SELECT * FROM big")).toEqual([50]);
  });

  it("supports column lists and views over views", () => {
    const db = new Database();
    db.exec(`
      CREATE TABLE t (a INTEGER, b INTEGER);
      INSERT INTO t VALUES (1, 2), (3, 4);
      CREATE VIEW v1 (first, second) AS SELECT a, b FROM t;
      CREATE VIEW v2 AS SELECT first + second AS s FROM v1;
    `);
    expect(column(db, "SELECT s FROM v2 ORDER BY s")).toEqual([3, 7]);
    expect(() => db.exec("CREATE VIEW bad (x) AS SELECT a, b FROM t")).toThrow(/declares 1 columns/);
  });

  it("does not see the caller's CTEs", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1); CREATE VIEW v AS SELECT x FROM t;");
    expect(column(db, "WITH t AS (SELECT 99 AS x) SELECT x FROM v")).toEqual([1]);
  });

  it("is read-only and shares the table namespace", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); CREATE VIEW v AS SELECT x FROM t;");
    expect(() => db.exec("INSERT INTO v VALUES (1)")).toThrow(/is a view, not a table/);
    expect(() => db.exec("CREATE TABLE v (y INTEGER)")).toThrow(/view named 'v' already exists/);
    expect(() => db.exec("CREATE VIEW t AS SELECT 1")).toThrow(/already exists/);
    expect(() => db.exec("DROP TABLE v")).toThrow(/use DROP VIEW/);
    db.exec("DROP VIEW v");
    expect(() => db.exec("SELECT * FROM v")).toThrow(/No such table: v/);
    db.exec("DROP VIEW IF EXISTS v");
  });

  it("cannot be defined in terms of missing or later objects", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); CREATE VIEW a AS SELECT x FROM t; CREATE VIEW b AS SELECT x FROM a;");
    db.exec("DROP VIEW a");
    // Validation at creation time means a view can never (transitively) refer to itself.
    expect(() => db.exec("CREATE VIEW a AS SELECT x FROM b")).toThrow(/No such table: a/);
  });

  it("appears in SHOW TABLES, DESCRIBE, schema and dumps", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1); CREATE VIEW v (doubled) AS SELECT x * 2 FROM t;");
    expect(rows(db, "SHOW TABLES")).toEqual([
      ["t", "table", 1, 1],
      ["v", "view", 1, null],
    ]);
    expect(rows(db, "DESCRIBE v")).toEqual([["doubled", "ANY", "YES", "", null, "view column"]]);
    expect(db.schema()).toContain("CREATE VIEW v (doubled) AS SELECT x * 2 FROM t;");
    const copy = new Database();
    copy.exec(db.dump());
    expect(column(copy, "SELECT doubled FROM v")).toEqual([2]);
    expect(column(Database.fromJSON(db.toJSON()), "SELECT doubled FROM v")).toEqual([2]);
    expect(db.views()).toEqual(["v"]);
  });

  it("rolls back view creation", () => {
    const db = new Database();
    db.exec("BEGIN; CREATE VIEW v AS SELECT 1 AS one; ROLLBACK;");
    expect(db.views()).toEqual([]);
  });
});

describe("RETURNING", () => {
  it("returns inserted rows including generated keys and defaults", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, created TEXT DEFAULT 'today')");
    const r = db.exec("INSERT INTO t (name) VALUES ('a'), ('b') RETURNING id, name, created")[0]!;
    expect(r.columns).toEqual(["id", "name", "created"]);
    expect(r.rows).toEqual([
      [1, "a", "today"],
      [2, "b", "today"],
    ]);
    expect(r.changes).toBe(2);
  });

  it("returns updated rows with expressions and *", () => {
    const db = sampleDb();
    const r = db.exec("UPDATE employees SET salary = salary + 1 WHERE dept_id = 2 RETURNING name, salary * 2 AS doubled")[0]!;
    expect(r.columns).toEqual(["name", "doubled"]);
    expect(r.rows).toEqual([
      ["Dave", 180002],
      ["Eve", 140002],
    ]);
    expect(db.exec("UPDATE departments SET budget = 1 WHERE id = 4 RETURNING *")[0]!.rows).toEqual([[4, "Legal", 1]]);
  });

  it("returns deleted rows", () => {
    const db = sampleDb();
    expect(db.query("DELETE FROM employees WHERE salary < 70000 RETURNING id, name")).toEqual([{ id: 7, name: "Grace" }]);
    expect(scalar(db, "SELECT COUNT(*) FROM employees")).toBe(6);
  });

  it("supports subqueries in RETURNING", () => {
    const db = sampleDb();
    expect(
      db.query("UPDATE employees SET salary = salary WHERE id = 2 RETURNING name, (SELECT name FROM departments d WHERE d.id = employees.dept_id) AS dept"),
    ).toEqual([{ name: "Bob", dept: "Engineering" }]);
  });

  it("works with prepared statements", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?) RETURNING id");
    expect(insert.get(["x"])).toEqual({ id: 1 });
    expect(insert.get(["y"])).toEqual({ id: 2 });
  });
});

describe("ON CONFLICT (upsert)", () => {
  function kv(): Database {
    const db = new Database();
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER, hits INTEGER DEFAULT 0, note TEXT UNIQUE)");
    db.exec("INSERT INTO kv (k, v, note) VALUES ('a', 1, 'n1'), ('b', 2, 'n2')");
    return db;
  }

  it("ignores conflicting rows with DO NOTHING", () => {
    const db = kv();
    const r = db.run("INSERT INTO kv (k, v) VALUES ('a', 100), ('c', 3) ON CONFLICT DO NOTHING");
    expect(r.changes).toBe(1);
    expect(rows(db, "SELECT k, v FROM kv ORDER BY k")).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    // Without a target, DO NOTHING covers every unique constraint.
    db.exec("INSERT INTO kv (k, v, note) VALUES ('z', 0, 'n1') ON CONFLICT DO NOTHING");
    expect(scalar(db, "SELECT COUNT(*) FROM kv")).toBe(3);
  });

  it("updates the existing row with DO UPDATE and excluded", () => {
    const db = kv();
    db.exec("INSERT INTO kv (k, v) VALUES ('a', 10), ('d', 4) ON CONFLICT (k) DO UPDATE SET v = excluded.v, hits = kv.hits + 1");
    expect(rows(db, "SELECT k, v, hits FROM kv ORDER BY k")).toEqual([
      ["a", 10, 1],
      ["b", 2, 0],
      ["d", 4, 0],
    ]);
  });

  it("applies the DO UPDATE WHERE filter", () => {
    const db = kv();
    const r = db.run("INSERT INTO kv (k, v) VALUES ('a', 0), ('b', 99) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE excluded.v > kv.v");
    expect(r.changes).toBe(1);
    expect(rows(db, "SELECT k, v FROM kv ORDER BY k")).toEqual([
      ["a", 1],
      ["b", 99],
    ]);
  });

  it("handles conflicts between rows of the same statement", () => {
    const db = kv();
    db.exec("INSERT INTO kv (k, v) VALUES ('x', 1), ('x', 2), ('x', 3) ON CONFLICT (k) DO UPDATE SET v = kv.v + excluded.v");
    expect(scalar(db, "SELECT v FROM kv WHERE k = 'x'")).toBe(6);
  });

  it("still enforces constraints the target does not name", () => {
    const db = kv();
    expect(() => db.exec("INSERT INTO kv (k, v, note) VALUES ('new', 1, 'n1') ON CONFLICT (k) DO NOTHING")).toThrow(/UNIQUE constraint failed/);
    expect(() => db.exec("INSERT INTO kv (k, v) VALUES ('a', NULL) ON CONFLICT (v) DO NOTHING")).toThrow(/does not match any PRIMARY KEY or UNIQUE/);
    expect(() => db.exec("INSERT INTO kv (k) VALUES ('a') ON CONFLICT DO UPDATE SET v = 1")).toThrow(/requires a conflict target/);
  });

  it("returns upserted rows", () => {
    const db = kv();
    expect(db.query("INSERT INTO kv (k, v) VALUES ('a', 5), ('e', 6) ON CONFLICT (k) DO UPDATE SET v = excluded.v * 10 RETURNING k, v")).toEqual([
      { k: "a", v: 50 },
      { k: "e", v: 6 },
    ]);
  });

  it("works with composite unique keys", () => {
    const db = new Database();
    db.exec("CREATE TABLE scores (player TEXT, game TEXT, best INTEGER, UNIQUE (player, game))");
    const record = db.prepare("INSERT INTO scores VALUES (?, ?, ?) ON CONFLICT (game, player) DO UPDATE SET best = MAX(best, excluded.best)");
    record.run(["ann", "chess", 10]);
    record.run(["ann", "chess", 7]);
    record.run(["ann", "go", 3]);
    record.run(["ann", "chess", 12]);
    expect(rows(db, "SELECT game, best FROM scores ORDER BY game")).toEqual([
      ["chess", 12],
      ["go", 3],
    ]);
  });
});

describe("LIKE ESCAPE and GLOB", () => {
  const db = new Database();
  const value = (expr: string) => scalar(db, `SELECT ${expr}`);

  it("escapes LIKE wildcards", () => {
    expect(value("'100%' LIKE '100!%' ESCAPE '!'")).toBe(true);
    expect(value("'1000' LIKE '100!%' ESCAPE '!'")).toBe(false);
    expect(value("'a_b' LIKE 'a\\_b' ESCAPE '\\'")).toBe(true);
    expect(value("'axb' LIKE 'a\\_b' ESCAPE '\\'")).toBe(false);
    expect(() => value("'x' LIKE 'x' ESCAPE 'ab'")).toThrow(/single character/);
  });

  it("matches GLOB patterns case-sensitively", () => {
    expect(value("'hello.txt' GLOB '*.txt'")).toBe(true);
    expect(value("'Hello' GLOB 'h*'")).toBe(false);
    expect(value("'cat' GLOB 'c?t'")).toBe(true);
    expect(value("'cut' GLOB 'c[aeiou]t'")).toBe(true);
    expect(value("'cxt' GLOB 'c[aeiou]t'")).toBe(false);
    expect(value("'c5t' GLOB 'c[0-9]t'")).toBe(true);
    expect(value("'cat' GLOB 'c[^a]t'")).toBe(false);
    expect(value("'a]' GLOB 'a[]]'")).toBe(true);
    expect(value("'x' NOT GLOB 'y'")).toBe(true);
  });
});
