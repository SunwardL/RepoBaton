#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 22.18 strips types natively),
// or the compiled output when `npm run build` has produced dist/.
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist', 'cli.js');
const src = path.join(root, 'src', 'cli.ts');
const entry = existsSync(src) ? src : dist;
await import(pathToFileURL(entry).href);
