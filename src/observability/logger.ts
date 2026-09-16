import { isSpanContextValid, trace } from '@opentelemetry/api';
import pino, { type Logger } from 'pino';
import pretty from 'pino-pretty';

// One process-wide logger. Structured JSON by default — the shape Alloy ships straight into Loki off
// the container's stdout, so every line is queryable telemetry with no log client in the app. In an
// interactive terminal (dev) we pretty-print for readability; NODE_ENV=production (or a non-TTY pipe)
// forces raw JSON.
//
// pino-pretty is attached as a *stream* rather than a worker transport — that keeps it working under
// tsx/esbuild, which the worker-thread transport doesn't reliably do.
const usePretty =
  process.env['NODE_ENV'] !== 'production' && process.stdout.isTTY;

/**
 * Stamp every line with the active trace/span, so a log in Loki and a span in the trace backend are
 * the same story told twice. Returns nothing when no span is active, or when tracing was never
 * started — the no-op tracer hands back an all-zero (invalid) span context, which is noise, not data.
 */
function traceContext(): Record<string, string> {
  const span = trace.getActiveSpan();

  if (!span) {
    return {};
  }

  const ctx = span.spanContext();

  if (!isSpanContextValid(ctx)) {
    return {};
  }

  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

export const logger: Logger = pino(
  {
    level: process.env['LOG_LEVEL'] ?? 'info',
    mixin: traceContext,
  },
  usePretty
    ? pretty({
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      })
    : process.stdout,
);

/** A child logger tagged with a component name (and optional fixed fields) — use one per app/module. */
export function createLogger(
  component: string,
  bindings: Record<string, unknown> = {},
): Logger {
  return logger.child({ component, ...bindings });
}

export type { Logger };
