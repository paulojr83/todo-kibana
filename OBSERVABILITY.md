# Logs and Traces with Elasticsearch, Tempo and Grafana

This guide adds the observability setup from this repository to another **NestJS + React** project. You get:

- Backend and frontend logs in Elasticsearch, in [ECS](https://www.elastic.co/guide/en/ecs/current/index.html) format, browsable in Grafana.
- Distributed traces from the browser to the API to the database, stored in Tempo and browsable in Grafana (**Explore → Tempo**, **Drilldown → Traces**).
- Two-way correlation: backend logs written during a request, and the frontend's per-API-call logs, carry `trace.id`. In Grafana, a log opens its trace, and a span opens its logs. Frontend logs written outside an API call have no active span, so they have no `trace.id`.
- In development, the browser console prints a Grafana link for every API call:

  ```
  [Trace] 62523ee09cdea2e74ca7d1af347cb5d9
  http://localhost:3030/explore?...panes=... GET
  http://localhost:3010/api/todos
  ```

Replace `myapp` everywhere with your project's name.

---

## Architecture

| Signal | Path | Stored in |
| :--- | :--- | :--- |
| Backend logs | `nestjs-pino` → `pino-elasticsearch` (bulk) | ES data stream `logs-myapp.backend-default` |
| Frontend logs | browser logger → `POST /api/logs` (batched, `text/plain`) → backend → ES bulk | ES data stream `logs-myapp.frontend-default` |
| Traces (browser + backend) | OpenTelemetry → OTLP/HTTP → Tempo `:4318` | Tempo |

Grafana reads both stores. A trace starts in the browser: every API call becomes a span, and its context travels to the backend in the `traceparent` header.

| Sent by the browser | Becomes, in the logs | Use it to find |
| :--- | :--- | :--- |
| `traceparent` header | `trace.id` | a whole trace, logs ↔ spans |
| `x-request-id` header | `http.request.id` | one API call on both sides |
| `x-session-id` header | `labels.session_id` | everything from one browser tab |

**Left out on purpose.** You don't need these:

- **Grafana Alloy / OpenTelemetry Collector.** Tempo's OTLP receiver supports CORS, so the backend and the browser send to it directly. Add a collector only if you need to send traces to several backends, sample them, or add Kubernetes metadata.
- **Kibana and APM Server.** Grafana already shows both logs and traces.
- **Prometheus.** It only feeds Tempo's Service Graph / span metrics. The Drilldown → Traces app works without it.

## Versions

| Component | Version tested | Notes |
| :--- | :--- | :--- |
| Elasticsearch | 8.19.0 | Don't use 8.0.0: its bundled JDK crashes on cgroup v2 hosts. Keep `@elastic/elasticsearch` on the same major as the server. |
| Tempo | 2.8.2 | |
| Grafana | 12.2.0 | The Drilldown → Traces app is built in. |
| Node.js (backend) | 20.x, at least 20.12 | `process.loadEnvFile` is used before Nest starts. |
| NestJS | 10 (Express platform) | `nestjs-pino` 4.x supports Nest 8–11. Version 5.x needs Nest 11 and Node 22. |
| OpenTelemetry JS, backend | `sdk-node` 0.222 / `core` 2.11 | |
| OpenTelemetry JS, browser | 1.30.1 / 0.57.2 | OTel JS 2.x needs TypeScript 5, but Create React App 5 is stuck on TypeScript 4.9. See the note in section 3. |

---

## 1. Infrastructure

```
docker-compose.yml
tempo/
  Dockerfile
  tempo.yaml
grafana/
  Dockerfile
  provisioning/datasources/datasources.yml
```

The Tempo and Grafana configs are copied into custom images instead of bind-mounted. That way they also work with Docker Desktop on WSL without the WSL integration enabled, which is when bind mounts from WSL paths fail. After editing a config, run `docker compose up -d --build <service>`.

```yaml
# docker-compose.yml (observability services only; add them to your file)
services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.19.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false # development only
      - "ES_JAVA_OPTS=-Xms512m -Xmx512m"
    ports:
      - "9200:9200"
    volumes:
      - elasticsearch_data:/usr/share/elasticsearch/data
    healthcheck:
      test: ["CMD-SHELL", "curl -s http://localhost:9200/_cluster/health?local=true | grep -q '\"status\":\"green\"\\|\"status\":\"yellow\"'"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 60s

  tempo:
    build: ./tempo
    command: ["-config.file=/etc/tempo.yaml"]
    ports:
      - "4317:4317" # OTLP gRPC
      - "4318:4318" # OTLP HTTP: backend and browser send traces here
    volumes:
      - tempo_data:/var/tempo

  grafana:
    build: ./grafana
    depends_on:
      elasticsearch:
        condition: service_healthy
      tempo:
        condition: service_started
    ports:
      - "3030:3000" # host port 3000 is usually taken by the frontend dev server
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_AUTH_ANONYMOUS_ENABLED=true
      - GF_AUTH_ANONYMOUS_ORG_ROLE=Editor # Explore requires at least Editor
    volumes:
      - grafana_data:/var/lib/grafana

volumes:
  elasticsearch_data:
  tempo_data:
  grafana_data:
```

```dockerfile
# tempo/Dockerfile
# The Tempo image is distroless and runs as 10001. Create the data directory
# with that owner so the named volume mounted there inherits the permission.
FROM busybox:1.36 AS data
RUN mkdir -p /var/tempo

FROM grafana/tempo:2.8.2
COPY --from=data --chown=10001:10001 /var/tempo /var/tempo
COPY tempo.yaml /etc/tempo.yaml
```

```yaml
# tempo/tempo.yaml
# Single-binary Tempo for development: receives OTLP directly from the backend
# and the browser, stores traces on local disk.
stream_over_http_enabled: true

server:
  http_listen_port: 3200
  log_level: warn

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
          # The browser sends spans straight to Tempo, from another origin.
          # List every origin the frontend is served from.
          cors:
            allowed_origins: ["http://localhost:3000"]

ingester:
  max_block_duration: 5m

compactor:
  compaction:
    block_retention: 72h

# Local blocks power TraceQL metrics, used by Grafana's Drilldown > Traces app.
metrics_generator:
  storage:
    path: /var/tempo/generator/wal
  traces_storage:
    path: /var/tempo/generator/traces
  processor:
    local_blocks:
      filter_server_spans: false
      flush_to_storage: true

storage:
  trace:
    backend: local
    wal:
      path: /var/tempo/wal
    local:
      path: /var/tempo/blocks

overrides:
  defaults:
    metrics_generator:
      processors: [local-blocks]
```

```dockerfile
# grafana/Dockerfile
FROM grafana/grafana:12.2.0
COPY provisioning /etc/grafana/provisioning
```

```yaml
# grafana/provisioning/datasources/datasources.yml
# In provisioning files, `$$` keeps Grafana from reading ${...} as an environment variable.
apiVersion: 1

datasources:
  - name: Logs (Elasticsearch)
    uid: logs
    type: elasticsearch
    access: proxy
    url: http://elasticsearch:9200
    isDefault: true
    editable: false
    jsonData:
      index: 'logs-myapp.*'
      timeField: '@timestamp'
      logMessageField: message
      logLevelField: log.level
      # In a log's details, trace.id opens the trace in Tempo.
      dataLinks:
        - field: trace.id
          datasourceUid: tempo
          url: '$${__value.raw}'
          urlDisplayLabel: View trace in Tempo

  - name: Tempo
    uid: tempo # the frontend's console links use this uid
    type: tempo
    access: proxy
    url: http://tempo:3200
    editable: false
    jsonData:
      # Span -> logs with the same trace.id in Elasticsearch.
      tracesToLogsV2:
        datasourceUid: logs
        spanStartTimeShift: '-5m'
        spanEndTimeShift: '5m'
        customQuery: true
        query: 'trace.id:"$${__trace.traceId}"'
      nodeGraph:
        enabled: true
      traceQuery:
        timeShiftEnabled: true
        spanStartTimeShift: '-30m'
        spanEndTimeShift: '30m'
      streamingEnabled:
        search: true
        metrics: true
```

Start everything:

```bash
docker compose up -d --build
```

---

## 2. Backend (NestJS)

**Requirements**
- `tsconfig.json` has `"esModuleInterop": true`. `pino-elasticsearch` has no default export, so without it the logger crashes at startup.
- `@nestjs/config` is installed and `ConfigModule` is global.

```bash
npm install nestjs-pino@^4.6.1 pino-http@^10.5.0 pino@^9.14.0 pino-pretty@^13.1.3 pino-elasticsearch@^8.1.0 @elastic/ecs-pino-format@^1.5.0 @elastic/elasticsearch@^8.19.1 @nestjs/config @opentelemetry/api@^1.9.0 @opentelemetry/core@^2.11.0 @opentelemetry/sdk-node@^0.222.0 @opentelemetry/auto-instrumentations-node@^0.80.0 @opentelemetry/exporter-trace-otlp-proto@^0.222.0 @opentelemetry/resources@^2.11.0 @opentelemetry/instrumentation-express@^0.70.0
```

```
src/
  tracing.ts                     OpenTelemetry SDK (first import of main.ts)
  main.ts                        logger, text body parser, CORS
  app.module.ts                  imports LoggingModule
  logging/
    logging.constants.ts         names, indices, headers
    elastic-stream.ts            resilient pino -> Elasticsearch stream
    logger.config.ts             nestjs-pino / pino-http options (ECS)
    logging.module.ts
    client-logs.controller.ts    POST /api/logs (frontend logs)
    client-logs.service.ts       frontend entry -> ECS document -> bulk
```

```ts
// src/logging/logging.constants.ts
export const DEFAULT_ELASTICSEARCH_NODE = 'http://localhost:9200';

// Use the same service names in both tracing files so logs and traces line up.
export const BACKEND_SERVICE = 'myapp-backend';
export const FRONTEND_SERVICE = 'myapp-frontend';

// Data streams named logs-<dataset>-<namespace> get Elasticsearch 8's built-in
// "logs" index template (ECS mappings + lifecycle) with no extra setup.
export const BACKEND_DATASET = 'myapp.backend';
export const FRONTEND_DATASET = 'myapp.frontend';
export const BACKEND_LOGS_INDEX = `logs-${BACKEND_DATASET}-default`;
export const FRONTEND_LOGS_INDEX = `logs-${FRONTEND_DATASET}-default`;

export const REQUEST_ID_HEADER = 'x-request-id';
export const SESSION_ID_HEADER = 'x-session-id';
```

```ts
// src/tracing.ts
// OpenTelemetry: must be the FIRST import of main.ts, before any module it
// instruments (http, express, nest, mongodb, pino).
import type { IncomingMessage } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BACKEND_SERVICE } from './logging/logging.constants';

// Nest's ConfigModule loads .env later; read it now so OTEL_* can live there too.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file: use environment variables / defaults
}

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': BACKEND_SERVICE,
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Frontend log shipping and CORS preflights are not application traffic.
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          req.method === 'OPTIONS' || (req.url ?? '').startsWith('/api/logs'),
        // Outgoing calls made outside a request (timers, startup) don't start traces of their own.
        requireParentforOutgoingSpans: true,
      },
      '@opentelemetry/instrumentation-undici': { requireParentforSpans: true },
      // One span per Express middleware (cors, json, ...) only clutters the waterfall.
      '@opentelemetry/instrumentation-express': {
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
        // Catch-all handlers registered by Nest ("request handler - /*").
        ignoreLayers: [/^request handler - \/\*$/],
      },
      // mongoose would duplicate the spans of the mongodb driver instrumentation (harmless if unused).
      '@opentelemetry/instrumentation-mongoose': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // Adds trace.id / span.id (ECS names) to every pino log line.
      '@opentelemetry/instrumentation-pino': {
        disableLogSending: true,
        logKeys: { traceId: 'trace.id', spanId: 'span.id', traceFlags: 'trace.flags' },
      },
    }),
  ],
});

if (process.env.OTEL_SDK_DISABLED !== 'true') {
  sdk.start();
}
```

```ts
// src/logging/elastic-stream.ts
import { Writable } from 'node:stream';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import pinoElastic, { DestinationStream } from 'pino-elasticsearch';

const RECONNECT_DELAY_MS = 10_000;

// Log shipping is not application traffic. Without this, every flush to ES
// becomes a span (the Elasticsearch client has built-in OpenTelemetry) and gets
// attached to whatever trace created the stream, e.g. "Create Nest App" at boot.
export const NO_TRACING = suppressTracing(ROOT_CONTEXT);

interface ElasticStreamOptions {
  node: string;
  index: string;
  flushInterval?: number;
}

/**
 * pino -> Elasticsearch stream that survives cluster outages.
 *
 * The bulk helper used by pino-elasticsearch aborts for good on the first
 * connection error (e.g. backend started before ES), and no log reaches ES after
 * that. Here the stream is recreated after a delay; lines written while ES is
 * down are dropped (the console still gets everything).
 */
export function createElasticStream({ node, index, flushInterval = 2000 }: ElasticStreamOptions): Writable {
  let target: DestinationStream | null = null;

  const connect = () => {
    const stream = pinoElastic({ node, index, esVersion: 8, opType: 'create', flushBytes: 1000, flushInterval });

    stream.on('error', (err) => {
      if (target !== stream) return;
      target = null;
      process.stderr.write(
        `[elastic-stream] failed to ship logs to ${node}: ${err.message}. Retrying in ${RECONNECT_DELAY_MS / 1000}s\n`,
      );
      setTimeout(() => context.with(NO_TRACING, connect), RECONNECT_DELAY_MS).unref();
    });

    stream.on('insertError', (err) => {
      const reason = err.document?.error?.reason ?? err.message;
      process.stderr.write(`[elastic-stream] log rejected by Elasticsearch: ${reason}\n`);
    });

    target = stream;
  };

  context.with(NO_TRACING, connect);

  return new Writable({
    write(chunk, _encoding, callback) {
      context.with(NO_TRACING, () => target?.write(chunk));
      callback();
    },
  });
}
```

```ts
// src/logging/logger.config.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import ecsFormat from '@elastic/ecs-pino-format';
import pino from 'pino';
import type { Options } from 'pino-http';
import pretty from 'pino-pretty';
import type { Params } from 'nestjs-pino';
import { createElasticStream } from './elastic-stream';
import {
  BACKEND_DATASET,
  BACKEND_LOGS_INDEX,
  BACKEND_SERVICE,
  REQUEST_ID_HEADER,
  SESSION_ID_HEADER,
} from './logging.constants';

interface LoggerSettings {
  level: pino.Level;
  environment: string;
  elasticsearchNode: string;
  logToElasticsearch: boolean;
}

// Accept ids sent by the frontend only if they look like ids.
const VALID_ID = /^[\w-]{1,64}$/;

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && VALID_ID.test(value) ? value : undefined;
}

function requestPath(req: IncomingMessage): string {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  return url.split('?')[0];
}

// Express route that handled the request (e.g. /api/items/:id), to group by
// route instead of by id. Missing when no route matched (404).
function routeTemplate(req: IncomingMessage): string | undefined {
  const { route, baseUrl } = req as IncomingMessage & { route?: { path?: string }; baseUrl?: string };
  return typeof route?.path === 'string' ? `${baseUrl ?? ''}${route.path}` : undefined;
}

// ECS fields built by hand: ecs-pino-format's convertReqRes doesn't see the
// `req` that pino-http puts in the child logger's bindings.
function httpFields(req: IncomingMessage, res: ServerResponse, responseTime: number) {
  return {
    'http.request.method': req.method,
    'url.path': requestPath(req),
    'http.route': routeTemplate(req),
    'http.response.status_code': res.statusCode,
    'event.duration': Math.round(responseTime * 1e6), // ECS uses nanoseconds
    'client.ip': req.socket?.remoteAddress,
    'user_agent.original': req.headers['user-agent'],
    'labels.session_id': headerValue(req, SESSION_ID_HEADER),
  };
}

function httpOptions(settings: LoggerSettings): Options {
  return {
    ...ecsFormat({
      serviceName: BACKEND_SERVICE,
      serviceEnvironment: settings.environment,
      eventDataset: BACKEND_DATASET,
    }),
    level: settings.level,
    // App logs only carry the request id; the rest goes on the completion line.
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'http.request.id' },
    genReqId: (req, res) => {
      const id = headerValue(req, REQUEST_ID_HEADER) ?? randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    autoLogging: {
      // Preflights and the frontend's own log shipping would only add noise.
      ignore: (req) => req.method === 'OPTIONS' || requestPath(req) === '/api/logs',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${requestPath(req)} ${res.statusCode} ${Math.round(responseTime)}ms`,
    customErrorMessage: (req, res, err) => `${req.method} ${requestPath(req)} ${res.statusCode} - ${err.message}`,
    customSuccessObject: (req, res, val) => httpFields(req, res, val.responseTime),
    // No stack here: Nest's ExceptionsHandler already logs the real exception with its stack.
    customErrorObject: (req, res, err, val) => ({
      ...httpFields(req, res, val.responseTime),
      'error.message': err.message,
    }),
  };
}

