/**
 * Agent Response Types
 *
 * These types define the contract for agent-friendly query responses.
 * Used by orchestrators (like mind-orchestrator) to return results
 * optimized for AI agents (Claude Code, AI Review, etc.)
 */

// === MODES ===
export type AgentQueryMode = 'instant' | 'auto' | 'thinking';

// === SOURCE KINDS ===
export type AgentSourceKind = 'code' | 'doc' | 'adr' | 'config' | 'external';

// === SOURCE ===
export interface AgentSource {
  file: string;
  lines: [number, number];
  snippet: string;
  relevance: string;
  kind: AgentSourceKind;

  // For external sources
  sourceProvider?: string;
  externalUrl?: string;
  externalTitle?: string;
}

// === METADATA ===
export interface AgentMeta {
  schemaVersion: string;             // "agent-response-v1"
  requestId: string;
  mode: AgentQueryMode;
  timingMs: number;
  cached: boolean;
  indexVersion?: string;

  // LLM stats
  llmCalls?: number;
  tokensIn?: number;
  tokensOut?: number;
}

// === SUGGESTIONS ===
export interface AgentSuggestion {
  type: 'adr' | 'repo' | 'doc' | 'file' | 'next-question';
  label: string;
  ref: string;
}

// === WARNING CODES ===
export type AgentWarningCode =
  | 'STALE_INDEX'           // Index may be outdated vs git HEAD
  | 'UNVERIFIED_SOURCE'     // Source file/snippet not found
  | 'UNVERIFIED_FIELD'      // Mentioned field not found in source
  | 'LOW_CONFIDENCE'        // Answer confidence below threshold
  | 'INCOMPLETE_CONTEXT'    // Not all relevant chunks retrieved
  | 'TRUNCATED_SOURCES'     // Some sources truncated due to token limits
  | 'FALLBACK_MODE';        // Fell back to simpler mode due to error

// === WARNING ===
export interface AgentWarning {
  code: AgentWarningCode;
  message: string;
  details?: {
    field?: string;         // For UNVERIFIED_FIELD
    file?: string;          // For UNVERIFIED_SOURCE
    expectedRevision?: string;  // For STALE_INDEX
    actualRevision?: string;    // For STALE_INDEX
    originalMode?: AgentQueryMode;  // For FALLBACK_MODE
    fallbackMode?: AgentQueryMode;  // For FALLBACK_MODE
  };
}

// === DEBUG INFO ===
export interface AgentDebugInfo {
  matchesTotal: number;
  matchesUsed: number;
  subqueries?: string[];
  dedupStrategy: string;
  compressionApplied: boolean;
}

// === SOURCES SUMMARY ===
export interface AgentSourcesSummary {
  code: number;
  docs: number;
  external: Record<string, number>;
}

// === SUCCESS RESPONSE ===
export interface AgentResponse {
  answer: string;
  sources: AgentSource[];
  confidence: number;
  complete: boolean;
  suggestions?: AgentSuggestion[];
  warnings?: AgentWarning[];
  sourcesSummary?: AgentSourcesSummary;
  meta: AgentMeta;
  debug?: AgentDebugInfo;
}

// === ERROR CODES ===
export type AgentErrorCode =
  | 'NO_MATCHES'
  | 'INDEX_NOT_FOUND'
  | 'INDEX_OUTDATED'
  | 'ENGINE_ERROR'
  | 'LLM_ERROR'
  | 'TIMEOUT'
  | 'INVALID_QUERY'
  // Knowledge-level errors
  | 'KNOWLEDGE_CAPABILITY_MISSING'
  | 'KNOWLEDGE_ACCESS_DENIED'
  | 'KNOWLEDGE_SCOPE_NOT_FOUND';

// === ERROR RESPONSE ===
export interface AgentErrorResponse {
  error: {
    code: AgentErrorCode;
    message: string;
    details?: unknown;
    recoverable: boolean;
  };
  meta: AgentMeta;
}

// === TYPE GUARDS ===
export function isAgentError(
  response: AgentResponse | AgentErrorResponse
): response is AgentErrorResponse {
  return 'error' in response;
}

export function isAgentSuccess(
  response: AgentResponse | AgentErrorResponse
): response is AgentResponse {
  return 'answer' in response;
}

// === CONSTANTS ===
export const AGENT_RESPONSE_SCHEMA_VERSION = 'agent-response-v1';

// === CONFIDENCE THRESHOLDS ===
export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.8,      // Can use directly
  MEDIUM: 0.5,    // Consider thinking mode
  LOW: 0.2,       // Practically "don't know"
} as const;
