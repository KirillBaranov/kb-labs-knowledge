import type {
  KnowledgeEngineConfig,
  KnowledgeEngineType,
  KnowledgeResult,
  KnowledgeQuery,
} from '@kb-labs/knowledge-contracts';
import { createKnowledgeError } from './errors';
import type {
  KnowledgeEngine,
  KnowledgeEngineFactory,
  KnowledgeEngineFactoryContext,
  KnowledgeExecutionContext,
  KnowledgeIndexOptions,
} from './engine';
import type { KnowledgeLogger } from './logger';

export class KnowledgeEngineRegistry {
  private readonly factories = new Map<
    KnowledgeEngineType | (string & {}),
    KnowledgeEngineFactory
  >();

  register(
    type: KnowledgeEngineType | (string & {}),
    factory: KnowledgeEngineFactory,
  ): void {
    this.factories.set(type, factory);
  }

  create(
    config: KnowledgeEngineConfig,
    context: KnowledgeEngineFactoryContext,
  ): KnowledgeEngine {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw createKnowledgeError(
        'KNOWLEDGE_ENGINE_UNREGISTERED',
        `No knowledge engine registered for type "${config.type}".`,
        { meta: { type: config.type } },
      );
    }
    return factory(config, context);
  }

  has(type: KnowledgeEngineType | (string & {})): boolean {
    return this.factories.has(type);
  }
}

export function createKnowledgeEngineRegistry(
  logger: KnowledgeLogger,
): KnowledgeEngineRegistry {
  const registry = new KnowledgeEngineRegistry();
  registry.register('none', config => new NullKnowledgeEngine(config, logger));
  return registry;
}

class NullKnowledgeEngine implements KnowledgeEngine {
  readonly id: string;
  readonly type = 'none';
  private readonly logger: KnowledgeLogger;

  constructor(config: KnowledgeEngineConfig, logger: KnowledgeLogger) {
    this.id = config.id;
    this.logger = logger;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async index(
    _sources: unknown[],
    _options: KnowledgeIndexOptions,
  ): Promise<void> {
    this.logger.debug?.(
      '[knowledge-core] NullKnowledgeEngine index called; ignoring.',
      { engineId: this.id },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async query(
    query: KnowledgeQuery,
    _context: KnowledgeExecutionContext,
  ): Promise<KnowledgeResult> {
    this.logger.warn?.(
      '[knowledge-core] NullKnowledgeEngine query invoked. Returning empty result.',
      { engineId: this.id },
    );
    return {
      query,
      chunks: [],
      contextText: '',
      engineId: this.id,
      generatedAt: new Date().toISOString(),
    };
  }
}
