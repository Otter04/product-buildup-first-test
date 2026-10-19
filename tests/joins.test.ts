import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { rows, sampleDb } from "./helpers.js";

describe("joins", () => {
  const db = sampleDb();

  it("performs inner joins", () => {
    expect(
      rows(db, "SELECT e.name, d.name FROM employees e JOIN departments d ON d.id = e.dept_id WHERE d.name = 'Sales' ORDER BY e.name"),
    ).toEqual([
      ["Dave", "Sales"],
      ["Eve", "Sales"],
    ]);
  });

  it("keeps unmatched left rows in LEFT JOIN", () => {
    expect(rows(db, "SELECT e.name, d.name FROM employees e LEFT JOIN departments d ON d.id = e.dept_id WHERE e.name IN ('Grace', 'Alice') ORDER BY e.name")).toEqual([
      ["Alice", "Engineering"],
      ["Grace", null],
    ]);
  });

  it("keeps unmatched right rows in RIGHT JOIN", () => {
    expect(rows(db, "SELECT d.name, COUNT(e.id) FROM employees e RIGHT JOIN departments d ON d.id = e.dept_id GROUP BY d.name ORDER BY d.name")).toEqual([
      ["Engineering", 3],
      ["Legal", 0],
      ["Marketing", 1],
      ["Sales", 2],
    ]);
  });

  it("keeps both sides in FULL OUTER JOIN", () => {
    const r = rows(db, "SELECT e.name, d.name FROM employees e FULL JOIN departments d ON d.id = e.dept_id WHERE e.name IS NULL OR d.name IS NULL");
    expect(r).toEqual(
      expect.arrayContaining([
        ["Grace", null],
        [null, "Legal"],
      ]),
    );
    expect(r).toHaveLength(2);
  });

  it("produces cartesian products", () => {
    expect(rows(db, "SELECT COUNT(*) FROM departments CROSS JOIN departments d2")).toEqual([[16]]);
    expect(rows(db, "SELECT COUNT(*) FROM departments a, departments b WHERE a.id < b.id")).toEqual([[6]]);
  });

  it("supports self joins", () => {
    expect(rows(db, "SELECT e.name, m.name FROM employees e JOIN employees m ON m.id = e.manager_id ORDER BY e.name")).toEqual([
      ["Bob", "Alice"],
      ["Carol", "Alice"],
      ["Eve", "Dave"],
    ]);
  });

  it("joins three tables", () => {
    expect(
      rows(
        db,
        `SELECT e.name, m.name, d.name
         FROM employees e
         LEFT JOIN employees m ON m.id = e.manager_id
         JOIN departments d ON d.id = e.dept_id
         WHERE d.id = 2 ORDER BY e.name`,
      ),
    ).toEqual([
      ["Dave", null, "Sales"],
      ["Eve", "Dave", "Sales"],
    ]);
  });

  it("supports JOIN ... USING", () => {
    const d = new Database();
    d.exec(`
      CREATE TABLE a (id INTEGER, x TEXT);
      CREATE TABLE b (id INTEGER, y TEXT);
      INSERT INTO a VALUES (1, 'a1'), (2, 'a2');
      INSERT INTO b VALUES (2, 'b2'), (3, 'b3');
    `);
    expect(rows(d, "SELECT x, y FROM a JOIN b USING (id)")).toEqual([["a2", "b2"]]);
  });

  it("keeps ON filters on the null-supplying side inside the join", () => {
    // The filter on d.budget must not remove employees whose department fails it.
    expect(
      rows(db, "SELECT e.name, d.name FROM employees e LEFT JOIN departments d ON d.id = e.dept_id AND d.budget > 200000 WHERE e.dept_id = 3"),
    ).toEqual([["Frank", null]]);
    // ...but a WHERE filter on the same column does remove them.
    expect(rows(db, "SELECT e.name FROM employees e LEFT JOIN departments d ON d.id = e.dept_id WHERE d.budget > 200000 AND e.dept_id = 3")).toEqual([]);
  });

  it("keeps ON filters on the preserved side from dropping rows", () => {
    expect(rows(db, "SELECT e.name, d.name FROM employees e LEFT JOIN departments d ON d.id = e.dept_id AND e.salary > 1000000 WHERE e.id = 1")).toEqual([
      ["Alice", null],
    ]);
  });

  it("matches numeric strings against numbers in hash joins", () => {
    const d = new Database();
    d.exec(`
      CREATE TABLE a (k TEXT);
      CREATE TABLE b (k INTEGER);
      INSERT INTO a VALUES ('1'), ('2'), ('x');
      INSERT INTO b VALUES (1), (3);
    `);
    expect(rows(d, "SELECT a.k, b.k FROM a JOIN b ON a.k = b.k")).toEqual([["1", 1]]);
  });

  it("never matches NULL join keys", () => {
    const d = new Database();
    d.exec(`
      CREATE TABLE a (k INTEGER);
      CREATE TABLE b (k INTEGER);
      INSERT INTO a VALUES (NULL), (1);
      INSERT INTO b VALUES (NULL), (1);
    `);
    expect(rows(d, "SELECT COUNT(*) FROM a JOIN b ON a.k = b.k")).toEqual([[1]]);
  });

  it("rejects duplicate table aliases", () => {
    expect(() => db.exec("SELECT * FROM employees e JOIN departments e ON 1")).toThrow(/used more than once/);
  });

  it("chooses a join strategy visible in EXPLAIN", () => {
    const plan = (sql: string) => db.exec(`EXPLAIN ${sql}`)[0]!.rows.map((r) => r[0]).join("\n");
    expect(plan("SELECT * FROM employees e JOIN departments d ON d.id = e.dept_id")).toMatch(/index nested loop/);
    expect(plan("SELECT * FROM employees e JOIN employees m ON m.name = e.name")).toMatch(/hash/);
    expect(plan("SELECT * FROM employees e JOIN employees m ON m.salary > e.salary")).toMatch(/nested loop/);
  });
});
