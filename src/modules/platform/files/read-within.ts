/**
 * How long one storage read may take before its photograph is given up.
 *
 * The S3 client has no deadline of its own, so a MinIO that keeps the
 * connection open and sends nothing holds whoever awaits the read for as long
 * as it pleases. Every reader that sits on a SHARED queue reads through this:
 * the client pushes' one sweep (round C review, PA-2), the price channel's
 * drain, and the cabinet's 📷, which runs on that chat's answer chain — a
 * stalled read there used to hold the customer's «📦», «💰», «🧾» behind it
 * (Q5-1). One home (#513), in platform so the bot reaches it without
 * importing wms — and its own file, so a test that stands in for the storage
 * module does not stand in for the deadline too.
 */
export const PHOTO_READ_MS = 15_000;

export class ReadTimeout extends Error {}

/** A storage read bounded by a deadline; a late answer is simply dropped. */
export function readWithin(read: Promise<Buffer>, ms: number): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeout(`storage read took longer than ${ms} ms`)), ms);
  });
  // The read itself cannot be cancelled; its late answer is simply dropped.
  read.catch(() => undefined);
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}
