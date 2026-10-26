// OpenTelemetry: precisa ser o PRIMEIRO import do main.ts, antes de qualquer módulo
// que ele instrumenta (http, express, nest, mongodb, pino).
// Os traces vão por OTLP direto para o Tempo (Grafana).
import type { IncomingMessage } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';

// O ConfigModule do Nest só carrega o .env depois; aqui ele é lido antes para que
// as variáveis OTEL_* também possam vir de lá.
try {
  process.loadEnvFile('.env');
} catch {
  // sem .env: segue com as variáveis de ambiente/padrões
}

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'todo-backend',
    'deployment.environment.name': process.env.NODE_ENV ?? 'development',
  }),
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Envio de logs do frontend e preflights de CORS não são tráfego da aplicação.
        ignoreIncomingRequestHook: (req: IncomingMessage) =>
          req.method === 'OPTIONS' || (req.url ?? '').startsWith('/api/logs'),
        // Sem isso, cada flush de logs para o Elasticsearch viraria um trace próprio.
        requireParentforOutgoingSpans: true,
      },
      '@opentelemetry/instrumentation-undici': { requireParentforSpans: true },
      // Um span por middleware do Express (cors, json, ...) só polui a cascata.
      '@opentelemetry/instrumentation-express': {
        ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
        // Handlers catch-all que o Nest registra ("request handler - /*").
        ignoreLayers: [/^request handler - \/\*$/],
      },
      // O mongoose duplicaria os spans que a instrumentação do driver mongodb já cria.
      '@opentelemetry/instrumentation-mongoose': { enabled: false },
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // Coloca o trace.id nos logs do pino (campos ECS, os mesmos que o Kibana e o Grafana usam).
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
