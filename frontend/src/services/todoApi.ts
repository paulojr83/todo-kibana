import axios from 'axios';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { context, isSpanContextValid, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { createId, createLogger, sessionId } from '../logging/logger';
import { printTraceLink } from '../logging/tracing';
import type { LogLevel } from '../logging/logger';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000';

const log = createLogger('todoApi');
const tracer = trace.getTracer('todo-frontend-api');

export interface Todo {
  _id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  responseTime?: number;
}

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    metadata?: { requestId: string; startedAt: number; span: Span };
  }
}

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Ids do Mongo viram :id no nome do span, para não criar um nome por registro.
function routeOf(path: string | undefined): string {
  return (path ?? '').replace(/[0-9a-f]{24}/g, ':id');
}

// Cada chamada vira um span CLIENT cujo contexto segue no header traceparent: o
// backend continua o mesmo trace. O x-request-id também aparece nos logs do
// backend (http.request.id).
api.interceptors.request.use((config) => {
  const requestId = createId();
  const method = config.method?.toUpperCase() ?? 'GET';
  const span = tracer.startSpan(`${method} ${routeOf(config.url)}`, {
    kind: SpanKind.CLIENT,
    attributes: { 'http.request.method': method, 'url.full': `${API_URL}${config.url ?? ''}` },
  });

  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), carrier);
  for (const [header, value] of Object.entries(carrier)) config.headers.set(header, value);

  config.headers.set('x-request-id', requestId);
  config.headers.set('x-session-id', sessionId);
  config.metadata = { requestId, startedAt: performance.now(), span };
  return config;
});

function logHttp(config: InternalAxiosRequestConfig | undefined, statusCode?: number, error?: AxiosError) {
  const method = config?.method?.toUpperCase();
  const path = config?.url;
  const durationMs = config?.metadata ? Math.round(performance.now() - config.metadata.startedAt) : undefined;

  // Sucesso -> info; 4xx -> warn; 5xx ou sem resposta (rede/CORS) -> error.
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

  log[level](`${method} ${path} ${statusCode ?? 'sem resposta'} ${durationMs ?? '?'}ms`, {
    requestId: config?.metadata?.requestId,
    traceId,
    error,
    http: { method, path, statusCode, durationMs },
  });
}

api.interceptors.response.use(
  (response) => {
    logHttp(response.config, response.status);
    return response;
  },
  (error: AxiosError) => {
    logHttp(error.config, error.response?.status, error);
    return Promise.reject(error);
  },
);

export const todoApi = {
  async getTodos(): Promise<{ data: Todo[]; count: number; responseTime: number }> {
    log.debug('Buscando todos do servidor');
    const response = await api.get('/api/todos');
    log.debug('Todos recebidos', { context: { count: response.data.count } });
    return response.data;
  },

  async createTodo(title: string): Promise<Todo> {
    log.debug('Criando novo todo', { context: { title } });
    const response = await api.post('/api/todos', { title });
    log.info('Todo criado', { context: { todoId: response.data._id } });
    return response.data;
  },

  async updateTodo(id: string, completed: boolean): Promise<Todo> {
    log.debug('Atualizando todo', { context: { todoId: id, completed } });
    const response = await api.put(`/api/todos/${id}`, { completed });
    log.info('Todo atualizado', { context: { todoId: id, completed } });
    return response.data;
  },

  async deleteTodo(id: string): Promise<void> {
    log.debug('Deletando todo', { context: { todoId: id } });
    await api.delete(`/api/todos/${id}`);
    log.info('Todo deletado', { context: { todoId: id } });
  },

  async getTrace() {
    log.debug('Buscando trace de requisições');
    const response = await api.get('/api/todos/logs/trace');
    return response.data;
  },

  async getStats() {
    log.debug('Buscando estatísticas');
    const response = await api.get('/api/todos/logs/stats');
    return response.data;
  },
};
