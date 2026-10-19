import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column, rows, sampleDb, scalar } from "./helpers.js";

describe("subqueries", () => {
  const db = sampleDb();

  it("evaluates scalar subqueries", () => {
    expect(scalar(db, "SELECT (SELECT MAX(salary) FROM employees)")).toBe(180000);
    expect(column(db, "SELECT name FROM employees WHERE salary = (SELECT MIN(salary) FROM employees)")).toEqual(["Grace"]);
  });

  it("returns NULL for an empty scalar subquery", () => {
    expect(scalar(db, "SELECT (SELECT name FROM employees WHERE 0)")).toBeNull();
  });

  it("supports IN and NOT IN with subqueries", () => {
    expect(column(db, "SELECT name FROM departments WHERE id IN (SELECT dept_id FROM employees WHERE salary > 100000)")).toEqual(["Engineering"]);
    expect(column(db, "SELECT name FROM departments WHERE id NOT IN (SELECT dept_id FROM employees WHERE dept_id IS NOT NULL) ORDER BY name")).toEqual([
      "Legal",
    ]);
  });

  it("follows SQL semantics for NOT IN with NULLs", () => {
    // employees.dept_id contains a NULL, so NOT IN is unknown for every non-matching row.
    expect(column(db, "SELECT name FROM departments WHERE id NOT IN (SELECT dept_id FROM employees)")).toEqual([]);
  });

  it("supports correlated subqueries", () => {
    expect(
      rows(db, "SELECT d.name, (SELECT COUNT(*) FROM employees e WHERE e.dept_id = d.id) AS n FROM departments d ORDER BY n DESC, d.name"),
    ).toEqual([
      ["Engineering", 3],
      ["Sales", 2],
      ["Marketing", 1],
      ["Legal", 0],
    ]);
    // Employees earning more than their department's average.
    expect(
      column(db, "SELECT name FROM employees e WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id) ORDER BY name"),
    ).toEqual(["Alice", "Dave"]);
  });

  it("supports EXISTS and NOT EXISTS", () => {
    expect(column(db, "SELECT name FROM departments d WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id) ORDER BY name")).toEqual([
      "Engineering",
      "Marketing",
      "Sales",
    ]);
    expect(column(db, "SELECT name FROM departments d WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id)")).toEqual(["Legal"]);
  });

  it("supports doubly nested correlation", () => {
    expect(
      column(
        db,
        `SELECT d.name FROM departments d
         WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id
                       AND EXISTS (SELECT 1 FROM employees m WHERE m.id = e.manager_id AND m.dept_id = d.id))
         ORDER BY d.name`,
      ),
    ).toEqual(["Engineering", "Sales"]);
  });

  it("requires single-column subqueries where a value is expected", () => {
    expect(() => db.exec("SELECT (SELECT id, name FROM employees)")).toThrow(/exactly one column/);
    expect(() => db.exec("SELECT 1 WHERE 1 IN (SELECT id, name FROM employees)")).toThrow(/exactly one column/);
  });
});

describe("common table expressions", () => {
  const db = sampleDb();

  it("supports simple CTEs", () => {
    expect(
      rows(
        db,
        `WITH dept_totals AS (SELECT dept_id, SUM(salary) AS total FROM employees GROUP BY dept_id)
         SELECT d.name, t.total FROM dept_totals t JOIN departments d ON d.id = t.dept_id ORDER BY t.total DESC`,
      ),
    ).toEqual([
      ["Engineering", 425000],
      ["Sales", 160000],
      ["Marketing", 85000],
    ]);
  });

  it("lets later CTEs reference earlier ones", () => {
    expect(scalar(db, "WITH a AS (SELECT 2 AS x), b AS (SELECT x * 10 AS y FROM a) SELECT y FROM b")).toBe(20);
  });

  it("supports column lists on CTEs", () => {
    expect(rows(db, "WITH t(a, b) AS (SELECT 1, 2) SELECT b, a FROM t")).toEqual([[2, 1]]);
    expect(() => db.exec("WITH t(a) AS (SELECT 1, 2) SELECT * FROM t")).toThrow(/declares 1 columns/);
  });

  it("evaluates recursive CTEs", () => {
    expect(column(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n")).toEqual([1, 2, 3, 4, 5]);
  });

  it("walks hierarchies recursively", () => {
    const d = new Database();
    d.exec(`
      CREATE TABLE tree (id INTEGER PRIMARY KEY, parent INTEGER, name TEXT);
      INSERT INTO tree VALUES (1, NULL, 'root'), (2, 1, 'a'), (3, 1, 'b'), (4, 2, 'a1'), (5, 4, 'a1x');
    `);
    expect(
      rows(
        d,
        `WITH RECURSIVE path(id, name, depth) AS (
           SELECT id, name, 0 FROM tree WHERE parent IS NULL
           UNION ALL
           SELECT t.id, p.name || '/' || t.name, p.depth + 1 FROM tree t JOIN path p ON t.parent = p.id
         )
         SELECT name, depth FROM path ORDER BY name`,
      ),
    ).toEqual([
      ["root", 0],
      ["root/a", 1],
      ["root/a/a1", 2],
      ["root/a/a1/a1x", 3],
      ["root/b", 1],
    ]);
  });

  it("stops UNION recursion when no new rows appear", () => {
    const d = new Database();
    d.exec("CREATE TABLE edges (a INTEGER, b INTEGER); INSERT INTO edges VALUES (1, 2), (2, 3), (3, 1), (3, 4);");
    expect(
      column(d, "WITH RECURSIVE reach(n) AS (SELECT 1 UNION SELECT e.b FROM edges e JOIN reach r ON e.a = r.n) SELECT n FROM reach ORDER BY n"),
    ).toEqual([1, 2, 3, 4]);
  });

  it("honours LIMIT inside a recursive CTE", () => {
    expect(column(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 4) SELECT i FROM n")).toEqual([1, 2, 3, 4]);
  });

  it("detects runaway recursion", () => {
    expect(() => db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT COUNT(*) FROM n")).toThrow(/more than/);
  });

  it("evaluates subqueries inside recursive members on every iteration", () => {
    expect(
      column(db, "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE (SELECT MAX(i) FROM n) < 4) SELECT i FROM n"),
    ).toEqual([1, 2, 3, 4]);
  });
});

describe("compound queries", () => {
  const db = sampleDb();

  it("combines results", () => {
    expect(column(db, "SELECT 1 UNION SELECT 1 UNION SELECT 2 ORDER BY 1")).toEqual([1, 2]);
    expect(column(db, "SELECT 1 UNION ALL SELECT 1 UNION ALL SELECT 2")).toEqual([1, 1, 2]);
    expect(column(db, "SELECT id FROM departments INTERSECT SELECT dept_id FROM employees ORDER BY 1")).toEqual([1, 2, 3]);
    expect(column(db, "SELECT id FROM departments EXCEPT SELECT dept_id FROM employees")).toEqual([4]);
  });

  it("orders compound results by column name", () => {
    expect(column(db, "SELECT name FROM departments WHERE id < 3 UNION SELECT name FROM employees WHERE id < 3 ORDER BY name DESC")).toEqual([
      "Sales",
      "Engineering",
      "Bob",
      "Alice",
    ]);
  });

  it("requires matching column counts", () => {
    expect(() => db.exec("SELECT 1 UNION SELECT 1, 2")).toThrow(/same number of result columns/);
  });

  it("applies LIMIT to the whole compound", () => {
    expect(column(db, "SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 LIMIT 2")).toEqual([1, 2]);
  });
});
