import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { displayWidth, formatCsv, formatJson, formatLines, formatTable } from "../src/format.js";

const root = join(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "minisql-cli-"));

beforeAll(() => {
  // The CLI is tested end-to-end against the compiled output.
  execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], input?: string) {
  return spawnSync(process.execPath, [cli, ...args], { input, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

describe("formatting", () => {
  const result = {
    columns: ["id", "name", "score"],
    rows: [
      [1, "Ada", 9.5],
      [22, null, 10],
    ],
  };

  it("draws tables with right-aligned numbers", () => {
    expect(formatTable(result)).toBe(
      [
        "┌────┬──────┬───────┐",
        "│ id │ name │ score │",
        "├────┼──────┼───────┤",
        "│  1 │ Ada  │   9.5 │",
        "│ 22 │ NULL │    10 │",
        "└────┴──────┴───────┘",
      ].join("\n"),
    );
  });

  it("measures wide characters", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("한글")).toBe(4);
    expect(displayWidth("日本")).toBe(4);
    expect(formatTable({ columns: ["x"], rows: [["한"]] })).toContain("│ 한 │");
  });

  it("truncates long cells", () => {
    expect(formatTable({ columns: ["x"], rows: [["abcdefghij"]] }, { maxCellWidth: 5 })).toContain("abcd…");
  });

  it("formats CSV, JSON and line output", () => {
    expect(formatCsv({ columns: ["a", "b"], rows: [["x,y", 'say "hi"'], [null, 1]] })).toBe('a,b\n"x,y","say ""hi"""\n,1');
    expect(JSON.parse(formatJson(result))).toEqual([
      { id: 1, name: "Ada", score: 9.5 },
      { id: 22, name: null, score: 10 },
    ]);
    expect(formatLines({ columns: ["id", "name"], rows: [[1, "Ada"]] })).toBe("  id = 1\nname = Ada");
  });
});

describe("command line", () => {
  it("prints help and version", () => {
    expect(run(["--help"]).stdout).toMatch(/Usage:/);
    expect(run(["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("executes SQL from --execute", () => {
    const r = run(["-e", "SELECT 1 + 1 AS two;"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("│   2 │");
  });

  it("executes scripts from stdin in other output modes", () => {
    const r = run(["-m", "csv"], "CREATE TABLE t (a, b); INSERT INTO t VALUES (1, 'x'), (2, 'y'); SELECT * FROM t ORDER BY a;");
    expect(r.stdout).toContain("a,b\n1,x\n2,y");
  });

  it("exits non-zero on SQL errors", () => {
    const r = run(["-e", "SELECT * FROM nope;"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No such table: nope/);
  });

  it("persists changes to a database file", () => {
    const path = join(dir, "cli.json");
    run([path, "-e", "CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('remember me');"]);
    expect(existsSync(path)).toBe(true);
    const r = run([path, "-m", "json", "-e", "SELECT body FROM notes;"]);
    expect(JSON.parse(r.stdout)).toEqual([{ body: "remember me" }]);
  });

  it("rejects unknown options", () => {
    const r = run(["--bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Unknown option/);
  });
});
