/**
 * Explicit database factory: importing this module does not open a connection.
 * Future long-lived applications should create one client and reuse its pool,
 * then call $disconnect during shutdown. No global client or secret is exported.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function createDatabase(connectionString: string): PrismaClient {
  // Refuse empty input instead of letting pg silently choose machine defaults.
  if (!connectionString.trim()) throw new Error('DATABASE_URL is required');
  const adapter = new PrismaPg({ connectionString, max: 5 });
  return new PrismaClient({ adapter });
}

// Public persistence boundary and typed errors for the ingress adapter.
export {
  acceptDelivery,
  DeliveryConflictError,
  OwnershipMismatchError,
} from './acceptance.js';
export type { AcceptanceInput, AcceptanceResult } from './acceptance.js';

// Dispatcher API is separate from ingress acceptance; neither starts itself on import.
export { dispatchNext, dispatchAttemptLimit } from './dispatch.js';

// Stop signals are durable; callers must obtain policy/actor context through authorization.
export { stopRuns, canExecuteRun } from './lifecycle.js';
export type { StopInput } from './lifecycle.js';
