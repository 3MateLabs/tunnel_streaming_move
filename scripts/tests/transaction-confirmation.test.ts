import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmTransactionWorkflow } from '../src/utils.js';

type Tx = {
  digest: string;
  status: { success: boolean; error?: { message: string } };
  effects?: { changedObjects: unknown[] };
  objectTypes?: Record<string, string>;
};

type Result =
  | { $kind: 'Transaction'; Transaction: Tx; FailedTransaction?: never }
  | { $kind: 'FailedTransaction'; Transaction?: never; FailedTransaction: Tx };

const success = (digest: string, extra: Partial<Tx> = {}): Result => ({
  $kind: 'Transaction',
  Transaction: { digest, status: { success: true }, ...extra },
});

const failure = (digest: string, message: string): Result => ({
  $kind: 'FailedTransaction',
  FailedTransaction: {
    digest,
    status: { success: false, error: { message } },
  },
});

test('failed submission is rejected without waiting', async () => {
  let waits = 0;
  const client = {
    signAndExecuteTransaction: async () => failure('submitted', 'submission failed'),
    core: {
      waitForTransaction: async () => {
        waits += 1;
        return success('submitted');
      },
    },
  };

  await assert.rejects(
    confirmTransactionWorkflow<Tx, Tx>(
      () => client.signAndExecuteTransaction(),
      () => client.core.waitForTransaction(),
    ),
    /submission failed/,
  );
  assert.equal(waits, 0);
});

test('failed confirmed transaction is rejected', async () => {
  const client = {
    signAndExecuteTransaction: async () => success('submitted'),
    core: {
      waitForTransaction: async () => failure('submitted', 'confirmation failed'),
    },
  };

  await assert.rejects(
    confirmTransactionWorkflow<Tx, Tx>(
      () => client.signAndExecuteTransaction(),
      () => client.core.waitForTransaction(),
    ),
    /confirmation failed/,
  );
});

test('confirmation digest must equal submitted digest', async () => {
  const client = {
    signAndExecuteTransaction: async () => success('submitted'),
    core: {
      waitForTransaction: async () => success('different'),
    },
  };

  await assert.rejects(
    confirmTransactionWorkflow<Tx, Tx>(
      () => client.signAndExecuteTransaction(),
      () => client.core.waitForTransaction(),
    ),
    /digest mismatch/i,
  );
});

test('success is exposed only after confirmation and returns confirmed fields', async () => {
  const order: string[] = [];
  const client = {
    signAndExecuteTransaction: async () => {
      order.push('submit');
      return success('same');
    },
    core: {
      waitForTransaction: async () => {
        order.push('confirm');
        return success('same', {
          effects: { changedObjects: [] },
          objectTypes: {},
        });
      },
    },
  };

  const confirmed = await confirmTransactionWorkflow<Tx, Tx>(
      () => client.signAndExecuteTransaction(),
      () => client.core.waitForTransaction(),
    );
  order.push('success');

  assert.deepEqual(order, ['submit', 'confirm', 'success']);
  assert.equal(confirmed.digest, 'same');
  assert.deepEqual(confirmed.effects?.changedObjects, []);
});
