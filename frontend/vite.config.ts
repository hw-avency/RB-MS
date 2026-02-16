import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  envPrefix: ['VITE_', 'APP_TITLE', 'PAGE_TITLE', 'FAV_ICON', 'COMPANY_LOGO_URL']
});
