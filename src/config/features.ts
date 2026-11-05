/// <reference types="vite/client" />

/** Developer switches. Restart/reload the app after changing a switch. */
export const FEATURES = {
  interiorWalls: import.meta.env?.VITE_DOMUS_INTERIOR_WALLS === '1',
  aiExperiment: typeof document === 'undefined'
    || !document.querySelector('meta[name="domus-deployment"][content="public"]'),
};
