import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import ecsFormat from '@elastic/ecs-pino-format';
import pino from 'pino';
import type { Options } from 'pino-http';
import pretty from 'pino-pretty';
import type { Params } from 'nestjs-pino';
import { createElasticStream } from './elastic-stream';
import { BACKEND_LOGS_INDEX, REQUEST_ID_HEADER, SESSION_ID_HEADER } from './logging.constants';

interface LoggerSettings {
  level: pino.Level;
  environment: string;
  elasticsearchNode: string;
  logToElasticsearch: boolean;
}

// Aceita o id vindo do frontend só se tiver cara de id, para não indexar lixo.
const VALID_ID = /^[\w-]{1,64}$/;

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && VALID_ID.test(value) ? value : undefined;
}

function requestPath(req: IncomingMessage): string {
  const url = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  return url.split('?')[0];
}

// Rota do Express que atendeu a requisição (ex.: /api/todos/:id), para agrupar
// métricas sem explodir por id. Ausente quando nenhuma rota casou (404).
function routeTemplate(req: IncomingMessage): string | undefined {
  const { route, baseUrl } = req as IncomingMessage & { route?: { path?: string }; baseUrl?: string };
  return typeof route?.path === 'string' ? `${baseUrl ?? ''}${route.path}` : undefined;
}

// Campos ECS montados à mão: o convertReqRes do ecs-pino-format não enxerga o
// `req` que o pino-http coloca nos bindings do child logger.
function httpFields(req: IncomingMessage, res: ServerResponse, responseTime: number) {
  return {
    'http.request.method': req.method,
    'url.path': requestPath(req),
    'http.route': routeTemplate(req),
    'http.response.status_code': res.statusCode,
    'event.duration': Math.round(responseTime * 1e6), // ECS usa nanossegundos
    'client.ip': req.socket?.remoteAddress,
    'user_agent.original': req.headers['user-agent'],
    'labels.session_id': headerValue(req, SESSION_ID_HEADER),
  };
}

function httpOptions(settings: LoggerSettings): Options {
  return {
    ...ecsFormat({
      serviceName: 'todo-backend',
      serviceEnvironment: settings.environment,
      eventDataset: 'todo.backend',
    }),
    level: settings.level,
    // Só o id da requisição vai para os logs da aplicação; o resto fica na linha de conclusão.
    quietReqLogger: true,
    quietResLogger: true,
    customAttributeKeys: { reqId: 'http.request.id' },
    genReqId: (req, res) => {
      const id = headerValue(req, REQUEST_ID_HEADER) ?? randomUUID();
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    autoLogging: {
      // Preflights e o próprio envio de logs do frontend só gerariam ruído.
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
    // Sem stack aqui: a exceção real (com stack) já é logada pelo ExceptionsHandler do Nest.
    customErrorObject: (req, res, err, val) => ({
      ...httpFields(req, res, val.responseTime),
      'error.message': err.message,
    }),
  };
}

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
