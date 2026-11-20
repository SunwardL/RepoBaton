// Copy the built web UI next to the compiled server so a packed install is self-contained.
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'web', 'dist');
const to = path.join(root, 'dist', 'web');
if (!existsSync(path.join(from, 'index.html'))) {
  console.error('web/dist/index.html is missing: the web build did not run.');
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log(`copied ${from} -> ${to}`);
