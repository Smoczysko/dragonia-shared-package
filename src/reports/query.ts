import { z } from 'zod';

/** The most rows one request may take, however many it asks for. */
export const MAX_TAKE = 100;

/** What the grid takes without being told otherwise. */
export const DEFAULT_TAKE = 10;

/**
 * `?skip=&take=` — the only part of this contract that is validated rather than merely typed.
 *
 * The response is a plain interface because the console only ever reads it. These two are
 * different: every reporting service has to coerce, clamp and default the same two parameters, and
 * a hand-written copy per service is how they start disagreeing about what `?skip=-1` means.
 *
 * **Offsets rather than page numbers**, matching GraphQL's convention and — usefully — Prisma's
 * own `skip`/`take`, so the query parameter, the store method and the database call all say the
 * same word. The console still renders page numbers; `total` is what lets it.
 *
 * **Everything is clamped, never rejected**, and that is enforced rather than merely intended:
 * `min`/`max` *reject*, so an earlier version of this schema threw on out-of-range input and the
 * route answered 500 while this comment claimed the opposite. `transform` is what actually clamps.
 *
 * Nothing a caller can put in these two is an error. A negative `skip` means the start, an
 * oversized `take` means the maximum, and anything that is not a whole number — `banana`, `2.7`,
 * absent — means the default. A grid asking for something silly should show rows rather than a
 * stack trace, and a `skip` past the end is a fact about an empty table: an empty array with an
 * honest `total`.
 */
export const ReportQuery = z.object({
  skip: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    .transform((skip) => {
      return skip === undefined || skip < 0 ? 0 : skip;
    }),

  take: z.coerce
    .number()
    .int()
    .optional()
    .catch(undefined)
    .transform((take) => {
      if (take === undefined) {
        return DEFAULT_TAKE;
      }

      return Math.min(Math.max(take, 1), MAX_TAKE);
    }),
});

export type ReportQuery = z.infer<typeof ReportQuery>;
