import { describe, expect, it } from "vitest";
import { Database, SqlConstraintError } from "../src/index.js";
import { column, rows, sampleDb, scalar } from "./helpers.js";

describe("INSERT", () => {
  it("inserts with and without a column list", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER, b TEXT, c REAL DEFAULT 1.5)");
    db.exec("INSERT INTO t VALUES (1, 'x', 2)");
    db.exec("INSERT INTO t (b, a) VALUES ('y', 2)");
    expect(rows(db, "SELECT * FROM t ORDER BY a")).toEqual([
      [1, "x", 2],
      [2, "y", 1.5],
    ]);
  });

  it("reports changes and the last inserted id", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(db.run("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')")).toEqual({ changes: 3, lastInsertRowId: 3 });
    expect(db.run("INSERT INTO t (id, v) VALUES (10, 'd')").lastInsertRowId).toBe(10);
    expect(db.run("INSERT INTO t (v) VALUES ('e')").lastInsertRowId).toBe(11);
  });

  it("never reuses AUTOINCREMENT values", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    db.exec("INSERT INTO t (v) VALUES ('a'), ('b')");
    db.exec("DELETE FROM t WHERE id = 2");
    expect(db.run("INSERT INTO t (v) VALUES ('c')").lastInsertRowId).toBe(3);
  });

  it("inserts DEFAULT VALUES", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, created TEXT DEFAULT 'now', n INTEGER DEFAULT (1 + 1))");
    db.exec("INSERT INTO t DEFAULT VALUES");
    expect(rows(db, "SELECT * FROM t")).toEqual([[1, "now", 2]]);
  });

  it("inserts from a SELECT, including from the same table", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1), (2);");
    db.exec("INSERT INTO t SELECT n + 10 FROM t");
    expect(column(db, "SELECT n FROM t ORDER BY n")).toEqual([1, 2, 11, 12]);
  });

  it("coerces values to the column type", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BOOLEAN)");
    db.exec("INSERT INTO t VALUES ('42', '2.5', 7, 'yes')");
    expect(rows(db, "SELECT i, r, s, b, typeof(i), typeof(s) FROM t")).toEqual([[42, 2.5, "7", true, "integer", "text"]]);
    expect(() => db.exec("INSERT INTO t (i) VALUES ('abc')")).toThrow(/expects INTEGER/);
    expect(() => db.exec("INSERT INTO t (i) VALUES (1.5)")).toThrow(/expects INTEGER/);
    expect(() => db.exec("INSERT INTO t (b) VALUES ('maybe')")).toThrow(/expects BOOLEAN/);
  });

  it("validates value counts", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER, b INTEGER)");
    expect(() => db.exec("INSERT INTO t VALUES (1)")).toThrow(/expects 2 values/);
    expect(() => db.exec("INSERT INTO t (a, a) VALUES (1, 2)")).toThrow(/Duplicate column/);
    expect(() => db.exec("INSERT INTO t (zzz) VALUES (1)")).toThrow(/no column named 'zzz'/);
  });
});

describe("constraints", () => {
  it("enforces NOT NULL", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a TEXT NOT NULL)");
    expect(() => db.exec("INSERT INTO t VALUES (NULL)")).toThrow(SqlConstraintError);
    expect(() => db.exec("INSERT INTO t DEFAULT VALUES")).toThrow(/NOT NULL constraint failed: t.a/);
  });

  it("enforces PRIMARY KEY and UNIQUE", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    db.exec("INSERT INTO t VALUES (1, 'a@x')");
    expect(() => db.exec("INSERT INTO t VALUES (1, 'b@x')")).toThrow(/PRIMARY KEY constraint failed/);
    expect(() => db.exec("INSERT INTO t VALUES (2, 'a@x')")).toThrow(/UNIQUE constraint failed/);
    // Several NULLs never conflict.
    db.exec("INSERT INTO t VALUES (3, NULL), (4, NULL)");
    expect(scalar(db, "SELECT COUNT(*) FROM t")).toBe(3);
  });

  it("enforces composite keys", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER, b INTEGER, PRIMARY KEY (a, b))");
    db.exec("INSERT INTO t VALUES (1, 1), (1, 2), (2, 1)");
    expect(() => db.exec("INSERT INTO t VALUES (1, 2)")).toThrow(/PRIMARY KEY constraint failed: t\(a, b\)/);
    expect(() => db.exec("INSERT INTO t VALUES (NULL, 3)")).toThrow(/NOT NULL/);
  });

  it("enforces CHECK constraints", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (qty INTEGER CHECK (qty > 0), lo INTEGER, hi INTEGER CHECK (hi >= lo))");
    db.exec("INSERT INTO t VALUES (1, 1, 2)");
    db.exec("INSERT INTO t VALUES (NULL, NULL, 5)"); // NULL checks pass
    expect(() => db.exec("INSERT INTO t VALUES (0, 1, 2)")).toThrow(/CHECK constraint failed: t.qty/);
    expect(() => db.exec("INSERT INTO t VALUES (1, 5, 2)")).toThrow(/CHECK constraint failed: t.hi/);
    expect(() => db.exec("UPDATE t SET qty = -1")).toThrow(/CHECK constraint failed/);
  });

  it("enforces foreign keys on insert, update and delete", () => {
    const db = sampleDb();
    expect(() => db.exec("INSERT INTO employees (name, dept_id) VALUES ('Zed', 99)")).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.exec("UPDATE employees SET dept_id = 42 WHERE id = 1")).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("DELETE FROM departments WHERE id = 1")).toThrow(/still referenced by employees.dept_id/);
    expect(() => db.exec("UPDATE departments SET id = 100 WHERE id = 2")).toThrow(/still referenced/);
    // Unreferenced parents can be removed; NULL children are fine.
    db.exec("DELETE FROM departments WHERE id = 4");
    db.exec("INSERT INTO employees (name, dept_id) VALUES ('Nobody', NULL)");
  });

  it("allows self-referencing rows", () => {
    const db = new Database();
    db.exec("CREATE TABLE n (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES n(id))");
    db.exec("INSERT INTO n VALUES (1, 1), (2, 1)");
    expect(() => db.exec("DELETE FROM n WHERE id = 1")).toThrow(/still referenced/);
    db.exec("DELETE FROM n WHERE id = 2");
    db.exec("DELETE FROM n WHERE id = 1");
    expect(scalar(db, "SELECT COUNT(*) FROM n")).toBe(0);
  });

  it("refuses to drop a referenced table", () => {
    const db = sampleDb();
    expect(() => db.exec("DROP TABLE departments")).toThrow(/referenced by employees/);
  });
});

