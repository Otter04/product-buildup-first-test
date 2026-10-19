// Micro-benchmarks for minisql. Run with `npm run bench` (builds first).
// When node:sqlite is available, the same workloads run on SQLite as a reference.
import { createRequire } from "node:module";
import { Database } from "../dist/index.js";

let DatabaseSync;
try {
  process.removeAllListeners("warning");
  DatabaseSync = createRequire(import.meta.url)("node:sqlite").DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

const N = Number(process.env.BENCH_ROWS ?? 50_000);
const CUSTOMERS = Math.max(10, Math.floor(N / 10));

/** Deterministic pseudo-random numbers so both engines see the same data. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA = `
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, country TEXT);
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT, day INTEGER);
`;
const COUNTRIES = ["US", "UK", "DE", "FR", "KR", "JP", "BR", "IN"];
const STATUSES = ["new", "paid", "shipped", "returned"];

/** Adapters give both engines the same tiny interface. */
function minisqlAdapter() {
  const db = new Database();
  return {
    name: "minisql",
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return { run: (p) => stmt.run(p), all: (p) => stmt.values(p) };
    },
  };
}

function sqliteAdapter() {
  const db = new DatabaseSync(":memory:");
  return {
    name: "sqlite",
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return { run: (p) => stmt.run(...p), all: (p) => stmt.all(...p) };
    },
  };
}

function time(fn) {
  const start = performance.now();
  const ops = fn();
  return { ms: performance.now() - start, ops };
}

function load(db) {
  db.exec(SCHEMA);
  const random = rng(42);
  return time(() => {
    db.exec("BEGIN");
    const c = db.prepare("INSERT INTO customers (id, name, country) VALUES (?, ?, ?)");
    for (let i = 1; i <= CUSTOMERS; i++) c.run([i, `customer-${i}`, COUNTRIES[Math.floor(random() * COUNTRIES.length)]]);
    const o = db.prepare("INSERT INTO orders (id, customer_id, amount, status, day) VALUES (?, ?, ?, ?, ?)");
    for (let i = 1; i <= N; i++) {
      o.run([i, 1 + Math.floor(random() * CUSTOMERS), Math.round(random() * 50000) / 100, STATUSES[Math.floor(random() * 4)], Math.floor(random() * 365)]);
    }
    db.exec("COMMIT");
    return CUSTOMERS + N;
  });
}

const WORKLOADS = [
  {
    name: "point lookup by primary key",
    run: (db) => {
      const stmt = db.prepare("SELECT amount FROM orders WHERE id = ?");
      const random = rng(1);
      const n = Math.min(N, 20_000);
      for (let i = 0; i < n; i++) stmt.all([1 + Math.floor(random() * N)]);
      return n;
    },
  },
  {
    name: "full scan with filter",
    run: (db) => {
      const stmt = db.prepare("SELECT COUNT(*) FROM orders WHERE amount > ? AND status = 'paid'");
      for (let i = 0; i < 20; i++) stmt.all([i * 10]);
      return 20;
    },
  },
  {
    name: "secondary index range scan",
    setup: (db) => db.exec("CREATE INDEX idx_orders_day ON orders (day)"),
    run: (db) => {
      const stmt = db.prepare("SELECT SUM(amount) FROM orders WHERE day BETWEEN ? AND ?");
      for (let i = 0; i < 200; i++) stmt.all([i, i + 7]);
      return 200;
    },
  },
  {
    name: "join + group by (index nested loop)",
    setup: (db) => db.exec("CREATE INDEX idx_orders_customer ON orders (customer_id)"),
    run: (db) => {
      db.prepare(
        "SELECT c.country, COUNT(*), SUM(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.country",
      ).all([]);
      return 1;
    },
  },
  {
    name: "join on unindexed column (hash join)",
    run: (db) => {
      db.prepare("SELECT COUNT(*) FROM orders a JOIN orders b ON a.day = b.day AND a.status = b.status WHERE a.id < 2000").all([]);
      return 1;
    },
  },
  {
    name: "group by + order by",
    run: (db) => {
      db.prepare("SELECT customer_id, COUNT(*) AS n, AVG(amount) FROM orders GROUP BY customer_id ORDER BY n DESC LIMIT 10").all([]);
      return 1;
    },
  },
  {
    name: "window function (running total)",
    run: (db) => {
      db.prepare("SELECT id, SUM(amount) OVER (PARTITION BY customer_id ORDER BY day ROWS UNBOUNDED PRECEDING) FROM orders").all([]);
      return 1;
    },
  },
  {
    name: "sort entire table",
    run: (db) => {
      db.prepare("SELECT id FROM orders ORDER BY amount DESC, id").all([]);
      return 1;
    },
  },
  {
    name: "correlated subquery",
    run: (db) => {
      db.prepare(
        "SELECT COUNT(*) FROM customers c WHERE (SELECT MAX(amount) FROM orders o WHERE o.customer_id = c.id) > 400",
      ).all([]);
      return 1;
    },
  },
  {
    name: "update 10% of rows",
    once: true,
    run: (db) => {
      db.exec("UPDATE orders SET status = 'archived' WHERE day < 36");
      return 1;
    },
  },
];

function fmt(ms) {
  return ms < 1 ? `${ms.toFixed(3)} ms` : ms < 100 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

const REPEATS = Number(process.env.BENCH_REPEATS ?? 5);

/** Median of several timed runs after one warm-up run (workloads that modify data run once). */
function measure(w, adapter) {
  if (w.once) return time(() => w.run(adapter)).ms;
  w.run(adapter);
  const samples = Array.from({ length: REPEATS }, () => time(() => w.run(adapter)).ms).sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

function runAll(adapter) {
  const results = new Map();
  const loaded = load(adapter);
  results.set(`bulk insert (${loaded.ops.toLocaleString("en-US")} rows)`, loaded.ms);
  for (const w of WORKLOADS) {
    w.setup?.(adapter);
    results.set(w.name, measure(w, adapter));
  }
  return results;
}

console.log(
  `minisql benchmark — ${N.toLocaleString("en-US")} orders, ${CUSTOMERS.toLocaleString("en-US")} customers, ` +
    `median of ${REPEATS} runs, Node ${process.version}\n`,
);
const mini = runAll(minisqlAdapter());
const lite = DatabaseSync ? runAll(sqliteAdapter()) : undefined;

const rows = [...mini.keys()].map((name) => {
  const m = mini.get(name);
  const s = lite?.get(name);
  return [name, fmt(m), s === undefined ? "-" : fmt(s), s === undefined ? "-" : `${(m / s).toFixed(1)}x`];
});
const header = ["workload", "minisql", "sqlite", "ratio"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => "| " + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(" | ") + " |";
console.log(line(header));
console.log("|" + widths.map((w, i) => (i === 0 ? "-".repeat(w + 2) : "-".repeat(w + 1) + ":")).join("|") + "|");
for (const r of rows) console.log(line(r));
