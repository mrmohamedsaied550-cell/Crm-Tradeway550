/**
 * @crm/api — root module placeholder.
 *
 * The actual NestJS AppModule is wired in C3 alongside the bootstrap, global
 * pipes, logger, error filter, and /health endpoint. C1 ships a typed marker
 * only so the workspace graph and TypeScript references resolve.
 */

export const APP_MODULE_PLACEHOLDER = 'app-module' as const;
