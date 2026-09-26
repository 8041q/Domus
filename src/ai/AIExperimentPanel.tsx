import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { PRODUCT_LIST, PRODUCTS } from '../core/products';
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

function operationLabel(operation: NonNullable<AiTurnResponse['proposal']>['operations'][number]) {
  const objectName = operation.objectId || (operation.productId ? PRODUCTS[operation.productId]?.name : '') || 'item';
  if (operation.type === 'add-object') return `Add ${objectName} at ${operation.x.toFixed(2)}, ${operation.z.toFixed(2)} m`;
  if (operation.type === 'remove-object') return `Remove ${objectName}`;
  if (operation.type === 'rotate-object') return `Rotate ${objectName} to ${operation.rotationDegrees.toFixed(0)}°`;
  return `Move ${objectName} to ${operation.x.toFixed(2)}, ${operation.z.toFixed(2)} m at ${operation.rotationDegrees.toFixed(0)}°`;
}

export function AIExperimentPanel({ onClose }: { onClose: () => void }) {
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
  const provider = settings.provider;
  const model = settings.models[provider];
  const cloudProvider = provider === 'gemini' || provider === 'openai' ? provider : null;

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let active = true;
    getAiGatewayConfig()
      .then((config) => {
        if (!active) return;
        setOllamaEndpoints(config.ollamaEndpoints);
        if (!config.ollamaEndpoints.some((endpoint) => endpoint.id === settings.ollamaEndpoint) && config.ollamaEndpoints[0]) {
          setSettings((current) => ({ ...current, ollamaEndpoint: config.ollamaEndpoints[0].id }));
        }
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'The experimental AI gateway is unavailable.'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setCredentialInput('');
    setModels([]);
    setResult(null);
    setMessages([]);
    setStatus('');
    setError('');
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
    await removeAiCredential(cloudProvider);
    setCredentialMeta(null);
    setCredentialInput('');
    setModels([]);
    setStatus('Saved API key removed.');
  };

  const credentialForRequest = async () => {
    if (!cloudProvider) return undefined;
    const credential = await loadAiCredential(cloudProvider);
    if (!credential) throw new Error(`Save a ${PROVIDER_LABELS[cloudProvider]} key before connecting.`);
    return credential;
  };

  const refreshModels = async () => {
    setBusy(true);
    setError('');
    setStatus('Connecting…');
    try {
      const credential = await credentialForRequest();
      const response = await listAiModels({ provider, credential, ollamaEndpoint: settings.ollamaEndpoint });
      setModels(response.models);
      if (!model && response.models[0]) updateModel(response.models[0]);
      setStatus(response.models.length ? `Connected · ${response.models.length} model${response.models.length === 1 ? '' : 's'} available` : 'Connected, but no compatible models were listed.');
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'Connection test failed.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const userText = prompt.trim();
    if (!userText || busy) return;
    if (!model.trim()) {
      setError('Choose or enter a model first.');
      return;
    }
    setBusy(true);
    setError('');
    setStatus('Thinking…');
    setResult(null);
    try {
      const credential = await credentialForRequest();
      const snapshot = getSnapshot();
      const nextMessages: AiChatMessage[] = [...messages, { role: 'user', content: userText }];
      const response = await sendAiTurn({
        provider,
        model: model.trim(),
        credential,
        ollamaEndpoint: settings.ollamaEndpoint,
        messages: nextMessages,
        snapshot,
        projectRevision: snapshotRevision(snapshot),
        productCatalog: PRODUCT_LIST.map(({ id, name, width, depth, height }) => ({ id, name, width, depth, height }))
      });
      setMessages([...nextMessages, { role: 'assistant', content: response.message }]);
      setResult(response);
      setPrompt('');
      setStatus(response.capabilities.proposals ? 'Structured proposal mode' : 'Advice-only mode');
    } catch (reason) {
      setStatus('');
      setError(reason instanceof Error ? reason.message : 'The AI request failed.');
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!result?.proposal) return;
    const applied = applyProposal(result.proposal);
    if (!applied.ok) {
      setError(applied.error);
      return;
    }
    setResult({ ...result, proposal: null });
    setStatus('Proposal applied as one undoable action.');
  };

  return (
    <aside className="ai-experiment-panel" aria-label="Experimental AI assistant">
      <div className="ai-panel-heading">
        <div><span className="ai-experimental-badge">Experimental</span><h2>Room assistant</h2></div>
        <button type="button" onClick={onClose} aria-label="Close AI assistant"><Icon name="x" /></button>
      </div>

      <div className="ai-settings-grid">
        <label><span>Provider</span><select value={provider} onChange={(event) => updateProvider(event.target.value as AiProviderId)}>
          <option value="gemini">Gemini API</option>
          <option value="openai">OpenAI API</option>
          <option value="ollama">Ollama on the server</option>
        </select></label>

        {cloudProvider ? (
          <div className="ai-key-setting">
            <label><span>API key {credentialMeta && <small>saved ····{credentialMeta.lastFour}</small>}</span>
              <input type="password" autoComplete="off" value={credentialInput} placeholder={credentialMeta ? 'Enter a replacement key' : 'Stored encrypted in this browser'} onChange={(event) => setCredentialInput(event.target.value)} />
            </label>
            <div><button type="button" onClick={saveCredential} disabled={!credentialInput.trim()}>Save key</button>{credentialMeta && <button type="button" className="text-danger" onClick={removeCredential}>Remove</button>}</div>
          </div>
        ) : (
          <label><span>Server endpoint</span><select value={settings.ollamaEndpoint} onChange={(event) => setSettings((current) => ({ ...current, ollamaEndpoint: event.target.value }))}>
            {ollamaEndpoints.map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.label}</option>)}
          </select></label>
        )}

        <label><span>Model</span>{modelOptions.length ? (
          <select value={model} onChange={(event) => updateModel(event.target.value)}>
            {modelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        ) : <input value={model} placeholder={provider === 'ollama' ? 'Load installed models' : 'Model ID'} onChange={(event: ChangeEvent<HTMLInputElement>) => updateModel(event.target.value)} />}</label>
        <button className="ai-connect-button" type="button" onClick={refreshModels} disabled={busy}>{busy ? 'Working…' : 'Test connection & load models'}</button>
      </div>

      <div className="ai-conversation">
        {!messages.length && <div className="ai-empty-state"><strong>Ask about this room</strong><p>Try “Can you improve this layout?” or “Move the sofa closer to the west wall.” Proposed furniture changes always wait for approval.</p></div>}
        {messages.map((message, index) => <div key={`${message.role}-${index}`} className={`ai-message ${message.role}`}><span>{message.role === 'user' ? 'You' : 'AI'}</span><p>{message.content}</p></div>)}
      </div>

      {result?.proposal && <div className="ai-proposal-card">
        <span>Proposed change</span>
        <strong>{result.proposal.summary}</strong>
        <ul>{result.proposal.operations.map((operation, index) => <li key={`${operation.type}-${index}`}>{operationLabel(operation)}</li>)}</ul>
        <div><button type="button" className="ai-apply-button" onClick={apply}>Apply proposal</button><button type="button" onClick={() => { setResult({ ...result, proposal: null }); setStatus('Proposal dismissed.'); }}>Dismiss</button></div>
      </div>}

      {(status || error) && <div className={`ai-panel-status ${error ? 'error' : ''}`}>{error || status}</div>}

      <div className="ai-composer">
        <textarea value={prompt} rows={3} maxLength={2500} placeholder="Ask about the room or request a furniture change…" onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }} />
        <button type="button" onClick={send} disabled={busy || !prompt.trim()}>{busy ? 'Thinking…' : 'Send'}</button>
      </div>
      <small className="ai-safety-note">Experimental · furniture proposals only · always verify dimensions and placement</small>
    </aside>
  );
}
