import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLogCapture } from './logging/logger';
import { startTracing } from './logging/tracing';

startTracing();
installLogCapture();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
