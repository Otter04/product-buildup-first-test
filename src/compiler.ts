import type { Expr, FrameBound, FunctionCallExpr, SelectStatement, WindowSpec } from "./ast.js";
import { SqlCatalogError, SqlRuntimeError } from "./errors.js";
import { glob, isAggregateCall, like, lookupScalar } from "./functions.js";
import { castValue, sqlCompare, toBool, toNumber, toText, type SqlValue } from "./values.js";
import { WINDOW_ONLY_FUNCTIONS } from "./window.js";

/** One column visible to expressions at some query level. */
export interface ColumnInfo {
  /** Qualifier the column can be referenced by (table name or alias). */
  table?: string;
  name: string;
  /** Hidden columns (aggregate slots) are never expanded by `*`. */
  hidden?: boolean;
}

/** Runtime row environment: the current row plus the rows of enclosing queries. */
export interface Env {
  row: SqlValue[];
  outer?: Env;
}

export type Compiled = (env: Env) => SqlValue;

/** Marks the root scope of a subquery so we can detect correlation. */
export interface Boundary {
  correlated: boolean;
}

/** Name resolution scope for one query level, chained to enclosing levels. */
export class Scope {
  constructor(
    readonly columns: ColumnInfo[],
    readonly parent?: Scope,
    readonly boundary?: Boundary,
    /** For post-aggregation scopes: aggregate call → column index of its result. */
    readonly aggregates?: Map<FunctionCallExpr, number>,
    /** For projection scopes: window function call → column index of its result. */
    readonly windows?: Map<FunctionCallExpr, number>,
  ) {}

  /** Finds a column at this level only. Throws on ambiguity. */
  findLocal(table: string | undefined, name: string): number | undefined {
    const lname = name.toLowerCase();
    const ltable = table?.toLowerCase();
    let found: number | undefined;
    for (let i = 0; i < this.columns.length; i++) {
      const c = this.columns[i]!;
      if (c.hidden) continue;
      if (c.name.toLowerCase() !== lname) continue;
      if (ltable !== undefined && c.table?.toLowerCase() !== ltable) continue;
      if (found !== undefined) {
        throw new SqlCatalogError(`Ambiguous column name: ${table ? `${table}.` : ""}${name}`);
      }
      found = i;
    }
    return found;
  }

  hasQualifier(table: string): boolean {
    const lt = table.toLowerCase();
    return this.columns.some((c) => c.table?.toLowerCase() === lt);
  }

  /** Resolves a column through the scope chain, marking crossed boundaries as correlated. */
  resolve(table: string | undefined, name: string): { depth: number; index: number } | undefined {
    let scope: Scope | undefined = this;
    let depth = 0;
    const crossed: Boundary[] = [];
    while (scope) {
      const index = scope.findLocal(table, name);
      if (index !== undefined) {
        for (const b of crossed) b.correlated = true;
        return { depth, index };
      }
      if (scope.boundary) crossed.push(scope.boundary);
      scope = scope.parent;
      depth++;
    }
    return undefined;
  }
}

export type ParamValues = SqlValue[] | Record<string, SqlValue>;

/**
 * Holds the parameter values of the current execution. Compiled plans read
 * parameters from it at run time, so a plan can be reused with new values.
 */
export class ParamBox {
  values: ParamValues = [];

  get(key: number | string): SqlValue {
    const params = this.values;
    if (typeof key === "number") {
      if (!Array.isArray(params)) throw new SqlRuntimeError("Positional parameter used but named parameters were supplied");
      const value = params[key];
      if (value === undefined) throw new SqlRuntimeError(`Missing value for parameter ${key + 1}`);
      return value;
    }
    if (Array.isArray(params)) throw new SqlRuntimeError(`Named parameter :${key} used but positional parameters were supplied`);
    if (!(key in params)) throw new SqlRuntimeError(`Missing value for parameter :${key}`);
    return params[key]!;
  }
}

/** Hooks the expression compiler needs from the query compiler. */
export interface CompileContext {
  params: ParamBox;
  /**
   * Compiles a subquery whose scope chain is rooted at `outer`. Returns a
   * function that runs it for a given outer environment.
   */
  compileSubquery(query: SelectStatement, outer: Scope, kind: SubqueryKind): SubqueryRunner;
}

/** How a subquery is used, for EXPLAIN output. */
export type SubqueryKind = "SCALAR" | "EXISTS" | "IN";

