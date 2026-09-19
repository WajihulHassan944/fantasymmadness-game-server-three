Warning: truncated output (original token count: 275207)
... 52250 bytes omitted ...

const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const moment = require('moment');
const Parser = require('rss-parser');
const parser = new Parser();
const app = express();

// Production-safe defaults. These are intentionally conservative and configurable
// so existing routes keep their contracts while oversized requests fail fast.
app.disable('x-powered-by');
app.set('trust proxy', 1);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || process.env.REQUEST_BODY_LIMIT || '10mb';
const URLENCODED_BODY_LIMIT = process.env.URLENCODED_BODY_LIMIT || JSON_BODY_LIMIT;
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
});

const { ObjectId } = require('mongodb');
const Pusher = require('pusher');
const cors = require("cors");
const FormData = require('form-data');
const multer = require('multer');
const bcrypt = require('bcrypt');
const crypto = require('crypto'); // For generating the verification token
const nodemailer = require('nodemailer'); // For sending emails
const SUPPORT_EMAIL = String(process.env.SUPPORT_EMAIL || 'contact@fantasymmadness.com').trim().toLowerCase();
const ADMIN_ALERT_EMAILS = String(process.env.ADMIN_ALERT_EMAILS || SUPPORT_EMAIL).trim();
const SMTP_ACCOUNT_EMAIL = String(process.env.SMTP_USER || 'Fantasymmadness2@gmail.com').trim();
// Most SMTP providers reject an unverified From domain. Use the authenticated
// mailbox by default; SMTP_FROM remains available for a verified domain/alias.
const FMM_MAIL_FROM = String(process.env.SMTP_FROM || `Fantasy MMAdness <${SMTP_ACCOUNT_EMAIL}>`).trim();
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const accessToken = process.env.ZENPAYMENTS_ACCESS_TOKEN;
const terminalId = process.env.ZENPAYMENTS_TERMINAL_ID;
const { promisify } = require('util');

const axios = require('axios');
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const { registerSwarmPhase2Routes } = require('./swarm-phase2');
const { registerSeoPerformancePhase2Routes } = require('./seo-performance-phase2');
const { registerFightDataQualityRoutes } = require('./fight-data-quality');
const { registerAdminPushRoutes } = require('./admin-push');
// Populated once registerAdminPushRoutes runs below; declared early so the
// signup handlers further up the file can close over it safely (they only
// call it at request time, long after the server has finished booting).
let sendAdminPush = async () => ({ sent: 0, failed: 0, skipped: true });
const { registerUfcEventDiscovery, GOOGLE_NEWS_UFC_RSS_FEED_URL, _private: ufcEventDiscoveryPrivate } = require('./ufc-event-discovery');
const {
  FM_COIN_PRODUCTS,
  FM_PLUS_PLANS,
  buildScoutingPayload,
  buildTemplateScoutingReport,
  derivePredictionPickSide,
  extractCalendarDateKey,
  normalizeCalendarDateInput,
  resolveFmPlusPlan,
  resolveCoinCart,
  timingSafeSignatureMatch,
  validateScoutingReportNumbers,
} = require('./client-feedback-core');

const ALGORITHM = 'aes-256-cbc'; // AES algorithm
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 bytes
const IV_LENGTH = 16; // For AES, this is always 16
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Example of generating a random IV for encryption
const iv = crypto.randomBytes(IV_LENGTH);

app.use((req, res, next) => {
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => res.setHeader(name, value));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }
  next();
});

app.use(express.json({
  limit: JSON_BODY_LIMIT,
  verify: (req, res, buf) => {
    req.rawBody = buf ? buf.toString('utf8') : '';
  },
}));

// CORS configuration
const defaultAllowedOrigins = [
  'https://fantasymmadness-version2.vercel.app', // Legacy production
  'https://fmm-ver2.vercel.app', // Current production
  'http://localhost:3000',
  'https://www.fantasymmadness.com',
  'https://fantasymmadness.com', // Add this line
  'https://www.betcombatsports.com',
  'https://betcombatsports.com',
  'https://www.betfantasymadness.com',
   'https://betfantasymadness.com',
   'https://www.betfmma.com',
   'https://betfmma.com',
   'https://combatdoorgym.com',
   'https://www.combatdoorgym.com',
   'https://z7neckbrace.online',
   'https://www.z7neckbrace.online',
   'https://suckapunch.online',
   'https://www.suckapunch.online'
];

const allowedOrigins = [
  ...new Set([
    ...defaultAllowedOrigins,
    ...String(process.env.CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]),
];

const isFantasyFrontendPreview = (origin = '') =>
  /^https:\/\/fmm-ver2(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(origin);

app.use(cors({
  origin: function (origin, callback) {
    if (allowedOrigins.includes(origin) || isFantasyFrontendPreview(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow credentials (cookies, headers, etc.)
}));

// --------------------------------------------------------------------------
// BOOT CONFIGURATION GUARD
// Every auth check in this file rests on these secrets. Missing or placeholder
// values used to fail silently at request time — jwt.verify(token, undefined)
// just throws, so every protected route returned 403 and the cause was invisible
// in the logs. Fail loudly at boot instead, before traffic arrives.
// --------------------------------------------------------------------------
(() => {
  const REQUIRED = ['MONGODB_URI', 'JWT_SECRET', 'JWT_SECRET_ADMIN'];
  const WEAK = new Set(['secret', 'changeme', 'change-me', 'jwtsecret', 'test', 'dev', 'password', 'fantasymmadness']);
  const missing = REQUIRED.filter((name) => !String(process.env[name] || '').trim());
  const weak = ['JWT_SECRET', 'JWT_SECRET_ADMIN'].filter((name) => {
    const value = String(process.env[name] || '').trim();
    return value && (value.length < 32 || WEAK.has(value.toLowerCase()));
  });

  if (missing.length) {
    console.error(`FATAL: missing required environment variables: ${missing.join(', ')}`);
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }
  if (weak.length) {
    const message = `${weak.join(', ')} ${weak.length > 1 ? 'are' : 'is'} too weak — use 32+ random characters.`;
    if (process.env.NODE_ENV === 'production') {
      console.error(`FATAL: ${message}`);
      process.exit(1);
    }
    console.warn(`WARNING: ${message}`);
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET === process.env.JWT_SECRET_ADMIN) {
    console.error('FATAL: JWT_SECRET and JWT_SECRET_ADMIN must differ — a player token would otherwise pass admin checks.');
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }

  // Non-fatal, but each one silently disables a feature in production.
  [
    ['CRON_SECRET', 'scheduled jobs will return 503'],
    ['AUTHORIZE_NET_SIGNATURE_KEY', 'payment webhooks will be rejected'],
    ['SMTP_PASS', 'no email will be delivered'],
  ].forEach(([name, effect]) => {
    if (!String(process.env[name] || '').trim()) console.warn(`WARNING: ${name} is not set — ${effect}.`);
  });
})();

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// --------------------------------------------------------------------------
// REPLICA SET DETECTION
//
// Entry charging, refunds, prize settlement, coin purchases and challenge
// escrow all run inside MongoDB transactions, and transactions do not exist on
// a standalone mongod. Standalone does not warn — it throws mid-sequence, which
// is exactly the wrong moment because money may already have moved.
//
// So we ask the server what it is, once, at boot: a replica set reports a
// setName in its hello response; a standalone does not.
// --------------------------------------------------------------------------
const databaseCapability = {
  checked: false,
  isReplicaSet: false,
  transactionsSupported: false,
  topology: 'unknown',
  detail: '',
};

const detectDatabaseCapability = async () => {
  try {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      databaseCapability.checked = false;
      databaseCapability.topology = 'connecting';
      databaseCapability.detail = 'MongoDB connection is not ready yet.';
      return false;
    }
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const setName = hello?.setName || '';
    const isMongos = hello?.msg === 'isdbgrid';
    databaseCapability.checked = true;
    databaseCapability.isReplicaSet = Boolean(setName);
    // Sharded clusters support transactions from MongoDB 4.2 onward.
    databaseCapability.transactionsSupported = Boolean(setName) || isMongos;
    databaseCapability.topology = setName ? 'replicaSet' : isMongos ? 'sharded' : 'standalone';
    databaseCapability.detail = setName ? `replica set "${setName}"` : databaseCapability.topology;
  } catch (error) {
    // A cold serverless request can arrive before Mongoose finishes opening.
    // Do not permanently cache that transient state as "standalone".
    databaseCapability.checked = false;
    databaseCapability.topology = mongoose.connection.readyState === 1 ? 'unknown' : 'connecting';
    databaseCapability.detail = `could not determine topology: ${error.message}`;
    console.error('WARNING: could not determine MongoDB topology.', error.message);
    return false;
  }

  if (databaseCapability.transactionsSupported) {
    console.log(`MongoDB topology OK — ${databaseCapability.detail}. Transactions available.`);
    return true;
  }

  const message = [
    'MongoDB is running as a STANDALONE server, which does not support transactions.',
    'Paid fight entries, refunds, prize settlement, coin purchases and challenge',
    'escrow will all FAIL until this is a replica set (Atlas M10+ is one by default;',
    'a self-hosted single node is not — start it with --replSet and run rs.initiate()).',
  ].join(' ');

  if (process.env.NODE_ENV === 'production') {
    console.error(`FATAL: ${message}`);
    process.exit(1);
  }
  console.warn(`WARNING: ${message}`);
  return false;
};

const ensureDatabaseCapability = async () => {
  if (mongoose.connection.readyState !== 1) {
    await Promise.race([
      mongoose.connection.asPromise(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB connection timed out.')), 8000)),
    ]).catch((error) => {
      databaseCapability.checked = false;
      databaseCapability.topology = 'connecting';
      databaseCapability.detail = error.message;
    });
  }
  if (!databaseCapability.checked && mongoose.connection.readyState === 1) await detectDatabaseCapability();
  return databaseCapability;
};

mongoose.connection.once('open', () => { detectDatabaseCapability(); });

// Middleware
app.use(bodyParser.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));
app.use(bodyParser.json({ limit: JSON_BODY_LIMIT }));

// Session lifetime. 1h was far too short for a fight-night app: a player who
// signed in early got 401s the moment they tried to enter a fight later, right
// at the money step. Admin tokens stay short (see JWT_SECRET_ADMIN usage).
const SESSION_TOKEN_TTL = process.env.SESSION_TOKEN_TTL || '30d';
const SESSION_COOKIE_MAX_AGE = Number(process.env.SESSION_COOKIE_MAX_AGE || 30 * 24 * 60 * 60 * 1000);

// Defined here (not further down) because routes above the old definition
// now use it; `const` is not hoisted, so a later definition would throw
// "Cannot access 'verifyToken' before initialization" at boot.
const verifyToken = (req, res, next) => {
  // NEVER log req.headers here. It printed a live bearer token on every
  // authenticated request, so anyone with log access could resume a player's
  // session straight out of the log stream.
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Extract token from Bearer scheme

  if (token == null) return res.sendStatus(401); // No token, unauthorized

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Token invalid, forbidden

    // Owner "view as" sessions are strictly read-only. Checked here, at the one
    // place every authenticated route passes through, so no individual route can
    // forget it — a preview token must never be able to spend, enter or change
    // anything belonging to the person being viewed.
    if (user?.scope === 'owner-preview' && req.method !== 'GET') {
      return res.status(403).json({
        message: 'This is a read-only preview session. Sign in as the account to make changes.',
        code: 'PREVIEW_READ_ONLY',
      });
    }

    req.user = user; // Attach user info to request object
    next();
  });
};

// Admin auth. Defined here (not further down the file) because ~20 admin routes
// registered above the old definition referenced it — and `const` is not
// hoisted, so the server crashed at boot with a ReferenceError.
const verifyAdminToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({
      message: 'Admin authentication is required.',
      code: 'ADMIN_AUTH_REQUIRED',
      shouldLogin: true,
    });
  }

  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET_ADMIN);
    return next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid or expired admin token.',
      code: 'ADMIN_TOKEN_INVALID_OR_EXPIRED',
      shouldLogin: true,
    });
  }
};


// --------------------------------------------------------------------------
// NoSQL INJECTION GUARD
// Without this, POST /login with {"email":{"$ne":null}} matches the first user
// in the collection and hands back a valid session for an account the caller
// does not own. Strips Mongo operator keys from every request payload.
// --------------------------------------------------------------------------
function stripMongoOperators(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => stripMongoOperators(item, depth + 1));
    return;
  }
  Object.keys(value).forEach((key) => {
    if (key.startsWith('$') || key.includes('.')) {
      delete value[key];
      return;
    }
    stripMongoOperators(value[key], depth + 1);
  });
}

app.use((req, _res, next) => {
  stripMongoOperators(req.body);
  stripMongoOperators(req.query);
  stripMongoOperators(req.params);
  next();
});

// --------------------------------------------------------------------------
// CRON AUTH
// Scheduled jobs were plain public GETs: anyone could roll fights over,
// re-run settlement sweeps, or blast affiliate mail on demand.
// --------------------------------------------------------------------------
const verifyCronSecret = (req, res, next) => {
  const configured = String(process.env.CRON_SECRET || '').trim();
  if (!configured) {
    return res.status(503).json({ ok: false, message: 'Scheduled jobs are disabled until CRON_SECRET is configured.' });
  }
  const supplied = String(
    req.headers['x-cron-secret'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''),
  ).trim();
  const a = Buffer.from(configured);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // Fall back to a valid admin token so an operator can trigger a job by hand.
    const adminToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    try {
      if (adminToken && process.env.JWT_SECRET_ADMIN) {
        req.admin = jwt.verify(adminToken, process.env.JWT_SECRET_ADMIN);
        return next();
      }
    } catch (_error) { /* fall through to 401 */ }
    return res.status(401).json({ ok: false, message: 'Unauthorized.' });
  }
  return next();
};

// --------------------------------------------------------------------------
// TOKEN SCOPES
// Player, affiliate and sponsor sessions are all signed with JWT_SECRET and used
// to carry only { id }. Nothing was exploitable because ids never collide across
// collections — but that was a coincidence, not a rule. Every token now declares
// its audience, and money routes assert it.
//
// Tokens issued before this change have no scope claim. They stay valid until
// they expire (30 days) rather than logging everyone out mid fight night, so
// requireScope() treats a missing scope as legacy-and-allowed and only rejects a
// scope that is present and wrong.
// --------------------------------------------------------------------------
const TOKEN_SCOPES = Object.freeze({ PLAYER: 'player', AFFILIATE: 'affiliate', SPONSOR: 'sponsor' });

const requireScope = (...allowed) => (req, res, next) => {
  const scope = String(req.user?.scope || '').trim();
  if (!scope) return next(); // legacy token, pre-scope
  // A read-only owner preview may read any role's screens; verifyToken has
  // already guaranteed the request is a GET.
  if (scope === 'owner-preview') return next();
  if (allowed.includes(scope)) return next();
  return res.status(403).json({
    message: 'This account type cannot use that action.',
    code: 'WRONG_TOKEN_SCOPE',
    expected: allowed,
  });
};

// Ownership guard: the caller must be acting on their own record. Admin tokens
// pass so back-office screens keep working.
const requireSelf = (getTargetId) => (req, res, next) => {
  const tokenId = String(req.user?.id || req.user?._id || '');
  const targetId = String(getTargetId(req) || '');
  if (tokenId && targetId && tokenId === targetId) return next();
  return res.status(403).json({ message: 'You can only change your own account.' });
};

// --------------------------------------------------------------------------
// Fight creation has TWO legitimate callers: the back office, and an affiliate
// promoting a template you already approved. Locking /addMatch to admin only
// would silently kill affiliate promotion, so this accepts either and records
// WHICH it was — an affiliate is then pinned to their own affiliateId below and
// cannot promote on someone else's behalf.
// --------------------------------------------------------------------------
// True when this affiliate is a promoter on this fight. Used to let a promoter
// manage THEIR OWN campaign through routes that are otherwise admin-only —
// without it those screens 403 silently and the promoter thinks the button is
// broken.
async function affiliateOwnsFight(affiliateId, fightId) {
  if (!affiliateId || !fightId) return false;
  const id = String(affiliateId);
  for (const model of [Match, Shadow]) {
    const fight = await model.findById(fightId).select('affiliateId AffiliateIds').lean();
    if (!fight) continue;
    const owners = [
      fight.affiliateId,
      ...(Array.isArray(fight.AffiliateIds) ? fight.AffiliateIds.map((a) => a?.AffiliateId) : []),
    ].filter(Boolean).map(String);
    return owners.includes(id);
  }
  return false;
}

const requireAdminOrFightOwner = (getFightId) => async (req, res, next) => {
  if (req.actorRole === 'admin') return next();
  const owns = await affiliateOwnsFight(req.affiliateActorId, getFightId(req));
  if (owns) return next();
  return res.status(403).json({ message: 'You can only manage fights you promote.', code: 'NOT_FIGHT_OWNER' });
};

const verifyAdminOrAffiliateToken = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({
      message: 'Sign in as an administrator or an affiliate to create a fight.',
      code: 'AUTH_REQUIRED',
      shouldLogin: true,
    });
  }
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET_ADMIN);
    req.actorRole = 'admin';
    return next();
  } catch (_adminError) {
    try {
      const claims = jwt.verify(token, process.env.JWT_SECRET);
      const scope = String(claims.scope || '').trim();
      // A player token must never reach fight creation.
      if (scope && scope !== TOKEN_SCOPES.AFFILIATE) {
        return res.status(403).json({ message: 'This account cannot create fights.', code: 'WRONG_TOKEN_SCOPE' });
      }
      req.user = claims;
      req.actorRole = 'affiliate';
      req.affiliateActorId = String(claims.id || claims._id || '');
      return next();
    } catch (_userError) {
      return res.status(401).json({ message: 'Invalid or expired session.', code: 'TOKEN_INVALID_OR_EXPIRED', shouldLogin: true });
    }
  }
};


// Email approval links cannot carry an Authorization header, so they carry a
// signature instead. Use buildSignedActionUrl() wherever such a link is built.
function signActionToken(scope, id) {
  const secret = String(process.env.ACTION_LINK_SECRET || process.env.JWT_SECRET_ADMIN || '').trim();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(`${scope}:${id}`).digest('hex').slice(0, 32);
}

function verifySignedAction(scope, id, supplied) {
  const expected = signActionToken(scope, id);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(supplied || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --------------------------------------------------------------------------
// RATE LIMITING
// No dependency added on purpose — this is a small in-memory limiter. If you
// run more than one instance, move it to Redis so the counters are shared.
// --------------------------------------------------------------------------
const rateBuckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

const rateLimit = ({ windowMs = 60000, max = 30, keyPrefix = 'rl', message, keyBy = 'ip' } = {}) => (req, res, next) => {
  const ip = String(
    req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown'
  ).split(',')[0].trim();

  // keyBy 'caller' buckets per SESSION rather than per IP. This limiter runs
  // before verifyToken on most routes, so the raw token is used as the identity —
  // unverified is fine for bucketing, and an invalid token falls back to IP.
  // Without this, everyone sharing a WiFi shares one bucket: a watch party of
  // eight would lock itself out of entering the same fight.
  let identity = ip;
  if (keyBy === 'caller') {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (bearer.length > 24) identity = 't:' + bearer.slice(-24);
  }
  const key = `${keyPrefix}:${identity}`;
  const now = Date.now();

  let bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }

  bucket.count += 1;
  if (bucket.count > max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({
      message: message || 'Too many attempts. Please wait and try again.',
      code: 'RATE_LIMITED',
      retryAfterSeconds: retryAfter,
    });
  }
  return next();
};

// Credential endpoints: strict. Brute-forcing a login is how accounts with real
// coin balances get taken.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyPrefix: 'login',
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
});

// Authenticated actions — entries, drafts, league notices, support. Keyed per
// caller, not per IP, so a household or a watch party does not lock itself out.
// 20 in 10 minutes is generous for a real player and still stops flooding: a
// signed-out caller falls back to IP, and someone with many accounts is caught by
// duplicate-account prevention rather than by this.
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  keyPrefix: 'submit',
  keyBy: 'caller',
});


// Client feedback helper utilities for fight freshness, manual scoring, and edit forms.
function isProvidedValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function assignIfProvided(document, field, value) {
  if (isProvidedValue(value)) {
    document[field] = value;
  }
}

function hasOwnField(source, field) {
  return source && Object.prototype.hasOwnProperty.call(source, field);
}

