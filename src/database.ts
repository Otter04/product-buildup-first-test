import type {
  AlterTableStatement,
  ColumnDef,
  CreateIndexStatement,
  CreateTableStatement,
  DeleteStatement,
  Expr,
  InsertStatement,
  SelectItem,
  Statement,
  UpdateStatement,
} from "./ast.js";
import { compileExpr, exprToSql, normalizeParam, quoteIdent, Scope, walkExpr, type ColumnInfo, type Compiled, type Env } from "./compiler.js";
import { SqlCatalogError, SqlConstraintError, SqlError, SqlRuntimeError } from "./errors.js";
import { Parser, parseExpression } from "./parser.js";
import { QueryCompiler, renderPlan } from "./planner.js";
import { Catalog, Index, Journal, Table, type View } from "./storage.js";
import { coerceToType, formatValue, sqlCompare, toBool, toSqlLiteral, type Row, type SqlValue } from "./values.js";

/** Parameters bound to `?` (array) or `:name` / `$name` / `@name` (object) placeholders. */
export type Params = readonly unknown[] | Record<string, unknown>;

/** The outcome of executing one statement. */
export interface QueryResult {
  /** Statement kind, e.g. "select", "insert", "createTable". */
  type: Statement["type"];
  columns: string[];
  rows: SqlValue[][];
  /** Rows inserted, updated or deleted. */
  changes: number;
  /** Key of the last inserted row (the auto-assigned primary key, if any). */
  lastInsertRowId?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowId?: number;
}

/** Serializable snapshot of a whole database (see {@link Database.toJSON}). */
export interface DatabaseSnapshot {
  format: "minisql";
  version: 1;
  tables: { schema: string; rows: SqlValue[][]; autoIncrementSeq: number }[];
  indexes: string[];
  views?: string[];
}

/** Converts a result's rows into objects keyed by column name. */
export function toObjects(result: Pick<QueryResult, "columns" | "rows">): Row[] {
  return result.rows.map((r) => {
    const obj: Row = {};
    result.columns.forEach((c, i) => {
      obj[c] = r[i]!;
    });
    return obj;
  });
}

function normalizeParams(params: Params | undefined): SqlValue[] | Record<string, SqlValue> {
  if (params === undefined) return [];
  if (Array.isArray(params)) return params.map(normalizeParam);
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(params)) out[k.replace(/^[:$@]/, "")] = normalizeParam(v);
  return out;
}

/** A parsed statement that can be executed many times with different parameters. */
export class PreparedStatement {
  constructor(
    private readonly db: Database,
    private readonly statements: Statement[],
    readonly sql: string,
  ) {
    if (statements.length !== 1) throw new SqlRuntimeError(`prepare() expects exactly one statement, got ${statements.length}`);
  }

  /** Executes the statement and returns the full result. */
  execute(params?: Params): QueryResult {
    return this.db.executeStatement(this.statements[0]!, params);
  }

  /** Returns every result row as an object. */
  all<T extends Row = Row>(params?: Params): T[] {
    return toObjects(this.execute(params)) as T[];
  }

  /** Returns the first result row, or undefined. */
  get<T extends Row = Row>(params?: Params): T | undefined {
    return this.all<T>(params)[0];
  }

  /** Executes a data-modifying statement. */
  run(params?: Params): RunResult {
    const r = this.execute(params);
    return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
  }

  /** Returns each result row as an array of values. */
  values(params?: Params): SqlValue[][] {
    return this.execute(params).rows;
  }
}

/**
 * An in-memory relational database.
 *
 * ```ts
 * const db = new Database();
 * db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
 * db.run("INSERT INTO users (name) VALUES (?)", ["Ada"]);
 * db.query("SELECT * FROM users"); // [{ id: 1, name: "Ada" }]
 * ```
 */
export class Database {
  private readonly catalog = new Catalog();
  private readonly journal = new Journal();
  private transactionDepth = 0;

  /** True while an explicit transaction (BEGIN ... COMMIT) is open. */
  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Executes every statement in `sql`, returning one result per statement. */
  exec(sql: string, params?: Params): QueryResult[] {
    const results: QueryResult[] = [];
    for (const { statement } of new Parser(sql).statements()) results.push(this.executeStatement(statement, params));
    return results;
  }

  /** Runs `sql` and returns the rows of its last statement as objects. */
  query<T extends Row = Row>(sql: string, params?: Params): T[] {
    const results = this.exec(sql, params);
    const last = results[results.length - 1];
    return last ? (toObjects(last) as T[]) : [];
  }

  /** Returns the first row of the last statement in `sql`, or undefined. */
  get<T extends Row = Row>(sql: string, params?: Params): T | undefined {
    return this.query<T>(sql, params)[0];
  }

  /** Executes data-modifying SQL and reports the number of affected rows. */
  run(sql: string, params?: Params): RunResult {
    const results = this.exec(sql, params);
    const changes = results.reduce((n, r) => n + r.changes, 0);
    const lastInsertRowId = [...results].reverse().find((r) => r.lastInsertRowId !== undefined)?.lastInsertRowId;
    return { changes, lastInsertRowId };
  }

