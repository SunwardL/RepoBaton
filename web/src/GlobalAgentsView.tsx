import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AgentConnection, type GlobalAgent, type GlobalAgents, type GlobalAgentType } from './api';
import { Banner, errorText } from './common';
import { CommandAgentFields } from './CommandAgentFields';
import { CONNECTION_STATUS } from './SettingsView';

const LABELS: Record<GlobalAgentType, string> = {
  'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code',
  'openai-compatible': 'OpenAI 兼容 API', 'anthropic-compatible': 'Anthropic 兼容 API',
  command: '自定义命令',
};

function isNative(agent: GlobalAgent): boolean {
  return agent.type === 'codex-cli' || agent.type === 'claude-cli';
}

export function GlobalAgentsView({ toast }: { toast: (message: string, kind?: 'ok' | 'err') => void }) {
  const [initial, setInitial] = useState<GlobalAgents | null>(null);
  const [agents, setAgents] = useState<GlobalAgent[]>([]);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [checkError, setCheckError] = useState('');
  const dirty = !!initial && JSON.stringify(initial.agents) !== JSON.stringify(agents);

  const check = async (): Promise<void> => {
    setChecking(true);
    setCheckError('');
    try {
      setConnections((await api.checkGlobalAgents()).agents);
    } catch (err) {
      setCheckError(errorText(err));
    } finally {
      setChecking(false);
    }
  };

  const read = async (): Promise<void> => {
    setError('');
    setLoading(true);
    try {
      const value = await api.globalAgents();
      setInitial(value);
      setAgents(value.agents);
      void check();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void read(); }, []);

  const update = (index: number, patch: Partial<GlobalAgent>): void =>
    setAgents((items) => items.map((agent, i) => i === index ? { ...agent, ...patch } : agent));

  const importYaml = async (file: File): Promise<void> => {
    setImporting(true);
    try {
      if (file.size > 900_000) throw new Error('请选择小于 900 KB 的 YAML 文件。');
      const { agents: preview } = await api.previewAgentsYaml(await file.text());
      setAgents((current) => {
        const incoming = new Map(preview.map((agent) => [agent.id, agent]));
        return [...current.map((agent) => {
          const replacement = incoming.get(agent.id);
          incoming.delete(agent.id);
          return replacement ?? agent;
        }), ...incoming.values()];
      });
      toast(`已加载 ${preview.length} 个 Agent，请核对表单后保存。`);
    } catch (err) {
      toast(errorText(err), 'err');
    } finally {
      setImporting(false);
    }
  };

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!initial || !dirty || saving || importing) return;
    setSaving(true);
    setError('');
    try {
      const result = await api.saveGlobalAgents(initial.revision, agents);
      setInitial(result);
      setAgents(result.agents);
      toast('全局 Agent 配置已保存');
      void check();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'stale-config' ? '全局配置已在别处更新，请重新读取。' : errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const cards = (native: boolean) => agents.map((agent, index) => {
    if (isNative(agent) !== native) return null;
    const command = agent.type === 'command';
    const status = connections.find((connection) => connection.id === agent.id);
    const [label, tone] = status ? CONNECTION_STATUS[status.status] : ['未检查', 'stop'];
    return (
      <div className="global-agent" key={index}>
        <div className="settings-agent-head">
          <strong>{native ? LABELS[agent.type] : agent.id || '新连接'}</strong>
          <div className="project-actions">
            <span className={`pill ${tone}`}><i />{label}</span>
            {!native && <button className="btn sm" type="button" disabled={saving}
              onClick={() => setAgents((items) => items.filter((_, i) => i !== index))}>移除</button>}
          </div>
        </div>
        {status?.version && <div className="muted global-agent-detail">{status.version}</div>}
        {status?.path && <div className="mono muted global-agent-detail">{status.path}</div>}
        <div className="global-agent-fields">
          {native ? <label>可执行文件路径
            <input value={agent.path ?? ''} placeholder="留空自动检测" onChange={(e) => update(index, { path: e.target.value })} />
          </label> : <>
            <label>Agent 名称<input required value={agent.id} placeholder="例如 deepseek"
              onChange={(e) => update(index, { id: e.target.value })} /></label>
            <label>连接类型
              <select value={agent.type} onChange={(e) => update(index, { type: e.target.value as GlobalAgentType })}>
                <option value="openai-compatible">OpenAI 兼容 API</option>
                <option value="anthropic-compatible">Anthropic 兼容 API</option>
                <option value="command">自定义命令</option>
              </select>
            </label>
            {!command && <><label>Base URL<input type="url" required value={agent.baseUrl ?? ''} placeholder="https://api.example.com/v1"
              onChange={(e) => update(index, { baseUrl: e.target.value })} /></label>
            <label>密钥环境变量<input required value={agent.apiKeyEnv ?? ''} placeholder="例如 DEEPSEEK_API_KEY"
              onChange={(e) => update(index, { apiKeyEnv: e.target.value })} /></label></>}
          </>}
          <label>默认模型<input required={!native && !command} value={agent.model ?? ''}
            placeholder={native ? '沿用 CLI 默认模型' : command ? '可选，用于 {{model}} 参数' : '服务商提供的模型名称'}
            onChange={(e) => update(index, { model: e.target.value })} /></label>
        </div>
        {command && <CommandAgentFields value={agent} disabled={saving} onChange={(patch) => update(index, patch)} />}
      </div>
    );
  });

  return (
    <>
      <header className="top">
        <div><h1>全局 Agent 配置</h1><p className="sub">这台电脑上的连接可用于所有项目和任务。</p></div>
        <button className="btn" type="button" disabled={loading || saving || checking || importing}
          onClick={() => { if (!dirty || window.confirm('放弃修改并重新读取？')) void read(); }}>重新读取</button>
      </header>
      {error && <div className="settings-notice" role="alert"><Banner kind="err" title="无法保存或读取配置">{error}</Banner></div>}
      {checkError && <div className="settings-notice" role="alert"><Banner kind="err" title="无法检查连接">{checkError}</Banner></div>}
      {loading && <div className="card empty">正在读取全局配置…</div>}
      {!loading && initial && (
        <form className="stack settings-form global-agents" onSubmit={(event) => void save(event)}>
          <section className="card sec">
            <h2>本机 CLI
              <button className="btn sm" type="button" disabled={checking || saving} onClick={() => void check()}>
                {checking ? '正在检查…' : '检查连接'}
              </button>
            </h2>
            <p className="muted">复用本机登录。RepoBaton 任务的返修沿用原生实现会话；检查连接不发送模型请求。</p>
            <div className="global-agent-list">{cards(true)}</div>
          </section>
          <section className="card sec">
            <h2>自定义连接
              <span className="project-actions">
                <button className="btn sm" type="button" disabled={saving} onClick={() =>
                  setAgents((items) => [...items, { id: '', type: 'openai-compatible' }])}>添加 API</button>
                <button className="btn sm" type="button" disabled={saving} onClick={() =>
                  setAgents((items) => [...items, { id: '', type: 'command' }])}>添加命令</button>
              </span>
            </h2>
            <p className="muted">API 密钥通过环境变量提供。自定义命令需要支持非交互式运行。</p>
            <div className="global-agent-list">{cards(false)}</div>
          </section>
          <details className="card sec agent-import">
            <summary>从 YAML 导入</summary>
            <p className="muted">从已有文件读取 Agent 配置。导入会在表单里替换同名配置，确认保存后生效。密钥值不会导入。</p>
            <label>选择 YAML 文件
              <input type="file" accept=".yaml,.yml" disabled={saving || importing} onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void importYaml(file);
              }} />
            </label>
          </details>
          <footer className="global-agent-footer">
            <span className="muted mono">{initial.file}</span>
            <button className="btn p" type="submit" disabled={!dirty || saving || importing}>{saving ? '正在保存…' : '保存全局配置'}</button>
          </footer>
        </form>
      )}
    </>
  );
}