function toNumberIfProvided(value, fallback) {
  if (!isProvidedValue(value)) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function parseMaybeJson(value, fallback = undefined) {
  if (!isProvidedValue(value)) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function normalizeCombatCategory(category) {
  const value = String(category || '').trim().toLowerCase();
  // Bare knuckle is stored as matchCategory 'boxing' + matchCategoryTwo
  // 'Bare-knuckle', so it already lands on the boxing stat set. If a caller
  // sends the sub-category as the category, map it explicitly rather than
  // letting it fall through to the MMA branch and silently record the wrong
  // stats (ST/KI/KN/EL against a punch card).
  if (['bare-knuckle', 'bareknuckle', 'bare knuckle'].includes(value)) return 'boxing';
  if (value === 'kickboxing') return 'mma';
  return value;
}

async function resolveCombatFighterSelectionForMatchInput({ fighterAId, fighterBId, matchFighterA, matchFighterB, fighterAImage, fighterBImage, fighterAImagePublicId, fighterBImagePublicId, matchCategory }) {
  const CombatFighter = mongoose.models.CombatFighter;
  const result = { fighterA: null, fighterB: null };
  const ids = [fighterAId, fighterBId].map((value) => String(value || '').trim()).filter(Boolean);
  const uniqueIds = [...new Set(ids)].filter((id) => mongoose.isValidObjectId(id));

  if (CombatFighter && uniqueIds.length) {
    const fighters = await CombatFighter.find({ _id: { $in: uniqueIds }, status: { $ne: 'inactive' } }).lean();
    const byId = new Map(fighters.map((fighter) => [String(fighter._id), fighter]));
    result.fighterA = byId.get(String(fighterAId || '').trim()) || null;
    result.fighterB = byId.get(String(fighterBId || '').trim()) || null;
  }

  // Any fighter that arrives with a name + image but no library id — someone
  // uploaded straight onto the fight instead of picking from the library —
  // gets registered into the library automatically, so they show up there
  // for editing/deletion instead of only existing as fields on this one fight.
  if (CombatFighter) {
    if (!result.fighterA && matchFighterA && fighterAImage) {
      result.fighterA = await autoRegisterCombatFighter(CombatFighter, { name: matchFighterA, image: fighterAImage, imagePublicId: fighterAImagePublicId, category: matchCategory });
    }
    if (!result.fighterB && matchFighterB && fighterBImage) {
      result.fighterB = await autoRegisterCombatFighter(CombatFighter, { name: matchFighterB, image: fighterBImage, imagePublicId: fighterBImagePublicId, category: matchCategory });
    }
  }

  return result;
}

async function autoRegisterCombatFighter(CombatFighter, { name, image, imagePublicId, category }) {
  const displayName = String(name || '').trim();
  const normalizedName = displayName.toLowerCase();
  // Match resolveSport() on the client: a bare-knuckle bout is stored as
  // matchCategory 'boxing' + matchCategoryTwo 'Bare-knuckle', so the caller
  // passes categoryTwo first when set. Normalize the same "bare"/"bkfc"
  // wording here so an auto-registered fighter's category actually matches
  // the sport pill's lookup key ('bare-knuckle') instead of silently
  // defaulting to 'boxing' and never showing up in that carousel.
  const rawCategory = String(category || 'combat').trim().toLowerCase();
  const normalizedCategory = (rawCategory.includes('bare') || rawCategory.includes('bkfc')) ? 'bare-knuckle' : (rawCategory || 'combat');
  if (!displayName || !image) return null;
  try {
    return await CombatFighter.findOneAndUpdate(
      { normalizedName, category: normalizedCategory },
      {
        $setOnInsert: {
          displayName,
          normalizedName,
          category: normalizedCategory,
          primaryImage: image,
          imagePublicId: imagePublicId || undefined,
          status: 'active',
          source: 'auto-registered-from-fight',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (error) {
    // Duplicate-key race on the unique (normalizedName, category) index — just
    // re-read the record another request just created.
    if (error?.code === 11000) return CombatFighter.findOne({ normalizedName, category: normalizedCategory }).lean();
    console.error('Auto-register fighter from fight failed:', error);
    return null;
  }
}

function applyCombatFighterSelectionToMatchPayload(matchData, selection = {}, options = {}) {
  const allowImageFallback = options.allowImageFallback !== false;
  const fighterA = selection.fighterA;
  const fighterB = selection.fighterB;

  if (fighterA) {
    matchData.fighterAId = fighterA._id;
    if (fighterA.displayName) matchData.matchFighterA = fighterA.displayName;
    if (allowImageFallback && !matchData.fighterAImage && fighterA.primaryImage) {
      matchData.fighterAImage = fighterA.primaryImage;
      // Do not copy fighter image public IDs into fights; deleting a fight must not delete a shared fighter-library asset.
    }
  }

  if (fighterB) {
    matchData.fighterBId = fighterB._id;
    if (fighterB.displayName) matchData.matchFighterB = fighterB.displayName;
    if (allowImageFallback && !matchData.fighterBImage && fighterB.primaryImage) {
      matchData.fighterBImage = fighterB.primaryImage;
      // Do not copy fighter image public IDs into fights; deleting a fight must not delete a shared fighter-library asset.
    }
  }

  return matchData;
}

function clearLegacyFighterFieldsForLibraryRefs(record, options = {}) {
  if (!record || typeof record !== 'object') return record;
  const removeNames = options.removeNames !== false;
  const removeImages = options.removeImages !== false;
  const removeDeleteUrls = options.removeDeleteUrls !== false;

  const clearField = (field) => {
    if (typeof record.set === 'function') record.set(field, undefined);
    else delete record[field];
  };

  if (record.fighterAId) {
    if (removeNames) clearField('matchFighterA');
    if (removeImages) clearField('fighterAImage');
    if (removeDeleteUrls) clearField('fighterAImageDeleteUrl');
  }

  if (record.fighterBId) {
    if (removeNames) clearField('matchFighterB');
    if (removeImages) clearField('fighterBImage');
    if (removeDeleteUrls) clearField('fighterBImageDeleteUrl');
  }

  return record;
}

function pickExplicitNumericField(input, names, fallback) {
  for (const name of names) {
    if (hasOwnField(input, name)) {
      return toNumberIfProvided(input[name], fallback);
    }
  }
  return fallback;
}

function normalizeRoundStatsForCategory(input = {}, previous = {}, category = 'boxing') {
  const normalizedCategory = normalizeCombatCategory(category);
  const output = { ...(previous && typeof previous.toObject === 'function' ? previous.toObject() : previous || {}) };

  output.roundNumber = pickExplicitNumericField(input, ['roundNumber', 'round'], output.roundNumber);

  if (normalizedCategory === 'boxing') {
    output.HP = pickExplicitNumericField(input, ['HP', 'hp', 'headPunches'], output.HP);
    output.BP = pickExplicitNumericField(input, ['BP', 'bp', 'bodyPunches'], output.BP);
    // TP / total punches is intentionally manual only. It is never calculated from HP + BP.
    output.TP = pickExplicitNumericField(input, ['TP', 'tp', 'totalPunches'], output.TP);
    output.RW = pickExplicitNumericField(input, ['RW', 'rw', 'roundsWon'], output.RW);
    output.RL = pickExplicitNumericField(input, ['RL', 'rl', 'roundsLost'], output.RL);
    output.KO = pickExplicitNumericField(input, ['KO', 'ko', 'knockouts'], output.KO);
    output.SP = pickExplicitNumericField(input, ['SP', 'sp', 'specialPoints'], output.SP);
    return output;
  }

  output.ST = pickExplicitNumericField(input, ['ST', 'st', 'strikes'], output.ST);
  output.KI = pickExplicitNumericField(input, ['KI', 'ki', 'kicks'], output.KI);
  // KN is KNEES on the MMA/kickboxing card — the same thing the player predicts
  // in MakePredictions. Knockdowns are not a counted stat; a knockdown that ends
  // the fight is the KO market. 'knockdowns' stays an accepted alias only so old
  // admin payloads keep landing in the right field.
  output.KN = pickExplicitNumericField(input, ['KN', 'kn', 'knees', 'knockdowns'], output.KN);
  output.EL = pickExplicitNumericField(input, ['EL', 'el', 'elbows'], output.EL);
  output.RW = pickExplicitNumericField(input, ['RW', 'rw', 'roundsWon'], output.RW);
  output.RL = pickExplicitNumericField(input, ['RL', 'rl', 'roundsLost'], output.RL);
  output.KO = pickExplicitNumericField(input, ['KO', 'ko', 'knockouts'], output.KO);
  output.SP = pickExplicitNumericField(input, ['SP', 'sp', 'specialPoints'], output.SP);
  return output;
}

function upsertRoundStats(statsArray, incomingStats = {}, category = 'boxing') {
  if (!incomingStats) return;
  const rawRound = hasOwnField(incomingStats, 'roundNumber') ? incomingStats.roundNumber : incomingStats.round;
  if (!isProvidedValue(rawRound)) return;
  const incomingRound = Number(rawRound);
  const existingIndex = statsArray.findIndex((stat) => Number(stat.roundNumber) === incomingRound);
  const previous = existingIndex !== -1 ? statsArray[existingIndex] : {};
  const normalized = normalizeRoundStatsForCategory(incomingStats, previous, category);
  if (existingIndex !== -1) {
    statsArray[existingIndex] = normalized;
  } else {
    statsArray.push(normalized);
  }
}

function getStatsContainer(match, category) {
  const normalizedCategory = normalizeCombatCategory(category || match.matchCategory);
  if (normalizedCategory === 'boxing') {
    if (!match.BoxingMatch) match.BoxingMatch = {};
    if (!Array.isArray(match.BoxingMatch.fighterOneStats)) match.BoxingMatch.fighterOneStats = [];
    if (!Array.isArray(match.BoxingMatch.fighterTwoStats)) match.BoxingMatch.fighterTwoStats = [];
    return match.BoxingMatch;
  }
  if (!match.MMAMatch) match.MMAMatch = {};
  if (!Array.isArray(match.MMAMatch.fighterOneStats)) match.MMAMatch.fighterOneStats = [];
  if (!Array.isArray(match.MMAMatch.fighterTwoStats)) match.MMAMatch.fighterTwoStats = [];
  return match.MMAMatch;
}

function applyRoundResultsToMatch(match, body = {}) {
  const category = normalizeCombatCategory(body.matchCategory || match.matchCategory);
  if (!['boxing', 'mma'].includes(category)) {
    const error = new Error('Invalid match category');
    error.statusCode = 400;
    throw error;
  }
  const statsContainer = getStatsContainer(match, category);
  if (body.fighterOneStats) upsertRoundStats(statsContainer.fighterOneStats, body.fighterOneStats, category);
  if (body.fighterTwoStats) upsertRoundStats(statsContainer.fighterTwoStats, body.fighterTwoStats, category);
  return match;
}

const FIGHT_DRAFT_STATUSES = ['Draft', 'draft', 'DRAFT'];
const FIGHT_DRAFT_STATUS_REGEX = /^\s*draft\s*$/i;

function shouldIncludeDraftFights(query = {}) {
  return ['true', '1', 'yes'].includes(String(query.includeDrafts || query.admin || '').toLowerCase());
}

function isDraftFightRecord(match = {}) {
  const normalize = (value) => String(value || '').trim().toLowerCase();
  return normalize(match.matchStatus) === 'draft'
    || normalize(match.status) === 'draft'
    || normalize(match.matchShadowStatus) === 'draft'
    || match.draft === true
    || match.isDraft === true;
}

function isAllFilterValue(value) {
  return ['', 'all', 'any', 'undefined', 'null'].includes(String(value || '').trim().toLowerCase());
}

function exactTextRegex(value) {
  const clean = String(value || '').trim();
  if (!clean) return null;
  return new RegExp(`^${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

function escapeRegexText(value) {
  return String(value || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanFightCategoryValue(value) {
  const clean = String(value || '').trim();
  if (!clean || ['undefined', 'null', 'all', 'any'].includes(clean.toLowerCase())) return '';
  return clean;
}

function normalizeFightCategorySlug(value) {
  const clean = cleanFightCategoryValue(value).toLowerCase();
  if (!clean) return '';
  const compact = clean.replace(/[^a-z0-9]+/g, '');
  if (['bareknuckle', 'bareknuckleboxing', 'bareknucklefighting'].includes(compact)) return 'bare-knuckle';
  if (['kickboxing', 'k1', 'kone'].includes(compact)) return 'kickboxing';
  if (['mixedmartialarts', 'mma'].includes(compact)) return 'mma';
  if (['boxing', 'box'].includes(compact)) return 'boxing';
  return clean.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function getFightCategoryAliases(value) {
  const clean = cleanFightCategoryValue(value);
  const slug = normalizeFightCategorySlug(clean);
  const aliasesBySlug = {
    'bare-knuckle': ['Bare-knuckle', 'Bare Knuckle', 'Bareknuckle', 'bare-knuckle', 'bare knuckle', 'bareknuckle'],
    kickboxing: ['kickboxing', 'Kickboxing', 'kick-boxing', 'Kick-boxing', 'kick boxing', 'Kick Boxing', 'K-1', 'K1'],
    boxing: ['boxing', 'Boxing'],
    mma: ['mma', 'MMA', 'mixed martial arts', 'Mixed Martial Arts'],
  };
  const aliases = aliasesBySlug[slug] || [clean];
  return [...new Set(aliases.filter(Boolean))];
}

function categoryTextRegex(value) {
  const aliases = getFightCategoryAliases(value);
  if (!aliases.length) return null;
  return new RegExp(`^(?:${aliases.map(escapeRegexText).join('|')})$`, 'i');
}

const FIGHT_CATEGORY_TWO_BLANK_REGEX = /^\s*$/i;

function hasSecondaryFightCategory(match = {}) {
  return Boolean(cleanFightCategoryValue(match.matchCategoryTwo));
}

function getEffectiveFightCategory(match = {}) {
  return cleanFightCategoryValue(match.matchCategoryTwo) || cleanFightCategoryValue(match.matchCategory) || 'combat';
}

function getEffectiveFightCategorySlug(match = {}) {
  return normalizeFightCategorySlug(getEffectiveFightCategory(match));
}

function isFightRecordInEffectiveCategory(match = {}, category) {
  if (isAllFilterValue(category)) return true;
  const requestedSlug = normalizeFightCategorySlug(category);
  if (!requestedSlug) return true;
  return getEffectiveFightCategorySlug(match) === requestedSlug;
}

function appendAndFilter(query = {}, condition = null) {
  if (!condition || !Object.keys(condition).length) return query;
  const base = { ...(query || {}) };
  const andParts = Array.isArray(base.$and) ? [...base.$and] : [];
  delete base.$and;
  if (Object.keys(base).length) andParts.unshift(base);
  andParts.push(condition);
  return andParts.length === 1 ? andParts[0] : { $and: andParts };
}

function buildEffectiveFightCategoryFilter(category) {
  if (isAllFilterValue(category)) return null;
  const categoryRegex = categoryTextRegex(category);
  if (!categoryRegex) return null;
  const emptySecondaryFilter = {
    $or: [
      { matchCategoryTwo: { $exists: false } },
      { matchCategoryTwo: null },
      { matchCategoryTwo: '' },
      { matchCategoryTwo: FIGHT_CATEGORY_TWO_BLANK_REGEX },
    ],
  };
  return {
    $or: [
      { matchCategoryTwo: categoryRegex },
      { $and: [{ matchCategory: categoryRegex }, emptySecondaryFilter] },
    ],
  };
}

function shouldUseStrictPlayableFightFilter(query = {}) {
  return ['true', '1', 'yes'].includes(String(query.strictPlayable || query.openOnly || query.onlyOpen || '').toLowerCase());
}

function getRequestedClassicPlayerId(query = {}) {
  return String(query.playerId || query.userId || query.accountId || query.viewerId || '').trim();
}

function parseMonthDayTextDate(text = '') {
  const match = String(text).match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b/i);
  if (!match) return null;
  const date = new Date(`${match[1]} ${match[2]}, ${new Date().getFullYear()}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseFightDateTime(match = {}) {
  const rawDate = match.matchDate
    || match.date
    || match.fightDate
    || match.scheduledAt
    || match.startDate
    || match.eventDate
    || match.iso
    || match.dateLabel
    || match.scheduleLabel
    || match.matchDateLabel
    || match.homepagePromotionStartsAt
    || match.homepagePromotion?.startsAt
    || match.homepagePromotion?.subtitle
    || match.homepagePromotionSubtitle;
  const searchableText = [
    rawDate,
    match.matchName,
    match.matchDescription,
    match.homepagePromotion?.title,
    match.homepagePromotion?.subtitle,
    match.homepagePromotionTitle,
    match.homepagePromotionSubtitle,
  ].filter(Boolean).join(' ').trim();
  if (!searchableText) return null;

  const rawText = String(rawDate || searchableText).trim();
  const timeText = String(match.matchTime || match.time || match.fightTime || '').trim();
  const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})/);
  const isIsoLike = /^\d{4}-\d{2}-\d{2}/.test(rawText) || rawText.includes('T');
  let date = null;

  if (isIsoLike) {
    const hh = String(timeMatch?.[1] || '23').padStart(2, '0');
    const mm = String(timeMatch?.[2] || '59').padStart(2, '0');
    date = new Date(rawText.includes('T') ? rawText : `${rawText}T${hh}:${mm}:00`);
  }

  if (!date || Number.isNaN(date.getTime())) date = new Date(rawText);
  if (!date || Number.isNaN(date.getTime())) date = parseMonthDayTextDate(rawText) || parseMonthDayTextDate(searchableText);
  if (!date || Number.isNaN(date.getTime())) return null;

  if (timeMatch && !rawText.includes('T')) {
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) date.setHours(hours, minutes, 0, 0);
  } else if (!rawText.includes('T')) {
    date.setHours(23, 59, 59, 999);
  }
  return date;
}

function isShadowFightRecord(match = {}) {
  const source = String(match.sourceType || match.collection || '').trim().toLowerCase();
  const type = String(match.matchType || match.type || '').trim().toLowerCase();
  return source === 'shadow' || type === 'shadow';
}

function hasOfficialShadowScores(match = {}) {
  const hasCompleteStats = (container) => Array.isArray(container?.fighterOneStats)
    && container.fighterOneStats.length > 0
    && Array.isArray(container?.fighterTwoStats)
    && container.fighterTwoStats.length > 0;
  return hasCompleteStats(match.BoxingMatch) || hasCompleteStats(match.MMAMatch);
}

function isLiveFightRecord(match = {}) {
  const type = String(match.matchType || match.type || '').trim().toLowerCase();
  return type === 'live' && !isShadowFightRecord({ ...match, sourceType: match.sourceType || '' });
}

function hasFutureFightDate(match = {}, now = new Date()) {
  const fightDate = parseFightDateTime(match);
  return Boolean(fightDate && fightDate.getTime() >= now.getTime());
}

function getFightTimelineBucket(match = {}, now = new Date()) {
  if (isDraftFightRecord(match)) return 'draft';
  if (isShadowFightRecord(match)) return hasFutureFightDate(match, now) ? 'upcoming' : 'past';
  const status = String(match.matchStatus || match.status || '').trim().toLowerCase();
  const openStatus = String(match.matchShadowOpenStatus || '').trim().toLowerCase();
  if (['finished', 'closed', 'completed', 'complete', 'cancelled', 'canceled', 'past', 'result', 'final'].includes(status) || openStatus === 'closed') return 'past';
  const fightDate = parseFightDateTime(match);
  if (fightDate) return fightDate.getTime() >= now.getTime() ? 'upcoming' : 'past';
  if (isLiveFightRecord(match)) return 'upcoming';
  return 'upcoming';
}

function hasExpiredMonthDayText(match = {}, now = new Date()) {
  const searchableText = [
    match.matchDate,
    match.date,
    match.fightDate,
    match.scheduledAt,
    match.startDate,
    match.eventDate,
    match.dateLabel,
    match.scheduleLabel,
    match.matchDateLabel,
    match.matchName,
    match.matchDescription,
    match.homepagePromotion?.title,
    match.homepagePromotion?.subtitle,
    match.homepagePromotionTitle,
    match.homepagePromotionSubtitle,
  ].filter(Boolean).join(' ');

  const monthDay = parseMonthDayTextDate(searchableText);
  if (!monthDay) return false;
  monthDay.setHours(23, 59, 59, 999);
  const normalizedNow = now instanceof Date ? now : new Date(now || Date.now());
  return !Number.isNaN(normalizedNow.getTime()) && monthDay.getTime() < normalizedNow.getTime();
}

function isPublicHomeActiveFightRecord(match = {}, now = new Date()) {
  if (!match || isDraftFightRecord(match)) return false;
  // Discovery creates review candidates, not published contests. Keep those
  // candidates out of every public/home feed until an admin explicitly marks
  // one for a homepage surface. This also quarantines candidates created by
  // older deployments that saved them as Scheduled/Open.
  if (match.autoDiscovered === true
    && !match.homepagePromoted
    && !match.featuredThisWeek
    && !match.featuredFight) return false;
  if (getFightTimelineBucket(match, now) === 'past') return false;
  if (hasExpiredMonthDayText(match, now)) return false;
  return true;
}

function getFightStatusBucket(match = {}) {
  const timeline = getFightTimelineBucket(match);
  if (timeline === 'past') return 'completed';
  if (timeline === 'draft') return 'draft';
  return 'playable';
}

function normalizePredictionUserId(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    const plain = toPlainObject(value) || value;
    const nestedId = plain._id || plain.id || plain.userId || plain.playerId;
    if (nestedId) return String(nestedId).trim();
    if (typeof value.toString === 'function') {
      const text = String(value).trim();
      if (text && text !== '[object Object]') return text;
    }
    return '';
  }
  return String(value).trim();
}

function getUserPredictionEntryForFight(match = {}, playerId = '') {
  const normalizedPlayerId = normalizePredictionUserId(playerId);
  if (!normalizedPlayerId || !Array.isArray(match.userPredictions)) return null;

  return match.userPredictions.find((prediction) => {
    const predictionUserId = normalizePredictionUserId(
      prediction?.userId || prediction?.playerId || prediction?.user || prediction?.player ||
      (prediction && typeof prediction !== 'object' ? prediction : '')
    );
    return predictionUserId === normalizedPlayerId;
  }) || null;
}

function getPredictionStatusText(value) {
  const status = String(value || '').trim().toLowerCase();
  if (['submitted', 'submit', 'complete', 'completed', 'locked', 'scored', 'settled'].includes(status)) return 'submitted';
  if (['notsubmitted', 'not_submitted', 'not-submitted', 'pending', 'draft', 'unsubmitted'].includes(status)) return 'not_submitted';
  return status || 'not_submitted';
}

function isSubmittedPredictionStatusText(value) {
  return getPredictionStatusText(value) === 'submitted';
}

async function attachPlayerPredictionStateToFightItems(items = [], query = {}) {
  const playerId = getRequestedClassicPlayerId(query);
  const includePrivateEntry = query.includePrivateEntry === true;
  const baseItems = Array.isArray(items) ? items : [];
  if (!baseItems.length) return [];

  let submittedMatchIds = new Set();
  const userScoreByMatchId = new Map();
  const scoresByMatchId = new Map();
  const matchIds = [...new Set(baseItems.map((item) => String(item && item._id || '').trim()).filter(Boolean))];
  if (matchIds.length) {
    const allScores = await Score.find({ matchId: { $in: matchIds } })
      .select('matchId playerId predictions totalPoints totalScore score points createdAt updatedAt')
      .lean();
    allScores.forEach((score) => {
      const key = String(score.matchId || '');
      if (!scoresByMatchId.has(key)) scoresByMatchId.set(key, []);
      scoresByMatchId.get(key).push(score);
      if (playerId && normalizePredictionUserId(score.playerId) === playerId) userScoreByMatchId.set(key, score);
    });
  }
  if (playerId) {
    submittedMatchIds = new Set([...userScoreByMatchId.keys()]);
  }

  return baseItems.map((item) => {
    const plain = toPlainObject(item) || {};
    const embeddedPrediction = getUserPredictionEntryForFight(plain, playerId);
    const embeddedStatus = getPredictionStatusText(embeddedPrediction?.predictionStatus || embeddedPrediction?.status);
    const scoreSubmitted = submittedMatchIds.has(String(plain._id));
    const predictionSubmitted = Boolean(scoreSubmitted || embeddedStatus === 'submitted');
    const userPredictionStatus = predictionSubmitted ? 'submitted' : embeddedStatus;
    const fightStatusBucket = getFightStatusBucket(plain);
    const canSubmitPrediction = !predictionSubmitted && isPredictionEligibleFightRecord(plain) && !isDraftFightRecord(plain);
    const score = userScoreByMatchId.get(String(plain._id));
    const pickSide = derivePredictionPickSide(score?.predictions);
    const explicitLivePoints = score
      ? readNumericField(score, ['totalPoints', 'totalScore', 'score', 'points'])
      : null;
    const officialStats = score ? getClassicFightOfficialStats(plain) : null;
    const calculatedLivePoints = score && officialStats && hasOfficialStats(officialStats)
      ? calculateClassicPredictionPoints(score.predictions, officialStats.fighterOneStats, officialStats.fighterTwoStats, officialStats.category)
      : 0;
    const scoutingPayload = buildScoutingPayload(plain, scoresByMatchId.get(String(plain._id)) || []);
    const liveReport = buildTemplateScoutingReport(scoutingPayload);
    const storedReport = plain.aiScoutingReport && typeof plain.aiScoutingReport === 'object'
      ? plain.aiScoutingReport
      : null;
    const identityHidden = Boolean(plain.shadowIdentityHidden) && !predictionSubmitted;
    const aiScoutingReport = !identityHidden && liveReport ? {
      ...liveReport,
      ...(storedReport || {}),
      pickSplitNote: liveReport.pickSplitNote,
      underdogAngle: liveReport.underdogAngle,
      pickCount: scoutingPayload.pickCount,
      pickSplit: scoutingPayload.pickSplit,
    } : null;

    return {
      ...plain,
      ...(identityHidden ? {
        matchName: 'MYSTERY SHADOW FIGHT',
        matchFighterA: 'MYSTERY RED CORNER',
        matchFighterB: 'MYSTERY BLUE CORNER',
        fighterA: null,
        fighterB: null,
        fighterAId: null,
        fighterBId: null,
        fighterAImage: '',
        fighterBImage: '',
        matchDescription: 'Archived mystery fight. Competitor identities reveal after entry.',
        promotionBackground: '',
        fightPosterImage: '',
        fightPosterMobileImage: '',
      } : {}),
      predictionSubmitted,
      userPredictionSubmitted: predictionSubmitted,
      userPredictionStatus,
      userFightBucket: predictionSubmitted ? 'completed' : (canSubmitPrediction ? 'playable' : fightStatusBucket),
      fightStatusBucket,
      canSubmitPrediction,
      aiScoutingReport,
      userEntry: score && includePrivateEntry ? {
        status: 'submitted',
        pickSide,
        pickName: pickSide === 'a' ? plain.matchFighterA : pickSide === 'b' ? plain.matchFighterB : '',
        predictions: score.predictions || [],
        livePoints: Number.isFinite(explicitLivePoints) ? explicitLivePoints : calculatedLivePoints,
        submittedAt: score.updatedAt || score.createdAt || null,
      } : null,
    };
  });
}

async function updateClassicFightPredictionStatus(matchId, userId, predictionStatus = 'submitted') {
  const normalizedMatchId = String(matchId || '').trim();
  const normalizedUserId = normalizePredictionUserId(userId);
  if (!normalizedMatchId || !normalizedUserId) return null;

  const normalizedStatus = isSubmittedPredictionStatusText(predictionStatus) ? 'submitted' : 'notSubmitted';
  let sourceType = 'match';
  let fight = await Match.findById(normalizedMatchId);

  if (!fight) {
    sourceType = 'shadow';
    fight = await Shadow.findById(normalizedMatchId);
  }

  if (!fight) return null;

  if (!Array.isArray(fight.userPredictions)) fight.userPredictions = [];

  const existingPrediction = fight.userPredictions.find((prediction) => {
    const predictionUserId = normalizePredictionUserId(
      prediction?.userId || prediction?.playerId || prediction?.user || prediction?.player
    );
    return predictionUserId === normalizedUserId;
  });

  if (existingPrediction) {
    existingPrediction.predictionStatus = normalizedStatus;
  } else {
    fight.userPredictions.push({ userId: normalizedUserId, predictionStatus: normalizedStatus });
  }

  await fight.save();
  clearPublicResponseCache();
  return { fight, sourceType, predictionStatus: normalizedStatus };
}

function applyPublicFightStatusIntent(items = [], query = {}) {
  const statusValue = String(query.status || query.bucket || query.view || '').trim().toLowerCase();
  if (!statusValue || ['all', 'any'].includes(statusValue)) return items;
  if (['upcoming', 'future', 'scheduled'].includes(statusValue)) {
    return items.filter((item) => getFightTimelineBucket(item) === 'upcoming');
  }
  if (['past', 'previous', 'history', 'shadow-history'].includes(statusValue)) {
    return items.filter((item) => getFightTimelineBucket(item) === 'past');
  }
  if (['completed', 'complete', 'submitted', 'my-predictions', 'predicted'].includes(statusValue)) {
    return items.filter((item) => item.predictionSubmitted || item.userFightBucket === 'completed');
  }
  if (['playable', 'prediction', 'predictions', 'can-predict', 'open-for-predictions', 'active-contests', 'unsubmitted'].includes(statusValue)) {
    return shouldUseStrictPlayableFightFilter(query)
      ? items.filter((item) => isPredictionEligibleFightRecord(item) && !item.predictionSubmitted)
      : items.filter((item) => !item.predictionSubmitted);
  }
  return items;
}

function appendNoDraftFightFilter(query = {}) {
  if (shouldIncludeDraftFights(query)) return null;

  // IMPORTANT: hide only fights that are explicitly marked as Draft.
  // Do not rely on optional visibility flags here because many existing
  // production fights do not have those fields normalized yet.
  return {
    $and: [
      { $or: [{ matchStatus: { $exists: false } }, { matchStatus: { $not: FIGHT_DRAFT_STATUS_REGEX } }] },
      { draft: { $ne: true } },
      { isDraft: { $ne: true } },
    ],
  };
}

const SENSITIVE_ACCOUNT_FIELDS = [
  'password',
  'verificationToken',
  'resetPasswordToken',
  'resetPasswordExpires',
  'preferredPaymentMethodValue',
  'profileDeleteUrl',
];

const SENSITIVE_BILLING_FIELDS = [
  'cardNumber',
  'cardCode',
  'expirationDate',
  'paymentProfileId',
  'customerProfileId',
  'transactionId',
];

const USER_SAFE_SELECT = [
  '_id',
  'firstName',
  'lastName',
  'playerName',
  'zipCode',
  'tokens',
  'email',
  'phone',
  'shortBio',
  'isNotificationsEnabled',
  'isSubscribed',
  'isUSCitizen',
  'isAgreed',
  'verified',
  'profileUrl',
  'currentPlan',
  'fmPlusPlan',
  'fmPlusExpiresAt',
  'fmPlusLastCoinCreditAt',
  'hasReceivedFirstPurchaseBonus',
  'skillTier',
  'skillTierUpdatedAt',
  'rollingPerformancePercentile',
  'loginStreak',
  'streakExpiresAt',
  'dailyRewardClaimedAt',
  'streakSkipUnlockedAt',
  'freePlanExpiryDate',
  'hasAvailedFreePlan',
  'preferredPaymentMethod',
  'hasSubmittedTestimonial',
  'billing.address',
  'billing.city',
  'billing.state',
  'billing.zip',
  'billing.country',
  'createdAt',
  'updatedAt',
].join(' ');

const AFFILIATE_SAFE_SELECT = [
  '_id',
  'firstName',
  'lastName',
  'playerName',
  'zipCode',
  'email',
  'phone',
  'hearing',
  'isNotificationsEnabled',
  'isSubscribed',
  'isUSCitizen',
  'isAgreed',
  'totalViews',
  'verified',
  'profileUrl',
  'tokens',
  'preferredPaymentMethod',
  'rewardTitle',
  'rewardImageUrl',
  'usersJoined',
  'payouts',
  'createdAt',
  'updatedAt',
].join(' ');

function toPlainObject(value) {
  if (!value) return value;
  if (typeof value.toObject === 'function') {
    return value.toObject({ depopulate: false, versionKey: false, transform: false });
  }
  if (typeof value === 'object') {
    return Array.isArray(value) ? value.map((item) => toPlainObject(item)) : { ...value };
  }
  return value;
}

function normalizeWalletTokenNumber(value, fallback = 0) {
  const raw = typeof value === 'string' ? value.trim().replace(/,/g, '') : value;
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function normalizeWalletTokenString(value, fallback = 0) {
  return String(normalizeWalletTokenNumber(value, fallback));
}

function isWalletTokenValueInvalid(value) {
  return String(value ?? '') !== normalizeWalletTokenString(value);
}

function addWalletTokens(currentBalance, tokensToAdd) {
  return String(normalizeWalletTokenNumber(currentBalance) + normalizeWalletTokenNumber(tokensToAdd));
}

function subtractWalletTokens(currentBalance, tokensToDeduct) {
  const balance = normalizeWalletTokenNumber(currentBalance);
  const deduction = normalizeWalletTokenNumber(tokensToDeduct);
  return {
    balance,
    deduction,
    nextBalance: balance - deduction,
  };
}

function sanitizeAccountObject(value) {
  const account = toPlainObject(value);
  if (!account || typeof account !== 'object' || Array.isArray(account)) return account;

  SENSITIVE_ACCOUNT_FIELDS.forEach((field) => {
    delete account[field];
  });

  if (Object.prototype.hasOwnProperty.call(account, 'tokens')) {
    account.tokens = normalizeWalletTokenString(account.tokens);
  }

  if (account.billing && typeof account.billing === 'object') {
    SENSITIVE_BILLING_FIELDS.forEach((field) => {
      delete account.billing[field];
    });
  }

  return account;
}

function sanitizeAccountList(values) {
  return Array.isArray(values) ? values.map((value) => sanitizeAccountObject(value)) : [];
}

function attachSafeAccountJsonTransform(schema) {
  schema.set('toJSON', {
    virtuals: true,
    transform: (_doc, ret) => sanitizeAccountObject(ret),
  });
}

function parsePositiveInteger(value, fallback, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

const PUBLIC_CACHE_TTL_SECONDS = parsePositiveInteger(process.env.PUBLIC_CACHE_TTL_SECONDS, 15, 300);
const publicResponseCache = new Map();

function getPublicCacheKey(req, namespace = 'public') {
  return `${namespace}:${req.originalUrl || req.url || ''}`;
}

function setPublicCacheHeaders(res, ttlSeconds = PUBLIC_CACHE_TTL_SECONDS, cacheState = 'MISS') {
  const ttl = parsePositiveInteger(ttlSeconds, PUBLIC_CACHE_TTL_SECONDS, 300);
  // max-age (the BROWSER copy) is deliberately 0 while s-maxage (the shared
  // edge copy) keeps the TTL. A browser that cached a fight list for 15s would
  // ignore a reload right after publishing, which is what "I deleted it and it
  // is still there" looks like from the desk. The edge copy is short-lived and
  // is dropped by clearPublicResponseCache on the next write anyway.
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`);
  res.setHeader('X-Backend-Cache', cacheState);
}

async function readThroughPublicCache(cacheKey, producer, ttlSeconds = PUBLIC_CACHE_TTL_SECONDS) {
  const ttl = parsePositiveInteger(ttlSeconds, PUBLIC_CACHE_TTL_SECONDS, 300);
  const now = Date.now();
  const cached = publicResponseCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return { payload: cached.payload, cacheState: 'HIT' };
  }

  const payload = await producer();
  publicResponseCache.set(cacheKey, {
    payload,
    expiresAt: now + ttl * 1000,
  });

  if (publicResponseCache.size > 250) {
    const expiredKeys = [];
    publicResponseCache.forEach((entry, key) => {
      if (!entry || entry.expiresAt <= now) expiredKeys.push(key);
    });
    expiredKeys.forEach((key) => publicResponseCache.delete(key));
  }

  return { payload, cacheState: 'MISS' };
}

function clearPublicResponseCache() {
  publicResponseCache.clear();
}

function normalizeCombatFighterReadRef(value) {
  if (!value || typeof value !== 'object' || !value._id) return null;
  const fighter = toPlainObject(value) || {};
  return {
    id: String(fighter._id),
    _id: fighter._id,
    displayName: fighter.displayName || '',
    normalizedName: fighter.normalizedName || '',
    category: fighter.category || 'combat',
    aliases: Array.isArray(fighter.aliases) ? fighter.aliases : [],
    primaryImage: fighter.primaryImage || '',
    imagePublicId: fighter.imagePublicId || '',
    imageHealth: fighter.imageHealth || null,
    status: fighter.status || 'active',
  };
}

function normalizeCombatFighterReadId(value) {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function attachCombatFighterReadFallbacks(fight = {}, sourceType = 'match') {
  const item = toPlainObject(fight) || {};
  const fighterA = normalizeCombatFighterReadRef(item.fighterAId);
  const fighterB = normalizeCombatFighterReadRef(item.fighterBId);
  const effectiveCategory = getEffectiveFightCategory(item);
  const effectiveCategorySlug = getEffectiveFightCategorySlug(item);
  const matchDateKey = item.matchDateKey || extractCalendarDateKey(item.matchDate);
  const submittedEntryCount = Array.isArray(item.userPredictions)
    ? item.userPredictions.filter((prediction) => String(prediction?.predictionStatus || '').toLowerCase() === 'submitted').length
    : 0;
  const entryFee = Number.isFinite(Number(item.matchTokens)) ? Math.max(0, Number(item.matchTokens)) : 0;
  const prizePool = Number.isFinite(Number(item.pot)) ? Math.max(0, Number(item.pot)) : 0;
  return {
    ...item,
    sourceType: item.sourceType || sourceType,
    fighterAId: normalizeCombatFighterReadId(item.fighterAId),
    fighterBId: normalizeCombatFighterReadId(item.fighterBId),
    fighterA,
    fighterB,
    // Keep matchCategory as the scoring/rules category. Use effectiveCategory for
    // UI/category tabs: matchCategoryTwo wins, otherwise matchCategory is used.
    effectiveCategory,
    effectiveCategorySlug,
    displayCategory: effectiveCategory,
    categoryLabel: effectiveCategory,
    categorySlug: effectiveCategorySlug,
    matchDateKey,
    entryFee,
    entryFeeTokens: entryFee,
    prizePool,
    entryCount: submittedEntryCount,
    playerCount: submittedEntryCount,
    hasSecondaryCategory: hasSecondaryFightCategory(item),
    // Public/admin cards keep their old field names for compatibility, but the
    // fighter library is now the source of truth whenever refs are populated.
    matchFighterA: fighterA?.displayName || item.matchFighterA || '',
    matchFighterB: fighterB?.displayName || item.matchFighterB || '',
    fighterAImage: fighterA?.primaryImage || item.fighterAImage || '',
    fighterBImage: fighterB?.primaryImage || item.fighterBImage || '',
  };
}

function pickPublicFightFields(fight = {}, sourceType = 'match') {
  const item = attachCombatFighterReadFallbacks(fight, sourceType);
  const identityHidden = sourceType === 'shadow' && Boolean(item.shadowIdentityHidden);
  const entryCount = Array.isArray(item.userPredictions)
    ? item.userPredictions.filter((prediction) => String(prediction?.predictionStatus || '').toLowerCase() === 'submitted').length
    : 0;
  const entryFee = Number.isFinite(Number(item.matchTokens)) ? Math.max(0, Number(item.matchTokens)) : 0;
  const prizePool = Number.isFinite(Number(item.pot)) ? Math.max(0, Number(item.pot)) : 0;
  return {
    _id: item._id,
    sourceType,
    matchCategory: item.matchCategory,
    matchCategoryTwo: item.matchCategoryTwo,
    effectiveCategory: item.effectiveCategory,
    effectiveCategorySlug: item.effectiveCategorySlug,
    displayCategory: item.displayCategory,
    categoryLabel: item.categoryLabel,
    categorySlug: item.categorySlug,
    hasSecondaryCategory: item.hasSecondaryCategory,
    matchName: identityHidden ? 'MYSTERY SHADOW FIGHT' : item.matchName,
    matchFighterA: identityHidden ? 'MYSTERY RED CORNER' : item.matchFighterA,
    matchFighterB: identityHidden ? 'MYSTERY BLUE CORNER' : item.matchFighterB,
    fighterAId: identityHidden ? null : item.fighterAId,
    fighterBId: identityHidden ? null : item.fighterBId,
    fighterA: identityHidden ? null : item.fighterA,
    fighterB: identityHidden ? null : item.fighterB,
    fighterAImage: identityHidden ? '' : item.fighterAImage,
    fighterBImage: identityHidden ? '' : item.fighterBImage,
    promotionBackground: identityHidden ? '' : item.promotionBackground,
    fightPosterImage: identityHidden ? '' : (item.fightPosterImage || item.promotionBackground || ''),
    fightPosterMobileImage: identityHidden ? '' : (item.fightPosterMobileImage || item.fightPosterImage || item.promotionBackground || ''),
    matchDescription: identityHidden ? 'Archived mystery fight. Competitor identities reveal after entry.' : item.matchDescription,
    matchType: item.matchType,
    matchTokens: item.matchTokens,
    entryFee,
    entryFeeTokens: entryFee,
    pot: prizePool,
    prizePool,
    entryCount,
    playerCount: entryCount,
    matchDate: item.matchDate,
    matchDateKey: item.matchDateKey,
    matchTime: item.matchTime,
    venue: item.venue,
    maxRounds: item.maxRounds,
    aiScoutingReport: !identityHidden && item.aiScoutingReport && typeof item.aiScoutingReport === 'object' ? item.aiScoutingReport : null,
    isShadow: sourceType === 'shadow' || String(item.matchType || '').toLowerCase() === 'shadow',
    shadowIdentityHidden: identityHidden,
    shadowAutoPublished: Boolean(item.shadowAutoPublished),
    shadowPublishedAt: item.shadowPublishedAt || null,
    shadowExpiresAt: item.shadowExpiresAt || null,
    shadowLastUsedAt: item.shadowLastUsedAt || null,
    homepagePromoted: Boolean(item.homepagePromoted),
    featuredThisWeek: Boolean(item.featuredThisWeek),
    featuredFight: Boolean(item.featuredFight),
    featuredThisWeekImage: identityHidden ? '' : (item.featuredThisWeekImage || ''),
    featuredFightBackgroundImage: identityHidden ? '' : (item.featuredFightBackgroundImage || ''),
    featuredFightFighterAImage: identityHidden ? '' : (item.featuredFightFighterAImage || ''),
    featuredFightFighterBImage: identityHidden ? '' : (item.featuredFightFighterBImage || ''),
    division: item.division || item.weightClass || '',
    weightClass: item.weightClass || item.division || '',
    homepagePromotionRank: Number(item.homepagePromotionRank || 0),
    homepagePromotion: {
      isPromoted: Boolean(item.homepagePromoted),
      rank: Number(item.homepagePromotionRank || 0),
      title: item.homepagePromotionTitle || '',
      subtitle: item.homepagePromotionSubtitle || '',
      ctaLabel: item.homepagePromotionCtaLabel || '',
      posterImage: identityHidden ? '' : (item.fightPosterImage || item.promotionBackground || ''),
      mobilePosterImage: identityHidden ? '' : (item.fightPosterMobileImage || item.fightPosterImage || item.promotionBackground || ''),
      startsAt: item.homepagePromotionStartsAt || null,
      endsAt: item.homepagePromotionEndsAt || null,
      calendarSource: item.homepagePromotionCalendarSource || '',
      externalSourceUrl: item.homepagePromotionExternalSourceUrl || '',
      updatedAt: item.homepagePromotionUpdatedAt || null,
    },
    matchStatus: item.matchStatus,
    matchShadowStatus: item.matchShadowStatus,
    matchShadowOpenStatus: item.matchShadowOpenStatus,
    affiliateId: item.affiliateId,
    AffiliateIds: item.AffiliateIds,
    timelineBucket: getFightTimelineBucket(item),
    publicTimelineBucket: getFightTimelineBucket(item),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function calculateClassicPredictionPoints(userPrediction = [], fighterOneStats = [], fighterTwoStats = [], matchCategory = '') {
  if (!Array.isArray(userPrediction) || !Array.isArray(fighterOneStats) || !Array.isArray(fighterTwoStats)) return 0;
  const combatCategory = normalizeCombatCategory(matchCategory);

  return userPrediction.reduce((totalScore, roundPrediction, index) => {
    const fighterOneRound = fighterOneStats[index];
    const fighterTwoRound = fighterTwoStats[index];
    if (!fighterOneRound || !fighterTwoRound || !roundPrediction) return totalScore;

    let roundScore = 0;
    const addIfUnderOrEqual = (predictionValue, actualValue) => {
      const prediction = Number(predictionValue);
      const actual = Number(actualValue);
      if (Number.isFinite(prediction) && Number.isFinite(actual) && prediction <= actual) roundScore += prediction;
    };
    const addIfEqualPrediction = (predictionValue, actualValue, scoreValue = predictionValue) => {
      const prediction = Number(predictionValue);
      const actual = Number(actualValue);
      const score = Number(scoreValue);
      if (Number.isFinite(prediction) && Number.isFinite(actual) && prediction === actual && Number.isFinite(score)) roundScore += score;
    };

    if (combatCategory === 'boxing') {
      addIfUnderOrEqual(roundPrediction.hpPrediction1, fighterOneRound.HP);
      addIfUnderOrEqual(roundPrediction.bpPrediction1, fighterOneRound.BP);
      addIfUnderOrEqual(roundPrediction.tpPrediction1, fighterOneRound.TP);
      addIfEqualPrediction(roundPrediction.rwPrediction1, fighterOneRound.RW);
      addIfEqualPrediction(roundPrediction.koPrediction1, fighterOneRound.KO, fighterOneRound.KO);
      addIfUnderOrEqual(roundPrediction.hpPrediction2, fighterTwoRound.HP);
      addIfUnderOrEqual(roundPrediction.bpPrediction2, fighterTwoRound.BP);
      addIfUnderOrEqual(roundPrediction.tpPrediction2, fighterTwoRound.TP);
      addIfEqualPrediction(roundPrediction.rwPrediction2, fighterTwoRound.RW);
      addIfEqualPrediction(roundPrediction.koPrediction2, fighterTwoRound.KO, fighterTwoRound.KO);
    } else if (combatCategory === 'mma') {
      addIfUnderOrEqual(roundPrediction.hpPrediction1, fighterOneRound.ST);
      addIfUnderOrEqual(roundPrediction.bpPrediction1, fighterOneRound.KI);
      addIfUnderOrEqual(roundPrediction.tpPrediction1, fighterOneRound.KN);
      addIfUnderOrEqual(roundPrediction.elPrediction1, fighterOneRound.EL);
      addIfEqualPrediction(roundPrediction.rwPrediction1, fighterOneRound.RW);
      addIfEqualPrediction(roundPrediction.koPrediction1, fighterOneRound.KO, fighterOneRound.KO);
      addIfUnderOrEqual(roundPrediction.hpPrediction2, fighterTwoRound.ST);
      addIfUnderOrEqual(roundPrediction.bpPrediction2, fighterTwoRound.KI);
      addIfUnderOrEqual(roundPrediction.tpPrediction2, fighterTwoRound.KN);
      addIfUnderOrEqual(roundPrediction.elPrediction2, fighterTwoRound.EL);
      addIfEqualPrediction(roundPrediction.rwPrediction2, fighterTwoRound.RW);
      addIfEqualPrediction(roundPrediction.koPrediction2, fighterTwoRound.KO, fighterTwoRound.KO);
    }

    return totalScore + roundScore;
  }, 0);
}

function applyFightPublicVisibilityFilter(filter = {}, query = {}) {
  const draftFilter = appendNoDraftFightFilter(query);
  if (!draftFilter) return filter;
  if (filter.$and) return { ...filter, $and: [...filter.$and, ...draftFilter.$and] };
  return Object.keys(filter).length ? { $and: [filter, ...draftFilter.$and] } : draftFilter;
}

function applyFightFreshSort(query) {
  return query.sort({ updatedAt: -1, createdAt: -1, matchDate: -1, _id: -1 });
}

function applyLeanRead(query) {
  return typeof query.lean === 'function' ? query.lean() : query;
}

function applyFightFreshSortLean(query) {
  return applyLeanRead(applyFightFreshSort(query));
}

function shouldRequestPredictionEligibleFights(query = {}) {
  const values = [query.playable, query.predictionEligible, query.userPlayable, query.canPredict, query.status, query.intent]
    .map((value) => String(value || '').trim().toLowerCase());
  return values.some((value) => ['true', '1', 'yes', 'playable', 'prediction', 'predictions', 'can-predict', 'open-for-predictions', 'active-contests'].includes(value));
}

const PREDICTION_ELIGIBLE_MATCH_STATUSES = ['Scheduled', 'Open', 'Live', 'Ongoing', 'scheduled', 'open', 'live', 'ongoing', 'Active', 'active'];

function buildPredictionEligibleFightFilter() {
  return {
    $or: [
      { matchShadowOpenStatus: { $in: ['open', 'Open'] } },
      { matchStatus: { $in: PREDICTION_ELIGIBLE_MATCH_STATUSES } },
      { status: { $in: PREDICTION_ELIGIBLE_MATCH_STATUSES } },
    ],
  };
}

function isPredictionEligibleFightRecord(match = {}) {
  if (isDraftFightRecord(match)) return false;
  const normalize = (value) => String(value || '').trim().toLowerCase();
  const status = normalize(match.matchStatus || match.status);
  const openStatus = normalize(match.matchShadowOpenStatus);
  const shadowStatus = normalize(match.matchShadowStatus);
  const closedLike = ['finished', 'closed', 'completed', 'complete', 'cancelled', 'canceled'];
  if (closedLike.includes(status) || closedLike.includes(openStatus)) return false;
  if (openStatus === 'open') return true;
  if (['scheduled', 'open', 'live', 'ongoing', 'active'].includes(status)) return true;
  if (shadowStatus === 'active' && !closedLike.includes(openStatus)) return true;
  // Legacy fights often miss a normalized status but are still playable if they
  // are not explicitly closed/draft and have enough card data to submit picks.
  return Boolean(match.matchFighterA && match.matchFighterB && !status && !openStatus);
}


async function updateFightVideoFields(Model, id, body = {}) {
  const update = {};
  if (isProvidedValue(body.matchVideoUrl)) update.matchVideoUrl = body.matchVideoUrl;
  if (isProvidedValue(body.videoUrl)) update.matchVideoUrl = body.videoUrl;
  if (isProvidedValue(body.matchPromotionalVideoUrl)) update.matchPromotionalVideoUrl = body.matchPromotionalVideoUrl;
  if (isProvidedValue(body.promotionalVideoUrl)) update.matchPromotionalVideoUrl = body.promotionalVideoUrl;
  if (!Object.keys(update).length) {
    const error = new Error('At least one video URL is required');
    error.statusCode = 400;
    throw error;
  }
  const updatedMatch = await Model.findByIdAndUpdate(id, update, { new: true });
  if (!updatedMatch) {
    const error = new Error('Fight not found');
    error.statusCode = 404;
    throw error;
  }
  return updatedMatch;
}

async function updateFightScoringFields(Model, id, body = {}) {
  const match = await Model.findById(id);
  if (!match) {
    const error = new Error('Fight not found');
    error.statusCode = 404;
    throw error;
  }
  applyRoundResultsToMatch(match, body);
  await match.save();
  return match;
}

const builder = new xml2js.Builder({
  headless: true,
  rootName: 'createTransactionRequest', // Set the root element name
  renderOpts: { pretty: false },
  xmldec: { version: '1.0', encoding: 'UTF-8' }
});
// File upload configuration
// Keep memory storage because existing Cloudinary upload streams depend on buffers,
// but add conservative limits so a single oversized request cannot exhaust memory.
const MAX_UPLOAD_FILE_SIZE_BYTES = Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 15 * 1024 * 1024);
const MAX_UPLOAD_FILES_PER_REQUEST = Number(process.env.MAX_UPLOAD_FILES_PER_REQUEST || 10);
const storage = multer.memoryStorage();

// The declared Content-Type is a client-supplied string, so it decides nothing.
// The old filter accepted anything labelled image/*, anything labelled
// application/octet-stream, and anything with no type at all — which is every
// file. These uploads land in Cloudinary on our account and are served from a
// URL we hand to browsers, so an SVG carrying a <script> is stored XSS and a
// disguised binary is our storage bill. Signatures are checked instead.
const IMAGE_SIGNATURES = [
  { ext: 'jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp', bytes: [0x42, 0x4d] },
];

const sniffImageType = (buffer) => {
  if (!buffer || buffer.length < 12) return null;
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) return signature.ext;
  }
  // RIFF....WEBP
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  // HEIC/HEIF: ....ftyp<brand>
  if (buffer.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.slice(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1', 'avif'].includes(brand)) return 'heic';
  }
  return null;
};

const rawUpload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
    files: MAX_UPLOAD_FILES_PER_REQUEST,
  },
  fileFilter: (req, file, callback) => {
    // Cheap pre-filter only. The real check is on the bytes, below.
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (mimeType === 'image/svg+xml' || mimeType === 'text/html') {
      const error = new Error('SVG and HTML uploads are not accepted.');
      error.statusCode = 415;
      error.code = 'UNSUPPORTED_UPLOAD_TYPE';
      return callback(error);
    }
    return callback(null, true);
  },
});

const collectUploadedFiles = (req) => {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((group) => {
      if (Array.isArray(group)) files.push(...group);
    });
  }
  return files.filter(Boolean);
};

const validateUploadedImages = (req, res, next) => {
  const files = collectUploadedFiles(req);
  for (const file of files) {
    const kind = sniffImageType(file.buffer);
    if (!kind) {
      return res.status(415).json({
        message: 'Only real image files are accepted (JPEG, PNG, GIF, BMP, WebP or HEIC).',
        code: 'UNSUPPORTED_UPLOAD_TYPE',
        field: file.fieldname,
      });
    }
    // Record what it actually is, so downstream code never trusts the label.
    file.detectedType = kind;
  }
  return next();
};

// Wrapped so every existing call site — upload.single, upload.fields, upload.array
// — validates bytes without touching ~15 route definitions.
const chainUpload = (middleware) => (req, res, next) => middleware(req, res, (error) => {
  if (error) return next(error);
  return validateUploadedImages(req, res, next);
});

const upload = {
  single: (...args) => chainUpload(rawUpload.single(...args)),
  fields: (...args) => chainUpload(rawUpload.fields(...args)),
  array: (...args) => chainUpload(rawUpload.array(...args)),
  any: (...args) => chainUpload(rawUpload.any(...args)),
  none: (...args) => rawUpload.none(...args),
};
const shadowSchema = new mongoose.Schema({
  matchCategory: String, // 'boxing' or 'mma'
  matchCategoryTwo: String,
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  // Optional normalized fighter references. Existing string/image fields remain fallback.
  fighterAId: { type: mongoose.Schema.Types.ObjectId, ref: 'CombatFighter' },
  fighterBId: { type: mongoose.Schema.Types.ObjectId, ref: 'CombatFighter' },
  promotionBackground: String,
  fightPosterImage: String,
  fightPosterMobileImage: String,
  matchDescription: String,
  matchVideoUrl: String,
  matchDate: Date,
  matchDateKey: { type: String, index: true },
  eventTimeZone: String,
  matchTime: String,
  venue: String,
  sourceMatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', index: true },
  convertedFromLiveAt: Date,
  affiliatePromotionDate: Date,
  affiliatePromotionTime: String,
  homepagePromoted: { type: Boolean, default: false, index: true },
  featuredThisWeek: { type: Boolean, default: false, index: true },
  featuredFight: { type: Boolean, default: false, index: true },
  featuredThisWeekImage: String,
  featuredFightBackgroundImage: String,
  featuredFightFighterAImage: String,
  featuredFightFighterBImage: String,
  division: String,
  weightClass: String,
  homepagePromotionRank: { type: Number, default: 0 },
  homepageSlot: { type: Number, default: 0 },
  homepagePromotionTitle: String,
  homepagePromotionSubtitle: String,
  homepagePromotionCtaLabel: String,
  homepagePromotionStartsAt: Date,
  homepagePromotionEndsAt: Date,
  homepagePromotionCalendarSource: String,
  homepagePromotionExternalSourceUrl: String,
  homepagePromotionUpdatedAt: Date,
  homepagePromotionUpdatedBy: String,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  sourceShadowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shadow', index: true },
  activatedFromShadowAt: Date,
  matchTokens: { type: Number, min: 0, default: 0 },
  pot: { type: Number, min: 0, default: 0 },
  // The prize is declared up front and never grows with entries, so the platform
  // must not promise more than the entries can cover. Below this many paid
  // entrants the contest voids and everyone is refunded, which is what keeps the
  // house off the hook for the shortfall.
  minimumEntrants: { type: Number, min: 0, default: 0 },
  autoRefundIfShort: { type: Boolean, default: true },
  // Set by the shortfall sweep so a warning is sent once, not on every pass.
  shortfallPromoterWarnedAt: Date,
  shortfallPlayersWarnedAt: Date,
  voidedAt: Date,
  voidReason: String,
  collectedFees: { type: Number, min: 0, default: 0 },
  projectedEntrants: { type: Number, min: 0, default: 0 },
  platformContribution: { type: Number, min: 0, default: 0 },
  maxRounds: Number,
  fighterAImageDeleteUrl: String, // ImgBB delete URL for Fighter A's image
  fighterBImageDeleteUrl: String, 
  promotionBackgroundDeleteUrl: String,
  fightPosterImageDeleteUrl: String,
  fightPosterMobileImageDeleteUrl: String,
  matchStatus: { type: String, enum: ['Finished', 'Ongoing', 'Draft', 'Scheduled', 'Live', 'Open', 'Closed'], default: 'Ongoing' },
  matchShadowStatus: { type: String, enum: ['active', 'inactive', 'draft'], default: 'active' },
  matchShadowOpenStatus: { type: String, enum: ['open', 'closed'], default: 'open' },
  shadowIdentityHidden: { type: Boolean, default: false, index: true },
  shadowAutoPublished: { type: Boolean, default: false, index: true },
  shadowPublishedAt: Date,
  shadowExpiresAt: Date,
  shadowLastUsedAt: { type: Date, index: true },
  shadowOriginalMatchDate: Date,
  aiScoutingReport: mongoose.Schema.Types.Mixed,
  
  // Boxing-specific stats
  BoxingMatch: {
    fighterOneStats: [{
      roundNumber: Number,
      HP: Number,
      BP: Number,
      TP: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
    }],
    fighterTwoStats: [{
      roundNumber: Number,
      HP: Number,
      BP: Number,
      TP: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
    }],
  },

  // MMA-specific stats
  MMAMatch: {
    fighterOneStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
   }],
    fighterTwoStats: [{
      roundNumber: Number,
      ST: Number,
      KI: Number,
      KN: Number,
      EL: Number,
      RW: Number,
      RL: Number,
      KO: Number,
      SP: Number,
   }],
  },

  // Prize settlement bookkeeping
  prizesSettledAt: Date,
  prizePoolPaid: Number,
  houseCutTaken: Number,
  // Shadow Fight pot target — the promoter stakes a pot and only earns once
  // entries have covered it (owner's rule: he waits for the pot to fill first).
  potTarget: { type: Number, default: 0 },
  promoterStake: { type: Number, default: 0 },
  profitZoneReachedAt: Date,
  userPredictions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    predictionStatus: { type: String, enum: ['submitted', 'notSubmitted'], default: 'notSubmitted' }
  }],

  // Add AffiliateIds as an array of objects
  AffiliateIds: [
    {
      AffiliateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Affiliate', // Reference to the Affiliate schema
      },
      matchId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Match', // Reference to the Match schema (or appropriate schema for matches)
      }
    }
  ]
});
shadowSchema.index({ matchStatus: 1, matchShadowOpenStatus: 1, updatedAt: -1 });
shadowSchema.index({ matchDate: -1, updatedAt: -1 });
shadowSchema.index({ homepagePromoted: 1, homepagePromotionRank: -1, matchDate: 1, updatedAt: -1 });
shadowSchema.index({ featuredThisWeek: 1, matchDate: 1 });
shadowSchema.index({ featuredFight: 1, matchDate: 1 });
shadowSchema.index({ fighterAId: 1, fighterBId: 1 });
shadowSchema.pre('save', function cacheInitialShadowScoutingReport(next) {
  if (!this.aiScoutingReport) {
    const report = buildTemplateScoutingReport(buildScoutingPayload(this.toObject ? this.toObject() : this, []));
    if (report) this.aiScoutingReport = report;
  }
  next();
});


const Shadow = mongoose.models.Shadow || mongoose.model('Shadow', shadowSchema);
app.post('/compare-matches', verifyAdminToken, async (req, res) => {
  try {
      const matches = await Match.find({ shadowTemplatesAdditionStatus: false });
      const shadows = await Shadow.find();

      let updatedCount = 0;

      for (const match of matches) {
          const isMatchFound = shadows.some(shadow =>
              match.matchCategory === shadow.matchCategory &&
              match.matchCategoryTwo === shadow.matchCategoryTwo &&
              match.matchName === shadow.matchName &&
              match.matchFighterA === shadow.matchFighterA &&
              match.matchFighterB === shadow.matchFighterB &&
              match.matchDescription === shadow.matchDescription
              );

          if (isMatchFound) {
              await Match.findByIdAndUpdate(match._id, { shadowTemplatesAdditionStatus: true });
              updatedCount++;
          }
      }

      res.json({ message: 'Comparison complete', updatedMatches: updatedCount });
  } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
  }
});

// Uncached admin fetch for a single fight, by id, across MMA/Boxing/wrestling
// collections. Edit screens must never read through the public-fights cache
// (clearPublicResponseCache() runs on save, but CDN/edge layers in front of
// the public route can still serve a stale copy) — this always hits the DB.
app.get('/api/admin/matches/:id', verifyAdminToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: 'Invalid fight id.' });
    const match = (await MMAMatch.findById(id).lean())
      || (await BoxingMatch.findById(id).lean())
      || (await ProWrestlingMatch.findById(id).lean());
    if (!match) return res.status(404).json({ message: 'Fight not found.' });
    res.json({ match });
  } catch (error) {
    console.error('Error loading admin match by id:', error);
    res.status(500).json({ message: 'Could not load this fight.' });
  }
});

app.post(
  '/editShadow',
  verifyAdminToken,
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' },
  ]),
  async (req, res) => {
    try {
      const {
        matchId,
        matchCategoryTwo,
        maxRounds,
        matchCategory,
        matchName,
        matchFighterA,
        matchFighterB,
        matchDescription,
        fighterAImageUrl,
        fighterBImageUrl,
        promotionBackgroundUrl,
        matchVideoUrl,
        matchDate,
        matchTime,
        venue,
        matchStatus,
        BoxingMatch,
        MMAMatch,
      } = req.body;

      let fighterAImage,
        fighterBImage,
        fighterAImageDeleteUrl,
        fighterBImageDeleteUrl,
        promotionBackgroundUrls,
        promotionBackgroundDeleteUrl;

      // Validate matchId
      if (!matchId) {
        return res.status(400).json({ error: 'matchId is required' });
      }

      // Fetch the existing match by matchId
      const existingMatch = await Shadow.findById(matchId);
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      // Use provided image URLs or handle uploads
      if (fighterAImageUrl) {
        fighterAImage = fighterAImageUrl;
      } else if (req.files.fighterAImage) {
        // Upload fighter A image to Cloudinary
        const resultA = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/fighterA' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterAImage[0].buffer);
        });

        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;

        // Delete the old image
        if (existingMatch.fighterAImageDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.fighterAImageDeleteUrl);
        }
      }

      if (fighterBImageUrl) {
        fighterBImage = fighterBImageUrl;
      } else if (req.files.fighterBImage) {
        // Upload fighter B image to Cloudinary
        const resultB = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/fighterB' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterBImage[0].buffer);
        });

        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;

        // Delete the old image
        if (existingMatch.fighterBImageDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.fighterBImageDeleteUrl);
        }
      }

      if (promotionBackgroundUrl) {
        promotionBackgroundUrls = promotionBackgroundUrl;
      } else if (req.files.promotionBackground) {
        // Upload promotion background image to Cloudinary
        const resultBackground = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'shadow/promotionBackground' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.promotionBackground[0].buffer);
        });

        promotionBackgroundUrls = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;

        // Delete the old background image
        if (existingMatch.promotionBackgroundDeleteUrl) {
          await cloudinary.uploader.destroy(existingMatch.promotionBackgroundDeleteUrl);
        }
      }

      // Update the match object
      existingMatch.matchCategory = matchCategory || existingMatch.matchCategory;
      existingMatch.matchName = matchName || existingMatch.matchName;
      existingMatch.matchFighterA = matchFighterA || existingMatch.matchFighterA;
      existingMatch.matchFighterB = matchFighterB || existingMatch.matchFighterB;
      assignIfProvided(existingMatch, 'matchCategory', matchCategory);
      assignIfProvided(existingMatch, 'matchName', matchName);
      assignIfProvided(existingMatch, 'matchFighterA', selectedFighterPatch.matchFighterA || matchFighterA);
      assignIfProvided(existingMatch, 'matchFighterB', selectedFighterPatch.matchFighterB || matchFighterB);
      assignIfProvided(existingMatch, 'matchDescription', matchDescription);
      assignIfProvided(existingMatch, 'maxRounds', maxRounds);
      assignIfProvided(existingMatch, 'matchCategoryTwo', matchCategoryTwo);
      assignIfProvided(existingMatch, 'matchVideoUrl', matchVideoUrl);
      if (matchDate !== undefined && matchDate !== null && matchDate !== '') {
        const normalizedDate = normalizeCalendarDateInput(matchDate);
        if (!normalizedDate.date) return res.status(400).json({ error: 'A valid match date is required.' });
        existingMatch.matchDate = normalizedDate.date;
        existingMatch.matchDateKey = normalizedDate.key;
      }
      assignIfProvided(existingMatch, 'matchTime', matchTime);
      assignIfProvided(existingMatch, 'venue', venue);
      assignIfProvided(existingMatch, 'matchStatus', matchStatus);

      const parsedShadowBoxingMatch = parseMaybeJson(BoxingMatch);
      const parsedShadowMMAMatch = parseMaybeJson(MMAMatch);
      if (parsedShadowBoxingMatch) existingMatch.BoxingMatch = parsedShadowBoxingMatch;
      if (parsedShadowMMAMatch) existingMatch.MMAMatch = parsedShadowMMAMatch;

      if (fighterAImage) existingMatch.fighterAImage = fighterAImage;
      if (fighterBImage) existingMatch.fighterBImage = fighterBImage;
      if (fighterAImageDeleteUrl) existingMatch.fighterAImageDeleteUrl = fighterAImageDeleteUrl;
      if (fighterBImageDeleteUrl) existingMatch.fighterBImageDeleteUrl = fighterBImageDeleteUrl;
      if (promotionBackgroundUrls) existingMatch.promotionBackground = promotionBackgroundUrls;
      if (promotionBackgroundDeleteUrl) existingMatch.promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrl;

      // Save the updated match
      const updatedMatch = await existingMatch.save();

 const notification = new Notification({
      title: `Shadow Fight Updated: ${updatedMatch.matchName}`,
    });
    await notification.save();
      clearPublicResponseCache();
      res.status(200).json({
        message: 'Match updated successfully',
        matchId: updatedMatch._id,
      });
    } catch (error) {
      console.error('Error updating match:', error);
      res.status(500).json({ error: 'An error occurred while updating the match' });
    }
  }
);


app.post('/finishShadow/:matchId', verifyAdminToken, async (req, res) => {
  try {
    const { matchId } = req.params;

    // Find the match by ID and update the status to 'Finished'
    const match = await Shadow.findByIdAndUpdate(
      matchId, 
      { matchStatus: 'Finished' }, 
      { new: true } // This option returns the updated document
    );

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const swarmAutomation = await app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'fight_result_updated',
      vertical: 'combat',
      sourceEntity: {
        type: 'combat_match',
        id: String(match._id),
        label: match.matchName || `${match.matchFighterA || ''} vs ${match.matchFighterB || ''}`.trim(),
      },
      input: {
        matchId: String(match._id),
        matchName: match.matchName,
        title: match.matchName,
        fighterA: match.matchFighterA,
        fighterB: match.matchFighterB,
        matchStatus: match.matchStatus,
        matchDate: match.matchDate,
        matchTime: match.matchTime,
      },
      metadata: { route: '/finishMatch/:matchId', action: 'legacy-fight-result-updated' },
      reason: 'fight-finished-in-backend',
    }).catch((error) => ({ ok: false, warning: 'Fight finished but swarm automation event failed.', error: error.message }));
    res.json({ message: 'Match status updated to Finished', match, automation: swarmAutomation || null });
  } catch (error) {
    console.error('Error finishing match:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/shadow/addShadowRoundResults/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  const { fighterOneStats, fighterTwoStats } = req.body;

  try {
    // Find the match document
    const match = await Shadow.findById(id);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    // Apply round results without deriving TP/total punches from HP/BP.
    try {
      applyRoundResultsToMatch(match, { fighterOneStats, fighterTwoStats });
    } catch (scoringError) {
      return res.status(scoringError.statusCode || 400).json({ message: scoringError.message });
    }

    // Save the updated match document
    await match.save();

    res.status(200).json({ message: 'Round results added successfully', match });
  } catch (error) {
    console.error('Error adding round results:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});





app.post('/updateShadowVideo', verifyAdminToken, async (req, res) => {
  const { matchId, matchVideoUrl } = req.body;

  // Basic validation
  if (!matchId || !matchVideoUrl) {
    return res.status(400).json({ message: 'matchId and matchVideoUrl are required' });
  }

  try {
    // Find the match by matchId and update the matchVideoUrl if it exists, otherwise create a new one
    const updatedMatch = await Shadow.findOneAndUpdate(
      { _id: matchId }, 
      { matchVideoUrl }, // Update the matchVideoUrl
      { new: true, upsert: true } // new: return the updated document, upsert: create if not found
    );

    res.status(200).json({
      message: 'Match video URL updated successfully',
      updatedMatch,
    });
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({ message: 'An error occurred while updating the match' });
  }
});

app.delete('/shadowfighttodelete/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for Shadow ID:', id);

  try {
    // Fetch the shadow fight by ID
    const shadowFight = await Shadow.findById(id);
    
    if (!shadowFight) {
      return res.status(404).json({ message: 'Shadow fight not found' });
    }

 const notification = new Notification({
      title: `Shadow Fight Deleted: ${shadowFight.matchName}`,
    });
    await notification.save();

    const deleteFromCloudinary = async (publicId) => {
      if (publicId) {
        await cloudinary.uploader.destroy(publicId);
      }
    };

    await Promise.all([
      deleteFromCloudinary(shadowFight.fighterAImageDeleteUrl),
      deleteFromCloudinary(shadowFight.fighterBImageDeleteUrl),
      deleteFromCloudinary(shadowFight.promotionBackgroundDeleteUrl),
    ]);

    // Delete the shadow fight from the database
    await Shadow.findByIdAndDelete(id);

    res.status(200).json({ message: 'Shadow fight and associated images deleted successfully' });
  } catch (error) {
    console.error('Error deleting shadow fight:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get Matches API
app.get('/shadow', async (req, res) => {
  try {
    const requestedLimit = Math.max(0, Math.min(500, Number(req.query.limit) || 0));
    const compact = String(req.query.compact || '').toLowerCase();
    let shadowQuery = Shadow.find();
   …212152 tokens truncated…onst allowed = SEASON_CALL_CATEGORIES[family] || {};
        const calledCategory = String(raw?.calledCategory || '').trim().toUpperCase();
        const calledValue = Math.max(0, Math.round(Number(raw?.calledValue) || 0));
        if (calledCategory && !allowed[calledCategory]) {
          throw teamError(422, `${calledCategory} is not a category for that bout.`, 'BAD_CALL_CATEGORY');
        }

        picks.push({
          fightId,
          fighterName: fighterName.slice(0, 120),
          matchKey: key,
          calledCategory: calledCategory && calledValue > 0 ? calledCategory : '',
          calledValue: calledCategory && calledValue > 0 ? calledValue : 0,
        });
      }

      const existing = await withFightSession(TeamEntry.findOne({ contestId, userId }), session).lean();
      if (existing) throw teamError(409, 'You already have a team in this contest.', 'ALREADY_ENTERED');

      if (fee > 0) {
        const before = fightTokenBalance(user.tokens);
        if (before < fee) {
          throw teamError(402, 'Not enough FM coins for this contest.', 'INSUFFICIENT_FUNDS', {
            balance: before, entryFee: fee, shortfall: fee - before,
          });
        }
        user.tokens = String(before - fee);
        await user.save({ session });
        await recordWalletMove({
          userId, amount: -fee, balanceBefore: before, balanceAfter: before - fee,
          reason: 'team_entry', reference: `team:${contestId}:${userId}`,
          meta: { contestId, contestName: contest.name }, session,
        });
        await TeamContest.updateOne({ _id: contestId }, { $inc: { prizePool: fee } }, session ? { session } : undefined);
      }

      const [entry] = await TeamEntry.create([{
        contestId, userId, picks, entryFeePaid: fee,
        idempotencyKey: `team:${contestId}:${userId}`,
      }], session ? { session } : undefined);

      return { entry, contest, user, fee };
    });

    sendMoneyNotice({
      to: result.user.email,
      subject: `Your team is in — ${result.contest.name}`,
      heading: 'TEAM LOCKED IN',
      lines: [
        `Your ${result.entry.picks.length} fighters are set for <strong>${escapeHtml(result.contest.name)}</strong>.`,
        result.entry.picks.map((pick) => `<strong>${escapeHtml(pick.fighterName)}</strong>${pick.calledCategory ? ` — called ${pick.calledValue}` : ''}`).join('<br>'),
        result.fee > 0 ? `Entry: ${result.fee.toLocaleString()} FM.` : 'Free entry.',
        'Your score is what all of them do on the night, added together.',
      ],
    });

    return res.status(201).json({
      ok: true,
      entryId: result.entry._id,
      contestName: result.contest.name,
      picks: result.entry.picks.map((pick) => ({
        fightId: pick.fightId, fighterName: pick.fighterName,
        calledCategory: pick.calledCategory, calledValue: pick.calledValue,
      })),
      entryFeePaid: result.fee,
    });
  } catch (error) {
    const status = error?.status || 500;
    if (status >= 500) console.error('Team entry failed:', error);
    return res.status(status).json({
      ok: false,
      message: error?.message || 'Could not lock in that team.',
      code: error?.code || 'TEAM_ENTRY_FAILED',
      ...(error?.extra || {}),
    });
  }
});

// --------------------------------------------------------------------------
// SETTLEMENT — a plain total, because every fighter was scored by the same
// rules. Claimed atomically before any money moves.
// --------------------------------------------------------------------------
const settleTeamContest = async (contestId) => {
  const claimed = await TeamContest.findOneAndUpdate(
    { _id: contestId, status: { $in: ['OPEN', 'LOCKED'] } },
    { $set: { status: 'SETTLED', settledAt: new Date() } },
    { new: true },
  );
  if (!claimed) {
    const current = await TeamContest.findById(contestId).select('status settledAt').lean();
    return { alreadySettled: true, status: current?.status || null };
  }

  const entries = await TeamEntry.find({ contestId: String(contestId) });
  if (!entries.length) return { settled: 0, entrants: 0 };

  for (const entry of entries) {
    let total = 0;
    entry.picks.forEach((pick) => {
      const actual = Number((pick.categoryTotals || {})[pick.calledCategory]) || 0;
      const hit = Boolean(pick.calledCategory) && pick.calledValue > 0 && pick.calledValue <= actual;
      pick.callHit = hit;
      pick.callBonus = hit ? Math.min(pick.calledValue, TEAM_CALL_BONUS_CAP) : 0;
      total += pick.points + pick.callBonus;
    });
    entry.totalPoints = total;
    entry.settled = true;
    entry.markModified('picks');
    await entry.save();
  }

  const scored = entries
    .map((entry) => ({ userId: String(entry.userId), points: entry.totalPoints }))
    .sort((a, b) => b.points - a.points);

  // A single paid entrant has no field to beat, so the entry goes back rather
  // than a prize being paid out of their own money.
  const paid = entries.filter((entry) => Number(entry.entryFeePaid) > 0);
  let refundedNoField = false;
  if (paid.length === 1) {
    refundedNoField = true;
    const solo = paid[0];
    try {
      const user = await User.findById(solo.userId).select('tokens email');
      if (user) {
        const before = fightTokenBalance(user.tokens);
        user.tokens = String(before + solo.entryFeePaid);
        await user.save();
        await recordWalletMove({
          userId: solo.userId, amount: solo.entryFeePaid, balanceBefore: before,
          balanceAfter: before + solo.entryFeePaid, reason: 'team_refund_no_field',
          reference: `team:solo-refund:${contestId}:${solo.userId}`,
          meta: { contestId: String(contestId) },
        });
        if (user.email) {
          sendMoneyNotice({
            to: user.email,
            subject: `${claimed.name} — refunded, not enough entrants`,
            heading: 'CONTEST REFUNDED',
            lines: [
              `<strong>${escapeHtml(claimed.name)}</strong> finished with only one paid team, so there was no field to score against.`,
              `Your ${solo.entryFeePaid.toLocaleString()} FM entry has been returned in full.`,
            ],
          });
        }
      }
    } catch (error) {
      console.error('Solo-entrant team refund failed:', error);
    }
  }

  let payout = null;
  const prizePool = refundedNoField ? 0 : Math.max(0, Math.round(Number(claimed.prizePool) || 0));
  if (refundedNoField) payout = { prizePool: 0, paid: 0, refunded: true };
  if (prizePool > 0) {
    const { awards } = buildPrizeAwards(scored, prizePool);
    let totalPaid = 0;
    for (const award of awards) {
      if (!award?.amount || award.amount <= 0) continue;
      const winner = await User.findById(award.userId).select('email tokens');
      if (!winner) continue;
      const before = fightTokenBalance(winner.tokens);
      winner.tokens = String(before + award.amount);
      await winner.save();
      await recordWalletMove({
        userId: award.userId, amount: award.amount, balanceBefore: before,
        balanceAfter: before + award.amount, reason: 'team_prize',
        reference: `team:prize:${contestId}:${award.userId}`,
        meta: { contestId, place: award.place },
      });
      totalPaid += award.amount;
      if (winner.email) {
        sendMoneyNotice({
          to: winner.email,
          subject: `${claimed.name} — you finished #${award.place}`,
          heading: `TEAM RESULT · #${award.place}`,
          lines: [
            `<strong>${escapeHtml(claimed.name)}</strong> has been settled.`,
            `<strong>${award.amount.toLocaleString()} FM</strong> has been added to your wallet.`,
          ],
        });
      }
    }
    payout = { prizePool, paid: totalPaid };
  }

  let awardsGiven = null;
  try {
    awardsGiven = await awardNonCashPrizes(contestId, scored, { matchFighterA: claimed.name, matchFighterB: 'Team Card' });
  } catch (error) {
    console.error('Team non-cash awards failed:', error);
    awardsGiven = { error: 'AWARDS_FAILED' };
  }

  clearPublicResponseCache();
  return { settled: entries.length, entrants: entries.length, payout, awardsGiven };
};

