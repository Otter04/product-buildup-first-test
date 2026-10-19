import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { rows, sampleDb, scalar } from "./helpers.js";

describe("aggregation", () => {
  const db = sampleDb();

  it("computes aggregates over the whole table", () => {
    expect(rows(db, "SELECT COUNT(*), COUNT(dept_id), SUM(salary), MIN(salary), MAX(salary) FROM employees")).toEqual([
      [7, 6, 730000, 60000, 180000],
    ]);
    expect(scalar(db, "SELECT AVG(salary) FROM employees WHERE dept_id = 1")).toBeCloseTo(141666.667, 2);
  });

  it("returns one row for aggregates over empty input", () => {
    expect(rows(db, "SELECT COUNT(*), SUM(salary), TOTAL(salary), AVG(salary), MAX(name) FROM employees WHERE 0")).toEqual([[0, null, 0, null, null]]);
  });

  it("returns no rows when grouping empty input", () => {
    expect(rows(db, "SELECT dept_id, COUNT(*) FROM employees WHERE 0 GROUP BY dept_id")).toEqual([]);
  });

  it("groups rows", () => {
    expect(rows(db, "SELECT dept_id, COUNT(*), SUM(salary) FROM employees GROUP BY dept_id ORDER BY dept_id")).toEqual([
      [null, 1, 60000],
      [1, 3, 425000],
      [2, 2, 160000],
      [3, 1, 85000],
    ]);
  });

  it("filters groups with HAVING", () => {
    expect(rows(db, "SELECT dept_id, COUNT(*) AS n FROM employees GROUP BY dept_id HAVING COUNT(*) > 1 ORDER BY n DESC")).toEqual([
      [1, 3],
      [2, 2],
    ]);
    expect(rows(db, "SELECT dept_id FROM employees GROUP BY dept_id HAVING MAX(salary) > 100000")).toEqual([[1]]);
  });

  it("groups by position and alias", () => {
    expect(rows(db, "SELECT dept_id AS d, COUNT(*) FROM employees GROUP BY 1 ORDER BY 1 LIMIT 1")).toEqual([[null, 1]]);
    expect(rows(db, "SELECT salary > 100000 AS rich, COUNT(*) FROM employees GROUP BY rich ORDER BY rich")).toEqual([
      [false, 4],
      [true, 3],
    ]);
  });

  it("groups by expressions", () => {
    expect(rows(db, "SELECT substr(hired, 1, 3) || '0s' AS decade, COUNT(*) FROM employees GROUP BY substr(hired, 1, 3) ORDER BY 1")).toEqual([
      ["2010s", 4],
      ["2020s", 3],
    ]);
  });

  it("orders by aggregates not in the select list", () => {
    expect(rows(db, "SELECT dept_id FROM employees WHERE dept_id IS NOT NULL GROUP BY dept_id ORDER BY SUM(salary) DESC")).toEqual([[1], [2], [3]]);
  });

  it("combines aggregates in expressions", () => {
    expect(scalar(db, "SELECT MAX(salary) - MIN(salary) FROM employees")).toBe(120000);
    expect(scalar(db, "SELECT ROUND(SUM(salary) * 1.0 / COUNT(*), 2) FROM employees WHERE dept_id = 2")).toBe(80000);
  });

  it("supports DISTINCT aggregates", () => {
    expect(rows(db, "SELECT COUNT(DISTINCT dept_id), COUNT(dept_id) FROM employees")).toEqual([[3, 6]]);
    const d = new Database();
    d.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (1), (2), (NULL);");
    expect(rows(d, "SELECT SUM(DISTINCT x), AVG(DISTINCT x) FROM t")).toEqual([[3, 1.5]]);
  });

  it("concatenates groups", () => {
    expect(scalar(db, "SELECT GROUP_CONCAT(name) FROM (SELECT name FROM employees WHERE dept_id = 1 ORDER BY name) t")).toBe("Alice,Bob,Carol");
    expect(scalar(db, "SELECT GROUP_CONCAT(name, ' | ') FROM (SELECT name FROM employees WHERE dept_id = 2 ORDER BY name) t")).toBe("Dave | Eve");
    expect(scalar(db, "SELECT STRING_AGG(name, '-') FROM (SELECT name FROM employees WHERE dept_id = 2 ORDER BY name) t")).toBe("Dave-Eve");
  });

  it("computes statistical aggregates", () => {
    const d = new Database();
    d.exec("CREATE TABLE t (x REAL); INSERT INTO t VALUES (2), (4), (4), (4), (5), (5), (7), (9);");
    expect(scalar(d, "SELECT STDDEV_POP(x) FROM t")).toBeCloseTo(2, 10);
    expect(scalar(d, "SELECT VAR_POP(x) FROM t")).toBeCloseTo(4, 10);
    expect(scalar(d, "SELECT VARIANCE(x) FROM t")).toBeCloseTo(32 / 7, 10);
    expect(scalar(d, "SELECT MEDIAN(x) FROM t")).toBe(4.5);
  });

  it("evaluates boolean aggregates", () => {
    expect(rows(db, "SELECT BOOL_AND(salary > 50000), BOOL_OR(salary > 150000), EVERY(salary > 100000) FROM employees")).toEqual([[true, true, false]]);
  });

  it("uses the scalar MIN/MAX when given several arguments", () => {
    expect(rows(db, "SELECT MAX(1, 5, 3), MIN('b', 'a')")).toEqual([[5, "a"]]);
  });

  it("rejects misplaced aggregates", () => {
    expect(() => db.exec("SELECT name FROM employees WHERE COUNT(*) > 1")).toThrow(/not allowed in WHERE/);
    expect(() => db.exec("SELECT SUM(COUNT(*)) FROM employees")).toThrow(/cannot be nested/);
    expect(() => db.exec("SELECT name FROM employees HAVING name = 'x'")).toThrow(/HAVING requires/);
    expect(() => db.exec("SELECT dept_id FROM employees GROUP BY COUNT(*)")).toThrow(/not allowed in GROUP BY/);
  });
});
