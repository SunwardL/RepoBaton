import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentRegistry } from './agents/registry.ts';
import { noopSink, type EventSink } from './events.ts';
import { commandEnv, readWorktreeFile } from './flow-io.ts';
import * as G from './git.ts';
import { parseTemplate, requestsPublish, workflowHash } from './flow.ts';
import { fingerprintRemoteAddress } from './flow-config.ts';
import { renderPrompt, type RenderSources } from './flow-render.ts';
import { readStepOutput, stepOutputFile, writeStepOutput, writeStepPrompt } from './flow-store.ts';
import type { ApprovalStep, InputRef } from './flow-types.ts';
import { runShell } from './proc.ts';
import { redactDeep, redactDiagnostic } from './redact.ts';
import type { RunStore } from './store.ts';
import { AgentError, type RunState, type StageSession } from './types.ts';
import { nowIso, tail, writeFileAtomic } from './util.ts';

async function resolveInputs(state: RunState, store: RunStore, refs: InputRef[]): Promise<{ sources: RenderSources; files: Map<string, string> }> {
  if (!state.worktree || !state.steps) throw new Error('custom workflow has no worktree or steps');
  const sources: RenderSources = { task: state.task, outputs: new Map(), exitCodes: new Map(), files: new Map() };
  const files = new Map<string, string>();
  for (const ref of refs) {
    if (ref.kind === 'step-output') {
      const output = await readStepOutput(store.dir(state.id), ref.step);
      if (state.steps[ref.step]?.status !== 'succeeded' || output.status !== 'succeeded') throw new Error(`step ${ref.step} output is ${output.status}`);
      sources.outputs.set(ref.step, output);
    } else if (ref.kind === 'step-exit-code') {
      const previous = state.steps[ref.step];
      if (previous?.status !== 'succeeded' || typeof previous.exitCode !== 'number') throw new Error(`step ${ref.step} has no exit code`);
      sources.exitCodes.set(ref.step, previous.exitCode);
    } else if (ref.kind === 'file') {
      const file = await readWorktreeFile(state.worktree, ref.path, { maxBytes: 32 * 1024 });
      if (!file.ok) throw new Error(file.reason);
      sources.files.set(ref.path, file);
      files.set(ref.path, file.realPath);
    }
  }
  return { sources, files };
}

