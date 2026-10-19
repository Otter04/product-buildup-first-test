import { Database, Parser, SqlError, SqlSyntaxError, formatValue } from "./lib/index.js";
import { DATASETS } from "./datasets.js";

const $ = (id) => document.getElementById(id);
const editor = $("editor");
const resultsEl = $("results");
const statusEl = $("status");
const datasetSelect = $("dataset");
const exampleSelect = $("example");

const MAX_ROWS_SHOWN = 500;
const STORAGE_KEY = "minisql-playground";

let db = new Database();
let dataset = DATASETS[0];

// ---------------------------------------------------------------------------
// Persistence of the editor contents (per viewer, best effort)
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ dataset: dataset.id, sql: editor.value }));
  } catch {
    // Storage may be unavailable (private mode); the playground works without it.
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function renderTable(columns, rows) {
  const table = el("table");
  const numeric = columns.map((_, i) => rows.some((r) => typeof r[i] === "number") && rows.every((r) => r[i] === null || typeof r[i] === "number"));
  const head = el("tr", {}, columns.map((c, i) => el("th", { class: numeric[i] ? "num" : "", text: c })));
  table.append(el("thead", {}, head));
  const body = el("tbody");
  for (const row of rows.slice(0, MAX_ROWS_SHOWN)) {
    const tr = el("tr");
    row.forEach((value, i) => {
      const cls = [numeric[i] ? "num" : "", value === null ? "null" : ""].filter(Boolean).join(" ");
      tr.append(el("td", { class: cls, text: formatValue(value) }));
    });
    body.append(tr);
  }
  table.append(body);
  return table;
}

function summarize(sql) {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? oneLine.slice(0, 87) + "…" : oneLine;
}

function describe(result) {
  switch (result.type) {
    case "insert":
      return `${result.changes} row${result.changes === 1 ? "" : "s"} inserted`;
    case "update":
      return `${result.changes} row${result.changes === 1 ? "" : "s"} updated`;
    case "delete":
      return `${result.changes} row${result.changes === 1 ? "" : "s"} deleted`;
    case "createTable":
      return "Table created";
    case "createView":
      return "View created";
    case "createIndex":
      return "Index created";
    case "dropTable":
    case "dropView":
    case "dropIndex":
      return "Dropped";
    case "alterTable":
      return "Table altered";
    case "begin":
      return "Transaction started";
    case "commit":
      return "Transaction committed";
    case "rollback":
      return "Transaction rolled back";
    default:
      return "OK";
  }
}

function resultCard(sql, ms, body, meta) {
  const head = el("div", { class: "result-head" }, [el("code", { text: summarize(sql) }), el("span", { class: "meta", text: meta ?? `${ms.toFixed(2)} ms` })]);
  return el("div", { class: "result" }, [head, el("div", { class: "result-body" }, body)]);
}

// ---------------------------------------------------------------------------
// Running SQL
// ---------------------------------------------------------------------------

/** Runs each statement in turn so earlier results stay visible when a later one fails. */
function run(sql, { mode } = {}) {
  resultsEl.replaceChildren();
  const started = performance.now();
  let count = 0;
  try {
    if (mode) {
      // Run everything but the last statement, then explain the last one.
      const statements = [...new Parser(sql).statements()];
      const last = statements.pop();
      for (const { statement } of statements) db.executeStatement(statement);
      if (last) {
        runOne((mode === "analyze" ? "EXPLAIN ANALYZE " : "EXPLAIN ") + last.text);
        count = 1;
      }
    } else {
      // Statements are parsed lazily, so the ones before a syntax error still run.
      for (const { statement, text } of new Parser(sql).statements()) {
        const t = performance.now();
        const result = db.executeStatement(statement);
        renderResult(text, result, performance.now() - t);
        count++;
      }
    }
    if (count === 0) resultsEl.append(el("p", { class: "message", text: "Nothing to run." }));
  } catch (e) {
    renderError(e);
  }
  statusEl.textContent = `${count} statement${count === 1 ? "" : "s"} · ${(performance.now() - started).toFixed(1)} ms${db.inTransaction ? " · transaction open" : ""}`;
  renderSchema();
  saveState();
}

function runOne(sql) {
  const t = performance.now();
  const [result] = db.exec(sql);
  renderResult(sql, result, performance.now() - t);
}

function renderResult(sql, result, ms) {
  if (result.type === "explain") {
    resultsEl.append(resultCard(sql, ms, el("pre", { class: "plan", text: result.rows.map((r) => r[0]).join("\n") })));
    return;
  }
  if (result.columns.length) {
    const shown = Math.min(result.rows.length, MAX_ROWS_SHOWN);
    const meta = `${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${shown < result.rows.length ? ` (first ${shown} shown)` : ""} · ${ms.toFixed(2)} ms`;
    const body = result.rows.length ? renderTable(result.columns, result.rows) : el("p", { class: "message", text: "No rows." });
    resultsEl.append(resultCard(sql, ms, body, meta));
    return;
  }
  resultsEl.append(resultCard(sql, ms, el("p", { class: "message ok", text: describe(result) })));
}

function renderError(e) {
  const message = e instanceof SqlError ? e.message : `Internal error: ${e?.message ?? e}`;
  const card = el("div", { class: "result" }, [el("p", { class: "message error", text: message })]);
  resultsEl.append(card);
  if (e instanceof SqlSyntaxError) highlightPosition(e.line, e.column);
  if (!(e instanceof SqlError)) console.error(e);
}

/** Moves the editor caret to the reported error position. */
function highlightPosition(line, column) {
  const lines = editor.value.split("\n");
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  offset += column - 1;
  editor.focus();
  editor.setSelectionRange(offset, offset + 1);
}

// ---------------------------------------------------------------------------
// Schema sidebar
// ---------------------------------------------------------------------------

function renderSchema() {
  const container = $("schema");
  container.replaceChildren();
  let entries;
  try {
    entries = db.exec("SHOW TABLES")[0].rows;
  } catch {
    return;
  }
  if (!entries.length) {
    container.append(el("p", { class: "hint", text: "No tables yet." }));
    return;
  }
  for (const [name, type, , rowCount] of entries) {
    const header = el("button", { title: `SELECT * FROM ${name}` }, [
      el("span", { text: `${name}${type === "view" ? " (view)" : ""}` }),
      el("span", { class: "count", text: rowCount === null ? "" : `${rowCount} rows` }),
    ]);
    header.addEventListener("click", () => {
      editor.value = `SELECT * FROM ${name} LIMIT 100;`;
      run(editor.value);
    });
    const list = el("ul");
    for (const [column, colType, , key] of db.exec(`DESCRIBE "${name}"`)[0].rows) {
      const label = el("span", { text: column });
      if (key === "PRI") label.append(el("span", { class: "badge", text: "PK" }));
      else if (key === "UNI") label.append(el("span", { class: "badge", text: "UQ" }));
      list.append(el("li", {}, [label, el("span", { class: "type", text: colType === "ANY" ? "" : colType.toLowerCase() })]));
    }
    container.append(el("div", { class: "table-card" }, [header, list]));
  }
}

// ---------------------------------------------------------------------------
// Datasets and examples
// ---------------------------------------------------------------------------

function loadDataset(id, { keepEditor = false } = {}) {
  dataset = DATASETS.find((d) => d.id === id) ?? DATASETS[0];
  datasetSelect.value = dataset.id;
  db = new Database();
  if (dataset.setup) db.exec(dataset.setup);
  exampleSelect.replaceChildren(...dataset.examples.map((ex, i) => el("option", { value: String(i), text: ex.title })));
  if (!keepEditor && dataset.examples.length) {
    editor.value = dataset.examples[0].sql;
    run(editor.value);
  } else {
    renderSchema();
    resultsEl.replaceChildren(el("p", { class: "message", text: dataset.description }));
  }
}

datasetSelect.replaceChildren(...DATASETS.map((d) => el("option", { value: d.id, text: d.name })));
datasetSelect.addEventListener("change", () => loadDataset(datasetSelect.value));
exampleSelect.addEventListener("change", () => {
  const example = dataset.examples[Number(exampleSelect.value)];
  if (!example) return;
  editor.value = example.sql;
  run(editor.value);
});
$("reset").addEventListener("click", () => loadDataset(dataset.id, { keepEditor: true }));
$("run").addEventListener("click", () => run(editor.value));
$("explain").addEventListener("click", () => run(editor.value, { mode: "explain" }));
$("analyze").addEventListener("click", () => run(editor.value, { mode: "analyze" }));

editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    run(editor.value);
  } else if (e.key === "Tab" && !e.shiftKey) {
    // Indent instead of leaving the editor.
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end } = editor;
    editor.setRangeText("  ", start, end, "end");
  }
});
editor.addEventListener("input", saveState);

const saved = loadState();
if (saved.dataset && saved.sql) {
  loadDataset(saved.dataset, { keepEditor: true });
  editor.value = saved.sql;
  run(editor.value);
} else {
  loadDataset(DATASETS[0].id);
}
