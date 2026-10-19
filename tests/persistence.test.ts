import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { openDatabase, saveDatabase } from "../src/node.js";
import { rows, sampleDb } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "minisql-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function everything(db: Database): unknown {
  return Object.fromEntries(db.tables().map((t) => [t, rows(db, `SELECT * FROM "${t}"`)]));
}

describe("dump", () => {
  it("produces a script that recreates the database", () => {
    const db = sampleDb();
    db.exec("CREATE INDEX idx_salary ON employees (salary); CREATE TABLE \"odd name\" (\"select\" TEXT, x REAL DEFAULT 1.5);");
    db.exec(`INSERT INTO "odd name" VALUES ('it''s', 2.25), (NULL, NULL)`);
    const script = db.dump();
    expect(script).toMatch(/^BEGIN;/);
    expect(script).toMatch(/CREATE INDEX idx_salary ON employees \(salary\);/);

    const copy = new Database();
    copy.exec(script);
    expect(everything(copy)).toEqual(everything(db));
    expect(copy.schema()).toEqual(db.schema());
  });

  it("orders parent tables before children", () => {
    const db = new Database();
    db.exec("CREATE TABLE z_parent (id INTEGER PRIMARY KEY); CREATE TABLE a_child (p INTEGER REFERENCES z_parent(id));");
    db.exec("INSERT INTO z_parent VALUES (1); INSERT INTO a_child VALUES (1);");
    const copy = new Database();
    copy.exec(db.dump());
    expect(rows(copy, "SELECT * FROM a_child")).toEqual([[1]]);
  });

  it("round-trips composite keys, checks and unique constraints", () => {
    const db = new Database();
    db.exec(`
      CREATE TABLE t (
        a INTEGER, b TEXT, c INTEGER CHECK (c > 0), d BOOLEAN DEFAULT FALSE,
        PRIMARY KEY (a, b), UNIQUE (b, c)
      );
      INSERT INTO t VALUES (1, 'x', 5, TRUE);
    `);
    const copy = new Database();
    copy.exec(db.dump());
    expect(copy.schema()).toEqual(db.schema());
    expect(() => copy.exec("INSERT INTO t VALUES (1, 'x', 6, NULL)")).toThrow(/PRIMARY KEY/);
    expect(() => copy.exec("INSERT INTO t VALUES (2, 'x', 5, NULL)")).toThrow(/UNIQUE/);
    expect(() => copy.exec("INSERT INTO t VALUES (3, 'y', 0, NULL)")).toThrow(/CHECK/);
    expect(rows(copy, "SELECT d FROM t")).toEqual([[true]]);
  });
});

describe("JSON snapshots", () => {
  it("round-trips through toJSON / fromJSON", () => {
    const db = sampleDb();
    db.exec("DELETE FROM employees WHERE id = 7"); // leaves a gap in the AUTOINCREMENT sequence
    const restored = Database.fromJSON(JSON.parse(JSON.stringify(db.toJSON())));
    expect(everything(restored)).toEqual(everything(db));
    expect(restored.run("INSERT INTO employees (name) VALUES ('New')").lastInsertRowId).toBe(8);
    expect(() => restored.exec("INSERT INTO departments (id, name) VALUES (1, 'Dup')")).toThrow(/PRIMARY KEY/);
  });

  it("refuses to snapshot mid-transaction", () => {
    const db = new Database();
    db.exec("BEGIN");
    expect(() => db.toJSON()).toThrow(/open transaction/);
  });

  it("rejects foreign formats", () => {
    expect(() => Database.fromJSON({ format: "other" } as never)).toThrow(/Unsupported snapshot/);
  });
});

describe("files", () => {
  it("saves and opens JSON snapshots", () => {
    const path = join(dir, "db.json");
    const db = sampleDb();
    saveDatabase(db, path);
    expect(JSON.parse(readFileSync(path, "utf8")).format).toBe("minisql");
    expect(everything(openDatabase(path))).toEqual(everything(db));
  });

  it("saves and opens SQL dumps", () => {
    const path = join(dir, "db.sql");
    const db = sampleDb();
    saveDatabase(db, path);
    expect(readFileSync(path, "utf8")).toMatch(/CREATE TABLE departments/);
    expect(everything(openDatabase(path))).toEqual(everything(db));
  });

  it("opens a missing file as an empty database", () => {
    expect(openDatabase(join(dir, "missing.json")).tables()).toEqual([]);
  });

  it("reports corrupt files", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{ not json");
    expect(() => openDatabase(path)).toThrow();
  });
});
