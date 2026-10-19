import { SqlSyntaxError } from "./errors.js";

export type TokenType =
  | "keyword"
  | "identifier"
  | "number"
  | "string"
  | "operator"
  | "punct"
  | "param"
  | "eof";

export interface Token {
  type: TokenType;
  /** Upper-cased for keywords, raw text otherwise (unquoted for strings / quoted identifiers). */
  value: string;
  /** Exact source text of the token. */
  raw: string;
  line: number;
  column: number;
  /** Offset of the first character of the token in the source. */
  start: number;
  /** Offset one past the last character of the token in the source. */
  end: number;
}

export const KEYWORDS = new Set([
  "ADD",
  "ALL",
  "ALTER",
  "AND",
  "AS",
  "ASC",
  "BEGIN",
  "BETWEEN",
  "BY",
  "CASE",
  "CAST",
  "COLUMN",
  "COMMIT",
  "CREATE",
  "CROSS",
  "DEFAULT",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DROP",
  "ELSE",
  "END",
  "EXCEPT",
  "EXISTS",
  "EXPLAIN",
  "FALSE",
  "FROM",
  "FULL",
  "GROUP",
  "HAVING",
  "IF",
  "IN",
  "INDEX",
  "INNER",
  "INSERT",
  "INTERSECT",
  "INTO",
  "IS",
  "JOIN",
  "KEY",
  "LEFT",
  "LIKE",
  "LIMIT",
  "NOT",
  "NULL",
  "NULLS",
  "FIRST",
  "LAST",
  "OFFSET",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "PRIMARY",
  "RENAME",
  "RIGHT",
  "ROLLBACK",
  "SELECT",
  "SET",
  "TABLE",
  "THEN",
  "TO",
  "TRANSACTION",
  "TRUE",
  "UNION",
  "UNIQUE",
  "UPDATE",
  "USING",
  "VALUES",
  "WHEN",
  "WHERE",
  "WITH",
  "AUTOINCREMENT",
  "CHECK",
  "REFERENCES",
  "RECURSIVE",
  "SHOW",
  "TABLES",
  "DESCRIBE",
  "OVER",
  "PARTITION",
  "ROWS",
  "RANGE",
  "UNBOUNDED",
  "PRECEDING",
  "FOLLOWING",
  "CURRENT",
  "ROW",
]);

const TWO_CHAR_OPERATORS = new Set(["<=", ">=", "<>", "!=", "||", "=="]);
const ONE_CHAR_OPERATORS = new Set(["+", "-", "*", "/", "%", "=", "<", ">"]);
const PUNCTUATION = new Set(["(", ")", ",", ";", "."]);

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) > 127;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Converts SQL source text into a flat list of tokens, always terminated by an
 * `eof` token. Comments (`-- ...` and `/* ... *\/`) and whitespace are skipped.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1): void => {
    for (let i = 0; i < n; i++) {
      if (source[pos] === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      pos++;
    }
  };

  const fail = (message: string): never => {
    throw new SqlSyntaxError(message, line, col);
  };

  while (pos < source.length) {
    const ch = source[pos]!;

    if (/\s/.test(ch)) {
      advance();
      continue;
    }

    if (ch === "-" && source[pos + 1] === "-") {
      while (pos < source.length && source[pos] !== "\n") advance();
      continue;
    }

    if (ch === "/" && source[pos + 1] === "*") {
      advance(2);
      while (pos < source.length && !(source[pos] === "*" && source[pos + 1] === "/")) advance();
      if (pos >= source.length) fail("Unterminated block comment");
      advance(2);
      continue;
    }

    const startLine = line;
    const startCol = col;
    const start = pos;
    const push = (type: TokenType, value: string): void => {
      tokens.push({ type, value, raw: source.slice(start, pos), line: startLine, column: startCol, start, end: pos });
    };

    if (isDigit(ch) || (ch === "." && isDigit(source[pos + 1] ?? ""))) {
      while (isDigit(source[pos] ?? "")) advance();
      if (source[pos] === "." && isDigit(source[pos + 1] ?? "")) {
        advance();
        while (isDigit(source[pos] ?? "")) advance();
      } else if (source[pos] === "." && !isIdentStart(source[pos + 1] ?? "")) {
        advance();
      }
      if (source[pos] === "e" || source[pos] === "E") {
        const save = { pos, line, col };
        advance();
        if (source[pos] === "+" || source[pos] === "-") advance();
        if (!isDigit(source[pos] ?? "")) {
          pos = save.pos;
          line = save.line;
          col = save.col;
        } else {
          while (isDigit(source[pos] ?? "")) advance();
        }
      }
      if (isIdentStart(source[pos] ?? "")) fail(`Invalid number literal '${source.slice(start, pos + 1)}'`);
      push("number", source.slice(start, pos));
      continue;
    }

    if (ch === "'") {
      advance();
      let value = "";
      for (;;) {
        if (pos >= source.length) fail("Unterminated string literal");
        const c = source[pos]!;
        if (c === "'") {
          if (source[pos + 1] === "'") {
            value += "'";
            advance(2);
            continue;
          }
          advance();
          break;
        }
        value += c;
        advance();
      }
      push("string", value);
      continue;
    }

    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      advance();
      let value = "";
      for (;;) {
        if (pos >= source.length) fail("Unterminated quoted identifier");
        const c = source[pos]!;
        if (c === close) {
          if (close !== "]" && source[pos + 1] === close) {
            value += close;
            advance(2);
            continue;
          }
          advance();
          break;
        }
        value += c;
        advance();
      }
      if (value.length === 0) fail("Empty quoted identifier");
      push("identifier", value);
      continue;
    }

    if (isIdentStart(ch)) {
      while (pos < source.length && isIdentPart(source[pos]!)) advance();
      const word = source.slice(start, pos);
      const upper = word.toUpperCase();
      if (KEYWORDS.has(upper)) push("keyword", upper);
      else push("identifier", word);
      continue;
    }

    if (ch === "?") {
      advance();
      push("param", "?");
      continue;
    }

    if (ch === ":" || ch === "$" || ch === "@") {
      advance();
      if (!isIdentStart(source[pos] ?? "") && !isDigit(source[pos] ?? "")) fail(`Expected parameter name after '${ch}'`);
      while (pos < source.length && isIdentPart(source[pos]!)) advance();
      push("param", source.slice(start + 1, pos));
      continue;
    }

    const two = source.slice(pos, pos + 2);
    if (TWO_CHAR_OPERATORS.has(two)) {
      advance(2);
      push("operator", two === "!=" ? "<>" : two === "==" ? "=" : two);
      continue;
    }
    if (ONE_CHAR_OPERATORS.has(ch)) {
      advance();
      push("operator", ch);
      continue;
    }
    if (PUNCTUATION.has(ch)) {
      advance();
      push("punct", ch);
      continue;
    }

    fail(`Unexpected character '${ch}'`);
  }

  tokens.push({ type: "eof", value: "", raw: "", line, column: col, start: pos, end: pos });
  return tokens;
}
