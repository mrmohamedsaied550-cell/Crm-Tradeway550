import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from './request-id.middleware';

/**
 * Standardized error envelope returned to clients.
 *
 *   {
 *     "code":       "string snake_case error code",
 *     "message":    "human-readable message",
 *     "details":    optional additional payload (validation errors, etc.),
 *     "request_id": "uuid for correlation with logs"
 *   }
 */
export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: unknown;
  request_id: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { requestId?: string }>();
    const res = ctx.getResponse<Response>();
    const requestId =
      req.requestId ?? (req.header(REQUEST_ID_HEADER) as string | undefined) ?? 'unknown';

    const { status, code, message, details } = this.normalize(exception);

    this.logger.error({
      request_id: requestId,
      method: req.method,
      url: req.url,
      status,
      code,
      message,
      err:
        exception instanceof Error ? { name: exception.name, stack: exception.stack } : exception,
    });

    const envelope: ErrorEnvelope = {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
      request_id: requestId,
    };

    res.status(status).json(envelope);
  }

  private normalize(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'validation_error',
        message: 'Request validation failed.',
        details: exception.flatten(),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const baseCode = this.codeFromStatus(status);

      if (typeof response === 'string') {
        return { status, code: baseCode, message: response };
      }

      const body = response as {
        message?: string | string[];
        error?: string;
        code?: string;
        details?: unknown;
      };

      return {
        status,
        code: body.code ?? baseCode,
        message: Array.isArray(body.message)
          ? body.message.join('; ')
          : (body.message ?? body.error ?? this.messageFromStatus(status)),
        ...(body.details !== undefined ? { details: body.details } : {}),
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    };
  }

  private codeFromStatus(status: number): string {
    switch (status) {
      case 400:
        return 'bad_request';
      case 401:
        return 'unauthorized';
      case 403:
        return 'forbidden';
      case 404:
        return 'not_found';
      case 409:
        return 'conflict';
      case 422:
        return 'unprocessable_entity';
      case 429:
        return 'too_many_requests';
      default:
        return status >= 500 ? 'internal_error' : 'error';
    }
  }

  private messageFromStatus(status: number): string {
    return status >= 500 ? 'Internal server error.' : 'Request error.';
  }
}
