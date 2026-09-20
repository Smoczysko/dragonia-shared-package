import { z } from 'zod';

/** The most rows one request may ask for, however hard it asks. */
export const MAX_PAGE_SIZE = 100;

/** What the grid shows without being told otherwise. */
export const DEFAULT_PAGE_SIZE = 10;

/**
 * `?page=&pageSize=` — the only part of this contract that is validated rather than merely typed.
 *
 * The response is a plain interface because the console only ever reads it. These two are different:
 * four services have to coerce, clamp and default the same two query parameters, and four
 * hand-written copies of that is how four services start disagreeing about what `?page=0` means.
 *
 * **Everything is permissive and clamped rather than rejected.** A page past the end is a fact
 * about an empty table, not a client error — it returns an empty array with an honest `total`, and
 * a grid that asked for page 9 of 3 should show nothing rather than a 400.
 */
export const ReportQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export type ReportQuery = z.infer<typeof ReportQuery>;

/**
 * Turn a validated query into the two numbers a database wants.
 *
 * Trivial, and shared anyway: an off-by-one in this arithmetic silently repeats or skips a row at
 * every page boundary, which is exactly the kind of bug that survives review in four places.
 */
export function toOffset(query: ReportQuery): {
  limit: number;
  offset: number;
} {
  return {
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  };
}
