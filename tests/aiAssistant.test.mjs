import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
after(() => vite.close());
const { emptyRoomSnapshot, getSnapshot, usePlannerStore: store } = await vite.ssrLoadModule('/src/store.ts');
const { applyAiProposal, snapshotRevision } = await vite.ssrLoadModule('/src/core/aiProposal.ts');
const { removalProposal } = await vite.ssrLoadModule('/src/ai/removalIntent.ts');
const { proposalIssue, operationDescription } = await vite.ssrLoadModule('/src/ai/proposalPresentation.ts');
const { blocksLoadingInteraction } = await vite.ssrLoadModule('/src/core/loadingInteraction.ts');
const { experimentalAiGateway } = await vite.ssrLoadModule('/server/aiGateway.ts');
const { sendAiTurn } = await vite.ssrLoadModule('/src/ai/client.ts');
const { AIExperimentPanel } = await vite.ssrLoadModule('/src/ai/AIExperimentPanel.tsx');
const { AssistantOpening, AssistantWaiting } = await vite.ssrLoadModule('/src/ai/AssistantWaiting.tsx');
const catalog = [{ id: 'chair', name: 'Dining chair', width: .5, depth: .56, height: .83 }];
const operation = (type, objectId, x = 0, z = 0) => ({ type, objectId, productId: '', x, z, rotationDegrees: 0 });
const proposal = (snapshot, operations) => ({ summary: 'Test changes', baseRevision: snapshotRevision(snapshot), operations });

test('assistant startup and waiting stay inside chat without requiring a workspace loading provider', () => {
  for (const Component of [AIExperimentPanel, AssistantOpening, AssistantWaiting]) {
    const html = renderToString(createElement(Component, { onClose() {} }));
    assert.match(html, /role="status"/);
    assert.match(html, /ai-waiting/);
    assert.doesNotMatch(html, /loading-status|loading-status-blocking|inert=/);
  }
});
function room() {
  const snapshot = emptyRoomSnapshot();
  snapshot.objects = [{ id: 'chair-unique-a', productId: 'chair', x: 1, z: 1, rotationY: 0 }, { id: 'chair-unique-b', productId: 'chair', x: 3, z: 1, rotationY: 0 }];
  snapshot.unplacedObjects = [{ id: 'chair-unique-c', productId: 'chair' }];
  return snapshot;
}

test('explicit clear/remove requests propose actual removals including unplaced items, never zero-position moves', () => {
  const snapshot = room();
  for (const text of ['Remove all furniture', 'Could you please clear the room?', 'Remove all dining chairs']) {
    const response = removalProposal(text, snapshot, catalog, snapshotRevision(snapshot));
    assert.deepEqual(response.proposal.operations.map(item => item.type), Array(3).fill('remove-object'));
    const applied = applyAiProposal(snapshot, response.proposal);
    assert.equal(applied.error, null); assert.equal(applied.snapshot.objects.length, 0); assert.equal(applied.snapshot.unplacedObjects.length, 0);
    assert.equal(snapshot.objects.length, 2, 'Preview cannot mutate the current room');
  }
  for (const text of ['Do not remove all furniture', 'How do I remove furniture?', 'Clean up the room', 'Remove the chair and move the table']) assert.equal(removalProposal(text, snapshot, catalog, 'revision'), null);
  assert.equal(removalProposal('Remove the dining chair', snapshot, catalog, 'revision').proposal, null, 'Ambiguous item selection asks for clarification');
});

test('removals ignore unused coordinates, support larger clear requests, and apply as one undoable action', () => {
  const snapshot = room();
  snapshot.objects = Array.from({ length: 12 }, (_, index) => ({ id: `item-${index}`, productId: 'chair', x: 0, z: 0, rotationY: 0 }));
  const response = removalProposal('Remove all furniture', snapshot, catalog, snapshotRevision(snapshot));
  response.proposal.operations[0].x = NaN;
  assert.equal(applyAiProposal(snapshot, response.proposal).error, null);
  store.getState().openProject(snapshot);
  const before = getSnapshot();
  const clean = removalProposal('Remove all furniture', before, catalog, snapshotRevision(before));
  assert.deepEqual(store.getState().applyAiProposal(clean.proposal), { ok: true });
  assert.equal(store.getState().objects.length, 0); assert.equal(store.getState().unplacedObjects.length, 0);
  store.getState().undo(); assert.deepEqual(getSnapshot(), before);
});

