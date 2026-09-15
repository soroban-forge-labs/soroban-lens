import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
const container = document.getElementById('root');
if (!container)
    throw new Error('#root is missing from index.html');
createRoot(container).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
