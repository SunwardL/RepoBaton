import { useState, type ReactNode } from 'react';
import { api, ApiError, type RunDetail, type RunStatus } from './api';
import { Banner, errorText, ERROR_HINT } from './common';

interface Props {
  projectId: string;
  run: RunDetail;
  executing: boolean;
  /** Called after an action was accepted so the page reloads promptly. */
  onChanged: () => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}

/**
 * Everything the user can do to a run in its current state, and why something is blocked.
 * Each action sends the status the user was looking at, so a stale page cannot act on a
 * run that has moved on.
 */
export function ActionPanel({ projectId, run, executing, onChanged, notify }: Props) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [guidance, setGuidance] = useState('');

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      notify(label);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'busy') notify('这个项目已有任务在执行,请等它结束或进入待审批。', 'err');
      else notify(errorText(e), 'err');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const s: RunStatus = run.status;
  const blocks: ReactNode[] = [];

  if (s === 'awaiting-plan-approval' && !executing) {
    blocks.push(
      <div key="plan" className="card sec">
        <h2>计划等你审批</h2>
        <p className="muted">计划通过后才会开始改代码。你也可以带着意见退回,让规划重新来一遍。</p>
        <div className="actions">
          <button className="btn g" disabled={busy} onClick={() => act('已通过,开始实现', () => api.approve(projectId, run.id))}>
            通过计划
          </button>
        </div>
        <h4 style={{ margin: '16px 0 6px', fontSize: 13 }}>带意见驳回</h4>
        <textarea aria-label="驳回意见" placeholder="例如:把第 1 步拆成两步,并补充回滚方案" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <div className="actions">
          <button
            className="btn d"
            disabled={busy || !feedback.trim()}
            onClick={() => act('已退回,正在重新规划', async () => { await api.reject(projectId, run.id, feedback.trim()); setFeedback(''); })}
          >
            驳回并重新规划
          </button>
        </div>
      </div>,
    );
  }

  if (s === 'interrupted' && !executing) {
    const unsafe = !!run.publish.inFlight;
    blocks.push(
      <div key="int" className="card sec">
        <h2>这个任务被中断了</h2>
        <p className="muted">
          服务重启或退出时它还在执行。工作区、提交、审批记录和报告都还在。继续会从上次完成的检查点接着做,不会从头来。
        </p>
        {unsafe ? (
          <Banner kind="warn" title="先人工核对">
            中断时正在执行外部操作「{run.publish.inFlight}」,无法确认它是否已经发生。请到远端查看分支{run.branch ? ` ${run.branch}` : ''}后,告诉我结果。
          </Banner>
        ) : null}
        <div className="actions">
          {unsafe ? (
            <>
              <button className="btn" disabled={busy} onClick={() => act('已记录:该操作已完成', () => api.acknowledge(projectId, run.id, true))}>我查过了:它已完成</button>
              <button className="btn" disabled={busy} onClick={() => act('已记录:该操作未发生', () => api.acknowledge(projectId, run.id, false))}>我查过了:它没有发生</button>
            </>
          ) : (
            <button className="btn p" disabled={busy} onClick={() => act('已继续执行', () => api.resume(projectId, run.id, 'interrupted'))}>继续执行</button>
          )}
        </div>
      </div>,
    );
  }

  if ((s === 'failed' || s === 'needs-human' || s === 'cancelled') && !executing) {
    const unsafe = !!run.publish.inFlight;
    blocks.push(
      <div key="stop" className="card sec">
        <h2>{s === 'needs-human' ? '需要你来决定' : s === 'cancelled' ? '已取消' : '执行失败'}</h2>
        {run.error ? <p>{run.error}</p> : null}
        {run.errorKind ? <p className="muted">原因类型:{ERROR_HINT[run.errorKind] ?? run.errorKind}{run.errorAgent ? `(agent ${run.errorAgent})` : ''}</p> : null}
        {unsafe ? (
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => act('已记录:该操作已完成', () => api.acknowledge(projectId, run.id, true))}>我查过了:它已完成</button>
            <button className="btn" disabled={busy} onClick={() => act('已记录:该操作未发生', () => api.acknowledge(projectId, run.id, false))}>我查过了:它没有发生</button>
          </div>
        ) : (
          <>
            {s === 'needs-human' ? (
              <>
                <h4 style={{ margin: '12px 0 6px', fontSize: 13 }}>给实现 agent 的指导(可选)</h4>
                <textarea aria-label="指导" value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="告诉它下一轮该怎么改" />
              </>
            ) : null}
            <div className="actions">
              <button
                className="btn p"
                disabled={busy}
                onClick={() =>
                  act('已继续执行', () => api.resume(projectId, run.id, s, s === 'needs-human' ? { moreRounds: 1, feedback: guidance.trim() || undefined } : {}))
                }
              >
                {s === 'needs-human' ? '再来一轮' : '重试'}
              </button>
            </div>
          </>
        )}
      </div>,
    );
  }

  if (executing) {
    blocks.push(
      <div key="exec" className="card sec">
        <h2>正在执行</h2>
        <p className="muted">进度在下方实时更新。取消后可以再继续。</p>
        <div className="actions">
          <button className="btn d" disabled={busy} onClick={() => act('已请求取消', () => api.cancel(projectId, run.id))}>取消执行</button>
        </div>
      </div>,
    );
  }

  if (s === 'running' && !executing) {
    blocks.push(
      <Banner key="orphan" kind="info" title="没有服务在执行这个任务">
        它可能是在终端里用 CLI 启动的,服务无法确认它是否还在跑,所以不会擅自改动它。请在终端里查看,或等它结束。
      </Banner>,
    );
  }

  const canClean = !executing && s !== 'running' && s !== 'awaiting-plan-approval' && run.worktree;
  if (canClean) {
    blocks.push(
      <div key="clean" className="card sec">
        <h2>清理</h2>
        <p className="muted">只删除这个任务的工作区目录,分支和提交会保留。</p>
        <div className="actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => {
              if (window.confirm('删除这个任务的工作区目录?分支和提交会保留。')) void act('工作区已清理', () => api.cleanup(projectId, run.id));
            }}
          >
            清理工作区
          </button>
        </div>
      </div>,
    );
  }

  return <>{blocks}</>;
}
