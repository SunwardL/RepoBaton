import path from 'node:path';
import { exists, readJson } from './util.ts';

export interface Detected {
  test?: string;
  setup?: string;
  note: string;
}

/** Guess the project's test and dependency-install commands from marker files. */
export async function detectProject(dir: string): Promise<Detected> {
  const has = (f: string): Promise<boolean> => exists(path.join(dir, f));

  if (await has('package.json')) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (await readJson<{ scripts?: Record<string, string> }>(path.join(dir, 'package.json'))).scripts ?? {};
    } catch {
      /* ignore malformed package.json */
    }
    const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) || (await has('bun.lock')) ? 'bun' : 'npm';
    let setup: string;
    if (pm === 'pnpm') setup = 'pnpm install --frozen-lockfile';
    else if (pm === 'yarn') setup = 'yarn install --frozen-lockfile';
    else if (pm === 'bun') setup = 'bun install';
    else setup = (await has('package-lock.json')) ? 'npm ci' : 'npm install';
    const t = scripts.test;
    const real = t && !/no test specified/i.test(t);
    return {
      test: real ? (pm === 'npm' ? 'npm test' : `${pm} test`) : undefined,
      setup,
      note: `node project (${pm})`,
    };
  }
  if ((await has('pyproject.toml')) || (await has('pytest.ini')) || (await has('setup.py')) || (await has('tox.ini'))) {
    return { test: 'python -m pytest -q', note: 'python project' };
  }
  if (await has('go.mod')) return { test: 'go test ./...', note: 'go module' };
  if (await has('Cargo.toml')) return { test: 'cargo test', note: 'rust crate' };
  if ((await has('pom.xml'))) return { test: 'mvn -q test', note: 'maven project' };
  if ((await has('build.gradle')) || (await has('build.gradle.kts'))) {
    return { test: (await has('gradlew')) ? './gradlew test' : 'gradle test', note: 'gradle project' };
  }
  return { note: 'no known project type' };
}
