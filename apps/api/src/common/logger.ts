import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from './request-id.middleware';

/**
 * Pino logger configuration for the API.
 *
 * - JSON-structured in production for log aggregation.
 * - Pretty-printed in development for human readability.
 * - Every log line includes the request_id set by RequestIdMiddleware.
 */
export function buildLoggerConfig(env: NodeJS.ProcessEnv): Params {
  const isProd = env['NODE_ENV'] === 'production';
  const level = env['LOG_LEVEL'] ?? (isProd ? 'info' : 'debug');

  return {
    pinoHttp: {
      level,
      // request_id correlation
      genReqId: (req: IncomingMessage): string => {
        const headerValue = req.headers[REQUEST_ID_HEADER];
        if (typeof headerValue === 'string' && headerValue.length > 0) {
          return headerValue;
        }
        // Fallback (RequestIdMiddleware should have set it already, but this
        // covers the request-log boundary if Pino runs before middleware).
        return (req as IncomingMessage & { id?: string }).id ?? 'unknown';
      },
      customProps: (req: IncomingMessage) => ({
        request_id:
          (req as IncomingMessage & { id?: string }).id ??
          (req.headers[REQUEST_ID_HEADER] as string | undefined) ??
          'unknown',
      }),
      serializers: {
        req(req: IncomingMessage & { id?: string }) {
          return {
            id: req.id,
            method: req.method,
            url: req.url,
          };
        },
        res(res: ServerResponse) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
              singleLine: false,
            },
          },
    },
  };
}
