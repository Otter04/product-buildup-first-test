import { describe, expect, it } from "vitest";
import { SqlSyntaxError, tokenize } from "../src/index.js";

const kinds = (sql: string) => tokenize(sql).map((t) => [t.type, t.value]);

describe("tokenize", () => {
  it("classifies keywords, identifiers, numbers and punctuation", () => {
    expect(kinds("SELECT a, 1.5 FROM t;")).toEqual([
      ["keyword", "SELECT"],
      ["identifier", "a"],
      ["punct", ","],
      ["number", "1.5"],
      ["keyword", "FROM"],
      ["identifier", "t"],
      ["punct", ";"],
      ["eof", ""],
    ]);
  });

  it("upper-cases keywords but keeps identifier case", () => {
    expect(kinds("select MyCol from Users")).toEqual([
      ["keyword", "SELECT"],
      ["identifier", "MyCol"],
      ["keyword", "FROM"],
      ["identifier", "Users"],
      ["eof", ""],
    ]);
  });

  it("handles string escapes and quoted identifiers", () => {
    const toks = tokenize(`'it''s' "my ""col""" \`back\` [bracket]`);
    expect(toks.slice(0, 4).map((t) => [t.type, t.value])).toEqual([
      ["string", "it's"],
      ["identifier", 'my "col"'],
      ["identifier", "back"],
      ["identifier", "bracket"],
    ]);
  });

  it("recognises numbers in several notations", () => {
    expect(tokenize("42 3.14 .5 1e3 2.5E-2 7.").filter((t) => t.type === "number").map((t) => t.value)).toEqual([
      "42",
      "3.14",
      ".5",
      "1e3",
      "2.5E-2",
      "7.",
    ]);
  });

  it("normalises operator spellings", () => {
    expect(tokenize("a != b == c <> d").filter((t) => t.type === "operator").map((t) => t.value)).toEqual(["<>", "=", "<>"]);
  });

  it("skips line and block comments", () => {
    expect(kinds("SELECT -- comment\n 1 /* block\n comment */ + 2")).toEqual([
      ["keyword", "SELECT"],
      ["number", "1"],
      ["operator", "+"],
      ["number", "2"],
      ["eof", ""],
    ]);
  });

  it("parses positional and named parameters", () => {
    expect(tokenize("? :name $x @y").filter((t) => t.type === "param").map((t) => t.value)).toEqual(["?", "name", "x", "y"]);
  });

  it("tracks line and column numbers", () => {
    const toks = tokenize("SELECT\n  foo");
    expect(toks[1]).toMatchObject({ value: "foo", line: 2, column: 3 });
  });

  it("supports unicode identifiers", () => {
    expect(kinds("SELECT 이름 FROM 사람")[1]).toEqual(["identifier", "이름"]);
  });

  it("reports unterminated strings with a position", () => {
    expect(() => tokenize("SELECT 'oops")).toThrow(SqlSyntaxError);
    expect(() => tokenize("SELECT 'oops")).toThrow(/Unterminated string literal/);
  });

  it("rejects unexpected characters", () => {
    expect(() => tokenize("SELECT #")).toThrow(/Unexpected character '#'/);
  });

  it("rejects malformed numbers", () => {
    expect(() => tokenize("SELECT 12abc")).toThrow(/Invalid number literal/);
  });
});
