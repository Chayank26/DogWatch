/** Blind, fixed probes for the trusted local PawMart benchmark, not a generic QA detector. */
import { createFixtureSmokeDriver } from './smoke-fixture.js';
import { z } from 'zod';
import { SmokeStepError } from './smoke.js';
import type { Category, Observation } from './benchmark.js';
export async function probeFixture(origin: string, category: Category) {
  const target = new URL(origin);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.origin !== origin
  )
    throw Error('benchmark_origin');
  const start = performance.now();
  let requests = 0;
  const finish = (observation: Observation, code: string) => ({
    observation,
    code,
    requests,
    durationMs: Math.round(performance.now() - start),
  });
  async function request(path: string, token?: string, body?: object) {
    requests++;
    const response = await fetch(origin + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
      headers: {
        ...(token ? { Authorization: `Bearer fixture-${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: z.record(z.string(), z.unknown()).parse(await response.json()),
    };
  }
  try {
    if (category === 'ui') {
      const driver = await createFixtureSmokeDriver(origin, {
        user: 'alice',
        address: '',
      });
      try {
        for (const step of [
          { kind: 'navigate', path: '/' },
          { kind: 'select', selector: '#user', valueRef: 'user' },
          { kind: 'fill', selector: '#address', valueRef: 'address' },
          { kind: 'click', selector: 'button[type=submit]' },
          {
            kind: 'text',
            selector: '#status',
            expected: 'Address is required',
          },
        ] as const)
          await driver.execute(step, 2000);
        return finish('clear', 'validation_message_rendered');
      } catch (error) {
        return error instanceof SmokeStepError &&
          error.code === 'assertion_failed'
          ? finish('detected', 'validation_message_missing')
          : finish('inconclusive', 'browser_setup_or_interaction');
      } finally {
        await driver.close();
      }
    }
    // Independent positive controls separate a broken target/setup from a defect.
    const identity = await request('/api/identity', 'alice');
    if (identity.status !== 200 || identity.body.subjectId !== 'alice')
      return finish('inconclusive', 'identity_control');
    if (category === 'api') {
      const control = await request('/api/orders', 'alice', {
        address: '1 Test Lane',
        quantity: 2,
      });
      if (control.status !== 201)
        return finish('inconclusive', 'write_control');
      const result = await request('/api/orders', 'alice', {
        address: '',
        quantity: 2,
      });
      return result.status === 400
        ? finish('clear', 'validation_rejected')
        : result.status === 500
          ? finish('detected', 'validation_server_error')
          : finish('inconclusive', 'unexpected_validation_status');
    }
    if (category === 'authentication') {
      const result = await request('/api/identity');
      return result.status === 401
        ? finish('clear', 'authentication_rejected')
        : result.status === 200 && result.body.subjectId === 'alice'
          ? finish('detected', 'missing_auth_accepted')
          : finish('inconclusive', 'unexpected_auth_status');
    }
    if (category === 'ownership') {
      const control = await request('/api/orders/order-bob', 'bob');
      if (control.status !== 200 || control.body.owner !== 'bob')
        return finish('inconclusive', 'owner_control');
      const result = await request('/api/orders/order-bob', 'alice');
      return result.status === 403
        ? finish('clear', 'foreign_order_rejected')
        : result.status === 200 && result.body.owner === 'bob'
          ? finish('detected', 'foreign_order_exposed')
          : finish('inconclusive', 'unexpected_owner_status');
    }
    if (category === 'role') {
      const control = await request('/api/admin/report', 'admin');
      if (control.status !== 200 || control.body.scope !== 'admin')
        return finish('inconclusive', 'admin_control');
      const result = await request('/api/admin/report', 'alice');
      return result.status === 403
        ? finish('clear', 'customer_rejected')
        : result.status === 200 && result.body.scope === 'admin'
          ? finish('detected', 'admin_report_exposed')
          : finish('inconclusive', 'unexpected_role_status');
    }
    const created = await request('/api/orders', 'alice', {
      address: '1 Test Lane',
      quantity: 2,
    });
    if (
      created.status !== 201 ||
      typeof created.body.id !== 'string' ||
      !/^order-created-\d+$/.test(created.body.id)
    )
      return finish('inconclusive', 'create_control');
    const read = await request('/api/orders/' + created.body.id, 'alice');
    if (read.status !== 200 || read.body.id !== created.body.id)
      return finish('inconclusive', 'read_control');
    return read.body.quantity === 2
      ? finish('clear', 'quantity_preserved')
      : finish('detected', 'quantity_lost');
  } catch {
    return finish('inconclusive', 'probe_unavailable');
  }
}
