const configuredPageTitle = import.meta.env.APP_TITLE || import.meta.env.VITE_APP_TITLE || import.meta.env.PAGE_TITLE || import.meta.env.VITE_PAGE_TITLE;
const configuredCompanyLogoUrl = import.meta.env.COMPANY_LOGO_URL || import.meta.env.VITE_COMPANY_LOGO_URL;

export const APP_TITLE = configuredPageTitle?.trim() || 'AVENCY Booking';
export const COMPANY_LOGO_URL = configuredCompanyLogoUrl?.trim() || '';

export const APP_VERSION = __APP_VERSION__;