// Readable console in development; plain JSON lines in production.
function consoleStream(environment: string) {
  if (environment === 'production') return process.stdout;

  return pretty({
    colorize: true,
    levelKey: 'log\\.level',
    messageKey: 'message',
    timestampKey: '@timestamp',
    translateTime: 'SYS:HH:MM:ss.l',
    messageFormat: (log, messageKey) => {
      const context = log['log.logger'] ?? 'HTTP';
      const requestId = log['http.request.id'];
      const stack = (log.error as { stack_trace?: string } | undefined)?.stack_trace;
      const line = `[${context}] ${log[messageKey]}${requestId ? ` (${String(requestId).slice(0, 8)})` : ''}`;
      return stack ? `${line}\n${stack}` : line;
    },
    hideObject: true,
  });
}

export function buildLoggerParams(settings: LoggerSettings): Params {
  const streams: pino.StreamEntry[] = [{ level: settings.level, stream: consoleStream(settings.environment) }];

  if (settings.logToElasticsearch) {
    streams.push({
      level: settings.level,
      stream: createElasticStream({ node: settings.elasticsearchNode, index: BACKEND_LOGS_INDEX }),
    });
  }

  return {
    renameContext: 'log.logger',
    pinoHttp: [httpOptions(settings), pino.multistream(streams)],
  };
}
```

```ts
// src/logging/logging.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Level } from 'pino';
import { ClientLogsController } from './client-logs.controller';
import { ClientLogsService } from './client-logs.service';
import { buildLoggerParams } from './logger.config';
import { DEFAULT_ELASTICSEARCH_NODE } from './logging.constants';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildLoggerParams({
          level: config.get<Level>('LOG_LEVEL', 'info'),
          environment: config.get('NODE_ENV', 'development'),
          elasticsearchNode: config.get('ELASTICSEARCH_NODE', DEFAULT_ELASTICSEARCH_NODE),
          logToElasticsearch: config.get('LOG_TO_ELASTICSEARCH', 'true') !== 'false',
        }),
    }),
  ],
  controllers: [ClientLogsController],
  providers: [ClientLogsService],
})
export class LoggingModule {}
```

```ts
// src/logging/client-logs.controller.ts
import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ClientLogsService } from './client-logs.service';

