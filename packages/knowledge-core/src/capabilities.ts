import type {
  KnowledgeCapability,
  KnowledgeCapabilityRegistry,
  KnowledgeIntent,
} from '@kb-labs/knowledge-contracts';
import { createKnowledgeError } from './errors.js';

export function getCapability(
  registry: KnowledgeCapabilityRegistry | undefined,
  productId: string,
): KnowledgeCapability {
  const capability = registry?.[productId];
  if (!capability) {
    throw createKnowledgeError(
      'KNOWLEDGE_CAPABILITY_MISSING',
      `No knowledge capability registered for product "${productId}".`,
      { meta: { productId } },
    );
  }
  return capability;
}

export function ensureIntentAllowed(
  capability: KnowledgeCapability,
  intent: KnowledgeIntent,
): void {
  if (!capability.allowedIntents.includes(intent)) {
    throw createKnowledgeError(
      'KNOWLEDGE_ACCESS_DENIED',
      `Intent "${intent}" is not permitted for product "${capability.productId}".`,
      {
        meta: {
          productId: capability.productId,
          intent,
          allowedIntents: capability.allowedIntents,
        },
      },
    );
  }
}

export function ensureScopeAllowed(
  capability: KnowledgeCapability,
  scopeId: string,
): void {
  if (!capability.allowedScopes.includes(scopeId)) {
    throw createKnowledgeError(
      'KNOWLEDGE_ACCESS_DENIED',
      `Scope "${scopeId}" is not permitted for product "${capability.productId}".`,
      {
        meta: {
          productId: capability.productId,
          scopeId,
          allowedScopes: capability.allowedScopes,
        },
      },
    );
  }
}
