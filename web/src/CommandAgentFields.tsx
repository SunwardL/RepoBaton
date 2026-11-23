import type { CommandOptions } from './api';

export function CommandAgentFields({ value, onChange, disabled }: {
  value: Partial<CommandOptions>;
  onChange: (patch: Partial<CommandOptions>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="global-agent-fields">
      <label>可执行文件
        <input required value={value.command ?? ''} disabled={disabled} placeholder="例如 node.exe 或完整路径"
          onChange={(event) => onChange({ command: event.target.value })} />
      </label>
      <label>提示词传递
        <select value={value.promptVia ?? 'stdin'} disabled={disabled}
          onChange={(event) => onChange({ promptVia: event.target.value as CommandOptions['promptVia'] })}>
          <option value="stdin">标准输入</option>
          <option value="arg">最后一个参数</option>
        </select>
      </label>
      <label className="command-arguments">命令参数
        <textarea rows={3} value={value.args?.join('\n') ?? ''} disabled={disabled} placeholder="每行一个参数，无需加引号"
          onChange={(event) => onChange({ args: event.target.value ? event.target.value.split('\n') : [] })} />
      </label>
    </div>
  );
}
