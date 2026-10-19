/**
 * Differential testing: generates random data and random queries, runs them on
 * both minisql and SQLite (via node:sqlite), and checks that the results agree.
 * The generator sticks to the SQL subset where both engines share semantics
 * (e.g. no `/`, which is integer division in SQLite but not in minisql).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";

type SqliteDb = { exec(sql: string): void; prepare(sql: string): { all(): Record<string, unknown>[] } };
let DatabaseSync: (new (path: string) => SqliteDb) | undefined;
try {
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

/** `FUZZ_SEEDS=n npm run fuzz` runs n extra seeds per fuzzer instead of the quick default set. */
const FUZZ_SEEDS = Number(process.env.FUZZ_SEEDS ?? 0);
const seeds = (base: number, defaults: number[]): number[] =>
  FUZZ_SEEDS > 0 ? Array.from({ length: FUZZ_SEEDS }, (_, i) => base + i) : defaults;

class Random {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const WORDS = ["a", "b", "ab", "ba", "abc", "B", "x", "xy", "", "zz"];

interface TableSpec {
  name: string;
  intCols: string[];
  textCols: string[];
}

const TABLES: TableSpec[] = [
  { name: "t1", intCols: ["a", "b"], textCols: ["c"] },
  { name: "t2", intCols: ["a", "d"], textCols: ["e"] },
  { name: "t3", intCols: ["k", "v"], textCols: ["s"] },
];

function setupSql(r: Random, withIndexes: boolean): string {
  const parts: string[] = [];
  for (const t of TABLES) {
    const cols = ["id INTEGER PRIMARY KEY", ...t.intCols.map((c) => `${c} INTEGER`), ...t.textCols.map((c) => `${c} TEXT`)];
    parts.push(`CREATE TABLE ${t.name} (${cols.join(", ")});`);
    const n = r.int(0, 25);
    for (let i = 0; i < n; i++) {
      const values = [
        "NULL",
        ...t.intCols.map(() => (r.chance(0.15) ? "NULL" : String(r.int(-3, 8)))),
        ...t.textCols.map(() => (r.chance(0.15) ? "NULL" : `'${r.pick(WORDS)}'`)),
      ];
      parts.push(`INSERT INTO ${t.name} VALUES (${values.join(", ")});`);
    }
  }
  if (withIndexes) {
    parts.push("CREATE INDEX i_t1_a ON t1 (a);");
    parts.push("CREATE INDEX i_t1_bc ON t1 (b, c);");
    parts.push("CREATE INDEX i_t2_a ON t2 (a);");
    parts.push("CREATE INDEX i_t2_e ON t2 (e);");
    parts.push("CREATE INDEX i_t3_kv ON t3 (k, v);");
  }
  return parts.join("\n");
}

interface Ctx {
  r: Random;
  /** Columns in scope, as qualified names, split by type. */
  ints: string[];
  texts: string[];
  depth: number;
}

function intExpr(ctx: Ctx): string {
  const { r } = ctx;
  const roll = r.next();
  if (roll < 0.45 && ctx.ints.length) return r.pick(ctx.ints);
  if (roll < 0.65) return String(r.int(-3, 8));
  if (roll < 0.8 && ctx.depth < 2) {
    const inner = { ...ctx, depth: ctx.depth + 1 };
    return `(${intExpr(inner)} ${r.pick(["+", "-", "*"])} ${intExpr(inner)})`;
  }
  if (roll < 0.87 && ctx.depth < 2) {
    const inner = { ...ctx, depth: ctx.depth + 1 };
    return `COALESCE(${intExpr(inner)}, ${r.int(0, 5)})`;
  }
  if (roll < 0.93 && ctx.depth < 2) {
    const inner = { ...ctx, depth: ctx.depth + 1 };
    return `CASE WHEN ${predicate(inner)} THEN ${intExpr(inner)} ELSE ${intExpr(inner)} END`;
  }
  if (roll < 0.95 && ctx.texts.length) return `LENGTH(${r.pick(ctx.texts)})`;
  if (roll < 0.96 && ctx.texts.length) return `INSTR(${r.pick(ctx.texts)}, '${r.pick(["a", "b", "x"])}')`;
  if (roll < 0.97 && ctx.ints.length) return `(${r.pick(ctx.ints)} % ${r.pick([2, 3, -3, 0])})`;
  if (roll < 0.98 && ctx.depth < 2) {
    const inner = { ...ctx, depth: ctx.depth + 1 };
    return `NULLIF(${intExpr(inner)}, ${r.int(0, 3)})`;
  }
  return `ABS(${ctx.ints.length ? r.pick(ctx.ints) : r.int(-5, 5)})`;
}

function textExpr(ctx: Ctx): string {
  const { r } = ctx;
  const roll = r.next();
  if (roll < 0.6 && ctx.texts.length) return r.pick(ctx.texts);
  if (roll < 0.8) return `'${r.pick(WORDS)}'`;
  if (roll < 0.84 && ctx.texts.length) return `UPPER(${r.pick(ctx.texts)})`;
  if (roll < 0.87 && ctx.texts.length) return `SUBSTR(${r.pick(ctx.texts)}, ${r.int(-3, 3)}${r.chance(0.5) ? `, ${r.int(-2, 3)}` : ""})`;
  if (roll < 0.9 && ctx.texts.length) return `REPLACE(${r.pick(ctx.texts)}, '${r.pick(["a", "b", "x"])}', '${r.pick(WORDS)}')`;
  if (roll < 0.92 && ctx.texts.length) return `TRIM(${r.pick(ctx.texts)}, '${r.pick(["a", "b", "ab"])}')`;
  if (roll < 0.94 && ctx.texts.length) return `COALESCE(${r.pick(ctx.texts)}, '${r.pick(WORDS)}')`;
  if (ctx.texts.length) return `(${r.pick(ctx.texts)} || '${r.pick(WORDS)}')`;
  return `'${r.pick(WORDS)}'`;
}

function predicate(ctx: Ctx): string {
  const { r } = ctx;
  const inner = { ...ctx, depth: ctx.depth + 1 };
  const roll = r.next();
  if (ctx.depth < 2 && roll < 0.15) return `(${predicate(inner)} ${r.pick(["AND", "OR"])} ${predicate(inner)})`;
  if (ctx.depth < 2 && roll < 0.2) return `NOT (${predicate(inner)})`;
  if (roll < 0.5) return `${intExpr(inner)} ${r.pick(["=", "<>", "<", "<=", ">", ">="])} ${intExpr(inner)}`;
  if (roll < 0.6) return `${textExpr(inner)} ${r.pick(["=", "<>", "<", ">="])} ${textExpr(inner)}`;
  if (roll < 0.65) return `${r.pick([...ctx.ints, ...ctx.texts])} IS ${r.chance(0.5) ? "NOT " : ""}NULL`;
  if (roll < 0.68 && ctx.ints.length) {
    const other = r.chance(0.5) ? r.pick(ctx.ints) : String(r.int(-1, 4));
    const op = r.pick(["IS", "IS NOT", "IS DISTINCT FROM", "IS NOT DISTINCT FROM"]);
    return `${r.pick(ctx.ints)} ${op} ${other}`;
  }
  if (roll < 0.76) {
    const list = Array.from({ length: r.int(1, 4) }, () => (r.chance(0.1) ? "NULL" : String(r.int(-2, 6))));
    return `${intExpr(inner)} ${r.chance(0.3) ? "NOT " : ""}IN (${list.join(", ")})`;
  }
  if (roll < 0.84) {
    const lo = r.int(-3, 4);
    return `${intExpr(inner)} ${r.chance(0.2) ? "NOT " : ""}BETWEEN ${lo} AND ${lo + r.int(0, 5)}`;
  }
  if (roll < 0.9 && ctx.texts.length) {
    return `${r.pick(ctx.texts)} ${r.chance(0.2) ? "NOT " : ""}LIKE '${r.pick(["a%", "%b", "_", "%", "a_", "%x%"])}'`;
  }
  if (ctx.depth < 2) return subqueryPredicate(inner);
  return `${intExpr(inner)} > ${r.int(-2, 5)}`;
}

function subqueryPredicate(ctx: Ctx): string {
  const { r } = ctx;
  const t = r.pick(TABLES);
  const alias = `s${ctx.depth}`;
  const inner: Ctx = {
    r,
    ints: [...t.intCols.map((c) => `${alias}.${c}`), ...ctx.ints],
    texts: [...t.textCols.map((c) => `${alias}.${c}`), ...ctx.texts],
    depth: ctx.depth + 1,
  };
  const correlated = r.chance(0.5) && ctx.ints.length ? ` AND ${alias}.${t.intCols[0]} = ${r.pick(ctx.ints)}` : "";
  const local: Ctx = { ...inner, ints: t.intCols.map((c) => `${alias}.${c}`), texts: t.textCols.map((c) => `${alias}.${c}`) };
  switch (r.int(0, 2)) {
    case 0:
      return `${r.chance(0.3) ? "NOT " : ""}EXISTS (SELECT 1 FROM ${t.name} ${alias} WHERE ${predicate(local)}${correlated})`;
    case 1:
      return `${intExpr(ctx)} ${r.chance(0.3) ? "NOT " : ""}IN (SELECT ${alias}.${r.pick(t.intCols)} FROM ${t.name} ${alias} WHERE ${predicate(local)}${correlated})`;
    default:
      return `${intExpr(ctx)} ${r.pick(["=", "<", ">="])} (SELECT ${r.pick(["MAX", "MIN", "COUNT", "SUM"])}(${alias}.${r.pick(t.intCols)}) FROM ${t.name} ${alias} WHERE ${predicate(local)}${correlated})`;
  }
}

/** A simple query over `t` exposing the same column names, used as a derived table / CTE. */
function randomCoreForDerived(r: Random, t: TableSpec): string {
  const cols = columnsOf(t, "d");
  const ctx: Ctx = { r, ints: cols.ints, texts: cols.texts, depth: 1 };
  const select = [...t.intCols.map((c) => `d.${c} AS ${c}`), ...t.textCols.map((c) => `d.${c} AS ${c}`)];
  if (r.chance(0.3)) {
    // Aggregate derived table: keep the column names, aggregate the rest.
    const [g, ...rest] = t.intCols;
    const aggs = [`d.${g} AS ${g}`, ...rest.map((c) => `${r.pick(["SUM", "MIN", "MAX", "COUNT"])}(d.${c}) AS ${c}`), ...t.textCols.map((c) => `MAX(d.${c}) AS ${c}`)];
    return `SELECT ${aggs.join(", ")} FROM ${t.name} d GROUP BY d.${g}`;
  }
  return `SELECT ${r.chance(0.2) ? "DISTINCT " : ""}${select.join(", ")} FROM ${t.name} d${r.chance(0.6) ? ` WHERE ${predicate(ctx)}` : ""}`;
}

function columnsOf(t: TableSpec, alias: string): { ints: string[]; texts: string[] } {
  return { ints: t.intCols.map((c) => `${alias}.${c}`), texts: t.textCols.map((c) => `${alias}.${c}`) };
}

function randomQuery(r: Random): string {
  const t1 = r.pick(TABLES);
  const from: string[] = [`${t1.name} x`];
  let prefix = "";
  let { ints, texts } = columnsOf(t1, "x");

  if (r.chance(0.15)) {
    // Derived table or CTE in place of the first table.
    const inner = randomCoreForDerived(r, t1);
    if (r.chance(0.5)) {
      prefix = `WITH w AS (${inner}) `;
      from[0] = "w x";
    } else {
      from[0] = `(${inner}) x`;
    }
  }

  const joins = r.chance(0.5) ? (r.chance(0.25) ? 2 : 1) : 0;
  for (let j = 0; j < joins; j++) {
    const t2 = r.pick(TABLES);
    const alias = j === 0 ? "y" : "q";
    const cols = columnsOf(t2, alias);
    const joinType = r.pick(["JOIN", "LEFT JOIN", "LEFT JOIN", "CROSS JOIN", "RIGHT JOIN", "FULL JOIN"]);
    let on = "";
    if (joinType !== "CROSS JOIN") {
      on = ` ON ${r.pick(ints)} = ${r.pick(cols.ints)}`;
      if (r.chance(0.4)) on += ` AND ${predicate({ r, ints: [...ints, ...cols.ints], texts: [...texts, ...cols.texts], depth: 1 })}`;
    }
    from.push(`${joinType} ${t2.name} ${alias}${on}`);
    ints = [...ints, ...cols.ints];
    texts = [...texts, ...cols.texts];
  }

  const ctx: Ctx = { r, ints, texts, depth: 0 };
  const where = r.chance(0.75) ? ` WHERE ${predicate(ctx)}` : "";

  if (r.chance(0.3)) {
    // Aggregate query.
    const groupCols = r.chance(0.7) ? [r.pick([...ints, ...texts])] : [];
    const aggs = Array.from({ length: r.int(1, 3) }, () => {
      const fn = r.pick(["COUNT", "SUM", "MIN", "MAX", "COUNT(DISTINCT", "TOTAL"]);
      if (fn === "COUNT" && r.chance(0.4)) return "COUNT(*)";
      if (fn === "COUNT(DISTINCT") return `COUNT(DISTINCT ${r.pick(ints)})`;
      return `${fn}(${intExpr({ ...ctx, depth: 1 })})`;
    });
    const having = groupCols.length && r.chance(0.3) ? ` HAVING COUNT(*) ${r.pick([">", ">=", "<"])} ${r.int(0, 3)}` : "";
    const groupBy = groupCols.length ? ` GROUP BY ${groupCols.join(", ")}` : "";
    return `${prefix}SELECT ${aliased([...groupCols, ...aggs])} FROM ${from.join(" ")}${where}${groupBy}${having}`;
  }

  const selectCount = r.int(1, 3);
  const items = Array.from({ length: selectCount }, (): { sql: string; text: boolean } => {
    if (r.chance(0.08)) {
      // Correlated scalar subquery in the select list.
      const t = r.pick(TABLES);
      const [agg, text] = r.pick([
        ["COUNT(*)", false],
        [`MAX(s.${t.intCols[1]})`, false],
        [`MIN(s.${t.textCols[0]})`, true],
      ] as const);
      return { sql: `(SELECT ${agg} FROM ${t.name} s WHERE s.${t.intCols[0]} = ${r.pick(ints)})`, text };
    }
    return r.chance(0.7) ? { sql: intExpr(ctx), text: false } : { sql: textExpr(ctx), text: true };
  });
  const select = items.map((i) => i.sql);
  const distinct = r.chance(0.2) ? "DISTINCT " : "";
  let sql = `${prefix}SELECT ${distinct}${aliased(select)} FROM ${from.join(" ")}${where}`;

  if (r.chance(0.15)) {
    const t3 = r.pick(TABLES);
    const c3 = columnsOf(t3, "z");
    const other = items.map((item) => (item.text ? r.pick(c3.texts) : r.pick(c3.ints)));
    sql += ` ${r.pick(["UNION", "UNION ALL", "INTERSECT", "EXCEPT"])} SELECT ${other.join(", ")} FROM ${t3.name} z`;
  } else if (r.chance(0.3)) {
    const positions = Array.from({ length: selectCount }, (_, i) => `${i + 1}${r.chance(0.5) ? " DESC" : ""}`);
    sql += ` ORDER BY ${positions.join(", ")} LIMIT ${r.int(0, 10)}${r.chance(0.3) ? ` OFFSET ${r.int(0, 3)}` : ""}`;
  }
  return sql;
}

/** Gives every result column a unique name (SQLite returns rows as objects). */
function aliased(exprs: string[]): string {
  return exprs.map((e, i) => `${e} AS r${i}`).join(", ");
}

/** Window function queries, ordered with unique tiebreakers so results are deterministic. */
function randomWindowQuery(r: Random): string {
  const t = r.pick(TABLES);
  let from = `${t.name} x`;
  let { ints, texts } = columnsOf(t, "x");
  let ids = ["x.id"];
  if (r.chance(0.3)) {
    const t2 = r.pick(TABLES);
    const cols = columnsOf(t2, "y");
    from += ` ${r.pick(["JOIN", "LEFT JOIN"])} ${t2.name} y ON ${r.pick(ints)} = ${r.pick(cols.ints)}`;
    ints = [...ints, ...cols.ints];
    texts = [...texts, ...cols.texts];
    ids = ["x.id", "y.id"];
  }
  const ctx: Ctx = { r, ints, texts, depth: 1 };
  const where = r.chance(0.5) ? ` WHERE ${predicate(ctx)}` : "";

  if (r.chance(0.2)) {
    // Windows over grouped rows: order by aggregates, which are deterministic.
    const g = r.pick(ints);
    const agg = `${r.pick(["SUM", "COUNT", "MAX"])}(${r.pick(ints)})`;
    const fn = r.pick(["RANK()", "DENSE_RANK()", "CUME_DIST()", `SUM(${agg})`, "COUNT(*)"]);
    return `SELECT ${aliased([g, agg, `${fn} OVER (ORDER BY ${agg}${r.chance(0.5) ? " DESC" : ""})`])} FROM ${from}${where} GROUP BY ${g}`;
  }

  const partition = r.chance(0.6) ? `PARTITION BY ${r.pick([...ints, ...texts])} ` : "";
  const key = r.pick([...ints, ...texts]);
  const dir = r.chance(0.4) ? " DESC" : "";
  const nulls = r.chance(0.2) ? r.pick([" NULLS FIRST", " NULLS LAST"]) : "";
  const peerOrder = `ORDER BY ${key}${dir}${nulls}`;
  const totalOrder = `${peerOrder}, ${ids.join(", ")}`;
  const value = intExpr({ ...ctx, depth: 2 });

  const windows = Array.from({ length: r.int(1, 3) }, () => {
    switch (r.int(0, 7)) {
      case 0:
        return `ROW_NUMBER() OVER (${partition}${totalOrder})`;
      case 1:
        return `${r.pick(["RANK", "DENSE_RANK", "PERCENT_RANK", "CUME_DIST"])}() OVER (${partition}${peerOrder})`;
      case 2: {
        const fn = r.pick(["LAG", "LEAD"]);
        const args = r.chance(0.5) ? `${value}, ${r.int(1, 3)}${r.chance(0.5) ? `, ${r.int(-9, 9)}` : ""}` : value;
        return `${fn}(${args}) OVER (${partition}${totalOrder})`;
      }
      case 3: {
        const fn = r.pick(["FIRST_VALUE", "LAST_VALUE", `NTH_VALUE`]);
        const args = fn === "NTH_VALUE" ? `${value}, ${r.int(1, 3)}` : value;
        const frame = r.chance(0.5) ? " ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING" : "";
        return `${fn}(${args}) OVER (${partition}${totalOrder}${frame})`;
      }
      case 4:
        return `NTILE(${r.int(1, 4)}) OVER (${partition}${totalOrder})`;
      case 5: {
        // Aggregates with the default (peer-inclusive) frame or no ordering at all.
        const fn = r.pick(["SUM", "COUNT", "MIN", "MAX", "TOTAL", "AVG"]);
        return `${fn}(${value}) OVER (${partition}${r.chance(0.6) ? peerOrder : ""})`;
      }
      case 6: {
        const bound = (): string => r.pick(["UNBOUNDED PRECEDING", "CURRENT ROW", "UNBOUNDED FOLLOWING", `${r.int(0, 2)} PRECEDING`, `${r.int(0, 2)} FOLLOWING`]);
        let start = bound();
        let end = bound();
        // Keep frames syntactically valid and with start <= end.
        const rank = (b: string): number =>
          b === "UNBOUNDED PRECEDING" ? -100 : b === "UNBOUNDED FOLLOWING" ? 100 : b === "CURRENT ROW" ? 0 : b.endsWith("PRECEDING") ? -Number(b.split(" ")[0]) : Number(b.split(" ")[0]);
        if (rank(start) > rank(end)) [start, end] = [end, start];
        if (start === "UNBOUNDED FOLLOWING") start = "CURRENT ROW";
        if (end === "UNBOUNDED PRECEDING") end = "CURRENT ROW";
        const fn = r.pick(["SUM", "COUNT", "MIN", "MAX", "TOTAL"]);
        return `${fn}(${value}) OVER (${partition}${totalOrder} ROWS BETWEEN ${start} AND ${end})`;
      }
      default: {
        // RANGE with numeric offsets needs a single numeric ORDER BY key.
        const numKey = r.pick(ints);
        const fn = r.pick(["SUM", "COUNT", "MAX"]);
        return `${fn}(${value}) OVER (${partition}ORDER BY ${numKey}${dir} RANGE BETWEEN ${r.int(0, 2)} PRECEDING AND ${r.chance(0.5) ? "CURRENT ROW" : `${r.int(0, 2)} FOLLOWING`})`;
      }
    }
  });
  if (r.chance(0.25)) {
    // Move the shared partition/order into a named window.
    const spec = `${partition}${totalOrder}`;
    const named = windows.map((w) => w.replace(`OVER (${spec})`, "OVER w"));
    return `SELECT ${aliased([r.pick(ints), ...named])} FROM ${from}${where} WINDOW w AS (${spec})`;
  }
  return `SELECT ${aliased([r.pick(ints), ...windows])} FROM ${from}${where}`;
}

function normalize(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return Number(v.toPrecision(10));
  return v;
}

function canonical(rows: unknown[][], ordered: boolean): string[] {
  const keys = rows.map((r) => JSON.stringify(r.map(normalize)));
  return ordered ? keys : keys.sort();
}

describe.skipIf(!DatabaseSync)("differential testing against SQLite", () => {
  for (const seed of seeds(1000, [1, 2, 3, 4, 5, 6, 7, 8])) {
    it(`agrees with SQLite on random queries (seed ${seed})`, () => {
      const dataRandom = new Random(seed);
      const setupWithIndexes = setupSql(dataRandom, true);
      const setupPlain = setupSql(new Random(seed), false);

      const sqlite = new DatabaseSync!(":memory:");
      sqlite.exec(setupPlain);
      const indexed = new Database();
      indexed.exec(setupWithIndexes);
      const plain = new Database();
      plain.exec(setupPlain);

      const r = new Random(seed * 1000 + 17);
      let compared = 0;
      for (let i = 0; i < 300; i++) {
        const sql = i % 5 === 4 ? randomWindowQuery(r) : randomQuery(r);
        let expected: unknown[][];
        try {
          const result = sqlite.prepare(sql).all();
          expected = result.map((row) => Object.values(row));
        } catch {
          // The generator occasionally produces queries SQLite rejects; skip them.
          continue;
        }
        // Only an outer ORDER BY (always paired with LIMIT here) fixes the row order;
        // ORDER BY inside OVER (...) does not.
        const ordered = /\bLIMIT\b/.test(sql);
        const exp = canonical(expected, ordered);
        for (const [label, db] of [
          ["indexed", indexed],
          ["plain", plain],
        ] as const) {
          let actual: unknown[][];
          try {
            actual = db.exec(sql)[0]!.rows;
          } catch (e) {
            throw new Error(`minisql (${label}) failed on: ${sql}\n${(e as Error).message}`);
          }
          expect(canonical(actual, ordered), `${label}: ${sql}`).toEqual(exp);
        }
        compared++;
      }
      expect(compared).toBeGreaterThan(250);
    });
  }
});

function randomDml(r: Random): string {
  const t = r.pick(TABLES);
  const cols = columnsOf(t, t.name);
  const ctx: Ctx = { r, ints: cols.ints, texts: cols.texts, depth: 1 };
  // Subqueries in DML only read *other* tables, where both engines agree on visibility.
  const others = TABLES.filter((o) => o !== t);
  const where = (): string => {
    if (r.chance(0.2)) {
      const o = r.pick(others);
      return ` WHERE ${r.pick(cols.ints)} IN (SELECT ${o.intCols[0]} FROM ${o.name} WHERE ${o.intCols[1]} > ${r.int(-2, 5)})`;
    }
    return r.chance(0.85) ? ` WHERE ${predicate(ctx).replace(/EXISTS \(SELECT 1 FROM t\d s\d+[^)]*\)/g, "1 = 1")}` : "";
  };
  const returning = (): string => {
    if (!r.chance(0.3)) return "";
    const items = r.chance(0.3) ? ["*"] : Array.from({ length: r.int(1, 2) }, () => (r.chance(0.6) ? intExpr(ctx) : textExpr(ctx)));
    return ` RETURNING ${items.map((e, i) => (e === "*" ? e : `${e} AS r${i}`)).join(", ")}`;
  };
  switch (r.int(0, 5)) {
    case 5: {
      // INSERT OR IGNORE / OR REPLACE / REPLACE INTO with ids likely to collide.
      const verb = r.pick(["INSERT OR IGNORE", "INSERT OR REPLACE", "REPLACE"]);
      const rowsSql = Array.from({ length: r.int(1, 3) }, () => {
        const values = [
          String(r.int(1, 25)),
          ...t.intCols.map(() => (r.chance(0.15) ? "NULL" : String(r.int(-3, 8)))),
          ...t.textCols.map(() => (r.chance(0.15) ? "NULL" : `'${r.pick(WORDS)}'`)),
        ];
        return `(${values.join(", ")})`;
      });
      return `${verb} INTO ${t.name} VALUES ${rowsSql.join(", ")}${returning()}`;
    }
    case 4: {
      // Upsert against the primary key with ids likely to collide.
      const values = [
        String(r.int(1, 25)),
        ...t.intCols.map(() => (r.chance(0.15) ? "NULL" : String(r.int(-3, 8)))),
        ...t.textCols.map(() => (r.chance(0.15) ? "NULL" : `'${r.pick(WORDS)}'`)),
      ];
      let action = "DO NOTHING";
      if (r.chance(0.7)) {
        const col = r.pick(t.intCols);
        const value = r.pick([`excluded.${col}`, `${t.name}.${col} + 1`, `COALESCE(${t.name}.${col}, 0) + COALESCE(excluded.${col}, 0)`, String(r.int(-3, 8))]);
        action = `DO UPDATE SET ${col} = ${value}${r.chance(0.3) ? ` WHERE ${t.name}.${t.intCols[0]} IS NOT NULL` : ""}`;
      }
      return `INSERT INTO ${t.name} VALUES (${values.join(", ")}) ON CONFLICT${action === "DO NOTHING" && r.chance(0.5) ? "" : " (id)"} ${action}${returning()}`;
    }
    case 0: {
      const n = r.int(1, 3);
      const rowsSql = Array.from({ length: n }, () => {
        const values = [
          r.chance(0.8) ? "NULL" : String(r.int(100, 120)),
          ...t.intCols.map(() => (r.chance(0.15) ? "NULL" : String(r.int(-3, 8)))),
          ...t.textCols.map(() => (r.chance(0.15) ? "NULL" : `'${r.pick(WORDS)}'`)),
        ];
        return `(${values.join(", ")})`;
      });
      return `INSERT INTO ${t.name} VALUES ${rowsSql.join(", ")}${returning()}`;
    }
    case 1: {
      const o = r.pick(others);
      // ORDER BY pins the order in which new primary keys are handed out.
      return `INSERT INTO ${t.name} SELECT NULL, ${[...o.intCols, ...o.textCols].join(", ")} FROM ${o.name}${r.chance(0.7) ? ` WHERE ${o.intCols[0]} = ${r.int(-2, 6)}` : ""} ORDER BY id`;
    }
    case 2: {
      const col = r.pick([...t.intCols, ...t.textCols]);
      const isText = t.textCols.includes(col);
      const value = isText ? textExpr({ ...ctx, ints: cols.ints, texts: cols.texts }) : intExpr(ctx);
      return `UPDATE ${t.name} SET ${col} = ${value}${where()}${returning()}`;
    }
    default:
      return `DELETE FROM ${t.name}${where()}${returning()}`;
  }
}

function tableContents(run: (sql: string) => unknown[][]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) out[t.name] = canonical(run(`SELECT * FROM ${t.name}`), false);
  return out;
}

