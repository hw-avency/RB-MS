const configuredPageTitle = import.meta.env.PAGE_TITLE || import.meta.env.VITE_PAGE_TITLE;

export const APP_TITLE = configuredPageTitle?.trim() || 'AVENCY Booking';