@Controller('api/logs')
export class ClientLogsController {
  constructor(private readonly clientLogs: ClientLogsService) {}

  // The frontend sends text/plain (fetch or sendBeacon) to avoid the CORS
  // preflight, so the body may arrive as a string.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  ingest(@Body() body: unknown, @Req() req: Request) {
    let payload = body;
    if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        throw new BadRequestException('Body is not valid JSON');
      }
    }

    const entries = (payload as { entries?: unknown } | null)?.entries;
    const accepted = this.clientLogs.ingest(entries, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { accepted };
  }
}
```

```ts
// src/logging/client-logs.service.ts
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import { context } from '@opentelemetry/api';
import { NO_TRACING } from './elastic-stream';
import {
  DEFAULT_ELASTICSEARCH_NODE,
  FRONTEND_DATASET,
  FRONTEND_LOGS_INDEX,
  FRONTEND_SERVICE,
} from './logging.constants';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const MAX_ENTRIES_PER_REQUEST = 100;
const MAX_LABELS = 20;

export interface ClientMetadata {
  ip?: string;
  userAgent?: string;
}

type Entry = Record<string, unknown>;

function str(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown): Entry {
  return isRecord(value) ? value : {};
}

// Drops undefined fields and empty objects. An indexed `labels: {}` shows up in
// Grafana as a bare "labels" field, which the logs panel treats as the row's
// labels and fails ("Need parsed labels to find common labels").
function compact(value: Entry): Entry {
  const result: Entry = {};
  for (const [key, child] of Object.entries(value)) {
    const cleaned = isRecord(child) ? compact(child) : child;
    if (cleaned === undefined || (isRecord(cleaned) && Object.keys(cleaned).length === 0)) continue;
    result[key] = cleaned;
  }
  return result;
}

