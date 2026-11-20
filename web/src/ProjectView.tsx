import { useState } from 'react';
import { api, type MissingSecret, type Project, type RunRow, type RunStatus } from './api';
import { ago, Banner, ERROR_HINT, errorText, Pill, usePoll } from './common';

type Filter = 'all' | 'attention' | 'running' | 'done' | 'failed';

const FILTERS: { key: Filter; label: string; test: (r: RunRow) => boolean }[] = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'attention', label: '待处理', test: (r) => ['awaiting-plan-approval', 'needs-human', 'interrupted'].includes(r.status) },
  { key: 'running', label: '执行中', test: (r) => r.status === 'running' },
  { key: 'done', label: '已完成', test: (r) => r.status === 'succeeded' },
  { key: 'failed', label: '失败', test: (r) => ['failed', 'cancelled'].includes(r.status) },
];

export function ProjectView({
  project,
  onOpenRun,
  onChanged,
  toast,
}: {
  project: Project;
  onOpenRun: (id: string) => void;
  onChanged: () => void;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [missing, setMissing] = useState<MissingSecret[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [composing, setComposing] = useState(false);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  usePoll(
    async () => {
      try {
        const [r, s] = await Promise.all([api.runs(project.id), api.status(project.id)]);
        setRuns(r.runs);
        setMissing(s.missingSecrets);
        setLoadError(null);
      } catch (e) {
        setLoadError(errorText(e));
      }
    },
    2500,
    [project.id],
  );

  const create = async (): Promise<void> => {
    if (!task.trim()) return;
    setBusy(true);
    try {
      const { id } = await api.createRun(project.id, task.trim());
      setTask('');
      setComposing(false);
      onChanged();
      onOpenRun(id);
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const list = runs ?? [];
  const attention = list.filter((r) => FILTERS[1].test(r));
  const active = FILTERS[0] && FILTERS.find((f) => f.key === filter)!;
  const shown = list.filter(active.test);
  const week = Date.now() - 7 * 86400_000;
  const doneWeek = list.filter((r) => r.status === 'succeeded' && Date.parse(r.updatedAt) > week);
  const cost = list.reduce((a, r) => a + (r.usage?.costUsd ?? 0), 0);
  const execRun = list.find((r) => r.executing);

  return (
    <>
      <div className="top">
        <div>
          <h1>{project.name}</h1>
          <div className="sub mono">{project.root}</div>
        </div>
        <button className="btn p" onClick={() => setComposing((v) => !v)} disabled={!project.available}>
          {composing ? '收起' : '+ 新建任务'}
        </button>
      </div>

      {!project.available ? (
        <Banner kind="err" title="这个文件夹已不可用">
          路径不存在或已不再是 Git 仓库。可以在左侧把它从列表中移除。
        </Banner>
      ) : null}

      {loadError ? (
        <Banner kind="err" title="无法读取这个项目">
          {loadError}
        </Banner>
      ) : null}

      {missing.length ? (
        <Banner kind="warn" title="缺少 API 密钥,相关环节无法运行">
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            {missing.map((m) => (
              <li key={m.agent}>
                Agent <b style={{ display: 'inline' }}>{m.agent}</b>
                {m.stages.length ? `(用于 ${m.stages.join('、')})` : '(当前没有环节使用它)'}:需要环境变量 <code>{m.variable}</code>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6 }}>
            请在启动 <code>repobaton ui</code> 的终端里设置它,再重新启动。界面不会显示、也不会保存密钥。
          </div>
        </Banner>
      ) : null}

      {execRun ? (
        <Banner
          kind="info"
          title="这个项目正在执行一个任务"
          actions={
            <button className="btn sm" onClick={() => onOpenRun(execRun.id)}>
              查看进度
            </button>
          }
        >
          同一个仓库同一时间只执行一个任务;其他项目不受影响。
        </Banner>
      ) : null}

      {composing ? (
        <div className="card sec" style={{ marginBottom: 18 }}>
          <h2>新建任务</h2>
          <p className="muted" style={{ marginBottom: 8 }}>
            描述要完成的事。会先由规划环节出计划;如果配置里开启了计划审批,会停下来等你确认。
          </p>
          <textarea
            autoFocus
            value={task}
            placeholder="例如:修复 add() 让它返回两数之和,并补充测试"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void create();
            }}
            aria-label="任务描述"
          />
          <div className="actions">
            <button className="btn p" disabled={busy || !task.trim() || missing.some((m) => m.stages.length > 0)} onClick={() => void create()}>
              {busy ? '正在创建…' : '开始'}
            </button>
            <button className="btn" onClick={() => setComposing(false)}>
              取消
            </button>
            <span className="muted">Ctrl + Enter 提交</span>
          </div>
        </div>
      ) : null}

      <div className="stats">
        <div className={`st ${attention.length ? 'hot' : ''}`}>
          <small>等待你处理</small>
          <b>{attention.length}</b>
          <i>{attention.length ? summarizeAttention(attention) : '没有需要处理的任务'}</i>
        </div>
        <div className="st">
          <small>执行中</small>
          <b>{list.filter((r) => r.executing).length}</b>
          <i>{execRun ? STAGE_LABEL(execRun.stage) : '空闲'}</i>
        </div>
        <div className="st">
          <small>近 7 天完成</small>
          <b>{doneWeek.length}</b>
          <i>共 {list.length} 个任务</i>
        </div>
        <div className="st">
          <small>累计花费</small>
          <b>${cost.toFixed(2)}</b>
          <i>仅统计报告了费用的 agent</i>
        </div>
      </div>

      <div className="tabs" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'on' : ''} onClick={() => setFilter(f.key)}>
            {f.label} {list.filter(f.test).length}
          </button>
        ))}
      </div>

      <div className="card tbl">
        <div className="row hd">
          <span>状态</span>
          <span>任务</span>
          <span>轮次</span>
          <span>更新</span>
          <span>花费</span>
          <span />
        </div>
        {runs === null ? (
          <div className="empty">正在加载…</div>
        ) : shown.length === 0 ? (
          <div className="empty">
            <h3>{list.length === 0 ? '还没有任务' : '没有符合条件的任务'}</h3>
            {list.length === 0 ? '点右上角「新建任务」开始。' : '换一个筛选看看。'}
          </div>
        ) : (
          shown.map((r) => (
            <button key={r.id} className="row" onClick={() => onOpenRun(r.id)}>
              <span>
                <Pill status={r.status} executing={r.executing} />
              </span>
              <span className="t">
                {r.task.split('\n')[0]}
                <small>{r.errorKind ? `${ERROR_HINT[r.errorKind] ?? r.errorKind}${r.errorAgent ? `(${r.errorAgent})` : ''}` : r.branch ?? r.id}</small>
              </span>
              <span className="num">{r.rounds || '—'}</span>
              <span className="muted">{ago(r.updatedAt)}</span>
              <span className="num">{r.usage?.costUsd ? `$${r.usage.costUsd.toFixed(2)}` : '—'}</span>
              <span style={{ justifySelf: 'end' }}>
                <span className={`btn sm ${primaryAction(r.status) ? 'p' : ''}`}>{actionLabel(r.status)}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

function STAGE_LABEL(stage?: string): string {
  if (!stage) return '准备中';
  const base = stage.replace(/-r\d+$/, '');
  const m: Record<string, string> = { prepare: '准备工作区', plan: '规划中', implement: '实现中', test: '测试中', review: '审核中', release: '起草发版', publish: '发布' };
  return m[base] ?? stage;
}

function summarizeAttention(rs: RunRow[]): string {
  const c = (s: RunStatus): number => rs.filter((r) => r.status === s).length;
  const parts = [c('awaiting-plan-approval') && `${c('awaiting-plan-approval')} 个待审批`, c('interrupted') && `${c('interrupted')} 个已中断`, c('needs-human') && `${c('needs-human')} 个需人工`];
  return parts.filter(Boolean).join(' · ');
}

function primaryAction(s: RunStatus): boolean {
  return ['awaiting-plan-approval', 'interrupted', 'needs-human'].includes(s);
}

function actionLabel(s: RunStatus): string {
  switch (s) {
    case 'awaiting-plan-approval':
      return '审阅计划';
    case 'interrupted':
      return '查看并继续';
    case 'needs-human':
      return '查看并处理';
    case 'failed':
      return '查看错误';
    default:
      return '查看';
  }
}
