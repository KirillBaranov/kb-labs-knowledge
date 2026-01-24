import {
  type KnowledgeCapability,
  type KnowledgeCapabilityRegistry,
  type KnowledgeConfig,
  type KnowledgeConfigInput,
  type KnowledgeEngineConfig,
  type KnowledgeProfile,
  type KnowledgeQuery,
  type KnowledgeQueryFilters,
  type KnowledgeResult,
  type KnowledgeScope,
  type KnowledgeSource,
  type IndexingStats,
  knowledgeConfigSchema,
} from '@kb-labs/knowledge-contracts';
import { createKnowledgeError } from './errors';
import type {
  KnowledgeEngine,
  KnowledgeEngineFactoryContext,
  KnowledgeExecutionContext,
  KnowledgeIndexOptions,
} from './engine';
import {
  KnowledgeEngineRegistry,
  createKnowledgeEngineRegistry,
} from './registry';
import type { KnowledgeLogger } from './logger';
import { createNullLogger } from './logger';
import {
  ensureIntentAllowed,
  ensureScopeAllowed,
  getCapability,
} from './capabilities';
import {
  createProfileMap,
  resolveProfileSettings,
  type KnowledgeProfileMap,
  type ResolvedProfileSettings,
} from './profiles';

const DEFAULT_MAX_CHUNKS = 32;

export interface KnowledgeServiceOptions {
  config: KnowledgeConfigInput;
  capabilities?: KnowledgeCapabilityRegistry;
  profiles?: KnowledgeProfile[];
  registry?: KnowledgeEngineRegistry;
  logger?: KnowledgeLogger;
  workspaceRoot?: string;
  defaultMaxChunks?: number;
}

export interface KnowledgeService {
  query(query: KnowledgeQuery): Promise<KnowledgeResult>;
  index(scopeId: string, options?: { force?: boolean }): Promise<IndexingStats | void>;
}

interface EngineRecord {
  config: KnowledgeEngineConfig;
  instance?: KnowledgeEngine;
  promise?: Promise<KnowledgeEngine>;
}

interface ResolvedScopeContext {
  scope: KnowledgeScope;
  sources: KnowledgeSource[];
  capability: KnowledgeCapability;
  profileOverride?: ResolvedProfileSettings;
  limit: number;
  filters?: KnowledgeQueryFilters;
  engineConfig: KnowledgeEngineConfig;
}

function normalizeConfig(input: KnowledgeConfigInput): KnowledgeConfig {
  const parsed = knowledgeConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw createKnowledgeError(
      'KNOWLEDGE_CONFIG_INVALID',
      'Invalid knowledge configuration.',
      { meta: { issues: parsed.error.issues } },
    );
  }
  return parsed.data;
}

export class KnowledgeOrchestrator implements KnowledgeService {
  private readonly config: KnowledgeConfig;
  private readonly registry: KnowledgeEngineRegistry;
  private readonly logger: KnowledgeLogger;
  private readonly capabilities?: KnowledgeCapabilityRegistry;
  private readonly profileMap: KnowledgeProfileMap;
  private readonly workspaceRoot?: string;
  private readonly defaultMaxChunks: number;

  private readonly sources = new Map<string, KnowledgeSource>();
  private readonly scopes = new Map<string, KnowledgeScope>();
  private readonly engineConfigs = new Map<string, EngineRecord>();

  constructor(options: KnowledgeServiceOptions) {
    this.logger = options.logger ?? createNullLogger();
    this.config = normalizeConfig(options.config);
    this.capabilities = options.capabilities;
    this.registry =
      options.registry ?? createKnowledgeEngineRegistry(this.logger);
    this.profileMap = createProfileMap(options.profiles);
    this.workspaceRoot = options.workspaceRoot;
    this.defaultMaxChunks = options.defaultMaxChunks ?? DEFAULT_MAX_CHUNKS;

    for (const source of this.config.sources) {
      this.sources.set(source.id, source);
    }

    for (const scope of this.config.scopes) {
      this.scopes.set(scope.id, scope);
    }

    for (const engineConfig of this.config.engines) {
      this.engineConfigs.set(engineConfig.id, { config: engineConfig });
    }
  }

