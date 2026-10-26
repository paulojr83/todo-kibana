import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ClientLogsService } from './client-logs.service';

@Controller('api/logs')
export class ClientLogsController {
  constructor(private readonly clientLogs: ClientLogsService) {}

  // O frontend envia como text/plain (via fetch keepalive ou sendBeacon) para
  // evitar o preflight de CORS; por isso o corpo pode chegar como string.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  ingest(@Body() body: unknown, @Req() req: Request) {
    let payload = body;
    if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        throw new BadRequestException('Corpo não é um JSON válido');
      }
    }

    const entries = (payload as { entries?: unknown } | null)?.entries;
    const accepted = this.clientLogs.ingest(entries, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { accepted };
  }
}
