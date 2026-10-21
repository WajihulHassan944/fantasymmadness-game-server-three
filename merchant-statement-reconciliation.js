'use strict';

/**
 * Merchant settlement reconciliation primitives.
 * This module deliberately accepts normalized statement records only.
 * Do not put raw PDFs, merchant credentials, card details or bank numbers in source control.
 * Callers must enforce admin authentication and encrypted private storage.
 */
const cents = value => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite numeric amount.');
  return Math.round(value * 100);
};
const money = value => Number((value / 100).toFixed(2));

function reconcileStatement(input) {
  if (!input || typeof input !== 'object') throw new Error('Statement is required.');
  const period = String(input.period || '');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error('Expected YYYY-MM statement period.');
  const gross = cents(input.grossSales);
  const refunds = cents(input.refunds);
  const adjustments = cents(input.adjustments);
  const cardFees = cents(input.cardFees);
  const otherFees = cents(input.otherFees);
  const net = cents(input.reportedNetFunding);
  if (gross < 0 || refunds < 0 || cardFees > 0 || otherFees > 0) throw new Error('Invalid amount signs.');
  const expected = gross - refunds + adjustments + cardFees + otherFees;
  const batches = Array.isArray(input.batches) ? input.batches : [];
  if (batches.length > 5000) throw new Error('Too many batches.');
  const batchNet = batches.reduce((sum, batch) => sum + cents(batch.funded), 0);
  const batchGross = batches.reduce((sum, batch) => sum + cents(batch.submitted), 0);
  return {
    period,
    grossSales: money(gross),
    refunds: money(refunds),
    adjustments: money(adjustments),
    cardFees: money(cardFees),
    otherFees: money(otherFees),
    reportedNetFunding: money(net),
    calculatedNetFunding: money(expected),
    reconciled: expected === net,
    difference: money(net - expected),
    batchCount: batches.length,
    batchGross: money(batchGross),
    batchNet: money(batchNet),
    batchesReconciled: batches.length ? batchNet === net && batchGross === gross : null,
    status: expected === net && (!batches.length || (batchNet === net && batchGross === gross))
      ? 'STATEMENT_ARITHMETIC_MATCH'
      : 'REVIEW_REQUIRED',
    bankDepositVerified: false,
    transactionIdsVerified: false,
  };
}

module.exports = { reconcileStatement };
