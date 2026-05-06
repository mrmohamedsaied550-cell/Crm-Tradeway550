# Phase D5 — Enterprise Governance / Dynamic Permissions / Field-Level Access

This module is the source of truth for tenant-scoped RBAC. It rewrites the
hand-rolled "if (user.role === 'admin')" checks scattered across services with
a small set of typed services that compose into one rule:

> **Server is the source of truth. Frontend hiding is a UX hint, never a
> gate.**

D5 was shipped in 13 chunks (D5.1 → D5.13). This README is the wrap-up: it
lists every service, the catalogue resources they cover, the default-deny
matrix, the audit verbs they emit, and the safety rules every future writer
must follow.

---

## Services

| Service                       | File                                    | Responsibility                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionResolverService`   | `permission-resolver.service.ts`        | Resolves the `(roleId)` → `{ capabilities, fieldPermissions, scopes }` envelope. Caches per-request via `PermissionCacheService`.                                                                                                                                                              |
| `PermissionCacheService`      | `permission-cache.service.ts`           | Per-request memoisation so a single HTTP turn never re-reads the role tables.                                                                                                                                                                                                                  |
| `FieldFilterService`          | `field-filter.service.ts`               | Returns the `DeniedReadFields` list for a `(claims, resource)` pair. Source of every per-field redaction.                                                                                                                                                                                      |
| `FieldRedactionInterceptor`   | `field-redaction.interceptor.ts`        | NestJS interceptor that walks controller responses with `@ResourceFieldGate(resource)` and nulls denied paths.                                                                                                                                                                                 |
| `ScopeContextService`         | `scope-context.service.ts`              | Translates a role's data-scope (global / tenant / team / own) into Prisma `where` clauses. Read paths use these.                                                                                                                                                                               |
| `OwnershipVisibilityService`  | `ownership-visibility.service.ts`       | D5.7 — gates the `lead.previousOwner` history surface. Strips prior-owner identity from `/leads/:id` and rotation-log responses unless the role holds `lead.previousOwner`.                                                                                                                    |
| `LeadReviewVisibilityService` | `lead-review-visibility.service.ts`     | D5.8 — gates the TL Review Queue context (assigned TL, owner / partner / SLA context). Stricter-rule-wins with the field catalogue.                                                                                                                                                            |
| `WhatsAppVisibilityService`   | `whatsapp-visibility.service.ts`        | D5.12-A + D5.12-B — gates conversation read paths, the review row's embedded conversation, and the WhatsApp handover sub-keys on `LeadActivity` rows / unified-audit-feed payloads. Strict-rule-wins between transfer mode (clean / summary / full) and `priorAgentMessages` field permission. |
| `RolePreviewService`          | `role-preview.service.ts`               | D5.10 — server-side "what would role X see?" preview. Powers the admin role editor's preview tab and writes the `rbac.role.previewed` audit verb.                                                                                                                                              |
| `ExportRedactionService`      | `export-redaction.service.ts`           | D5.6A → D5.6D — applies field-permission redaction to every governed export (tenant backup / report CSV / partner reconciliation / partner commission / lead / audit). Pairs with `ExportInterceptor` + `ExportAuditService`.                                                                  |
| `ExportAuditService`          | `export-audit.service.ts`               | D5.6A — writes the `*.export.completed` audit verbs. Payload is metadata only (`rowCount` / `tablesShipped` / `columnsRedactedByTable` / `bytesShipped`); never row values.                                                                                                                    |
| `RbacService` + controller    | `rbac.service.ts`, `rbac.controller.ts` | Read + write surface for roles, capabilities, scopes, and field permissions. Writes `role.*` and `user.scope.*` audit verbs.                                                                                                                                                                   |

The full module wiring lives in `rbac.module.ts`. It is `@Global` so any
feature service can `@Optional() inject` the visibility / preview / redaction
services without ceremony.

---

## Field catalogue

`field-catalogue.registry.ts` is the single source of truth for redactable
fields. Every entry carries a stable `(resource, field)` key, EN/AR labels,
and a default-deny bit per role. The frontend mirror lives at
`apps/web/lib/field-catalogue-mirror.ts`.

Resources covered (28 as of D5.13):

- `lead`, `lead.activity`, `lead.previousOwner`
- `lead.review`
- `rotation`, `rotation.fromUser`
- `whatsapp.conversation` (priorAgentMessages, handoverChain, handoverSummary,
  conversationHistory, reviewNotes, internalMetadata)
- `partner.commission`, `partner.reconciliation`
- `report.activations`, `report.bonuses`, `report.compensation`,
  `report.kpi`, `report.leads`, `report.reconciliation`
- `tenant.backup`
- (plus the classic `user.contact`, `team`, `bonus.accrual`, ...)

**Adding a new redactable field:**

1. Append a row in `field-catalogue.registry.ts` with EN/AR labels.
2. Mirror in `apps/web/lib/field-catalogue-mirror.ts`.
3. Decorate the controller method with
   `@ResourceFieldGate('<resource>')` so `FieldRedactionInterceptor` walks
   the response.
4. If the field is on a transactional write path, add a `D5.x`
   regression test next to the closest existing one.

---

## Default-deny matrix (production roles)

| Role               | Scope  | Sensitive read denies (default)                                                                                                                                                                                                                                                                             |
| ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `super_admin`      | global | none — bypass on every gate                                                                                                                                                                                                                                                                                 |
| `admin`            | tenant | none — but writes are audited                                                                                                                                                                                                                                                                               |
| `team_lead`        | team   | `lead.activity.payload.summary` (handover summary text), `whatsapp.conversation.priorAgentMessages`                                                                                                                                                                                                         |
| `sales_agent`      | own    | `lead.previousOwner`, `rotation.fromUser`, `lead.activity.payload.fromUserId`, `whatsapp.conversation.priorAgentMessages`, `whatsapp.conversation.handoverChain`, `whatsapp.conversation.handoverSummary`, `whatsapp.conversation.internalMetadata`, `lead.review.assignedTl`, `lead.review.partnerContext` |
| `activation_agent` | own    | same as `sales_agent` plus `lead.review.ownerContext`                                                                                                                                                                                                                                                       |
| `qa_reviewer`      | tenant | `lead.previousOwner` (read by exception), `whatsapp.conversation.handoverSummary` permitted (QA needs handover context)                                                                                                                                                                                     |
| `finance_admin`    | tenant | strictly the partner / report resources; lead surface is denied for read                                                                                                                                                                                                                                    |
| `finance_viewer`   | tenant | report.\* read-only                                                                                                                                                                                                                                                                                         |
| `ops_lead`         | tenant | tenant export / backup denied; everything else allowed by default                                                                                                                                                                                                                                           |
| `read_only`        | tenant | every write denied; reads follow the agent profile                                                                                                                                                                                                                                                          |
| `service_account`  | tenant | bot — capability-driven, no UI                                                                                                                                                                                                                                                                              |

(These are defaults — tenants override per-role via the admin role editor.
The catalogue's default-deny bit only seeds new tenants.)

---

## Audit verbs (D5.x)

Every governance action writes a structured audit row. Payloads carry
**metadata only** — never row values, never PII.

| Verb                                                 | Source                   | Chip group                  |
| ---------------------------------------------------- | ------------------------ | --------------------------- |
| `rbac.role.previewed`                                | D5.10 RolePreviewService | `rbac`                      |
| `role.create` / `.update` / `.duplicate` / `.delete` | RbacService              | `role`                      |
| `role.capability.update`                             | RbacService              | `role`                      |
| `role.scope.update`                                  | RbacService              | `role`                      |
| `role.field.update`                                  | RbacService              | `role`                      |
| `user.scope.assign` / `.update` / `.revoke`          | RbacService              | `user_scope`                |
| `tenant.export.completed`                            | D5.6D ExportAuditService | `tenant_export`             |
| `report.export.completed`                            | D5.6C ExportAuditService | `report_export`             |
| `partner.reconciliation.export.completed`            | D5.6B ExportAuditService | `partner_recon_export`      |
| `partner.commission.export.completed`                | D5.6B ExportAuditService | `partner_commission_export` |
| `lead.export.completed`                              | reserved                 | `export_governance`         |
| `audit.export.completed`                             | reserved                 | `export_governance`         |
| `whatsapp.handover.completed`                        | D5.13 WhatsAppService    | `whatsapp_handover`         |
| `field_write_denied`                                 | C5.5 (legacy)            | (not a chip — row badge)    |

Allow-list registry: `apps/api/src/audit/audit-action-groups.ts`.
Frontend mirror: `apps/web/lib/audit-governance.ts`.

---

## Realtime / notification channel

The realtime channel is a **notification channel, not a data channel**.
Three event types:

- `notification.created` — `{ notificationId, recipientUserId, kind }`
- `whatsapp.message` — `{ conversationId, messageId, direction }`
- `lead.assigned` — `{ leadId, toUserId, fromUserId: null, reason }`

Note: `RealtimeLeadAssigned.fromUserId` is typed as the literal `null`
(not `string | null`). A future emitter trying to set it surfaces at
compile time. Previous-owner identity is gated by the REST surface
via `lead.previousOwner` / `rotation.fromUser` field permissions —
clients re-fetch the canonical record after receiving the event.

Notification rows follow the same rule:

- **Body** never carries prior-agent text, prior-owner names, or
  conversation snippets. Use neutral copy ("Lead reassigned", "WhatsApp
  conversation handed to you", "Transfer mode: clean").
- **Payload** carries structural navigation fields only (`leadId`,
  `conversationId`, `mode`). Never `fromUserId` / `toUserId` / `summary`.

---

## Safety rules for future writers

1. **Server is the source of truth.** Frontend hiding is a UX hint. Every
   redaction MUST land on the server via the field catalogue + a
   visibility service.

2. **Strict-rule-wins.** When two rules disagree on whether to hide a
   field, the stricter one wins. WhatsApp transfer mode `clean` / `summary`
   always hides prior agent messages; `full` respects the
   `priorAgentMessages` field permission.

3. **Never leak previous-owner identity outside the REST gate.** Realtime
   events, notification payloads, audit row payloads, lead-activity
   payloads (the WhatsApp handover surgical-strip exists for exactly
   this), CSV exports, and backup dumps all flow through a redaction
   service. If you add a new emitter and it carries an actor ID, ask:
   "would a sales_agent see this on the REST surface?" If the answer is
   "no", strip it.

4. **Audit payloads are metadata only.** Row counts, table counts,
   redacted-column counts, target role codes, warning counts. Never row
   values, never PII. The export-governance verbs ship the canonical
   shape; copy it.

5. **Tests are mandatory.** Every D5 chunk has a `d5-N-*.test.ts` next to
   the service it changes. New visibility surfaces ship with at least:
   - default-deny path (the field is null'd for the denied role),
   - allowed path (the field passes through for an allowed role),
   - super-admin bypass (input unchanged),
   - row-count preservation (no rows dropped).

6. **Feature flag + rollout.** Behind `D5_DYNAMIC_PERMISSIONS_V1`. Flip
   the flag in staging, watch the audit feed for `field_write_denied`
   spikes, then promote.

---

## Test layout

- Unit tests for visibility services live next to the service.
- Cross-flow tests (controller + interceptor + redaction) live in
  `apps/api/src/rbac/d5-N-*.test.ts`.
- Audit governance tests live in `apps/api/src/audit/d5-11-audit-governance.test.ts`.
- Realtime + notification body tests live in
  `apps/api/src/rbac/d5-13-realtime-and-notification.test.ts`.

---

## Ship log (chunks)

| Chunk     | Theme                                                                               | Audit verbs introduced                                                           |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D5.1      | Foundation: feature flag, capability registry, role registry, `RbacModule` wiring   | —                                                                                |
| D5.2      | Field catalogue + `FieldFilterService` + denial bit                                 | —                                                                                |
| D5.3      | `FieldRedactionInterceptor` + `@ResourceFieldGate` decorator                        | `field_write_denied` (re-routed)                                                 |
| D5.4-D5.5 | Resource-gate wiring across leads / rotations / reports / partners / WhatsApp       | —                                                                                |
| D5.6A     | Export governance foundation + `ExportRedactionService` + `ExportAuditService`      | `*.export.completed` shape                                                       |
| D5.6B     | Partner reconciliation + commission CSV exports                                     | `partner.reconciliation.export.completed`, `partner.commission.export.completed` |
| D5.6C     | Reports CSV exports                                                                 | `report.export.completed`                                                        |
| D5.6D-1/2 | Tenant backup export foundation + redaction                                         | `tenant.export.completed`                                                        |
| D5.7      | `OwnershipVisibilityService` — previous-owner / rotation-from-user gating           | —                                                                                |
| D5.8      | `LeadReviewVisibilityService` — TL Review Queue context gating                      | —                                                                                |
| D5.9      | `RedactedFieldBadge` UX + frontend field-catalogue mirror + auth permission surface | —                                                                                |
| D5.10     | `RolePreviewService` — admin role editor preview tab                                | `rbac.role.previewed`                                                            |
| D5.11     | Audit governance allow-list + chip strip + `summariseAuditPayload`                  | (allow-list registry, no new verbs)                                              |
| D5.12-A   | `WhatsAppVisibilityService` for conversation read paths                             | —                                                                                |
| D5.12-B   | Review queue + lead-activity timeline + unified-audit-feed handover redaction       | —                                                                                |
| D5.13     | Close realtime + notification + handover audit leak surfaces                        | `whatsapp.handover.completed`                                                    |

D5.14 is reserved for a per-recipient realtime redaction surface (so we can
restore richer payloads to roles that hold the right field permissions
without compromising the safe-minimal baseline). Out of scope for D5.13.
