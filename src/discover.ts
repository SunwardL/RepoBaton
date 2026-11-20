import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunch, runLaunch, type Launch } from './proc.ts';
import { exists } from './util.ts';

export type CliKind = 'claude' | 'codex';

export interface Discovered {
  kind: CliKind;
  path: string;
  source: string;
  version: string;
  launch: Launch;
}

export interface DiscoverOptions {
  kind: CliKind;
  /** Explicit path from the config file (highest priority). */
  configured?: string;
}

const isWin = process.platform === 'win32';
const exeNames = (kind: CliKind): string[] =>
  isWin ? [`${kind}.exe`, `${kind}.cmd`, `${kind}.bat`, kind] : [kind];

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function lookupInPath(kind: CliKind): Promise<string[]> {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const out: string[] = [];
  for (const d of dirs) {
    for (const n of exeNames(kind)) {
      const p = path.join(d, n);
      if (await fileExists(p)) out.push(p);
    }
  }
  return out;
}

async function globOne(dir: string, test: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter(test).map((e) => path.join(dir, e));
  } catch {
    return [];
  }
}

async function knownLocations(kind: CliKind): Promise<string[]> {
  const home = os.homedir();
  const out: string[] = [];
  const add = (...p: string[]): number => out.push(path.join(...p));
  const names = exeNames(kind);

  if (kind === 'claude') {
    for (const n of names) {
      add(home, '.local', 'bin', n);
      add(home, '.claude', 'local', n);
      add(home, '.claude', 'local', 'node_modules', '.bin', n);
    }
  } else {
    const ch = process.env.CODEX_HOME || path.join(home, '.codex');
    for (const n of names) {
      add(ch, 'bin', n);
      // The plugin bundle ships codex next to its helper executables; the
      // .sandbox-bin copy does not, and fails to run commands without them.
      add(ch, 'plugins', '.plugin-appserver', n);
      add(ch, '.sandbox-bin', n);
      add(home, '.local', 'bin', n);
    }
    // VS Code / Cursor / Windsurf OpenAI extension bundles the CLI.
    for (const ext of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
      const base = path.join(home, ext, 'extensions');
      for (const dir of await globOne(base, (e) => /^openai\.chatgpt-/i.test(e))) {
        for (const sub of ['bin', path.join('bin', 'windows-x86_64'), path.join('bin', 'macos-aarch64'), path.join('bin', 'linux-x86_64')]) {
          for (const n of names) add(dir, sub, n);
        }
      }
    }
  }

  if (isWin) {
    const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    for (const n of names) {
      add(appdata, 'npm', n);
      add(local, 'Programs', kind, n);
      add(local, 'Microsoft', 'WinGet', 'Links', n);
      add(pf, 'nodejs', n);
    }
    add(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    add(appdata, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe');
  } else {
    for (const n of names) {
      add('/usr/local/bin', n);
      add('/opt/homebrew/bin', n);
      add(home, '.npm-global', 'bin', n);
      add(home, '.bun', 'bin', n);
      add(home, '.volta', 'bin', n);
    }
  }
  return out;
}

async function probe(kind: CliKind, file: string): Promise<{ launch: Launch; version: string } | null> {
  const launch = await resolveLaunch(file);
  const r = await runLaunch(launch, ['--version'], { timeoutMs: 20_000, shell: needsShell(launch) });
  if (r.code !== 0) return null;
  const text = `${r.stdout}\n${r.stderr}`.trim();
  const version = text.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l)) ?? text.split(/\r?\n/)[0] ?? '';
  if (!version) return null;
  // Guard against a random `codex`/`claude` binary that is not the real CLI.
  if (kind === 'claude' && !/claude/i.test(text) && !/^\s*\d+\.\d+/.test(text)) return null;
  return { launch, version: version.trim() };
}

function needsShell(launch: Launch): boolean {
  return isWin && /\.(cmd|bat)$/i.test(launch.command);
}

export function toLaunchWithShell(launch: Launch): { launch: Launch; shell: boolean } {
  return { launch, shell: needsShell(launch) };
}

/** Candidate list in priority order, with the source label for each. */
export async function candidates(opts: DiscoverOptions): Promise<Array<{ path: string; source: string }>> {
  const list: Array<{ path: string; source: string }> = [];
  const seen = new Set<string>();
  const push = (p: string | undefined, source: string): void => {
    if (!p) return;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ path: p, source });
  };
  push(opts.configured, 'config');
  const upper = opts.kind.toUpperCase();
  push(process.env[`REPOBATON_${upper}_PATH`], `env REPOBATON_${upper}_PATH`);
  push(process.env[`${upper}_PATH`], `env ${upper}_PATH`);
  for (const p of await lookupInPath(opts.kind)) push(p, 'PATH');
  for (const p of await knownLocations(opts.kind)) if (await exists(p)) push(p, 'known location');
  return list;
}

/** codex needs its helper executables beside it to run commands at all. */
async function hasHelpers(kind: CliKind, file: string): Promise<boolean> {
  if (kind !== 'codex') return true;
  const dir = path.dirname(file);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const names = entries.map((e) => e.toLowerCase());
  const hasHelperFiles = names.some((n) => n.startsWith('codex-') && !n.startsWith('codex-command-runner-'));
  // An npm/brew/standalone install has no helpers at all and works fine;
  // an install that ships *some* helpers must ship the code-mode host too.
  return !hasHelperFiles || names.some((n) => n.startsWith('codex-code-mode-host'));
}

export async function discover(opts: DiscoverOptions): Promise<Discovered | null> {
  const all = await candidates(opts);
  const complete: typeof all = [];
  const partial: typeof all = [];
  for (const c of all) ((c.source === 'config' || (await hasHelpers(opts.kind, c.path))) ? complete : partial).push(c);
  const list = [...complete, ...partial];
  for (const c of list) {
    // An explicit config path that does not work should not silently fall back.
    const found = await probe(opts.kind, c.path);
    if (found) return { kind: opts.kind, path: c.path, source: c.source, version: found.version, launch: found.launch };
    if (c.source === 'config') return null;
  }
  return null;
}

export async function discoverAll(configured: Partial<Record<CliKind, string>> = {}): Promise<Discovered[]> {
  const out: Discovered[] = [];
  for (const kind of ['claude', 'codex'] as CliKind[]) {
    const d = await discover({ kind, configured: configured[kind] });
    if (d) out.push(d);
  }
  return out;
}

/** Resolve an executable name or path to a concrete file, or null. */
export async function which(cmd: string): Promise<string | null> {
  if (!cmd) return null;
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes(path.sep) || cmd.includes('\u005c')) {
    return (await fileExists(cmd)) ? cmd : null;
  }
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const names = isWin ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd] : [cmd];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (await fileExists(p)) return p;
    }
  }
  return null;
}