export interface SubqueryRunner {
  columnCount: number;
  /** Iterates result rows lazily (so EXISTS / scalar subqueries can stop early). */
  run(env: Env): Iterable<SqlValue[]>;
}

const NAMED_CONSTANT_FUNCTIONS = new Set(["CURRENT_DATE", "CURRENT_TIMESTAMP", "CURRENT_TIME"]);

/** Walks an expression tree (not descending into subqueries). */
export function walkExpr(expr: Expr, visit: (e: Expr) => boolean | void): void {
  if (visit(expr) === false) return;
  switch (expr.kind) {
    case "unary":
      walkExpr(expr.operand, visit);
      break;
    case "binary":
      walkExpr(expr.left, visit);
      walkExpr(expr.right, visit);
      break;
    case "isNull":
      walkExpr(expr.operand, visit);
      break;
    case "between":
      walkExpr(expr.operand, visit);
      walkExpr(expr.low, visit);
      walkExpr(expr.high, visit);
      break;
    case "inList":
      walkExpr(expr.operand, visit);
      for (const e of expr.list) walkExpr(e, visit);
      break;
    case "inSubquery":
      walkExpr(expr.operand, visit);
      break;
    case "like":
      walkExpr(expr.operand, visit);
      walkExpr(expr.pattern, visit);
      if (expr.escape) walkExpr(expr.escape, visit);
      break;
    case "case":
      if (expr.operand) walkExpr(expr.operand, visit);
      for (const b of expr.branches) {
        walkExpr(b.when, visit);
        walkExpr(b.then, visit);
      }
      if (expr.elseExpr) walkExpr(expr.elseExpr, visit);
      break;
    case "cast":
      walkExpr(expr.operand, visit);
      break;
    case "function":
      for (const a of expr.args) walkExpr(a, visit);
      if (expr.over) {
        for (const p of expr.over.partitionBy) walkExpr(p, visit);
        for (const o of expr.over.orderBy) walkExpr(o.expr, visit);
      }
      break;
    default:
      break;
  }
}

/**
 * Rebuilds an expression bottom-up. `replace` may return a substitute for a
 * node (which is not visited further); subqueries are left untouched.
 */
export function mapExpr(expr: Expr, replace: (e: Expr) => Expr | undefined): Expr {
  const sub = replace(expr);
  if (sub) return sub;
  const m = (e: Expr): Expr => mapExpr(e, replace);
  switch (expr.kind) {
    case "unary":
      return { ...expr, operand: m(expr.operand) };
    case "binary":
      return { ...expr, left: m(expr.left), right: m(expr.right) };
    case "isNull":
      return { ...expr, operand: m(expr.operand) };
    case "between":
      return { ...expr, operand: m(expr.operand), low: m(expr.low), high: m(expr.high) };
    case "inList":
      return { ...expr, operand: m(expr.operand), list: expr.list.map(m) };
    case "inSubquery":
      return { ...expr, operand: m(expr.operand) };
    case "like":
      return { ...expr, operand: m(expr.operand), pattern: m(expr.pattern), escape: expr.escape && m(expr.escape) };
    case "case":
      return {
        ...expr,
        operand: expr.operand && m(expr.operand),
        branches: expr.branches.map((b) => ({ when: m(b.when), then: m(b.then) })),
        elseExpr: expr.elseExpr && m(expr.elseExpr),
      };
    case "cast":
      return { ...expr, operand: m(expr.operand) };
    case "function":
      // Keep the node identity of calls without arguments to rewrite (aggregate slots are keyed by node).
      if (expr.args.length === 0) return expr;
      return { ...expr, args: expr.args.map(m) };
    default:
      return expr;
  }
}

/** True if the expression contains any subquery. */
export function containsSubquery(expr: Expr): boolean {
  let found = false;
  walkExpr(expr, (e) => {
    if (e.kind === "subquery" || e.kind === "exists" || e.kind === "inSubquery") found = true;
    return !found;
  });
  return found;
}

/** True for calls that aggregate a whole group (aggregate functions without OVER). */
export function isGroupAggregate(e: Expr): e is FunctionCallExpr {
  return e.kind === "function" && !e.over && isAggregateCall(e.name, e.args.length, e.star);
}

