import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AgentRegistry } from './agents/registry.ts';
import { detectProject } from './detect.ts';
import * as G from './git.ts';
import { FileEventSink, noopSink, type EventSink } from './events.ts';
import { silentLogger, type Logger } from './log.ts';
import { teeLogger } from './teelog.ts';
import { DEFAULT_PROMPTS, loadPrompt, PLAN_SCHEMA, RELEASE_SCHEMA, REVIEW_SCHEMA } from './prompts.ts';
import { runShell } from './proc.ts';
import { formatAcceptance, formatPlan, renderReport } from './report.ts';
import { newRunId, RunStore } from './store.ts';
import {
  AgentError,
  type AgentErrorKind,
  type AgentResult,
  type AgentRunRequest,
  type Config,
  type Plan,
  type ReleaseDraft,
  type ReviewResult,
  type Round,
  type RunState,
  type StageName,
  type StageSession,
} from './types.ts';
import { formatFeedback, judge } from './verdict.ts';
import { withWorkflow } from './workflow.ts';
import { redactDeep, redactDiagnostic } from './redact.ts';
import { ensureDir, nowIso, sleep, slugify, tail, truncate, validateSchema, readJson, exists } from './util.ts';

export class PipelineError extends Error {
  status: RunState['status'];
  /** Set when an agent failure ended the run, so the UI can say what to fix. */
  kind?: AgentErrorKind;
  agent?: string;
  constructor(message: string, status: RunState['status'] = 'failed') {
    super(redactDiagnostic(message));
    this.name = 'PipelineError';
    this.status = status;
  }
}

export interface PipelineOptions {
  repo: string;
  config: Config;
  log?: Logger;
  signal?: AbortSignal;
  registry?: AgentRegistry;
  /** Interactive plan approval. When absent and the stage requires approval the run pauses. */
  approvePlan?: (plan: Plan) => Promise<{ approved: true } | { approved: false; feedback: string }>;
  /** Override the configured publish actions for this run. */
  publishOverride?: Partial<Config['publish']>;
  /** Remote operations (push, gh, tags). Tests pass fakes so nothing reaches a real remote. */
  remote?: G.RemoteOps;
  /** Stamped onto every run this pipeline executes. Set by the local server, never by the CLI. */
  owner?: NonNullable<RunState['owner']>;
}

export interface ResumeOptions {
  moreRounds?: number;
  feedback?: string;
  approvePlan?: boolean;
}

const MAX_RAW_ARTIFACT = 2_000_000;

export class Pipeline {
  readonly store: RunStore;
  private cfg: Config;
  private baseConfig: Config;
  private log: Logger;
  private baseLog: Logger;
  private events: EventSink = noopSink;
  private repo: string;
  private registry: AgentRegistry;
  private signal?: AbortSignal;
  private opts: PipelineOptions;
  private ops: G.RemoteOps;

  constructor(opts: PipelineOptions) {
    this.opts = opts;
    this.ops = opts.remote ?? G.realRemoteOps;
    this.repo = opts.repo;
    this.baseConfig = this.cfg = opts.publishOverride
      ? { ...opts.config, publish: { ...opts.config.publish, ...opts.publishOverride } }
      : opts.config;
    this.baseLog = opts.log ?? silentLogger;
    this.log = this.baseLog;
    this.signal = opts.signal;
    this.registry = opts.registry ?? new AgentRegistry(this.cfg);
    this.store = new RunStore(this.repo);
  }

  // ------------------------------------------------------------------ entry points

  /** onCreated fires as soon as the run exists, so a caller can show it before the (long) execution ends. */
  async start(task: string, onCreated?: (id: string) => void, workflow?: RunState['workflow']): Promise<RunState> {
    this.cfg = withWorkflow(this.baseConfig, workflow);
    task = task.trim();
    if (!task) throw new PipelineError('task description is empty');
    if (!(await G.hasCommits(this.repo))) {
      throw new PipelineError('the repository has no commits yet; make an initial commit first');
    }
    const id = newRunId();
    const state: RunState = {
      id,
      task,
      workflow,
      repo: this.repo,
      status: 'running',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      rounds: [],
      publish: {},
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
      owner: this.opts.owner,
    };
    await this.store.save(state);
    await this.openEvents(state);
    this.events.emit('run.started', task.slice(0, 120).replace(/\s+/g, ' '), { data: { task } });
    this.log.info(`run ${id}`);
    onCreated?.(id);
    return this.execute(state);
  }