  /** Parses a single statement once so it can be executed repeatedly. */
  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this, new Parser(sql).parseScript(), sql);
  }

  /**
   * Runs `fn` inside a transaction: commits if it returns, rolls back if it
   * throws. Nested calls join the outer transaction.
   */
  transaction<T>(fn: (db: this) => T): T {
    if (this.inTransaction) return fn(this);
    this.executeStatement({ type: "begin" });
    try {
      const result = fn(this);
      this.executeStatement({ type: "commit" });
      return result;
    } catch (e) {
      if (this.inTransaction) this.executeStatement({ type: "rollback" });
      throw e;
    }
  }

  /** Names of all tables. */
  tables(): string[] {
    return this.catalog.allTables().map((t) => t.name);
  }

  /** Names of all views. */
  views(): string[] {
    return this.catalog.allViews().map((v) => v.name);
  }

  private viewColumns(view: View): string[] {
    return view.columns ?? new QueryCompiler(this.catalog, []).compileTop(view.query).columns;
  }

  /** Column definitions of a table. */
  columns(table: string): ColumnDef[] {
    return this.catalog.getTable(table).columns.map((c) => ({ ...c }));
  }

  /** The `CREATE TABLE` / `CREATE INDEX` / `CREATE VIEW` statements describing the schema. */
  schema(): string {
    const parts: string[] = [];
    for (const table of this.orderedTables()) parts.push(createTableSql(table) + ";");
    for (const index of this.catalog.allIndexes()) if (!index.implicit) parts.push(createIndexSql(index) + ";");
    for (const view of this.catalog.allViews()) parts.push(createViewSql(view) + ";");
    return parts.join("\n");
  }

  /** A SQL script that recreates the database (schema and data). */
  dump(): string {
    const lines: string[] = ["BEGIN;"];
    for (const table of this.orderedTables()) {
      lines.push(createTableSql(table) + ";");
      const cols = table.columns.map((c) => quoteIdent(c.name)).join(", ");
      for (const row of table.scan()) {
        lines.push(`INSERT INTO ${quoteIdent(table.name)} (${cols}) VALUES (${row.map(toSqlLiteral).join(", ")});`);
      }
    }
    for (const index of this.catalog.allIndexes()) if (!index.implicit) lines.push(createIndexSql(index) + ";");
    for (const view of this.catalog.allViews()) lines.push(createViewSql(view) + ";");
    lines.push("COMMIT;");
    return lines.join("\n") + "\n";
  }

  /** A JSON-serializable snapshot of the database. */
  toJSON(): DatabaseSnapshot {
    if (this.inTransaction) throw new SqlRuntimeError("Cannot snapshot a database with an open transaction");
    return {
      format: "minisql",
      version: 1,
      tables: this.orderedTables().map((t) => ({
        schema: createTableSql(t),
        rows: [...t.scan()].map((r) => [...r]),
        autoIncrementSeq: t.autoIncrementSeq,
      })),
      indexes: this.catalog
        .allIndexes()
        .filter((i) => !i.implicit)
        .map(createIndexSql),
      views: this.catalog.allViews().map(createViewSql),
    };
  }

  /** Restores a database from {@link Database.toJSON} output. */
  static fromJSON(snapshot: DatabaseSnapshot): Database {
    if (snapshot.format !== "minisql" || snapshot.version !== 1) throw new SqlError("Unsupported snapshot format");
    const db = new Database();
    for (const t of snapshot.tables) {
      const stmt = new Parser(t.schema).parseSingle();
      if (stmt.type !== "createTable") throw new SqlError("Corrupt snapshot: expected CREATE TABLE");
      db.executeStatement(stmt);
      const table = db.catalog.getTable(stmt.name);
      for (const row of t.rows) {
        if (row.length !== table.columns.length) throw new SqlError(`Corrupt snapshot: bad row width in ${table.name}`);
        table.load([...row]);
      }
      table.autoIncrementSeq = t.autoIncrementSeq;
    }
    for (const sql of snapshot.indexes) db.exec(sql);
    for (const sql of snapshot.views ?? []) db.exec(sql);
    db.journal.truncate();
    return db;
  }

  // -------------------------------------------------------------------------
  // Statement dispatch
  // -------------------------------------------------------------------------

  /** Executes one parsed statement with statement-level atomicity. */
  executeStatement(stmt: Statement, params?: Params): QueryResult {
    const normalized = normalizeParams(params);
    const mark = this.journal.length;
    try {
      const result = this.dispatch(stmt, normalized);
      if (!this.inTransaction) this.journal.truncate();
      return result;
    } catch (e) {
      this.journal.rollbackTo(mark);
      throw e;
    }
  }

  private dispatch(stmt: Statement, params: SqlValue[] | Record<string, SqlValue>): QueryResult {
    const empty = (changes = 0): QueryResult => ({ type: stmt.type, columns: [], rows: [], changes });
    switch (stmt.type) {
      case "select": {
        const compiled = new QueryCompiler(this.catalog, params).compileTop(stmt);
        return { type: "select", columns: compiled.columns, rows: [...compiled.run()], changes: 0 };
      }
      case "insert":
        return this.insert(stmt, params);
      case "update":
        return this.update(stmt, params);
      case "delete":
        return this.delete(stmt, params);
      case "createTable":
        this.createTable(stmt, params);
        return empty();
      case "dropTable": {
        const table = this.catalog.findTable(stmt.name);
        if (!table) {
          if (this.catalog.findView(stmt.name)) throw new SqlCatalogError(`'${stmt.name}' is a view; use DROP VIEW`);
          if (stmt.ifExists) return empty();
          throw new SqlCatalogError(`No such table: ${stmt.name}`);
        }
        for (const other of this.catalog.allTables()) {
          if (other === table) continue;
          for (const c of other.columns) {
            if (c.references?.table.toLowerCase() === table.name.toLowerCase()) {
              throw new SqlConstraintError(`Cannot drop table '${table.name}': referenced by ${other.name}.${c.name}`);
            }
          }
        }
        this.catalog.removeTable(table, this.journal);
        return empty();
      }
      case "createIndex":
        this.createIndex(stmt);
        return empty();
      case "createView": {
        if (this.catalog.findView(stmt.name)) {
          if (stmt.ifNotExists) return empty();
          throw new SqlCatalogError(`View '${stmt.name}' already exists`);
        }
        const view = { name: stmt.name, columns: stmt.columns, query: stmt.query, queryText: stmt.queryText };
        // Validate by compiling (also rejects parameters, which views cannot hold).
        const compiled = new QueryCompiler(this.catalog, []).compileTop(stmt.query);
        if (stmt.columns && stmt.columns.length !== compiled.columns.length) {
          throw new SqlCatalogError(`View '${stmt.name}' declares ${stmt.columns.length} columns but its query returns ${compiled.columns.length}`);
        }
        this.catalog.addView(view, this.journal);
        return empty();
      }
      case "dropView": {
        const view = this.catalog.findView(stmt.name);
        if (!view) {
          if (stmt.ifExists) return empty();
          throw new SqlCatalogError(`No such view: ${stmt.name}`);
        }
        this.catalog.removeView(view, this.journal);
        return empty();
      }
      case "dropIndex": {
        const index = this.catalog.getIndex(stmt.name);
        if (!index) {
          if (stmt.ifExists) return empty();
          throw new SqlCatalogError(`No such index: ${stmt.name}`);
        }
        if (index.implicit) throw new SqlCatalogError(`Index '${index.name}' backs a constraint and cannot be dropped`);
        this.catalog.removeIndex(index, this.journal);
        return empty();
      }
      case "alterTable":
        this.alterTable(stmt);
        return empty();
      case "begin":
        if (this.inTransaction) throw new SqlRuntimeError("Cannot BEGIN: a transaction is already open");
        this.journal.truncate();
        this.transactionDepth = 1;
        return empty();
      case "commit":
        if (!this.inTransaction) throw new SqlRuntimeError("Cannot COMMIT: no transaction is open");
        this.transactionDepth = 0;
        this.journal.truncate();
        return empty();
      case "rollback":
        if (!this.inTransaction) throw new SqlRuntimeError("Cannot ROLLBACK: no transaction is open");
        this.journal.rollbackTo(0);
        this.transactionDepth = 0;
        return empty();
      case "explain": {
        const compiler = new QueryCompiler(this.catalog, params);
        const inner = stmt.statement;
        let lines: string[];
        if (inner.type === "select") {
          lines = renderPlan(compiler.compileTop(inner).plan);
        } else {
          const table = this.catalog.getTable(inner.table);
          const { plan } = compiler.compileTableScan(table, inner.alias, inner.where);
          lines = renderPlan({ label: `${inner.type.toUpperCase()} ${table.name}`, children: [plan] });
        }
        return { type: "explain", columns: ["plan"], rows: lines.map((l) => [l]), changes: 0 };
      }
      case "showTables": {
        const tables: SqlValue[][] = this.catalog.allTables().map((t) => [t.name, "table", t.columns.length, t.rows.size]);
        const views: SqlValue[][] = this.catalog.allViews().map((v) => [v.name, "view", this.viewColumns(v).length, null]);
        return {
          type: "showTables",
          columns: ["name", "type", "columns", "rows"],
          rows: [...tables, ...views].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
          changes: 0,
        };
      }
      case "describe": {
        const view = this.catalog.findView(stmt.table);
        if (view) {
          return {
            type: "describe",
            columns: ["name", "type", "nullable", "key", "default", "extra"],
            rows: this.viewColumns(view).map((c) => [c, "ANY", "YES", "", null, "view column"]),
            changes: 0,
          };
        }
        const table = this.catalog.getTable(stmt.table);
        const pk = table.primaryKey;
        return {
          type: "describe",
          columns: ["name", "type", "nullable", "key", "default", "extra"],
          rows: table.columns.map((c, i) => {
            const key = pk?.columnIndexes.includes(i)
              ? "PRI"
              : table.indexes.some((ix) => ix.unique && ix.columnIndexes.length === 1 && ix.columnIndexes[0] === i)
                ? "UNI"
                : table.indexes.some((ix) => ix.columnIndexes[0] === i)
                  ? "MUL"
                  : "";
            const extra = [
              c.autoIncrement ? "autoincrement" : "",
              c.check ? `check ${exprToSql(c.check)}` : "",
              c.references ? `references ${c.references.table}${c.references.column ? `(${c.references.column})` : ""}` : "",
            ]
              .filter(Boolean)
              .join(", ");
            return [c.name, c.type, c.notNull ? "NO" : "YES", key, c.defaultValue ? exprToSql(c.defaultValue) : null, extra];
          }),
          changes: 0,
        };
      }
    }
  }

  // -------------------------------------------------------------------------
  // DDL
  // -------------------------------------------------------------------------

  private createTable(stmt: CreateTableStatement, params: SqlValue[] | Record<string, SqlValue>): void {
    if (this.catalog.hasTable(stmt.name)) {
      if (stmt.ifNotExists) return;
      throw new SqlCatalogError(`Table '${stmt.name}' already exists`);
    }

    if (stmt.asSelect) {
      const compiled = new QueryCompiler(this.catalog, params).compileTop(stmt.asSelect);
      const rows = [...compiled.run()];
      const seen = new Set<string>();
      const columns: ColumnDef[] = compiled.columns.map((name) => {
        let unique = name;
        for (let i = 2; seen.has(unique.toLowerCase()); i++) unique = `${name}_${i}`;
        seen.add(unique.toLowerCase());
        return { name: unique, type: "ANY", notNull: false, primaryKey: false, unique: false, autoIncrement: false };
      });
      const table = new Table(stmt.name, columns);
      this.catalog.addTable(table, this.journal);
      for (const row of rows) table.insert(row, this.journal);
      return;
    }

    const names = new Set<string>();
    for (const c of stmt.columns) {
      const lower = c.name.toLowerCase();
      if (names.has(lower)) throw new SqlCatalogError(`Duplicate column name '${c.name}' in table '${stmt.name}'`);
      names.add(lower);
    }

    const columns = stmt.columns.map((c) => ({ ...c }));
    const pkColumns = columns.filter((c) => c.primaryKey).map((c) => c.name);
    const tablePks = stmt.constraints.filter((c) => c.kind === "primaryKey");
    if (pkColumns.length + tablePks.length > 1) throw new SqlCatalogError(`Table '${stmt.name}' has more than one primary key`);
    let primaryKey = pkColumns.length ? pkColumns : tablePks[0]?.columns;

    const table = new Table(stmt.name, columns);
    for (const c of stmt.constraints) for (const name of c.columns) table.columnIndex(name);
    if (primaryKey) {
      primaryKey = primaryKey.map((n) => table.columns[table.columnIndex(n)]!.name);
      for (const name of primaryKey) {
        const col = table.columns[table.columnIndex(name)]!;
        col.notNull = true;
        if (primaryKey.length === 1) col.primaryKey = true;
      }
    }

    // Validate defaults, checks and references up front.
    for (const col of columns) {
      if (col.defaultValue) this.evaluateDefault(col.defaultValue);
      if (col.check) this.compileCheck(table, col.check);
      if (col.references) {
        const ref = col.references;
        const parent = ref.table.toLowerCase() === stmt.name.toLowerCase() ? table : this.catalog.getTable(ref.table);
        if (ref.column) parent.columnIndex(ref.column);
        else if (!parent.columns.some((c) => c.primaryKey) && parent !== table) {
          throw new SqlCatalogError(`Referenced table '${parent.name}' has no single-column primary key`);
        }
      }
    }

    this.catalog.addTable(table, this.journal);
    if (primaryKey) {
      this.catalog.addIndex(new Index(`pk_${table.name}`, table, primaryKey, true, true), this.journal);
    }
    for (const col of columns) {
      if (col.unique && !col.primaryKey) {
        this.catalog.addIndex(new Index(`uq_${table.name}_${col.name}`, table, [col.name], true, true), this.journal);
      }
    }
    for (const c of stmt.constraints) {
      if (c.kind === "unique") {
        this.catalog.addIndex(new Index(`uq_${table.name}_${c.columns.join("_")}`, table, c.columns, true, true), this.journal);
      }
    }
  }

  private createIndex(stmt: CreateIndexStatement): void {
    if (this.catalog.getIndex(stmt.name)) {
      if (stmt.ifNotExists) return;
      throw new SqlCatalogError(`Index '${stmt.name}' already exists`);
    }
    const table = this.catalog.getTable(stmt.table);
    const columns = stmt.columns.map((c) => table.columns[table.columnIndex(c)]!.name);
    this.catalog.addIndex(new Index(stmt.name, table, columns, stmt.unique, false), this.journal);
  }

  private alterTable(stmt: AlterTableStatement): void {
    const table = this.catalog.getTable(stmt.table);
    const action = stmt.action;
    switch (action.kind) {
      case "renameTable": {
        const oldName = table.name;
        this.catalog.renameTable(table, action.to, this.journal);
        this.updateReferences((ref) => {
          if (ref.table.toLowerCase() === oldName.toLowerCase()) ref.table = action.to;
        });
        return;
      }
      case "renameColumn": {
        const idx = table.columnIndex(action.from);
        if (table.hasColumn(action.to)) throw new SqlCatalogError(`Column '${action.to}' already exists in '${table.name}'`);
        const oldName = table.columns[idx]!.name;
        this.snapshotTable(table);
        table.columns = table.columns.map((c, i) => (i === idx ? { ...c, name: action.to } : { ...c }));
        for (const c of table.columns) {
          if (c.check) c.check = renameColumnInExpr(c.check, oldName, action.to);
        }
        for (const index of table.indexes) {
          index.columns = index.columns.map((c) => (c.toLowerCase() === oldName.toLowerCase() ? action.to : c));
          index.resolveColumns();
        }
        this.updateReferences((ref) => {
          if (ref.table.toLowerCase() === table.name.toLowerCase() && ref.column?.toLowerCase() === oldName.toLowerCase()) {
            ref.column = action.to;
          }
        });
        return;
      }
      case "addColumn": {
        const col = { ...action.column };
        if (table.hasColumn(col.name)) throw new SqlCatalogError(`Column '${col.name}' already exists in '${table.name}'`);
        if (col.primaryKey) throw new SqlCatalogError("Cannot add a PRIMARY KEY column with ALTER TABLE");
        if (col.autoIncrement) throw new SqlCatalogError("Cannot add an AUTOINCREMENT column with ALTER TABLE");
        let value: SqlValue = null;
        if (col.defaultValue) value = coerceToType(this.evaluateDefault(col.defaultValue), col.type, col.name);
        if (col.notNull && value === null && table.rows.size > 0) {
          throw new SqlConstraintError(`Cannot add NOT NULL column '${col.name}' without a non-NULL default to a non-empty table`);
        }
        if (col.references) this.catalog.getTable(col.references.table);
        this.snapshotTable(table);
        table.columns = [...table.columns, col];
        if (col.check) {
          const check = this.compileCheck(table, col.check);
          for (const row of table.rows.values()) {
            if (!check({ row: [...row, value] })) throw new SqlConstraintError(`CHECK constraint failed for new column '${col.name}'`);
          }
        }
        for (const [id, row] of [...table.rows]) table.rows.set(id, [...row, value]);
        if (col.unique) {
          this.catalog.addIndex(new Index(`uq_${table.name}_${col.name}`, table, [col.name], true, true), this.journal);
        }
        return;
      }
      case "dropColumn": {
        const idx = table.columnIndex(action.name);
        const name = table.columns[idx]!.name;
        if (table.columns.length === 1) throw new SqlCatalogError(`Cannot drop the only column of '${table.name}'`);
        for (const index of table.indexes) {
          if (index.columnIndexes.includes(idx)) {
            throw new SqlCatalogError(`Cannot drop column '${name}': it is used by index '${index.name}'`);
          }
        }
        for (const other of this.catalog.allTables()) {
          for (const c of other.columns) {
            const ref = c.references;
            if (ref && ref.table.toLowerCase() === table.name.toLowerCase()) {
              const target = ref.column ?? table.columns.find((x) => x.primaryKey)?.name;
              if (target?.toLowerCase() === name.toLowerCase()) {
                throw new SqlCatalogError(`Cannot drop column '${name}': referenced by ${other.name}.${c.name}`);
              }
            }
          }
        }
        for (const c of table.columns) {
          if (c.check && c !== table.columns[idx]) {
            walkExpr(c.check, (e) => {
              if (e.kind === "column" && e.name.toLowerCase() === name.toLowerCase()) {
                throw new SqlCatalogError(`Cannot drop column '${name}': used by CHECK constraint on '${c.name}'`);
              }
            });
          }
        }
        this.snapshotTable(table);
        table.columns = table.columns.filter((_, i) => i !== idx);
        for (const [id, row] of [...table.rows]) table.rows.set(id, row.filter((_, i) => i !== idx));
        for (const index of table.indexes) {
          index.resolveColumns();
          table.populateIndex(index);
        }
        return;
      }
    }
  }

  /** Records enough state to undo an in-place schema change of `table`. */
  private snapshotTable(table: Table): void {
    const columns = table.columns;
    const rows = new Map(table.rows);
    const indexColumns = table.indexes.map((i) => [i, i.columns] as const);
    const references = this.catalog.allTables().flatMap((t) => t.columns.filter((c) => c.references).map((c) => [c, { ...c.references! }] as const));
    this.journal.record(() => {
      table.columns = columns;
      table.rows.clear();
      for (const [id, row] of rows) table.rows.set(id, row);
      for (const [index, cols] of indexColumns) {
        index.columns = cols;
        index.resolveColumns();
        table.populateIndex(index);
      }
      for (const [col, ref] of references) col.references = ref;
    });
  }

  private updateReferences(fn: (ref: { table: string; column?: string }) => void): void {
    for (const t of this.catalog.allTables()) {
      for (const c of t.columns) {
        if (!c.references) continue;
        const before = { ...c.references };
        const after = { ...c.references };
        fn(after);
        if (before.table !== after.table || before.column !== after.column) {
          c.references = after;
          this.journal.record(() => {
            c.references = before;
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DML
  // -------------------------------------------------------------------------

  private evaluateDefault(expr: Expr): SqlValue {
    const compiled = compileExpr(expr, new Scope([]), {
      params: [],
      compileSubquery: () => {
        throw new SqlRuntimeError("Subqueries are not allowed in DEFAULT expressions");
      },
    });
    return compiled({ row: [] });
  }

  private compileCheck(table: Table, check: Expr): (env: { row: SqlValue[] }) => boolean {
    const columns: ColumnInfo[] = table.columns.map((c) => ({ table: table.name, name: c.name }));
    const compiled = compileExpr(check, new Scope(columns), {
      params: [],
      compileSubquery: () => {
        throw new SqlRuntimeError("Subqueries are not allowed in CHECK constraints");
      },
    });
    // A CHECK passes unless it evaluates to FALSE (NULL is allowed).
    return (env) => {
      const v = compiled(env);
      return v === null || toBool(v) === true;
    };
  }

  /** Builds the per-statement validator that coerces and checks a candidate row. */
  private rowValidator(table: Table): (row: SqlValue[]) => SqlValue[] {
    const checks = table.columns.flatMap((c) => (c.check ? [{ column: c.name, check: this.compileCheck(table, c.check), expr: c.check }] : []));
    const references = table.columns.flatMap((c, i) => {
      if (!c.references) return [];
      const parent = this.catalog.getTable(c.references.table);
      const parentCol = c.references.column ? parent.columnIndex(c.references.column) : parent.columns.findIndex((x) => x.primaryKey);
      if (parentCol < 0) throw new SqlCatalogError(`Referenced table '${parent.name}' has no single-column primary key`);
      return [{ column: i, parent, parentCol }];
    });
    return (row) => {
      const out = row.map((v, i) => {
        const col = table.columns[i]!;
        const value = coerceToType(v, col.type, col.name);
        if (value === null && col.notNull) {
          throw new SqlConstraintError(`NOT NULL constraint failed: ${table.name}.${col.name}`);
        }
        return value;
      });
      for (const c of checks) {
        if (!c.check({ row: out })) throw new SqlConstraintError(`CHECK constraint failed: ${table.name}.${c.column} (${exprToSql(c.expr)})`);
      }
      for (const ref of references) {
        const v = out[ref.column]!;
        if (v === null) continue;
        if (ref.parent === table && sqlCompare(out[ref.parentCol]!, v) === 0) continue;
        if (!findRow(ref.parent, ref.parentCol, v)) {
          throw new SqlConstraintError(
            `FOREIGN KEY constraint failed: ${table.name}.${table.columns[ref.column]!.name} = ${formatValue(v)} has no match in ${ref.parent.name}.${ref.parent.columns[ref.parentCol]!.name}`,
          );
        }
      }
      return out;
    };
  }

  /** Throws if removing / changing `oldRow` would orphan rows in referencing tables. */
  private checkNotReferenced(table: Table, oldRow: SqlValue[], newRow?: SqlValue[]): void {
    for (const child of this.catalog.allTables()) {
      child.columns.forEach((c, childCol) => {
        const ref = c.references;
        if (!ref || ref.table.toLowerCase() !== table.name.toLowerCase()) return;
        const parentCol = ref.column ? table.columnIndex(ref.column) : table.columns.findIndex((x) => x.primaryKey);
        if (parentCol < 0) return;
        const oldValue = oldRow[parentCol]!;
        if (oldValue === null) return;
        if (newRow && sqlCompare(newRow[parentCol]!, oldValue) === 0) return;
        const hit = findRow(child, childCol, oldValue);
        // A self-referencing row may point at itself.
        if (hit && !(child === table && hit === oldRow)) {
          throw new SqlConstraintError(
            `FOREIGN KEY constraint failed: ${table.name}.${table.columns[parentCol]!.name} = ${formatValue(oldValue)} is still referenced by ${child.name}.${c.name}`,
          );
        }
      });
    }
  }

  /** Compiles a RETURNING clause into a function producing one result row per affected row. */
  private compileReturning(
    compiler: QueryCompiler,
    table: Table,
    alias: string | undefined,
    items: SelectItem[] | undefined,
  ): { columns: string[]; evaluate: (row: SqlValue[]) => SqlValue[] } | undefined {
    if (!items) return undefined;
    const qualifier = alias ?? table.name;
    const scopeColumns: ColumnInfo[] = table.columns.map((c) => ({ table: qualifier, name: c.name }));
    const columns: string[] = [];
    const exprs: Compiled[] = [];
    for (const item of items) {
      if (item.expr.kind === "star") {
        if (item.expr.table && item.expr.table.toLowerCase() !== qualifier.toLowerCase()) {
          throw new SqlCatalogError(`No such table: ${item.expr.table}`);
        }
        table.columns.forEach((c, i) => {
          columns.push(c.name);
          exprs.push((env) => env.row[i]!);
        });
        continue;
      }
      columns.push(item.alias ?? (item.expr.kind === "column" ? item.expr.name : item.text ?? exprToSql(item.expr)));
      exprs.push(compiler.compileRowExpr(item.expr, scopeColumns));
    }
    return { columns, evaluate: (row) => exprs.map((e) => e({ row })) };
  }

  private insert(stmt: InsertStatement, params: SqlValue[] | Record<string, SqlValue>): QueryResult {
    const table = this.catalog.getTable(stmt.table);
    const compiler = new QueryCompiler(this.catalog, params);
    const targetIdx = stmt.columns ? stmt.columns.map((c) => table.columnIndex(c)) : table.columns.map((_, i) => i);
    if (new Set(targetIdx).size !== targetIdx.length) throw new SqlCatalogError("Duplicate column in INSERT column list");

    let sourceRows: SqlValue[][];
    if (stmt.select) {
      const compiled = compiler.compileTop(stmt.select);
      if (compiled.columns.length !== targetIdx.length) {
        throw new SqlRuntimeError(`INSERT expects ${targetIdx.length} values but the SELECT returns ${compiled.columns.length} columns`);
      }
      // Materialize first so `INSERT INTO t SELECT ... FROM t` terminates.
      sourceRows = [...compiled.run()];
    } else {
      const values = stmt.values!;
      const isDefaultValues = values.length === 1 && values[0]!.length === 0 && !stmt.columns;
      sourceRows = values.map((exprs) => {
        if (isDefaultValues) return [];
        if (exprs.length !== targetIdx.length) {
          throw new SqlRuntimeError(`INSERT expects ${targetIdx.length} values per row, got ${exprs.length}`);
        }
        return exprs.map((e) => compiler.compileRowExpr(e, [])({ row: [] }));
      });
      if (isDefaultValues) targetIdx.length = 0;
    }

    const upsert = this.compileUpsert(compiler, table, stmt);
    const returning = this.compileReturning(compiler, table, undefined, stmt.returning);
    const returned: SqlValue[][] = [];
    const defaults = table.columns.map((c) => c.defaultValue);
    const autoCol = autoAssignColumn(table);
    const validate = this.rowValidator(table);
    const referenced = this.isReferenced(table);
    let lastInsertRowId: number | undefined;
    let changes = 0;
    const seqBefore = table.autoIncrementSeq;
    this.journal.record(() => {
      table.autoIncrementSeq = seqBefore;
    });

    for (const source of sourceRows) {
      const row: (SqlValue | undefined)[] = table.columns.map(() => undefined);
      targetIdx.forEach((col, i) => {
        row[col] = source[i]!;
      });
      for (let i = 0; i < row.length; i++) {
        if (row[i] !== undefined) continue;
        row[i] = defaults[i] ? this.evaluateDefault(defaults[i]!) : null;
      }
      if (autoCol >= 0 && row[autoCol] === null) {
        // Like SQLite: AUTOINCREMENT never reuses a value; a plain INTEGER
        // PRIMARY KEY takes one more than the current maximum.
        const max = maxIntegerIn(table, autoCol);
        row[autoCol] = table.columns[autoCol]!.autoIncrement ? Math.max(table.autoIncrementSeq, max) + 1 : max + 1;
      }
      const finalRow = validate(row as SqlValue[]);

      if (upsert) {
        const conflictId = upsert.findConflict(finalRow);
        if (conflictId !== undefined) {
          if (upsert.action === "nothing") continue;
          const existing = table.rows.get(conflictId)!;
          const env = { row: existing, outer: { row: finalRow } };
          if (upsert.where && !upsert.where(env)) continue;
          const updated = existing.slice();
          for (const a of upsert.assignments) updated[a.col] = a.value(env);
          const validated = validate(updated);
          if (referenced) this.checkNotReferenced(table, existing, validated);
          table.update(conflictId, validated, this.journal);
          changes++;
          if (returning) returned.push(returning.evaluate(validated));
          continue;
        }
      }

      if (autoCol >= 0 && table.columns[autoCol]!.autoIncrement) {
        const assigned = finalRow[autoCol];
        if (typeof assigned === "number") table.autoIncrementSeq = Math.max(table.autoIncrementSeq, assigned);
      }
      const rowId = table.insert(finalRow, this.journal);
      lastInsertRowId = autoCol >= 0 ? (finalRow[autoCol] as number) : rowId;
      changes++;
      if (returning) returned.push(returning.evaluate(finalRow));
    }
    return { type: "insert", columns: returning?.columns ?? [], rows: returned, changes, lastInsertRowId };
  }

  /** Prepares the ON CONFLICT clause of an INSERT, if any. */
  private compileUpsert(compiler: QueryCompiler, table: Table, stmt: InsertStatement) {
    const clause = stmt.onConflict;
    if (!clause) return undefined;
    let target: Index | undefined;
    if (clause.target) {
      const cols = clause.target.map((c) => table.columnIndex(c)).sort((a, b) => a - b);
      target = table.indexes.find(
        (ix) => ix.unique && ix.columnIndexes.length === cols.length && [...ix.columnIndexes].sort((a, b) => a - b).every((c, i) => c === cols[i]),
      );
      if (!target) throw new SqlCatalogError("ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint");
    }
    // DO UPDATE expressions see the existing row as the table and the proposed
    // row as `excluded` (an outer scope, so unqualified names mean the table).
    const columns: ColumnInfo[] = table.columns.map((c) => ({ table: table.name, name: c.name }));
    const excluded: ColumnInfo[] = table.columns.map((c) => ({ table: "excluded", name: c.name }));
    return {
      action: clause.action,
      assignments: clause.assignments.map((a) => ({ col: table.columnIndex(a.column), value: compiler.compileRowExpr(a.value, columns, excluded) })),
      where: clause.where ? predicateOf(compiler.compileRowExpr(clause.where, columns, excluded)) : undefined,
      findConflict: (row: SqlValue[]): number | undefined => {
        if (target) return target.findConflict(row);
        for (const ix of table.indexes) {
          if (!ix.unique) continue;
          const hit = ix.findConflict(row);
          if (hit !== undefined) return hit;
        }
        return undefined;
      },
    };
  }

  private update(stmt: UpdateStatement, params: SqlValue[] | Record<string, SqlValue>): QueryResult {
    const table = this.catalog.getTable(stmt.table);
    const compiler = new QueryCompiler(this.catalog, params);
    const name = stmt.alias ?? table.name;
    const columns: ColumnInfo[] = table.columns.map((c) => ({ table: name, name: c.name }));
    const assignments: { col: number; value: Compiled }[] = stmt.assignments.map((a) => ({
      col: table.columnIndex(a.column),
      value: compiler.compileRowExpr(a.value, columns),
    }));
    const returning = this.compileReturning(compiler, table, stmt.alias, stmt.returning);
    const { scan } = compiler.compileTableScan(table, stmt.alias, stmt.where);
    const ids = [...scan()];
    const validate = this.rowValidator(table);
    const referenced = this.isReferenced(table);
    const returned: SqlValue[][] = [];
    for (const id of ids) {
      const oldRow = table.rows.get(id)!;
      const newRow = oldRow.slice();
      for (const a of assignments) newRow[a.col] = a.value({ row: oldRow });
      const finalRow = validate(newRow);
      if (referenced) this.checkNotReferenced(table, oldRow, finalRow);
      table.update(id, finalRow, this.journal);
      if (returning) returned.push(returning.evaluate(finalRow));
    }
    return { type: "update", columns: returning?.columns ?? [], rows: returned, changes: ids.length };
  }

  private delete(stmt: DeleteStatement, params: SqlValue[] | Record<string, SqlValue>): QueryResult {
    const table = this.catalog.getTable(stmt.table);
    const compiler = new QueryCompiler(this.catalog, params);
    const returning = this.compileReturning(compiler, table, stmt.alias, stmt.returning);
    const { scan } = compiler.compileTableScan(table, stmt.alias, stmt.where);
    const ids = [...scan()];
    const referenced = this.isReferenced(table);
    const returned: SqlValue[][] = [];
    for (const id of ids) {
      const row = table.rows.get(id)!;
      // Evaluate RETURNING before the row disappears (its subqueries may read the table).
      if (returning) returned.push(returning.evaluate(row));
      table.delete(id, this.journal);
      if (referenced) this.checkNotReferenced(table, row);
    }
    return { type: "delete", columns: returning?.columns ?? [], rows: returned, changes: ids.length };
  }

  private isReferenced(table: Table): boolean {
    const lname = table.name.toLowerCase();
    return this.catalog.allTables().some((t) => t.columns.some((c) => c.references?.table.toLowerCase() === lname));
  }

  /** Tables ordered so that referenced (parent) tables come before their children. */
  private orderedTables(): Table[] {
    const tables = this.catalog.allTables();
    const ordered: Table[] = [];
    const state = new Map<Table, "visiting" | "done">();
    const visit = (t: Table): void => {
      if (state.get(t)) return;
      state.set(t, "visiting");
      for (const c of t.columns) {
        if (!c.references) continue;
        const parent = this.catalog.findTable(c.references.table);
        if (parent && parent !== t && !state.get(parent)) visit(parent);
      }
      state.set(t, "done");
      ordered.push(t);
    };
    for (const t of tables) visit(t);
    return ordered;
  }
}

/** The column whose NULL values are replaced by the next sequence number, or -1. */
function autoAssignColumn(table: Table): number {
  const auto = table.autoIncrementColumn;
  if (auto >= 0) return auto;
  const pk = table.primaryKey;
  if (pk && pk.columnIndexes.length === 1) {
    const col = pk.columnIndexes[0]!;
    if (table.columns[col]!.type === "INTEGER") return col;
  }
  return -1;
}

function maxIntegerIn(table: Table, col: number): number {
  const pk = table.primaryKey;
  if (pk && pk.columnIndexes.length === 1 && pk.columnIndexes[0] === col) {
    // The primary key index is ordered: its last entry holds the maximum.
    for (const id of pk.scan(true)) {
      const v = table.rows.get(id)?.[col];
      return typeof v === "number" ? v : 0;
    }
    return 0;
  }
  let max = 0;
  for (const row of table.rows.values()) {
    const v = row[col];
    if (typeof v === "number" && v > max) max = v;
  }
  return max;
}

/** Finds a row whose column equals `value`, using an index when one exists. */
function findRow(table: Table, col: number, value: SqlValue): SqlValue[] | undefined {
  const index = table.indexes.find((i) => i.columnIndexes[0] === col);
  if (index) {
    const type = table.columns[col]!.type;
    let probe: SqlValue | undefined = value;
    try {
      probe = coerceToType(value, type, table.columns[col]!.name);
    } catch {
      probe = undefined;
    }
    if (probe !== undefined && probe !== null) {
      for (const id of index.lookup([probe])) {
        const row = table.rows.get(id);
        if (row) return row;
      }
      if (type !== "ANY") return undefined;
    }
  }
  for (const row of table.rows.values()) if (sqlCompare(row[col]!, value) === 0) return row;
  return undefined;
}

function predicateOf(compiled: Compiled): (env: Env) => boolean {
  return (env) => toBool(compiled(env)) === true;
}

function renameColumnInExpr(expr: Expr, from: string, to: string): Expr {
  const clone = structuredClone(expr);
  walkExpr(clone, (e) => {
    if (e.kind === "column" && e.name.toLowerCase() === from.toLowerCase()) e.name = to;
  });
  return clone;
}

export function createTableSql(table: Table): string {
  const pk = table.primaryKey;
  const lines = table.columns.map((c) => {
    let s = `  ${quoteIdent(c.name)}`;
    if (c.type !== "ANY") s += ` ${c.type}`;
    if (c.primaryKey) s += " PRIMARY KEY";
    if (c.autoIncrement) s += " AUTOINCREMENT";
    if (c.notNull && !c.primaryKey) s += " NOT NULL";
    if (c.unique && !c.primaryKey) s += " UNIQUE";
    if (c.defaultValue) s += ` DEFAULT ${wrapDefault(c.defaultValue)}`;
    if (c.check) s += ` CHECK (${exprToSql(c.check)})`;
    if (c.references) s += ` REFERENCES ${quoteIdent(c.references.table)}${c.references.column ? `(${quoteIdent(c.references.column)})` : ""}`;
    return s;
  });
  if (pk && pk.columns.length > 1) lines.push(`  PRIMARY KEY (${pk.columns.map(quoteIdent).join(", ")})`);
  for (const index of table.indexes) {
    if (index.implicit && index.unique && index !== pk && index.columns.length > 1) {
      lines.push(`  UNIQUE (${index.columns.map(quoteIdent).join(", ")})`);
    }
  }
  return `CREATE TABLE ${quoteIdent(table.name)} (\n${lines.join(",\n")}\n)`;
}

function wrapDefault(expr: Expr): string {
  return expr.kind === "literal" ? exprToSql(expr) : `(${exprToSql(expr)})`;
}

export function createViewSql(view: View): string {
  const columns = view.columns ? ` (${view.columns.map(quoteIdent).join(", ")})` : "";
  return `CREATE VIEW ${quoteIdent(view.name)}${columns} AS ${view.queryText}`;
}

export function createIndexSql(index: Index): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(index.name)} ON ${quoteIdent(index.table.name)} (${index.columns.map(quoteIdent).join(", ")})`;
}

export { parseExpression };