/** Collects the window function calls of an expression. */
export function collectWindows(expr: Expr, out: FunctionCallExpr[]): void {
  walkExpr(expr, (e) => {
    if (e.kind === "function" && e.over) {
      for (const a of e.args) {
        walkExpr(a, (inner) => {
          if (inner.kind === "function" && inner.over) throw new SqlRuntimeError("Window functions cannot be nested");
        });
      }
      out.push(e);
    }
    return true;
  });
}

/** Collects the aggregate calls of an expression in evaluation order. */
export function collectAggregates(expr: Expr, out: FunctionCallExpr[]): void {
  walkExpr(expr, (e) => {
    if (isGroupAggregate(e)) {
      for (const arg of e.args) {
        walkExpr(arg, (inner) => {
          if (isGroupAggregate(inner)) {
            throw new SqlRuntimeError(`Aggregate functions cannot be nested: ${e.name}(${inner.name}(...))`);
          }
        });
      }
      out.push(e);
      return false;
    }
    return true;
  });
}

export function hasAggregates(expr: Expr): boolean {
  const out: FunctionCallExpr[] = [];
  collectAggregates(expr, out);
  return out.length > 0;
}

function accessor(depth: number, index: number): Compiled {
  switch (depth) {
    case 0:
      return (env) => env.row[index]!;
    case 1:
      return (env) => env.outer!.row[index]!;
    case 2:
      return (env) => env.outer!.outer!.row[index]!;
    default:
      return (env) => {
        let e = env;
        for (let i = 0; i < depth; i++) e = e.outer!;
        return e.row[index]!;
      };
  }
}

function and(a: SqlValue, b: SqlValue): SqlValue {
  const x = toBool(a);
  const y = toBool(b);
  if (x === false || y === false) return false;
  if (x === null || y === null) return null;
  return true;
}

function or(a: SqlValue, b: SqlValue): SqlValue {
  const x = toBool(a);
  const y = toBool(b);
  if (x === true || y === true) return true;
  if (x === null || y === null) return null;
  return false;
}

function arithmetic(op: string, a: SqlValue, b: SqlValue): SqlValue {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === null || y === null) return null;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      // All numbers are doubles, so `/` is true division (7 / 2 = 3.5).
      if (y === 0) return null;
      return x / y;
    case "%":
      if (y === 0) return null;
      return x % y;
  }
  throw new SqlRuntimeError(`Unknown operator ${op}`);
}

/** Builds an operator-specific comparison closure (avoids a switch per row). */
function comparison(op: string, left: Compiled, right: Compiled): Compiled {
  const test = COMPARATORS[op];
  if (!test) throw new SqlRuntimeError(`Unknown operator ${op}`);
  return (env) => {
    const c = sqlCompare(left(env), right(env));
    return c === null ? null : test(c);
  };
}

const COMPARATORS: Record<string, (c: number) => boolean> = {
  "=": (c) => c === 0,
  "<>": (c) => c !== 0,
  "<": (c) => c < 0,
  "<=": (c) => c <= 0,
  ">": (c) => c > 0,
  ">=": (c) => c >= 0,
};

function compareOp(op: string, a: SqlValue, b: SqlValue): SqlValue {
  const c = sqlCompare(a, b);
  if (c === null) return null;
  switch (op) {
    case "=":
      return c === 0;
    case "<>":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case ">=":
      return c >= 0;
  }
  throw new SqlRuntimeError(`Unknown operator ${op}`);
}

