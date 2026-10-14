import { pino, type Logger } from 'pino';
import type { Config } from '../config.ts';

export type { Logger };

/**
 * Create the application logger. JSON output is the default so logs stay cheap
 * and machine-readable; pretty printing is opt-in because it spawns a transport
 * worker.
 */
export function createLogger(config: Config): Logger {
  return pino({
    level: config.log.level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(config.log.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l' },
          },
        }
      : {}),
  });
}
