// Sample databases for the playground. Each has setup SQL and a few example queries.

export const DATASETS = [
  {
    id: "company",
    name: "Company",
    description: "Departments, employees with managers, projects and assignments.",
    setup: `
CREATE TABLE departments (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  budget REAL
);
CREATE TABLE employees (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  title      TEXT,
  dept_id    INTEGER REFERENCES departments(id),
  manager_id INTEGER REFERENCES employees(id),
  salary     INTEGER CHECK (salary > 0),
  hired      TEXT
);
CREATE TABLE projects (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  dept_id  INTEGER REFERENCES departments(id),
  deadline TEXT
);
CREATE TABLE assignments (
  employee_id INTEGER REFERENCES employees(id),
  project_id  INTEGER REFERENCES projects(id),
  hours       INTEGER,
  PRIMARY KEY (employee_id, project_id)
);
CREATE INDEX idx_employees_dept ON employees (dept_id);
CREATE INDEX idx_employees_manager ON employees (manager_id);

INSERT INTO departments VALUES
  (1, 'Engineering', 1200000), (2, 'Sales', 450000), (3, 'Marketing', 300000), (4, 'Research', 800000), (5, 'Legal', NULL);

INSERT INTO employees VALUES
  (1, 'Ada Lovelace',     'CTO',                1, NULL, 250000, '2015-03-01'),
  (2, 'Grace Hopper',     'Principal Engineer', 1, 1,    210000, '2016-07-15'),
  (3, 'Alan Turing',      'Staff Engineer',     4, 1,    195000, '2017-01-10'),
  (4, 'Edsger Dijkstra',  'Senior Engineer',    1, 2,    170000, '2018-11-30'),
  (5, 'Barbara Liskov',   'Senior Engineer',    1, 2,    172000, '2019-02-02'),
  (6, 'Ken Thompson',     'Engineer',           1, 4,    140000, '2020-05-05'),
  (7, 'Margaret Hamilton','Research Lead',      4, 3,    185000, '2018-04-21'),
  (8, 'Claude Shannon',   'Researcher',         4, 7,    150000, '2021-09-09'),
  (9, 'Don Draper',       'Head of Marketing',  3, NULL, 160000, '2016-01-04'),
  (10,'Peggy Olson',      'Copywriter',         3, 9,     90000, '2019-06-17'),
  (11,'Jordan Belfort',   'Head of Sales',      2, NULL, 175000, '2017-08-08'),
  (12,'Dwight Schrute',   'Account Manager',    2, 11,    95000, '2020-10-10'),
  (13,'Jim Halpert',      'Account Manager',    2, 11,    97000, '2021-03-03'),
  (14,'Saul Goodman',     'Counsel',            5, NULL, 130000, '2022-12-12'),
  (15,'Linus Torvalds',   'Engineer',           1, 4,    145000, '2023-01-15');

INSERT INTO projects VALUES
  (1, 'Compiler rewrite', 1, '2026-12-31'), (2, 'Query engine', 1, '2026-06-30'),
  (3, 'Information theory', 4, '2027-03-31'), (4, 'Spring campaign', 3, '2026-04-01'),
  (5, 'Enterprise deals', 2, '2026-09-30'), (6, 'Moon landing', 4, NULL);

INSERT INTO assignments VALUES
  (2, 1, 300), (4, 1, 420), (6, 1, 380), (15, 1, 200),
  (2, 2, 120), (5, 2, 500), (6, 2, 150), (1, 2, 40),
  (3, 3, 600), (8, 3, 450), (7, 6, 700), (3, 6, 80),
  (9, 4, 200), (10, 4, 350), (11, 5, 260), (12, 5, 400), (13, 5, 380);
`,
    examples: [
      {
        title: "Headcount and payroll per department",
        sql: `SELECT d.name AS department,
       COUNT(e.id) AS headcount,
       SUM(e.salary) AS payroll,
       ROUND(AVG(e.salary)) AS avg_salary
FROM departments d
LEFT JOIN employees e ON e.dept_id = d.id
GROUP BY d.name
ORDER BY payroll DESC NULLS LAST;`,
      },
      {
        title: "Org chart (recursive CTE)",
        sql: `WITH RECURSIVE chain(id, name, depth, path) AS (
  SELECT id, name, 0, name FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.name, c.depth + 1, c.path || ' > ' || e.name
  FROM employees e JOIN chain c ON e.manager_id = c.id
)
SELECT REPEAT('    ', depth) || name AS employee, depth
FROM chain
ORDER BY path;`,
      },
      {
        title: "Who earns more than their department's average?",
        sql: `SELECT name, title, salary
FROM employees e
WHERE salary > (SELECT AVG(salary) FROM employees x WHERE x.dept_id = e.dept_id)
ORDER BY salary DESC;`,
      },
      {
        title: "Salary rank within each department",
        sql: `SELECT d.name AS department, e.name, e.salary,
       RANK() OVER (PARTITION BY d.name ORDER BY e.salary DESC) AS rank_in_dept,
       e.salary - AVG(e.salary) OVER (PARTITION BY d.name) AS vs_avg
FROM employees e JOIN departments d ON d.id = e.dept_id
ORDER BY department, rank_in_dept;`,
      },
      {
        title: "Project staffing with EXPLAIN ANALYZE",
        sql: `EXPLAIN ANALYZE
SELECT p.name, COUNT(*) AS people, SUM(a.hours) AS hours
FROM projects p
JOIN assignments a ON a.project_id = p.id
JOIN employees e ON e.id = a.employee_id
WHERE e.salary > 100000
GROUP BY p.name
ORDER BY hours DESC;`,
      },
      {
        title: "Transactions and constraints",
        sql: `BEGIN;
UPDATE employees SET salary = ROUND(salary * 1.1) WHERE dept_id = 2;
SELECT name, salary FROM employees WHERE dept_id = 2;
ROLLBACK;
-- The raise was rolled back:
SELECT name, salary FROM employees WHERE dept_id = 2;
-- Constraints are enforced:
DELETE FROM departments WHERE id = 1;`,
      },
    ],
  },
  {
    id: "sales",
    name: "Sales analytics",
    description: "Two years of monthly sales for 4 regions × 5 products, generated with a recursive CTE.",
    setup: `
CREATE TABLE products (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT,
  price    REAL
);
CREATE TABLE sales (
  id         INTEGER PRIMARY KEY,
  month      TEXT NOT NULL,
  region     TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),
  units      INTEGER,
  revenue    REAL
);
CREATE INDEX idx_sales_month ON sales (month);

INSERT INTO products VALUES
  (1, 'Keyboard', 'Accessories', 49.0),
  (2, 'Monitor', 'Displays', 229.0),
  (3, 'Laptop', 'Computers', 1299.0),
  (4, 'Mouse', 'Accessories', 25.0),
  (5, 'Docking station', 'Accessories', 189.0);

-- 24 months x 4 regions x 5 products, with seasonality and regional differences.
INSERT INTO sales (month, region, product_id, units, revenue)
WITH RECURSIVE months(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM months WHERE n < 23),
regions(region, factor) AS (VALUES ('North', 1.0), ('South', 0.8), ('East', 1.3), ('West', 1.1))
SELECT DATE('2024-01-01', '+' || n || ' months') AS month,
       region,
       p.id,
       -- Second-year growth differs per product.
       CAST(factor * (20 + (p.id * 7 + n * 3) % 17) * (1 + 0.35 * SIN(n * 3.14159 / 6))
            * (CASE WHEN n >= 12 THEN 1.1 + 0.08 * p.id - 0.12 * (p.id % 2) ELSE 1 END) AS INTEGER) AS units,
       0
FROM months, regions, products p;
UPDATE sales SET revenue = ROUND(units * (SELECT price FROM products p WHERE p.id = sales.product_id), 2);
`,
    examples: [
      {
        title: "Monthly revenue with running total and moving average",
        sql: `SELECT SUBSTR(month, 1, 7) AS month,
       ROUND(SUM(revenue)) AS revenue,
       ROUND(SUM(SUM(revenue)) OVER (ORDER BY month)) AS running_total,
       ROUND(AVG(SUM(revenue)) OVER (ORDER BY month ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)) AS moving_avg_3m
FROM sales
GROUP BY month
ORDER BY month;`,
      },
      {
        title: "Best-selling product per region",
        sql: `SELECT region, product, units FROM (
  SELECT s.region, p.name AS product, SUM(s.units) AS units,
         ROW_NUMBER() OVER (PARTITION BY s.region ORDER BY SUM(s.units) DESC) AS rn
  FROM sales s JOIN products p ON p.id = s.product_id
  GROUP BY s.region, p.name
) ranked
WHERE rn = 1
ORDER BY units DESC;`,
      },
      {
        title: "Year-over-year growth by category",
        sql: `WITH yearly AS (
  SELECT p.category, SUBSTR(s.month, 1, 4) AS year, SUM(s.revenue) AS revenue
  FROM sales s JOIN products p ON p.id = s.product_id
  GROUP BY p.category, year
)
SELECT category, year, ROUND(revenue) AS revenue,
       ROUND(100.0 * (revenue - LAG(revenue) OVER w) / LAG(revenue) OVER w, 1) AS growth_pct
FROM yearly
WINDOW w AS (PARTITION BY category ORDER BY year)
ORDER BY category, year;`,
      },
      {
        title: "Regional share and quartiles",
        sql: `SELECT region,
       ROUND(SUM(revenue)) AS revenue,
       ROUND(100.0 * SUM(revenue) / SUM(SUM(revenue)) OVER (), 1) AS share_pct,
       NTILE(4) OVER (ORDER BY SUM(revenue)) AS quartile
FROM sales
GROUP BY region
ORDER BY revenue DESC;`,
      },
      {
        title: "Top months served straight from an index",
        sql: `EXPLAIN ANALYZE
SELECT month, region, revenue FROM sales
ORDER BY month DESC
LIMIT 5;`,
      },
    ],
  },
  {
    id: "flights",
    name: "Flight routes",
    description: "Airports and direct routes — a graph for recursive queries.",
    setup: `
CREATE TABLE airports (
  code TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  country TEXT
);
CREATE TABLE routes (
  origin      TEXT REFERENCES airports(code),
  destination TEXT REFERENCES airports(code),
  minutes     INTEGER,
  PRIMARY KEY (origin, destination)
);
INSERT INTO airports VALUES
  ('ICN', 'Seoul', 'KR'), ('NRT', 'Tokyo', 'JP'), ('SFO', 'San Francisco', 'US'),
  ('JFK', 'New York', 'US'), ('LHR', 'London', 'GB'), ('CDG', 'Paris', 'FR'),
  ('DXB', 'Dubai', 'AE'), ('SIN', 'Singapore', 'SG'), ('SYD', 'Sydney', 'AU'), ('GRU', 'São Paulo', 'BR');
INSERT INTO routes VALUES
  ('ICN', 'NRT', 140), ('NRT', 'ICN', 145), ('ICN', 'SFO', 630), ('SFO', 'ICN', 760),
  ('NRT', 'SFO', 600), ('SFO', 'JFK', 330), ('JFK', 'SFO', 380), ('JFK', 'LHR', 420),
  ('LHR', 'JFK', 480), ('LHR', 'CDG', 75), ('CDG', 'LHR', 80), ('CDG', 'DXB', 400),
  ('DXB', 'SIN', 450), ('SIN', 'SYD', 480), ('SYD', 'SIN', 500), ('ICN', 'SIN', 380),
  ('SIN', 'ICN', 390), ('DXB', 'LHR', 450), ('JFK', 'GRU', 600), ('GRU', 'CDG', 690);
`,
    examples: [
      {
        title: "All destinations reachable from Seoul, with the fastest itinerary",
        sql: `WITH RECURSIVE trips(dest, path, minutes, hops) AS (
  SELECT destination, 'ICN → ' || destination, minutes, 1 FROM routes WHERE origin = 'ICN'
  UNION ALL
  SELECT r.destination, t.path || ' → ' || r.destination, t.minutes + r.minutes, t.hops + 1
  FROM trips t JOIN routes r ON r.origin = t.dest
  WHERE t.hops < 4 AND t.path NOT LIKE '%' || r.destination || '%'
)
SELECT a.city, t.path, CAST(t.minutes / 60 AS INTEGER) || 'h ' || t.minutes % 60 || 'm' AS duration, t.hops
FROM trips t JOIN airports a ON a.code = t.dest
WHERE t.minutes = (SELECT MIN(minutes) FROM trips x WHERE x.dest = t.dest)
ORDER BY t.minutes;`,
      },
      {
        title: "Airports by connectivity",
        sql: `SELECT a.code, a.city,
       (SELECT COUNT(*) FROM routes r WHERE r.origin = a.code) AS departures,
       (SELECT COUNT(*) FROM routes r WHERE r.destination = a.code) AS arrivals
FROM airports a
ORDER BY departures + arrivals DESC, a.code;`,
      },
      {
        title: "Routes without a direct return flight",
        sql: `SELECT r.origin, r.destination, r.minutes
FROM routes r
WHERE NOT EXISTS (
  SELECT 1 FROM routes back WHERE back.origin = r.destination AND back.destination = r.origin
)
ORDER BY r.origin;`,
      },
    ],
  },
  {
    id: "empty",
    name: "Empty database",
    description: "Start from scratch.",
    setup: "",
    examples: [
      {
        title: "Create a table",
        sql: `CREATE TABLE notes (
  id      INTEGER PRIMARY KEY,
  body    TEXT NOT NULL,
  tags    TEXT,
  created TEXT DEFAULT (DATETIME('now'))
);
INSERT INTO notes (body, tags) VALUES ('Hello, minisql!', 'greeting'), ('Try EXPLAIN ANALYZE', 'tip')
RETURNING *;`,
      },
    ],
  },
];
