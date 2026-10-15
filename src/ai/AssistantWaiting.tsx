import { Icon } from '../ui';

export function AssistantWaiting({ label = 'Thinking…' }: { label?: string }) {
  return <div className="ai-message assistant" role="status">
    <span>Assistant</span>
    <p className="ai-waiting"><span className="ai-waiting-dots" aria-hidden="true"><i /><i /><i /></span>{label}</p>
  </div>;
}

/** Even the lazy module opens inside the chat, without a workspace loading task. */
export function AssistantOpening({ onClose }: { onClose: () => void }) {
  return <aside className="ai-experiment-panel" aria-label="Experimental AI assistant">
    <div className="ai-panel-heading"><h2>Room assistant</h2><div className="ai-heading-actions">
      <button type="button" onClick={onClose} aria-label="Close AI assistant"><Icon name="x" /></button>
    </div></div>
    <div className="ai-conversation"><AssistantWaiting label="Opening assistant…" /></div>
  </aside>;
}
