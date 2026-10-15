import { FEATURES } from '../config/features';
import { activeArchitecture } from '../core/activeArchitecture';
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { PRODUCT_LIST } from '../core/products';
import { snapshotRevision } from '../core/aiProposal';
import { getSnapshot, usePlannerStore } from '../store';
import { Icon } from '../ui';
import { getAiGatewayConfig, listAiModels, sendAiTurn } from './client';
import {
  getAiCredentialMetadata,
  loadAiCredential,
  removeAiCredential,
  saveAiCredential,
  type CredentialMetadata
} from './credentials';
import type { AiBrowserSettings, AiChatMessage, AiProviderId, AiTurnResponse } from './types';
import { removalProposal } from './removalIntent';
import { operationDescription, proposalIssue } from './proposalPresentation';
import { AssistantWaiting } from './AssistantWaiting';

const SETTINGS_KEY = 'domus-ai-settings-v1';
const DEFAULT_SETTINGS: AiBrowserSettings = {
  provider: 'gemini',
  models: {
    gemini: 'gemini-2.5-flash',
    openai: 'gpt-5-mini',
    ollama: ''
  },
  ollamaEndpoint: 'http://127.0.0.1:11434'
};

const PROVIDER_LABELS: Record<AiProviderId, string> = {
  gemini: 'Gemini API',
  openai: 'OpenAI API',
  ollama: 'Ollama'
};

