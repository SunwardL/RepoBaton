import { createHash } from 'node:crypto';
import { FLOW_SCHEMA, MAX_FLOW_STEPS, STEP_ID_PATTERN, type FlowIssue, type InputRef, type Workflow } from './flow-types.ts';

// ---- Reference parsing -------------------------------------------------------------------

export interface ParsedTemplate {
  refs: InputRef[];
  errors: string[];
}

const STEP_REF = /^steps\.([a-z][a-z0-9_-]{0,31})\.(output|exit_code)$/;

/** Parses every `{{ }}` in a templated field. Unknown forms are errors; nothing passes through. */
export function parseTemplate(text: string): ParsedTemplate {
  const refs: InputRef[] = [];
  const errors: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) break;
    const close = text.indexOf('}}', open + 2);
    if (close < 0) {
      errors.push('引用没有闭合：缺少 }}');
      break;
    }
    const body = text.slice(open + 2, close).trim();
    const ref = parseRef(body);
    if (ref) refs.push(ref);
    else errors.push(`不支持的引用 {{${body}}}：只支持 task、steps.<id>.output、steps.<id>.exit_code、file:<相对路径>`);
    i = close + 2;
  }
  return { refs, errors };
}

function parseRef(body: string): InputRef | undefined {
  if (body === 'task') return { kind: 'task' };
  if (body.startsWith('file:')) {
    const p = body.slice(5).trim();
    return p ? { kind: 'file', path: p } : undefined;
  }
  const m = STEP_REF.exec(body);
  if (!m) return undefined;
  return m[2] === 'output' ? { kind: 'step-output', step: m[1] } : { kind: 'step-exit-code', step: m[1] };
}

