// Copies the compiled browser-safe modules into site/lib so the playground can import them.
// Run after `npm run build` (or use `npm run site`).
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const lib = join(root, "site", "lib");
// Node-only entry points are not needed (and would not load) in the browser.
const NODE_ONLY = new Set(["cli.js", "node.js", "persistence.js"]);

rmSync(lib, { recursive: true, force: true });
mkdirSync(lib, { recursive: true });
let copied = 0;
for (const file of readdirSync(dist)) {
  if (!file.endsWith(".js") || NODE_ONLY.has(file)) continue;
  copyFileSync(join(dist, file), join(lib, file));
  copied++;
}
console.log(`Copied ${copied} modules to site/lib. Serve the site with e.g. \`npx serve site\` or \`python3 -m http.server -d site\`.`);
