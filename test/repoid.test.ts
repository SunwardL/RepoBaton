import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { git } from '../src/git.ts';
import { ProjectRegistry } from '../src/projects.ts';
import { comparablePath, identifyProject, identifyRepo, NotAGitRepoError, realPath } from '../src/repoid.ts';

async function makeRepo(prefix = 'rb-id-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 't@e.com']);
  await git(dir, ['config', 'user.name', 't']);
  await fs.writeFile(path.join(dir, 'f.txt'), 'a\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

test('a repository, its subdirectories and its linked worktrees share one identity', async () => {
  const repo = await makeRepo();
  await fs.mkdir(path.join(repo, 'sub', 'deep'), { recursive: true });
  const wt = `${repo}-wt`;
  await git(repo, ['worktree', 'add', '-q', wt, '-b', 'wt1']);
  const a = await identifyRepo(repo);
  const b = await identifyRepo(path.join(repo, 'sub', 'deep'));
  const c = await identifyRepo(wt);
  assert.equal(b.key, a.key);
  assert.equal(c.key, a.key, 'linked worktree must resolve to the main repository');
  assert.equal(comparablePath(c.root), comparablePath(repo), 'root is the main working tree, not the worktree');
});

test('two different repositories have different identities', async () => {
  const a = await identifyRepo(await makeRepo());
  const b = await identifyRepo(await makeRepo());
  assert.notEqual(a.key, b.key);
});

test('a folder that is not a repository is rejected', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-notgit-'));
  await assert.rejects(identifyRepo(dir), NotAGitRepoError);
  await assert.rejects(identifyRepo(path.join(dir, 'does-not-exist')), NotAGitRepoError);
});

test('relative paths are resolved before comparing', async () => {
  const repo = await makeRepo();
  const rel = path.relative(process.cwd(), repo);
  assert.equal((await identifyRepo(rel)).key, (await identifyRepo(repo)).key);
});

test('different casing of the same folder is the same repository on Windows', { skip: process.platform !== 'win32' }, async () => {
  const repo = await makeRepo();
  const swapped = repo.replace(/[a-z]/gi, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
  assert.equal((await identifyRepo(swapped)).key, (await identifyRepo(repo)).key);
});

test('an 8.3 short path is the same repository on Windows', { skip: process.platform !== 'win32' }, async () => {
  const repo = await makeRepo('rb-a-long-folder-name-');
  // Ask Windows for the real 8.3 name of the folder.
  let short: string;
  try {
    short = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${repo}').ShortPath`],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return;
  }
  if (!short || short.toLowerCase() === repo.toLowerCase()) return; // short names disabled on this volume
  assert.equal((await identifyRepo(short)).key, (await identifyRepo(repo)).key);
  assert.equal(realPath(short).toLowerCase(), realPath(repo).toLowerCase());
});

test('project registry: stores, de-duplicates by repository and survives a restart', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-reg-')), 'projects.json');
  const repo = await makeRepo();
  const wt = `${repo}-wt2`;
  await git(repo, ['worktree', 'add', '-q', wt, '-b', 'wt2']);
  await fs.mkdir(path.join(repo, 'sub'), { recursive: true });

  const reg = new ProjectRegistry(file);
  const first = await reg.add(path.join(repo, 'sub'), 'My project');
  assert.equal(first.name, 'My project');
  assert.equal(comparablePath(first.root), comparablePath(repo), 'a subdirectory registers the repository root');
  const again = await reg.add(wt);
  assert.equal(again.id, first.id, 'a linked worktree is the same project');
  assert.equal((await reg.list()).length, 1);

  const other = await reg.add(await makeRepo());
  assert.notEqual(other.id, first.id);

  const reloaded = new ProjectRegistry(file);
  assert.deepEqual((await reloaded.list()).map((p) => p.id).sort(), [first.id, other.id].sort());
  assert.equal((await reloaded.get(first.id))?.name, 'My project');
  assert.equal(await reloaded.remove(first.id), true);
  assert.equal(await reloaded.remove(first.id), false);
  assert.equal((await new ProjectRegistry(file).list()).length, 1);
});

test('project registry: accepts directories and tolerates a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-reg-'));
  const file = path.join(dir, 'projects.json');
  const reg = new ProjectRegistry(file);
  const project = await reg.add(dir);
  assert.equal(project.root, realPath(dir));
  await assert.rejects(reg.add(path.join(dir, 'missing')));
  const broken = path.join(dir, 'broken');
  await fs.mkdir(path.join(broken, '.git'), { recursive: true });
  await assert.rejects(reg.add(broken), /cannot identify the Git repository/);
  await fs.writeFile(file, '{not json');
  assert.deepEqual(await reg.list(), []);
});

test('initializing Git preserves a directory project identity and execution slot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-init-project-'));
  const file = path.join(dir, 'projects.json');
  const registry = new ProjectRegistry(file);
  const project = await registry.add(dir);
  const before = await identifyProject(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  const after = await identifyProject(dir);
  assert.equal(after.slotKey, before.slotKey);
  assert.equal((await registry.get(project.id))?.root, project.root);
  assert.equal((await registry.add(dir)).id, project.id);
  assert.equal((await new ProjectRegistry(file).list()).length, 1);
});

test('legacy project IDs are saved before a directory changes identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-legacy-project-'));
  const file = path.join(dir, 'projects.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [{ name: 'legacy', root: dir, addedAt: '2026-01-01' }] }));
  const registry = new ProjectRegistry(file);
  const before = (await registry.list())[0];
  await registry.stabilize();
  await git(dir, ['init', '-q', '-b', 'main']);
  assert.equal((await new ProjectRegistry(file).list())[0].id, before.id);
});

test('project registry does not trust path-like stored IDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rb-invalid-project-id-'));
  const file = path.join(dir, 'projects.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [{ id: '../other', name: 'local', root: dir, addedAt: '2026-01-01' }] }));
  const registry = new ProjectRegistry(file);
  const project = (await registry.list())[0];
  assert.match(project.id, /^[0-9a-z]{7}$/);
  await registry.stabilize();
  assert.equal((await new ProjectRegistry(file).list())[0].id, project.id);
});

test('concurrent adds do not lose entries', async () => {
  const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rb-reg-')), 'projects.json');
  const reg = new ProjectRegistry(file);
  const repos = await Promise.all([makeRepo(), makeRepo(), makeRepo()]);
  await Promise.all(repos.map((r) => reg.add(r)));
  assert.equal((await new ProjectRegistry(file).list()).length, 3);
});