app.post('/api/admin/team-contests/:contestId/settle', verifyAdminToken, async (req, res) => {
  try {
    const summary = await settleTeamContest(String(req.params.contestId || '').trim());
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) {
    console.error('Team settle failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not settle that contest.' });
  }
});

// Auto-settles a card once every bout on it has been scored, so the result lands
// the same night rather than waiting for an admin to remember.
app.get('/api/cron/team-contests/settle', verifyCronSecret, async (req, res) => {
  try {
    const live = await TeamContest.find({ status: { $in: ['OPEN', 'LOCKED'] } }).select('_id name fightIds').limit(40).lean();
    const settled = [];
    for (const contest of live) {
      const ids = (contest.fightIds || []).filter((id) => mongoose.isValidObjectId(id));
      if (!ids.length) continue;
      const fights = await Match.find({ _id: { $in: ids } }).select('prizesSettledAt').lean();
      // Every bout must be settled — a partial card would score an incomplete team.
      if (fights.length !== ids.length || !fights.every((fight) => fight.prizesSettledAt)) continue;
      try {
        const summary = await settleTeamContest(String(contest._id));
        settled.push({ id: contest._id, name: contest.name, ...summary });
      } catch (error) {
        console.error('Team auto-settle failed for', String(contest._id), error.message);
      }
    }
    return res.json({ ok: true, examined: live.length, settled });
  } catch (error) {
    console.error('Team settle sweep failed:', error);
    return res.status(500).json({ ok: false, message: 'Team sweep failed.' });
  }
});

