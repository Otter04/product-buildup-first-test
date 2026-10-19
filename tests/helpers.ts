import { Database } from "../src/index.js";

/** Creates a database pre-loaded with a small HR / sales schema used across tests. */
export function sampleDb(): Database {
  const db = new Database();
  db.exec(`
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      budget REAL
    );
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      dept_id INTEGER REFERENCES departments(id),
      salary INTEGER CHECK (salary >= 0),
      manager_id INTEGER REFERENCES employees(id),
      hired TEXT
    );
    INSERT INTO departments (id, name, budget) VALUES
      (1, 'Engineering', 1000000),
      (2, 'Sales', 250000),
      (3, 'Marketing', 150000),
      (4, 'Legal', NULL);
    INSERT INTO employees (name, dept_id, salary, manager_id, hired) VALUES
      ('Alice', 1, 180000, NULL, '2015-03-01'),
      ('Bob', 1, 120000, 1, '2018-07-15'),
      ('Carol', 1, 125000, 1, '2019-01-10'),
      ('Dave', 2, 90000, NULL, '2016-11-30'),
      ('Eve', 2, 70000, 4, '2020-02-02'),
      ('Frank', 3, 85000, NULL, '2021-05-05'),
      ('Grace', NULL, 60000, NULL, '2022-09-09');
  `);
  return db;
}

/** Runs a query and returns its rows as arrays (handy for compact assertions). */
export function rows(db: Database, sql: string, params?: unknown[] | Record<string, unknown>): unknown[][] {
  const results = db.exec(sql, params);
  return results[results.length - 1]!.rows;
}

/** Runs a query and returns the first column of every row. */
export function column(db: Database, sql: string, params?: unknown[] | Record<string, unknown>): unknown[] {
  return rows(db, sql, params).map((r) => r[0]);
}

/** Runs a query and returns the single value of its single row. */
export function scalar(db: Database, sql: string, params?: unknown[] | Record<string, unknown>): unknown {
  const r = rows(db, sql, params);
  if (r.length !== 1 || r[0]!.length !== 1) throw new Error(`Expected a single value, got ${JSON.stringify(r)}`);
  return r[0]![0];
}