// W3C Trace Context trace id (32 hex chars) created by the browser.
function traceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

function timestamp(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// Free-form frontend context becomes `labels` (keyword), so the browser can't
// create arbitrary fields in the data stream mapping.
function labels(sessionId: string | undefined, page: string | undefined, context: Entry) {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(context).slice(0, MAX_LABELS)) {
    if (/^\w{1,40}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = String(value).slice(0, 1024);
    }
  }
  if (sessionId) result.session_id = sessionId;
  if (page) result.page_url = page;
  return result;
}

/** Turns an entry sent by the browser into an ECS document. */
function toEcsDocument(raw: unknown, meta: ClientMetadata) {
  const entry = obj(raw);
  const http = obj(entry.http);
  const error = obj(entry.error);
  const durationMs = num(http.durationMs);
  const level = str(entry.level);

  return compact({
    '@timestamp': timestamp(entry.timestamp),
    message: str(entry.message, 8192) ?? '',
    log: { level: level && LEVELS.has(level) ? level : 'info', logger: str(entry.logger, 128) },
    service: { name: FRONTEND_SERVICE },
    event: {
      dataset: FRONTEND_DATASET,
      duration: durationMs === undefined ? undefined : Math.round(durationMs * 1e6),
    },
    http: {
      request: { id: str(entry.requestId, 64), method: str(http.method, 16) },
      response: { status_code: num(http.statusCode) },
    },
    url: { path: str(http.path, 2048) },
    trace: { id: traceId(entry.traceId) },
    error: str(error.message)
      ? { type: str(error.type, 128), message: str(error.message, 8192), stack_trace: str(error.stack, 16384) }
      : undefined,
    labels: labels(str(entry.sessionId, 64), str(entry.page, 2048), obj(entry.context)),
    client: { ip: meta.ip },
    user_agent: { original: str(meta.userAgent, 1024) },
  });
}

