export interface KnowledgeLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export function createNullLogger(): KnowledgeLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
