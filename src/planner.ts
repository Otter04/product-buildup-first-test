import type {
  CommonTableExpr,
  Expr,
  FrameBound,
  FromItem,
  FunctionCallExpr,
  JoinType,
  OrderByItem,
  SelectCore,
  SelectStatement,
  SubqueryRef,
  TableRef,
} from "./ast.js";
import {
  collectAggregates,
  collectWindows,
  compileExpr,
  containsSubquery,
  exprToSql,
  hasAggregates,
  predicate,
  Scope,
  splitConjuncts,
  walkExpr,
  type Boundary,
  type ColumnInfo,
  type ParamBox,
  type CompileContext,
  type Compiled,
  type Env,
  type SubqueryRunner,
} from "./compiler.js";
import { SqlCatalogError, SqlRuntimeError } from "./errors.js";
import { createAccumulator, type Accumulator } from "./functions.js";
import type { Catalog, Index, Table } from "./storage.js";
import { evaluateWindow, validateWindowCall, type CompiledWindow } from "./window.js";
import { compareValues, rowKey, toBool, toNumber, type SqlValue } from "./values.js";

/** A node of the human-readable query plan produced by EXPLAIN. */
export interface PlanNode {
  label: string;
  children: PlanNode[];
}

export function renderPlan(node: PlanNode): string[] {
  const lines: string[] = [];
  const visit = (n: PlanNode, prefix: string, childPrefix: string): void => {
    lines.push(prefix + n.label);
    n.children.forEach((c, i) => {
      const last = i === n.children.length - 1;
      visit(c, childPrefix + (last ? "└─ " : "├─ "), childPrefix + (last ? "   " : "│  "));
    });
  };
  visit(node, "", "");
  return lines;
}

/** A compiled SELECT, ready to run any number of times within one statement. */
export interface CompiledQuery {
  columns: string[];
  run(outer?: Env): Iterable<SqlValue[]>;
  plan: PlanNode;
}

/** A relation produced by a FROM clause (or part of one). */
interface Source {
  columns: ColumnInfo[];
  rows(outer: Env | undefined): Iterable<SqlValue[]>;
  plan: PlanNode;
  /** True when rows come out in the order requested through an {@link OrderHint}. */
  ordered?: boolean;
}

/**
 * A request to produce a single table's rows sorted by some of its columns,
 * so that ORDER BY needs no sort (and LIMIT can stop early).
 */
interface OrderHint {
  /** Table column indexes, most significant first, each ascending (NULLs first) or descending (NULLs last). */
  terms: { column: number; desc: boolean }[];
  /** With a LIMIT, an ordered index scan beats a selective filter followed by a sort. */
  hasLimit: boolean;
}

interface CteBinding {
  columns: string[];
  rows(outer: Env | undefined): SqlValue[][];
  /** True when the CTE body references columns of an enclosing query. */
  isCorrelated(): boolean;
  /** Recursive working tables change between iterations and must never be cached. */
  volatile: boolean;
  /** Number of open subquery boundaries when the CTE was defined. */
  boundaryDepth: number;
}

type CteMap = ReadonlyMap<string, CteBinding>;

const EMPTY_ROW: SqlValue[] = [];
const MAX_RECURSION_ROWS = 1_000_000;

// ---------------------------------------------------------------------------
// FROM-clause trees
// ---------------------------------------------------------------------------

interface LeafNode {
  kind: "leaf";
  id: number;
  name: string;
  columns: ColumnInfo[];
  offset: number;
  table?: Table;
  query?: CompiledQuery;
  cte?: CteBinding;
  /** Filters that reference only this leaf and can be applied while scanning it. */
  pushed: Expr[];
}

interface JoinNode {
  kind: "join";
  joinType: JoinType;
  left: FromNode;
  right: FromNode;
  /** Conditions evaluated when combining rows from both sides. */
  conds: Expr[];
  leaves: Set<number>;
}

type FromNode = LeafNode | JoinNode;

function leavesOfNode(node: FromNode): Set<number> {
  return node.kind === "leaf" ? new Set([node.id]) : node.leaves;
}

function isSubset(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Whether `leaf` sits on the null-supplying side of an outer join below `node`. */
function isNullableWithin(node: FromNode, leaf: number): boolean {
  if (node.kind === "leaf") return false;
  const inLeft = node.left.kind === "leaf" ? node.left.id === leaf : node.left.leaves.has(leaf);
  if (inLeft) {
    if (node.joinType === "RIGHT" || node.joinType === "FULL") return true;
    return isNullableWithin(node.left, leaf);
  }
  if (node.joinType === "LEFT" || node.joinType === "FULL") return true;
  return isNullableWithin(node.right, leaf);
}

// ---------------------------------------------------------------------------
// Index access paths
// ---------------------------------------------------------------------------

interface ColumnConstraint {
  /** Alternatives for equality (`=` gives one, `IN (...)` gives several). */
  eq?: Expr[];
  lower?: { expr: Expr; inclusive: boolean };
  upper?: { expr: Expr; inclusive: boolean };
}

interface AccessPath {
  index: Index;
  eqColumns: Expr[][];
  lower?: { expr: Expr; inclusive: boolean };
  upper?: { expr: Expr; inclusive: boolean };
  score: number;
}

/**
 * Converts a probe value to the representation stored in an index column of
 * the given type. Returns `undefined` when the value cannot be matched through
 * the index exactly (the caller then falls back to a full scan).
 */
function probeValue(v: SqlValue, table: Table, column: number): SqlValue | undefined {
  const type = table.columns[column]!.type;
  if (v === null) return null;
  switch (type) {
    case "INTEGER":
    case "REAL":
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
      return undefined;
    case "TEXT":
      return typeof v === "string" ? v : undefined;
    case "BOOLEAN":
      return typeof v === "boolean" ? v : undefined;
    case "ANY":
      if (typeof v === "boolean") return v;
      if (typeof v === "string" && (v.trim() === "" || Number.isNaN(Number(v)))) return v;
      return undefined;
  }
}

const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "=": "=" };

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

export class QueryCompiler {
  private readonly boundaryStack: Boundary[] = [];
  /** Views currently being expanded, to detect circular definitions. */
  private readonly viewStack: string[] = [];

  /** Incremented for every execution; run-scoped caches are keyed by it. */
  private runId = 0;

  constructor(
    private readonly catalog: Catalog,
    private readonly params: ParamBox,
  ) {}

  /** Starts a new execution of the compiled plans, invalidating run-scoped caches. */
  beginRun(): void {
    this.runId++;
  }

  /** Caches `compute()` for the duration of one execution. */
  private perRun<T>(compute: () => T): () => T {
    let at = -1;
    let value: T;
    return () => {
      if (at !== this.runId) {
        value = compute();
        at = this.runId;
      }
      return value;
    };
  }

  private context(ctes: CteMap): CompileContext {
    return {
      params: this.params,
      compileSubquery: (query, outer) => this.compileSubquery(query, outer, ctes),
    };
  }

  private compileSubquery(query: SelectStatement, outer: Scope, ctes: CteMap): SubqueryRunner {
    const boundary: Boundary = { correlated: false };
    const compiled = this.compileSelect(query, outer, ctes, boundary);
    if (boundary.correlated) {
      return { columnCount: compiled.columns.length, run: (env) => compiled.run(env) };
    }
    // Uncorrelated subqueries are evaluated once per statement execution.
    let lastEnv: Env | undefined;
    const cached = this.perRun(() => [...compiled.run(lastEnv)]);
    return {
      columnCount: compiled.columns.length,
      run: (env) => {
        lastEnv = env;
        return cached();
      },
    };
  }

  /** Compiles a top-level SELECT. */
  compileTop(stmt: SelectStatement): CompiledQuery {
    return this.compileSelect(stmt, undefined, new Map(), { correlated: false });
  }

  /**
   * Compiles an expression evaluated against the columns of one table
   * (UPDATE / DELETE / RETURNING). `outerColumns`, if given, are visible
   * through `env.outer` and lose to `columns` on unqualified name clashes.
   */
  compileRowExpr(expr: Expr, columns: ColumnInfo[], outerColumns?: ColumnInfo[]): Compiled {
    const boundary: Boundary = { correlated: false };
    const parent = outerColumns ? new Scope(outerColumns) : undefined;
    return this.withBoundary(boundary, () => compileExpr(expr, new Scope(columns, parent, boundary), this.context(new Map())));
  }

