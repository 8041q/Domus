import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './mobile.css';
import { applyThemeTokens } from './theme';
import { initializeProductCatalogue, startProductCatalogueUpdates } from './core/products';
import { loadInterfaceFonts } from './core/reportFonts';
import { roomProjects } from './roomProjects';

applyThemeTokens();
const root = createRoot(document.getElementById('root')!);
root.render(<div className="project-progress" role="status">Opening Domus…</div>);
async function start() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all([
      initializeProductCatalogue(),
      Promise.race([loadInterfaceFonts(), new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Font loading timed out.')), 5000); })])
        .catch(error => console.warn('Using fallback interface fonts.', error))
    ]);
    await roomProjects.initialize();
    root.render(<StrictMode><App /></StrictMode>);
    const stopCatalogueUpdates = startProductCatalogueUpdates();
    import.meta.hot?.dispose(stopCatalogueUpdates);
  } catch {
    root.render(<div className="project-progress" role="alert"><p>Domus could not finish starting. Your saved rooms are still in this browser.</p><button onClick={() => location.reload()}>Try again</button></div>);
  } finally { clearTimeout(timer); }
}
void start();
