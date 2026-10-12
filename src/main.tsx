import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyThemeTokens } from './theme';
import { initializeProductCatalogue, startProductCatalogueUpdates } from './core/products';

applyThemeTokens();

void initializeProductCatalogue().then(() => {
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
  const stopCatalogueUpdates = startProductCatalogueUpdates();
  import.meta.hot?.dispose(stopCatalogueUpdates);
});
