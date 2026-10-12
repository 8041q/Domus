/// <reference types="vite/client" />

declare module 'virtual:domus-models' {
  const catalogue: import('../server/modelCatalogue').ModelCatalogueData;
  export default catalogue;
}
