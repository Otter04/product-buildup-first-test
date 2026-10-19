import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { Database, type DatabaseSnapshot } from "./database.js";

/**
 * Opens a database file. `.sql` files are replayed as SQL scripts; any other
 * extension is read as a JSON snapshot. A missing file yields an empty database.
 */
export function openDatabase(path: string): Database {
  if (!existsSync(path)) return new Database();
  const text = readFileSync(path, "utf8");
  if (extname(path).toLowerCase() === ".sql") {
    const db = new Database();
    db.exec(text);
    return db;
  }
  return Database.fromJSON(JSON.parse(text) as DatabaseSnapshot);
}

/**
 * Writes a database to disk atomically (write to a temp file, then rename).
 * `.sql` paths receive a SQL dump; anything else a JSON snapshot.
 */
export function saveDatabase(db: Database, path: string): void {
  const content = extname(path).toLowerCase() === ".sql" ? db.dump() : JSON.stringify(db.toJSON());
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
