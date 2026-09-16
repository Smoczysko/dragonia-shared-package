import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { declareFreshness, recordSuccess, type Duration } from './freshness.js';
import { createLogger } from './logger.js';
import { startMetricsServer } from './metrics.js';
import { isExportingTraces, stopTracing } from './tracing.js';

export interface ObservabilityOptions {
  /** Identifies this process everywhere: the `app` metric label, the log `component`, the trace resource. */
  service: string;
  /** Port for this process's `/metrics`. Must be unique on the host — see the port map in the README. */
  metricsPort: number;
  /**
   * How long this service may go without completing real work before it's stale — `'26h'` for a
   * nightly pipeline, `'3h'` for an hourly poll. Declared here so one alert rule covers every
   * service; see `freshness.ts`.
   *
   * **Omit it for event-driven services.** A consumer that legitimately has nothing to do for days
   * is not stale, and declaring a tolerance for it manufactures false alarms — its health signal is
   * consumer lag. Omitting publishes no freshness series at all, which is the honest answer.
   */
  freshness?: Duration;
}

export interface Observability {
  log: Logger;
  /**
   * Record that this service just did its job. Call from the path that completes real work and
   * nowhere else — never at boot, or a crash-looping service looks permanently fresh.
   *
   * Pass a date to seed from durable state at startup (the newest row written, the last run
   * record), so a deploy doesn't read as "never succeeded" until the next scheduled run.
   */
  recordSuccess: (at?: Date) => void;
  /** Stop the metrics server and flush pending spans. Call from the app's shutdown path. */
  shutdown: () => Promise<void>;
}

/**
 * Wire one process for observability — the single call every app makes at boot, so all of them are
 * instrumented identically.
 *
 * This does **not** start tracing: instrumentations have to patch modules before the app imports
 * them, so tracing is started by the preload entry (`node --import
 * @dragonia/shared/observability/tracing`) long before this runs. What's left at boot is the
 * metrics endpoint and the process-wide logger.
 */
export function initObservability({
  service,
  metricsPort,
  freshness,
}: ObservabilityOptions): Observability {
  const log = createLogger(service);
  const server: Server = startMetricsServer(service, metricsPort);

  if (freshness !== undefined) {
    declareFreshness(freshness);
  }

  /** Resolves once the metrics server has either bound or failed to — never rejects. */
  const settled = new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();

      return undefined;
    }

    server.once('listening', () => {
      resolve();
    });
    server.once('error', () => {
      resolve();
    });

    return undefined;
  });

  log.info(
    {
      event: 'observability.ready',
      service,
      metricsPort,
      freshness: freshness ?? 'event-driven',
      exportingTraces: isExportingTraces(),
    },
    `observability ready for ${service}`,
  );

  return {
    log,
    recordSuccess,
    shutdown: async () => {
      // `listen` is asynchronous, so a process that fails during boot can reach shutdown while the
      // metrics server is still binding. Closing it then is a no-op that reports
      // ERR_SERVER_NOT_RUNNING *and* leaves the bind to complete afterwards — the socket stays
      // open and the process never exits. So wait for the bind to settle first, either way.
      await settled;

      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();

          return undefined;
        }

        server.close((err) => {
          if (err) {
            reject(err);

            return undefined;
          }

          resolve();

          return undefined;
        });
      });

      await stopTracing();

      return undefined;
    },
  };
}
