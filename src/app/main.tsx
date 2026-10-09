import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Studio, bootstrapStudio } from './Studio';
import type { StoragePort } from './storage';
import '../styles/styles.css';
import '../styles/app.css';

let storage: StoragePort | null = null;
try { storage = window.localStorage; } catch { /* Runtime exposes storage unavailability. */ }
const target = document.getElementById('root');
if (!target) throw new Error('The app mount point is missing.');
const root = createRoot(target);
bootstrapStudio(storage).then(manager => root.render(<StrictMode><Studio manager={manager} /></StrictMode>)).catch(() => {
  root.render(<main><h1>The workspace could not be opened</h1><p>Your saved records have not been cleared. Reload to retry.</p></main>);
});
