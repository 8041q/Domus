import { FEATURES } from '../src/config/features';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { removalProposal, MAX_AI_REMOVALS } from '../src/ai/removalIntent';
import type { PlannerSnapshot } from '../src/core/types';

type ProviderId = 'gemini' | 'openai' | 'ollama';
type JsonRecord = Record<string, unknown>;

const MAX_BODY_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 45_000;
const UNUSABLE_PROPOSAL = 'The assistant could not prepare a usable proposal. Nothing changed. Try rephrasing your request.';
const PRODUCT_IDS = [
  'sofa', 'armchair', 'dining-table', 'coffee-table', 'chair',
  'cabinet', 'bookcase', 'rug', 'plant'
] as const;
const OPERATION_TYPES = ['move-object', 'rotate-object', 'add-object', 'remove-object'] as const;

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'Short helpful answer for the user.' },
    proposalSummary: { type: 'string', description: 'Short summary of the proposed changes, or an empty string.' },
    operations: {
      type: 'array',
      description: 'Up to eight furniture operations, or up to 128 removals when clearing furniture. An empty array means advice only.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: OPERATION_TYPES },
          objectId: { type: 'string', description: 'Existing object ID, or empty when adding.' },
          productId: { type: 'string', enum: ['', ...PRODUCT_IDS], description: 'Catalogue ID when adding, otherwise empty.' },
          x: { type: 'number', description: 'Target world X in metres; use 0 when unused.' },
          z: { type: 'number', description: 'Target world Z in metres; use 0 when unused.' },
          rotationDegrees: { type: 'number', description: 'Target Y rotation in degrees; use 0 when unused.' }
        },
        required: ['type', 'objectId', 'productId', 'x', 'z', 'rotationDegrees']
      }
    }
  },
  required: ['message', 'proposalSummary', 'operations']
} as const;

// Gemini's responseSchema rejects additionalProperties and empty enum members.
// An empty productId means an operation does not add furniture, so let Gemini
// return a string here and validate catalogue IDs in parseStructuredText.
function geminiSchema(schema: unknown) { return JSON.parse(JSON.stringify(schema, (key, value) => {
  if (key === 'additionalProperties') return undefined;
  if (key === 'productId') {
    const { enum: _enum, ...productIdSchema } = value as JsonRecord;
    return productIdSchema;
  }
  return value;
})) as JsonRecord; }

class GatewayError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

class ProposalError extends GatewayError {
  constructor(message = UNUSABLE_PROPOSAL) { super(502, message); }
}

function normalizeEndpoint(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Ollama endpoints must use HTTP or HTTPS.');
  return url.toString().replace(/\/$/, '');
}

function ollamaEndpoints(configured?: string) {
  const values = ['http://127.0.0.1:11434', ...(configured ?? '').split(',')]
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values.map(normalizeEndpoint))];
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) throw new GatewayError(413, 'The AI request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as JsonRecord;
  } catch {
    throw new GatewayError(400, 'The AI request body is not valid JSON.');
  }
}

function stringField(value: unknown, name: string, maxLength = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new GatewayError(400, `${name} is invalid.`);
  return value.trim();
}

function providerField(value: unknown): ProviderId {
  if (value !== 'gemini' && value !== 'openai' && value !== 'ollama') throw new GatewayError(400, 'Choose a supported AI provider.');
  return value;
}

function credentialField(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new GatewayError(400, 'This provider requires an API key.');
  return value.trim();
}

function selectedOllamaEndpoint(value: unknown, allowed: string[]) {
  const endpoint = typeof value === 'string' && value ? normalizeEndpoint(value) : allowed[0];
  if (!allowed.includes(endpoint)) throw new GatewayError(403, 'That Ollama endpoint is not allowed by this server.');
  return endpoint;
}

async function providerFetch(url: string, init: RequestInit, signal?: AbortSignal) {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    throw new GatewayError(502, error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
      ? 'The assistant took too long to respond. Try again in a moment.'
      : 'Could not reach the AI provider. Check your connection and try again.');
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? 'The provider rejected the API key. Check your connection settings.'
      : response.status === 429 ? 'The provider is busy or its usage limit has been reached. Wait a moment, then try again.'
      : response.status === 404 ? 'This model is unavailable. Choose another model in connection settings.'
      : response.status >= 500 ? 'The AI provider is temporarily unavailable. Try again in a moment.'
      : 'This model could not process the request. Try another model or rephrase your request.';
    throw new GatewayError(response.status >= 500 ? 502 : response.status, message);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid provider response');
    return parsed as JsonRecord;
  } catch {
    throw new GatewayError(502, 'The AI provider returned an unreadable response.');
  }
}

