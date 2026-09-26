import type { AiGatewayConfig, AiProviderId, AiTurnRequest, AiTurnResponse } from './types';

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

export async function getAiGatewayConfig() {
  return readResponse<AiGatewayConfig>(await fetch('/api/ai/config'));
}

export async function listAiModels(input: {
  provider: AiProviderId;
  credential?: string;
  ollamaEndpoint?: string;
}) {
  const response = await fetch('/api/ai/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  return readResponse<{ models: string[] }>(response);
}

export async function sendAiTurn(request: AiTurnRequest) {
  const response = await fetch('/api/ai/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  return readResponse<AiTurnResponse>(response);
}
