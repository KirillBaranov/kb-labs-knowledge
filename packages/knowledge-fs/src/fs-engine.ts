import path from 'node:path';
import { promises as fsp } from 'node:fs';
import fg from 'fast-glob';
import fs from 'fs-extra';
import picomatch from 'picomatch';
import {
  createKnowledgeError,
  type KnowledgeEngine,
  type KnowledgeEngineFactory,
  type KnowledgeEngineFactoryContext,
  type KnowledgeEngineRegistry,
  type KnowledgeExecutionContext,
  type KnowledgeIndexOptions,
  type KnowledgeLogger,
} from '@kb-labs/knowledge-core';
import type {
  KnowledgeEngineOptions,
  KnowledgeQuery,
  KnowledgeResult,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeChunk,
  SpanRange,
} from '@kb-labs/knowledge-contracts';

interface FileSystemEngineOptions {
  indexDir: string;
  chunkSize: number;
  chunkOverlap: number;
  encoding: BufferEncoding;
}

interface StoredChunk {
  id: string;
  sourceId: string;
  path: string;
  span: SpanRange;
  text: string;
  metadata?: Record<string, unknown>;
}

interface ScopeIndex {
  scopeId: string;
  generatedAt: string;
  chunks: StoredChunk[];
}

const DEFAULT_OPTIONS: FileSystemEngineOptions = {
  indexDir: '.kb/knowledge',
  chunkSize: 160,
  chunkOverlap: 20,
  encoding: 'utf8',
};

export interface FileSystemEngineConfigOptions
  extends KnowledgeEngineOptions {
  indexDir?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  encoding?: BufferEncoding;
}

export function createFileSystemKnowledgeEngineFactory(): KnowledgeEngineFactory {
  return (config, context) =>
    new FileSystemKnowledgeEngine(config.id, config.options, context);
}

export class FileSystemKnowledgeEngine implements KnowledgeEngine {
  readonly id: string;
  readonly type = 'fs';

  private readonly workspaceRoot: string;
  private readonly logger: KnowledgeLogger;
  private options: FileSystemEngineOptions;

  constructor(
    id: string,
    rawOptions: KnowledgeEngineOptions | undefined,
    context: KnowledgeEngineFactoryContext,
  ) {
    this.id = id;
    this.logger = context.logger;
    this.workspaceRoot = context.workspaceRoot ?? process.cwd();
    this.options = this.normalizeOptions(rawOptions);
  }

  async init(options?: KnowledgeEngineOptions): Promise<void> {
    if (options) {
      this.options = this.normalizeOptions(options);
    }
    await fs.ensureDir(this.options.indexDir);
  }

  async index(
    sources: KnowledgeSource[],
    options: KnowledgeIndexOptions,
  ): Promise<void> {
    const scopeIndex: ScopeIndex = {
      scopeId: options.scope.id,
      generatedAt: new Date().toISOString(),
      chunks: [],
    };

    for (const source of sources) {
      const files = await fg(source.paths, {
        cwd: this.workspaceRoot,
        ignore: source.exclude ?? [],
        dot: true,
        onlyFiles: true,
        unique: true,
      });
      for (const relativePath of files) {
        const absolutePath = path.resolve(this.workspaceRoot, relativePath);
        const contents = await fsp.readFile(
          absolutePath,
          this.options.encoding,
        );
        const chunks = this.chunkFile(
          source,
          relativePath.replace(/\\/g, '/'),
          contents,
        );
        scopeIndex.chunks.push(...chunks);
      }
    }

    await fs.ensureDir(this.options.indexDir);
    await fs.writeJson(this.getScopeIndexPath(options.scope), scopeIndex, {
      spaces: 2,
    });
    this.logger.info?.('[knowledge-fs] Indexed scope.', {
      scopeId: options.scope.id,
      chunks: scopeIndex.chunks.length,
    });
  }

  async query(
    query: KnowledgeQuery,
    context: KnowledgeExecutionContext,
  ): Promise<KnowledgeResult> {
    const index = await this.readScopeIndex(context.scope);
    const filteredChunks = this.filterChunks(index.chunks, query, context);
    const scoredChunks = this.scoreChunks(filteredChunks, query.text);
    const limited = scoredChunks.slice(0, context.limit);

    return {
      query,
      chunks: limited,
      contextText: limited.map(chunk => chunk.text).join('\n\n---\n\n'),
      engineId: this.id,
      generatedAt: new Date().toISOString(),
    };
  }

