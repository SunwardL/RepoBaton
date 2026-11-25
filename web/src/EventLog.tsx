import { useEffect, useRef } from 'react';
import type { RunEvent } from './api';
import { ERROR_HINT } from './common';

export function eventClass(e: RunEvent): string {
  if (e.type === 'agent.failed' || e.type === 'log.error') return 'bad';
  if (e.type === 'step.finished' && (e.data?.status === 'failed' || e.data?.status === 'unknown')) return 'bad';
  if (e.type === 'run.finished' && e.data?.status === 'succeeded') return 'ok';
  if (e.type === 'stage.started' || e.type === 'step.started') return 's';
  return '';
}

export function eventText(e: RunEvent): string {
  switch (e.type) {
    case 'agent.progress':
      return `    ${e.message}`;
    case 'agent.failed': {
      const kind = typeof e.data?.kind === 'string' ? ERROR_HINT[e.data.kind] ?? e.data.kind : '';
      return `✕ ${e.stage ?? ''} 失败${kind ? `(${kind})` : ''}:${e.message}`;
    }
    case 'stage.started':
    case 'step.started':
      return `── ${e.message}`;
    case 'run.started':
      return `开始:${e.message}`;
    case 'run.resumed':
      return `继续执行:${e.message}`;
    case 'run.interrupted':
      return `⚠ 已中断:${e.message}`;
    case 'run.finished':
      return `结束:${String(e.data?.status ?? '')}`;
    default:
      return e.message;
  }
}

/** Live progress. Follows new lines unless the user has scrolled up to read. */
export function EventLog({ events }: { events: RunEvent[] }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div
      className="log"
      ref={box}
      role="log"
      aria-live="polite"
      aria-label="实时进度"
      onScroll={(ev) => {
        const el = ev.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events.length === 0 ? <div className="t">还没有事件</div> : null}
      {events.map((e) => (
        <div key={e.seq} className={eventClass(e)}>
          <span className="t">{e.ts.slice(11, 19)}</span>
          {eventText(e)}
        </div>
      ))}
    </div>
  );
}
