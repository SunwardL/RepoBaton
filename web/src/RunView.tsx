import { useRef, useState } from 'react';
import { api, type RunDetail, type RunEvent } from './api';
import { ActionPanel } from './ActionPanel';
import { Banner, dur, errorText, ERROR_HINT, Pill, usePoll } from './common';
import { EventLog } from './EventLog';
import { DiffView, PlanBox, RoundCard } from './RunParts';

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
        lastSeq.current = ev.events[ev.events.length - 1].seq;
        setEvents((old) => [...old, ...ev.events]);
      }
      // Result tabs reload whenever the run's state moves, not on every poll.
      const sig = `${r.run.status}:${r.run.rounds.length}:${r.run.updatedAt}`;
      if (sig !== statusSeen.current) {
        statusSeen.current = sig;
        if (r.run.rounds.some((x) => x.implement)) void api.diff(projectId, runId).then(setDiff).catch(() => undefined);
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
      {run.status === 'failed' && run.errorKind ? (
        <Banner kind="err" title={`${ERROR_HINT[run.errorKind] ?? '执行失败'}${failedAgent ? `:agent ${failedAgent}` : ''}`}>
          <div>{run.error}</div>
        </Banner>
      ) : null}

      <div className="card flow" aria-label="流水线进度">
        {STAGES.map((s, i) => (
          <div key={s.key} className={`n ${states[i]}`}>
            <div className="dot">{states[i] === 'd' ? '✓' : states[i] === 'x' ? '✕' : i + 1}</div>
            <b>{s.label}</b>
            <small>{states[i] === 'c' ? '进行中' : states[i] === 'd' ? '完成' : states[i] === 'x' ? '出错' : '等待'}</small>
            {s.agentOf(run) ? <div><span className="chip">{s.agentOf(run)}</span></div> : s.key === 'plan' && run.plan ? <div><span className="chip">{(run as RunDetail & { planAgent?: string }).planAgent ?? 'agent'}</span></div> : null}
          </div>
        ))}
      </div>

      <div className="stack">
        <ActionPanel projectId={projectId} run={run} executing={executing} notify={notify} onChanged={() => void load()} />
      </div>

      <div className="tabs" role="tablist" style={{ marginTop: 18 }}>
        {([['progress', '进度'], ['plan', '计划'], ['diff', '改动'], ['report', '结果']] as Array<[Tab, string]>).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'progress' ? (
        <div className="grid2">
          <div className="stack">
            {run.rounds.length === 0 ? <div className="card empty">还没有开始实现。</div> : null}
            {run.rounds.map((r, i) => <RoundCard key={r.n} round={r} active={executing && i === run.rounds.length - 1} />)}
          </div>
          <div className="stack">
            <div className="card sec"><h2>实时进度</h2><EventLog events={events} /></div>
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

      {tab === 'diff' ? <div className="card sec">{diff ? <DiffView {...diff} /> : <div className="empty"><h2>还没有改动</h2></div>}</div> : null}

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
