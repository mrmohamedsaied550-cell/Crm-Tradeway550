import { Controller, Get, Logger, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { TokensService } from '../identity/tokens.service';

import { RealtimeService } from './realtime.service';
import type { RealtimeEvent } from './realtime.types';

/**
 * P3-02 — Server-Sent Events stream.
 *
 * EventSource (the browser SSE client) cannot send custom headers,
 * so we accept the access JWT as a query-string parameter instead of
 * the usual `Authorization: Bearer …` header. The token is validated
 * against the access secret and `typ=access` so a refresh token sent
 * here is rejected. The query string is opaque on HTTPS, but mind
 * that proxies / access logs may capture it; rotate aggressively if
 * a captured token is suspected leaked.
 *
 * Heartbeats: every 25s we write an SSE comment line (`: ping\n\n`)
 * so connections traversing proxies with idle timeouts (~30s for
 * many CDNs) stay open. Comments are ignored by the EventSource
 * dispatcher, so they don't trigger a `message` event on the client.
 *
 * Reconnect: EventSource auto-reconnects on transport failure with
 * exponential backoff. We send a `retry: 5000` line at connect so
 * the client baseline is 5s before its own backoff multiplier kicks
 * in. The web hook also keeps polling as a fallback when the SSE
 * channel never connects (firewalls, broken proxies).
 *
 * The route is mounted *outside* the global `api/v1` prefix
 * (`/realtime/stream`) so the service worker shell-cache rules
 * never accidentally try to cache it.
 */
@ApiTags('realtime')
@Controller({ path: 'realtime', version: undefined })
export class RealtimeController {
  private readonly logger = new Logger(RealtimeController.name);

  /** Heartbeat cadence — keep below typical proxy idle timeout. */
  private static readonly HEARTBEAT_MS = 25_000;

  constructor(
    private readonly tokens: TokensService,
    private readonly realtime: RealtimeService,
  ) {}

  @Get('stream')
  @ApiOperation({ summary: 'Subscribe to tenant + user realtime events (SSE)' })
  stream(
    @Query('token') token: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    if (!token || token.length === 0) {
      throw new UnauthorizedException({
        code: 'realtime.missing_token',
        message: 'Missing token query parameter',
      });
    }
    let claims;
    try {
      claims = this.tokens.verifyAccess(token);
    } catch {
      throw new UnauthorizedException({
        code: 'realtime.invalid_token',
        message: 'Invalid or expired token',
      });
    }

    const { sub: userId, tid: tenantId } = claims;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable Nginx/Cloudflare buffering so events flush immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    // Hint the client to wait 5s before reconnecting after a transient
    // failure. EventSource will fall back to its own backoff on top of
    // this if the server stays unreachable.
    res.write('retry: 5000\n\n');
    res.flushHeaders?.();

    // Send a hello so the client knows the channel is live; useful for
    // distinguishing "connected but quiet" from "still connecting".
    this.write(res, {
      type: 'notification.created',
      notificationId: '__hello__',
      recipientUserId: userId,
      kind: 'realtime.connected',
    });

    const unsubscribe = this.realtime.subscribe(tenantId, userId, (event) => {
      this.write(res, event);
    });

    const heartbeat = setInterval(() => {
      // Comment line — invisible to the EventSource client but keeps
      // intermediaries from closing the connection on idle timeout.
      try {
        res.write(': ping\n\n');
      } catch {
        // Write after close — bail; the close handler will clean up.
      }
    }, RealtimeController.HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      this.logger.debug(`realtime: ${tenantId}/${userId} disconnected`);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  /**
   * Write one event in SSE wire format. The `event:` line uses the
   * envelope `type` so EventSource clients can `addEventListener` per
   * event-kind if they ever want to; we still send a `data:` JSON for
   * the generic onmessage path.
   */
  private write(res: Response, event: RealtimeEvent): void {
    try {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Closed socket — the close handler will tear everything down.
    }
  }
}