/** Render exactly what an approval shows; re-render it when the user confirms. */
export async function flowApprovalPreview(state: RunState, store: RunStore, step: ApprovalStep, ops: G.RemoteOps = G.realRemoteOps): Promise<NonNullable<import('./flow-types.ts').StepState['approvalPreview']>> {
  const references = step.show.map((ref) => {
    if (ref.kind === 'task') return '{{task}}';
    if (ref.kind === 'step-output') return `{{steps.${ref.step}.output}}`;
    if (ref.kind === 'step-exit-code') return `{{steps.${ref.step}.exit_code}}`;
    return `{{file:${ref.path}}}`;
  });
  const template = [step.message ?? '', ...references].filter(Boolean).join('\n\n');
  const parsed = parseTemplate(template);
  if (parsed.errors.length) throw new Error(parsed.errors.join('; '));
  const { sources } = await resolveInputs(state, store, parsed.refs);
  const rendered = renderPrompt(template, sources);
  if (!rendered.ok) throw new Error(rendered.reason);
  let content = rendered.text;
  let approvedHead: string | undefined;
  let approvedBranch: string | undefined;
  let approvedDraftHash: string | undefined;
  let approvedTarget: { remote: string; url: string; fingerprint: string } | undefined;
  if (state.flow && requestsPublish(state.flow.workflow.git) && state.flow.workflow.steps.at(-1)?.id === step.id) {
    if (!state.worktree || !state.branch || state.workspaceMode === 'directory') throw new Error('publishing requires a Git worktree and task branch');
    approvedHead = await G.headSha(state.worktree);
    approvedBranch = await G.currentBranch(state.worktree);
    if (approvedBranch !== state.branch) throw new Error('restore the task branch before approving publication');
    if (await G.isDirty(state.worktree)) throw new Error('commit or remove the uncommitted changes before approving publication');
    const remote = state.flow.publishConfig?.remote ?? state.flow.workflow.git.publish?.remote ?? 'origin';
    const addresses = await ops.pushUrls(state.repo, remote);
    if (addresses.length !== 1) throw new Error(`remote ${remote} must have exactly one push destination`);
    const url = G.sanitizeRemoteUrl(addresses[0]);
    if (!url) throw new Error(`remote ${remote} has no usable push destination`);
    const fingerprint = await fingerprintRemoteAddress(addresses[0], !state.steps?.[step.id]?.approval);
    approvedTarget = { remote, url, fingerprint };
    const flags = state.flow.publishConfig ?? state.flow.workflow.git.publish!;
    const draft = state.release;
    if (!draft) throw new Error('publication draft is missing');
    if (flags.createPr && (!state.base?.branch || !G.githubRepoOf(addresses[0]))) throw new Error('creating a PR requires a GitHub push destination and a base branch');
    if (flags.tag) {
      const tag = `${flags.tagPrefix ?? 'v'}${draft.suggested_version}`;
      await G.git(state.repo, ['check-ref-format', `refs/tags/${tag}`]);
    }
    approvedDraftHash = createHash('sha256').update(JSON.stringify(redactDeep(draft, { assignments: true }))).digest('hex');
    const actions = [flags.push && '推送分支', flags.createPr && (flags.draftPr && !flags.merge ? '创建草稿 PR' : '创建 PR'),
      flags.merge && '压缩合并 PR 并删除分支', flags.tag && `推送标签 ${flags.tagPrefix ?? 'v'}${draft.suggested_version}`].filter(Boolean).join(' → ');
    const releaseText = [flags.createPr ? `PR 标题：${draft.pr_title}\nPR 内容：\n${draft.pr_body}` : '',
      flags.tag ? `标签版本：${draft.suggested_version}\n发布说明：\n${draft.release_notes}` : ''].filter(Boolean).join('\n\n');
    content = `发布确认\n提交：${approvedHead}\n分支：${approvedBranch}${flags.createPr ? `\nPR 基底分支：${state.base!.branch}` : ''}\n目标：${remote} (${url})\n操作：${actions}${releaseText ? `\n\n${releaseText}` : ''}\n\n${content}`;
  }
  content = redactDiagnostic(content);
  return { content, contentHash: createHash('sha256').update(JSON.stringify({ content, targetFingerprint: approvedTarget?.fingerprint })).digest('hex'),
    ...(approvedHead ? { approvedHead, approvedBranch, approvedDraftHash, approvedTarget } : {}) };
}

