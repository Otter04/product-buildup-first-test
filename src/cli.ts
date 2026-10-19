#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Database, type QueryResult } from "./database.js";
import { SqlError, SqlSyntaxError } from "./errors.js";
import { formatResult, type OutputMode } from "./format.js";
import { tokenize } from "./lexer.js";
import { openDatabase, saveDatabase } from "./persistence.js";

const VERSION = "0.1.0";

const HELP = `minisql ${VERSION} — a tiny SQL database engine

Usage:
  minisql [file] [options]

Arguments:
  file                 Database file (.json snapshot or .sql dump). Created on first save.

Options:
  -e, --execute <sql>  Execute SQL and exit
  -m, --mode <mode>    Output mode: table (default), csv, json, line
  -h, --help           Show this help
  -v, --version        Show version

When stdin is not a terminal, it is read and executed as a SQL script.`;

const DOT_HELP = `.help                 Show this message
.tables               List tables
.schema [table]       Show CREATE statements
.describe <table>     Show the columns of a table
.dump                 Print the database as a SQL script
.read <file>          Execute SQL from a file
.save [file]          Save the database (.json snapshot or .sql dump)
.open <file>          Open another database file
.mode <mode>          Set output mode: table, csv, json, line
.timer on|off         Show execution time of each statement
.quit / .exit         Leave the shell`;

interface Session {
  db: Database;
  path?: string;
  mode: OutputMode;
  timer: boolean;
  color: boolean;
  dirty: boolean;
  print: (s: string) => void;
  printError: (s: string) => void;
}

/** True once the buffered input forms complete statements ending in `;`. */
export function isComplete(sql: string): boolean {
  try {
    const tokens = tokenize(sql);
    const meaningful = tokens.filter((t) => t.type !== "eof");
    if (meaningful.length === 0) return true;
    const last = meaningful[meaningful.length - 1]!;
    return last.type === "punct" && last.value === ";";
  } catch (e) {
    // Unterminated strings / comments: keep reading.
    if (e instanceof SqlSyntaxError && /Unterminated/.test(e.message)) return false;
    return true;
  }
}

function describeResult(r: QueryResult): string {
  switch (r.type) {
    case "insert":
    case "update":
    case "delete":
      return `${r.changes} row${r.changes === 1 ? "" : "s"} ${r.type === "insert" ? "inserted" : r.type === "update" ? "updated" : "deleted"}`;
    case "createTable":
      return "Table created";
    case "dropTable":
      return "Table dropped";
    case "createIndex":
      return "Index created";
    case "dropIndex":
      return "Index dropped";
    case "alterTable":
      return "Table altered";
    case "begin":
      return "Transaction started";
    case "commit":
      return "Transaction committed";
    case "rollback":
      return "Transaction rolled back";
    default:
      return "";
  }
}

function runSql(session: Session, sql: string): boolean {
  const start = performance.now();
  try {
    const results = session.db.exec(sql);
    for (const r of results) {
      if (r.type === "explain" && session.mode === "table") {
        // Plans read best as an indented tree, without table borders.
        session.print(r.rows.map((row) => String(row[0])).join("\n"));
        continue;
      }
      if (r.columns.length > 0) {
        if (r.rows.length === 0 && session.mode === "table") session.print("(no rows)");
        else session.print(formatResult(r, session.mode, { color: session.color }));
        if (session.mode === "table" && r.rows.length > 0) session.print(`${r.rows.length} row${r.rows.length === 1 ? "" : "s"}`);
      } else {
        const msg = describeResult(r);
        if (msg) session.print(msg);
      }
      if (r.type !== "select" && r.type !== "explain" && r.type !== "showTables" && r.type !== "describe") session.dirty = true;
    }
    if (session.timer) session.print(`Time: ${(performance.now() - start).toFixed(3)} ms`);
    autosave(session);
    return true;
  } catch (e) {
    if (e instanceof SqlError) session.printError(`Error: ${e.message}`);
    else throw e;
    return false;
  }
}

function autosave(session: Session): void {
  if (session.path && session.dirty && !session.db.inTransaction) {
    saveDatabase(session.db, session.path);
    session.dirty = false;
  }
}

