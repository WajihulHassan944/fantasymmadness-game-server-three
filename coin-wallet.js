'use strict';

// FM COINS wallet: the ONLY way balances change.
//
// Every change to a player's, affiliate's or house account's FM COINS goes through
// applyCoinChange(). Each change:
//   * is a single atomic database update (add/subtract computed inside MongoDB), so two
//     simultaneous changes can never overwrite each other;
//   * refuses to take a balance below zero unless the caller explicitly allows it;
//   * carries a unique transactionId, so a double click, network retry or repeated
//     request returns the earlier result instead of moving coins twice;
//   * writes its coin-history record (amount, reason, transaction ID, date, resulting
//     balance) inside the SAME database transaction as the balance change, so a balance
//     never changes without its record, or the record without the balance.
//
// A safety net (installCoinWriteGuards) also stops any other code from writing a
// balance the old read-then-save way. Existing balances are never recalculated.

const TOKEN_FIELD = 'tokens';

class CoinError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'CoinError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Same rule the site already uses to read a balance (normalizeWalletTokenNumber):
// commas ignored, invalid or negative values count as 0, fractions rounded down.
const balanceExpr = (field = `$${TOKEN_FIELD}`) => ({
  $let: {
    vars: {
      n: {
        $convert: {
          input: { $replaceAll: { input: { $trim: { input: { $toString: { $ifNull: [field, '0'] } } } }, find: ',', replacement: '' } },
          to: 'double', onError: 0, onNull: 0,
        },
      },
    },
    in: { $toLong: { $floor: { $max: [0, '$$n'] } } },
  },
});

// Older MongoDB drivers (the one bundled with Mongoose 7) wrap findOneAndUpdate
// results as { value, ok, lastErrorObject }; newer ones return the document itself.
const unwrapDocument = (result) => {
  if (result && typeof result === 'object' && 'lastErrorObject' in result && 'value' in result) return result.value;
  if (result && typeof result === 'object' && 'ok' in result && 'value' in result && Object.keys(result).length <= 4) return result.value;
  return result;
};

