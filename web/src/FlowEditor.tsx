import { useState } from 'react';
import { accessDescription } from './agentAccess';
import type { CustomFlow, FlowStep, ProjectSettings } from './api';

export function initialFlow(settings: ProjectSettings): CustomFlow {
  const first = settings.agents.find((agent) => agent.type === 'codex-cli') ?? settings.agents[0];
  return { schema: 1, kind: 'custom', name: '自定义流程', git: { mode: 'none' }, steps: [
    { id: 'step1', title: '完成任务', type: 'agent', agent: first?.id ?? '', access: 'workspace-write', prompt: '请完成任务：\n{{task}}', output: { kind: 'text' } },
  ] };
}

export function FlowEditor({ flow, onChange, agents, disabled, isGit }: {
  flow: CustomFlow;
  onChange: (flow: CustomFlow) => void;
  agents: ProjectSettings['agents'];
  disabled: boolean;
  isGit: boolean;
}) {
  const [fileInputs, setFileInputs] = useState<Record<string, string>>({});
  const update = (index: number, patch: Partial<FlowStep>) => onChange({ ...flow,
    steps: flow.steps.map((step, i) => i === index ? { ...step, ...patch } : step),
  });
  const add = (type: FlowStep['type']) => {
    let n = 1;
    while (flow.steps.some((step) => step.id === `step${n}`)) n++;
    const id = `step${n}`;
    const step: FlowStep = type === 'agent'
      ? { id, title: '新步骤', type, agent: agents[0]?.id ?? '', access: 'read-only', prompt: '请处理任务：\n{{task}}', output: { kind: 'text' } }
      : type === 'command' ? { id, title: '运行命令', type, run: '', output: { kind: 'text' } }
      : type === 'approval' ? { id, title: '人工确认', type, message: '请确认后继续。', show: [{ kind: 'task' }] }
      : { id, title: '提交改动', type, message: '' };
    onChange({ ...flow, git: { ...flow.git, mode: type === 'commit' ? 'explicit-step' : flow.git.mode }, steps: [...flow.steps, step] });
  };
  const move = (index: number, direction: number) => {
    const steps = [...flow.steps];
    const target = index + direction;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    onChange({ ...flow, steps });
  };
  const publish = flow.git.publish ?? {};
  const updatePublish = (patch: NonNullable<CustomFlow['git']['publish']>) => onChange({ ...flow, git: { ...flow.git, publish: { ...publish, ...patch } } });
  const updateRelease = (patch: NonNullable<CustomFlow['git']['release']>) => onChange({ ...flow, git: { ...flow.git, release: { ...flow.git.release, ...patch } } });
  return <div className="flow-editor settings-form">
    <div className="flow-heading"><div><h3>自定义流程</h3><p className="muted">步骤依次在同一个工作区执行。使用 {'{{task}}'} 引用任务，使用 {'{{steps.步骤ID.output}}'} 交接输出。</p></div></div>
    {isGit && <label>Git 交由谁处理
      <select value={flow.git.mode} disabled={disabled || flow.steps.some((step) => step.type === 'commit')} onChange={(event) => onChange({ ...flow, git: { ...flow.git, mode: event.target.value as CustomFlow['git']['mode'] } })}>
        <option value="none">不安排提交</option>
        <option value="agent-managed">由 Agent 按提示词处理 Git</option>
        {flow.git.mode === 'explicit-step' && <option value="explicit-step">使用流程中的提交步骤</option>}
      </select>
      <span className="muted">Agent 可使用其工具执行 Git；选择由 Agent 处理时，RepoBaton 会记录每步前后的提交状态。</span>
    </label>}
    {flow.steps.map((step, index) => <section className="flow-step" key={step.id}>
      <div className="flow-step-head"><span className="flow-step-dot" aria-hidden="true" /><strong>{step.title || '未命名步骤'}</strong><span className="muted mono">{step.id}</span>
        <div className="project-actions"><button type="button" className="btn sm" disabled={disabled || index === 0} onClick={() => move(index, -1)}>上移</button>
          <button type="button" className="btn sm" disabled={disabled || index === flow.steps.length - 1} onClick={() => move(index, 1)}>下移</button>
          <button type="button" className="btn sm" disabled={disabled || flow.steps.length === 1} onClick={() => onChange({ ...flow, steps: flow.steps.filter((_, i) => i !== index) })}>删除</button></div>
      </div>
      <div className="flow-fields"><label>步骤名称<input value={step.title} disabled={disabled} onChange={(event) => update(index, { title: event.target.value })} /></label>
        {step.type === 'agent' && <><label>Agent<select value={step.agent} disabled={disabled} onChange={(event) => update(index, { agent: event.target.value, fallbackAgent: undefined })}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}</select></label>
          <label>备用 Agent<select value={step.fallbackAgent ?? ''} disabled={disabled} onChange={(event) => update(index, { fallbackAgent: event.target.value || undefined })}><option value="">不使用</option>{agents.filter((agent) => agent.id !== step.agent).map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}</select></label>
          <label>模型<input value={step.model ?? ''} disabled={disabled} placeholder="沿用默认模型" onChange={(event) => update(index, { model: event.target.value || undefined })} /></label>
          <label>工作区权限<select value={step.access} disabled={disabled} onChange={(event) => update(index, { access: event.target.value as FlowStep['access'] })}><option value="read-only">请求只读</option><option value="workspace-write">允许修改</option></select></label></>}
      </div>
      {step.type === 'agent' && <><label className="flow-full">角色与提示词<textarea rows={4} value={step.prompt ?? ''} disabled={disabled} onChange={(event) => update(index, { prompt: event.target.value })} /></label>
        <div className="flow-inputs"><strong>添加输入到提示词</strong><p className="muted">只会传入选中的内容。不同 Agent 不会自动共享对话。</p>
          <div className="flow-add"><button type="button" className="btn sm" disabled={disabled} onClick={() => update(index, { prompt: `${step.prompt ?? ''}\n{{task}}` })}>＋ 任务描述</button>
            {flow.steps.slice(0, index).filter((item) => item.type === 'agent' || item.type === 'command').map((item) => <button type="button" className="btn sm" key={item.id} disabled={disabled} onClick={() => update(index, { prompt: `${step.prompt ?? ''}\n{{steps.${item.id}.output}}` })}>＋ {item.title}的输出</button>)}
            {flow.steps.slice(0, index).filter((item) => item.type === 'command').map((item) => <button type="button" className="btn sm" key={`${item.id}-exit`} disabled={disabled} onClick={() => update(index, { prompt: `${step.prompt ?? ''}\n{{steps.${item.id}.exit_code}}` })}>＋ {item.title}的退出码</button>)}
          </div>
          <label>工作区文件路径<input value={fileInputs[step.id] ?? ''} disabled={disabled} placeholder="例如 docs/design.md" onChange={(event) => setFileInputs({ ...fileInputs, [step.id]: event.target.value })} /></label>
          <button type="button" className="btn sm" disabled={disabled || !fileInputs[step.id]?.trim()} onClick={() => { const file = fileInputs[step.id].trim(); update(index, { prompt: `${step.prompt ?? ''}\n{{file:${file}}}` }); setFileInputs({ ...fileInputs, [step.id]: '' }); }}>＋ 文件内容</button>
        </div></>}
      {step.type === 'agent' && <p className="muted flow-note">{accessDescription(agents.find((agent) => agent.id === step.agent)?.type, step.access)}{step.fallbackAgent && ' 主 Agent 失败时备用 Agent 会在同一工作区继续；超时或取消时暂停等待处理。'}</p>}
      {step.type === 'command' && <><label className="flow-full">命令<input value={step.run ?? ''} disabled={disabled} placeholder="例如 npm test" onChange={(event) => update(index, { run: event.target.value })} /></label>
        <div className="flow-inputs"><strong>命令输入</strong><p className="muted">选中的内容通过环境变量提供路径或退出码。命令中引用路径时请按所用 shell 的规则加引号；例如 Windows CMD 使用 <code>type &quot;%RB_TASK_FILE%&quot;</code>。</p>
          {[{ kind: 'task' as const }, ...flow.steps.slice(0, index).filter((item) => item.type === 'agent' || item.type === 'command').map((item) => ({ kind: 'step-output' as const, step: item.id }))].map((ref) => {
            const selected = (step.inputs ?? []).some((item) => JSON.stringify(item) === JSON.stringify(ref));
            const label = ref.kind === 'task' ? '任务描述 · RB_TASK_FILE' : `${flow.steps.find((item) => item.id === ref.step)?.title}的输出 · RB_STEP_${ref.step.toUpperCase().replace(/-/g, '_')}_OUTPUT_FILE`;
            return <label className="flow-input-option" key={JSON.stringify(ref)}><input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => update(index, { inputs: event.target.checked ? [...(step.inputs ?? []), ref] : (step.inputs ?? []).filter((item) => JSON.stringify(item) !== JSON.stringify(ref)) })} />{label}</label>;
          })}
          {flow.steps.slice(0, index).filter((item) => item.type === 'command').map((item) => {
            const ref = { kind: 'step-exit-code' as const, step: item.id };
            const selected = (step.inputs ?? []).some((input) => JSON.stringify(input) === JSON.stringify(ref));
            return <label className="flow-input-option" key={`${item.id}-exit`}><input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => update(index, { inputs: event.target.checked ? [...(step.inputs ?? []), ref] : (step.inputs ?? []).filter((input) => JSON.stringify(input) !== JSON.stringify(ref)) })} />{item.title}的退出码 · RB_STEP_{item.id.toUpperCase().replace(/-/g, '_')}_EXIT_CODE</label>;
          })}
          <label className="flow-full">工作区文件路径（每行一个，对应 RB_FILE_1、RB_FILE_2…）<textarea rows={2} value={(step.inputs ?? []).filter((item): item is { kind: 'file'; path: string } => item.kind === 'file').map((item) => item.path).join('\n')} disabled={disabled}
            onChange={(event) => update(index, { inputs: [...(step.inputs ?? []).filter((item) => item.kind !== 'file'), ...(event.target.value ? event.target.value.split('\n').map((file) => ({ kind: 'file' as const, path: file })) : [])] })} /></label>
        </div></>}
      {step.type === 'commit' && <label className="flow-full">提交说明<input value={step.message ?? ''} disabled={disabled} placeholder="例如 feat: complete task" onChange={(event) => update(index, { message: event.target.value })} /></label>}
      {step.type === 'approval' && <><label className="flow-full">确认说明<textarea rows={2} value={step.message ?? ''} disabled={disabled} onChange={(event) => update(index, { message: event.target.value })} /></label>
        <div className="flow-inputs"><strong>确认时展示</strong><p className="muted">勾选需要人工查看的内容，确认只绑定这些内容。</p>
          {[{ kind: 'task' as const }, ...flow.steps.slice(0, index).filter((item) => item.type === 'agent' || item.type === 'command').map((item) => ({ kind: 'step-output' as const, step: item.id }))].map((ref) => {
            const selected = (step.show ?? []).some((item) => JSON.stringify(item) === JSON.stringify(ref));
            const label = ref.kind === 'task' ? '任务描述' : `${flow.steps.find((item) => item.id === ref.step)?.title}的输出`;
            return <label className="flow-input-option" key={JSON.stringify(ref)}><input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => update(index, { show: event.target.checked ? [...(step.show ?? []), ref] : (step.show ?? []).filter((item) => JSON.stringify(item) !== JSON.stringify(ref)) })} />{label}</label>;
          })}
          {flow.steps.slice(0, index).filter((item) => item.type === 'command').map((item) => {
            const ref = { kind: 'step-exit-code' as const, step: item.id };
            const selected = (step.show ?? []).some((input) => JSON.stringify(input) === JSON.stringify(ref));
            return <label className="flow-input-option" key={`${item.id}-exit`}><input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => update(index, { show: event.target.checked ? [...(step.show ?? []), ref] : (step.show ?? []).filter((input) => JSON.stringify(input) !== JSON.stringify(ref)) })} />{item.title}的退出码</label>;
          })}
          <label className="flow-full">工作区文件路径（每行一个）<textarea rows={2} value={(step.show ?? []).filter((item): item is { kind: 'file'; path: string } => item.kind === 'file').map((item) => item.path).join('\n')} disabled={disabled}
            onChange={(event) => update(index, { show: [...(step.show ?? []).filter((item) => item.kind !== 'file'), ...(event.target.value ? event.target.value.split('\n').map((file) => ({ kind: 'file' as const, path: file })) : [])] })} /></label>
          {!step.show?.length && <p role="status">至少选择一项展示内容。</p>}
        </div></>}
    </section>)}
    <div className="flow-add"><button type="button" className="btn sm" disabled={disabled || flow.steps.length >= 20} onClick={() => add('agent')}>＋ Agent 步骤</button>
      <button type="button" className="btn sm" disabled={disabled || flow.steps.length >= 20} onClick={() => add('command')}>＋ 命令步骤</button>
      <button type="button" className="btn sm" disabled={disabled || flow.steps.length >= 20} onClick={() => add('approval')}>＋ 人工确认</button>
      {isGit && <button type="button" className="btn sm" disabled={disabled || flow.steps.length >= 20} onClick={() => add('commit')}>＋ Git 提交</button>}</div>
    {isGit && flow.git.mode === 'explicit-step' && <section className="flow-inputs"><strong>可选远端操作</strong>
      <p className="muted">默认关闭。启用后，最后一步必须是人工确认；确认时会显示提交、实际推送目标和所选操作。</p>
      <label className="flow-input-option"><input type="checkbox" disabled={disabled} checked={!!publish.push} onChange={(event) => updatePublish(event.target.checked ? { push: true } : { push: false, createPr: false, merge: false, tag: false })} />推送任务分支</label>
      <label className="flow-input-option"><input type="checkbox" disabled={disabled || !publish.push} checked={!!publish.createPr} onChange={(event) => updatePublish(event.target.checked ? { createPr: true } : { createPr: false, merge: false, tag: false })} />创建 GitHub PR</label>
      {publish.createPr && !publish.merge && <label className="flow-input-option"><input type="checkbox" disabled={disabled} checked={publish.draftPr ?? true} onChange={(event) => updatePublish({ draftPr: event.target.checked })} />创建为草稿 PR</label>}
      <label className="flow-input-option"><input type="checkbox" disabled={disabled || !publish.createPr} checked={!!publish.merge} onChange={(event) => updatePublish(event.target.checked ? { merge: true } : { merge: false, tag: false })} />压缩合并 PR 并删除分支</label>
      <label className="flow-input-option"><input type="checkbox" disabled={disabled || !publish.merge} checked={!!publish.tag} onChange={(event) => updatePublish({ tag: event.target.checked })} />为合并提交打标签</label>
      {publish.push && <label>远端名称<input disabled={disabled} value={publish.remote ?? 'origin'} onChange={(event) => updatePublish({ remote: event.target.value })} /></label>}
      {publish.createPr && <><label>PR 标题（留空使用任务标题）<input disabled={disabled} value={flow.git.release?.title ?? ''} onChange={(event) => updateRelease({ title: event.target.value })} /></label>
        <label className="flow-full">PR 内容（留空使用任务描述）<textarea disabled={disabled} rows={3} value={flow.git.release?.body ?? ''} onChange={(event) => updateRelease({ body: event.target.value })} /></label></>}
      {publish.tag && <><label>版本号<input disabled={disabled} value={flow.git.release?.version ?? ''} placeholder="例如 1.2.0" onChange={(event) => updateRelease({ version: event.target.value })} /></label>
        <label className="flow-full">发布说明<textarea disabled={disabled} rows={3} value={flow.git.release?.notes ?? ''} onChange={(event) => updateRelease({ notes: event.target.value })} /></label></>}
      {publish.push && !flow.steps.some((step) => step.type === 'commit') && <p role="status">请先添加 Git 提交步骤。</p>}
      {publish.push && flow.steps.at(-1)?.type !== 'approval' && <p role="status">请在流程最后添加一个人工确认步骤。</p>}
    </section>}
    <p className="muted flow-note">{flow.steps.some((step) => step.type === 'commit') ? '流程包含 Git 提交步骤。' : isGit ? '任务完成后，改动保留在独立工作区。' : '任务直接修改项目文件夹。'} 人工确认只绑定所展示的内容；Agent 对文件的审核不会锁定之后的工作区。</p>
  </div>;
}
