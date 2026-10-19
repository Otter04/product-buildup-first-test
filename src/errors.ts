/** Base class for every error raised by the engine. */
export class SqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Raised when the input text cannot be tokenized or parsed. */
export class SqlSyntaxError extends SqlError {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

/** Raised when a statement references unknown tables, columns or functions. */
export class SqlCatalogError extends SqlError {}

export type ConstraintKind = "notNull" | "check" | "unique" | "primaryKey" | "foreignKey" | "schema";

/** Raised when a constraint (NOT NULL, UNIQUE, PRIMARY KEY, CHECK, FOREIGN KEY) is violated. */
export class SqlConstraintError extends SqlError {
  constructor(
    message: string,
    /** Which kind of constraint failed; `schema` covers DDL-level refusals. */
    readonly kind: ConstraintKind = "schema",
  ) {
    super(message);
  }
}

/** Raised for runtime evaluation problems such as type mismatches. */
export class SqlRuntimeError extends SqlError {}
