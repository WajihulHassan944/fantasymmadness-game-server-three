'use strict';
const assert = require('node:assert/strict');
const { reconcileStatement } = require('./merchant-statement-reconciliation');

const result = reconcileStatement({
  period: '2026-09',
  grossSales: 8.94,
  refunds: 0,
  adjustments: 0,
  cardFees: -2.11,
  otherFees: -42.97,
  reportedNetFunding: -36.14,
  batches: [
    { submitted: 3.96, funded: 3.88 },
    { submitted: 0.99, funded: 0.97 },
    { submitted: 3.99, funded: 3.91 },
    { submitted: 0, funded: -44.90 },
  ],
});
assert.equal(result.reconciled, true);
assert.equal(result.batchesReconciled, true);
assert.equal(result.calculatedNetFunding, -36.14);
assert.equal(result.bankDepositVerified, false);
assert.equal(result.transactionIdsVerified, false);
assert.equal(result.status, 'STATEMENT_ARITHMETIC_MATCH');

const mismatch = reconcileStatement({period:'2026-09',grossSales:8.94,refunds:0,adjustments:0,cardFees:-2.11,otherFees:-42.97,reportedNetFunding:0});
assert.equal(mismatch.reconciled,false);
assert.equal(mismatch.status,'REVIEW_REQUIRED');
assert.throws(()=>reconcileStatement({period:'2026-09',grossSales:'8.94',refunds:0,adjustments:0,cardFees:0,otherFees:0,reportedNetFunding:8.94}));
console.log('Merchant statement reconciliation checks passed.');