/** Returns a reason when the path may not be read from the worktree, otherwise undefined. */
export function badFilePath(p: string): string | undefined {
  if (!p || /[\0\r\n]/.test(p)) return '路径为空或含有控制字符';
  if (p.startsWith('/') || p.startsWith('\\')) return '必须是相对路径';
  if (/^[a-zA-Z]:/.test(p)) return '必须是相对路径，不能带盘符';
  const parts: string[] = [];
  for (const seg of p.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return '路径不能越出工作区';
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return '路径为空';
  if (parts.some((s) => s.toLowerCase() === '.git' || s.toLowerCase() === '.repobaton')) {
    return '不能指向 .git 或 .repobaton';
  }
  return undefined;
}

// ---- Hash --------------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the workflow with keys sorted, so key order never changes the hash. */
export function workflowHash(w: Workflow): string {
  return createHash('sha256').update(JSON.stringify(canonical(w))).digest('hex');
}

// ---- Validation --------------------------------------------------------------------------

export interface ValidateOptions {
  hasAgent: (id: string) => boolean;
}

type Add = (level: FlowIssue['level'], message: string, step?: string, field?: string) => void;

const STEP_TYPES = ['agent', 'command', 'approval', 'commit'];
const ACCESS = ['read-only', 'workspace-write'];
const GIT_MODES = ['none', 'explicit-step', 'agent-managed'];
const PUBLISH_FLAGS = ['push', 'createPr', 'draftPr', 'merge', 'tag'];
const PUBLISH_TEXT = ['tagPrefix', 'remote'];

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;

function refKey(ref: InputRef): string {
  switch (ref.kind) {
    case 'task': return 'task';
    case 'step-output': return `steps.${ref.step}.output`;
    case 'step-exit-code': return `steps.${ref.step}.exit_code`;
    case 'file': return `file:${ref.path}`;
  }
}

function toRef(v: unknown): InputRef | undefined {
  if (!isRecord(v)) return undefined;
  if (v.kind === 'task') return { kind: 'task' };
  if ((v.kind === 'step-output' || v.kind === 'step-exit-code') && typeof v.step === 'string') return { kind: v.kind, step: v.step };
  if (v.kind === 'file' && typeof v.path === 'string') return { kind: 'file', path: v.path };
  return undefined;
}

function validatePublish(publish: unknown, mode: unknown, add: Add): void {
  const field = 'git.publish';
  if (!isRecord(publish)) {
    add('error', 'Git 策略里的 publish 必须是对象', undefined, field);
    return;
  }
  for (const [key, value] of Object.entries(publish)) {
    if (PUBLISH_FLAGS.includes(key)) {
      if (typeof value !== 'boolean') add('error', `publish.${key} 必须是 true 或 false`, undefined, field);
    } else if (PUBLISH_TEXT.includes(key)) {
      if (typeof value !== 'string' || !value.trim() || /[\s\0]/.test(value)) add('error', `publish.${key} 必须是不含空白的非空文本`, undefined, field);
    } else add('error', `publish 里有不认识的字段 ${key}`, undefined, field);
  }
  const on = PUBLISH_FLAGS.filter((k) => publish[k] === true);
  if (on.length && mode !== 'explicit-step') {
    add('error', 'Git 策略里的 publish 只能和 explicit-step 一起使用', undefined, 'git.publish');
  }
  if (publish.createPr === true && publish.push !== true) add('error', 'publish.createPr 需要同时开启 push', undefined, 'git.publish');
  if (publish.merge === true && publish.createPr !== true) add('error', 'publish.merge 需要同时开启 createPr', undefined, 'git.publish');
}

/**
 * Validates a workflow without touching disk or the network. Used when saving and again before a
 * run starts, so both paths report identical problems. Accepts `unknown` because the input may be
 * an imported YAML document or a request body.
 */
export function validateWorkflow(input: unknown, opts: ValidateOptions): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const add: Add = (level, message, step, field) =>
    issues.push({ level, message, ...(step !== undefined ? { step } : {}), ...(field !== undefined ? { field } : {}) });

  if (!isRecord(input)) {
    add('error', '流程必须是一个对象');
    return issues;
  }
  if (input.schema !== FLOW_SCHEMA) add('error', `schema 必须是 ${FLOW_SCHEMA}`, undefined, 'schema');
  if (input.kind !== 'custom' && input.kind !== 'builtin:four-stage') {
    add('error', 'kind 必须是 custom 或 builtin:four-stage', undefined, 'kind');
  }
  if (typeof input.name !== 'string' || !input.name.trim()) add('error', '流程名称不能为空', undefined, 'name');

  const git = isRecord(input.git) ? input.git : undefined;
  const mode: unknown = git?.mode;
  if (!git) {
    add('error', 'Git 策略必须是一个对象，例如 { mode: none }', undefined, 'git');
  } else if (typeof mode !== 'string' || !GIT_MODES.includes(mode)) {
    add('error', 'Git 策略 mode 必须是 none 或 explicit-step', undefined, 'git.mode');
  } else if (mode === 'agent-managed') {
    add('error', 'Git 策略 agent-managed 暂未开放，请使用 none 或 explicit-step', undefined, 'git.mode');
  }
  if (git && git.publish !== undefined) validatePublish(git.publish, mode, add);

  if (!Array.isArray(input.steps)) {
    add('error', '步骤必须是列表', undefined, 'steps');
    return issues;
  }
  const steps: unknown[] = input.steps;
  if (steps.length < 1) add('error', '流程至少需要 1 个步骤', undefined, 'steps');
  if (steps.length > MAX_FLOW_STEPS) add('error', `流程至多 ${MAX_FLOW_STEPS} 个步骤，当前 ${steps.length} 个`, undefined, 'steps');

  // First pass: ids, so references can tell missing from later.
  const position = new Map<string, number>();
  const types = new Map<string, string>();
  const envNames = new Map<string, string>();
  steps.forEach((s, index) => {
    const rawId = isRecord(s) ? s.id : undefined;
    if (!isRecord(s) || typeof rawId !== 'string' || !STEP_ID_PATTERN.test(rawId)) {
      add('error', `第 ${index + 1} 个步骤的步骤 id 不合法：需要小写字母开头，只含小写字母、数字、_、-，最长 32 位`, typeof rawId === 'string' ? rawId : undefined, 'id');
      return;
    }
    if (position.has(rawId)) {
      add('error', `步骤 id ${rawId} 重复`, rawId, 'id');
      return;
    }
    position.set(rawId, index);
    const upper = rawId.toUpperCase().replace(/-/g, '_');
    const clash = envNames.get(upper);
    if (clash) {
      add('error', `步骤 id ${rawId} 与 ${clash} 会映射到同一个环境变量名 ${upper}，请改一个`, rawId, 'id');
    } else envNames.set(upper, rawId);
    types.set(rawId, typeof s.type === 'string' ? s.type : '');
  });

  steps.forEach((s, index) => {
    const rawId = isRecord(s) ? s.id : undefined;
    if (!isRecord(s) || typeof rawId !== 'string' || position.get(rawId) !== index) return;
    const id = rawId;
    const err = (message: string, field?: string) => add('error', message, id, field);
    const warn = (message: string, field?: string) => add('warning', message, id, field);
    if (typeof s.title !== 'string' || !s.title.trim()) err('步骤标题不能为空', 'title');
    if (s.model !== undefined && (typeof s.model !== 'string' || /[\r\n\0]/.test(s.model) || s.model.length > 200)) {
      err('model 必须是单行文本', 'model');
    }
    const type = s.type;
    if (typeof type !== 'string' || !STEP_TYPES.includes(type)) {
      err(`步骤类型必须是 ${STEP_TYPES.join('、')}`, 'type');
      return;
    }

    const checkRef = (ref: InputRef, field: string) => {
      if (ref.kind === 'task') return;
      if (ref.kind === 'file') {
        const bad = badFilePath(ref.path);
        if (bad) err(`文件引用 ${ref.path} 不可用：${bad}`, field);
        return;
      }
      const at = position.get(ref.step);
      if (at === undefined) return err(`引用的步骤 ${ref.step} 不存在`, field);
      if (at >= index) return err(`步骤 ${ref.step} 排在引用它的步骤之后（或就是它自己），只能引用前面的步骤`, field);
      const t = types.get(ref.step);
      if (ref.kind === 'step-exit-code' && t !== 'command') {
        err(`步骤 ${ref.step} 不是命令步骤，没有退出码`, field);
      } else if (ref.kind === 'step-output' && (t === 'approval' || t === 'commit')) {
        err(`步骤 ${ref.step} 是${t === 'approval' ? '确认' : '提交'}步骤，没有输出可引用`, field);
      }
    };

    const checkTemplated = (text: unknown, field: string, declared?: unknown) => {
      const parsed = parseTemplate(typeof text === 'string' ? text : '');
      for (const e of parsed.errors) err(e, field);
      for (const ref of parsed.refs) checkRef(ref, field);
      if (declared === undefined) return;
      if (!Array.isArray(declared)) return err('inputs 必须是列表', 'inputs');
      const used = new Set(parsed.refs.map(refKey));
      const listed = new Set<string>();
      for (const d of declared) {
        const ref = toRef(d);
        if (!ref) {
          err('inputs 中有无法识别的项', 'inputs');
          continue;
        }
        checkRef(ref, 'inputs');
        listed.add(refKey(ref));
      }
      for (const key of used) {
        if (key !== 'task' && !listed.has(key)) warn(`正文引用了 ${key}，但未在 inputs 中声明（以正文为准）`, 'inputs');
      }
      for (const key of listed) {
        if (!used.has(key)) warn(`inputs 声明了 ${key}，但正文没有用到（以正文为准）`, 'inputs');
      }
    };

    /** Command steps: `inputs` is the only way to hand values over, so it is checked on its own. */
    const checkDeclared = (declared: unknown) => {
      if (declared === undefined) return;
      if (!Array.isArray(declared)) return err('inputs 必须是列表', 'inputs');
      for (const d of declared) {
        const ref = toRef(d);
        if (ref) checkRef(ref, 'inputs');
        else err('inputs 中有无法识别的项', 'inputs');
      }
    };

    const timeout = (v: unknown) => {
      if (v !== undefined && !posInt(v)) err('timeoutSec 必须是正整数', 'timeoutSec');
    };
    const outputSpec = (v: unknown) => {
      if (!isRecord(v) || (v.kind !== 'text' && v.kind !== 'json')) return err('output.kind 必须是 text', 'output');
      if (v.kind === 'json') err('该版本暂不执行结构化输出，请使用 text', 'output');
    };

    switch (type) {
      case 'agent': {
        const agent = s.agent;
        if (typeof agent !== 'string' || !opts.hasAgent(agent)) err(`Agent ${String(agent)} 未配置`, 'agent');
        const fb = s.fallbackAgent;
        if (fb !== undefined) {
          if (typeof fb !== 'string' || !opts.hasAgent(fb)) err(`备用 Agent ${String(fb)} 未配置`, 'fallbackAgent');
          else if (fb === agent) err('备用 Agent 不能与主 Agent 相同', 'fallbackAgent');
        }
        const access = s.access;
        if (typeof access !== 'string' || !ACCESS.includes(access)) err('access 必须是 read-only 或 workspace-write', 'access');
        const prompt = s.prompt;
        if (typeof prompt !== 'string' || !prompt.trim()) err('提示词不能为空', 'prompt');
        timeout(s.timeoutSec);
        outputSpec(s.output);
        checkTemplated(prompt, 'prompt', s.inputs);
        break;
      }
      case 'command': {
        const run = s.run;
        if (typeof run !== 'string' || !run.trim()) err('命令不能为空', 'run');
        else if (/[\r\n]/.test(run)) err('命令必须写成一行', 'run');
        else if (run.includes('{{')) {
          // Values are never spliced into a command line: an output containing & | " % or a newline
          // would become extra commands. They are passed as environment variables instead.
          err('命令行里不能写 {{ }} 引用：请在 inputs 声明需要的值，命令通过环境变量读取（见 RB_TASK、RB_STEP_<ID>_OUTPUT、RB_STEP_<ID>_EXIT_CODE、RB_FILE_<序号>）', 'run');
        }
        timeout(s.timeoutSec);
        const ok = s.okExitCodes;
        if (ok !== undefined && (!Array.isArray(ok) || !ok.length || !ok.every((c) => typeof c === 'number' && Number.isInteger(c)))) {
          err('okExitCodes 必须是非空的整数列表', 'okExitCodes');
        }
        outputSpec(s.output);
        checkDeclared(s.inputs);
        break;
      }
      case 'approval': {
        const show = s.show;
        if (!Array.isArray(show) || !show.length) {
          err('确认步骤至少需要展示一项内容（show）', 'show');
        } else {
          for (const d of show) {
            const ref = toRef(d);
            if (ref) checkRef(ref, 'show');
            else err('show 中有无法识别的项', 'show');
          }
        }
        if (s.message !== undefined) {
          if (typeof s.message !== 'string') err('message 必须是文本', 'message');
          else checkTemplated(s.message, 'message');
        }
        break;
      }
      case 'commit': {
        const message = s.message;
        if (typeof message !== 'string' || !message.trim()) err('提交说明不能为空', 'message');
        if (mode !== 'explicit-step') err('提交步骤要求 Git 策略为 explicit-step', 'type');
        const paths = s.paths;
        if (paths !== undefined) {
          if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) err('paths 必须是路径列表', 'paths');
          else for (const p of paths as string[]) {
            const bad = badFilePath(p);
            if (bad) err(`提交路径 ${p} 不可用：${bad}`, 'paths');
          }
        }
        checkTemplated(message, 'message');
        break;
      }
    }
  });
  return issues;
}
