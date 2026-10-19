import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './components/ProjectStudio';
import {StudioBoundary} from './components/StudioBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <StudioBoundary><App /></StudioBoundary>
  </React.StrictMode>
);
