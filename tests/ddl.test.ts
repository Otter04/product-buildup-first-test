import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column, rows, sampleDb } from "./helpers.js";

describe("CREATE / DROP TABLE", () => {
  it("creates tables and rejects duplicates", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER)");
    expect(() => db.exec("CREATE TABLE t (a INTEGER)")).toThrow(/already exists/);
    db.exec("CREATE TABLE IF NOT EXISTS t (b TEXT)");
    expect(db.columns("t").map((c) => c.name)).toEqual(["a"]);
  });

  it("rejects duplicate columns and multiple primary keys", () => {
    const db = new Database();
    expect(() => db.exec("CREATE TABLE t (a INTEGER, A TEXT)")).toThrow(/Duplicate column name/);
    expect(() => db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, PRIMARY KEY (b))")).toThrow(/more than one primary key/);
  });

  it("creates tables from queries", () => {
    const db = sampleDb();
    db.exec("CREATE TABLE eng AS SELECT name, salary FROM employees WHERE dept_id = 1");
    expect(rows(db, "SELECT name FROM eng ORDER BY salary DESC")).toEqual([["Alice"], ["Carol"], ["Bob"]]);
  });

  it("drops tables", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (a INTEGER); DROP TABLE t;");
    expect(db.tables()).toEqual([]);
    expect(() => db.exec("DROP TABLE t")).toThrow(/No such table/);
    db.exec("DROP TABLE IF EXISTS t");
  });

  it("lists tables and describes columns", () => {
    const db = sampleDb();
    expect(rows(db, "SHOW TABLES")).toEqual([
      ["departments", 3, 4],
      ["employees", 6, 7],
    ]);
    expect(rows(db, "DESCRIBE employees").slice(0, 3)).toEqual([
      ["id", "INTEGER", "NO", "PRI", null, "autoincrement"],
      ["name", "TEXT", "NO", "", null, ""],
      ["dept_id", "INTEGER", "YES", "", null, "references departments(id)"],
    ]);
  });
});

describe("indexes", () => {
  it("creates, uses and drops indexes", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX idx_emp_dept ON employees (dept_id, salary)");
    const plan = db.exec("EXPLAIN SELECT name FROM employees WHERE dept_id = 1 AND salary > 121000")[0]!.rows.flat().join("\n");
    expect(plan).toMatch(/SEARCH employees USING INDEX idx_emp_dept \(dept_id=\? AND salary>\?\)/);
    expect(column(db, "SELECT name FROM employees WHERE dept_id = 1 AND salary > 121000 ORDER BY name")).toEqual(["Alice", "Carol"]);
    db.exec("DROP INDEX idx_emp_dept");
    expect(db.exec("EXPLAIN SELECT name FROM employees WHERE dept_id = 1")[0]!.rows.flat().join("\n")).toMatch(/SCAN employees/);
  });

  it("rejects duplicate index names and constraint index drops", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX i1 ON employees (name)");
    expect(() => db.exec("CREATE INDEX i1 ON employees (salary)")).toThrow(/already exists/);
    db.exec("CREATE INDEX IF NOT EXISTS i1 ON employees (salary)");
    expect(() => db.exec("DROP INDEX pk_employees")).toThrow(/backs a constraint/);
  });

  it("validates existing data when creating a unique index", () => {
    const db = sampleDb();
    expect(() => db.exec("CREATE UNIQUE INDEX u ON employees (dept_id)")).toThrow(/duplicate value/);
    db.exec("CREATE UNIQUE INDEX u ON employees (name)");
    expect(() => db.exec("INSERT INTO employees (name) VALUES ('Alice')")).toThrow(/UNIQUE constraint failed/);
  });

  it("serves IN lists and BETWEEN through indexes", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX idx_sal ON employees (salary)");
    const explain = (sql: string) => db.exec(`EXPLAIN ${sql}`)[0]!.rows.flat().join("\n");
    expect(explain("SELECT * FROM employees WHERE id IN (1, 3)")).toMatch(/pk_employees \(id IN \(2 values\)\)/);
    expect(explain("SELECT * FROM employees WHERE salary BETWEEN 1 AND 2")).toMatch(/idx_sal \(salary>=\? AND salary<=\?\)/);
    expect(column(db, "SELECT id FROM employees WHERE id IN (3, 1, 3) ORDER BY id")).toEqual([1, 3]);
    expect(column(db, "SELECT name FROM employees WHERE salary BETWEEN 70000 AND 90000 ORDER BY salary")).toEqual(["Eve", "Frank", "Dave"]);
    expect(column(db, "SELECT name FROM employees WHERE 85000 < salary AND salary <= 120000 ORDER BY salary")).toEqual(["Dave", "Bob"]);
  });

  it("falls back to scanning when probe values do not match the column type", () => {
    const db = sampleDb();
    // '2' is compared numerically with INTEGER ids.
    expect(column(db, "SELECT name FROM employees WHERE id = '2'")).toEqual(["Bob"]);
    expect(column(db, "SELECT name FROM employees WHERE id = 'abc'")).toEqual([]);
    expect(column(db, "SELECT name FROM employees WHERE id = NULL")).toEqual([]);
  });
});

