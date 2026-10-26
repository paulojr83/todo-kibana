import { Writable } from 'node:stream';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import pinoElastic, { DestinationStream } from 'pino-elasticsearch';

const RECONNECT_DELAY_MS = 10_000;

// Envio de logs não é tráfego da aplicação: sem isso, cada flush para o ES vira
// span (o client do Elasticsearch tem instrumentação OpenTelemetry própria) e se
// pendura no trace de quem criou o stream, p. ex. "Create Nest App" no boot.
export const NO_TRACING = suppressTracing(ROOT_CONTEXT);

interface ElasticStreamOptions {
  node: string;
  index: string;
  flushInterval?: number;
}

/**
 * Stream de logs para o Elasticsearch que sobrevive a quedas do cluster.
 *
 * O bulk helper usado pelo pino-elasticsearch aborta de vez no primeiro erro de
 * conexão (ex.: backend iniciado antes do ES), e dali em diante nenhum log chega
 * ao Kibana. Aqui o stream é recriado após um intervalo; as linhas escritas
 * enquanto o ES está fora são descartadas (o console continua recebendo tudo).
 */
export function createElasticStream({ node, index, flushInterval = 2000 }: ElasticStreamOptions): Writable {
  let target: DestinationStream | null = null;

  const connect = () => {
    const stream = pinoElastic({ node, index, esVersion: 8, opType: 'create', flushBytes: 1000, flushInterval });

    stream.on('error', (err) => {
      if (target !== stream) return;
      target = null;
      process.stderr.write(
        `[elastic-stream] falha ao enviar logs para ${node}: ${err.message}. Nova tentativa em ${RECONNECT_DELAY_MS / 1000}s\n`,
      );
      setTimeout(() => context.with(NO_TRACING, connect), RECONNECT_DELAY_MS).unref();
    });

    stream.on('insertError', (err) => {
      const reason = err.document?.error?.reason ?? err.message;
      process.stderr.write(`[elastic-stream] log rejeitado pelo Elasticsearch: ${reason}\n`);
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
