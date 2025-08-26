import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import winston from 'winston';
import winstonDaily from 'winston-daily-rotate-file';
import { LOG_DIR } from '@config';

// logs dir (fallback to 'logs' if LOG_DIR not set)
const resolvedLogDir = LOG_DIR && LOG_DIR.trim().length > 0 ? LOG_DIR : 'logs';
const logDir: string = join(process.cwd(), resolvedLogDir);

if (!existsSync(logDir)) {
  mkdirSync(logDir);
}

// Define console log format (human-readable)
const consoleFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${message}${extra}`;
});

/*
 * Log Level
 * error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6
 */
const logger = winston.createLogger({
  format: winston.format.combine(winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' })),
  transports: [
    // debug log setting
    new winstonDaily({
      level: 'debug',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/debug', // log file /logs/debug/*.log in save
      filename: `%DATE%.log`,
      maxFiles: 30, // 30 Days saved
      json: true,
      zippedArchive: true,
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
    // error log setting
    new winstonDaily({
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      dirname: logDir + '/error', // log file /logs/error/*.log in save
      filename: `%DATE%.log`,
      maxFiles: 30, // 30 Days saved
      handleExceptions: true,
      json: true,
      zippedArchive: true,
      format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    }),
  ],
});

logger.add(
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.splat(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      consoleFormat,
    ),
  }),
);

const stream = {
  write: (message: string) => {
    logger.info(message.substring(0, message.lastIndexOf('\n')));
  },
};

export { logger, stream };
