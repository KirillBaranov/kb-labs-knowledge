import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {
  KnowledgeExecutionContext,
  KnowledgeLogger,
} from '@kb-labs/knowledge-core';
import {
  FileSystemKnowledgeEngine,
  type FileSystemEngineConfigOptions,
} from '../fs-engine';

const scope = {
  id: 'default',
  sources: ['repo-code'],
};

const source = {
  id: 'repo-code',
  kind: 'code',
  paths: ['src/**/*.ts'],
};

const logger: KnowledgeLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

describe('FileSystemKnowledgeEngine', () => {
  let workspace: string;
  let engine: FileSystemKnowledgeEngine;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-fs-'));
    await fs.ensureDir(path.join(workspace, 'src'));
    await fs.writeFile(
      path.join(workspace, 'src', 'index.ts'),
      ['export function greet(name: string) {', '  return `Hello ${name}`;', '}'].join(
        '\n',
      ),
      'utf8',
    );

    const options: FileSystemEngineConfigOptions = {
      indexDir: '.kb/index',
      chunkSize: 10,
    };

    engine = new FileSystemKnowledgeEngine(
      'fs-engine',
      options,
      { workspaceRoot: workspace, logger },
    );
    await engine.init(options);
  });

  afterEach(async () => {
    await fs.remove(workspace);
  });

  it('indexes files and answers queries from the local index', async () => {
    await engine.index([source], { scope, force: true });

    const executionContext: KnowledgeExecutionContext = {
      scope,
      sources: [source],
      limit: 5,
    };

    const result = await engine.query(
      {
        productId: 'aiReview',
        intent: 'summary',
        scopeId: 'default',
        text: 'Hello',
      },
      executionContext,
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]?.text).toContain('Hello');
  });
});