@Injectable()
export class ClientLogsService implements OnModuleDestroy {
  private readonly logger = new Logger(ClientLogsService.name);
  private readonly client: Client;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get('LOG_TO_ELASTICSEARCH', 'true') !== 'false';
    this.client = new Client({ node: config.get('ELASTICSEARCH_NODE', DEFAULT_ELASTICSEARCH_NODE) });
  }

  /** Indexes the entries in the background and returns how many were accepted. */
  ingest(entries: unknown, meta: ClientMetadata): number {
    const docs = (Array.isArray(entries) ? entries : [])
      .slice(0, MAX_ENTRIES_PER_REQUEST)
      .map((entry) => toEcsDocument(entry, meta));

    if (docs.length === 0 || !this.enabled) return docs.length;

    context
      .with(NO_TRACING, () =>
        this.client.bulk({ operations: docs.flatMap((doc) => [{ create: { _index: FRONTEND_LOGS_INDEX } }, doc]) }),
      )
      .then((response) => {
        if (!response.errors) return;
        const failed = response.items.filter((item) => item.create?.error);
        this.logger.warn(`${failed.length} frontend logs rejected by Elasticsearch: ${failed[0]?.create?.error?.reason}`);
      })
      .catch((err: Error) => this.logger.warn(`Failed to index frontend logs: ${err.message}`));

    return docs.length;
  }

  async onModuleDestroy() {
    await this.client.close();
  }
}
```

Wire it up in `main.ts` and `app.module.ts`. Keep your own modules and port; the lines below are the ones that matter.

```ts
// src/main.ts
import './tracing'; // OpenTelemetry: must come before every other import
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Frontend logs arrive as text/plain (no CORS preflight; works with sendBeacon).
  app.useBodyParser('text', { type: 'text/plain', limit: '256kb' });

  // Origins the FRONTEND is served from, not the backend's own port. With no
  // allowedHeaders set, the cors middleware accepts traceparent, x-request-id and x-session-id.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3000').split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  logger.log(`Backend listening on port ${port}`, 'Bootstrap');
}

bootstrap();
```

```ts
// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggingModule } from './logging/logging.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggingModule,
    // ...your modules
  ],
})
export class AppModule {}
```

Keep using Nest's `Logger` as usual (`new Logger(MyService.name).log(...)`): it now goes through pino, with `log.logger` set to the class name.

---

## 3. Frontend (React)

The code targets Create React App 5, which needs TypeScript 4.9, so it uses the OpenTelemetry JS **1.x** browser packages. If your frontend runs TypeScript 5 (Vite, Next.js…), OTel JS 2.x should also work; in `tracing.ts`, replace `new Resource({...})` with `resourceFromAttributes({...})` from `@opentelemetry/resources`. The 2.x variant was not tested here.

```bash
npm install @opentelemetry/api@^1.9.0 @opentelemetry/core@1.30.1 @opentelemetry/sdk-trace-web@1.30.1 @opentelemetry/sdk-trace-base@1.30.1 @opentelemetry/resources@1.30.1 @opentelemetry/exporter-trace-otlp-http@0.57.2 @opentelemetry/instrumentation@0.57.2 @opentelemetry/instrumentation-document-load@0.44.1
```

```
src/
  index.tsx                  starts tracing and log capture before rendering
  observability/
    logger.ts                createLogger(), batching, global error capture
    tracing.ts               OTel provider, Grafana trace links
    http.ts                  instrumentAxios(): span + traceparent + log per call
