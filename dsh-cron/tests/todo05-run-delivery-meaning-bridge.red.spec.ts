/**
 * TODO05 source-neutral Cordis bridge B/C1/C2 RED.
 *
 * This file covers the package boundary and run-scoped B/C1/C2 port seams.
 * It does not define Feed/PF shapes or scheduler C2 gating.
 */

import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlStore, RunLedger } from '../src/store.ts';
import type {
  CronDeliveryReceipt,
  RunClaimRecord,
  RunDeliveryReceiptRecord,
  RunEnvironmentPrefinishSettleRecord,
  RunFinishRecord,
} from '../src/types.ts';
import type {
  CronPreparedDeliveryClaimBinding,
  CronRunDeliveryMeaningPortFactory,
} from '../src/run-environment.ts';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function directoryBytes(directory: string): Promise<Map<string, string>> {
  const names = (await readdir(directory)).sort();
  return new Map(await Promise.all(names.map(async name => [
    name,
    Buffer.from(await readFile(join(directory, name))).toString('base64'),
  ] as const)));
}

async function durableClaim(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
  prepared = true,
): Promise<CronPreparedDeliveryClaimBinding> {
  const claim: RunClaimRecord = {
    schemaVersion: 2,
    event: 'claim',
    jobId: `bridge-${suffix}`,
    runId: `bridge-${trigger}-${suffix}`,
    sessionId: `session-${suffix}`,
    scheduledFor: new Date(1_000).toISOString(),
    claimedAt: new Date(2_000).toISOString(),
    trigger,
    ...(prepared
      ? { agentEnvironment: 'bridge-provider/v1' as const, deliveryLifecycle: 'prepared' as const }
      : {}),
  };
  new RunLedger(directory).claim(claim);
  return {
    jobId: claim.jobId,
    runId: claim.runId,
    sessionId: claim.sessionId,
    scheduledFor: claim.scheduledFor,
    claimedAt: claim.claimedAt,
    trigger,
  };
}

async function realFactory(directory: string): Promise<CronRunDeliveryMeaningPortFactory> {
  const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
  const createFactory = module.createCronRunDeliveryMeaningPortFactory;
  if (typeof createFactory !== 'function') throw new Error('internal meaning factory is unavailable');
  return (createFactory as (config: { readonly storeDir: string }) => CronRunDeliveryMeaningPortFactory)({
    storeDir: directory,
  });
}

function prepareObject(
  directory: string,
  binding: CronPreparedDeliveryClaimBinding,
  objectId: string,
): void {
  new RunLedger(directory).prepareDelivery({
    schemaVersion: 2,
    event: 'prepared-delivery',
    jobId: binding.jobId,
    runId: binding.runId,
    sessionId: binding.sessionId,
    scheduledFor: binding.scheduledFor,
    preparedAt: new Date(3_000).toISOString(),
    objectId,
    text: `prepared text for ${binding.runId}`,
  });
}

async function preparedReceiptFixture(
  directory: string,
  trigger: 'scheduled' | 'manual',
  suffix: string,
  state: CronDeliveryReceipt['deliveryState'] = 'delivered',
): Promise<{
  readonly binding: CronPreparedDeliveryClaimBinding
  readonly receipt: CronDeliveryReceipt
  readonly factory: CronRunDeliveryMeaningPortFactory
  readonly port: Extract<Awaited<ReturnType<CronRunDeliveryMeaningPortFactory['createRunPort']>>, { readonly status: 'accepted' }>['port']
  readonly dispose: () => void | Promise<void>
}> {
  const binding = await durableClaim(directory, trigger, suffix);
  const objectId = `receipt-object-${suffix}`;
  prepareObject(directory, binding, objectId);
  const factory = await realFactory(directory);
  const created = await factory.createRunPort(binding);
  if (created.status !== 'accepted') throw new Error('expected accepted run port');
  const business = await created.port.bindPreparedDelivery({
    businessRunId: `receipt-business-${suffix}`,
    businessPeriodId: `receipt-period-${suffix}`,
  });
  if (business.status !== 'accepted') throw new Error('expected accepted B binding');

  const ledger = new RunLedger(directory);
  const claimedAt = new Date(4_000).toISOString();
  ledger.claimDeliveryAttempt({
    schemaVersion: 2,
    event: 'delivery-attempt-claim',
    jobId: binding.jobId,
    runId: binding.runId,
    sessionId: binding.sessionId,
    scheduledFor: binding.scheduledFor,
    claimedAt,
    objectId,
  });
  const receipt: CronDeliveryReceipt = {
    objectId,
    jobId: binding.jobId,
    runId: binding.runId,
    sessionId: binding.sessionId,
    scheduledFor: binding.scheduledFor,
    deliveryState: state,
    ...(state === 'delivered' ? { deliveredAt: new Date(5_000).toISOString() } : {}),
    ...(state === 'failed' || state === 'uncertain' ? { deliveryError: `${state} receipt evidence` } : {}),
  };
  ledger.recordDeliveryReceipt({
    schemaVersion: 2,
    event: 'delivery-receipt',
    ...receipt,
    receiptAt: new Date(6_000).toISOString(),
  } satisfies RunDeliveryReceiptRecord);
  return { binding, receipt, factory, port: created.port, dispose: created.dispose };
}

