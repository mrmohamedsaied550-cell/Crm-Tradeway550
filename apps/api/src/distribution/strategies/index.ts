/**
 * Phase 1A — strategy registry.
 *
 * The orchestrator (DistributionService — A4) looks up the matched
 * rule's strategy here. Singletons are fine because every strategy
 * in this module is stateless and pure.
 */
import type { RoutingStrategy, StrategyName } from '../distribution.types';
import { CapacityStrategy } from './capacity.strategy';
import { RoundRobinStrategy } from './round-robin.strategy';
import { SpecificUserStrategy } from './specific-user.strategy';
import { WeightedStrategy } from './weighted.strategy';

export const STRATEGIES: Readonly<Record<StrategyName, RoutingStrategy>> = {
  specific_user: new SpecificUserStrategy(),
  round_robin: new RoundRobinStrategy(),
  weighted: new WeightedStrategy(),
  capacity: new CapacityStrategy(),
};

/**
 * Convenience helper for the orchestrator. Returns the singleton
 * for the requested strategy name. Throws on an unknown name —
 * the DTO layer guards against this at the controller boundary
 * with a zod enum, so an invalid name reaching here is a programmer
 * error, not user input.
 */
export function getStrategy(name: StrategyName): RoutingStrategy {
  const s = STRATEGIES[name];
  if (!s) throw new Error(`Unknown strategy: ${name}`);
  return s;
}

export { CapacityStrategy, RoundRobinStrategy, SpecificUserStrategy, WeightedStrategy };
