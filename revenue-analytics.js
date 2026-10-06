'use strict';

function registerRevenueAnalyticsRoutes({ app, mongoose, verifyAdminToken }) {
  if (!app || !mongoose || !verifyAdminToken) throw new Error('Revenue analytics requires app, mongoose and admin auth.');

  const schema = new mongoose.Schema({
    event: { type: String, required: true, index: true },
    sessionId: { type: String, default: '', index: true },
    fightId: { type: String, default: '', index: true },
    affiliateRef: { type: String, default: '', index: true },
    path: { type: String, default: '' },
    referrer: { type: String, default: '' },
    entryFee: { type: Number, default: 0 },
    signedIn: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  }, { timestamps: true, minimize: true });

  schema.index({ createdAt: -1, event: 1 });
  const RevenueEvent = mongoose.models.RevenueEvent || mongoose.model('RevenueEvent', schema, 'revenue_events');
  const allowed = new Set(['fight_view','play_click','prediction_start','first_prediction','prediction_complete','signup_gate','coin_checkout','paid_entry','free_entry','challenge_share','partner_lead']);

  app.post('/api/revenue/events', async (req, res) => {
    try {
      const body = req.body || {};
      const event = String(body.event || '').trim();
      if (!allowed.has(event)) return res.status(400).json({ ok: false, message: 'Unknown revenue event.' });
      const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
      await RevenueEvent.create({
        event,
        sessionId: String(body.sessionId || '').slice(0, 160),
        fightId: String(body.fightId || '').slice(0, 160),
        affiliateRef: String(body.affiliateRef || '').slice(0, 160),
        path: String(body.path || '').slice(0, 500),
        referrer: String(body.referrer || '').slice(0, 1000),
        entryFee: Math.max(0, Number(body.entryFee || 0)),
        signedIn: Boolean(body.signedIn),
        metadata,
      });
      return res.status(202).json({ ok: true });
    } catch (error) {
      console.error('Revenue event capture failed:', error);
      return res.status(500).json({ ok: false, message: 'Revenue event could not be recorded.' });
    }
  });

  app.get('/api/admin/revenue/summary', verifyAdminToken, async (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
      const since = new Date(Date.now() - days * 86400000);
      const [totals, uniqueSessions, recent, fightBreakdown] = await Promise.all([
        RevenueEvent.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$event', count: { $sum: 1 }, entryValue: { $sum: '$entryFee' } } }]),
        RevenueEvent.distinct('sessionId', { createdAt: { $gte: since }, sessionId: { $ne: '' } }),
        RevenueEvent.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(50).lean(),
        RevenueEvent.aggregate([
          { $match: { createdAt: { $gte: since }, fightId: { $ne: '' }, event: { $in: ['fight_view','play_click','prediction_start','first_prediction','prediction_complete','signup_gate','coin_checkout','paid_entry'] } } },
          { $group: {
            _id: '$fightId',
            views: { $sum: { $cond: [{ $eq: ['$event', 'fight_view'] }, 1, 0] } },
            visitorSessions: { $addToSet: { $cond: [{ $and: [{ $eq: ['$event', 'fight_view'] }, { $ne: ['$sessionId', ''] }] }, '$sessionId', '$REMOVE'] } },
            playClicks: { $sum: { $cond: [{ $eq: ['$event', 'play_click'] }, 1, 0] } },
            predictionStarts: { $sum: { $cond: [{ $eq: ['$event', 'prediction_start'] }, 1, 0] } },
            firstPredictions: { $sum: { $cond: [{ $eq: ['$event', 'first_prediction'] }, 1, 0] } },
            predictionCompletes: { $sum: { $cond: [{ $eq: ['$event', 'prediction_complete'] }, 1, 0] } },
            signupGates: { $sum: { $cond: [{ $eq: ['$event', 'signup_gate'] }, 1, 0] } },
            checkoutStarts: { $sum: { $cond: [{ $eq: ['$event', 'coin_checkout'] }, 1, 0] } },
            paidEntries: { $sum: { $cond: [{ $eq: ['$event', 'paid_entry'] }, 1, 0] } },
            fmCoinsCommitted: { $sum: { $cond: [{ $eq: ['$event', 'paid_entry'] }, '$entryFee', 0] } },
            fightName: { $last: '$metadata.fightName' },
          } },
          { $sort: { views: -1, playClicks: -1, predictionStarts: -1 } },
          { $limit: 100 },
        ]),
      ]);
      // Older analytics events may only contain fightId. Hydrate the fight
      // name from the real Match record so the admin never has to decipher IDs.
      const fightIds = fightBreakdown.map(row => String(row._id || '')).filter(Boolean);
      const Match = mongoose.models.Match;
      const Shadow = mongoose.models.Shadow || mongoose.models.ShadowFight || mongoose.models.ShadowMatch;
      let fightNamesById = {};
      if (fightIds.length) {
        const objectIds = fightIds.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));
        const projection = '_id matchName title matchFighterA matchFighterB fighterAName fighterBName matchDate date matchCategory category';
        const [matches, shadows] = await Promise.all([
          Match && objectIds.length ? Match.find({ _id: { $in: objectIds } }).select(projection).lean() : [],
          Shadow && objectIds.length ? Shadow.find({ _id: { $in: objectIds } }).select(projection).lean() : [],
        ]);
        fightNamesById = Object.fromEntries([...matches, ...shadows].map(match => {
          const a = String(match.matchFighterA || match.fighterAName || '').trim();
          const b = String(match.matchFighterB || match.fighterBName || '').trim();
          const name = String(match.matchName || match.title || '').trim() || (a && b ? `${a} vs ${b}` : '');
          return [String(match._id), {
            fightName: name,
            matchDate: match.matchDate || match.date || null,
            category: match.matchCategory || match.category || '',
          }];
        }));
      }

      const byEvent = Object.fromEntries(totals.map(row => [row._id, { count: row.count, entryValue: row.entryValue || 0 }]));
      const count = key => Number(byEvent[key]?.count || 0);
      const rate = (n, d) => d ? Number(((n / d) * 100).toFixed(1)) : 0;
      return res.json({
        ok: true, days, uniqueSessions: uniqueSessions.length, byEvent,
        funnel: {
          viewToPlay: rate(count('play_click'), count('fight_view')),
          playToPrediction: rate(count('prediction_start'), count('play_click')),
          predictionToPaid: rate(count('paid_entry'), count('prediction_start')),
          challengeRate: rate(count('challenge_share'), count('paid_entry') + count('free_entry')),
        },
        fmCoinsCommitted: Number(byEvent.paid_entry?.entryValue || 0),
        fights: fightBreakdown.map(row => ({
          fightId: row._id,
          fightName: String(row.fightName || fightNamesById[String(row._id)]?.fightName || ''),
          matchDate: fightNamesById[String(row._id)]?.matchDate || null,
          category: String(fightNamesById[String(row._id)]?.category || ''),
          views: Number(row.views || 0),
          uniqueVisitors: Array.isArray(row.visitorSessions) ? row.visitorSessions.length : 0,
          playClicks: Number(row.playClicks || 0),
          predictionStarts: Number(row.predictionStarts || 0),
          firstPredictions: Number(row.firstPredictions || 0),
          predictionCompletes: Number(row.predictionCompletes || 0),
          signupGates: Number(row.signupGates || 0),
          checkoutStarts: Number(row.checkoutStarts || 0),
          paidEntries: Number(row.paidEntries || 0),
          conversionRate: row.views ? Number(((Number(row.paidEntries || 0) / row.views) * 100).toFixed(1)) : 0,
          fmCoinsCommitted: Number(row.fmCoinsCommitted || 0),
        })),
        recent,
      });
    } catch (error) {
      console.error('Revenue summary failed:', error);
      return res.status(500).json({ ok: false, message: 'Revenue summary could not be loaded.' });
    }
  });

  return { RevenueEvent };
}

module.exports = { registerRevenueAnalyticsRoutes };