  async query(request: KnowledgeQuery): Promise<KnowledgeResult> {
    const context = await this.resolveQueryContext(request);
    const engine = await this.ensureEngine(context.engineConfig.id);
    const engineResult = await engine.query(
      { ...request, limit: context.limit, scopeId: context.scope.id },
      {
        scope: context.scope,
        sources: context.sources,
        limit: context.limit,
        filters: context.filters,
        capability: context.capability,
        profile: context.profileOverride?.profile,
      } satisfies KnowledgeExecutionContext,
    );

    return {
      ...engineResult,
      engineId: engineResult.engineId ?? context.engineConfig.id,
      query: { ...engineResult.query, limit: context.limit },
      generatedAt: engineResult.generatedAt ?? new Date().toISOString(),
    };
  }

  async index(scopeId: string, options?: { force?: boolean }): Promise<IndexingStats | void> {
    const scope = this.scopes.get(scopeId);
    if (!scope) {
      throw createKnowledgeError(
        'KNOWLEDGE_SCOPE_NOT_FOUND',
        `Scope "${scopeId}" is not defined.`,
        { meta: { scopeId } },
      );
    }
    const sources = scope.sources.map(sourceId => {
      const source = this.sources.get(sourceId);
      if (!source) {
        throw createKnowledgeError(
          'KNOWLEDGE_SOURCE_NOT_FOUND',
          `Scope "${scope.id}" references unknown source "${sourceId}".`,
          { meta: { scopeId: scope.id, sourceId } },
        );
      }
      return source;
    });
    const engineConfig = this.resolveEngineForScope(scope);
    const engine = await this.ensureEngine(engineConfig.id);
    if (!engine.index) {
      this.logger.warn?.(
        '[knowledge-core] Engine does not implement index(); skipping.',
        { engineId: engineConfig.id, scopeId: scope.id },
      );
      return;
    }
    return engine.index(sources, { scope, force: options?.force, workspaceRoot: this.workspaceRoot });
  }

  private async resolveQueryContext(
    request: KnowledgeQuery,
  ): Promise<ResolvedScopeContext> {
    const capability = getCapability(this.capabilities, request.productId);
    ensureIntentAllowed(capability, request.intent);

    const profileOverride = resolveProfileSettings(
      request.profileId,
      request.productId,
      this.profileMap,
    );

    const scope = this.resolveScopeId(request, capability, profileOverride);
    ensureScopeAllowed(capability, scope.id);
    const sources = this.resolveScopeSources(scope);
    const limit = this.resolveLimit(request, capability, profileOverride);
    const filters = this.resolveFilters(request, scope);
    const engineConfig = this.resolveEngineForScope(scope, profileOverride);

    return {
      scope,
      sources,
      capability,
      profileOverride,
      limit,
      filters,
      engineConfig,
    };
  }

  private resolveScopeId(
    request: KnowledgeQuery,
    capability: KnowledgeCapability,
    profileOverride?: ResolvedProfileSettings,
  ): KnowledgeScope {
    const candidateIds = [
      profileOverride?.settings.scopeId,
      request.scopeId,
      capability.defaultScopeId,
      this.config.defaults?.fallbackScopeId,
    ];

    for (const scopeId of candidateIds) {
      if (!scopeId) continue;
      const scope = this.scopes.get(scopeId);
      if (scope) {
        return scope;
      }
    }

    throw createKnowledgeError(
      'KNOWLEDGE_SCOPE_NOT_FOUND',
      'Unable to resolve a scope for the provided query.',
      {
        meta: {
          requested: request.scopeId,
          capabilityDefault: capability.defaultScopeId,
          fallback: this.config.defaults?.fallbackScopeId,
        },
      },
    );
  }

