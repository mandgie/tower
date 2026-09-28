import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MobileApp, useMobileLayout } from './components/Mobile';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

// A file dropped outside a terminal pane would otherwise navigate the window to it.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (ev) => { if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault(); });
}

function Root() {
  const [mobile, setLayout] = useMobileLayout();
  return mobile ? <MobileApp onDesktop={() => setLayout('desktop')} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
