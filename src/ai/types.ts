import type { PlannerSnapshot, ProductKind } from '../core/types';

export type AiProviderId = 'gemini' | 'openai' | 'ollama';

export type AiChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AiOperation = {
  type: 'move-object' | 'rotate-object' | 'add-object' | 'remove-object';
  objectId: string;
  productId: ProductKind | '';
  x: number;
  z: number;
  rotationDegrees: number;
};

export type AiProposal = {
  baseRevision: string;
  summary: string;
  operations: AiOperation[];
};

export type AiCapabilities = {
  advice: boolean;
  proposals: boolean;
  structuredOutput: boolean;
};

export type AiTurnResponse = {
  message: string;
  proposal: AiProposal | null;
  capabilities: AiCapabilities;
  provider: AiProviderId;
  model: string;
};

export type AiGatewayConfig = {
  experimental: true;
  ollamaEndpoints: Array<{ id: string; label: string }>;
};

export type AiTurnRequest = {
  provider: AiProviderId;
  model: string;
  credential?: string;
  ollamaEndpoint?: string;
  messages: AiChatMessage[];
  snapshot: PlannerSnapshot;
  projectRevision: string;
  productCatalog: Array<{
    id: ProductKind;
    name: string;
    width: number;
    depth: number;
    height: number;
  }>;
};

export type AiApplyResult = { ok: true } | { ok: false; error: string };

export type AiBrowserSettings = {
  provider: AiProviderId;
  models: Record<AiProviderId, string>;
  ollamaEndpoint: string;
};
