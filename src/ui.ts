import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from './server/server.ts';

/** Where the built UI lives: dist/web in a packed install, web/dist in a checkout. */
export function findStaticDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, 'web'), path.resolve(here, '..', 'web', 'dist'), path.resolve(here, '..', 'dist', 'web')];
  return candidates.find((c) => existsSync(path.join(c, 'index.html')));
}

export interface UiOptions {
  port?: number;
  /** Repositories to open as projects at startup. */
  projects: string[];
  open: boolean;
}

export function openBrowser(url: string): void {
  // The URL carries the per-launch token in the fragment; the fragment never reaches the network.
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '""', url.replace(/&/g, '^&')], { windowsHide: true }, () => undefined);
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => undefined);
  } else {
    execFile('xdg-open', [url], () => undefined);
  }
}

export async function runUi(opts: UiOptions): Promise<RunningServer> {
  const staticDir = findStaticDir();
  const server = await startServer({ port: opts.port, seedProjects: opts.projects, staticDir });
  if (!staticDir) {
    process.stderr.write('! The web UI is not built (run "npm run build"). Only the API is available.\n');
  }
  process.stdout.write(`RepoBaton UI: ${server.url}\n`);
  process.stdout.write('Listening on 127.0.0.1 only. Press Ctrl+C to stop; runs in progress will be marked interrupted and can be resumed.\n');
  if (opts.open) openBrowser(server.url);
  return server;
}