/** Compiles an expression into a closure evaluated against an {@link Env}. */
export function compileExpr(expr: Expr, scope: Scope, ctx: CompileContext): Compiled {
  switch (expr.kind) {
    case "literal": {
      const v = expr.value;
      return () => v;
    }

    case "param": {
      const box = ctx.params;
      const key = expr.key;
      return () => box.get(key);
    }

    case "column": {
      const hit = scope.resolve(expr.table, expr.name);
      if (!hit) {
        if (!expr.table && NAMED_CONSTANT_FUNCTIONS.has(expr.name.toUpperCase())) {
          const name = expr.name.toUpperCase();
          return compileExpr({ kind: "function", name: name === "CURRENT_TIME" ? "TIME" : name, args: [], distinct: false, star: false }, scope, ctx);
        }
        if (expr.table) {
          let s: Scope | undefined = scope;
          let qualifierKnown = false;
          for (; s; s = s.parent) if (s.hasQualifier(expr.table)) qualifierKnown = true;
          if (!qualifierKnown) throw new SqlCatalogError(`No such table or alias: ${expr.table}`);
          throw new SqlCatalogError(`No such column: ${expr.table}.${expr.name}`);
        }
        throw new SqlCatalogError(`No such column: ${expr.name}`);
      }
      return accessor(hit.depth, hit.index);
    }

    case "star":
      throw new SqlRuntimeError("'*' is only allowed in a select list or COUNT(*)");

    case "unary": {
      const operand = compileExpr(expr.operand, scope, ctx);
      switch (expr.op) {
        case "-":
          return (env) => {
            const v = toNumber(operand(env));
            return v === null ? null : -v;
          };
        case "+":
          return (env) => toNumber(operand(env));
        case "NOT":
          return (env) => {
            const v = toBool(operand(env));
            return v === null ? null : !v;
          };
      }
      break;
    }

    case "binary": {
      const left = compileExpr(expr.left, scope, ctx);
      const right = compileExpr(expr.right, scope, ctx);
      const op = expr.op;
      switch (op) {
        case "AND":
          return (env) => {
            const a = left(env);
            if (toBool(a) === false) return false;
            return and(a, right(env));
          };
        case "OR":
          return (env) => {
            const a = left(env);
            if (toBool(a) === true) return true;
            return or(a, right(env));
          };
        case "||":
          return (env) => {
            const a = left(env);
            const b = right(env);
            if (a === null || b === null) return null;
            return toText(a)! + toText(b)!;
          };
        case "+":
        case "-":
        case "*":
        case "/":
        case "%":
          return (env) => arithmetic(op, left(env), right(env));
        default:
          return comparison(op, left, right);
      }
    }

    case "isNull": {
      const operand = compileExpr(expr.operand, scope, ctx);
      return expr.negated ? (env) => operand(env) !== null : (env) => operand(env) === null;
    }

    case "between": {
      const operand = compileExpr(expr.operand, scope, ctx);
      const low = compileExpr(expr.low, scope, ctx);
      const high = compileExpr(expr.high, scope, ctx);
      const negated = expr.negated;
      return (env) => {
        const v = operand(env);
        const r = and(compareOp(">=", v, low(env)), compareOp("<=", v, high(env)));
        return negated && r !== null ? !r : r;
      };
    }

    case "inList": {
      const operand = compileExpr(expr.operand, scope, ctx);
      const list = expr.list.map((e) => compileExpr(e, scope, ctx));
      const negated = expr.negated;
      return (env) => {
        const v = operand(env);
        if (list.length === 0) return negated;
        if (v === null) return null;
        let sawNull = false;
        for (const item of list) {
          const c = sqlCompare(v, item(env));
          if (c === null) sawNull = true;
          else if (c === 0) return !negated;
        }
        return sawNull ? null : negated;
      };
    }

    case "inSubquery": {
      const operand = compileExpr(expr.operand, scope, ctx);
      const sub = ctx.compileSubquery(expr.query, scope, "IN");
      if (sub.columnCount !== 1) throw new SqlRuntimeError("Subquery in IN must return exactly one column");
      const negated = expr.negated;
      return (env) => {
        const v = operand(env);
        let sawNull = false;
        let any = false;
        for (const row of sub.run(env)) {
          any = true;
          if (v === null) break;
          const c = sqlCompare(v, row[0]!);
          if (c === null) sawNull = true;
          else if (c === 0) return !negated;
        }
        if (!any) return negated;
        if (v === null || sawNull) return null;
        return negated;
      };
    }

    case "exists": {
      const sub = ctx.compileSubquery(expr.query, scope, "EXISTS");
      const negated = expr.negated;
      return (env) => {
        for (const _ of sub.run(env)) return !negated;
        return negated;
      };
    }

    case "subquery": {
      const sub = ctx.compileSubquery(expr.query, scope, "SCALAR");
      if (sub.columnCount !== 1) throw new SqlRuntimeError("Scalar subquery must return exactly one column");
      return (env) => {
        for (const row of sub.run(env)) return row[0]!;
        return null;
      };
    }

    case "like": {
      const operand = compileExpr(expr.operand, scope, ctx);
      const pattern = compileExpr(expr.pattern, scope, ctx);
      const escape = expr.escape ? compileExpr(expr.escape, scope, ctx) : undefined;
      const negated = expr.negated;
      const isGlob = expr.op === "GLOB";
      return (env) => {
        const v = operand(env);
        const p = pattern(env);
        if (v === null || p === null) return null;
        let r: boolean;
        if (isGlob) r = glob(toText(v)!, toText(p)!);
        else if (escape) {
          const e = escape(env);
          if (e === null) return null;
          r = like(toText(v)!, toText(p)!, toText(e)!);
        } else r = like(toText(v)!, toText(p)!);
        return negated ? !r : r;
      };
    }

    case "case": {
      const operand = expr.operand ? compileExpr(expr.operand, scope, ctx) : undefined;
      const branches = expr.branches.map((b) => ({ when: compileExpr(b.when, scope, ctx), then: compileExpr(b.then, scope, ctx) }));
      const elseExpr = expr.elseExpr ? compileExpr(expr.elseExpr, scope, ctx) : () => null;
      if (operand) {
        return (env) => {
          const v = operand(env);
          for (const b of branches) if (sqlCompare(v, b.when(env)) === 0) return b.then(env);
          return elseExpr(env);
        };
      }
      return (env) => {
        for (const b of branches) if (toBool(b.when(env)) === true) return b.then(env);
        return elseExpr(env);
      };
    }

    case "cast": {
      const operand = compileExpr(expr.operand, scope, ctx);
      const type = expr.type;
      return (env) => castValue(operand(env), type);
    }

    case "function": {
      if (expr.over) {
        const slot = scope.windows?.get(expr);
        if (slot === undefined) throw new SqlRuntimeError(`Window function ${expr.name}() is only allowed in the select list and ORDER BY`);
        return (env) => env.row[slot]!;
      }
      if (WINDOW_ONLY_FUNCTIONS[expr.name]) throw new SqlRuntimeError(`${expr.name}() requires an OVER clause`);
      if (isAggregateCall(expr.name, expr.args.length, expr.star)) {
        const slot = scope.aggregates?.get(expr);
        if (slot === undefined) {
          throw new SqlRuntimeError(`Aggregate function ${expr.name}() is not allowed here`);
        }
        return (env) => env.row[slot]!;
      }
      if (expr.star) throw new SqlRuntimeError(`${expr.name}(*) is not valid`);
      if (expr.distinct) throw new SqlRuntimeError(`DISTINCT is only allowed in aggregate functions`);
      const fn = lookupScalar(expr.name, expr.args.length);
      const args = expr.args.map((a) => compileExpr(a, scope, ctx));
      // Short-circuit COALESCE / IFNULL / IIF so unused branches are not evaluated.
      if (expr.name === "COALESCE" || expr.name === "IFNULL" || expr.name === "NVL") {
        return (env) => {
          for (const a of args) {
            const v = a(env);
            if (v !== null) return v;
          }
          return null;
        };
      }
      if (expr.name === "IIF" || expr.name === "IF") {
        const [c, t, f] = args as [Compiled, Compiled, Compiled];
        return (env) => (toBool(c(env)) ? t(env) : f(env));
      }
      const impl = fn.fn;
      return (env) => impl(args.map((a) => a(env)));
    }
  }
  throw new SqlRuntimeError(`Cannot compile expression of kind ${(expr as Expr).kind}`);
}

