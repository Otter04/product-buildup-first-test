/**
 * JSON support modelled on SQLite's JSON1 extension. Documents are parsed
 * into a small tree that keeps number lexemes, so `1` and `1.0` keep their
 * integer / real distinction and minified output reproduces them exactly.
 */
import { SqlRuntimeError } from "./errors.js";
import { formatNumber, type SqlValue } from "./values.js";

export type JsonNode =
  | { type: "null" }
  | { type: "true" }
  | { type: "false" }
  | { type: "integer" | "real"; value: number; raw: string }
  | { type: "text"; value: string }
  | { type: "array"; items: JsonNode[] }
  | { type: "object"; entries: [string, JsonNode][] };

export class JsonError extends SqlRuntimeError {}

// ---------------------------------------------------------------------------
// Parsing and serialization
// ---------------------------------------------------------------------------

class JsonParser {
  private pos = 0;

  constructor(private readonly text: string) {}

  parse(): JsonNode {
    const node = this.value();
    this.ws();
    if (this.pos < this.text.length) this.fail();
    return node;
  }

  private fail(): never {
    throw new JsonError("malformed JSON");
  }

  private ws(): void {
    while (this.pos < this.text.length && /[ \t\n\r]/.test(this.text[this.pos]!)) this.pos++;
  }

  private value(): JsonNode {
    this.ws();
    const ch = this.text[this.pos];
    if (ch === "{") return this.object();
    if (ch === "[") return this.array();
    if (ch === '"') return { type: "text", value: this.string() };
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.number();
    for (const [word, node] of [
      ["true", { type: "true" }],
      ["false", { type: "false" }],
      ["null", { type: "null" }],
    ] as const) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return node;
      }
    }
    return this.fail();
  }

  private object(): JsonNode {
    this.pos++;
    const entries: [string, JsonNode][] = [];
    this.ws();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return { type: "object", entries };
    }
    for (;;) {
      this.ws();
      if (this.text[this.pos] !== '"') this.fail();
      const key = this.string();
      this.ws();
      if (this.text[this.pos++] !== ":") this.fail();
      entries.push([key, this.value()]);
      this.ws();
      const sep = this.text[this.pos++];
      if (sep === "}") return { type: "object", entries };
      if (sep !== ",") this.fail();
    }
  }

  private array(): JsonNode {
    this.pos++;
    const items: JsonNode[] = [];
    this.ws();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return { type: "array", items };
    }
    for (;;) {
      items.push(this.value());
      this.ws();
      const sep = this.text[this.pos++];
      if (sep === "]") return { type: "array", items };
      if (sep !== ",") this.fail();
    }
  }

  private string(): string {
    const start = this.pos;
    this.pos++;
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length) this.fail();
      const ch = this.text[this.pos++]!;
      if (ch === '"') break;
      if (ch < " ") this.fail();
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = this.text[this.pos++];
      switch (esc) {
        case '"':
        case "\\":
        case "/":
          out += esc;
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "n":
          out += "\n";
          break;
        case "r":
          out += "\r";
          break;
        case "t":
          out += "\t";
          break;
        case "u": {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail();
      }
    }
    void start;
    return out;
  }

  private number(): JsonNode {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!m) this.fail();
    this.pos += m[0].length;
    const isReal = m[2] !== undefined || m[3] !== undefined;
    return { type: isReal ? "real" : "integer", value: Number(m[0]), raw: m[0] };
  }
}

export function parseJson(text: string): JsonNode {
  return new JsonParser(text).parse();
}

export function isValidJson(text: string): boolean {
  try {
    parseJson(text);
    return true;
  } catch {
    return false;
  }
}

function quote(s: string): string {
  // JSON.stringify escapes exactly what JSON requires.
  return JSON.stringify(s);
}

/** Minified JSON text of a node. */
export function stringifyJson(node: JsonNode): string {
  switch (node.type) {
    case "null":
    case "true":
    case "false":
      return node.type;
    case "integer":
    case "real":
      return node.raw;
    case "text":
      return quote(node.value);
    case "array":
      return `[${node.items.map(stringifyJson).join(",")}]`;
    case "object":
      return `{${node.entries.map(([k, v]) => `${quote(k)}:${stringifyJson(v)}`).join(",")}}`;
  }
}

// ---------------------------------------------------------------------------
// Conversions between SQL values and JSON nodes
// ---------------------------------------------------------------------------

function numberNode(n: number): JsonNode {
  if (!Number.isFinite(n)) throw new JsonError("cannot represent a non-finite number in JSON");
  const raw = Number.isInteger(n) ? formatNumber(n) : String(n);
  return { type: Number.isInteger(n) ? "integer" : "real", value: n, raw };
}

