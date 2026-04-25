import type { Prisma, TimelineEventType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export async function writeTimeline(args: {
  enrollmentId: string;
  type: TimelineEventType;
  actorId: string | null;
  payload: Prisma.InputJsonValue;
  tx?: Prisma.TransactionClient;
}) {
  const client = args.tx ?? prisma;
  return client.enrollmentTimeline.create({
    data: {
      enrollmentId: args.enrollmentId,
      type: args.type,
      actorId: args.actorId,
      payload: args.payload,
    },
  });
}
