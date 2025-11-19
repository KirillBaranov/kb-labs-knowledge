export type KnowledgeErrorCode =
  | 'KNOWLEDGE_CONFIG_INVALID'
  | 'KNOWLEDGE_CAPABILITY_MISSING'
  | 'KNOWLEDGE_ACCESS_DENIED'
  | 'KNOWLEDGE_SCOPE_NOT_FOUND'
  | 'KNOWLEDGE_SOURCE_NOT_FOUND'
  | 'KNOWLEDGE_ENGINE_NOT_FOUND'
  | 'KNOWLEDGE_ENGINE_UNREGISTERED'
  | 'KNOWLEDGE_ENGINE_FAILED'
  | 'KNOWLEDGE_PROFILE_NOT_FOUND'
  | 'KNOWLEDGE_QUERY_INVALID'
  | 'KNOWLEDGE_INDEX_NOT_AVAILABLE';

export interface KnowledgeErrorDetail {
  cause?: unknown;
  meta?: Record<string, unknown>;
}

export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;
  override readonly cause?: unknown;
  readonly meta?: Record<string, unknown>;

  override name = 'KnowledgeError';

  constructor(
    code: KnowledgeErrorCode,
    message: string,
    detail?: KnowledgeErrorDetail,
  ) {
    super(message);
    this.code = code;
    this.cause = detail?.cause;
    this.meta = detail?.meta;
  }
}

export function createKnowledgeError(
  code: KnowledgeErrorCode,
  message: string,
  detail?: KnowledgeErrorDetail,
): KnowledgeError {
  return new KnowledgeError(code, message, detail);
}
