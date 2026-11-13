import { describe, expect, it } from 'vitest';
import { databaseConnectionBudget } from './database-budget.js';

describe('restart connection capacity', () => {
  it('allocates spare per-machine capacity to side reads after core and jobs', () => {
    const budget = databaseConnectionBudget(100, 4);
    expect(budget.app).toBe(5);
    expect(budget.enrichment).toBe(11);
    expect(budget.app + budget.enrichment + budget.jobs + budget.diagnostics + budget.listener).toBe(budget.perMachine);
  });

  it.each([18, 20, 40, 100])('stays inside the database budget (%s)', capacity => {
    const b = databaseConnectionBudget(capacity);
    expect(b.enrichment).toBeGreaterThanOrEqual(1);
    expect((b.app + b.enrichment + b.jobs + b.diagnostics + b.listener) * b.serverMachines + b.reservedConnections).toBeLessThanOrEqual(capacity);
  });
});