  /**
   * Plans a single-table scan for UPDATE / DELETE, using an index when the
   * WHERE clause allows it. `scan()` yields the ids of matching rows.
   */
  compileTableScan(table: Table, alias: string | undefined, where: Expr | undefined): { scan(): Generator<number>; plan: PlanNode } {
    const boundary: Boundary = { correlated: false };
    return this.withBoundary(boundary, () => {
      const name = alias ?? table.name;
      const columns: ColumnInfo[] = table.columns.map((c) => ({ table: name, name: c.name }));
      const scope = new Scope(columns, undefined, boundary);
      const ctx = this.context(new Map());
      const conjuncts = splitConjuncts(where);
      if (conjuncts.some(hasAggregates)) throw new SqlRuntimeError("Aggregate functions are not allowed in WHERE");
      const filter = conjuncts.length ? predicate(compileAll(conjuncts, scope, ctx)) : undefined;
      const access = chooseAccessPath(table, conjuncts.filter((c) => !containsSubquery(c)), scope);
      const constScope = new Scope([], undefined, boundary);
      const filterLabel = conjuncts.length ? ` WHERE ${conjuncts.map(exprToSql).join(" AND ")}` : "";
      const aliasLabel = alias ? ` AS ${alias}` : "";

      if (!access) {
        return {
          plan: { label: `SCAN ${table.name}${aliasLabel}${filterLabel}`, children: [] },
          scan: function* () {
            for (const id of table.rowIds()) {
              if (filter && !filter({ row: table.rows.get(id)! })) continue;
              yield id;
            }
          },
        };
      }
      const eqAlternatives = access.eqColumns.map((alts) => alts.map((e) => compileExpr(e, constScope, ctx)));
      const lower = access.lower ? { value: compileExpr(access.lower.expr, constScope, ctx), inclusive: access.lower.inclusive } : undefined;
      const upper = access.upper ? { value: compileExpr(access.upper.expr, constScope, ctx), inclusive: access.upper.inclusive } : undefined;
      return {
        plan: { label: `SEARCH ${table.name}${aliasLabel} USING INDEX ${access.index.name}${filterLabel}`, children: [] },
        scan: function* () {
          const ids = indexRowIds(access.index, table, eqAlternatives, lower, upper, { row: EMPTY_ROW });
          for (const id of ids ?? table.rowIds()) {
            const row = table.rows.get(id);
            if (!row) continue;
            if (filter && !filter({ row })) continue;
            yield id;
          }
        },
      };
    });
  }

  private withBoundary<T>(boundary: Boundary, fn: () => T): T {
    this.boundaryStack.push(boundary);
    try {
      return fn();
    } finally {
      this.boundaryStack.pop();
    }
  }

  compileSelect(stmt: SelectStatement, outer: Scope | undefined, inheritedCtes: CteMap, boundary: Boundary): CompiledQuery {
    return this.withBoundary(boundary, () => {
      const ctes = this.bindCtes(stmt.with, stmt.recursive ?? false, outer, inheritedCtes, boundary);

      if (stmt.compounds.length === 0) {
        const core = this.compileCore(stmt.core, outer, ctes, boundary, stmt.orderBy, stmt.limit !== undefined);
        return this.finish(core.columns, core.run, core.plan, stmt, outer, ctes, boundary, core.presorted ? [] : core.sortable);
      }

      const cores = [stmt.core, ...stmt.compounds.map((c) => c.core)].map((c) => this.compileCore(c, outer, ctes, boundary, []));
      const width = cores[0]!.columns.length;
      for (const c of cores) {
        if (c.columns.length !== width) {
          throw new SqlRuntimeError("All SELECTs in a compound query must have the same number of result columns");
        }
      }
      const ops = stmt.compounds.map((c) => c.op);
      const run = (env: Env | undefined): Iterable<{ out: SqlValue[]; keys: SqlValue[] }> => {
        let result: SqlValue[][] = [...cores[0]!.run(env)].map((r) => r.out);
        ops.forEach((op, i) => {
          const right = [...cores[i + 1]!.run(env)].map((r) => r.out);
          result = combine(op, result, right);
        });
        return result.map((out) => ({ out, keys: [] }));
      };
      const plan: PlanNode = {
        label: `COMPOUND (${ops.join(", ")})`,
        children: cores.map((c) => c.plan),
      };
      return this.finish(cores[0]!.columns, run, plan, stmt, outer, ctes, boundary, undefined);
    });
  }