  async resume(idOrPrefix: string, ropts: ResumeOptions = {}): Promise<RunState> {
    const id = await this.store.resolve(idOrPrefix);
    const state = await this.store.load(id);
    if (state.status === 'succeeded') {
      this.log.info('run already succeeded; nothing to do');
      return state;
    }
    this.cfg = withWorkflow(this.baseConfig, state.workflow);
    if (state.status === 'awaiting-plan-approval' && !ropts.approvePlan && !ropts.feedback && !this.opts.approvePlan) {
      throw new PipelineError('this run is waiting for plan approval: use "repobaton approve <run>"', 'awaiting-plan-approval');
    }
    if (ropts.approvePlan) state.planApproved = true;
    if (ropts.moreRounds) state.extraRounds = (state.extraRounds ?? 0) + ropts.moreRounds;
    if (ropts.feedback) {
      // Feedback given while the plan is still unapproved is about the plan.
      if (state.status === 'awaiting-plan-approval' && !ropts.approvePlan) state.planFeedback = ropts.feedback;
      else state.pendingFeedback = ropts.feedback;
    }
    state.status = 'running';
    state.error = undefined;
    state.errorKind = undefined;
    state.errorAgent = undefined;
    state.interruptedAt = undefined;
    // A standalone CLI resume clears the owner: nothing server-side is executing it any more.
    state.owner = this.opts.owner;
    await this.store.save(state);
    await this.openEvents(state);
    this.events.emit('run.resumed', `resuming from ${state.stage ?? 'the start'}`, {
      data: { moreRounds: ropts.moreRounds, approvePlan: !!ropts.approvePlan, hasFeedback: !!ropts.feedback },
    });
    this.log.info(`resuming run ${state.id}`);
    return this.execute(state);
  }

  /** Each run owns <run>/events.jsonl; logs are mirrored into it. */
  private async openEvents(state: RunState): Promise<void> {
    this.events = await FileEventSink.open(this.store.dir(state.id), state.id);
    this.log = teeLogger(this.baseLog, this.events);
  }

  /** Reject the pending plan with feedback; the planner revises it and the run pauses again. */
  async rejectPlan(idOrPrefix: string, feedback: string): Promise<RunState> {
    const id = await this.store.resolve(idOrPrefix);
    const state = await this.store.load(id);
    if (state.status !== 'awaiting-plan-approval' || !state.plan) {
      throw new PipelineError('this run has no pending plan to reject');
    }
    return this.resume(id, { feedback: feedback.trim() || 'Please revise the plan.' });
  }

  // ------------------------------------------------------------------ main flow

  private async execute(state: RunState): Promise<RunState> {
    try {
      await this.prepare(state);
      if (this.cfg.stages.plan.enabled !== false && (!state.plan || state.planFeedback)) {
        await this.planStage(state);
        if (state.status === 'awaiting-plan-approval') return await this.finish(state);
      } else if (this.needsApproval(state)) {
        // Resumed without an approval decision: stay paused rather than guess.
        if (!(await this.confirmPlan(state))) return await this.finish(state);
      }
      const approved = await this.implementLoop(state);
      if (approved) {
        await this.releaseStage(state);
        state.status = 'succeeded';
      } else {
        state.status = 'needs-human';
        state.error = `not approved after ${state.rounds.length} round(s); inspect the worktree or resume with --more-rounds / --feedback`;
      }
    } catch (e) {
      if (this.signal?.aborted || (e instanceof AgentError && e.message === 'cancelled')) {
        state.status = 'cancelled';
        state.error = 'cancelled';
      } else if (e instanceof PipelineError) {
        state.status = e.status;
        state.error = e.message;
        state.errorKind = e.kind;
        state.errorAgent = e.agent;
      } else {
        state.status = 'failed';
        state.error = (e as Error).message;
      }
      this.log.error(state.error ?? 'failed');
    }
    return this.finish(state);
  }

  private async finish(state: RunState): Promise<RunState> {
    state.stage = undefined;
    // Order matters: readers treat a settled status in state.json as "no more events
    // are coming", so the closing event must be on disk before that status is.
    this.events.emit('run.finished', state.error ?? state.status, {
      data: { status: state.status, rounds: state.rounds.length, usage: state.usage },
    });
    await this.events.flush();
    await this.store.save(state);
    await fs.writeFile(path.join(this.store.dir(state.id), 'report.md'), renderReport(redactDeep(state, { assignments: true })), 'utf8');
    return state;
  }

  private checkpoint(state: RunState, stage: string): Promise<void> {
    if (this.signal?.aborted) throw new AgentError('cancelled', false);
    state.stage = stage;
    this.events.emit('stage.started', stage, { stage });
    return this.store.save(state);
  }

  // ------------------------------------------------------------------ prepare

  private async prepare(state: RunState): Promise<void> {
    if (state.worktree && (await exists(state.worktree))) {
      // A saved worktree whose setup never finished: complete it now (no-op when setup is done).
      await this.runSetup(state);
      return;
    }
    await this.checkpoint(state, 'prepare');
    const root = this.repo;
    if (await G.isDirty(root)) {
      this.log.warn('your working tree has uncommitted changes; the run starts from the committed base branch and will not include them');
    }
    const baseBranch = this.cfg.git.baseBranch || (await G.guessBaseBranch(root));
    // A resumed run keeps the base it was reviewed against, even if the base branch has moved on.
    if (!state.base) {
      const baseSha = await G.revParse(root, baseBranch).catch(() => {
        throw new PipelineError(`base branch "${baseBranch}" not found; set git.baseBranch`);
      });
      state.base = { branch: baseBranch, sha: baseSha };
    }
    const baseSha = state.base.sha;
    state.branch ??= `${this.cfg.git.branchPrefix}${slugify(state.task)}-${state.id.slice(-4)}`;
    const dir = path.resolve(root, this.cfg.git.worktreeDir, state.id);
    await G.excludeLocally(root, '/.repobaton/');
    // The folder may already be a worktree of this branch (a crash between creating it and saving state).
    if (!(await G.isWorktreeOf(dir, state.branch))) await G.addWorktree(root, dir, state.branch, baseSha);
    state.worktree = dir;
    // A recreated worktree has no installed dependencies: run setup again.
    state.setupDone = false;
    this.log.stage('prepare', `branch ${state.branch} from ${state.base.branch}@${baseSha.slice(0, 8)}`);
    await this.store.save(state);
    await this.runSetup(state);
  }

