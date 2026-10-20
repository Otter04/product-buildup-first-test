import type {
  AlterAction,
  AlterTableStatement,
  BinaryOp,
  ColumnDef,
  ColumnType,
  CommonTableExpr,
  CompoundOp,
  CreateIndexStatement,
  CreateTableStatement,
  DeleteStatement,
  DropIndexStatement,
  DropTableStatement,
  Assignment,
  CreateViewStatement,
  DropViewStatement,
  Expr,
  FrameBound,
  FromItem,
  FunctionCallExpr,
  InsertStatement,
  JoinType,
  NamedWindow,
  OnConflict,
  OrderByItem,
  SelectCore,
  SelectItem,
  SelectStatement,
  Statement,
  TableConstraint,
  UpdateStatement,
  WindowSpec,
} from "./ast.js";
import { SqlSyntaxError } from "./errors.js";
import { tokenize, type Token, type TokenType } from "./lexer.js";

/**
 * Keywords that may still be used as table / column / alias names. Everything
 * else in the keyword list is reserved.
 */
const SOFT_KEYWORDS = new Set([
  "ADD",
  "ANALYZE",
  "IGNORE",
  "REPLACE",
  "WINDOW",
  "CONFLICT",
  "DO",
  "ESCAPE",
  "GLOB",
  "NOTHING",
  "RETURNING",
  "VIEW",
  "CURRENT",
  "FOLLOWING",
  "OVER",
  "PARTITION",
  "PRECEDING",
  "RANGE",
  "ROW",
  "ROWS",
  "UNBOUNDED",
  "AUTOINCREMENT",
  "COLUMN",
  "DESCRIBE",
  "FIRST",
  "IF",
  "INDEX",
  "KEY",
  "LAST",
  "NULLS",
  "RENAME",
  "SHOW",
  "TABLES",
  "TO",
  "TRANSACTION",
]);

const TYPE_ALIASES: Record<string, ColumnType> = {
  INT: "INTEGER",
  INTEGER: "INTEGER",
  BIGINT: "INTEGER",
  SMALLINT: "INTEGER",
  TINYINT: "INTEGER",
  REAL: "REAL",
  FLOAT: "REAL",
  DOUBLE: "REAL",
  DECIMAL: "REAL",
  NUMERIC: "REAL",
  NUMBER: "REAL",
  TEXT: "TEXT",
  VARCHAR: "TEXT",
  CHAR: "TEXT",
  STRING: "TEXT",
  CLOB: "TEXT",
  DATE: "TEXT",
  DATETIME: "TEXT",
  TIMESTAMP: "TEXT",
  BOOLEAN: "BOOLEAN",
  BOOL: "BOOLEAN",
  ANY: "ANY",
};

