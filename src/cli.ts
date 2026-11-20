import { promises as fs } from 'node:fs';
import { EOL } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { AgentRegistry } from './agents/registry.ts';
import { loadConfig, ConfigError, CONFIG_FILENAMES, findConfig, configToYaml } from './config.ts';
import { detectProject } from './detect.ts';
import { discoverAll } from './discover.ts';
import * as G from './git.ts';
import { createLogger } from './log.ts';
import { eventsFile, followEvents, formatEventLine, SETTLED_STATUSES } from './events.ts';
import { Pipeline } from './pipeline.ts';
import { formatPlan, renderReport } from './report.ts';
import { RunStore } from './store.ts';
import { configTemplate } from './template.ts';
import { STAGE_NAMES, type Config, type Plan, type RunState, type StageName } from './types.ts';
import { exists, formatDuration } from './util.ts';

const HELP = `repobaton - let Codex, Claude Code and API models work on one task as planner / implementer / reviewer / release manager

Usage:
  repobaton ui [--port <n>] [--no-open] [--project <dir>]...
                                           open the local web UI (127.0.0.1 only) to manage several projects
  repobaton init [--force]                 detect local CLIs, write repobaton.yaml
  repobaton doctor                         check CLIs, API keys, git, gh and the config
  repobaton run "<task>" [options]         run plan -> implement -> test -> review -> release
  repobaton resume <run|last> [options]    continue a paused/failed run
  repobaton approve <run|last>             approve a pending plan and continue
  repobaton reject <run|last> "<feedback>" send the plan back to the planner (pauses again for approval)
  repobaton status [run|last] [--follow]   list runs, or show one; --follow streams its live events
  repobaton report <run|last>              print the Markdown report
  repobaton cleanup <run|last> [--delete-branch]
  repobaton config                         print the effective configuration

Run options:
  --task-file <file>        read the task from a file ("-" = stdin)
  --config <file>           use a specific config file
  --repo <dir>              repository (default: current directory)
  --plan <agent>  --implement <agent>  --review <agent>  --release <agent>
  --plan-model <m>  --implement-model <m>  --review-model <m>  --release-model <m>
  --max-rounds <n>          review/fix rounds
  --approve-plan            pause after planning and ask for approval
  --no-release              skip the release-draft stage
  --push  --pr  --merge  --tag      publish steps (off by default; --pr implies --push, --merge implies --pr)
  --ready                   open the PR as ready instead of draft
  --test "<cmd>"            test command    --setup "<cmd>"   worktree setup command
  -v, --verbose             show agent progress
  -q, --quiet               only print the final result
  --json                    print the final run state as JSON (with status --follow: one event per line)
  -f, --follow              status: stream a run's events until it stops

Resume options:
  --more-rounds <n>   --feedback "<text>"
    --feedback on a run waiting for plan approval is feedback on the plan;
    on any other run it is guidance for the implementer's next round.

Without a terminal (pipes, CI, a UI), a run that needs plan approval always pauses
at "awaiting-plan-approval"; it is never approved automatically.
`;

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const OPTIONS = {
  config: { type: 'string' },
  repo: { type: 'string' },
  'task-file': { type: 'string' },
  plan: { type: 'string' },
  implement: { type: 'string' },
  review: { type: 'string' },
  release: { type: 'string' },
  'plan-model': { type: 'string' },
  'implement-model': { type: 'string' },
  'review-model': { type: 'string' },
  'release-model': { type: 'string' },
  'max-rounds': { type: 'string' },
  'approve-plan': { type: 'boolean' },
  'no-release': { type: 'boolean' },
  push: { type: 'boolean' },
  pr: { type: 'boolean' },
  merge: { type: 'boolean' },
  tag: { type: 'boolean' },
  ready: { type: 'boolean' },
  test: { type: 'string' },
  setup: { type: 'string' },
  'more-rounds': { type: 'string' },
  feedback: { type: 'string' },
  'delete-branch': { type: 'boolean' },
  force: { type: 'boolean' },
  json: { type: 'boolean' },
  follow: { type: 'boolean', short: 'f' },
  port: { type: 'string' },
  'no-open': { type: 'boolean' },
  project: { type: 'string', multiple: true },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const;

function fail(msg: string, code = 2): never {
  process.stderr.write(`repobaton: ${msg}\n`);
  process.exit(code);
}

async function repoOf(f: Flags): Promise<string> {
  const start = path.resolve(typeof f.repo === 'string' ? f.repo : process.cwd());
  try {
    return await G.repoRoot(start);
  } catch {
    return fail(`${start} is not inside a git repository`);
  }
}

function applyOverrides(cfg: Config, f: Flags): Config {
  const c: Config = structuredClone(cfg);
  for (const s of STAGE_NAMES) {
    const agent = f[s];
    if (typeof agent === 'string') {
      if (!c.agents[agent]) fail(`--${s}: unknown agent "${agent}" (defined: ${Object.keys(c.agents).join(', ')})`);
      c.stages[s].agent = agent;
    }
    const model = f[`${s}-model`];
    if (typeof model === 'string') c.stages[s].model = model;
  }
  if (typeof f['max-rounds'] === 'string') {
    const n = Number(f['max-rounds']);
    if (!Number.isInteger(n) || n < 1) fail('--max-rounds must be a positive integer');
    c.loop.maxReviewRounds = n;
  }
  if (f['approve-plan']) c.stages.plan.requireApproval = true;
  if (f['no-release']) c.stages.release.enabled = false;
  if (typeof f.test === 'string') c.test.command = f.test;
  if (typeof f.setup === 'string') c.test.setup = f.setup;
  const p = c.publish;
  if (f.merge) p.merge = p.createPr = p.push = true;
  if (f.pr) p.createPr = p.push = true;
  if (f.push) p.push = true;
  if (f.tag) {
    p.tag = true;
    if (!p.merge) fail('--tag needs --merge: tags are only created on the merge commit');
  }
  if (f.ready) p.draftPr = false;
  return c;
}

async function askPlan(plan: Plan): Promise<{ approved: true } | { approved: false; feedback: string }> {
  process.stderr.write(`\n${formatPlan(plan)}\n\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = (await rl.question('Approve this plan? [Y]es / [n]o, give feedback: ')).trim().toLowerCase();
    if (a === '' || a === 'y' || a === 'yes') return { approved: true };
    const fb = (await rl.question('What should change? ')).trim();
    // An empty answer must not silently approve: ask the planner to revise instead.
    return { approved: false, feedback: fb || 'Please revise the plan.' };
  } finally {
    rl.close();
  }
}

function summarize(s: RunState): string {
  const L = [`run ${s.id}: ${s.status}${s.error ? ` (${s.error})` : ''}`];
  if (s.branch) L.push(`  branch   ${s.branch}`);
  if (s.worktree) L.push(`  worktree ${s.worktree}`);
  const last = s.rounds[s.rounds.length - 1];
  if (last?.implement) L.push(`  commit   ${last.implement.sha.slice(0, 10)} after ${s.rounds.length} round(s)`);
  if (s.publish.prUrl) L.push(`  PR       ${s.publish.prUrl}`);
  if (s.publish.tag) L.push(`  tag      ${s.publish.tag}`);
  if (s.release?.suggested_version) L.push(`  version  ${s.release.version_bump} -> ${s.release.suggested_version}`);
  L.push(`  report   ${path.join(s.repo, '.repobaton', 'runs', s.id, 'report.md')}`);
  return L.join('\n');
}

function exitCodeFor(s: RunState): number {
  switch (s.status) {
    case 'succeeded':
      return 0;
    case 'needs-human':
    case 'interrupted':
    case 'awaiting-plan-approval':
      return 3;
    case 'cancelled':
      return 130;
    default:
      return 1;
  }
}

async function cmdInit(f: Flags): Promise<void> {
  const repo = await repoOf(f);
  const existing = await findConfig(repo);
  if (existing && !f.force) fail(`${existing} already exists (use --force to overwrite)`);
  const found = await discoverAll();
  const claude = found.find((d) => d.kind === 'claude') ?? null;
  const codex = found.find((d) => d.kind === 'codex') ?? null;
  const proj = await detectProject(repo);
  const base = (await G.hasCommits(repo)) ? await G.guessBaseBranch(repo) : '';
  const file = existing ?? path.join(repo, CONFIG_FILENAMES[0]);
  await fs.writeFile(
    file,
    configTemplate({ claude, codex, testCommand: proj.test, setupCommand: proj.setup, baseBranch: base }),
    'utf8',
  );
  const line = (n: string, d: typeof claude): string => (d ? `  ${n.padEnd(7)} ${d.path}  (${d.version}, via ${d.source})` : `  ${n.padEnd(7)} NOT FOUND`);
  process.stdout.write(`wrote ${file}\n${line('claude', claude)}\n${line('codex', codex)}\n  project ${proj.note}${proj.test ? `, tests: ${proj.test}` : ', no test command detected'}\n`);
  if (!claude || !codex) process.stdout.write('Set agents.<id>.path in the file for any CLI that was not found, then run "repobaton doctor".\n');
}

async function cmdDoctor(f: Flags): Promise<number> {
  let bad = 0;
  const ok = (m: string): void => void process.stdout.write(`  ok    ${m}\n`);
  const warn = (m: string): void => void process.stdout.write(`  warn  ${m}\n`);
  const err = (m: string): void => {
    bad++;
    process.stdout.write(`  FAIL  ${m}\n`);
  };
  process.stdout.write(`node ${process.version} on ${process.platform}\n`);
  if (Number(process.versions.node.split('.')[0]) < 22) err('Node 22.18+ is required');

  process.stdout.write('git\n');
  let repo: string | null = null;
  try {
    repo = await G.repoRoot(path.resolve(typeof f.repo === 'string' ? f.repo : process.cwd()));
    ok(`repository ${repo}`);
    (await G.hasCommits(repo)) ? ok(`base branch ${await G.guessBaseBranch(repo)}`) : err('no commits yet');
    const remote = await G.remoteUrl(repo, 'origin');
    remote ? ok(`origin ${remote}`) : warn('no "origin" remote (needed only for push/PR)');
  } catch {
    warn('not inside a git repository (run doctor from your project)');
  }
  (await G.ghAvailable(repo ?? process.cwd())) ? ok('gh CLI found') : warn('gh CLI not found (needed only for --pr / --merge)');

  process.stdout.write('config\n');
  let cfg: Config | null = null;
  try {
    const loaded = await loadConfig(repo ?? process.cwd(), typeof f.config === 'string' ? f.config : undefined);
    cfg = loaded.config;
    ok(loaded.file ?? 'no config file: using defaults (run "repobaton init")');
    loaded.warnings.forEach(warn);
  } catch (e) {
    err(e instanceof ConfigError ? e.problems.join('; ') : (e as Error).message);
  }

  process.stdout.write('agents\n');
  if (cfg) {
    const reg = new AgentRegistry(cfg);
    for (const id of Object.keys(cfg.agents)) {
      const used = STAGE_NAMES.filter((s) => cfg!.stages[s].agent === id || cfg!.stages[s].fallbackAgent === id);
      const r = await reg.get(id).check();
      const label = `${id} [${cfg.agents[id].type}]${used.length ? ` used by ${used.join(',')}` : ''}: ${r.detail}`;
      r.ok ? ok(label) : used.length ? err(label) : warn(label);
    }
  }
  process.stdout.write(bad ? `\n${bad} problem(s) found\n` : '\nall good\n');
  return bad ? 1 : 0;
}

async function cmdRun(f: Flags, positional: string[]): Promise<number> {
  let task = positional.join(' ').trim();
  if (typeof f['task-file'] === 'string') {
    task = f['task-file'] === '-' ? await readStdin() : await fs.readFile(f['task-file'], 'utf8');
  }
  if (!task) fail('missing task: repobaton run "<what to build>"');
  const repo = await repoOf(f);
  const loaded = await loadConfig(repo, typeof f.config === 'string' ? f.config : undefined).catch(handleConfigError);
  loaded.warnings.forEach((w) => process.stderr.write(`! ${w}\n`));
  const cfg = applyOverrides(loaded.config, f);
  return runPipeline(f, repo, cfg, (p) => p.start(task));
}

async function cmdResume(f: Flags, positional: string[], approve = false): Promise<number> {
  const id = positional[0] ?? fail('missing run id (or "last")');
  const repo = await repoOf(f);
  const loaded = await loadConfig(repo, typeof f.config === 'string' ? f.config : undefined).catch(handleConfigError);
  const cfg = applyOverrides(loaded.config, f);
  const more = typeof f['more-rounds'] === 'string' ? Number(f['more-rounds']) : undefined;
  if (more !== undefined && (!Number.isInteger(more) || more < 1)) fail('--more-rounds must be a positive integer');
  return runPipeline(f, repo, cfg, (p) =>
    p.resume(id, {
      approvePlan: approve,
      moreRounds: more,
      feedback: typeof f.feedback === 'string' ? f.feedback : undefined,
    }),
  );
}

async function cmdReject(f: Flags, positional: string[]): Promise<number> {
  const id = positional[0] ?? fail('missing run id (or "last")');
  const feedback = positional.slice(1).join(' ').trim() || (typeof f.feedback === 'string' ? f.feedback.trim() : '');
  if (!feedback) fail('missing feedback: repobaton reject <run> "what should change"');
  const repo = await repoOf(f);
  const loaded = await loadConfig(repo, typeof f.config === 'string' ? f.config : undefined).catch(handleConfigError);
  const cfg = applyOverrides(loaded.config, f);
  return runPipeline(f, repo, cfg, (p) => p.rejectPlan(id, feedback));
}

async function runPipeline(f: Flags, repo: string, cfg: Config, go: (p: Pipeline) => Promise<RunState>): Promise<number> {
  const ctrl = new AbortController();
  let interrupted = false;
  const onSig = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    process.stderr.write('\ninterrupting... (press Ctrl+C again to force quit)\n');
    ctrl.abort();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const log = createLogger({
    file: path.join(repo, '.repobaton', 'repobaton.log'),
    quiet: !!f.quiet,
    verbose: !!f.verbose,
  });
  // Only a real terminal can answer the approval prompt. Anything else (a UI
  // subprocess, CI, a pipe) must pause at the plan instead of auto-approving.
  const interactive = !!process.stdin.isTTY && !!process.stderr.isTTY && !f.json;
  const pipeline = new Pipeline({ repo, config: cfg, log, signal: ctrl.signal, approvePlan: interactive ? askPlan : undefined });
  const state = await go(pipeline).catch((e: Error) => fail(e.message, 1));
  if (f.json) process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  else process.stdout.write('\n' + summarize(state) + '\n');
  return exitCodeFor(state);
}

function handleConfigError(e: unknown): never {
  if (e instanceof ConfigError) return fail(e.message);
  return fail((e as Error).message);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdStatus(f: Flags, positional: string[]): Promise<void> {
  const repo = await repoOf(f);
  const store = new RunStore(repo);
  if (f.follow) {
    const id = await store.resolve(positional[0] ?? 'last');
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    await followEvents(eventsFile(store.dir(id)), {
      signal: ctrl.signal,
      isSettled: async () => SETTLED_STATUSES.includes((await store.load(id)).status),
      onEvent: (ev) => process.stdout.write((f.json ? JSON.stringify(ev) : formatEventLine(ev)) + EOL),
    });
    return;
  }
  if (positional[0]) {
    const s = await store.load(await store.resolve(positional[0]));
    process.stdout.write(f.json ? JSON.stringify(s, null, 2) + '\n' : renderReport(s));
    return;
  }
  const runs = await store.list();
  if (f.json) return void process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
  if (!runs.length) return void process.stdout.write('no runs yet\n');
  for (const r of runs) {
    const age = formatDuration(Date.now() - Date.parse(r.createdAt));
    process.stdout.write(`${r.id}  ${r.status.padEnd(22)} ${String(r.rounds.length)}r  ${age} ago  ${r.task.split('\n')[0].slice(0, 60)}\n`);
  }
}

async function cmdReport(f: Flags, positional: string[]): Promise<void> {
  const store = new RunStore(await repoOf(f));
  const s = await store.load(await store.resolve(positional[0] ?? 'last'));
  process.stdout.write(renderReport(s));
}

async function cmdCleanup(f: Flags, positional: string[]): Promise<void> {
  const repo = await repoOf(f);
  const loaded = await loadConfig(repo).catch(handleConfigError);
  const p = new Pipeline({ repo, config: loaded.config });
  await p.cleanup(positional[0] ?? fail('missing run id'), { deleteBranch: !!f['delete-branch'] });
  process.stdout.write('worktree removed\n');
}

async function cmdUi(f: Flags): Promise<number> {
  const port = typeof f.port === 'string' ? Number(f.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) fail('--port must be 0-65535');
  const explicit = Array.isArray(f.project) ? f.project.filter((x): x is string => typeof x === 'string') : [];
  // Open the current directory's repository too, when there is one, so "repobaton ui" in a project just works.
  const projects = [...explicit];
  if (!explicit.length) {
    try {
      projects.push(await G.repoRoot(process.cwd()));
    } catch {
      /* not inside a repository: the project list on disk is enough */
    }
  }
  const { runUi } = await import('./ui.ts');
  const server = await runUi({ port, projects, open: !f['no-open'] }).catch((e: Error) => fail(e.message, 1));
  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === '--version') {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    process.stdout.write(pkg.version + '\n');
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv.slice(1), options: OPTIONS, allowPositionals: true });
  } catch (e) {
    return fail((e as Error).message);
  }
  const f = parsed.values as Flags;
  const pos = parsed.positionals;
  if (f.help) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (cmd) {
    case 'ui':
      return cmdUi(f);
    case 'init':
      await cmdInit(f);
      return 0;
    case 'doctor':
      return cmdDoctor(f);
    case 'run':
      return cmdRun(f, pos);
    case 'resume':
      return cmdResume(f, pos);
    case 'approve':
      return cmdResume(f, pos, true);
    case 'reject':
      return cmdReject(f, pos);
    case 'status':
    case 'list':
      await cmdStatus(f, pos);
      return 0;
    case 'report':
      await cmdReport(f, pos);
      return 0;
    case 'cleanup':
      await cmdCleanup(f, pos);
      return 0;
    case 'config': {
      const repo = await repoOf(f);
      const loaded = await loadConfig(repo, typeof f.config === 'string' ? f.config : undefined).catch(handleConfigError);
      process.stdout.write(configToYaml(loaded.config, `# ${loaded.file ?? 'defaults (no config file)'}\n`));
      return 0;
    }
    default:
      return fail(`unknown command "${cmd}". Run "repobaton help".`);
  }
}

if (!(await exists(path.dirname(new URL(import.meta.url).pathname))) && false) process.exit(1);
main().then(
  (code) => process.exit(code),
  (e: Error) => fail(e.message, 1),
);
export type { StageName };
