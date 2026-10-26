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
