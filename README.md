# @dragonia/shared

The paved-road foundation every Dragonia service imports: validated config, observability, and
typed Kafka. Published to the private Verdaccio on ci01.

```bash
npm i @dragonia/shared
```

Consumers need the scope mapped, in their own `.npmrc`:

```
@dragonia:registry=http://192.168.1.42:4873
```

**Scope only — never a global `registry=`.** Routing all of npm through Verdaccio for the proxy
caching is tempting and would make this container a build-time dependency for every repo in the
homelab, vault images included. Scoped-only bounds an outage to these packages.

## Subpaths

There is no root entry point, on purpose: importing `/config` should not pull the OpenTelemetry SDK
into the module graph.

```ts
import { loadConfig }         from '@dragonia/shared/config';
import { initObservability }  from '@dragonia/shared/observability';
import { createConsumer }     from '@dragonia/shared/kafka';
import type { ServiceReport } from '@dragonia/shared/reports';
```

Plus the preload entry, which is the only module here with a side effect on import:

```bash
node --import @dragonia/shared/observability/tracing dist/main.js
```

## `/reports` is a contract, not an implementation

Unlike the other three subpaths, `/reports` ships almost no code — a `ReportQuery` schema and an
offset helper, and otherwise types. That is the whole point.

Every scheduled service keeps its own table of what it did and serves it at `GET /reports`; the
console renders whichever ones declare it. The services cannot share a write path — vault uses
postgres.js and node-pg-migrate, health-metrics uses Prisma — so what they share is the shape the
console reads.

```ts
interface ServiceReport {
  id: string;
  task: string;                    // 'scryfall:all_cards' | 'poll' | 'images'
  status: 'success' | 'partial' | 'failed';
  startedAt: string;               // ISO 8601
  finishedAt: string;
  durationMs: number;
  summary: string;                 // the human line the console renders
  counts: Record<string, number>;  // the service's own vocabulary
  correlationId?: string;          // groups one run's several reports
  error?: string;
}
```

**`summary` is load-bearing.** Without it the console must learn every service's counters to render
a legible row, and gains a reason to change whenever any of them adds one. With it the console
renders a string. `counts` exists for when the string is not enough.

**The query is validated, the response is only typed.** The console only reads the response, so an
interface is enough. But every reporting service has to coerce, clamp and default the same two
parameters, and a hand-written copy per service is how they start disagreeing about what `?skip=-1`
means.

`?skip=&take=` rather than page numbers — GraphQL's convention, and Prisma's, so the query
parameter, the store method and the database call all say the same word. The console still renders
page numbers; `total` is what lets it.

**Everything is clamped, never rejected.** A negative `skip` is the start, an oversized `take` is
the maximum, a non-integer is the default, and a `skip` past the end is an empty array with an
honest `total` — never a 400. That is enforced with `transform`: `min`/`max` *reject*, and an
earlier version of this schema did exactly that, answering 500 while its own comment promised
clamping.

## Why one package and not three

`kafka` imports exactly two things from its siblings — `loadConfig` for `KAFKA_BROKERS`, and
`createLogger` for three log lines — and all three were always going to be versioned in lockstep.
Three packages that always share a version, always publish together and are always installed
together are one package with extra bookkeeping.

The cost: a service using only `/config` still installs `kafkajs`. Every service today uses all
three; if a Kafka-less one appears, `kafkajs` becomes an optional peer dependency.

## Where this came from

These libraries lived twice — in `multiverse` and copied into `health-metrics` on 2026-08-30,
because nothing published them anywhere. That copy was deliberate, taken so the shared interface
could be designed against **two real consumers rather than one**.

Two weeks later the diff proved the point better than the argument did:

- `config` was **byte-identical**. `observability` differed only in a scope string and two Prettier
  line-wraps — the freshness metric names, the thing most at risk, had not drifted at all.
- `kafka` had diverged substantially, **and each copy was ahead of the other**. Two repos, two
  different production incidents, two fixes that never met.

This package is the merge, so both fixes exist in one place:

| from | what | why it exists |
| --- | --- | --- |
| health-metrics | `RetryAfter` + partition pause | the Strava ingester took **232 real 429s in half an hour**, because throwing meant redelivering as fast as kafkajs could |
| health-metrics | `ensureTopic(topic)` takes the declared topic | as `(name, count)` a topic could declare 12 partitions and be created with 1 |
| multiverse | `ConsumerOptions.sessionTimeout` / `rebalanceTimeout` | a six-minute parse got its consumer evicted mid-work, then redelivered a message it had already finished |
| multiverse | `ConsumerOptions.autoCommitInterval` / `autoCommitThreshold` | 100,788 images downloaded over four hours with **no offset ever committed** |

**Two rate-limiting patterns, deliberately both.** `RetryAfter` is for a limit discovered from a
response — a 429 with `Retry-After` — where the work goes back on the queue. Vault instead spaces
outbound requests inside its client, because it knows the limit ahead of time and nothing tells it
to back off. They solve different problems and neither replaces the other.

## Versioning

The version is committed in `package.json` and bumped by hand. The publish workflow **fails** if
that version already exists on the registry.

That is deliberate, and it is the opposite of how `othot-schema` publishes — that one derives the
next version from the registry because its branch is protected against the bot, which is not a
constraint here. The reason to keep the manual bump: `service_last_success_timestamp_seconds` and
`service_freshness_tolerance_seconds` are consumed by one alert rule and one console for the whole
fleet. Semver is the only channel for announcing that they changed, and auto-bumping minor on every
push makes a comment fix and a fleet-breaking rename look identical.

**Nothing upgrades automatically.** Publishing changes no consumer until that repo runs
`npm i @dragonia/shared@<version>` — which is correct: a fleet-wide automatic bump of the freshness
contract is precisely the event worth being deliberate about.

## What varies between consumers

Almost nothing, which is what made this worth extracting. One value: `KAFKA_CLIENT_ID`, which
identifies the service in broker logs and `kafka_exporter`. It was a hardcoded constant in both
copies and is now config, defaulting to `dragonia`.
