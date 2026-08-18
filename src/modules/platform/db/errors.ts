/**
 * Postgres error codes this application actually decides on.
 *
 * `23505` is a unique violation, and it reaches a person more often than
 * anything else here: two people typing the same client code at once, an
 * owner adding «Narx» to a list that already holds «narx» (the indexes are on
 * `lower(label)`, which is exactly why the two look the same to him), an
 * admin renaming a custom field onto a name another field holds. Every one of
 * those is a sentence — «this name is taken» — and every one of them used to
 * be the error page, because the write path never caught it and the action
 * above rethrew (#472's rule, stated and then not applied to the
 * dictionaries).
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}