// --------------------------------------------------------------------------
// ADMIN + PROMOTER
// --------------------------------------------------------------------------
app.post('/api/admin/team-contests', verifyAdminToken, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const fightIds = (Array.isArray(req.body?.fightIds) ? req.body.fightIds : [])
      .map((id) => String(id).trim()).filter((id) => mongoose.isValidObjectId(id));
    if (!name) return res.status(422).json({ ok: false, message: 'A contest name is required.' });

    const picksRequired = Math.max(2, Math.min(10, Math.round(Number(req.body?.picksRequired) || TEAM_PICKS_REQUIRED)));
    // The one-fighter-per-bout rule means the card needs at least as many bouts
    // as picks, or the contest is impossible to enter.
    if (fightIds.length < picksRequired) {
      return res.status(422).json({
        ok: false,
        message: `A ${picksRequired}-pick contest needs at least ${picksRequired} bouts on the card.`,
        code: 'NOT_ENOUGH_BOUTS',
      });
    }

    const contest = await TeamContest.create({
      name: name.slice(0, 120),
      eventName: String(req.body?.eventName || '').slice(0, 120),
      fightIds: [...new Set(fightIds)],
      picksRequired,
      entryFee: Math.max(0, Math.round(Number(req.body?.entryFee) || 0)),
      affiliateId: String(req.body?.affiliateId || '').trim(),
    });
    return res.status(201).json({ ok: true, contestId: contest._id });
  } catch (error) {
    console.error('Team contest create failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not create that contest.' });
  }
});

