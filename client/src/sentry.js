// Sentry initialization utility - lazy loads from runtime-configured DSN
// The DSN is injected at container startup via an inline script in index.html

let sentryInitialized = false;

export async function initSentry() {
  if (sentryInitialized) return;
  if (!window.SENTRY_DSN) return;

  const Sentry = await import('@sentry/browser');

  Sentry.init({
    dsn: window.SENTRY_DSN,
    environment: import.meta.env.MODE || 'production',
    // Only enable tracing in production to reduce overhead
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 0,
    // Don't send errors in development
    enabled: import.meta.env.PROD,
  });

  sentryInitialized = true;
}

// Export a no-op wrapper so components can call captureException safely
export const captureException = (error) => {
  if (window.SENTRY_DSN && sentryInitialized) {
    import('@sentry/browser').then(Sentry => {
      Sentry.captureException(error);
    });
  } else {
    console.warn('[Sentry] DSN not configured or not initialized:', error);
  }
};