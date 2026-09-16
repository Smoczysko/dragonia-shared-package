import { createLogger } from '../observability/index.js';
import type { Consumer, Producer } from 'kafkajs';
import { consumerCommitOptions } from './kafka.js';
import type { z } from 'zod';

const log = createLogger('shared.kafka');

/**
 * Thrown by a handler that cannot do its work *yet* and knows roughly how long to wait.
 *
 * Without this, "defer to the queue" means throwing — and throwing means kafkajs redelivers as fast
 * as it can. On 2026-09-01 the Strava ingester deferred 20 activities against a rate limit and then
 * took **232 real 429s in half an hour**, because every redelivery spent another request on the
 * limit that was already exhausted, which kept it exhausted. It reported `waitMs` on every single
 * one and waited none of them.
 *
 * So the wait has to be enforced by the thing that controls redelivery, not requested politely by
 * the thing that cannot enforce it. `consume` pauses the partition for `retryAfterMs` and only then
 * lets the message come round again.
 *
 * This is one of two rate-limiting patterns in the fleet, and they are not rivals: vault spaces
 * *outbound* requests inside its Scryfall client, because it knows the limit ahead of time and
 * nothing tells it to back off. Use this one when the limit is discovered from a response — a 429
 * with a `Retry-After` — and the work has to go back on the queue.
 */
export class RetryAfter extends Error {
  constructor(
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = 'RetryAfter';
  }
}

/**
 * Ceiling on a pause. Long enough for a 15-minute API window, short enough that a bad
 * `retryAfterMs` cannot park a partition indefinitely.
 */
const MAX_PAUSE_MS = 16 * 60 * 1000;

/**
 * A topic and everything needed to use it safely: its name, the shape of its payload, how to
 * derive a partition key, and how many partitions it gets.
 *
 * Keeping these together is what makes `publish` and `consume` below type-safe in both
 * directions — the producer can't send the wrong shape and the consumer doesn't have to guess
 * what it received.
 */
export interface EventTopic<T> {
  name: string;
  schema: z.ZodType<T>;
  /**
   * Partition key for a payload. Kafka guarantees order *within* a partition, so the key decides
   * what stays ordered relative to what: same key → same partition → sequential.
   */
  key: (payload: T) => string;
  partitions: number;
}

/**
 * Declare a topic. `partitions` defaults to 1, which keeps a single consumer strictly sequential;
 * raise it only where consumers are meant to scale out.
 */
export function defineTopic<T>(spec: {
  name: string;
  schema: z.ZodType<T>;
  key: (payload: T) => string;
  partitions?: number;
}): EventTopic<T> {
  return {
    name: spec.name,
    schema: spec.schema,
    key: spec.key,
    partitions: spec.partitions ?? 1,
  };
}

/**
 * Publish one payload. Validated on the way out as well as on the way in — a producer bug is
 * cheaper to find here than in the subscriber three services downstream.
 */
export async function publish<T>(
  producer: Producer,
  topic: EventTopic<T>,
  payload: T,
): Promise<void> {
  const parsed = topic.schema.parse(payload);

  await producer.send({
    topic: topic.name,
    messages: [{ key: topic.key(parsed), value: JSON.stringify(parsed) }],
  });

  return undefined;
}

export interface ConsumeOptions {
  /** Raise only for a partitioned topic whose handler is safe to run concurrently. */
  concurrency?: number;
  fromBeginning?: boolean;
}

/**
 * Subscribe to a topic and run a handler over it, decoding and **validating** every message
 * against the topic's schema first.
 *
 * The alternative — `JSON.parse(...) as Payload` — is an unchecked cast: a message whose shape
 * drifted still type-checks and fails somewhere deep in the handler, halfway through a COPY or a
 * diff-apply. Validating at the boundary turns that into one readable error naming the field.
 *
 * Not instrumented by hand: kafkajs produce/consume spans come from the auto-instrumentation in
 * `@dragonia/shared/observability`, and consumer-group lag is already scraped from
 * `kafka_exporter` on apps01. Adding either here would double-report.
 */
export async function consume<T>(
  consumer: Consumer,
  topic: EventTopic<T>,
  handler: (payload: T) => Promise<void>,
  options: ConsumeOptions = {},
): Promise<void> {
  const { concurrency = 1, fromBeginning = true } = options;

  await consumer.subscribe({ topic: topic.name, fromBeginning });

  await consumer.run({
    partitionsConsumedConcurrently: concurrency,
    // Whatever `createConsumer` was told about commit cadence. Defaults stay KafkaJS's when unset.
    ...consumerCommitOptions.get(consumer),
    eachMessage: async ({ message, partition, pause }) => {
      if (!message.value) {
        log.warn(
          { event: 'kafka.message.empty', topic: topic.name, partition },
          'empty message',
        );

        return undefined;
      }

      const result = topic.schema.safeParse(
        JSON.parse(message.value.toString()),
      );

      if (!result.success) {
        // Throwing here would stall the partition on a message that can never succeed, so the
        // bad one is logged in full and skipped; the topic keeps moving.
        log.error(
          {
            event: 'kafka.message.invalid',
            topic: topic.name,
            partition,
            offset: message.offset,
            issues: result.error.issues,
          },
          `invalid payload on ${topic.name} — skipped`,
        );

        return undefined;
      }

      try {
        await handler(result.data);
      } catch (err) {
        // Rethrown either way: the offset must not be committed for work that did not happen. The
        // pause is what makes the difference between deferring and busy-looping — it stops this
        // partition being redelivered until the handler's own deadline has passed.
        if (err instanceof RetryAfter) {
          const waitMs = Math.min(Math.max(err.retryAfterMs, 0), MAX_PAUSE_MS);
          const resume = pause();

          log.warn(
            {
              event: 'kafka.partition.paused',
              topic: topic.name,
              partition,
              waitMs,
            },
            `pausing ${topic.name} p${partition} for ${Math.ceil(waitMs / 1000)}s — ${err.message}`,
          );

          setTimeout(() => {
            log.info(
              {
                event: 'kafka.partition.resumed',
                topic: topic.name,
                partition,
              },
              `resuming ${topic.name} p${partition}`,
            );
            resume();
          }, waitMs);
        }

        throw err;
      }

      return undefined;
    },
  });

  return undefined;
}
