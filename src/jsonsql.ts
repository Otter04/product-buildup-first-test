/**
 * Compilation of JSON functions and the `->` / `->>` operators.
 *
 * SQLite marks values produced by JSON functions with a hidden "JSON subtype",
 * so `json_object('a', json_array(1, 2))` nests an array instead of the string
 * '[1,2]'. Here the same effect is achieved at compile time: an argument that
 * is itself a JSON-producing expression is compiled to yield a JSON tree.
 */
import type { BinaryExpr, Expr, FunctionCallExpr } from "./ast.js";
import type { Compiled, Env } from "./compiler.js";
import { SqlCatalogError, SqlRuntimeError } from "./errors.js";
import {
  arrowPath,
  edit,
  fromJsonNode,
  isValidJson,
  jsonTypeName,
  lookup,
  parseJson,
  parsePath,
  remove,
  stringifyJson,
  toJsonNode,
  type EditMode,
  type JsonNode,
} from "./json.js";
import { toText, type SqlValue } from "./values.js";

type NodeFn = (env: Env) => JsonNode | null;

/** Functions whose result is JSON text (and nests as JSON inside other JSON functions). */
const JSON_PRODUCERS = new Set([
  "JSON",
  "JSON_OBJECT",
  "JSON_ARRAY",
  "JSON_SET",
  "JSON_INSERT",
  "JSON_REPLACE",
  "JSON_REMOVE",
  "JSON_PATCH",
  "JSON_QUOTE",
  "JSON_GROUP_ARRAY",
  "JSON_GROUP_OBJECT",
]);

/** Scalar JSON functions handled by {@link compileJsonCall}, with their arities. */
export const JSON_SCALARS: Record<string, { min: number; max: number }> = {
  JSON: { min: 1, max: 1 },
  JSON_OBJECT: { min: 0, max: Infinity },
  JSON_ARRAY: { min: 0, max: Infinity },
  JSON_EXTRACT: { min: 2, max: Infinity },
  JSON_SET: { min: 3, max: Infinity },
  JSON_INSERT: { min: 3, max: Infinity },
  JSON_REPLACE: { min: 3, max: Infinity },
  JSON_REMOVE: { min: 1, max: Infinity },
  JSON_PATCH: { min: 2, max: 2 },
  JSON_QUOTE: { min: 1, max: 1 },
  JSON_TYPE: { min: 1, max: 2 },
  JSON_VALID: { min: 1, max: 1 },
  JSON_ARRAY_LENGTH: { min: 1, max: 2 },
};

/** Whether an expression yields JSON that should be embedded (not quoted) by JSON constructors. */
export function isJsonProducer(expr: Expr): boolean {
  if (expr.kind === "binary") return expr.op === "->";
  if (expr.kind !== "function" || expr.over) return false;
  if (JSON_PRODUCERS.has(expr.name)) return true;
  // json_extract with one path behaves like `->` when nested.
  return expr.name === "JSON_EXTRACT" && expr.args.length === 2;
}

type CompileFn = (expr: Expr) => Compiled;

/** Parses a JSON input value; SQL NULL stays null. */
function inputNode(v: SqlValue): JsonNode | null {
  if (v === null) return null;
  if (typeof v === "string") return parseJson(v);
  return toJsonNode(v);
}

function pathOf(v: SqlValue): ReturnType<typeof parsePath> | null {
  if (v === null) return null;
  return parsePath(toText(v)!);
}

/**
 * Compiles an expression to a function producing a JSON tree, for use as an
 * argument of a JSON constructor. Non-JSON expressions are converted from
 * their SQL value (text becomes a JSON string).
 */
export function compileJsonNode(expr: Expr, compile: CompileFn): NodeFn {
  if (isJsonProducer(expr)) {
    if (expr.kind === "binary") return compileArrowNode(expr, compile);
    const call = expr as FunctionCallExpr;
    if (call.name === "JSON_EXTRACT") {
      const doc = compileJsonInput(call.args[0]!, compile);
      const path = compile(call.args[1]!);
      return (env) => {
        const root = doc(env);
        const steps = pathOf(path(env));
        if (!root || !steps) return { type: "null" };
        return lookup(root, steps) ?? { type: "null" };
      };
    }
    if (call.name === "JSON_GROUP_ARRAY" || call.name === "JSON_GROUP_OBJECT") {
      // Aggregate results arrive as JSON text.
      const value = compile(call);
      return (env) => {
        const v = value(env);
        return v === null ? null : parseJson(String(v));
      };
    }
    return compileNodeCall(call, compile);
  }
  const value = compile(expr);
  return (env) => toJsonNode(value(env));
}

