import type { ColumnDef, ColumnType, Expr, SelectStatement } from "./ast.js";
import { BPlusTree } from "./btree.js";
import { SqlCatalogError, SqlConstraintError } from "./errors.js";
import { compareValues, formatValue, type SqlValue } from "./values.js";

/** Records how to revert each mutation so statements and transactions can roll back. */
export class Journal {
  private readonly undo: (() => void)[] = [];

  record(fn: () => void): void {
    this.undo.push(fn);
  }

  get length(): number {
    return this.undo.length;
  }

  /** Reverts every mutation recorded after `mark` (newest first). */
  rollbackTo(mark: number): void {
    while (this.undo.length > mark) this.undo.pop()!();
  }

  /** Forgets recorded mutations after `mark`, making them permanent. */
  truncate(mark = 0): void {
    this.undo.length = mark;
  }
}

/** Whether two versions of a row have identical keys in `index` (same values and types). */
function sameIndexKey(index: Index, a: SqlValue[], b: SqlValue[]): boolean {
  for (const i of index.columnIndexes) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Index key: the indexed column values followed by the row id as a tiebreaker. */
export type IndexKey = SqlValue[];

export function compareKeys(a: IndexKey, b: IndexKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareValues(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** Compares only the first `prefix.length` components of `key`. */
export function comparePrefix(key: IndexKey, prefix: IndexKey): number {
  for (let i = 0; i < prefix.length; i++) {
    const c = compareValues(key[i]!, prefix[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

export class Index {
  readonly tree = new BPlusTree<IndexKey, number>(compareKeys);
  columnIndexes: number[] = [];

  constructor(
    public name: string,
    public table: Table,
    public columns: string[],
    readonly unique: boolean,
    /** Indexes created implicitly for PRIMARY KEY / UNIQUE constraints. */
    readonly implicit: boolean,
  ) {
    this.resolveColumns();
  }

  resolveColumns(): void {
    this.columnIndexes = this.columns.map((c) => this.table.columnIndex(c));
  }

  keyFor(row: SqlValue[], rowId: number): IndexKey {
    const key: IndexKey = this.columnIndexes.map((i) => row[i]!);
    key.push(rowId);
    return key;
  }

  /** Finds a row (other than `exceptRowId`) holding the same indexed values, ignoring NULLs. */
  findConflict(row: SqlValue[], exceptRowId?: number): number | undefined {
    const prefix = this.columnIndexes.map((i) => row[i]!);
    if (prefix.some((v) => v === null)) return undefined;
    for (const { key, value } of this.tree.seek((k) => comparePrefix(k, prefix) >= 0)) {
      if (comparePrefix(key, prefix) !== 0) break;
      if (value !== exceptRowId) return value;
    }
    return undefined;
  }

  /** Row ids whose leading index columns equal `prefix`, in index order. */
  *lookup(prefix: SqlValue[]): Generator<number> {
    for (const { key, value } of this.tree.seek((k) => comparePrefix(k, prefix) >= 0)) {
      if (comparePrefix(key, prefix) !== 0) return;
      yield value;
    }
  }

  /**
   * Row ids whose columns match `prefix` exactly and whose next column falls
   * within the given bounds. Bounds are compared with the index ordering, so
   * NULLs (which sort first) are excluded whenever a lower bound is given.
   */
  *range(
    prefix: SqlValue[],
    lower: { value: SqlValue; inclusive: boolean } | undefined,
    upper: { value: SqlValue; inclusive: boolean } | undefined,
    reverse = false,
  ): Generator<number> {
    const depth = prefix.length;
    const startKey = lower ? [...prefix, lower.value] : prefix;
    const endKey = upper ? [...prefix, upper.value] : prefix;
    const beforeStart = (k: IndexKey): boolean => {
      const c = comparePrefix(k, startKey);
      return c < 0 || (c === 0 && lower !== undefined && !lower.inclusive);
    };
    const afterEnd = (k: IndexKey): boolean => {
      const c = comparePrefix(k, endKey);
      return c > 0 || (c === 0 && upper !== undefined && !upper.inclusive);
    };
    // Rows with NULL in the range column never satisfy a comparison.
    const isNullAtDepth = (k: IndexKey): boolean => (lower || upper ? k[depth] === null : false);

    if (!reverse) {
      for (const { key, value } of this.tree.seek((k) => !beforeStart(k))) {
        if (afterEnd(key)) return;
        if (isNullAtDepth(key)) continue;
        yield value;
      }
    } else {
      for (const { key, value } of this.tree.seekReversed(afterEnd)) {
        if (beforeStart(key)) return;
        if (isNullAtDepth(key)) continue;
        yield value;
      }
    }
  }

  /** Every row id in index order. */
  *scan(reverse = false): Generator<number> {
    const it = reverse ? this.tree.entriesReversed() : this.tree.entries();
    for (const { value } of it) yield value;
  }
}

export interface Column extends ColumnDef {}

/** A heap of rows keyed by an internal, monotonically increasing row id. */
export class Table {
  readonly rows = new Map<number, SqlValue[]>();
  readonly indexes: Index[] = [];
  nextRowId = 1;
  /** Highest value ever assigned to the AUTOINCREMENT column. */
  autoIncrementSeq = 0;

  constructor(
    public name: string,
    public columns: Column[],
  ) {}

  columnIndex(name: string): number {
    const lower = name.toLowerCase();
    const i = this.columns.findIndex((c) => c.name.toLowerCase() === lower);
    if (i < 0) throw new SqlCatalogError(`Table '${this.name}' has no column named '${name}'`);
    return i;
  }

  hasColumn(name: string): boolean {
    const lower = name.toLowerCase();
    return this.columns.some((c) => c.name.toLowerCase() === lower);
  }

  get columnNames(): string[] {
    return this.columns.map((c) => c.name);
  }

  get primaryKey(): Index | undefined {
    return this.indexes.find((i) => i.implicit && i.name.startsWith("pk_"));
  }

  /**
   * The index rows are clustered by, if any: like SQLite's rowid tables, a
   * table with a single-column INTEGER PRIMARY KEY is scanned in key order.
   */
  get clusteredIndex(): Index | undefined {
    const pk = this.primaryKey;
    if (pk && pk.columnIndexes.length === 1 && this.columns[pk.columnIndexes[0]!]!.type === "INTEGER") return pk;
    return undefined;
  }

  /** Row ids in scan order (primary key order for clustered tables, insertion order otherwise). */
  rowIds(): Iterable<number> {
    const clustered = this.clusteredIndex;
    return clustered ? clustered.scan() : this.rows.keys();
  }

  /** All rows in scan order. */
  *scan(): Generator<SqlValue[]> {
    for (const chunk of this.scanChunks()) yield* chunk;
  }

  /**
   * All rows in scan order, in batches. Full scans iterate batches to keep
   * per-row overhead low while staying lazy (so LIMIT can stop early).
   */
  *scanChunks(): Generator<SqlValue[][]> {
    const clustered = this.clusteredIndex;
    if (clustered) {
      // Copy each leaf's ids first: the caller may modify the table between batches.
      for (const ids of clustered.tree.valueChunks()) yield ids.map((id) => this.rows.get(id)!);
      return;
    }
    let batch: SqlValue[][] = [];
    for (const row of this.rows.values()) {
      batch.push(row);
      if (batch.length === 256) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length) yield batch;
  }

  get autoIncrementColumn(): number {
    return this.columns.findIndex((c) => c.autoIncrement);
  }

  /** Checks UNIQUE / PRIMARY KEY constraints for a candidate row. */
  checkUnique(row: SqlValue[], exceptRowId?: number, indexes: Index[] = this.indexes): void {
    for (const index of indexes) {
      if (!index.unique) continue;
      if (index.findConflict(row, exceptRowId) !== undefined) {
        const values = index.columnIndexes.map((i) => formatValue(row[i]!)).join(", ");
        const isPk = index.name.startsWith("pk_") && index.implicit;
        throw new SqlConstraintError(
          `${isPk ? "PRIMARY KEY" : "UNIQUE"} constraint failed: ${this.name}(${index.columns.join(", ")}) already contains (${values})`,
          isPk ? "primaryKey" : "unique",
        );
      }
    }
  }

  /**
   * The row id a row is stored under. For clustered tables it is the INTEGER
   * PRIMARY KEY value itself (a "rowid alias", as in SQLite), so secondary
   * indexes break ties by primary key.
   */
  private rowIdFor(row: SqlValue[]): number {
    const clustered = this.clusteredIndex;
    if (clustered) {
      const key = row[clustered.columnIndexes[0]!];
      if (typeof key === "number") return key;
    }
    return this.nextRowId++;
  }

  /** Stores a row without constraint checks or journaling (used when loading snapshots). */
  load(row: SqlValue[]): void {
    const rowId = this.rowIdFor(row);
    this.rows.set(rowId, row);
    for (const index of this.indexes) index.tree.set(index.keyFor(row, rowId), rowId);
  }

  insert(row: SqlValue[], journal: Journal): number {
    this.checkUnique(row);
    const rowId = this.rowIdFor(row);
    this.rows.set(rowId, row);
    for (const index of this.indexes) index.tree.set(index.keyFor(row, rowId), rowId);
    journal.record(() => {
      this.rows.delete(rowId);
      for (const index of this.indexes) index.tree.delete(index.keyFor(row, rowId));
    });
    return rowId;
  }

  /** Replaces a row. Returns its (possibly new) row id: changing a clustered key moves the row. */
  update(rowId: number, newRow: SqlValue[], journal: Journal): number {
    const oldRow = this.rows.get(rowId);
    if (!oldRow) throw new Error(`Row ${rowId} not found in ${this.name}`);
    const clustered = this.clusteredIndex;
    const newId = clustered ? (newRow[clustered.columnIndexes[0]!] as number) : rowId;
    // Only indexes whose key changes need checking and maintenance.
    const affected = newId === rowId ? this.indexes.filter((ix) => !sameIndexKey(ix, oldRow, newRow)) : this.indexes;
    this.checkUnique(newRow, rowId, affected);
    this.replaceRow(rowId, oldRow, newId, newRow, affected);
    journal.record(() => this.replaceRow(newId, newRow, rowId, oldRow, affected));
    return newId;
  }

  private replaceRow(oldId: number, oldRow: SqlValue[], newId: number, newRow: SqlValue[], indexes: Index[]): void {
    for (const index of indexes) {
      index.tree.delete(index.keyFor(oldRow, oldId));
      index.tree.set(index.keyFor(newRow, newId), newId);
    }
    if (oldId !== newId) this.rows.delete(oldId);
    this.rows.set(newId, newRow);
  }

  delete(rowId: number, journal: Journal): void {
    const row = this.rows.get(rowId);
    if (!row) return;
    this.rows.delete(rowId);
    for (const index of this.indexes) index.tree.delete(index.keyFor(row, rowId));
    journal.record(() => {
      this.rows.set(rowId, row);
      for (const index of this.indexes) index.tree.set(index.keyFor(row, rowId), rowId);
    });
  }

  /** Builds (or rebuilds) an index from the current rows, validating uniqueness. */
  populateIndex(index: Index): void {
    index.tree.clear();
    for (const [rowId, row] of this.rows) {
      if (index.unique && index.findConflict(row) !== undefined) {
        index.tree.clear();
        const values = index.columnIndexes.map((i) => formatValue(row[i]!)).join(", ");
        throw new SqlConstraintError(
          `Cannot create unique index '${index.name}': duplicate value (${values}) in ${this.name}(${index.columns.join(", ")})`,
        );
      }
      index.tree.set(index.keyFor(row, rowId), rowId);
    }
  }
}

/** A stored query that can be referenced like a table. */
export interface View {
  name: string;
  columns?: string[];
  query: SelectStatement;
  /** Source text of the query, used to reproduce the CREATE VIEW statement. */
  queryText: string;
}

/** All tables, views and indexes known to a database. Names are case-insensitive. */
export class Catalog {
  private readonly tables = new Map<string, Table>();
  private readonly views = new Map<string, View>();
  private readonly indexes = new Map<string, Index>();

  /**
   * Schema version, bumped by every schema change (and by undoing one).
   * Cached query plans are only reused while it is unchanged.
   */
  version = 0;

  /** Records a schema change made outside the catalog (e.g. ALTER TABLE). */
  touch(): void {
    this.version++;
  }

  getTable(name: string): Table {
    const table = this.tables.get(name.toLowerCase());
    if (!table) {
      if (this.views.has(name.toLowerCase())) throw new SqlCatalogError(`'${name}' is a view, not a table`);
      throw new SqlCatalogError(`No such table: ${name}`);
    }
    return table;
  }

  findView(name: string): View | undefined {
    return this.views.get(name.toLowerCase());
  }

  allViews(): View[] {
    return [...this.views.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  addView(view: View, journal: Journal): void {
    const key = view.name.toLowerCase();
    if (this.views.has(key) || this.tables.has(key)) throw new SqlCatalogError(`Table or view '${view.name}' already exists`);
    this.views.set(key, view);
    this.touch();
    journal.record(() => {
      this.views.delete(key);
      this.touch();
    });
  }

  removeView(view: View, journal: Journal): void {
    const key = view.name.toLowerCase();
    this.views.delete(key);
    this.touch();
    journal.record(() => {
      this.views.set(key, view);
      this.touch();
    });
  }

  findTable(name: string): Table | undefined {
    return this.tables.get(name.toLowerCase());
  }

  hasTable(name: string): boolean {
    return this.tables.has(name.toLowerCase());
  }

  allTables(): Table[] {
    return [...this.tables.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  addTable(table: Table, journal: Journal): void {
    const key = table.name.toLowerCase();
    if (this.tables.has(key)) throw new SqlCatalogError(`Table '${table.name}' already exists`);
    if (this.views.has(key)) throw new SqlCatalogError(`A view named '${table.name}' already exists`);
    this.tables.set(key, table);
    this.touch();
    journal.record(() => {
      this.tables.delete(key);
      this.touch();
    });
  }

  removeTable(table: Table, journal: Journal): void {
    const key = table.name.toLowerCase();
    this.tables.delete(key);
    const removed = table.indexes.map((i) => i.name.toLowerCase());
    for (const name of removed) this.indexes.delete(name);
    this.touch();
    journal.record(() => {
      this.tables.set(key, table);
      for (const index of table.indexes) this.indexes.set(index.name.toLowerCase(), index);
      this.touch();
    });
  }

  renameTable(table: Table, newName: string, journal: Journal): void {
    if (this.hasTable(newName) || this.findView(newName)) throw new SqlCatalogError(`Table or view '${newName}' already exists`);
    const oldName = table.name;
    this.tables.delete(oldName.toLowerCase());
    table.name = newName;
    this.tables.set(newName.toLowerCase(), table);
    this.touch();
    journal.record(() => {
      this.tables.delete(newName.toLowerCase());
      table.name = oldName;
      this.tables.set(oldName.toLowerCase(), table);
      this.touch();
    });
  }

  getIndex(name: string): Index | undefined {
    return this.indexes.get(name.toLowerCase());
  }

  allIndexes(): Index[] {
    return [...this.indexes.values()];
  }

  addIndex(index: Index, journal: Journal): void {
    const key = index.name.toLowerCase();
    if (this.indexes.has(key)) throw new SqlCatalogError(`Index '${index.name}' already exists`);
    index.table.populateIndex(index);
    this.indexes.set(key, index);
    index.table.indexes.push(index);
    this.touch();
    journal.record(() => {
      this.indexes.delete(key);
      const i = index.table.indexes.indexOf(index);
      if (i >= 0) index.table.indexes.splice(i, 1);
      this.touch();
    });
  }

  removeIndex(index: Index, journal: Journal): void {
    const key = index.name.toLowerCase();
    this.indexes.delete(key);
    const pos = index.table.indexes.indexOf(index);
    if (pos >= 0) index.table.indexes.splice(pos, 1);
    this.touch();
    journal.record(() => {
      this.indexes.set(key, index);
      index.table.indexes.splice(pos, 0, index);
      index.table.populateIndex(index);
      this.touch();
    });
  }
}
