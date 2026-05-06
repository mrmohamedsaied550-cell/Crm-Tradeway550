import { SetMetadata } from '@nestjs/common';

import type { CatalogueResource } from './field-catalogue.registry';

/**
 * Phase D5 — D5.3: route metadata key consumed by
 * `FieldRedactionInterceptor`.
 *
 * Apply via `@ResourceFieldGate('lead')` on a controller method to
 * declare which resource the response carries. The interceptor
 * looks up the calling user's denied-read fields for that resource
 * (via `PermissionResolverService`) and strips them from the
 * outgoing JSON before serialisation.
 *
 * D5.3 wires the decorator only on `LeadsController.list` /
 * `findOne`; later D5.x chunks (D5.4 captain/contact/partner,
 * D5.5 timeline/review/audit) extend it to additional resources.
 */
export const RESOURCE_FIELD_GATE_KEY = 'd5.resourceFieldGate';

/**
 * Decorator factory. The single argument is a `CatalogueResource`
 * value — the closed string set declared by the field catalogue.
 *
 * Single-resource convention: a route returns one logical resource
 * shape. If a future endpoint mixes resources (rare), it should be
 * split into discrete handlers OR the interceptor extended to
 * accept an array. D5.3 deliberately keeps the contract narrow.
 */
export function ResourceFieldGate(resource: CatalogueResource): MethodDecorator {
  return SetMetadata(RESOURCE_FIELD_GATE_KEY, resource);
}