/** Converts host values (e.g. bigint, Date, undefined) into SQL values. */
export function normalizeParam(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  throw new SqlRuntimeError(`Unsupported parameter type: ${typeof v}`);
}

/** Splits `a AND b AND c` into `[a, b, c]`. */
export function splitConjuncts(expr: Expr | undefined): Expr[] {
  if (!expr) return [];
  if (expr.kind === "binary" && expr.op === "AND") return [...splitConjuncts(expr.left), ...splitConjuncts(expr.right)];
  return [expr];
}

/** Joins expressions with AND. */
export function joinConjuncts(exprs: Expr[]): Expr | undefined {
  return exprs.reduce<Expr | undefined>((acc, e) => (acc ? { kind: "binary", op: "AND", left: acc, right: e } : e), undefined);
}

/** Evaluates an expression to a boolean predicate result (NULL counts as false). */
export function predicate(compiled: Compiled): (env: Env) => boolean {
  return (env) => toBool(compiled(env)) === true;
}

/** Renders an expression back to SQL text (used by EXPLAIN and schema dumps). */
export function exprToSql(expr: Expr): string {
  switch (expr.kind) {
    case "literal": {
      const v = expr.value;
      if (v === null) return "NULL";
      if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
      if (typeof v === "number") return String(v);
      return `'${v.replace(/'/g, "''")}'`;
    }
    case "column":
      return expr.table ? `${quoteIdent(expr.table)}.${quoteIdent(expr.name)}` : quoteIdent(expr.name);
    case "param":
      return typeof expr.key === "number" ? "?" : `:${expr.key}`;
    case "star":
      return expr.table ? `${quoteIdent(expr.table)}.*` : "*";
    case "unary":
      return expr.op === "NOT" ? `NOT ${wrap(expr.operand)}` : `${expr.op}${wrap(expr.operand)}`;
    case "binary":
      return `${wrap(expr.left)} ${expr.op} ${wrap(expr.right)}`;
    case "isNull":
      return `${wrap(expr.operand)} IS ${expr.negated ? "NOT " : ""}NULL`;
    case "between":
      return `${wrap(expr.operand)} ${expr.negated ? "NOT " : ""}BETWEEN ${wrap(expr.low)} AND ${wrap(expr.high)}`;
    case "inList":
      return `${wrap(expr.operand)} ${expr.negated ? "NOT " : ""}IN (${expr.list.map(exprToSql).join(", ")})`;
    case "inSubquery":
      return `${wrap(expr.operand)} ${expr.negated ? "NOT " : ""}IN (<subquery>)`;
    case "exists":
      return `${expr.negated ? "NOT " : ""}EXISTS (<subquery>)`;
    case "subquery":
      return "(<subquery>)";
    case "like":
      return `${wrap(expr.operand)} ${expr.negated ? "NOT " : ""}${expr.op} ${wrap(expr.pattern)}${expr.escape ? ` ESCAPE ${exprToSql(expr.escape)}` : ""}`;
    case "case": {
      let s = "CASE";
      if (expr.operand) s += ` ${exprToSql(expr.operand)}`;
      for (const b of expr.branches) s += ` WHEN ${exprToSql(b.when)} THEN ${exprToSql(b.then)}`;
      if (expr.elseExpr) s += ` ELSE ${exprToSql(expr.elseExpr)}`;
      return s + " END";
    }
    case "cast":
      return `CAST(${exprToSql(expr.operand)} AS ${expr.type})`;
    case "function": {
      const call = expr.star ? `${expr.name}(*)` : `${expr.name}(${expr.distinct ? "DISTINCT " : ""}${expr.args.map(exprToSql).join(", ")})`;
      return expr.over ? `${call} OVER (${windowToSql(expr.over)})` : call;
    }
  }
}

