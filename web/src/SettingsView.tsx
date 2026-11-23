import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AgentConnection, type Project, type ProjectSettings, type SettingsUpdate, type StageName } from './api';
import { Banner, errorText } from './common';
import { CommandAgentFields } from './CommandAgentFields';

const STAGES: Record<StageName, string> = { plan: '规划', implement: '实现与返修', review: '审核', release: '发版草稿' };
const TYPES: Record<string, string> = {
  'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code',
  'openai-compatible': 'OpenAI 兼容 API', 'anthropic-compatible': 'Anthropic 兼容 API', command: '自定义命令',
};
export const CONNECTION_STATUS: Record<AgentConnection['status'], [string, string]> = {
  'logged-in': ['已登录', 'done'],
  'signed-out': ['未登录', 'wait'],
  installed: ['已找到，登录状态未知', 'wait'],
  missing: ['未找到可用命令', 'fail'],
  'key-present': ['密钥已配置', 'done'],
  'key-missing': ['缺少密钥', 'fail'],
  found: ['命令已找到', 'done'],
};

function changedSettings(initial: ProjectSettings, draft: ProjectSettings): SettingsUpdate {
  const update: SettingsUpdate = { revision: initial.revision };
  for (const [index, stage] of draft.stages.entries()) {
    const old = initial.stages[index];
    const changes = {
      ...(stage.agent !== old.agent ? { agent: stage.agent } : {}),
      ...(stage.model !== old.model ? { model: stage.model.trim() } : {}),
    };
    if (Object.keys(changes).length) (update.stages ??= {})[stage.name] = changes;
  }
  if (initial.requireApproval !== draft.requireApproval) update.requireApproval = draft.requireApproval;
  if (initial.testCommand !== draft.testCommand) update.testCommand = draft.testCommand?.trim() || null;
  for (const [index, agent] of draft.commandAgents.entries()) {
    if (JSON.stringify(agent) !== JSON.stringify(initial.commandAgents[index])) {
      const { id, ...options } = agent;
      (update.commands ??= {})[id] = options;
    }
  }
  return update;
}

