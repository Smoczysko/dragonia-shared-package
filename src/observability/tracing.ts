import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * Spans go nowhere, quietly. Used when no OTLP endpoint is configured: the tracer provider is still
 * registered, so every span gets a real trace/span id and the logger can correlate lines in Loki —
 * we just don't ship them anywhere. The homelab has no trace backend yet (Prometheus + Loki + Grafana,
 * no Tempo), so this is the default path; standing Tempo up is a one-env-var change here, not an
 * app-code change anywhere.
 */
class NoopSpanProcessor implements tracing.SpanProcessor {
  onStart(): void {
    // nothing to record
    return undefined;
  }

  onEnd(): void {
    // nothing to export
    return undefined;
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function otlpEndpoint(): string | undefined {
  return (
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    undefined
  );
}

function spanProcessor(): tracing.SpanProcessor {
  if (!otlpEndpoint()) {
    return new NoopSpanProcessor();
  }

  // The exporter reads the standard OTEL_EXPORTER_OTLP_* env vars itself (endpoint, headers,
  // timeout), so the deploy configures it the same way any other OTel process is configured.
  return new tracing.BatchSpanProcessor(new OTLPTraceExporter());
}

let sdk: NodeSDK | undefined;

/**
 * Start tracing. Call this **before the app imports anything it wants instrumented** — the
 * instrumentations work by patching modules at load time, which is why the preload entry
 * (`@dragonia/shared/observability/tracing`) exists and why apps run with `--import`.
 *
 * Reads its config straight from the environment rather than `@dragonia/shared/config`: this runs
 * as a preload, before the app has had a chance to declare its config schema.
 */
export function startTracing(): void {
  if (sdk) {
    return undefined;
  }

  const service = process.env['OTEL_SERVICE_NAME'] ?? 'multiverse-unknown';

  // Traces are the *only* signal OTLP carries here. Left alone, NodeSDK would also spin up OTLP push
  // exporters for metrics and logs the moment an endpoint exists — but metrics are Prometheus **pull**
  // (obs01 scrapes `/metrics`, see metrics.ts) and logs reach Loki as container stdout via Alloy. Both
  // would be duplicate reporting into a backend that doesn't want them. Set as a default, so a deploy
  // that genuinely wants OTLP metrics later can still override it.
  process.env['OTEL_METRICS_EXPORTER'] ??= 'none';
  process.env['OTEL_LOGS_EXPORTER'] ??= 'none';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: service,
      [ATTR_SERVICE_VERSION]: process.env['OTEL_SERVICE_VERSION'] ?? '0.0.0',
    }),
    spanProcessors: [spanProcessor()],
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(), // global fetch — the Scryfall client
      new NestInstrumentation(),
      new KafkaJsInstrumentation(), // produce/consume spans, context propagated in headers
    ],
  });

  sdk.start();

  return undefined;
}

/** Flush and stop the tracer. Wire into the app's shutdown so in-flight spans aren't dropped. */
export async function stopTracing(): Promise<void> {
  if (!sdk) {
    return undefined;
  }

  await sdk.shutdown();
  sdk = undefined;

  return undefined;
}

/** True when spans are actually being exported — i.e. a trace backend is configured. */
export function isExportingTraces(): boolean {
  return otlpEndpoint() !== undefined;
}
