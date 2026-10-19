import { SqlCatalogError, SqlRuntimeError } from "./errors.js";
import {
  castValue,
  compareValues,
  formatNumber,
  rowKey,
  sqlCompare,
  toBool,
  toNumber,
  toText,
  typeName,
  type SqlValue,
} from "./values.js";

// ---------------------------------------------------------------------------
// Scalar functions
// ---------------------------------------------------------------------------

export interface ScalarFunction {
  minArgs: number;
  maxArgs: number;
  /** Deterministic functions may be constant-folded. */
  deterministic: boolean;
  fn: (args: SqlValue[]) => SqlValue;
}

function scalar(minArgs: number, maxArgs: number, fn: (args: SqlValue[]) => SqlValue, deterministic = true): ScalarFunction {
  return { minArgs, maxArgs, fn, deterministic };
}

/** Wraps a function so that any NULL argument yields NULL. */
function strict(fn: (args: SqlValue[]) => SqlValue): (args: SqlValue[]) => SqlValue {
  return (args) => (args.some((a) => a === null) ? null : fn(args));
}

function num(v: SqlValue): number {
  return toNumber(v)!;
}

function str(v: SqlValue): string {
  return toText(v)!;
}

/** Converts a JS string index (UTF-16) aware of astral characters. */
function chars(s: string): string[] {
  return Array.from(s);
}

function trimChars(s: string, set: string | undefined, left: boolean, right: boolean): string {
  const remove = new Set(chars(set ?? " "));
  const cs = chars(s);
  let start = 0;
  let end = cs.length;
  if (left) while (start < end && remove.has(cs[start]!)) start++;
  if (right) while (end > start && remove.has(cs[end - 1]!)) end--;
  return cs.slice(start, end).join("");
}

function roundHalfAwayFromZero(n: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = Math.abs(n) * factor;
  // Nudge by a relative epsilon so that 2.675 rounds the way people expect.
  const rounded = Math.round(scaled + scaled * Number.EPSILON) / factor;
  return Math.sign(n) * rounded;
}

