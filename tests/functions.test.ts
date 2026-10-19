import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { scalar } from "./helpers.js";

const db = new Database();
const value = (expr: string) => scalar(db, `SELECT ${expr}`);

describe("numeric functions", () => {
  it.each([
    ["ABS(-4)", 4],
    ["ROUND(2.5)", 3],
    ["ROUND(-2.5)", -3],
    ["ROUND(2.675, 2)", 2.68],
    ["ROUND(1234.5, -2)", 1200],
    ["CEIL(1.2)", 2],
    ["FLOOR(-1.2)", -2],
    ["TRUNC(-1.7)", -1],
    ["SQRT(16)", 4],
    ["SQRT(-1)", null],
    ["POWER(2, 10)", 1024],
    ["MOD(10, 3)", 1],
    ["MOD(1, 0)", null],
    ["SIGN(-3)", -1],
    ["LOG(100)", 2],
    ["LOG(2, 8)", 3],
    ["LN(1)", 0],
    ["GREATEST(1, 7, 3)", 7],
    ["LEAST('b', 'a', 'c')", "a"],
    ["GREATEST(1, NULL)", null],
  ])("%s = %j", (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it("returns random numbers", () => {
    expect(typeof value("RANDOM()")).toBe("number");
    const r = value("RAND()") as number;
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
  });
});

describe("string functions", () => {
  it.each([
    ["LENGTH('héllo')", 5],
    ["LENGTH('😀')", 1],
    ["UPPER('abc')", "ABC"],
    ["LOWER('ABC')", "abc"],
    ["TRIM('  x  ')", "x"],
    ["LTRIM('xxaxx', 'x')", "axx"],
    ["RTRIM('xxaxx', 'x')", "xxa"],
    ["SUBSTR('hello', 2, 3)", "ell"],
    ["SUBSTR('hello', 2)", "ello"],
    ["SUBSTR('hello', -3)", "llo"],
    ["SUBSTRING('hello', 1, 1)", null],
    ["REPLACE('a-b-c', '-', '+')", "a+b+c"],
    ["INSTR('hello', 'll')", 3],
    ["INSTR('hello', 'z')", 0],
    ["REVERSE('abc')", "cba"],
    ["REPEAT('ab', 3)", "ababab"],
    ["LEFT('hello', 2)", "he"],
    ["RIGHT('hello', 2)", "lo"],
    ["LPAD('7', 3, '0')", "007"],
    ["RPAD('ab', 4, '.')", "ab.."],
    ["CONCAT('a', NULL, 'b', 1)", "ab1"],
    ["CONCAT_WS('-', 'a', NULL, 'b')", "a-b"],
    ["PRINTF('%05.1f|%-4s|%d', 3.14159, 'ab', 42)", "003.1|ab  |42"],
    ["PRINTF('%x %X %o %%', 255, 255, 8)", "ff FF 10 %"],
    ["CHAR(72, 105)", "Hi"],
    ["UNICODE('A')", 65],
    ["HEX('AB')", "4142"],
  ])("%s = %j", (expr, expected) => {
    if (expr.startsWith("SUBSTRING")) {
      expect(() => value(expr)).toThrow(/Unknown function SUBSTRING/);
      return;
    }
    expect(value(expr)).toBe(expected);
  });
});

describe("conditional functions", () => {
  it.each([
    ["COALESCE(NULL, NULL, 3)", 3],
    ["COALESCE(NULL)", null],
    ["IFNULL(NULL, 'x')", "x"],
    ["NULLIF(1, 1)", null],
    ["NULLIF(1, 2)", 1],
    ["IIF(1 > 2, 'yes', 'no')", "no"],
    ["TYPEOF(1)", "integer"],
    ["TYPEOF(1.5)", "real"],
    ["TYPEOF('x')", "text"],
    ["TYPEOF(NULL)", "null"],
    ["TYPEOF(TRUE)", "boolean"],
  ])("%s = %j", (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it("does not evaluate unused COALESCE branches", () => {
    // The second argument would fail with a type error if evaluated.
    expect(value("COALESCE(1, (SELECT 1 UNION SELECT 2 ORDER BY 1 LIMIT 1))")).toBe(1);
  });

  it("validates argument counts", () => {
    expect(() => value("ABS()")).toThrow(/ABS\(\) takes 1 argument/);
    expect(() => value("NOSUCHFN(1)")).toThrow(/Unknown function NOSUCHFN/);
  });
});

describe("date functions", () => {
  it.each([
    ["DATE('2024-02-28', '+1 day')", "2024-02-29"],
    ["DATE('2024-01-31', '+1 month')", "2024-03-02"],
    ["DATE('2024-03-15', 'start of month')", "2024-03-01"],
    ["DATE('2024-03-15 10:20:30', 'start of year', '+1 year')", "2025-01-01"],
    ["DATETIME('2024-01-01 00:00:00', '+90 minutes')", "2024-01-01 01:30:00"],
    ["TIME('2024-01-01 13:14:15')", "13:14:15"],
    ["UNIXEPOCH('1970-01-02')", 86400],
    ["DATE(86400)", "1970-01-02"],
    ["STRFTIME('%Y/%m/%d %H:%M', '2024-07-04 09:05:00')", "2024/07/04 09:05"],
    ["STRFTIME('%j', '2024-02-01')", "032"],
    ["JULIANDAY('2000-01-01 12:00:00')", 2451545],
    ["DATE('not a date')", null],
    ["DATE('2024-01-01', 'bogus modifier')", null],
  ])("%s = %j", (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it("knows the current time", () => {
    expect(value("CURRENT_DATE")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value("CURRENT_TIMESTAMP")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(value("NOW()")).toMatch(/^\d{4}-/);
  });
});