  private async runSetup(state: RunState): Promise<void> {
    if (state.setupDone || !state.worktree) return;
    const detected = await detectProject(state.worktree);
    const setup = this.cfg.test.setup ?? detected.setup;
    if (setup && this.cfg.test.setup !== '') {
      this.log.stage('setup', setup);
      const r = await runShell(setup, { cwd: state.worktree, timeoutMs: this.cfg.test.timeoutSec * 1000, signal: this.signal });
      if (r.code !== 0) this.log.warn(`setup command exited ${r.code}: ${tail(r.stderr || r.stdout, 300)}`);
    }
    state.setupDone = true;
    await this.store.save(state);
  }

  // ------------------------------------------------------------------ agent invocation

  private async invoke(
    state: RunState,
    stage: StageName,
    label: string,
    req: Pick<AgentRunRequest, 'prompt' | 'access' | 'schema' | 'sessionId' | 'persist'>,
    sessionAgent?: string,
  ): Promise<AgentResult & { agentId: string }> {
    const sc = this.cfg.stages[stage];
    const chain = [sc.agent, ...(sc.fallbackAgent ? [sc.fallbackAgent] : [])];
    const attempts = Math.max(0, sc.retries ?? 0) + 1;
    let lastErr: Error = new Error('no attempt made');
    for (const [idx, agentId] of chain.entries()) {
      const agent = this.registry.get(agentId);
      for (let n = 1; n <= attempts; n++) {
        if (this.signal?.aborted) throw new AgentError('cancelled', false);
        this.log.stage(stage, `${label} → ${agentId} [${agent.describe()}]${n > 1 ? ` (attempt ${n})` : ''}`);
        this.events.emit('agent.started', `${label} → ${agentId}`, {
          stage,
          data: { label, agent: agentId, attempt: n, access: req.access },
        });
        // Native Codex and Claude Code stage sessions are kept on disk so the user can find and continue them.
        const isNative = agent.type === 'codex-cli' || agent.type === 'claude-cli';
        const session: StageSession = {
          label,
          stage,
          round: Number(/-r(\d+)/.exec(label)?.[1]) || undefined,
          agent: agentId,
          agentType: agent.type,
          persisted: isNative || !!req.persist,
          cwd: state.worktree!,
          status: 'running',
          startedAt: nowIso(),
        };
        (state.sessions ??= []).push(session);
        await this.store.save(state);
        try {
          const res = await agent.run({
            ...req,
            persist: isNative ? true : req.persist,
            stage,
            cwd: state.worktree!,
            // Stage-level model/effort only apply to the stage's primary agent.
            model: idx === 0 ? sc.model : undefined,
            effort: idx === 0 ? sc.effort : undefined,
            timeoutMs: (sc.timeoutSec ?? 900) * 1000,
            signal: this.signal,
            sessionId: agentId === sessionAgent ? req.sessionId : undefined,
            onSession: (id, confirmed = true) => {
              if (session.sessionId === id) return;
              session.sessionId = id;
              session.sessionConfirmed = confirmed;
              // Fire and forget on purpose: the call must not wait for the disk, but the id must reach it
              // while the call is still running, so a stop in the middle does not lose it.
              void this.store.save(state).catch(() => undefined);
            },
            onProgress: (l) => {
              this.log.detail(l);
              this.events.emit('agent.progress', l.slice(0, 300), { stage, data: { label, agent: agentId } });
            },
          });
          if (req.schema) {
            const errs = validateSchema(req.schema, res.structured);
            if (errs.length) throw new AgentError(`structured output invalid: ${errs.slice(0, 3).join('; ')}`);
          }
          session.status = 'completed';
          session.finishedAt = nowIso();
          session.sessionId = res.sessionId ?? session.sessionId;
          if (res.sessionId) session.sessionConfirmed = undefined; // the CLI answered with it: confirmed
          if (res.cli) session.cli = res.cli;
          if (!session.sessionId && isNative) session.noSessionReason = 'the agent finished without reporting a session id';
          state.usage.calls++;
          state.usage.costUsd += res.costUsd ?? 0;
          state.usage.inputTokens += res.inputTokens ?? 0;
          state.usage.outputTokens += res.outputTokens ?? 0;
          if (res.raw) {
            await this.store
              .artifact(state.id, `${label}.${agentId}.log`, truncate(res.raw, MAX_RAW_ARTIFACT))
              .catch(() => undefined);
          }
          await this.store.save(state);
          return { ...res, agentId };
        } catch (e) {
          lastErr = e as Error;
          session.status = 'failed';
          session.finishedAt = nowIso();
          // Keep any id the call had already obtained; say so plainly when there is none.
          if (e instanceof AgentError && e.sessionId) {
            session.sessionId = e.sessionId;
            session.sessionConfirmed = e.sessionConfirmed === false ? false : undefined;
          }
          if (!session.sessionId) {
            session.noSessionReason = isNative
              ? 'the call ended before the agent reported a session id, so there is no native session to continue'
              : 'this agent has no native session';
          }
          await this.store.save(state).catch(() => undefined);
          if (this.signal?.aborted || lastErr.message === 'cancelled') throw new AgentError('cancelled', false);
          const retryable = !(e instanceof AgentError) || e.retryable;
          this.log.warn(`${stage}/${agentId} failed: ${lastErr.message}`);
          this.events.emit('agent.failed', lastErr.message.slice(0, 500), {
            stage,
            data: {
              label,
              agent: agentId,
              attempt: n,
              retryable,
              kind: e instanceof AgentError ? e.kind : 'unknown',
            },
          });
          if (!retryable) break;
          if (n < attempts) await sleep(2000 * n);
        }
      }
    }
    const pe = new PipelineError(`${stage} stage failed: ${lastErr.message}`);
    pe.kind = lastErr instanceof AgentError ? lastErr.kind : 'unknown';
    pe.agent = chain[chain.length - 1];
    throw pe;
  }