/** A tiny printf supporting %d %i %f %s %x %X %o %e %g %% with flags/width/precision. */
function printf(format: string, args: SqlValue[]): string {
  let argIndex = 0;
  return format.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([dioxXfFeEgGsqQc%])/g, (_m, flags: string, width?: string, precision?: string, conv?: string) => {
    if (conv === "%") return "%";
    const arg = args[argIndex++] ?? null;
    let out: string;
    const prec = precision === undefined ? undefined : Number(precision);
    switch (conv) {
      case "d":
      case "i":
        out = arg === null ? "0" : formatNumber(Math.trunc(num(arg)));
        break;
      case "o":
        out = Math.trunc(num(arg ?? 0)).toString(8);
        break;
      case "x":
        out = Math.trunc(num(arg ?? 0)).toString(16);
        break;
      case "X":
        out = Math.trunc(num(arg ?? 0)).toString(16).toUpperCase();
        break;
      case "f":
      case "F":
        out = num(arg ?? 0).toFixed(prec ?? 6);
        break;
      case "e":
      case "E":
        out = num(arg ?? 0).toExponential(prec ?? 6);
        if (conv === "E") out = out.toUpperCase();
        break;
      case "g":
      case "G":
        out = String(Number(num(arg ?? 0).toPrecision(prec ?? 6)));
        break;
      case "c":
        out = arg === null ? "" : chars(str(arg))[0] ?? "";
        break;
      case "q":
        out = arg === null ? "" : str(arg).replace(/'/g, "''");
        break;
      case "Q":
        out = arg === null ? "NULL" : `'${str(arg).replace(/'/g, "''")}'`;
        break;
      default:
        out = arg === null ? "" : str(arg);
        if (prec !== undefined) out = chars(out).slice(0, prec).join("");
    }
    if (flags.includes("+") && /^[dioxXfFeEgG]$/.test(conv!) && !out.startsWith("-")) out = "+" + out;
    else if (flags.includes(" ") && /^[dioxXfFeEgG]$/.test(conv!) && !out.startsWith("-")) out = " " + out;
    const w = width ? Number(width) : 0;
    if (out.length < w) {
      if (flags.includes("-")) out = out.padEnd(w);
      else if (flags.includes("0") && /^[dioxXfFeEgG]$/.test(conv!)) {
        const sign = /^[+\- ]/.test(out) ? out[0]! : "";
        out = sign + out.slice(sign.length).padStart(w - sign.length, "0");
      } else out = out.padStart(w);
    }
    return out;
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Formats a Date as `YYYY-MM-DD HH:MM:SS` in UTC. */
function formatDateTime(d: Date): string {
  return `${formatDate(d)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function formatDate(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Parses the time-value argument of the date functions. Returns null if invalid. */
function parseTimeValue(v: SqlValue): Date | null {
  if (v === null) return null;
  if (typeof v === "number") return new Date(v * 1000);
  const s = str(v).trim();
  if (s.toLowerCase() === "now") return new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?Z?$/.exec(s);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0), ms));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Applies SQLite-style modifiers such as '+1 day', '-3 months', 'start of month'. */
function applyModifiers(d: Date, modifiers: SqlValue[]): Date | null {
  let date = new Date(d.getTime());
  for (const raw of modifiers) {
    if (raw === null) return null;
    const mod = str(raw).trim().toLowerCase();
    const m = /^([+-]?\d+(?:\.\d+)?)\s+(second|minute|hour|day|month|year)s?$/.exec(mod);
    if (m) {
      const amount = Number(m[1]);
      switch (m[2]) {
        case "second":
          date = new Date(date.getTime() + amount * 1000);
          break;
        case "minute":
          date = new Date(date.getTime() + amount * 60_000);
          break;
        case "hour":
          date = new Date(date.getTime() + amount * 3_600_000);
          break;
        case "day":
          date = new Date(date.getTime() + amount * 86_400_000);
          break;
        case "month":
          date.setUTCMonth(date.getUTCMonth() + Math.trunc(amount));
          break;
        case "year":
          date.setUTCFullYear(date.getUTCFullYear() + Math.trunc(amount));
          break;
      }
      continue;
    }
    if (mod === "start of day") {
      date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    } else if (mod === "start of month") {
      date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    } else if (mod === "start of year") {
      date = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    } else {
      return null;
    }
  }
  return date;
}

function dateFunction(format: (d: Date) => SqlValue): (args: SqlValue[]) => SqlValue {
  return (args) => {
    const base = parseTimeValue(args.length ? args[0]! : "now");
    if (!base) return null;
    const d = applyModifiers(base, args.slice(1));
    return d ? format(d) : null;
  };
}

function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%([dfHjmMsSwWY%])/g, (_m, c: string) => {
    switch (c) {
      case "d":
        return pad2(d.getUTCDate());
      case "f":
        return `${pad2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}`;
      case "H":
        return pad2(d.getUTCHours());
      case "j": {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        return String(Math.floor((d.getTime() - start) / 86_400_000) + 1).padStart(3, "0");
      }
      case "m":
        return pad2(d.getUTCMonth() + 1);
      case "M":
        return pad2(d.getUTCMinutes());
      case "s":
        return String(Math.floor(d.getTime() / 1000));
      case "S":
        return pad2(d.getUTCSeconds());
      case "w":
        return String(d.getUTCDay());
      case "W": {
        const start = Date.UTC(d.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((d.getTime() - start) / 86_400_000);
        const mondayBased = (d.getUTCDay() + 6) % 7;
        return pad2(Math.floor((dayOfYear - mondayBased + 7) / 7));
      }
      case "Y":
        return String(d.getUTCFullYear()).padStart(4, "0");
      default:
        return "%";
    }
  });
}

export const SCALAR_FUNCTIONS: Record<string, ScalarFunction> = {
  // --- numeric -------------------------------------------------------------
  ABS: scalar(1, 1, strict(([x]) => Math.abs(num(x!)))),
  SIGN: scalar(1, 1, strict(([x]) => Math.sign(num(x!)))),
  ROUND: scalar(
    1,
    2,
    strict(([x, d]) => roundHalfAwayFromZero(num(x!), d === undefined ? 0 : Math.trunc(num(d)))),
  ),
  CEIL: scalar(1, 1, strict(([x]) => Math.ceil(num(x!)))),
  CEILING: scalar(1, 1, strict(([x]) => Math.ceil(num(x!)))),
  FLOOR: scalar(1, 1, strict(([x]) => Math.floor(num(x!)))),
  TRUNC: scalar(1, 1, strict(([x]) => Math.trunc(num(x!)))),
  SQRT: scalar(1, 1, strict(([x]) => (num(x!) < 0 ? null : Math.sqrt(num(x!))))),
  POWER: scalar(2, 2, strict(([x, y]) => num(x!) ** num(y!))),
  POW: scalar(2, 2, strict(([x, y]) => num(x!) ** num(y!))),
  EXP: scalar(1, 1, strict(([x]) => Math.exp(num(x!)))),
  LN: scalar(1, 1, strict(([x]) => (num(x!) <= 0 ? null : Math.log(num(x!))))),
  LOG: scalar(
    1,
    2,
    strict((args) => {
      if (args.length === 1) return num(args[0]!) <= 0 ? null : Math.log10(num(args[0]!));
      const [b, x] = args.map(num) as [number, number];
      return b <= 0 || b === 1 || x <= 0 ? null : Math.log(x) / Math.log(b);
    }),
  ),
  LOG10: scalar(1, 1, strict(([x]) => (num(x!) <= 0 ? null : Math.log10(num(x!))))),
  LOG2: scalar(1, 1, strict(([x]) => (num(x!) <= 0 ? null : Math.log2(num(x!))))),
  MOD: scalar(2, 2, strict(([x, y]) => (num(y!) === 0 ? null : num(x!) % num(y!)))),
  PI: scalar(0, 0, () => Math.PI),
  SIN: scalar(1, 1, strict(([x]) => Math.sin(num(x!)))),
  COS: scalar(1, 1, strict(([x]) => Math.cos(num(x!)))),
  TAN: scalar(1, 1, strict(([x]) => Math.tan(num(x!)))),
  DEGREES: scalar(1, 1, strict(([x]) => (num(x!) * 180) / Math.PI)),
  RADIANS: scalar(1, 1, strict(([x]) => (num(x!) * Math.PI) / 180)),
  RANDOM: scalar(0, 0, () => Math.floor(Math.random() * 2 ** 53) - 2 ** 52, false),
  RAND: scalar(0, 0, () => Math.random(), false),

  // --- text ----------------------------------------------------------------
  LENGTH: scalar(1, 1, strict(([s]) => chars(str(s!)).length)),
  CHAR_LENGTH: scalar(1, 1, strict(([s]) => chars(str(s!)).length)),
  UPPER: scalar(1, 1, strict(([s]) => str(s!).toUpperCase())),
  LOWER: scalar(1, 1, strict(([s]) => str(s!).toLowerCase())),
  TRIM: scalar(1, 2, strict(([s, set]) => trimChars(str(s!), set === undefined ? undefined : str(set), true, true))),
  LTRIM: scalar(1, 2, strict(([s, set]) => trimChars(str(s!), set === undefined ? undefined : str(set), true, false))),
  RTRIM: scalar(1, 2, strict(([s, set]) => trimChars(str(s!), set === undefined ? undefined : str(set), false, true))),
  SUBSTR: scalar(
    2,
    3,
    strict(([s, start, len]) => {
      const cs = chars(str(s!));
      let from = Math.trunc(num(start!));
      // SQL strings are 1-indexed; negative starts count from the end.
      if (from < 0) from = cs.length + from + 1;
      let begin = from - 1;
      let end = len === undefined ? cs.length : begin + Math.trunc(num(len));
      if (len !== undefined && num(len) < 0) {
        end = begin;
        begin = begin + Math.trunc(num(len));
      }
      return cs.slice(Math.max(0, begin), Math.max(0, end)).join("");
    }),
  ),
  REPLACE: scalar(3, 3, strict(([s, from, to]) => (str(from!) === "" ? str(s!) : str(s!).split(str(from!)).join(str(to!))))),
  INSTR: scalar(
    2,
    2,
    strict(([s, sub]) => {
      const i = str(s!).indexOf(str(sub!));
      return i < 0 ? 0 : chars(str(s!).slice(0, i)).length + 1;
    }),
  ),
  REVERSE: scalar(1, 1, strict(([s]) => chars(str(s!)).reverse().join(""))),
  REPEAT: scalar(2, 2, strict(([s, n]) => str(s!).repeat(Math.max(0, Math.trunc(num(n!)))))),
  LEFT: scalar(2, 2, strict(([s, n]) => chars(str(s!)).slice(0, Math.max(0, Math.trunc(num(n!)))).join(""))),
  RIGHT: scalar(
    2,
    2,
    strict(([s, n]) => {
      const k = Math.max(0, Math.trunc(num(n!)));
      const cs = chars(str(s!));
      return k === 0 ? "" : cs.slice(-k).join("");
    }),
  ),
  LPAD: scalar(
    2,
    3,
    strict(([s, n, fill]) => {
      const cs = chars(str(s!));
      const width = Math.trunc(num(n!));
      if (cs.length >= width) return cs.slice(0, width).join("");
      return str(s!).padStart(width, fill === undefined ? " " : str(fill));
    }),
  ),
  RPAD: scalar(
    2,
    3,
    strict(([s, n, fill]) => {
      const cs = chars(str(s!));
      const width = Math.trunc(num(n!));
      if (cs.length >= width) return cs.slice(0, width).join("");
      return str(s!).padEnd(width, fill === undefined ? " " : str(fill));
    }),
  ),
  CONCAT: scalar(1, Infinity, (args) => args.map((a) => (a === null ? "" : str(a))).join("")),
  CONCAT_WS: scalar(2, Infinity, ([sep, ...rest]) => {
    if (sep === null) return null;
    return rest
      .filter((a): a is Exclude<SqlValue, null> => a !== null)
      .map(str)
      .join(str(sep!));
  }),
  PRINTF: scalar(1, Infinity, ([fmt, ...rest]) => (fmt === null ? null : printf(str(fmt!), rest))),
  FORMAT: scalar(1, Infinity, ([fmt, ...rest]) => (fmt === null ? null : printf(str(fmt!), rest))),
  UNICODE: scalar(1, 1, strict(([s]) => str(s!).codePointAt(0) ?? null)),
  CHAR: scalar(0, Infinity, (args) => String.fromCodePoint(...args.filter((a) => a !== null).map((a) => Math.trunc(num(a))))),
  HEX: scalar(
    1,
    1,
    strict(([s]) =>
      Array.from(new TextEncoder().encode(str(s!)))
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join(""),
    ),
  ),

  // --- null handling & conditionals -----------------------------------------
  COALESCE: scalar(1, Infinity, (args) => args.find((a) => a !== null) ?? null),
  IFNULL: scalar(2, 2, ([a, b]) => (a !== null ? a! : b!)),
  NVL: scalar(2, 2, ([a, b]) => (a !== null ? a! : b!)),
  NULLIF: scalar(2, 2, ([a, b]) => (sqlCompare(a!, b!) === 0 ? null : a!)),
  IIF: scalar(3, 3, ([c, a, b]) => (toBool(c!) ? a! : b!)),
  IF: scalar(3, 3, ([c, a, b]) => (toBool(c!) ? a! : b!)),
  // Scalar MIN / MAX (two or more arguments); the one-argument forms are aggregates.
  MIN: scalar(2, Infinity, (args) => {
    if (args.some((a) => a === null)) return null;
    return args.reduce((m, a) => (compareValues(a, m) < 0 ? a : m));
  }),
  MAX: scalar(2, Infinity, (args) => {
    if (args.some((a) => a === null)) return null;
    return args.reduce((m, a) => (compareValues(a, m) > 0 ? a : m));
  }),
  GREATEST: scalar(1, Infinity, (args) => {
    if (args.some((a) => a === null)) return null;
    return args.reduce((m, a) => (compareValues(a, m) > 0 ? a : m));
  }),
  LEAST: scalar(1, Infinity, (args) => {
    if (args.some((a) => a === null)) return null;
    return args.reduce((m, a) => (compareValues(a, m) < 0 ? a : m));
  }),

  // --- types -----------------------------------------------------------------
  TYPEOF: scalar(1, 1, ([v]) => typeName(v!)),
  TO_NUMBER: scalar(1, 1, ([v]) => castValue(v!, "REAL")),
  TO_TEXT: scalar(1, 1, ([v]) => castValue(v!, "TEXT")),

  // --- date & time (UTC) ------------------------------------------------------
  DATE: scalar(0, Infinity, dateFunction(formatDate), false),
  TIME: scalar(
    0,
    Infinity,
    dateFunction((d) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`),
    false,
  ),
  DATETIME: scalar(0, Infinity, dateFunction(formatDateTime), false),
  UNIXEPOCH: scalar(0, Infinity, dateFunction((d) => Math.floor(d.getTime() / 1000)), false),
  JULIANDAY: scalar(0, Infinity, dateFunction((d) => d.getTime() / 86_400_000 + 2440587.5), false),
  STRFTIME: scalar(
    1,
    Infinity,
    ([fmt, ...rest]) => {
      if (fmt === null) return null;
      const base = parseTimeValue(rest.length ? rest[0]! : "now");
      if (!base) return null;
      const d = applyModifiers(base, rest.slice(1));
      return d ? strftime(str(fmt!), d) : null;
    },
    false,
  ),
  NOW: scalar(0, 0, () => formatDateTime(new Date()), false),
  CURRENT_DATE: scalar(0, 0, () => formatDate(new Date()), false),
  CURRENT_TIMESTAMP: scalar(0, 0, () => formatDateTime(new Date()), false),
};

/** Functions callable only with a fixed argument count when not used as aggregates. */
export function lookupScalar(name: string, argc: number): ScalarFunction {
  const fn = SCALAR_FUNCTIONS[name];
  if (!fn) throw new SqlCatalogError(`Unknown function ${name}()`);
  if (argc < fn.minArgs || argc > fn.maxArgs) {
    const expected = fn.minArgs === fn.maxArgs ? `${fn.minArgs}` : fn.maxArgs === Infinity ? `at least ${fn.minArgs}` : `${fn.minArgs} to ${fn.maxArgs}`;
    throw new SqlCatalogError(`${name}() takes ${expected} argument(s), got ${argc}`);
  }
  return fn;
}

// ---------------------------------------------------------------------------
// Aggregate functions
// ---------------------------------------------------------------------------

export interface Accumulator {
  step(args: SqlValue[]): void;
  result(): SqlValue;
}

export interface AggregateFunction {
  minArgs: number;
  maxArgs: number;
  create(): Accumulator;
}

class CountAcc implements Accumulator {
  n = 0;
  constructor(private readonly star: boolean) {}
  step(args: SqlValue[]): void {
    if (this.star || args[0] !== null) this.n++;
  }
  result(): SqlValue {
    return this.n;
  }
}

class SumAcc implements Accumulator {
  sum = 0;
  seen = false;
  constructor(private readonly emptyValue: SqlValue) {}
  step([v]: SqlValue[]): void {
    if (v === null || v === undefined) return;
    this.sum += toNumber(v)!;
    this.seen = true;
  }
  result(): SqlValue {
    return this.seen ? this.sum : this.emptyValue;
  }
}

class AvgAcc implements Accumulator {
  sum = 0;
  n = 0;
  step([v]: SqlValue[]): void {
    if (v === null || v === undefined) return;
    this.sum += toNumber(v)!;
    this.n++;
  }
  result(): SqlValue {
    return this.n === 0 ? null : this.sum / this.n;
  }
}

class ExtremeAcc implements Accumulator {
  best: SqlValue = null;
  constructor(private readonly sign: 1 | -1) {}
  step([v]: SqlValue[]): void {
    if (v === null || v === undefined) return;
    if (this.best === null || compareValues(v, this.best) * this.sign > 0) this.best = v;
  }
  result(): SqlValue {
    return this.best;
  }
}

class GroupConcatAcc implements Accumulator {
  parts: string[] = [];
  separator: string | null = null;
  constructor(private readonly defaultSeparator: string) {}
  step([v, sep]: SqlValue[]): void {
    if (this.separator === null) this.separator = sep === undefined || sep === null ? this.defaultSeparator : str(sep);
    if (v === null || v === undefined) return;
    this.parts.push(str(v));
  }
  result(): SqlValue {
    return this.parts.length ? this.parts.join(this.separator ?? this.defaultSeparator) : null;
  }
}

class BoolAcc implements Accumulator {
  value: boolean | null = null;
  constructor(private readonly all: boolean) {}
  step([v]: SqlValue[]): void {
    const b = toBool(v ?? null);
    if (b === null) return;
    this.value = this.value === null ? b : this.all ? this.value && b : this.value || b;
  }
  result(): SqlValue {
    return this.value;
  }
}

class VarianceAcc implements Accumulator {
  // Welford's online algorithm for numerical stability.
  n = 0;
  mean = 0;
  m2 = 0;
  constructor(
    private readonly sample: boolean,
    private readonly sqrt: boolean,
  ) {}
  step([v]: SqlValue[]): void {
    if (v === null || v === undefined) return;
    const x = toNumber(v)!;
    this.n++;
    const delta = x - this.mean;
    this.mean += delta / this.n;
    this.m2 += delta * (x - this.mean);
  }
  result(): SqlValue {
    const denom = this.sample ? this.n - 1 : this.n;
    if (denom <= 0) return null;
    const variance = this.m2 / denom;
    return this.sqrt ? Math.sqrt(variance) : variance;
  }
}

class MedianAcc implements Accumulator {
  values: number[] = [];
  step([v]: SqlValue[]): void {
    if (v === null || v === undefined) return;
    this.values.push(toNumber(v)!);
  }
  result(): SqlValue {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
}

/** Accumulator wrapper implementing `AGG(DISTINCT x)`. */
export class DistinctAcc implements Accumulator {
  private readonly seen = new Set<string>();
  constructor(private readonly inner: Accumulator) {}
  step(args: SqlValue[]): void {
    if (args[0] === null) return;
    const key = rowKey(args.slice(0, 1));
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.inner.step(args);
  }
  result(): SqlValue {
    return this.inner.result();
  }
}

function aggregate(minArgs: number, maxArgs: number, create: () => Accumulator): AggregateFunction {
  return { minArgs, maxArgs, create };
}

export const AGGREGATE_FUNCTIONS: Record<string, AggregateFunction> = {
  COUNT: aggregate(0, 1, () => new CountAcc(false)),
  SUM: aggregate(1, 1, () => new SumAcc(null)),
  TOTAL: aggregate(1, 1, () => new SumAcc(0)),
  AVG: aggregate(1, 1, () => new AvgAcc()),
  MIN: aggregate(1, 1, () => new ExtremeAcc(-1)),
  MAX: aggregate(1, 1, () => new ExtremeAcc(1)),
  GROUP_CONCAT: aggregate(1, 2, () => new GroupConcatAcc(",")),
  STRING_AGG: aggregate(2, 2, () => new GroupConcatAcc(",")),
  BOOL_AND: aggregate(1, 1, () => new BoolAcc(true)),
  BOOL_OR: aggregate(1, 1, () => new BoolAcc(false)),
  EVERY: aggregate(1, 1, () => new BoolAcc(true)),
  VARIANCE: aggregate(1, 1, () => new VarianceAcc(true, false)),
  VAR_SAMP: aggregate(1, 1, () => new VarianceAcc(true, false)),
  VAR_POP: aggregate(1, 1, () => new VarianceAcc(false, false)),
  STDDEV: aggregate(1, 1, () => new VarianceAcc(true, true)),
  STDDEV_SAMP: aggregate(1, 1, () => new VarianceAcc(true, true)),
  STDDEV_POP: aggregate(1, 1, () => new VarianceAcc(false, true)),
  MEDIAN: aggregate(1, 1, () => new MedianAcc()),
};

/**
 * Whether a call is an aggregate. MIN / MAX with more than one argument are
 * the scalar variants (like SQLite).
 */
export function isAggregateCall(name: string, argc: number, star: boolean): boolean {
  if (star) return name === "COUNT";
  if ((name === "MIN" || name === "MAX") && argc > 1) return false;
  return name in AGGREGATE_FUNCTIONS;
}

export function createAccumulator(name: string, argc: number, star: boolean, distinct: boolean): Accumulator {
  const def = AGGREGATE_FUNCTIONS[name];
  if (!def) throw new SqlCatalogError(`Unknown aggregate function ${name}()`);
  if (!star && (argc < def.minArgs || argc > def.maxArgs)) {
    throw new SqlCatalogError(`${name}() takes ${def.minArgs === def.maxArgs ? def.minArgs : `${def.minArgs} to ${def.maxArgs}`} argument(s), got ${argc}`);
  }
  if (name === "COUNT" && !star && argc === 0) throw new SqlRuntimeError("COUNT() requires an argument or *");
  const acc = name === "COUNT" ? new CountAcc(star) : def.create();
  return distinct ? new DistinctAcc(acc) : acc;
}

// ---------------------------------------------------------------------------
// LIKE
// ---------------------------------------------------------------------------

const patternCache = new Map<string, RegExp>();

function cached(key: string, build: () => RegExp): RegExp {
  let re = patternCache.get(key);
  if (!re) {
    re = build();
    if (patternCache.size > 500) patternCache.clear();
    patternCache.set(key, re);
  }
  return re;
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive LIKE with `%` and `_` wildcards. An optional escape
 * character makes the following `%`, `_` or escape character literal.
 */
export function like(value: string, pattern: string, escape?: string): boolean {
  if (escape !== undefined && chars(escape).length !== 1) throw new SqlRuntimeError("ESCAPE expression must be a single character");
  const re = cached(`L${escape ?? ""}\u0000${pattern}`, () => {
    let src = "^";
    const cs = chars(pattern);
    for (let i = 0; i < cs.length; i++) {
      const ch = cs[i]!;
      if (escape !== undefined && ch === escape) {
        const next = cs[++i];
        if (next === undefined) throw new SqlRuntimeError("LIKE pattern ends with the escape character");
        src += escapeRegExp(next);
      } else if (ch === "%") src += "[\\s\\S]*";
      else if (ch === "_") src += "[\\s\\S]";
      else src += escapeRegExp(ch);
    }
    return new RegExp(src + "$", "iu");
  });
  return re.test(value);
}

/** Case-sensitive GLOB with `*`, `?` and `[...]` character classes (`[^...]` negates). */
export function glob(value: string, pattern: string): boolean {
  const re = cached(`G\u0000${pattern}`, () => {
    let src = "^";
    const cs = chars(pattern);
    for (let i = 0; i < cs.length; i++) {
      const ch = cs[i]!;
      if (ch === "*") src += "[\\s\\S]*";
      else if (ch === "?") src += "[\\s\\S]";
      else if (ch === "[") {
        let j = i + 1;
        let cls = "";
        if (cs[j] === "^") {
          cls += "^";
          j++;
        }
        // A ']' right after '[' (or '[^') is a literal member of the class.
        if (cs[j] === "]") {
          cls += "\\]";
          j++;
        }
        while (j < cs.length && cs[j] !== "]") {
          const c = cs[j]!;
          cls += c === "-" && j > i + 1 && cs[j + 1] !== "]" ? "-" : escapeRegExp(c);
          j++;
        }
        if (j >= cs.length) {
          // Unterminated class: treat '[' literally.
          src += "\\[";
          continue;
        }
        src += `[${cls}]`;
        i = j;
      } else src += escapeRegExp(ch);
    }
    return new RegExp(src + "$", "u");
  });
  return re.test(value);
}
