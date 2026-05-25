import React from 'react';
import { createRoot } from 'react-dom/client';

import { DialogProvider } from './dialog.jsx';
import { ToastProvider } from './toast.jsx';
import { BackendsProvider, CliProfilesProvider } from './shellState.jsx';
import { App } from './appShell.jsx';

createRoot(document.getElementById('root')).render(
  <DialogProvider><ToastProvider><BackendsProvider><CliProfilesProvider><App/></CliProfilesProvider></BackendsProvider></ToastProvider></DialogProvider>
);
