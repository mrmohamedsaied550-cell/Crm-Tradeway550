/**
 * P2-06 — MetaLeadgenController unit tests.
 *
 * No DB. Stubs MetaLeadSourcesService + LeadIngestionService and
 * exercises the controller's:
 *   - GET handshake (verify-token routing + challenge echo).
 *   - POST inbound: payload parsing, signature check, mapping
 *     application, per-event ingest dispatch.
 *
 * The end-to-end persistence path is covered by
 * `lead-ingestion.test.ts`; here we just verify the controller's
 * dispatch contract.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';

import type { LeadSource } from '../crm/pipeline.registry';
import type { LeadIngestionService } from './lead-ingestion.service';
import type { MetaLeadSourcesService } from './meta-lead-sources.service';
import { MetaLeadgenController } from './meta-leadgen.controller';

interface FakeSource {
  id: string;
  tenantId: string;
  pageId: string;
  formId: string | null;
  verifyToken: string;
  appSecret: string | null;
  defaultSource: string;
  fieldMapping: Record<string, string>;
  isActive: boolean;
}

function makeSource(overrides: Partial<FakeSource> = {}): FakeSource {
  return {
    id: 'src-1',
    tenantId: '00000000-0000-0000-0000-000000000001',
    pageId: 'page-egypt',
    formId: null,
    verifyToken: 'verify-egypt',
    appSecret: 'secret-egypt',
    defaultSource: 'meta',
    fieldMapping: { full_name: 'name', phone_number: 'phone', email: 'email' },
    isActive: true,
    ...overrides,
  };
}

function buildController(opts: {
  source?: FakeSource | null;
  ingestResults?: Array<
    { kind: 'created'; id: string } | { kind: 'duplicate' } | { kind: 'error'; reason: string }
  >;
}): {
  controller: MetaLeadgenController;
  ingestCalls: { name: string; phone: string; email: string | null; source: LeadSource }[];
} {
  const source = opts.source ?? null;
  const ingestCalls: {
    name: string;
    phone: string;
    email: string | null;
    source: LeadSource;
  }[] = [];
  const queue = [...(opts.ingestResults ?? [])];

  const sourcesStub = {
    findRoutingByVerifyToken: async () => source,
    findRoutingByPageId: async () => source,
  } as unknown as MetaLeadSourcesService;

  const ingestionStub = {
    ingestMetaPayload: async (input: {
      name: string;
      phoneRaw: string;
      email?: string | null;
      source: LeadSource;
    }) => {
      ingestCalls.push({
        name: input.name,
        phone: input.phoneRaw,
        email: input.email ?? null,
        source: input.source,
      });
      return queue.shift() ?? { kind: 'created', id: `lead-${ingestCalls.length}` };
    },
  } as unknown as LeadIngestionService;

  return {
    controller: new MetaLeadgenController(sourcesStub, ingestionStub),
    ingestCalls,
  };
}

function makeReq(body: unknown, signature?: string): Request & { rawBody?: Buffer } {
  const raw = JSON.stringify(body);
  return {
    rawBody: Buffer.from(raw, 'utf8'),
    header(name: string) {
      if (name.toLowerCase() === 'x-hub-signature-256') return signature;
      return undefined;
    },
  } as unknown as Request & { rawBody?: Buffer };
}

function sign(rawBody: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

describe('ingestion — meta-leadgen controller', () => {
  it('echoes the challenge on a matching verify token', async () => {
    const { controller } = buildController({ source: makeSource() });
    const out = await controller.verify({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-egypt',
      'hub.challenge': 'CHALLENGE_42',
    });
    assert.equal(out, 'CHALLENGE_42');
  });

  it('rejects a non-matching verify token', async () => {
    const { controller } = buildController({ source: null });
    await assert.rejects(
      () =>
        controller.verify({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong',
          'hub.challenge': 'X',
        }),
      BadRequestException,
    );
  });

  it('rejects when hub.mode is not subscribe', async () => {
    const { controller } = buildController({ source: makeSource() });
    await assert.rejects(
      () =>
        controller.verify({
          'hub.mode': 'unsubscribe',
          'hub.verify_token': 'verify-egypt',
          'hub.challenge': 'X',
        }),
      BadRequestException,
    );
  });

  it('rejects a POST whose signature does not match', async () => {
    const { controller } = buildController({ source: makeSource() });
    const body = {
      object: 'page',
      entry: [
        {
          changes: [
            {
              field: 'leadgen',
              value: {
                page_id: 'page-egypt',
                form_id: null,
                leadgen_id: 'LG_1',
                field_data: [
                  { name: 'full_name', values: ['Alice'] },
                  { name: 'phone_number', values: ['+201001100777'] },
                ],
              },
            },
          ],
        },
      ],
    };

    await assert.rejects(
      () => controller.inbound(body, makeReq(body, 'sha256=00')),
      BadRequestException,
    );
  });

  it('parses field_data, applies the mapping, and dispatches one ingest per event', async () => {
    const { controller, ingestCalls } = buildController({
      source: makeSource(),
      ingestResults: [{ kind: 'created', id: 'lead-1' }, { kind: 'duplicate' }],
    });

    const body = {
      object: 'page',
      entry: [
        {
          changes: [
            {
              field: 'leadgen',
              value: {
                page_id: 'page-egypt',
                form_id: null,
                leadgen_id: 'LG_1',
                field_data: [
                  { name: 'full_name', values: ['Alice'] },
                  { name: 'phone_number', values: ['+201001100777'] },
                  { name: 'email', values: ['a@example.com'] },
                ],
              },
            },
            {
              field: 'leadgen',
              value: {
                page_id: 'page-egypt',
                form_id: null,
                leadgen_id: 'LG_2',
                field_data: [
                  { name: 'full_name', values: ['Bob'] },
                  { name: 'phone_number', values: ['+201001100778'] },
                ],
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(body);
    const out = await controller.inbound(body, makeReq(body, sign(raw, 'secret-egypt')));

    assert.equal(out.ingested, 1);
    assert.equal(out.duplicates, 1);
    assert.equal(out.errors, 0);

    assert.equal(ingestCalls.length, 2);
    assert.deepEqual(ingestCalls[0], {
      name: 'Alice',
      phone: '+201001100777',
      email: 'a@example.com',
      source: 'meta',
    });
    assert.deepEqual(ingestCalls[1], {
      name: 'Bob',
      phone: '+201001100778',
      email: null,
      source: 'meta',
    });
  });

  it('counts events without field_data as errors (verbose mode disabled)', async () => {
    const { controller, ingestCalls } = buildController({ source: makeSource() });
    const body = {
      object: 'page',
      entry: [
        {
          changes: [
            {
              field: 'leadgen',
              value: {
                page_id: 'page-egypt',
                form_id: null,
                leadgen_id: 'LG_NO_DATA',
                // no field_data on this event
              },
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(body);
    const out = await controller.inbound(body, makeReq(body, sign(raw, 'secret-egypt')));
    assert.equal(out.ingested, 0);
    assert.equal(out.duplicates, 0);
    assert.equal(out.errors, 1);
    assert.equal(ingestCalls.length, 0);
  });

  it('treats events for an unknown page as errors and does not 4xx', async () => {
    const { controller, ingestCalls } = buildController({ source: null });
    const body = {
      object: 'page',
      entry: [
        {
          changes: [
            {
              field: 'leadgen',
              value: {
                page_id: 'unknown-page',
                form_id: null,
                leadgen_id: 'LG_X',
                field_data: [
                  { name: 'full_name', values: ['X'] },
                  { name: 'phone_number', values: ['+201001100799'] },
                ],
              },
            },
          ],
        },
      ],
    };
    const out = await controller.inbound(body, makeReq(body));
    assert.equal(out.ingested, 0);
    assert.equal(out.errors, 1);
    assert.equal(ingestCalls.length, 0);
  });

  it('returns an empty envelope for non-page payloads', async () => {
    const { controller } = buildController({ source: makeSource() });
    const out = await controller.inbound({ object: 'whatsapp_business_account' }, makeReq({}));
    assert.deepEqual(out, { ok: true, ingested: 0, duplicates: 0, errors: 0 });
  });
});