function promptFor(body: JsonRecord) {
  const snapshot = body.snapshot;
  const catalog = body.productCatalog;
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(catalog)) throw new GatewayError(400, 'The project snapshot is missing.');
  if (!Array.isArray((snapshot as JsonRecord).objects) || !Array.isArray((snapshot as JsonRecord).unplacedObjects)
    || catalog.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string')) throw new GatewayError(400, 'The project data is incomplete. Refresh the room and try again.');
  const messages = Array.isArray(body.messages)
    ? body.messages.slice(-12).flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const role = (item as JsonRecord).role;
        const content = (item as JsonRecord).content;
        if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return [];
        return [{ role, content: content.slice(0, 2500) }];
      })
    : [];
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new GatewayError(400, 'Write a message for the AI first.');
  const productIds = catalog.flatMap(item => item && typeof item.id === 'string' && item.id.length <= 160 ? [item.id] : []);
  const schema = JSON.parse(JSON.stringify(responseSchema));
  schema.properties.operations.items.properties.productId.enum = ['', ...new Set(productIds)];

  const instructions = [
    'You are the experimental Domus room-planning assistant.',
    'Give concise, practical advice grounded only in the supplied semantic room data.',
    'You may propose furniture operations only. Never change walls, openings, finishes, lighting, or project metadata.',
    'Coordinates are metres in the project world. Existing object IDs and catalogue product IDs must be copied exactly.',
    'Use move-object for position or position+rotation, rotate-object for rotation only, add-object for catalogue furniture, and remove-object only when explicitly requested.',
    'Remove, delete, clear furniture, and take out mean remove-object. Never simulate removal by moving to (0,0), changing rotation, or moving an item out of the room.',
    'For remove-object supply the exact objectId. Other fields are unused placeholders: productId="", x=0, z=0, rotationDegrees=0. These zero values do not move the item.',
    'If "clean up" or another request is ambiguous between rearranging and removing, ask which the user means and return no operations.',
    'The supplied snapshot includes placed objects and unplacedObjects. Removal may target either list. Never invent IDs or product names.',
    'Prefer zero operations when the user asks a question or when a safe exact placement is uncertain.',
    'Never say a change was applied. Say that it is a proposal awaiting approval.',
    'Return JSON matching this schema:',
    JSON.stringify(schema),
    'Current project:',
    JSON.stringify(snapshot),
    'Available product catalogue:',
    JSON.stringify(catalog)
  ].join('\n');
  return { instructions, messages, schema, productIds };
}

function parseStructuredText(text: string, productIds: string[]) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: JsonRecord;
  try {
    parsed = JSON.parse(cleaned) as JsonRecord;
  } catch {
    throw new ProposalError();
  }
  if (!parsed || typeof parsed.message !== 'string' || typeof parsed.proposalSummary !== 'string' || !Array.isArray(parsed.operations)) {
    throw new ProposalError();
  }
  if (parsed.operations.length > (parsed.operations.every(raw => raw?.type === 'remove-object') ? MAX_AI_REMOVALS : 8)) throw new ProposalError('The assistant proposed too many changes. Ask for a smaller group.');
  const operations = parsed.operations.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new ProposalError();
    const operation = raw as JsonRecord;
    if (!OPERATION_TYPES.includes(operation.type as typeof OPERATION_TYPES[number])) throw new ProposalError();
    if (operation.type === 'add-object') {
      if (typeof operation.productId !== 'string' || !productIds.includes(operation.productId)) throw new ProposalError('The assistant referenced furniture that is not in your catalogue. Nothing changed. Ask for another option.');
      operation.objectId = '';
    } else if (typeof operation.objectId !== 'string' || !operation.objectId) throw new ProposalError();
    if (operation.type !== 'add-object') operation.productId = '';
    for (const field of ['x', 'z', 'rotationDegrees'] as const) {
      if (operation.type === 'remove-object' || (operation.type === 'rotate-object' && field !== 'rotationDegrees')) { operation[field] = 0; continue; }
      if (typeof operation[field] !== 'number' || !Number.isFinite(operation[field]) || Math.abs(operation[field]) > 1000) {
        throw new ProposalError();
      }
    }
    return {
      type: operation.type,
      objectId: operation.objectId,
      productId: operation.productId,
      x: operation.x,
      z: operation.z,
      rotationDegrees: operation.rotationDegrees
    };
  });
  return { message: parsed.message.trim(), proposalSummary: parsed.proposalSummary.trim(), operations };
}

