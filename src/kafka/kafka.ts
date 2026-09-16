import { loadConfig } from '../config/index.js';
import type { EventTopic } from './topic.js';
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { z } from 'zod';

// No default broker address. A fallback like `localhost:9092` is the worst kind of config bug:
// deployed with the variable missing, the process starts happily and then fails to reach a broker
// that was never going to be there, and the error names a connection rather than the real cause.
// Required instead, so a missing value is one readable error at startup.
const ConfigSchema = z.object({
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .describe('Comma-separated broker list, e.g. "localhost:9092"'),

  // The one value the two copies of this library genuinely disagreed on: hardcoded 'multiverse' in
  // one, 'health-metrics' in the other. It identifies the client in broker logs and in
  // kafka_exporter, so a single shared constant would make every service in the fleet anonymous in
  // exactly the place you look when one of them misbehaves. Defaulted rather than required — an
  // unhelpful client id should not stop a service booting.
  KAFKA_CLIENT_ID: z.string().min(1).default('dragonia'),
});

let kafka: Kafka | undefined;

function client(): Kafka {
  if (!kafka) {
    // Resolved on first use rather than at import, so merely importing this lib can't throw —
    // but every entry point connects at boot, so in practice this still fails fast.
    const config = loadConfig(ConfigSchema);
    const brokers = config.KAFKA_BROKERS.split(',').map((b) => {
      return b.trim();
    });

    kafka = new Kafka({
      clientId: config.KAFKA_CLIENT_ID,
      brokers,
      logLevel: logLevel.ERROR,
    });
  }

  return kafka;
}

/**
 * How long a handler may take before Kafka assumes the consumer is dead and revokes its partitions.
 * Exported so a handler that might block — waiting out a rate limit, say — can compare against it
 * rather than guess.
 *
 * kafkajs defaults this to 5 minutes and it is not a soft limit: exceeding it evicts the consumer
 * from the group, and the eviction is silent from inside the handler. The process finishes its work,
 * tries to commit an offset for a partition it no longer owns, and stops consuming while remaining
 * perfectly healthy-looking — container up, no restarts, nothing in its own logs.
 *
 * It happened in both repos, which is a large part of why this library exists: a 14-minute
 * rate-limit sleep killed the Strava ingester two hours into a backfill (2026-09-01), and a
 * six-minute card parse did the same to vault-ingestion (2026-09-10). Raise `sessionTimeout` past it
 * deliberately — see `ConsumerOptions` — rather than hoping a handler stays under it.
 */
export const MAX_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A connected producer — reuse one per process; disconnect on shutdown. */
export async function createProducer(): Promise<Producer> {
  const producer = client().producer();

  await producer.connect();

  return producer;
}

/**
 * Commit settings belong to `consumer.run()`, not to `consumer()` — but the caller configures a
 * consumer in one place and runs it in another. This carries them across so `consume` can apply
 * them without every call site having to pass them twice.
 */
export const consumerCommitOptions = new WeakMap<
  Consumer,
  { autoCommitInterval?: number; autoCommitThreshold?: number }
>();

export interface ConsumerOptions {
  /**
   * How long the broker waits for a heartbeat before declaring this consumer dead.
   *
   * Raise it for a group whose handler does minutes of work per message. KafkaJS only heartbeats
   * *between* messages, so a handler that blocks for longer than this gets its consumer evicted
   * mid-work: the offset is never committed, the group rebalances, and the message is redelivered
   * to a handler that already finished it. That is not hypothetical — it crash-looped
   * vault-ingestion on 2026-09-10 after a wholly successful six-minute parse.
   */
  sessionTimeout?: number;
  /** Must exceed the longest a handler can run, or the rejoin itself times out. */
  rebalanceTimeout?: number;

  /**
   * Commit progress at least this often, in milliseconds.
   *
   * KafkaJS's default is to commit when a *batch* finishes. With small messages a batch is
   * thousands of records, so a consumer that processes them slowly commits almost never — and
   * everything between commits is redelivered on the next restart.
   *
   * Observed: vault-assets downloaded 100,788 images over four hours with `CURRENT-OFFSET` showing
   * `-` on all twelve partitions the whole time. A restart at any point would have re-fetched every
   * image already on disk. Set this for any consumer whose per-message work is slow enough that a
   * batch takes minutes.
   */
  autoCommitInterval?: number;

  /** Or commit every N messages, whichever comes first. */
  autoCommitThreshold?: number;
}

/**
 * A connected consumer in the given group — the caller subscribes and runs it.
 *
 * The defaults suit a handler that returns quickly. A parser that streams a 2.9 GB file does not:
 * see `ConsumerOptions`.
 */
export async function createConsumer(
  groupId: string,
  options: ConsumerOptions = {},
): Promise<Consumer> {
  const consumer = client().consumer({
    groupId,
    // Stated rather than inherited. The defaults are reasonable, but they are a contract every
    // handler has to respect, and a contract nobody can see is one that gets broken.
    maxInFlightRequests: 1,
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
    maxWaitTimeInMs: 5_000,
    ...(options.sessionTimeout === undefined
      ? {}
      : { sessionTimeout: options.sessionTimeout }),
    ...(options.rebalanceTimeout === undefined
      ? {}
      : { rebalanceTimeout: options.rebalanceTimeout }),
  });

  consumerCommitOptions.set(consumer, {
    ...(options.autoCommitInterval === undefined
      ? {}
      : { autoCommitInterval: options.autoCommitInterval }),
    ...(options.autoCommitThreshold === undefined
      ? {}
      : { autoCommitThreshold: options.autoCommitThreshold }),
  });

  await consumer.connect();

  return consumer;
}

/**
 * Create the topic if it doesn't already exist (idempotent — a no-op when it does). We create
 * topics explicitly rather than relying on broker auto-create, so partition counts are a decision
 * in code rather than whatever the broker defaults to.
 *
 * **Takes the declared topic, not a name and a count.** Those were two arguments in one of the two
 * copies this library was merged from, which meant a topic could declare 12 partitions and be
 * created with 1 — the declaration and the creation had no way to disagree loudly, and raising the
 * partition count on a live topic is the awkward direction. Taking the same object the producer
 * publishes through means they cannot drift.
 *
 * One partition is `defineTopic`'s default, because it keeps a single consumer strictly sequential.
 * Raise it only for a topic whose consumers are meant to scale out.
 */
export async function ensureTopic<T>(topic: EventTopic<T>): Promise<void> {
  const admin = client().admin();

  await admin.connect();

  try {
    const existing = await admin.listTopics();

    if (existing.includes(topic.name)) {
      return undefined;
    }

    await admin.createTopics({
      topics: [
        {
          topic: topic.name,
          numPartitions: topic.partitions,
          replicationFactor: 1,
        },
      ],
      waitForLeaders: true,
    });

    return undefined;
  } finally {
    await admin.disconnect();
  }
}
