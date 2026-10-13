import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StandaloneErrorPage } from './features/errors/ErrorPage';
import './styles/styles.css';

const target = document.getElementById('error-root');
if (target) createRoot(target).render(<StrictMode><StandaloneErrorPage /></StrictMode>);