```

```ts
// src/observability/logger.ts
// Browser logger: mirrors to the console and ships batches to the backend
// (POST /api/logs), which indexes them into logs-myapp.frontend-default.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  requestId?: string;
  traceId?: string;
  error?: unknown;
  http?: { method?: string; path?: string; statusCode?: number; durationMs?: number };
  context?: Record<string, string | number | boolean | null | undefined>;
}

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  logger: string;
  sessionId: string;
  page: string;
  requestId?: string;
  traceId?: string;
  error?: { type?: string; message: string; stack?: string };
  http?: LogFields['http'];
  context?: LogFields['context'];
}

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';
const LOGS_ENDPOINT = `${API_URL}/api/logs`;
const SESSION_KEY = 'myapp-log-session-id';
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 500;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function parseLevel(value: string | undefined): LogLevel | undefined {
  return value && value in LEVEL_ORDER ? (value as LogLevel) : undefined;
}

const minLevel: LogLevel =
  parseLevel(process.env.REACT_APP_LOG_LEVEL) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function loadSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = createId();
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return createId();
  }
}

/** Identifies the browser tab; also sent as the x-session-id header on API calls. */
export const sessionId = loadSessionId();

let queue: LogEntry[] = [];

// Original fetch, captured before any tracing instrumentation could wrap it:
// log shipping must not become a span nor carry a traceparent header.
const nativeFetch = window.fetch.bind(window);

let traceIdProvider: () => string | undefined = () => undefined;

/** Registered by tracing.ts to attach the current trace.id to every log. */
export function setTraceIdProvider(provider: () => string | undefined) {
  traceIdProvider = provider;
}

function serializeError(error: unknown): LogEntry['error'] {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) {
    return {
      type: error.name,
      message: error.message.slice(0, MAX_MESSAGE_LENGTH),
      stack: error.stack?.slice(0, MAX_STACK_LENGTH),
    };
  }
  return { type: typeof error, message: String(error).slice(0, MAX_MESSAGE_LENGTH) };
}

function enqueue(entry: LogEntry) {
  queue.push(entry);
  if (queue.length > MAX_QUEUE_SIZE) queue = queue.slice(-MAX_QUEUE_SIZE);
  if (queue.length >= MAX_BATCH_SIZE) flushLogs();
}

// text/plain is a "simple" content type: no CORS preflight, which is what lets
// sendBeacon deliver the last batch while the page is closing.
export function flushLogs(onPageHide = false) {
  while (queue.length > 0) {
    const batch = queue.splice(0, MAX_BATCH_SIZE);
    const body = JSON.stringify({ entries: batch });

    if (onPageHide && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon(LOGS_ENDPOINT, new Blob([body], { type: 'text/plain' }));
      continue;
    }

    sendBatch(batch, body);
  }
}

function sendBatch(batch: LogEntry[], body: string) {
  nativeFetch(LOGS_ENDPOINT, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' } })
    .then((response) => {
      // A 4xx won't succeed on retry: drop the batch.
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    })
    .catch(() => {
      // Backend unreachable: put the batch back and retry on the next cycle.
      queue = [...batch, ...queue].slice(-MAX_QUEUE_SIZE);
    });
}

function write(level: LogLevel, logger: string, message: string, fields: LogFields = {}) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const consoleArgs: unknown[] = [`[${logger}] ${message}`];
  if (fields.error !== undefined) consoleArgs.push(fields.error);
  if (fields.context) consoleArgs.push(fields.context);
  console[level](...consoleArgs);

  enqueue({
    timestamp: new Date().toISOString(),
    level,
    message: message.slice(0, MAX_MESSAGE_LENGTH),
    logger,
    sessionId,
    page: window.location.href,
    requestId: fields.requestId,
    traceId: fields.traceId ?? traceIdProvider(),
    error: serializeError(fields.error),
    http: fields.http,
    context: fields.context,
  });
}

export function createLogger(name: string) {
  return {
    debug: (message: string, fields?: LogFields) => write('debug', name, message, fields),
    info: (message: string, fields?: LogFields) => write('info', name, message, fields),
    warn: (message: string, fields?: LogFields) => write('warn', name, message, fields),
    error: (message: string, fields?: LogFields) => write('error', name, message, fields),
  };
}

export type Logger = ReturnType<typeof createLogger>;

let installed = false;

