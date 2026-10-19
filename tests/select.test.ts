import { describe, expect, it } from "vitest";
import { Database, SqlCatalogError } from "../src/index.js";
import { column, rows, sampleDb, scalar } from "./helpers.js";

describe("SELECT basics", () => {
  const db = sampleDb();

  it("selects without FROM", () => {
    expect(rows(db, "SELECT 1, 'two', NULL, TRUE")).toEqual([[1, "two", null, true]]);
  });

  it("expands * and table.*", () => {
    const r = db.exec("SELECT * FROM departments WHERE id = 1")[0]!;
    expect(r.columns).toEqual(["id", "name", "budget"]);
    expect(r.rows).toEqual([[1, "Engineering", 1000000]]);
    const j = db.exec("SELECT d.*, e.name FROM departments d JOIN employees e ON e.dept_id = d.id WHERE e.id = 1")[0]!;
    expect(j.columns).toEqual(["id", "name", "budget", "name"]);
  });

  it("names columns by alias, column name or expression text", () => {
    expect(db.exec("SELECT name AS n, salary, salary * 2, upper(name) FROM employees LIMIT 1")[0]!.columns).toEqual([
      "n",
      "salary",
      "salary * 2",
      "upper(name)",
    ]);
  });

  it("filters with WHERE", () => {
    expect(column(db, "SELECT name FROM employees WHERE salary > 100000 ORDER BY name")).toEqual(["Alice", "Bob", "Carol"]);
    expect(column(db, "SELECT name FROM employees WHERE dept_id IS NULL")).toEqual(["Grace"]);
    expect(column(db, "SELECT name FROM employees WHERE name LIKE '%a%' ORDER BY name")).toEqual(["Alice", "Carol", "Dave", "Frank", "Grace"]);
    expect(column(db, "SELECT name FROM employees WHERE salary BETWEEN 70000 AND 90000 ORDER BY salary")).toEqual(["Eve", "Frank", "Dave"]);
    expect(column(db, "SELECT name FROM employees WHERE id IN (2, 4, 99) ORDER BY id")).toEqual(["Bob", "Dave"]);
  });

  it("orders by multiple keys, directions and NULL placement", () => {
    expect(column(db, "SELECT name FROM departments ORDER BY budget")).toEqual(["Legal", "Marketing", "Sales", "Engineering"]);
    expect(column(db, "SELECT name FROM departments ORDER BY budget DESC")).toEqual(["Engineering", "Sales", "Marketing", "Legal"]);
    expect(column(db, "SELECT name FROM departments ORDER BY budget NULLS LAST")).toEqual(["Marketing", "Sales", "Engineering", "Legal"]);
    expect(column(db, "SELECT name FROM departments ORDER BY budget DESC NULLS FIRST")).toEqual(["Legal", "Engineering", "Sales", "Marketing"]);
    expect(column(db, "SELECT name FROM employees ORDER BY dept_id DESC, salary")).toEqual(["Frank", "Eve", "Dave", "Bob", "Carol", "Alice", "Grace"]);
  });

  it("orders by alias, position and non-selected expressions", () => {
    expect(column(db, "SELECT name, salary / 1000 AS k FROM employees ORDER BY k DESC LIMIT 2")).toEqual(["Alice", "Carol"]);
    expect(column(db, "SELECT name, salary FROM employees ORDER BY 2 LIMIT 2")).toEqual(["Grace", "Eve"]);
    expect(column(db, "SELECT name FROM employees ORDER BY length(name) DESC, name LIMIT 3")).toEqual(["Alice", "Carol", "Frank"]);
  });

  it("applies LIMIT and OFFSET", () => {
    expect(column(db, "SELECT id FROM employees ORDER BY id LIMIT 3 OFFSET 2")).toEqual([3, 4, 5]);
    expect(column(db, "SELECT id FROM employees ORDER BY id LIMIT 2, 2")).toEqual([3, 4]);
    expect(column(db, "SELECT id FROM employees ORDER BY id OFFSET 5")).toEqual([6, 7]);
    expect(column(db, "SELECT id FROM employees LIMIT 0")).toEqual([]);
    expect(column(db, "SELECT id FROM employees ORDER BY id LIMIT ?", [1])).toEqual([1]);
  });

  it("removes duplicates with DISTINCT", () => {
    expect(column(db, "SELECT DISTINCT dept_id FROM employees ORDER BY dept_id")).toEqual([null, 1, 2, 3]);
  });

  it("supports VALUES as a table expression", () => {
    const r = db.exec("SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v WHERE column1 > 1")[0]!;
    expect(r.columns).toEqual(["column1", "column2"]);
    expect(r.rows).toEqual([[2, "b"]]);
  });

  it("supports derived tables", () => {
    expect(rows(db, "SELECT x.d, x.n FROM (SELECT dept_id d, COUNT(*) n FROM employees GROUP BY dept_id) x WHERE x.n > 1 ORDER BY x.d")).toEqual([
      [1, 3],
      [2, 2],
    ]);
  });

  it("evaluates CASE expressions", () => {
    expect(
      column(db, "SELECT CASE WHEN salary >= 120000 THEN 'high' WHEN salary >= 80000 THEN 'mid' ELSE 'low' END FROM employees ORDER BY id"),
    ).toEqual(["high", "high", "high", "mid", "low", "mid", "low"]);
    expect(column(db, "SELECT CASE dept_id WHEN 1 THEN 'eng' WHEN 2 THEN 'sales' END FROM employees WHERE id IN (1, 4, 6) ORDER BY id")).toEqual([
      "eng",
      "sales",
      null,
    ]);
  });

  it("binds positional and named parameters", () => {
    expect(column(db, "SELECT name FROM employees WHERE salary > ? AND dept_id = ? ORDER BY name", [100000, 1])).toEqual(["Alice", "Bob", "Carol"]);
    expect(column(db, "SELECT name FROM employees WHERE name = :name", { name: "Eve" })).toEqual(["Eve"]);
    expect(column(db, "SELECT name FROM employees WHERE name = $name", { $name: "Eve" })).toEqual(["Eve"]);
    expect(() => db.exec("SELECT ?", [])).toThrow(/Missing value for parameter 1/);
  });

  it("reports unknown tables and columns", () => {
    expect(() => db.exec("SELECT * FROM nope")).toThrow(SqlCatalogError);
    expect(() => db.exec("SELECT nope FROM employees")).toThrow(/No such column: nope/);
    expect(() => db.exec("SELECT x.name FROM employees")).toThrow(/No such table or alias: x/);
    expect(() => db.exec("SELECT name FROM employees e JOIN departments d ON 1")).toThrow(/Ambiguous column name: name/);
  });

  it("is case-insensitive for identifiers", () => {
    expect(scalar(db, "SELECT COUNT(*) FROM EMPLOYEES WHERE Dept_Id = 1")).toBe(3);
  });

  it("supports quoted identifiers with spaces", () => {
    const d = new Database();
    d.exec(`CREATE TABLE "my table" ("first name" TEXT); INSERT INTO "my table" VALUES ('x');`);
    expect(d.query(`SELECT "first name" FROM "my table"`)).toEqual([{ "first name": "x" }]);
  });
});

