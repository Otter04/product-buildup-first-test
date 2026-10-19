import type { FrameBound, FunctionCallExpr, WindowFrame } from "./ast.js";
import type { Compiled, Env } from "./compiler.js";
import { SqlCatalogError, SqlRuntimeError } from "./errors.js";
import { AGGREGATE_FUNCTIONS, createAccumulator, type Accumulator } from "./functions.js";
import { compareValues, rowKey, toNumber, type SqlValue } from "./values.js";

/** Functions that only make sense with an OVER clause. */
export const WINDOW_ONLY_FUNCTIONS: Record<string, { minArgs: number; maxArgs: number }> = {
  ROW_NUMBER: { minArgs: 0, maxArgs: 0 },
  RANK: { minArgs: 0, maxArgs: 0 },
  DENSE_RANK: { minArgs: 0, maxArgs: 0 },
  PERCENT_RANK: { minArgs: 0, maxArgs: 0 },
  CUME_DIST: { minArgs: 0, maxArgs: 0 },
  NTILE: { minArgs: 1, maxArgs: 1 },
  LAG: { minArgs: 1, maxArgs: 3 },
  LEAD: { minArgs: 1, maxArgs: 3 },
  FIRST_VALUE: { minArgs: 1, maxArgs: 1 },
  LAST_VALUE: { minArgs: 1, maxArgs: 1 },
  NTH_VALUE: { minArgs: 2, maxArgs: 2 },
};

export function validateWindowCall(call: FunctionCallExpr): void {
  if (call.over?.base) throw new SqlCatalogError(`No such window: ${call.over.base}`);
  const only = WINDOW_ONLY_FUNCTIONS[call.name];
  if (only) {
    if (call.args.length < only.minArgs || call.args.length > only.maxArgs) {
      throw new SqlCatalogError(`${call.name}() takes ${only.minArgs === only.maxArgs ? only.minArgs : `${only.minArgs} to ${only.maxArgs}`} argument(s), got ${call.args.length}`);
    }
    if (call.distinct) throw new SqlRuntimeError(`DISTINCT is not supported for ${call.name}()`);
    return;
  }
  if (!(call.name in AGGREGATE_FUNCTIONS)) throw new SqlCatalogError(`${call.name}() is not a window or aggregate function`);
  if (call.distinct) throw new SqlRuntimeError("DISTINCT is not supported in window aggregates");
  // Validate arity through the regular aggregate path.
  createAccumulator(call.name, call.args.length, call.star, false);
}

/** A compiled window function call, ready to evaluate over a set of rows. */
export interface CompiledWindow {
  call: FunctionCallExpr;
  args: Compiled[];
  partitionBy: Compiled[];
  orderBy: { expr: Compiled; direction: "ASC" | "DESC"; nulls?: "FIRST" | "LAST" }[];
  frame?: { unit: "ROWS" | "RANGE"; start: FrameBound; end: FrameBound; startOffset?: Compiled; endOffset?: Compiled };
}

interface FrameOffsets {
  start: number;
  end: number;
}

function compareKeys(
  a: SqlValue[],
  b: SqlValue[],
  orderBy: CompiledWindow["orderBy"],
): number {
  for (let i = 0; i < orderBy.length; i++) {
    const { direction, nulls } = orderBy[i]!;
    const va = a[i]!;
    const vb = b[i]!;
    if (va === null || vb === null) {
      if (va === null && vb === null) continue;
      const nullsFirst = nulls ? nulls === "FIRST" : direction === "ASC";
      return (va === null) === nullsFirst ? -1 : 1;
    }
    const c = compareValues(va, vb);
    if (c !== 0) return direction === "ASC" ? c : -c;
  }
  return 0;
}

function frameOffset(compiled: Compiled | undefined, outer: Env | undefined, what: string): number {
  if (!compiled) return 0;
  const v = toNumber(compiled({ row: [], outer }));
  if (v === null || v < 0 || !Number.isFinite(v)) throw new SqlRuntimeError(`Window frame ${what} offset must be a non-negative number`);
  return v;
}

/**
 * Evaluates a window function for every row. `rows` are the rows the
 * function's expressions are evaluated against; the result is aligned with it.
 */
