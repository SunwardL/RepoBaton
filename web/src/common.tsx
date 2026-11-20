import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, type RunStatus } from './api';

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export const STATUS: Record<RunStatus, { label: string; cls: string }> = {
  running: { label: '执行中', cls: 'run' },
  'awaiting-plan-approval': { label: '待审批计划', cls: 'wait' },
  succeeded: { label: '已完成', cls: 'done' },
  'needs-human': { label: '需要人工', cls: 'wait' },
  failed: { label: '执行失败', cls: 'fail' },
  cancelled: { label: '已取消', cls: 'stop' },
  interrupted: { label: '已中断', cls: 'wait' },
};

export function Pill({ status, executing }: { status: RunStatus; executing?: boolean }): ReactNode {
  // A run the file calls "running" but nothing executes is shown honestly as waiting, not spinning.
  const s = STATUS[status];
  const live = status === 'running' && executing !== false;
  return (
    <span className={`pill ${live ? 'run' : status === 'running' ? 'wait' : s.cls}`}>
      <i />
      {status === 'running' && executing === false ? '无执行者' : s.label}
    </span>
  );
}

export const ERROR_HINT: Record<string, string> = {
  auth: '密钥缺失或被拒绝',
  'rate-limit': '触发限流',
  network: '网络不通',
  timeout: '请求超时',
  'not-found': '找不到命令、模型或地址',
  'bad-output': '模型返回的格式不对',
  cancelled: '已取消',
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Small transient message. */
export function useToast(): { node: ReactNode; show: (msg: string, kind?: 'ok' | 'err') => void } {
  const [t, setT] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = (msg: string, kind: 'ok' | 'err' = 'ok'): void => {
    setT({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setT(null), kind === 'err' ? 9000 : 3500);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { node: t ? <div className={`toast ${t.kind === 'err' ? 'err' : ''}`} role="status">{t.msg}</div> : null, show };
}

/** Run `fn` now and every `ms` until unmounted. Errors surface through onError. */
export function usePoll(fn: () => Promise<void>, ms: number, deps: unknown[]): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        await ref.current();
      } catch {
        /* the caller decides what an error means; polling just carries on */
      }
      if (!stop) timer = window.setTimeout(tick, ms);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function Banner({ kind, title, children, actions }: { kind: 'warn' | 'err' | 'info'; title: string; children?: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <div className={`banner ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <div>
        <b>{title}</b>
        {children}
      </div>
      {actions ? <div className="acts">{actions}</div> : null}
    </div>
  );
}
