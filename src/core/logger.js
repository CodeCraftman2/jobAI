const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const os = require('os');
const { redactSecrets } = require('./privacy');

// Logs are kept on disk for days. They record what happened, not what was said:
// secrets are redacted everywhere, and fields that carry questions, transcripts
// or answers are reduced to their length. LOG_CONTENT=true keeps them (debugging).
const CONTENT_KEYS = new Set(['text', 'textPreview', 'responsePreview', 'dataPreview', 'rawResponse', 'response', 'transcript', 'question', 'prompt', 'content']);

function scrub(value, key, depth = 0) {
  if (typeof value === 'string') {
    if (key && CONTENT_KEYS.has(key) && process.env.LOG_CONTENT !== 'true') return `[omitted ${value.length} chars]`;
    return redactSecrets(value);
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, key, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k, depth + 1);
  return out;
}

const sanitizeLogs = require('winston').format((info) => {
  for (const k of Object.keys(info)) {
    if (k === 'level' || k === 'timestamp' || k === 'service' || k === 'stack') continue;
    info[k] = scrub(info[k], k === 'message' ? null : k);
  }
  if (typeof info.stack === 'string') info.stack = redactSecrets(info.stack);
  return info;
});

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.JobAI', 'logs');
    this.setupLogger();
  }

  setupLogger() {
    const logFormat = winston.format.combine(
      sanitizeLogs(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.printf(({ timestamp, level, message, stack, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        const serviceStr = service ? `[${service}]` : '';
        const stackStr = stack ? `\n${stack}` : '';
        return `${timestamp} ${level.toUpperCase()} ${serviceStr} ${message}${stackStr}${metaStr ? `\n${metaStr}` : ''}`;
      })
    );

    this.logger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      defaultMeta: { pid: process.pid },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            logFormat
          ),
          stderrLevels: ['error', 'warn']
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'application-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '14d',
          level: 'info'
        }),
        new DailyRotateFile({
          filename: path.join(this.logDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '30d',
          level: 'error'
        })
      ],
      exceptionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'exceptions.log')
        })
      ],
      rejectionHandlers: [
        new winston.transports.File({
          filename: path.join(this.logDir, 'rejections.log')
        })
      ]
    });
  }

  createServiceLogger(serviceName) {
    return {
      debug: (message, meta = {}) => this.logger.debug(message, { service: serviceName, ...meta }),
      info: (message, meta = {}) => this.logger.info(message, { service: serviceName, ...meta }),
      warn: (message, meta = {}) => this.logger.warn(message, { service: serviceName, ...meta }),
      error: (message, meta = {}) => this.logger.error(message, { service: serviceName, ...meta }),
      logPerformance: (operation, startTime, metadata = {}) => this.logPerformance(operation, startTime, { service: serviceName, ...metadata })
    };
  }

  getSystemMetrics() {
    return {
      memory: process.memoryUsage(),
      uptime: process.uptime(),
      platform: process.platform,
      nodeVersion: process.version
    };
  }

  logPerformance(operation, startTime, metadata = {}) {
    const duration = Date.now() - startTime;
    this.logger.info(`Performance: ${operation} completed`, {
      service: 'PERFORMANCE',
      duration: `${duration}ms`,
      ...metadata
    });
    return duration;
  }
}

module.exports = new Logger();
module.exports.scrub = scrub; // exported for tests