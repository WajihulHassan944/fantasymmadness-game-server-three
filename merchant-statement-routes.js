'use strict';
const { reconcileStatement } = require('./merchant-statement-reconciliation');

/**
 * Protected merchant-statement records. Register only on the existing authenticated
 * backend; never expose this collection through public revenue event endpoints.
 * Accept normalized totals, not PDFs, card data, account numbers or credentials.
 */
function registerMerchantStatementRoutes({ app, mongoose, verifyAdminToken }) {
  if (!app || !mongoose || !verifyAdminToken) throw new Error('Merchant statements require app, database and admin auth.');
  const BatchSchema = new mongoose.Schema({
    submitted: { type: Number, required: true },
    funded: { type: Number, required: true },
  }, { _id: false });
  const schema = new mongoose.Schema({
    period: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}$/ },
    grossSales: { type: Number, required: true },
    refunds: { type: Number, required: true },
    adjustments: { type: Number, required: true },
    cardFees: { type: Number, required: true },
    otherFees: { type: Number, required: true },
    reportedNetFunding: { type: Number, required: true },
    batches: { type: [BatchSchema], default: [] },
    sourceType: { type: String, enum: ['merchant_statement_manual'], default: 'merchant_statement_manual' },
    importedAt: { type: Date, default: Date.now },
  }, { timestamps: true, strict: true });
  const MerchantStatement = mongoose.models.MerchantStatement ||
    mongoose.model('MerchantStatement', schema, 'merchant_statements');

  app.get('/api/admin/revenue/merchant-statements', verifyAdminToken, async (_req, res) => {
    try {
      const rows = await MerchantStatement.find({}).sort({ period: -1 }).limit(36).lean();
      return res.json({ ok: true, statements: rows.map(row => ({
        ...reconcileStatement(row), sourceType: row.sourceType, importedAt: row.importedAt,
      })) });
    } catch (error) {
      console.error('Merchant statement list failed:', error);
      return res.status(500).json({ ok: false, message: 'Unable to load merchant statements.' });
    }
  });

  app.post('/api/admin/revenue/merchant-statements', verifyAdminToken, async (req, res) => {
    try {
      const body = req.body || {};
      const keys = ['period', 'grossSales', 'refunds', 'adjustments', 'cardFees', 'otherFees', 'reportedNetFunding', 'batches'];
      if (Object.keys(body).some(key => !keys.includes(key))) {
        return res.status(400).json({ ok: false, message: 'Unsupported statement field.' });
      }
      const normalized = Object.fromEntries(keys.filter(key => key in body).map(key => [key, body[key]]));
      const result = reconcileStatement(normalized);
      if (result.status !== 'STATEMENT_ARITHMETIC_MATCH') {
        return res.status(422).json({ ok: false, message: 'Statement totals do not reconcile.', reconciliation: result });
      }
      const existing = await MerchantStatement.exists({ period: result.period });
      if (existing) return res.status(409).json({ ok: false, message: 'A statement for this month already exists.' });
      await MerchantStatement.create(normalized);
      return res.status(201).json({ ok: true, reconciliation: result });
    } catch (error) {
      if (error && error.code === 11000) return res.status(409).json({ ok: false, message: 'Statement already exists.' });
      if (error instanceof Error && /Expected|Invalid|Statement|Too many/.test(error.message)) {
        return res.status(400).json({ ok: false, message: error.message });
      }
      console.error('Merchant statement save failed:', error);
      return res.status(500).json({ ok: false, message: 'Unable to save merchant statement.' });
    }
  });
  return { MerchantStatement };
}
module.exports = { registerMerchantStatementRoutes };