function loadSettings(): AiBrowserSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '') as Partial<AiBrowserSettings>;
    const provider = parsed.provider === 'openai' || parsed.provider === 'ollama' || parsed.provider === 'gemini'
      ? parsed.provider
      : DEFAULT_SETTINGS.provider;
    return {
      provider,
      models: { ...DEFAULT_SETTINGS.models, ...parsed.models },
      ollamaEndpoint: typeof parsed.ollamaEndpoint === 'string' && parsed.ollamaEndpoint
        ? parsed.ollamaEndpoint
        : DEFAULT_SETTINGS.ollamaEndpoint
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function AIExperimentPanel({ onClose }: { onClose: () => void }) {
  return FEATURES.aiExperiment ? <EnabledAIExperimentPanel onClose={onClose} /> : null;
}

function EnabledAIExperimentPanel({ onClose }: { onClose: () => void }) {
  const applyProposal = usePlannerStore((state) => state.applyAiProposal);
  const [settings, setSettings] = useState(loadSettings);
  const [ollamaEndpoints, setOllamaEndpoints] = useState<Array<{ id: string; label: string }>>([]);
  const [credentialInput, setCredentialInput] = useState('');
  const [credentialMeta, setCredentialMeta] = useState<CredentialMetadata | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<AiTurnResponse | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [configLoading, setConfigLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const lastRequest = useRef('');
  const retryAction = useRef<'chat' | 'models' | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const room = usePlannerStore(state => state.room);
  const openings = usePlannerStore(state => state.openings);
  const dividers = usePlannerStore(state => state.dividers);
  const spaces = usePlannerStore(state => state.spaces);
  const objects = usePlannerStore(state => state.objects);
  const unplacedObjects = usePlannerStore(state => state.unplacedObjects);
  const snapshot = useMemo(() => ({ room, openings, dividers, spaces, objects, unplacedObjects }),
    [room, openings, dividers, spaces, objects, unplacedObjects]);
  const issue = useMemo(() => result?.proposal ? proposalIssue(snapshot, result.proposal) : null, [snapshot, result?.proposal]);
  const provider = settings.provider;
  const model = settings.models[provider];
  const cloudProvider = provider === 'gemini' || provider === 'openai' ? provider : null;
  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight }); }, [messages, result, error, busy, configLoading]);
  useEffect(() => { if (settingsOpen) bodyRef.current?.scrollTo({ top: 0 }); }, [settingsOpen]);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Connection can still be used for this session. */ }
  }, [settings]);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    getAiGatewayConfig(controller.signal)
      .then((config) => {
        if (!active) return;
        setOllamaEndpoints(config.ollamaEndpoints);
        if (!config.ollamaEndpoints.some((endpoint) => endpoint.id === settings.ollamaEndpoint) && config.ollamaEndpoints[0]) {
          setSettings((current) => ({ ...current, ollamaEndpoint: config.ollamaEndpoints[0].id }));
        }
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'The experimental AI gateway is unavailable.'); })
      .finally(() => { if (active) setConfigLoading(false); });
    return () => { active = false; controller.abort(); };
  }, []);

  useEffect(() => {
    let active = true;
    request.current?.abort(); request.current = null; setBusy(false);
    setCredentialInput('');
    setModels([]);
    setResult(null);
    setMessages([]);
    setStatus('');
    setError('');
    lastRequest.current = ''; retryAction.current = null;
    if (!cloudProvider) {
      setCredentialMeta(null);
      return () => { active = false; };
    }
    getAiCredentialMetadata(cloudProvider)
      .then((metadata) => { if (active) setCredentialMeta(metadata); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not read the saved credential.'); });
    return () => { active = false; };
  }, [cloudProvider]);

  const modelOptions = useMemo(() => models.includes(model) || !model ? models : [model, ...models], [model, models]);

  const updateProvider = (next: AiProviderId) => {
    setSettings((current) => ({ ...current, provider: next }));
  };

  const updateModel = (next: string) => {
    setSettings((current) => ({ ...current, models: { ...current.models, [current.provider]: next } }));
  };

  const saveCredential = async () => {
    if (!cloudProvider) return;
    retryAction.current = null;
    setError('');
    try {
      const metadata = await saveAiCredential(cloudProvider, credentialInput);
      setCredentialMeta(metadata);
      setCredentialInput('');
      setStatus('API key encrypted in this browser.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the API key.');
    }
  };

  const removeCredential = async () => {
    if (!cloudProvider) return;
    retryAction.current = null;
    try {
      await removeAiCredential(cloudProvider);
      setCredentialMeta(null); setCredentialInput(''); setModels([]);
      setStatus('Saved API key removed.');
    } catch { setError('Could not remove the saved key. Please try again.'); }
  };

  const credentialForRequest = async () => {
    if (!cloudProvider) return undefined;
    const credential = await loadAiCredential(cloudProvider);
    if (!credential) throw new Error(`Save a ${PROVIDER_LABELS[cloudProvider]} key before connecting.`);
    return credential;
  };

  const refreshModels = async () => {
    if (request.current) return;
    retryAction.current = 'models';
    const controller = new AbortController(); request.current = controller;
    setBusy(true);
    setError('');
    setStatus('Connecting…');
    try {
      const credential = await credentialForRequest();
      controller.signal.throwIfAborted();
      const response = await listAiModels({ provider, credential, ollamaEndpoint: settings.ollamaEndpoint }, controller.signal);
      if (controller.signal.aborted) return;
      setModels(response.models);
      if (!model && response.models[0]) updateModel(response.models[0]);
      setStatus(response.models.length ? `Connected · ${response.models.length} model${response.models.length === 1 ? '' : 's'} available` : 'Connected, but no compatible models were listed.');
    } catch (reason) {
      if (controller.signal.aborted) return;
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'Connection test failed.');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };

  const send = async (retryText?: string, feedback?: string) => {
    const userText = (retryText ?? prompt).trim();
    if (!userText || busy || request.current) return;
    const snapshot = getSnapshot();
    const local = removalProposal(userText, snapshot, PRODUCT_LIST, snapshotRevision(snapshot));
    if (!local && !model.trim()) {
      retryAction.current = null;
      setError('Choose or enter a model first.');
      return;
    }
    setBusy(true);
    const controller = new AbortController(); request.current = controller;
    lastRequest.current = userText;
    retryAction.current = 'chat';
    setError('');
    setStatus('Thinking…');
    setResult(null);
    try {
      const nextMessages: AiChatMessage[] = [...messages, { role: 'user', content: feedback
        ? `${userText}\nThe last proposal could not be applied: ${feedback} Please propose a corrected alternative, or explain if it cannot be done.` : userText }];
      const credential = local ? undefined : await credentialForRequest();
      controller.signal.throwIfAborted();
      const response: AiTurnResponse = local ? { ...local, provider, model, capabilities: { advice: true, proposals: true, structuredOutput: true } } : await sendAiTurn({
        provider,
        model: model.trim(),
        credential,
        ollamaEndpoint: settings.ollamaEndpoint,
        messages: nextMessages,
        snapshot: activeArchitecture(snapshot),
        projectRevision: snapshotRevision(snapshot),
        productCatalog: PRODUCT_LIST.map(({ id, name, width, depth, height }) => ({ id, name, width, depth, height }))
      }, controller.signal);
      if (controller.signal.aborted) return;
      setMessages([...nextMessages, { role: 'assistant', content: response.message }]);
      setResult(response);
      setPrompt(current => current.trim() === userText ? '' : current);
      setStatus(response.proposal ? '' : response.capabilities.proposals ? '' : 'Advice only · no room changes');
    } catch (reason) {
      if (controller.signal.aborted) return;
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'The AI request failed.');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };

  const apply = () => {
    if (!result?.proposal || issue) return;
    const applied = applyProposal(result.proposal);
    if (!applied.ok) {
      setError('The room changed before this proposal could be applied. Request an updated version. Nothing has changed.');
      return;
    }
    setResult({ ...result, proposal: null });
    setStatus('Proposal applied as one undoable action.');
  };

  return (
    <aside className="ai-experiment-panel" aria-label="Experimental AI assistant">
      <div className="ai-panel-heading">
        <div><h2>Room assistant</h2><span className="ai-experimental-badge">Experimental</span></div>
        <div className="ai-heading-actions">
          <button type="button" onClick={() => setSettingsOpen(value => !value)} aria-label="Connection settings" aria-expanded={settingsOpen}><Icon name="settings" /></button>
          <button type="button" onClick={onClose} aria-label="Close AI assistant"><Icon name="x" /></button>
        </div>
      </div>
      <button className="ai-connection-summary" type="button" onClick={() => setSettingsOpen(value => !value)} aria-expanded={settingsOpen}>
        <span title={`${PROVIDER_LABELS[provider]} · ${model}`}>{PROVIDER_LABELS[provider]} · {model || 'Choose a model'}</span><Icon name="chevronDown" />
      </button>
      <div className="ai-panel-body" ref={bodyRef}>
      {settingsOpen && <div className="ai-settings-grid">
        <label><span>Provider</span><select disabled={busy} value={provider} onChange={(event) => updateProvider(event.target.value as AiProviderId)}>
          <option value="gemini">Gemini API</option>
          <option value="openai">OpenAI API</option>
          <option value="ollama">Ollama on the server</option>
        </select></label>

        {cloudProvider ? (
          <div className="ai-key-setting">
            <label><span>API key {credentialMeta && <small>saved ····{credentialMeta.lastFour}</small>}</span>
              <input type="password" disabled={busy} autoComplete="off" value={credentialInput} placeholder={credentialMeta ? 'Enter a replacement key' : 'Stored encrypted in this browser'} onChange={(event) => setCredentialInput(event.target.value)} />
            </label>
            <div><button type="button" onClick={saveCredential} disabled={busy || !credentialInput.trim()}>Save key</button>{credentialMeta && <button type="button" disabled={busy} className="text-danger" onClick={removeCredential}>Remove</button>}</div>
          </div>
        ) : (
          <label><span>Server endpoint</span><select disabled={busy} value={settings.ollamaEndpoint} onChange={(event) => setSettings((current) => ({ ...current, ollamaEndpoint: event.target.value }))}>
            {ollamaEndpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
          </select></label>
        )}

        <label><span>Model</span>{modelOptions.length ? (
          <select disabled={busy} value={model} onChange={(event) => updateModel(event.target.value)}>
            {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : <input disabled={busy} value={model} placeholder={provider === 'ollama' ? 'Load installed models' : 'Model ID'} onChange={(event: ChangeEvent<HTMLInputElement>) => updateModel(event.target.value)} />}</label>
        <button className="ai-connect-button" type="button" onClick={refreshModels} disabled={busy}>{busy ? 'Working…' : 'Test connection & load models'}</button>
      </div>}

      <div className="ai-conversation" aria-busy={busy || configLoading}>
        {!messages.length && !busy && !configLoading && <div className="ai-empty-state"><strong>What would you like to change?</strong><p>Ask for layout ideas, move an item, or remove furniture. You review every change before it is applied.</p>
          <button type="button" onClick={() => setPrompt('Remove all furniture')}>Remove all furniture</button></div>}
        {messages.slice(-12).map((message, index) => <div key={`${message.role}-${index}`} className={`ai-message ${message.role}`}><span>{message.role === 'user' ? 'You' : 'Assistant'}</span><p>{message.content}</p></div>)}
        {busy && retryAction.current === 'chat' && <div className="ai-message user"><span>You</span><p>{lastRequest.current}</p></div>}
        {(busy || configLoading) && <AssistantWaiting label={busy ? status === 'Connecting…' ? 'Connecting…' : 'Thinking…' : 'Opening assistant…'} />}
      </div>

      {result?.proposal && <div className="ai-proposal-card">
        <span>Review changes</span>
        <strong>{result.proposal.summary}</strong>
        <details><summary>{result.proposal.operations.length} change{result.proposal.operations.length === 1 ? '' : 's'}</summary>
          <ul>{result.proposal.operations.map((operation, index) => <li key={`${operation.type}-${index}`}>{operationDescription(operation, snapshot)}</li>)}</ul>
        </details>
        {issue && <p className="ai-proposal-issue">{issue}</p>}
        <div>{issue ? <button type="button" className="ai-apply-button" onClick={() => { void send(lastRequest.current, issue); }}>Revise proposal</button>
          : <button type="button" className="ai-apply-button" onClick={apply}>Apply changes</button>}
          <button type="button" onClick={() => { setResult({ ...result, proposal: null }); setError(''); setStatus(''); }}>Dismiss</button></div>
      </div>}
      {error && <div className="ai-panel-status error" role="alert"><strong>Could not finish that request</strong><p>{error}</p><small>Your room has not changed.</small>
        <div>{retryAction.current && <button type="button" onClick={() => { void (retryAction.current === 'models' ? refreshModels() : send(lastRequest.current)); }}>Try again</button>}<button type="button" onClick={() => setSettingsOpen(true)}>Connection settings</button></div>
      </div>}
      {!error && status && !busy && <div className="ai-panel-status" role="status">{status}</div>}
      </div>
      <div className="ai-composer">
        <textarea aria-label="Message to room assistant" value={prompt} rows={2} maxLength={2500} placeholder="Ask about your room…" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }} />
        <button type="button" onClick={() => { void send(); }} disabled={busy || !prompt.trim()}>Send</button>
      </div>
      <small className="ai-safety-note">Changes require your approval · undo anytime</small>
    </aside>
  );
}
