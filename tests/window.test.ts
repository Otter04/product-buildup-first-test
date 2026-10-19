import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { rows } from "./helpers.js";

function salesDb(): Database {
  const db = new Database();
  db.exec(`
    CREATE TABLE sales (id INTEGER PRIMARY KEY, region TEXT, month INTEGER, amount INTEGER);
    INSERT INTO sales (region, month, amount) VALUES
      ('east', 1, 100), ('east', 2, 150), ('east', 3, 150), ('east', 4, 90),
      ('west', 1, 200), ('west', 2, 120), ('west', 3, NULL);
  `);
  return db;
}

describe("window functions", () => {
  const db = salesDb();

  it("numbers rows within partitions", () => {
    expect(rows(db, "SELECT region, month, ROW_NUMBER() OVER (PARTITION BY region ORDER BY month DESC) FROM sales ORDER BY region, month")).toEqual([
      ["east", 1, 4],
      ["east", 2, 3],
      ["east", 3, 2],
      ["east", 4, 1],
      ["west", 1, 3],
      ["west", 2, 2],
      ["west", 3, 1],
    ]);
  });

  it("ranks with gaps and without", () => {
    const w = "OVER (ORDER BY amount DESC)";
    expect(
      rows(
        db,
        `SELECT amount, RANK() ${w}, DENSE_RANK() ${w}, PERCENT_RANK() ${w}, CUME_DIST() ${w}
         FROM sales WHERE region = 'east' ORDER BY amount DESC`,
      ),
    ).toEqual([
      [150, 1, 1, 0, 0.5],
      [150, 1, 1, 0, 0.5],
      [100, 3, 2, 2 / 3, 0.75],
      [90, 4, 3, 1, 1],
    ]);
  });

  it("computes running totals with the default frame", () => {
    expect(rows(db, "SELECT month, amount, SUM(amount) OVER (PARTITION BY region ORDER BY month) FROM sales WHERE region = 'east' ORDER BY month")).toEqual([
      [1, 100, 100],
      [2, 150, 250],
      [3, 150, 400],
      [4, 90, 490],
    ]);
  });

  it("includes peers in the default RANGE frame", () => {
    expect(rows(db, "SELECT amount, SUM(amount) OVER (ORDER BY amount) FROM sales WHERE region = 'east' ORDER BY amount")).toEqual([
      [90, 90],
      [100, 190],
      [150, 490],
      [150, 490],
    ]);
  });

  it("aggregates over the whole partition without ORDER BY", () => {
    expect(rows(db, "SELECT region, amount, SUM(amount) OVER (PARTITION BY region), COUNT(*) OVER () FROM sales WHERE month = 1 ORDER BY region")).toEqual([
      ["east", 100, 100, 2],
      ["west", 200, 200, 2],
    ]);
  });

  it("supports ROWS frames", () => {
    expect(
      rows(
        db,
        `SELECT month,
                AVG(amount) OVER (ORDER BY month ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING),
                SUM(amount) OVER (ORDER BY month ROWS 1 PRECEDING),
                SUM(amount) OVER (ORDER BY month ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),
                COUNT(*) OVER (ORDER BY month ROWS BETWEEN 2 FOLLOWING AND 3 FOLLOWING)
         FROM sales WHERE region = 'east' ORDER BY month`,
      ),
    ).toEqual([
      [1, 125, 100, 490, 2],
      [2, 400 / 3, 250, 390, 1],
      [3, 130, 300, 240, 0],
      [4, 120, 240, 90, 0],
    ]);
  });

  it("supports RANGE frames with numeric offsets", () => {
    const d = new Database();
    d.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (4), (7), (8);");
    expect(rows(d, "SELECT x, SUM(x) OVER (ORDER BY x RANGE BETWEEN 2 PRECEDING AND CURRENT ROW) FROM t ORDER BY x")).toEqual([
      [1, 1],
      [2, 3],
      [4, 6],
      [7, 7],
      [8, 15],
    ]);
    expect(rows(d, "SELECT x, COUNT(*) OVER (ORDER BY x DESC RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t ORDER BY x")).toEqual([
      [1, 2],
      [2, 2],
      [4, 1],
      [7, 2],
      [8, 2],
    ]);
  });

  it("looks backwards and forwards with LAG and LEAD", () => {
    expect(
      rows(
        db,
        `SELECT month, LAG(amount) OVER (ORDER BY month), LEAD(amount, 2) OVER (ORDER BY month), LAG(amount, 1, -1) OVER (ORDER BY month)
         FROM sales WHERE region = 'east' ORDER BY month`,
      ),
    ).toEqual([
      [1, null, 150, -1],
      [2, 100, 90, 100],
      [3, 150, null, 150],
      [4, 150, null, 150],
    ]);
  });

  it("reads values from the frame", () => {
    expect(
      rows(
        db,
        `SELECT month, FIRST_VALUE(amount) OVER (ORDER BY month), LAST_VALUE(amount) OVER (ORDER BY month),
                LAST_VALUE(amount) OVER (ORDER BY month ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),
                NTH_VALUE(amount, 2) OVER (ORDER BY month)
         FROM sales WHERE region = 'east' ORDER BY month`,
      ),
    ).toEqual([
      [1, 100, 100, 90, null],
      [2, 100, 150, 90, 150],
      [3, 100, 150, 90, 150],
      [4, 100, 90, 90, 150],
    ]);
  });

  it("distributes rows into buckets with NTILE", () => {
    const d = new Database();
    d.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1), (2), (3), (4), (5), (6), (7);");
    expect(rows(d, "SELECT x, NTILE(3) OVER (ORDER BY x) FROM t ORDER BY x").map((r) => r[1])).toEqual([1, 1, 1, 2, 2, 3, 3]);
    expect(rows(d, "SELECT NTILE(10) OVER (ORDER BY x) FROM t ORDER BY x").map((r) => r[0])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("combines with GROUP BY", () => {
    expect(
      rows(
        db,
        `SELECT region, SUM(amount) AS total, RANK() OVER (ORDER BY SUM(amount) DESC) AS r,
                SUM(SUM(amount)) OVER () AS grand
         FROM sales GROUP BY region ORDER BY r`,
      ),
    ).toEqual([
      ["east", 490, 1, 810],
      ["west", 320, 2, 810],
    ]);
  });

  it("can be used in ORDER BY", () => {
    expect(rows(db, "SELECT month FROM sales WHERE region = 'west' ORDER BY ROW_NUMBER() OVER (ORDER BY month DESC)")).toEqual([[3], [2], [1]]);
  });

  it("filters on window results through a derived table", () => {
    expect(
      rows(
        db,
        `SELECT region, month FROM (
           SELECT region, month, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC NULLS LAST, month) AS rn FROM sales
         ) ranked WHERE rn = 1 ORDER BY region`,
      ),
    ).toEqual([
      ["east", 2],
      ["west", 1],
    ]);
  });

  it("rejects window functions in the wrong places", () => {
    expect(() => db.exec("SELECT * FROM sales WHERE ROW_NUMBER() OVER () > 1")).toThrow(/only allowed in the select list/);
    expect(() => db.exec("SELECT ROW_NUMBER() FROM sales")).toThrow(/requires an OVER clause/);
    expect(() => db.exec("SELECT region FROM sales GROUP BY region HAVING RANK() OVER () = 1")).toThrow(/not allowed in HAVING/);
    expect(() => db.exec("SELECT SUM(ROW_NUMBER() OVER ()) OVER () FROM sales")).toThrow(/cannot be nested/);
    expect(() => db.exec("SELECT UPPER(region) OVER () FROM sales")).toThrow(/not a window or aggregate function/);
    expect(() => db.exec("SELECT SUM(amount) OVER (ROWS BETWEEN UNBOUNDED FOLLOWING AND CURRENT ROW) FROM sales")).toThrow(/cannot start at UNBOUNDED FOLLOWING/);
  });

  it("shows windows in EXPLAIN", () => {
    const plan = db.exec("EXPLAIN SELECT RANK() OVER (PARTITION BY region ORDER BY amount) FROM sales")[0]!.rows.flat().join("\n");
    expect(plan).toMatch(/WINDOW \[RANK\(\) OVER \(PARTITION BY region ORDER BY amount ASC\)\]/);
  });
});
