import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@elastic/elasticsearch';
import { context } from '@opentelemetry/api';
import { NO_TRACING } from './elastic-stream';
import { DEFAULT_ELASTICSEARCH_NODE, FRONTEND_LOGS_INDEX } from './logging.constants';

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

// Remove campos undefined e objetos vazios. Um `labels: {}` indexado vira um
// campo "labels" solto no Grafana, que o painel de logs trata como os labels da
// linha e quebra ("Need parsed labels to find common labels").
function compact(value: Entry): Entry {
  const result: Entry = {};
  for (const [key, child] of Object.entries(value)) {
    const cleaned = isRecord(child) ? compact(child) : child;
    if (cleaned === undefined || (isRecord(cleaned) && Object.keys(cleaned).length === 0)) continue;
    result[key] = cleaned;
  }
  return result;
}

// trace.id do W3C Trace Context (32 hex) gerado pelo agente RUM do navegador.
function traceId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

function timestamp(value: unknown): string {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

// Contexto livre do frontend vira `labels` (keyword), para não criar campos
// arbitrários no mapeamento do data stream.
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

/** Converte uma entrada enviada pelo navegador em um documento ECS. */
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
    service: { name: 'todo-frontend' },
    event: {
      dataset: 'todo.frontend',
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

  /** Indexa as entradas em background e devolve quantas foram aceitas. */
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
        this.logger.warn(
          `${failed.length} logs do frontend rejeitados pelo Elasticsearch: ${failed[0]?.create?.error?.reason}`,
        );
      })
      .catch((err: Error) => this.logger.warn(`Falha ao indexar logs do frontend: ${err.message}`));

    return docs.length;
  }

  async onModuleDestroy() {
    await this.client.close();
  }
}
