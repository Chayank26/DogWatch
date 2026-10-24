/** Process-local, scope-bound reservation ledger. Never refunds uncertain attempts. */
import { z } from 'zod';
import { scopeSchema } from './api-execution.js';
export const browserBudgetSchema = z.strictObject({
  maxCalls: z.number().int().min(0).max(100).default(30),
  maxTokens: z.number().int().min(0).max(500000).default(100000),
  maxActions: z.number().int().min(0).max(300).default(60),
  maxRequests: z.number().int().min(0).max(1000).default(200),
  maxCostMicros: z.number().int().min(0).max(100000000),
  costPerCallMicros: z.number().int().min(1).max(10000000),
  maxExecutionMs: z.number().int().min(1).max(120000).default(60000),
});
export class BrowserBudget {
  private readonly scope;
  private readonly limits;
  private readonly started;
  private used = {
    calls: 0,
    tokens: 0,
    actions: 0,
    requests: 0,
    costMicros: 0,
  };
  constructor(
    scopeInput: unknown,
    limitsInput: unknown,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.scope = scopeSchema.parse(scopeInput);
    this.limits = browserBudgetSchema.parse(limitsInput);
    this.started = this.now();
  }
  private check(scopeInput: unknown) {
    const scope = scopeSchema.parse(scopeInput);
    if (
      Object.entries(this.scope).some(
        ([key, value]) => scope[key as keyof typeof scope] !== value,
      )
    )
      throw Error('budget_scope');
    if (this.remainingMs() <= 0) throw Error('shared_time_budget');
  }
  remainingMs() {
    return Math.max(
      0,
      this.limits.maxExecutionMs - Math.max(0, this.now() - this.started),
    );
  }
  reserve(scope: unknown, kind: 'call' | 'action' | 'request', tokens = 0) {
    this.check(scope);
    z.number().int().nonnegative().max(20000).parse(tokens);
    const next = { ...this.used };
    if (kind === 'call') {
      next.calls++;
      next.tokens += tokens;
      next.costMicros += this.limits.costPerCallMicros;
    } else if (kind === 'action') next.actions++;
    else next.requests++;
    if (
      next.calls > this.limits.maxCalls ||
      next.tokens > this.limits.maxTokens ||
      next.actions > this.limits.maxActions ||
      next.requests > this.limits.maxRequests ||
      next.costMicros > this.limits.maxCostMicros
    )
      throw Error('shared_budget');
    this.used = next;
  }
  snapshot() {
    return { ...this.used, remainingMs: Math.floor(this.remainingMs()) };
  }
}
