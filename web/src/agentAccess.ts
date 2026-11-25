/** Describe what the adapter asks for; custom CLI arguments can change CLI behavior. */
export function accessDescription(type?: string, access?: string): string {
  if (type === 'command') return '外部命令不受 RepoBaton 的只读限制，可能修改文件或执行其他操作。';
  if (access !== 'read-only') return '该步骤允许修改工作区。';
  if (type === 'codex-cli') return '请求 Codex 的 read-only 沙箱；额外启动参数和 CLI 配置可能影响实际行为。';
  if (type === 'claude-cli') return '限制 Claude Code 可用工具；工具列表由 Agent 配置决定，额外参数可能影响实际行为。';
  if (type === 'openai-compatible' || type === 'anthropic-compatible') return 'RepoBaton 仅向此 API Agent 提供读取类工具。';
  return '请求只读；当前记录不足以确认 Agent 的限制方式。';
}
