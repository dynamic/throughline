// Copies the repo's hooks/*.sh into this package so the published plugin runs the
// same capture, redaction and session-start scripts as every other harness
// (issue #179). Run by `npm run build`; the copy is gitignored.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkg, "..", "hooks");
const dest = join(pkg, "hooks");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith(".sh")) cpSync(join(src, f), join(dest, f));
}