describe('TODO05 source-neutral scheduler-owned bridge bootstrap RED', () => {
  it('exposes one canonical scheduler-owned factory token while keeping the owner factory internal', async () => {
    const environment = await import('../src/run-environment.js') as Record<string, unknown>;
    const packageIndex = await import('../src/index.js') as Record<string, unknown>;

    expect(environment.CRON_RUN_DELIVERY_MEANING_LIFECYCLE).toEqual(expect.any(String));
    expect(packageIndex.createCronRunDeliveryMeaningLifecycle).toBeUndefined();
    expect(packageIndex.createCronRunDeliveryMeaningPortFactory).toBeUndefined();
    expect(packageIndex.JsonlRunDeliveryMeaningStore).toBeUndefined();
  });

  it('fails closed through the internal creator when the exact durable claim does not exist', async () => {
    const directory = await temporaryDirectory('todo05-bridge-bootstrap-');
    const before = await directoryBytes(directory);
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;

    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;

    const binding = {
      jobId: 'bootstrap-job',
      runId: 'bootstrap-run',
      sessionId: 'bootstrap-session',
      scheduledFor: new Date(0).toISOString(),
      claimedAt: new Date(0).toISOString(),
      trigger: 'scheduled',
    } as const;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: typeof binding) => Promise<unknown>;
    })({ storeDir: directory });
    const result = await factory.createRunPort(binding);

    expect(result).toEqual({ status: 'failed', error: expect.any(String) });
    const after = await directoryBytes(directory);
    expect(after).toEqual(before);
  });

  it.each([
    ['scheduled', 'factory-scheduled'],
    ['manual', 'factory-manual'],
  ] as const)('registers a %s exact prepared claim into an accepted run-scoped port', async (trigger, suffix) => {
    const directory = await temporaryDirectory(`todo05-bridge-${suffix}-`);
    const binding = await durableClaim(directory, trigger, suffix);
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;

    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const result = await factory.createRunPort(binding);

    expect(result).toEqual({
      status: 'accepted',
      port: expect.objectContaining({
        bindPreparedDelivery: expect.any(Function),
        acceptDurableReceipt: expect.any(Function),
        commitBusinessFinalization: expect.any(Function),
      }),
      dispose: expect.any(Function),
    });
    if (result.status !== 'accepted') return;

    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    const ownerRows = (await readFile(ownerPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const lineageRows = ownerRows.filter(row => row.event === 'external-first-lineage');
    expect(lineageRows).toHaveLength(1);
    expect(lineageRows[0]?.claim).toEqual(binding);
    expect(lineageRows[0]?.runLineage).toBe('external_first');

    const firstBytes = await directoryBytes(directory);
    const replay = await factory.createRunPort(binding);
    expect(replay).toEqual({
      status: 'accepted',
      port: expect.objectContaining({
        bindPreparedDelivery: expect.any(Function),
        acceptDurableReceipt: expect.any(Function),
        commitBusinessFinalization: expect.any(Function),
      }),
      dispose: expect.any(Function),
    });
    if (replay.status === 'accepted' && result.status === 'accepted') {
      expect.soft(replay.port).toBe(result.port);
      expect.soft(replay.dispose).toBe(result.dispose);
    }
    expect(await directoryBytes(directory)).toEqual(firstBytes);

    const dispose = result.dispose;
    await dispose();
    await replay.dispose();

    const rebuilt = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const rebuiltResult = await rebuilt.createRunPort(binding);
    expect(rebuiltResult).toEqual({
      status: 'accepted',
      port: expect.objectContaining({
        bindPreparedDelivery: expect.any(Function),
        acceptDurableReceipt: expect.any(Function),
        commitBusinessFinalization: expect.any(Function),
      }),
      dispose: expect.any(Function),
    });
    expect(await directoryBytes(directory)).toEqual(firstBytes);

    if (replay.status !== 'accepted' || rebuiltResult.status !== 'accepted') return;
    expect(rebuiltResult.port).not.toBe(result.port);
    expect(rebuiltResult.dispose).not.toBe(result.dispose);
    expect(Object.keys(replay.port).sort()).toEqual(Object.keys(result.port).sort());
    expect(Object.keys(rebuiltResult.port).sort()).toEqual(Object.keys(result.port).sort());
    expect(Object.isFrozen(replay.port)).toBe(true);
    expect(Object.isFrozen(rebuiltResult.port)).toBe(true);

    expect(Object.keys(result.port).sort()).toEqual([
      'acceptDurableReceipt',
      'bindPreparedDelivery',
      'commitBusinessFinalization',
    ]);
    expect(Object.isFrozen(result.port)).toBe(true);

    const receipt: CronDeliveryReceipt = {
      objectId: 'bridge-object-1',
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      deliveryState: 'delivered',
    };
    await dispose();
    await rebuiltResult.dispose();

    const fresh = await factory.createRunPort(binding);
    expect(fresh).toEqual({
      status: 'accepted',
      port: expect.objectContaining({
        bindPreparedDelivery: expect.any(Function),
        acceptDurableReceipt: expect.any(Function),
        commitBusinessFinalization: expect.any(Function),
      }),
      dispose: expect.any(Function),
    });
    if (fresh.status === 'accepted') {
      expect(fresh.port).not.toBe(result.port);
      expect(await fresh.port.bindPreparedDelivery({ businessRunId: 'b', businessPeriodId: 'p' }))
        .toEqual({ status: 'rejected', input: { businessRunId: 'b', businessPeriodId: 'p' } });
      await fresh.dispose();
    }
    expect(await result.port.bindPreparedDelivery({ businessRunId: 'b', businessPeriodId: 'p' }))
      .toEqual({ status: 'failed', input: { businessRunId: 'b', businessPeriodId: 'p' } });
    expect(await result.port.acceptDurableReceipt(receipt))
      .toEqual({ status: 'failed', input: receipt });
    expect(await result.port.commitBusinessFinalization())
      .toEqual({ status: 'failed', input: undefined });
    expect(await directoryBytes(directory)).toEqual(firstBytes);
  });

  it.each([
    ['scheduled', 'prepared-scheduled'],
    ['manual', 'prepared-manual'],
  ] as const)('binds the exact prepared object for a %s run and stores one B owner fact', async (trigger, suffix) => {
    const directory = await temporaryDirectory(`todo05-bridge-prepared-${suffix}-`);
    const binding = await durableClaim(directory, trigger, suffix);
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') throw new Error('expected accepted run port');

    const input = { businessRunId: `business-${suffix}`, businessPeriodId: `period-${suffix}` };
    const beforePrepared = await directoryBytes(directory);
    expect(await created.port.bindPreparedDelivery(input)).toEqual({ status: 'rejected', input });
    expect(await directoryBytes(directory)).toEqual(beforePrepared);

    prepareObject(directory, binding, `object-${suffix}`);
    const beforeBinding = await directoryBytes(directory);
    expect(await created.port.bindPreparedDelivery(input)).toEqual({ status: 'accepted' });
    const afterBinding = await directoryBytes(directory);
    expect(afterBinding).not.toEqual(beforeBinding);
    const ownerRows = (await readFile(join(directory, 'run-delivery-meaning.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const primaryRows = ownerRows.filter(row => row.event === 'primary-run-content-object');
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0]).toMatchObject({
      claim: binding,
      objectId: `object-${suffix}`,
      businessRunId: input.businessRunId,
      businessPeriodId: input.businessPeriodId,
      objectClass: 'primary_run_content',
      runLineage: 'external_first',
    });
    await created.dispose();
  });

  it('replays one prepared binding across the active port and a rebuilt factory without another owner fact', async () => {
    const directory = await temporaryDirectory('todo05-bridge-prepared-idempotent-');
    const binding = await durableClaim(directory, 'manual', 'prepared-idempotent');
    prepareObject(directory, binding, 'prepared-idempotent-object');
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') throw new Error('expected accepted run port');
    const input = { businessRunId: 'prepared-business', businessPeriodId: 'prepared-period' };
    expect(await created.port.bindPreparedDelivery(input)).toEqual({ status: 'accepted' });
    const firstBytes = await directoryBytes(directory);
    expect(await created.port.bindPreparedDelivery(input)).toEqual({ status: 'accepted' });
    expect(await directoryBytes(directory)).toEqual(firstBytes);

    await created.dispose();
    const rebuilt = await realFactory(directory);
    const rebuiltResult = await rebuilt.createRunPort(binding);
    expect(rebuiltResult.status).toBe('accepted');
    if (rebuiltResult.status !== 'accepted') throw new Error('expected rebuilt accepted run port');
    expect(rebuiltResult.port).not.toBe(created.port);
    expect(await rebuiltResult.port.bindPreparedDelivery(input)).toEqual({ status: 'accepted' });
    expect(await directoryBytes(directory)).toEqual(firstBytes);
    expect(await created.port.bindPreparedDelivery(input)).toEqual({ status: 'failed', input });
    expect(await directoryBytes(directory)).toEqual(firstBytes);
    await rebuiltResult.dispose();
  });

  it('rejects same-run business-reference conflicts and preserves the first B fact', async () => {
    const directory = await temporaryDirectory('todo05-bridge-prepared-same-run-conflict-');
    const binding = await durableClaim(directory, 'scheduled', 'prepared-same-run-conflict');
    prepareObject(directory, binding, 'prepared-same-run-conflict-object');
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') throw new Error('expected accepted run port');
    const firstInput = { businessRunId: 'same-run-business', businessPeriodId: 'same-run-period' };
    expect(await created.port.bindPreparedDelivery(firstInput)).toEqual({ status: 'accepted' });
    const firstBytes = await directoryBytes(directory);
    for (const conflictingInput of [
      { businessRunId: 'same-run-business-other', businessPeriodId: firstInput.businessPeriodId },
      { businessRunId: firstInput.businessRunId, businessPeriodId: 'same-run-period-other' },
    ]) {
      expect(await created.port.bindPreparedDelivery(conflictingInput)).toEqual({
        status: 'rejected',
        input: conflictingInput,
      });
      expect(await directoryBytes(directory)).toEqual(firstBytes);
    }
    expect(await created.port.bindPreparedDelivery(firstInput)).toEqual({ status: 'accepted' });
    expect(await directoryBytes(directory)).toEqual(firstBytes);
    await created.dispose();
  });

  it.each([
    ['extra key', { businessRunId: 'ingress-business', businessPeriodId: 'ingress-period', extra: 'reject' }],
    ['missing businessPeriodId', { businessRunId: 'ingress-business' }],
    ['blank businessRunId', { businessRunId: '', businessPeriodId: 'ingress-period' }],
    ['blank businessPeriodId', { businessRunId: 'ingress-business', businessPeriodId: '   ' }],
    ['businessRunId over bound', { businessRunId: 'x'.repeat(1_025), businessPeriodId: 'ingress-period' }],
    ['businessPeriodId over bound', { businessRunId: 'ingress-business', businessPeriodId: 'x'.repeat(1_025) }],
  ] as const)('rejects %s at the run-port ingress without writing B', async (_name, input) => {
    const directory = await temporaryDirectory('todo05-bridge-prepared-ingress-');
    const binding = await durableClaim(directory, 'manual', `prepared-ingress-${_name}`);
    prepareObject(directory, binding, `prepared-ingress-object-${_name}`);
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') throw new Error('expected accepted run port');
    const before = await directoryBytes(directory);
    const bind = created.port.bindPreparedDelivery as (value: unknown) => Promise<unknown>;
    expect(await bind(input)).toEqual({ status: 'rejected', input });
    expect(await directoryBytes(directory)).toEqual(before);
    const ownerRows = (await readFile(join(directory, 'run-delivery-meaning.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(ownerRows.filter(row => row.event === 'primary-run-content-object')).toHaveLength(0);
    await created.dispose();
  });

  it.each([
    ['same object across runs', true],
    ['same business run and period across runs', false],
  ] as const)('rejects a %s while preserving the first B owner fact', async (_label, reuseObject) => {
    const directory = await temporaryDirectory('todo05-bridge-prepared-conflict-');
    const firstBinding = await durableClaim(directory, 'scheduled', 'prepared-conflict-one');
    const secondBinding = await durableClaim(directory, 'manual', 'prepared-conflict-two');
    const firstObject = 'prepared-conflict-object-one';
    prepareObject(directory, firstBinding, firstObject);
    prepareObject(directory, secondBinding, reuseObject ? firstObject : 'prepared-conflict-object-two');
    const factory = await realFactory(directory);
    const first = await factory.createRunPort(firstBinding);
    const second = await factory.createRunPort(secondBinding);
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('expected accepted run ports');
    const firstInput = { businessRunId: 'conflict-business-one', businessPeriodId: 'conflict-period-one' };
    expect(await first.port.bindPreparedDelivery(firstInput)).toEqual({ status: 'accepted' });
    const conflictingInput = reuseObject
      ? { businessRunId: 'conflict-business-two', businessPeriodId: 'conflict-period-two' }
      : firstInput;
    const before = await directoryBytes(directory);
    expect(await second.port.bindPreparedDelivery(conflictingInput)).toEqual({
      status: 'rejected',
      input: conflictingInput,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    const ownerRows = (await readFile(join(directory, 'run-delivery-meaning.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(ownerRows.filter(row => row.event === 'primary-run-content-object')).toHaveLength(1);
    await first.dispose();
    await second.dispose();
  });

  it.each([
    ['sessionId', (binding: CronPreparedDeliveryClaimBinding) => ({
        ...binding,
        sessionId: `${binding.sessionId}-other`,
      })],
    ['scheduledFor', (binding: CronPreparedDeliveryClaimBinding) => ({
        ...binding,
        scheduledFor: new Date(Date.parse(binding.scheduledFor) + 60_000).toISOString(),
      })],
    ['claimedAt', (binding: CronPreparedDeliveryClaimBinding) => ({
        ...binding,
        claimedAt: new Date(Date.parse(binding.claimedAt) + 60_000).toISOString(),
      })],
    ['trigger', (binding: CronPreparedDeliveryClaimBinding) => ({
        ...binding,
        trigger: binding.trigger === 'scheduled' ? 'manual' : 'scheduled',
      })],
  ] as const)('fails an active same-run replay when %s changes without touching the cached lease', async (field, mutate) => {
    const directory = await temporaryDirectory(`todo05-bridge-active-${field}-`);
    const binding = await durableClaim(directory, 'scheduled', `active-${field}`);
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;

    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(binding);
    expect(first).toEqual({
      status: 'accepted',
      port: expect.objectContaining({
        bindPreparedDelivery: expect.any(Function),
        acceptDurableReceipt: expect.any(Function),
        commitBusinessFinalization: expect.any(Function),
      }),
      dispose: expect.any(Function),
    });
    if (first.status !== 'accepted') return;

    const before = await directoryBytes(directory);
    const wrongBinding = mutate(binding);
    await expect(factory.createRunPort(wrongBinding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
    expect(await first.port.bindPreparedDelivery({ businessRunId: 'b', businessPeriodId: 'p' }))
      .toEqual({ status: 'rejected', input: { businessRunId: 'b', businessPeriodId: 'p' } });
    await first.dispose();
  });

  it('fails an active exact replay when the real owner row becomes malformed', async () => {
    const directory = await temporaryDirectory('todo05-bridge-active-owner-corrupt-');
    const binding = await durableClaim(directory, 'scheduled', 'active-owner-corrupt');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;

    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(binding);
    expect(first).toEqual(expect.objectContaining({ status: 'accepted' }));
    if (first.status !== 'accepted') return;

    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    const ownerRow = await readFile(ownerPath, 'utf8');
    expect(ownerRow.trim()).not.toBe('');
    await writeFile(ownerPath, ownerRow.replace(/}\s*$/, '\n'), 'utf8');
    const before = await directoryBytes(directory);

    await expect(factory.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await first.dispose();
  });

  it('rejects a durable claim without prepared lifecycle without writing', async () => {
    const directory = await temporaryDirectory('todo05-bridge-unprepared-');
    const binding = await durableClaim(directory, 'manual', 'unprepared', false);
    const before = await directoryBytes(directory);
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });

    await expect(factory.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('rejects a six-field binding mismatch without writing', async () => {
    const directory = await temporaryDirectory('todo05-bridge-mismatch-');
    const binding = await durableClaim(directory, 'scheduled', 'mismatch');
    const before = await directoryBytes(directory);
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });

    await expect(factory.createRunPort({ ...binding, runId: `${binding.runId}-wrong` })).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('fails a rebuilt factory on malformed real A owner data without writing', async () => {
    const directory = await temporaryDirectory('todo05-bridge-owner-malformed-');
    const binding = await durableClaim(directory, 'manual', 'owner-malformed');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(binding);
    expect(first).toEqual(expect.objectContaining({ status: 'accepted' }));
    if (first.status !== 'accepted') return;
    await first.dispose();
    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    await writeFile(ownerPath, '{malformed\n', 'utf8');
    const before = await directoryBytes(directory);
    const rebuilt = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    await expect(rebuilt.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('fails a rebuilt factory on duplicate real A owner data without writing', async () => {
    const directory = await temporaryDirectory('todo05-bridge-owner-duplicate-');
    const binding = await durableClaim(directory, 'scheduled', 'owner-duplicate');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(binding);
    expect(first).toEqual(expect.objectContaining({ status: 'accepted' }));
    if (first.status !== 'accepted') return;
    await first.dispose();
    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    const ownerRow = await readFile(ownerPath, 'utf8');
    await appendFile(ownerPath, ownerRow, 'utf8');
    const before = await directoryBytes(directory);
    const rebuilt = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    await expect(rebuilt.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('returns failed rather than throwing when the owner store read fails', async () => {
    const directory = await temporaryDirectory('todo05-bridge-owner-io-');
    const binding = await durableClaim(directory, 'manual', 'owner-io');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(binding);
    expect(first).toEqual(expect.objectContaining({ status: 'accepted' }));
    if (first.status !== 'accepted') return;
    await first.dispose();
    const originalReadLines = JsonlStore.prototype.readLines;
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function () {
      const file = Reflect.get(this, 'file');
      if (typeof file === 'string' && file.endsWith('run-delivery-meaning.jsonl')) throw new Error('owner read failed');
      return originalReadLines.call(this);
    });
    const before = await directoryBytes(directory);
    const rebuilt = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    await expect(rebuilt.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
    vi.restoreAllMocks();
  });

  it('returns failed rather than throwing when the runs ledger read fails', async () => {
    const directory = await temporaryDirectory('todo05-bridge-runs-io-');
    const binding = await durableClaim(directory, 'scheduled', 'runs-io');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const originalReadLines = JsonlStore.prototype.readLines;
    vi.spyOn(JsonlStore.prototype, 'readLines').mockImplementation(function () {
      const file = Reflect.get(this, 'file');
      if (typeof file === 'string' && file.endsWith('runs.jsonl')) throw new Error('runs read failed');
      return originalReadLines.call(this);
    });
    const before = await directoryBytes(directory);
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    await expect(factory.createRunPort(binding)).resolves.toEqual({
      status: 'failed',
      error: expect.any(String),
    });
    expect(await directoryBytes(directory)).toEqual(before);
    vi.restoreAllMocks();
  });

  it('keeps two concurrent exact claims on distinct run-scoped ports', async () => {
    const directory = await temporaryDirectory('todo05-bridge-concurrent-');
    const firstBinding = await durableClaim(directory, 'scheduled', 'concurrent-one');
    const secondBinding = await durableClaim(directory, 'manual', 'concurrent-two');
    const module = await import('../src/run-delivery-meaning.js') as Record<string, unknown>;
    const createFactory = module.createCronRunDeliveryMeaningPortFactory;
    expect(typeof createFactory).toBe('function');
    if (typeof createFactory !== 'function') return;
    const factory = (createFactory as (config: { readonly storeDir: string }) => {
      readonly createRunPort: (claim: CronPreparedDeliveryClaimBinding) => Promise<unknown>;
    })({ storeDir: directory });
    const first = await factory.createRunPort(firstBinding);
    const second = await factory.createRunPort(secondBinding);

    expect(first).toEqual(expect.objectContaining({ status: 'accepted' }));
    expect(second).toEqual(expect.objectContaining({ status: 'accepted' }));
    if (first.status !== 'accepted' || second.status !== 'accepted') return;
    expect(first.port).not.toBe(second.port);
    await first.dispose();
    expect(await second.port.bindPreparedDelivery({ businessRunId: 'b', businessPeriodId: 'p' }))
      .toEqual({ status: 'rejected', input: { businessRunId: 'b', businessPeriodId: 'p' } });
  });

  it.each([
    ['scheduled', 'delivered'],
    ['manual', 'failed'],
    ['scheduled', 'uncertain'],
  ] as const)('accepts the exact durable %s receipt state %s through the run-scoped port', async (trigger, state) => {
    const directory = await temporaryDirectory(`todo05-bridge-receipt-${trigger}-${state}-`);
    const fixture = await preparedReceiptFixture(directory, trigger, `${trigger}-${state}`, state);
    const before = await directoryBytes(directory);
    const result = await fixture.port.acceptDurableReceipt(fixture.receipt);
    expect(result).toEqual({ status: 'accepted', value: { receipt: fixture.receipt } });
    if (result.status !== 'accepted') return;
    expect(result.value.receipt).toEqual(fixture.receipt);
    const receiptLine = (await readFile(join(directory, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .find(line => (JSON.parse(line) as Record<string, unknown>).event === 'delivery-receipt');
    expect(receiptLine).toBeDefined();
    const ownerRows = (await readFile(join(directory, 'run-delivery-meaning.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const meaningRows = ownerRows.filter(row => row.event === 'run-delivery-meaning');
    expect(meaningRows).toHaveLength(1);
    expect(meaningRows[0]).toMatchObject({
      claim: fixture.binding,
      objectId: fixture.receipt.objectId,
      businessRunId: `receipt-business-${trigger}-${state}`,
      businessPeriodId: `receipt-period-${trigger}-${state}`,
      receiptDigest: createHash('sha256').update(receiptLine!).digest('hex'),
    });
    expect(JSON.stringify(meaningRows[0])).not.toMatch(/deliveryState|deliveredAt|deliveryError|finalization|ack|finish/i);
    const technicalRecords = (await readFile(join(directory, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(technicalRecords.filter(record => record.event === 'environment-prefinish-settle')).toHaveLength(0);
    expect(technicalRecords.filter(record => record.event === 'finish')).toHaveLength(0);
    expect(ownerRows.filter(record => record.event === 'primary-run-content-business-finalization')).toHaveLength(0);
    const firstBytes = await directoryBytes(directory);
    expect(firstBytes).not.toEqual(before);

    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual(result);
    expect(await directoryBytes(directory)).toEqual(firstBytes);
    await fixture.dispose();
    const rebuilt = await realFactory(directory);
    const rebuiltResult = await rebuilt.createRunPort(fixture.binding);
    expect(rebuiltResult.status).toBe('accepted');
    if (rebuiltResult.status !== 'accepted') return;
    await expect(rebuiltResult.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual(result);
    expect(await directoryBytes(directory)).toEqual(firstBytes);
    await rebuiltResult.dispose();
  });

  it.each([
    ['extra receipt field', (receipt: CronDeliveryReceipt) => ({ ...receipt, extra: 'reject' })],
    ['foreign object identity', (receipt: CronDeliveryReceipt) => ({ ...receipt, objectId: `${receipt.objectId}-foreign` })],
    ['foreign job identity', (receipt: CronDeliveryReceipt) => ({ ...receipt, jobId: `${receipt.jobId}-foreign` })],
    ['foreign run identity', (receipt: CronDeliveryReceipt) => ({ ...receipt, runId: `${receipt.runId}-foreign` })],
    ['foreign session identity', (receipt: CronDeliveryReceipt) => ({ ...receipt, sessionId: `${receipt.sessionId}-foreign` })],
    ['foreign scheduled time', (receipt: CronDeliveryReceipt) => ({ ...receipt, scheduledFor: new Date(7_000).toISOString() })],
    ['foreign delivery state', (receipt: CronDeliveryReceipt) => {
      const { deliveredAt: _deliveredAt, ...withoutDeliveredAt } = receipt;
      return { ...withoutDeliveredAt, deliveryState: 'failed', deliveryError: 'foreign state' };
    }],
    ['foreign delivered time', (receipt: CronDeliveryReceipt) => ({ ...receipt, deliveredAt: new Date(7_000).toISOString() })],
  ] as const)('rejects %s without writing a C1 fact', async (_label, mutate) => {
    const directory = await temporaryDirectory(`todo05-bridge-receipt-invalid-${_label}-`);
    const fixture = await preparedReceiptFixture(directory, 'manual', `invalid-${_label}`, 'delivered');
    const before = await directoryBytes(directory);
    const input = mutate(fixture.receipt);
    const accept = fixture.port.acceptDurableReceipt as (value: unknown) => Promise<unknown>;
    await expect(accept(input)).resolves.toEqual({ status: 'rejected', input });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('rejects a legal but conflicting deliveryError on a failed durable receipt', async () => {
    const directory = await temporaryDirectory('todo05-bridge-receipt-invalid-error-');
    const fixture = await preparedReceiptFixture(directory, 'manual', 'invalid-error', 'failed');
    const before = await directoryBytes(directory);
    const input = { ...fixture.receipt, deliveryError: 'another valid durable error' };
    await expect(fixture.port.acceptDurableReceipt(input)).resolves.toEqual({ status: 'rejected', input });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it.each([
    ['prepared and B but no attempt or receipt', false, false],
    ['attempt but no receipt', true, false],
  ] as const)('rejects C1 when %s', async (_label, withAttempt, withReceipt) => {
    const directory = await temporaryDirectory(`todo05-bridge-receipt-missing-${withAttempt}-${withReceipt}-`);
    const binding = await durableClaim(directory, 'scheduled', `missing-${withAttempt}-${withReceipt}`);
    const objectId = `missing-object-${withAttempt}-${withReceipt}`;
    prepareObject(directory, binding, objectId);
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') return;
    expect(await created.port.bindPreparedDelivery({ businessRunId: 'missing-business', businessPeriodId: 'missing-period' }))
      .toEqual({ status: 'accepted' });
    if (withAttempt) {
      new RunLedger(directory).claimDeliveryAttempt({
        schemaVersion: 2,
        event: 'delivery-attempt-claim',
        jobId: binding.jobId,
        runId: binding.runId,
        sessionId: binding.sessionId,
        scheduledFor: binding.scheduledFor,
        claimedAt: new Date(4_000).toISOString(),
        objectId,
      });
    }
    const input: CronDeliveryReceipt = {
      objectId,
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      deliveryState: 'delivered',
    };
    const before = await directoryBytes(directory);
    await expect(created.port.acceptDurableReceipt(input)).resolves.toEqual({ status: 'rejected', input });
    expect(await directoryBytes(directory)).toEqual(before);
    await created.dispose();
  });

  it('fails when attempt and receipt exist without the exact B owner', async () => {
    const directory = await temporaryDirectory('todo05-bridge-receipt-without-b-');
    const binding = await durableClaim(directory, 'manual', 'without-b');
    const objectId = 'receipt-without-b-object';
    prepareObject(directory, binding, objectId);
    const ledger = new RunLedger(directory);
    ledger.claimDeliveryAttempt({
      schemaVersion: 2,
      event: 'delivery-attempt-claim',
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      claimedAt: new Date(4_000).toISOString(),
      objectId,
    });
    const receipt: CronDeliveryReceipt = {
      objectId,
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      deliveryState: 'uncertain',
      deliveryError: 'transport ambiguous',
    };
    ledger.recordDeliveryReceipt({
      schemaVersion: 2,
      event: 'delivery-receipt',
      ...receipt,
      receiptAt: new Date(6_000).toISOString(),
    });
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') return;
    const before = await directoryBytes(directory);
    await expect(created.port.acceptDurableReceipt(receipt)).resolves.toEqual({ status: 'failed', input: receipt });
    expect(await directoryBytes(directory)).toEqual(before);
    await created.dispose();
  });

  it('fails after the run-scoped port is disposed and never writes C1', async () => {
    const directory = await temporaryDirectory('todo05-bridge-receipt-disposed-');
    const fixture = await preparedReceiptFixture(directory, 'manual', 'disposed', 'delivered');
    await fixture.dispose();
    const before = await directoryBytes(directory);
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'failed',
      input: fixture.receipt,
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('fails closed on a conflicting raw receipt row and preserves the first technical fact', async () => {
    const directory = await temporaryDirectory('todo05-bridge-receipt-conflict-');
    const fixture = await preparedReceiptFixture(directory, 'scheduled', 'conflict', 'delivered');
    const conflicting: RunDeliveryReceiptRecord = {
      schemaVersion: 2,
      event: 'delivery-receipt',
      ...fixture.receipt,
      deliveryState: 'uncertain',
      deliveryError: 'later conflicting raw fact',
      receiptAt: new Date(7_000).toISOString(),
    };
    await appendFile(join(directory, 'runs.jsonl'), `${JSON.stringify(conflicting)}\n`, 'utf8');
    const before = await directoryBytes(directory);
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'failed',
      input: fixture.receipt,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('re-reads a real meaning owner on active-port replay after owner corruption', async () => {
    const directory = await temporaryDirectory('todo05-bridge-receipt-owner-corrupt-');
    const fixture = await preparedReceiptFixture(directory, 'scheduled', 'owner-corrupt', 'delivered');
    const first = await fixture.port.acceptDurableReceipt(fixture.receipt);
    expect(first).toEqual({ status: 'accepted', value: { receipt: fixture.receipt } });
    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    const lines = (await readFile(ownerPath, 'utf8')).trim().split('\n');
    const meaningIndex = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event === 'run-delivery-meaning');
    expect(meaningIndex).toBeGreaterThanOrEqual(0);
    const meaning = JSON.parse(lines[meaningIndex!]!) as Record<string, unknown>;
    lines[meaningIndex!] = JSON.stringify({ ...meaning, receiptDigest: 'f'.repeat(64) });
    await writeFile(ownerPath, `${lines.join('\n')}\n`, 'utf8');
    const before = await directoryBytes(directory);
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'failed',
      input: fixture.receipt,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

});

describe('TODO05 run-scoped C2 finalization RED', () => {
  it.each([
    ['scheduled', 'delivered'],
    ['manual', 'failed'],
    ['scheduled', 'uncertain'],
  ] as const)('commits the exact %s durable %s receipt into one C2 owner fact', async (trigger, state) => {
    const directory = await temporaryDirectory(`todo05-bridge-c2-${trigger}-${state}-`);
    const fixture = await preparedReceiptFixture(directory, trigger, `c2-${trigger}-${state}`, state);
    const c1 = await fixture.port.acceptDurableReceipt(fixture.receipt);
    expect(c1).toEqual({ status: 'accepted', value: { receipt: fixture.receipt } });
    const beforeC2 = await directoryBytes(directory);

    const first = await fixture.port.commitBusinessFinalization();
    expect(first).toEqual({ status: 'accepted' });
    const ownerRows = (await readFile(join(directory, 'run-delivery-meaning.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const finalizationRows = ownerRows.filter(row => row.event === 'primary-run-content-business-finalization');
    expect(finalizationRows).toHaveLength(1);
    expect(finalizationRows[0]).toMatchObject({
      claim: fixture.binding,
      objectId: fixture.receipt.objectId,
      businessRunId: `receipt-business-c2-${trigger}-${state}`,
      businessPeriodId: `receipt-period-c2-${trigger}-${state}`,
    });
    expect(JSON.stringify(finalizationRows[0])).not.toMatch(/deliveryState|deliveryError|receiptDigest|retry|authorization|text/i);

    const afterFirst = await directoryBytes(directory);
    expect(afterFirst).not.toEqual(beforeC2);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual(first);
    expect(await directoryBytes(directory)).toEqual(afterFirst);

    const settledAt = new Date(7_000).toISOString();
    new RunLedger(directory).environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...fixture.receipt,
      settledAt,
    } satisfies RunEnvironmentPrefinishSettleRecord);
    new RunLedger(directory).finish({
      schemaVersion: 2,
      event: 'finish',
      trigger: fixture.binding.trigger,
      runId: fixture.binding.runId,
      jobId: fixture.binding.jobId,
      sessionId: fixture.binding.sessionId,
      scheduledFor: fixture.binding.scheduledFor,
      startedAt: fixture.binding.claimedAt,
      finishedAt: new Date(8_000).toISOString(),
      status: 'success',
      deliveryState: fixture.receipt.deliveryState,
      ...(fixture.receipt.deliveredAt === undefined ? {} : { deliveredAt: fixture.receipt.deliveredAt }),
      ...(fixture.receipt.deliveryError === undefined ? {} : { deliveryError: fixture.receipt.deliveryError }),
    } satisfies RunFinishRecord);
    const afterTechnicalClose = await directoryBytes(directory);
    expect(afterTechnicalClose).not.toEqual(afterFirst);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual(first);
    expect(await directoryBytes(directory)).toEqual(afterTechnicalClose);

    await fixture.dispose();
    const rebuilt = await realFactory(directory);
    const rebuiltResult = await rebuilt.createRunPort(fixture.binding);
    expect(rebuiltResult.status).toBe('accepted');
    if (rebuiltResult.status !== 'accepted') return;
    await expect(rebuiltResult.port.commitBusinessFinalization()).resolves.toEqual(first);
    expect(await directoryBytes(directory)).toEqual(afterTechnicalClose);
    await rebuiltResult.dispose();
  });

  it('rejects C2 when the exact prepared object has no B owner binding', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-missing-b-');
    const binding = await durableClaim(directory, 'manual', 'c2-missing-b');
    const objectId = 'c2-missing-b-object';
    prepareObject(directory, binding, objectId);
    const ledger = new RunLedger(directory);
    ledger.claimDeliveryAttempt({
      schemaVersion: 2,
      event: 'delivery-attempt-claim',
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      claimedAt: new Date(4_000).toISOString(),
      objectId,
    });
    const receipt: CronDeliveryReceipt = {
      objectId,
      jobId: binding.jobId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      scheduledFor: binding.scheduledFor,
      deliveryState: 'uncertain',
      deliveryError: 'missing B',
    };
    ledger.recordDeliveryReceipt({
      schemaVersion: 2,
      event: 'delivery-receipt',
      ...receipt,
      receiptAt: new Date(6_000).toISOString(),
    });
    const factory = await realFactory(directory);
    const created = await factory.createRunPort(binding);
    expect(created.status).toBe('accepted');
    if (created.status !== 'accepted') return;
    const before = await directoryBytes(directory);
    await expect(created.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'rejected',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await created.dispose();
  });

  it('rejects C2 when B and technical receipt exist but C1 is absent', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-missing-c1-');
    const fixture = await preparedReceiptFixture(directory, 'scheduled', 'c2-missing-c1', 'delivered');
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'rejected',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('fails closed when a real prefinish acknowledgement precedes C2', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-ack-before-');
    const fixture = await preparedReceiptFixture(directory, 'scheduled', 'c2-ack-before', 'failed');
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'accepted',
      value: { receipt: fixture.receipt },
    });
    new RunLedger(directory).environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...fixture.receipt,
      settledAt: new Date(7_000).toISOString(),
    } satisfies RunEnvironmentPrefinishSettleRecord);
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'failed',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('fails closed when acknowledgement and finish precede C2', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-finish-before-');
    const fixture = await preparedReceiptFixture(directory, 'manual', 'c2-finish-before', 'delivered');
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'accepted',
      value: { receipt: fixture.receipt },
    });
    new RunLedger(directory).environmentPrefinishSettled({
      schemaVersion: 2,
      event: 'environment-prefinish-settle',
      ...fixture.receipt,
      settledAt: new Date(7_000).toISOString(),
    } satisfies RunEnvironmentPrefinishSettleRecord);
    new RunLedger(directory).finish({
      schemaVersion: 2,
      event: 'finish',
      trigger: fixture.binding.trigger,
      runId: fixture.binding.runId,
      jobId: fixture.binding.jobId,
      sessionId: fixture.binding.sessionId,
      scheduledFor: fixture.binding.scheduledFor,
      startedAt: fixture.binding.claimedAt,
      finishedAt: new Date(8_000).toISOString(),
      status: 'success',
      deliveryState: fixture.receipt.deliveryState,
      deliveredAt: fixture.receipt.deliveredAt,
    } satisfies RunFinishRecord);
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'failed',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('fails C2 on the disposed exact port without writing a finalization fact', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-disposed-');
    const fixture = await preparedReceiptFixture(directory, 'manual', 'c2-disposed', 'uncertain');
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'accepted',
      value: { receipt: fixture.receipt },
    });
    await fixture.dispose();
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'failed',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
  });

  it('fails C2 after the durable receipt raw fact changes and never appends', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-receipt-corrupt-');
    const fixture = await preparedReceiptFixture(directory, 'scheduled', 'c2-receipt-corrupt', 'delivered');
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'accepted',
      value: { receipt: fixture.receipt },
    });
    const runsPath = join(directory, 'runs.jsonl');
    const lines = (await readFile(runsPath, 'utf8')).trim().split('\n');
    const receiptIndex = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event === 'delivery-receipt');
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    const raw = JSON.parse(lines[receiptIndex!]!) as Record<string, unknown>;
    lines[receiptIndex!] = JSON.stringify({ ...raw, receiptAt: new Date(7_000).toISOString() });
    await writeFile(runsPath, `${lines.join('\n')}\n`, 'utf8');
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'failed',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });

  it('fails C2 when the real B owner row is corrupted and preserves all bytes', async () => {
    const directory = await temporaryDirectory('todo05-bridge-c2-b-corrupt-');
    const fixture = await preparedReceiptFixture(directory, 'manual', 'c2-b-corrupt', 'uncertain');
    await expect(fixture.port.acceptDurableReceipt(fixture.receipt)).resolves.toEqual({
      status: 'accepted',
      value: { receipt: fixture.receipt },
    });
    const ownerPath = join(directory, 'run-delivery-meaning.jsonl');
    const lines = (await readFile(ownerPath, 'utf8')).trim().split('\n');
    const primaryIndex = lines.findIndex(line => (JSON.parse(line) as Record<string, unknown>).event === 'primary-run-content-object');
    expect(primaryIndex).toBeGreaterThanOrEqual(0);
    const raw = JSON.parse(lines[primaryIndex!]!) as Record<string, unknown>;
    lines[primaryIndex!] = JSON.stringify({ ...raw, objectId: `${fixture.receipt.objectId}-foreign` });
    await writeFile(ownerPath, `${lines.join('\n')}\n`, 'utf8');
    const before = await directoryBytes(directory);
    await expect(fixture.port.commitBusinessFinalization()).resolves.toEqual({
      status: 'failed',
      input: undefined,
    });
    expect(await directoryBytes(directory)).toEqual(before);
    await fixture.dispose();
  });
});
