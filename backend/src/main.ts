import './tracing'; // OpenTelemetry: deve vir antes de todos os outros imports
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

// Origens de onde o FRONTEND é servido (não a porta do backend).
const DEFAULT_CORS_ORIGINS = 'http://localhost:3000,http://localhost:3001,http://localhost:5601';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Logs do frontend chegam como text/plain (sem preflight de CORS).
  app.useBodyParser('text', { type: 'text/plain', limit: '256kb' });

  app.enableCors({
    origin: (process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS).split(',').map((origin) => origin.trim()),
    credentials: true,
  });

  const port = 3010;
  await app.listen(port);
  logger.log(`✅ Backend iniciado na porta ${port}`, 'Bootstrap');
}

bootstrap();
