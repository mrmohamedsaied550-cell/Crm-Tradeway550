/**
 * P2-06 — unit tests for the bundled CSV parser.
 *
 * No DB / no Nest — pure parser behaviour. Lives next to the rest of
 * the ingestion tests so a `pnpm test ingestion` filter picks it up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CsvParseError, parseCsv } from './csv.util';

describe('ingestion — csv.util', () => {
  it('parses a basic CSV with headers', () => {
    const { headers, rows } = parseCsv(
      'name,phone,email\nAlice,201001,alice@example.com\nBob,201002,bob@example.com\n',
    );
    assert.deepEqual(headers, ['name', 'phone', 'email']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { name: 'Alice', phone: '201001', email: 'alice@example.com' });
    assert.deepEqual(rows[1], { name: 'Bob', phone: '201002', email: 'bob@example.com' });
  });

  it('handles quoted cells, escaped quotes, and commas inside quotes', () => {
    const csv = 'name,note\n"Alice, A.","She said ""hi"""\nBob,plain\n';
    const { rows } = parseCsv(csv);
    assert.equal(rows[0]?.name, 'Alice, A.');
    assert.equal(rows[0]?.note, 'She said "hi"');
    assert.equal(rows[1]?.note, 'plain');
  });

  it('normalises CRLF and accepts a trailing newline', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { a: '1', b: '2' });
  });

  it('strips a UTF-8 BOM', () => {
    const { headers } = parseCsv('﻿full_name,phone\nAlice,1\n');
    assert.deepEqual(headers, ['full_name', 'phone']);
  });

  it('skips blank lines without affecting row count', () => {
    const { rows } = parseCsv('a,b\n\n1,2\n\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.a, '1');
  });

  it('pads short rows with empty strings', () => {
    const { rows } = parseCsv('a,b,c\n1,2\n');
    assert.deepEqual(rows[0], { a: '1', b: '2', c: '' });
  });

  it('drops extra trailing cells gracefully', () => {
    const { rows } = parseCsv('a,b\n1,2,3\n');
    assert.deepEqual(rows[0], { a: '1', b: '2' });
  });

  it('rejects an empty CSV', () => {
    assert.throws(
      () => parseCsv(''),
      (e) => e instanceof CsvParseError,
    );
  });

  it('rejects duplicate header columns', () => {
    assert.throws(
      () => parseCsv('phone,phone\n1,2\n'),
      (e) => e instanceof CsvParseError && /Duplicate header/.test(e.message),
    );
  });

  it('rejects an empty header column', () => {
    assert.throws(
      () => parseCsv('a,,c\n1,2,3\n'),
      (e) => e instanceof CsvParseError && /Header column is empty/.test(e.message),
    );
  });

  it('rejects an unterminated quoted cell', () => {
    assert.throws(
      () => parseCsv('a\n"unterminated\n'),
      (e) => e instanceof CsvParseError,
    );
  });

  it('rejects an unescaped quote in the middle of a cell', () => {
    assert.throws(
      () => parseCsv('a\nfoo"bar\n'),
      (e) => e instanceof CsvParseError,
    );
  });
});