function normalizedResponse(provider: ProviderId, model: string, revision: string, parsed: ReturnType<typeof parseStructuredText>) {
  return {
    message: parsed.message || (parsed.operations.length ? 'I prepared an experimental layout proposal.' : 'I could not produce an answer.'),
    proposal: parsed.operations.length ? {
      baseRevision: revision,
      summary: parsed.proposalSummary || 'Experimental furniture layout proposal',
      operations: parsed.operations
    } : null,
    capabilities: { advice: true, proposals: true, structuredOutput: true },
    provider,
    model
  };
}

async function callGemini(body: JsonRecord, credential: string, model: string, revision: string, signal?: AbortSignal) {
  const { instructions, messages, schema, productIds } = promptFor(body);
  const response = await providerFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': credential },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instructions }] },
        contents: messages.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
        generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(schema), temperature: 0.2, maxOutputTokens: 1800 }
      })
    },
    signal
  );
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const content = candidates[0] && typeof candidates[0] === 'object' ? (candidates[0] as JsonRecord).content : null;
  const parts = content && typeof content === 'object' && Array.isArray((content as JsonRecord).parts) ? (content as JsonRecord).parts as JsonRecord[] : [];
  const text = parts.map((part) => typeof part.text === 'string' ? part.text : '').join('');
  if (!text) throw new GatewayError(502, 'Gemini returned no text response.');
  return normalizedResponse('gemini', model, revision, parseStructuredText(text, productIds));
}

async function callOpenAi(body: JsonRecord, credential: string, model: string, revision: string, signal?: AbortSignal) {
  const { instructions, messages, schema, productIds } = promptFor(body);
  const response = await providerFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify({
      model,
      store: false,
      instructions,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      text: { format: { type: 'json_schema', name: 'domus_ai_response', strict: true, schema } },
      max_output_tokens: 1800
    })
  }, signal);
  const output = Array.isArray(response.output) ? response.output as JsonRecord[] : [];
  const text = output.flatMap((item) => Array.isArray(item.content) ? item.content as JsonRecord[] : [])
    .map((item) => item.type === 'output_text' && typeof item.text === 'string' ? item.text : '')
    .join('');
  if (!text) throw new GatewayError(502, 'OpenAI returned no text response.');
  return normalizedResponse('openai', model, revision, parseStructuredText(text, productIds));
}

async function callOllama(body: JsonRecord, endpoint: string, model: string, revision: string, signal?: AbortSignal) {
  const { instructions, messages, schema, productIds } = promptFor(body);
  try {
    const response = await providerFetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: schema,
        options: { temperature: 0.2 },
        messages: [{ role: 'system', content: instructions }, ...messages]
      })
    }, signal);
    const message = response.message && typeof response.message === 'object' ? response.message as JsonRecord : null;
    const text = message && typeof message.content === 'string' ? message.content : '';
    if (!text) throw new ProposalError();
    return normalizedResponse('ollama', model, revision, parseStructuredText(text, productIds));
  } catch (error) {
    if (signal?.aborted) throw error;
    // Advice mode can recover unsupported structured output, but must not
    // repeat requests after a network failure, timeout or provider rate limit.
    if (!(error instanceof ProposalError) && !(error instanceof GatewayError && [400, 422].includes(error.status))) throw error;
    const fallback = await providerFetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.3 },
        messages: [
          { role: 'system', content: `${instructions}\nThis model is in advice-only mode. Do not output operations; answer the user in plain text.` },
          ...messages
        ]
      })
    }, signal);
    const message = fallback.message && typeof fallback.message === 'object' ? fallback.message as JsonRecord : null;
    const text = message && typeof message.content === 'string' ? message.content.trim() : '';
    if (!text) throw error;
    return {
      message: text,
      proposal: null,
      capabilities: { advice: true, proposals: false, structuredOutput: false },
      provider: 'ollama',
      model
    };
  }
}

