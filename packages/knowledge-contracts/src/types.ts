export const knowledgeSourceKinds = [
  'code',
  'docs',
  'config',
  'logs',
  'custom',
] as const

export type KnowledgeSourceKind = (typeof knowledgeSourceKinds)[number]

export interface KnowledgeSource {
  id: string
  label?: string
  kind: KnowledgeSourceKind
  language?: string
  paths: string[]
  exclude?: string[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeScope {
  id: string
  label?: string
  sources: string[]
  defaultEngine?: string
  description?: string
  metadata?: Record<string, unknown>
}

export const knowledgeEngineTypes = ['mind', 'external-rag', 'fs', 'none'] as const
export type KnowledgeEngineType = (typeof knowledgeEngineTypes)[number] | (string & {})

export type KnowledgeEngineOptions = Record<string, unknown>

export interface KnowledgeEngineConfig {
  id: string
  type: KnowledgeEngineType
  options?: KnowledgeEngineOptions
  llmEngineId?: string
  preferredEmbeddingModel?: string
  metadata?: Record<string, unknown>
}

export const knowledgeIntents = ['summary', 'similar', 'nav', 'search'] as const
export type KnowledgeIntent = (typeof knowledgeIntents)[number]

export interface KnowledgeQueryFilters {
  sourceIds?: string[]
  paths?: string[]
  languages?: string[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeQuery {
  productId: string
  intent: KnowledgeIntent
  scopeId: string
  profileId?: string
  text: string
  limit?: number
  filters?: KnowledgeQueryFilters
  metadata?: Record<string, unknown>
}

export interface SpanRange {
  startLine: number
  endLine: number
}

export interface KnowledgeChunk {
  id: string
  sourceId: string
  path: string
  span: SpanRange
  text: string
  score: number
  metadata?: Record<string, unknown>
}

export interface KnowledgeResult {
  query: KnowledgeQuery
  chunks: KnowledgeChunk[]
  contextText?: string
  engineId?: string
  generatedAt: string
  metadata?: Record<string, unknown>
}

export interface EmbeddingVector {
  dim: number
  values: number[]
}

export interface IndexedChunk {
  chunkId: string
  sourceId: string
  path: string
  embedding: EmbeddingVector
  metadata: Record<string, unknown>
  span: SpanRange
}

export interface KnowledgeDefaults {
  maxChunks?: number
  embeddingModel?: string
  fallbackScopeId?: string
  fallbackEngineId?: string
}

export interface KnowledgeConfig {
  sources: KnowledgeSource[]
  scopes: KnowledgeScope[]
  engines: KnowledgeEngineConfig[]
  defaults?: KnowledgeDefaults
}

export interface KnowledgeCapability {
  productId: string
  allowedIntents: KnowledgeIntent[]
  allowedScopes: string[]
  maxChunks?: number
  defaultScopeId?: string
  description?: string
}

export type KnowledgeCapabilityRegistry = Record<string, KnowledgeCapability>

export interface KnowledgeProfileSettings {
  scopeId?: string
  engineId?: string
  maxChunks?: number
}

export interface KnowledgeProfileProductOverrides {
  [productId: string]: KnowledgeProfileSettings | undefined
}

export interface KnowledgeProfile {
  id: string
  label?: string
  description?: string
  products: KnowledgeProfileProductOverrides
}

/**
 * Statistics returned from indexing operation
 */
export interface IndexingStats {
  /** Number of files discovered */
  filesDiscovered: number
  /** Number of files processed (chunked and embedded) */
  filesProcessed: number
  /** Number of files skipped (unchanged) */
  filesSkipped: number
  /** Total number of chunks stored */
  chunksStored: number
  /** Number of chunks updated (existing) */
  chunksUpdated: number
  /** Number of chunks skipped (duplicate) */
  chunksSkipped: number
  /** Number of errors encountered */
  errorCount: number
  /** Duration in milliseconds */
  durationMs: number
}
