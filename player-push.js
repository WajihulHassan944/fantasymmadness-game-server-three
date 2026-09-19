const webpush = require('web-push');

function registerPlayerPushRoutes({ app, mongoose, verifyToken, User }) {
  const schema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: { type: String, required: true }, auth: { type: String, required: true } },
    userAgent: String,
    lastSeenAt: Date,
  }, { timestamps: true });
  const PlayerPushSubscription = mongoose.models.PlayerPushSubscription
    || mongoose.model('PlayerPushSubscription', schema);

  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  const subject = process.env.VAPID_SUBJECT || 'mailto:contact@fantasymmadness.com';
  const configured = Boolean(publicKey && privateKey);
  if (configured) webpush.setVapidDetails(subject, publicKey, privateKey);

  const userId = (req) => req.user?.id || req.user?._id;

  app.get('/api/player/push/public-key', verifyToken, (req, res) => {
    res.json({ ok: true, configured, publicKey });
  });

  app.get('/api/player/push/status', verifyToken, async (req, res) => {
    const count = await PlayerPushSubscription.countDocuments({ userId: userId(req) });
    res.json({ ok: true, configured, subscribed: count > 0, deviceCount: count });
  });

  app.post('/api/player/push/subscribe', verifyToken, async (req, res) => {
    if (!configured) return res.status(503).json({ ok: false, message: 'Browser alerts are not configured yet.' });
    const { subscription } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ ok: false, message: 'Invalid browser notification subscription.' });
    }
    await PlayerPushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        userId: userId(req), endpoint: subscription.endpoint, keys: subscription.keys,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500), lastSeenAt: new Date(),
      },
      { upsert: true, new: true },
    );
    await User.updateOne({ _id: userId(req) }, { $set: { isNotificationsEnabled: true } });
    res.json({ ok: true, subscribed: true });
  });

  app.post('/api/player/push/unsubscribe', verifyToken, async (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) await PlayerPushSubscription.deleteOne({ userId: userId(req), endpoint });
    const remaining = await PlayerPushSubscription.countDocuments({ userId: userId(req) });
    if (!remaining) await User.updateOne({ _id: userId(req) }, { $set: { isNotificationsEnabled: false } });
    res.json({ ok: true, subscribed: remaining > 0, deviceCount: remaining });
  });

  app.post('/api/player/push/test', verifyToken, async (req, res) => {
    const result = await sendPlayerPush(userId(req), {
      title: 'Fantasy MMAdness alerts are on',
      body: 'Your browser is connected. Fight and account alerts can reach this device.',
      url: '/',
    });
    res.json({ ok: result.sent > 0, ...result });
  });

  async function sendPlayerPush(targetUserId, { title, body, url = '/' }) {
    if (!configured) return { sent: 0, failed: 0, skipped: true };
    const subscriptions = await PlayerPushSubscription.find({ userId: targetUserId }).lean();
    let sent = 0; let failed = 0;
    await Promise.all(subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys },
          JSON.stringify({ title, body, url }),
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        if ([404, 410].includes(error.statusCode)) {
          await PlayerPushSubscription.deleteOne({ endpoint: subscription.endpoint }).catch(() => null);
        }
      }
    }));
    return { sent, failed, skipped: false };
  }

  return { sendPlayerPush };
}

module.exports = { registerPlayerPushRoutes };
