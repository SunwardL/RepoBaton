import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runShell } from '../proc.ts';
import type { Access } from '../types.ts';
import { isInside, tail, truncate } from '../util.ts';

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.repobaton', 'dist', 'build', '.venv', '__pycache__']);

export function toolSpecs(access: Access, allowShell: boolean): ToolSpec[] {
  const specs: ToolSpec[] = [
    {
      name: 'list_dir',
      description: 'List files and folders in a directory of the repository (relative path, "." for root).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a text file. Optionally pass 1-based start_line and end_line.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
        },
        required: ['path'],
      },
    },
    {
      name: 'search',
      description: 'Search repository text files for a regular expression. Returns file:line: text matches.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' }, path: { type: 'string' } },
        required: ['pattern'],
      },
    },
  ];
  if (access === 'workspace-write') {
    specs.push({
      name: 'write_file',
      description: 'Create or overwrite a file with the full given content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    });
    if (allowShell) {
      specs.push({
        name: 'run_command',
        description: 'Run a shell command in the repository root (build, test, formatters). Output is truncated.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      });
    }
  }
  return specs;
}

function safePath(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel) throw new Error('path is required');
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) throw new Error(`path escapes the repository: ${rel}`);
  const parts = path.relative(root, abs).split(path.sep);
  if (parts[0] === '.git') throw new Error('access to .git is not allowed');
  return abs;
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(dir, e.name), root);
    } else if (e.isFile()) {
      yield path.join(dir, e.name);
    }
  }
}

export async function execTool(
  name: string,
  args: Record<string, any>,
  root: string,
  opts: { access: Access; allowShell: boolean; timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  try {
    switch (name) {
      case 'list_dir': {
        const dir = safePath(root, args.path ?? '.');
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return (
          entries
            .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join('\n') || '(empty)'
        );
      }
      case 'read_file': {
        const file = safePath(root, args.path);
        const text = await fs.readFile(file, 'utf8');
        const lines = text.split('\n');
        const start = Math.max(1, Number(args.start_line ?? 1));
        const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${start + i}\t${l}`)
          .join('\n');
        return truncate(body, 60_000);
      }
      case 'search': {
        const base = safePath(root, args.path ?? '.');
        const re = new RegExp(String(args.pattern), 'i');
        const out: string[] = [];
        for await (const file of walk(base, root)) {
          let text: string;
          try {
            const stat = await fs.stat(file);
            if (stat.size > 1_000_000) continue;
            text = await fs.readFile(file, 'utf8');
          } catch {
            continue;
          }
          if (text.includes('\u0000')) continue;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              out.push(`${path.relative(root, file).replace(/\\/g, '/')}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (out.length >= 200) return out.join('\n') + '\n... (more matches omitted)';
            }
          }
        }
        return out.join('\n') || 'no matches';
      }
      case 'write_file': {
        if (opts.access !== 'workspace-write') return 'error: this stage is read-only';
        const file = safePath(root, args.path);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, String(args.content ?? ''), 'utf8');
        return `wrote ${args.path} (${String(args.content ?? '').length} chars)`;
      }
      case 'run_command': {
        if (opts.access !== 'workspace-write' || !opts.allowShell) {
          return 'error: shell commands are not enabled for this agent';
        }
        const r = await runShell(String(args.command), {
          cwd: root,
          timeoutMs: Math.min(opts.timeoutMs, 300_000),
          signal: opts.signal,
        });
        return `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${tail(r.stdout + r.stderr, 8000)}`;
      }
      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
