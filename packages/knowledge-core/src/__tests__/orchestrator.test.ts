import { beforeEach, describe, expect, it } from 'vitest';
import type {
  KnowledgeCapabilityRegistry,
  KnowledgeConfigInput,
  KnowledgeQuery,
} from '@kb-labs/knowledge-contracts';
import {
  KnowledgeOrchestrator,
  KnowledgeEngineRegistry,
  type KnowledgeEngine,
  type KnowledgeExecutionContext,
  type KnowledgeResult,
} from '../index';

class StubEngine implements KnowledgeEngine {
  readonly id: string;
  readonly type = 'stub';
  lastQuery?: KnowledgeQuery;
  lastContext?: KnowledgeExecutionContext;
  indexedScopes: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  async query(
    query: KnowledgeQuery,
    context: KnowledgeExecutionContext,
  ): Promise<KnowledgeResult> {
    this.lastQuery = query;
    this.lastContext = context;
    return {
      query,
      chunks: [
        {
          id: 'chunk-1',
          sourceId: context.sources[0]?.id ?? 'unknown',
          path: 'src/index.ts',
          span: { startLine: 1, endLine: 5 },
          text: `Echo: ${query.text}`,
          score: 1,
        },
      ],
      engineId: this.id,
      generatedAt: new Date().toISOString(),
    };
  }

  async index(): Promise<void> {
    // No-op for tests
  }
}

const baseConfig: KnowledgeConfigInput = {
  sources: [
    {
      id: 'repo-code',
      kind: 'code',
      paths: ['src/**/*.ts'],
    },
  ],
  scopes: [
    {
      id: 'default',
      sources: ['repo-code'],
      defaultEngine: 'stub-engine',
    },
  ],
  engines: [
    {
      id: 'stub-engine',
      type: 'stub',
    },
  ],
  defaults: {
    maxChunks: 16,
  },
};

const capabilities: KnowledgeCapabilityRegistry = {
  aiReview: {
    productId: 'aiReview',
    allowedIntents: ['summary', 'search'],
    allowedScopes: ['default'],
    maxChunks: 8,
  },
};

function createRegistry(engine: StubEngine): KnowledgeEngineRegistry {
  const registry = new KnowledgeEngineRegistry();
  registry.register('stub', () => engine);
  return registry;
}

describe('KnowledgeOrchestrator', () => {
  let orchestrator: KnowledgeOrchestrator;
  let engine: StubEngine;

  beforeEach(() => {
    engine = new StubEngine('stub-engine');
    orchestrator = new KnowledgeOrchestrator({
      config: baseConfig,
      capabilities,
      registry: createRegistry(engine),
    });
  });

  it('clamps query limits according to capabilities', async () => {
    await orchestrator.query({
      productId: 'aiReview',
      intent: 'summary',
      scopeId: 'default',
      text: 'what is knowledge?',
      limit: 20,
    });

    expect(engine.lastQuery?.limit).toBe(8);
    expect(engine.lastContext?.limit).toBe(8);
  });

  it('throws if scope is not found', async () => {
    await expect(
      orchestrator.query({
        productId: 'aiReview',
        intent: 'summary',
        scopeId: 'missing',
        text: 'test',
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_SCOPE_NOT_FOUND' });
  });

  it('throws when capability is missing', async () => {
    await expect(
      orchestrator.query({
        productId: 'unknown',
        intent: 'summary',
        scopeId: 'default',
        text: 'test',
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_CAPABILITY_MISSING' });
  });
});
