import { describe, expect, it } from "vitest";
import { parse, parseExpression, SqlSyntaxError } from "../src/index.js";
import type { Expr, SelectStatement } from "../src/index.js";

function select(sql: string): SelectStatement {
  const [stmt] = parse(sql);
  if (stmt?.type !== "select") throw new Error("expected select");
  return stmt;
}

describe("expression parsing", () => {
  it("respects operator precedence", () => {
    const e = parseExpression("1 + 2 * 3");
    expect(e).toMatchObject({
      kind: "binary",
      op: "+",
      left: { kind: "literal", value: 1 },
      right: { kind: "binary", op: "*" },
    });
  });

  it("binds AND tighter than OR and NOT tighter than AND", () => {
    const e = parseExpression("NOT a OR b AND c");
    expect(e).toMatchObject({
      kind: "binary",
      op: "OR",
      left: { kind: "unary", op: "NOT" },
      right: { kind: "binary", op: "AND" },
    });
  });

  it("folds negative numeric literals", () => {
    expect(parseExpression("-5")).toEqual({ kind: "literal", value: -5 });
  });

  it("parses IN, BETWEEN, LIKE and their negations", () => {
    expect(parseExpression("x NOT IN (1, 2)")).toMatchObject({ kind: "inList", negated: true });
    expect(parseExpression("x BETWEEN 1 AND 10")).toMatchObject({ kind: "between", negated: false });
    expect(parseExpression("x NOT LIKE 'a%'")).toMatchObject({ kind: "like", negated: true });
  });

  it("parses BETWEEN inside a larger AND chain", () => {
    const e = parseExpression("a BETWEEN 1 AND 2 AND b = 3");
    expect(e).toMatchObject({ kind: "binary", op: "AND", left: { kind: "between" }, right: { kind: "binary", op: "=" } });
  });

  it("parses IS NULL / IS NOT NULL", () => {
    expect(parseExpression("x IS NOT NULL")).toEqual({ kind: "isNull", operand: { kind: "column", name: "x" }, negated: true });
  });

  it("parses both CASE forms", () => {
    expect(parseExpression("CASE WHEN a THEN 1 ELSE 2 END")).toMatchObject({ kind: "case", operand: undefined });
    expect(parseExpression("CASE a WHEN 1 THEN 'one' END")).toMatchObject({ kind: "case", operand: { kind: "column" } });
  });

  it("parses function calls, COUNT(*) and DISTINCT aggregates", () => {
    expect(parseExpression("count(*)")).toMatchObject({ kind: "function", name: "COUNT", star: true });
    expect(parseExpression("SUM(DISTINCT x)")).toMatchObject({ kind: "function", name: "SUM", distinct: true });
    expect(parseExpression("coalesce(a, b, 0)")).toMatchObject({ kind: "function", name: "COALESCE" });
  });

  it("parses CAST", () => {
    expect(parseExpression("CAST(x AS VARCHAR(20))")).toMatchObject({ kind: "cast", type: "TEXT" });
  });

  it("parses qualified column references", () => {
    expect(parseExpression("t.col")).toEqual({ kind: "column", table: "t", name: "col" });
  });

  it("numbers positional parameters", () => {
    const e = parseExpression("? + ?") as Extract<Expr, { kind: "binary" }>;
    expect(e.left).toEqual({ kind: "param", key: 0 });
    expect(e.right).toEqual({ kind: "param", key: 1 });
  });

  it("allows soft keywords as identifiers", () => {
    expect(parseExpression("key + first")).toMatchObject({
      left: { kind: "column", name: "key" },
      right: { kind: "column", name: "first" },
    });
  });
});

