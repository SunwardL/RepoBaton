import type { EventSink } from './events.ts';
import type { Logger } from './log.ts';

/**
 * Forwards every human-readable log line to the run's event stream as well, so
 * a reader of events.jsonl sees the same story as the terminal.
 * Fine-grained agent progress is emitted separately (agent.progress), so
 * detail() deliberately does not become an event.
 */
export function teeLogger(base: Logger, sink: EventSink): Logger {
  return {
    info(msg) {
      base.info(msg);
      sink.emit('log.info', msg);
    },
    warn(msg) {
      base.warn(msg);
      sink.emit('log.warn', msg);
    },
    error(msg) {
      base.error(msg);
      sink.emit('log.error', msg);
    },
    stage(stage, msg) {
      base.stage(stage, msg);
      sink.emit('log.info', msg, { stage });
    },
    detail(msg) {
      base.detail(msg);
    },
  };
}