app.post('/api/admin/team-contests/:contestId/void', verifyAdminToken, async (req, res) => {
  try {
    const contest = await TeamContest.findById(String(req.params.contestId || '')).lean();
    if (!contest) return res.status(404).json({ ok: false, message: 'Contest not found.' });
    if (contest.status === 'SETTLED') {
      return res.status(409).json({ ok: false, message: 'That contest is already settled.' });
    }
    const entries = await TeamEntry.find({ contestId: String(contest._id), entryFeePaid: { $gt: 0 } }).lean();
    for (const entry of entries) {
      try {
        const user = await User.findById(entry.userId).select('tokens email');
        if (!user) continue;
        const before = fightTokenBalance(user.tokens);
        user.tokens = String(before + entry.entryFeePaid);
        await user.save();
        await recordWalletMove({
          userId: entry.userId, amount: entry.entryFeePaid, balanceBefore: before,
          balanceAfter: before + entry.entryFeePaid, reason: 'team_refund',
          reference: `team:refund:${contest._id}:${entry.userId}`,
          meta: { contestId: String(contest._id) },
        });
        if (user.email) {
          sendMoneyNotice({
            to: user.email,
            subject: `${contest.name} was cancelled — you have been refunded`,
            heading: 'CONTEST CANCELLED',
            lines: [
              `<strong>${escapeHtml(contest.name)}</strong> has been cancelled.`,
              `Your ${entry.entryFeePaid.toLocaleString()} FM entry has been returned in full.`,
            ],
          });
        }
      } catch (error) {
        console.error('Team refund failed for', String(entry.userId), error.message);
      }
    }
    await TeamContest.updateOne({ _id: contest._id }, {
      $set: { status: 'VOID', voidReason: String(req.body?.reason || 'Cancelled by an administrator.').slice(0, 300) },
    });
    return res.json({ ok: true, refunded: entries.length });
  } catch (error) {
    console.error('Team void failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not cancel that contest.' });
  }
});

// A promoter runs a Team Card for their own league.
app.post('/api/affiliates/me/team-contests', requireTeamCards, verifyToken, requireScope(TOKEN_SCOPES.AFFILIATE), async (req, res) => {
  try {
    const affiliateId = String(req.user?.id || req.user?._id || '').trim();
    const affiliate = await Affiliate.findById(affiliateId).select('_id verified').lean();
    if (!affiliate) return res.status(404).json({ ok: false, message: 'Affiliate account not found.' });
    if (!affiliate.verified) {
      return res.status(403).json({ ok: false, message: 'Your league must be approved before you can run contests.', code: 'NOT_VERIFIED' });
    }

    const name = String(req.body?.name || '').trim();
    const fightIds = (Array.isArray(req.body?.fightIds) ? req.body.fightIds : [])
      .map((id) => String(id).trim()).filter((id) => mongoose.isValidObjectId(id));
    const picksRequired = Math.max(2, Math.min(10, Math.round(Number(req.body?.picksRequired) || TEAM_PICKS_REQUIRED)));
    if (!name) return res.status(422).json({ ok: false, message: 'Name your contest.' });
    if (fightIds.length < picksRequired) {
      return res.status(422).json({ ok: false, message: `Pick at least ${picksRequired} bouts for a ${picksRequired}-pick contest.`, code: 'NOT_ENOUGH_BOUTS' });
    }

    const contest = await TeamContest.create({
      name: name.slice(0, 120),
      eventName: String(req.body?.eventName || '').slice(0, 120),
      fightIds: [...new Set(fightIds)],
      picksRequired,
      entryFee: Math.max(0, Math.round(Number(req.body?.entryFee) || 0)),
      affiliateId,
    });
    return res.status(201).json({ ok: true, contestId: contest._id });
  } catch (error) {
    console.error('Promoter team contest create failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not create that contest.' });
  }
});

// --------------------------------------------------------------------------
// PLAYER READS
// --------------------------------------------------------------------------
app.get('/api/team-contests/open', requireTeamCards, async (req, res) => {
  try {
    const contests = await TeamContest.find({ status: 'OPEN' }).sort({ createdAt: -1 }).limit(20).lean();
    const allFightIds = [...new Set(contests.flatMap((contest) => contest.fightIds || []))]
      .filter((id) => mongoose.isValidObjectId(id));
    const fights = allFightIds.length
      ? await Match.find({ _id: { $in: allFightIds } })
        .select('matchFighterA matchFighterB matchDate matchCategory maxRounds matchStatus').lean()
      : [];
    const fightById = new Map(fights.map((row) => [String(row._id), row]));

    return res.json({
      ok: true,
      callCategories: SEASON_CALL_CATEGORIES,
      callBonusCap: TEAM_CALL_BONUS_CAP,
      contests: await Promise.all(contests.map(async (contest) => ({
        id: contest._id,
        name: contest.name,
        eventName: contest.eventName,
        entryFee: contest.entryFee,
        prizePool: contest.prizePool,
        picksRequired: contest.picksRequired,
        promoted: Boolean(contest.affiliateId),
        entrants: await TeamEntry.countDocuments({ contestId: String(contest._id) }),
        bouts: (contest.fightIds || []).map((id) => {
          const bout = fightById.get(String(id));
          if (!bout) return null;
          return {
            fightId: String(id),
            fighterA: bout.matchFighterA,
            fighterB: bout.matchFighterB,
            category: bout.matchCategory,
            rounds: bout.maxRounds,
            date: bout.matchDate,
            open: isFightOpenForEntry(bout),
          };
        }).filter(Boolean),
      }))),
    });
  } catch (error) {
    console.error('Team contest list failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not load contests.' });
  }
});

app.get('/api/team-contests/me', requireTeamCards, verifyToken, requireScope(TOKEN_SCOPES.PLAYER), async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || '').trim();
    const entries = await TeamEntry.find({ userId }).sort({ createdAt: -1 }).limit(30).lean();
    const contestIds = [...new Set(entries.map((entry) => entry.contestId))].filter((id) => mongoose.isValidObjectId(id));
    const contests = contestIds.length ? await TeamContest.find({ _id: { $in: contestIds } }).lean() : [];
    const byId = new Map(contests.map((row) => [String(row._id), row]));

    return res.json({
      ok: true,
      teams: entries.map((entry) => {
        const contest = byId.get(String(entry.contestId));
        return {
          entryId: entry._id,
          contestId: entry.contestId,
          contestName: contest?.name || 'Team Card',
          eventName: contest?.eventName || '',
          status: contest?.status || 'OPEN',
          entryFeePaid: entry.entryFeePaid,
          totalPoints: entry.totalPoints,
          settled: entry.settled,
          scoredCount: (entry.picks || []).filter((pick) => pick.scored).length,
          picks: (entry.picks || []).map((pick) => ({
            fighterName: pick.fighterName,
            points: pick.points,
            scored: pick.scored,
            calledCategory: pick.calledCategory,
            calledValue: pick.calledValue,
            actual: Number((pick.categoryTotals || {})[pick.calledCategory]) || 0,
            callHit: pick.callHit,
            callBonus: pick.callBonus,
          })),
        };
      }),
    });
  } catch (error) {
    console.error('Team lookup failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not load your teams.' });
  }
});