describe("statement parsing", () => {
  it("parses a full SELECT", () => {
    const s = select(`
      SELECT DISTINCT d.name AS dept, COUNT(*) n
      FROM employees e
      JOIN departments d ON d.id = e.dept_id
      WHERE e.salary > 100
      GROUP BY d.name
      HAVING COUNT(*) > 1
      ORDER BY n DESC NULLS LAST, 1
      LIMIT 10 OFFSET 5`);
    expect(s.core.distinct).toBe(true);
    expect(s.core.columns.map((c) => c.alias)).toEqual(["dept", "n"]);
    expect(s.core.from).toMatchObject({ kind: "join", joinType: "INNER" });
    expect(s.core.groupBy).toHaveLength(1);
    expect(s.core.having).toBeDefined();
    expect(s.orderBy).toMatchObject([
      { direction: "DESC", nulls: "LAST" },
      { direction: "ASC", expr: { kind: "literal", value: 1 } },
    ]);
    expect(s.limit).toEqual({ kind: "literal", value: 10 });
    expect(s.offset).toEqual({ kind: "literal", value: 5 });
  });

  it("records the source text of select items", () => {
    expect(select("SELECT a+1, upper( b ) FROM t").core.columns.map((c) => c.text)).toEqual(["a+1", "upper( b )"]);
  });

  it("parses all join types", () => {
    for (const [sql, type] of [
      ["a LEFT JOIN b ON 1", "LEFT"],
      ["a LEFT OUTER JOIN b ON 1", "LEFT"],
      ["a RIGHT JOIN b ON 1", "RIGHT"],
      ["a FULL OUTER JOIN b ON 1", "FULL"],
      ["a CROSS JOIN b", "CROSS"],
      ["a, b", "CROSS"],
      ["a INNER JOIN b ON 1", "INNER"],
    ] as const) {
      expect(select(`SELECT * FROM ${sql}`).core.from).toMatchObject({ kind: "join", joinType: type });
    }
  });

  it("desugars JOIN ... USING", () => {
    const from = select("SELECT * FROM a JOIN b USING (id)").core.from;
    expect(from).toMatchObject({
      on: { kind: "binary", op: "=", left: { table: "a", name: "id" }, right: { table: "b", name: "id" } },
    });
  });

  it("parses compound queries", () => {
    const s = select("SELECT 1 UNION SELECT 2 UNION ALL SELECT 3 EXCEPT SELECT 4 INTERSECT SELECT 5");
    expect(s.compounds.map((c) => c.op)).toEqual(["UNION", "UNION ALL", "EXCEPT", "INTERSECT"]);
  });

  it("parses WITH and WITH RECURSIVE", () => {
    const s = select("WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t");
    expect(s.recursive).toBe(true);
    expect(s.with[0]).toMatchObject({ name: "t", columns: ["n"] });
  });

  it("parses CREATE TABLE with constraints", () => {
    const [stmt] = parse(`
      CREATE TABLE IF NOT EXISTS t (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email VARCHAR(255) NOT NULL UNIQUE,
        age INT DEFAULT 18 CHECK (age >= 0),
        team_id INTEGER REFERENCES teams(id),
        UNIQUE (email, age)
      )`);
    expect(stmt).toMatchObject({
      type: "createTable",
      ifNotExists: true,
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true, autoIncrement: true, notNull: true },
        { name: "email", type: "TEXT", notNull: true, unique: true },
        { name: "age", type: "INTEGER", defaultValue: { kind: "literal", value: 18 } },
        { name: "team_id", references: { table: "teams", column: "id" } },
      ],
      constraints: [{ kind: "unique", columns: ["email", "age"] }],
    });
  });

  it("parses INSERT forms", () => {
    expect(parse("INSERT INTO t VALUES (1, 'a'), (2, 'b')")[0]).toMatchObject({ type: "insert", values: [[{}, {}], [{}, {}]] });
    expect(parse("INSERT INTO t (a) SELECT x FROM y")[0]).toMatchObject({ type: "insert", columns: ["a"], select: {} });
    expect(parse("INSERT INTO t DEFAULT VALUES")[0]).toMatchObject({ type: "insert", values: [[]] });
  });

  it("parses UPDATE and DELETE", () => {
    expect(parse("UPDATE t SET a = 1, b = b + 1 WHERE id = 3")[0]).toMatchObject({
      type: "update",
      assignments: [{ column: "a" }, { column: "b" }],
      where: { kind: "binary" },
    });
    expect(parse("DELETE FROM t WHERE x IS NULL")[0]).toMatchObject({ type: "delete", where: { kind: "isNull" } });
  });

  it("parses ALTER TABLE variants", () => {
    expect(parse("ALTER TABLE t ADD COLUMN c TEXT")[0]).toMatchObject({ action: { kind: "addColumn" } });
    expect(parse("ALTER TABLE t DROP COLUMN c")[0]).toMatchObject({ action: { kind: "dropColumn", name: "c" } });
    expect(parse("ALTER TABLE t RENAME COLUMN a TO b")[0]).toMatchObject({ action: { kind: "renameColumn", from: "a", to: "b" } });
    expect(parse("ALTER TABLE t RENAME TO u")[0]).toMatchObject({ action: { kind: "renameTable", to: "u" } });
  });

  it("parses scripts with several statements and stray semicolons", () => {
    expect(parse(";;BEGIN; SELECT 1;; COMMIT;").map((s) => s.type)).toEqual(["begin", "select", "commit"]);
  });

  it("reports syntax errors with positions", () => {
    expect(() => parse("SELECT FROM")).toThrow(SqlSyntaxError);
    expect(() => parse("SELECT 1 +")).toThrow(/end of input/);
    expect(() => parse("SELEC 1")).toThrow(/line 1, column 1/);
    expect(() => parse("SELECT * FROM t WHERE")).toThrow(/Unexpected end of input/);
    expect(() => parse("CREATE TABLE t (a FOO)")).toThrow(/Unknown column type 'FOO'/);
  });

  it("requires an alias for derived tables", () => {
    expect(() => parse("SELECT * FROM (SELECT 1)")).toThrow(/must have an alias/);
  });
});
