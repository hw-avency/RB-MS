import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { ToastProvider } from './components/toast';
import './styles.css';

const faviconUrl = import.meta.env.FAV_ICON ?? import.meta.env.VITE_FAV_ICON;

if (faviconUrl) {
  let faviconLink = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;

  if (!faviconLink) {
    faviconLink = document.createElement('link');
    faviconLink.rel = 'icon';
    document.head.appendChild(faviconLink);
  }

  faviconLink.href = faviconUrl;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </AuthProvider>
  </React.StrictMode>
);
