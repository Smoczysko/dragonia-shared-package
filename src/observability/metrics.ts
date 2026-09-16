import http from 'node:http';
import { collectDefaultMetrics, Registry } from 'prom-client';
import { logger } from './logger.js';

// One process-wide Prometheus registry. Domain instruments (counters/gauges/histograms) are defined
// where they're used and registered here via `{ registers: [registry] }`. Default Node/process metrics
// (event-loop lag, heap, GC, fds) are collected automatically — the baseline health signal.
export const registry = new Registry();

collectDefaultMetrics({ register: registry });

/**
 * Expose `GET /metrics` on a dedicated port. Prometheus on obs01 is **pull**-based, so every process —
 * the HTTP-less Kafka subscribers included — has to serve this port for its metrics to exist at all.
 * `service` is stamped as a default label on every metric, so one scrape job can tell the apps apart
 * (app="vault-ingestion", …); see the port map in the lib README.
 */
export function startMetricsServer(service: string, port: number): http.Server {
  registry.setDefaultLabels({ app: service });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.setHeader('Content-Type', registry.contentType);
          res.end(body);
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'failed to render metrics');
          res.statusCode = 500;
          res.end();
        });

      return undefined;
    }

    res.statusCode = 404;
    res.end();
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(
      { event: 'metrics.start', service, port },
      `metrics on :${port}/metrics`,
    );
  });

  return server;
}
