import type { Plan, Round } from './api';
import { dur } from './common';

const SEV_ORDER = { blocker: 0, major: 1, minor: 2, nit: 3 } as const;

export function PlanBox({ plan }: { plan: Plan }) {
  return (
    <div className="planbox">
      <p>{plan.summary}</p>
      <h4>步骤</h4>
      <ol>
        {plan.steps.map((s, i) => (
          <li key={i}>
            <b>{s.title}</b>
            {s.files.length ? <span className="mono muted"> · {s.files.join(', ')}</span> : null}
            <small>{s.detail}</small>
          </li>
        ))}
      </ol>
      <h4>验收标准</h4>
      <ul>
        {plan.acceptance.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
      {plan.risks.length ? (
        <>
          <h4>风险与假设</h4>
          <ul>
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Step({ ok, icon, title, meta, children }: { ok: 'ok' | 'no' | 'go' | 'sk'; icon: string; title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <div className="step">
      <span className={`ic ${ok === 'ok' ? '' : ok}`}>{icon}</span>
      <div>
        <b>{title}</b> {meta ? <em>{meta}</em> : null}
        {children}
      </div>
    </div>
  );
}

export function RoundCard({ round, active }: { round: Round; active: boolean }) {
  const label = round.decision === 'approved' ? '已通过' : round.decision === 'changes-requested' ? '已退回' : active ? '进行中' : '未完成';
  const color = round.decision === 'approved' ? 'var(--ok)' : round.decision === 'changes-requested' ? 'var(--bd)' : 'var(--ac)';
  const r = round.review;
  const sorted = r ? [...r.issues].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) : [];
  return (
    <div className="round">
      <header>
        <span>第 {round.n} 轮</span>
        <span style={{ color }}>{label}</span>
      </header>
      {round.implement ? (
        <Step ok="ok" icon="✓" title="实现" meta={`${round.implement.agent} · ${dur(round.implement.durationMs)} · ${round.implement.sha.slice(0, 8)}`}>
          <p>
            修改 {round.implement.changedFiles.length} 个文件
            {round.implement.changedFiles.length ? `:${round.implement.changedFiles.join(', ')}` : ''}
          </p>
        </Step>
      ) : (
        <Step ok="go" icon="…" title="实现" meta="进行中" />
      )}
      {round.test ? (
        round.test.skipped ? (
          <Step ok="sk" icon="–" title="测试" meta="未配置测试命令,已跳过" />
        ) : (
          <Step ok={round.test.exitCode === 0 ? 'ok' : 'no'} icon={round.test.exitCode === 0 ? '✓' : '✕'} title={round.test.exitCode === 0 ? '测试通过' : '测试失败'} meta={`退出码 ${round.test.exitCode} · ${dur(round.test.durationMs)}`}>
            {round.test.exitCode !== 0 ? <p className="mono">{round.test.outputTail.slice(-600)}</p> : null}
          </Step>
        )
      ) : null}
      {r ? (
        <Step ok={r.verdict === 'approve' ? 'ok' : 'no'} icon={r.verdict === 'approve' ? '✓' : '!'} title={r.verdict === 'approve' ? '审核:通过' : '审核:要求修改'} meta={r.agent}>
          <p>{r.summary}</p>
          {r.overriddenBy ? (
            <div className="note">
              审核原意见是「{r.rawVerdict === 'approve' ? '通过' : '要求修改'}」,被程序改判为「退回」。原因:{r.overriddenBy}。
            </div>
          ) : null}
          {sorted.map((i, k) => (
            <p key={k}>
              <span className={`sev ${i.severity}`}>{i.severity.toUpperCase()}</span> <span className="mono">{i.file}</span> {i.description}
              {i.suggestion ? <em> 建议:{i.suggestion}</em> : null}
            </p>
          ))}
        </Step>
      ) : null}
    </div>
  );
}

export function DiffView({ diff, stat, truncated }: { diff: string; stat: string; truncated?: boolean }) {
  if (!diff && !stat.trim()) return <div className="empty"><h3>没有可显示的改动</h3>实现阶段完成后会出现。</div>;
  return (
    <>
      {stat ? <pre className="mono muted" style={{ marginBottom: 10, whiteSpace: 'pre-wrap' }}>{stat.trim()}</pre> : null}
      {diff ? <div className="diff" role="region" aria-label="代码改动">
        {diff.split('\n').map((l, i) => {
          const cls = l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'r' : '';
          return <div key={i} className={cls}>{l || ' '}</div>;
        })}
      </div> : <p className="muted">未跟踪文件的内容请在工作区查看。</p>}
      {truncated ? <p className="muted" style={{ marginTop: 8 }}>改动过大,只显示了前一部分。</p> : null}
    </>
  );
}
