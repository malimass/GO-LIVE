import winston from 'winston';
import fs from 'fs';

const SECRET_PATTERN = /([a-zA-Z0-9_-]{20,})/g;

const redactSecrets = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = info.message.replace(SECRET_PATTERN, (match) => {
      if (match.length > 30) {
        return `${match.substring(0, 6)}...[REDACTED]`;
      }
      return match;
    });
  }
  return info;
});

const transports: winston.transport[] = [
  new winston.transports.Console(),
];

// Add file transport if logs directory exists
if (fs.existsSync('logs')) {
  transports.push(
    new winston.transports.File({ filename: 'logs/go-live.log', maxsize: 10_000_000, maxFiles: 3 }),
  );
}

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    redactSecrets(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    }),
  ),
  transports,
});
