import { useState } from 'react';
import { api, type CustomFlow, type FlowStep, type MissingSecret, type Project, type ProjectSettings, type RunRow, type RunStatus, type TaskWorkflow } from './api';
import { ago, Banner, ERROR_HINT, errorText, Pill, usePoll } from './common';
import { FlowEditor, initialFlow } from './FlowEditor';
import { accessDescription } from './agentAccess';

type Filter = 'all' | 'attention' | 'running' | 'done' | 'failed';

const FILTERS: { key: Filter; label: string; test: (r: RunRow) => boolean }[] = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'attention', label: '待处理', test: (r) => ['awaiting-plan-approval', 'needs-human', 'interrupted'].includes(r.status) },
  { key: 'running', label: '执行中', test: (r) => r.status === 'running' },
  { key: 'done', label: '已完成', test: (r) => r.status === 'succeeded' },
  { key: 'failed', label: '失败', test: (r) => ['failed', 'cancelled'].includes(r.status) },
];

const STAGE_TITLES = { plan: '规划', implement: '实现与返修', review: '审核', release: '发版草稿' };

function templateCopy(settings: ProjectSettings, choices: TaskWorkflow): CustomFlow {
  const prompts = { plan: '分析任务并提出可执行的计划。', implement: '按照任务和交接内容修改工作区。', review: '检查工作区的改动，报告问题和建议。', release: '根据任务和交接内容编写变更摘要。' };
  const steps: FlowStep[] = [];
  let previous = '';
  for (const name of ['plan', 'implement', 'review', 'release'] as const) {
    const stage = settings.stages.find((item) => item.name === name && item.enabled);
    if (!stage) continue;
    const selection = choices[name] ?? stage;
    steps.push({ id: name, title: STAGE_TITLES[name], type: 'agent', agent: selection.agent,
      ...(selection.model ? { model: selection.model } : {}), access: name === 'implement' ? 'workspace-write' : 'read-only',
      prompt: `${prompts[name]}\n\n{{task}}${previous ? `\n\n{{steps.${previous}.output}}` : ''}`, output: { kind: 'text' } });
    previous = name;
    if (name === 'plan' && settings.requireApproval) steps.push({ id: 'confirm_plan', title: '确认计划', type: 'approval', show: [{ kind: 'step-output', step: 'plan' }] });
    if (name === 'implement' && settings.testCommand) {
      steps.push({ id: 'test', title: '运行测试', type: 'command', run: settings.testCommand, output: { kind: 'text' } });
      previous = 'test';
    }
  }
  return { schema: 1, kind: 'custom', name: '四阶段流程副本', git: { mode: 'none' }, steps };
}

