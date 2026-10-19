# Contributing

Thanks for your interest in minisql! This is a small, readable codebase — most changes touch only one or
two files in `src/`.

## Development setup

```sh
npm install
npm run build      # compile to dist/
npm test           # unit, integration and quick differential tests
npm run typecheck
```

Node 22 or newer is recommended: the differential tests compare minisql against SQLite through the built-in
`node:sqlite` module and are skipped on older versions.

## Where things live

| If you want to… | Look at |
| --- | --- |
| add syntax | `src/lexer.ts` (keywords), `src/ast.ts`, `src/parser.ts` |
| add a function | `src/functions.ts` (scalar and aggregate), `src/window.ts` (window-only) |
| change query planning | `src/planner.ts` (`compileFrom`, `chooseAccessPath`, `joinSource`) |
| change expression semantics | `src/compiler.ts`, `src/values.ts` |
| change storage / indexes / rollback | `src/storage.ts`, `src/btree.ts` |
| add a statement | `src/database.ts` (`dispatch`) |

## Guidelines

- **Match SQLite** unless there is a documented reason not to (see "Differences from SQLite" in the
  README). When in doubt, try the query in `sqlite3`.
- **Every mutation must be journaled.** Anything that changes rows or the schema has to record an undo
  closure in the `Journal`, and schema changes must bump the catalog version (`Catalog.touch()`), or cached
  plans will go stale.
- **Add tests** next to similar ones in `tests/`. If the feature exists in SQLite, consider teaching the
  generator in `tests/differential.test.ts` to produce it — that is how most semantic bugs get caught.
- Keep the core free of runtime dependencies and of Node-specific APIs (file access belongs in
  `src/persistence.ts`).

## Fuzzing

```sh
FUZZ_SEEDS=500 npm run fuzz
```

runs 500 seeds of both the query and the DML fuzzer. When a seed fails, the assertion message contains the
offending SQL; reduce it by hand and add it as a regular test.