  // ------------------------------------------------------------------ plan

  private async planStage(state: RunState): Promise<void> {
    await this.checkpoint(state, 'plan');
    for (let attempt = 0; attempt < 4; attempt++) {
      // planFeedback is consumed here and only here: it is about the plan, never the code.
      const feedback = state.planFeedback;
      const previous = state.plan;
      state.planFeedback = undefined;
      const base = await loadPrompt('plan', this.repo, this.cfg.stages.plan.promptFile, { task: state.task });
      const prompt = feedback
        ? `${base}\n\n# Reviewer feedback on your previous plan\n` +
          (previous ? `Previous plan:\n${formatPlan(previous)}\n\n` : '') +
          `${feedback}\nRevise the plan accordingly.`
        : base;
      state.planApproved = false;
      const res = await this.invoke(state, 'plan', `plan${attempt ? `-${attempt + 1}` : ''}`, {
        prompt,
        access: 'read-only',
        schema: PLAN_SCHEMA,
      });
      await this.restoreClean(state, state.base!.sha);
      state.plan = res.structured as Plan;
      state.planVersion = (state.planVersion ?? 0) + 1;
      state.planAgent = res.agentId;
      await this.store.artifact(state.id, 'plan.md', formatPlan(state.plan) + '\n\n## Acceptance\n' + formatAcceptance(state.plan));
      await this.store.save(state);
      this.log.stage('plan', `${state.plan.steps.length} steps, ${state.plan.acceptance.length} acceptance criteria`);
      if (!this.needsApproval(state)) return;
      const decision = await this.confirmPlanDecision(state);
      if (decision === 'paused' || decision === 'approved') return;
      state.planFeedback = decision;
    }
    throw new PipelineError('plan was rejected too many times', 'needs-human');
  }

  private needsApproval(state: RunState): boolean {
    return !!this.cfg.stages.plan.requireApproval && !!state.plan && !state.planApproved;
  }

  /** Called when a run resumes with an unapproved plan and no decision: stay paused. */
  private async confirmPlan(state: RunState): Promise<boolean> {
    const d = await this.confirmPlanDecision(state);
    if (d === 'approved') return true;
    if (d === 'paused') return false;
    // Interactive rejection on resume: replan with the feedback.
    state.planFeedback = d;
    await this.planStage(state);
    return !this.needsApproval(state) || state.status !== 'awaiting-plan-approval';
  }

  private async confirmPlanDecision(state: RunState): Promise<'approved' | 'paused' | string> {
    if (this.opts.approvePlan && state.plan) {
      const d = await this.opts.approvePlan(state.plan);
      if (d.approved) {
        state.planApproved = true;
        await this.store.save(state);
        return 'approved';
      }
      return d.feedback || 'Please revise the plan.';
    }
    state.status = 'awaiting-plan-approval';
    state.error = `plan ready for review: ${path.join(this.store.dir(state.id), 'artifacts', 'plan.md')}`;
    this.log.info(`plan awaiting approval — run "repobaton approve ${state.id}" to continue`);
    return 'paused';
  }

  // ------------------------------------------------------------------ implement / test / review loop

  private maxRounds(state: RunState): number {
    return this.cfg.loop.maxReviewRounds + (state.extraRounds ?? 0);
  }

