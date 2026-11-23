import { useState } from 'react';
import type { RunDetail, StageSession } from './api';

const STAGE_LABEL: Record<string, string> = { plan: '规划', implement: '实现', review: '审核', release: '发版草稿' };
const STATUS_LABEL: Record<StageSession['status'], string> = { running: '进行中', completed: '已完成', failed: '失败' };

/** Command that continues the native session from its own working directory (Windows CMD). */
export function resumeCommand(s: StageSession): string | null {
  if (!s.sessionId) return null;
  const run = s.agentType === 'codex-cli' ? `codex resume ${s.sessionId}` : s.agentType === 'claude-cli' ? `claude --resume ${s.sessionId}` : null;
  return run ? `cd /d "${s.cwd}" && ${run}` : null;
}

async function copy(text: string, notify: (ok: boolean) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notify(true);
  } catch {
    notify(false);
  }
}

export function SessionsCard({ run }: { run: RunDetail }) {
  const [msg, setMsg] = useState('');
  const sessions = run.sessions ?? [];
  const done = (ok: boolean): void => setMsg(ok ? '已复制' : '复制失败，请手动选中复制');

  return (
    <div className="card sec">
      <h2>原生会话</h2>
      {sessions.length === 0 ? (
        <p className="muted">无法定位原生会话。这个任务没有记录各阶段的会话，详情和产物仍可查看。</p>
      ) : (
        sessions.map((s, i) => {
          const cmd = resumeCommand(s);
          return (
            <div key={`${s.label}-${i}`} style={{ padding: '8px 0', borderTop: i ? '1px solid var(--line, #ddd)' : undefined }}>
              <div>
                <b>{STAGE_LABEL[s.stage] ?? s.stage}</b>
                {s.round ? ` · 第 ${s.round} 轮` : ''} <span className="chip">{s.agent}</span> <span className="muted">{STATUS_LABEL[s.status]}</span>
              </div>
              {s.sessionId ? (
                <>
                  <div className="mono" style={{ wordBreak: 'break-all' }}>{s.sessionId}</div>
                  <div className="actions">
                    <button className="btn sm" onClick={() => void copy(s.sessionId!, done)}>复制会话 ID</button>
                    {cmd ? <button className="btn sm" onClick={() => void copy(cmd, done)}>复制继续命令</button> : null}
                  </div>
                </>
              ) : (
                <div className="muted">{s.status === 'running' ? '会话 ID 将在阶段完成后出现。' : '这次调用没有返回会话 ID，无法定位原生会话。'}</div>
              )}
            </div>
          );
        })
      )}
      {msg ? <p className="muted" role="status">{msg}</p> : null}
    </div>
  );
}
