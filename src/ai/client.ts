import { FEATURES } from '../config/features';
import type { AiGatewayConfig, AiProviderId, AiTurnRequest, AiTurnResponse } from './types';

function requireAiEnabled() {
  if (!FEATURES.aiExperiment) throw new Error('The AI experiment is disabled.');
}


async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | T | null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `AI gateway request failed (${response.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export async function getAiGatewayConfig(signal?: AbortSignal) {
  requireAiEnabled();
  const config = await readResponse<AiGatewayConfig>(await fetch('/api/ai/config', { signal }));
  if (!config || !Array.isArray(config.ollamaEndpoints)) throw new Error('Connection settings are unavailable. Please try again.');
  return config;
}

export async function listAiModels(input: {
  provider: AiProviderId;
  credential?: string;
  ollamaEndpoint?: string;
}, signal?: AbortSignal) {
  requireAiEnabled();
  const response = await fetch('/api/ai/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal
  });
  const body = await readResponse<{ models: string[] }>(response);
  if (!body || !Array.isArray(body.models) || body.models.some(model => typeof model !== 'string')) throw new Error('The provider could not list its models. Please try again.');
  return body;
}

export async function sendAiTurn(request: AiTurnRequest, signal?: AbortSignal) {
  requireAiEnabled();
  const response = await fetch('/api/ai/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request), signal
  });
  const body = await readResponse<AiTurnResponse>(response);
  if (!body || typeof body.message !== 'string' || !body.capabilities
    || (body.proposal && (typeof body.proposal.summary !== 'string' || typeof body.proposal.baseRevision !== 'string'
      || !Array.isArray(body.proposal.operations) || body.proposal.operations.some(operation => !operation
        || !['move-object', 'rotate-object', 'add-object', 'remove-object'].includes(operation.type)
        || typeof operation.objectId !== 'string' || typeof operation.productId !== 'string'
        || ![operation.x, operation.z, operation.rotationDegrees].every(Number.isFinite))))) {
    throw new Error('The assistant returned an unreadable response. Nothing changed. Please try again.');
  }
  return body;
}