const readBalance = (value) => {
  const parsed = Number(typeof value === 'string' ? value.trim().replace(/,/g, '') : value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

function createCoinWallet({ mongoose, getLedgerCollection, models }) {
  const accountCollection = (account) => {
    const modelName = models[account];
    const model = modelName && mongoose.models[modelName];
    if (!model) throw new CoinError('UNKNOWN_ACCOUNT_TYPE', `Unknown coin account type: ${account}`);
    return model.collection;
  };
  const toId = (id) => {
    if (id && typeof id === 'object' && id._bsontype === 'ObjectId') return id;
    const text = String(id || '');
    if (!mongoose.Types.ObjectId.isValid(text)) throw new CoinError('ACCOUNT_NOT_FOUND', 'Account not found.');
    return new mongoose.Types.ObjectId(text);
  };
  // Mongoose sessions wrap the driver session; the native collection needs the latter.
  const driverSession = (session) => (session && session.session ? session.session : session) || undefined;

  async function applyInSession(opts, session) {
    const { account = 'user', id, delta, reason, transactionId, reference = '', meta = {}, allowNegative = false, history = true, extraSet = null, extraFilter = null, sourceType = 'match' } = opts;
    const ledger = getLedgerCollection();
    const s = driverSession(session);
    const previous = await ledger.findOne({ idempotencyKey: transactionId }, { session: s });
    if (previous) {
      return { applied: false, duplicate: true, transactionId, balanceBefore: previous.balanceBefore, balanceAfter: previous.balanceAfter, amount: previous.amount };
    }
    const _id = toId(id);
    const collection = accountCollection(account);
    const filter = { _id, ...(extraFilter || {}) };
    if (delta < 0 && !allowNegative) filter.$expr = { $gte: [{ $add: [balanceExpr(), delta] }, 0] };
    const updated = unwrapDocument(await collection.findOneAndUpdate(
      filter,
      [{ $set: { [TOKEN_FIELD]: { $toString: { $add: [balanceExpr(), delta] } }, ...(extraSet || {}) } }],
      { session: s, returnDocument: 'after', projection: { [TOKEN_FIELD]: 1 } },
    ));
    if (!updated) {
      const exists = await collection.findOne({ _id }, { session: s, projection: { [TOKEN_FIELD]: 1 } });
      if (!exists) throw new CoinError('ACCOUNT_NOT_FOUND', 'Account not found.');
      if (extraFilter) throw new CoinError('CONDITION_NOT_MET', 'This change no longer applies.', { balance: readBalance(exists[TOKEN_FIELD]) });
      throw new CoinError('INSUFFICIENT_FM_COINS', 'Not enough FM COINS.', { balance: readBalance(exists[TOKEN_FIELD]), required: -delta });
    }
    const balanceAfter = readBalance(updated[TOKEN_FIELD]);
    const balanceBefore = balanceAfter - delta;
    if (history) {
      const now = new Date();
      await ledger.insertOne({
        userId: _id,
        matchId: String(reference || reason).slice(0, 120),
        sourceType: sourceType === 'shadow' ? 'shadow' : 'match',
        type: delta < 0 ? 'FIGHT_ENTRY' : 'FIGHT_ENTRY_REFUND',
        amount: delta,
        balanceBefore,
        balanceAfter,
        idempotencyKey: transactionId,
        metadata: { reason, account, transactionId, ...meta },
        createdAt: now,
        updatedAt: now,
      }, { session: s });
    }
    return { applied: true, transactionId, balanceBefore, balanceAfter, amount: delta };
  }

  const isTransactionUnsupported = (error) => /Transaction numbers are only allowed|replica set|transactions are not supported/i.test(String(error && error.message || ''));

  // opts: { account: 'user'|'affiliate'|'house', id, delta (integer, + adds, - removes),
  //         reason, transactionId (unique), reference, meta, allowNegative, history,
  //         session (to join a caller's transaction), extraSet / extraFilter (optional
  //         fields changed in the same atomic update, e.g. lastDailyRewardAt) }
  async function applyCoinChange(opts) {
    const delta = Number(opts.delta);
    if (!Number.isInteger(delta)) throw new CoinError('INVALID_AMOUNT', 'FM COINS amounts must be whole numbers.');
    const transactionId = String(opts.transactionId || '').trim();
    if (!transactionId) throw new CoinError('TRANSACTION_ID_REQUIRED', 'A transaction ID is required for every FM COINS change.');
    if (!opts.reason) throw new CoinError('REASON_REQUIRED', 'A reason is required for every FM COINS change.');
    const normalized = { ...opts, delta, transactionId: transactionId.slice(0, 300) };
    if (delta === 0 && !opts.extraSet) return { applied: false, noChange: true, transactionId: normalized.transactionId };

    if (opts.session) return applyInSession(normalized, opts.session);

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await applyInSession(normalized, session); });
      return result;
    } catch (error) {
      if (error && error.code === 11000 && /idempotencyKey/.test(String(error.message || ''))) {
        const previous = await getLedgerCollection().findOne({ idempotencyKey: normalized.transactionId });
        return { applied: false, duplicate: true, transactionId: normalized.transactionId, balanceBefore: previous?.balanceBefore, balanceAfter: previous?.balanceAfter, amount: previous?.amount };
      }
      if (isTransactionUnsupported(error)) {
        if (process.env.NODE_ENV === 'production') {
          console.error('FATAL DATA RISK: FM COINS change attempted against a non-transactional MongoDB.');
          throw new CoinError('DATABASE_NOT_TRANSACTIONAL', 'FM COINS changes are temporarily unavailable.');
        }
        if (String(process.env.FIGHT_ENTRY_ALLOW_NON_TRANSACTIONAL || '').toLowerCase() === 'true') return applyInSession(normalized, null);
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  // Runs several coin changes (and any other writes) as ONE all-or-nothing transaction.
  async function runCoinTransaction(work) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await work(session); });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // Raises a balance to `target` only if it is lower (membership plan allotments).
  // Never lowers a balance. Atomic, recorded, and once per transactionId.
  async function topUpCoins({ account = 'user', id, target, reason, transactionId, reference = '', meta = {}, session = null }) {
    const goal = Number(target);
    if (!Number.isInteger(goal) || goal < 0) throw new CoinError('INVALID_AMOUNT', 'Top-up target must be a whole number.');
    if (!transactionId || !reason) throw new CoinError('TRANSACTION_ID_REQUIRED', 'Transaction ID and reason are required.');
    const work = async (s) => {
      const ledger = getLedgerCollection();
      const ds = driverSession(s);
      const previous = await ledger.findOne({ idempotencyKey: transactionId }, { session: ds });
      if (previous) return { applied: false, duplicate: true, transactionId, balanceBefore: previous.balanceBefore, balanceAfter: previous.balanceAfter };
      const _id = toId(id);
      const before = unwrapDocument(await accountCollection(account).findOneAndUpdate(
        { _id, $expr: { $lt: [balanceExpr(), goal] } },
        [{ $set: { [TOKEN_FIELD]: String(goal) } }],
        { session: ds, returnDocument: 'before', projection: { [TOKEN_FIELD]: 1 } },
      ));
      if (!before) return { applied: false, noChange: true, transactionId };
      const balanceBefore = readBalance(before[TOKEN_FIELD]);
      const now = new Date();
      await ledger.insertOne({
        userId: _id, matchId: String(reference || reason).slice(0, 120), sourceType: 'match', type: 'FIGHT_ENTRY_REFUND',
        amount: goal - balanceBefore, balanceBefore, balanceAfter: goal, idempotencyKey: transactionId,
        metadata: { reason, account, transactionId, topUpTo: goal, ...meta }, createdAt: now, updatedAt: now,
      }, { session: ds });
      return { applied: true, transactionId, balanceBefore, balanceAfter: goal, amount: goal - balanceBefore };
    };
    if (session) return work(session);
    try { return await runCoinTransaction(work); } catch (error) {
      if (error && error.code === 11000) return { applied: false, duplicate: true, transactionId };
      throw error;
    }
  }

  return { applyCoinChange, runCoinTransaction, topUpCoins, readBalance, CoinError };
}