describe.skipIf(!DatabaseSync)("differential DML testing against SQLite", () => {
  for (const seed of seeds(50_000, [11, 12, 13, 14, 15, 16])) {
    it(`applies random INSERT / UPDATE / DELETE identically (seed ${seed})`, () => {
      const sqlite = new DatabaseSync!(":memory:");
      sqlite.exec(setupSql(new Random(seed), false));
      const indexed = new Database();
      indexed.exec(setupSql(new Random(seed), true));

      const r = new Random(seed * 31 + 5);
      for (let i = 0; i < 150; i++) {
        const sql = randomDml(r);
        let expectedReturned: unknown[][];
        try {
          expectedReturned = sqlite.prepare(sql).all().map((row) => Object.values(row));
        } catch {
          continue;
        }
        let actualReturned: unknown[][];
        try {
          actualReturned = indexed.exec(sql)[0]!.rows;
        } catch (e) {
          throw new Error(`minisql failed on: ${sql}\n${(e as Error).message}`);
        }
        expect(canonical(actualReturned, false), `RETURNING of: ${sql}`).toEqual(canonical(expectedReturned, false));
        if (i % 10 === 9) {
          const expected = tableContents((q) => sqlite.prepare(q).all().map((row) => Object.values(row)));
          const actual = tableContents((q) => indexed.exec(q)[0]!.rows);
          expect(actual, `after: ${sql}`).toEqual(expected);
          // Index-assisted lookups must agree with the table contents.
          const probe = sqlite.prepare("SELECT a, COUNT(*) AS n FROM t1 GROUP BY a").all();
          for (const row of probe) {
            if (row.a === null) continue;
            expect(indexed.exec(`SELECT COUNT(*) FROM t1 WHERE a = ${row.a}`)[0]!.rows[0]![0]).toBe(Number(row.n));
          }
        }
      }
    });
  }
});
