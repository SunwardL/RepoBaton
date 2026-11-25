import { useRef, useState } from 'react';
import { api, type RunDetail, type RunEvent } from './api';
import { ActionPanel } from './ActionPanel';
import { Banner, dur, errorText, ERROR_HINT, Pill, usePoll } from './common';
import { EventLog } from './EventLog';
import { mergeEvents } from './mergeEvents';
import { DiffView, PlanBox, RoundCard } from './RunParts';
import { SessionsCard } from './SessionsCard';
import { accessDescription } from './agentAccess';

type Tab = 'progress' | 'plan' | 'diff' | 'report';

const STAGES: Array<{ key: string; label: string; agentOf: (r: RunDetail) => string | undefined }> = [
  { key: 'plan', label: '规划', agentOf: () => undefined },
  { key: 'implement', label: '实现', agentOf: (r) => r.rounds.at(-1)?.implement?.agent },
  { key: 'test', label: '测试', agentOf: () => undefined },
  { key: 'review', label: '审核', agentOf: (r) => r.rounds.at(-1)?.review?.agent },
  { key: 'release', label: '发版草稿', agentOf: () => undefined },
];

/** Where the pipeline is, derived from the run itself rather than from event text. */
function stageStates(r: RunDetail, executing: boolean): Array<'d' | 'c' | 'x' | ''> {
  const last = r.rounds.at(-1);
  const stage = (r.stage ?? '').replace(/-r\d+$/, '');
  const failed = r.status === 'failed' || r.status === 'needs-human';
  const approved = r.rounds.some((x) => x.decision === 'approved');
  const idx = (k: string): number => STAGES.findIndex((s) => s.key === k);
  const done = [!!r.plan, !!last?.implement, !!last?.test, !!last?.review, !!r.release];
  return STAGES.map((s, i) => {
    if (r.status === 'succeeded') return 'd';
    if (done[i] && !(s.key === 'review' && !approved && r.status !== 'running' && last?.decision === 'changes-requested' && false)) {
      if (s.key === 'implement' || s.key === 'test' || s.key === 'review') {
        if (stage === s.key && executing) return 'c';
      }
      if (i > idx(stage) && idx(stage) >= 0 && stage !== '' && (s.key === 'review' || s.key === 'test') && executing) return '';
      return 'd';
    }
    if (executing && stage === s.key) return 'c';
    if (failed && stage === s.key) return 'x';
    return '';
  });
}