/** A JSON document argument: JSON-producing expressions pass their tree, anything else is parsed. */
function compileJsonInput(expr: Expr, compile: CompileFn): NodeFn {
  if (isJsonProducer(expr)) return compileJsonNode(expr, compile);
  const value = compile(expr);
  return (env) => inputNode(value(env));
}

function compileArrowNode(expr: BinaryExpr, compile: CompileFn): NodeFn {
  const doc = compileJsonInput(expr.left, compile);
  const path = compile(expr.right);
  return (env) => {
    const root = doc(env);
    const p = path(env);
    if (!root || p === null) return null;
    return lookup(root, parsePath(arrowPath(p))) ?? null;
  };
}

/** Compiles a JSON-producing function call to return its tree. */
function compileNodeCall(call: FunctionCallExpr, compile: CompileFn): NodeFn {
  const args = call.args;
  switch (call.name) {
    case "JSON": {
      const doc = compileJsonInput(args[0]!, compile);
      return (env) => doc(env);
    }
    case "JSON_QUOTE": {
      const value = compileJsonNode(args[0]!, compile);
      return (env) => value(env);
    }
    case "JSON_ARRAY": {
      const items = args.map((a) => compileJsonNode(a, compile));
      return (env) => ({ type: "array", items: items.map((i) => i(env) ?? { type: "null" }) });
    }
    case "JSON_OBJECT": {
      if (args.length % 2) throw new SqlRuntimeError("json_object() requires an even number of arguments");
      const keys: Compiled[] = [];
      const values: NodeFn[] = [];
      for (let i = 0; i < args.length; i += 2) {
        keys.push(compile(args[i]!));
        values.push(compileJsonNode(args[i + 1]!, compile));
      }
      return (env) => {
        const entries: [string, JsonNode][] = [];
        keys.forEach((k, i) => {
          const key = k(env);
          if (typeof key !== "string") throw new SqlRuntimeError("json_object() labels must be TEXT");
          entries.push([key, values[i]!(env) ?? { type: "null" }]);
        });
        return { type: "object", entries };
      };
    }
    case "JSON_SET":
    case "JSON_INSERT":
    case "JSON_REPLACE": {
      if (args.length % 2 === 0) throw new SqlRuntimeError(`${call.name.toLowerCase()}() needs a document and path/value pairs`);
      const mode = call.name.slice(5).toLowerCase() as EditMode;
      const doc = compileJsonInput(args[0]!, compile);
      const pairs: { path: Compiled; value: NodeFn }[] = [];
      for (let i = 1; i < args.length; i += 2) pairs.push({ path: compile(args[i]!), value: compileJsonNode(args[i + 1]!, compile) });
      return (env) => {
        let root = doc(env);
        if (!root) return null;
        for (const p of pairs) {
          const steps = pathOf(p.path(env));
          if (!steps) return null;
          root = edit(root, steps, p.value(env) ?? { type: "null" }, mode);
        }
        return root;
      };
    }
    case "JSON_REMOVE": {
      const doc = compileJsonInput(args[0]!, compile);
      const paths = args.slice(1).map((a) => compile(a));
      return (env) => {
        let root: JsonNode | undefined | null = doc(env);
        for (const p of paths) {
          if (!root) break;
          const steps = pathOf(p(env));
          if (!steps) return null;
          root = remove(root, steps);
        }
        return root ?? null;
      };
    }
    case "JSON_PATCH": {
      const target = compileJsonInput(args[0]!, compile);
      const patch = compileJsonInput(args[1]!, compile);
      return (env) => {
        const t = target(env);
        const p = patch(env);
        if (!t || !p) return null;
        return mergePatch(t, p);
      };
    }
  }
  throw new SqlCatalogError(`Unknown JSON function ${call.name}()`);
}

/** RFC 7396 merge patch, as implemented by json_patch(). */
function mergePatch(target: JsonNode, patch: JsonNode): JsonNode {
  if (patch.type !== "object") return patch;
  const entries: [string, JsonNode][] = target.type === "object" ? target.entries.slice() : [];
  for (const [key, value] of patch.entries) {
    const idx = entries.findIndex(([k]) => k === key);
    if (value.type === "null") {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = [key, mergePatch(entries[idx]![1], value)];
    } else {
      entries.push([key, mergePatch({ type: "null" }, value)]);
    }
  }
  return { type: "object", entries };
}

