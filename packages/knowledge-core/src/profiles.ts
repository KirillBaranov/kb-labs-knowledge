import type {
  KnowledgeProfile,
  KnowledgeProfileSettings,
} from '@kb-labs/knowledge-contracts';

export type KnowledgeProfileMap = Map<string, KnowledgeProfile>;

export function createProfileMap(
  profiles?: KnowledgeProfile[],
): KnowledgeProfileMap {
  const map: KnowledgeProfileMap = new Map();
  if (profiles) {
    for (const profile of profiles) {
      map.set(profile.id, profile);
    }
  }
  return map;
}

export interface ResolvedProfileSettings {
  profile: KnowledgeProfile;
  settings: KnowledgeProfileSettings;
}

export function resolveProfileSettings(
  profileId: string | undefined,
  productId: string,
  profileMap: KnowledgeProfileMap,
): ResolvedProfileSettings | undefined {
  if (!profileId) {
    return undefined;
  }
  const profile = profileMap.get(profileId);
  if (!profile) {
    return undefined;
  }
  const settings = profile.products[productId];
  if (!settings) {
    return undefined;
  }
  return { profile, settings };
}