  private resolveScopeSources(scope: KnowledgeScope): KnowledgeSource[] {
    return scope.sources.map(sourceId => {
      const source = this.sources.get(sourceId);
      if (!source) {
        throw createKnowledgeError(
          'KNOWLEDGE_SOURCE_NOT_FOUND',
          `Scope "${scope.id}" references unknown source "${sourceId}".`,
          { meta: { scopeId: scope.id, sourceId } },
        );
      }
      return source;
    });
  }

  private resolveFilters(
    request: KnowledgeQuery,
    scope: KnowledgeScope,
  ): KnowledgeQueryFilters | undefined {
    if (!request.filters) {
      return undefined;
    }
    if (request.filters.sourceIds) {
      const allowed = new Set(scope.sources);
      const sanitized = request.filters.sourceIds.filter(sourceId =>
        allowed.has(sourceId),
      );
      if (sanitized.length === 0) {
        throw createKnowledgeError(
          'KNOWLEDGE_QUERY_INVALID',
          'Requested source filters are not part of the selected scope.',
          { meta: { scopeId: scope.id, requested: request.filters.sourceIds } },
        );
      }
      return { ...request.filters, sourceIds: sanitized };
    }
    return request.filters;
  }

  private resolveEngineForScope(
    scope: KnowledgeScope,
    profileOverride?: ResolvedProfileSettings,
  ): KnowledgeEngineConfig {
    const candidateEngineIds = [
      profileOverride?.settings.engineId,
      scope.defaultEngine,
      this.config.defaults?.fallbackEngineId,
    ];

    for (const engineId of candidateEngineIds) {
      if (!engineId) continue;
      const record = this.engineConfigs.get(engineId);
      if (record) {
        return record.config;
      }
    }

    throw createKnowledgeError(
      'KNOWLEDGE_ENGINE_NOT_FOUND',
      `Unable to find an engine for scope "${scope.id}".`,
      {
        meta: {
          scopeId: scope.id,
          candidates: candidateEngineIds,
        },
      },
    );
  }

  private resolveLimit(
    request: KnowledgeQuery,
    capability: KnowledgeCapability,
    profileOverride?: ResolvedProfileSettings,
  ): number {
    const candidateLimits = [
      request.limit,
      profileOverride?.settings.maxChunks,
      capability.maxChunks,
      this.config.defaults?.maxChunks,
      this.defaultMaxChunks,
    ].filter((value): value is number => typeof value === 'number');

    if (candidateLimits.length === 0) {
      return DEFAULT_MAX_CHUNKS;
    }

    let limit = candidateLimits[0]!;
    for (const value of candidateLimits.slice(1)) {
      limit = Math.min(limit, value);
    }
    return Math.max(1, limit);
  }

  private async ensureEngine(engineId: string): Promise<KnowledgeEngine> {
    const record = this.engineConfigs.get(engineId);
    if (!record) {
      throw createKnowledgeError(
        'KNOWLEDGE_ENGINE_NOT_FOUND',
        `Knowledge engine "${engineId}" is not defined.`,
        { meta: { engineId } },
      );
    }

    if (record.instance) {
      return record.instance;
    }

    if (!record.promise) {
      record.promise = this.instantiateEngine(record);
    }

    const instance = await record.promise;
    record.instance = instance;
    record.promise = undefined;
    return instance;
  }

  private async instantiateEngine(record: EngineRecord): Promise<KnowledgeEngine> {
    try {
      const context: KnowledgeEngineFactoryContext = {
        workspaceRoot: this.workspaceRoot,
        logger: this.logger,
      };
      const engine = this.registry.create(record.config, context);
      if (engine.init) {
        await engine.init(record.config.options);
      }
      return engine;
    } catch (error) {
      console.error('[instantiateEngine] Error details:', error);
      console.error('[instantiateEngine] Engine config:', record.config);
      throw createKnowledgeError(
        'KNOWLEDGE_ENGINE_FAILED',
        `Failed to initialize engine "${record.config.id}".`,
        {
          cause: error,
          meta: { engineId: record.config.id, type: record.config.type },
        },
      );
    }
  }
}

export function createKnowledgeService(
  options: KnowledgeServiceOptions,
): KnowledgeService {
  return new KnowledgeOrchestrator(options);
}