/** Compiles a JSON scalar function call to return its SQL value. */
export function compileJsonCall(call: FunctionCallExpr, compile: CompileFn): Compiled {
  const arity = JSON_SCALARS[call.name]!;
  if (call.args.length < arity.min || call.args.length > arity.max) {
    throw new SqlCatalogError(`${call.name}() takes ${arity.max === Infinity ? `at least ${arity.min}` : arity.min === arity.max ? arity.min : `${arity.min} to ${arity.max}`} argument(s), got ${call.args.length}`);
  }
  const args = call.args;
  switch (call.name) {
    case "JSON_EXTRACT": {
      const doc = compileJsonInput(args[0]!, compile);
      const paths = args.slice(1).map((a) => compile(a));
      if (paths.length === 1) {
        const path = paths[0]!;
        return (env) => {
          const root = doc(env);
          const steps = pathOf(path(env));
          if (!root || !steps) return null;
          const node = lookup(root, steps);
          return node ? fromJsonNode(node) : null;
        };
      }
      // Several paths: a JSON array of the results.
      return (env) => {
        const root = doc(env);
        if (!root) return null;
        const items: JsonNode[] = [];
        for (const p of paths) {
          const steps = pathOf(p(env));
          if (!steps) return null;
          items.push(lookup(root, steps) ?? { type: "null" });
        }
        return stringifyJson({ type: "array", items });
      };
    }
    case "JSON_TYPE": {
      const doc = compileJsonInput(args[0]!, compile);
      const path = args[1] ? compile(args[1]) : undefined;
      return (env) => {
        const root = doc(env);
        if (!root) return null;
        if (!path) return jsonTypeName(root);
        const steps = pathOf(path(env));
        if (!steps) return null;
        const node = lookup(root, steps);
        return node ? jsonTypeName(node) : null;
      };
    }
    case "JSON_VALID": {
      const value = compile(args[0]!);
      const producer = isJsonProducer(args[0]!);
      return (env) => {
        const v = value(env);
        if (v === null) return null;
        if (producer) return true;
        return typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && isValidJson(v);
      };
    }
    case "JSON_ARRAY_LENGTH": {
      const doc = compileJsonInput(args[0]!, compile);
      const path = args[1] ? compile(args[1]) : undefined;
      return (env) => {
        let node: JsonNode | null | undefined = doc(env);
        if (!node) return null;
        if (path) {
          const steps = pathOf(path(env));
          if (!steps) return null;
          node = lookup(node, steps);
          if (!node) return null;
        }
        return node.type === "array" ? node.items.length : 0;
      };
    }
  }
  // Everything else produces JSON text.
  const node = compileNodeCall(call, compile);
  return (env) => {
    const n = node(env);
    return n ? stringifyJson(n) : null;
  };
}

/** Compiles `doc -> path` (JSON text) or `doc ->> path` (SQL value). */
export function compileArrow(expr: BinaryExpr, compile: CompileFn): Compiled {
  const node = compileArrowNode(expr, compile);
  if (expr.op === "->") {
    return (env) => {
      const n = node(env);
      return n ? stringifyJson(n) : null;
    };
  }
  return (env) => {
    const n = node(env);
    return n ? fromJsonNode(n) : null;
  };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** json_group_array(x): collects values (JSON-producing arguments are nested as JSON). */
export class JsonGroupArray {
  private readonly items: JsonNode[] = [];
  constructor(private readonly jsonArg: boolean) {}
  step([v]: SqlValue[]): void {
    this.items.push(v === null ? { type: "null" } : this.jsonArg && typeof v === "string" ? parseJson(v) : toJsonNode(v ?? null));
  }
  result(): SqlValue {
    return stringifyJson({ type: "array", items: this.items });
  }
}

/** json_group_object(key, value). */
export class JsonGroupObject {
  private readonly entries: [string, JsonNode][] = [];
  constructor(private readonly jsonArg: boolean) {}
  step([k, v]: SqlValue[]): void {
    if (k === null || k === undefined) throw new SqlRuntimeError("json_group_object() labels must not be NULL");
    const value = v === null || v === undefined ? ({ type: "null" } as JsonNode) : this.jsonArg && typeof v === "string" ? parseJson(v) : toJsonNode(v);
    this.entries.push([toText(k)!, value]);
  }
  result(): SqlValue {
    return stringifyJson({ type: "object", entries: this.entries });
  }
}

