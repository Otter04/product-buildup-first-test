import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { sampleDb } from "./helpers.js";

const lines = (db: Database, sql: string) => db.exec(sql)[0]!.rows.map((r) => String(r[0]));

describe("EXPLAIN", () => {
  it("shows expression subqueries and whether they are correlated", () => {
    const db = sampleDb();
    const plan = lines(
      db,
      "EXPLAIN SELECT name, (SELECT name FROM departments d WHERE d.id = e.dept_id) FROM employees e WHERE salary > (SELECT AVG(salary) FROM employees)",
    ).join("\n");
    expect(plan).toMatch(/SCALAR SUBQUERY \(correlated\)/);
    expect(plan).toMatch(/SCALAR SUBQUERY \(evaluated once\)/);
    expect(plan).toMatch(/SEARCH departments AS d USING INDEX pk_departments/);
  });

  it("explains UPDATE and DELETE access paths", () => {
    const db = sampleDb();
    expect(lines(db, "EXPLAIN UPDATE employees SET salary = 1 WHERE id = 3").join("\n")).toMatch(/UPDATE employees\n└─ SEARCH employees USING INDEX pk_employees/);
    expect(lines(db, "EXPLAIN DELETE FROM employees WHERE name = 'x'").join("\n")).toMatch(/SCAN employees/);
  });
});

describe("EXPLAIN ANALYZE", () => {
  it("reports rows per node and loops for repeated nodes", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX idx_dept ON employees (dept_id)");
    const plan = lines(
      db,
      `EXPLAIN ANALYZE
       SELECT d.name, COUNT(*) FROM departments d JOIN employees e ON e.dept_id = d.id
       WHERE d.budget > 100000 GROUP BY d.name ORDER BY 2 DESC LIMIT 2`,
    );
    const text = plan.join("\n");
    expect(text).toMatch(/LIMIT 2 \(rows=2\)/);
    expect(text).toMatch(/GROUP BY d\.name \[COUNT\(\*\)\] \(rows=3\)/);
    expect(text).toMatch(/INNER JOIN \(index nested loop\) ON e\.dept_id = d\.id \(rows=6\)/);
    expect(text).toMatch(/SCAN departments AS d WHERE d\.budget > 100000 \(rows=3\)/);
    expect(text).toMatch(/SEARCH employees AS e USING INDEX idx_dept \(dept_id=\?\) \(rows=6 loops=3\)/);
    expect(plan[plan.length - 1]).toMatch(/^Execution: 2 rows in \d+\.\d+ ms$/);
  });

  it("counts subquery calls and early termination", () => {
    const db = sampleDb();
    const text = lines(db, "EXPLAIN ANALYZE SELECT name FROM departments d WHERE EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id)").join("\n");
    expect(text).toMatch(/EXISTS SUBQUERY \(correlated\) \(calls=4\)/);
    // EXISTS stops at the first match, so far fewer than all employee rows are read.
    expect(text).toMatch(/PROJECT 1 \(rows=3 loops=4\)/);
  });

  it("marks nodes that never ran", () => {
    const db = sampleDb();
    const text = lines(db, "EXPLAIN ANALYZE SELECT * FROM employees WHERE 1 = 0 AND (SELECT COUNT(*) FROM departments) > 0").join("\n");
    expect(text).toMatch(/SCALAR SUBQUERY \(evaluated once\) \(calls=0\)/);
    expect(text).toMatch(/never executed/);
  });

  it("only analyzes SELECT statements", () => {
    const db = sampleDb();
    expect(() => db.exec("EXPLAIN ANALYZE DELETE FROM employees")).toThrow(/SELECT statements only/);
  });

  it("does not disturb cached plans", () => {
    const db = sampleDb();
    const stmt = db.prepare("SELECT COUNT(*) AS n FROM employees WHERE salary > ?");
    expect(stmt.get([100000])).toEqual({ n: 3 });
    db.exec("EXPLAIN ANALYZE SELECT COUNT(*) AS n FROM employees WHERE salary > 100000");
    expect(stmt.get([50000])).toEqual({ n: 7 });
  });
});
