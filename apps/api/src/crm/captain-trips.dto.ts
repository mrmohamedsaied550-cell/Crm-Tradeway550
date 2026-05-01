import { z } from 'zod';

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'must be an ISO 8601 datetime',
});

/**
 * P2-09 — admin endpoint for ingesting a captain trip.
 *
 * The CRM doesn't subscribe to the operator's trip stream directly —
 * an integration job (or a manual admin action) POSTs each trip
 * here. The (captain_id, trip_id) UNIQUE makes the endpoint
 * idempotent on retries; re-delivering the same trip is a no-op.
 */
export const RecordTripSchema = z
  .object({
    /** Operator's external trip id (Uber uuid, inDrive id, ...). */
    tripId: z.string().trim().min(1).max(120),
    /** When the trip was completed. */
    occurredAt: isoDateTime,
    /** Optional opaque payload for downstream analytics. */
    payload: z.record(z.unknown()).optional(),
  })
  .strict();
export type RecordTripDto = z.infer<typeof RecordTripSchema>;