/**
 * Converts a SQL value to JSON. Text is a JSON string unless `isJson` says it
 * came from a JSON-producing expression (SQLite's "JSON subtype"), in which
 * case it is embedded as parsed JSON.
 */
export function toJsonNode(v: SqlValue, isJson = false): JsonNode {
  if (v === null) return { type: "null" };
  if (typeof v === "boolean") return { type: v ? "true" : "false" };
  if (typeof v === "number") return numberNode(v);
  return isJson ? parseJson(v) : { type: "text", value: v };
}

/** The SQL value of a JSON node, as returned by `json_extract` and `->>`. */
export function fromJsonNode(node: JsonNode): SqlValue {
  switch (node.type) {
    case "null":
      return null;
    case "true":
      return true;
    case "false":
      return false;
    case "integer":
    case "real":
      return node.value;
    case "text":
      return node.value;
    default:
      return stringifyJson(node);
  }
}

/** The JSON type name reported by `json_type`. */
export function jsonTypeName(node: JsonNode): string {
  return node.type;
}

// ---------------------------------------------------------------------------
// Paths: $, .key, ."quoted key", [n], [#], [#-n]
// ---------------------------------------------------------------------------

type PathStep = { kind: "key"; key: string } | { kind: "index"; index: number; fromEnd: boolean };

const pathCache = new Map<string, PathStep[]>();

export function parsePath(path: string): PathStep[] {
  const cached = pathCache.get(path);
  if (cached) return cached;
  if (!path.startsWith("$")) throw new JsonError(`JSON path must start with '$': ${path}`);
  const steps: PathStep[] = [];
  let i = 1;
  const bad = (): never => {
    throw new JsonError(`bad JSON path: ${path}`);
  };
  while (i < path.length) {
    const ch = path[i]!;
    if (ch === ".") {
      i++;
      if (path[i] === '"') {
        const end = path.indexOf('"', i + 1);
        if (end < 0) bad();
        steps.push({ kind: "key", key: path.slice(i + 1, end) });
        i = end + 1;
      } else {
        let j = i;
        while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
        if (j === i) bad();
        steps.push({ kind: "key", key: path.slice(i, j) });
        i = j;
      }
    } else if (ch === "[") {
      const end = path.indexOf("]", i);
      if (end < 0) bad();
      const inner = path.slice(i + 1, end).trim();
      if (/^\d+$/.test(inner)) steps.push({ kind: "index", index: Number(inner), fromEnd: false });
      else if (inner === "#") steps.push({ kind: "index", index: 0, fromEnd: true });
      else {
        const m = /^#\s*-\s*(\d+)$/.exec(inner);
        if (!m) bad();
        steps.push({ kind: "index", index: Number(m![1]), fromEnd: true });
      }
      i = end + 1;
    } else {
      bad();
    }
  }
  if (pathCache.size > 500) pathCache.clear();
  pathCache.set(path, steps);
  return steps;
}

function resolveIndex(step: Extract<PathStep, { kind: "index" }>, length: number): number {
  return step.fromEnd ? length - step.index : step.index;
}

/** Follows a path; returns undefined when it does not exist. */
export function lookup(node: JsonNode, steps: PathStep[]): JsonNode | undefined {
  let cur: JsonNode | undefined = node;
  for (const step of steps) {
    if (!cur) return undefined;
    if (step.kind === "key") {
      if (cur.type !== "object") return undefined;
      // Duplicate keys: the first one wins, like SQLite.
      cur = cur.entries.find(([k]) => k === step.key)?.[1];
    } else {
      if (cur.type !== "array") return undefined;
      cur = cur.items[resolveIndex(step, cur.items.length)];
    }
  }
  return cur;
}

export type EditMode = "set" | "insert" | "replace";

/**
 * Returns a copy of `root` with `value` written at `steps`. `insert` only
 * creates, `replace` only overwrites, `set` does both. Missing parents are not created.
 */
export function edit(root: JsonNode, steps: PathStep[], value: JsonNode, mode: EditMode): JsonNode {
  if (steps.length === 0) return mode === "insert" ? root : value;
  const [step, ...rest] = steps as [PathStep, ...PathStep[]];
  if (step.kind === "key") {
    if (root.type !== "object") return root;
    const idx = root.entries.findIndex(([k]) => k === step.key);
    if (idx >= 0) {
      const entries = root.entries.slice();
      entries[idx] = [step.key, edit(entries[idx]![1], rest, value, mode)];
      return { type: "object", entries };
    }
    if (rest.length || mode === "replace") return root;
    return { type: "object", entries: [...root.entries, [step.key, value]] };
  }
  if (root.type !== "array") return root;
  const index = resolveIndex(step, root.items.length);
  if (index >= 0 && index < root.items.length) {
    const items = root.items.slice();
    items[index] = edit(items[index]!, rest, value, mode);
    return { type: "array", items };
  }
  // Appending is allowed at exactly the end of the array (e.g. `$[#]`).
  if (index === root.items.length && !rest.length && mode !== "replace") return { type: "array", items: [...root.items, value] };
  return root;
}

