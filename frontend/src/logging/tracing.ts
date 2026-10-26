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
// Janela fixa em volta da requisição: o link continua abrindo o trace mesmo horas depois.
const TRACE_LINK_WINDOW_MS = 15 * 60 * 1000;

/**
 * OpenTelemetry no navegador: envia os spans por OTLP direto para o Tempo
 * (Grafana), que libera CORS para o frontend. Os spans das chamadas à API são
 * criados em services/todoApi.ts, que também propaga o traceparent ao backend.
 */
export function startTracing() {
  if (process.env.REACT_APP_OTEL_ENABLED === 'false') return;

  const provider = new WebTracerProvider({
    resource: new Resource({
      'service.name': 'todo-frontend',
      'deployment.environment.name': process.env.NODE_ENV,
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        // `headers` força o envio via XHR: sendBeacon com JSON para outra origem é bloqueado pelo navegador.
        new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces`, headers: {} }),
      ),
    ],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });

  // Tempos de carregamento da página (documentFetch, resourceFetch, ...).
  registerInstrumentations({ instrumentations: [new DocumentLoadInstrumentation()] });

  setTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId);
}

/** Link para o trace no Grafana (Explore > Tempo). */
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

/** Só em desenvolvimento: imprime no console o link do trace de uma chamada à API. */
export function printTraceLink(traceId: string, method: string, url: string) {
  if (process.env.NODE_ENV !== 'development') return;
  console.log(`[Trace] ${traceId}\n${grafanaTraceUrl(traceId)} ${method}\n${url}`);
}