/** Execute custom steps sequentially, saving a checkpoint before every side effect. */
export async function executeFlow(state: RunState, store: RunStore, registry: AgentRegistry, signal?: AbortSignal, events: EventSink = noopSink, ops: G.RemoteOps = G.realRemoteOps): Promise<void> {
  const flow = state.flow;
  if (!flow || !state.worktree || !state.steps) throw new Error('custom workflow is missing its state or worktree');
  if (workflowHash(flow.workflow) !== flow.hash) throw new Error('workflow snapshot changed; refusing to resume');
  const runDir = store.dir(state.id);
  for (const step of flow.workflow.steps) {
    const checkpoint = state.steps[step.id];
    if (!checkpoint) throw new Error(`missing checkpoint for ${step.id}`);
    if (checkpoint.status === 'succeeded') {
      if (step.type === 'agent' || step.type === 'command') {
        const output = await readStepOutput(runDir, step.id);
        if (output.status !== 'succeeded') throw new Error(`step ${step.id} output is ${output.status}`);
      }
      continue;
    }
    if (checkpoint.status !== 'pending') {
      if (checkpoint.status === 'running') {
        checkpoint.status = 'unknown';
        checkpoint.reason = 'execution stopped before the result was saved';
        await store.save(state);
      }
      state.status = 'needs-human';
      state.error = `step ${step.id} requires review (${checkpoint.status})`;
      return;
    }
    if (signal?.aborted) throw new Error('cancelled');
    const refs: InputRef[] = step.type === 'agent' ? parseTemplate(step.prompt).refs : step.type === 'command' ? step.inputs ?? [] : step.type === 'commit' ? parseTemplate(step.message).refs : [];
    let sources: RenderSources;
    let files: Map<string, string>;
    try {
      ({ sources, files } = await resolveInputs(state, store, refs));
    } catch (error) {
      checkpoint.status = 'failed';
      checkpoint.reason = (error as Error).message;
      checkpoint.finishedAt = nowIso();
      await store.save(state);
      events.emit('step.finished', `${step.title}: ${checkpoint.reason}`, { stage: step.id, data: { stepId: step.id, status: 'failed' } });
      throw error;
    }
    let prompt = '';
    if (step.type === 'agent' || step.type === 'commit') {
      const rendered = renderPrompt(step.type === 'agent' ? step.prompt : step.message, sources);
      if (!rendered.ok) {
        checkpoint.status = 'failed';
        checkpoint.reason = rendered.reason;
        checkpoint.finishedAt = nowIso();
        await store.save(state);
        events.emit('step.finished', `${step.title}: ${checkpoint.reason}`, { stage: step.id, data: { stepId: step.id, status: 'failed' } });
        throw new Error(rendered.reason);
      }
      prompt = rendered.text;
      checkpoint.truncatedRefs = rendered.truncated;
    }
    if (step.type === 'approval') {
      try {
        checkpoint.approvalPreview = await flowApprovalPreview(state, store, step, ops);
      } catch (error) {
        checkpoint.status = 'failed';
        checkpoint.reason = (error as Error).message;
        checkpoint.finishedAt = nowIso();
        await store.save(state);
        events.emit('step.finished', `${step.title}: ${checkpoint.reason}`, { stage: step.id, data: { stepId: step.id, status: 'failed' } });
        throw error;
      }
      state.status = 'needs-human';
      state.error = undefined;
      state.stage = step.id;
      await store.save(state);
      events.emit('step.waiting', `${step.title}: 等待人工确认`, { stage: step.id, data: { stepId: step.id } });
      return;
    }
    checkpoint.status = 'running';
    checkpoint.startedAt = nowIso();
    checkpoint.attempt++;
    state.stage = step.id;
    await store.save(state);
    events.emit('step.started', step.title, { stage: step.id, data: { stepId: step.id, type: step.type, attempt: checkpoint.attempt } });
    let session: StageSession | undefined;
    let sideEffectReturned = false;
    const observeAgentWorkspace = step.type === 'agent' && state.workspaceMode !== 'directory' &&
      (flow.workflow.git.mode === 'agent-managed' || step.access === 'read-only');
    try {
      let output: string;
      if (step.type === 'agent') {
        checkpoint.promptRef = await writeStepPrompt(runDir, step.id, checkpoint.attempt, prompt);
        await store.save(state);
        if (observeAgentWorkspace) {
          checkpoint.headBefore = await G.headSha(state.worktree);
          checkpoint.branchBefore = await G.currentBranch(state.worktree);
          checkpoint.dirtyBefore = await G.isDirty(state.worktree);
          await store.save(state);
        }
        const previousAgent = checkpoint.agent;
        const previousId = checkpoint.sessionId;
        let result: Awaited<ReturnType<ReturnType<AgentRegistry['get']>['run']>> | undefined;
        for (const agentId of [step.agent, ...(step.fallbackAgent ? [step.fallbackAgent] : [])]) {
          const agent = registry.get(agentId);
          const previousSession = (agent.type === 'codex-cli' || agent.type === 'claude-cli') && previousAgent === agentId && previousId
            ? [...(state.sessions ?? [])].reverse().find((item) => item.agent === agentId && item.sessionId === previousId && item.sessionConfirmed !== false)
            : undefined;
          checkpoint.agent = agentId;
          checkpoint.agentType = agent.type;
          checkpoint.sessionId = previousSession?.sessionId;
          const currentSession: StageSession = { label: step.title, stage: step.access === 'read-only' ? 'plan' : 'implement',
            agent: agentId, agentType: agent.type, persisted: agent.type === 'codex-cli' || agent.type === 'claude-cli',
            cwd: state.worktree, status: 'running', startedAt: nowIso() };
          session = currentSession;
          (state.sessions ??= []).push(currentSession);
          await store.save(state);
          try {
            result = await agent.run({
              stage: step.access === 'read-only' ? 'plan' : 'implement', prompt, cwd: state.worktree,
              access: step.access, model: agentId === step.agent ? step.model : undefined, timeoutMs: (step.timeoutSec ?? 900) * 1000, signal,
              sessionId: previousSession?.sessionId,
              persist: agent.type === 'codex-cli' || agent.type === 'claude-cli',
              onSession: (id, confirmed = true) => { checkpoint.sessionId = id; currentSession.sessionId = id; currentSession.sessionConfirmed = confirmed; void store.save(state).catch(() => undefined); },
              onLaunch: (cli) => { currentSession.cli = cli; void store.save(state).catch(() => undefined); },
              onProgress: (message) => events.emit('agent.progress', message.slice(0, 500), { stage: step.id, data: { stepId: step.id, agent: agentId } }),
            });
            break;
          } catch (error) {
            if (agentId !== step.agent || !step.fallbackAgent || signal?.aborted ||
                (error instanceof AgentError && (error.kind === 'timeout' || error.kind === 'cancelled'))) throw error;
            currentSession.status = 'failed';
            currentSession.finishedAt = nowIso();
            if (error instanceof AgentError && error.sessionId) {
              currentSession.sessionId = error.sessionId;
              currentSession.sessionConfirmed = error.sessionConfirmed;
            }
            await store.save(state);
            events.emit('agent.failed', `${agentId} failed; switching to ${step.fallbackAgent}: ${redactDiagnostic((error as Error).message).slice(0, 500)}`,
              { stage: step.id, data: { stepId: step.id, agent: agentId, fallbackAgent: step.fallbackAgent } });
          }
        }
        if (!result || !session) throw new Error('no agent produced a result');
        sideEffectReturned = true;
        session.status = 'completed';
        session.finishedAt = nowIso();
        checkpoint.sessionId = result.sessionId ?? checkpoint.sessionId;
        session.sessionId = checkpoint.sessionId;
        if (result.sessionId) session.sessionConfirmed = true;
        state.usage.calls++;
        state.usage.costUsd += result.costUsd ?? 0;
        state.usage.inputTokens += result.inputTokens ?? 0;
        state.usage.outputTokens += result.outputTokens ?? 0;
        await store.save(state);
        if (observeAgentWorkspace) {
          checkpoint.headAfter = await G.headSha(state.worktree);
          checkpoint.branchAfter = await G.currentBranch(state.worktree);
          checkpoint.dirtyAfter = await G.isDirty(state.worktree);
          if (step.access === 'read-only') checkpoint.readOnlyChanged = checkpoint.headBefore !== checkpoint.headAfter || checkpoint.branchBefore !== checkpoint.branchAfter || checkpoint.dirtyBefore !== checkpoint.dirtyAfter;
        }
        output = result.text;
      } else if (step.type === 'command') {
        const taskFile = path.join(runDir, 'task.txt');
        await writeFileAtomic(taskFile, redactDiagnostic(state.task), 0o600);
        const outputFiles = new Map<string, string>();
        for (const ref of refs) if (ref.kind === 'step-output') {
          const result = await stepOutputFile(runDir, ref.step);
          if (!result.ok) throw new Error(result.reason);
          outputFiles.set(ref.step, result.file);
        }
        const env = commandEnv({ taskFile, refs, outputFile: (id) => outputFiles.get(id)!,
          exitCode: (id) => sources.exitCodes.get(id), resolvedFile: (name) => files.get(name)! });
        const result = await runShell(step.run, { cwd: state.worktree, env, timeoutMs: (step.timeoutSec ?? 900) * 1000, signal });
        if (result.timedOut || result.aborted) {
          checkpoint.status = 'unknown';
          throw new Error('command was interrupted; its outcome is unknown');
        }
        if (result.error || result.code === null) throw new Error(result.error ?? 'command could not be started');
        checkpoint.exitCode = result.code;
        output = result.stdout + result.stderr;
        if (!(step.okExitCodes ?? [0]).includes(result.code)) {
          throw new Error(`command exited with code ${result.code}: ${redactDiagnostic(tail(output, 2000))}`);
        }
        sideEffectReturned = true;
      } else {
        const gitBusy = await G.unfinishedGitOperation(state.worktree);
        if (gitBusy) throw new Error(`Git has an unfinished operation or index lock (${gitBusy}); inspect the worktree before committing`);
        checkpoint.headBefore = await G.headSha(state.worktree);
        checkpoint.indexTreeBefore = (await G.git(state.worktree, ['write-tree'])).trim();
        const paths = step.paths?.length ? step.paths : ['.'];
        await G.git(state.worktree, ['add', '-A', '--', ...paths]);
        checkpoint.expectedTree = (await G.git(state.worktree, ['write-tree'])).trim();
        await store.save(state);
        if (checkpoint.expectedTree !== (await G.git(state.worktree, ['rev-parse', 'HEAD^{tree}'])).trim()) {
          try {
            await G.git(state.worktree, ['commit', '-q', '-F', '-'], { input: prompt });
          } catch (error) {
            checkpoint.status = 'unknown';
            throw error;
          }
        }
        checkpoint.headAfter = await G.headSha(state.worktree);
        if (checkpoint.headAfter !== checkpoint.headBefore) {
          const parent = (await G.git(state.worktree, ['rev-parse', 'HEAD^'])).trim();
          const tree = (await G.git(state.worktree, ['rev-parse', 'HEAD^{tree}'])).trim();
          if (parent !== checkpoint.headBefore || tree !== checkpoint.expectedTree) {
            checkpoint.status = 'unknown';
            throw new Error('the commit does not match the staged tree; review the worktree');
          }
        }
        checkpoint.status = 'succeeded';
        checkpoint.finishedAt = nowIso();
        await store.save(state);
        events.emit('step.finished', `${step.title}: 已完成`, { stage: step.id, data: { stepId: step.id, status: 'succeeded' } });
        continue;
      }
      const { meta } = await writeStepOutput(runDir, step.id, output, { status: 'succeeded', startedAt: checkpoint.startedAt, finishedAt: nowIso(), agent: checkpoint.agent, sessionId: checkpoint.sessionId, exitCode: checkpoint.exitCode ?? undefined });
      checkpoint.outputRef = { bytes: meta.storedBytes, sha256: meta.sha256, truncated: meta.storedTruncated, storedTruncated: meta.storedTruncated };
      checkpoint.status = 'succeeded';
      checkpoint.finishedAt = nowIso();
      await store.save(state);
      events.emit('step.finished', `${step.title}: 已完成`, { stage: step.id, data: { stepId: step.id, status: 'succeeded' } });
    } catch (error) {
      if (step.type === 'agent' && observeAgentWorkspace) {
        checkpoint.headAfter = await G.headSha(state.worktree).catch(() => undefined);
        checkpoint.branchAfter = await G.currentBranch(state.worktree).catch(() => undefined);
        checkpoint.dirtyAfter = await G.isDirty(state.worktree).catch(() => undefined);
        if (step.access === 'read-only' && checkpoint.headBefore !== undefined && checkpoint.branchBefore !== undefined && checkpoint.dirtyBefore !== undefined && checkpoint.headAfter !== undefined && checkpoint.branchAfter !== undefined && checkpoint.dirtyAfter !== undefined) {
          checkpoint.readOnlyChanged = checkpoint.headBefore !== checkpoint.headAfter || checkpoint.branchBefore !== checkpoint.branchAfter || checkpoint.dirtyBefore !== checkpoint.dirtyAfter;
        }
      }
      if (session && session.status === 'running') {
        session.status = 'failed';
        session.finishedAt = nowIso();
        if (error instanceof AgentError && error.sessionId) {
          checkpoint.sessionId = error.sessionId;
          session.sessionId = error.sessionId;
          session.sessionConfirmed = error.sessionConfirmed;
        }
      }
      if (checkpoint.status === 'running') checkpoint.status = signal?.aborted || sideEffectReturned || (error instanceof AgentError && (error.kind === 'timeout' || error.kind === 'cancelled')) ? 'unknown' : 'failed';
      checkpoint.reason = (error as Error).message;
      checkpoint.finishedAt = nowIso();
      await store.save(state);
      events.emit('step.finished', `${step.title}: ${checkpoint.reason}`, { stage: step.id, data: { stepId: step.id, status: checkpoint.status } });
      throw error;
    }
  }
  state.status = 'succeeded';
}
