/**
 * Phase D5 — hotfix regression test for the
 * `feat(d5): resolve RoleDependencyService DI wiring` fix.
 *
 * Background:
 *
 *   Manus staging boot crashed with
 *
 *     Nest can't resolve dependencies of the RoleDependencyService
 *     (PrismaService, ?, AuditService). Please make sure that the
 *     argument dependency at index [1] is available in the
 *     RbacModule context.
 *
 *   Root cause: a CJS module-load cycle introduced when D5.15-B's
 *   `RoleVersionService` imported `computeRiskSummary` from
 *   `role-change-preview.service.ts`. The chain was:
 *
 *     rbac.service.ts
 *       → (value) role-version.service.ts
 *           → (value) role-change-preview.service.ts
 *               → (value) role-dependency.service.ts
 *                   → (value) rbac.service.ts          ← cycle
 *
 *   Static checks (typecheck / lint / unit tests that build
 *   services with `new`) all passed because they don't simulate
 *   Nest's reflection-metadata pipeline. The cycle only bit at
 *   `Reflect.getMetadata('design:paramtypes', RoleDependencyService)`
 *   time, where `RbacService` resolved to `undefined` because
 *   `rbac.service.ts` was mid-evaluation when
 *   `role-dependency.service.ts` ran its `@Injectable()` decorator.
 *
 * Why a static-source test, not a Nest TestingModule:
 *
 *   1. `@nestjs/testing` is not in the dev deps; adding it just
 *      for one test would be a much bigger change than this
 *      hotfix warrants.
 *   2. The unit-test runner (`node --import tsx --test`) uses
 *      esbuild under the hood, which does NOT emit
 *      `emitDecoratorMetadata`. A `Reflect.getMetadata` check
 *      under tsx returns `undefined` regardless of cycle state,
 *      so a reflection-based test would not actually catch the
 *      regression.
 *   3. The fix is structural: `RoleVersionService` MUST NOT
 *      import a value from `role-change-preview.service.ts` (the
 *      file that pulls `RoleDependencyService` into the cycle).
 *      The pure helpers file `role-change-preview.helpers.ts`
 *      exists for exactly this reason.
 *
 *   This test parses the actual source of the affected files and
 *   asserts the import-chain invariant directly. It would have
 *   caught the original regression and will catch any future
 *   re-introduction of the cycle.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RBAC_DIR = resolve(__dirname);

function readSource(filename: string): string {
  return readFileSync(resolve(RBAC_DIR, filename), 'utf8');
}

function importsValueFrom(source: string, modulePath: string): boolean {
  // Match `import { foo, bar } from 'modulePath'` where at least
  // one specifier is NOT prefixed with `type` (i.e. is a value
  // import). Also catches `import foo from 'modulePath'` and
  // `import * as ns from 'modulePath'`.
  //
  // A pure type-only line — `import type { X } from 'modulePath';`
  // — is NOT counted as a value import (TypeScript erases it at
  // compile time and it does not trigger module evaluation).
  const lines = source.split('\n');
  const escapedPath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRegex = new RegExp(`from\\s+['"\`]${escapedPath}['"\`]`);
  for (const line of lines) {
    if (!pathRegex.test(line)) continue;
    // Skip pure-type-only imports: `import type { … } from 'mod';`
    if (/^\s*import\s+type\s+/.test(line)) continue;
    // The line is some form of import that loads the module at
    // runtime (default, namespace, mixed value+type, or pure
    // value). That's enough to trigger module evaluation.
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════
// Hotfix invariants
// ════════════════════════════════════════════════════════════════

describe('rbac/D5 hotfix — import-chain invariant', () => {
  it('role-change-preview.helpers.ts exists and exports computeRiskSummary', () => {
    const src = readSource('role-change-preview.helpers.ts');
    assert.match(
      src,
      /export\s+function\s+computeRiskSummary\b/,
      'helpers file must own the computeRiskSummary implementation',
    );
    assert.match(
      src,
      /export\s+interface\s+RoleRiskSummary\b/,
      'helpers file must own the RoleRiskSummary type',
    );
  });

  it('role-change-preview.helpers.ts has NO class imports from other rbac services', () => {
    const src = readSource('role-change-preview.helpers.ts');
    // The helpers file is only allowed to import from
    // `capability-dependencies.ts` (pure data — no @Injectable
    // anywhere). Any import from a `*.service.ts` file would
    // re-introduce the cycle risk.
    const forbidden = [
      './rbac.service',
      './role-dependency.service',
      './role-version.service',
      './role-change-preview.service',
      './role-template.service',
      './role-preview.service',
      './ownership-visibility.service',
      './lead-review-visibility.service',
      './whatsapp-visibility.service',
    ];
    for (const path of forbidden) {
      assert.equal(
        importsValueFrom(src, path),
        false,
        `role-change-preview.helpers.ts must NOT import a value from '${path}' — ` +
          `the helpers file is the cycle-break, it cannot itself depend on the class graph.`,
      );
    }
  });

  it('role-version.service.ts imports computeRiskSummary from helpers, NOT from the service', () => {
    const src = readSource('role-version.service.ts');
    assert.equal(
      importsValueFrom(src, './role-change-preview.helpers'),
      true,
      'role-version.service.ts must import the pure helpers file ' +
        '(not role-change-preview.service.ts) for computeRiskSummary',
    );
    assert.equal(
      importsValueFrom(src, './role-change-preview.service'),
      false,
      'role-version.service.ts must NOT load role-change-preview.service.ts — ' +
        'that file pulls RoleDependencyService into the value-import chain and ' +
        'closes the boot-crashing cycle: ' +
        'rbac → version → change-preview → dependency → rbac.',
    );
  });

  it('role-change-preview.service.ts re-exports computeRiskSummary for backward compat', () => {
    const src = readSource('role-change-preview.service.ts');
    // The service file imports the helper and re-exports it under
    // the same name so existing call sites that already point at
    // role-change-preview.service.ts (the d5-15a tests, the
    // controller) keep working.
    assert.match(
      src,
      /export\s*\{\s*computeRiskSummaryFromHelpers\s+as\s+computeRiskSummary\s*\}/,
      're-export of computeRiskSummary is required for back-compat with the d5-15a tests',
    );
  });

  it('role-dependency.service.ts continues to depend on RbacService (the fix preserves the contract)', () => {
    const src = readSource('role-dependency.service.ts');
    assert.equal(
      importsValueFrom(src, './rbac.service'),
      true,
      'RoleDependencyService.findRoleById delegates to RbacService — that dependency is correct. ' +
        'The cycle was on the RbacService → ... → RoleDependencyService side, not the other direction.',
    );
  });

  it('rbac.service.ts continues to depend on RoleVersionService (D5.15-B contract preserved)', () => {
    const src = readSource('rbac.service.ts');
    assert.equal(
      importsValueFrom(src, './role-version.service'),
      true,
      'RbacService write paths call RoleVersionService.recordVersion inside the same tx ' +
        '(D5.15-B). The hotfix preserves this dependency direction.',
    );
  });

  it('the cycle endpoint pair (rbac → version) does NOT close back through change-preview', () => {
    // Direct invariant: no value-import path from
    // role-version.service.ts to role-change-preview.service.ts
    // exists. The previous chain was:
    //
    //   rbac.service → role-version.service → role-change-preview.service
    //     → role-dependency.service → rbac.service
    //
    // Cutting role-version → role-change-preview (the second
    // edge) breaks the cycle structurally.
    const versionSrc = readSource('role-version.service.ts');
    assert.equal(
      importsValueFrom(versionSrc, './role-change-preview.service'),
      false,
      'value-import role-version.service → role-change-preview.service ' +
        'must stay broken. Re-introducing it crashes Nest at boot.',
    );
  });
});

// ════════════════════════════════════════════════════════════════
// PR #35 — PermissionCacheService DI hotfix invariants
// ════════════════════════════════════════════════════════════════
//
// After PR #34 fixed the role-dependency cycle, staging boot
// crashed on a different DI error:
//
//   Nest can't resolve dependencies of the PermissionCacheService (?).
//   Please make sure that the argument Object at index [0] is
//   available in the RbacModule context.
//
// Root cause: `PermissionCacheService.constructor(opts:
// PermissionCacheOptions)` takes a parameter typed as a
// TypeScript INTERFACE. Interfaces are erased at runtime, so
// TypeScript emits the literal `Object` in `design:paramtypes`.
// Nest then looks up a provider with token `Object`, finds
// none, and throws.
//
// The fix is `@Optional()` on the parameter — Nest silently
// passes `undefined` when no matching provider exists; the
// `= {}` default keeps construction working in both DI and
// direct-`new` (test) call sites.
//
// These invariants catch a future regression before deploy.

describe('rbac/D5 hotfix #2 — PermissionCacheService DI safety', () => {
  it('PermissionCacheService.constructor uses @Optional() on the options param', () => {
    const src = readSource('permission-cache.service.ts');
    // The decorator must sit on the constructor parameter that
    // takes the (interface-typed) options object. We accept any
    // formatting the linter / prettier might produce.
    assert.match(
      src,
      /constructor\s*\([\s\S]*?@Optional\s*\(\s*\)[\s\S]*?opts\s*:\s*PermissionCacheOptions/,
      'PermissionCacheService.constructor must keep @Optional() on the opts parameter — ' +
        'without it, Nest crashes at boot trying to resolve provider for token Object ' +
        '(the design:paramtypes emit for an interface-typed param).',
    );
  });

  it('PermissionCacheService imports Optional from @nestjs/common', () => {
    const src = readSource('permission-cache.service.ts');
    assert.match(
      src,
      /import\s*\{[^}]*\bOptional\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/,
      'Optional must be imported from @nestjs/common',
    );
  });

  it('PermissionCacheService keeps PermissionCacheOptions as the param type (test compat)', () => {
    // The test surface (permission-resolver.service.test.ts) calls
    // `new PermissionCacheService({ maxEntries, ttlMs })`. Removing
    // the constructor parameter or renaming the interface would
    // break those tests. Asserting the shape locks the contract.
    const src = readSource('permission-cache.service.ts');
    assert.match(
      src,
      /export\s+interface\s+PermissionCacheOptions\b/,
      'PermissionCacheOptions interface must remain exported',
    );
  });
});

// ════════════════════════════════════════════════════════════════
// PR #35 — RBAC DI cycle sweep
// ════════════════════════════════════════════════════════════════
//
// After two boot crashes (PR #34: cycle on RoleDependencyService;
// PR #35: interface-typed param on PermissionCacheService), do
// a defensive structural sweep of the entire RBAC layer so the
// next failure-mode does not hit production.
//
// For every rbac/* service, walk its source and:
//   1. Collect every `from './...service'` value-import.
//   2. For each imported sibling, walk THAT file's value-imports.
//   3. Detect any cycle that closes back to the starting file
//      via two or more hops.
//
// The previous cycle was 4 hops (rbac → version → change-preview
// → dependency → rbac). The sweep guards against any future
// re-introduction of any cycle within the rbac/* directory.

describe('rbac/D5 hotfix #2 — no value-import cycles within rbac/*', () => {
  // ESM relative-import paths to the rbac/* services that are
  // most likely to participate in cycles. (We're not chasing
  // pure-helper / registry / DTO files — those are leaves.)
  const RBAC_SERVICE_FILES: readonly string[] = [
    'rbac.service.ts',
    'role-dependency.service.ts',
    'role-change-preview.service.ts',
    'role-version.service.ts',
    'role-template.service.ts',
    'role-preview.service.ts',
    'permission-cache.service.ts',
    'permission-resolver.service.ts',
    'field-filter.service.ts',
    'field-redaction.interceptor.ts',
    'export-redaction.service.ts',
    'export-audit.service.ts',
    'export.interceptor.ts',
    'ownership-visibility.service.ts',
    'lead-review-visibility.service.ts',
    'whatsapp-visibility.service.ts',
    'scope-context.service.ts',
    'capability.guard.ts',
  ];

  /**
   * Parse the value-import targets from a source file. Returns
   * normalised relative paths (no extension). Pure-type imports
   * (`import type { X } from 'mod';`) and re-exports are skipped
   * — only paths that trigger module evaluation at load time
   * count.
   */
  function valueImportsFrom(filename: string): readonly string[] {
    const src = readSource(filename);
    const out: string[] = [];
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('import')) continue;
      // Skip pure-type-only imports.
      if (/^import\s+type\b/.test(line)) continue;
      const match = /from\s+['"](\.\/[^'"]+)['"]/.exec(line);
      if (!match) continue;
      const target = match[1]!.replace(/\.(ts|tsx|js)$/u, '');
      out.push(target);
    }
    return out;
  }

  /** Convert "role-version.service" → "role-version.service.ts". */
  function withExt(target: string): string {
    return target.startsWith('./') ? `${target.slice(2)}.ts` : `${target}.ts`;
  }

  /**
   * BFS from `start` through value-import edges. Returns the
   * first cycle path that loops back to `start`, or `null` when
   * the graph is acyclic from this entry point.
   */
  function findCycleFrom(start: string): readonly string[] | null {
    const visited = new Set<string>();
    const stack: Array<{ node: string; path: readonly string[] }> = [
      { node: start, path: [start] },
    ];
    while (stack.length > 0) {
      const { node, path } = stack.shift()!;
      const nodeFile = path.length === 1 ? start : node;
      let imports: readonly string[];
      try {
        imports = valueImportsFrom(nodeFile);
      } catch {
        continue; // file not a tracked source — skip
      }
      for (const imp of imports) {
        const next = withExt(imp);
        if (next === start && path.length > 1) {
          return [...path, start];
        }
        if (visited.has(next)) continue;
        // Only walk into RBAC siblings — out-of-rbac imports
        // (PrismaService, AuditService, …) cannot participate
        // in the rbac-internal cycle we're hunting.
        if (!RBAC_SERVICE_FILES.includes(next)) continue;
        visited.add(next);
        stack.push({ node: next, path: [...path, next] });
      }
    }
    return null;
  }

  for (const start of RBAC_SERVICE_FILES) {
    it(`${start} has no value-import cycle to itself`, () => {
      const cycle = findCycleFrom(start);
      assert.equal(
        cycle,
        null,
        `value-import cycle detected starting from ${start}: ${cycle?.join(' → ') ?? ''}`,
      );
    });
  }
});