// Safety net: any code path that tries to write a balance directly (document save or
// query update) is stopped, so a stale balance can never be written back. Coin changes
// go through applyCoinChange, which writes with the native driver and is not affected.
// Brand-new accounts may be created with their opening balance.
function installCoinWriteGuards(schema, label) {
  const blocked = (what) => new CoinError('UNSAFE_COIN_WRITE', `${label} FM COINS must be changed through the coin wallet (${what}).`);
  schema.pre('save', function guardCoinSave(next) {
    if (!this.isNew && this.isModified(TOKEN_FIELD) && !(this.$locals && this.$locals.allowCoinWrite)) return next(blocked('save'));
    return next();
  });
  const touchesTokens = (update) => {
    if (!update) return false;
    if (Array.isArray(update)) return update.some((stage) => stage && typeof stage === 'object' && Object.values(stage).some((v) => v && typeof v === 'object' && TOKEN_FIELD in v));
    if (TOKEN_FIELD in update) return true;
    return Object.keys(update).some((op) => op.startsWith('$') && update[op] && typeof update[op] === 'object' && TOKEN_FIELD in update[op]);
  };
  for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
    schema.pre(op, function guardCoinUpdate(next) {
      if (touchesTokens(this.getUpdate()) && !this.getOptions().allowCoinWrite) return next(blocked(op));
      return next();
    });
  }
}

module.exports = { createCoinWallet, installCoinWriteGuards, CoinError, readBalance, balanceExpr };
