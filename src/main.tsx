import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/fraunces/index.css';
import '@fontsource-variable/fraunces/wght-italic.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './styles/theme.css';
import './styles/app.css';
import App from './App';
import './analysis/conductor';
import * as studioControl from './studio/control';
import './ui/ambient';
import './ui/mediaSession';
import './store/session';
import './store/sleep';
import './stems/manager';
import './lyrics/lyrics';
import * as analysis from './analysis/manager';
import { getAnalysis } from './analysis/manager';
import { engine } from './audio/engine';
import { hub } from './audio/hub';
import * as lyrics from './lyrics/lyrics';
import * as stems from './stems/manager';
import * as stemMixer from './stems/mixer';
import * as stemStore from './stems/store';
import * as controller from './store/controller';
import { reloadForUpdate } from './lib/update';
import { usePlayer } from './store/player';
import * as studio from './studio/store';
import { ErrorBoundary } from './ui/ErrorBoundary';

if (import.meta.env.DEV) {
  // Console handle for inspecting the live engine while developing.
  Object.assign(window, { __musiccus: { engine, hub, controller, store: usePlayer, getAnalysis, studio, studioControl, stems, stemMixer, stemStore, analysis, lyrics } });
}

// Installable and offline-capable in production builds only, so development
// always sees fresh files.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}

// A lazily loaded part of the app is missing, almost always because a new
// version was deployed while this tab was open: reload once to pick it up.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForUpdate()) event.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary className="crash-root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
