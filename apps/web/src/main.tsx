import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { loadRuntimeNetworks } from './api.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// The network list has to be settled before the first render: the selected
// network comes from it, and switching it later would refetch everything.
void loadRuntimeNetworks().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
