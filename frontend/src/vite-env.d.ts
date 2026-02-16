/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly APP_TITLE?: string;
  readonly FAV_ICON?: string;
  readonly PAGE_TITLE?: string;
  readonly VITE_APP_TITLE?: string;
  readonly VITE_FAV_ICON?: string;
  readonly VITE_PAGE_TITLE?: string;
  readonly COMPANY_LOGO_URL?: string;
  readonly VITE_COMPANY_LOGO_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_BYPASS?: string;
}

declare const __APP_VERSION__: string;
