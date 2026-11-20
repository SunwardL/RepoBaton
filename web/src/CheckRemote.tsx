import { useState } from 'react';
import { api } from './api';
import { Banner, errorText } from './common';

const HELP: Record<string, string> = {
  push: '远端分支当前指向的提交(必须是已批准的提交)',
  pr: '拉取请求的网址',
  merge: '已合并拉取请求的合并提交(完整 40 位 SHA)',
  tag: '已推送的 tag 指向的提交(必须是合并提交)',
};

/**
 * Shown when a push, PR, merge or tag was interrupted and nobody knows whether it happened.
 * The server asks the remote itself; "completed" is only recorded when the remote confirms it
 * or the evidence given here settles it. Otherwise the run stays paused.
 */
export function CheckRemote({ projectId, runId, op, branch, onDone, notify }: { projectId: string; runId: string; op: string; branch?: string; onDone: () => void; notify: (m: string, k?: 'ok' | 'err') => void }) {
  const [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (claimDone: boolean): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const v = evidence.trim();
    const ev = !claimDone || !v ? undefined : op === 'pr' ? { prUrl: v } : op === 'merge' ? { mergeSha: v } : { remoteSha: v };
    try {
      const r = await api.check(projectId, runId, claimDone ? { completed: true, evidence: ev } : {});
      notify(r.recorded === 'done' ? `已记录:${r.summary}` : `已确认它没有发生:${r.summary}。现在可以继续。`);
      onDone();
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Banner kind="warn" title="先核对远端">
        中断时正在执行外部操作「{op}」,无法确认它是否已经发生。系统会直接向远端查询{branch ? `(分支 ${branch})` : ''},只有远端能证明的结果才会被记录;查询不到时任务保持暂停,不会重复执行。
      </Banner>
      {problem ? <Banner kind="err" title="暂时无法继续">{problem}</Banner> : null}
      <div className="actions">
        <button className="btn p" disabled={busy} onClick={() => void run(false)}>检查远端</button>
      </div>
      <h3 style={{ margin: '14px 0 6px', fontSize: 13 }}>远端查不到时,你可以附上证据</h3>
      <input type="text" className="full" aria-label="证据" placeholder={HELP[op] ?? '证据'} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      <div className="actions">
        <button className="btn" disabled={busy || !evidence.trim()} onClick={() => void run(true)}>按这个证据记为已完成</button>
      </div>
    </>
  );
}
