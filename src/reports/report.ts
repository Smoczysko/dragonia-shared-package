/**
 * What a scheduled service did, once.
 *
 * Every service in the fleet produces a rich account of its work and — before this existed —
 * printed it to a log and forgot it. The console could say whether a service was alive and whether
 * it was stale; it could not say what it had actually done, which is the question you have in the
 * morning.
 *
 * **A fixed envelope plus a service-defined blob.** The services share no vocabulary: vault counts
 * `read`/`inserted`/`updated`/`unmapped`, the pollers count `discovered`, the image consumer counts
 * files and bytes. Columns that fit all of them would fit none of them well, so the shape below is
 * only what every report genuinely has, and `counts` carries the rest.
 */
export type ReportStatus = 'success' | 'partial' | 'failed';

export interface ServiceReport {
  /**
   * Opaque to every consumer. A `string` so that a uuid and a sequence both fit — the services
   * behind this use different databases and different ORMs, and nothing here does arithmetic on it.
   */
  id: string;

  /**
   * *What* ran — `scryfall:all_cards`, `mtgjson:prices`, `poll`, `images`.
   *
   * One scheduled run can produce several of these. vault's nightly run downloads four files and
   * parses them on independent consumers; waiting for all of them before writing a single report
   * would mean coordinating across consumer groups to learn nothing extra. They are separate rows,
   * tied back together by `correlationId`.
   */
  task: string;

  /**
   * `partial` is not decoration. A run that isolates per-source failures genuinely ends with some
   * work done and some not — vault's does — and collapsing that into success or failure throws away
   * the only interesting part.
   */
  status: ReportStatus;

  /** ISO 8601. Strings rather than `Date`: this crosses JSON, and a `Date` here would be a lie. */
  startedAt: string;
  finishedAt: string;

  /**
   * Derived from the timestamps rather than stored beside them — two fields that can disagree about
   * the same fact eventually will. It is in the response because every consumer wants it and none
   * should have to compute it.
   */
  durationMs: number;

  /**
   * One human line, written by the service. **This is the load-bearing field.**
   *
   * Without it the console has to learn four services' vocabularies to render anything legible, and
   * gains a reason to change every time any of them adds a counter. With it the console renders a
   * string and stays ignorant. `counts` is there for when the string is not enough.
   *
   * Worth writing as though someone reads it at 8am: `542,264 cards: 23 new, 406 changed`.
   */
  summary: string;

  /**
   * The service's own numbers. Deliberately not a union of per-service shapes: the console renders
   * this generically, and a union would drag the whole fleet into a package release every time one
   * service counted something new.
   */
  counts: Record<string, number>;

  /** Groups the several reports produced by one scheduled run. vault's `runId`; absent elsewhere. */
  correlationId?: string;

  /** Present when `status` is not `success`, and the reason the row is worth looking at. */
  error?: string;
}

/**
 * One page of reports, newest first.
 *
 * `total` is here despite costing a `COUNT` per request, because the console paginates by page
 * number and cannot render "3 of 12" without it. At a few thousand narrow rows that count is free;
 * the alternative — a `hasMore` flag — would force an infinite-scroll UI to avoid a cost nobody is
 * paying.
 */
export interface ReportPage {
  page: number;
  pageSize: number;
  total: number;
  reports: ServiceReport[];
}