app.get('/api/team-contests/:contestId/leaderboard', requireTeamCards, async (req, res) => {
  try {
    const contestId = String(req.params.contestId || '').trim();
    const entries = await TeamEntry.find({ contestId }).lean();
    const settled = entries.some((entry) => entry.settled);
    const ranked = entries
      .map((entry) => ({
        userId: entry.userId,
        // Live totals mid-card so the leaderboard moves as the night goes on.
        score: settled ? entry.totalPoints : (entry.picks || []).reduce((sum, pick) => sum + pick.points, 0),
        scoredCount: (entry.picks || []).filter((pick) => pick.scored).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);

    const users = ranked.length
      ? await User.find({ _id: { $in: ranked.map((row) => row.userId).filter((id) => mongoose.isValidObjectId(id)) } })
        .select('playerName firstName profileUrl').lean()
      : [];
    const byId = new Map(users.map((row) => [String(row._id), row]));

    return res.json({
      ok: true,
      live: !settled,
      leaderboard: ranked.map((row, index) => ({
        place: index + 1,
        name: byId.get(row.userId)?.playerName || byId.get(row.userId)?.firstName || 'Player',
        avatar: byId.get(row.userId)?.profileUrl || '',
        score: row.score,
        fightsScored: row.scoredCount,
      })),
    });
  } catch (error) {
    console.error('Team leaderboard failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not load the leaderboard.' });
  }
});

// ==========================================================================
// NON-CASH PRIZES — what makes a free contest worth winning
//
// In free-play states the entry fee is zero, so there is no consideration and no
// wager. That also means there is nothing to pay out of. Prizes here are things
// with no cash value to the player: badges, leaderboard titles, sponsor merch
// and PPV codes the sponsor funds.
//
// Deliberately kept separate from the wallet. Coins are a balance; these are
// awards. Mixing them would give the "free" coins a cash value and collapse the
// distinction the free mode depends on.
// ==========================================================================
const PRIZE_TYPES = Object.freeze(['badge', 'title', 'merch', 'ppv_code', 'sponsor_other']);
// Digital-only types need no shipping and are complete the moment they are won.
const INSTANT_PRIZE_TYPES = Object.freeze(['badge', 'title', 'ppv_code']);

const contestPrizeSchema = new mongoose.Schema({
  fightId: { type: String, required: true, index: true },
  // 1, 2, 3 … or 0 meaning "everyone who entered" (participation badges).
  place: { type: Number, required: true, min: 0 },
  type: { type: String, enum: PRIZE_TYPES, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  sponsorName: { type: String, default: '' },
  // For ppv_code: a pool of single-use codes, claimed one per winner.
  codePool: { type: [String], default: [] },
  quantity: { type: Number, default: 1, min: 1 },
  awardedCount: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const playerAwardSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  fightId: { type: String, required: true, index: true },
  prizeId: { type: String, required: true },
  type: { type: String, enum: PRIZE_TYPES, required: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  sponsorName: { type: String, default: '' },
  place: { type: Number, default: 0 },
  // Single-use code handed to this winner (ppv_code only).
  code: { type: String, default: '' },
  // Physical goods need fulfilment; digital awards are done on creation.
  fulfilment: { type: String, enum: ['not_required', 'pending', 'shipped', 'cancelled'], default: 'not_required' },
  shippingNote: { type: String, default: '' },
  // Prevents a re-run of settlement awarding the same prize twice.
  idempotencyKey: { type: String, required: true, unique: true },
}, { timestamps: true });

const ContestPrize = mongoose.models.ContestPrize || mongoose.model('ContestPrize', contestPrizeSchema);
const PlayerAward = mongoose.models.PlayerAward || mongoose.model('PlayerAward', playerAwardSchema);

// Ranks entrants by score and hands out whatever non-cash prizes the fight has
// configured. Safe to re-run: each award has an idempotency key.
const awardNonCashPrizes = async (fightId, scoredRows, fight) => {
  const prizes = await ContestPrize.find({ fightId: String(fightId), active: true }).lean();
  if (!prizes.length) return { awarded: 0, prizes: 0 };

  // Same ordering the cash prizes use, so a winner is a winner in both.
  const ranked = [...scoredRows].sort((a, b) => b.points - a.points);
  let awarded = 0;

  for (const prize of prizes) {
    const recipients = prize.place === 0
      ? ranked
      : (ranked[prize.place - 1] ? [ranked[prize.place - 1]] : []);

    for (const recipient of recipients) {
      if (prize.awardedCount >= prize.quantity && prize.place !== 0) break;

      const idempotencyKey = `award:${fightId}:${prize._id}:${recipient.userId}`;
      const existing = await PlayerAward.findOne({ idempotencyKey }).lean();
      if (existing) continue;

      // Claim one code from the pool atomically, so two winners cannot receive
      // the same PPV code.
      let code = '';
      if (prize.type === 'ppv_code') {
        const claimed = await ContestPrize.findOneAndUpdate(
          { _id: prize._id, 'codePool.0': { $exists: true } },
          { $pop: { codePool: -1 }, $inc: { awardedCount: 1 } },
          { new: false },
        ).lean();
        if (!claimed?.codePool?.length) {
          console.warn(`[prizes] code pool empty for prize ${prize._id}; skipping ${recipient.userId}`);
          continue;
        }
        code = claimed.codePool[0];
      } else {
        await ContestPrize.updateOne({ _id: prize._id }, { $inc: { awardedCount: 1 } });
      }

      try {
        await PlayerAward.create({
          userId: String(recipient.userId),
          fightId: String(fightId),
          prizeId: String(prize._id),
          type: prize.type,
          name: prize.name,
          description: prize.description,
          imageUrl: prize.imageUrl,
          sponsorName: prize.sponsorName,
          place: prize.place,
          code,
          fulfilment: INSTANT_PRIZE_TYPES.includes(prize.type) ? 'not_required' : 'pending',
          idempotencyKey,
        });
        awarded += 1;
      } catch (error) {
        if (error?.code !== 11000) console.error('Award creation failed:', error.message);
        continue;
      }

      const winner = await User.findById(recipient.userId).select('email playerName').lean();
      if (winner?.email) {
        sendMoneyNotice({
          to: winner.email,
          subject: `You won: ${prize.name}`,
          heading: prize.place === 0 ? 'YOU EARNED AN AWARD' : `#${prize.place} FINISH`,
          lines: [
            `${fight?.matchFighterA || 'Fighter A'} vs ${fight?.matchFighterB || 'Fighter B'} has been scored.`,
            `You won <strong>${escapeHtml(prize.name)}</strong>${prize.sponsorName ? `, courtesy of ${escapeHtml(prize.sponsorName)}` : ''}.`,
            code ? `Your code: <strong>${escapeHtml(code)}</strong>` : '',
            INSTANT_PRIZE_TYPES.includes(prize.type)
              ? 'It is already on your profile.'
              : 'We will be in touch about delivery.',
          ].filter(Boolean),
        });
      }
    }
  }

  return { awarded, prizes: prizes.length };
};

// --- admin: configure prizes on a fight -----------------------------------
app.post('/api/admin/fights/:fightId/prizes', verifyAdminToken, async (req, res) => {
  try {
    const fightId = String(req.params.fightId || '').trim();
    const type = String(req.body?.type || '').trim();
    if (!PRIZE_TYPES.includes(type)) {
      return res.status(422).json({ ok: false, message: `type must be one of: ${PRIZE_TYPES.join(', ')}` });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(422).json({ ok: false, message: 'A prize name is required.' });

    const codePool = Array.isArray(req.body?.codePool)
      ? req.body.codePool.map((c) => String(c).trim()).filter(Boolean).slice(0, 500)
      : [];
    if (type === 'ppv_code' && !codePool.length) {
      return res.status(422).json({ ok: false, message: 'Provide at least one code for a PPV code prize.' });
    }

    const prize = await ContestPrize.create({
      fightId,
      place: Math.max(0, Math.round(Number(req.body?.place) || 0)),
      type,
      name: name.slice(0, 120),
      description: String(req.body?.description || '').slice(0, 500),
      imageUrl: String(req.body?.imageUrl || '').slice(0, 500),
      sponsorName: String(req.body?.sponsorName || '').slice(0, 120),
      codePool,
      quantity: type === 'ppv_code' ? codePool.length : Math.max(1, Math.round(Number(req.body?.quantity) || 1)),
    });
    return res.status(201).json({ ok: true, prizeId: prize._id });
  } catch (error) {
    console.error('Prize create failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not add that prize.' });
  }
});

app.get('/api/admin/fights/:fightId/prizes', verifyAdminToken, async (req, res) => {
  try {
    const prizes = await ContestPrize.find({ fightId: String(req.params.fightId || '').trim() })
      .select('-codePool').sort({ place: 1 }).lean();
    // Never return the unclaimed codes themselves; the count is what admins need.
    const withCounts = await Promise.all(prizes.map(async (prize) => {
      const full = await ContestPrize.findById(prize._id).select('codePool').lean();
      return { ...prize, codesRemaining: full?.codePool?.length || 0 };
    }));
    return res.json({ ok: true, prizes: withCounts });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Could not load prizes.' });
  }
});

app.delete('/api/admin/prizes/:prizeId', verifyAdminToken, async (req, res) => {
  try {
    await ContestPrize.updateOne({ _id: String(req.params.prizeId || '') }, { $set: { active: false } });
    return res.json({ ok: true, message: 'Prize deactivated. Awards already given are unaffected.' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Could not remove that prize.' });
  }
});

// --- admin: fulfilment queue for physical goods ---------------------------
app.get('/api/admin/awards/fulfilment', verifyAdminToken, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending').trim();
    const rows = await PlayerAward.find({ fulfilment: status }).sort({ createdAt: 1 }).limit(300).lean();
    const userIds = [...new Set(rows.map((r) => r.userId))].filter((id) => mongoose.isValidObjectId(id));
    const users = userIds.length
      ? await User.find({ _id: { $in: userIds } }).select('email playerName firstName lastName phone zipCode').lean()
      : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));
    return res.json({
      ok: true,
      awards: rows.map((row) => ({
        id: row._id,
        name: row.name,
        type: row.type,
        sponsorName: row.sponsorName,
        place: row.place,
        wonAt: row.createdAt,
        fulfilment: row.fulfilment,
        winner: byId.get(row.userId)
          ? {
            name: byId.get(row.userId).playerName
              || [byId.get(row.userId).firstName, byId.get(row.userId).lastName].filter(Boolean).join(' '),
            email: byId.get(row.userId).email,
            phone: byId.get(row.userId).phone,
            zipCode: byId.get(row.userId).zipCode,
          }
          : null,
      })),
    });
  } catch (error) {
    console.error('Fulfilment queue failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not load the queue.' });
  }
});

app.post('/api/admin/awards/:awardId/fulfil', verifyAdminToken, async (req, res) => {
  try {
    const next = String(req.body?.status || 'shipped').trim();
    if (!['shipped', 'cancelled', 'pending'].includes(next)) {
      return res.status(422).json({ ok: false, message: 'status must be shipped, cancelled or pending.' });
    }
    const award = await PlayerAward.findOneAndUpdate(
      { _id: String(req.params.awardId || '') },
      { $set: { fulfilment: next, shippingNote: String(req.body?.note || '').slice(0, 300) } },
      { new: true },
    ).lean();
    if (!award) return res.status(404).json({ ok: false, message: 'Award not found.' });

    if (next === 'shipped') {
      const winner = await User.findById(award.userId).select('email').lean();
      if (winner?.email) {
        sendMoneyNotice({
          to: winner.email,
          subject: `Your prize is on the way: ${award.name}`,
          heading: 'PRIZE SHIPPED',
          lines: [
            `<strong>${escapeHtml(award.name)}</strong> has been sent out.`,
            award.shippingNote ? escapeHtml(award.shippingNote) : '',
          ].filter(Boolean),
        });
      }
    }
    return res.json({ ok: true, fulfilment: award.fulfilment });
  } catch (error) {
    console.error('Fulfilment update failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not update that award.' });
  }
});

// --- player: my trophy case ------------------------------------------------
app.get('/api/users/me/awards', verifyToken, async (req, res) => {
  try {
    const userId = String(req.user?.id || req.user?._id || '').trim();
    const rows = await PlayerAward.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
    return res.json({
      ok: true,
      awards: rows.map((row) => ({
        id: row._id,
        type: row.type,
        name: row.name,
        description: row.description,
        imageUrl: row.imageUrl,
        sponsorName: row.sponsorName,
        place: row.place,
        code: row.code || undefined,
        fulfilment: row.fulfilment,
        wonAt: row.createdAt,
        fightId: row.fightId,
      })),
      badges: rows.filter((r) => r.type === 'badge').length,
      titles: rows.filter((r) => r.type === 'title').map((r) => r.name),
    });
  } catch (error) {
    console.error('Awards lookup failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not load your awards.' });
  }
});

// Public trophy case, for the leaderboard and profile showcase. Names only.
app.get('/api/public/awards/:userId', async (req, res) => {
  try {
    const rows = await PlayerAward.find({ userId: String(req.params.userId || '').trim() })
      .select('type name imageUrl sponsorName place createdAt').sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ ok: true, awards: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Could not load awards.' });
  }
});

// ==========================================================================
// OWNER CHECK — read-only inspection of the whole platform
//
// A credential that can see everything is a credential worth stealing, so this
// one cannot DO anything: there is no write endpoint here beyond signing in.
// Every money action stays behind admin auth with its own audit trail. That way
// a leaked owner code costs you information, not money.
//
// Separate secret from admin (JWT_SECRET_OWNER) so neither role's compromise
// includes the other. Short session — you are checking, not living here.
// ==========================================================================
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || SUPPORT_EMAIL).trim().toLowerCase();
const OWNER_CODE_TTL_MS = 10 * 60 * 1000;
const OWNER_SESSION_TTL = process.env.OWNER_SESSION_TTL || '1h';
const OWNER_CODE_MAX_ATTEMPTS = 5;

const ownerLoginCodeSchema = new mongoose.Schema({
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

const OwnerLoginCode = mongoose.models.OwnerLoginCode
  || mongoose.model('OwnerLoginCode', ownerLoginCodeSchema);

const ownerSecret = () => String(process.env.JWT_SECRET_OWNER || '').trim();

app.post('/api/owner/login/request', loginLimiter, async (req, res) => {
  // Identical response either way — this must never confirm the owner address.
  const generic = { ok: true, message: 'If that address can access the owner view, a code is on its way.' };
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (email !== OWNER_EMAIL) return res.json(generic);
    if (!ownerSecret()) {
      console.error('Owner sign-in attempted but JWT_SECRET_OWNER is not configured.');
      return res.json(generic);
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await OwnerLoginCode.deleteMany({});
    await OwnerLoginCode.create({
      codeHash: crypto.createHash('sha256').update(code).digest('hex'),
      expiresAt: new Date(Date.now() + OWNER_CODE_TTL_MS),
    });

    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: OWNER_EMAIL,
      subject: 'Fantasy MMAdness owner sign-in code',
      html: `<div style="font-family:Georgia,'Times New Roman',serif;color:#201f1d">
        <p>Your owner sign-in code:</p>
        <p style="font-size:32px;letter-spacing:8px;font-variant-numeric:tabular-nums"><strong>${code}</strong></p>
        <p>Valid for 10 minutes. <strong>If you did not request this, someone knows your owner address — change your email password and tell your developer.</strong></p>
      </div>`,
    });
    return res.json(generic);
  } catch (error) {
    console.error('Owner code request failed:', error);
    return res.json(generic);
  }
});

app.post('/api/owner/login/verify', loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').trim();
    if (email !== OWNER_EMAIL || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, message: 'That code is not correct.' });
    }
    if (!ownerSecret()) return res.status(503).json({ ok: false, message: 'Owner access is not configured.' });

    const record = await OwnerLoginCode.findOne({}).sort({ createdAt: -1 });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ ok: false, message: 'That code has expired. Request a new one.' });
    }
    if (record.attempts >= OWNER_CODE_MAX_ATTEMPTS) {
      return res.status(429).json({ ok: false, message: 'Too many attempts. Request a new code.' });
    }
    const supplied = Buffer.from(crypto.createHash('sha256').update(code).digest('hex'));
    const expected = Buffer.from(record.codeHash);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ ok: false, message: 'That code is not correct.' });
    }
    await OwnerLoginCode.deleteMany({});

    const token = jwt.sign({ email: OWNER_EMAIL, scope: 'owner' }, ownerSecret(), { expiresIn: OWNER_SESSION_TTL });

    // Every successful owner sign-in is announced, so an unexpected one is visible.
    sendMoneyNotice({
      to: OWNER_EMAIL,
      subject: 'Owner view accessed',
      heading: 'OWNER SIGN-IN',
      lines: [
        `Someone signed in to the owner view at ${new Date().toUTCString()}.`,
        `IP: ${String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')}`,
        'If this was not you, change your email password immediately.',
      ],
    });

    return res.json({ ok: true, token, expiresIn: OWNER_SESSION_TTL });
  } catch (error) {
    console.error('Owner verify failed:', error);
    return res.status(500).json({ ok: false, message: 'Sign-in is temporarily unavailable.' });
  }
});

