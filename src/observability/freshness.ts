import { Gauge } from 'prom-client';
import { createLogger } from './logger.js';
import { registry } from './metrics.js';

const log = createLogger('shared.observability');

/**
 * The freshness gauges, created **lazily** by `declareFreshness` rather than at module load.
 *
 * prom-client initialises an unlabeled gauge to 0 the moment it is registered, so registering at
 * import time made every service that merely *imports* this lib export
 * `service_freshness_tolerance_seconds 0` — which a rule reads as "tolerance zero", i.e. always
 * stale. Event-driven services would have alerted constantly. Observed live on
 * strava-ingester/form-recompute after the first deploy.
 *
 * A service that never declares freshness now exports neither series, which is the honest signal:
 * it has no cadence to be late against.
 */
let gauges: { lastSuccess: Gauge; tolerance: Gauge } | undefined;

function ensureGauges(): { lastSuccess: Gauge; tolerance: Gauge } {
  if (!gauges) {
    gauges = {
      /**
       * When this service last completed a unit of real work.
       *
       * The name is deliberately **not** project-prefixed. Every other metric here is (`vault_*`),
       * but this one is a cross-service contract: one shared name means one alert rule covers every
       * service that will ever exist. The `app` label is already stamped by `startMetricsServer`.
       *
       * **`0` means "no success recorded"** — never, or not since this process started. That is a
       * real state worth alerting on separately from "stale", and it is why the gauge is never
       * seeded from process start time: a crash-looping service would then look permanently fresh.
       */
      lastSuccess: new Gauge({
        name: 'service_last_success_timestamp_seconds',
        help: 'Unix time when this service last completed a unit of real work; 0 = none recorded',
        registers: [registry],
      }),
      /**
       * How long this service may go without a success. Exported by the service rather than
       * configured in the alert rules, so one rule works for every cadence:
       *
       * ```promql
       * time() - service_last_success_timestamp_seconds
       *   > on(app) group_left() service_freshness_tolerance_seconds
       * ```
       */
      tolerance: new Gauge({
        name: 'service_freshness_tolerance_seconds',
        help: 'Seconds this service may go without a success before it is considered stale',
        registers: [registry],
      }),
    };
  }

  return gauges;
}

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `'26h'` / `'90m'` / `'45s'` / `'2d'`, or a plain number of seconds. */
export type Duration = number | string;

export function toSeconds(value: Duration): number {
  if (typeof value === 'number') {
    return value;
  }

  const m = value.trim().match(/^(\d+(?:\.\d+)?)([smhd])$/);

  if (!m) {
    throw new Error(
      `Invalid duration "${value}" — expected a number of seconds or e.g. "26h"`,
    );
  }

  return Number(m[1]) * UNITS[m[2]];
}

/**
 * Declare how fresh this service is expected to stay. Called once at boot by
 * `initObservability`; also initializes the success gauge to 0 so the series exists from the
 * first scrape — a service that has never succeeded must be visible, not absent.
 */
export function declareFreshness(within: Duration): void {
  const g = ensureGauges();

  g.tolerance.set(toSeconds(within));
  g.lastSuccess.set(0);

  return undefined;
}

/**
 * Record that this service just did its job. Call it from the path that completes real work —
 * one ingest run, one poll that fetched, one batch applied — and nowhere else.
 *
 * Pass `at` to seed from durable state at boot: a service that can prove when it last succeeded
 * (the newest row it wrote, its last run record) should say so on startup, otherwise every deploy
 * looks like "never succeeded" until the next scheduled run. A service with no such state simply
 * doesn't call this until it genuinely succeeds.
 */
export function recordSuccess(at: Date = new Date()): void {
  if (!gauges) {
    log.warn(
      { event: 'freshness.undeclared' },
      'recordSuccess() before declareFreshness() — ignored; declare a tolerance to publish freshness',
    );

    return undefined;
  }

  gauges.lastSuccess.set(Math.floor(at.getTime() / 1000));

  return undefined;
}

/** Seconds since the last recorded success, or `null` when none has been recorded. */
export async function secondsSinceSuccess(): Promise<number | null> {
  if (!gauges) {
    return null;
  }

  const metric = await gauges.lastSuccess.get();
  const value = metric.values[0]?.value ?? 0;

  if (value === 0) {
    return null;
  }

  return Math.floor(Date.now() / 1000) - value;
}

/** Log the freshness state — useful on shutdown and in the health skill's evidence. */
export async function logFreshness(): Promise<void> {
  const since = await secondsSinceSuccess();

  log.info(
    { event: 'freshness.state', secondsSinceSuccess: since },
    'freshness',
  );

  return undefined;
}
