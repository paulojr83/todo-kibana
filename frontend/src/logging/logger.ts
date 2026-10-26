// Logger do navegador: espelha no console e envia em lotes para o backend
// (POST /api/logs), que indexa no data stream logs-todo.frontend-default.

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
const SESSION_KEY = 'todo-log-session-id';
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

/** Identifica a aba do navegador; também vai no header x-session-id das chamadas à API. */
export const sessionId = loadSessionId();

let queue: LogEntry[] = [];

// Referência ao fetch original, guardada antes de qualquer instrumentação de
// tracing: o envio de logs não deve virar span nem receber header traceparent.
const nativeFetch = window.fetch.bind(window);

let traceIdProvider: () => string | undefined = () => undefined;

/** Registrado pelo tracing (tracing.ts) para anexar o trace.id atual a cada log. */
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

// text/plain é um content-type "simples": o envio não dispara preflight de CORS,
// o que permite usar sendBeacon quando a página está sendo fechada.
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
      // 4xx não melhora com nova tentativa: o lote é descartado.
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    })
    .catch(() => {
      // Backend fora do ar: devolve o lote para a fila e tenta no próximo ciclo.
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

/** Captura erros não tratados e agenda o envio periódico dos logs. */
export function installLogCapture() {
  if (installed) return;
  installed = true;

  const log = createLogger('window');

  window.addEventListener('error', (event) => {
    log.error(event.message || 'Erro não tratado', {
      error: event.error ?? event.message,
      context: { source: event.filename, line: event.lineno, column: event.colno },
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    log.error('Promise rejeitada sem tratamento', { error: event.reason });
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushLogs(true);
  });
  window.addEventListener('pagehide', () => flushLogs(true));

  window.setInterval(() => flushLogs(), FLUSH_INTERVAL_MS);
}
