import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, hasToken, initApi, type Project } from './api';
import { ProjectView } from './ProjectView';
import { RunView } from './RunView';
import { SettingsView } from './SettingsView';
import { GlobalAgentsView } from './GlobalAgentsView';
import { errorText, useToast } from './common';
import './styles.css';

initApi();

interface Route {
  agents?: boolean;
  project?: string;
  run?: string;
  settings?: boolean;
}

function parseRoute(): Route {
  if (window.location.hash === '#/agents') return { agents: true };
  const m = /^#\/p\/([^/]+)(?:\/(settings)|\/r\/([^/]+))?$/.exec(window.location.hash);
  return m ? { project: decodeURIComponent(m[1]), settings: !!m[2], run: m[3] ? decodeURIComponent(m[3]) : undefined } : {};
}

export function go(project?: string, route?: 'settings' | { run: string }): void {
  const suffix = route === 'settings' ? '/settings' : route ? `/r/${encodeURIComponent(route.run)}` : '';
  window.location.hash = project ? `#/p/${encodeURIComponent(project)}${suffix}` : '#/';
}

function App() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(parseRoute());
  const [adding, setAdding] = useState('');
  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      setProjects((await api.projects()).projects);
      setFatal(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setFatal('token');
      else setFatal(errorText(e));
    }
  }, []);

  useEffect(() => {
    const onHash = (): void => setRoute(parseRoute());
    window.addEventListener('hashchange', onHash);
    void refresh();
    const t = window.setInterval(refresh, 2500);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.clearInterval(t);
    };
  }, [refresh]);

  if (!hasToken() || fatal === 'token') {
    return (
      <div className="card gate">
        <h1>需要重新打开</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          这个页面没有有效的访问令牌。请回到运行 <code>repobaton ui</code> 的终端,用它打印的完整地址(带 <code>#token=…</code>)重新打开。每次启动的令牌都不同。
        </p>
      </div>
    );
  }

  if (fatal) {
    return (
      <div className="card gate" role="alert">
        <h1>连不上本地服务</h1>
        <p className="muted" style={{ marginTop: 8 }}>{fatal}</p>
        <div className="actions"><button className="btn p" onClick={() => void refresh()}>重试</button></div>
      </div>
    );
  }

  const addProject = async (): Promise<void> => {
    const path = adding.trim();
    if (!path) return;
    try {
      const { project } = await api.addProject(path);
      setAdding('');
      // Navigate first: a refresh that finishes later must not pull the user back from wherever they went.
      go(project.id);
      toast.show(`已添加项目 ${project.name}`);
      await refresh();
    } catch (e) {
      toast.show(errorText(e), 'err');
    }
  };

  const current = projects?.find((p) => p.id === route.project);

  return (
    <div className="app">
      <aside className="side" aria-label="项目">
        <div className="brand">
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="9.5" y="1" width="5" height="22" rx="2.5" transform="rotate(35 12 12)" fill="#fff" /><circle cx="18.5" cy="5.5" r="3.2" fill="#6C8CFF" /></svg>
          RepoBaton
        </div>
        <button className={`pitem global-agents-link ${route.agents ? 'on' : ''}`}
          aria-current={route.agents ? 'page' : undefined} onClick={() => { window.location.hash = '#/agents'; }}>全局 Agent</button>
        <div>
          <h2>项目</h2>
          <div className="plist">
            {projects?.map((p) => (
              <div key={p.id} className="project-entry"><button className={`pitem ${p.id === route.project ? 'on' : ''}`} onClick={() => go(p.id)} title={p.root}>
                <span className={`dot ${!p.available ? 'gone' : p.busy ? 'busy' : ''}`} aria-hidden="true" />
                <span className="nm">{p.name}</span>
                {p.needsAttention > 0 ? <span className="badge" title="需要你处理的任务">{p.needsAttention}</span> : null}
              </button><button type="button" className="project-remove" aria-label={`移除 ${p.name}`} title="从列表移除（不会删除文件）" onClick={() => {
                void api.removeProject(p.id).then(() => { if (route.project === p.id) go(); void refresh(); }).catch((error) => toast.show(errorText(error), 'err'));
              }}>×</button></div>
            ))}
            {projects && projects.length === 0 ? <p style={{ padding: '4px 10px', fontSize: 13 }}>还没有项目</p> : null}
          </div>
        </div>
        <div className="addrow add">
          <h2 style={{ padding: 0 }}>添加项目</h2>
          <input
            aria-label="项目路径"
            placeholder="D:\\workspace\\my-repo"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addProject(); }}
          />
          <button className="btn sm" onClick={() => void addProject()} disabled={!adding.trim()}>添加</button>
        </div>
      </aside>
      <main>
        {route.agents ? (
          <GlobalAgentsView toast={toast.show} />
        ) : projects === null ? (
          <p className="muted">加载中…</p>
        ) : !current ? (
          <div className="empty"><h2>选择或添加一个项目</h2>在左侧输入一个本地项目文件夹的路径。</div>
        ) : route.run ? (
          <RunView key={`${current.id}/${route.run}`} projectId={current.id} runId={route.run} notify={toast.show} onBack={() => go(current.id)} />
        ) : route.settings ? (
          <SettingsView key={current.id} project={current} onBack={() => go(current.id)} toast={toast.show} />
        ) : (
          <ProjectView key={current.id} project={current} onOpenRun={(run) => go(current.id, { run })}
            onOpenSettings={() => go(current.id, 'settings')} onChanged={refresh} toast={toast.show} />
        )}
      </main>
      {toast.node}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
