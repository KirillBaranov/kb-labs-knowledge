import { z } from 'zod'
import {
  knowledgeEngineTypes,
  knowledgeIntents,
  knowledgeSourceKinds,
} from './types'

export const spanRangeSchema = z
  .object({
    startLine: z.number().nonnegative(),
    endLine: z.number().nonnegative(),
  })
  .refine(data => data.endLine >= data.startLine, {
    message: 'endLine must be >= startLine',
  })

export const knowledgeSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  kind: z.enum(knowledgeSourceKinds),
  language: z.string().optional(),
  paths: z.array(z.string()).nonempty(),
  exclude: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
})

export const knowledgeScopeSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  sources: z.array(z.string()).nonempty(),
  defaultEngine: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

export const knowledgeEngineConfigSchema = z.object({
  id: z.string().min(1),
  type: z.union([z.enum(knowledgeEngineTypes), z.string().min(1)]),
  options: z.record(z.any()).optional(),
  llmEngineId: z.string().optional(),
  preferredEmbeddingModel: z.string().optional(),
  metadata: z.record(z.any()).optional(),
})

export const knowledgeDefaultsSchema = z.object({
  maxChunks: z.number().int().positive().optional(),
  embeddingModel: z.string().optional(),
  fallbackScopeId: z.string().optional(),
  fallbackEngineId: z.string().optional(),
})

export const knowledgeConfigSchema = z.object({
  sources: z.array(knowledgeSourceSchema),
  scopes: z.array(knowledgeScopeSchema),
  engines: z.array(knowledgeEngineConfigSchema),
  defaults: knowledgeDefaultsSchema.optional(),
})

export const knowledgeQuerySchema = z.object({
  productId: z.string().min(1),
  intent: z.enum(knowledgeIntents),
  scopeId: z.string().min(1),
  profileId: z.string().optional(),
  text: z.string().min(1),
  limit: z.number().int().positive().optional(),
  filters: z
    .object({
      sourceIds: z.array(z.string()).optional(),
      paths: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      metadata: z.record(z.any()).optional(),
    })
    .optional(),
  metadata: z.record(z.any()).optional(),
})

export const knowledgeCapabilitySchema = z.object({
  productId: z.string().min(1),
  allowedIntents: z.array(z.enum(knowledgeIntents)).nonempty(),
  allowedScopes: z.array(z.string()).nonempty(),
  maxChunks: z.number().int().positive().optional(),
  defaultScopeId: z.string().optional(),
  description: z.string().optional(),
})

export type KnowledgeConfigInput = z.input<typeof knowledgeConfigSchema>
export type KnowledgeCapabilityInput = z.input<typeof knowledgeCapabilitySchema>

export const knowledgeProfileSettingsSchema = z.object({
  scopeId: z.string().optional(),
  engineId: z.string().optional(),
  maxChunks: z.number().int().positive().optional(),
})

export const knowledgeProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  products: z.record(knowledgeProfileSettingsSchema).default({}),
})