  private async implementLoop(state: RunState): Promise<boolean> {
    // An approved commit is already saved: go straight to release/publish with that exact SHA.
    // No new implement round, and an exhausted round budget cannot block it.
    if (state.rounds.some((r) => r.decision === 'approved' && r.implement)) return true;
    for (;;) {
      let round = state.rounds[state.rounds.length - 1];
      if (!round || round.decision) {
        if (state.rounds.length >= this.maxRounds(state)) return false;
        round = { n: state.rounds.length + 1 };
        state.rounds.push(round);
      }
      await this.doRound(state, round);
      if (round.decision === 'approved') return true;
    }
  }

  private planFor(state: RunState): { plan: string; acceptance: string } {
    return state.plan
      ? { plan: formatPlan(state.plan), acceptance: formatAcceptance(state.plan) }
      : { plan: '(no separate plan stage: work directly from the task)', acceptance: '- The task is completed as described.' };
  }

  private async doRound(state: RunState, round: Round): Promise<void> {
    const wt = state.worktree!;
    const base = state.base!.sha;

    if (!round.implement) {
      await this.checkpoint(state, `implement-r${round.n}`);
      const prev = [...state.rounds].reverse().find((r) => r.n < round.n && r.review);
      const prevTests = [...state.rounds].reverse().find((r) => r.n < round.n && r.test)?.test;
      const { plan, acceptance } = this.planFor(state);
      const testsText = prevTests
        ? prevTests.skipped
          ? 'No tests were run.'
          : `exit code ${prevTests.exitCode}\n${prevTests.outputTail}`
        : 'No test run yet.';
      let feedback = prev?.review ? formatFeedback(prev.review as unknown as ReviewResult, this.cfg.loop.blockOn) : '';
      if (state.pendingFeedback) feedback += `${feedback ? '\n\n' : ''}Human guidance:\n${state.pendingFeedback}`;
      const isFix = round.n > 1 || !!feedback;
      const testHint = this.cfg.test.command
        ? `\nThe orchestrator will run \`${this.cfg.test.command}\` after you finish; make sure it passes.`
        : '';
      const prompt = await loadPrompt(isFix ? 'fix' : 'implement', this.repo, isFix ? undefined : this.cfg.stages.implement.promptFile, {
        task: state.task,
        plan,
        acceptance,
        branch: state.branch ?? '',
        tests: testsText,
        feedback: feedback || '(none)',
        round: round.n - 1,
        test_hint: testHint,
      });
      const implementStage = this.cfg.stages.implement;
      const previousSession = this.cfg.loop.resumeImplementerSession
        ? [...state.rounds].reverse().find((r) => r.implement?.sessionId &&
          [implementStage.agent, implementStage.fallbackAgent].includes(r.implement.agent))?.implement
        : undefined;
      let res;
      try {
        res = await this.invoke(state, 'implement', `implement-r${round.n}`, {
          prompt,
          access: 'workspace-write',
          sessionId: previousSession?.sessionId,
          persist: this.cfg.loop.resumeImplementerSession,
        }, previousSession?.agent);
      } catch (e) {
        if (!previousSession || e instanceof PipelineError === false) throw e;
        this.log.warn('could not resume the implementer session; starting a fresh one with full context');
        res = await this.invoke(state, 'implement', `implement-r${round.n}b`, {
          prompt,
          access: 'workspace-write',
          persist: this.cfg.loop.resumeImplementerSession,
        });
      }
      state.pendingFeedback = undefined;
      const commit = await G.commitAll(wt, `repobaton: ${state.task.split('\n')[0].slice(0, 60)} (round ${round.n})`, {
        noVerify: this.cfg.git.noVerify,
        ...(await this.identity(wt)),
      });
      const head = commit.sha;
      if (head === base) {
        throw new PipelineError('the implementer made no changes to the repository', 'needs-human');
      }
      if (!commit.created && round.n > 1) {
        // Nothing changed since the rejected commit: another test+review pass would
        // reach the same verdict, so stop and hand the decision to a human.
        throw new PipelineError(
          `the implementer made no new changes in round ${round.n} in response to the feedback; ` +
            'resume with --feedback "<guidance>" to steer it',
          'needs-human',
        );
      }
      round.implement = {
        agent: res.agentId,
        sha: head,
        summary: res.text.trim(),
        changedFiles: await G.changedFiles(wt, base, head),
        durationMs: res.durationMs,
        sessionId: res.sessionId,
      };
      this.log.stage('implement', `${round.implement.changedFiles.length} files changed, commit ${head.slice(0, 8)}`);
      await this.store.save(state);
    }

    const head = round.implement.sha;

    if (!round.test || round.test.sha !== head) {
      await this.checkpoint(state, `test-r${round.n}`);
      round.test = await this.runTests(state, head);
      await this.store.save(state);
    }

    if (this.cfg.stages.review.enabled === false) {
      const ok = round.test.skipped || round.test.exitCode === 0 || !this.cfg.loop.testsMustPass;
      round.decision = ok ? 'approved' : 'changes-requested';
      this.log.stage('review', 'disabled; decision based on tests only');
      await this.store.save(state);
      return;
    }

    if (!round.review || round.review.sha !== head) {
      await this.checkpoint(state, `review-r${round.n}`);
      const review = await this.reviewStage(state, round, head);
      const j = judge(review.result, round.test, this.cfg.loop);
      round.review = {
        agent: review.agentId,
        sha: head,
        verdict: j.verdict,
        rawVerdict: review.result.verdict,
        summary: review.result.summary,
        issues: review.result.issues,
        overriddenBy: j.overriddenBy,
      };
      round.decision = j.verdict === 'approve' ? 'approved' : 'changes-requested';
      this.log.stage(
        'review',
        `${j.verdict}${j.overriddenBy ? ` (overridden: ${j.overriddenBy})` : ''}, ${review.result.issues.length} issue(s)`,
      );
      await this.store.save(state);
    }
    if (!round.decision) round.decision = round.review.verdict === 'approve' ? 'approved' : 'changes-requested';
    await this.store.save(state);
  }

