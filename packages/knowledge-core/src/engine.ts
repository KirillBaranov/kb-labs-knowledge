import type {
  KnowledgeEngineConfig,
  KnowledgeEngineOptions,
  KnowledgeEngineType,
  KnowledgeQuery,
  KnowledgeQueryFilters,
  KnowledgeResult,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeCapability,
  KnowledgeProfile,
  IndexingStats,
} from '@kb-labs/knowledge-contracts';
import type { KnowledgeLogger } from './logger';

export interface KnowledgeIndexOptions {
  scope: KnowledgeScope;
  force?: boolean;
  workspaceRoot?: string;
}

export interface KnowledgeExecutionContext {
  scope: KnowledgeScope;
  sources: KnowledgeSource[];
  limit: number;
  filters?: KnowledgeQueryFilters;
  capability?: KnowledgeCapability;
  profile?: KnowledgeProfile;
}

export interface KnowledgeEngine {
  readonly id: string;
  readonly type: KnowledgeEngineType | (string & {});

  init?(options?: KnowledgeEngineOptions): Promise<void> | void;

  index?(
    sources: KnowledgeSource[],
    options: KnowledgeIndexOptions,
  ): Promise<IndexingStats | void>;

  query(
    query: KnowledgeQuery,
    context: KnowledgeExecutionContext,
  ): Promise<KnowledgeResult>;

  dispose?(): Promise<void> | void;
}

export interface KnowledgeEngineFactoryContext {
  workspaceRoot?: string;
  logger: KnowledgeLogger;
}

export type KnowledgeEngineFactory = (
  config: KnowledgeEngineConfig,
  context: KnowledgeEngineFactoryContext,
) => KnowledgeEngine;
