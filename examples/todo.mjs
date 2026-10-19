// A tiny persistent to-do list backed by a minisql database file.
//
//   node examples/todo.mjs add "Write the README" --due 2026-11-01
//   node examples/todo.mjs list
//   node examples/todo.mjs done 1
//   node examples/todo.mjs stats
//
// Data is stored in todo.minisql.json next to the current directory.
import { formatTable, openDatabase, saveDatabase } from "../dist/node.js";

const FILE = process.env.TODO_DB ?? "todo.minisql.json";
const db = openDatabase(FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY,
    title      TEXT NOT NULL CHECK (LENGTH(title) > 0),
    due        TEXT,
    done       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
  );
`);

const [command = "list", ...args] = process.argv.slice(2);

switch (command) {
  case "add": {
    const dueFlag = args.indexOf("--due");
    const due = dueFlag >= 0 ? args[dueFlag + 1] : null;
    const title = (dueFlag >= 0 ? [...args.slice(0, dueFlag), ...args.slice(dueFlag + 2)] : args).join(" ");
    const { id } = db.get("INSERT INTO todos (title, due) VALUES (?, ?) RETURNING id", [title, due]);
    console.log(`Added #${id}: ${title}`);
    break;
  }
  case "done": {
    const { changes } = db.run("UPDATE todos SET done = TRUE WHERE id = ?", [Number(args[0])]);
    console.log(changes ? `Completed #${args[0]}` : `No to-do #${args[0]}`);
    break;
  }
  case "remove": {
    const { changes } = db.run("DELETE FROM todos WHERE id = ?", [Number(args[0])]);
    console.log(changes ? `Removed #${args[0]}` : `No to-do #${args[0]}`);
    break;
  }
  case "stats": {
    console.log(
      formatTable(
        db.exec(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN done THEN 1 ELSE 0 END) AS done,
                 SUM(CASE WHEN NOT done AND due < DATE('now') THEN 1 ELSE 0 END) AS overdue
          FROM todos
        `)[0],
      ),
    );
    break;
  }
  case "list": {
    const result = db.exec(`
      SELECT id, CASE WHEN done THEN '✔' ELSE '' END AS done, title, COALESCE(due, '') AS due
      FROM todos
      ORDER BY done, due IS NULL, due, id
    `)[0];
    console.log(result.rows.length ? formatTable(result) : "Nothing to do. Add something with: todo add <title>");
    break;
  }
  default:
    console.error(`Unknown command '${command}'. Use add, list, done, remove or stats.`);
    process.exitCode = 2;
}

saveDatabase(db, FILE);