  private async identity(cwd: string): Promise<{ name?: string; email?: string }> {
    const g = this.cfg.git;
    if (g.authorName || g.authorEmail) return { name: g.authorName, email: g.authorEmail };
    const name = (await G.git(cwd, ['config', 'user.name'], { allowFail: true })).trim();
    const email = (await G.git(cwd, ['config', 'user.email'], { allowFail: true })).trim();
    return { name: name || 'RepoBaton', email: email || 'repobaton@localhost' };
  }

  private async runTests(state: RunState, sha: string): Promise<NonNullable<Round['test']>> {
    const wt = state.worktree!;
    const cmd = this.cfg.test.command ?? (await detectProject(wt)).test;
    if (!cmd) {
      this.log.stage('test', 'no test command configured or detected; skipping');
      return { skipped: true, exitCode: null, durationMs: 0, sha, outputTail: '' };
    }
    this.log.stage('test', cmd);
    const r = await runShell(cmd, { cwd: wt, timeoutMs: this.cfg.test.timeoutSec * 1000, signal: this.signal });
    if (r.aborted) throw new AgentError('cancelled', false);
    const code = r.timedOut ? 124 : r.code ?? 1;
    const output = r.timedOut ? `${r.stdout}${r.stderr}\n[timed out after ${this.cfg.test.timeoutSec}s]` : r.stdout + r.stderr;
    await this.store.artifact(state.id, `test-${sha.slice(0, 8)}.log`, output).catch(() => undefined);
    this.log.stage('test', code === 0 ? 'passed' : `FAILED (exit ${code})`);
    return { skipped: false, exitCode: code, durationMs: r.durationMs, sha, outputTail: tail(output, 6000) };
  }

  private async reviewStage(state: RunState, round: Round, head: string): Promise<{ result: ReviewResult; agentId: string }> {
    const wt = state.worktree!;
    const base = state.base!.sha;
    const { acceptance } = this.planFor(state);
    const diff = truncate(await G.diffRange(wt, base, head), this.cfg.limits.maxDiffChars);
    const prev = [...state.rounds].reverse().find((r) => r.n < round.n && r.review)?.review;
    const t = round.test!;
    const prompt = await loadPrompt('review', this.repo, this.cfg.stages.review.promptFile, {
      task: state.task,
      acceptance,
      tests: t.skipped ? 'No automated tests were run.' : `exit code ${t.exitCode}\n${t.outputTail}`,
      base_short: base.slice(0, 8),
      head_short: head.slice(0, 8),
      log: (await G.commitLog(wt, base, head)).trim(),
      stat: (await G.diffStat(wt, base, head)).trim(),
      diff,
      previous: prev
        ? `\n# Previous review (verify each blocking issue was actually fixed)\n${formatFeedback(prev as unknown as ReviewResult, this.cfg.loop.blockOn)}`
        : '',
    });
    const res = await this.invoke(state, 'review', `review-r${round.n}`, { prompt, access: 'read-only', schema: REVIEW_SCHEMA });
    await this.restoreClean(state, head);
    return { result: res.structured as ReviewResult, agentId: res.agentId };
  }

  /** Read-only stages must not leave edits behind; undo any that slipped through. */
  private async restoreClean(state: RunState, sha: string): Promise<void> {
    const wt = state.worktree!;
    const head = await G.headSha(wt);
    const dirty = await G.isDirty(wt);
    if (head === sha && !dirty) return;
    this.log.warn('a read-only stage modified the worktree; restoring it');
    await G.git(wt, ['reset', '--hard', sha]);
    await G.git(wt, ['clean', '-fd', '-e', 'node_modules', '-e', '.venv']);
  }

  // ------------------------------------------------------------------ release & publish

  private approvedSha(state: RunState): string {
    const r = [...state.rounds].reverse().find((x) => x.decision === 'approved');
    if (!r?.implement) throw new PipelineError('no approved commit to release');
    return r.implement.sha;
  }

