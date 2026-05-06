/**
 * Hotfix regression test for the
 * `fix(whatsapp): resolve MetaCloudProvider DI wiring` change.
 *
 * Background:
 *
 *   After PR #35 closed the RBAC DI sweep, Manus staging boot
 *   crashed with a different DI error in the WhatsApp module:
 *
 *     Nest can't resolve dependencies of the MetaCloudProvider (?).
 *     Please make sure that the argument Function at index [0] is
 *     available in the WhatsAppModule context.
 *
 *   Root cause: `MetaCloudProvider.constructor(fetchImpl: FetchFn)`
 *   takes a parameter typed as a TypeScript FUNCTION-TYPE alias.
 *   Function-type aliases are erased at runtime, so TypeScript
 *   emits the literal `Function` in the constructor's
 *   `design:paramtypes` metadata. Nest then looks up a provider
 *   for token `Function`, finds none, and throws on boot.
 *
 *   The fix is `@Optional()` on the parameter — Nest silently
 *   passes `undefined` when no matching provider exists; the
 *   existing `= globalThis.fetch as unknown as FetchFn` default
 *   keeps both DI construction (Nest passes nothing → falls back
 *   to global fetch) and direct `new MetaCloudProvider(stub)`
 *   test instantiation working unchanged.
 *
 * Why a static-source test, not a Nest TestingModule:
 *
 *   1. `@nestjs/testing` is not in dev deps — adding it for one
 *      test would be a much bigger change than this hotfix
 *      warrants.
 *   2. The unit-test runner (`node --import tsx --test`) uses
 *      esbuild under the hood, which does NOT emit
 *      `emitDecoratorMetadata`. A `Reflect.getMetadata` check
 *      under tsx returns `undefined` regardless of decorator
 *      state, so a reflection-based test would not actually
 *      catch the regression.
 *   3. Same pattern as the RBAC hotfix tests
 *      (`d5-hotfix-module-wiring.test.ts`) — parse the actual
 *      source and assert the structural invariant directly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WHATSAPP_DIR = resolve(__dirname);

function readSource(filename: string): string {
  return readFileSync(resolve(WHATSAPP_DIR, filename), 'utf8');
}

describe('whatsapp/MetaCloudProvider DI safety', () => {
  it('MetaCloudProvider.constructor uses @Optional() on the fetch param', () => {
    const src = readSource('meta-cloud.provider.ts');
    // The decorator must sit on the constructor parameter that
    // takes the function-typed `fetchImpl`. We accept any
    // formatting prettier might produce.
    assert.match(
      src,
      /constructor\s*\([\s\S]*?@Optional\s*\(\s*\)[\s\S]*?fetchImpl\s*:\s*FetchFn/,
      'MetaCloudProvider.constructor must keep @Optional() on the fetchImpl parameter — ' +
        'without it, Nest crashes at boot trying to resolve provider for token Function ' +
        '(the design:paramtypes emit for a function-type-aliased param).',
    );
  });

  it('MetaCloudProvider imports Optional from @nestjs/common', () => {
    const src = readSource('meta-cloud.provider.ts');
    assert.match(
      src,
      /import\s*\{[^}]*\bOptional\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/,
      'Optional must be imported from @nestjs/common',
    );
  });

  it('MetaCloudProvider keeps a runtime default for fetchImpl', () => {
    // The default (`globalThis.fetch as unknown as FetchFn`) is what
    // makes `@Optional()` viable — when Nest passes `undefined`, the
    // default kicks in and the provider works in production. Without
    // the default, an `@Optional()` param would leave `fetchImpl`
    // as `undefined` and every send/test/connection call would
    // crash with "this.fetchImpl is not a function".
    const src = readSource('meta-cloud.provider.ts');
    assert.match(
      src,
      /fetchImpl\s*:\s*FetchFn\s*=\s*globalThis\.fetch/,
      'MetaCloudProvider must default fetchImpl to globalThis.fetch — ' +
        '@Optional() without a default would make the provider unusable in production.',
    );
  });

  it('MetaCloudProvider keeps FetchFn exported (test compat)', () => {
    // Multiple test files (whatsapp.test.ts,
    // whatsapp-templates-media.test.ts) instantiate the provider
    // via `new MetaCloudProvider(fakeFetch)` typed as FetchFn.
    // Removing the export would break those call sites silently.
    const src = readSource('meta-cloud.provider.ts');
    assert.match(
      src,
      /export\s+type\s+FetchFn\s*=/,
      'FetchFn type must remain exported for the test fakeFetch typings.',
    );
  });
});

describe('whatsapp/WhatsAppModule provider registration', () => {
  it('WhatsAppModule registers MetaCloudProvider', () => {
    const src = readSource('whatsapp.module.ts');
    // The provider entry can be either the class shorthand
    // (`MetaCloudProvider`) or a factory record. Either is valid;
    // we just assert the provider is wired into the module.
    assert.match(
      src,
      /providers\s*:\s*\[[\s\S]*?\bMetaCloudProvider\b[\s\S]*?\]/,
      'WhatsAppModule.providers must include MetaCloudProvider — ' +
        'WhatsAppService injects it directly.',
    );
  });

  it('WhatsAppModule imports MetaCloudProvider from ./meta-cloud.provider', () => {
    const src = readSource('whatsapp.module.ts');
    assert.match(
      src,
      /import\s*\{[^}]*\bMetaCloudProvider\b[^}]*\}\s*from\s*['"]\.\/meta-cloud\.provider['"]/,
      'WhatsAppModule must import MetaCloudProvider from the canonical file ' +
        '(no shadow / forwarded export).',
    );
  });

  it('WhatsAppService injects MetaCloudProvider as a class-typed param', () => {
    // MetaCloudProvider itself is a class, so its design:paramtypes
    // emit is a valid token. This assertion locks the contract that
    // the consumer side stays class-typed (i.e. nobody widens the
    // type to a union or interface, which would re-introduce the
    // very failure mode this hotfix repairs).
    const src = readSource('whatsapp.service.ts');
    assert.match(
      src,
      /private\s+readonly\s+\w+\s*:\s*MetaCloudProvider\b/,
      'WhatsAppService must inject MetaCloudProvider with the concrete class type.',
    );
  });
});