function frameBoundToSql(b: FrameBound): string {
  switch (b.kind) {
    case "unboundedPreceding":
      return "UNBOUNDED PRECEDING";
    case "unboundedFollowing":
      return "UNBOUNDED FOLLOWING";
    case "currentRow":
      return "CURRENT ROW";
    case "preceding":
      return `${exprToSql(b.offset)} PRECEDING`;
    case "following":
      return `${exprToSql(b.offset)} FOLLOWING`;
  }
}

function windowToSql(spec: WindowSpec): string {
  const parts: string[] = [];
  if (spec.partitionBy.length) parts.push(`PARTITION BY ${spec.partitionBy.map(exprToSql).join(", ")}`);
  if (spec.orderBy.length) parts.push(`ORDER BY ${spec.orderBy.map((o) => `${exprToSql(o.expr)} ${o.direction}`).join(", ")}`);
  if (spec.frame) parts.push(`${spec.frame.unit} BETWEEN ${frameBoundToSql(spec.frame.start)} AND ${frameBoundToSql(spec.frame.end)}`);
  return parts.join(" ");
}

function wrap(expr: Expr): string {
  const s = exprToSql(expr);
  return expr.kind === "binary" || expr.kind === "between" || expr.kind === "like" ? `(${s})` : s;
}

export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_FOR_QUOTING.has(name.toUpperCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}

const RESERVED_FOR_QUOTING = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "ORDER",
  "GROUP",
  "BY",
  "TABLE",
  "INDEX",
  "KEY",
  "PRIMARY",
  "UNIQUE",
  "NULL",
  "NOT",
  "AND",
  "OR",
  "IN",
  "IS",
  "AS",
  "ON",
  "JOIN",
  "VALUES",
  "DEFAULT",
  "CHECK",
  "LIMIT",
  "OFFSET",
  "SET",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
]);