export function evaluateWindow(w: CompiledWindow, rows: SqlValue[][], outer: Env | undefined): SqlValue[] {
  const result: SqlValue[] = new Array(rows.length).fill(null);
  const envs: Env[] = rows.map((row) => ({ row, outer }));

  // Partition the rows, preserving input order within each partition.
  const partitions = new Map<string, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const key = w.partitionBy.length ? rowKey(w.partitionBy.map((p) => p(envs[i]!))) : "";
    let list = partitions.get(key);
    if (!list) partitions.set(key, (list = []));
    list.push(i);
  }

  const offsets: FrameOffsets = {
    start: frameOffset(w.frame?.startOffset, outer, "start"),
    end: frameOffset(w.frame?.endOffset, outer, "end"),
  };

  for (const indices of partitions.values()) {
    const keys = new Map<number, SqlValue[]>();
    for (const i of indices) keys.set(i, w.orderBy.map((o) => o.expr(envs[i]!)));
    // Array.prototype.sort is stable, so ties keep their input order.
    if (w.orderBy.length) indices.sort((a, b) => compareKeys(keys.get(a)!, keys.get(b)!, w.orderBy));
    const sortedKeys = indices.map((i) => keys.get(i)!);
    const values = evaluatePartition(w, indices, sortedKeys, envs, offsets);
    indices.forEach((rowIndex, pos) => {
      result[rowIndex] = values[pos]!;
    });
  }
  return result;
}

function evaluatePartition(
  w: CompiledWindow,
  indices: number[],
  keys: SqlValue[][],
  envs: Env[],
  offsets: FrameOffsets,
): SqlValue[] {
  const n = indices.length;
  const out: SqlValue[] = new Array(n);
  const ordered = w.orderBy.length > 0;
  const isPeer = (a: number, b: number): boolean => !ordered || compareKeys(keys[a]!, keys[b]!, w.orderBy) === 0;

  // peerStart[i] / peerEnd[i]: the [start, end) range of rows that are peers of row i.
  const peerStart = new Array<number>(n);
  const peerEnd = new Array<number>(n);
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && isPeer(i, j)) j++;
    for (let k = i; k < j; k++) {
      peerStart[k] = i;
      peerEnd[k] = j;
    }
    i = j;
  }

  const arg = (pos: number, a = 0): SqlValue => w.args[a]!(envs[indices[pos]!]!);
  const name = w.call.name;

  switch (name) {
    case "ROW_NUMBER":
      for (let i = 0; i < n; i++) out[i] = i + 1;
      return out;
    case "RANK":
      for (let i = 0; i < n; i++) out[i] = peerStart[i]! + 1;
      return out;
    case "DENSE_RANK": {
      let rank = 0;
      for (let i = 0; i < n; i++) {
        if (i === 0 || peerStart[i] === i) rank++;
        out[i] = rank;
      }
      return out;
    }
    case "PERCENT_RANK":
      for (let i = 0; i < n; i++) out[i] = n > 1 ? peerStart[i]! / (n - 1) : 0;
      return out;
    case "CUME_DIST":
      for (let i = 0; i < n; i++) out[i] = peerEnd[i]! / n;
      return out;
    case "NTILE": {
      const buckets = toNumber(arg(0));
      if (buckets === null || !Number.isInteger(buckets) || buckets <= 0) throw new SqlRuntimeError("NTILE() argument must be a positive integer");
      // Like SQLite: the first (n % buckets) buckets get one extra row.
      const size = Math.floor(n / buckets);
      const larger = n % buckets;
      for (let i = 0; i < n; i++) {
        const boundary = larger * (size + 1);
        out[i] = i < boundary ? Math.floor(i / (size + 1)) + 1 : Math.floor((i - boundary) / Math.max(size, 1)) + larger + 1;
      }
      return out;
    }
    case "LAG":
    case "LEAD": {
      for (let i = 0; i < n; i++) {
        const offset = w.args[1] ? toNumber(arg(i, 1)) : 1;
        if (offset === null) {
          out[i] = null;
          continue;
        }
        const target = name === "LAG" ? i - offset : i + offset;
        if (Number.isInteger(target) && target >= 0 && target < n) out[i] = arg(target);
        else out[i] = w.args[2] ? arg(i, 2) : null;
      }
      return out;
    }
  }

  // Frame-based functions: FIRST_VALUE, LAST_VALUE, NTH_VALUE and aggregates.
  const frameOf = (i: number): [number, number] => frameBounds(w, i, n, peerStart, peerEnd, keys, offsets);

  if (name === "FIRST_VALUE" || name === "LAST_VALUE" || name === "NTH_VALUE") {
    let nth = 1;
    if (name === "NTH_VALUE") {
      const v = toNumber(w.args[1]!(envs[indices[0]!]!));
      if (v === null || !Number.isInteger(v) || v <= 0) throw new SqlRuntimeError("NTH_VALUE() position must be a positive integer");
      nth = v;
    }
    for (let i = 0; i < n; i++) {
      const [start, end] = frameOf(i);
      if (start >= end) {
        out[i] = null;
        continue;
      }
      if (name === "FIRST_VALUE") out[i] = arg(start);
      else if (name === "LAST_VALUE") out[i] = arg(end - 1);
      else out[i] = start + nth - 1 < end ? arg(start + nth - 1) : null;
    }
    return out;
  }

  // Aggregates over the frame, reusing the accumulator while the frame only grows.
  let acc: Accumulator | undefined;
  let accStart = 0;
  let accEnd = 0;
  const make = (): Accumulator => createAccumulator(name, w.args.length, w.call.star, false);
  const step = (pos: number): void => {
    acc!.step(w.args.map((a) => a(envs[indices[pos]!]!)));
  };
  for (let i = 0; i < n; i++) {
    const [start, end] = frameOf(i);
    if (!acc || start !== accStart || end < accEnd) {
      acc = make();
      accStart = start;
      accEnd = start;
    }
    while (accEnd < end) step(accEnd++);
    out[i] = acc.result();
  }
  return out;
}