// --------------------------------------------------------------------------
// TRUSTED DEVICE + PIN
//
// Emailing a code every time is right for a new device and wrong for the phone
// in your pocket. So: prove it once by email, then keep a device secret on that
// phone and unlock with a short PIN.
//
// This is only defensible because the owner view is READ-ONLY. A PIN would be a
// bad guard on anything that can move money; here the worst case is that someone
// holding your unlocked phone can read numbers they could also read over your
// shoulder. The device secret is long and random — the PIN alone is useless
// without it, and five wrong PINs destroy the device record entirely.
// --------------------------------------------------------------------------
const ownerDeviceSchema = new mongoose.Schema({
  deviceKeyHash: { type: String, required: true, unique: true },
  pinHash: { type: String, required: true },
  label: { type: String, default: 'Phone' },
  failedAttempts: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

const OwnerDevice = mongoose.models.OwnerDevice || mongoose.model('OwnerDevice', ownerDeviceSchema);

const OWNER_DEVICE_TTL_MS = Number(process.env.OWNER_DEVICE_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const OWNER_PIN_MAX_ATTEMPTS = 5;
const hashOwnerValue = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

app.post('/api/owner/device/trust', (req, res, next) => verifyOwnerToken(req, res, next), async (req, res) => {
  try {
    const pin = String(req.body?.pin || '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(422).json({ ok: false, message: 'Choose a PIN of 4 to 8 digits.' });
    }
    // Refuse the PINs someone would guess first.
    if (/^(\d)\1+$/.test(pin) || ['1234', '12345', '123456', '0000'].includes(pin)) {
      return res.status(422).json({ ok: false, message: 'Pick a less predictable PIN.' });
    }

    const deviceKey = crypto.randomBytes(32).toString('hex');
    await OwnerDevice.create({
      deviceKeyHash: hashOwnerValue(deviceKey),
      pinHash: await bcrypt.hash(pin, 10),
      label: String(req.body?.label || 'Phone').slice(0, 40),
      expiresAt: new Date(Date.now() + OWNER_DEVICE_TTL_MS),
    });

    sendMoneyNotice({
      to: OWNER_EMAIL,
      subject: 'A device was trusted for owner access',
      heading: 'DEVICE TRUSTED',
      lines: [
        `A device was set up for quick owner sign-in on ${new Date().toUTCString()}.`,
        'If this was not you, open the owner view and choose "Forget all devices".',
      ],
    });

    // Returned once and never again — the phone stores it, the server keeps only a hash.
    return res.json({ ok: true, deviceKey, expiresInDays: Math.round(OWNER_DEVICE_TTL_MS / 86400000) });
  } catch (error) {
    console.error('Owner device trust failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not set up quick access.' });
  }
});

app.post('/api/owner/login/device', loginLimiter, async (req, res) => {
  try {
    const deviceKey = String(req.body?.deviceKey || '').trim();
    const pin = String(req.body?.pin || '').trim();
    const generic = { ok: false, message: 'That PIN is not correct.' };
    if (!deviceKey || !/^\d{4,8}$/.test(pin) || !ownerSecret()) return res.status(400).json(generic);

    const device = await OwnerDevice.findOne({ deviceKeyHash: hashOwnerValue(deviceKey) });
    if (!device) return res.status(401).json({ ok: false, message: 'This device is no longer trusted. Sign in with an email code.', reset: true });
    if (device.expiresAt.getTime() < Date.now()) {
      await device.deleteOne();
      return res.status(401).json({ ok: false, message: 'Quick access expired. Sign in with an email code.', reset: true });
    }
    if (device.failedAttempts >= OWNER_PIN_MAX_ATTEMPTS) {
      await device.deleteOne();
      return res.status(429).json({ ok: false, message: 'Too many wrong PINs — this device was un-trusted. Sign in with an email code.', reset: true });
    }

    if (!(await bcrypt.compare(pin, device.pinHash))) {
      device.failedAttempts += 1;
      await device.save();
      const left = OWNER_PIN_MAX_ATTEMPTS - device.failedAttempts;
      return res.status(401).json({
        ok: false,
        message: left > 0 ? `That PIN is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'That PIN is not correct.',
      });
    }

    device.failedAttempts = 0;
    device.lastUsedAt = new Date();
    // Sliding window: a phone you actually use stays trusted.
    device.expiresAt = new Date(Date.now() + OWNER_DEVICE_TTL_MS);
    await device.save();

    const token = jwt.sign({ email: OWNER_EMAIL, scope: 'owner', via: 'device' }, ownerSecret(), { expiresIn: OWNER_SESSION_TTL });
    return res.json({ ok: true, token, expiresIn: OWNER_SESSION_TTL });
  } catch (error) {
    console.error('Owner device sign-in failed:', error);
    return res.status(500).json({ ok: false, message: 'Sign-in is temporarily unavailable.' });
  }
});

app.post('/api/owner/device/forget-all', (req, res, next) => verifyOwnerToken(req, res, next), async (req, res) => {
  try {
    const { deletedCount } = await OwnerDevice.deleteMany({});
    return res.json({ ok: true, removed: deletedCount || 0, message: 'All trusted devices removed. Every device now needs an email code.' });
  } catch (error) {
    console.error('Owner device wipe failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not remove trusted devices.' });
  }
});

// --------------------------------------------------------------------------
// VIEW AS — see the app as a specific player or affiliate, read-only
//
// Not impersonation: the token this mints cannot write. It is a way to answer
// "what does this person actually see", which support questions constantly need
// and screenshots never settle.
// --------------------------------------------------------------------------
const OWNER_PREVIEW_TTL = process.env.OWNER_PREVIEW_TTL || '20m';

app.get('/api/owner/preview/search', (req, res, next) => verifyOwnerToken(req, res, next), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ ok: true, players: [], affiliates: [] });
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(safe, 'i');
    const filter = { $or: [{ email: match }, { playerName: match }, { firstName: match }, { lastName: match }] };

    const [players, affiliates] = await Promise.all([
      User.find(filter).select('_id email playerName firstName lastName tokens').limit(10).lean(),
      Affiliate.find(filter).select('_id email playerName firstName lastName tokens verified').limit(10).lean(),
    ]);

    const shape = (row) => ({
      id: String(row._id),
      name: row.playerName || [row.firstName, row.lastName].filter(Boolean).join(' ') || 'Unnamed',
      email: row.email,
      coins: Number.parseInt(String(row.tokens || '0'), 10) || 0,
      verified: row.verified,
    });
    return res.json({ ok: true, players: players.map(shape), affiliates: affiliates.map(shape) });
  } catch (error) {
    console.error('Owner preview search failed:', error);
    return res.status(500).json({ ok: false, message: 'Search failed.' });
  }
});

app.post('/api/owner/preview/token', (req, res, next) => verifyOwnerToken(req, res, next), async (req, res) => {
  try {
    const targetType = String(req.body?.targetType || '').trim().toLowerCase();
    const targetId = String(req.body?.targetId || '').trim();
    if (!['player', 'affiliate'].includes(targetType) || !mongoose.isValidObjectId(targetId)) {
      return res.status(422).json({ ok: false, message: 'Choose a player or affiliate to view.' });
    }
    const account = targetType === 'affiliate'
      ? await Affiliate.findById(targetId).select('_id email playerName firstName lastName').lean()
      : await User.findById(targetId).select('_id email playerName firstName lastName').lean();
    if (!account) return res.status(404).json({ ok: false, message: 'That account no longer exists.' });

    // Signed with JWT_SECRET so ordinary read routes accept it — but carrying a
    // scope that verifyToken refuses to let write.
    const token = jwt.sign(
      { id: String(account._id), scope: 'owner-preview', previewOf: targetType, actor: OWNER_EMAIL },
      process.env.JWT_SECRET,
      { expiresIn: OWNER_PREVIEW_TTL },
    );

    console.log(`[owner-preview] ${OWNER_EMAIL} started a read-only preview of ${targetType} ${account._id}`);
    return res.json({
      ok: true,
      token,
      expiresIn: OWNER_PREVIEW_TTL,
      target: {
        id: String(account._id),
        type: targetType,
        name: account.playerName || [account.firstName, account.lastName].filter(Boolean).join(' ') || account.email,
      },
    });
  } catch (error) {
    console.error('Owner preview token failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not start the preview.' });
  }
});

const verifyOwnerToken = (req, res, next) => {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !ownerSecret()) {
    return res.status(401).json({ ok: false, message: 'Owner sign-in required.', shouldLogin: true });
  }
  try {
    const claims = jwt.verify(token, ownerSecret());
    if (claims?.scope !== 'owner') throw new Error('wrong scope');
    req.owner = claims;
    return next();
  } catch (error) {
    return res.status(401).json({ ok: false, message: 'Your owner session has expired.', shouldLogin: true });
  }
};

// --------------------------------------------------------------------------
// OVERVIEW — configuration, live counts, feature flags
// --------------------------------------------------------------------------
app.get('/api/owner/overview', verifyOwnerToken, async (req, res) => {
  try {
    await ensureDatabaseCapability();
    const anet = getAuthorizeNetEnvironment();
    const set = (name) => Boolean(String(process.env[name] || '').trim());

    const [players, affiliates, openFights, entriesToday, pendingPayouts] = await Promise.all([
      User.countDocuments({}),
      Affiliate.countDocuments({}),
      Match.countDocuments({ matchStatus: { $nin: ['finished', 'closed', 'draft'] } }),
      Score.countDocuments({ createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      Affiliate.countDocuments({ 'payouts.status': 'pending' }),
    ]);

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      config: [
        { label: 'Database transactions', ok: databaseCapability.transactionsSupported, value: databaseCapability.topology,
          note: databaseCapability.transactionsSupported ? 'Money paths safe' : 'PAID ENTRIES WILL FAIL' },
        { label: 'Payment provider mode', ok: anet.isLive, value: anet.isLive ? 'production' : 'sandbox',
          note: anet.isLive ? 'Taking real payments' : 'Sandbox — no real money moves' },
        { label: 'Payment webhook signing', ok: set('AUTHORIZE_NET_SIGNATURE_KEY'), value: set('AUTHORIZE_NET_SIGNATURE_KEY') ? 'configured' : 'missing',
          note: 'Without it, payment confirmations are rejected' },
        { label: 'Email delivery', ok: set('SMTP_PASS') || set('GMAIL_APP_PASSWORD'), value: (set('SMTP_PASS') || set('GMAIL_APP_PASSWORD')) ? 'configured' : 'missing',
          note: 'Receipts, payouts and alerts all depend on this' },
        { label: 'Scheduled jobs', ok: set('CRON_SECRET'), value: set('CRON_SECRET') ? 'protected' : 'disabled',
          note: set('CRON_SECRET') ? 'Cron endpoints require the secret' : 'Jobs return 503 until CRON_SECRET is set' },
        { label: 'Admin/player secrets differ', ok: process.env.JWT_SECRET !== process.env.JWT_SECRET_ADMIN, value: process.env.JWT_SECRET !== process.env.JWT_SECRET_ADMIN ? 'yes' : 'IDENTICAL',
          note: 'If identical, any player token passes admin checks' },
        { label: 'Paid states', ok: PAID_STATES.length > 0, value: `${PAID_STATES.length} states`,
          note: 'Real-money contests are open in these' },
        { label: 'Free-play only (locked)', ok: true, value: FREE_ONLY_STATES.join(', '),
          note: 'Paid contests can never be enabled here, by design' },
        { label: 'Blocked states', ok: true, value: BLOCKED_STATES.length ? BLOCKED_STATES.join(', ') : 'none',
          note: 'No access at all' },
      ],
      counts: { players, affiliates, openFights, entriesLast24h: entriesToday, pendingPayouts },
      trustedDevices: await OwnerDevice.countDocuments({}),
      features: {
        headToHead: HEAD_TO_HEAD_ENABLED,
        proWrestling: ['true', '1', 'yes', 'on'].includes(String(process.env.PRO_WRESTLING_ENABLED || 'false').toLowerCase()),
      },
    });
  } catch (error) {
    console.error('Owner overview failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not build the overview.' });
  }
});

// --------------------------------------------------------------------------
// INTEGRITY — the questions that tell you whether the books are straight.
// Read-only; every check reports counts and a small sample, never a bulk dump.
// --------------------------------------------------------------------------
const runOwnerIntegrityChecks = async () => {
  const checks = [];
  const add = (name, count, detail, sample = []) => checks.push({
    name, count, ok: count === 0, detail, sample: sample.slice(0, 10),
  });

  // 1. Entries charged with no ledger row — an entry fee taken without an audit trail.
  const paidFights = await Match.find({ matchTokens: { $gt: 0 } }).select('_id').limit(500).lean();
  const paidIds = paidFights.map((f) => String(f._id));
  const entries = paidIds.length
    ? await Score.find({ matchId: { $in: paidIds }, refunded: { $ne: true } }).select('playerId matchId').limit(5000).lean()
    : [];
  const ledgerRows = entries.length
    ? await FightEntryLedger.find({ matchId: { $in: paidIds }, type: 'FIGHT_ENTRY' }).select('userId matchId').limit(20000).lean()
    : [];
  const ledgerKeys = new Set(ledgerRows.map((r) => `${r.userId}:${r.matchId}`));
  const unaudited = entries.filter((e) => !ledgerKeys.has(`${e.playerId}:${e.matchId}`));
  add('Paid entries with no ledger row', unaudited.length,
    'A player was entered into a paid fight without a recorded charge. Entries created before charging existed will show here.',
    unaudited.map((e) => ({ playerId: e.playerId, matchId: e.matchId })));

  // 2. Broken wallet chains — each ledger row records the balance before and
  //    after, so a gap between consecutive rows means a balance changed without
  //    being recorded anywhere.
  const recentLedger = await FightEntryLedger.find({})
    .select('userId amount balanceBefore balanceAfter createdAt')
    .sort({ createdAt: -1 }).limit(4000).lean();
  const byUser = new Map();
  recentLedger.forEach((row) => {
    const key = String(row.userId);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(row);
  });
  const brokenChains = [];
  byUser.forEach((rows, userId) => {
    const ordered = rows.slice().reverse();
    for (let i = 1; i < ordered.length; i += 1) {
      if (Number(ordered[i].balanceBefore) !== Number(ordered[i - 1].balanceAfter)) {
        brokenChains.push({
          userId,
          expected: Number(ordered[i - 1].balanceAfter),
          found: Number(ordered[i].balanceBefore),
          at: ordered[i].createdAt,
        });
        break;
      }
    }
  });
  add('Wallets with an unrecorded balance change', brokenChains.length,
    'A balance moved between two recorded moves. Usually an admin adjustment made outside the ledger.',
    brokenChains);

  // 3. Fights that have entries and official stats but were never settled.
  const finishedWithStats = await Match.find({
    prizesSettledAt: { $in: [null, undefined] },
    matchDate: { $lt: new Date(Date.now() - 12 * 60 * 60 * 1000) },
  }).select('_id matchFighterA matchFighterB matchDate pot').limit(200).lean();
  const unsettled = [];
  for (const fight of finishedWithStats) {
    const entryCount = await Score.countDocuments({ matchId: String(fight._id), refunded: { $ne: true } });
    if (entryCount > 0) {
      unsettled.push({
        fightId: String(fight._id),
        fight: `${fight.matchFighterA || '?'} vs ${fight.matchFighterB || '?'}`,
        entries: entryCount,
        pot: Number(fight.pot) || 0,
        date: fight.matchDate,
      });
    }
  }
  add('Fights with entries awaiting settlement', unsettled.length,
    'Players paid in and have not been paid out. Settle these from the admin fight screen.',
    unsettled);

  // 3b. Contests where the declared prize is not covered by the entries taken —
  //     the platform would be paying the difference.
  const openPaid = await Match.find({
    prizesSettledAt: { $in: [null, undefined] },
    voidedAt: { $in: [null, undefined] },
    matchTokens: { $gt: 0 },
    pot: { $gt: 0 },
  }).select('_id matchFighterA matchFighterB pot matchTokens collectedFees minimumEntrants').limit(200).lean();
  const uncovered = openPaid
    .map((fight) => {
      const collected = Math.max(0, Number(fight.collectedFees) || 0);
      const declared = Math.max(0, Number(fight.pot) || 0);
      return {
        fightId: String(fight._id),
        fight: `${fight.matchFighterA || '?'} vs ${fight.matchFighterB || '?'}`,
        declaredPrize: declared,
        feesCollected: collected,
        shortfall: Math.max(0, declared - collected),
      };
    })
    .filter((row) => row.shortfall > 0);
  add('Open contests not yet covering their prize', uncovered.length,
    'Entries so far do not cover the prize promised. They will void and refund at settlement unless more players enter.',
    uncovered);

  // 3c. Physical prizes won but not yet sent.
  const pendingAwards = await PlayerAward.find({ fulfilment: 'pending' })
    .select('name sponsorName createdAt').sort({ createdAt: 1 }).limit(100).lean();
  const stalePrizes = pendingAwards.filter((row) => (Date.now() - new Date(row.createdAt).getTime()) > 7 * 24 * 3600 * 1000);
  add('Prizes won but not sent after a week', stalePrizes.length,
    'Winners are waiting on merch or sponsor goods. Clear these from the fulfilment queue.',
    stalePrizes.map((r) => ({ prize: r.name, sponsor: r.sponsorName, wonAt: r.createdAt })));

  // 4. Payments that took money but never credited.
  const stuckOrders = await CoinPurchaseOrder.find({
    status: { $in: ['PROCESSING', 'FAILED'] },
    createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
  }).select('orderNumber email status subtotalCents createdAt').sort({ createdAt: -1 }).limit(100).lean();
  add('Coin orders stuck or failed', stuckOrders.length,
    'A payment may have been taken without coins being credited. Check each against the payment provider.',
    stuckOrders.map((o) => ({ orderNumber: o.orderNumber, email: o.email, status: o.status, amount: (o.subtotalCents || 0) / 100 })));

  // 5. Payouts an affiliate is waiting on.
  const withPending = await Affiliate.find({ 'payouts.status': 'pending' })
    .select('firstName lastName email payouts').limit(200).lean();
  const stalePayouts = [];
  withPending.forEach((affiliate) => {
    (affiliate.payouts || []).forEach((payout, index) => {
      const created = payout?.requestedAt || payout?.createdAt;
      const ageHours = created ? (Date.now() - new Date(created).getTime()) / 3600000 : 0;
      if (String(payout?.status || '').toLowerCase() === 'pending' && ageHours > 48) {
        stalePayouts.push({
          affiliate: `${affiliate.firstName || ''} ${affiliate.lastName || ''}`.trim(),
          amount: Number(payout.amount) || 0,
          waitingHours: Math.round(ageHours),
          payoutIndex: index,
        });
      }
    });
  });
  add('Payouts pending over 48 hours', stalePayouts.length,
    'Affiliates are waiting on money. Approve or reject from the payouts screen.',
    stalePayouts);

  // 6. Head-to-head escrow left holding coins on a settled fight.
  if (HEAD_TO_HEAD_ENABLED) {
    const settledFightIds = (await Match.find({ prizesSettledAt: { $ne: null } }).select('_id').limit(500).lean())
      .map((f) => String(f._id));
    const stuck = settledFightIds.length
      ? await Challenge.find({ fightId: { $in: settledFightIds }, status: { $in: ['PENDING', 'ACCEPTED'] } })
        .select('fightId stake status').limit(200).lean()
      : [];
    add('Challenges holding coins on a settled fight', stuck.length,
      'Escrow was not released. Re-run settle-challenges for those fights.',
      stuck.map((c) => ({ challengeId: String(c._id), fightId: c.fightId, stake: c.stake, status: c.status })));
  }

  const problems = checks.filter((c) => !c.ok);
  return {
    generatedAt: new Date().toISOString(),
    allClear: problems.length === 0,
    problemCount: problems.length,
    checks,
  };
};

app.get('/api/owner/integrity', verifyOwnerToken, async (req, res) => {
  try {
    return res.json({ ok: true, ...(await runOwnerIntegrityChecks()) });
  } catch (error) {
    console.error('Owner integrity check failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not complete the checks.' });
  }
});

// Nightly run. Emails ONLY when something is wrong, so silence means the books
// balance and the mail stays worth reading.
app.get('/api/cron/owner-integrity', verifyCronSecret, async (req, res) => {
  try {
    const report = await runOwnerIntegrityChecks();
    if (report.allClear) return res.json({ ok: true, allClear: true, emailed: false });

    const problems = report.checks.filter((c) => !c.ok);
    await sendMoneyNotice({
      to: OWNER_EMAIL,
      subject: `[FMM] ${problems.length} thing${problems.length === 1 ? '' : 's'} need${problems.length === 1 ? 's' : ''} your attention`,
      heading: 'NIGHTLY CHECK',
      lines: problems.map((p) => `<strong>${p.name}: ${p.count}</strong><br/>${escapeHtml(p.detail)}`),
      footer: 'Open the owner view for the full list. You only get this email when something is off.',
    });
    return res.json({ ok: true, allClear: false, problemCount: problems.length, emailed: true });
  } catch (error) {
    console.error('Nightly integrity check failed:', error);
    return res.status(500).json({ ok: false, message: 'Nightly check failed.' });
  }
});

// Centralized request/upload error handling. This keeps existing upload routes intact
// while returning deterministic 4xx responses for malformed or oversized requests.
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const isFileTooLarge = error.code === 'LIMIT_FILE_SIZE';
    return res.status(isFileTooLarge ? 413 : 400).json({
      message: isFileTooLarge
        ? `Uploaded file is too large. Maximum allowed size is ${MAX_UPLOAD_FILE_SIZE_BYTES} bytes.`
        : error.message,
      code: error.code,
    });
  }

  if (req.fileValidationError) {
    return res.status(400).json({ message: req.fileValidationError });
  }

  if (error?.statusCode) {
    return res.status(error.statusCode).json({ message: error.message, code: error.code });
  }

  if (error?.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin is not allowed by CORS.' });
  }

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ message: `Request body is too large. Maximum JSON body size is ${JSON_BODY_LIMIT}.` });
  }

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ message: 'Malformed JSON request body.' });
  }

  return next(error);
});

// ==========================================================================
// SCORER DELEGATION
// --------------------------------------------------------------------------
// Multiple live events on one night means the owner cannot be at every card.
// A scorer is a delegated pair of hands: they punch rounds in as they happen
// and those rounds go live immediately, but they can NEVER finalize a fight,
// settle it, or pay anybody. Finalization stays admin-only, which is the whole
// safety property here.
//
// Two ways in, both landing on the same scoped token:
//   * LINK    - a one-time URL for a casual helper. No account. Bound to one
//               fight, expires, single claim, revocable.
//   * ACCOUNT - a permanent staff login that only ever sees fights explicitly
//               assigned to it.
//
// What a scorer must not see (owner's call): the pot and entry fees, the
// entrant list and their predictions, other fights on the card, and anything
// about the affiliate/promoter. buildScorerFightView() is the only shape a
// scorer token can ever read, so those fields cannot leak by accident.
// ==========================================================================

const SCORER_SCOPE = 'scorer';
const SCORER_LINK_TTL_HOURS = Number(process.env.SCORER_LINK_TTL_HOURS || 24);
const SCORER_SESSION_TTL = process.env.SCORER_SESSION_TTL || '12h';

const scorerAccountSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: '' },
  email: { type: String, required: true, trim: true, lowercase: true, unique: true },
  passwordHash: { type: String, required: true },
  active: { type: Boolean, default: true },
  createdBy: { type: String, default: 'admin' },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

const scorerAssignmentSchema = new mongoose.Schema({
  fightId: { type: String, required: true, index: true },
  fightLabel: { type: String, default: '' },
  mode: { type: String, enum: ['link', 'account'], required: true },
  scorerName: { type: String, trim: true, default: '' },
  scorerEmail: { type: String, trim: true, lowercase: true, default: '' },
  accountId: { type: String, default: '' },
  // Only the hash is stored. The raw link token is shown once, at creation.
  tokenHash: { type: String, default: '' },
  expiresAt: { type: Date, default: null },
  claimedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  createdBy: { type: String, default: 'admin' },
  roundsSubmitted: { type: Number, default: 0 },
  lastSubmitAt: { type: Date, default: null },
}, { timestamps: true });

const scorerLogSchema = new mongoose.Schema({
  assignmentId: { type: String, index: true },
  fightId: { type: String, index: true },
  scorer: { type: String, default: '' },
  roundNumber: { type: Number, default: 0 },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  at: { type: Date, default: Date.now },
});

const ScorerAccount = mongoose.models.ScorerAccount || mongoose.model('ScorerAccount', scorerAccountSchema);
const ScorerAssignment = mongoose.models.ScorerAssignment || mongoose.model('ScorerAssignment', scorerAssignmentSchema);
const ScorerLog = mongoose.models.ScorerLog || mongoose.model('ScorerLog', scorerLogSchema);

// Live scoring is bursty — a scorer correcting round 7 three times in a minute
// is normal. The generic submitLimiter (20 per 10 min) would lock them out
// mid-fight, so scoring gets its own, roomier limit.
const scorerLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many score submissions. Wait a moment and try again.' },
});

const hashScorerToken = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex');

const signScorerSession = (assignment) => jwt.sign({
  id: String(assignment._id),
  scope: SCORER_SCOPE,
  fightId: String(assignment.fightId),
  accountId: String(assignment.accountId || ''),
}, process.env.JWT_SECRET, { expiresIn: SCORER_SESSION_TTL });

// A scorer token is deliberately NOT accepted by verifyToken's player routes:
// this middleware is the only door it opens.
const verifyScorerToken = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!raw) return res.status(401).json({ message: 'Scorer session required.', code: 'NO_SCORER_TOKEN' });
  try {
    const claims = jwt.verify(raw, process.env.JWT_SECRET);
    if (claims.scope !== SCORER_SCOPE) {
      return res.status(403).json({ message: 'This session cannot score fights.', code: 'WRONG_SCOPE' });
    }
    const assignment = await ScorerAssignment.findById(claims.id);
    if (!assignment || assignment.revokedAt) {
      return res.status(403).json({ message: 'This scoring assignment has been revoked.', code: 'REVOKED' });
    }
    if (assignment.expiresAt && assignment.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ message: 'This scoring assignment has expired.', code: 'EXPIRED' });
    }
    req.scorer = assignment;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired scorer session.', code: 'BAD_SCORER_TOKEN' });
  }
};

// The ONLY fight shape a scorer token can read. No pot, no matchTokens, no
// entrants, no affiliate, no sibling fights on the card.
function buildScorerFightView(match, assignment) {
  const category = normalizeCombatCategory(match.matchCategory);
  const container = category === 'boxing' ? (match.BoxingMatch || {}) : (match.MMAMatch || {});
  return {
    id: String(match._id),
    name: match.matchName || '',
    category,
    categoryTwo: match.matchCategoryTwo || '',
    fighterA: match.matchFighterA || '',
    fighterB: match.matchFighterB || '',
    fighterAImage: match.fighterAImage || '',
    fighterBImage: match.fighterBImage || '',
    maxRounds: Number(match.maxRounds || 0) || 12,
    matchDate: match.matchDate || '',
    matchTime: match.matchTime || '',
    status: match.matchStatus || '',
    statSet: category === 'boxing' ? ['HP', 'BP', 'TP'] : ['ST', 'KI', 'KN', 'EL'],
    fighterOneStats: Array.isArray(container.fighterOneStats) ? container.fighterOneStats : [],
    fighterTwoStats: Array.isArray(container.fighterTwoStats) ? container.fighterTwoStats : [],
    assignment: {
      id: String(assignment._id),
      scorerName: assignment.scorerName || '',
      mode: assignment.mode,
      expiresAt: assignment.expiresAt,
      roundsSubmitted: assignment.roundsSubmitted || 0,
      // Stated to the scorer's own UI so the limit is visible, not a surprise 403.
      canFinalize: false,
    },
  };
}

// --- admin: staff scorer accounts -----------------------------------------
app.post('/api/admin/scorers', verifyAdminToken, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    const existing = await ScorerAccount.findOne({ email });
    if (existing) return res.status(409).json({ message: 'A scorer already exists with that email.' });
    const account = await ScorerAccount.create({
      email,
      name: String(req.body.name || '').trim(),
      passwordHash: await bcrypt.hash(password, 10),
    });
    return res.status(201).json({ ok: true, scorer: { id: account._id, email: account.email, name: account.name, active: account.active } });
  } catch (error) {
    console.error('Create scorer failed:', error);
    return res.status(500).json({ message: 'Could not create the scorer account.' });
  }
});

app.get('/api/admin/scorers', verifyAdminToken, async (_req, res) => {
  try {
    const accounts = await ScorerAccount.find({}).select('name email active lastLoginAt createdAt').sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, scorers: accounts });
  } catch (error) {
    return res.status(500).json({ message: 'Could not load scorers.' });
  }
});

app.patch('/api/admin/scorers/:id', verifyAdminToken, async (req, res) => {
  try {
    const update = {};
    if (typeof req.body.active === 'boolean') update.active = req.body.active;
    if (req.body.name !== undefined) update.name = String(req.body.name).trim();
    if (req.body.password) {
      if (String(req.body.password).length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
      update.passwordHash = await bcrypt.hash(String(req.body.password), 10);
    }
    const account = await ScorerAccount.findByIdAndUpdate(req.params.id, update, { new: true }).select('name email active');
    if (!account) return res.status(404).json({ message: 'Scorer not found.' });
    return res.json({ ok: true, scorer: account });
  } catch (error) {
    return res.status(500).json({ message: 'Could not update the scorer.' });
  }
});

// --- admin: hand a fight to somebody --------------------------------------
app.post('/api/admin/fights/:fightId/scorers', verifyAdminToken, async (req, res) => {
  try {
    const fightId = String(req.params.fightId || '').trim();
    const match = await Match.findById(fightId).select('matchName matchFighterA matchFighterB');
    if (!match) return res.status(404).json({ message: 'Fight not found.' });

    const mode = String(req.body.mode || 'link').toLowerCase() === 'account' ? 'account' : 'link';
    const fightLabel = match.matchName || `${match.matchFighterA} vs ${match.matchFighterB}`;

    if (mode === 'account') {
      const account = await ScorerAccount.findById(String(req.body.accountId || ''));
      if (!account || !account.active) return res.status(400).json({ message: 'Pick an active scorer account.' });
      const assignment = await ScorerAssignment.create({
        fightId, fightLabel, mode: 'account',
        accountId: String(account._id),
        scorerName: account.name || account.email,
        scorerEmail: account.email,
        createdBy: String(req.admin?.id || 'admin'),
      });
      return res.status(201).json({ ok: true, assignment: { id: assignment._id, mode: 'account', scorerName: assignment.scorerName } });
    }

    const rawToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + SCORER_LINK_TTL_HOURS * 60 * 60 * 1000);
    const assignment = await ScorerAssignment.create({
      fightId, fightLabel, mode: 'link',
      scorerName: String(req.body.scorerName || '').trim(),
      scorerEmail: String(req.body.scorerEmail || '').trim().toLowerCase(),
      tokenHash: hashScorerToken(rawToken),
      expiresAt,
      createdBy: String(req.admin?.id || 'admin'),
    });

    const appOrigin = String(process.env.PUBLIC_APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');
    const link = `${appOrigin}/score/${rawToken}`;

    let emailSent = false;
    let emailError = '';
    if (assignment.scorerEmail) {
      try {
        await transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: assignment.scorerEmail,
          subject: `You are scoring ${fightLabel}`,
          html: `<p>You have been asked to score <strong>${fightLabel}</strong>.</p>
                 <p><a href="${link}">Open the scorecard</a></p>
                 <p>This link works once and expires in ${SCORER_LINK_TTL_HOURS} hours. You can submit rounds as they happen; only the promoter can finalize the fight.</p>`,
        });
        emailSent = true;
      } catch (mailError) {
        console.warn('Scorer invite email failed:', mailError?.message);
        emailError = mailError?.message || 'Email delivery failed.';
      }
    }

    // The raw token is returned exactly once, here \u2014 so the admin can still
    // copy/paste it manually if the email failed to send.
    return res.status(201).json({ ok: true, assignment: { id: assignment._id, mode: 'link', expiresAt }, link, emailSent, emailError });
  } catch (error) {
    console.error('Assign scorer failed:', error);
    return res.status(500).json({ message: 'Could not assign a scorer.' });
  }
});

app.get('/api/admin/fights/:fightId/scorers', verifyAdminToken, async (req, res) => {
  try {
    const rows = await ScorerAssignment.find({ fightId: String(req.params.fightId || '').trim() })
      .select('-tokenHash').sort({ createdAt: -1 }).lean();
    return res.json({ ok: true, assignments: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Could not load scorer assignments.' });
  }
});

app.delete('/api/admin/scorer-assignments/:id', verifyAdminToken, async (req, res) => {
  try {
    const assignment = await ScorerAssignment.findByIdAndUpdate(req.params.id, { revokedAt: new Date() }, { new: true });
    if (!assignment) return res.status(404).json({ message: 'Assignment not found.' });
    return res.json({ ok: true, revokedAt: assignment.revokedAt });
  } catch (error) {
    return res.status(500).json({ message: 'Could not revoke the assignment.' });
  }
});

// Audit: what did the delegated scorer actually punch in.
app.get('/api/admin/fights/:fightId/scorer-log', verifyAdminToken, async (req, res) => {
  try {
    const rows = await ScorerLog.find({ fightId: String(req.params.fightId || '').trim() })
      .sort({ at: -1 }).limit(200).lean();
    return res.json({ ok: true, entries: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Could not load the scorer log.' });
  }
});

// --- scorer: getting in ----------------------------------------------------
app.post('/api/scorer/claim', submitLimiter, async (req, res) => {
  try {
    const raw = String(req.body.token || '').trim();
    if (!raw) return res.status(400).json({ message: 'Scoring link token is required.' });
    const assignment = await ScorerAssignment.findOne({ tokenHash: hashScorerToken(raw), mode: 'link' });
    if (!assignment || assignment.revokedAt) return res.status(404).json({ message: 'This scoring link is no longer valid.' });
    if (assignment.expiresAt && assignment.expiresAt.getTime() < Date.now()) {
      return res.status(410).json({ message: 'This scoring link has expired. Ask for a new one.' });
    }
    if (!assignment.claimedAt) {
      assignment.claimedAt = new Date();
      await assignment.save();
    }
    return res.json({ ok: true, token: signScorerSession(assignment), fightLabel: assignment.fightLabel });
  } catch (error) {
    console.error('Scorer claim failed:', error);
    return res.status(500).json({ message: 'Could not open the scorecard.' });
  }
});

app.post('/api/scorer/login', submitLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const account = await ScorerAccount.findOne({ email });
    if (!account || !account.active || !(await bcrypt.compare(password, account.passwordHash))) {
      return res.status(401).json({ message: 'Wrong email or password.' });
    }
    const assignments = await ScorerAssignment.find({
      accountId: String(account._id),
      revokedAt: null,
    }).sort({ createdAt: -1 }).lean();
    if (!assignments.length) return res.status(403).json({ message: 'You have no fights assigned right now.' });

    account.lastLoginAt = new Date();
    await account.save();

    // One session per assignment: the token is fight-bound by design, so a
    // staff scorer picks the fight and gets the token for that fight only.
    return res.json({
      ok: true,
      scorer: { name: account.name, email: account.email },
      fights: assignments.map((a) => ({
        assignmentId: String(a._id),
        fightId: a.fightId,
        fightLabel: a.fightLabel,
        token: signScorerSession(a),
      })),
    });
  } catch (error) {
    console.error('Scorer login failed:', error);
    return res.status(500).json({ message: 'Could not sign in.' });
  }
});

// --- scorer: the desk ------------------------------------------------------
app.get('/api/scorer/fight', verifyScorerToken, async (req, res) => {
  try {
    const match = await Match.findById(req.scorer.fightId);
    if (!match) return res.status(404).json({ message: 'Fight not found.' });
    return res.json({ ok: true, fight: buildScorerFightView(match, req.scorer) });
  } catch (error) {
    return res.status(500).json({ message: 'Could not load the fight.' });
  }
});

// Rounds go live the moment they are submitted. This is the same write path
// the admin desk uses (applyRoundResultsToMatch), so TP is still never
// computed from HP + BP and the stat set still follows the category.
app.post('/api/scorer/fight/rounds', verifyScorerToken, scorerLimiter, async (req, res) => {
  try {
    const match = await Match.findById(req.scorer.fightId);
    if (!match) return res.status(404).json({ message: 'Fight not found.' });

    const finished = String(match.matchStatus || '').toLowerCase();
    if (['completed', 'finished', 'settled'].includes(finished)) {
      return res.status(409).json({ message: 'This fight is already finalized. Rounds are locked.', code: 'FINALIZED' });
    }

    try {
      applyRoundResultsToMatch(match, {
        fighterOneStats: req.body.fighterOneStats,
        fighterTwoStats: req.body.fighterTwoStats,
      });
    } catch (scoringError) {
      return res.status(scoringError.statusCode || 400).json({ message: scoringError.message });
    }
    await match.save();

    const roundNumber = Number(req.body?.fighterOneStats?.roundNumber || req.body?.fighterTwoStats?.roundNumber || 0);
    req.scorer.roundsSubmitted = (req.scorer.roundsSubmitted || 0) + 1;
    req.scorer.lastSubmitAt = new Date();
    await req.scorer.save();
    await ScorerLog.create({
      assignmentId: String(req.scorer._id),
      fightId: String(req.scorer.fightId),
      scorer: req.scorer.scorerName || req.scorer.scorerEmail || 'scorer',
      roundNumber,
      payload: { fighterOneStats: req.body.fighterOneStats, fighterTwoStats: req.body.fighterTwoStats },
    });

    return res.json({ ok: true, fight: buildScorerFightView(match, req.scorer) });
  } catch (error) {
    console.error('Scorer round submit failed:', error);
    return res.status(500).json({ message: 'Could not save the round.' });
  }
});

// Explicit, so a scorer hitting the wall gets an explanation rather than a 404.
app.post('/api/scorer/fight/finalize', verifyScorerToken, (_req, res) => res.status(403).json({
  message: 'Scorers cannot finalize a fight. The promoter finalizes and pays out.',
  code: 'FINALIZE_IS_ADMIN_ONLY',
}));


// ==========================================================================
// AFFILIATE MONEY PAGE
// --------------------------------------------------------------------------
// One read for the promoter's whole financial picture. Deliberately narrower
// than the admin view: a promoter sees THEIR fights, THEIR rake and THEIR
// payouts, and nothing about other affiliates, the platform's own cut, or the
// admin-only levers (uploading a live card, setting a pot). Those stay in the
// back office.
//
// Earnings are not recalculated here. They are read back out of the wallet
// ledger rows settlement already wrote (reason: 'affiliate_pot_share'), so this
// page can never disagree with what was actually paid.
// ==========================================================================
app.get('/api/affiliates/me/money', verifyToken, requireScope(TOKEN_SCOPES.AFFILIATE), async (req, res) => {
  try {
    const affiliateId = String(req.user?.id || req.user?._id || '').trim();
    const affiliate = await Affiliate.findById(affiliateId).select('affiliateName email tokens payouts');
    if (!affiliate) return res.status(404).json({ message: 'Affiliate not found.' });

    const balance = Number.parseInt(String(affiliate.tokens || '0'), 10) || 0;

    // --- earnings, straight from the settlement ledger ---------------------
    const ledgerRows = await FightEntryLedger.find({
      userId: affiliateId,
      'metadata.reason': 'affiliate_pot_share',
    }).sort({ createdAt: -1 }).limit(200).lean();

    const fightIds = [...new Set(ledgerRows.map((row) => String(row.matchId)).filter(Boolean))];
    const fightDocs = await Match.find({ _id: { $in: fightIds } })
      .select('matchName matchFighterA matchFighterB matchDate matchCategory pot collectedFees')
      .lean();
    const fightById = new Map(fightDocs.map((f) => [String(f._id), f]));

    const earnings = ledgerRows.map((row) => {
      const meta = row.metadata || {};
      const fight = fightById.get(String(row.matchId)) || {};
      return {
        fightId: String(row.matchId),
        fightLabel: fight.matchName || `${fight.matchFighterA || ''} vs ${fight.matchFighterB || ''}`.trim(),
        category: fight.matchCategory || '',
        settledAt: row.createdAt,
        entrants: Number(meta.entrants || 0),
        // What the contest took in, vs the pot that was promised out.
        revenue: Number(meta.collectedFees || 0),
        potTotal: Number(meta.potTotal || 0),
        sharePct: Number(meta.sharePct || AFFILIATE_SPLIT_PCT),
        // The 50% rake splits into a fixed cut of the declared pot plus half of
        // everything the contest took above it. Shown apart because the second
        // number is the one that grows with a bigger field.
        fixedCut: Number(meta.fixedCut || 0),
        surplusShare: Number(meta.surplusShare || 0),
        total: Math.round(Number(row.amount) || 0),
      };
    });

    const lifetimeEarned = earnings.reduce((sum, row) => sum + row.total, 0);

    // --- staked shadow fights: pot fill and profit zone ---------------------
    // Staked cards live in BOTH collections: a shadow template the promoter
    // staked, and a live card they created through the promotion desk (which
    // saves to Match). Reading only Shadow silently hid half their money.
    const stakeQuery = {
      $or: [{ affiliateId }, { 'AffiliateIds.AffiliateId': affiliateId }],
      potTarget: { $gt: 0 },
    };
    const stakeFields = 'matchName matchFighterA matchFighterB pot potTarget promoterStake profitZoneReachedAt userPredictions matchDate';
    const stakedFights = [
      ...(await Shadow.find(stakeQuery).select(stakeFields).lean()),
      ...(await Match.find(stakeQuery).select(stakeFields).lean()),
    ];

    const stakes = stakedFights.map((fight) => {
      const target = Math.max(0, Number(fight.potTarget) || 0);
      const filled = Math.max(0, Number(fight.pot) || 0);
      const entrants = Array.isArray(fight.userPredictions)
        ? fight.userPredictions.filter((u) => String(u?.predictionStatus) === 'submitted').length
        : 0;
      const profitAboveStake = Math.max(0, filled - target);
      return {
        fightId: String(fight._id),
        fightLabel: fight.matchName || `${fight.matchFighterA || ''} vs ${fight.matchFighterB || ''}`.trim(),
        matchDate: fight.matchDate || '',
        staked: Math.max(0, Number(fight.promoterStake) || target),
        potTarget: target,
        potFilled: filled,
        fillPct: target ? Math.min(100, Math.round((filled / target) * 100)) : 0,
        entrants,
        inProfitZone: target > 0 && filled >= target,
        profitZoneReachedAt: fight.profitZoneReachedAt || null,
        profitAboveStake,
        yourProjectedShare: Math.floor((profitAboveStake * AFFILIATE_SPLIT_PCT) / 100),
      };
    });

    // --- payouts ------------------------------------------------------------
    const payouts = (affiliate.payouts || []).map((p, index) => ({
      index,
      amount: Number(p.amount || 0),
      status: p.status || 'pending',
      requestedAt: p.createdAt,
      resolvedAt: p.resolvedAt || null,
      reason: p.reason || '',
    })).sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

    const paidOut = payouts.filter((p) => p.status === 'paid').reduce((sum, p) => sum + p.amount, 0);
    const pending = payouts.filter((p) => p.status === 'pending').reduce((sum, p) => sum + p.amount, 0);

    return res.json({
      ok: true,
      affiliate: { name: affiliate.affiliateName || '', email: affiliate.email || '' },
      summary: {
        balance,
        lifetimeEarned,
        paidOut,
        pendingPayouts: pending,
        splitPct: AFFILIATE_SPLIT_PCT,
        fightsSettled: earnings.length,
        totalEntrants: earnings.reduce((sum, row) => sum + row.entrants, 0),
      },
      earnings,
      stakes,
      payouts,
    });
  } catch (error) {
    console.error('Affiliate money page failed:', error);
    return res.status(500).json({ message: 'Could not load your earnings.' });
  }
});


// ==========================================================================
// SHORTFALL SWEEP — fills, or it refunds
// --------------------------------------------------------------------------
// The default deal on a paid card is simple: if enough people enter, it runs;
// if they don't, it never happens and everybody gets their money back. That is
// what makes promoting accessible — a promoter needs an audience, not capital.
//
// A promoter CAN put money behind the prize (promoterStake >= pot). That card
// is guaranteed: it runs however few turn up, and the shortfall comes out of
// their stake. Guaranteed cards are skipped by this sweep entirely.
//
// autoRefundIfShort already existed but only ran inside settlement — i.e. after
// a fight was over and only when an admin got round to it. So an underfilled
// card sat open, took entries, and nobody was told. This closes that.
//
// Three moments, each fired once:
//   T-6h   promoter warned, with the number they still need. Time to push.
//   T-1h   entrants warned it may void, with cards that ARE filling. Time to move.
//   Lock   void, refund every entry, tell them where else to play.
//
// Five minutes' notice was the original idea and it is too late to be useful:
// the promoter cannot rescue a card in five minutes and a player cannot get
// into another one before its own lock.
// ==========================================================================

const PROMOTER_WARN_MS = Number(process.env.SHORTFALL_PROMOTER_WARN_MS || 6 * 60 * 60 * 1000);
const PLAYER_WARN_MS = Number(process.env.SHORTFALL_PLAYER_WARN_MS || 60 * 60 * 1000);
const APP_ORIGIN = String(process.env.PUBLIC_APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');

// Lock is the fight's own lockAt when set, otherwise the scheduled start.
// matchTime is a local "HH:MM" string alongside a date, so it has to be folded
// in — using the bare date would treat every card as locking at midnight.
function resolveFightLockAt(fight) {
  if (fight.lockAt) return new Date(fight.lockAt);
  if (!fight.matchDate) return null;
  const base = new Date(fight.matchDate);
  if (Number.isNaN(base.getTime())) return null;
  const time = String(fight.matchTime || '').trim();
  const parts = time.match(/^(\d{1,2}):(\d{2})$/);
  if (parts) base.setHours(Number(parts[1]), Number(parts[2]), 0, 0);
  return base;
}

function fightLabelOf(fight) {
  return fight.matchName || `${fight.matchFighterA || 'Fighter A'} vs ${fight.matchFighterB || 'Fighter B'}`;
}

// Cards a stranded player can move to: open, paid or free, soonest first, and
// never the one they were just refunded from.
async function findAlternativeFights(excludeId, limit = 3) {
  const now = new Date();
  const rows = await Match.find({
    _id: { $ne: excludeId },
    voidedAt: { $exists: false },
    matchDate: { $gte: now },
    matchStatus: { $nin: ['finished', 'completed', 'Draft', 'draft'] },
  }).select('matchName matchFighterA matchFighterB matchDate matchTokens pot').sort({ matchDate: 1 }).limit(limit).lean();
  return rows.map((row) => ({
    id: String(row._id),
    label: fightLabelOf(row),
    fee: Math.max(0, Number(row.matchTokens) || 0),
    pot: Math.max(0, Number(row.pot) || 0),
  }));
}

function alternativesHtml(alternatives) {
  if (!alternatives.length) return 'New cards open all the time — keep an eye on the app.';
  const items = alternatives.map((alt) => {
    const cost = alt.fee > 0 ? `${alt.fee.toLocaleString()} to enter` : 'Free to enter';
    return `<a href="${APP_ORIGIN}/fight/${alt.id}" style="color:#f2b544;">${alt.label}</a> — ${cost}, ${alt.pot.toLocaleString()} pot`;
  });
  return `These are open right now:<br>${items.join('<br>')}`;
}

async function entrantsOf(fightId) {
  const rows = await Score.find({ matchId: String(fightId), refunded: { $ne: true } })
    .select('playerId').lean();
  const ids = [...new Set(rows.map((row) => String(row.playerId)).filter(Boolean))];
  if (!ids.length) return [];
  return User.find({ _id: { $in: ids } }).select('email firstName playerName').lean();
}

async function sweepShortFights({ now = new Date() } = {}) {
  const summary = { checked: 0, promoterWarned: 0, playersWarned: 0, voided: 0, refunded: 0 };

  // Only paid, unsettled, unvoided cards with a declared prize can be short.
  const horizon = new Date(now.getTime() + PROMOTER_WARN_MS);
  const fights = await Match.find({
    voidedAt: { $exists: false },
    prizesSettledAt: { $exists: false },
    matchTokens: { $gt: 0 },
    pot: { $gt: 0 },
    matchDate: { $lte: horizon },
  }).limit(200);

  for (const fight of fights) {
    const lockAt = resolveFightLockAt(fight);
    if (!lockAt) continue;
    summary.checked += 1;

    const fee = Math.max(0, Math.round(Number(fight.matchTokens) || 0));
    const pot = Math.max(0, Math.round(Number(fight.pot) || 0));
    const stake = Math.max(0, Math.round(Number(fight.promoterStake) || 0));
    const platformFunding = Math.max(0, Math.round(Number(fight.platformContribution) || 0));

    // Guaranteed card: the promoter's money is already behind the prize, so a
    // thin room is their problem and the fight still runs.
    if (stake + platformFunding >= pot && pot > 0) continue;
    if (fight.autoRefundIfShort === false) continue;

    const breakEven = fee > 0 ? Math.ceil(Math.max(0, pot - stake - platformFunding) / fee) : 0;
    const required = Math.max(0, Math.round(Number(fight.minimumEntrants) || 0)) || breakEven;
    if (required <= 0) continue;

    const entries = await Score.countDocuments({ matchId: String(fight._id), refunded: { $ne: true } });
    if (entries >= required) continue;

    const msToLock = lockAt.getTime() - now.getTime();
    const short = required - entries;
    const label = fightLabelOf(fight);

    // ---- lock reached: void and refund ----------------------------------
    if (msToLock <= 0) {
      const refund = await refundFightEntries({
        fightId: String(fight._id),
        reason: `Card voided: ${entries} of ${required} entries needed.`,
      });
      fight.voidedAt = new Date();
      fight.voidReason = `Only ${entries} of ${required} required entries at lock.`;
      await fight.save();
      clearPublicResponseCache();
      summary.voided += 1;
      summary.refunded += refund.refundedCount || 0;

      const alternatives = await findAlternativeFights(fight._id);
      const people = await entrantsOf(fight._id);
      await Promise.allSettled(people.map((person) => sendMoneyNotice({
        to: person.email,
        subject: `${label} was voided — your entry has been refunded`,
        heading: 'CARD VOIDED, MONEY BACK',
        lines: [
          `<strong>${label}</strong> did not get the entries it needed, so it was voided before it started.`,
          'Your entry fee is back in your wallet in full. Nothing was scored and nothing was charged.',
          alternativesHtml(alternatives),
        ],
        footer: 'You were told before the fight, not during it — that is the point of the lock check.',
      })));

      const promoter = fight.affiliateId ? await Affiliate.findById(fight.affiliateId).select('email').lean() : null;
      if (promoter?.email) {
        await sendMoneyNotice({
          to: promoter.email,
          subject: `${label} voided — ${entries} of ${required} entries`,
          heading: 'YOUR CARD DID NOT FILL',
          lines: [
            `<strong>${label}</strong> closed on ${entries} entries against the ${required} it needed, so it voided and everyone was refunded.`,
            'You were not charged anything. Next time: a smaller pot, or a higher buy-in, fills faster.',
          ],
        });
      }
      continue;
    }

    // ---- T-1h: warn the people who already paid --------------------------
    if (msToLock <= PLAYER_WARN_MS && !fight.shortfallPlayersWarnedAt) {
      const alternatives = await findAlternativeFights(fight._id);
      const people = await entrantsOf(fight._id);
      await Promise.allSettled(people.map((person) => sendMoneyNotice({
        to: person.email,
        subject: `${label} is short — it may void within the hour`,
        heading: 'THIS CARD MAY NOT RUN',
        lines: [
          `<strong>${label}</strong> is ${short} ${short === 1 ? 'entry' : 'entries'} short with under an hour before predictions lock.`,
          'If it does not fill, the card voids and your entry is refunded in full and automatically — you do not need to do anything.',
          'Telling you now so you are not sitting down to watch a fight you no longer have action on.',
          alternativesHtml(alternatives),
        ],
      })));
      fight.shortfallPlayersWarnedAt = new Date();
      await fight.save();
      summary.playersWarned += 1;
      continue;
    }

    // ---- T-6h: warn the promoter while they can still fix it -------------
    if (msToLock <= PROMOTER_WARN_MS && !fight.shortfallPromoterWarnedAt) {
      const promoter = fight.affiliateId ? await Affiliate.findById(fight.affiliateId).select('email').lean() : null;
      const to = promoter?.email || FMM_MAIL_FROM;
      const hours = Math.max(1, Math.round(msToLock / 3600000));
      await sendMoneyNotice({
        to,
        subject: `${label} needs ${short} more ${short === 1 ? 'entry' : 'entries'}`,
        heading: 'YOUR CARD IS SHORT',
        lines: [
          `<strong>${label}</strong> has ${entries} of the ${required} entries it needs, and predictions lock in about ${hours} ${hours === 1 ? 'hour' : 'hours'}.`,
          `${short} more and it runs. Post it to your league now — that is usually all it takes.`,
          `<a href="${APP_ORIGIN}/AffiliateDashboard" style="color:#f2b544;">Open your promotion desk</a>`,
          'If it does not fill it voids at lock and every entry is refunded. You are not charged for a card that does not run.',
        ],
      });
      fight.shortfallPromoterWarnedAt = new Date();
      await fight.save();
      summary.promoterWarned += 1;
    }
  }

  return summary;
}

// Scheduled entry point. Vercel cron hits this; the shared secret keeps it from
// being a public "refund everything" button.
const runShortfallSweep = async (req, res) => {
  const secret = String(process.env.CRON_SECRET || '');
  const provided = String(req.headers['x-cron-secret'] || req.query.secret || '');
  const isAdmin = Boolean(req.admin);
  if (secret && provided !== secret && !isAdmin) {
    return res.status(403).json({ message: 'Not authorised.', code: 'BAD_CRON_SECRET' });
  }
  try {
    const summary = await sweepShortFights();
    return res.json({ ok: true, ...summary });
  } catch (error) {
    console.error('Shortfall sweep failed:', error);
    return res.status(500).json({ message: 'Sweep failed.', detail: error.message });
  }
};
app.get('/api/cron/sweep-short-fights', runShortfallSweep);
app.post('/api/cron/sweep-short-fights', runShortfallSweep);

// No scheduler by design. The sweep rides ordinary traffic instead: every
// request checks the clock, and at most one sweep runs every five minutes so it
// can never pile up or slow a response (it is fired AFTER next(), so nothing
// waits on it). Five minutes is tight enough that a lock-time void happens
// while the card is still fresh, and the site always has traffic around a card
// closing — that is exactly when entries are coming in.
let lastOpportunisticSweep = 0;
const OPPORTUNISTIC_SWEEP_MS = 5 * 60 * 1000;
app.use((req, _res, next) => {
  next();
  if (Date.now() - lastOpportunisticSweep < OPPORTUNISTIC_SWEEP_MS) return;
  lastOpportunisticSweep = Date.now();
  sweepShortFights().catch((error) => console.warn('Opportunistic sweep failed:', error.message));
});


// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