  private async releaseStage(state: RunState): Promise<void> {
    const wt = state.worktree!;
    const base = state.base!.sha;
    const sha = this.approvedSha(state);
    const lastReview = [...state.rounds].reverse().find((r) => r.review)?.review;

    if (this.cfg.stages.release.enabled !== false && !state.release) {
      await this.checkpoint(state, 'release');
      let versionInfo = '';
      const pkg = path.join(wt, 'package.json');
      if (await exists(pkg)) {
        const v = (await readJson<{ version?: string }>(pkg).catch(() => ({}) as { version?: string })).version;
        if (v) versionInfo = `package.json version: ${v}`;
      }
      const prompt = await loadPrompt('release', this.repo, this.cfg.stages.release.promptFile, {
        task: state.task,
        log: (await G.commitLog(wt, base, sha)).trim(),
        stat: (await G.diffStat(wt, base, sha)).trim(),
        review: lastReview ? `${lastReview.verdict}: ${lastReview.summary}` : 'No review stage was run.',
        latest_tag: (await G.latestTag(wt)) || '(none)',
        version_info: versionInfo,
      });
      const res = await this.invoke(state, 'release', 'release', { prompt, access: 'read-only', schema: RELEASE_SCHEMA });
      await this.restoreClean(state, sha);
      state.release = res.structured as ReleaseDraft;
      await this.store.artifact(
        state.id,
        'release.md',
        `# ${state.release.pr_title}\n\n${state.release.pr_body}\n\n---\n## Release notes (${state.release.version_bump} → ${state.release.suggested_version})\n\n${state.release.release_notes}\n`,
      );
      await this.store.save(state);
    } else if (!state.release) {
      state.release = {
        version_bump: 'none',
        suggested_version: '',
        pr_title: state.task.split('\n')[0].slice(0, 70),
        pr_body: `${state.task}\n\n(Generated by RepoBaton)`,
        release_notes: '',
        risks: [],
      };
    }
    await this.publish(state, sha);
  }

  /** Record, on disk, that an external operation is about to start. */
  private async markInFlight(state: RunState, op: NonNullable<RunState['publish']['inFlight']>, target: NonNullable<RunState['publish']['inFlightTarget']>): Promise<void> {
    state.publish.inFlight = op;
    state.publish.inFlightTarget = target;
    await this.store.save(state);
  }

  /**
   * The place a push, tag or PR step really writes to. `git push <remote>` goes to the push
   * address (pushurl, insteadOf rules applied), which can differ from the address used for
   * reading, and `gh` must be told the repository instead of guessing it from the directory.
   * Several push addresses, or a PR on an address that is not github.com, cannot be tied to one
   * target, so the run stops before doing anything.
   */
  private async writeTarget(needsGithubRepo: boolean): Promise<NonNullable<RunState['publish']['inFlightTarget']>> {
    const remote = this.cfg.publish.remote;
    const urls = await this.ops.pushUrls(this.repo, remote);
    if (urls.length === 0) throw new PipelineError(`remote "${remote}" is not configured`, 'needs-human');
    if (urls.length > 1) {
      throw new PipelineError(
        `remote "${remote}" has ${urls.length} push addresses (${urls.map(G.sanitizeRemoteUrl).join(', ')}); a push would write to all of them and an interrupted one could not be checked reliably. Configure a single push address.`,
        'needs-human',
      );
    }
    const url = G.sanitizeRemoteUrl(urls[0]);
    if (!needsGithubRepo) return { remote, url };
    const githubRepo = G.githubRepoOf(urls[0]);
    if (!githubRepo) {
      throw new PipelineError(`remote "${remote}" pushes to ${url}, which is not a github.com address, so the pull request repository cannot be identified`, 'needs-human');
    }
    return { remote, url, githubRepo };
  }

