// A tour of the minisql API. Run with `npm run build && node examples/quickstart.mjs`.
import { Database, formatTable, SqlConstraintError } from "../dist/index.js";

const db = new Database();

// Schema: constraints, defaults, foreign keys and indexes.
db.exec(`
  CREATE TABLE authors (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL UNIQUE,
    country TEXT
  );
  CREATE TABLE books (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES authors(id),
    title     TEXT NOT NULL,
    year      INTEGER CHECK (year > 1400),
    rating    REAL DEFAULT 0
  );
  CREATE INDEX idx_books_author ON books (author_id);
`);

// Prepared statements are parsed and planned once, then reused.
const addAuthor = db.prepare("INSERT INTO authors (name, country) VALUES (?, ?) RETURNING id");
const addBook = db.prepare("INSERT INTO books (author_id, title, year, rating) VALUES (:author, :title, :year, :rating)");

// A transaction commits everything or nothing.
db.transaction(() => {
  const leGuin = addAuthor.get(["Ursula K. Le Guin", "US"]).id;
  const borges = addAuthor.get(["Jorge Luis Borges", "AR"]).id;
  const calvino = addAuthor.get(["Italo Calvino", "IT"]).id;
  addBook.run({ author: leGuin, title: "A Wizard of Earthsea", year: 1968, rating: 4.6 });
  addBook.run({ author: leGuin, title: "The Left Hand of Darkness", year: 1969, rating: 4.4 });
  addBook.run({ author: leGuin, title: "The Dispossessed", year: 1974, rating: 4.5 });
  addBook.run({ author: borges, title: "Ficciones", year: 1944, rating: 4.7 });
  addBook.run({ author: borges, title: "The Aleph", year: 1949, rating: 4.5 });
  addBook.run({ author: calvino, title: "Invisible Cities", year: 1972, rating: 4.4 });
});

console.log("Books per author:");
const [perAuthor] = db.exec(`
  SELECT a.name, COUNT(*) AS books, ROUND(AVG(b.rating), 2) AS avg_rating, MIN(b.year) AS first
  FROM authors a JOIN books b ON b.author_id = a.id
  GROUP BY a.name
  ORDER BY books DESC, a.name
`);
console.log(formatTable(perAuthor));

// Rows as plain objects.
console.log("\nBooks from the 1960s:", db.query("SELECT title, year FROM books WHERE year BETWEEN 1960 AND 1969 ORDER BY year"));

// Constraint violations throw typed errors and leave the data untouched.
try {
  db.run("INSERT INTO books (author_id, title, year) VALUES (99, 'Ghost Book', 2000)");
} catch (e) {
  console.log(`\n${e instanceof SqlConstraintError ? "Constraint error" : "Error"}: ${e.message}`);
}

// Upsert: insert or update in one statement.
db.exec(`
  INSERT INTO authors (id, name, country) VALUES (1, 'Ursula K. Le Guin', 'USA')
  ON CONFLICT (id) DO UPDATE SET country = excluded.country
`);
console.log("\nAfter upsert:", db.get("SELECT name, country FROM authors WHERE id = 1"));

// EXPLAIN shows how the planner will run a query.
console.log("\nQuery plan:");
const plan = db.exec("EXPLAIN SELECT a.name, b.title FROM authors a JOIN books b ON b.author_id = a.id WHERE a.country = 'AR'")[0];
console.log(plan.rows.map((r) => r[0]).join("\n"));

// The whole database can be exported as SQL.
console.log("\nSchema:\n" + db.schema());
