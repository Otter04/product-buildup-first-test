// Analytical SQL with minisql: CTEs, window functions and recursive queries.
// Run with `npm run build && node examples/analytics.mjs`.
import { Database, formatTable } from "../dist/index.js";

const db = new Database();
db.exec(`
  CREATE TABLE sales (
    id     INTEGER PRIMARY KEY,
    region TEXT NOT NULL,
    month  TEXT NOT NULL,
    amount REAL NOT NULL
  );
`);

// Twelve months of deterministic sales data for three regions.
const insert = db.prepare("INSERT INTO sales (region, month, amount) VALUES (?, ?, ?)");
db.transaction(() => {
  const regions = { north: 120, south: 90, west: 150 };
  for (const [region, base] of Object.entries(regions)) {
    for (let m = 1; m <= 12; m++) {
      const seasonal = Math.round(base * (1 + 0.3 * Math.sin((m / 12) * 2 * Math.PI)) * 100) / 100;
      insert.run([region, `2024-${String(m).padStart(2, "0")}`, seasonal]);
    }
  }
});

function show(title, sql) {
  console.log(`\n${title}`);
  console.log(formatTable(db.exec(sql)[0]));
}

show(
  "Running total and 3-month moving average (north)",
  `SELECT month, amount,
          SUM(amount) OVER (ORDER BY month) AS running_total,
          ROUND(AVG(amount) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS moving_avg_3m
   FROM sales WHERE region = 'north' ORDER BY month LIMIT 6`,
);

show(
  "Best month per region",
  `SELECT region, month, amount FROM (
     SELECT region, month, amount,
            ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
     FROM sales
   ) ranked
   WHERE rn = 1
   ORDER BY amount DESC`,
);

show(
  "Month-over-month change (west)",
  `SELECT month, amount,
          ROUND(amount - LAG(amount) OVER (ORDER BY month), 2) AS change,
          ROUND(100.0 * (amount - LAG(amount) OVER (ORDER BY month)) / LAG(amount) OVER (ORDER BY month), 1) AS pct
   FROM sales WHERE region = 'west' ORDER BY month LIMIT 5`,
);

show(
  "Regional share of yearly revenue",
  `WITH totals AS (
     SELECT region, SUM(amount) AS total FROM sales GROUP BY region
   )
   SELECT region, total,
          ROUND(100.0 * total / SUM(total) OVER (), 1) AS share_pct,
          RANK() OVER (ORDER BY total DESC) AS rank
   FROM totals ORDER BY rank`,
);

show(
  "Quarters, generated with a recursive CTE",
  `WITH RECURSIVE quarters(q, first_month) AS (
     SELECT 1, 1
     UNION ALL
     SELECT q + 1, first_month + 3 FROM quarters WHERE q < 4
   )
   SELECT 'Q' || q AS quarter,
          ROUND(SUM(s.amount), 2) AS revenue,
          COUNT(DISTINCT s.region) AS regions
   FROM quarters
   JOIN sales s ON CAST(SUBSTR(s.month, 6, 2) AS INTEGER) BETWEEN first_month AND first_month + 2
   GROUP BY q ORDER BY q`,
);
