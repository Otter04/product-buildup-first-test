import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { column, sampleDb, scalar } from "./helpers.js";

describe("transactions", () => {
  it("commits changes", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER)");
    db.exec("BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); COMMIT;");
    expect(column(db, "SELECT x FROM t ORDER BY x")).toEqual([1, 2]);
    expect(db.inTransaction).toBe(false);
  });

  it("rolls back data and schema changes", () => {
    const db = sampleDb();
    db.exec(`
      BEGIN;
      INSERT INTO departments (id, name) VALUES (9, 'Temp');
      UPDATE employees SET salary = 0;
      DELETE FROM employees WHERE id = 7;
      CREATE TABLE scratch (x INTEGER);
      CREATE INDEX idx_name ON employees (name);
      DROP TABLE scratch;
      ROLLBACK;
    `);
    expect(scalar(db, "SELECT COUNT(*) FROM departments")).toBe(4);
    expect(scalar(db, "SELECT SUM(salary) FROM employees")).toBe(730000);
    expect(scalar(db, "SELECT COUNT(*) FROM employees")).toBe(7);
    expect(db.tables()).toEqual(["departments", "employees"]);
    expect(db.schema()).not.toMatch(/idx_name/);
    // Indexes were restored too.
    expect(column(db, "SELECT name FROM employees WHERE id = 7")).toEqual(["Grace"]);
  });

  it("undoes a failed statement but keeps the transaction open", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.exec("BEGIN; INSERT INTO t VALUES (1);");
    expect(() => db.exec("INSERT INTO t VALUES (2), (1)")).toThrow(/PRIMARY KEY/);
    expect(db.inTransaction).toBe(true);
    expect(column(db, "SELECT id FROM t")).toEqual([1]);
    db.exec("COMMIT");
    expect(column(db, "SELECT id FROM t")).toEqual([1]);
  });

  it("makes each statement atomic outside a transaction", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() => db.exec("INSERT INTO t VALUES (1), (2), (2)")).toThrow();
    expect(scalar(db, "SELECT COUNT(*) FROM t")).toBe(0);
  });

  it("restores AUTOINCREMENT counters on rollback", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    db.exec("INSERT INTO t (v) VALUES ('a')");
    db.exec("BEGIN; INSERT INTO t (v) VALUES ('b'), ('c'); ROLLBACK;");
    expect(db.run("INSERT INTO t (v) VALUES ('d')").lastInsertRowId).toBe(2);
  });

  it("validates transaction state", () => {
    const db = new Database();
    expect(() => db.exec("COMMIT")).toThrow(/no transaction is open/);
    expect(() => db.exec("ROLLBACK")).toThrow(/no transaction is open/);
    db.exec("BEGIN TRANSACTION");
    expect(() => db.exec("BEGIN")).toThrow(/already open/);
    db.exec("ROLLBACK");
  });

  it("offers a transaction() helper", () => {
    const db = new Database();
    db.exec("CREATE TABLE t (x INTEGER UNIQUE)");
    db.transaction((tx) => {
      tx.run("INSERT INTO t VALUES (1)");
      tx.run("INSERT INTO t VALUES (2)");
    });
    expect(() =>
      db.transaction((tx) => {
        tx.run("INSERT INTO t VALUES (3)");
        tx.run("INSERT INTO t VALUES (1)");
      }),
    ).toThrow(/UNIQUE/);
    expect(column(db, "SELECT x FROM t ORDER BY x")).toEqual([1, 2]);
    expect(db.transaction(() => 42)).toBe(42);
  });
});

describe("prepared statements", () => {
  it("runs repeatedly with different parameters", () => {
    const db = new Database();
    db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v INTEGER)");
    const insert = db.prepare("INSERT INTO kv VALUES (?, ?)");
    for (let i = 0; i < 5; i++) insert.run([`k${i}`, i * i]);
    const get = db.prepare("SELECT v FROM kv WHERE k = :k");
    expect(get.get({ k: "k3" })).toEqual({ v: 9 });
    expect(get.get({ k: "missing" })).toBeUndefined();
    expect(db.prepare("SELECT k FROM kv WHERE v > ? ORDER BY k").values([3])).toEqual([["k2"], ["k3"], ["k4"]]);
  });

  it("accepts host values like bigint, Date and undefined", () => {
    const db = new Database();
    const row = db.prepare("SELECT ? AS a, ? AS b, ? AS c").get([10n, new Date("2024-05-06T07:08:09.000Z"), undefined]);
    expect(row).toEqual({ a: 10, b: "2024-05-06 07:08:09", c: null });
  });

  it("requires exactly one statement", () => {
    const db = new Database();
    expect(() => db.prepare("SELECT 1; SELECT 2")).toThrow(/exactly one statement/);
  });
});
