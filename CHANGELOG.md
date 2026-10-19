# Changelog

## 0.1.0

First release.

- SQL engine: lexer, recursive-descent parser, closure-compiling query planner and executor
- Queries: joins of every kind, subqueries (correlated at any depth), set operations, `WITH` and
  `WITH RECURSIVE`, aggregates with `DISTINCT`, window functions with `ROWS` / `RANGE` frames
- Writes: `INSERT` / `UPDATE` / `DELETE` with `RETURNING`, upserts with `ON CONFLICT`
- Schema: tables, views, indexes, `ALTER TABLE`; `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `CHECK`, `DEFAULT`,
  foreign keys; clustered `INTEGER PRIMARY KEY` tables
- B+ tree indexes with cost-based access path selection, predicate push-down, index nested loop / hash /
  nested loop joins, plan caching
- Transactions with an undo journal covering data and schema changes
- JSON snapshots and SQL dumps; interactive shell with multiple output modes
- Test suite with differential fuzzing against SQLite; benchmark suite