test('proposals validate final geometry atomically and expose human-readable validation before Apply', () => {
  const snapshot = room();
  const swap = proposal(snapshot, [operation('move-object', 'chair-unique-a', 3, 1), operation('move-object', 'chair-unique-b', 1, 1)]);
  assert.equal(proposalIssue(snapshot, swap), null, 'Temporary overlap in a valid swap must not cause failure');
  const invalid = proposal(snapshot, [operation('move-object', 'chair-unique-a', 100, 100)]);
  assert.match(proposalIssue(snapshot, invalid), /does not fit/);
  assert.equal(applyAiProposal(snapshot, invalid).snapshot, snapshot, 'Invalid proposals are all-or-nothing');
  const moved = structuredClone(snapshot); moved.objects[0].x = -.5;
  assert.match(proposalIssue(moved, swap), /room changed/i);
  assert.match(operationDescription(operation('remove-object', 'chair-unique-a'), snapshot), /^Remove Dining chair 1$/);
  assert.doesNotMatch(operationDescription(operation('remove-object', 'chair-unique-a'), snapshot), /unique/);
});

test('loading blocks edits, shortcuts and header actions, while allowing only workflow navigation and internal downloads', () => {
  const event = (type, target, key) => ({ type, key, composedPath: () => [{ matches: selector => selector === target }] });
  assert.equal(blocksLoadingInteraction(event('click', '.mode-stepper button')), false);
  assert.equal(blocksLoadingInteraction(event('pointerdown', '.mode-stepper button')), false);
  assert.equal(blocksLoadingInteraction(event('click', '.project-menu-trigger')), true);
  assert.equal(blocksLoadingInteraction(event('pointermove', 'canvas')), true);
  assert.equal(blocksLoadingInteraction(event('keydown', '.mode-stepper button', 'Delete')), true);
  assert.equal(blocksLoadingInteraction(event('keydown', '.mode-stepper button', 's')), true);
  assert.equal(blocksLoadingInteraction(event('keydown', '.mode-stepper button', 'Enter')), false);
  assert.equal(blocksLoadingInteraction(event('click', 'a[download]')), false);
});

function gatewayRequest(body) {
  let middleware;
  experimentalAiGateway().configureServer({ middlewares: { use(fn) { middleware = fn; } } });
  const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = 'POST'; request.url = '/api/ai/turn';
  const response = new EventEmitter(); response.setHeader = () => {}; response.writableEnded = false;
  response.end = text => { response.body = JSON.parse(text); response.writableEnded = true; };
  return { response, run: () => middleware(request, response, () => assert.fail('AI route was not handled')) };
}
function requestBody(text = 'Please suggest a change') {
  const snapshot = room();
  return { provider: 'gemini', model: 'test-model', credential: 'test-key-not-real', snapshot, productCatalog: catalog,
    projectRevision: snapshotRevision(snapshot), messages: [{ role: 'user', content: text }] };
}
const geminiReply = parsed => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(parsed) }] } }] }), { status: 200 });

test('gateway handles clear commands without a provider call, and normalizes removal-only model responses', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = () => assert.fail('A clear command must not call an external provider');
    const local = gatewayRequest(requestBody('Remove all furniture')); await local.run();
    assert.equal(local.response.statusCode, 200); assert.equal(local.response.body.proposal.operations.length, 3);
    globalThis.fetch = async () => geminiReply({ message: 'Review removal', proposalSummary: 'Remove chair', operations: [{ type: 'remove-object', objectId: 'chair-unique-a' }] });
    const remote = gatewayRequest(requestBody()); await remote.run();
    assert.equal(remote.response.statusCode, 200);
    assert.deepEqual(remote.response.body.proposal.operations[0], operation('remove-object', 'chair-unique-a'));
  } finally { globalThis.fetch = previous; }
});

