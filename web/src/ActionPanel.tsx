import { useState, type ReactNode } from 'react';
import { api, ApiError, type RunDetail, type RunStatus } from './api';
import { Banner, errorText, ERROR_HINT } from './common';
import { CheckRemote } from './CheckRemote';

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
  const [cleanupPreview, setCleanupPreview] = useState<{ files: string[]; unreferencedHead?: string; confirmationHash: string } | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      notify(label);
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'busy') notify('这个项目已有任务在执行,请等它结束或进入待审批。', 'err');
      else if (e instanceof ApiError && e.code === 'stale-plan') notify('计划已经更新,你看到的是旧版本。页面已刷新,请重新审阅后再操作。', 'err');
      else notify(errorText(e), 'err');
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const s: RunStatus = run.status;
  const blocks: ReactNode[] = [];

  if (run.humanControl && !executing) return <div className="card sec"><h2>人工接管中</h2>
    <p className="muted">请在工作区完成操作，交还后可查看现场并选择继续。</p>
    <p className="mono">{run.worktree}</p>
    <div className="actions"><button className="btn p" disabled={busy} onClick={() => void act('已交还任务', () => api.returnControl(projectId, run.id))}>交还任务</button></div>
  </div>;

  if (run.handoff && !executing) blocks.push(<div key="handoff" className="card sec"><h2>交还后的工作区</h2>
    {run.handoff.branchBefore !== undefined && <p>分支：{run.handoff.branchBefore || '游离 HEAD'} → {run.handoff.branchAfter || '游离 HEAD'}</p>}
    {run.handoff.headBefore && <p className="mono">{run.handoff.headBefore.slice(0, 8)} → {run.handoff.headAfter?.slice(0, 8)}</p>}
    {run.handoff.status ? <pre className="flow-output">{run.handoff.status}</pre> : <p className="muted">{run.workspaceMode === 'directory' ? '请在项目文件夹中查看改动。' : '没有未提交的改动。'}</p>}
    {run.handoff.reviewRequired && <p>请先恢复任务分支，处理未提交改动或已发生的远端操作，再重新接管并交还以核对。</p>}
  </div>);

  if (s === 'awaiting-plan-approval' && !executing) {
    blocks.push(
      <div key="plan" className="card sec">
        <h2>计划等你审批</h2>
        <p className="muted">计划通过后才会开始改代码。你也可以带着意见退回,让规划重新来一遍。</p>
        <div className="actions">
          <button className="btn g" disabled={busy} onClick={() => act('已通过,开始实现', () => api.approve(projectId, run.id, run.planVersion ?? 0))}>
            通过计划
          </button>
        </div>
        <h3 style={{ margin: "16px 0 6px", fontSize: 13 }}>带意见驳回</h3>
        <textarea aria-label="驳回意见" placeholder="例如:把第 1 步拆成两步,并补充回滚方案" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <div className="actions">
          <button
            className="btn d"
            disabled={busy || !feedback.trim()}
            onClick={() => act('已退回,正在重新规划', async () => { await api.reject(projectId, run.id, feedback.trim(), run.planVersion ?? 0); setFeedback(''); })}
          >
            驳回并重新规划
          </button>
        </div>
      </div>,
    );
  }

  if (s === 'interrupted' && !executing && !run.flow) {
    const unsafe = !!run.publish.inFlight;
    blocks.push(
      <div key="int" className="card sec">
        <h2>这个任务被中断了</h2>
        <p className="muted">
          服务重启或退出时它还在执行。工作区、提交、审批记录和报告都还在。继续会从上次完成的检查点接着做,不会从头来。
        </p>
        <div className="actions">
          {unsafe ? null : (
            <button className="btn p" disabled={busy} onClick={() => act('已继续执行', () => api.resume(projectId, run.id, 'interrupted'))}>继续执行</button>
          )}
        </div>
        {unsafe ? <CheckRemote projectId={projectId} runId={run.id} op={run.publish.inFlight!} branch={run.branch} onDone={onChanged} notify={notify} /> : null}
      </div>,
    );
  }

  if ((s === 'failed' || s === 'needs-human' || s === 'cancelled') && !executing && !run.flow) {
    const unsafe = !!run.publish.inFlight;
    blocks.push(
      <div key="stop" className="card sec">
        <h2>{s === 'needs-human' ? '需要你来决定' : s === 'cancelled' ? '已取消' : '执行失败'}</h2>
        {run.error ? <p>{run.error}</p> : null}
        {run.errorKind ? <p className="muted">原因类型:{ERROR_HINT[run.errorKind] ?? run.errorKind}{run.errorAgent ? `(agent ${run.errorAgent})` : ''}</p> : null}
        {unsafe ? (
          <CheckRemote projectId={projectId} runId={run.id} op={run.publish.inFlight!} branch={run.branch} onDone={onChanged} notify={notify} />
        ) : (
          <>
            {s === 'needs-human' ? (
              <>
                <h3 style={{ margin: "12px 0 6px", fontSize: 13 }}>给实现 agent 的指导(可选)</h3>
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

  if (run.flow && ['failed', 'needs-human', 'cancelled', 'interrupted'].includes(s) && !executing) {
    const first = run.flow.workflow.steps.find((step) => run.steps?.[step.id]?.status !== 'succeeded');
    const canResume = !first || (first.type !== 'approval' && run.steps?.[first.id]?.status === 'pending');
    const last = run.flow.workflow.steps.at(-1);
    const confirmation = last?.type === 'approval' ? run.steps?.[last.id]?.approval : undefined;
    const canReviewAgain = !!confirmation && !!run.flow.workflow.git.publish?.push && !run.publish.inFlight && !run.publish.pushed && !run.publish.prUrl && !run.publish.merged && !run.publish.tag && !run.publish.pendingTag;
    blocks.push(<div key="custom-stop" className="card sec"><h2>流程已停止</h2><p>{run.error ?? '请检查步骤状态和工作区。'}</p><p className="muted">工作区已保留，可查看步骤输出和改动。</p>
      {run.publish.inFlight ? <CheckRemote projectId={projectId} runId={run.id} op={run.publish.inFlight} branch={run.branch} onDone={onChanged} notify={notify} /> :
        <div className="actions">{canResume && <button className="btn p" disabled={busy} onClick={() => void act('已继续执行', () => api.resume(projectId, run.id, s))}>继续执行</button>}
          {canReviewAgain && <button className="btn" disabled={busy} onClick={() => void act('请重新审阅发布内容', () => api.reviewPublicationAgain(projectId, run.id, confirmation.contentHash))}>重新审阅发布</button>}</div>}</div>);
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

  const canClean = !executing && s !== 'running' && s !== 'awaiting-plan-approval' && run.worktree && run.workspaceMode !== 'directory';
  if (!executing && s !== 'running' && run.worktree) blocks.push(<div key="takeover" className="card sec"><h2>人工接管</h2>
    <p className="muted">在原生会话或工作区处理后，再交还任务。</p>
    <button className="btn" disabled={busy} onClick={() => void act('已进入人工接管', () => api.takeover(projectId, run.id))}>接管任务</button></div>);
  if (canClean) {
    blocks.push(
      <div key="clean" className="card sec">
        <h2>清理</h2>
        <p className="muted">先检查工作区内容，再决定是否清理。</p>
        {cleanupPreview && <div>
          {cleanupPreview.files.length ? <><p>清理会丢弃以下文件或目录中的改动：</p><pre className="flow-output">{cleanupPreview.files.join('\n')}</pre></> : <p className="muted">没有未提交或忽略的文件。</p>}
          {cleanupPreview.unreferencedHead && <p>此提交没有分支或标签引用：<code>{cleanupPreview.unreferencedHead}</code></p>}
        </div>}
        <div className="actions">
          {!cleanupPreview ? <button className="btn" disabled={busy} onClick={() => {
            setBusy(true);
            void api.cleanupPreview(projectId, run.id).then(setCleanupPreview).catch((error) => notify(errorText(error), 'err')).finally(() => setBusy(false));
          }}>检查清理内容</button> : <>
            <button className="btn" disabled={busy} onClick={() => {
              const losesData = cleanupPreview.files.length > 0 || !!cleanupPreview.unreferencedHead;
              if (window.confirm(losesData ? '确认丢弃上面列出的内容并清理工作区？' : '确认清理这个任务的工作区？')) {
                void act('工作区已清理', () => api.cleanup(projectId, run.id, losesData ? cleanupPreview.confirmationHash : undefined));
              }
            }}>{cleanupPreview.files.length || cleanupPreview.unreferencedHead ? '丢弃并清理' : '清理工作区'}</button>
            <button className="btn" disabled={busy} onClick={() => setCleanupPreview(null)}>取消</button>
          </>}
        </div>
      </div>,
    );
  }

  return <>{blocks}</>;
}
