import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

const tracer = trace.getTracer('@dragonia/shared/observability');

/**
 * Run `fn` inside a span, recording the error and marking the span failed if it throws.
 *
 * The auto-instrumentations cover HTTP, fetch, Nest and Kafka, but **not the database**: vault talks
 * to Postgres through `postgres.js`, which has no OpenTelemetry instrumentation (the official `pg`
 * one patches node-postgres, a different driver). So DB spans — and any other work worth a span, like
 * a COPY into staging or a diff-apply pass — are created by hand with this.
 *
 * @example
 *   await withSpan('vault.cards.diff-apply', () => applyDiff(rows), { 'vault.rows': rows.length });
 */
export function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Attributes = {},
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });

      throw err;
    } finally {
      span.end();
    }
  });
}