describe("UPDATE", () => {
  it("updates matching rows using old values", () => {
    const db = sampleDb();
    expect(db.run("UPDATE employees SET salary = salary + 1000, name = name || '!' WHERE dept_id = 2").changes).toBe(2);
    expect(rows(db, "SELECT name, salary FROM employees WHERE dept_id = 2 ORDER BY id")).toEqual([
      ["Dave!", 91000],
      ["Eve!", 71000],
    ]);
  });

  it("swaps columns atomically", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER, b INTEGER); INSERT INTO t VALUES (1, 2);");
    db.exec("UPDATE t SET a = b, b = a");
    expect(rows(db, "SELECT a, b FROM t")).toEqual([[2, 1]]);
  });

  it("updates every row without WHERE", () => {
    const db = sampleDb();
    expect(db.run("UPDATE employees SET hired = NULL").changes).toBe(7);
  });

  it("supports subqueries in SET and WHERE", () => {
    const db = sampleDb();
    db.exec("UPDATE departments SET budget = (SELECT SUM(salary) FROM employees e WHERE e.dept_id = departments.id) WHERE id IN (SELECT dept_id FROM employees)");
    expect(rows(db, "SELECT id, budget FROM departments ORDER BY id")).toEqual([
      [1, 425000],
      [2, 160000],
      [3, 85000],
      [4, null],
    ]);
  });

  it("keeps indexes in sync", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX idx_salary ON employees (salary)");
    db.exec("UPDATE employees SET salary = 1 WHERE name = 'Alice'");
    expect(column(db, "SELECT name FROM employees WHERE salary = 1")).toEqual(["Alice"]);
    expect(column(db, "SELECT name FROM employees WHERE salary = 180000")).toEqual([]);
  });

  it("is atomic when a row fails a constraint", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER CHECK (v < 3)); INSERT INTO t VALUES (1, 0), (2, 1), (3, 2);");
    expect(() => db.exec("UPDATE t SET v = v + 1")).toThrow(/CHECK/);
    expect(column(db, "SELECT v FROM t ORDER BY id")).toEqual([0, 1, 2]);
  });
});

describe("DELETE", () => {
  it("deletes matching rows", () => {
    const db = sampleDb();
    expect(db.run("DELETE FROM employees WHERE salary < 80000").changes).toBe(2);
    expect(scalar(db, "SELECT COUNT(*) FROM employees")).toBe(5);
  });

  it("deletes everything without WHERE", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);");
    expect(db.run("DELETE FROM t").changes).toBe(2);
    expect(scalar(db, "SELECT COUNT(*) FROM t")).toBe(0);
  });

  it("uses indexes to locate rows", () => {
    const db = sampleDb();
    const plan = db.exec("EXPLAIN DELETE FROM employees WHERE id = 3")[0]!.rows.map((r) => r[0]).join("\n");
    expect(plan).toMatch(/USING INDEX pk_employees/);
    db.exec("DELETE FROM employees WHERE id = 3");
    expect(column(db, "SELECT id FROM employees ORDER BY id")).toEqual([1, 2, 4, 5, 6, 7]);
  });
});
