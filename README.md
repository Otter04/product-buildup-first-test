# minisql

**A relational SQL database engine written from scratch in TypeScript — with zero runtime dependencies.**

minisql parses SQL, plans queries with a small cost-based optimizer, executes them over B+ tree indexes, and
enforces constraints inside transactions. It is tested against SQLite with a differential fuzzer: hundreds of
thousands of randomly generated queries and data-modifying statements must produce exactly the same results
in both engines.

```
$ node dist/cli.js shop.json
minisql 0.1.0. Type .help for commands; end SQL statements with ';'.
minisql> SELECT c.name, COUNT(*) AS orders, SUM(o.total) AS spent,
   ...>        RANK() OVER (ORDER BY SUM(o.total) DESC) AS rank
   ...> FROM customers c JOIN orders o ON o.customer_id = c.id
   ...> GROUP BY c.name ORDER BY rank;
┌───────┬────────┬───────┬──────┐
│ name  │ orders │ spent │ rank │
├───────┼────────┼───────┼──────┤
│ Grace │      2 │ 399.9 │    1 │
│ Ada   │      2 │ 200.5 │    2 │
│ Linus │      1 │    42 │    3 │
└───────┴────────┴───────┴──────┘
3 rows
minisql> EXPLAIN SELECT c.name, SUM(o.total) FROM customers c
   ...> JOIN orders o ON o.customer_id = c.id WHERE c.country = 'US' GROUP BY c.name;
PROJECT name, SUM(o.total)
└─ GROUP BY c.name [SUM(o.total)]
   └─ INNER JOIN (index nested loop) ON o.customer_id = c.id
      ├─ SCAN customers AS c WHERE c.country = 'US'
      └─ SEARCH orders AS o USING INDEX idx_orders_customer (customer_id=?)
```

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [Library API](#library-api)
- [Command-line shell](#command-line-shell)
- [SQL reference](#sql-reference)
- [How it works](#how-it-works)
- [Testing](#testing)
- [Performance](#performance)
- [Differences from SQLite](#differences-from-sqlite)
- [Project layout](#project-layout)

## Features

| Area | What is supported |
| --- | --- |
| **Queries** | `SELECT` with `DISTINCT`, expressions, aliases, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY … NULLS FIRST/LAST`, `LIMIT`/`OFFSET` |
| **Joins** | `INNER`, `LEFT`, `RIGHT`, `FULL OUTER`, `CROSS`, comma joins, `USING`, self joins, derived tables |
| **Subqueries** | scalar, `IN`, `EXISTS`, correlated at any depth, in `SELECT`, `WHERE`, `HAVING`, `SET` and `RETURNING` |
| **Set operations** | `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT`, standalone `VALUES` |
| **CTEs** | `WITH`, `WITH RECURSIVE` (with cycle-safe `UNION` and a runaway-recursion guard) |
| **Window functions** | `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE`, `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`, and every aggregate with `OVER (PARTITION BY … ORDER BY … ROWS/RANGE BETWEEN …)` |
| **Aggregates** | `COUNT`, `SUM`, `TOTAL`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT`/`STRING_AGG`, `BOOL_AND`/`BOOL_OR`, `VARIANCE`, `STDDEV`, `MEDIAN`, plus `DISTINCT` |
| **Writes** | `INSERT … VALUES / SELECT / DEFAULT VALUES`, `UPDATE`, `DELETE`, upserts (`ON CONFLICT … DO NOTHING / DO UPDATE`), `RETURNING` |
| **Schema** | `CREATE/DROP TABLE`, `CREATE TABLE … AS SELECT`, `ALTER TABLE` (add / drop / rename column, rename table), `CREATE [UNIQUE] INDEX`, `CREATE VIEW` |
| **Constraints** | `PRIMARY KEY` (incl. composite), `AUTOINCREMENT`, `UNIQUE`, `NOT NULL`, `CHECK`, `DEFAULT`, `FOREIGN KEY … REFERENCES` |
| **Types** | `INTEGER`, `REAL`, `TEXT`, `BOOLEAN` and untyped columns, with SQL three-valued logic and `CAST` |
| **Transactions** | `BEGIN` / `COMMIT` / `ROLLBACK` (data *and* schema changes), statement-level atomicity, `db.transaction(fn)` |
| **Optimizer** | index selection (equality, ranges, `IN`, `BETWEEN`, composite prefixes), predicate push-down, join strategy choice, plan caching |
| **Introspection** | `EXPLAIN`, `SHOW TABLES`, `DESCRIBE`, `db.schema()` |
| **Functions** | 70+ built-ins: string, math, date/time (`DATE`, `DATETIME`, `STRFTIME`, modifiers like `'+1 month'`), conditional (`COALESCE`, `IIF`, `NULLIF`, `CASE`), `PRINTF`, `LIKE … ESCAPE`, `GLOB` |
| **Persistence** | JSON snapshots, SQL dumps, atomic file saves |
| **Tooling** | interactive shell with multi-line input, table / CSV / JSON / line output, East-Asian-width aware tables |

## Getting started

Requires Node.js 20 or newer (Node 22+ also runs the SQLite differential tests).

```sh
git clone https://github.com/otter04/product-buildup-first-test.git minisql
cd minisql
npm install
npm run build

node dist/cli.js            # interactive shell on an in-memory database
node dist/cli.js shop.json  # ...or on a file that is saved after every change
npm test                    # run the test suite
npm run examples            # run the examples in ./examples
npm run bench               # benchmark (compares against SQLite when available)
```

## Library API

```ts
import { Database } from "minisql";

const db = new Database();

db.exec(`
  CREATE TABLE users (
    id    INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name  TEXT,
    karma INTEGER DEFAULT 0 CHECK (karma >= 0)
  )
`);

// run(): data-modifying statements
const { changes, lastInsertRowId } = db.run("INSERT INTO users (email, name) VALUES (?, ?)", ["ada@example.com", "Ada"]);

// query() / get(): rows as objects
db.query("SELECT * FROM users WHERE karma >= :min", { min: 0 }); // [{ id: 1, email: "ada@example.com", name: "Ada", karma: 0 }]
db.get("SELECT COUNT(*) AS n FROM users"); // { n: 1 }

// exec(): every statement of a script, as { columns, rows, changes, lastInsertRowId } results
const [result] = db.exec("SELECT id, name FROM users");
result.columns; // ["id", "name"]
result.rows; // [[1, "Ada"]]

// prepare(): parse and plan once, run many times
const upsertKarma = db.prepare(`
  INSERT INTO users (email, karma) VALUES (?, ?)
  ON CONFLICT (email) DO UPDATE SET karma = users.karma + excluded.karma
  RETURNING karma
`);
upsertKarma.get(["ada@example.com", 5]); // { karma: 5 }

// transaction(): commit on return, roll back on throw
db.transaction((tx) => {
  tx.run("UPDATE users SET karma = karma - 10 WHERE id = 1"); // violates CHECK -> throws
}); // the whole transaction is rolled back
```

| Method | Description |
| --- | --- |
| `exec(sql, params?)` | Runs every statement in `sql`; returns a `QueryResult` per statement |
| `query(sql, params?)` | Rows of the last statement as objects |
| `get(sql, params?)` | First row of the last statement, or `undefined` |
| `run(sql, params?)` | `{ changes, lastInsertRowId }` |
| `prepare(sql)` | A `PreparedStatement` with `all`, `get`, `run`, `values`, `execute` |
| `transaction(fn)` | Runs `fn` in a transaction; nested calls join the outer one |
| `tables()`, `views()`, `columns(table)` | Catalog introspection |
| `schema()` / `dump()` | `CREATE` statements / a full SQL script that recreates the database |
| `toJSON()` / `Database.fromJSON(snapshot)` | Serializable snapshots |

Parameters can be positional (`?`) or named (`:name`, `$name`, `@name`). Values may be `number`, `string`,
`boolean`, `null`, `bigint`, `Date` or `undefined` (treated as `NULL`).

Errors are typed: `SqlSyntaxError` (with `line` and `column`), `SqlCatalogError` (unknown tables, columns,
functions), `SqlConstraintError` and `SqlRuntimeError` all extend `SqlError`.

File persistence lives in the Node-specific entry point so the core stays environment-agnostic:

```ts
import { openDatabase, saveDatabase } from "minisql/node";

const db = openDatabase("app.json"); // .json snapshot or .sql dump; a missing file gives an empty database
db.run("INSERT INTO notes (body) VALUES (?)", ["hello"]);
saveDatabase(db, "app.json"); // written atomically (temp file + rename)
```

## Command-line shell

```
minisql [file] [options]

  -e, --execute <sql>  Execute SQL and exit
  -m, --mode <mode>    Output mode: table (default), csv, json, line
  -h, --help           Show help
  -v, --version        Show version
```

When stdin is not a terminal it is executed as a script, so `minisql -m csv < report.sql > report.csv` works.
Inside the shell, statements end with `;` and can span lines. Dot-commands:

| Command | |
| --- | --- |
| `.tables` | List tables |
| `.schema [table]` | Show `CREATE` statements |
| `.describe <table>` | Show columns |
| `.dump` | Print the database as SQL |
| `.read <file>` | Execute a SQL file |
| `.save [file]` / `.open <file>` | Save to / load from a `.json` snapshot or `.sql` dump |
| `.mode table\|csv\|json\|line` | Output format |
| `.timer on\|off` | Show execution times |

## SQL reference

A few examples of what the engine understands — see the [tests](tests/) for many more.

```sql
-- Window functions with frames
SELECT month, amount,
       SUM(amount) OVER (ORDER BY month) AS running_total,
       AVG(amount) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS moving_avg,
       amount - LAG(amount) OVER (ORDER BY month) AS change
FROM sales WHERE region = 'north';

-- Top-N per group
SELECT * FROM (
  SELECT region, month, amount, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
  FROM sales
) ranked WHERE rn <= 3;

-- Recursive CTE: walk a tree
WITH RECURSIVE path(id, name, depth) AS (
  SELECT id, name, 0 FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, p.name || ' / ' || c.name, p.depth + 1
  FROM categories c JOIN path p ON c.parent_id = p.id
)
SELECT name, depth FROM path ORDER BY name;

-- Correlated subqueries
SELECT name FROM employees e
WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id);

-- Upsert with RETURNING
INSERT INTO inventory (sku, qty) VALUES ('A-1', 5)
ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + excluded.qty
RETURNING sku, qty;

-- Dates
SELECT DATE('2024-01-31', '+1 month'), STRFTIME('%Y-W%W', 'now'), DATETIME('now', 'start of day');
```

**Type system.** Columns declared `INTEGER`, `REAL`, `TEXT` or `BOOLEAN` coerce values on write and reject
values that cannot be represented (`'abc'` into an `INTEGER` column is an error; `'42'` becomes `42`). Columns
without a type accept anything. Common aliases (`INT`, `VARCHAR(n)`, `DOUBLE`, `BOOL`, `DATETIME`, …) are mapped
to these four. Comparisons follow SQL three-valued logic, and numeric strings compare equal to numbers
(`'10' = 10`).

**Primary keys.** A table whose primary key is a single `INTEGER` column is *clustered* on it, like SQLite's
rowid tables: rows are stored and scanned in key order, and `NULL` keys are assigned automatically
(`max + 1`, or never-reused values with `AUTOINCREMENT`).

## How it works

```mermaid
flowchart LR
    SQL[SQL text] --> L[Lexer]
    L --> P[Recursive-descent parser]
    P --> AST
    AST --> QC[Query compiler / planner]
    CAT[(Catalog<br/>tables · views · indexes)] --> QC
    QC --> PLAN[Plan tree of closures]
    PLAN --> EX[Executor]
    EX <--> ST[(Row heap + B+ tree indexes)]
    EX --> J[Undo journal]
    J -. rollback .-> ST
```

1. **Lexer** (`src/lexer.ts`) turns text into tokens with line/column positions; it understands quoted
   identifiers (`"x"`, `` `x` ``, `[x]`), escaped strings, numeric formats, comments and four parameter styles.
2. **Parser** (`src/parser.ts`) is a hand-written recursive-descent parser with precedence climbing for
   expressions. It desugars some syntax (`USING`, `IS [NOT] DISTINCT`-style `IS`, `VALUES` tables) into
   simpler AST nodes. Keywords that are commonly used as names (`key`, `first`, `rows`, …) stay usable as identifiers.
3. **Compiler and planner** (`src/compiler.ts`, `src/planner.ts`) turn the AST into a tree of JavaScript
   closures. Column references are resolved once at compile time into `(depth, index)` pairs, so evaluating
   a correlated subquery just walks up a chain of row environments.
   - `WHERE` and `ON` predicates are split into conjuncts and **pushed down** to the table they reference, or
     attached to the lowest join that covers them, taking care never to move a predicate across the
     null-supplying side of an outer join.
   - For each table scan the planner scores every index against the pushed-down predicates
     (equality prefixes, then a range on the next column, `IN` lists, `BETWEEN`) and picks the best
     **access path**. Probe values are converted to the column's storage type, falling back to a full scan
     whenever an index lookup could miss rows that SQL comparison semantics would match.
   - **Joins** use an *index nested loop* when the inner side is a table with an index on the join key, a
     *hash join* for other equi-joins (hashing values so that `10` and `'10'` collide, then re-checking), and a
     *nested loop* otherwise. `RIGHT` and `FULL` joins track unmatched build-side rows.
   - Uncorrelated subqueries and CTEs are evaluated once per execution; correlation is detected
     automatically during name resolution.
   - Aggregation is hash-based; window functions sort each partition once and compute frames incrementally
     where possible.
4. **Plan cache.** Parameters are read at run time, so compiled plans are reusable. Prepared statements and
   recently executed SQL (an LRU keyed by SQL text) keep their plans until the catalog's schema version
   changes — including when a schema change is rolled back.
5. **Storage** (`src/storage.ts`, `src/btree.ts`) keeps rows in a heap keyed by row id, plus one
   [B+ tree](src/btree.ts) per index with doubly linked leaves for range scans in both directions. Index keys
   are `(column values…, row id)`, which makes every key unique and gives deterministic tie ordering.
6. **Transactions** use an **undo journal**: every mutation — row inserts, updates and deletes, but also
   index creation, `ALTER TABLE`, view and table drops — records a closure that reverts it. Each statement
   remembers the journal position it started at, so a failing statement is undone on its own, and `ROLLBACK`
   unwinds the whole transaction.

## Testing

```sh
npm test            # 350+ tests
npm run typecheck
```

Besides unit tests for every layer (lexer, parser, B+ tree, expressions, joins, aggregates, windows, DML,
DDL, transactions, persistence, the CLI), the suite contains a **differential fuzzer**
([`tests/differential.test.ts`](tests/differential.test.ts)) that runs on Node 22+ via the built-in
`node:sqlite` module:

- It generates random tables with random data (including `NULL`s), then random queries: joins of every
  kind (up to three tables), derived tables and CTEs, correlated `EXISTS` / `IN` / scalar subqueries, set
  operations, aggregates with `HAVING`, `DISTINCT`, `CASE`, string functions, and window functions with
  `ROWS` / `RANGE` frames.
- Each query runs on SQLite and on two minisql databases — one with secondary indexes, one without — and all
  three results must match. This checks query semantics *and* that every index access path returns exactly
  what a full scan would.
- A second fuzzer applies random `INSERT` / `UPDATE` / `DELETE` / upsert statements with `RETURNING` and
  compares the returned rows and the full table contents after every batch.

The default run covers a few thousand queries; while developing, the fuzzer was run with thousands of seeds
(well over half a million statements) with no disagreements. Bugs it caught along the way included scan-order
differences for rowid-aliased primary keys and index tie-breaking — both now match SQLite.

## Performance

`npm run bench` runs a set of workloads on 50,000 orders / 5,000 customers and, when `node:sqlite` is
available, runs the same workloads on SQLite (native C) for reference. Median of five runs on Node 22:

| workload | minisql | SQLite | ratio |
| --- | ---: | ---: | ---: |
| bulk insert (55,000 rows, one transaction) | 268 ms | 70 ms | 3.8× |
| 20,000 point lookups by primary key | 126 ms | 29 ms | 4.4× |
| 20 filtered full scans | 163 ms | 63 ms | 2.6× |
| 200 secondary-index range scans | 133 ms | 62 ms | 2.1× |
| join + group by (index nested loop) | 63 ms | 27 ms | 2.3× |
| join on unindexed columns (hash join) | 190 ms | 98 ms | 1.9× |
| group by + order by | 41 ms | 19 ms | 2.2× |
| window function (running total) | 127 ms | 91 ms | 1.4× |
| sort 50,000 rows | 79 ms | 45 ms | 1.7× |
| correlated subquery | 78 ms | 23 ms | 3.3× |
| update 10% of rows | 16 ms | 5 ms | 3.3× |

Being within a small factor of SQLite comes from a handful of decisions: compiling expressions to closures
instead of interpreting the AST, caching plans, iterating B+ tree leaves in batches, reusing row
environments in hot loops, and only touching the indexes whose keys an `UPDATE` actually changes.

## Differences from SQLite

minisql follows SQLite's behavior closely (that is what the fuzzer checks), with these deliberate differences:

- `/` is always true division (`7 / 2 = 3.5`), because all numbers are JavaScript doubles.
- Columns have strict declared types instead of SQLite's type affinity, and booleans are a real type.
- Foreign keys are always enforced (`RESTRICT` semantics); there is no `PRAGMA`.
- Everything lives in memory; persistence is by snapshot (`.json`) or dump (`.sql`), not page-level I/O.
- Not implemented: triggers, `ALTER TABLE` on views, named windows (`WINDOW w AS …`), `GROUPS` frames,
  collations, `UPDATE … FROM`, blobs.

## Project layout

```
src/
  lexer.ts        tokenizer
  parser.ts       recursive-descent parser → AST (ast.ts)
  compiler.ts     name resolution and expression compilation
  planner.ts      FROM-clause planning, access paths, joins, aggregation, CTEs, EXPLAIN
  window.ts       window function evaluation
  functions.ts    scalar and aggregate functions, LIKE / GLOB
  values.ts       value semantics: comparison, coercion, casting
  btree.ts        B+ tree
  storage.ts      tables, indexes, catalog, undo journal
  database.ts     public API, DDL / DML execution, plan cache, dumps and snapshots
  persistence.ts  file I/O (minisql/node)
  format.ts       table / CSV / JSON rendering
  cli.ts          interactive shell
tests/            unit, integration and differential tests
examples/         runnable examples (quick start, analytics, a to-do app)
bench/            benchmarks
```

## License

[MIT](LICENSE)