test('gateway accepts current catalogue products and reports provider failures without raw responses or keys', async () => {
  const previous = globalThis.fetch;
  try {
    const body = requestBody('Add a custom bed'); body.productCatalog.push({ id: 'model-custom-bed', name: 'Custom bed', width: 1, depth: 2, height: .8 });
    globalThis.fetch = async (_url, init) => {
      assert.match(JSON.parse(init.body).systemInstruction.parts[0].text, /model-custom-bed/);
      return geminiReply({ message: 'Review bed', proposalSummary: 'Add bed', operations: [{ ...operation('add-object', ''), productId: 'model-custom-bed', x: 1, z: 1 }] });
    };
    const success = gatewayRequest(body); await success.run(); assert.equal(success.response.statusCode, 200);
    globalThis.fetch = async () => new Response('raw provider body including test-key-not-real', { status: 429 });
    const failure = gatewayRequest(requestBody()); await failure.run();
    assert.equal(failure.response.statusCode, 429); assert.match(failure.response.body.error, /usage limit|busy/);
    assert.doesNotMatch(failure.response.body.error, /test-key|raw provider/);
  } finally { globalThis.fetch = previous; }
});

test('leaving the assistant aborts upstream work instead of starting an advice fallback', async () => {
  const previous = globalThis.fetch;
  try {
    let entered, calls = 0; const ready = new Promise(resolve => { entered = resolve; });
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      calls++; entered(); init.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    });
    const body = requestBody(); body.provider = 'ollama';
    const pending = gatewayRequest(body); const running = pending.run(); await ready;
    pending.response.destroyed = true; pending.response.emit('close'); await running;
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('malformed provider output produces a recoverable explanation instead of schema or runtime errors', async () => {
  const previous = globalThis.fetch;
  try {
    for (const reply of [null, {}, { message: 'Invalid', proposalSummary: '', operations: [null] },
      { message: 'Invalid', proposalSummary: '', operations: [{ type: 'move-object', objectId: 'chair-unique-a', x: 'wrong' }] }]) {
      globalThis.fetch = async () => geminiReply(reply);
      const failure = gatewayRequest(requestBody()); await failure.run();
      assert.equal(failure.response.statusCode, 502);
      assert.match(failure.response.body.error, /Nothing changed.*Try rephrasing/);
      assert.doesNotMatch(failure.response.body.error, /schema|TypeError|properties|operation/i);
    }
  } finally { globalThis.fetch = previous; }
});

test('Ollama advice fallback is limited to structured-output incompatibility, not provider failures', async () => {
  const previous = globalThis.fetch;
  try {
    const body = requestBody(); body.provider = 'ollama';
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 429 }); };
    const failure = gatewayRequest(body); await failure.run();
    assert.equal(calls, 1); assert.equal(failure.response.statusCode, 429);
    calls = 0;
    globalThis.fetch = async () => { calls++; return calls === 1 ? new Response('', { status: 400 })
      : new Response(JSON.stringify({ message: { content: 'Try keeping a clear walkway.' } })); };
    const advice = gatewayRequest(body); await advice.run();
    assert.equal(calls, 2); assert.equal(advice.response.statusCode, 200);
    assert.equal(advice.response.body.proposal, null); assert.equal(advice.response.body.capabilities.proposals, false);
  } finally { globalThis.fetch = previous; }
});

test('browser client rejects malformed proposal fields before they can crash the assistant panel', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Review', capabilities: { proposals: true },
      proposal: { summary: 'Invalid', baseRevision: 'revision', operations: [null] } }));
    await assert.rejects(sendAiTurn(requestBody()), /unreadable response.*Nothing changed/);
  } finally { globalThis.fetch = previous; }
});
