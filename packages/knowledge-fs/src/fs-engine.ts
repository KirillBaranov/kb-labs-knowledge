import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createWriteStream, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
    await fs.ensureDir(this.options.indexDir);
    const indexPath = this.getScopeIndexPath(options.scope);
    
    // CRITICAL: Use streaming write from the start to prevent accumulating all chunks in memory
    // This prevents OOM when processing large codebases with many files
    const stream = createWriteStream(indexPath, { encoding: 'utf-8' });
    const generatedAt = new Date().toISOString();
    
    // Write JSON header
    stream.write('{"scopeId":');
    stream.write(JSON.stringify(options.scope.id));
    stream.write(',"generatedAt":');
    stream.write(JSON.stringify(generatedAt));
    stream.write(',"chunks":[');

    let totalChunks = 0;
    let isFirstChunk = true;

    // Threshold for quality chunking vs streaming (500KB as per plan)
    const QUALITY_CHUNKING_THRESHOLD = 500 * 1024; // 500KB

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
        
        // Check file size before reading
        const stats = await fsp.stat(absolutePath);
        const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit
        if (stats.size > MAX_FILE_SIZE) {
          this.logger.warn?.('[knowledge-fs] Skipping large file', {
            path: relativePath,
            size: stats.size,
          });
          continue;
        }
        
        // Use hybrid approach: quality chunking for small files, streaming for large
        const normalizedPath = relativePath.replace(/\\/g, '/');
        const useQuality = stats.size < QUALITY_CHUNKING_THRESHOLD;
        
        if (useQuality) {
          // For small files: read into memory and use quality chunking
          let contents = await fsp.readFile(absolutePath, this.options.encoding);
          const chunks = this.chunkFileWithQuality(
            source,
            normalizedPath,
            contents,
          );

          // Write chunks immediately to stream
          for (const chunk of chunks) {
            if (!isFirstChunk) {
              stream.write(',');
            }
            this.writeChunkToStream(chunk, stream);
            isFirstChunk = false;
            totalChunks++;
          }

          // Clear reference to help GC
          // @ts-ignore - help GC
          contents = '';
          chunks.length = 0;
        } else {
          // For large files: use streaming line-by-line
          const result = await this.chunkFileStreaming(
            source,
            normalizedPath,
            absolutePath,
            stream,
            isFirstChunk,
          );
          totalChunks += result.chunkCount;
          isFirstChunk = result.isFirstChunk;
        }
      }
    }

    // Write JSON footer
    stream.write(']}');
    stream.end();

    // Wait for stream to finish
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });
    
    this.logger.info?.('[knowledge-fs] Indexed scope.', {
      scopeId: options.scope.id,
      chunks: totalChunks,
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


  /**
   * Write a single chunk to stream in JSON format
   */
  private writeChunkToStream(chunk: StoredChunk, stream: NodeJS.WritableStream): void {
    stream.write('{');
    stream.write(`"id":${JSON.stringify(chunk.id)}`);
    stream.write(`,"sourceId":${JSON.stringify(chunk.sourceId)}`);
    stream.write(`,"path":${JSON.stringify(chunk.path)}`);
    stream.write(`,"span":${JSON.stringify(chunk.span)}`);
    stream.write(`,"text":${JSON.stringify(chunk.text)}`);
    if (chunk.metadata) {
      stream.write(`,"metadata":${JSON.stringify(chunk.metadata)}`);
    }
    stream.write('}');
  }

  /**
   * Quality chunking for small files
   * Uses regex-based chunking for TS/JS, heading-based for Markdown
   */
  private chunkFileWithQuality(
    source: KnowledgeSource,
    relativePath: string,
    contents: string,
  ): StoredChunk[] {
    const ext = path.extname(relativePath).toLowerCase();
    
    // TypeScript/JavaScript: use regex-based chunking
    if (ext.match(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/)) {
      return this.chunkTypeScriptRegex(source, relativePath, contents);
    }
    
    // Markdown: use heading-based chunking
    if (ext.match(/\.(md|mdx|markdown)$/)) {
      return this.chunkMarkdownHeadings(source, relativePath, contents);
    }
    
    // Fallback to line-based chunking
    return this.chunkFile(source, relativePath, contents);
  }

  /**
   * Streaming chunking for large files
   * Processes file line-by-line and writes chunks directly to stream
   */
  private async chunkFileStreaming(
    source: KnowledgeSource,
    relativePath: string,
    absolutePath: string,
    stream: NodeJS.WritableStream,
    isFirstChunk: boolean,
  ): Promise<{ chunkCount: number; isFirstChunk: boolean }> {
    return new Promise((resolve, reject) => {
      const fileStream = createReadStream(absolutePath, { encoding: this.options.encoding });
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const chunkSize = this.options.chunkSize;
      const overlap = this.options.chunkOverlap;
      let chunkLines: string[] = [];
      let chunkStartLine = 1;
      let currentLine = 1;
      let currentIsFirstChunk = isFirstChunk;
      let chunkCount = 0;

      rl.on('line', (line) => {
        chunkLines.push(line);

        if (chunkLines.length >= chunkSize) {
          // Write chunk to stream
          if (!currentIsFirstChunk) {
            stream.write(',');
          }
          
          const text = chunkLines.join('\n');
          const spanEnd = currentLine;
          const chunk: StoredChunk = {
            id: `${source.id}:${relativePath}:${chunkStartLine}-${spanEnd}`,
            sourceId: source.id,
            path: relativePath,
            span: { startLine: chunkStartLine, endLine: spanEnd },
            text,
            metadata: { language: source.language, kind: source.kind },
          };
          
          this.writeChunkToStream(chunk, stream);
          
          currentIsFirstChunk = false;
          chunkCount++;

          // Prepare for next chunk with overlap
          if (overlap > 0 && chunkLines.length > overlap) {
            chunkLines = chunkLines.slice(-overlap);
            chunkStartLine = spanEnd - overlap + 1;
          } else {
            chunkLines = [];
            chunkStartLine = currentLine + 1;
          }
        }

        currentLine++;
      });

      rl.on('close', () => {
        // Write remaining lines as final chunk
        if (chunkLines.length > 0) {
          if (!currentIsFirstChunk) {
            stream.write(',');
          }
          
          const text = chunkLines.join('\n');
          const chunk: StoredChunk = {
            id: `${source.id}:${relativePath}:${chunkStartLine}-${currentLine - 1}`,
            sourceId: source.id,
            path: relativePath,
            span: { startLine: chunkStartLine, endLine: currentLine - 1 },
            text,
            metadata: { language: source.language, kind: source.kind },
          };
          
          this.writeChunkToStream(chunk, stream);
          
          currentIsFirstChunk = false;
          chunkCount++;
        }
        
        resolve({ chunkCount, isFirstChunk: currentIsFirstChunk });
      });

      rl.on('error', reject);
      fileStream.on('error', reject);
    });
  }

  /**
   * Regex-based chunking for TypeScript/JavaScript files
   * Extracts functions, classes, interfaces, types as separate chunks
   */
  private chunkTypeScriptRegex(
    source: KnowledgeSource,
    relativePath: string,
    contents: string,
  ): StoredChunk[] {
    const chunks: StoredChunk[] = [];
    const lines = contents.split(/\r?\n/);
    
    // Patterns for different declaration types
    const patterns = [
      { type: 'function', pattern: /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g },
      { type: 'class', pattern: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g },
      { type: 'interface', pattern: /(?:export\s+)?interface\s+(\w+)/g },
      { type: 'type', pattern: /(?:export\s+)?type\s+(\w+)\s*=/g },
      { type: 'const', pattern: /(?:export\s+)?const\s+(\w+)\s*=/g },
    ];

    const declarations: Array<{
      type: string;
      name: string;
      startLine: number;
      endLine: number;
      text: string;
    }> = [];

    for (const { type, pattern } of patterns) {
      let match;
      while ((match = pattern.exec(contents)) !== null) {
        const name = match[1];
        if (!name) continue;

        const startIndex = match.index;
        const startLine = contents.substring(0, startIndex).split('\n').length;
        
        // Find end of declaration (simplified - find matching brace)
        let braceCount = 0;
        let inString = false;
        let stringChar = '';
        let endIndex = startIndex;
        
        for (let i = startIndex; i < contents.length; i++) {
          const char = contents[i];
          if (!inString && (char === '"' || char === "'" || char === '`')) {
            inString = true;
            stringChar = char;
          } else if (inString && char === stringChar && contents[i - 1] !== '\\') {
            inString = false;
          } else if (!inString) {
            if (char === '{') braceCount++;
            else if (char === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIndex = i + 1;
                break;
              }
            } else if (braceCount === 0 && char === ';' && type !== 'function' && type !== 'class' && type !== 'interface') {
              endIndex = i + 1;
              break;
            }
          }
        }

        const endLine = contents.substring(0, endIndex).split('\n').length;
        const text = contents.substring(startIndex, endIndex);

        declarations.push({ type, name, startLine, endLine, text });
      }
    }

    // Sort by start line and create chunks
    declarations.sort((a, b) => a.startLine - b.startLine);
    
    for (const decl of declarations) {
      chunks.push({
        id: `${source.id}:${relativePath}:${decl.startLine}-${decl.endLine}`,
        sourceId: source.id,
        path: relativePath,
        span: { startLine: decl.startLine, endLine: decl.endLine },
        text: decl.text,
        metadata: {
          language: source.language,
          kind: source.kind,
          declarationType: decl.type,
          declarationName: decl.name,
        },
      });
    }

    // If no declarations found, fall back to line-based chunking
    if (chunks.length === 0) {
      return this.chunkFile(source, relativePath, contents);
    }

    return chunks;
  }

  /**
   * Heading-based chunking for Markdown files
   */
  private chunkMarkdownHeadings(
    source: KnowledgeSource,
    relativePath: string,
    contents: string,
  ): StoredChunk[] {
    const chunks: StoredChunk[] = [];
    const lines = contents.split(/\r?\n/);
    
    let currentChunk: {
      startLine: number;
      title?: string;
      lines: string[];
    } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save previous chunk if exists
        if (currentChunk && currentChunk.lines.length >= 10) {
          chunks.push({
            id: `${source.id}:${relativePath}:${currentChunk.startLine}-${currentChunk.startLine + currentChunk.lines.length - 1}`,
            sourceId: source.id,
            path: relativePath,
            span: {
              startLine: currentChunk.startLine,
              endLine: currentChunk.startLine + currentChunk.lines.length - 1,
            },
            text: currentChunk.lines.join('\n'),
            metadata: {
              language: source.language,
              kind: source.kind,
              headingTitle: currentChunk.title,
            },
          });
        }

        // Start new chunk
        const title = headingMatch[2]!.trim();
        currentChunk = {
          startLine: i + 1,
          title,
          lines: [line],
        };
      } else if (currentChunk) {
        currentChunk.lines.push(line);
      } else {
        // Content before first heading
        currentChunk = {
          startLine: i + 1,
          lines: [line],
        };
      }
    }

    // Save final chunk
    if (currentChunk && currentChunk.lines.length > 0) {
      chunks.push({
        id: `${source.id}:${relativePath}:${currentChunk.startLine}-${currentChunk.startLine + currentChunk.lines.length - 1}`,
        sourceId: source.id,
        path: relativePath,
        span: {
          startLine: currentChunk.startLine,
          endLine: currentChunk.startLine + currentChunk.lines.length - 1,
        },
        text: currentChunk.lines.join('\n'),
        metadata: {
          language: source.language,
          kind: source.kind,
          headingTitle: currentChunk.title,
        },
      });
    }

    // If no chunks found, fall back to line-based chunking
    if (chunks.length === 0) {
      return this.chunkFile(source, relativePath, contents);
    }

    return chunks;
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
    // CRITICAL: Don't use split() on large files - it creates huge arrays in memory
    // Instead, process file iteratively to avoid OOM
    const chunks: StoredChunk[] = [];
    const chunkSize = this.options.chunkSize;
    const overlap = this.options.chunkOverlap;

    // CRITICAL: Use iterative processing for files > 1MB to prevent OOM
    // Even "small" files can cause issues when processing many files
    const MAX_SPLIT_SIZE = 1 * 1024 * 1024; // 1MB threshold (lowered from 10MB)
    if (contents.length > MAX_SPLIT_SIZE) {
      return this.chunkFileIterative(source, relativePath, contents, chunkSize, overlap);
    }

    // For very small files, use split (acceptable for files < 1MB)
    const lines = contents.split(/\r?\n/);
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

  /**
   * Chunk large files iteratively without creating full line array
   * Prevents OOM from split() on huge files
   */
  private chunkFileIterative(
    source: KnowledgeSource,
    relativePath: string,
    contents: string,
    chunkSize: number,
    overlap: number,
  ): StoredChunk[] {
    const chunks: StoredChunk[] = [];
    const lineEnding = /\r?\n/;
    let currentLine = 1;
    let chunkStartLine = 1;
    let chunkLines: string[] = [];
    let lastChunkEndLine = 0;

    let pos = 0;
    while (pos < contents.length) {
      // Find next line ending - use indexOf instead of match to avoid creating substrings
      let lineEndPos = contents.indexOf('\n', pos);
      if (lineEndPos === -1) {
        lineEndPos = contents.length;
      } else {
        // Check for \r\n
        if (lineEndPos > 0 && contents[lineEndPos - 1] === '\r') {
          lineEndPos--; // Include \r in line ending
        }
        lineEndPos++; // Move past \n
      }
      
      // Extract line (without line ending) - only create substring when needed
      const lineEnd = lineEndPos > pos && contents[lineEndPos - 1] === '\n' 
        ? (contents[lineEndPos - 2] === '\r' ? lineEndPos - 2 : lineEndPos - 1)
        : lineEndPos;
      const line = contents.substring(pos, lineEnd);
      chunkLines.push(line);
      currentLine++;
      
      // Update pos to after line ending
      pos = lineEndPos;

      // If we've collected enough lines for a chunk
      if (chunkLines.length >= chunkSize) {
        const text = chunkLines.join('\n');
        const spanEnd = currentLine - 1;
        chunks.push({
          id: `${source.id}:${relativePath}:${chunkStartLine}-${spanEnd}`,
          sourceId: source.id,
          path: relativePath,
          span: { startLine: chunkStartLine, endLine: spanEnd },
          text,
          metadata: { language: source.language, kind: source.kind },
        });

        // Prepare for next chunk with overlap
        lastChunkEndLine = spanEnd;
        if (overlap > 0 && chunkLines.length > overlap) {
          // Keep last 'overlap' lines for next chunk
          chunkLines = chunkLines.slice(-overlap);
          chunkStartLine = lastChunkEndLine - overlap + 1;
        } else {
          chunkLines = [];
          chunkStartLine = currentLine;
        }
      }
    }

    // Handle remaining lines
    if (chunkLines.length > 0) {
      const text = chunkLines.join('\n');
      chunks.push({
        id: `${source.id}:${relativePath}:${chunkStartLine}-${currentLine - 1}`,
        sourceId: source.id,
        path: relativePath,
        span: { startLine: chunkStartLine, endLine: currentLine - 1 },
        text,
        metadata: { language: source.language, kind: source.kind },
      });
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