describe("expressions", () => {
  const db = new Database();
  const value = (expr: string) => scalar(db, `SELECT ${expr}`);

  it("does arithmetic", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("7 / 2")).toBe(3.5);
    expect(value("7 % 3")).toBe(1);
    expect(value("-(2 - 5)")).toBe(3);
    expect(value("1 / 0")).toBeNull();
    expect(value("'3' + 4")).toBe(7);
  });

  it("propagates NULL through operators", () => {
    expect(value("NULL + 1")).toBeNull();
    expect(value("NULL = NULL")).toBeNull();
    expect(value("NULL || 'x'")).toBeNull();
  });

  it("implements three-valued logic", () => {
    expect(value("NULL AND FALSE")).toBe(false);
    expect(value("NULL AND TRUE")).toBeNull();
    expect(value("NULL OR TRUE")).toBe(true);
    expect(value("NULL OR FALSE")).toBeNull();
    expect(value("NOT NULL")).toBeNull();
    expect(value("1 IN (2, NULL)")).toBeNull();
    expect(value("1 NOT IN (2, NULL)")).toBeNull();
    expect(value("1 IN (1, NULL)")).toBe(true);
  });

  it("compares values", () => {
    expect(value("'abc' < 'abd'")).toBe(true);
    expect(value("10 = '10'")).toBe(true);
    expect(value("2 <> 3")).toBe(true);
    expect(value("2 != 2")).toBe(false);
  });

  it("supports IS, IS NOT, IS TRUE and IS FALSE", () => {
    expect(value("NULL IS NULL")).toBe(true);
    expect(value("1 IS NOT NULL")).toBe(true);
    expect(value("NULL IS NOT 1")).toBe(true);
    expect(value("NULL IS NULL")).toBe(true);
    expect(value("2 IS 2")).toBe(true);
    expect(value("NULL IS TRUE")).toBe(false);
    expect(value("NULL IS FALSE")).toBe(false);
    expect(value("NULL IS NOT TRUE")).toBe(true);
    expect(value("0 IS FALSE")).toBe(true);
  });

  it("concatenates strings", () => {
    expect(value("'a' || 'b' || 1")).toBe("ab1");
  });

  it("matches LIKE patterns case-insensitively", () => {
    expect(value("'Hello' LIKE 'h%'")).toBe(true);
    expect(value("'Hello' LIKE 'h_llo'")).toBe(true);
    expect(value("'Hello' LIKE 'h_lo'")).toBe(false);
    expect(value("'a.b' LIKE 'a.b'")).toBe(true);
    expect(value("'axb' LIKE 'a.b'")).toBe(false);
    expect(value("'Hello' NOT LIKE '%z%'")).toBe(true);
  });

  it("casts between types", () => {
    expect(value("CAST('42' AS INTEGER)")).toBe(42);
    expect(value("CAST(3.9 AS INTEGER)")).toBe(3);
    expect(value("CAST(12 AS TEXT)")).toBe("12");
    expect(value("CAST('2.5' AS REAL)")).toBe(2.5);
    expect(value("CAST(1 AS BOOLEAN)")).toBe(true);
    expect(value("CAST(NULL AS INTEGER)")).toBeNull();
  });
});

describe("result aliases inside expressions", () => {
  const db = sampleDb();

  it("can be used in ORDER BY expressions", () => {
    expect(
      rows(db, "SELECT name, salary / 1000 AS k, dept_id * 10 AS d FROM employees WHERE dept_id IS NOT NULL ORDER BY d - k LIMIT 2"),
    ).toEqual([
      ["Alice", 180, 10],
      ["Carol", 125, 10],
    ]);
  });

  it("can be used in HAVING", () => {
    expect(rows(db, "SELECT dept_id, COUNT(*) AS n FROM employees GROUP BY dept_id HAVING n > 1 ORDER BY dept_id")).toEqual([
      [1, 3],
      [2, 2],
    ]);
    expect(rows(db, "SELECT dept_id, SUM(salary) AS total FROM employees GROUP BY dept_id HAVING total / 2 > 100000")).toEqual([[1, 425000]]);
  });

  it("prefers input columns over aliases with the same name", () => {
    // `salary` inside the expression is the column, not the alias.
    expect(column(db, "SELECT name, -salary AS salary FROM employees ORDER BY salary + 0 LIMIT 1")).toEqual(["Grace"]);
  });
});