/** Captures uncaught errors and schedules the periodic flush. */
export function installLogCapture() {
  if (installed) return;
  installed = true;

  const log = createLogger('window');

  window.addEventListener('error', (event) => {
    log.error(event.message || 'Unhandled error', {
      error: event.error ?? event.message,
      context: { source: event.filename, line: event.lineno, column: event.colno },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    log.error('Unhandled promise rejection', { error: event.reason });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLogs(true);
  });
  window.addEventListener('pagehide', () => flushLogs(true));

  window.setInterval(() => flushLogs(), FLUSH_INTERVAL_MS);
}
```

```ts
// src/observability/tracing.ts
import { trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { setTraceIdProvider } from './logger';

const OTLP_ENDPOINT = process.env.REACT_APP_OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const GRAFANA_URL = process.env.REACT_APP_GRAFANA_URL || 'http://localhost:3030';
// Fixed window around the request: the link still opens the trace hours later.
const TRACE_LINK_WINDOW_MS = 15 * 60 * 1000;

/**
 * OpenTelemetry in the browser: spans go over OTLP straight to Tempo. The API
 * call spans are created in http.ts, which also sends traceparent to the backend.
 */
export function startTracing() {
  if (process.env.REACT_APP_OTEL_ENABLED === 'false') return;

  const provider = new WebTracerProvider({
    resource: new Resource({
      'service.name': 'myapp-frontend',
      'deployment.environment.name': process.env.NODE_ENV,
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        // `headers` forces XHR: browsers block sendBeacon with a JSON body to another origin.
        new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces`, headers: {} }),
      ),
    ],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });

  // Page load timings (documentFetch, resourceFetch, ...).
  registerInstrumentations({ instrumentations: [new DocumentLoadInstrumentation()] });

  setTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId);
}

/** Link to the trace in Grafana (Explore > Tempo). */
export function grafanaTraceUrl(traceId: string, at = Date.now()): string {
  const panes = {
    trace: {
      datasource: 'tempo',
      queries: [{ refId: 'A', datasource: { type: 'tempo', uid: 'tempo' }, queryType: 'traceql', query: traceId }],
      range: { from: String(at - TRACE_LINK_WINDOW_MS), to: String(at + TRACE_LINK_WINDOW_MS) },
    },
  };
  return `${GRAFANA_URL}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`;
}

/** Development only: prints the trace link of an API call to the console. */
export function printTraceLink(traceId: string, method: string, url: string) {
  if (process.env.NODE_ENV !== 'development') return;
  console.log(`[Trace] ${traceId}\n${grafanaTraceUrl(traceId)} ${method}\n${url}`);
}
```

```ts
// src/observability/http.ts
import type { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { context, isSpanContextValid, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { createId, createLogger, sessionId } from './logger';
import type { LogLevel } from './logger';
import { printTraceLink } from './tracing';

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    metadata?: { requestId: string; startedAt: number; span: Span };
  }
}

const log = createLogger('http');
const tracer = trace.getTracer('myapp-frontend-http');

const ID_SEGMENT = /^(\d+|[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Ids in the path become :id in the span name: one name per route, not per record.
function routeOf(path: string | undefined): string {
  return (path ?? '')
    .split('?')[0]
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

/**
 * Adds tracing and logging to an axios instance. Each call becomes a CLIENT span
 * whose context goes to the backend in the traceparent header, so the backend
 * continues the same trace. It also logs one line and, in development, prints
 * the Grafana link.
 */
export function instrumentAxios(api: AxiosInstance): AxiosInstance {
  api.interceptors.request.use((config) => {
    const requestId = createId();
    const method = config.method?.toUpperCase() ?? 'GET';
    const span = tracer.startSpan(`${method} ${routeOf(config.url)}`, {
      kind: SpanKind.CLIENT,
      attributes: { 'http.request.method': method, 'url.full': api.getUri(config) },
    });

    const carrier: Record<string, string> = {};
    propagation.inject(trace.setSpan(context.active(), span), carrier);
    for (const [header, value] of Object.entries(carrier)) config.headers.set(header, value);

    config.headers.set('x-request-id', requestId);
    config.headers.set('x-session-id', sessionId);
    config.metadata = { requestId, startedAt: performance.now(), span };
    return config;
  });

  const finish = (config: InternalAxiosRequestConfig | undefined, statusCode?: number, error?: AxiosError) => {
    const method = config?.method?.toUpperCase();
    const path = config?.url;
    const durationMs = config?.metadata ? Math.round(performance.now() - config.metadata.startedAt) : undefined;

    // Success -> info; 4xx -> warn; 5xx or no response (network/CORS) -> error.
    const level: LogLevel = !error ? 'info' : statusCode && statusCode < 500 ? 'warn' : 'error';

    const span = config?.metadata?.span;
    if (span) {
      if (statusCode) span.setAttribute('http.response.status_code', statusCode);
      if (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      span.end();
    }
    const spanContext = span?.spanContext();
    const traceId = spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
    if (traceId && config) printTraceLink(traceId, method ?? '', api.getUri(config));

    log[level](`${method} ${path} ${statusCode ?? 'no response'} ${durationMs ?? '?'}ms`, {
      requestId: config?.metadata?.requestId,
      traceId,
      error,
      http: { method, path, statusCode, durationMs },
    });
  };

  api.interceptors.response.use(
    (response) => {
      finish(response.config, response.status);
      return response;
    },
    (error: AxiosError) => {
      finish(error.config, error.response?.status, error);
      return Promise.reject(error);
    },
  );

  return api;
}
```

Use the instrumented instance for every API call. Start tracing and log capture before rendering:

```ts
// src/services/api.ts
import axios from 'axios';
import { instrumentAxios } from '../observability/http';

export const api = instrumentAxios(axios.create({ baseURL: process.env.REACT_APP_API_URL }));
```

```tsx
// src/index.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLogCapture } from './observability/logger';
import { startTracing } from './observability/tracing';

startTracing();
installLogCapture();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Log from anywhere with a named logger:

```ts
// example: src/components/ItemList.tsx
import { createLogger } from '../observability/logger';

const log = createLogger('ItemList');

export function reportLoadFailure(error: unknown) {
  log.error('Failed to load items', { error, context: { page: 1 } });
}
```

---

## 4. Environment variables

| Variable | Side | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `ELASTICSEARCH_NODE` | backend | `http://localhost:9200` | Where logs are shipped |
| `LOG_TO_ELASTICSEARCH` | backend | `true` | `false` keeps logs on the console only |
| `LOG_LEVEL` | backend | `info` | `debug`, `info`, `warn`, `error` |
| `NODE_ENV` | backend | `development` | `production` switches the console to JSON lines |
| `CORS_ORIGINS` | backend | `http://localhost:3000` | Comma-separated **frontend** origins |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | backend | `http://localhost:4318` | Tempo's OTLP HTTP endpoint |
| `OTEL_SDK_DISABLED` | backend | `false` | `true` turns tracing off |
| `REACT_APP_API_URL` | frontend | `http://localhost:3000` | Backend base URL (logs go to `<url>/api/logs`) |
| `REACT_APP_LOG_LEVEL` | frontend | `debug` in dev, `info` in builds | Minimum level shipped |
| `REACT_APP_OTEL_EXPORTER_OTLP_ENDPOINT` | frontend | `http://localhost:4318` | Tempo's OTLP HTTP endpoint, as seen from the browser |
| `REACT_APP_OTEL_ENABLED` | frontend | `true` | `false` turns tracing off |
| `REACT_APP_GRAFANA_URL` | frontend | `http://localhost:3030` | Grafana used in the dev-only `[Trace]` console links |

With Vite, use `import.meta.env.VITE_*` instead of `process.env.REACT_APP_*`.

---

## 5. Using it

Grafana is at <http://localhost:3030>. Anonymous users are Editors; log in as `admin` / `admin` to change settings.

- **Explore → Tempo:** paste a trace ID in the TraceQL tab, or use Search (filter by service, span name, duration, status).
- **Drilldown → Traces:** browse by clicking, with rate / errors / duration breakdowns and no query needed.
- **Explore → Logs (Elasticsearch):** filter with Lucene, e.g. `service.name:"myapp-backend" AND log.level:error`.
- **Log → trace:** open a log line and click **View trace in Tempo** on `trace.id`.
- **Span → logs:** the logs icon on a span lists the backend and frontend logs with that `trace.id`.
- **Browser console (dev):** every API call prints `[Trace] <id>` plus a link to that trace.

### Verify the setup

1. Start the stack, the backend and the frontend, then use the app for a moment.
2. Check that logs reached Elasticsearch. You should see a count for both data streams:

   ```bash
   curl -s 'http://localhost:9200/logs-myapp.*/_count'
   ```

3. Check that Tempo has traces:

   ```bash
   curl -s -u admin:admin 'http://localhost:3030/api/datasources/proxy/uid/tempo/api/search?limit=5'
   ```

4. In the browser console, open a `[Trace]` link. The waterfall should start with the `myapp-frontend` span and continue into `myapp-backend`.

---

## 6. Pitfalls

Each of these broke something while building the reference setup:

| Symptom | Cause / fix |
| :--- | :--- |
| Backend spans missing or logs without `trace.id` | `import './tracing'` must be the first line of `main.ts`. |
| `Cannot read properties of undefined` at logger startup | `esModuleInterop` is off; `pino-elasticsearch` has no default export. |
| Browser: *No 'Access-Control-Allow-Origin' header* | `CORS_ORIGINS` must list the frontend's origin, not the backend's port. For traces, list it in Tempo's `cors.allowed_origins` too. |
| Logs stop reaching ES forever after ES was down once | The `pino-elasticsearch` bulk helper aborts on the first connection error; `createElasticStream` recreates it. |
| A "Create Nest App" trace that keeps growing, full of `bulk` / `POST` spans | Log shipping was traced (the ES client has built-in OpenTelemetry). Ship logs inside `context.with(NO_TRACING, …)`. |
| Grafana logs panel: *Need parsed labels to find common labels* | A document was indexed with an empty `labels: {}`. `compact()` drops empty objects. |
| Grafana data links/queries lose `${...}` | Escape `$` as `$$` in provisioning files. |
| `term` query on `message` finds nothing | `message` is `match_only_text` in the `logs` template; use `match_phrase`. |
| CRA build: *Attempted import error: 'X' is not exported* | Type-only imports need `import type` (Babel compiles each file on its own). |
| Browser spans never arrive | The OTLP exporter defaults to `sendBeacon`, which is blocked for cross-origin JSON; `headers: {}` makes it use XHR. |
| Docker Desktop on WSL: *accessing specified distro mount service* | Bind mounts from WSL paths need the WSL integration; the configs are baked into images instead. |
| Tempo can't write to its volume | The image runs as 10001; see the ownership step in `tempo/Dockerfile`. |
| Explore missing in Grafana | Explore needs the Editor role. |

---

## 7. Kubernetes

The code doesn't change, only the addresses.

- **Deploy the backends.** Deploy Tempo with the `grafana/tempo` Helm chart using the same `tempo.yaml` settings, and provision Grafana's datasources through the Grafana chart. Use a managed or ECK Elasticsearch.
- **Backend:** set `OTEL_EXPORTER_OTLP_ENDPOINT` to Tempo's in-cluster service, e.g. `http://tempo.observability:4318`, and `ELASTICSEARCH_NODE` to the in-cluster Elasticsearch.
- **Browser:**
  - Expose Tempo's OTLP HTTP port through an Ingress, for example `/otlp` on your domain. Protect it the same way as any public ingestion endpoint.
  - Set `REACT_APP_OTEL_EXPORTER_OTLP_ENDPOINT` to that public URL.
  - Add the frontend's public origin to Tempo's `cors.allowed_origins`.
- **Console links:** set `REACT_APP_GRAFANA_URL` to the cluster's Grafana.
- **Collector:** add Grafana Alloy (e.g. via the `grafana/k8s-monitoring` chart) only if you need pod/namespace metadata on spans, sampling, or several trace backends.
