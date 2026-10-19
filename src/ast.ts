import type { SqlValue } from "./values.js";

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | LiteralExpr
  | ColumnRefExpr
  | ParamExpr
  | UnaryExpr
  | BinaryExpr
  | IsNullExpr
  | BetweenExpr
  | InListExpr
  | InSubqueryExpr
  | ExistsExpr
  | LikeExpr
  | CaseExpr
  | CastExpr
  | FunctionCallExpr
  | SubqueryExpr
  | StarExpr;

export interface LiteralExpr {
  kind: "literal";
  value: SqlValue;
}

export interface ColumnRefExpr {
  kind: "column";
  table?: string;
  name: string;
}

export interface ParamExpr {
  kind: "param";
  /** Zero-based positional index for `?`, or the name for `:name` / `$name` / `@name`. */
  key: number | string;
}

export interface UnaryExpr {
  kind: "unary";
  op: "-" | "+" | "NOT";
  operand: Expr;
}

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "||"
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "AND"
  | "OR";

export interface BinaryExpr {
  kind: "binary";
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface IsNullExpr {
  kind: "isNull";
  operand: Expr;
  negated: boolean;
}

export interface BetweenExpr {
  kind: "between";
  operand: Expr;
  low: Expr;
  high: Expr;
  negated: boolean;
}

export interface InListExpr {
  kind: "inList";
  operand: Expr;
  list: Expr[];
  negated: boolean;
}

export interface InSubqueryExpr {
  kind: "inSubquery";
  operand: Expr;
  query: SelectStatement;
  negated: boolean;
}

export interface ExistsExpr {
  kind: "exists";
  query: SelectStatement;
  negated: boolean;
}

export interface LikeExpr {
  kind: "like";
  /** LIKE is case-insensitive with `%` / `_`; GLOB is case-sensitive with `*` / `?` / `[...]`. */
  op: "LIKE" | "GLOB";
  operand: Expr;
  pattern: Expr;
  escape?: Expr;
  negated: boolean;
}

export interface CaseExpr {
  kind: "case";
  /** Present for the "simple" form: `CASE x WHEN 1 THEN ...`. */
  operand?: Expr;
  branches: { when: Expr; then: Expr }[];
  elseExpr?: Expr;
}

export interface CastExpr {
  kind: "cast";
  operand: Expr;
  type: ColumnType;
}

export interface FunctionCallExpr {
  kind: "function";
  /** Upper-cased function name. */
  name: string;
  args: Expr[];
  distinct: boolean;
  /** True for `COUNT(*)`. */
  star: boolean;
  /** Present for window function calls: `f(...) OVER (...)`. */
  over?: WindowSpec;
}

/** A named window from a `WINDOW name AS (...)` clause. */
export interface NamedWindow {
  name: string;
  spec: WindowSpec;
}

export type FrameBound =
  | { kind: "unboundedPreceding" }
  | { kind: "preceding"; offset: Expr }
  | { kind: "currentRow" }
  | { kind: "following"; offset: Expr }
  | { kind: "unboundedFollowing" };

export interface WindowFrame {
  unit: "ROWS" | "RANGE";
  start: FrameBound;
  end: FrameBound;
}

export interface WindowSpec {
  /** `OVER w` or `OVER (w ORDER BY ...)`: the named window this one builds on (resolved by the parser). */
  base?: string;
  partitionBy: Expr[];
  orderBy: OrderByItem[];
  frame?: WindowFrame;
}

export interface SubqueryExpr {
  kind: "subquery";
  query: SelectStatement;
}

/** `*` or `table.*` inside a select list. Never evaluated directly. */
export interface StarExpr {
  kind: "star";
  table?: string;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type ColumnType = "INTEGER" | "REAL" | "TEXT" | "BOOLEAN" | "ANY";

export interface ColumnDef {
  name: string;
  type: ColumnType;
  notNull: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  defaultValue?: Expr;
  check?: Expr;
  references?: { table: string; column?: string };
}

export interface TableConstraint {
  kind: "primaryKey" | "unique";
  columns: string[];
}

export interface CreateTableStatement {
  type: "createTable";
  name: string;
  ifNotExists: boolean;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  /** `CREATE TABLE t AS SELECT ...` */
  asSelect?: SelectStatement;
}

export interface DropTableStatement {
  type: "dropTable";
  name: string;
  ifExists: boolean;
}

export interface CreateIndexStatement {
  type: "createIndex";
  name: string;
  table: string;
  columns: string[];
  unique: boolean;
  ifNotExists: boolean;
}

export interface DropIndexStatement {
  type: "dropIndex";
  name: string;
  ifExists: boolean;
}

export type AlterAction =
  | { kind: "addColumn"; column: ColumnDef }
  | { kind: "dropColumn"; name: string }
  | { kind: "renameColumn"; from: string; to: string }
  | { kind: "renameTable"; to: string };

export interface AlterTableStatement {
  type: "alterTable";
  table: string;
  action: AlterAction;
}

export interface Assignment {
  column: string;
  value: Expr;
}

/** `ON CONFLICT [(columns)] DO NOTHING | DO UPDATE SET ... [WHERE ...]` */
export interface OnConflict {
  target?: string[];
  action: "nothing" | "update";
  assignments: Assignment[];
  where?: Expr;
}

export interface InsertStatement {
  type: "insert";
  /** `INSERT OR IGNORE` / `INSERT OR REPLACE` (and `REPLACE INTO`). */
  orAction?: "IGNORE" | "REPLACE";
  table: string;
  columns?: string[];
  /** Either literal rows (`VALUES`) or a query (`INSERT ... SELECT`). */
  values?: Expr[][];
  select?: SelectStatement;
  onConflict?: OnConflict;
  returning?: SelectItem[];
}

export interface UpdateStatement {
  type: "update";
  table: string;
  alias?: string;
  assignments: Assignment[];
  where?: Expr;
  returning?: SelectItem[];
}

export interface DeleteStatement {
  type: "delete";
  table: string;
  alias?: string;
  where?: Expr;
  returning?: SelectItem[];
}

export interface CreateViewStatement {
  type: "createView";
  name: string;
  columns?: string[];
  query: SelectStatement;
  /** Source text of the view's query, kept for schema dumps. */
  queryText: string;
  ifNotExists: boolean;
}

export interface DropViewStatement {
  type: "dropView";
  name: string;
  ifExists: boolean;
}

export interface SelectItem {
  expr: Expr;
  alias?: string;
  /** Source text of the expression, used to name unaliased result columns. */
  text?: string;
}

export type FromItem = TableRef | SubqueryRef | JoinRef;

export interface TableRef {
  kind: "table";
  name: string;
  alias?: string;
}

export interface SubqueryRef {
  kind: "subquery";
  query: SelectStatement;
  alias: string;
}

export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";

export interface JoinRef {
  kind: "join";
  joinType: JoinType;
  left: FromItem;
  right: FromItem;
  on?: Expr;
}

export interface OrderByItem {
  expr: Expr;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

export interface SelectCore {
  distinct: boolean;
  columns: SelectItem[];
  from?: FromItem;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
}

export type CompoundOp = "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";

export interface CommonTableExpr {
  name: string;
  columns?: string[];
  query: SelectStatement;
}

export interface SelectStatement {
  type: "select";
  /** True for `WITH RECURSIVE`. */
  recursive?: boolean;
  with: CommonTableExpr[];
  core: SelectCore;
  compounds: { op: CompoundOp; core: SelectCore }[];
  orderBy: OrderByItem[];
  limit?: Expr;
  offset?: Expr;
}

export interface TransactionStatement {
  type: "begin" | "commit" | "rollback";
}

export interface ExplainStatement {
  type: "explain";
  statement: SelectStatement | UpdateStatement | DeleteStatement;
}

export interface ShowTablesStatement {
  type: "showTables";
}

export interface DescribeStatement {
  type: "describe";
  table: string;
}

export type Statement =
  | CreateTableStatement
  | DropTableStatement
  | CreateViewStatement
  | DropViewStatement
  | CreateIndexStatement
  | DropIndexStatement
  | AlterTableStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | SelectStatement
  | TransactionStatement
  | ExplainStatement
  | ShowTablesStatement
  | DescribeStatement;