export function SettingsView({ project, onBack, toast }: {
  project: Project;
  onBack: () => void;
  toast: (message: string, kind?: 'ok' | 'err') => void;
}) {
  const [initial, setInitial] = useState<ProjectSettings | null>(null);
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState('');
  const [connectionError, setConnectionError] = useState('');

  const load = async (): Promise<void> => {
    setLoading(true);
    setProblem('');
    try {
      const value = await api.settings(project.id);
      setInitial(value);
      setDraft(value);
      setConnections([]);
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [project.id]);

  const check = async (): Promise<void> => {
    setChecking(true);
    setConnectionError('');
    try {
      const result = await api.checkAgents(project.id);
      setConnections(result.agents);
    } catch (err) {
      setConnectionError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const update = initial && draft ? changedSettings(initial, draft) : null;
  const dirty = !!update && Object.keys(update).length > 1;

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!update || !dirty || saving || project.busy) return;
    setSaving(true);
    setProblem('');
    try {
      const value = await api.saveSettings(project.id, update);
      setInitial(value);
      setDraft(value);
      toast('项目配置已保存');
      if (update.commands) void check();
    } catch (err) {
      const stale = err instanceof ApiError && err.code === 'stale-config';
      setProblem(stale ? '配置文件在别处有更新。请重新读取后再编辑。' : errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="crumb"><button type="button" onClick={onBack}>← 返回任务列表</button></div>
      <header className="top">
        <div>
          <h1>项目配置</h1>
          <div className="sub">{project.name} · <span className="mono">{initial?.file ?? '默认配置'}</span></div>
        </div>
        <button className="btn" type="button" disabled={loading || saving || checking} onClick={() => {
          if (!dirty || window.confirm('放弃尚未保存的修改并重新读取？')) void load();
        }}>重新读取</button>
      </header>
      {problem && <div className="settings-notice" role="alert"><Banner kind="err" title="配置未更新">{problem}</Banner></div>}
      {loading && <div className="card empty">正在读取项目配置…</div>}
      {draft && !loading && (
        <div className="settings-layout">
          <form className="card sec settings-form" onSubmit={(event) => void save(event)}>
            <h2>运行设置</h2>
            <div className="settings-stage">
              {draft.stages.map((stage) => {
                const setStage = (value: Partial<Pick<typeof stage, 'agent' | 'model'>>): void => {
                  setDraft({ ...draft, stages: draft.stages.map((s) => s.name === stage.name ? { ...s, ...value } : s) });
                };
                return (
                  <div className="settings-stage-row" key={stage.name}>
                    <div className="settings-stage-name">{STAGES[stage.name]}{!stage.enabled && <small>已停用</small>}</div>
                    <label>Agent
                      <select aria-label={`${STAGES[stage.name]} Agent`} value={stage.agent} disabled={!stage.enabled || saving}
                        onChange={(e) => setStage({ agent: e.target.value })}>
                        {!draft.agents.some((a) => a.id === stage.agent) && <option value={stage.agent}>{stage.agent}</option>}
                        {draft.agents.map((a) => <option key={a.id} value={a.id}>{a.id}</option>)}
                      </select>
                    </label>
                    <label>模型覆盖
                      <input aria-label={`${STAGES[stage.name]}模型`} value={stage.model} placeholder="沿用 Agent 默认模型" disabled={!stage.enabled || saving}
                        onChange={(e) => setStage({ model: e.target.value })} />
                    </label>
                  </div>
                );
              })}
            </div>
            <label className="settings-toggle">
              <input type="checkbox" checked={draft.requireApproval} disabled={saving || !draft.stages.find((s) => s.name === 'plan')?.enabled}
                onChange={(e) => setDraft({ ...draft, requireApproval: e.target.checked })} />
              <span>实现前需要批准计划</span>
            </label>
            <label className="settings-command">测试命令
              <input value={draft.testCommand ?? ''} placeholder="留空自动检测" disabled={saving}
                onChange={(e) => setDraft({ ...draft, testCommand: e.target.value || null })} />
              <small>{draft.testCommand === '' ? '当前配置显式关闭了测试。' : '例如 npm test。清空已设置的命令可恢复自动检测。'}</small>
            </label>
            {!!draft.commandAgents.length && <section className="project-command-agents" aria-labelledby="project-command-title">
              <h2 id="project-command-title">项目自定义命令</h2>
              <div className="global-agent-list">
                {draft.commandAgents.map((agent) => (
                  <div className="global-agent" key={agent.id}>
                    <strong>{agent.id}</strong>
                    <CommandAgentFields value={agent} disabled={saving} onChange={(patch) =>
                      setDraft({ ...draft, commandAgents: draft.commandAgents.map((item) =>
                        item.id === agent.id ? { ...item, ...patch } : item) })} />
                  </div>
                ))}
              </div>
            </section>}
            <footer className="settings-footer">
              <span className="muted" aria-live="polite">{project.busy ? '项目有任务正在执行，完成后可保存。' : dirty ? '尚未保存的修改' : '保存到项目的 YAML 配置。'}</span>
              <button className="btn p" type="submit" disabled={!dirty || saving || project.busy}>{saving ? '正在保存…' : '保存配置'}</button>
            </footer>
          </form>
          <section className="card sec settings-agents" aria-labelledby="agent-check-title">
            <h2 id="agent-check-title">Agent 连接</h2>
            <p className="muted">检查本机 CLI 的安装与登录状态，或检查 API 密钥是否已配置。</p>
            <div className="settings-agent-list">
              {draft.agents.map((agent) => {
                const connection = connections.find((c) => c.id === agent.id);
                const [label, tone] = connection ? CONNECTION_STATUS[connection.status] : ['未检查', 'stop'];
                return (
                  <div className="settings-agent" key={agent.id}>
                    <div className="settings-agent-head">
                      <strong>{agent.id}</strong><span className={`pill ${tone}`}><i />{label}</span>
                    </div>
                    <small>{TYPES[agent.type] ?? agent.type}{connection?.version ? ` · ${connection.version}` : ''}</small>
                    {connection?.path && <code title={connection.path}>{connection.path}</code>}
                    {connection?.status === 'key-missing' && <code>需要环境变量 {connection.variable}</code>}
                  </div>
                );
              })}
            </div>
            {connectionError && <div role="alert"><Banner kind="err" title="无法检查连接">{connectionError}</Banner></div>}
            <button className="btn" type="button" disabled={checking} onClick={() => void check()}>{checking ? '正在检查…' : '检查连接'}</button>
            <p className="muted settings-check-note">检查不发送模型请求。</p>
          </section>
        </div>
      )}
    </>
  );
}