const COMPARISON_OPS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/** Recursive-descent parser producing {@link Statement} ASTs. */
export class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private paramIndex = 0;

  constructor(private readonly source: string) {
    this.tokens = tokenize(source);
  }

  /** Parses every `;`-separated statement in the source. */
  parseScript(): Statement[] {
    const statements: Statement[] = [];
    for (;;) {
      while (this.matchPunct(";"));
      if (this.peek().type === "eof") break;
      statements.push(this.parseStatement());
      if (this.peek().type !== "eof") this.expectPunct(";");
    }
    return statements;
  }

  /**
   * Parses statements one at a time, also returning the source text of each.
   * Positional parameter numbering restarts for every statement.
   */
  *statements(): Generator<{ statement: Statement; text: string }> {
    for (;;) {
      while (this.matchPunct(";"));
      if (this.peek().type === "eof") return;
      this.paramIndex = 0;
      const start = this.peek().start;
      const statement = this.parseStatement();
      const end = this.tokens[this.pos - 1]!.end;
      if (this.peek().type !== "eof") this.expectPunct(";");
      yield { statement, text: this.source.slice(start, end) };
    }
  }

  /** Parses exactly one statement (an optional trailing `;` is allowed). */
  parseSingle(): Statement {
    const stmt = this.parseStatement();
    this.matchPunct(";");
    if (this.peek().type !== "eof") this.fail(`Unexpected '${this.peek().raw}' after end of statement`);
    return stmt;
  }

  /** Parses a standalone expression (used by tests and tooling). */
  parseStandaloneExpr(): Expr {
    const expr = this.parseExpr();
    if (this.peek().type !== "eof") this.fail(`Unexpected '${this.peek().raw}' after expression`);
    return expr;
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.type !== "eof") this.pos++;
    return tok;
  }

  private fail(message: string, tok: Token = this.peek()): never {
    throw new SqlSyntaxError(message, tok.line, tok.column);
  }

  private describe(tok: Token): string {
    return tok.type === "eof" ? "end of input" : `'${tok.raw}'`;
  }

  private isKeyword(kw: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === "keyword" && tok.value === kw;
  }

  private matchKeyword(...kws: string[]): boolean {
    for (let i = 0; i < kws.length; i++) {
      if (!this.isKeyword(kws[i]!, i)) return false;
    }
    this.pos += kws.length;
    return true;
  }

  private expectKeyword(...kws: string[]): void {
    for (const kw of kws) {
      if (!this.matchKeyword(kw)) this.fail(`Expected ${kw} but found ${this.describe(this.peek())}`);
    }
  }

  private isPunct(p: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === "punct" && tok.value === p;
  }

  private matchPunct(p: string): boolean {
    if (this.isPunct(p)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectPunct(p: string): void {
    if (!this.matchPunct(p)) this.fail(`Expected '${p}' but found ${this.describe(this.peek())}`);
  }

  private isOperator(op: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === "operator" && tok.value === op;
  }

  private matchOperator(op: string): boolean {
    if (this.isOperator(op)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private isType(type: TokenType, offset = 0): boolean {
    return this.peek(offset).type === type;
  }

  /** True if the token at `offset` can be used as a name. */
  private isIdentifier(offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.type === "identifier" || (tok.type === "keyword" && SOFT_KEYWORDS.has(tok.value));
  }

  private parseIdentifier(what = "identifier"): string {
    const tok = this.peek();
    if (tok.type === "identifier") {
      this.pos++;
      return tok.value;
    }
    if (tok.type === "keyword" && SOFT_KEYWORDS.has(tok.value)) {
      this.pos++;
      return tok.raw;
    }
    return this.fail(`Expected ${what} but found ${this.describe(tok)}`);
  }

  private parseIdentifierList(): string[] {
    this.expectPunct("(");
    const names = [this.parseIdentifier("column name")];
    while (this.matchPunct(",")) names.push(this.parseIdentifier("column name"));
    this.expectPunct(")");
    return names;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private parseStatement(): Statement {
    const tok = this.peek();
    if (tok.type === "keyword" || tok.type === "identifier") {
      switch (tok.value) {
        case "SELECT":
        case "WITH":
          return this.parseSelect();
        case "INSERT":
          return this.parseInsert();
        case "REPLACE":
          if (this.isKeyword("INTO", 1)) return this.parseInsert();
          break;
        case "UPDATE":
          return this.parseUpdate();
        case "DELETE":
          return this.parseDelete();
        case "CREATE":
          return this.parseCreate();
        case "DROP":
          return this.parseDrop();
        case "ALTER":
          return this.parseAlter();
        case "BEGIN":
          this.next();
          this.matchKeyword("TRANSACTION");
          return { type: "begin" };
        case "COMMIT":
          this.next();
          this.matchKeyword("TRANSACTION");
          return { type: "commit" };
        case "ROLLBACK":
          this.next();
          this.matchKeyword("TRANSACTION");
          return { type: "rollback" };
        case "EXPLAIN": {
          this.next();
          const analyze = this.matchKeyword("ANALYZE");
          const inner = this.parseStatement();
          if (inner.type !== "select" && inner.type !== "update" && inner.type !== "delete") {
            this.fail("EXPLAIN supports SELECT, UPDATE and DELETE statements", tok);
          }
          if (analyze && inner.type !== "select") this.fail("EXPLAIN ANALYZE supports SELECT statements only", tok);
          return { type: "explain", statement: inner, analyze };
        }
        case "SHOW":
          this.next();
          this.expectKeyword("TABLES");
          return { type: "showTables" };
        case "DESCRIBE":
          this.next();
          this.matchKeyword("TABLE");
          return { type: "describe", table: this.parseIdentifier("table name") };
      }
    }
    if (this.isPunct("(")) return this.parseSelect();
    return this.fail(`Unexpected ${this.describe(tok)} at start of statement`);
  }

  private parseCreate(): Statement {
    this.expectKeyword("CREATE");
    if (this.matchKeyword("TABLE")) return this.parseCreateTable();
    if (this.matchKeyword("VIEW")) return this.parseCreateView();
    const unique = this.matchKeyword("UNIQUE");
    if (this.matchKeyword("INDEX")) return this.parseCreateIndex(unique);
    return this.fail(`Expected TABLE, VIEW or INDEX after CREATE`);
  }

  private parseCreateView(): CreateViewStatement {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseIdentifier("view name");
    const columns = this.isPunct("(") ? this.parseIdentifierList() : undefined;
    this.expectKeyword("AS");
    const start = this.peek().start;
    const query = this.parseSelect();
    const queryText = this.source.slice(start, this.tokens[this.pos - 1]!.end);
    return { type: "createView", name, columns, query, queryText, ifNotExists };
  }

  private parseIfNotExists(): boolean {
    if (this.isKeyword("IF")) {
      this.expectKeyword("IF", "NOT", "EXISTS");
      return true;
    }
    return false;
  }

  private parseIfExists(): boolean {
    if (this.isKeyword("IF")) {
      this.expectKeyword("IF", "EXISTS");
      return true;
    }
    return false;
  }

  private parseCreateTable(): CreateTableStatement {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseIdentifier("table name");
    if (this.matchKeyword("AS")) {
      return { type: "createTable", name, ifNotExists, columns: [], constraints: [], asSelect: this.parseSelect() };
    }
    this.expectPunct("(");
    const columns: ColumnDef[] = [];
    const constraints: TableConstraint[] = [];
    do {
      if (this.isKeyword("PRIMARY")) {
        this.expectKeyword("PRIMARY", "KEY");
        constraints.push({ kind: "primaryKey", columns: this.parseIdentifierList() });
      } else if (this.isKeyword("UNIQUE") && this.isPunct("(", 1)) {
        this.next();
        constraints.push({ kind: "unique", columns: this.parseIdentifierList() });
      } else {
        columns.push(this.parseColumnDef());
      }
    } while (this.matchPunct(","));
    this.expectPunct(")");
    if (columns.length === 0) this.fail("A table needs at least one column");
    return { type: "createTable", name, ifNotExists, columns, constraints };
  }

  private parseColumnType(): ColumnType {
    const tok = this.peek();
    if (tok.type !== "identifier" && tok.type !== "keyword") this.fail(`Expected column type`);
    const mapped = TYPE_ALIASES[tok.value.toUpperCase()];
    if (!mapped) this.fail(`Unknown column type '${tok.raw}'`);
    this.next();
    // Swallow size / precision arguments: VARCHAR(255), DECIMAL(10, 2).
    if (this.matchPunct("(")) {
      do {
        if (!this.isType("number")) this.fail("Expected number in type arguments");
        this.next();
      } while (this.matchPunct(","));
      this.expectPunct(")");
    }
    return mapped;
  }

  private parseColumnDef(): ColumnDef {
    const name = this.parseIdentifier("column name");
    const col: ColumnDef = {
      name,
      type: "ANY",
      notNull: false,
      primaryKey: false,
      unique: false,
      autoIncrement: false,
    };
    if (this.isType("identifier") || (this.isType("keyword") && TYPE_ALIASES[this.peek().value])) {
      col.type = this.parseColumnType();
    }
    for (;;) {
      if (this.matchKeyword("PRIMARY", "KEY")) {
        col.primaryKey = true;
        col.notNull = true;
        if (this.matchKeyword("AUTOINCREMENT")) {
          if (col.type !== "INTEGER") this.fail("AUTOINCREMENT is only allowed on INTEGER columns");
          col.autoIncrement = true;
        }
      } else if (this.matchKeyword("NOT", "NULL")) {
        col.notNull = true;
      } else if (this.matchKeyword("NULL")) {
        // explicit NULL: nothing to do
      } else if (this.matchKeyword("UNIQUE")) {
        col.unique = true;
      } else if (this.matchKeyword("DEFAULT")) {
        col.defaultValue = this.isPunct("(") ? this.parsePrimary() : this.parseUnary();
      } else if (this.matchKeyword("CHECK")) {
        this.expectPunct("(");
        col.check = this.parseExpr();
        this.expectPunct(")");
      } else if (this.matchKeyword("REFERENCES")) {
        const table = this.parseIdentifier("table name");
        let column: string | undefined;
        if (this.matchPunct("(")) {
          column = this.parseIdentifier("column name");
          this.expectPunct(")");
        }
        col.references = { table, column };
      } else {
        break;
      }
    }
    return col;
  }

  private parseCreateIndex(unique: boolean): CreateIndexStatement {
    const ifNotExists = this.parseIfNotExists();
    const name = this.parseIdentifier("index name");
    this.expectKeyword("ON");
    const table = this.parseIdentifier("table name");
    this.expectPunct("(");
    const columns: string[] = [];
    do {
      columns.push(this.parseIdentifier("column name"));
      // Direction is accepted for compatibility; indexes are bidirectional.
      if (!this.matchKeyword("ASC")) this.matchKeyword("DESC");
    } while (this.matchPunct(","));
    this.expectPunct(")");
    return { type: "createIndex", name, table, columns, unique, ifNotExists };
  }

  private parseDrop(): DropTableStatement | DropIndexStatement | DropViewStatement {
    this.expectKeyword("DROP");
    if (this.matchKeyword("VIEW")) {
      const ifExists = this.parseIfExists();
      return { type: "dropView", name: this.parseIdentifier("view name"), ifExists };
    }
    if (this.matchKeyword("TABLE")) {
      const ifExists = this.parseIfExists();
      return { type: "dropTable", name: this.parseIdentifier("table name"), ifExists };
    }
    if (this.matchKeyword("INDEX")) {
      const ifExists = this.parseIfExists();
      return { type: "dropIndex", name: this.parseIdentifier("index name"), ifExists };
    }
    return this.fail("Expected TABLE, VIEW or INDEX after DROP");
  }

  private parseAlter(): AlterTableStatement {
    this.expectKeyword("ALTER", "TABLE");
    const table = this.parseIdentifier("table name");
    let action: AlterAction;
    if (this.matchKeyword("ADD")) {
      this.matchKeyword("COLUMN");
      action = { kind: "addColumn", column: this.parseColumnDef() };
    } else if (this.matchKeyword("DROP")) {
      this.matchKeyword("COLUMN");
      action = { kind: "dropColumn", name: this.parseIdentifier("column name") };
    } else if (this.matchKeyword("RENAME")) {
      if (this.matchKeyword("TO")) {
        action = { kind: "renameTable", to: this.parseIdentifier("table name") };
      } else {
        this.matchKeyword("COLUMN");
        const from = this.parseIdentifier("column name");
        this.expectKeyword("TO");
        action = { kind: "renameColumn", from, to: this.parseIdentifier("column name") };
      }
    } else {
      return this.fail("Expected ADD, DROP or RENAME after ALTER TABLE");
    }
    return { type: "alterTable", table, action };
  }

  private parseInsert(): InsertStatement {
    let orAction: InsertStatement["orAction"];
    if (this.matchKeyword("REPLACE")) {
      orAction = "REPLACE";
    } else {
      this.expectKeyword("INSERT");
      if (this.matchKeyword("OR")) {
        const tok = this.next();
        if (tok.type === "keyword" && (tok.value === "IGNORE" || tok.value === "REPLACE")) orAction = tok.value;
        else if (!(tok.type === "identifier" && /^(ABORT|FAIL)$/i.test(tok.value))) this.fail("Expected IGNORE, REPLACE, ABORT or FAIL after INSERT OR", tok);
      }
    }
    this.expectKeyword("INTO");
    const table = this.parseIdentifier("table name");
    let columns: string[] | undefined;
    if (this.isPunct("(") && !this.isKeyword("SELECT", 1) && !this.isKeyword("WITH", 1)) {
      columns = this.parseIdentifierList();
    }
    let stmt: InsertStatement;
    if (this.matchKeyword("VALUES")) {
      const values: Expr[][] = [];
      do {
        this.expectPunct("(");
        const row: Expr[] = [];
        if (!this.isPunct(")")) {
          do row.push(this.parseExpr());
          while (this.matchPunct(","));
        }
        this.expectPunct(")");
        values.push(row);
      } while (this.matchPunct(","));
      stmt = { type: "insert", table, columns, values };
    } else if (this.matchKeyword("DEFAULT", "VALUES")) {
      stmt = { type: "insert", table, columns, values: [[]] };
    } else if (this.isKeyword("SELECT") || this.isKeyword("WITH") || this.isPunct("(")) {
      stmt = { type: "insert", table, columns, select: this.parseSelect() };
    } else {
      return this.fail(`Expected VALUES or SELECT but found ${this.describe(this.peek())}`);
    }
    if (this.matchKeyword("ON", "CONFLICT")) {
      if (orAction) this.fail(`INSERT OR ${orAction} cannot be combined with ON CONFLICT`);
      stmt.onConflict = this.parseOnConflict();
    }
    if (orAction) stmt.orAction = orAction;
    stmt.returning = this.parseReturning();
    return stmt;
  }

  private parseOnConflict(): OnConflict {
    const target = this.isPunct("(") ? this.parseIdentifierList() : undefined;
    this.expectKeyword("DO");
    if (this.matchKeyword("NOTHING")) return { target, action: "nothing", assignments: [] };
    this.expectKeyword("UPDATE");
    if (!target) this.fail("ON CONFLICT DO UPDATE requires a conflict target, e.g. ON CONFLICT (id)");
    this.expectKeyword("SET");
    const assignments = this.parseAssignments();
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : undefined;
    return { target, action: "update", assignments, where };
  }

  private parseAssignments(): Assignment[] {
    const assignments: Assignment[] = [];
    do {
      let column = this.parseIdentifier("column name");
      // Allow `SET t.col = ...`.
      if (this.matchPunct(".")) column = this.parseIdentifier("column name");
      if (!this.matchOperator("=")) this.fail(`Expected '=' in SET clause`);
      assignments.push({ column, value: this.parseExpr() });
    } while (this.matchPunct(","));
    return assignments;
  }

  private parseReturning(): SelectItem[] | undefined {
    if (!this.matchKeyword("RETURNING")) return undefined;
    const items: SelectItem[] = [];
    do items.push(this.parseSelectItem());
    while (this.matchPunct(","));
    return items;
  }

  private parseOptionalAlias(): string | undefined {
    if (this.matchKeyword("AS")) return this.parseIdentifier("alias");
    if (this.isType("identifier")) return this.parseIdentifier("alias");
    return undefined;
  }

  private parseUpdate(): UpdateStatement {
    this.expectKeyword("UPDATE");
    const table = this.parseIdentifier("table name");
    const alias = this.isKeyword("SET") ? undefined : this.parseOptionalAlias();
    this.expectKeyword("SET");
    const assignments = this.parseAssignments();
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : undefined;
    return { type: "update", table, alias, assignments, where, returning: this.parseReturning() };
  }

  private parseDelete(): DeleteStatement {
    this.expectKeyword("DELETE", "FROM");
    const table = this.parseIdentifier("table name");
    const alias = this.isKeyword("WHERE") ? undefined : this.parseOptionalAlias();
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : undefined;
    return { type: "delete", table, alias, where, returning: this.parseReturning() };
  }

  // -------------------------------------------------------------------------
  // SELECT
  // -------------------------------------------------------------------------

  parseSelect(): SelectStatement {
    const withClause: CommonTableExpr[] = [];
    let recursive = false;
    if (this.matchKeyword("WITH")) {
      recursive = this.matchKeyword("RECURSIVE");
      do {
        const name = this.parseIdentifier("CTE name");
        const columns = this.isPunct("(") ? this.parseIdentifierList() : undefined;
        this.expectKeyword("AS");
        this.expectPunct("(");
        const query = this.parseSelect();
        this.expectPunct(")");
        withClause.push({ name, columns, query });
      } while (this.matchPunct(","));
    }

    const core = this.parseSelectCoreOrParenthesized();
    const compounds: { op: CompoundOp; core: SelectCore }[] = [];
    for (;;) {
      let op: CompoundOp;
      if (this.matchKeyword("UNION")) op = this.matchKeyword("ALL") ? "UNION ALL" : "UNION";
      else if (this.matchKeyword("INTERSECT")) op = "INTERSECT";
      else if (this.matchKeyword("EXCEPT")) op = "EXCEPT";
      else break;
      compounds.push({ op, core: this.parseSelectCoreOrParenthesized() });
    }

    const orderBy = this.matchKeyword("ORDER", "BY") ? this.parseOrderByItems() : [];

    let limit: Expr | undefined;
    let offset: Expr | undefined;
    if (this.matchKeyword("LIMIT")) {
      limit = this.parseExpr();
      if (this.matchKeyword("OFFSET")) offset = this.parseExpr();
      else if (this.matchPunct(",")) {
        // MySQL-style `LIMIT offset, count`.
        offset = limit;
        limit = this.parseExpr();
      }
    } else if (this.matchKeyword("OFFSET")) {
      offset = this.parseExpr();
    }

    return { type: "select", recursive, with: withClause, core, compounds, orderBy, limit, offset };
  }

  private parseOrderByItems(): OrderByItem[] {
    const items: OrderByItem[] = [];
    do {
      const expr = this.parseExpr();
      let direction: "ASC" | "DESC" = "ASC";
      if (this.matchKeyword("DESC")) direction = "DESC";
      else this.matchKeyword("ASC");
      let nulls: "FIRST" | "LAST" | undefined;
      if (this.matchKeyword("NULLS")) {
        if (this.matchKeyword("FIRST")) nulls = "FIRST";
        else if (this.matchKeyword("LAST")) nulls = "LAST";
        else this.fail("Expected FIRST or LAST after NULLS");
      }
      items.push({ expr, direction, nulls });
    } while (this.matchPunct(","));
    return items;
  }

  private parseSelectCoreOrParenthesized(): SelectCore {
    if (this.isPunct("(")) {
      this.next();
      const inner = this.parseSelect();
      this.expectPunct(")");
      if (inner.compounds.length || inner.orderBy.length || inner.limit || inner.with.length) {
        // Wrap complex parenthesized queries as a derived table.
        return {
          distinct: false,
          columns: [{ expr: { kind: "star" } }],
          from: { kind: "subquery", query: inner, alias: "__paren" },
          groupBy: [],
        };
      }
      return inner.core;
    }
    return this.parseSelectCore();
  }

  private parseSelectCore(): SelectCore {
    if (this.matchKeyword("VALUES")) return this.parseValuesCore();
    this.expectKeyword("SELECT");
    let distinct = false;
    if (this.matchKeyword("DISTINCT")) distinct = true;
    else this.matchKeyword("ALL");

    const columns: SelectItem[] = [];
    do columns.push(this.parseSelectItem());
    while (this.matchPunct(","));

    const from = this.matchKeyword("FROM") ? this.parseFrom() : undefined;
    const where = this.matchKeyword("WHERE") ? this.parseExpr() : undefined;
    const groupBy: Expr[] = [];
    if (this.matchKeyword("GROUP", "BY")) {
      do groupBy.push(this.parseExpr());
      while (this.matchPunct(","));
    }
    const having = this.matchKeyword("HAVING") ? this.parseExpr() : undefined;
    const core: SelectCore = { distinct, columns, from, where, groupBy, having };
    const windows: NamedWindow[] = [];
    if (this.matchKeyword("WINDOW")) {
      do {
        const name = this.parseIdentifier("window name");
        this.expectKeyword("AS");
        windows.push({ name, spec: this.parseWindowSpec() });
      } while (this.matchPunct(","));
    }
    this.resolveNamedWindows(core, windows);
    return core;
  }

  /** Replaces `OVER name` references in a SELECT core with the named windows' definitions. */
  private resolveNamedWindows(core: SelectCore, windows: NamedWindow[]): void {
    const byName = new Map<string, WindowSpec>();
    const resolve = (spec: WindowSpec): WindowSpec => {
      if (!spec.base) return spec;
      const base = byName.get(spec.base.toLowerCase());
      if (!base) throw new SqlSyntaxError(`No such window: ${spec.base}`, this.peek().line, this.peek().column);
      if (spec.partitionBy.length) throw new SqlSyntaxError(`Cannot override PARTITION BY of window ${spec.base}`, this.peek().line, this.peek().column);
      if (spec.orderBy.length && base.orderBy.length) {
        throw new SqlSyntaxError(`Cannot override ORDER BY of window ${spec.base}`, this.peek().line, this.peek().column);
      }
      if (base.frame) throw new SqlSyntaxError(`Cannot build on window ${spec.base}, which has a frame`, this.peek().line, this.peek().column);
      return {
        partitionBy: base.partitionBy,
        orderBy: spec.orderBy.length ? spec.orderBy : base.orderBy,
        frame: spec.frame,
      };
    };
    for (const w of windows) {
      const key = w.name.toLowerCase();
      if (byName.has(key)) throw new SqlSyntaxError(`Window ${w.name} is defined more than once`, this.peek().line, this.peek().column);
      byName.set(key, resolve(w.spec));
    }
    const visit = (expr: Expr | undefined): void => {
      if (!expr) return;
      walkAll(expr, (e) => {
        if (e.kind === "function" && e.over?.base) e.over = resolve(e.over);
      });
    };
    for (const item of core.columns) visit(item.expr);
    visit(core.having);
  }

  /** `VALUES (1, 2), (3, 4)` as a standalone query, with columns column1, column2, ... */
  private parseValuesCore(): SelectCore {
    const rows: Expr[][] = [];
    do {
      this.expectPunct("(");
      const row: Expr[] = [];
      do row.push(this.parseExpr());
      while (this.matchPunct(","));
      this.expectPunct(")");
      if (rows.length && rows[0]!.length !== row.length) this.fail("All VALUES rows must have the same number of columns");
      rows.push(row);
    } while (this.matchPunct(","));

    // Desugar into SELECT ... UNION ALL SELECT ... inside a derived table.
    const toCore = (row: Expr[]): SelectCore => ({
      distinct: false,
      columns: row.map((expr, i) => ({ expr, alias: `column${i + 1}` })),
      groupBy: [],
    });
    const query: SelectStatement = {
      type: "select",
      with: [],
      core: toCore(rows[0]!),
      compounds: rows.slice(1).map((row) => ({ op: "UNION ALL" as const, core: toCore(row) })),
      orderBy: [],
    };
    return {
      distinct: false,
      columns: [{ expr: { kind: "star" } }],
      from: { kind: "subquery", query, alias: "__values" },
      groupBy: [],
    };
  }

  private parseSelectItem(): SelectItem {
    if (this.isOperator("*")) {
      this.next();
      return { expr: { kind: "star" } };
    }
    if (this.isIdentifier() && this.isPunct(".", 1) && this.isOperator("*", 2)) {
      const table = this.parseIdentifier();
      this.pos += 2;
      return { expr: { kind: "star", table } };
    }
    const start = this.peek().start;
    const expr = this.parseExpr();
    const text = this.source.slice(start, this.tokens[this.pos - 1]!.end);
    let alias: string | undefined;
    if (this.matchKeyword("AS")) {
      alias = this.isType("string") ? this.next().value : this.parseIdentifier("alias");
    } else if (this.isType("identifier")) {
      alias = this.parseIdentifier("alias");
    }
    return { expr, alias, text };
  }

  private parseFrom(): FromItem {
    let left = this.parseTableFactor();
    for (;;) {
      if (this.matchPunct(",")) {
        left = { kind: "join", joinType: "CROSS", left, right: this.parseTableFactor() };
        continue;
      }
      let joinType: JoinType | undefined;
      if (this.matchKeyword("CROSS", "JOIN")) joinType = "CROSS";
      else if (this.matchKeyword("INNER", "JOIN") || this.matchKeyword("JOIN")) joinType = "INNER";
      else if (this.matchKeyword("LEFT")) {
        this.matchKeyword("OUTER");
        this.expectKeyword("JOIN");
        joinType = "LEFT";
      } else if (this.matchKeyword("RIGHT")) {
        this.matchKeyword("OUTER");
        this.expectKeyword("JOIN");
        joinType = "RIGHT";
      } else if (this.matchKeyword("FULL")) {
        this.matchKeyword("OUTER");
        this.expectKeyword("JOIN");
        joinType = "FULL";
      }
      if (!joinType) break;
      const right = this.parseTableFactor();
      let on: Expr | undefined;
      if (joinType !== "CROSS") {
        if (this.matchKeyword("ON")) on = this.parseExpr();
        else if (this.matchKeyword("USING")) on = this.parseUsing(left, right);
        else this.fail(`Expected ON after ${joinType} JOIN`);
      }
      left = { kind: "join", joinType, left, right, on };
    }
    return left;
  }

  /** Desugars `USING (a, b)` into `left.a = right.a AND left.b = right.b`. */
  private parseUsing(left: FromItem, right: FromItem): Expr {
    const columns = this.parseIdentifierList();
    const leftName = rightmostName(left);
    const rightName = rightmostName(right);
    let expr: Expr | undefined;
    for (const name of columns) {
      const eq: Expr = {
        kind: "binary",
        op: "=",
        left: { kind: "column", table: leftName, name },
        right: { kind: "column", table: rightName, name },
      };
      expr = expr ? { kind: "binary", op: "AND", left: expr, right: eq } : eq;
    }
    return expr!;
  }

  private parseTableFactor(): FromItem {
    if (this.matchPunct("(")) {
      if (this.isKeyword("SELECT") || this.isKeyword("WITH") || this.isKeyword("VALUES")) {
        const query = this.parseSelect();
        this.expectPunct(")");
        const alias = this.parseOptionalAlias();
        if (!alias) this.fail("A subquery in FROM must have an alias");
        return { kind: "subquery", query, alias };
      }
      const inner = this.parseFrom();
      this.expectPunct(")");
      return inner;
    }
    const name = this.parseIdentifier("table name");
    const alias = this.parseOptionalAlias();
    return { kind: "table", name, alias };
  }

  // -------------------------------------------------------------------------
  // Expressions (lowest to highest precedence)
  // -------------------------------------------------------------------------

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchKeyword("OR")) left = { kind: "binary", op: "OR", left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.matchKeyword("AND")) left = { kind: "binary", op: "AND", left, right: this.parseNot() };
    return left;
  }

  private parseNot(): Expr {
    if (this.isKeyword("NOT") && !this.isKeyword("EXISTS", 1)) {
      this.next();
      return { kind: "unary", op: "NOT", operand: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    for (;;) {
      const tok = this.peek();
      if (tok.type === "operator" && COMPARISON_OPS.has(tok.value)) {
        this.next();
        left = { kind: "binary", op: tok.value as BinaryOp, left, right: this.parseAdditive() };
        continue;
      }
      if (this.matchKeyword("IS")) {
        const negated = this.matchKeyword("NOT");
        if (this.matchKeyword("DISTINCT")) {
          // `a IS DISTINCT FROM b` is the null-safe inequality.
          this.expectKeyword("FROM");
          left = nullSafeEquals(left, this.parseAdditive(), !negated);
          continue;
        }
        if (this.matchKeyword("NULL")) {
          left = { kind: "isNull", operand: left, negated };
        } else if (this.matchKeyword("TRUE") || this.matchKeyword("FALSE")) {
          const value = this.tokens[this.pos - 1]!.value === "TRUE";
          // `x IS TRUE` / `x IS FALSE` never yield NULL.
          const isTrue: Expr = {
            kind: "case",
            branches: [
              { when: { kind: "isNull", operand: left, negated: false }, then: { kind: "literal", value: false } },
              { when: left, then: { kind: "literal", value } },
            ],
            elseExpr: { kind: "literal", value: !value },
          };
          left = negated ? { kind: "unary", op: "NOT", operand: isTrue } : isTrue;
        } else {
          // IS / IS NOT <expr>: null-safe equality.
          const right = this.parseAdditive();
          left = nullSafeEquals(left, right, negated);
        }
        continue;
      }
      const negated =
        this.isKeyword("NOT") && (this.isKeyword("IN", 1) || this.isKeyword("LIKE", 1) || this.isKeyword("GLOB", 1) || this.isKeyword("BETWEEN", 1));
      if (negated) this.next();
      if (this.matchKeyword("IN")) {
        this.expectPunct("(");
        if (this.isKeyword("SELECT") || this.isKeyword("WITH")) {
          const query = this.parseSelect();
          this.expectPunct(")");
          left = { kind: "inSubquery", operand: left, query, negated };
        } else {
          const list: Expr[] = [];
          if (!this.isPunct(")")) {
            do list.push(this.parseExpr());
            while (this.matchPunct(","));
          }
          this.expectPunct(")");
          left = { kind: "inList", operand: left, list, negated };
        }
        continue;
      }
      if (this.isKeyword("LIKE") || this.isKeyword("GLOB")) {
        const op = this.next().value as "LIKE" | "GLOB";
        const pattern = this.parseAdditive();
        const escape = op === "LIKE" && this.matchKeyword("ESCAPE") ? this.parseAdditive() : undefined;
        left = { kind: "like", op, operand: left, pattern, escape, negated };
        continue;
      }
      if (this.matchKeyword("BETWEEN")) {
        const low = this.parseAdditive();
        this.expectKeyword("AND");
        const high = this.parseAdditive();
        left = { kind: "between", operand: left, low, high, negated };
        continue;
      }
      if (negated) this.fail("Expected IN, LIKE, GLOB or BETWEEN after NOT");
      return left;
    }
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    for (;;) {
      if (this.isOperator("+") || this.isOperator("-")) {
        const op = this.next().value as BinaryOp;
        left = { kind: "binary", op, left, right: this.parseMultiplicative() };
      } else {
        return left;
      }
    }
  }

  private parseMultiplicative(): Expr {
    let left = this.parseConcat();
    for (;;) {
      if (this.isOperator("*") || this.isOperator("/") || this.isOperator("%")) {
        const op = this.next().value as BinaryOp;
        left = { kind: "binary", op, left, right: this.parseConcat() };
      } else {
        return left;
      }
    }
  }

  private parseConcat(): Expr {
    let left = this.parseUnary();
    // `||`, `->` and `->>` share the highest binary precedence, as in SQLite.
    while (this.isOperator("||") || this.isOperator("->") || this.isOperator("->>")) {
      const op = this.next().value as BinaryOp;
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.isOperator("-") || this.isOperator("+")) {
      const op = this.next().value as "-" | "+";
      const operand = this.parseUnary();
      if (op === "-" && operand.kind === "literal" && typeof operand.value === "number") {
        return { kind: "literal", value: -operand.value };
      }
      return { kind: "unary", op, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.peek();

    switch (tok.type) {
      case "number":
        this.next();
        return { kind: "literal", value: Number(tok.value) };
      case "string":
        this.next();
        return { kind: "literal", value: tok.value };
      case "param": {
        this.next();
        if (tok.value === "?") return { kind: "param", key: this.paramIndex++ };
        return { kind: "param", key: tok.value };
      }
      case "punct":
        if (tok.value === "(") {
          this.next();
          if (this.isKeyword("SELECT") || this.isKeyword("WITH")) {
            const query = this.parseSelect();
            this.expectPunct(")");
            return { kind: "subquery", query };
          }
          const expr = this.parseExpr();
          this.expectPunct(")");
          return expr;
        }
        break;
      case "keyword":
        switch (tok.value) {
          case "NULL":
            this.next();
            return { kind: "literal", value: null };
          case "TRUE":
            this.next();
            return { kind: "literal", value: true };
          case "FALSE":
            this.next();
            return { kind: "literal", value: false };
          case "CASE":
            return this.parseCase();
          case "CAST": {
            this.next();
            this.expectPunct("(");
            const operand = this.parseExpr();
            this.expectKeyword("AS");
            const type = this.parseColumnType();
            this.expectPunct(")");
            return { kind: "cast", operand, type };
          }
          case "EXISTS":
            return this.parseExists(false);
          case "NOT":
            if (this.isKeyword("EXISTS", 1)) {
              this.next();
              return this.parseExists(true);
            }
            break;
          // A few keywords double as function names.
          case "LEFT":
          case "RIGHT":
          case "IF":
            if (this.isPunct("(", 1)) return this.parseFunctionCall();
            break;
        }
        break;
    }

    if (this.isIdentifier()) {
      if (this.isPunct("(", 1)) return this.parseFunctionCall();
      const first = this.parseIdentifier();
      if (this.matchPunct(".")) {
        const name = this.parseIdentifier("column name");
        return { kind: "column", table: first, name };
      }
      return { kind: "column", name: first };
    }

    return this.fail(`Unexpected ${this.describe(tok)} in expression`);
  }

  private parseExists(negated: boolean): Expr {
    this.expectKeyword("EXISTS");
    this.expectPunct("(");
    const query = this.parseSelect();
    this.expectPunct(")");
    return { kind: "exists", query, negated };
  }

  private parseFunctionCall(): Expr {
    const nameTok = this.next();
    const name = nameTok.value.toUpperCase();
    this.expectPunct("(");
    if (this.isOperator("*")) {
      this.next();
      this.expectPunct(")");
      const call: FunctionCallExpr = { kind: "function", name, args: [], distinct: false, star: true };
      this.parseOver(call);
      return call;
    }
    const distinct = this.matchKeyword("DISTINCT");
    const args: Expr[] = [];
    if (!this.isPunct(")")) {
      do args.push(this.parseExpr());
      while (this.matchPunct(","));
    }
    this.expectPunct(")");
    const call: FunctionCallExpr = { kind: "function", name, args, distinct, star: false };
    this.parseOver(call);
    return call;
  }

  /** Parses an optional `OVER (...)` or `OVER name` after a function call. */
  private parseOver(call: FunctionCallExpr): void {
    if (!this.isKeyword("OVER")) return;
    if (this.isPunct("(", 1)) {
      this.next();
      call.over = this.parseWindowSpec();
    } else if (this.isIdentifier(1)) {
      this.next();
      call.over = { base: this.parseIdentifier("window name"), partitionBy: [], orderBy: [] };
    }
  }

  private parseWindowSpec(): WindowSpec {
    this.expectPunct("(");
    const spec: WindowSpec = { partitionBy: [], orderBy: [] };
    // `(w ORDER BY ...)`: a window based on a named one.
    if (this.isIdentifier() && !this.isKeyword("PARTITION") && !this.isKeyword("ORDER") && !this.isKeyword("ROWS") && !this.isKeyword("RANGE")) {
      spec.base = this.parseIdentifier("window name");
    }
    if (this.matchKeyword("PARTITION")) {
      this.expectKeyword("BY");
      do spec.partitionBy.push(this.parseExpr());
      while (this.matchPunct(","));
    }
    if (this.matchKeyword("ORDER", "BY")) spec.orderBy = this.parseOrderByItems();
    if (this.isKeyword("ROWS") || this.isKeyword("RANGE")) {
      const unit = this.next().value as "ROWS" | "RANGE";
      let start: FrameBound;
      let end: FrameBound;
      if (this.matchKeyword("BETWEEN")) {
        start = this.parseFrameBound();
        this.expectKeyword("AND");
        end = this.parseFrameBound();
      } else {
        start = this.parseFrameBound();
        end = { kind: "currentRow" };
      }
      if (start.kind === "unboundedFollowing") this.fail("A window frame cannot start at UNBOUNDED FOLLOWING");
      if (end.kind === "unboundedPreceding") this.fail("A window frame cannot end at UNBOUNDED PRECEDING");
      if (unit === "RANGE" && (start.kind === "preceding" || start.kind === "following" || end.kind === "preceding" || end.kind === "following")) {
        if (spec.orderBy.length !== 1) this.fail("RANGE with an offset requires exactly one ORDER BY expression");
      }
      spec.frame = { unit, start, end };
    }
    this.expectPunct(")");
    return spec;
  }

  private parseFrameBound(): FrameBound {
    if (this.matchKeyword("UNBOUNDED")) {
      if (this.matchKeyword("PRECEDING")) return { kind: "unboundedPreceding" };
      this.expectKeyword("FOLLOWING");
      return { kind: "unboundedFollowing" };
    }
    if (this.matchKeyword("CURRENT")) {
      this.expectKeyword("ROW");
      return { kind: "currentRow" };
    }
    const offset = this.parseAdditive();
    if (this.matchKeyword("PRECEDING")) return { kind: "preceding", offset };
    this.expectKeyword("FOLLOWING");
    return { kind: "following", offset };
  }

  private parseCase(): Expr {
    this.expectKeyword("CASE");
    const operand = this.isKeyword("WHEN") ? undefined : this.parseExpr();
    const branches: { when: Expr; then: Expr }[] = [];
    while (this.matchKeyword("WHEN")) {
      const when = this.parseExpr();
      this.expectKeyword("THEN");
      branches.push({ when, then: this.parseExpr() });
    }
    if (branches.length === 0) this.fail("CASE requires at least one WHEN branch");
    const elseExpr = this.matchKeyword("ELSE") ? this.parseExpr() : undefined;
    this.expectKeyword("END");
    return { kind: "case", operand, branches, elseExpr };
  }
}

/** Visits an expression tree including window specifications (but not subqueries). */
function walkAll(expr: Expr, visit: (e: Expr) => void): void {
  visit(expr);
  const children: Expr[] = [];
  switch (expr.kind) {
    case "unary":
    case "isNull":
    case "cast":
      children.push(expr.operand);
      break;
    case "binary":
      children.push(expr.left, expr.right);
      break;
    case "between":
      children.push(expr.operand, expr.low, expr.high);
      break;
    case "inList":
      children.push(expr.operand, ...expr.list);
      break;
    case "inSubquery":
      children.push(expr.operand);
      break;
    case "like":
      children.push(expr.operand, expr.pattern, ...(expr.escape ? [expr.escape] : []));
      break;
    case "case":
      if (expr.operand) children.push(expr.operand);
      for (const b of expr.branches) children.push(b.when, b.then);
      if (expr.elseExpr) children.push(expr.elseExpr);
      break;
    case "function":
      children.push(...expr.args);
      if (expr.over) children.push(...expr.over.partitionBy, ...expr.over.orderBy.map((o) => o.expr));
      break;
  }
  for (const c of children) walkAll(c, visit);
}

function rightmostName(item: FromItem): string | undefined {
  switch (item.kind) {
    case "table":
      return item.alias ?? item.name;
    case "subquery":
      return item.alias;
    case "join":
      return rightmostName(item.right);
  }
}

/** Builds `a IS b` (null-safe equality) out of ordinary expression nodes. */
function nullSafeEquals(left: Expr, right: Expr, negated: boolean): Expr {
  const bothNull: Expr = {
    kind: "binary",
    op: "AND",
    left: { kind: "isNull", operand: left, negated: false },
    right: { kind: "isNull", operand: right, negated: false },
  };
  const eitherNull: Expr = {
    kind: "binary",
    op: "OR",
    left: { kind: "isNull", operand: left, negated: false },
    right: { kind: "isNull", operand: right, negated: false },
  };
  const expr: Expr = {
    kind: "case",
    branches: [
      { when: bothNull, then: { kind: "literal", value: true } },
      { when: eitherNull, then: { kind: "literal", value: false } },
    ],
    elseExpr: { kind: "binary", op: "=", left, right },
  };
  return negated ? { kind: "unary", op: "NOT", operand: expr } : expr;
}

/** Parses a SQL script into a list of statements. */
export function parse(sql: string): Statement[] {
  return new Parser(sql).parseScript();
}

/** Parses a single SQL expression. */
export function parseExpression(sql: string): Expr {
  return new Parser(sql).parseStandaloneExpr();
}