export function RunView({ projectId, runId, notify, onBack }: { projectId: string; runId: string; notify: (m: string, k?: 'ok' | 'err') => void; onBack: () => void }) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [executing, setExecuting] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tab, setTab] = useState<Tab>('progress');
  const [diff, setDiff] = useState<{ diff: string; stat: string; truncated?: boolean } | null>(null);
  const [report, setReport] = useState<string | null | undefined>(undefined);
  const [gone, setGone] = useState<string | null>(null);
  const [stepOutputs, setStepOutputs] = useState<Record<string, string>>({});
  const [stepPrompts, setStepPrompts] = useState<Record<string, { prompt: string; attempt: number; truncated: boolean }>>({});
  const [manualOutputs, setManualOutputs] = useState<Record<string, string>>({});
  const [manualExitCodes, setManualExitCodes] = useState<Record<string, string>>({});
  const [manualReviewed, setManualReviewed] = useState<Record<string, boolean>>({});
  const [commitPreview, setCommitPreview] = useState<Record<string, { head: string; expectedTree: string; actualTree: string; diff: string; truncated: boolean; hash: string }>>({});
  const [commitReviewed, setCommitReviewed] = useState<Record<string, boolean>>({});
  const [flowActionPending, setFlowActionPending] = useState(false);
  const lastSeq = useRef(0);
  const statusSeen = useRef('');

  const load = async (): Promise<void> => {
    try {
      const r = await api.run(projectId, runId);
      setRun(r.run);
      setExecuting(r.executing);
      setGone(null);
      const ev = await api.events(projectId, runId, lastSeq.current);
      if (ev.events.length) {
        lastSeq.current = Math.max(lastSeq.current, ...ev.events.map((event) => event.seq));
        setEvents((old) => mergeEvents(old, ev.events));
      }
      // Result tabs reload whenever the run's state moves, not on every poll.
      const sig = `${r.run.status}:${r.run.rounds.length}:${r.run.updatedAt}`;
      if (sig !== statusSeen.current) {
        statusSeen.current = sig;
        if (r.run.flow || r.run.rounds.some((x) => x.implement)) void api.diff(projectId, runId).then(setDiff).catch(() => undefined);
        if (r.run.status !== 'running') void api.report(projectId, runId).then((x) => setReport(x.report)).catch(() => undefined);
      }
    } catch (e) {
      setGone(errorText(e));
    }
  };

  // Fast while something is executing, slow otherwise.
  usePoll(load, executing ? 700 : 2500, [projectId, runId, executing]);

  if (gone && !run) {
    return (
      <>
        <button className="btn sm" onClick={onBack}>← 返回</button>
        <div className="empty"><h2>打不开这个任务</h2>{gone}</div>
      </>
    );
  }
  if (!run) return <div className="empty">加载中…</div>;

  const states = stageStates(run, executing);
  const ok = run.rounds.find((r) => r.decision === 'approved');
  const failedAgent = run.errorAgent;

  return (
    <>
      <div className="crumb"><button className="btn sm" onClick={onBack}>← 返回任务列表</button> <span className="mono">{run.id}</span></div>
      <div className="top">
        <div>
          <h1>{run.task.split('\n')[0].slice(0, 90)}</h1>
          <div className="sub" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pill status={run.status} executing={executing} />
            {run.branch ? <span className="mono">{run.branch}</span> : null}
            {run.base ? <span>基于 {run.base.branch}@{run.base.sha.slice(0, 7)}</span> : null}
          </div>
        </div>
      </div>

      {gone ? <Banner kind="warn" title="暂时连不上服务">{gone}。页面会自动重试。</Banner> : null}
      {!!run.flowConfigChanges?.length && <Banner kind="warn" title="Agent 配置已变化">继续执行时仍使用任务开始时保存的非敏感设置。变化的字段：{run.flowConfigChanges.join('、')}。</Banner>}
      {run.status === 'failed' && run.errorKind ? (
        <Banner kind="err" title={`${ERROR_HINT[run.errorKind] ?? '执行失败'}${failedAgent ? `:agent ${failedAgent}` : ''}`}>
          <div>{run.error}</div>
        </Banner>
      ) : null}

      {run.flow ? <div className="card sec custom-run-steps"><h2>流程步骤</h2>
        {run.flow.workflow.steps.map((step) => {
          const detail = run.steps?.[step.id];
          const fallbackUsed = step.type === 'agent' && !!detail?.agent && detail.agent !== step.agent;
          const label: Record<string, string> = { pending: '等待', running: '进行中', succeeded: '已完成', failed: '失败', unknown: '结果待核对', skipped: '已跳过' };
          return <div className="custom-run-step" key={step.id}><div><strong>{step.title}</strong><span className="muted"> · {detail?.agent ?? step.agent ?? (step.type === 'command' ? '命令' : step.type === 'approval' ? '人工确认' : 'Git 提交')}</span>
            {fallbackUsed && <span className="muted"> · 备用接手（原配置：{step.agent}）</span>}
            {step.model && !fallbackUsed && <span className="muted"> · {step.model}</span>}
            {step.type === 'agent' && <p className="muted">{accessDescription(detail?.agentType, step.access)}</p>}
            {detail?.readOnlyChanged && <p role="alert">请求只读的步骤前后检测到工作区状态变化，请检查改动。</p>}
            {detail?.headBefore && <p className="muted">步骤前 {detail.headBefore.slice(0, 8)}{detail.dirtyBefore ? '（有未提交改动）' : ''} → 步骤后 {detail.headAfter?.slice(0, 8) ?? '待核对'}{detail.dirtyAfter ? '（有未提交改动）' : ''}</p>}
            {detail?.branchBefore !== undefined && detail.branchBefore !== detail.branchAfter && <p className="muted">分支：{detail.branchBefore || '游离 HEAD'} → {detail.branchAfter || '游离 HEAD'}</p>}
            {step.type === 'agent' && <details><summary>查看提示词与输入引用</summary><pre className="flow-output">{step.prompt}</pre></details>}
            {step.type === 'agent' && detail && detail.status !== 'pending' && !detail.promptRef && <p className="muted">这次调用没有保存实际交接内容。</p>}
            {step.type === 'agent' && detail?.promptRef && <button type="button" className="btn sm" onClick={() => {
              void api.stepPrompt(projectId, runId, step.id).then((result) => setStepPrompts((old) => ({ ...old, [step.id]: result }))).catch((error) => notify(errorText(error), 'err'));
            }}>查看实际交接内容</button>}
            {stepPrompts[step.id] && <div><p className="muted">第 {stepPrompts[step.id].attempt} 次调用的提示词记录，已脱敏{stepPrompts[step.id].truncated ? '，内容过长已截断' : ''}。</p><pre className="flow-output">{stepPrompts[step.id].prompt}</pre></div>}
            {step.type === 'command' && <details><summary>查看命令与输入</summary><pre className="flow-output">{step.run}{step.inputs?.length ? `\n\n输入：${step.inputs.map((input) => input.kind === 'file' ? input.path : input.kind === 'task' ? '任务描述' : `${input.step} / ${input.kind}`).join('、')}` : ''}</pre></details>}
            {detail?.reason && <p className="muted">{detail.reason}</p>}
            {step.type === 'commit' && detail?.status === 'unknown' && !executing && !run.humanControl && <div>
              <p className="muted">请在工作区检查分支、提交记录和未提交改动。恢复到预期现场后，可重新核验；核验不会再次提交。</p>
              <button type="button" className="btn sm" disabled={flowActionPending} onClick={() => {
                setFlowActionPending(true);
                void api.recheckUnknownCommit(projectId, runId, step.id, detail.attempt).then(() => notify('提交已核验，继续执行')).catch((error) => notify(errorText(error), 'err')).finally(() => { void load().finally(() => setFlowActionPending(false)); });
              }}>重新核验提交</button>
              <button type="button" className="btn sm" disabled={flowActionPending} onClick={() => {
                setFlowActionPending(true);
                setCommitReviewed((old) => ({ ...old, [step.id]: false }));
                void api.previewChangedCommit(projectId, runId, step.id, detail.attempt).then((preview) => setCommitPreview((old) => ({ ...old, [step.id]: preview }))).catch((error) => notify(errorText(error), 'err')).finally(() => setFlowActionPending(false));
              }}>查看实际提交与预期的差异</button>
              {commitPreview[step.id] && <div>
                <p>实际提交：<code>{commitPreview[step.id].head}</code></p>
                <p className="muted">预期树：{commitPreview[step.id].expectedTree}；实际树：{commitPreview[step.id].actualTree}。差异已脱敏。</p>
                <pre className="flow-output">{commitPreview[step.id].diff || '没有可显示的文本差异。'}</pre>
                {commitPreview[step.id].truncated && <p role="alert">差异过长，仅显示一部分；请在工作区检查完整内容。</p>}
                <label><input type="checkbox" checked={commitReviewed[step.id] ?? false} onChange={(event) => setCommitReviewed((old) => ({ ...old, [step.id]: event.target.checked }))} /> 我已检查实际提交，接受它代替预期内容。</label>
                <button type="button" className="btn sm" disabled={flowActionPending || !commitReviewed[step.id]} onClick={() => {
                  setFlowActionPending(true);
                  void api.acceptChangedCommit(projectId, runId, step.id, detail.attempt, commitPreview[step.id].hash).then(() => notify('已接受实际提交并继续')).catch((error) => notify(errorText(error), 'err')).finally(() => { void load().finally(() => setFlowActionPending(false)); });
                }}>接受实际提交并继续</button>
              </div>}
            </div>}
            {detail?.manualCompletion && <p className="muted">{step.type === 'commit' ? '此提交由用户核对并接受，未重新提交。' : '此结果由用户核对并提供，未重新执行。'}</p>}
            {detail?.status === 'unknown' && (step.type === 'agent' || step.type === 'command') && !executing && !run.humanControl && <details>
              <summary>已核对：标记完成并继续</summary>
              <p className="muted">请先检查工作区和实际结果。以下内容将作为此步骤的输出交给后续步骤；没有输出可留空。</p>
              <label>人工提供的输出<textarea value={manualOutputs[step.id] ?? ''} onChange={(event) => setManualOutputs((old) => ({ ...old, [step.id]: event.target.value }))} /></label>
              {step.type === 'command' && <label>实际退出码<input type="number" min="-2147483648" max="4294967295" step="1" value={manualExitCodes[step.id] ?? ''} onChange={(event) => setManualExitCodes((old) => ({ ...old, [step.id]: event.target.value }))} /></label>}
              <label><input type="checkbox" checked={manualReviewed[step.id] ?? false} onChange={(event) => setManualReviewed((old) => ({ ...old, [step.id]: event.target.checked }))} /> 我已核对实际结果，确认不重新执行此步骤并继续。</label>
              <button type="button" className="btn sm" disabled={flowActionPending || !manualReviewed[step.id] || (step.type === 'command' && (manualExitCodes[step.id] ?? '') === '')} onClick={() => {
                setFlowActionPending(true);
                void api.completeUnknownFlow(projectId, runId, step.id, detail.attempt, manualOutputs[step.id] ?? '', step.type === 'command' ? Number(manualExitCodes[step.id]) : undefined)
                  .then(() => notify('已记录人工确认，继续执行')).catch((error) => notify(errorText(error), 'err')).finally(() => { void load().finally(() => setFlowActionPending(false)); });
              }}>确认结果并继续</button>
            </details>}
            {detail && ['failed', 'unknown'].includes(detail.status) && !executing && !run.humanControl && <button type="button" className="btn sm" disabled={flowActionPending} onClick={() => {
              if ((detail.status === 'unknown' || step.type === 'command' || (step.type === 'agent' && (step.access === 'workspace-write' || detail.agentType === 'command'))) && !window.confirm('重试可能重复修改文件或执行外部操作。请先核对工作区和结果。确定重试吗？')) return;
              setFlowActionPending(true);
              void api.retryFlow(projectId, runId, step.id, detail.status).then(() => { notify('已重新执行'); }).catch((error) => { notify(errorText(error), 'err'); }).finally(() => { void load().finally(() => setFlowActionPending(false)); });
            }}>重试此步骤</button>}
            {detail?.approvalPreview && !executing && !run.humanControl && <div><pre className="flow-output">{detail.approvalPreview.content}</pre><button type="button" className="btn p sm" disabled={flowActionPending} onClick={() => {
              setFlowActionPending(true);
              void api.approveFlow(projectId, runId, step.id, detail.approvalPreview!.contentHash).then(() => { notify('已确认，继续执行'); }).catch((error) => { notify(errorText(error), 'err'); }).finally(() => { void load().finally(() => setFlowActionPending(false)); });
            }}>确认并继续</button></div>}
            {detail?.status === 'succeeded' && (step.type === 'agent' || step.type === 'command') && <button type="button" className="btn sm" onClick={() => {
              void api.stepOutput(projectId, runId, step.id).then(({ output }) => setStepOutputs((old) => ({ ...old, [step.id]: output.text }))).catch((error) => notify(errorText(error), 'err'));
            }}>查看输出</button>}
            {stepOutputs[step.id] !== undefined && <pre className="flow-output">{stepOutputs[step.id]}</pre>}</div><span className="pill">{label[detail?.status ?? 'pending']}</span></div>;
        })}
        {run.worktree && <div className="custom-worktree"><p className="muted">工作区 <code>{run.worktree}</code></p>
          <button type="button" className="btn sm" onClick={() => {
            void api.openWorkspace(projectId, runId).catch((error) => notify(errorText(error), 'err'));
          }}>打开工作区</button>
          <button type="button" className="btn sm" onClick={() => {
            void navigator.clipboard.writeText(run.worktree!).then(() => notify('已复制工作区路径')).catch(() => notify('复制失败，请手动选择路径', 'err'));
          }}>复制工作区路径</button>
          <p className="muted">可将路径粘贴到文件管理器中查看或自行提交改动。</p>
        </div>}
      </div> : <div className="card flow" aria-label="流水线进度">
        {STAGES.map((s, i) => (
          <div key={s.key} className={`n ${states[i]}`}>
            <div className="dot">{states[i] === 'd' ? '✓' : states[i] === 'x' ? '✕' : i + 1}</div>
            <b>{s.label}</b>
            <small>{states[i] === 'c' ? '进行中' : states[i] === 'd' ? '完成' : states[i] === 'x' ? '出错' : '等待'}</small>
            {s.agentOf(run) ? <div><span className="chip">{s.agentOf(run)}</span></div> : s.key === 'plan' && run.plan ? <div><span className="chip">{(run as RunDetail & { planAgent?: string }).planAgent ?? 'agent'}</span></div> : null}
          </div>
        ))}
      </div>}

      {run.workflow && (
        <section className="run-workflow" aria-label="本次任务编排">
          {STAGES.map((stage) => {
            const selection = run.workflow?.[stage.key as keyof NonNullable<RunDetail['workflow']>];
            return selection ? <span className="chip" key={stage.key}>{stage.label} · {selection.agent}{selection.model && ` / ${selection.model}`}</span> : null;
          })}
        </section>
      )}

      <div className="stack">
        <ActionPanel projectId={projectId} run={run} executing={executing || flowActionPending} notify={notify} onChanged={() => void load()} />
      </div>

      <div className="tabs" role="tablist" style={{ marginTop: 18 }}>
        {([['progress', '进度'], ['plan', '计划'], ['diff', '改动'], ['report', '结果']] as Array<[Tab, string]>).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'progress' ? (
        <div className="grid2">
          <div className="stack">
            {run.rounds.length === 0 && !run.flow ? <div className="card empty">还没有开始实现。</div> : null}
            {run.rounds.map((r, i) => <RoundCard key={r.n} round={r} active={executing && i === run.rounds.length - 1} />)}
          </div>
          <div className="stack">
            <div className="card sec"><h2>实时进度</h2><EventLog events={events} /></div>
            <SessionsCard run={run} />
            <div className="card sec">
              <h2>用量</h2>
              <div className="kv">Agent 调用<b>{run.usage.calls}</b></div>
              <div className="kv">输入 / 输出 token<b>{run.usage.inputTokens} / {run.usage.outputTokens}</b></div>
              {run.usage.costUsd ? <div className="kv">花费<b>${run.usage.costUsd.toFixed(4)}</b></div> : null}
              {run.rounds.length ? <div className="kv">轮次<b>{run.rounds.length}</b></div> : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'plan' ? (
        <div className="card sec">
          {run.plan ? <PlanBox plan={run.plan} /> : <div className="empty"><h2>还没有计划</h2>规划完成后会显示在这里。</div>}
        </div>
      ) : null}

      {tab === 'diff' ? <div className="card sec">{run.workspaceMode === 'directory'
        ? <div className="empty"><h2>查看项目文件</h2>修改直接保存在 <code>{run.worktree}</code>。这个文件夹没有 Git 差异记录。</div>
        : diff ? <DiffView {...diff} /> : <div className="empty"><h2>还没有改动</h2></div>}</div> : null}

      {tab === 'report' ? (
        <div className="stack">
          {ok && run.release ? (
            <div className="card sec">
              <h2>发版草稿</h2>
              <div className="kv">建议版本<b>{run.release.version_bump} → {run.release.suggested_version || '未知'}</b></div>
              <div className="kv">PR 标题<b>{run.release.pr_title}</b></div>
              {run.release.risks.length ? <><h4 style={{ margin: '10px 0 4px', fontSize: 13 }}>需要注意</h4><ul style={{ paddingLeft: 18 }}>{run.release.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null}
              <p className="muted" style={{ marginTop: 10 }}>推送、PR、合并和打 tag 默认关闭,需要在配置里显式打开。当前分支:<span className="mono">{run.branch}</span></p>
            </div>
          ) : null}
          <div className="card sec">
            <h2>报告</h2>
            {report === undefined ? <p className="muted">加载中…</p> : report === null ? <p className="muted">任务结束后会生成报告。</p> : <div className="report">{report}</div>}
          </div>
          <div className="card sec">
            <h2>耗时</h2>
            {run.rounds.map((r) => <div key={r.n} className="kv">第 {r.n} 轮实现<b>{r.implement ? dur(r.implement.durationMs) : '—'}</b></div>)}
          </div>
        </div>
      ) : null}
    </>
  );
}
