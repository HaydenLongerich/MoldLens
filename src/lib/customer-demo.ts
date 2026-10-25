import { marketplace, type CustomerDemo } from './marketplace';

// One reset per document load, including React development StrictMode remounts.
// Hash navigation back to home within that document does not reset a second time.
let homeStart: Promise<CustomerDemo> | null = null;
let homeReady = false;
let initialization: Promise<CustomerDemo> | null = null;
export function initializeCustomerDemo(home: boolean) {
  if (home && !homeStart) return homeStart = marketplace.startCustomerDemo().finally(() => { homeReady = true; });
  if (homeStart && !homeReady) return homeStart;
  return initialization ||= marketplace.customerDemo().finally(() => { initialization = null; });
}
