'use strict';
// Read-only readiness audit of the existing application contract, no production mutations.
// These gates intentionally fail closed until authoritative adapters are identified and tested.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const revenue=fs.readFileSync(require.resolve('./revenue-analytics'),'utf8');
const merchant=require('./merchant-statement-reconciliation');
const paymentSourceVerified=false; // Existing public analytics endpoint is not a verified payment ledger.
const contestEntryVerified=false; // No authenticated atomic contest-entry adapter has been validated here.
const affiliateResolverVerified=false; // No actual deployed affiliate resolver has been exercised here.
assert.match(revenue,/app\.post\('\/api\/revenue\/events'/);
assert.match(revenue,/paid_entry/);
assert.equal(merchant.reconcileStatement({period:'2026-10',grossSales:5,refunds:0,adjustments:0,cardFees:0,otherFees:0,reportedNetFunding:5}).transactionIdsVerified,false);
const readiness={paymentSourceVerified,contestEntryVerified,affiliateResolverVerified,productionReady:paymentSourceVerified&&contestEntryVerified&&affiliateResolverVerified};
assert.equal(readiness.productionReady,false);
console.log('READINESS AUDIT',JSON.stringify(readiness));
console.log('BLOCKED: public revenue analytics cannot establish settled payment; transaction ledger, contest entry and live affiliate resolver require explicit integration verification.');
