import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createPublicRuntime, injectedProvider } from '../app/network';
import type { StoragePort } from '../app/storage';
import { DeskApp } from './DeskApp';
import { createDeskNavigation } from './navigation';
import '../styles/styles.css';
import '../styles/app.css';
import './desk.css';

let storage: StoragePort | null = null;
try { storage = window.localStorage; } catch { /* Reading is still available without storage. */ }
const binding = createPublicRuntime({ storage, namespace: 'partfolk:partner-desk', provider: injectedProvider(window) });
const navigation = createDeskNavigation(storage, window.location.hash);
navigation.remember();
const target = document.getElementById('desk-root');
if (!target) throw new Error('The Partner Desk mount point is missing.');
const root = createRoot(target);
root.render(<StrictMode><DeskApp binding={binding} navigation={navigation} /></StrictMode>);
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); binding.dispose(); });
