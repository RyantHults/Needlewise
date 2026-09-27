import posthog from 'posthog-js';

const key = import.meta.env.VITE_POSTHOG_KEY?.trim();
const host = import.meta.env.VITE_POSTHOG_HOST?.trim();

export const isPostHogConfigured = Boolean(key && host);

if (!isPostHogConfigured) {
  if (import.meta.env.DEV) {
    const missingVariable = !key ? 'VITE_POSTHOG_KEY' : 'VITE_POSTHOG_HOST';
    throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
  }
} else {
  posthog.init(key, {
    api_host: host,
    capture_pageview: 'history_change',
    logs: {
      serviceName: 'needlewise-web',
      environment: import.meta.env.MODE,
    },
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
  });
}

type PostHogLogAttributes = Record<string, string | number | boolean>;

export const posthogLogger = {
  info(message: string, attributes?: PostHogLogAttributes) {
    if (isPostHogConfigured) posthog.logger.info(message, attributes);
  },
};

export { posthog };
