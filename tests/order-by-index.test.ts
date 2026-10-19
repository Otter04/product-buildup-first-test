import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column } from "./helpers.js";

function plan(db: Database, sql: string): string {
  return db.exec(`EXPLAIN ${sql}`)[0]!.rows.map((r) => r[0]).join("\n");
}

describe("ORDER BY served by an index", () => {
  function db(): Database {
    const d = new Database();
    d.exec(`
      CREATE TABLE events (id INTEGER PRIMARY KEY, kind TEXT, at INTEGER, score REAL);
      CREATE INDEX idx_kind_at ON events (kind, at);
      CREATE INDEX idx_score ON events (score);
    `);
    const insert = d.prepare("INSERT INTO events (kind, at, score) VALUES (?, ?, ?)");
    for (let i = 0; i < 200; i++) insert.run([["a", "b", "c"][i % 3], (i * 37) % 101, i % 7 === 0 ? null : (i * 13) % 50]);
    return d;
  }

  it("skips the sort for the clustered primary key", () => {
    const d = db();
    const sql = "SELECT id FROM events ORDER BY id DESC LIMIT 3";
    expect(plan(d, sql)).toMatch(/ORDER BY \(from index\)/);
    expect(plan(d, sql)).toMatch(/SCAN events USING INDEX pk_events \(reverse\)/);
    expect(plan(d, sql)).not.toMatch(/SORT BY/);
    expect(column(d, sql)).toEqual([200, 199, 198]);
  });

  it("uses the order of an equality-prefix index search", () => {
    const d = db();
    const sql = "SELECT at FROM events WHERE kind = 'b' ORDER BY at LIMIT 5";
    expect(plan(d, sql)).toMatch(/SEARCH events USING INDEX idx_kind_at \(kind=\?\)/);
    expect(plan(d, sql)).toMatch(/ORDER BY \(from index\)/);
    const expected = column(d, "SELECT at FROM events WHERE kind = 'b'").map(Number).sort((a, b) => a - b).slice(0, 5);
    expect(column(d, sql)).toEqual(expected);
    // Ordering by the pinned column too is still served by the index.
    expect(plan(d, "SELECT at FROM events WHERE kind = 'b' ORDER BY kind, at DESC")).toMatch(/\(reverse\)/);
  });

  it("puts NULLs first ascending and last descending, like a sort would", () => {
    const d = db();
    const asc = column(d, "SELECT score FROM events ORDER BY score LIMIT 30");
    expect(asc.slice(0, 29).every((v) => v === null)).toBe(true);
    const desc = column(d, "SELECT score FROM events ORDER BY score DESC");
    expect(desc.slice(-29).every((v) => v === null)).toBe(true);
    expect(desc[0]).toBe(49);
  });

  it("falls back to sorting when the request does not match an index", () => {
    const d = db();
    expect(plan(d, "SELECT * FROM events ORDER BY at")).toMatch(/SORT BY/);
    expect(plan(d, "SELECT * FROM events ORDER BY kind, at DESC")).toMatch(/SORT BY/);
    expect(plan(d, "SELECT * FROM events ORDER BY score NULLS LAST")).toMatch(/SORT BY/);
    expect(plan(d, "SELECT DISTINCT kind FROM events ORDER BY kind")).toMatch(/SORT BY/);
    expect(plan(d, "SELECT kind, COUNT(*) FROM events GROUP BY kind ORDER BY kind")).toMatch(/SORT BY/);
    expect(plan(d, "SELECT score + 1 AS score FROM events ORDER BY score")).toMatch(/SORT BY/);
  });

  it("prefers a selective filter over an ordered scan without LIMIT", () => {
    const d = db();
    expect(plan(d, "SELECT * FROM events WHERE score = 3 ORDER BY id")).toMatch(/SORT BY[\s\S]*SEARCH events USING INDEX idx_score/);
    expect(plan(d, "SELECT * FROM events WHERE score = 3 ORDER BY id LIMIT 1")).toMatch(/SCAN events USING INDEX pk_events/);
  });

  it("resolves aliases and positions", () => {
    const d = db();
    expect(plan(d, "SELECT id AS n FROM events ORDER BY n DESC LIMIT 1")).toMatch(/ORDER BY \(from index\)/);
    expect(plan(d, "SELECT kind, at FROM events WHERE kind = 'a' ORDER BY 2 LIMIT 1")).toMatch(/ORDER BY \(from index\)/);
    expect(column(d, "SELECT id AS n FROM events ORDER BY n DESC LIMIT 1")).toEqual([200]);
  });

  it("matches a plain sort on random data and queries", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (const typed of [true, false]) {
      const setup = `CREATE TABLE t (id INTEGER PRIMARY KEY, a ${typed ? "INTEGER" : ""}, b ${typed ? "TEXT" : ""});`;
      const indexed = new Database();
      const plain = new Database();
      indexed.exec(setup + "CREATE INDEX t_ab ON t (a, b); CREATE INDEX t_b ON t (b);");
      plain.exec(setup);
      for (let i = 0; i < 300; i++) {
        let a: number | string | null = random() < 0.1 ? null : Math.floor(random() * 6);
        let b: number | string | null = random() < 0.1 ? null : `w${Math.floor(random() * 5)}`;
        // Untyped columns also get numeric strings and numbers, which compare equal to each other.
        if (!typed && a !== null && random() < 0.5) a = String(a);
        if (!typed && b !== null && random() < 0.3) b = Math.floor(random() * 5);
        for (const db of [indexed, plain]) db.run("INSERT INTO t (a, b) VALUES (?, ?)", [a, b]);
      }

      for (let q = 0; q < 200; q++) {
        const dir = random() < 0.5 ? " DESC" : "";
        const orderCols = random() < 0.3 ? ["id"] : random() < 0.5 ? ["a", "b"] : ["b"];
        const where = random() < 0.5 ? ` WHERE a = ${Math.floor(random() * 6)}` : random() < 0.5 ? ` WHERE a = '${Math.floor(random() * 6)}'` : "";
        const limit = random() < 0.5 ? ` LIMIT ${Math.floor(random() * 20)}` : "";
        // id is a unique tiebreaker, so the expected order is fully determined.
        const order = [...orderCols.map((c) => `${c}${dir}`), ...(orderCols.includes("id") ? [] : [`id${dir}`])].join(", ");
        const sql = `SELECT id, a, b FROM t${where} ORDER BY ${order}${limit}`;
        expect(indexed.exec(sql)[0]!.rows, sql).toEqual(plain.exec(sql)[0]!.rows);
      }
    }
  });
});
