// Web Push alerts for the admin back office, installed as a home-screen app.
// Isolated like swarm-phase2/fight-data-quality — existing signup flows and
// admin emails stay untouched; this only adds a phone push alongside them.
//
// Requires `web-push` (npm install web-push) and two env vars:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — generate once with:
//     npx web-push generate-vapid-keys
// Until both are set, routes respond but sendAdminPush() silently no-ops so
// signup flows never break because push isn't configured yet.
const webpush = require('web-push');

function registerAdminPushRoutes({ app, mongoose, verifyAdminToken }) {
  const subscriptionSchema = new mongoose.Schema({
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    adminEmail: String,
  }, { timestamps: true });
  const AdminPushSubscription = mongoose.models.AdminPushSubscription
    || mongoose.model('AdminPushSubscription', subscriptionSchema);

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
  const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:Fantasymmadness2@gmail.com';
  const configured = Boolean(vapidPublicKey && vapidPrivateKey);
  if (configured) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } else {
    console.warn('Admin push: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — admin push notifications are disabled until they are.');
  }

  app.get('/api/admin/push/public-key', verifyAdminToken, (req, res) => {
    res.json({ ok: true, publicKey: vapidPublicKey, configured });
  });

  app.post('/api/admin/push/subscribe', verifyAdminToken, async (req, res) => {
    const { subscription } = req.body || {};
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ ok: false, message: 'Invalid push subscription payload.' });
    }
    await AdminPushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      { endpoint: subscription.endpoint, keys: subscription.keys, adminEmail: req.admin?.email || '' },
      { upsert: true, new: true },
    );
    res.json({ ok: true });
  });

  app.post('/api/admin/push/unsubscribe', verifyAdminToken, async (req, res) => {
    const { endpoint } = req.body || {};
    if (endpoint) await AdminPushSubscription.deleteOne({ endpoint });
    res.json({ ok: true });
  });

  app.post('/api/admin/push/test', verifyAdminToken, async (req, res) => {
    const result = await sendAdminPush({
      title: 'Fantasy MMAdness admin',
      body: 'Test alert — push notifications are working.',
      url: '/administration',
    });
    res.json({ ok: true, ...result });
  });

  async function sendAdminPush({ title, body, url = '/administration' }) {
    if (!configured) return { sent: 0, failed: 0, skipped: true };
    const subs = await AdminPushSubscription.find().lean();
    let sent = 0;
    let failed = 0;
    await Promise.all(subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({ title, body, url }),
        );
        sent += 1;
      } catch (error) {
        failed += 1;
        // The browser dropped this subscription (uninstalled/expired) — stop retrying it.
        if (error.statusCode === 404 || error.statusCode === 410) {
          await AdminPushSubscription.deleteOne({ endpoint: sub.endpoint }).catch(() => null);
        }
      }
    }));
    return { sent, failed };
  }

  return { sendAdminPush };
}

module.exports = { registerAdminPushRoutes };
