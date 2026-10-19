// Node.js entry point: everything from the core package plus file persistence.
export * from "./index.js";
export { openDatabase, saveDatabase } from "./persistence.js";
