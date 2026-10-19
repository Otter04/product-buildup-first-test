import { describe, expect, it } from "vitest";
import { Database, SqlConstraintError } from "../src/index.js";
import { column, rows, scalar } from "./helpers.js";

describe("INSERT OR IGNORE / OR REPLACE", () => {
  function db(): Database {
    const d = new Database();
    d.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT NOT NULL DEFAULT 'anon', age INTEGER CHECK (age >= 0));
      INSERT INTO users VALUES (1, 'a@x', 'Ann', 30), (2, 'b@x', 'Bob', 40);
    `);
    return d;
  }

  it("skips rows that violate constraints with OR IGNORE", () => {
    const d = db();
    const r = d.run(`
      INSERT OR IGNORE INTO users VALUES
        (1, 'new@x', 'dup id', 1),
        (3, 'a@x', 'dup email', 1),
        (4, 'c@x', NULL, 1),
        (5, 'd@x', 'bad age', -1),
        (6, 'e@x', 'ok', 5)
    `);
    expect(r.changes).toBe(1);
    expect(column(d, "SELECT id FROM users ORDER BY id")).toEqual([1, 2, 6]);
  });

  it("still fails on foreign key violations with OR IGNORE", () => {
    const d = new Database();
    d.exec("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (pid INTEGER REFERENCES p(id));");
    expect(() => d.exec("INSERT OR IGNORE INTO c VALUES (1)")).toThrow(SqlConstraintError);
  });

  it("replaces conflicting rows with OR REPLACE and REPLACE INTO", () => {
    const d = db();
    d.exec("INSERT OR REPLACE INTO users VALUES (1, 'a2@x', 'Ann 2', 31)");
    expect(rows(d, "SELECT * FROM users WHERE id = 1")).toEqual([[1, "a2@x", "Ann 2", 31]]);
    // One new row can displace several existing ones (here: id 1 by key and id 2 by email).
    const r = d.run("REPLACE INTO users VALUES (1, 'b@x', 'Merged', 50)");
    expect(r.changes).toBe(1);
    expect(rows(d, "SELECT * FROM users")).toEqual([[1, "b@x", "Merged", 50]]);
  });

  it("uses defaults for NULLs in NOT NULL columns with OR REPLACE", () => {
    const d = db();
    d.exec("INSERT OR REPLACE INTO users VALUES (2, 'b@x', NULL, 41)");
    expect(rows(d, "SELECT name, age FROM users WHERE id = 2")).toEqual([["anon", 41]]);
  });

  it("refuses to replace rows that are still referenced", () => {
    const d = new Database();
    d.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE c (pid INTEGER REFERENCES p(id));");
    d.exec("INSERT INTO p VALUES (1, 'x'); INSERT INTO c VALUES (1);");
    expect(() => d.exec("REPLACE INTO p VALUES (1, 'y')")).toThrow(/still referenced/);
    expect(rows(d, "SELECT * FROM p")).toEqual([[1, "x"]]);
  });

  it("accepts OR ABORT / OR FAIL as the default behaviour", () => {
    const d = db();
    expect(() => d.exec("INSERT OR ABORT INTO users VALUES (1, 'z@x', 'z', 1)")).toThrow(/PRIMARY KEY/);
    d.exec("INSERT OR FAIL INTO users VALUES (9, 'z@x', 'z', 1)");
    expect(scalar(d, "SELECT COUNT(*) FROM users")).toBe(3);
  });

  it("returns the rows it actually wrote", () => {
    const d = db();
    expect(d.query("INSERT OR IGNORE INTO users (id, email) VALUES (1, 'q@x'), (7, 'q@x') RETURNING id")).toEqual([{ id: 7 }]);
  });

  it("cannot be combined with ON CONFLICT", () => {
    expect(() => db().exec("INSERT OR IGNORE INTO users VALUES (1, 'a', 'b', 1) ON CONFLICT DO NOTHING")).toThrow(/cannot be combined/);
  });

  it("reports constraint kinds on errors", () => {
    const d = db();
    const kind = (sql: string) => {
      try {
        d.exec(sql);
      } catch (e) {
        return (e as SqlConstraintError).kind;
      }
      return undefined;
    };
    expect(kind("INSERT INTO users VALUES (1, 'z', 'z', 1)")).toBe("primaryKey");
    expect(kind("INSERT INTO users VALUES (9, 'a@x', 'z', 1)")).toBe("unique");
    expect(kind("INSERT INTO users (id, email, name) VALUES (9, 'q', NULL)")).toBe("notNull");
    expect(kind("INSERT INTO users VALUES (9, 'q', 'z', -5)")).toBe("check");
  });
});

describe("IS [NOT] DISTINCT FROM", () => {
  const d = new Database();
  const value = (expr: string) => scalar(d, `SELECT ${expr}`);

  it("compares with NULLs as ordinary values", () => {
    expect(value("NULL IS DISTINCT FROM NULL")).toBe(false);
    expect(value("NULL IS NOT DISTINCT FROM NULL")).toBe(true);
    expect(value("1 IS DISTINCT FROM NULL")).toBe(true);
    expect(value("1 IS NOT DISTINCT FROM 1")).toBe(true);
    expect(value("1 IS DISTINCT FROM 2")).toBe(true);
  });

  it("works in WHERE clauses", () => {
    d.exec("CREATE TABLE t (a INTEGER, b INTEGER); INSERT INTO t VALUES (1, 1), (1, NULL), (NULL, NULL), (2, 3);");
    expect(scalar(d, "SELECT COUNT(*) FROM t WHERE a IS DISTINCT FROM b")).toBe(2);
    expect(scalar(d, "SELECT COUNT(*) FROM t WHERE a IS NOT DISTINCT FROM b")).toBe(2);
  });
});

describe("named windows", () => {
  const d = new Database();
  d.exec(`
    CREATE TABLE s (g TEXT, x INTEGER);
    INSERT INTO s VALUES ('a', 1), ('a', 3), ('a', 2), ('b', 10), ('b', 20);
  `);

  it("shares one definition between several functions", () => {
    expect(
      rows(d, "SELECT g, x, ROW_NUMBER() OVER w, SUM(x) OVER w FROM s WINDOW w AS (PARTITION BY g ORDER BY x) ORDER BY g, x"),
    ).toEqual([
      ["a", 1, 1, 1],
      ["a", 2, 2, 3],
      ["a", 3, 3, 6],
      ["b", 10, 1, 10],
      ["b", 20, 2, 30],
    ]);
  });

  it("can extend a named window with ORDER BY and a frame", () => {
    expect(
      rows(
        d,
        `SELECT x, COUNT(*) OVER p, SUM(x) OVER (p ORDER BY x ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
         FROM s WINDOW p AS (PARTITION BY g) ORDER BY x`,
      ),
    ).toEqual([
      [1, 3, 1],
      [2, 3, 3],
      [3, 3, 5],
      [10, 2, 10],
      [20, 2, 30],
    ]);
  });

  it("lets windows build on earlier windows", () => {
    expect(column(d, "SELECT RANK() OVER w2 FROM s WINDOW w1 AS (PARTITION BY g), w2 AS (w1 ORDER BY x DESC) ORDER BY g, x")).toEqual([3, 2, 1, 2, 1]);
  });

  it("rejects invalid references and overrides", () => {
    expect(() => d.exec("SELECT SUM(x) OVER nope FROM s")).toThrow(/No such window: nope/);
    expect(() => d.exec("SELECT SUM(x) OVER (w PARTITION BY g) FROM s WINDOW w AS (ORDER BY x)")).toThrow(/Cannot override PARTITION BY/);
    expect(() => d.exec("SELECT SUM(x) OVER (w ORDER BY g) FROM s WINDOW w AS (ORDER BY x)")).toThrow(/Cannot override ORDER BY/);
    expect(() => d.exec("SELECT 1 FROM s WINDOW w AS (), w AS ()")).toThrow(/defined more than once/);
  });
});