async function listModels(provider: ProviderId, body: JsonRecord, allowedOllama: string[], signal?: AbortSignal) {
  if (provider === 'ollama') {
    const endpoint = selectedOllamaEndpoint(body.ollamaEndpoint, allowedOllama);
    const response = await providerFetch(`${endpoint}/api/tags`, { method: 'GET' }, signal);
    const models = Array.isArray(response.models) ? response.models as JsonRecord[] : [];
    return models.map((model) => typeof model.name === 'string' ? model.name : '').filter(Boolean).sort();
  }
  const credential = credentialField(body.credential);
  if (provider === 'gemini') {
    const response = await providerFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      method: 'GET', headers: { 'x-goog-api-key': credential }
    }, signal);
    const models = Array.isArray(response.models) ? response.models as JsonRecord[] : [];
    return models
      .filter((model) => !Array.isArray(model.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent'))
      .map((model) => typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '')
      .filter(Boolean)
      .sort();
  }
  const response = await providerFetch('https://api.openai.com/v1/models', {
    method: 'GET', headers: { Authorization: `Bearer ${credential}` }
  }, signal);
  const data = Array.isArray(response.data) ? response.data as JsonRecord[] : [];
  return data.map((model) => typeof model.id === 'string' ? model.id : '').filter(Boolean).sort();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, allowedOllama: string[]) {
  const url = new URL(request.url ?? '/', 'http://domus.local');
  if (!url.pathname.startsWith('/api/ai/')) return false;

  if (request.method === 'GET' && url.pathname === '/api/ai/config') {
    sendJson(response, 200, {
      experimental: true,
      ollamaEndpoints: allowedOllama.map((endpoint) => ({ id: endpoint, label: endpoint }))
    });
    return true;
  }
  if (request.method !== 'POST') throw new GatewayError(405, 'Method not allowed.');
  const body = await readJson(request);
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  const provider = providerField(body.provider);

  if (url.pathname === '/api/ai/models') {
    sendJson(response, 200, { models: await listModels(provider, body, allowedOllama, controller.signal) });
    return true;
  }
  if (url.pathname !== '/api/ai/turn') throw new GatewayError(404, 'AI route not found.');

  const model = stringField(body.model, 'Model', 160);
  const revision = stringField(body.projectRevision, 'Project revision', 80);
  const { messages } = promptFor(body);
  const removal = removalProposal(messages[messages.length - 1].content, body.snapshot as PlannerSnapshot,
    body.productCatalog as Array<{ id: string; name: string }>, revision);
  if (removal) {
    sendJson(response, 200, { ...removal, provider, model, capabilities: { advice: true, proposals: true, structuredOutput: true } });
    return true;
  }
  const result = provider === 'gemini'
    ? await callGemini(body, credentialField(body.credential), model, revision, controller.signal)
    : provider === 'openai'
      ? await callOpenAi(body, credentialField(body.credential), model, revision, controller.signal)
      : await callOllama(body, selectedOllamaEndpoint(body.ollamaEndpoint, allowedOllama), model, revision, controller.signal);
  sendJson(response, 200, result);
  return true;
}

export function experimentalAiGateway(configuredOllamaEndpoints?: string): Plugin {
  const allowedOllama = process.env.DOMUS_PUBLIC === '1' ? [] : ollamaEndpoints(configuredOllamaEndpoints);
  const middleware = async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    try {
      const aiRoute = new URL(request.url ?? '/', 'http://localhost').pathname.startsWith('/api/ai/');
      if (aiRoute && request.headers?.origin && ![`http://${request.headers.host}`, `https://${request.headers.host}`].includes(request.headers.origin)) throw new GatewayError(403, 'AI requests must come from this application.');
      if (aiRoute && request.method === 'POST' && request.headers && !request.headers['content-type']?.startsWith('application/json')) throw new GatewayError(415, 'AI requests must use application/json.');
      if (!FEATURES.aiExperiment && new URL(request.url ?? '/', 'http://localhost').pathname.startsWith('/api/ai/')) {
        throw new GatewayError(503, 'The AI experiment is disabled.');
      }
      const handled = await handleRequest(request, response, allowedOllama);
      if (!handled) next();
    } catch (error) {
      if (response.destroyed) return;
      const status = error instanceof GatewayError ? error.status : 500;
      const message = error instanceof GatewayError ? error.message : 'The assistant could not finish the request. Nothing changed. Please try again.';
      sendJson(response, status, { error: message.slice(0, 700) });
    }
  };
  return {
    name: 'domus-experimental-ai-gateway',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    }
  };
}