describe("ALTER TABLE", () => {
  it("adds columns with defaults", () => {
    const db = sampleDb();
    db.exec("ALTER TABLE departments ADD COLUMN floor INTEGER DEFAULT 1");
    expect(column(db, "SELECT floor FROM departments")).toEqual([1, 1, 1, 1]);
    db.exec("INSERT INTO departments (id, name) VALUES (5, 'Ops')");
    expect(column(db, "SELECT floor FROM departments WHERE id = 5")).toEqual([1]);
    expect(() => db.exec("ALTER TABLE departments ADD COLUMN x TEXT NOT NULL")).toThrow(/without a non-NULL default/);
    expect(() => db.exec("ALTER TABLE departments ADD COLUMN name TEXT")).toThrow(/already exists/);
  });

  it("drops columns", () => {
    const db = sampleDb();
    db.exec("ALTER TABLE employees DROP COLUMN hired");
    expect(db.columns("employees").map((c) => c.name)).not.toContain("hired");
    expect(rows(db, "SELECT * FROM employees WHERE id = 1")).toEqual([[1, "Alice", 1, 180000, null]]);
    expect(() => db.exec("ALTER TABLE employees DROP COLUMN id")).toThrow(/used by index/);
    expect(() => db.exec("ALTER TABLE departments DROP COLUMN id")).toThrow(/used by index|referenced by/);
  });

  it("renames columns, updating indexes, checks and references", () => {
    const db = sampleDb();
    db.exec("ALTER TABLE employees RENAME COLUMN salary TO pay");
    expect(column(db, "SELECT pay FROM employees WHERE id = 1")).toEqual([180000]);
    expect(() => db.exec("UPDATE employees SET pay = -1 WHERE id = 1")).toThrow(/CHECK constraint failed/);
    db.exec("ALTER TABLE departments RENAME COLUMN id TO dept_no");
    expect(() => db.exec("INSERT INTO employees (name, dept_id) VALUES ('X', 77)")).toThrow(/FOREIGN KEY/);
    db.exec("INSERT INTO employees (name, dept_id) VALUES ('Y', 1)");
  });

  it("renames tables, updating references", () => {
    const db = sampleDb();
    db.exec("ALTER TABLE departments RENAME TO teams");
    expect(db.tables()).toEqual(["employees", "teams"]);
    expect(() => db.exec("INSERT INTO employees (name, dept_id) VALUES ('X', 77)")).toThrow(/FOREIGN KEY/);
    expect(db.schema()).toMatch(/REFERENCES teams\(id\)/);
  });

  it("rolls back schema changes in transactions", () => {
    const db = sampleDb();
    db.exec("BEGIN; ALTER TABLE employees DROP COLUMN hired; ALTER TABLE departments RENAME TO teams; ROLLBACK;");
    expect(db.tables()).toEqual(["departments", "employees"]);
    expect(db.columns("employees").map((c) => c.name)).toContain("hired");
    expect(column(db, "SELECT hired FROM employees WHERE id = 1")).toEqual(["2015-03-01"]);
  });
});
