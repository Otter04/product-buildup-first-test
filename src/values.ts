import type { ColumnType } from "./ast.js";
import { SqlRuntimeError } from "./errors.js";

/** Every value that can be stored in a cell or produced by an expression. */
export type SqlValue = null | number | string | boolean;

/** A row as returned to callers: column name → value. */
export type Row = Record<string, SqlValue>;

export function isNull(v: SqlValue): v is null {
  return v === null;
}

/** Storage class rank used to order values of different types (NULL first). */
function typeRank(v: SqlValue): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  return 3;
}

/**
 * Total ordering used by ORDER BY, indexes, DISTINCT and GROUP BY. NULL sorts
 * before everything else; values of different types are ordered by type.
 */
export function compareValues(a: SqlValue, b: SqlValue): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) {
    // Booleans compare numerically against numbers (TRUE = 1, FALSE = 0).
    if ((ra === 1 && rb === 2) || (ra === 2 && rb === 1)) {
      return Number(a) - Number(b) || ra - rb;
    }
    return ra - rb;
  }
  if (a === null || b === null) return 0;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const sa = a as string;
  const sb = b as string;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * SQL comparison with three-valued logic: returns null when either side is
 * NULL, otherwise the sign of the comparison. Numeric strings are compared
 * numerically against numbers so that `'10' = 10` holds.
 */
export function sqlCompare(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null;
  if (typeof a === "number" && typeof b === "string") {
    const n = Number(b);
    if (b.trim() !== "" && !Number.isNaN(n)) return a < n ? -1 : a > n ? 1 : 0;
  } else if (typeof a === "string" && typeof b === "number") {
    const n = Number(a);
    if (a.trim() !== "" && !Number.isNaN(n)) return n < b ? -1 : n > b ? 1 : 0;
  }
  return compareValues(a, b);
}

/** Interprets a value as a SQL boolean: NULL stays NULL (unknown). */
export function toBool(v: SqlValue): boolean | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const n = Number(v);
  if (v.trim() !== "" && !Number.isNaN(n)) return n !== 0;
  const upper = v.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return false;
}

/** Interprets a value as a number for arithmetic; NULL propagates. */
export function toNumber(v: SqlValue): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const trimmed = v.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  // SQLite-style: take the longest numeric prefix, else 0.
  const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(trimmed);
  return m ? Number(m[0]) : 0;
}

/** Converts a value to its textual representation. */
export function toText(v: SqlValue): string | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatNumber(v);
  return v;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n.toFixed(0);
  return String(n);
}

/** Human-readable rendering used by the REPL and EXPLAIN output. */
export function formatValue(v: SqlValue): string {
  if (v === null) return "NULL";
  return toText(v)!;
}

/** Renders a value as a SQL literal (used by dumps). */
export function toSqlLiteral(v: SqlValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new SqlRuntimeError(`Cannot serialize non-finite number ${v}`);
    return formatNumber(v);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Coerces a value into the declared column type, the way an INSERT or UPDATE
 * stores it. Throws when the value cannot be represented losslessly.
 */
export function coerceToType(v: SqlValue, type: ColumnType, column: string): SqlValue {
  if (v === null || type === "ANY") return v;
  switch (type) {
    case "INTEGER": {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") {
        if (Number.isInteger(v)) return v;
        throw new SqlRuntimeError(`Column '${column}' expects INTEGER, got ${v}`);
      }
      const n = Number(v.trim());
      if (v.trim() !== "" && Number.isInteger(n)) return n;
      throw new SqlRuntimeError(`Column '${column}' expects INTEGER, got '${v}'`);
    }
    case "REAL": {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return v;
      const n = Number(v.trim());
      if (v.trim() !== "" && !Number.isNaN(n)) return n;
      throw new SqlRuntimeError(`Column '${column}' expects REAL, got '${v}'`);
    }
    case "TEXT":
      return toText(v);
    case "BOOLEAN": {
      if (typeof v === "boolean") return v;
      if (typeof v === "number") {
        if (v === 0 || v === 1) return v === 1;
        throw new SqlRuntimeError(`Column '${column}' expects BOOLEAN, got ${v}`);
      }
      const upper = v.trim().toUpperCase();
      if (upper === "TRUE" || upper === "T" || upper === "1" || upper === "YES") return true;
      if (upper === "FALSE" || upper === "F" || upper === "0" || upper === "NO") return false;
      throw new SqlRuntimeError(`Column '${column}' expects BOOLEAN, got '${v}'`);
    }
  }
}

/** Explicit CAST semantics: more permissive than column coercion. */
export function castValue(v: SqlValue, type: ColumnType): SqlValue {
  if (v === null || type === "ANY") return v;
  switch (type) {
    case "INTEGER": {
      const n = toNumber(v)!;
      return Math.trunc(n);
    }
    case "REAL":
      return toNumber(v);
    case "TEXT":
      return toText(v);
    case "BOOLEAN":
      return toBool(v);
  }
}

/** Name of the dynamic type of a value, as reported by TYPEOF(). */
export function typeName(v: SqlValue): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "real";
  return "text";
}

/** Stable string key used for hashing values (DISTINCT, GROUP BY, hash joins). */
export function valueKey(v: SqlValue): string {
  if (v === null) return "n";
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "number") return `d${v}`;
  return `s${v}`;
}

export function rowKey(values: readonly SqlValue[]): string {
  let key = "";
  for (const v of values) key += valueKey(v) + "\u0000";
  return key;
}