/** Handles a dot-command. Returns false when the shell should exit. */
function runDotCommand(session: Session, line: string): boolean {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const arg = args.join(" ");
  switch (cmd) {
    case ".quit":
    case ".exit":
      return false;
    case ".help":
      session.print(DOT_HELP);
      break;
    case ".tables":
      session.print(session.db.tables().join("  ") || "(no tables)");
      break;
    case ".schema":
      if (arg) {
        const sql = session.db
          .schema()
          .split(/;\n?/)
          .filter((s) => new RegExp(`\\b(TABLE|ON)\\s+"?${arg}"?\\b`, "i").test(s))
          .map((s) => s.trim() + ";")
          .join("\n");
        session.print(sql || `No such table: ${arg}`);
      } else {
        session.print(session.db.schema() || "(empty database)");
      }
      break;
    case ".describe":
      if (!arg) session.printError("Usage: .describe <table>");
      else runSql(session, `DESCRIBE ${arg};`);
      break;
    case ".dump":
      session.print(session.db.dump().trimEnd());
      break;
    case ".read":
      if (!arg) session.printError("Usage: .read <file>");
      else {
        try {
          runSql(session, readFileSync(arg, "utf8"));
        } catch (e) {
          session.printError(`Error: ${(e as Error).message}`);
        }
      }
      break;
    case ".save": {
      const path = arg || session.path;
      if (!path) {
        session.printError("Usage: .save <file>");
        break;
      }
      try {
        saveDatabase(session.db, path);
        session.path = path;
        session.dirty = false;
        session.print(`Saved to ${path}`);
      } catch (e) {
        session.printError(`Error: ${(e as Error).message}`);
      }
      break;
    }
    case ".open":
      if (!arg) {
        session.printError("Usage: .open <file>");
        break;
      }
      try {
        session.db = openDatabase(arg);
        session.path = arg;
        session.dirty = false;
        session.print(`Opened ${arg}`);
      } catch (e) {
        session.printError(`Error: ${(e as Error).message}`);
      }
      break;
    case ".mode":
      if (arg === "table" || arg === "csv" || arg === "json" || arg === "line") session.mode = arg;
      else session.printError("Usage: .mode table|csv|json|line");
      break;
    case ".timer":
      if (arg === "on" || arg === "off") session.timer = arg === "on";
      else session.printError("Usage: .timer on|off");
      break;
    default:
      session.printError(`Unknown command ${cmd}. Type .help for help.`);
  }
  return true;
}

function startRepl(session: Session): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "minisql> " });
  let buffer = "";
  session.print(`minisql ${VERSION}. Type .help for commands; end SQL statements with ';'.`);
  if (session.path) session.print(`Database: ${session.path}`);
  rl.prompt();
  rl.on("line", (line) => {
    if (buffer === "" && line.trim().startsWith(".")) {
      if (!runDotCommand(session, line)) {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }
    buffer += (buffer ? "\n" : "") + line;
    if (isComplete(buffer)) {
      if (buffer.trim()) runSql(session, buffer);
      buffer = "";
      rl.setPrompt("minisql> ");
    } else {
      rl.setPrompt("   ...> ");
    }
    rl.prompt();
  });
  rl.on("SIGINT", () => {
    if (buffer) {
      buffer = "";
      process.stdout.write("\n");
      rl.setPrompt("minisql> ");
      rl.prompt();
    } else {
      rl.close();
    }
  });
  rl.on("close", () => {
    autosave(session);
    process.stdout.write("\n");
  });
}

function main(argv: string[]): number {
  let path: string | undefined;
  let execute: string | undefined;
  let mode: OutputMode = "table";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      return 0;
    }
    if (a === "-v" || a === "--version") {
      console.log(VERSION);
      return 0;
    }
    if (a === "-e" || a === "--execute") {
      execute = argv[++i];
      if (execute === undefined) {
        console.error("Missing SQL after --execute");
        return 2;
      }
    } else if (a === "-m" || a === "--mode") {
      const m = argv[++i];
      if (m !== "table" && m !== "csv" && m !== "json" && m !== "line") {
        console.error("--mode must be one of table, csv, json, line");
        return 2;
      }
      mode = m;
    } else if (a.startsWith("-")) {
      console.error(`Unknown option ${a}\n\n${HELP}`);
      return 2;
    } else {
      path = a;
    }
  }

  let db: Database;
  try {
    db = path ? openDatabase(path) : new Database();
  } catch (e) {
    console.error(`Cannot open ${path}: ${(e as Error).message}`);
    return 1;
  }
  const session: Session = {
    db,
    path,
    mode,
    timer: false,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    dirty: false,
    print: (s) => console.log(s),
    printError: (s) => console.error(s),
  };

  if (execute !== undefined) return runSql(session, execute) ? 0 : 1;
  if (!process.stdin.isTTY) {
    const script = readFileSync(0, "utf8");
    return runSql(session, script) ? 0 : 1;
  }
  startRepl(session);
  return 0;
}

const code = main(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