  private normalizeOptions(
    options: KnowledgeEngineOptions | undefined,
  ): FileSystemEngineOptions {
    const input = options as FileSystemEngineConfigOptions | undefined;
    const resolvedIndexDir = path.resolve(
      this.workspaceRoot,
      input?.indexDir ?? DEFAULT_OPTIONS.indexDir,
    );

    return {
      indexDir: resolvedIndexDir,
      chunkSize: input?.chunkSize && input.chunkSize > 0
        ? input.chunkSize
        : DEFAULT_OPTIONS.chunkSize,
      chunkOverlap: input?.chunkOverlap && input.chunkOverlap >= 0
        ? Math.min(input.chunkOverlap, DEFAULT_OPTIONS.chunkSize - 1)
        : DEFAULT_OPTIONS.chunkOverlap,
      encoding: input?.encoding ?? DEFAULT_OPTIONS.encoding,
    };
  }

  private chunkFile(
    source: KnowledgeSource,
    relativePath: string,
    contents: string,
  ): StoredChunk[] {
    const lines = contents.split(/\r?\n/);
    const chunks: StoredChunk[] = [];
    const chunkSize = this.options.chunkSize;
    const overlap = this.options.chunkOverlap;

    let start = 0;
    while (start < lines.length) {
      const end = Math.min(lines.length, start + chunkSize);
      const text = lines.slice(start, end).join('\n');
      const spanStart = start + 1;
      const spanEnd = end;
      chunks.push({
        id: `${source.id}:${relativePath}:${spanStart}-${spanEnd}`,
        sourceId: source.id,
        path: relativePath,
        span: { startLine: spanStart, endLine: spanEnd },
        text,
        metadata: { language: source.language, kind: source.kind },
      });
      if (end === lines.length) {
        break;
      }
      start = Math.max(0, end - overlap);
    }
    return chunks;
  }

  private getScopeIndexPath(scope: KnowledgeScope): string {
    const safeScopeId = scope.id.replace(/[\\/]/g, '_');
    return path.join(this.options.indexDir, `${safeScopeId}.json`);
  }

  private async readScopeIndex(scope: KnowledgeScope): Promise<ScopeIndex> {
    const filePath = this.getScopeIndexPath(scope);
    if (!(await fs.pathExists(filePath))) {
      throw createKnowledgeError(
        'KNOWLEDGE_INDEX_NOT_AVAILABLE',
        `Scope "${scope.id}" has not been indexed for engine "${this.id}".`,
        { meta: { scopeId: scope.id, engineId: this.id } },
      );
    }
    return fs.readJson(filePath);
  }

  private filterChunks(
    chunks: StoredChunk[],
    query: KnowledgeQuery,
    context: KnowledgeExecutionContext,
  ): StoredChunk[] {
    const pathMatcher =
      query.filters?.paths && query.filters.paths.length
        ? picomatch(query.filters.paths, { dot: true })
        : null;

    return chunks.filter(chunk => {
      if (query.filters?.sourceIds?.length) {
        if (!query.filters.sourceIds.includes(chunk.sourceId)) {
          return false;
        }
      }

      if (pathMatcher && !pathMatcher(chunk.path)) {
          return false;
      }

      if (query.filters?.languages?.length) {
        const source = context.sources.find(
          candidate => candidate.id === chunk.sourceId,
        );
        if (
          !source ||
          !source.language ||
          !query.filters.languages.includes(source.language)
        ) {
          return false;
        }
      }
      return true;
    });
  }

  private scoreChunks(
    chunks: StoredChunk[],
    text: string,
  ): KnowledgeChunk[] {
    if (!chunks.length) {
      return [];
    }
    const terms = text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const scored = chunks.map(chunk => {
      const lowerText = chunk.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (!term) continue;
        let index = lowerText.indexOf(term);
        while (index !== -1) {
          score += 1;
          index = lowerText.indexOf(term, index + term.length);
        }
      }
      return {
        ...chunk,
        score,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}

export function registerFileSystemEngine(
  registry: KnowledgeEngineRegistry,
): void {
  registry.register('fs', createFileSystemKnowledgeEngineFactory());
}