  /** Applies ORDER BY, LIMIT and OFFSET on top of a core or compound query. */
  private finish(
    columns: string[],
    run: (env: Env | undefined) => Iterable<{ out: SqlValue[]; keys: SqlValue[] }>,
    plan: PlanNode,
    stmt: SelectStatement,
    outer: Scope | undefined,
    ctes: CteMap,
    boundary: Boundary,
    sortable: SortSpec[] | undefined,
  ): CompiledQuery {
    let sort: SortSpec[] = sortable ?? [];
    const presorted = sortable !== undefined && sortable.length === 0 && stmt.orderBy.length > 0;
    if (!sortable && stmt.orderBy.length) {
      // Compound queries can only be ordered by result columns.
      sort = stmt.orderBy.map((item) => {
        const pos = outputPosition(item.expr, columns);
        if (pos === undefined) throw new SqlRuntimeError(`ORDER BY term ${exprToSql(item.expr)} does not match any result column`);
        return { source: "output", index: pos, direction: item.direction, nulls: item.nulls };
      });
    }

    const ctx = this.context(ctes);
    const constScope = new Scope([], outer, boundary);
    const limit = stmt.limit ? compileExpr(stmt.limit, constScope, ctx) : undefined;
    const offset = stmt.offset ? compileExpr(stmt.offset, constScope, ctx) : undefined;

    let finalPlan = plan;
    if (sort.length || presorted) {
      const label = `${presorted ? "ORDER BY (from index)" : "SORT BY"} ${stmt.orderBy.map((o) => `${exprToSql(o.expr)} ${o.direction}`).join(", ")}`;
      finalPlan = { label, children: [finalPlan] };
    }
    if (limit || offset) {
      const parts = [stmt.limit ? `LIMIT ${exprToSql(stmt.limit)}` : "", stmt.offset ? `OFFSET ${exprToSql(stmt.offset)}` : ""].filter(Boolean);
      finalPlan = { label: parts.join(" "), children: [finalPlan] };
    }

    const evalCount = (c: Compiled | undefined, env: Env | undefined, what: string): number | undefined => {
      if (!c) return undefined;
      const v = c({ row: EMPTY_ROW, outer: env });
      if (v === null) return undefined;
      const n = toNumber(v)!;
      if (!Number.isInteger(n)) throw new SqlRuntimeError(`${what} must be an integer`);
      return n;
    };

    return {
      columns,
      plan: finalPlan,
      run: function* (env?: Env) {
        let rows: Iterable<{ out: SqlValue[]; keys: SqlValue[] }> = run(env);
        if (sort.length) {
          const all = [...rows];
          all.sort((a, b) => {
            for (const s of sort) {
              const va = s.source === "output" ? a.out[s.index]! : a.keys[s.index]!;
              const vb = s.source === "output" ? b.out[s.index]! : b.keys[s.index]!;
              // NULLs sort first ascending and last descending unless told otherwise.
              const nullsFirst = s.nulls ? s.nulls === "FIRST" : s.direction === "ASC";
              if (va === null || vb === null) {
                if (va === null && vb === null) continue;
                return (va === null) === nullsFirst ? -1 : 1;
              }
              const c = compareValues(va, vb);
              if (c !== 0) return s.direction === "ASC" ? c : -c;
            }
            return 0;
          });
          rows = all;
        }
        let skip = evalCount(offset, env, "OFFSET") ?? 0;
        let remaining = evalCount(limit, env, "LIMIT");
        if (remaining !== undefined && remaining < 0) remaining = undefined;
        if (remaining === 0) return;
        for (const r of rows) {
          if (skip > 0) {
            skip--;
            continue;
          }
          yield r.out;
          if (remaining !== undefined && --remaining <= 0) return;
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // CTEs
  // -------------------------------------------------------------------------

  private bindCtes(defs: CommonTableExpr[], recursive: boolean, outer: Scope | undefined, inherited: CteMap, boundary: Boundary): CteMap {
    if (defs.length === 0) return inherited;
    const ctes = new Map(inherited);
    for (const def of defs) {
      const key = def.name.toLowerCase();
      const selfReferencing = recursive && referencesTable(def.query, def.name);
      const binding = selfReferencing
        ? this.bindRecursiveCte(def, outer, ctes, boundary)
        : this.bindPlainCte(def, outer, ctes);
      ctes.set(key, binding);
    }
    return ctes;
  }

  private bindPlainCte(def: CommonTableExpr, outer: Scope | undefined, ctes: CteMap): CteBinding {
    const cteBoundary: Boundary = { correlated: false };
    const compiled = this.compileSelect(def.query, outer, ctes, cteBoundary);
    const columns = renameColumns(def, compiled.columns);
    let lastEnv: Env | undefined;
    const cached = this.perRun(() => [...compiled.run(lastEnv)]);
    return {
      columns,
      volatile: false,
      boundaryDepth: this.boundaryStack.length,
      isCorrelated: () => cteBoundary.correlated,
      rows: (env) => {
        if (cteBoundary.correlated) return [...compiled.run(env)];
        lastEnv = env;
        return cached();
      },
    };
  }

  private bindRecursiveCte(def: CommonTableExpr, outer: Scope | undefined, ctes: CteMap, boundary: Boundary): CteBinding {
    const query = def.query;
    if (query.compounds.length === 0) throw new SqlRuntimeError(`Recursive CTE '${def.name}' must be a compound query (anchor UNION [ALL] recursive part)`);
    const op = query.compounds[0]!.op;
    if (op !== "UNION" && op !== "UNION ALL") throw new SqlRuntimeError(`Recursive CTE '${def.name}' must use UNION or UNION ALL`);
    if (query.compounds.some((c) => c.op !== op)) throw new SqlRuntimeError(`Recursive CTE '${def.name}' must use a single kind of UNION`);

    const cteBoundary: Boundary = { correlated: false };
    const anchor = this.compileSelect({ ...query, compounds: [], orderBy: [], limit: undefined, offset: undefined }, outer, ctes, cteBoundary);
    const columns = renameColumns(def, anchor.columns);

    // The recursive members read from a mutable working table.
    let working: SqlValue[][] = [];
    const workingBinding: CteBinding = {
      columns,
      volatile: true,
      boundaryDepth: this.boundaryStack.length,
      isCorrelated: () => false,
      rows: () => working,
    };
    const recursiveCtes = new Map(ctes);
    recursiveCtes.set(def.name.toLowerCase(), workingBinding);
    const members = query.compounds.map((c) =>
      this.compileSelect({ type: "select", with: [], core: c.core, compounds: [], orderBy: [] }, outer, recursiveCtes, cteBoundary),
    );
    for (const m of members) {
      if (m.columns.length !== columns.length) throw new SqlRuntimeError(`Recursive CTE '${def.name}' parts have different column counts`);
    }

    const limit = query.limit ? compileExpr(query.limit, new Scope([], outer, boundary), this.context(ctes)) : undefined;
    let lastEnv: Env | undefined;
    const cached = this.perRun(() => evaluate(lastEnv));
    const evaluate = (env: Env | undefined): SqlValue[][] => {
      const distinct = op === "UNION";
      const seen = new Set<string>();
      const result: SqlValue[][] = [];
      const max = limit ? toNumber(limit({ row: EMPTY_ROW, outer: env })) ?? Infinity : Infinity;
      const add = (rows: Iterable<SqlValue[]>, next: SqlValue[][]): void => {
        for (const row of rows) {
          if (result.length >= max) return;
          if (distinct) {
            const k = rowKey(row);
            if (seen.has(k)) continue;
            seen.add(k);
          }
          result.push(row);
          next.push(row);
          if (result.length > MAX_RECURSION_ROWS) {
            throw new SqlRuntimeError(`Recursive CTE '${def.name}' produced more than ${MAX_RECURSION_ROWS} rows; missing termination condition?`);
          }
        }
      };
      let frontier: SqlValue[][] = [];
      add(anchor.run(env), frontier);
      while (frontier.length && result.length < max) {
        working = frontier;
        frontier = [];
        for (const m of members) add([...m.run(env)], frontier);
      }
      working = [];
      return result;
    };

    return {
      columns,
      volatile: false,
      boundaryDepth: this.boundaryStack.length,
      isCorrelated: () => cteBoundary.correlated,
      rows: (env) => {
        if (cteBoundary.correlated) return evaluate(env);
        lastEnv = env;
        return cached();
      },
    };
  }

  // -------------------------------------------------------------------------
  // SELECT cores
  // -------------------------------------------------------------------------

  private compileCore(
    core: SelectCore,
    outer: Scope | undefined,
    ctes: CteMap,
    boundary: Boundary,
    orderBy: OrderByItem[],
    hasLimit = false,
  ): {
    columns: string[];
    run: (env: Env | undefined) => Iterable<{ out: SqlValue[]; keys: SqlValue[] }>;
    plan: PlanNode;
    sortable: SortSpec[];
    presorted: boolean;
  } {
    const ctx = this.context(ctes);
    const whereConjuncts = splitConjuncts(core.where);
    if (whereConjuncts.some(hasAggregates)) throw new SqlRuntimeError("Aggregate functions are not allowed in WHERE");
    const orderHint = orderBy.length ? this.orderHint(core, orderBy, ctes, hasLimit) : undefined;
    const { source, residual } = core.from
      ? this.compileFrom(core.from, whereConjuncts, outer, ctes, boundary, orderHint)
      : { source: singleRowSource(), residual: whereConjuncts };

    const scope = new Scope(source.columns, outer, boundary);
    const where = residual.length ? predicate(compileAll(residual, scope, ctx)) : undefined;

    // Expand `*` and `t.*`.
    const items: { expr: Expr; name: string }[] = [];
    for (const item of core.columns) {
      if (item.expr.kind === "star") {
        const qualifier = item.expr.table?.toLowerCase();
        if (qualifier !== undefined && !source.columns.some((c) => c.table?.toLowerCase() === qualifier)) {
          throw new SqlCatalogError(`No such table: ${item.expr.table}`);
        }
        if (!core.from && qualifier === undefined) throw new SqlRuntimeError("SELECT * requires a FROM clause");
        source.columns.forEach((c) => {
          if (c.hidden) return;
          if (qualifier !== undefined && c.table?.toLowerCase() !== qualifier) return;
          items.push({ expr: { kind: "column", table: c.table, name: c.name }, name: c.name });
        });
      } else {
        const name = item.alias ?? (item.expr.kind === "column" ? item.expr.name : item.text ?? exprToSql(item.expr));
        items.push({ expr: item.expr, name });
      }
    }
    const columns = items.map((i) => i.name);

    // Resolve GROUP BY items that refer to result positions or aliases.
    const groupExprs = core.groupBy.map((g) => {
      const pos = positionReference(g, items.length);
      if (pos !== undefined) return items[pos]!.expr;
      if (g.kind === "column" && !g.table && scope.findLocal(undefined, g.name) === undefined) {
        const aliased = items.find((i) => i.name.toLowerCase() === g.name.toLowerCase());
        if (aliased) return aliased.expr;
      }
      return g;
    });
    for (const g of groupExprs) {
      if (hasAggregates(g)) throw new SqlRuntimeError("Aggregate functions are not allowed in GROUP BY");
    }

    // ORDER BY terms that name a result column sort on the output value.
    const orderTerms = orderBy.map((o) => {
      const pos = outputPosition(o.expr, columns, true);
      return { item: o, pos };
    });

    const misplacedWindows = (expr: Expr | undefined, clause: string): void => {
      if (!expr) return;
      const found: FunctionCallExpr[] = [];
      collectWindows(expr, found);
      if (found.length) throw new SqlRuntimeError(`Window functions are not allowed in ${clause}`);
    };
    misplacedWindows(core.having, "HAVING");
    for (const g of groupExprs) misplacedWindows(g, "GROUP BY");

    const aggCalls: FunctionCallExpr[] = [];
    for (const i of items) collectAggregates(i.expr, aggCalls);
    if (core.having) collectAggregates(core.having, aggCalls);
    for (const t of orderTerms) if (t.pos === undefined) collectAggregates(t.item.expr, aggCalls);
    const aggregated = aggCalls.length > 0 || groupExprs.length > 0;
    if (core.having && !aggregated) throw new SqlRuntimeError("HAVING requires GROUP BY or an aggregate function");

    let projScope = scope;
    let aggregation:
      | {
          groups: Compiled[];
          calls: { args: Compiled[]; make: () => Accumulator }[];
          having?: (env: Env) => boolean;
        }
      | undefined;
    if (aggregated) {
      const slots = new Map<FunctionCallExpr, number>();
      const hidden: ColumnInfo[] = aggCalls.map((call, i) => {
        slots.set(call, source.columns.length + i);
        return { name: `__agg${i}`, hidden: true };
      });
      projScope = new Scope([...source.columns, ...hidden], outer, boundary, slots);
      aggregation = {
        groups: groupExprs.map((g) => compileExpr(g, scope, ctx)),
        calls: aggCalls.map((call) => {
          const args = call.args.map((a) => compileExpr(a, scope, ctx));
          // Validate arity eagerly so errors surface even on empty input.
          createAccumulator(call.name, call.args.length, call.star, call.distinct);
          return { args, make: () => createAccumulator(call.name, call.args.length, call.star, call.distinct) };
        }),
        having: core.having ? predicate(compileExpr(core.having, projScope, ctx)) : undefined,
      };
    }

    // Window functions are evaluated over the (possibly aggregated) rows and
    // appended to them as hidden columns before projection.
    const windowCalls: FunctionCallExpr[] = [];
    for (const i of items) collectWindows(i.expr, windowCalls);
    for (const t of orderTerms) if (t.pos === undefined) collectWindows(t.item.expr, windowCalls);
    let windows: CompiledWindow[] = [];
    if (windowCalls.length) {
      windows = windowCalls.map((call) => {
        validateWindowCall(call);
        const spec = call.over!;
        const constScope = new Scope([], outer, boundary);
        const offset = (b: FrameBound): Compiled | undefined =>
          b.kind === "preceding" || b.kind === "following" ? compileExpr(b.offset, constScope, ctx) : undefined;
        return {
          call,
          args: call.args.map((a) => compileExpr(a, projScope, ctx)),
          partitionBy: spec.partitionBy.map((p) => compileExpr(p, projScope, ctx)),
          orderBy: spec.orderBy.map((o) => ({ expr: compileExpr(o.expr, projScope, ctx), direction: o.direction, nulls: o.nulls })),
          frame: spec.frame && { ...spec.frame, startOffset: offset(spec.frame.start), endOffset: offset(spec.frame.end) },
        };
      });
      const base = projScope.columns.length;
      const windowSlots = new Map<FunctionCallExpr, number>();
      const hidden: ColumnInfo[] = windowCalls.map((call, i) => {
        windowSlots.set(call, base + i);
        return { name: `__win${i}`, hidden: true };
      });
      projScope = new Scope([...projScope.columns, ...hidden], outer, boundary, projScope.aggregates, windowSlots);
    }

    const projections = items.map((i) => compileExpr(i.expr, projScope, ctx));
    const sortable: SortSpec[] = [];
    const sortKeyExprs: Compiled[] = [];
    for (const t of orderTerms) {
      if (t.pos !== undefined) {
        sortable.push({ source: "output", index: t.pos, direction: t.item.direction, nulls: t.item.nulls });
      } else {
        sortable.push({ source: "key", index: sortKeyExprs.length, direction: t.item.direction, nulls: t.item.nulls });
        sortKeyExprs.push(compileExpr(t.item.expr, projScope, ctx));
      }
    }

    const distinct = core.distinct;
    const project = (env: Env): { out: SqlValue[]; keys: SqlValue[] } => ({
      out: projections.map((p) => p(env)),
      keys: sortKeyExprs.map((k) => k(env)),
    });

    const filtered = where
      ? function* (env: Env | undefined): Generator<SqlValue[]> {
          const rowEnv: Env = { row: EMPTY_ROW, outer: env };
          for (const row of source.rows(env)) {
            rowEnv.row = row;
            if (!where(rowEnv)) continue;
            yield row;
          }
        }
      : (env: Env | undefined): Iterable<SqlValue[]> => source.rows(env);

    /** Rows ready for projection: filtered source rows, or groups after HAVING. */
    function* grouped(env: Env | undefined): Generator<SqlValue[]> {
      if (!aggregation) {
        yield* filtered(env);
        return;
      }
      const groups = new Map<string, { rep: SqlValue[]; accs: Accumulator[] }>();
      for (const row of filtered(env)) {
        const rowEnv = { row, outer: env };
        const key = aggregation.groups.length ? rowKey(aggregation.groups.map((g) => g(rowEnv))) : "";
        let group = groups.get(key);
        if (!group) {
          group = { rep: row, accs: aggregation.calls.map((c) => c.make()) };
          groups.set(key, group);
        }
        for (let i = 0; i < aggregation.calls.length; i++) {
          group.accs[i]!.step(aggregation.calls[i]!.args.map((a) => a(rowEnv)));
        }
      }
      if (groups.size === 0 && aggregation.groups.length === 0) {
        groups.set("", { rep: source.columns.map(() => null), accs: aggregation.calls.map((c) => c.make()) });
      }
      for (const group of groups.values()) {
        const aggRow = [...group.rep, ...group.accs.map((a) => a.result())];
        if (aggregation.having && !aggregation.having({ row: aggRow, outer: env })) continue;
        yield aggRow;
      }
    }

    function* produce(env: Env | undefined): Generator<{ out: SqlValue[]; keys: SqlValue[] }> {
      if (!windows.length) {
        for (const row of grouped(env)) yield project({ row, outer: env });
        return;
      }
      const all = [...grouped(env)];
      const values = windows.map((w) => evaluateWindow(w, all, env));
      for (let i = 0; i < all.length; i++) {
        yield project({ row: all[i]!.concat(values.map((v) => v[i]!)), outer: env });
      }
    }

    const run = distinct
      ? function* (env: Env | undefined) {
          const seen = new Set<string>();
          for (const r of produce(env)) {
            const k = rowKey(r.out);
            if (seen.has(k)) continue;
            seen.add(k);
            yield r;
          }
        }
      : produce;

    let plan = source.plan;
    if (residual.length) plan = { label: `FILTER ${residual.map(exprToSql).join(" AND ")}`, children: [plan] };
    if (aggregation) {
      const label = groupExprs.length ? `GROUP BY ${groupExprs.map(exprToSql).join(", ")}` : "AGGREGATE";
      const aggs = aggCalls.length ? ` [${aggCalls.map(exprToSql).join(", ")}]` : "";
      plan = { label: label + aggs, children: [plan] };
      if (core.having) plan = { label: `HAVING ${exprToSql(core.having)}`, children: [plan] };
    }
    if (windowCalls.length) plan = { label: `WINDOW [${windowCalls.map(exprToSql).join(", ")}]`, children: [plan] };
    plan = { label: `PROJECT ${columns.join(", ")}`, children: [plan] };
    if (distinct) plan = { label: "DISTINCT", children: [plan] };

    return { columns, run, plan, sortable, presorted: orderHint !== undefined && source.ordered === true };
  }

  /**
   * Works out whether ORDER BY could be satisfied by reading a single table in
   * index order: only plain column references in one direction, and nothing
   * (aggregation, windows, DISTINCT) that would reorder rows afterwards.
   */
  private orderHint(core: SelectCore, orderBy: OrderByItem[], ctes: CteMap, hasLimit: boolean): OrderHint | undefined {
    const from = core.from;
    if (!from || from.kind !== "table" || ctes.has(from.name.toLowerCase()) || this.catalog.findView(from.name)) return undefined;
    const table = this.catalog.findTable(from.name);
    if (!table || core.distinct || core.groupBy.length || core.having) return undefined;
    for (const item of core.columns) {
      if (item.expr.kind !== "star" && (hasAggregates(item.expr) || hasWindows(item.expr))) return undefined;
    }
    const qualifier = (from.alias ?? from.name).toLowerCase();
    const hasStar = core.columns.some((c) => c.expr.kind === "star");
    const terms: OrderHint["terms"] = [];
    for (const term of orderBy) {
      if (hasAggregates(term.expr) || hasWindows(term.expr)) return undefined;
      let expr = term.expr;
      if (expr.kind === "literal") {
        // ORDER BY <position>: only resolvable here without `*` in the select list.
        if (hasStar || typeof expr.value !== "number" || !Number.isInteger(expr.value)) return undefined;
        const item = core.columns[expr.value - 1];
        if (!item) return undefined;
        expr = item.expr;
      } else if (expr.kind === "column" && !expr.table) {
        const name = expr.name.toLowerCase();
        const aliased = core.columns.find((c) => c.alias?.toLowerCase() === name);
        if (aliased) expr = aliased.expr;
      }
      if (expr.kind !== "column" || (expr.table && expr.table.toLowerCase() !== qualifier) || !table.hasColumn(expr.name)) return undefined;
      // The index yields NULLs first going forwards and last going backwards.
      const desc = term.direction === "DESC";
      if (term.nulls && (term.nulls === "FIRST") === desc) return undefined;
      terms.push({ column: table.columnIndex(expr.name), desc });
    }
    return { terms, hasLimit };
  }

  // -------------------------------------------------------------------------
  // FROM clause planning
  // -------------------------------------------------------------------------

  private compileFrom(
    from: FromItem,
    whereConjuncts: Expr[],
    outer: Scope | undefined,
    ctes: CteMap,
    boundary: Boundary,
    orderHint?: OrderHint,
  ): { source: Source; residual: Expr[] } {
    const leaves: LeafNode[] = [];
    const tree = this.buildFromTree(from, outer, ctes, leaves);

    const qualifiers = new Set<string>();
    for (const leaf of leaves) {
      const q = leaf.name.toLowerCase();
      if (qualifiers.has(q)) throw new SqlCatalogError(`Table name or alias '${leaf.name}' is used more than once in FROM`);
      qualifiers.add(q);
    }

    const allColumns = leaves.flatMap((l) => l.columns);
    const fullScope = new Scope(allColumns, outer, boundary);
    const leafOfColumn: number[] = [];
    for (const leaf of leaves) for (let i = 0; i < leaf.columns.length; i++) leafOfColumn.push(leaf.id);

    /** The set of FROM leaves an expression references, or null if it has subqueries. */
    const leafSet = (expr: Expr): Set<number> | null => {
      if (containsSubquery(expr)) return null;
      const set = new Set<number>();
      walkExpr(expr, (e) => {
        if (e.kind === "column") {
          const idx = fullScope.findLocal(e.table, e.name);
          if (idx !== undefined) set.add(leafOfColumn[idx]!);
        }
      });
      return set;
    };

    const residual: Expr[] = [];
    const place = (expr: Expr, node: FromNode, fallback: (e: Expr) => void): void => {
      const set = leafSet(expr);
      if (set === null || set.size === 0 || hasAggregates(expr)) {
        fallback(expr);
        return;
      }
      for (const id of set) {
        if (isNullableWithin(node, id)) {
          fallback(expr);
          return;
        }
      }
      if (set.size === 1) {
        const id = [...set][0]!;
        leaves.find((l) => l.id === id)!.pushed.push(expr);
        return;
      }
      // Attach multi-table predicates to the lowest inner join covering them.
      const target = lowestCoveringJoin(node, set);
      if (target && (target.joinType === "INNER" || target.joinType === "CROSS")) {
        target.conds.push(expr);
        if (target.joinType === "CROSS") target.joinType = "INNER";
        return;
      }
      fallback(expr);
    };

    // ON conditions first: they belong to their join node.
    const placeOn = (node: FromNode): void => {
      if (node.kind === "leaf") return;
      placeOn(node.left);
      placeOn(node.right);
      const on = node.conds;
      node.conds = [];
      for (const c of on) {
        if (node.joinType === "INNER" || node.joinType === "CROSS") {
          place(c, node, (e) => node.conds.push(e));
          continue;
        }
        // For outer joins only predicates on the null-supplying side may be pushed down.
        const set = leafSet(c);
        const supplying = node.joinType === "LEFT" ? node.right : node.joinType === "RIGHT" ? node.left : undefined;
        if (set && set.size > 0 && supplying && isSubset(set, leavesOfNode(supplying)) && !hasAggregates(c)) {
          place(c, supplying, (e) => node.conds.push(e));
        } else {
          node.conds.push(c);
        }
      }
    };
    placeOn(tree);
    for (const c of whereConjuncts) {
      // Validate against the full scope first so ambiguity errors surface.
      if (!containsSubquery(c)) compileExpr(c, fullScope, this.context(ctes));
      place(c, tree, (e) => residual.push(e));
    }

    const source = tree.kind === "leaf" ? this.leafSource(tree, outer, ctes, boundary, orderHint) : this.buildSource(tree, outer, ctes, boundary);
    return { source, residual };
  }

  private buildFromTree(item: FromItem, outer: Scope | undefined, ctes: CteMap, leaves: LeafNode[]): FromNode {
    if (item.kind === "join") {
      const left = this.buildFromTree(item.left, outer, ctes, leaves);
      const right = this.buildFromTree(item.right, outer, ctes, leaves);
      const set = new Set([...leavesOfNode(left), ...leavesOfNode(right)]);
      return { kind: "join", joinType: item.joinType, left, right, conds: splitConjuncts(item.on), leaves: set };
    }
    const leaf = this.buildLeaf(item, outer, ctes, leaves.length);
    leaves.push(leaf);
    return leaf;
  }

  private buildLeaf(item: TableRef | SubqueryRef, outer: Scope | undefined, ctes: CteMap, id: number): LeafNode {
    if (item.kind === "subquery") {
      const query = this.compileSelect(item.query, outer, ctes, this.boundaryStack[this.boundaryStack.length - 1]!);
      const columns = query.columns.map((name) => ({ table: item.alias, name }));
      return { kind: "leaf", id, name: item.alias, columns, offset: 0, query, pushed: [] };
    }
    const name = item.alias ?? item.name;
    const cte = ctes.get(item.name.toLowerCase());
    if (cte) {
      if (cte.volatile) {
        // The recursive members themselves are re-run every iteration, but any
        // subquery nested inside them that reads the working table must not be cached.
        for (const b of this.boundaryStack.slice(cte.boundaryDepth + 1)) b.correlated = true;
      } else if (cte.isCorrelated()) {
        // A CTE that depends on an enclosing query makes its users correlated too.
        for (const b of this.boundaryStack.slice(Math.max(0, cte.boundaryDepth - 1))) b.correlated = true;
      }
      const columns = cte.columns.map((c) => ({ table: name, name: c }));
      return { kind: "leaf", id, name, columns, offset: 0, cte, pushed: [] };
    }
    const view = this.catalog.findView(item.name);
    if (view) {
      const key = view.name.toLowerCase();
      if (this.viewStack.includes(key)) throw new SqlCatalogError(`View '${view.name}' is defined in terms of itself`);
      this.viewStack.push(key);
      try {
        // Views are self-contained: they see neither the enclosing query nor its CTEs.
        const query = this.compileSelect(view.query, undefined, new Map(), { correlated: false });
        const names = view.columns ?? query.columns;
        if (names.length !== query.columns.length) {
          throw new SqlCatalogError(`View '${view.name}' declares ${names.length} columns but its query returns ${query.columns.length}`);
        }
        const columns = names.map((c) => ({ table: name, name: c }));
        return { kind: "leaf", id, name, columns, offset: 0, query, pushed: [] };
      } finally {
        this.viewStack.pop();
      }
    }
    const table = this.catalog.getTable(item.name);
    const columns = table.columns.map((c) => ({ table: name, name: c.name }));
    return { kind: "leaf", id, name, columns, offset: 0, table, pushed: [] };
  }

  private buildSource(node: FromNode, outer: Scope | undefined, ctes: CteMap, boundary: Boundary): Source {
    if (node.kind === "leaf") return this.leafSource(node, outer, ctes, boundary);
    const left = this.buildSource(node.left, outer, ctes, boundary);
    const right = this.buildSource(node.right, outer, ctes, boundary);
    return this.joinSource(node, left, right, outer, ctes, boundary);
  }

  private leafSource(leaf: LeafNode, outer: Scope | undefined, ctes: CteMap, boundary: Boundary, order?: OrderHint): Source {
    const ctx = this.context(ctes);
    const scope = new Scope(leaf.columns, outer, boundary);
    const filter = leaf.pushed.length ? predicate(compileAll(leaf.pushed, scope, ctx)) : undefined;
    const filterLabel = leaf.pushed.length ? ` WHERE ${leaf.pushed.map(exprToSql).join(" AND ")}` : "";
    const aliasLabel = leaf.table && leaf.name.toLowerCase() !== leaf.table.name.toLowerCase() ? ` AS ${leaf.name}` : "";

    if (leaf.query || leaf.cte) {
      const query = leaf.query;
      const cte = leaf.cte;
      const children = query ? [query.plan] : [];
      return {
        columns: leaf.columns,
        plan: { label: `${query ? "SUBQUERY" : "CTE"} ${leaf.name}${filterLabel}`, children },
        rows: function* (env) {
          const rows = query ? query.run(env) : cte!.rows(env);
          for (const row of rows) {
            if (filter && !filter({ row, outer: env })) continue;
            yield row;
          }
        },
      };
    }

    const table = leaf.table!;
    let access = chooseAccessPath(table, leaf.pushed, scope);
    const constScope = new Scope([], outer, boundary);

    // Serve ORDER BY from an index when the access path (or a full index scan) already sorts the rows.
    let reverse = false;
    let ordered = false;
    let orderedScan: Index | undefined;
    if (order) {
      const viaAccess = access ? accessOrder(access, order.terms) : undefined;
      if (viaAccess) {
        ordered = true;
        reverse = viaAccess.reverse;
      } else if ((!access || order.hasLimit) && order.terms.every((t) => t.desc === order.terms[0]!.desc)) {
        orderedScan = table.indexes.find((ix) => order.terms.every((t, i) => ix.columnIndexes[i] === t.column));
        if (orderedScan) {
          ordered = true;
          reverse = order.terms[0]!.desc;
          access = undefined;
        }
      }
    }

    if (orderedScan) {
      const index = orderedScan;
      return {
        columns: leaf.columns,
        ordered,
        plan: { label: `SCAN ${table.name}${aliasLabel} USING INDEX ${index.name}${reverse ? " (reverse)" : ""}${filterLabel}`, children: [] },
        rows: function* (env) {
          const rowEnv: Env = { row: EMPTY_ROW, outer: env };
          for (const id of index.scan(reverse)) {
            const row = table.rows.get(id)!;
            if (filter) {
              rowEnv.row = row;
              if (!filter(rowEnv)) continue;
            }
            yield row;
          }
        },
      };
    }

    if (!access) {
      return {
        columns: leaf.columns,
        plan: { label: `SCAN ${table.name}${aliasLabel}${filterLabel}`, children: [] },
        rows: function* (env) {
          // One env object is reused for every row; predicates never retain it.
          const rowEnv: Env = { row: EMPTY_ROW, outer: env };
          for (const chunk of table.scanChunks()) {
            for (const row of chunk) {
              if (filter) {
                rowEnv.row = row;
                if (!filter(rowEnv)) continue;
              }
              yield row;
            }
          }
        },
      };
    }

    const eqAlternatives = access.eqColumns.map((alts) => alts.map((e) => compileExpr(e, constScope, ctx)));
    const lower = access.lower ? { value: compileExpr(access.lower.expr, constScope, ctx), inclusive: access.lower.inclusive } : undefined;
    const upper = access.upper ? { value: compileExpr(access.upper.expr, constScope, ctx), inclusive: access.upper.inclusive } : undefined;
    const index = access.index;
    const describeAccess = [
      ...access.eqColumns.map((alts, i) => `${index.columns[i]}${alts.length > 1 ? ` IN (${alts.length} values)` : "=?"}`),
      ...(access.lower ? [`${index.columns[access.eqColumns.length]}${access.lower.inclusive ? ">=" : ">"}?`] : []),
      ...(access.upper ? [`${index.columns[access.eqColumns.length]}${access.upper.inclusive ? "<=" : "<"}?`] : []),
    ].join(" AND ");

    const orderTerms = order?.terms ?? [];
    return {
      columns: leaf.columns,
      ordered,
      plan: {
        label: `SEARCH ${table.name}${aliasLabel} USING INDEX ${index.name} (${describeAccess})${ordered && reverse ? " (reverse)" : ""}${filterLabel}`,
        children: [],
      },
      rows: function* (env) {
        const constEnv: Env = { row: EMPTY_ROW, outer: env };
        const ids = indexRowIds(index, table, eqAlternatives, lower, upper, constEnv, ordered && reverse);
        if (ids) {
          const rowEnv: Env = { row: EMPTY_ROW, outer: env };
          for (const id of ids) {
            const row = table.rows.get(id);
            if (!row) continue;
            if (filter) {
              rowEnv.row = row;
              if (!filter(rowEnv)) continue;
            }
            yield row;
          }
          return;
        }
        // The probe values cannot be looked up exactly: scan everything (sorting if order was promised).
        const matching: SqlValue[][] = [];
        for (const row of table.scan()) {
          if (filter && !filter({ row, outer: env })) continue;
          if (!ordered) {
            yield row;
            continue;
          }
          matching.push(row);
        }
        if (ordered) yield* sortRowsBy(matching, orderTerms);
      },
    };
  }

  private joinSource(node: JoinNode, left: Source, right: Source, outer: Scope | undefined, ctes: CteMap, boundary: Boundary): Source {
    const ctx = this.context(ctes);
    const columns = [...left.columns, ...right.columns];
    const scope = new Scope(columns, outer, boundary);
    const cond = node.conds.length ? predicate(compileAll(node.conds, scope, ctx)) : undefined;
    const joinType = node.joinType;
    const rightNulls: SqlValue[] = right.columns.map(() => null);
    const leftNulls: SqlValue[] = left.columns.map(() => null);
    const condLabel = node.conds.length ? ` ON ${node.conds.map(exprToSql).join(" AND ")}` : "";

    // Split equality conditions into (left key, right key) pairs.
    const leftScope = new Scope(left.columns, outer, boundary);
    const rightScope = new Scope(right.columns, outer, boundary);
    const equi: { left: Expr; right: Expr }[] = [];
    for (const c of node.conds) {
      if (c.kind !== "binary" || c.op !== "=" || containsSubquery(c)) continue;
      const ls = sideOf(c.left, leftScope, rightScope);
      const rs = sideOf(c.right, leftScope, rightScope);
      if (ls === "left" && rs === "right") equi.push({ left: c.left, right: c.right });
      else if (ls === "right" && rs === "left") equi.push({ left: c.right, right: c.left });
    }

    // Index nested-loop join: probe an index on the right table for each left row.
    if ((joinType === "INNER" || joinType === "LEFT") && node.right.kind === "leaf" && node.right.table) {
      const rightLeaf = node.right;
      const table = rightLeaf.table!;
      for (const pair of equi) {
        if (pair.right.kind !== "column") continue;
        const colIdx = rightScope.findLocal(pair.right.table, pair.right.name);
        if (colIdx === undefined) continue;
        const index = table.indexes.find((ix) => ix.columnIndexes[0] === colIdx);
        if (!index) continue;
        const probe = compileExpr(pair.left, leftScope, ctx);
        const rightFilter = rightLeaf.pushed.length
          ? predicate(compileAll(rightLeaf.pushed, new Scope(rightLeaf.columns, outer, boundary), ctx))
          : undefined;
        const filterLabel = rightLeaf.pushed.length ? ` WHERE ${rightLeaf.pushed.map(exprToSql).join(" AND ")}` : "";
        const aliasLabel = rightLeaf.name.toLowerCase() !== table.name.toLowerCase() ? ` AS ${rightLeaf.name}` : "";
        return {
          columns,
          plan: {
            label: `${joinType} JOIN (index nested loop)${condLabel}`,
            children: [left.plan, { label: `SEARCH ${table.name}${aliasLabel} USING INDEX ${index.name} (${index.columns[0]}=?)${filterLabel}`, children: [] }],
          },
          rows: function* (env) {
            for (const l of left.rows(env)) {
              const key = probe({ row: l, outer: env });
              let matched = false;
              if (key !== null) {
                const pv = probeValue(key, table, colIdx);
                const ids: Iterable<number> = pv === undefined ? table.rowIds() : index.lookup([pv]);
                for (const id of ids) {
                  const r = table.rows.get(id);
                  if (!r) continue;
                  if (rightFilter && !rightFilter({ row: r, outer: env })) continue;
                  const combined = l.concat(r);
                  if (cond && !cond({ row: combined, outer: env })) continue;
                  matched = true;
                  yield combined;
                }
              }
              if (!matched && joinType === "LEFT") yield l.concat(rightNulls);
            }
          },
        };
      }
    }

    const emitUnmatchedRight = joinType === "RIGHT" || joinType === "FULL";
    const emitUnmatchedLeft = joinType === "LEFT" || joinType === "FULL";

    if (equi.length) {
      const leftKeys = equi.map((p) => compileExpr(p.left, leftScope, ctx));
      const rightKeys = equi.map((p) => compileExpr(p.right, rightScope, ctx));
      return {
        columns,
        plan: { label: `${joinType} JOIN (hash)${condLabel}`, children: [left.plan, right.plan] },
        rows: function* (env) {
          const rightRows = [...right.rows(env)];
          const buckets = new Map<string, number[]>();
          rightRows.forEach((r, i) => {
            const key = hashKey(rightKeys.map((k) => k({ row: r, outer: env })));
            if (key === null) return;
            let bucket = buckets.get(key);
            if (!bucket) buckets.set(key, (bucket = []));
            bucket.push(i);
          });
          const matchedRight = emitUnmatchedRight ? new Uint8Array(rightRows.length) : undefined;
          for (const l of left.rows(env)) {
            const key = hashKey(leftKeys.map((k) => k({ row: l, outer: env })));
            let matched = false;
            if (key !== null) {
              for (const i of buckets.get(key) ?? []) {
                const combined = l.concat(rightRows[i]!);
                if (cond && !cond({ row: combined, outer: env })) continue;
                matched = true;
                if (matchedRight) matchedRight[i] = 1;
                yield combined;
              }
            }
            if (!matched && emitUnmatchedLeft) yield l.concat(rightNulls);
          }
          if (matchedRight) {
            for (let i = 0; i < rightRows.length; i++) if (!matchedRight[i]) yield leftNulls.concat(rightRows[i]!);
          }
        },
      };
    }

    return {
      columns,
      plan: { label: `${joinType} JOIN (nested loop)${condLabel}`, children: [left.plan, right.plan] },
      rows: function* (env) {
        const rightRows = [...right.rows(env)];
        const matchedRight = emitUnmatchedRight ? new Uint8Array(rightRows.length) : undefined;
        for (const l of left.rows(env)) {
          let matched = false;
          for (let i = 0; i < rightRows.length; i++) {
            const combined = l.concat(rightRows[i]!);
            if (cond && !cond({ row: combined, outer: env })) continue;
            matched = true;
            if (matchedRight) matchedRight[i] = 1;
            yield combined;
          }
          if (!matched && emitUnmatchedLeft) yield l.concat(rightNulls);
        }
        if (matchedRight) {
          for (let i = 0; i < rightRows.length; i++) if (!matchedRight[i]) yield leftNulls.concat(rightRows[i]!);
        }
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SortSpec {
  source: "output" | "key";
  index: number;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

function singleRowSource(): Source {
  return {
    columns: [],
    plan: { label: "SINGLE ROW", children: [] },
    rows: () => [EMPTY_ROW],
  };
}

function compileAll(exprs: Expr[], scope: Scope, ctx: CompileContext): Compiled {
  const compiled = exprs.map((e) => compileExpr(e, scope, ctx));
  if (compiled.length === 1) return compiled[0]!;
  return (env) => {
    let sawNull = false;
    for (const c of compiled) {
      const b = toBool(c(env));
      if (b === false) return false;
      if (b === null) sawNull = true;
    }
    return sawNull ? null : true;
  };
}

/**
 * Whether an index access path returns rows in the requested order, and in
 * which direction. Columns pinned by single-value equalities are constant and
 * can be ignored; the rest must be the index columns that follow the equality
 * prefix, all sorted in the same direction.
 */
function accessOrder(access: AccessPath, terms: OrderHint["terms"]): { reverse: boolean } | undefined {
  if (access.eqColumns.some((alts) => alts.length !== 1)) return undefined;
  const eqCount = access.eqColumns.length;
  const pinned = new Set(access.index.columnIndexes.slice(0, eqCount));
  const rest = terms.filter((t) => !pinned.has(t.column));
  if (!rest.every((t, i) => access.index.columnIndexes[eqCount + i] === t.column && t.desc === rest[0]!.desc)) return undefined;
  return { reverse: rest[0]?.desc ?? false };
}

/** Sorts rows by table columns in index order (NULLs first), each term ascending or descending. */
function sortRowsBy(rows: SqlValue[][], terms: OrderHint["terms"]): SqlValue[][] {
  return [...rows].sort((a, b) => {
    for (const t of terms) {
      const d = compareValues(a[t.column]!, b[t.column]!);
      if (d !== 0) return t.desc ? -d : d;
    }
    return 0;
  });
}

function hasWindows(expr: Expr): boolean {
  const found: FunctionCallExpr[] = [];
  collectWindows(expr, found);
  return found.length > 0;
}

/** For `GROUP BY 1` / `ORDER BY 2`: zero-based position of a result column. */
function positionReference(expr: Expr, count: number): number | undefined {
  if (expr.kind !== "literal" || typeof expr.value !== "number") return undefined;
  const n = expr.value;
  if (!Number.isInteger(n) || n < 1 || n > count) throw new SqlRuntimeError(`Column position ${n} is out of range (1..${count})`);
  return n - 1;
}

/** Maps an ORDER BY term to a result column by position or by name. */
function outputPosition(expr: Expr, columns: string[], preferInputForAmbiguous = false): number | undefined {
  const pos = positionReference(expr, columns.length);
  if (pos !== undefined) return pos;
  if (expr.kind === "column" && !expr.table) {
    const lname = expr.name.toLowerCase();
    const matches = columns.map((c, i) => (c.toLowerCase() === lname ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && !preferInputForAmbiguous) return matches[0];
  }
  return undefined;
}

function renameColumns(def: CommonTableExpr, columns: string[]): string[] {
  if (!def.columns) return columns;
  if (def.columns.length !== columns.length) {
    throw new SqlRuntimeError(`CTE '${def.name}' declares ${def.columns.length} columns but its query returns ${columns.length}`);
  }
  return def.columns;
}

/**
 * Visits every table reference and every expression of a query, including
 * nested subqueries, CTEs, ORDER BY / LIMIT and window specifications.
 */
function walkSelect(query: SelectStatement, onTable: (ref: TableRef) => void, onExpr: (e: Expr) => void): void {
  const visitExpr = (expr: Expr | undefined): void => {
    if (!expr) return;
    walkExpr(expr, (e) => {
      onExpr(e);
      if (e.kind === "subquery" || e.kind === "exists" || e.kind === "inSubquery") visitQuery(e.query);
      if (e.kind === "function" && e.over?.frame) {
        for (const b of [e.over.frame.start, e.over.frame.end]) if (b.kind === "preceding" || b.kind === "following") visitExpr(b.offset);
      }
    });
  };
  const visitFrom = (item: FromItem | undefined): void => {
    if (!item) return;
    if (item.kind === "table") onTable(item);
    else if (item.kind === "subquery") visitQuery(item.query);
    else {
      visitFrom(item.left);
      visitFrom(item.right);
      visitExpr(item.on);
    }
  };
  const visitCore = (core: SelectCore): void => {
    visitFrom(core.from);
    visitExpr(core.where);
    visitExpr(core.having);
    for (const c of core.columns) visitExpr(c.expr);
    for (const g of core.groupBy) visitExpr(g);
  };
  const visitQuery = (q: SelectStatement): void => {
    for (const cte of q.with) visitQuery(cte.query);
    visitCore(q.core);
    for (const c of q.compounds) visitCore(c.core);
    for (const o of q.orderBy) visitExpr(o.expr);
    visitExpr(q.limit);
    visitExpr(q.offset);
  };
  visitQuery(query);
}

/** Whether a query mentions `name` in any FROM clause (used to detect recursive CTEs). */
function referencesTable(query: SelectStatement, name: string): boolean {
  const lname = name.toLowerCase();
  let found = false;
  walkSelect(
    query,
    (ref) => {
      if (ref.name.toLowerCase() === lname) found = true;
    },
    () => {},
  );
  return found;
}

/** Whether a query contains any `?` / `:name` parameter. */
export function containsParams(query: SelectStatement): boolean {
  let found = false;
  walkSelect(
    query,
    () => {},
    (e) => {
      if (e.kind === "param") found = true;
    },
  );
  return found;
}

function lowestCoveringJoin(node: FromNode, set: Set<number>): JoinNode | undefined {
  if (node.kind === "leaf" || !isSubset(set, node.leaves)) return undefined;
  return lowestCoveringJoin(node.left, set) ?? lowestCoveringJoin(node.right, set) ?? node;
}

/** Which join input an expression depends on: only the left, only the right, or neither/both. */
function sideOf(expr: Expr, leftScope: Scope, rightScope: Scope): "left" | "right" | "mixed" | "none" {
  let usesLeft = false;
  let usesRight = false;
  walkExpr(expr, (e) => {
    if (e.kind !== "column") return;
    let inLeft = false;
    let inRight = false;
    try {
      inLeft = leftScope.findLocal(e.table, e.name) !== undefined;
    } catch {
      inLeft = true;
    }
    try {
      inRight = rightScope.findLocal(e.table, e.name) !== undefined;
    } catch {
      inRight = true;
    }
    if (inLeft && inRight) {
      usesLeft = usesRight = true;
    } else if (inLeft) usesLeft = true;
    else if (inRight) usesRight = true;
  });
  if (usesLeft && usesRight) return "mixed";
  if (usesLeft) return "left";
  if (usesRight) return "right";
  return "none";
}

/**
 * Hash key for join probing. Values that compare equal under SQL semantics
 * (e.g. 10 and '10') must collide; false positives are removed by re-checking
 * the join condition. Returns null if any component is NULL.
 */
function hashKey(values: SqlValue[]): string | null {
  let key = "";
  for (const v of values) {
    if (v === null) return null;
    if (typeof v === "number") key += `d${v}\u0000`;
    else if (typeof v === "boolean") key += `b${v ? 1 : 0}\u0000`;
    else {
      const t = v.trim();
      key += t !== "" && !Number.isNaN(Number(t)) ? `d${Number(t)}\u0000` : `s${v}\u0000`;
    }
  }
  return key;
}

function combine(op: string, left: SqlValue[][], right: SqlValue[][]): SqlValue[][] {
  switch (op) {
    case "UNION ALL":
      return left.concat(right);
    case "UNION": {
      const seen = new Set<string>();
      const out: SqlValue[][] = [];
      for (const row of left.concat(right)) {
        const k = rowKey(row);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(row);
      }
      return out;
    }
    case "INTERSECT": {
      const rightKeys = new Set(right.map(rowKey));
      const seen = new Set<string>();
      return left.filter((row) => {
        const k = rowKey(row);
        if (!rightKeys.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case "EXCEPT": {
      const rightKeys = new Set(right.map(rowKey));
      const seen = new Set<string>();
      return left.filter((row) => {
        const k = rowKey(row);
        if (rightKeys.has(k) || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }
  throw new SqlRuntimeError(`Unknown compound operator ${op}`);
}

/** Expressions that do not depend on the scanned table (only constants, params and outer refs). */
function isTableIndependent(expr: Expr, scope: Scope): boolean {
  if (containsSubquery(expr)) return false;
  let independent = true;
  walkExpr(expr, (e) => {
    if (e.kind === "column" && scope.findLocal(e.table, e.name) !== undefined) independent = false;
    return independent;
  });
  return independent;
}

/** Picks the most selective usable index for the given single-table predicates. */
export function chooseAccessPath(table: Table, conjuncts: Expr[], scope: Scope): AccessPath | undefined {
  if (table.indexes.length === 0 || conjuncts.length === 0) return undefined;
  const constraints = new Map<number, ColumnConstraint>();
  const get = (col: number): ColumnConstraint => {
    let c = constraints.get(col);
    if (!c) constraints.set(col, (c = {}));
    return c;
  };
  const columnOf = (e: Expr): number | undefined => (e.kind === "column" ? scope.findLocal(e.table, e.name) : undefined);

  for (const c of conjuncts) {
    if (c.kind === "binary" && FLIP[c.op]) {
      let col = columnOf(c.left);
      let other = c.right;
      let op = c.op;
      if (col === undefined || !isTableIndependent(other, scope)) {
        col = columnOf(c.right);
        other = c.left;
        op = FLIP[c.op] as typeof op;
        if (col === undefined || !isTableIndependent(other, scope)) continue;
      }
      const cc = get(col);
      if (op === "=") cc.eq ??= [other];
      else if (op === ">" || op === ">=") cc.lower ??= { expr: other, inclusive: op === ">=" };
      else cc.upper ??= { expr: other, inclusive: op === "<=" };
    } else if (c.kind === "between" && !c.negated) {
      const col = columnOf(c.operand);
      if (col === undefined || !isTableIndependent(c.low, scope) || !isTableIndependent(c.high, scope)) continue;
      const cc = get(col);
      cc.lower ??= { expr: c.low, inclusive: true };
      cc.upper ??= { expr: c.high, inclusive: true };
    } else if (c.kind === "inList" && !c.negated && c.list.length > 0) {
      const col = columnOf(c.operand);
      if (col === undefined || !c.list.every((e) => isTableIndependent(e, scope))) continue;
      const cc = get(col);
      cc.eq ??= c.list;
    }
  }
  if (constraints.size === 0) return undefined;

  let best: AccessPath | undefined;
  for (const index of table.indexes) {
    const eqColumns: Expr[][] = [];
    let lower: AccessPath["lower"];
    let upper: AccessPath["upper"];
    for (const col of index.columnIndexes) {
      const cc = constraints.get(col);
      if (cc?.eq) {
        eqColumns.push(cc.eq);
        continue;
      }
      if (cc && (cc.lower || cc.upper)) {
        lower = cc.lower;
        upper = cc.upper;
      }
      break;
    }
    if (eqColumns.length === 0 && !lower && !upper) continue;
    let score = eqColumns.length * 4 + (lower ? 1 : 0) + (upper ? 1 : 0);
    if (index.unique && eqColumns.length === index.columnIndexes.length) score += 100;
    // Many IN alternatives make an index probe less attractive.
    if (eqColumns.some((alts) => alts.length > 1)) score -= 1;
    if (!best || score > best.score) best = { index, eqColumns, lower, upper, score };
  }
  return best;
}

/**
 * Evaluates index probe values and returns matching row ids, or undefined when
 * the probe values cannot be represented in the index (forcing a full scan).
 */
function indexRowIds(
  index: Index,
  table: Table,
  eqAlternatives: Compiled[][],
  lower: { value: Compiled; inclusive: boolean } | undefined,
  upper: { value: Compiled; inclusive: boolean } | undefined,
  env: Env,
  reverse = false,
): Iterable<number> | undefined {
  // Build the cartesian product of equality alternatives.
  let prefixes: SqlValue[][] = [[]];
  for (let i = 0; i < eqAlternatives.length; i++) {
    const colIdx = index.columnIndexes[i]!;
    const values: SqlValue[] = [];
    for (const alt of eqAlternatives[i]!) {
      const v = alt(env);
      if (v === null) continue; // `= NULL` never matches
      const pv = probeValue(v, table, colIdx);
      if (pv === undefined) return undefined;
      values.push(pv);
    }
    const next: SqlValue[][] = [];
    for (const p of prefixes) for (const v of values) next.push([...p, v]);
    prefixes = next;
  }
  const rangeCol = index.columnIndexes[eqAlternatives.length];
  let lo: { value: SqlValue; inclusive: boolean } | undefined;
  let hi: { value: SqlValue; inclusive: boolean } | undefined;
  if (lower && rangeCol !== undefined) {
    const v = lower.value(env);
    if (v === null) return [];
    const pv = probeValue(v, table, rangeCol);
    if (pv === undefined) return undefined;
    lo = { value: pv, inclusive: lower.inclusive };
  }
  if (upper && rangeCol !== undefined) {
    const v = upper.value(env);
    if (v === null) return [];
    const pv = probeValue(v, table, rangeCol);
    if (pv === undefined) return undefined;
    hi = { value: pv, inclusive: upper.inclusive };
  }
  if (prefixes.length === 1) {
    if (reverse) return index.range(prefixes[0]!, lo, hi, true);
    return lo || hi ? index.range(prefixes[0]!, lo, hi) : index.lookup(prefixes[0]!);
  }
  const seen = new Set<number>();
  for (const p of prefixes) {
    for (const id of lo || hi ? index.range(p, lo, hi) : index.lookup(p)) seen.add(id);
  }
  return seen;
}
