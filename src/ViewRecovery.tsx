import { Icon } from './ui';
import { useCancelLoading } from './LoadingStatus';

/** Shared, persistent recovery feedback for views that could not be rendered. */
export function ViewRecovery({ title, description, onReturn, onRetry }: {
  title: string;
  description: string;
  onReturn: () => void;
  onRetry?: () => void;
}) {
  useCancelLoading();
  return <div className="view-error">
    <section className="view-error-card loading-status-card" role="alert">
      <span className="view-error-symbol" aria-hidden="true"><Icon name="cube" /></span>
      <div className="view-error-copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="view-error-actions">
        <button type="button" className="view-error-primary" onClick={onReturn}><Icon name="arrowLeft" />Return to 2D</button>
        {onRetry && <button type="button" className="view-error-secondary" onClick={onRetry}><Icon name="rotateRight" />Try again</button>}
      </div>
    </section>
  </div>;
}