/** Returns a copy of `root` without the element at `steps` (unchanged if absent). */
export function remove(root: JsonNode, steps: PathStep[]): JsonNode | undefined {
  if (steps.length === 0) return undefined;
  const [step, ...rest] = steps as [PathStep, ...PathStep[]];
  if (step.kind === "key") {
    if (root.type !== "object") return root;
    const idx = root.entries.findIndex(([k]) => k === step.key);
    if (idx < 0) return root;
    const entries = root.entries.slice();
    if (rest.length) {
      const child = remove(entries[idx]![1], rest);
      entries[idx] = [step.key, child ?? entries[idx]![1]];
    } else {
      entries.splice(idx, 1);
    }
    return { type: "object", entries };
  }
  if (root.type !== "array") return root;
  const index = resolveIndex(step, root.items.length);
  if (index < 0 || index >= root.items.length) return root;
  const items = root.items.slice();
  if (rest.length) items[index] = remove(items[index]!, rest) ?? items[index]!;
  else items.splice(index, 1);
  return { type: "array", items };
}

/**
 * The right-hand side of `->` / `->>`: a full path, or a shorthand object
 * label (`'name'` → `$.name`) or array index (`2` → `$[2]`).
 */
export function arrowPath(v: SqlValue): string {
  if (typeof v === "number") return Number.isInteger(v) && v < 0 ? `$[#${v}]` : `$[${v}]`;
  const s = String(v);
  if (s.startsWith("$")) return s;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? `$.${s}` : `$."${s}"`;
}

/** Iterates the elements of a JSON container for json_each / json_tree. */
export interface JsonEachRow {
  key: SqlValue;
  value: SqlValue;
  type: string;
  atom: SqlValue;
  id: number;
  parent: number | null;
  fullkey: string;
  path: string;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}."${key}"`;
}

function isAtom(node: JsonNode): boolean {
  return node.type !== "array" && node.type !== "object";
}

/** Rows of `json_each` (recursive = false) or `json_tree` (recursive = true). */
export function jsonEach(root: JsonNode, rootPath: string, recursive: boolean): JsonEachRow[] {
  const rows: JsonEachRow[] = [];
  let nextId = 0;
  const visit = (node: JsonNode, key: SqlValue, fullkey: string, path: string, parent: number | null): void => {
    const id = nextId++;
    rows.push({
      key,
      value: fromJsonNode(node),
      type: node.type,
      atom: isAtom(node) ? fromJsonNode(node) : null,
      id,
      parent,
      fullkey,
      path,
    });
    if (!recursive) return;
    if (node.type === "array") node.items.forEach((child, i) => visit(child, i, childPath(fullkey, i), fullkey, id));
    if (node.type === "object") for (const [k, child] of node.entries) visit(child, k, childPath(fullkey, k), fullkey, id);
  };

  if (recursive) {
    const lastKey = rootPath.match(/(?:\.([^.[\]]+)|\[(\d+)\])$/);
    const key: SqlValue = lastKey ? (lastKey[2] !== undefined ? Number(lastKey[2]) : lastKey[1]!.replace(/^"|"$/g, "")) : null;
    const parentPath = lastKey ? rootPath.slice(0, rootPath.length - lastKey[0].length) || "$" : "$";
    visit(root, key, rootPath, parentPath, null);
    return rows;
  }
  if (root.type === "array") {
    root.items.forEach((child, i) => {
      rows.push({
        key: i,
        value: fromJsonNode(child),
        type: child.type,
        atom: isAtom(child) ? fromJsonNode(child) : null,
        id: nextId++,
        parent: null,
        fullkey: childPath(rootPath, i),
        path: rootPath,
      });
    });
  } else if (root.type === "object") {
    for (const [k, child] of root.entries) {
      rows.push({
        key: k,
        value: fromJsonNode(child),
        type: child.type,
        atom: isAtom(child) ? fromJsonNode(child) : null,
        id: nextId++,
        parent: null,
        fullkey: childPath(rootPath, k),
        path: rootPath,
      });
    }
  } else {
    // A scalar document yields a single row with a NULL key.
    rows.push({ key: null, value: fromJsonNode(root), type: root.type, atom: fromJsonNode(root), id: nextId++, parent: null, fullkey: rootPath, path: rootPath });
  }
  return rows;
}
