// JSON functions are compared directly against SQLite's JSON1 implementation (Node 22+).
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";

let DatabaseSync: (new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(): Record<string, unknown>[] } }) | undefined;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

const Q = [
  `json_extract('{"a":{"b":[1,2.5,"x",true,null]}}', '$.a.b[1]')`,
  `json_extract('{"a":{"b":[1,2.5,"x",true,null]}}', '$.a.b')`,
  `json_extract('{"a":{"b":[1,2.5,"x"]}}', '$.a.b[#-1]')`,
  `json_extract('{"a":1,"b":2}', '$.a', '$.b', '$.c')`,
  `'{"a":{"b":7}}' -> '$.a'`, `'{"a":{"b":7}}' ->> '$.a.b'`, `'{"a":{"b":"s"}}' -> 'a' -> 'b'`, `'[10,20,30]' ->> 2`,
  `json_object('a', 1, 'b', 'txt', 'c', json_array(1, 2), 'd', NULL, 'e', 1.5)`,
  `json_object('x', json('{"y":  [1, 2.0]}'))`, `json_object('x', '{"y":1}')`,
  `json_array(1, 'two', json_object('k', 'v'), '[1]', json('[1]'))`,
  `json_set('{"a":1}', '$.b', 2, '$.a', 9)`, `json_insert('{"a":1}', '$.a', 5, '$.c', 3)`, `json_replace('{"a":1}', '$.a', 5, '$.c', 3)`,
  `json_set('[1,2]', '$[#]', 3)`, `json_remove('{"a":1,"b":[1,2,3]}', '$.b[1]', '$.a')`,
  `json_patch('{"a":1,"b":{"c":2}}', '{"b":{"c":null,"d":4},"e":5}')`,
  `json_type('{"a":[1,1.0,"s",null,true]}', '$.a[1]')`, `json_type('{"a":[1]}')`, `json_type('{"a":[1]}', '$.a[0]')`,
  `json_array_length('[1,2,3]')`, `json_array_length('{"a":[1,2]}', '$.a')`, `json_valid('{"a":1}')`, `json_valid('{a:1}')`,
  `json(' { "a" : [ 1 , 2 ] } ')`, `json_quote('he said "hi"')`, `json_object('a', json_extract('{"b":[1]}', '$.b'))`,
  `json_object('a', '{"b":[1]}' -> '$.b', 'c', '{"b":[1]}' ->> '$.b')`,
];

const AGGREGATES = [
  "SELECT g, json_group_array(v) FROM t GROUP BY g ORDER BY g",
  "SELECT json_group_object(g || v, j -> '$.n') FROM t",
  "SELECT json_group_array(json_object('v', v)) FROM t",
  "SELECT SUM(j ->> 'n') FROM t",
];
const SETUP = `CREATE TABLE t (g TEXT, v INTEGER, j TEXT); INSERT INTO t VALUES ('a',1,'{"n":1}'),('a',2,'{"n":2}'),('b',3,NULL);`;
// minisql has a real boolean type where SQLite returns 1 / 0.
const norm = (v: unknown) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

describe.skipIf(!DatabaseSync)("JSON functions agree with SQLite", () => {
  const sqlite = new DatabaseSync!(":memory:");
  const db = new Database();
  sqlite.exec(SETUP);
  db.exec(SETUP);

  it.each(Q)("%s", (expr) => {
    const expected = Object.values(sqlite.prepare(`SELECT ${expr} AS v`).all()[0]!)[0];
    expect(norm(db.exec(`SELECT ${expr} AS v`)[0]!.rows[0]![0])).toEqual(norm(expected));
  });

  it.each(AGGREGATES)("%s", (sql) => {
    expect(db.exec(sql)[0]!.rows).toEqual(sqlite.prepare(sql).all().map((r) => Object.values(r)));
  });
});

describe("JSON functions", () => {
  const db = new Database();
  it("reports malformed input and bad paths", () => {
    expect(() => db.exec(`SELECT json_extract('{a:1}', '$.a')`)).toThrow(/malformed JSON/);
    expect(() => db.exec(`SELECT json_extract('{}', 'a')`)).toThrow(/must start with '\$'/);
    expect(() => db.exec(`SELECT json_object('a')`)).toThrow(/even number/);
    expect(() => db.exec(`SELECT json_object(1, 2)`)).toThrow(/labels must be TEXT/);
  });

  it("works with stored documents and indexes on extracted values", () => {
    const d = new Database();
    d.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, payload TEXT CHECK (json_valid(payload)))`);
    d.run(`INSERT INTO events (payload) VALUES (?), (?)`, [JSON.stringify({ user: "ann", tags: ["a", "b"] }), JSON.stringify({ user: "bob", tags: [] })]);
    expect(d.query("SELECT payload ->> 'user' AS u, json_array_length(payload, '$.tags') AS n FROM events ORDER BY u")).toEqual([
      { u: "ann", n: 2 },
      { u: "bob", n: 0 },
    ]);
    expect(() => d.exec("INSERT INTO events (payload) VALUES ('not json')")).toThrow(/CHECK constraint failed/);
  });
});