  private async publish(state: RunState, approvedSha: string): Promise<void> {
    if (state.publish.inFlight) {
      // A previous attempt died between "about to do X" and "X is recorded". Repeating X could
      // push twice, open a second PR or merge something unreviewed, so stop and ask a human.
      const op = state.publish.inFlight;
      throw new PipelineError(
        `the previous attempt was interrupted while doing "${op}", and it is unknown whether it completed. ` +
          `Check the remote (branch ${state.branch ?? ''}${state.publish.prUrl ? `, ${state.publish.prUrl}` : ''}), ` +
          // A run started from the UI server has an owner; a standalone CLI run does not. Point at the action that exists there.
          (this.opts.owner
            ? 'then use "Check the remote" on the run page, and continue.'
            : `then run "repobaton check ${state.id}" in this repository, and resume.`),
        'needs-human',
      );
    }
    const p = this.cfg.publish;
    if (!p.push && !p.createPr && !p.merge && !p.tag) {
      this.log.stage('publish', `nothing to publish (all publish actions off). Branch ${state.branch} is ready in ${state.worktree}`);
      return;
    }
    const wt = state.worktree!;
    const branch = state.branch!;
    // Only ship exactly what was approved.
    const head = await G.headSha(wt);
    if (head !== approvedSha) {
      throw new PipelineError(`worktree HEAD ${head.slice(0, 8)} differs from the approved commit ${approvedSha.slice(0, 8)}; refusing to publish`, 'needs-human');
    }
    if (await G.isDirty(wt)) throw new PipelineError('worktree has uncommitted changes; refusing to publish', 'needs-human');
    await this.checkpoint(state, 'publish');
    const rel = state.release!;

    if (p.push && !state.publish.pushed) {
      await this.markInFlight(state, 'push', await this.writeTarget(false));
      await this.ops.push(wt, p.remote, branch);
      state.publish.inFlight = undefined;
      state.publish.pushed = true;
      this.log.stage('publish', `pushed ${branch} to ${p.remote}`);
      await this.store.save(state);
    }
    if (p.createPr && !state.publish.prUrl) {
      if (!(await this.ops.ghAvailable(wt))) throw new PipelineError('publish.createPr needs the GitHub CLI ("gh") installed and logged in', 'needs-human');
      const target = await this.writeTarget(true);
      await this.markInFlight(state, 'pr', target);
      const created = await this.ops.ghCreatePr(wt, {
        repo: target.githubRepo!,
        base: state.base!.branch,
        head: branch,
        title: rel.pr_title,
        body: rel.pr_body,
        draft: p.draftPr && !p.merge,
      });
      // The marker stays set when the PR is somewhere else: nothing can be recorded safely.
      if (G.githubRepoOfPr(created) !== target.githubRepo) {
        throw new PipelineError(`the pull request ${created} is not in ${target.githubRepo}, the repository this run pushes to`, 'needs-human');
      }
      state.publish.prUrl = created;
      state.publish.inFlight = undefined;
      this.log.stage('publish', `PR ${state.publish.prUrl}`);
      await this.store.save(state);
    }
    if (p.merge && !state.publish.merged) {
      const pr = state.publish.prUrl!;
      const target = await this.writeTarget(true);
      if (G.githubRepoOfPr(pr) !== target.githubRepo) {
        throw new PipelineError(`the pull request ${pr} is not in ${target.githubRepo}, the repository this run pushes to; refusing to merge it`, 'needs-human');
      }
      await this.markInFlight(state, 'merge', target);
      await this.ops.ghMarkReady(wt, pr, target.githubRepo!);
      await this.ops.ghMergePr(wt, pr, approvedSha, target.githubRepo!);
      state.publish.inFlight = undefined;
      state.publish.merged = true;
      state.publish.mergeSha = (await this.ops.ghMergeCommit(wt, pr, target.githubRepo!)) || undefined;
      this.log.stage('publish', `merged ${pr}`);
      await this.store.save(state);
    }
    if (p.tag && !state.publish.tagPushed) {
      await this.tagRelease(state, rel);
    }
  }

  private async tagRelease(state: RunState, rel: ReleaseDraft): Promise<void> {
    const p = this.cfg.publish;
    if (rel.version_bump === 'none' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(rel.suggested_version)) {
      this.log.warn(`skipping tag: release stage gave no usable version ("${rel.suggested_version}", bump ${rel.version_bump})`);
      return;
    }
    const tag = `${p.tagPrefix}${rel.suggested_version}`;
    const root = this.repo;
    if ((await G.tagExists(root, tag)) && state.publish.pendingTag !== tag) throw new PipelineError(`tag ${tag} already exists`, 'needs-human');
    const sha = state.publish.mergeSha;
    if (!sha) throw new PipelineError('cannot tag: merge commit is unknown', 'needs-human');
    // The merge commit lives where the PR was merged: the repository this run writes to, which can
    // differ from the read address. Fetch it from there and confirm it is on that repository's base
    // branch before anything is tagged.
    const target = await this.writeTarget(false);
    const [address] = await this.ops.pushUrls(root, p.remote);
    if (!(await this.ops.fetchMergeCommit(root, address, state.base!.branch, sha))) {
      throw new PipelineError(`merge commit ${sha.slice(0, 8)} is not on ${state.base!.branch} at ${target.url}, the repository this run writes to; refusing to tag it`, 'needs-human');
    }
    state.publish.pendingTag = tag;
    await this.markInFlight(state, 'tag', target);
    // A tag that already exists locally at the merge commit (an earlier attempt got that far) is reused.
    if ((await G.tagTarget(root, tag)) !== sha) await G.createTag(root, tag, sha, rel.release_notes || tag);
    state.publish.tag = tag;
    await this.ops.pushTag(root, p.remote, tag);
    state.publish.inFlight = undefined;
    state.publish.tagPushed = true;
    this.log.stage('publish', `tagged ${tag} @ ${sha.slice(0, 8)}`);
    await this.store.save(state);
  }

  // ------------------------------------------------------------------ maintenance

  async cleanup(idOrPrefix: string, opts: { deleteBranch?: boolean } = {}): Promise<void> {
    const id = await this.store.resolve(idOrPrefix);
    const state = await this.store.load(id);
    if (state.worktree) await G.removeWorktree(this.repo, state.worktree);
    if (opts.deleteBranch && state.branch) await G.git(this.repo, ['branch', '-D', state.branch], { allowFail: true });
    await ensureDir(this.store.dir(id));
    state.worktree = undefined;
    await this.store.save(state);
  }
}

export { DEFAULT_PROMPTS };
