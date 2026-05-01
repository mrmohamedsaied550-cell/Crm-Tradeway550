import { SetMetadata } from '@nestjs/common';
import type { CapabilityCode } from './capabilities.registry';

/** Metadata key consumed by the CapabilityGuard. */
export const CAPABILITY_KEY = 'requiredCapabilities';

/**
 * Mark a controller method (or class) as requiring one or more
 * capabilities. The CapabilityGuard rejects with 403 when the calling
 * user's role lacks any one of them.
 *
 * Multiple decorators on the same method are AND'd together.
 *
 * Example:
 *   @Post('leads')
 *   @RequireCapability('lead.write')
 *   create(...)
 */
export function RequireCapability(
  ...caps: readonly CapabilityCode[]
): MethodDecorator & ClassDecorator {
  return SetMetadata(CAPABILITY_KEY, caps);
}
