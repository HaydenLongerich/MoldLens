// Local UI preview only; staff APIs still require a real authenticated session.
export const localTesting = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

export const customerDemoEnabled = localTesting && import.meta.env.DEV;