export function ProjectView({
  project,
  onOpenRun,
  onOpenSettings,
  onChanged,
  toast,
}: {
  project: Project;
  onOpenRun: (id: string) => void;
  onOpenSettings: () => void;
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
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [workflow, setWorkflow] = useState<TaskWorkflow>({});
  const [custom, setCustom] = useState(false);
  const [flow, setFlow] = useState<CustomFlow | null>(null);
  const [flowRevision, setFlowRevision] = useState('');
  const [savedFlow, setSavedFlow] = useState('');
  const [flowPreview, setFlowPreview] = useState<CustomFlow | null>(null);
  const [flowBusy, setFlowBusy] = useState(false);
  const [startPreview, setStartPreview] = useState<{ flow: CustomFlow; agents: Record<string, { type: string; command?: string; hasArguments: boolean }>; hash: string; shell: string; workspace: string; workspaceMode: 'worktree' | 'directory'; task: string } | null>(null);
  const [composeError, setComposeError] = useState('');

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
    if (!task.trim() || !settings || busy) return;
    setBusy(true);
    try {
      if (custom && flow) {
        const snapshot = JSON.parse(JSON.stringify(flow)) as CustomFlow;
        const preview = await api.previewFlowStart(project.id, snapshot);
        setStartPreview({ ...preview, task: task.trim() });
        return;
      }
      const { id } = await api.createRun(project.id, task.trim(), workflow);
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

  const confirmStart = async (): Promise<void> => {
    if (!startPreview || busy) return;
    setBusy(true);
    try {
      const { id } = await api.createFlowRun(project.id, startPreview.task, startPreview.flow, startPreview.hash);
      setStartPreview(null);
      setTask('');
      setComposing(false);
      onChanged();
      onOpenRun(id);
    } catch (error) { toast(errorText(error), 'err'); }
    finally { setBusy(false); }
  };

  const openComposer = async (): Promise<void> => {
    if (composing) {
      setComposing(false);
      return;
    }
    setComposing(true);
    setSettings(null);
    setComposeError('');
    try {
      const [value, stored] = await Promise.all([api.settings(project.id), api.flow(project.id)]);
      if (!project.hasCommits) setCustom(true);
      setWorkflow(Object.fromEntries(value.stages.filter((s) => s.enabled).map((s) => [s.name, { agent: s.agent, model: s.model }])));
      try {
        const saved = localStorage.getItem(`repobaton.flow.${project.id}`);
        const selected = saved ? JSON.parse(saved) as CustomFlow : stored.flow ?? initialFlow(value);
        setFlow(selected);
        setFlowRevision(stored.revision);
        setSavedFlow(stored.flow ? JSON.stringify(stored.flow) : '');
      } catch {
        setFlow(initialFlow(value));
        setFlowRevision(stored.revision);
        setSavedFlow(stored.flow ? JSON.stringify(stored.flow) : '');
      }
      setSettings(value);
    } catch (err) {
      setComposeError(errorText(err));
    }
  };

  const codex = settings?.agents.find((a) => a.type === 'codex-cli');
  const claude = settings?.agents.find((a) => a.type === 'claude-cli');
  const missingForTask = missing.some((m) => custom ? flow?.steps.some((step) => step.agent === m.agent || step.fallbackAgent === m.agent) : Object.values(workflow).some((selection) => selection.agent === m.agent));

  const saveCustomFlow = async (): Promise<void> => {
    if (!flow || flowBusy) return;
    setFlowBusy(true);
    try {
      const saved = await api.saveFlow(project.id, flowRevision, flow);
      setFlow(saved.flow);
      setFlowRevision(saved.revision);
      setSavedFlow(JSON.stringify(saved.flow));
      localStorage.removeItem(`repobaton.flow.${project.id}`);
      toast('流程已保存');
    } catch (error) { toast(errorText(error), 'err'); }
    finally { setFlowBusy(false); }
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
        <div className="project-actions">
          <button className="btn" onClick={onOpenSettings} disabled={!project.available}>配置</button>
          <button className="btn p" onClick={() => void openComposer()} disabled={!project.available}>
            {composing ? '收起' : '+ 新建任务'}
          </button>
        </div>
      </div>

      {!project.available ? (
        <Banner kind="err" title="这个文件夹已不可用">
          路径不存在或无法访问。可以在左侧把它从列表中移除。
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
          <p className="muted" style={{ marginBottom: 8 }}>描述任务，然后选择执行方式。</p>
          <textarea
            autoFocus
            value={task}
            disabled={!!startPreview}
            placeholder="例如:修复 add() 让它返回两数之和,并补充测试"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void create();
            }}
            aria-label="任务描述"
          />
          <div className="flow-mode" role="group" aria-label="执行方式">
            {project.hasCommits && <button type="button" disabled={!!startPreview} className={custom ? 'btn' : 'btn p'} onClick={() => setCustom(false)}>内置流程</button>}
            <button type="button" disabled={!!startPreview} className={custom ? 'btn p' : 'btn'} onClick={() => setCustom(true)}>自定义流程</button>
          </div>
          {!project.hasCommits && <p className="muted">这个文件夹会直接作为工作区，Agent 的修改会写入所选文件夹。</p>}
          {custom && flow && settings ? <><FlowEditor flow={flow} agents={settings.agents} disabled={busy || flowBusy || !!startPreview} isGit={project.hasCommits} onChange={(next) => {
            setFlow(next);
            localStorage.setItem(`repobaton.flow.${project.id}`, JSON.stringify(next));
          }} /><div className="flow-tools">
            <button type="button" className="btn sm" disabled={flowBusy || savedFlow === JSON.stringify(flow)} onClick={() => void saveCustomFlow()}>保存流程</button>
            <label className="btn sm flow-import">导入 YAML<input type="file" accept=".yaml,.yml" disabled={flowBusy} onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
              if (!file) return;
              setFlowBusy(true);
              void file.text().then((yaml) => api.previewFlow(project.id, yaml)).then(({ flow: preview }) => setFlowPreview(preview))
                .catch((error) => toast(errorText(error), 'err')).finally(() => setFlowBusy(false));
            }} /></label>
            <button type="button" className="btn sm" disabled={flowBusy} onClick={() => {
              setFlowBusy(true);
              void api.exportFlow(project.id, flow).then(({ yaml }) => {
                const url = URL.createObjectURL(new Blob([yaml], { type: 'application/yaml' }));
                const link = document.createElement('a'); link.href = url; link.download = 'repobaton-flow.yaml'; link.click(); URL.revokeObjectURL(url);
              }).catch((error) => toast(errorText(error), 'err')).finally(() => setFlowBusy(false));
            }}>导出 YAML</button>
            <span className="muted">{savedFlow === JSON.stringify(flow) ? '流程已保存' : '修改尚未保存'}</span>
          </div>{flowPreview && <div className="flow-preview"><h3>导入预览</h3>
            <p>流程：{flowPreview.name} · Git 策略：{flowPreview.git.mode}</p>
            <ol>{flowPreview.steps.map((step) => {
              const old = flow?.steps.find((item) => item.id === step.id);
              const inputs = step.type === 'approval' ? step.show : step.inputs;
              const describeInput = (input: NonNullable<FlowStep['inputs']>[number]) => input.kind === 'task' ? '任务描述' : input.kind === 'file' ? `文件 ${input.path}` : `${input.step} / ${input.kind === 'step-output' ? '输出' : '退出码'}`;
              return <li key={step.id}>
                <strong>{step.title}</strong> <span className="muted">({step.id}) · {step.type === 'command' ? '命令' : step.type === 'agent' ? 'Agent' : step.type === 'commit' ? 'Git 提交' : '人工确认'}</span>
                {step.type === 'agent' && <><p>Agent：{step.agent}{step.model ? ` · 模型：${step.model}` : ' · 沿用默认模型'}{step.fallbackAgent ? ` · 备用：${step.fallbackAgent}` : ''}</p><p className="muted">{accessDescription(settings.agents.find((agent) => agent.id === step.agent)?.type, step.access)}</p><details><summary>查看提示词及引用</summary><pre className="flow-output">{step.prompt}</pre></details></>}
                {inputs?.length ? <p>输入：{inputs.map(describeInput).join('、')}</p> : null}
                {step.type === 'command' && <><p>{old?.type !== 'command' ? '新增命令' : old.run !== step.run ? '命令已更改' : '命令未更改'}</p><pre className="flow-output">{step.run}</pre>{old?.type === 'command' && old.run !== step.run && <details><summary>查看编辑器中的原命令</summary><pre className="flow-output">{old.run}</pre></details>}</>}
              </li>;
            })}</ol>
            {flowPreview.git.publish?.push && <p>远端操作：推送到 {flowPreview.git.publish.remote || 'origin'}{flowPreview.git.publish.createPr ? ' → 创建 PR' : ''}{flowPreview.git.publish.merge ? ' → 合并' : ''}{flowPreview.git.publish.tag ? ' → 打标签' : ''}</p>}
            <p className="muted">预览不会保存或执行流程；开始任务前仍会展示执行命令供确认。</p>
            <div className="flow-add"><button type="button" className="btn sm p" onClick={() => { setFlow(flowPreview); localStorage.setItem(`repobaton.flow.${project.id}`, JSON.stringify(flowPreview)); setFlowPreview(null); }}>应用到编辑器</button><button type="button" className="btn sm" onClick={() => setFlowPreview(null)}>取消</button></div>
          </div>}</> : !custom && <div className="task-workflow settings-form">
            <div className="settings-agent-head">
              <h3>本次任务编排</h3>
              {settings && <button className="btn sm" type="button" disabled={busy} onClick={() => {
                if (localStorage.getItem(`repobaton.flow.${project.id}`) && !window.confirm('将用四阶段副本替换当前未保存的自定义流程，继续吗？')) return;
                const copy = templateCopy(settings, workflow);
                setFlow(copy); setCustom(true);
                localStorage.setItem(`repobaton.flow.${project.id}`, JSON.stringify(copy));
              }}>复制为自定义流程</button>}
              {codex && claude && (
                <button className="btn sm" type="button" disabled={busy} onClick={() => setWorkflow((current) =>
                  Object.fromEntries(Object.keys(current).map((name) => [name, { agent: name === 'implement' ? codex.id : claude.id, model: '' }])))}>
                  使用本机 Codex + Claude Code
                </button>
              )}
            </div>
            <p className="muted">副本使用示例提示词，步骤可自由修改；自动测试检测、自动返修、自动提交和发布规则不会复制。</p>
            {composeError ? <p role="alert">{composeError}</p> : !settings ? <p className="muted">正在读取 Agent…</p> :
              settings.stages.filter((stage) => stage.enabled).map((stage) => {
                const selection = workflow[stage.name];
                if (!selection) return null;
                const title = STAGE_TITLES[stage.name];
                return (
                  <div className="settings-stage-row" key={stage.name}>
                    <span className="settings-stage-name">{title}</span>
                    <label>Agent
                      <select aria-label={`${title} Agent`} value={selection.agent} disabled={busy}
                        onChange={(e) => setWorkflow({ ...workflow, [stage.name]: { agent: e.target.value, model: '' } })}>
                        {settings.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
                      </select>
                    </label>
                    <label>模型
                      <input aria-label={`${title}模型`} value={selection.model} placeholder="沿用 Agent 默认模型" disabled={busy}
                        onChange={(e) => setWorkflow({ ...workflow, [stage.name]: { ...selection, model: e.target.value } })} />
                    </label>
                  </div>
                );
              })}
            {missingForTask && <p className="muted" role="status">本次选中的 Agent 缺少密钥，请在「全局 Agent」里检查。</p>}
          </div>}
          {custom && missingForTask && <p className="muted" role="status">本次选中的 Agent 缺少密钥，请在「全局 Agent」里检查。</p>}
          {startPreview && <section className="flow-preview" aria-label="运行前确认">
            <h3>确认本次任务</h3>
            <p className="muted">{startPreview.workspaceMode === 'directory' ? '直接修改项目目录' : '在项目的独立工作区运行'}：<code>{startPreview.workspace}</code></p>
            <p>任务：{startPreview.task}。确认后将运行这里展示的流程快照。</p>
            <ol>{startPreview.flow.steps.map((step) => <li key={step.id}>
              <strong>{step.title}</strong> · {step.type === 'agent' ? `Agent ${step.agent}${step.model ? ` / ${step.model}` : ''}` : step.type === 'command' ? '命令' : step.type === 'approval' ? '人工确认' : 'Git 提交'}
              {step.type === 'agent' && <p className="muted">{accessDescription(startPreview.agents?.[step.agent ?? '']?.type, step.access)}</p>}
              {step.type === 'agent' && startPreview.agents?.[step.agent ?? '']?.type === 'command' && <p>外部程序：<code>{startPreview.agents?.[step.agent ?? '']?.command}</code>{startPreview.agents?.[step.agent ?? '']?.hasArguments && '（参数可能含敏感内容，请在 Agent 配置中核对；参数变更后需要重新确认）'}</p>}
              {step.type === 'agent' && step.fallbackAgent && <p>备用 Agent：{step.fallbackAgent}{startPreview.agents?.[step.fallbackAgent]?.type === 'command' && <> · 外部程序：<code>{startPreview.agents[step.fallbackAgent].command}</code>{startPreview.agents[step.fallbackAgent].hasArguments && '（请在 Agent 配置中核对参数）'}</>}</p>}
              {step.type === 'agent' && step.fallbackAgent && <p className="muted">备用 Agent：{accessDescription(startPreview.agents?.[step.fallbackAgent]?.type, step.access)}</p>}
              {step.type === 'command' && <><p className="muted">Shell：{startPreview.shell || '系统默认 shell'}</p><pre className="flow-output">{step.run}</pre></>}
            </li>)}</ol>
            {startPreview.flow.git.publish?.push && <div><h4>流程结束后的远端操作</h4>
              <p>远端：{startPreview.flow.git.publish.remote || 'origin'} · 推送分支{startPreview.flow.git.publish.createPr ? ' → 创建 PR' : ''}{startPreview.flow.git.publish.merge ? ' → 压缩合并 PR 并删除分支' : ''}{startPreview.flow.git.publish.tag ? ' → 打标签' : ''}</p>
              <p className="muted">最后的人工确认会展示具体提交、推送地址和发布内容；确认前不会执行这些远端操作。</p></div>}
            <div className="actions"><button type="button" className="btn p" disabled={busy} onClick={() => void confirmStart()}>确认并开始</button><button type="button" className="btn" disabled={busy} onClick={() => setStartPreview(null)}>返回修改</button></div>
          </section>}
          <div className="actions">
            <button className="btn p" disabled={busy || !!startPreview || !task.trim() || !settings || missingForTask} onClick={() => void create()}>
              {busy ? '正在创建…' : '开始'}
            </button>
            <button className="btn" onClick={() => { setStartPreview(null); setComposing(false); }}>
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