/** Computes the frame of row `i` as a half-open [start, end) range of positions. */
function frameBounds(
  w: CompiledWindow,
  i: number,
  n: number,
  peerStart: number[],
  peerEnd: number[],
  keys: SqlValue[][],
  offsets: FrameOffsets,
): [number, number] {
  const frame: WindowFrame | undefined = w.frame;
  if (!frame) {
    // Default: RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW (whole partition without ORDER BY).
    return w.orderBy.length ? [0, peerEnd[i]!] : [0, n];
  }
  if (frame.unit === "ROWS") {
    const bound = (b: FrameBound, offset: number, isStart: boolean): number => {
      switch (b.kind) {
        case "unboundedPreceding":
          return 0;
        case "unboundedFollowing":
          return n;
        case "currentRow":
          return isStart ? i : i + 1;
        case "preceding":
          return isStart ? i - offset : i - offset + 1;
        case "following":
          return isStart ? i + offset : i + offset + 1;
      }
    };
    const start = Math.max(0, bound(frame.start, offsets.start, true));
    const end = Math.min(n, bound(frame.end, offsets.end, false));
    return [start, Math.max(start, end)];
  }

  // RANGE frames: bounds are expressed in terms of the ORDER BY value.
  const rangeBound = (b: FrameBound, offset: number, isStart: boolean): number => {
    switch (b.kind) {
      case "unboundedPreceding":
        return 0;
      case "unboundedFollowing":
        return n;
      case "currentRow":
        return isStart ? peerStart[i]! : peerEnd[i]!;
      case "preceding":
      case "following": {
        const current = keys[i]![0]!;
        if (current === null) return isStart ? peerStart[i]! : peerEnd[i]!;
        const base = toNumber(current)!;
        const desc = w.orderBy[0]!.direction === "DESC";
        // Target value in sort order: "preceding" moves towards the start of the partition.
        const delta = b.kind === "preceding" ? -offset : offset;
        const target = desc ? base - delta : base + delta;
        // Position of the first row whose key is "at or after" target (start) or "after" target (end).
        const after = (pos: number): boolean => {
          const v = keys[pos]![0]!;
          if (v === null) return w.orderBy[0]!.nulls ? w.orderBy[0]!.nulls === "LAST" : desc;
          const x = toNumber(v)!;
          if (isStart) return desc ? x <= target : x >= target;
          return desc ? x < target : x > target;
        };
        let lo = 0;
        let hi = n;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (after(mid)) hi = mid;
          else lo = mid + 1;
        }
        return lo;
      }
    }
  };
  const start = rangeBound(frame.start, offsets.start, true);
  const end = rangeBound(frame.end, offsets.end, false);
  return [start, Math.max(start, end)];
}
