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
const FMM_MAIL_FROM = process.env.SMTP_FROM || 'Fantasy MMAdness <no-reply@fantasymmadness.com>';
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
// values used to fail silently at request time â€” jwt.verify(token, undefined)
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
    const message = `${weak.join(', ')} ${weak.length > 1 ? 'are' : 'is'} too weak â€” use 32+ random characters.`;
    if (process.env.NODE_ENV === 'production') {
      console.error(`FATAL: ${message}`);
      process.exit(1);
    }
    console.warn(`WARNING: ${message}`);
  }
  if (process.env.JWT_SECRET && process.env.JWT_SECRET === process.env.JWT_SECRET_ADMIN) {
    console.error('FATAL: JWT_SECRET and JWT_SECRET_ADMIN must differ â€” a player token would otherwise pass admin checks.');
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }

  // Non-fatal, but each one silently disables a feature in production.
  [
    ['CRON_SECRET', 'scheduled jobs will return 503'],
    ['AUTHORIZE_NET_SIGNATURE_KEY', 'payment webhooks will be rejected'],
    ['SMTP_PASS', 'no email will be delivered'],
  ].forEach(([name, effect]) => {
    if (!String(process.env[name] || '').trim()) console.warn(`WARNING: ${name} is not set â€” ${effect}.`);
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
// a standalone mongod. Standalone does not warn â€” it throws mid-sequence, which
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
    console.log(`MongoDB topology OK â€” ${databaseCapability.detail}. Transactions available.`);
    return true;
  }

  const message = [
    'MongoDB is running as a STANDALONE server, which does not support transactions.',
    'Paid fight entries, refunds, prize settlement, coin purchases and challenge',
    'escrow will all FAIL until this is a replica set (Atlas M10+ is one by default;',
    'a self-hosted single node is not â€” start it with --replSet and run rs.initiate()).',
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
    // forget it â€” a preview token must never be able to spend, enter or change
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
// registered above the old definition referenced it â€” and `const` is not
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
// collections â€” but that was a coincidence, not a rule. Every token now declares
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
// WHICH it was â€” an affiliate is then pinned to their own affiliateId below and
// cannot promote on someone else's behalf.
// --------------------------------------------------------------------------
// True when this affiliate is a promoter on this fight. Used to let a promoter
// manage THEIR OWN campaign through routes that are otherwise admin-only â€”
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
// No dependency added on purpose â€” this is a small in-memory limiter. If you
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
  // before verifyToken on most routes, so the raw token is used as the identity â€”
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

// Authenticated actions â€” entries, drafts, league notices, support. Keyed per
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

  // Any fighter that arrives with a name + image but no library id â€” someone
  // uploaded straight onto the fight instead of picking from the library â€”
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
    // Duplicate-key race on the unique (normalizedName, category) index â€” just
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
  // KN is KNEES on the MMA/kickboxing card â€” the same thing the player predicts
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
// application/octet-stream, and anything with no type at all â€” which is every
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

// Wrapped so every existing call site â€” upload.single, upload.fields, upload.array
// â€” validates bytes without touching ~15 route definitions.
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
  // Shadow Fight pot target â€” the promoter stakes a pot and only earns once
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
// the public route can still serve a stale copy) â€” this always hits the DB.
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
    if (compact === 'promotion' || compact === 'card' || compact === 'true') {
      shadowQuery = shadowQuery.select([
        'matchCategory', 'matchCategoryTwo', 'matchName', 'matchFighterA', 'matchFighterB',
        'fighterAId', 'fighterBId', 'fighterAImage', 'fighterBImage',
        'fighterAImageDeleteUrl', 'fighterBImageDeleteUrl', 'promotionBackground',
        'promotionBackgroundDeleteUrl', 'matchDescription', 'matchVideoUrl', 'matchDate',
        'matchTime', 'matchTokens', 'matchStatus', 'matchShadowStatus', 'matchShadowOpenStatus',
        'pot', 'profit', 'amountOverPotBudget', 'maxRounds', 'BoxingMatch', 'MMAMatch',
        'AffiliateIds', 'createdAt', 'updatedAt',
      ].join(' '));
    }
    shadowQuery = shadowQuery.populate('fighterAId fighterBId').sort({ _id: -1 });
    if (requestedLimit) shadowQuery = shadowQuery.limit(requestedLimit);
    const matches = await shadowQuery.lean(); // Sort by _id in descending order
    res.send(matches.map((item) => attachCombatFighterReadFallbacks(item, 'shadow')));
  } catch (err) {
    res.status(500).send({ message: 'Error fetching matches' });
  }
});





const matchSchema = new mongoose.Schema({
  // Optional game-mode metadata. Existing records and APIs remain fully compatible.
  gameMode: String,
  predictionFormat: String,
  scoringRuleVersion: String,
  matchCategory: String, // 'boxing' or 'mma'
  matchCategoryTwo: String,
  affiliateId: String,
  shadowFightId: String,
  sourceShadowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shadow' },
  promotedShadowFightId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shadow' },
  matchName: String,
  matchFighterA: String,
  matchFighterB: String,
  // Optional normalized fighter references. Existing string/image fields remain authoritative
  // until admin links or migrates data safely from the new combat fighter library.
  fighterAId: { type: mongoose.Schema.Types.ObjectId, ref: 'CombatFighter' },
  fighterBId: { type: mongoose.Schema.Types.ObjectId, ref: 'CombatFighter' },
  matchDescription: String,
  shadowTemplatesAdditionStatus: { type: Boolean, default: false },
  notificationSent: { type: Boolean, default: false },
  matchBy: { type: String, enum: ['admin', 'affiliate'], default: 'admin' },
  matchShadowStatus: { type: String, enum: ['active', 'inactive', 'draft'], default: 'active' },
  matchStatus: { type: String, enum: ['Finished', 'Ongoing', 'Draft', 'Scheduled', 'Live', 'Open', 'Closed'], default: 'Ongoing' },
  aiScoutingReport: mongoose.Schema.Types.Mixed,
matchShadowOpenStatus: { type: String, enum: ['open', 'closed'], default: 'open' },
matchReward: { type: String, enum: ['Rewarded', 'NotRewarded'], default: 'NotRewarded' },
  matchVideoUrl: String,
  matchPromotionalVideoUrl: String,
  matchDate: Date,
  matchDateKey: { type: String, index: true },
  eventTimeZone: String,
  matchTime: String,  // Store the match time as a string in 'HH:MM' format
  venue: String,
  // Auto-discovered UFC/upcoming-event metadata. These fields are additive and
  // keep manually created fight records backward-compatible while allowing
  // Google News/official UFC enrichment to dedupe and update calendar entries.
  autoDiscovered: { type: Boolean, default: false, index: true },
  autoDiscoveryProvider: String,
  autoDiscoveryKey: String,
  autoDiscoveryConfidence: Number,
  autoDiscoverySource: String,
  autoDiscoverySourceUrl: String,
  autoDiscoveryPayload: mongoose.Schema.Types.Mixed,
  autoDiscoveryLastSeenAt: Date,
  ufcEventNumber: Number,
  ufcEventType: String,
  officialEventUrl: String,
  eventCity: String,
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
  matchTokens: Number,
  pot: Number,
  // See shadowSchema: declared prize + minimum entrants is what removes house risk.
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
  profit: Number,
  amountOverPotBudget: Number,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  sourceShadowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shadow', index: true },
  activatedFromShadowAt: Date,
  maxRounds: Number,
  fighterAImageDeleteUrl: String,
  fighterBImageDeleteUrl: String,

  promotionBackgroundDeleteUrl:String,
  promotionBackground:String,
  fightPosterImage:String,
  fightPosterMobileImage:String,
  fightPosterImageDeleteUrl:String,
  fightPosterMobileImageDeleteUrl:String,

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
  // Shadow Fight pot target â€” the promoter stakes a pot and only earns once
  // entries have covered it (owner's rule: he waits for the pot to fill first).
  potTarget: { type: Number, default: 0 },
  promoterStake: { type: Number, default: 0 },
  profitZoneReachedAt: Date,
  userPredictions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Reference to the user
    predictionStatus: { type: String, enum: ['submitted', 'notSubmitted'], default: 'notSubmitted' }
  }],
  
  __v: Number
} , { timestamps: true });
matchSchema.index({ matchStatus: 1, matchShadowOpenStatus: 1, updatedAt: -1 });
matchSchema.index({ matchDate: -1, updatedAt: -1 });
matchSchema.index({ homepagePromoted: 1, homepagePromotionRank: -1, matchDate: 1, updatedAt: -1 });
matchSchema.index({ featuredThisWeek: 1, matchDate: 1 });
matchSchema.index({ featuredFight: 1, matchDate: 1 });
matchSchema.index({ affiliateId: 1, updatedAt: -1 });
matchSchema.index({ autoDiscoveryKey: 1 }, { sparse: true });
matchSchema.index({ ufcEventNumber: 1 }, { sparse: true });
matchSchema.index({ autoDiscovered: 1, matchDate: 1 });
matchSchema.pre('save', function cacheInitialMatchScoutingReport(next) {
  if (!this.aiScoutingReport) {
    const report = buildTemplateScoutingReport(buildScoutingPayload(this.toObject ? this.toObject() : this, []));
    if (report) this.aiScoutingReport = report;
  }
  next();
});


const Match = mongoose.models.Match || mongoose.model('Match', matchSchema);

function buildUpcomingEventAutomationPayload(match, context = {}) {
  const item = toPlainObject(match) || {};
  const contextInput = context.input && typeof context.input === 'object' ? context.input : {};
  const contextMetadata = context.metadata && typeof context.metadata === 'object' ? context.metadata : {};
  const title = item.matchName || `${item.matchFighterA || ''} vs ${item.matchFighterB || ''}`.trim() || contextInput.eventName || contextInput.title;
  return {
    trigger: context.trigger || 'upcoming_event',
    vertical: 'combat',
    sport: context.sport || item.matchCategoryTwo || item.matchCategory || contextInput.sport || 'mma',
    sourceEntity: {
      type: 'combat_match',
      id: String(item._id || item.id || contextInput.matchId || ''),
      label: title,
    },
    input: {
      matchId: String(item._id || item.id || contextInput.matchId || ''),
      matchName: item.matchName,
      title,
      eventName: contextInput.eventName || item.matchName,
      eventNumber: contextInput.eventNumber || item.ufcEventNumber,
      eventType: contextInput.eventType || item.ufcEventType,
      fighterA: item.matchFighterA,
      fighterB: item.matchFighterB,
      fighters: [item.matchFighterA, item.matchFighterB].filter(Boolean),
      matchDate: item.matchDate,
      matchTime: item.matchTime,
      matchType: item.matchType,
      maxRounds: item.maxRounds,
      description: item.matchDescription,
      venue: contextInput.venue || item.venue,
      city: contextInput.city || item.eventCity,
      articleSource: contextInput.articleSource || item.autoDiscoverySource,
      articleUrl: contextInput.articleUrl || item.autoDiscoverySourceUrl,
      officialEventUrl: contextInput.officialEventUrl || item.officialEventUrl,
      discoveryConfidence: contextInput.discoveryConfidence || item.autoDiscoveryConfidence,
      discoveryProvider: contextInput.discoveryProvider || item.autoDiscoveryProvider,
      ...contextInput,
    },
    metadata: {
      route: context.route || 'backend-upcoming-event-hook',
      action: context.action || 'upcoming-event-created',
      matchId: String(item._id || item.id || contextInput.matchId || ''),
      eventNumber: item.ufcEventNumber,
      discoveryProvider: item.autoDiscoveryProvider,
      discoveryKey: item.autoDiscoveryKey,
      source: context.source || 'fantasymmadness-backend',
      ...contextMetadata,
    },
    reason: context.reason || 'upcoming-event-created-in-backend',
  };
}

async function triggerUpcomingEventAutomationForMatch(match, context = {}) {
  if (!match || !app.locals.swarmPhase2?.triggerAutomationEvent) return null;
  try {
    return await app.locals.swarmPhase2.triggerAutomationEvent(buildUpcomingEventAutomationPayload(match, context));
  } catch (error) {
    return {
      ok: false,
      warning: context.warning || 'Fight was saved but upcoming-event automation failed.',
      error: error.message,
    };
  }
}

app.get('/api/update-shadow-open-status', verifyCronSecret, async (req, res) => {
  console.log('Cron job to update matchShadowOpenStatus started.');

  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Update only if `createdAt` exists and is older than 7 days
    const result = await Match.updateMany(
      { 
        $or: [
          { createdAt: { $exists: true, $lte: sevenDaysAgo } }, // If createdAt exists and is old
          { createdAt: { $exists: false } } // If createdAt doesn't exist, update just in case
        ],
        matchShadowOpenStatus: 'open'
      },
      { $set: { matchShadowOpenStatus: 'closed' } }
    );

    console.log(`Updated ${result.modifiedCount} matches to closed`);
    res.status(200).json({ message: `Updated ${result.modifiedCount} matches to closed` });
  } catch (error) {
    console.error('Error running cron job:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post("/update-match-shadow-open-status/:matchId", verifyAdminToken, async (req, res) => {
  const { matchId } = req.params;
  const { status } = req.body; // Expecting "open" or "closed" from frontend

  if (!["open", "closed"].includes(status)) {
    return res.status(400).json({ message: "Invalid status. Use 'open' or 'closed'." });
  }

  try {
    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    // Update match shadow open status
    match.matchShadowOpenStatus = status;
    await match.save();

    console.log(`Match ${matchId} shadow open status set to ${status}.`);
    res.status(200).json({ message: `Match shadow open status successfully set to ${status}.` });
  } catch (error) {
    console.error("Error updating match shadow open status:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});



app.post("/update-match-status-shadow/:matchId", verifyAdminOrAffiliateToken, requireAdminOrFightOwner((req) => req.params.matchId), async (req, res) => {
  const { matchId } = req.params;
  const { status } = req.body; // Expecting "active" or "inactive" from frontend

  if (!["active", "inactive"].includes(status)) {
    return res.status(400).json({ message: "Invalid status. Use 'active' or 'inactive'." });
  }

  try {
    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    // Update match status
    match.matchShadowStatus = status;
    await match.save();

    console.log(`Match ${matchId} status set to ${status}.`);
    res.status(200).json({ message: `Match successfully set to ${status}.` });
  } catch (error) {
    console.error("Error updating match status:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});



app.post("/activate-match/:matchId", verifyAdminOrAffiliateToken, requireAdminOrFightOwner((req) => req.params.matchId), async (req, res) => {
  const { matchId } = req.params;

  try {
    const match = await Match.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: "Match not found" });
    }

    // Activate match
    match.matchShadowStatus = "active";
    await match.save();

    console.log(`Match ${matchId} status set to active.`);

    // EMAIL IS FOR FEATURED FIGHTS ONLY.
    // This used to mail every user and every guest on every activation. Players
    // now receive all fights through the in-app bell
    // (GET /api/users/me/notifications), so the inbox is reserved for cards you
    // have actually marked as featured. An admin can force a send with
    // { "notify": true } in the body for a one-off.
    const isFeatured = Boolean(match.featuredThisWeek || match.featuredFight);
    const forceNotify = req.body?.notify === true;
    const shouldEmail = isFeatured || forceNotify;

    if (!shouldEmail) {
      console.log(`Match ${matchId} activated without email â€” not featured.`);
      clearPublicResponseCache();
      return res.status(200).json({
        message: "Fight activated. No email sent â€” mark it Featured This Week (or send notify:true) to email your list.",
        emailed: false,
        reason: 'NOT_FEATURED',
        inAppNotified: true,
      });
    }

    // Fetch users. Respect the two opt-outs that already exist on the account â€”
    // mailing someone who unsubscribed is the fastest route to a spam complaint.
    const users = await User.find({
      isSubscribed: { $ne: false },
      isNotificationsEnabled: { $ne: false },
    }).select('email firstName isSubscribed isNotificationsEnabled').limit(20000).lean();
    const nonRegisteredUsers = await Usernonregistered.find();

    // Match details for email
    const {
      matchName,
      matchFighterA,
      matchFighterB,
      fighterAImage,
      fighterBImage,
      matchDate,
      matchTime,
      maxRounds,
      matchType,
    } = match;

    // Prepare email function
    const sendEmail = (user, isRegistered) => {
      return {
        from: FMM_MAIL_FROM,
        to: user.email,
        subject: isRegistered ? "Fantasy MMA Madness - New Fight Alert!" : "Join Fantasy MMA Madness!",
        html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy MMA Madness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy MMA Madness</h2>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName || user.fullName},</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  ${isRegistered ? "A new fight has been added!" : "We noticed you havenâ€™t registered yet. Join now and donâ€™t miss out!"}
                </p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  <strong>Fight:</strong> ${matchFighterA} vs ${matchFighterB}
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Get Ready for Battle!</h2>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  Your next adrenaline-pumping challenge awaits. Enter the arena and put your prediction skills to the test!
                </p>
              </td>
            </tr>
            <tr>
              <td>
                <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:auto;">
                  <tr>
                    <td align="center" style="padding: 10px;">
                      <div style="width:60px; height:60px; border-radius:50%; border:3px solid red; background-color:#fff;">
                        <img src="${fighterAImage}" alt="${matchFighterA}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
                      </div>
                      <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterA}</p>
                    </td>
                    <td align="center" style="padding: 10px;">
                      <h1 style="margin:0; font-family: Arial, sans-serif; color: #333;">Vs</h1>
                    </td>
                    <td align="center" style="padding: 10px;">
                      <div style="width:60px; height:60px; border-radius:50%; border:3px solid blue; background-color:#fff;">
                        <img src="${fighterBImage}" alt="${matchFighterB}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
                      </div>
                      <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterB}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Date:</strong> ${matchDate}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  <strong>Time:</strong> ${new Date(`1970-01-01T${matchTime}:00`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })} EST
                </p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${maxRounds}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Type:</strong> ${matchType}</p>
                <p><a href="https://fantasymmadness.com/${isRegistered ? 'upcomingfights' : 'CreateAccount'}" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">
                  ${isRegistered ? "View Fight Details" : "Register Now"}
                </a></p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy MMA Madness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
      };
    };

    // Send emails
    const registeredEmails = users.map((user) => transporter.sendMail(sendEmail(user, true)));
    const nonRegisteredEmails = nonRegisteredUsers.map((user) => transporter.sendMail(sendEmail(user, false)));

    await Promise.all([...registeredEmails, ...nonRegisteredEmails]);

    console.log("Emails sent successfully to all users.");
    const swarmAutomation = await app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'fight_published',
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
        matchDate: match.matchDate,
        matchTime: match.matchTime,
        matchType: match.matchType,
        maxRounds: match.maxRounds,
        description: match.matchDescription,
      },
      metadata: { route: '/activate-match/:matchId', action: 'legacy-fight-published' },
      reason: 'fight-activated-in-backend',
    }).catch((error) => ({ ok: false, warning: 'Fight activated but swarm automation event failed.', error: error.message }));
    return res.status(200).json({ message: "Match activated & emails sent successfully", automation: swarmAutomation || null });
  } catch (error) {
    console.error("Error updating match status:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});


app.post('/api/matches/:matchId/promotional-video', verifyAdminOrAffiliateToken, requireAdminOrFightOwner((req) => req.params.matchId), async (req, res) => {
  const { matchId } = req.params;
  const { promotionalVideoUrl } = req.body;

  try {
    // Find the match by ID and update the promotional video URL
    const updatedMatch = await Match.findByIdAndUpdate(
      matchId,
      { matchPromotionalVideoUrl: promotionalVideoUrl },
      { new: true } // Return the updated document
    );

    if (!updatedMatch) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json({
      message: 'Promotional video URL updated successfully',
      match: updatedMatch,
    });
  } catch (error) {
    console.error('Error updating promotional video URL:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST API to update match reward status by matchId
app.post('/api/update-match-reward', verifyAdminToken, async (req, res) => {
  try {
    const { matchId, matchReward } = req.body;

    // Validate matchReward value
    if (!['Rewarded', 'NotRewarded'].includes(matchReward)) {
      return res.status(400).json({ success: false, message: 'Invalid matchReward value' });
    }

    // Find the match by matchId and update the matchReward status
    const match = await Match.findByIdAndUpdate(
      matchId, 
      { matchReward },
      { new: true }
    );

    if (!match) {
      return res.status(404).json({ success: false, message: 'Match not found' });
    }

    res.status(200).json({ success: true, message: 'Match reward status updated successfully', match });
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


app.get('/matchByName', async (req, res) => {
  const { matchName } = req.query;

  if (!matchName) {
      return res.status(400).json({ error: 'Match name is required.' });
  }

  try {
      const match = await Match.findOne(applyFightPublicVisibilityFilter({ matchName }, req.query)).populate('fighterAId fighterBId').lean();

      if (!match) {
          return res.status(404).json({ message: 'Match not found' });
      }

      res.status(200).json(attachCombatFighterReadFallbacks(match, 'match'));
  } catch (error) {
      console.error('Error fetching match details:', error);
      res.status(500).json({ message: 'Server error' });
  }
});




// POST API to receive matchId and matchVideoUrl
app.post('/updateMatchVideo', verifyAdminToken, async (req, res) => {
  const { matchId, matchVideoUrl } = req.body;

  // Basic validation
  if (!matchId || !matchVideoUrl) {
    return res.status(400).json({ message: 'matchId and matchVideoUrl are required' });
  }

  try {
    // Find the match by matchId and update the matchVideoUrl if it exists, otherwise create a new one
    const updatedMatch = await Match.findOneAndUpdate(
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



app.post('/finishMatch/:matchId', verifyAdminToken, async (req, res) => {
  try {
    const { matchId } = req.params;

    // Find the match by ID and update the status to 'Finished'
    const match = await Match.findByIdAndUpdate(
      matchId, 
      { matchStatus: 'Finished' }, 
      { new: true } // This option returns the updated document
    );

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json({ message: 'Match status updated to Finished', match });
  } catch (error) {
    console.error('Error finishing match:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});
// GET API to retrieve a match by ID
app.get('/api/matches/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Find the match by ID
    const match = await Match.findById(id).populate('fighterAId fighterBId').lean();

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.status(200).json(attachCombatFighterReadFallbacks(match, 'match'));
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


// Admin-friendly fight edit helpers used by the updated frontend.
// These endpoints are additive aliases over the existing legacy routes.
app.get('/api/shadow/:id', async (req, res) => {
  try {
    const shadowFight = await Shadow.findById(req.params.id).populate('fighterAId fighterBId').lean();
    if (!shadowFight) return res.status(404).json({ message: 'Shadow fight not found' });
    res.status(200).json(attachCombatFighterReadFallbacks(shadowFight, 'shadow'));
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.put('/api/admin/matches/:id/video', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight video' });
  }
});

app.post('/api/admin/matches/:id/video', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight video' });
  }
});

app.put('/api/admin/shadow/:id/video', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight video' });
  }
});

app.post('/api/admin/shadow/:id/video', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight video' });
  }
});

app.put('/api/admin/matches/:id/scoring', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight scoring' });
  }
});

app.post('/api/admin/matches/:id/scoring', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight scoring' });
  }
});

app.put('/api/admin/shadow/:id/scoring', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight scoring' });
  }
});

app.post('/api/admin/shadow/:id/scoring', verifyAdminToken, async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight scoring' });
  }
});

async function safelyDeleteFightImages(fight) {
  const deleteFromCloudinary = async (publicId) => {
    if (!publicId) return;
    try {
      await cloudinary.uploader.destroy(publicId);
    } catch (imageError) {
      console.warn('Fight image delete skipped:', imageError.message);
    }
  };

  await Promise.all([
    deleteFromCloudinary(fight?.fighterAImageDeleteUrl),
    deleteFromCloudinary(fight?.fighterBImageDeleteUrl),
    deleteFromCloudinary(fight?.promotionBackgroundDeleteUrl),
  ]);
}

async function refundMatchScoresIfRequested(match, matchId, updateWallet) {
  if (updateWallet !== 'true') return { refundedUsers: 0 };

  const scores = await Score.find({ matchId });
  const matchTokens = Number(match?.matchTokens || 0);
  let refundedUsers = 0;

  await Promise.all(scores.map(async (score) => {
    const user = await User.findById(score.playerId);
    if (user) {
      const balanceBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
      user.tokens = addWalletTokens(user.tokens, matchTokens);
      await user.save();
      await recordWalletMove({
        userId: user._id,
        amount: matchTokens,
        balanceBefore,
        balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
        reason: 'fight_removed_refund',
        reference: String(score.matchId || ''),
      });
      refundedUsers += 1;
    }
  }));

  return { refundedUsers };
}

function isValidMongoObjectId(id) {
  return Boolean(id && mongoose.Types.ObjectId.isValid(String(id)));
}

function normalizeFightDeleteItems(payload = {}) {
  const rawItems = Array.isArray(payload.items) ? payload.items
    : Array.isArray(payload.ids) ? payload.ids
      : Array.isArray(payload.fightIds) ? payload.fightIds
        : Array.isArray(payload.matchIds) ? payload.matchIds
          : [];

  return rawItems
    .map((item) => {
      if (typeof item === 'string') return { id: item };
      if (!item || typeof item !== 'object') return null;
      return {
        id: item.id || item._id || item.matchId || item.fightId,
        sourceType: item.sourceType || item.source || item.type,
      };
    })
    .filter((item) => item && isValidMongoObjectId(item.id));
}

async function deleteFightAcrossCollections(id, options = {}) {
  const { sourceType, affiliateId, updateWallet } = options;
  // Public reads are cached, so a delete that does not invalidate leaves the
  // fight on the website and in the app until the cache ages out. That is the
  // "I deleted it and nothing happened" report â€” cleared at every exit below.
  const done = (result) => { clearPublicResponseCache(); return result; };

  if (!isValidMongoObjectId(id)) {
    return { ok: false, id, code: 'INVALID_ID', message: 'Invalid fight id.' };
  }

  const normalizedSource = String(sourceType || '').trim().toLowerCase();
  const shouldTryShadowFirst = ['shadow', 'shadowfight', 'template'].includes(normalizedSource);
  const lookupOrder = shouldTryShadowFirst
    ? [{ model: Shadow, sourceType: 'shadow' }, { model: Match, sourceType: 'match' }]
    : [{ model: Match, sourceType: 'match' }, { model: Shadow, sourceType: 'shadow' }];

  let found = null;
  for (const candidate of lookupOrder) {
    const fight = await candidate.model.findById(id);
    if (fight) {
      found = { ...candidate, fight };
      break;
    }
  }

  if (!found) {
    return { ok: false, id, code: 'FIGHT_NOT_FOUND', message: 'Fight not found in Match or Shadow collections.' };
  }

  const { fight, model, sourceType: resolvedSourceType } = found;
  await safelyDeleteFightImages(fight);

  let refundResult = { refundedUsers: 0 };
  if (resolvedSourceType === 'match') {
    refundResult = await refundMatchScoresIfRequested(fight, id, updateWallet);
  }

  await model.findByIdAndDelete(id);
  const scoreDeleteResult = await Score.deleteMany({ matchId: id });

  await Shadow.updateMany(
    { 'AffiliateIds.matchId': id },
    { $pull: { AffiliateIds: affiliateId
      ? { AffiliateId: affiliateId, matchId: id }
      : { matchId: id }
    } }
  );

  try {
    const notification = new Notification({
      title: `${resolvedSourceType === 'shadow' ? 'Shadow Fight' : 'Fight'} Deleted: ${fight.matchName || 'Untitled Fight'}`,
    });
    await notification.save();
  } catch (notificationError) {
    console.warn('Fight delete notification skipped:', notificationError.message);
  }

  return done({
    ok: true,
    id,
    sourceType: resolvedSourceType,
    title: fight.matchName,
    deletedScores: scoreDeleteResult?.deletedCount || 0,
    refundedUsers: refundResult.refundedUsers || 0,
  });
}

async function handleBulkFightDelete(req, res) {
  try {
    const items = normalizeFightDeleteItems(req.body);

    if (!items.length) {
      return res.status(400).json({
        ok: false,
        message: 'Please provide fight ids in ids, fightIds, matchIds, or items.',
      });
    }

    const results = [];
    for (const item of items) {
      const result = await deleteFightAcrossCollections(item.id, {
        sourceType: item.sourceType,
        affiliateId: req.query.affiliateId || req.body.affiliateId,
        updateWallet: String(req.query.updateWallet || req.body.updateWallet || 'false'),
      });
      results.push(result);
    }

    const deletedCount = results.filter((item) => item.ok).length;
    const failedCount = results.length - deletedCount;

    return res.status(failedCount && !deletedCount ? 404 : 200).json({
      ok: failedCount === 0,
      message: `${deletedCount} fight(s) deleted${failedCount ? `, ${failedCount} failed` : ''}.`,
      deletedCount,
      failedCount,
      results,
    });
  } catch (error) {
    console.error('Bulk fight delete failed:', error);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
}

// SECURITY: admin-only. Deleting fights destroys the entries attached to them.
app.post('/api/admin/fights/bulk-delete', verifyAdminToken, handleBulkFightDelete);
app.delete('/api/admin/fights/bulk-delete', verifyAdminToken, handleBulkFightDelete);
app.post('/api/matches/bulk-delete', verifyAdminToken, handleBulkFightDelete);
app.delete('/api/matches/bulk-delete', verifyAdminToken, handleBulkFightDelete);

app.delete('/api/matches/:id', verifyAdminOrAffiliateToken, requireAdminOrFightOwner((req) => req.params.id), async (req, res) => {
  try {
    const result = await deleteFightAcrossCollections(req.params.id, {
      sourceType: req.query.sourceType || req.query.source,
      affiliateId: req.query.affiliateId,
      updateWallet: String(req.query.updateWallet || 'false'),
    });

    if (!result.ok) {
      return res.status(result.code === 'INVALID_ID' ? 400 : 404).json({
        message: result.message,
        code: result.code,
        id: result.id,
      });
    }

    return res.status(200).json({
      message: `${result.sourceType === 'shadow' ? 'Shadow fight' : 'Match'} deleted successfully.`,
      result,
    });
  } catch (error) {
    console.error('Fight delete failed:', error);
    res.status(500).json({ message: 'Server error' });
  }
});


app.post(
  '/addMatch',
  verifyAdminOrAffiliateToken,
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' }
  ]),
  async (req, res) => {
    // Declared out here because the shadow-template linkage below runs OUTSIDE
    // the try block and still needs the pinned promoter id.
    let effectiveAffiliateId = null;
    try {
      const {
        BoxingMatch,
        MMAMatch,
        matchCategoryTwo,
        shadowFightId,
        maxRounds,
        affiliateId,
        matchBy,
        profit,
        amountOverPotBudget,
        matchCategory,
        matchName,
        matchFighterA,
        matchFighterB,
        matchDescription,
        matchVideoUrl,
        matchDate,
        matchTime,
        matchTokens,
        matchStatus,
        pot,
        matchType,
        fighterAId,
        fighterBId,
        fighterAImageUrl,
        fighterAImageDeleteUrlFromReq,
        fighterBImageUrl,
        fighterBImageDeleteUrlFromReq,
        promotionBackgroundUrl,
        promotionBackgroundDeleteUrlFromReq
      } = req.body;

      // An affiliate promoting a card is pinned to their own id: the body value
      // is ignored so nobody can post a fight in another promoter's name (and
      // collect their rake). Admin posts keep whatever affiliateId they set.
      effectiveAffiliateId = affiliateId;
      if (req.actorRole === 'affiliate') {
        effectiveAffiliateId = req.affiliateActorId;
        if (!effectiveAffiliateId) {
          return res.status(403).json({ message: 'Affiliate session is missing an account id.', code: 'NO_AFFILIATE_ID' });
        }

        // Promoter staking is optional. Unstaked paid cards use the existing
        // minimum-entrant/auto-refund settlement guard; fully staked cards are
        // guaranteed. A previous route-level rejection contradicted that
        // settlement model and prevented ordinary affiliates from publishing.
      }

      // Upload images to Cloudinary if files are provided; otherwise, use URLs from req.body
      const uploadToCloudinary = (fileBuffer, folder) =>
        new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(fileBuffer);
        });

      let fighterAImage = fighterAImageUrl || null;
      let fighterBImage = fighterBImageUrl || null;
      let promotionBackground = promotionBackgroundUrl || null;

      let fighterAImageDeleteUrl = fighterAImageDeleteUrlFromReq || null;
      let fighterBImageDeleteUrl = fighterBImageDeleteUrlFromReq || null;
      let promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrlFromReq || null;

      if (req.files?.fighterAImage) {
        const resultA = await uploadToCloudinary(req.files.fighterAImage[0].buffer, 'fighter_images');
        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;
      }

      if (req.files?.fighterBImage) {
        const resultB = await uploadToCloudinary(req.files.fighterBImage[0].buffer, 'fighter_images');
        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;
      }

      if (req.files?.promotionBackground) {
        const resultBackground = await uploadToCloudinary(req.files.promotionBackground[0].buffer, 'promotion_backgrounds');
        promotionBackground = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;
      }

      const fighterSelection = await resolveCombatFighterSelectionForMatchInput({
        fighterAId, fighterBId, matchFighterA, matchFighterB, fighterAImage, fighterBImage,
        fighterAImagePublicId: fighterAImageDeleteUrl, fighterBImagePublicId: fighterBImageDeleteUrl, matchCategory: matchCategoryTwo || matchCategory,
      });
      const requestedMatchDate = matchDate || req.body?.fightDate || req.body?.scheduledDate;
      const requestedMatchTime = matchTime || req.body?.fightTime || req.body?.scheduledTime;
      const normalizedRequestedDate = normalizeCalendarDateInput(requestedMatchDate);
      if (requestedMatchDate && !normalizedRequestedDate.date) {
        return res.status(400).json({ message: 'A valid match date is required.' });
      }

      // Admin-created/affiliate-promoted public fight cards are LIVE by design.
      // Historical/template records live in Shadow and are created by the rollover job.
      const normalizedLiveMatchType = 'LIVE';
      const normalizedLiveStatus = req.actorRole === 'affiliate' ? 'Ongoing' : (matchStatus || 'Ongoing');

      // Create match data object
      const matchData = applyCombatFighterSelectionToMatchPayload({
        matchCategory,
        matchName,
        matchFighterA,
        matchFighterB,
        matchDescription,
        matchVideoUrl,
        matchDate: normalizedRequestedDate.date || requestedMatchDate,
        matchDateKey: normalizedRequestedDate.key || undefined,
        eventTimeZone: req.body?.eventTimeZone || req.body?.timezone || undefined,
        matchTime: requestedMatchTime,
        matchTokens,
        matchStatus: normalizedLiveStatus,
        pot,
        matchType: normalizedLiveMatchType,
        affiliateId: effectiveAffiliateId,
        // What the promoter has behind the prize, and the pot the fill gauge
        // measures against. Zero on admin cards and on free cards.
        promoterStake: Math.max(0, Math.round(Number(req.body.promoterStake) || 0)),
        potTarget: Math.max(0, Math.round(Number(req.body.potTarget) || 0)),
        autoRefundIfShort: req.body.autoRefundIfShort === undefined
          ? true
          : ['true', '1', 'yes', true].includes(req.body.autoRefundIfShort),
        matchBy,
        profit,
        amountOverPotBudget,
        maxRounds,
        shadowFightId,
        matchCategoryTwo,
        fighterAImage,
        fighterBImage,
        fighterAImageDeleteUrl,
        fighterBImageDeleteUrl,
        promotionBackground,
        promotionBackgroundDeleteUrl
      }, fighterSelection);

      if (mongoose.Types.ObjectId.isValid(String(shadowFightId || ''))) {
        matchData.sourceShadowId = shadowFightId;
        matchData.promotedShadowFightId = shadowFightId;
      }
      // NOT clearing matchFighterA/matchFighterB here anymore: this used to wipe
      // them immediately on creation, relying entirely on fighterAId/fighterBId
      // populating correctly on every future read. When that population ever
      // came back empty (deleted fighter, ref mismatch, etc.) the fight had no
      // name left at all â€” "FIGHTER A VS FIGHTER B" placeholders forever, with
      // real photos. The name string is now kept as a permanent fallback;
      // attachCombatFighterReadFallbacks still prefers the live fighter-library
      // name whenever population succeeds.
      Object.assign(matchData, buildAutoHomepagePromotionFields({
        body: req.body,
        admin: req.admin,
        actor: matchBy || effectiveAffiliateId || 'addMatch',
      }));

      // Conditionally append BoxingMatch and MMAMatch only if they have values
      if (BoxingMatch) {
        matchData.BoxingMatch = JSON.parse(BoxingMatch);
      }

      if (MMAMatch) {
        matchData.MMAMatch = JSON.parse(MMAMatch);
      }
      if (req.body.addToShadow === 'true' || req.body.addToShadow === true) {
        matchData.shadowTemplatesAdditionStatus = true;
    }
      // Save the match details to the database
      const newMatch = new Match(matchData);
      const savedMatch = await newMatch.save();
      clearPublicResponseCache();

  // Roster upkeep: make sure both fighters exist as profiles and their
  // appearance counts are current. Wrapped so a roster problem can never stop a
  // fight from being published.
  try {
    for (const [name, image] of [
      [savedMatch.matchFighterA, savedMatch.fighterAImage],
      [savedMatch.matchFighterB, savedMatch.fighterBImage],
    ]) {
      if (!fighterKeyOf(name)) continue;
      await upsertFighterProfile({
        name,
        sport: String(savedMatch.matchCategory || '').toLowerCase(),
        imageUrl: image || '',
      });
      await recountFighterAppearances(fighterKeyOf(name));
    }
  } catch (rosterError) {
    console.error('Fight saved but roster upkeep failed:', rosterError.message);
  }

  // Admin-console record only. Players get this through
  // GET /api/users/me/notifications, which derives from the fight itself â€” a row
  // per user per fight would be tens of thousands of writes per publish.
  const notification = new Notification({
      title: `New Fight Added: ${savedMatch.matchName}`,
    });
    await notification.save();
 

  // Now that match is saved, store affiliateId and matchId in the Shadow schema
  const shadowFight = await Shadow.findById(shadowFightId);
  if (shadowFight) {
    const affiliateExists = shadowFight.AffiliateIds.some(item => item.AffiliateId.toString() === String(effectiveAffiliateId) && item.matchId.toString() === savedMatch._id.toString());

    if (!affiliateExists) {
      shadowFight.AffiliateIds.push({
        AffiliateId: effectiveAffiliateId,
        matchId: savedMatch._id,
      });
      await shadowFight.save();
    }
  }
  

  if (req.body.notify === 'true' || req.body.notify === true) {

  // Opt-in already, but it was mailing people who had unsubscribed and loading
  // whole user documents (password hashes included) to do it.
  const users = await User.find({
    isSubscribed: { $ne: false },
    isNotificationsEnabled: { $ne: false },
  }).select('email firstName lastName').limit(20000).lean();
  
  
  const registeredUserMailPromises = users.map(user => {
    const mailOptions = {
      from: FMM_MAIL_FROM,
      to: user.email,
      subject: 'Fantasy mmadness',
   html: `
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
    <!-- Logo Section -->
    <tr>
      <td align="center" style="padding: 15px 0;">
        <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy mmadness Logo" style="width:100px;" />
        <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
      </td>
    </tr>
    
    <!-- Greeting Section -->
    <tr>
      <td style="padding: 10px 0;">
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We are excited to announce a new fight has been added:</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Added:</strong> ${matchName}</p>
      </td>
    </tr>
    
    <!-- New Captivating Section -->
    <tr>
      <td align="center" style="padding: 20px; background-color:#f8f8f8;">
        <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Gear Up for Battle!</h2>
        <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
          Your next adrenaline-pumping challenge awaits. Enter the arena and put your prediction skills to the test.
          Every punch, kick, and knockout is a step closer to victory!
        </p>
      </td>
    </tr>
    
    <!-- Fighter Section -->
    <tr>
      <td>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; margin:auto;">
          <tr>
            <!-- Fighter A -->
            <td align="center" style="padding: 10px;">
              <div style="width:60px; height:60px; border-radius:50%; border:3px solid red; background-color:#fff;">
                <img src="${fighterAImage}" alt="Fighter A" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
              </div>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterA}</p>
            </td>

            <!-- VS -->
            <td align="center" style="padding: 10px;">
              <h1 style="margin:0; font-family: Arial, sans-serif; color: #333;">Vs</h1>
            </td>

            <!-- Fighter B -->
            <td align="center" style="padding: 10px;">
              <div style="width:60px; height:60px; border-radius:50%; border:3px solid blue; background-color:#fff;">
                <img src="${fighterBImage}" alt="Fighter B" style="width:100%; height:100%; object-fit:cover; border-radius:50%;" />
              </div>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333; text-align:center;">${matchFighterB}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Match Details Section -->
    <tr>
      <td style="padding: 10px;">
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Date:</strong> ${matchDate}</p>
       <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
  <strong>Time:</strong> ${new Date(`1970-01-01T${matchTime}:00`).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })} EST</p>
 <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${maxRounds}</p>
        <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Type:</strong> ${matchType}</p>
        <p><a href="https://fantasymmadness.com/upcomingfights" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">Click here</a> to get more details</p>
      </td>
    </tr>

    <!-- Footer Section -->
    <tr>
      <td align="center" style="padding: 15px 0;">
        <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy mmadness Logo" style="width:70px;" />
        <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
      </td>
    </tr>
  </table>
`

,
    };

    return transporter.sendMail(mailOptions);
  });

  // Wait for all emails to be sent
  try {
    await Promise.all(mailPromises);
    console.log('Emails sent successfully');
  } catch (error) {
    console.error('Error sending emails:', error);
  }



  // Fetch non-registered users
const nonRegisteredUsers = await Usernonregistered.find();

const nonRegisteredUserMailPromises = nonRegisteredUsers.map(user => {
  const mailOptions = {
    from: FMM_MAIL_FROM,
    to: user.email, // Assuming you have email field here
    subject: 'Join the Excitement at Fantasy mmadness!',
    html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy mmadness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy mmadness</h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.fullName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We noticed you haven't registered yet, and we want to invite you to join the Fantasy mmadness community!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Sign up now to unleash your prediction skills and be part of the action!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Don't miss out on the next thrilling fight between <strong>${matchFighterA}</strong> and <strong>${matchFighterB}</strong>!</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Date: <strong>${matchDate}</strong>, Time: <strong>${matchTime}</strong>.</p>
            <p><a href="https://fantasymmadness.com/CreateAccount" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">Register Now</a></p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy mmadness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          </td>
        </tr>
      </table>
    `,
  };

  return transporter.sendMail(mailOptions);
});

  // Wait for all emails to be sent
  try {
    await Promise.all([...registeredUserMailPromises, ...nonRegisteredUserMailPromises]);
    console.log('Emails sent successfully to all users');
  } catch (error) {
    console.error('Error sending emails:', error);
  } 
  
  
} else {
    console.log('Notification skipped because notify is set to false');
  }

  const swarmAutomation = await triggerUpcomingEventAutomationForMatch(savedMatch, {
    route: '/addMatch',
    action: 'legacy-upcoming-event-created',
    reason: 'combat-match-added-in-backend',
    warning: 'Fight was added but upcoming-event automation failed.',
  });

  // Respond with success and the saved match ID
  res.status(200).json({ message: 'Match Added Successfully and Notifications Sent', matchId: savedMatch._id, automation: swarmAutomation || null });
} catch (error) {
  console.error('Error adding match:', error);
  const isValidationError = error?.name === 'ValidationError' || error?.name === 'CastError';
  res.status(isValidationError ? 400 : 500).json({
    message: isValidationError ? (error.message || 'The fight information is invalid.') : 'The fight could not be published.',
    code: isValidationError ? 'INVALID_FIGHT_DATA' : 'PUBLISH_FAILED',
  });
}
}
);
app.post(
  '/editMatch',
  verifyAdminToken,
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' },
  ]),
  async (req, res) => {
    const {
      matchId,
      matchCategoryTwo,
      maxRounds,
      profit,
      matchCategory,
      matchName,
      matchFighterA,
      matchFighterB,
      matchDescription,
      matchDate,
      matchTime,
      matchTokens,
      pot,
      matchType,
      fighterAId,
      fighterBId,
      fighterAImageUrl,
      fighterBImageUrl,
      promotionBackgroundUrl,
      addToShadow,
      matchVideoUrl,
      matchPromotionalVideoUrl,
      matchStatus,
      matchShadowStatus,
      matchShadowOpenStatus,
      BoxingMatch,
      MMAMatch,
    } = req.body;

    let fighterAImage,
      fighterBImage,
      fighterAImageDeleteUrl,
      fighterBImageDeleteUrl,
      promotionBackground,
      promotionBackgroundDeleteUrl;

    try {
      // Check if matchId is provided and valid
      if (!matchId) {
        return res.status(400).json({ error: 'matchId is required' });
      }

      // Fetch the existing match by matchId
      const existingMatch = await Match.findById(matchId);
      if (!existingMatch) {
        return res.status(404).json({ error: 'Match not found' });
      }

      // Use the image URLs directly if they are provided
      if (fighterAImageUrl) fighterAImage = fighterAImageUrl;
      if (fighterBImageUrl) fighterBImage = fighterBImageUrl;

      // Handle image uploads for Fighter A
      if (req.files.fighterAImage) {
        const resultA = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'fighterAImages' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterAImage[0].buffer);
        });

        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;
      }

      // Handle image uploads for Fighter B
      if (req.files.fighterBImage) {
        const resultB = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'fighterBImages' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.fighterBImage[0].buffer);
        });

        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;
      }

      // Handle promotion background upload
      if (req.files.promotionBackground) {
        const resultBackground = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'promotionBackgrounds' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(req.files.promotionBackground[0].buffer);
        });

        promotionBackground = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;
      } else if (promotionBackgroundUrl) {
        // Use the existing promotion background URL if provided
        promotionBackground = promotionBackgroundUrl;
      }

      const fighterSelection = await resolveCombatFighterSelectionForMatchInput({
        fighterAId, fighterBId, matchFighterA, matchFighterB, fighterAImage, fighterBImage,
        fighterAImagePublicId: fighterAImageDeleteUrl, fighterBImagePublicId: fighterBImageDeleteUrl, matchCategory: matchCategoryTwo || matchCategory,
      });
      const selectedFighterPatch = applyCombatFighterSelectionToMatchPayload({}, fighterSelection);

      // Update the match object. Use explicit provided-value checks so 0 remains valid.
      assignIfProvided(existingMatch, 'fighterAId', selectedFighterPatch.fighterAId);
      assignIfProvided(existingMatch, 'fighterBId', selectedFighterPatch.fighterBId);
      assignIfProvided(existingMatch, 'matchCategory', matchCategory);
      if (addToShadow === 'true' || addToShadow === true) existingMatch.shadowTemplatesAdditionStatus = true;
      assignIfProvided(existingMatch, 'matchName', matchName);
      assignIfProvided(existingMatch, 'matchFighterA', matchFighterA);
      assignIfProvided(existingMatch, 'matchFighterB', matchFighterB);
      assignIfProvided(existingMatch, 'matchDescription', matchDescription);
      if (matchDate !== undefined && matchDate !== null && matchDate !== '') {
        const normalizedDate = normalizeCalendarDateInput(matchDate);
        if (!normalizedDate.date) return res.status(400).json({ error: 'A valid match date is required.' });
        existingMatch.matchDate = normalizedDate.date;
        existingMatch.matchDateKey = normalizedDate.key;
      }
      assignIfProvided(existingMatch, 'eventTimeZone', req.body?.eventTimeZone || req.body?.timezone);
      assignIfProvided(existingMatch, 'matchTime', matchTime);
      assignIfProvided(existingMatch, 'matchTokens', matchTokens);
      assignIfProvided(existingMatch, 'pot', pot);
      assignIfProvided(existingMatch, 'matchType', matchType);
      assignIfProvided(existingMatch, 'profit', profit);
      assignIfProvided(existingMatch, 'maxRounds', maxRounds);
      assignIfProvided(existingMatch, 'matchCategoryTwo', matchCategoryTwo);
      assignIfProvided(existingMatch, 'matchVideoUrl', matchVideoUrl);
      assignIfProvided(existingMatch, 'matchPromotionalVideoUrl', matchPromotionalVideoUrl);
      assignIfProvided(existingMatch, 'matchStatus', matchStatus);
      assignIfProvided(existingMatch, 'matchShadowStatus', matchShadowStatus);
      assignIfProvided(existingMatch, 'matchShadowOpenStatus', matchShadowOpenStatus);

      const parsedBoxingMatch = parseMaybeJson(BoxingMatch);
      const parsedMMAMatch = parseMaybeJson(MMAMatch);
      if (parsedBoxingMatch) existingMatch.BoxingMatch = parsedBoxingMatch;
      if (parsedMMAMatch) existingMatch.MMAMatch = parsedMMAMatch;

      if (!fighterAImage && selectedFighterPatch.fighterAImage) fighterAImage = selectedFighterPatch.fighterAImage;
      if (!fighterBImage && selectedFighterPatch.fighterBImage) fighterBImage = selectedFighterPatch.fighterBImage;
      if (!fighterAImageDeleteUrl && selectedFighterPatch.fighterAImageDeleteUrl) fighterAImageDeleteUrl = selectedFighterPatch.fighterAImageDeleteUrl;
      if (!fighterBImageDeleteUrl && selectedFighterPatch.fighterBImageDeleteUrl) fighterBImageDeleteUrl = selectedFighterPatch.fighterBImageDeleteUrl;

      if (fighterAImage) existingMatch.fighterAImage = fighterAImage;
      if (fighterBImage) existingMatch.fighterBImage = fighterBImage;
      if (fighterAImageDeleteUrl)
        existingMatch.fighterAImageDeleteUrl = fighterAImageDeleteUrl;
      if (fighterBImageDeleteUrl)
        existingMatch.fighterBImageDeleteUrl = fighterBImageDeleteUrl;

      if (promotionBackground)
        existingMatch.promotionBackground = promotionBackground;
      if (promotionBackgroundDeleteUrl)
        existingMatch.promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrl;

      // NOTE: previously called clearLegacyFighterFieldsForLibraryRefs(existingMatch)
      // here, which wiped matchFighterA/matchFighterB back to blank on every save
      // whenever the record had a fighterAId/fighterBId ref â€” undoing the admin's
      // just-typed name edit in the same request, and blanking names on any fight
      // linked to the fighter library (now the normal case). The name the admin
      // submits (assignIfProvided above) is the one that should stick.

      // Save the updated match to the database
      const updatedMatch = await existingMatch.save();

  const notification = new Notification({
      title: `Fight Updated: ${updatedMatch.matchName}`,
    });
    await notification.save();
 
      // Public reads are cached; without this an edited fight keeps showing
      // its old pot, date or images on the website and in the app.
      clearPublicResponseCache();

      // Respond with success and the updated match data
      res.status(200).json({
        message: 'Match updated successfully',
        matchId: updatedMatch._id,
      });
    } catch (error) {
      console.error('Error updating match:', error);
      res
        .status(500)
        .json({ error: 'An error occurred while updating the match' });
    }
  }
);





// Get Matches API
app.get('/match', async (req, res) => {
  try {
    let query = {};

    if (!isAllFilterValue(req.query.status)) {
      const statusValue = String(req.query.status || '').trim().toLowerCase();
      const now = new Date();
      if (['playable', 'prediction', 'predictions', 'can-predict', 'open-for-predictions', 'active-contests'].includes(statusValue)) {
        // By default, keep all non-draft fights visible to users. If the frontend
        // explicitly asks for strict/open-only fights, apply the old open-status filter.
        if (shouldUseStrictPlayableFightFilter(req.query)) {
          query = appendAndFilter(query, buildPredictionEligibleFightFilter());
        }
      } else if (['past', 'previous', 'completed', 'complete', 'finished'].includes(statusValue)) {
        query.$or = [
          ...(query.$or || []),
          { matchStatus: { $in: ['Finished', 'Closed', 'finished', 'closed', 'Completed', 'completed'] } },
          { matchShadowOpenStatus: { $in: ['closed', 'Closed'] } },
          { matchDate: { $lt: now } },
        ];
      } else if (['upcoming', 'future', 'scheduled'].includes(statusValue)) {
        query.$or = [
          ...(query.$or || []),
          { matchStatus: { $in: ['Scheduled', 'Open', 'Live', 'Ongoing', 'scheduled', 'open', 'live', 'ongoing'] } },
          { matchShadowOpenStatus: { $in: ['open', 'Open'] } },
          { matchDate: { $gte: now } },
        ];
      } else {
        const statusRegex = exactTextRegex(req.query.status);
        if (statusRegex) query.matchStatus = statusRegex;
      }
    }

    if (!isAllFilterValue(req.query.category)) {
      query = appendAndFilter(query, buildEffectiveFightCategoryFilter(req.query.category));
    }

    if (!isAllFilterValue(req.query.shadowStatus)) query.matchShadowStatus = exactTextRegex(req.query.shadowStatus) || req.query.shadowStatus;
    if (!isAllFilterValue(req.query.openStatus)) query.matchShadowOpenStatus = exactTextRegex(req.query.openStatus) || req.query.openStatus;
    if (!isAllFilterValue(req.query.matchType || req.query.type)) {
      const matchTypeRegex = exactTextRegex(req.query.matchType || req.query.type);
      if (matchTypeRegex) query.matchType = matchTypeRegex;
    }

    if (shouldUseStrictPlayableFightFilter(req.query) && shouldRequestPredictionEligibleFights(req.query)) {
      query = appendAndFilter(query, buildPredictionEligibleFightFilter());
    }

    const visibleQuery = applyFightPublicVisibilityFilter(query, req.query);
    let matchRows = await applyFightFreshSortLean(Match.find(visibleQuery).populate('fighterAId fighterBId'));
    let shadowRows = [];

    // Safety fallback for legacy records: if the stricter public query produces no
    // results, keep the same base filters and remove only explicit Draft fights in
    // memory. This prevents public fight pages from going blank while still hiding drafts.
    if (!matchRows.length && !shouldIncludeDraftFights(req.query)) {
      const fallback = await applyFightFreshSortLean(Match.find(query).populate('fighterAId fighterBId'));
      matchRows = fallback.filter((item) => !isDraftFightRecord(item));
    }

    // Always include Shadow rows in the legacy match feed. Previously Shadow rows
    // were only used when Match returned empty, which made calendars/affiliate
    // dashboards miss most template fights once any live match existed.
    try {
      const rawShadowRows = await applyFightFreshSortLean(Shadow.find(visibleQuery).populate('fighterAId fighterBId'));
      shadowRows = shouldIncludeDraftFights(req.query)
        ? rawShadowRows
        : rawShadowRows.filter((item) => !isDraftFightRecord(item));
    } catch (fallbackError) {
      console.warn('Legacy /match shadow merge failed:', fallbackError.message);
    }

    let match = [
      ...matchRows.map((item) => ({ ...item, sourceType: 'match' })),
      ...shadowRows.map((item) => ({ ...item, sourceType: 'shadow' })),
    ];

    if (shouldUseStrictPlayableFightFilter(req.query) && shouldRequestPredictionEligibleFights(req.query)) {
      match = match.filter((item) => isPredictionEligibleFightRecord(item));
    }

    if (!isAllFilterValue(req.query.category)) {
      match = match.filter((item) => isFightRecordInEffectiveCategory(item, req.query.category));
    }

    let responseItems = match.map((item) => attachCombatFighterReadFallbacks(item, item.sourceType || 'match'));
    responseItems = await attachPlayerPredictionStateToFightItems(responseItems, req.query);
    responseItems = applyPublicFightStatusIntent(responseItems, req.query);
    const requestedTimeline = String(req.query.status || req.query.bucket || req.query.view || '').trim().toLowerCase();
    if (!requestedTimeline || ['upcoming', 'future', 'scheduled', 'active-contests', 'playable', 'prediction', 'predictions', 'all'].includes(requestedTimeline)) {
      responseItems = responseItems.filter((item) => isPublicHomeActiveFightRecord(item));
    }

    // Fight-operations economics: live entrant counts alongside the pot/entry
    // fee the admin declared on creation, so the back office can see whether a
    // fight is covered without opening it. Only meaningful for real Match rows
    // (Shadow templates never take entries) â€” skip the aggregate otherwise.
    if (shouldIncludeDraftFights(req.query)) {
      const matchIds = responseItems
        .filter((item) => item.sourceType !== 'shadow' && item._id)
        .map((item) => item._id);
      let entrantCounts = {};
      if (matchIds.length) {
        try {
          const rows = await Score.aggregate([
            { $match: { matchId: { $in: matchIds }, entryStatus: { $ne: 'refunded' } } },
            { $group: { _id: '$matchId', count: { $sum: 1 } } },
          ]);
          entrantCounts = Object.fromEntries(rows.map((row) => [String(row._id), row.count]));
        } catch (aggregateError) {
          console.warn('Entrant-count aggregate failed:', aggregateError.message);
        }
      }
      responseItems = responseItems.map((item) => {
        const declaredPot = Math.max(0, Math.round(Number(item.pot) || 0));
        const entryFee = Math.max(0, Math.round(Number(item.matchTokens) || 0));
        const committedFunding = Math.min(declaredPot,
          Math.max(0, Math.round(Number(item.promoterStake) || 0))
          + Math.max(0, Math.round(Number(item.platformContribution) || 0)));
        const uncoveredPrize = Math.max(0, declaredPot - committedFunding);
        const breakEvenEntrants = entryFee > 0 ? Math.ceil(uncoveredPrize / entryFee) : 0;
        const minimumEntrants = Math.max(0, Math.round(Number(item.minimumEntrants) || 0)) || breakEvenEntrants;
        const entrants = item.sourceType === 'shadow' ? null : (entrantCounts[String(item._id)] || 0);
        return { ...item, entrants, breakEvenEntrants, minimumEntrants };
      });
    }

    res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Backend-Cache', 'BYPASS');
    res.send(responseItems);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ message: 'Error fetching matches' });
  }
});

// Public/user-facing fight feed. It intentionally reads both regular Match and
// Shadow fight records because the site supports both paths for fight cards and
// promotional/affiliate contests. Only explicit Draft records are hidden by
// default. If a player/user id is passed, records already predicted by that user
// are marked for completed cards; the rest stay playable.
app.get('/api/public/prediction-fights', async (req, res) => {
  try {
    const loadPredictionFightPayload = async () => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      // Mirrors /api/admin/fights (source=all): draft-exclusion only, no
      // timeline/eligibility heuristics â€” those were silently dropping real
      // LIVE fights from the public feed while the admin registry, which
      // skips them, showed everything. If the admin list can show a fight,
      // the public list must be able to show it too.
      let baseFilter = {};
      baseFilter = appendAndFilter(baseFilter, buildEffectiveFightCategoryFilter(req.query.category));
      const visibleFilter = applyFightPublicVisibilityFilter(baseFilter, req.query);
      const [matches, shadows] = await Promise.all([
        applyFightFreshSortLean(Match.find(visibleFilter).populate('fighterAId fighterBId')).limit(500),
        applyFightFreshSortLean(Shadow.find(visibleFilter).populate('fighterAId fighterBId')).limit(500).catch(() => []),
      ]);
      let items = [
        ...matches.map((item) => ({ ...item, sourceType: 'match' })),
        ...shadows.map((item) => ({ ...item, sourceType: 'shadow' })),
      ].filter((item) => !isDraftFightRecord(item));

      if (!isAllFilterValue(req.query.category)) {
        items = items.filter((item) => isFightRecordInEffectiveCategory(item, req.query.category));
      }

      items = items.sort((a, b) => {
        const toTime = (value) => {
          const date = value ? new Date(value) : null;
          return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
        };
        return Math.max(toTime(b.updatedAt), toTime(b.createdAt), toTime(b.matchDate), toTime(b._id?.getTimestamp?.()))
          - Math.max(toTime(a.updatedAt), toTime(a.createdAt), toTime(a.matchDate), toTime(a._id?.getTimestamp?.()));
      }).map((item) => attachCombatFighterReadFallbacks(item, item.sourceType || 'match'));

      items = await attachPlayerPredictionStateToFightItems(items, req.query);
      items = items.slice(0, limit);

      return {
        ok: true,
        items,
        count: items.length,
        categoryMode: 'matchCategoryTwo-preferred',
        generatedAt: new Date().toISOString(),
      };
    };

    const payload = await loadPredictionFightPayload();
    res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Backend-Cache', 'BYPASS');
    return res.json(payload);
  } catch (error) {
    console.error('Error loading prediction-ready fights:', error);
    return res.status(500).json({ ok: false, message: 'Failed to load prediction-ready fights.' });
  }
});

// Update user prediction status
// SECURITY: authenticated. The user is taken from the verified token so a caller
// cannot flip another player's prediction status by passing their id.
app.post('/api/matches/:matchId/updatePredictionStatus', verifyToken, async (req, res) => {
  try {
    const { matchId } = req.params;
    const userId = String(req.user?.id || req.user?._id || '').trim();
    const predictionStatus = req.body?.predictionStatus || req.body?.status || 'submitted';

    if (!userId) {
      return res.status(401).json({ message: 'Authentication is required.' });
    }

    const result = await updateClassicFightPredictionStatus(matchId, userId, predictionStatus);

    if (!result) {
      return res.status(404).json({ message: 'Match not found' });
    }

    return res.status(200).json({
      message: 'Prediction status updated successfully',
      matchId,
      userId,
      sourceType: result.sourceType,
      predictionStatus: result.predictionStatus,
    });
  } catch (error) {
    console.error('Error updating prediction status:', error);
    return res.status(500).json({ message: 'Failed to update prediction status' });
  }
});



app.post('/match/addRoundResults/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;
  const { fighterOneStats, fighterTwoStats } = req.body;

  try {
    // Find the match document
    const match = await Match.findById(id);

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



































// Function to encrypt card details
const encrypt = (text) => {
  try {

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);

    let encrypted = Buffer.concat([
      cipher.update(text, 'utf8'),
      cipher.final(),
    ]);

    // Return IV and encrypted data as a single string
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (error) {
    console.error('Error encrypting data:', error);
    throw new Error('Encryption failed');
  }
};





// Function to decrypt card details
function decrypt(text) {
  const parts = text.split(':');
  const iv = Buffer.from(parts.shift(), 'hex');
  const encryptedText = Buffer.from(parts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}




const SALT_ROUNDS = 10;

const DeviceInfoSchema = new mongoose.Schema({
  email: { type: String, required: false },
  deviceId: { type: String, required: true },
}, { timestamps: true });
DeviceInfoSchema.index({ deviceId: 1 });
DeviceInfoSchema.index({ email: 1, createdAt: -1 });

const DeviceInfo = mongoose.models.DeviceInfo || mongoose.model('DeviceInfo', DeviceInfoSchema);
app.post('/admin/add-device', verifyAdminToken, async (req, res) => {
  try {
    const { deviceId, email } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    // Create a new DeviceInfo record with deviceId (and optionally email)
    const newDeviceInfo = new DeviceInfo({
      deviceId,
      email: email || null,  // If email is provided, use it, otherwise set to null
    });

    await newDeviceInfo.save();

    res.status(201).json({ message: 'Device info added successfully', data: newDeviceInfo });
  } catch (error) {
    console.error('Error saving device info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/admin/device-info', verifyAdminToken, async (req, res) => {
  try {
    const devices = await DeviceInfo.find().sort({ _id: -1 }).limit(5000).lean();
    res.status(200).json(devices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to fetch device info.' });
  }
});
app.delete('/admin/device-info', verifyAdminToken, async (req, res) => {
  const { email, deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ message: 'Device ID is required.' });
  }

  try {
    // If email is provided, delete based on both email and deviceId
    if (email) {
      const result = await DeviceInfo.findOneAndDelete({ email, deviceId });
      
      if (result) {
        return res.status(200).json({ message: 'Device info deleted successfully.' });
      }
    }

    // If email is not provided, delete based only on deviceId
    const result = await DeviceInfo.findOneAndDelete({ deviceId });

    if (result) {
      return res.status(200).json({ message: 'Device info deleted successfully.' });
    } else {
      return res.status(404).json({ message: 'Device info not found.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to delete device info.' });
  }
});












const DeviceInfoSchemaForSpinWheel = new mongoose.Schema({
  email: { type: String, required: false },
  deviceId: { type: String, required: true },
}, { timestamps: true });
DeviceInfoSchemaForSpinWheel.index({ deviceId: 1 });
DeviceInfoSchemaForSpinWheel.index({ email: 1, createdAt: -1 });

const DeviceInfoSpinWheel = mongoose.models.DeviceInfoSpinWheel || mongoose.model('DeviceInfoSpinWheel', DeviceInfoSchemaForSpinWheel);
app.post('/admin/add-device-spin-wheel', verifyAdminToken, async (req, res) => {
  try {
    const { deviceId, email } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID is required' });
    }

    const newDeviceInfo = new DeviceInfoSpinWheel({
      deviceId,
      email: email || null,  // If email is provided, use it, otherwise set to null
    });

    await newDeviceInfo.save();

    res.status(201).json({ message: 'Device info added successfully', data: newDeviceInfo });
  } catch (error) {
    console.error('Error saving device info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/admin/device-info-spin-wheel', verifyAdminToken, async (req, res) => {
  try {
    const devices = await DeviceInfoSpinWheel.find().sort({ _id: -1 }).limit(5000).lean();
    res.status(200).json(devices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to fetch device info.' });
  }
});
// The spin wheel used to download every device row (with player emails) just to
// decide whether THIS device had already spun. Scoped answer instead.
app.get('/api/spin-wheel/eligibility', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim().slice(0, 128);
    if (!deviceId) return res.status(400).json({ ok: false, message: 'deviceId is required.' });
    const email = String(req.query.email || '').trim().toLowerCase();

    // Same two checks the claim makes. Without the email check the wheel would
    // appear for a player who already spun elsewhere, then refuse the spin.
    const [byDevice, byAccount] = await Promise.all([
      DeviceInfoSpinWheel.findOne({ deviceId }).select('_id createdAt').lean(),
      email
        ? DeviceInfoSpinWheel.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id createdAt').lean()
        : null,
    ]);
    const existing = byDevice || byAccount;
    res.json({
      ok: true,
      deviceId,
      alreadySpun: Boolean(existing),
      reason: byDevice ? 'DEVICE' : byAccount ? 'ACCOUNT' : null,
      lastSpinAt: existing?.createdAt || null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Spin eligibility is temporarily unavailable.' });
  }
});

app.get('/api/guest-coins/eligibility', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim().slice(0, 128);
    if (!deviceId) return res.status(400).json({ ok: false, message: 'deviceId is required.' });
    const existing = await DeviceInfo.findOne({ deviceId }).select('_id createdAt').lean();
    res.json({ ok: true, deviceId, alreadyClaimed: Boolean(existing), claimedAt: existing?.createdAt || null });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Claim eligibility is temporarily unavailable.' });
  }
});

app.delete('/admin/device-info-spin-wheel', verifyAdminToken, async (req, res) => {
  const { email, deviceId } = req.body;

  if (!deviceId) {
    return res.status(400).json({ message: 'Device ID is required.' });
  }

  try {
    // If email is provided, delete based on both email and deviceId
    if (email) {
      const result = await DeviceInfoSpinWheel.findOneAndDelete({ email, deviceId });
      
      if (result) {
        return res.status(200).json({ message: 'Device info deleted successfully.' });
      }
    }

    // If email is not provided, delete based only on deviceId
    const result = await DeviceInfoSpinWheel.findOneAndDelete({ deviceId });

    if (result) {
      return res.status(200).json({ message: 'Device info deleted successfully.' });
    } else {
      return res.status(404).json({ message: 'Device info not found.' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to delete device info.' });
  }
});


















const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  tokens: { type: String, default: '0' },
  email: { type: String, required: true, unique: true },
  phone: String,
  shortBio: String,
  password: { type: String, select: false },
  isNotificationsEnabled: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  // --- Notifications -------------------------------------------------------
  notificationsReadAt: Date,
  // --- Daily reward --------------------------------------------------------
  lastDailyRewardAt: Date,
  dailyRewardStreak: { type: Number, default: 0 },
  // --- Eligibility & responsible play -------------------------------------
  dateOfBirth: Date,                       // required for real age verification
  ageVerifiedAt: Date,
  residenceState: { type: String, uppercase: true, trim: true }, // 2-letter code
  eligibilityCheckedAt: Date,
  selfExcludedUntil: Date,                 // set = blocked from paid entries
  selfExclusionReason: String,
  dailyDepositLimitCents: { type: Number, min: 0, default: 0 },   // 0 = no limit
  monthlyDepositLimitCents: { type: Number, min: 0, default: 0 },
  verificationToken: { type: String, select: false },
  verified: { type: Boolean, default: false },
  profileUrl: String,
  profileDeleteUrl: { type: String, select: false },
  currentPlan: { type: String, default: 'None' }, // Current subscription plan
  fmPlusPlan: { type: String, enum: ['monthly', 'pass', 'none'], default: 'none' },
  fmPlusExpiresAt: Date,
  fmPlusLastCoinCreditAt: Date,
  skillTier: { type: String, enum: ['rookie', 'regular', 'expert'], default: 'rookie', index: true },
  skillTierUpdatedAt: Date,
  rollingPerformancePercentile: { type: Number, min: 0, max: 100 },
  loginStreak: { type: Number, min: 0, max: 3650, default: 0 },
  streakExpiresAt: Date,
  dailyRewardClaimedAt: Date,
  streakSkipUnlockedAt: Date,
  freePlanExpiryDate: Date, // Date when the free plan expires
  hasAvailedFreePlan: { type: Boolean, default: false }, // Indicates if the user has availed the free plan
  preferredPaymentMethod: String,
  preferredPaymentMethodValue: { type: String, select: false },
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpires: { type: Date, select: false },
  hasSubmittedTestimonial: { type: Boolean, default: false },
  signupBonusGranted: { type: Boolean, default: false },
  hasReceivedFirstPurchaseBonus: { type: Boolean, default: false },
  billing: {
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String
  },
  // Set only by POST /api/admin/test-accounts. Lets test data be excluded from
  // public numbers and purged in one call without ever touching a real account.
  isTestAccount: { type: Boolean, default: false, index: true },

}, { timestamps: true });
userSchema.index({ playerName: 1 });
userSchema.index({ createdAt: -1 });
userSchema.pre('save', function normalizeUserWalletTokens(next) {
  this.tokens = normalizeWalletTokenString(this.tokens);
  next();
});
attachSafeAccountJsonTransform(userSchema);

const User = mongoose.models.User || mongoose.model('User', userSchema);
// SECURITY: this was behind verifyToken only, and updateMany({}) has no filter â€”
// so ANY signed-in player could overwrite the profile image of every user and
// every affiliate on the platform with one request. Mass defacement in a single
// call. It is a bulk migration tool, so it is admin-only and now requires an
// explicit confirmation flag so it cannot be fired by accident either.
app.put('/update-profile-url', verifyAdminToken, async (req, res) => {
  try {
      const { profileUrl } = req.body;
      if (!profileUrl) {
          return res.status(400).json({ message: 'profileUrl is required' });
      }
      if (req.body?.confirmBulkOverwrite !== 'YES-OVERWRITE-EVERY-ACCOUNT') {
        return res.status(400).json({
          message: 'This overwrites the profile image of every user and affiliate. Send confirmBulkOverwrite="YES-OVERWRITE-EVERY-ACCOUNT" to proceed.',
          code: 'CONFIRMATION_REQUIRED',
        });
      }
      console.warn('[bulk] profileUrl overwrite for ALL accounts by admin', req.admin?.id || 'unknown');

      // Update all users' profileUrl
      const result = await User.updateMany({}, { $set: { profileUrl } });
      const result2 = await Affiliate.updateMany({}, { $set: { profileUrl } });

      res.json({ message: 'Profile URLs updated successfully', modifiedCount: result.modifiedCount ,  modifiedCount2: result2.modifiedCount });
  } catch (error) {
      console.error('Request failed:', error);
      res.status(500).json({ message: 'Internal Server Error' });
  }
});
// SECURITY: authenticated, and bound to the signed-in account. The email used
// to come from the request body, so a spoofed device id could credit anyone.
app.post('/admin/add-tokens-won', verifyToken, requireScope(TOKEN_SCOPES.PLAYER), async (req, res) => {
  const { deviceId } = req.body;
  // The session token carries { id, scope } and NO email, so req.user.email was
  // always undefined and this fell through to req.body.email every time â€” any
  // player could credit 200 coins to any address they typed. The email is now
  // resolved from the account the token belongs to, and the body is ignored.
  const tokenUser = await User.findById(req.user?.id || req.user?._id).select('email').lean();
  const email = String(tokenUser?.email || '').trim();

  if (!email) {
    return res.status(403).json({ message: 'You can only claim coins for your own account.' });
  }
  if (!deviceId) {
    return res.status(400).json({ message: 'deviceId is required.' });
  }

  try {
    const existingDevice = await DeviceInfo.findOne({ deviceId });

    if (existingDevice) {
      return res.status(400).json({ message: 'Device ID already registered.' });
    }
    
    await new DeviceInfo({ email, deviceId }).save();
    
    // Check if User already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // User found, add 200 tokens
      existingUser.tokens = addWalletTokens(existingUser.tokens, 200);
      await existingUser.save();

      // Notify User and Admin
      const emailPromises = [
        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: email,
          subject: '200 Tokens Added!',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear User,</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    You have received 200 tokens added to your account! Your new token balance is ${existingUser.tokens}.
                  </p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    If you have any questions, feel free to reach out to us!
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        }),

        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: ADMIN_ALERT_EMAILS, // Replace with admin email
          subject: 'Tokens Added to User',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    200 tokens have been successfully added to the user with the email: ${email}.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        })
      ];

      // Wait for all emails to be sent
      await Promise.all(emailPromises);

      return res.status(200).json({ message: 'Tokens added successfully, emails sent.' });
    } else {
      // User not found, create new user with 200 tokens
      const firstName = email.split('@')[0]; // Extract the first part of the email for the name
      const password = firstName; // Use the first part of the email as the password
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = new User({
        firstName,
        email,
        password: hashedPassword,
        tokens: '200',
        currentPlan: 'Free',
        verified: true,
        isNotificationsEnabled: true,
        isSubscribed: true,
        isAgreed: true,
        profileUrl: "https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png",
      });

      await newUser.save();

      // Notify the new user and admin in parallel
      const emailPromises = [
        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: email,
          subject: 'Welcome to Fantasy Madness!',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    You have been successfully added to Fantasy Madness with 200 tokens. Below are your login credentials:
                  </p>
                  <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    <li><strong>Email:</strong> ${email}</li>
                    <li><strong>Password:</strong> ${password}</li>
                  </ul>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account!
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        }),

        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: ADMIN_ALERT_EMAILS, // Replace with admin email
          subject: 'New User Created and Tokens Added',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    A new user has been created with the email: ${email} and 200 tokens have been added.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        })
      ];

      // Wait for all emails to be sent
      await Promise.all(emailPromises);

      return res.status(201).json({ message: 'User created and tokens added, emails sent.' });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding tokens or creating the User.' });
  }
});


// SECURITY: authenticated, and the prize is validated against the server's own
// wheel segments. Previously the browser named its own prize, so a caller could
// claim the top value on every spin.
const SPIN_WHEEL_PRIZES = Object.freeze([0, 1, 2, 3, 4, 5, 7, 10, 200]);

app.post('/admin/add-tokens-won-spin-wheel', verifyToken, requireScope(TOKEN_SCOPES.PLAYER), async (req, res) => {
  const { deviceId } = req.body;
  // NOTE: email comes from the body here, but it is verified against the token's
  // own account a few lines below (see the tokenUser check) before any coins are
  // credited â€” so a spoofed address is rejected rather than paid. Do not add a
  // second lookup here; it shadows that one.
  const email = String(req.user?.email || req.body?.email || '').trim();
  const prize = Math.floor(Number(req.body?.results));

  if (!email || !deviceId) {
    return res.status(400).json({ message: 'Email and deviceId are required.' });
  }

  if (!Number.isFinite(prize) || !SPIN_WHEEL_PRIZES.includes(prize)) {
    return res.status(400).json({ message: 'That prize is not a valid wheel segment.', code: 'INVALID_PRIZE' });
  }

  // The wallet may only be credited for the signed-in user.
  const tokenUser = await User.findById(String(req.user?.id || req.user?._id || '')).select('email').lean();
  if (!tokenUser || String(tokenUser.email).toLowerCase() !== email.toLowerCase()) {
    return res.status(403).json({ message: 'You can only claim a spin for your own account.', code: 'ACCOUNT_MISMATCH' });
  }

  try {
    // Once per DEVICE and once per ACCOUNT. The device check alone let the same
    // player spin again on a second phone, or after clearing app data.
    const [existingDevice, existingClaim] = await Promise.all([
      DeviceInfoSpinWheel.findOne({ deviceId }).select('_id').lean(),
      DeviceInfoSpinWheel.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id').lean(),
    ]);

    if (existingDevice) {
      return res.status(400).json({ message: 'This device has already had its spin.', code: 'DEVICE_ALREADY_SPUN' });
    }
    if (existingClaim) {
      return res.status(400).json({ message: 'You have already used your welcome spin.', code: 'ALREADY_SPUN' });
    }

    await new DeviceInfoSpinWheel({ email, deviceId }).save();
    
    // Check if User already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // User found, add 200 tokens
      existingUser.tokens = addWalletTokens(existingUser.tokens, prize);
      await existingUser.save();

      // Notify User and Admin
      const emailPromises = [
        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: email,
          subject: `${prize} Tokens Added!`,
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear User,</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    You have received ${prize} tokens added to your account! Your new token balance is ${existingUser.tokens}.
                  </p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    If you have any questions, feel free to reach out to us!
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        }),

        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: ADMIN_ALERT_EMAILS, // Replace with admin email
          subject: 'Tokens Added to User',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    ${prize} tokens have been successfully added to the user with the email: ${email}.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        })
      ];

      // Wait for all emails to be sent
      await Promise.all(emailPromises);

      return res.status(200).json({ message: 'Tokens added successfully, emails sent.' });
    } else {
      // User not found, create new user with 200 tokens
      const firstName = email.split('@')[0]; // Extract the first part of the email for the name
      const password = firstName; // Use the first part of the email as the password
      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = new User({
        firstName,
        email,
        password: hashedPassword,
        tokens: String(prize),
        currentPlan: 'Free',
        verified: true,
        isNotificationsEnabled: true,
        isSubscribed: true,
        isAgreed: true,
        profileUrl: "https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png",
      });

      await newUser.save();

      // Notify the new user and admin in parallel
      const emailPromises = [
        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: email,
          subject: 'Welcome to Fantasy Madness!',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    You have been successfully added to Fantasy Madness with ${results} tokens. Below are your login credentials:
                  </p>
                  <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    <li><strong>Email:</strong> ${email}</li>
                    <li><strong>Password:</strong> ${password}</li>
                  </ul>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account!
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        }),

        transporter.sendMail({
          from: FMM_MAIL_FROM,
          to: ADMIN_ALERT_EMAILS, // Replace with admin email
          subject: 'New User Created and Tokens Added',
          html: `
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
              <tr>
                <td align="center" style="padding: 15px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                  <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    A new user has been created with the email: ${email} and ${results} tokens have been added.
                  </p>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding: 20px 0;">
                  <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                  <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                </td>
              </tr>
            </table>
          `,
        })
      ];

      // Wait for all emails to be sent
      await Promise.all(emailPromises);

      return res.status(201).json({ message: 'User created and tokens added, emails sent.' });
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding tokens or creating the User.' });
  }
});


app.post('/admin/add-user', verifyAdminToken, async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Check if User already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new User with default values and profileUrl
    const newUser = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      verified: true,
      isNotificationsEnabled: true,
      isSubscribed: true,
      isAgreed: true,
      profileUrl: "https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png",
    });

    await newUser.save();

    // Email to the User
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: email,
      subject: 'Welcome to Fantasy Madness!',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                You have been successfully added to the Fantasy Madness by our administrators!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Below are your login credentials:
              </p>
              <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Password:</strong> ${password}</li>
              </ul>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account and get started!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you have any questions, feel free to reach out to us!
              </p>
            </td>
          </tr>

          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    
        </table>
      `,
    });

    // Email to the admin
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: ADMIN_ALERT_EMAILS, // Replace with admin email
      subject: 'User Successfully Added',
      html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
  
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You have successfully added a new User to the Fantasy Madness with the following details:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>First Name:</strong> ${firstName}</li>
              <li><strong>Last Name:</strong> ${lastName}</li>
              <li><strong>Email:</strong> ${email}</li>
            </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              The User has been notified of their login credentials.
            </p>
          </td>
        </tr>
  
          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
      
      </table> `,
    });

    res.status(201).json({ message: 'User added successfully and emails sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding the User.' });
  }
});



app.post('/forgotPassword-user', submitLimiter, async (req, res) => {
  const { email } = req.body;

  try {
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Set reset token and expiration time (e.g., 1 hour)
    user.resetPasswordToken = resetTokenHash;
    user.resetPasswordExpires = Date.now() + 3600000;

    await user.save();

    // Send email with reset token
    const resetURL = `https://fantasymmadness.com/resetPassword-user/${resetToken}`;

    const mailOptions = {
      to: user.email,
      from: FMM_MAIL_FROM,
      subject: 'Password Reset Request',
      text: `You are receiving this because you have requested a password reset for your account.\n\n
      Please click the following link to reset your password:\n\n
      ${resetURL}\n\n
      If you did not request this, please ignore this email.\n`,
    };

    await transporter.sendMail(mailOptions);
    
    res.status(200).send('Password reset email sent');
  } catch (error) {
    console.error('Error sending reset password email:', error);
    res.status(500).send('Server error');
  }
});


app.post('/resetPassword-user/:token', submitLimiter, async (req, res) => {
  try {
    // Hash the token from the URL to match the stored hash
    const resetTokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

    // Find the User by the token and ensure the token hasn't expired
    const user = await User.findOne({
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: { $gt: Date.now() }, // Ensure token is not expired
    });

    if (!user) {
      return res.status(400).send('Invalid or expired token');
    }

    // Update the password and remove the reset token and expiry
    user.password = await bcrypt.hash(req.body.password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.status(200).send('Password has been reset');
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).send('Server error');
  }
});


// Permanently block the legacy direct-card routes. They accepted raw PAN/CVV
// values and are retained below only so older route manifests remain stable;
// all new purchases must use Accept Hosted through /api/checkout/*.
app.use('/api/authorize-net', (req, res, next) => {
  const disabled = req.method === 'POST' && ['/first-payment', '/transaction'].includes(req.path);
  if (!disabled) return next();
  return res.status(410).json({
    ok: false,
    code: 'LEGACY_CARD_FLOW_DISABLED',
    message: 'This payment route has been retired. Continue through the secure FM checkout.',
  });
});

app.post('/api/authorize-net/first-payment', submitLimiter, async (req, res) => {
  const { email, amount, cardNumber, expirationDate, cardCode, address, city, state, zip, country } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Construct the XML payload for Authorize.Net
    const payload = {
      $: { 'xmlns': 'AnetApi/xml/v1/schema/AnetApiSchema.xsd' }, // Add namespace
      merchantAuthentication: {
        name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
        transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: amount,
        payment: {
          creditCard: {
            cardNumber: cardNumber,
            expirationDate: expirationDate,
            cardCode: cardCode,
          },
        },
        order: {
          invoiceNumber: `INV-${new Date().getTime()}`,
          description: 'First-time payment',
        },
        customer: {
          email: email,
        },
        billTo: {
          firstName: user.firstName,
          lastName: user.lastName,
          address: address,
          city: city,
          state: state,
          zip: zip,
          country: country,
        },
      },
    };

    const xmlPayload = builder.buildObject(payload);

    // Send the transaction request to Authorize.Net
    const response = await axios.post('https://api.authorize.net/xml/v1/request.api', xmlPayload, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    // Log the raw response
    console.log('Authorize.Net raw response:', response.data);
    xml2js.parseString(response.data, async (err, result) => {
      if (err) {
          console.error('Error parsing XML response:', err);
          return res.status(500).json({ message: 'Error parsing payment response' });
      }
  
      const createTransactionResponse = result.createTransactionResponse;
      const transactionResponse = createTransactionResponse?.transactionResponse?.[0];
      const responseCode = transactionResponse?.responseCode?.[0];
  
      if (responseCode === '1') {
          // Transaction was successful
  
          // Encrypt card details
          const encryptedCardNumber = encrypt(cardNumber);
          const encryptedExpirationDate = encrypt(expirationDate);
          const encryptedCardCode = encrypt(cardCode);
  
          // Store encrypted details in user billing
          user.billing = {
              cardNumber: encryptedCardNumber,
              expirationDate: encryptedExpirationDate,
              cardCode: encryptedCardCode,
              address,
              city,
              state,
              zip,
              country,
          };
  
          // Add tokens to the user's account
          const anetFirstBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
          user.tokens = addWalletTokens(user.tokens, amount);
          await recordWalletMove({
            userId: user._id, amount, balanceBefore: anetFirstBefore,
            balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
            reason: 'card_payment_credit', reference: String(Date.now()),
          });
          user.currentPlan = 'Standard';
          await user.save();
  
          return res.status(200).json({
              message: 'Payment processed and user updated successfully',
              transactionId: transactionResponse.transId?.[0],
              authCode: transactionResponse.authCode?.[0],
          });
      } else {
        // Transaction failed, handle the failure case
        const errorMessage =
        transactionResponse?.errors?.[0]?.error?.[0]?.errorText ||
        transactionResponse?.messages?.[0]?.message?.[0]?.description ||
        'Unknown error';
      
        console.log('Authorize.Net transaction failed:', errorMessage);
        return res.status(400).json({
          message: 'Payment failed',
          details: errorMessage,
        });
      }
    });
  } catch (error) {
    console.error('Error processing first payment:', error);
    return res.status(500).json({ message: 'Error processing payment' });
  }
});
app.post('/api/authorize-net/transaction', submitLimiter, async (req, res) => {
  const { email, amount } = req.body;

  try {
    const user = await User.findOne({ email }).select('+billing.cardNumber +billing.expirationDate +billing.cardCode');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Decrypt card details
    const cardNumber = decrypt(user.billing.cardNumber);
    const expirationDate = decrypt(user.billing.expirationDate);
    const cardCode = decrypt(user.billing.cardCode);

    // Check if decryption was successful
    if (!cardNumber || !expirationDate || !cardCode) {
      return res.status(400).json({ message: 'Invalid card details' });
    }

    // Construct the payload for Authorize.Net
    const payload = {
      $: { 'xmlns': 'AnetApi/xml/v1/schema/AnetApiSchema.xsd' }, // Add namespace
      merchantAuthentication: {
        name: process.env.AUTHORIZE_NET_API_LOGIN_ID,
        transactionKey: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
      },
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: amount,
        payment: {
          creditCard: {
            cardNumber: cardNumber,
            expirationDate: expirationDate,
            cardCode: cardCode,
          },
        },
        order: {
          invoiceNumber: `INV-${new Date().getTime()}`,
          description: 'Purchase description here',
        },
        customer: {
          email: user.email,
        },
        billTo: {
          firstName: user.firstName,
          lastName: user.lastName,
          address: user.billing.address,
          city: user.billing.city,
          state: user.billing.state,
          zip: user.billing.zip,
          country: user.billing.country,
        },
      },
    };

    const xmlPayload = builder.buildObject(payload);

    // Send the transaction request to Authorize.Net
    const response = await axios.post('https://api.authorize.net/xml/v1/request.api', xmlPayload, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });

    // Parse XML response
    xml2js.parseString(response.data, async (err, result) => {
      if (err) {
        console.error('Error parsing XML response:', err);
        return res.status(500).json({ message: 'Error parsing transaction response' });
      }

      const createTransactionResponse = result.createTransactionResponse;
      const transactionResponse = createTransactionResponse?.transactionResponse?.[0];
      const responseCode = transactionResponse?.responseCode?.[0];

      if (responseCode === '1') {
        // Transaction was successful
        const anetTxnBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
        user.tokens = addWalletTokens(user.tokens, amount);
        await user.save();
        await recordWalletMove({
          userId: user._id, amount, balanceBefore: anetTxnBefore,
          balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
          reason: 'card_payment_credit', reference: String(Date.now()),
        });

        return res.status(200).json({
          message: 'Transaction successful and tokens added',
          transactionId: transactionResponse.transId?.[0],
          authCode: transactionResponse.authCode?.[0],
        });
      } else {
        // Transaction failed
        const errorMessage = transactionResponse?.messages?.[0]?.message?.[0]?.description || 'Unknown error';
        console.log('Authorize.Net transaction failed:', errorMessage);
        return res.status(400).json({
          message: 'Transaction failed',
          details: errorMessage,
        });
      }
    });
  } catch (error) {
    console.error('Error processing transaction:', error.response?.data || error.message);
    return res.status(500).json({ message: 'Error processing transaction' });
  }
});

// Google Login API
app.post('/google-login', loginLimiter, async (req, res) => {
  const { token } = req.body;

  try {
    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { name, email, picture } = ticket.getPayload();

    // Check if the email exists in Redusers
    const redListedUser = await Redusers.findOne({ email });
    if (redListedUser) {
      // Send email notification if user is on red list
      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: email,
        subject: 'Login Blocked',
        html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <!-- Logo Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <!-- Greeting Section -->
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear User,</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Due to violations of our terms and conditions, your account is flagged, and login is blocked on Fantasy Madness. 
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you believe this is a mistake, please contact our support team.
              </p>
            </td>
          </tr>

          <!-- Footer Section -->
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
      });

      return res.status(403).json({ message: 'Login blocked due to red list status.' });
    }

    // Check if the user exists
    let user = await User.findOne({ email });

    if (!user) {
      // If user does not exist, create a new user
      user = new User({
        firstName: name.split(' ')[0],
        lastName: name.split(' ')[1] || '',
        email,
        profileUrl: picture,
        verified: true, // Mark as verified for Google login
        isNotificationsEnabled: true, // Notifications enabled
        isSubscribed: true, // Subscribed to updates
        isAgreed: true, // Agreed to terms and conditions
        tokens: '500',
        signupBonusGranted: true,
      });

      await user.save();

// Handle referral if referrerId is present
if (req.body.referrerId && req.body.referrerId !== user._id.toString()) {
  try {
    const referrer = await User.findById(req.body.referrerId);
    const alreadyReferred = await Referral.findOne({ referredUser: user._id });

    if (referrer && !alreadyReferred) {
      await Referral.create({
        referrer: referrer._id,
        referredUser: user._id,
        rewarded: true,
      });

      referrer.tokens = addWalletTokens(referrer.tokens, 3);
      await referrer.save();
    }
  } catch (err) {
    console.error('Referral processing error (Google Login):', err);
  }
}


const notification = new Notification({
      title: `User Signed Up: ${user.firstName}`,
    });
    await notification.save();
    
      // Send welcome email to the new user
      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: email,
        subject: 'Welcome to Fantasy Madness!',
        html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Welcome to Fantasy Madness! We're thrilled to have you on board. Dive into the excitement and start your journey today!
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
      });

      // Notify admins about the new signup
      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: ADMIN_ALERT_EMAILS,
        subject: 'New User Signup Notification',
        html: `
        <p>A new user has signed up on Fantasy Madness:</p>
        <ul>
          <li>Name: ${user.firstName} ${user.lastName}</li>
          <li>Email: ${user.email}</li>
        </ul>
      `,
      });
    }

    // Generate JWT token
    const jwtToken = jwt.sign({ id: user._id, scope: TOKEN_SCOPES.PLAYER }, process.env.JWT_SECRET, { expiresIn: SESSION_TOKEN_TTL });

    // Return JWT token and user info
    res.status(200).json({
      message: 'Google login successful',
      token: jwtToken,
      user: {
        id: user._id,
        name: user.firstName + ' ' + user.lastName,
        email: user.email,
        profileUrl: user.profileUrl,
      },
    });
  } catch (error) {
    console.error('Google login error', error);

    // Send error email to admins
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: ADMIN_ALERT_EMAILS,
      subject: 'Google Login Error Notification',
      html: `
      <p>An error occurred during a Google login attempt. Please investigate the issue.</p>
      <p><strong>Error Details:</strong></p>
      <pre>${error.message}</pre>
    `,
    });

    res.status(500).json({ message: 'Internal server error' });
  }
});




app.post('/user/updatePayment/:id', verifyToken, async (req, res) => {
  // Payment details may only be changed by their owner.
  if (String(req.user?.id || req.user?._id || '') !== String(req.params.id)) {
    return res.status(403).json({ message: 'You can only update your own payment details.', code: 'NOT_OWNER' });
  }
  const { id } = req.params; // Get the affiliate ID from URL params
  const { preferredPaymentMethod, preferredPaymentMethodValue } = req.body; // Get data from request body

  try {
    // Find the affiliate by ID and update the payment method and value
    const updatedUser = await User.findByIdAndUpdate(
      id, 
      {
        preferredPaymentMethod,
        preferredPaymentMethodValue
      }, 
      { new: true } // Return the updated document
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ message: 'Affiliate updated successfully', data: updatedUser });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update Profile API
// SECURITY: was fully public â€” any caller could rewrite any player's profile
// (including their citizenship/eligibility flags) by guessing an id.
app.put('/update-profile/:userId', verifyToken, requireSelf((req) => req.params.userId), upload.single('image'), async (req, res) => {
  const { userId } = req.params;
  const {
    firstName,
    lastName,
    playerName,
    phone,
    zipCode,
    shortBio,
    isNotificationsEnabled,
    isSubscribed,
    isUSCitizen,
  } = req.body;

  try {
    // Create an object to hold the fields that should be updated
    const updateFields = {};

    // Add other fields to be updated
    if (firstName) updateFields.firstName = firstName;
    if (lastName) updateFields.lastName = lastName;
    if (playerName) updateFields.playerName = playerName;
    if (phone) updateFields.phone = phone;
    if (zipCode) updateFields.zipCode = zipCode;
    if (shortBio) updateFields.shortBio = shortBio;
    if (isNotificationsEnabled !== undefined) updateFields.isNotificationsEnabled = isNotificationsEnabled;
    if (isSubscribed !== undefined) updateFields.isSubscribed = isSubscribed;
    if (isUSCitizen !== undefined) updateFields.isUSCitizen = isUSCitizen;

    // Check if a new image is provided
    if (req.file) {
      // Find the user to retrieve the previous profile details
      const user = await User.findById(userId).select('+profileDeleteUrl');
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Delete previous image from Cloudinary if delete URL exists
      if (user.profileDeleteUrl) {
        await cloudinary.uploader.destroy(user.profileDeleteUrl);
      }

      // Upload new image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'profiles' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      updateFields.profileUrl = result.secure_url; // URL for accessing the image
      updateFields.profileDeleteUrl = result.public_id; // Cloudinary public ID for deletion
    }

    // Update the user document with the specified fields
    const updatedUser = await User.findByIdAndUpdate(userId, updateFields, { new: true });

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      message: 'Profile updated successfully',
      user: updatedUser,
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST API to reward tokens to the user and update matchReward status
// SECURITY: admin-only. Credits a wallet from an amount in the request body,
// so an unauthenticated caller could mint unlimited coins.
app.post('/api/reward-tokens/:userId', verifyAdminToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens, matchId } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    const grantBalanceBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
    user.tokens = addWalletTokens(user.tokens, tokens);
    await recordWalletMove({
      userId: user._id,
      amount: tokens,
      balanceBefore: grantBalanceBefore,
      balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
      reason: 'admin_grant',
      reference: String(req.params.userId || req.body?.matchId || Date.now()),
      meta: { grantedBy: req.admin?.id || null },
    });

    // Save the updated user
    await user.save();

    // Update the match's reward status to "Rewarded"
    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.matchReward = 'Rewarded';

    // Save the updated match
    await match.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded and match updated successfully', user, match });
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST API to reward tokens to the user and update matchReward status
// SECURITY: admin-only (called from the admin RegisteredUsers screen).
app.post('/api/reward-tokens-only-forcibly/:userId', verifyAdminToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    const grantBalanceBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
    user.tokens = addWalletTokens(user.tokens, tokens);
    await recordWalletMove({
      userId: user._id,
      amount: tokens,
      balanceBefore: grantBalanceBefore,
      balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
      reason: 'admin_grant',
      reference: String(req.params.userId || req.body?.matchId || Date.now()),
      meta: { grantedBy: req.admin?.id || null },
    });

    // Save the updated user
    await user.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded successfully', user});
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});


// SECURITY: authenticated. userId now comes from the verified token, not the
// body â€” otherwise any caller could drain another player's wallet.
app.post('/api/deduct-tokens', verifyToken, requireScope(TOKEN_SCOPES.PLAYER), async (req, res) => {
  try {
    const { matchTokens } = req.body;
    const userId = String(req.user?.id || req.user?._id || '').trim();

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const { balance, deduction, nextBalance } = subtractWalletTokens(user.tokens, matchTokens);

    // Check if the user has enough tokens
    if (balance < deduction) {
      return res.status(402).json({ code: 'INSUFFICIENT_FM', message: 'Insufficient tokens', tokensRemaining: String(balance) });
    }

    // Deduct the tokens
    user.tokens = String(nextBalance);
    await user.save();

    return res.status(200).json({ message: 'Tokens deducted successfully', tokensRemaining: user.tokens });
  } catch (error) {
    console.error('Error deducting tokens:', error);
    return res.status(500).json({ message: 'Server error' });
  }
});


// Get registered users. Kept at the legacy /users path for compatibility,
// but response payloads are sanitized so credentials, reset tokens, and card data
// cannot be exposed to public clients.
// Display names only â€” what leaderboards need, nothing more.
app.get('/api/public/user-directory', async (req, res) => {
  try {
    const users = await User.find({})
      .select('_id firstName lastName playerName profileUrl')
      .limit(parsePositiveInteger(req.query.limit, 500, 5000))
      .lean();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ message: 'Could not load the directory.' });
  }
});

app.get('/users', verifyAdminToken, async (req, res) => {
  try {
    const users = await User.find().select(USER_SAFE_SELECT).sort({ createdAt: -1 }).lean();
    res.send(sanitizeAccountList(users));
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'Error fetching users' });
  }
});


// Create reusable transporter object using the default SMTP transport.
// Credentials must come from environment variables; do not commit mailbox app passwords.
const transporter = nodemailer.createTransport({
  service: process.env.SMTP_SERVICE || 'Gmail',
  auth: {
    user: process.env.SMTP_USER || 'Fantasymmadness2@gmail.com',
    pass: process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD,
  },
});

// One authenticated path for operational tools (including Jarvis) to surface
// failures in both the admin inbox and the real support mailbox.
app.post('/api/admin/alerts', verifyAdminToken, async (req, res) => {
  try {
    const source = String(req.body?.source || 'Back office').trim().slice(0, 80);
    const severity = ['info', 'warning', 'critical'].includes(String(req.body?.severity))
      ? String(req.body.severity) : 'warning';
    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ message: 'Alert message is required.' });

    const title = `${severity === 'critical' ? 'CRITICAL' : severity.toUpperCase()}: ${source}`;
    await new Notification({ title: `${title} â€” ${message.slice(0, 180)}` }).save();
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: ADMIN_ALERT_EMAILS,
      replyTo: SUPPORT_EMAIL,
      subject: `[${severity.toUpperCase()}] ${source}`,
      html: `<div style="font-family:Arial,sans-serif"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p>Support: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p></div>`,
    });
    return res.status(201).json({ ok: true, deliveredTo: ADMIN_ALERT_EMAILS });
  } catch (error) {
    console.error('Admin alert delivery failed:', error);
    return res.status(500).json({ message: 'Could not deliver the admin alert.' });
  }
});

const STATIC_PUBLIC_APPAREL_PRODUCTS = [
  { sku: 'FMM-ETSY-4552218538', name: 'Every Fight Has A Formula Tee', price: 49.95, currency: 'USD', image: 'https://i.etsystatic.com/14114660/r/il/6ecaae/8355959330/il_794xN.8355959330_ru4j.jpg', sizes: ['M', 'L', 'XL', '2XL'], source: 'etsy', buyUrl: 'https://www.etsy.com/listing/4552218538/fantasy-mmadness-combat-sports-t-shirt' },
  { sku: 'FMM-ETSY-4552212559', name: 'Fighting Is In The Bones Tee', price: 49.95, currency: 'USD', image: 'https://i.etsystatic.com/14114660/r/il/e0f448/8403876627/il_794xN.8403876627_fcdb.jpg', sizes: ['M', 'L', 'XL', '2XL'], source: 'etsy', buyUrl: 'https://www.etsy.com/listing/4552212559/fantasy-mmadness-combat-sports-t-shirt' },
  { sku: 'FMM-ETSY-4552225010', name: 'The Fight Factory Tee', price: 49.95, currency: 'USD', image: 'https://i.etsystatic.com/14114660/r/il/0df5ca/8403887913/il_794xN.8403887913_lics.jpg', sizes: ['M', 'L', 'XL', '2XL'], source: 'etsy', buyUrl: 'https://www.etsy.com/listing/4552225010/fantasy-mmadness-combat-sports-t-shirt' },
  { sku: 'FMM-ETSY-4549330994', name: 'Raw Dawg Tee', price: 49.95, currency: 'USD', image: 'https://i.etsystatic.com/14114660/r/il/0c238f/8335272402/il_794xN.8335272402_ceu7.jpg', sizes: ['M', 'L', 'XL', '2XL'], source: 'etsy', buyUrl: 'https://www.etsy.com/listing/4549330994/fantasy-mmadness-combat-sports-t-shirt' },
  { sku: 'FMM-ETSY-4541697432', name: 'The Darkness Walks Tee', price: 49.95, currency: 'USD', image: 'https://i.etsystatic.com/14114660/r/il/c431a4/8328853743/il_794xN.8328853743_efn0.jpg', sizes: ['M', 'L', 'XL', '2XL'], source: 'etsy', buyUrl: 'https://www.etsy.com/listing/4541697432/inspired-by-champions-built-for-the' },
];
const PUBLIC_APPAREL_PRODUCTS = STATIC_PUBLIC_APPAREL_PRODUCTS;
const ETSY_API_BASE_URL = String(process.env.ETSY_API_BASE_URL || 'https://api.etsy.com/v3/application').replace(/\/$/, '');
const ETSY_DEFAULT_SHOP_NAME = process.env.ETSY_SHOP_NAME || 'FANTASYMMADNESS';
const ETSY_PRODUCTS_CACHE_TTL_MS = Number(process.env.ETSY_PRODUCTS_CACHE_TTL_MS || 15 * 60 * 1000);
let etsyApparelCache = { expiresAt: 0, data: null, error: null };
let etsyShopIdCache = null;

function getEtsyApiKeyHeader() {
  const keystring = String(process.env.ETSY_API_KEYSTRING || process.env.ETSY_KEYSTRING || process.env.ETSY_API_KEY || '').trim();
  const sharedSecret = String(process.env.ETSY_SHARED_SECRET || process.env.ETSY_API_SHARED_SECRET || '').trim();
  return keystring && sharedSecret ? `${keystring}:${sharedSecret}` : '';
}

function isEtsyCatalogEnabled() {
  const disabled = ['false', '0', 'off'].includes(String(process.env.ETSY_APPAREL_SYNC_ENABLED || 'true').toLowerCase());
  return !disabled && Boolean(getEtsyApiKeyHeader());
}

function buildEtsyUrl(pathname, query = {}) {
  const url = new URL(`${ETSY_API_BASE_URL}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  });
  return url.toString();
}

async function fetchEtsyJson(pathname, query = {}) {
  const apiKey = getEtsyApiKeyHeader();
  if (!apiKey) {
    const error = new Error('ETSY_API_KEYSTRING and ETSY_SHARED_SECRET are required for Etsy apparel sync.');
    error.status = 503;
    throw error;
  }

  const timeoutMs = Number(process.env.ETSY_API_TIMEOUT_MS || 12000);
  const request = fetch(buildEtsyUrl(pathname, query), {
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Etsy API request timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  const response = await Promise.race([request, timeout]);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_error) {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error || payload?.message || response.statusText || 'Etsy API request failed.';
    const error = new Error(`Etsy API ${response.status}: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function extractEtsyResults(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function resolveEtsyShopId() {
  const configuredShopId = String(process.env.ETSY_SHOP_ID || '').trim();
  if (configuredShopId) return configuredShopId;
  if (etsyShopIdCache) return etsyShopIdCache;

  const shopName = String(ETSY_DEFAULT_SHOP_NAME || '').trim();
  const searchPayload = await fetchEtsyJson('/shops', { shop_name: shopName, limit: 10 });
  const shops = extractEtsyResults(searchPayload);
  const matchedShop = shops.find((shop) => String(shop.shop_name || '').toLowerCase() === shopName.toLowerCase()) || shops[0];
  if (!matchedShop?.shop_id) {
    throw new Error(`Etsy shop ${shopName || '(missing shop name)'} was not found.`);
  }
  etsyShopIdCache = String(matchedShop.shop_id);
  return etsyShopIdCache;
}

function normalizeEtsyPrice(price, fallbackCurrency = 'USD') {
  if (price && typeof price === 'object') {
    const divisor = Number(price.divisor || 100) || 100;
    const amount = Number(price.amount ?? price.value ?? price.price ?? 0);
    return {
      amount: Number((amount / divisor).toFixed(2)),
      currency: price.currency_code || price.currency || fallbackCurrency,
    };
  }
  const parsed = Number(String(price || '').replace(/[^0-9.]/g, ''));
  return {
    amount: Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0,
    currency: fallbackCurrency,
  };
}

const APPAREL_FALLBACK_IMAGES = STATIC_PUBLIC_APPAREL_PRODUCTS.map((product) => product.image);

function getApparelFallbackImage(index = 0) {
  return APPAREL_FALLBACK_IMAGES[index % APPAREL_FALLBACK_IMAGES.length] || '/images/mobile-home/final-v35/ap2.webp';
}

function getEtsyImageUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return image.trim();
  if (typeof image !== 'object') return '';
  return String(
    image.url_fullxfull ||
    image.url_300x300 ||
    image.url_570xN ||
    image.url_680x540 ||
    image.url_340x270 ||
    image.url_170x135 ||
    image.url_75x75 ||
    image.url ||
    image.src ||
    ''
  ).trim();
}

function collectEtsyListingImages(listing = {}) {
  const collections = [
    listing.Images,
    listing.images,
    listing.ListingImages,
    listing.listing_images,
    listing.listingImages,
    listing.MainImage ? [listing.MainImage] : null,
    listing.main_image ? [listing.main_image] : null,
    listing.primary_image ? [listing.primary_image] : null,
    listing.image ? [listing.image] : null,
  ].filter(Array.isArray);

  const directFields = [
    listing.image_url,
    listing.imageUrl,
    listing.url_fullxfull,
    listing.url_570xN,
    listing.url_300x300,
    listing.primary_image_url,
  ];

  const urls = [...collections.flat().map(getEtsyImageUrl), ...directFields.map(getEtsyImageUrl)]
    .filter((url) => /^https?:\/\//i.test(url));
  return Array.from(new Set(urls));
}

function pickEtsyListingImage(listing = {}, fallbackIndex = 0) {
  return collectEtsyListingImages(listing)[0] || getApparelFallbackImage(fallbackIndex);
}

function normalizeEtsyListing(listing = {}, fallbackIndex = 0) {
  const listingId = String(listing.listing_id || listing.id || '').trim();
  const price = normalizeEtsyPrice(listing.price || listing.price_money || listing.BuyerPrice, listing.currency_code || 'USD');
  const title = String(listing.title || listing.name || 'Fantasy MMAdness Apparel').replace(/\s+/g, ' ').trim();
  const listingUrl = listing.url || listing.listing_url || (listingId ? `https://www.etsy.com/listing/${listingId}` : 'https://www.etsy.com/shop/FANTASYMMADNESS');
  const quantity = Number(listing.quantity ?? listing.inventory?.quantity ?? 1);
  const isAvailable = !Number.isFinite(quantity) || quantity > 0;
  const images = collectEtsyListingImages(listing);
  const primaryImage = images[0] || getApparelFallbackImage(fallbackIndex);
  return {
    sku: `ETSY-${listingId || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    etsyListingId: listingId,
    source: 'etsy',
    name: title,
    tag: 'Official Etsy shop',
    price: price.amount,
    currency: price.currency,
    image: primaryImage,
    images: images.length ? images : [primaryImage],
    url: listingUrl,
    externalUrl: listingUrl,
    buyUrl: listingUrl,
    isExternalCheckout: true,
    available: isAvailable,
    quantity: Number.isFinite(quantity) ? quantity : undefined,
    sizes: ['See Etsy options'],
  };
}

async function fetchEtsyListingImages(listingId) {
  if (!listingId) return [];
  const payload = await fetchEtsyJson(`/listings/${listingId}/images`);
  return extractEtsyResults(payload).filter(Boolean);
}

async function hydrateEtsyListingDetails(listings = []) {
  const ids = listings.map((listing) => listing.listing_id || listing.id).filter(Boolean).slice(0, 100);
  if (!ids.length) return listings;

  let mergedListings = listings;
  try {
    const batchPayload = await fetchEtsyJson('/listings/batch', {
      listing_ids: ids.join(','),
      includes: 'Images,BuyerPrice',
    });
    const detailedListings = extractEtsyResults(batchPayload);
    if (detailedListings.length) {
      const detailsById = new Map(detailedListings.map((listing) => [String(listing.listing_id || listing.id), listing]));
      mergedListings = listings.map((listing) => {
        const detail = detailsById.get(String(listing.listing_id || listing.id)) || {};
        return {
          ...listing,
          ...detail,
          Images: detail.Images || detail.images || listing.Images || listing.images,
        };
      });
    }
  } catch (error) {
    console.warn('[etsy] Listing batch hydration failed; trying image endpoints:', error.message);
  }

  const missingImageListings = mergedListings.filter((listing) => !collectEtsyListingImages(listing).length);
  if (!missingImageListings.length) return mergedListings;

  const imagesById = new Map();
  const concurrency = Math.min(5, missingImageListings.length);
  let cursor = 0;
  async function worker() {
    while (cursor < missingImageListings.length) {
      const listing = missingImageListings[cursor++];
      const listingId = String(listing.listing_id || listing.id || '').trim();
      if (!listingId) continue;
      try {
        const images = await fetchEtsyListingImages(listingId);
        if (images.length) imagesById.set(listingId, images);
      } catch (error) {
        console.warn(`[etsy] Image hydration failed for listing ${listingId}:`, error.message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return mergedListings.map((listing) => {
    const listingId = String(listing.listing_id || listing.id || '').trim();
    const images = imagesById.get(listingId);
    return images?.length ? { ...listing, Images: images } : listing;
  });
}

async function fetchEtsyApparelProductsFresh({ limit = 100 } = {}) {
  const shopId = await resolveEtsyShopId();
  const perPage = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const payload = await fetchEtsyJson(`/shops/${shopId}/listings/active`, {
    limit: perPage,
    offset: 0,
    includes: 'Images',
  });
  const activeListings = extractEtsyResults(payload);
  const hydratedListings = await hydrateEtsyListingDetails(activeListings);
  const products = hydratedListings
    .map((listing, index) => normalizeEtsyListing(listing, index))
    .filter((product) => product.etsyListingId && product.available !== false);

  return {
    source: 'etsy',
    products,
    shop: {
      id: shopId,
      name: ETSY_DEFAULT_SHOP_NAME,
      url: `https://www.etsy.com/shop/${ETSY_DEFAULT_SHOP_NAME}`,
    },
    syncedAt: new Date().toISOString(),
  };
}

async function getPublicApparelProducts({ force = false, limit = 100 } = {}) {
  if (!isEtsyCatalogEnabled()) {
    return {
      source: 'fallback',
      products: STATIC_PUBLIC_APPAREL_PRODUCTS,
      shop: { name: 'Fantasy MMAdness', url: 'https://www.etsy.com/shop/FANTASYMMADNESS' },
      syncedAt: null,
      reason: 'etsy_not_configured',
    };
  }

  const now = Date.now();
  if (!force && etsyApparelCache.data && etsyApparelCache.expiresAt > now) {
    return {
      ...etsyApparelCache.data,
      products: etsyApparelCache.data.products.slice(0, limit),
      cached: true,
    };
  }

  try {
    const data = await fetchEtsyApparelProductsFresh({ limit });
    const fallbackSafeData = data.products.length ? data : {
      ...data,
      source: 'fallback',
      products: STATIC_PUBLIC_APPAREL_PRODUCTS,
      reason: 'etsy_empty_catalog',
    };
    etsyApparelCache = {
      data: fallbackSafeData,
      error: null,
      expiresAt: now + ETSY_PRODUCTS_CACHE_TTL_MS,
    };
    return fallbackSafeData;
  } catch (error) {
    console.warn('[etsy] Falling back to local apparel products:', error.message);
    etsyApparelCache.error = error.message;
    return {
      source: 'fallback',
      products: STATIC_PUBLIC_APPAREL_PRODUCTS,
      shop: { name: 'Fantasy MMAdness', url: 'https://www.etsy.com/shop/FANTASYMMADNESS' },
      syncedAt: null,
      reason: 'etsy_fetch_failed',
      error: error.message,
    };
  }
}

const apparelOrderItemSchema = new mongoose.Schema({
  sku: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  size: { type: String, required: true, trim: true },
  quantity: { type: Number, min: 1, max: 20, required: true },
  unitPrice: { type: Number, min: 0, required: true },
  lineTotal: { type: Number, min: 0, required: true },
}, { _id: false });

const apparelOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  customerName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  shippingAddress: { type: String, required: true, trim: true },
  city: { type: String, required: true, trim: true },
  state: { type: String, trim: true },
  zipCode: { type: String, required: true, trim: true },
  country: { type: String, required: true, trim: true, default: 'United States' },
  notes: { type: String, trim: true },
  items: { type: [apparelOrderItemSchema], default: [] },
  subtotal: { type: Number, min: 0, required: true },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['PENDING', 'CONFIRMED', 'FULFILLING', 'SHIPPED', 'CANCELLED'], default: 'PENDING', index: true },
  source: { type: String, default: 'public-apparel-page' },
}, { timestamps: true });
apparelOrderSchema.index({ email: 1, createdAt: -1 });
const ApparelOrder = mongoose.models.ApparelOrder || mongoose.model('ApparelOrder', apparelOrderSchema);

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeApparelQuantity(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 20);
}

function buildApparelOrderNumber() {
  return `FMM-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

async function resolveApparelOrderItems(rawItems = []) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const error = new Error('At least one apparel item is required.');
    error.status = 400;
    throw error;
  }

  const catalog = await getPublicApparelProducts({ force: false, limit: 100 });
  const products = Array.isArray(catalog?.products) && catalog.products.length
    ? catalog.products
    : PUBLIC_APPAREL_PRODUCTS;

  return rawItems.map((rawItem) => {
    const sku = String(rawItem?.sku || '').trim();
    const product = products.find((item) => item.sku === sku) || PUBLIC_APPAREL_PRODUCTS.find((item) => item.sku === sku);
    if (!product) {
      const error = new Error(`Unknown apparel product: ${sku || 'missing sku'}.`);
      error.status = 400;
      throw error;
    }

    const productSizes = Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['One Size'];
    const requestedSize = String(rawItem?.size || productSizes[0] || 'One Size').trim();
    const size = productSizes.includes(requestedSize) ? requestedSize : productSizes[0];
    const quantity = normalizeApparelQuantity(rawItem?.quantity);
    const unitPrice = Number(product.price || 0);
    const lineTotal = Number((unitPrice * quantity).toFixed(2));

    return {
      sku: product.sku,
      name: product.name,
      size,
      quantity,
      unitPrice,
      lineTotal,
    };
  });
}

function renderApparelOrderRows(items = []) {
  return items.map((item) => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #eee;">${escapeHtml(item.name)}<br/><small>SKU: ${escapeHtml(item.sku)} Â· Size: ${escapeHtml(item.size)}</small></td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
      <td style="padding:10px;border-bottom:1px solid #eee;text-align:right;">$${item.lineTotal.toFixed(2)}</td>
    </tr>
  `).join('');
}

app.get('/api/public/apparel-products', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 100);
    const force = ['true', '1', 'yes'].includes(String(req.query.refresh || req.query.force || '').toLowerCase());
    const catalog = await getPublicApparelProducts({ force, limit });
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      source: catalog.source,
      shop: catalog.shop,
      syncedAt: catalog.syncedAt,
      cached: Boolean(catalog.cached),
      reason: catalog.reason,
      products: catalog.products.slice(0, limit),
    });
  } catch (error) {
    console.error('[apparel-products] catalog failed:', error);
    return res.status(500).json({
      ok: false,
      source: 'fallback',
      message: 'Unable to load apparel catalog.',
      products: PUBLIC_APPAREL_PRODUCTS,
    });
  }
});

app.post('/api/public/apparel-orders', submitLimiter, async (req, res) => {
  try {
    const {
      customerName,
      email,
      phone,
      shippingAddress,
      city,
      state,
      zipCode,
      country,
      notes,
      items,
      userId,
    } = req.body || {};

    if (!customerName || !email || !shippingAddress || !city || !zipCode) {
      return res.status(400).json({
        ok: false,
        message: 'Customer name, email, shipping address, city, and ZIP/postal code are required.',
      });
    }

    const orderItems = await resolveApparelOrderItems(items);
    const subtotal = Number(orderItems.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2));
    const order = await ApparelOrder.create({
      orderNumber: buildApparelOrderNumber(),
      userId: mongoose.isValidObjectId(userId) ? userId : undefined,
      customerName,
      email,
      phone,
      shippingAddress,
      city,
      state,
      zipCode,
      country: country || 'United States',
      notes,
      items: orderItems,
      subtotal,
      currency: 'USD',
    });

    const orderRows = renderApparelOrderRows(orderItems);
    const adminHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:auto;font-family:Arial,sans-serif;color:#222;">
        <tr><td style="padding:18px 0;text-align:center;"><h2 style="margin:0;">New Fantasy MMAdness Apparel Order</h2><p style="margin:6px 0 0;">Order ${escapeHtml(order.orderNumber)}</p></td></tr>
        <tr><td style="padding:16px;background:#f8f8f8;border-radius:12px;">
          <p><strong>Name:</strong> ${escapeHtml(customerName)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(phone || 'Not provided')}</p>
          <p><strong>Ship to:</strong> ${escapeHtml(shippingAddress)}, ${escapeHtml(city)}, ${escapeHtml(state || '')} ${escapeHtml(zipCode)}, ${escapeHtml(country || 'United States')}</p>
          ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ''}
        </td></tr>
        <tr><td style="padding-top:18px;"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><thead><tr><th align="left">Item</th><th>Qty</th><th align="right">Total</th></tr></thead><tbody>${orderRows}</tbody></table></td></tr>
        <tr><td style="padding-top:16px;text-align:right;"><strong>Subtotal: $${subtotal.toFixed(2)}</strong></td></tr>
      </table>
    `;
    const customerHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;margin:auto;font-family:Arial,sans-serif;color:#222;">
        <tr><td style="padding:18px 0;text-align:center;"><h2 style="margin:0;">Your Fantasy MMAdness order is received</h2><p style="margin:6px 0 0;">Order ${escapeHtml(order.orderNumber)}</p></td></tr>
        <tr><td style="padding:16px;background:#f8f8f8;border-radius:12px;"><p>Hi ${escapeHtml(customerName)},</p><p>We received your apparel order. The Fantasy MMAdness team will follow up with payment and shipping confirmation.</p></td></tr>
        <tr><td style="padding-top:18px;"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><thead><tr><th align="left">Item</th><th>Qty</th><th align="right">Total</th></tr></thead><tbody>${orderRows}</tbody></table></td></tr>
        <tr><td style="padding-top:16px;text-align:right;"><strong>Subtotal: $${subtotal.toFixed(2)}</strong></td></tr>
      </table>
    `;

    await Promise.allSettled([
      transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: process.env.APPAREL_ORDER_EMAIL || ADMIN_ALERT_EMAILS,
        subject: `New apparel order ${order.orderNumber}`,
        html: adminHtml,
      }),
      transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: email,
        subject: `Fantasy MMAdness apparel order ${order.orderNumber}`,
        html: customerHtml,
      }),
    ]);

    clearPublicResponseCache();
    return res.status(201).json({
      ok: true,
      message: 'Order received.',
      orderNumber: order.orderNumber,
      status: order.status,
      subtotal: order.subtotal,
      items: order.items,
    });
  } catch (error) {
    console.error('Error creating apparel order:', error);
    return res.status(error.status || 500).json({
      ok: false,
      message: error.message || 'Failed to create apparel order.',
    });
  }
});

app.post('/contact-us-fantasymmadness', submitLimiter, (req, res) => {
  // Escaped before it reaches any email body â€” see escapeHtml.
  const fullName = escapeHtml(String(req.body?.fullName || '').slice(0, 120));
  const email = escapeHtml(String(req.body?.email || '').slice(0, 160));
  const subject = escapeHtml(String(req.body?.subject || '').slice(0, 200));
  const message = escapeHtml(String(req.body?.message || '').slice(0, 4000));

  // Validate input (basic validation)
  if (!fullName || !email || !message) {
    return res.status(400).json({ error: 'Full name, email, and message are required.' });
  }
  // Email template for Admin
  const adminHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
      <!-- Header Section -->
      <tr>
        <td align="center" style="padding: 15px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
          <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
        </td>
      </tr>
      
      <!-- Message Details Section -->
      <tr>
        <td style="padding: 20px; font-family: Arial, sans-serif; color: #333;">
          <p style="font-size: 16px;"><strong>Full Name:</strong> ${fullName}</p>
          <p style="font-size: 16px;"><strong>Email:</strong> ${email}</p>
          <p style="font-size: 16px;"><strong>Subject:</strong> ${subject || 'No Subject'}</p>
          <p style="font-size: 16px;"><strong>Message:</strong></p>
          <p style="font-size: 16px; color: #555;">${message}</p>
        </td>
      </tr>

      <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%;" />
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;

  // Email template for User
  const userHtml = `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
      <!-- Header Section -->
      <tr>
       <td align="center" style="padding: 15px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
          <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
        </td>
     </tr>
      
      <!-- Message Confirmation Section -->
      <tr>
        <td style="padding: 20px; font-family: Arial, sans-serif; color: #333;">
          <p style="font-size: 16px;">Hello ${fullName},</p>
          <p style="font-size: 16px; color: #555;">
            Thank you for reaching out! We have received your message and will get back to you as soon as possible. Here's a summary of your submission:
          </p>
          <p style="font-size: 16px;"><strong>Subject:</strong> ${subject || 'No Subject'}</p>
          <p style="font-size: 16px;"><strong>Message:</strong></p>
          <p style="font-size: 16px; color: #555;">${message}</p>
        </td>
      </tr>

      <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    </table>
  `;


  // Admin email options
  const adminMailOptions = {
    from: FMM_MAIL_FROM,
    replyTo: email,
    to: ADMIN_ALERT_EMAILS,
    subject: `Contact Form Submission: ${subject}`,
    html: adminHtml,
  };

  // User email options
  const userMailOptions = {
    from: FMM_MAIL_FROM,
    to: email,
    subject: 'Thank You for Contacting Fantasy Madness!',
    html: userHtml,
  };

  // Send both emails
  Promise.all([
    transporter.sendMail(adminMailOptions),
    transporter.sendMail(userMailOptions)
  ])
    .then(([adminInfo, userInfo]) => {
      console.log('Admin email sent:', adminInfo.response);
      console.log('User email sent:', userInfo.response);
      res.status(200).json({ message: 'Email successfully sent .' });
    })
    .catch(error => {
      console.error('Error sending emails:', error);
      res.status(500).json({ error: 'Failed to send emails.' });
    });
});
// SECURITY: admin-only. This sends mail to every user and affiliate; as an open
// GET, anyone (or a crawler prefetching links) could trigger a mass blast.
app.get('/notify', verifyAdminToken, async (req, res) => {
  try {
    // Fetch all matches
    const matches = await Match.find({});
    if (!matches || matches.length === 0) {
      return res.status(404).json({ message: 'No matches found' });
    }

    // Fetch all users
    const users = await User.find({}).select('email firstName isSubscribed isNotificationsEnabled').limit(20000).lean();
    if (!users || users.length === 0) {
      return res.status(404).json({ message: 'No users found' });
    }

    // Fetch all affiliates
    const affiliates = await Affiliate.find({});
    if (!affiliates || affiliates.length === 0) {
      return res.status(404).json({ message: 'No affiliates found' });
    }

    const emailPromises = [];
    for (const match of matches) {
      // Skip if notification already sent
      if (match.notificationSent) continue;

      if (match.matchType === 'SHADOW') {
        const affiliate = affiliates.find((a) => a._id.toString() === match.affiliateId?.toString());
        if (affiliate) {
          const usersJoinedIds = affiliate.usersJoined.map((user) => user.userId);

          // Filter eligible users
          const eligibleUsers = users.filter(
            (user) => usersJoinedIds.includes(user._id.toString()) && normalizeWalletTokenNumber(user.tokens) >= normalizeWalletTokenNumber(match.matchTokens)
          );

          // Users who submitted predictions
          const predictionUsers = match.userPredictions
            .filter((prediction) => prediction.predictionStatus === 'submitted')
            .map((prediction) => prediction.userId);

          // Combine eligible users and prediction users
          const allEligibleUsers = [...new Set([...eligibleUsers.map((user) => user._id.toString()), ...predictionUsers])];

          // Required users based on match tokens and pot
          const requiredUsers = match.pot / match.matchTokens;

          // Check eligibility
          if (allEligibleUsers.length >= requiredUsers) {
            // Prepare and send emails to all users
            emailPromises.push(
              ...users.map(async (user) => {
                const emailHtml = `
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
                    <tr>
                      <td align="center" style="padding: 15px 0;">
                        <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                        <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 20px; font-family: Arial, sans-serif; color: #333;">
                        <p style="font-size: 16px;">Hello ${user.fullName || 'User'},</p>
                        <p style="font-size: 16px; color: #555;">
                          A new match has been scheduled! Here are the details:
                        </p>
                        <p style="font-size: 16px;"><strong>Match:</strong> ${match.matchFighterA} vs. ${match.matchFighterB}</p>
                        <p style="font-size: 16px;"><strong>Category:</strong> ${match.matchCategory} / ${match.matchCategoryTwo}</p>
                        <p style="font-size: 16px;"><strong>Description:</strong> ${match.matchDescription}</p>
                        <p style="font-size: 16px;"><strong>Tokens Required:</strong> ${match.matchTokens}</p>
                        <p style="font-size: 16px; color: #555;">
                          Visit <a href="https://fantasymmadness.com" style="color: #191164;">Fantasy Madness</a> to join the action!
                        </p>
                      </td>
                    </tr>
                    
          <tr>
            <td align="center" style="padding: 20px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              <div style="padding-top: 10px;">
                <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px;">
                  <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px;" />
                </a>
                <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
                  <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px;" />
                </a>
                <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
                  <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px;" />
                </a>
              </div>
            </td>
          </tr>
                  </table>
                `;

                await transporter.sendMail({
                  from: FMM_MAIL_FROM,
                  to: user.email,
                  subject: `Upcoming Match: ${match.matchName}`,
                  html: emailHtml,
                });
              })
            );

            // Mark notification as sent
            match.notificationSent = true;
            await match.save();
          }
        }
      }
    }

    // Send all emails
    await Promise.all(emailPromises);

    res.status(200).json({ message: 'Notifications processed successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error processing notifications' });
  }
});


app.post('/send-emails-to-all-users', verifyAdminToken, async (req, res) => {
  const { emails, subject, message } = req.body;

  if (!emails || emails.length === 0) {
    return res.status(400).json({ error: 'No email addresses provided.' });
  }

  try {
    // Loop through each email and send the message
    for (let email of emails) {
      await transporter.sendMail({
        from: FMM_MAIL_FROM, // sender address
        to: email, // receiver email
        subject: subject, // subject line
        text: message, // plain text body
      });
    }

    res.status(200).json({ success: true, message: 'Emails sent successfully!' });
  } catch (error) {
    console.error('Error sending emails:', error);
    res.status(500).json({ error: 'Failed to send emails.' });
  }
});


app.post('/register', submitLimiter, async (req, res) => {
  try {
    // Deliberately not logging req.body: it carries the plaintext password.

    const {
      firstName,
      lastName,
      playerName,
      email,
      phone,
      password,
      zipCode,
      isNotificationsEnabled,
      isSubscribed,
      isUSCitizen,
      isAgreed,
      referrerId
    } = req.body;

    // Duplicate-account guard: blocks device reuse and email aliasing
    // (gmail dots / +tags). Fails open so a check error never blocks a real user.
    try {
      const dupe = await checkDuplicateSignup({
        email,
        deviceId: String(req.body?.deviceId || '').slice(0, 128),
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
      });
      if (dupe) return res.status(409).json({ message: dupe.message, code: dupe.code });
    } catch (dupeError) {
      console.warn('Duplicate check skipped:', dupeError.message);
    }

    // Basic input validation to prevent malformed requests
    if (!email || !password || !firstName || !lastName) {
      console.warn('Registration rejected: missing required fields', {
      hasEmail: Boolean(email),
      hasPassword: Boolean(password),
      hasFirstName: Boolean(firstName),
      hasLastName: Boolean(lastName),
    });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if email exists in Redusers
    const redListedUser = await Redusers.findOne({ email }).lean();
    if (redListedUser) {
      console.log(`Blocked registration for redlisted email: ${email}`);

      const mailOptions = {
        from: FMM_MAIL_FROM,
        to: email,
        subject: 'Registration Blocked',
        html: `
          <h2>Fantasy Madness</h2>
          <p>Dear ${firstName || "User"}, your registration has been blocked due to redlist status.</p>
        `,
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log('Redlist email notification sent successfully.');
      } catch (err) {
        console.error('Error sending redlist email:', err);
      }

      return res.status(403).json({ error: 'Registration blocked due to red list status.' });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email }).lean();
    if (existingUser) {
      console.log(`Duplicate registration attempt: ${email}`);
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Generate verification token
    const verificationToken = crypto.randomBytes(20).toString('hex');

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      firstName,
      lastName,
      playerName,
      email,
      phone,
      zipCode,
      isNotificationsEnabled,
      isSubscribed,
      isUSCitizen,
      isAgreed,
      verified: false,
      verificationToken,
      password: hashedPassword,
      tokens: '500',
      signupBonusGranted: true,
    });

    await newUser.save();
    console.log(`âœ… User created successfully: ${email}`);

    // Notification
    await new Notification({ title: `New User Signed Up: ${newUser.firstName}` }).save();
    sendAdminPush({ title: 'New player sign-up', body: `${newUser.firstName} just joined.`, url: '/administration/RegisteredUsers' }).catch(() => null);

    // Handle referral safely
    if (referrerId && referrerId !== newUser._id.toString()) {
      try {
        const referrer = await User.findById(referrerId);
        const alreadyReferred = await Referral.findOne({ referredUser: newUser._id });
        if (referrer && !alreadyReferred) {
          await Referral.create({
            referrer: referrer._id,
            referredUser: newUser._id,
            rewarded: true,
          });
          referrer.tokens = addWalletTokens(referrer.tokens, 3);
          await referrer.save();
          console.log(`ðŸŽ 3 tokens awarded to referrer: ${referrer.email}`);
        }
      } catch (err) {
        console.error('Referral processing error:', err);
      }
    }

    // Schedule verification timeout cleanup. Was 120000ms (2 minutes) â€” far
    // too aggressive: any real-world email delay (spam filtering, provider
    // lag) meant the account was deleted before the person could even open
    // their inbox, so a late-arriving link failed with no clear reason and
    // there was no way to get a fresh one. 24 hours, plus a real resend route
    // below.
    setTimeout(async () => {
      try {
        const user = await User.findOne({ email });
        if (user && !user.verified) {
          console.log(`Deleting unverified user: ${email}`);
          await transporter.sendMail({
            from: FMM_MAIL_FROM,
            to: email,
            subject: 'Verification Failed',
            html: `<p>Dear ${user.firstName}, your registration was removed due to unverified email.</p>`,
          });
          await User.deleteOne({ email });
        }
      } catch (err) {
        console.error('Error during verification timeout cleanup:', err);
      }
    }, 24 * 60 * 60 * 1000);

    // Send verification email. A failure here must NOT fail the whole signup â€”
    // the account is already saved, and the resend-verification endpoint can
    // recover from a one-time send failure (e.g. SMTP credentials not set on
    // the backend, which silently drops every outgoing email including this
    // one). Previously this threw a 500 after the account existed, leaving
    // the user stuck with no account confirmation and no email, ever.
    const verificationLink = `https://fantasymmadness-game-server-three.vercel.app/verify-email?token=${verificationToken}`;
    try {
      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: email,
        subject: 'Email Verification',
        html: `<p>Click below to verify your email:</p>
               <a href="${verificationLink}">Verify Email</a>`,
      });
      console.log(`Verification email sent to: ${email}`);
      return res.status(200).json({
        message: 'Registration successful! Please check your email to verify your account.',
      });
    } catch (err) {
      console.error('Error sending verification email:', err);
      // Account still exists and is usable via /resend-verification â€”
      // tell the client that plainly instead of a bare failure.
      return res.status(201).json({
        message: 'Account created, but the verification email could not be sent. Use "Resend verification email" to try again.',
        emailFailed: true,
      });
    }
  } catch (error) {
    console.error("Unhandled registration error:", error);
    return res.status(500).json({ error: 'Error during registration' });
  }
});

app.post('/resend-verification', submitLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required.' });
    const user = await User.findOne({ email });
    // Same response whether or not the account exists / is already verified â€”
    // this endpoint must not confirm which emails are registered.
    if (!user || user.verified) {
      return res.status(200).json({ message: 'If that account needs verification, a new email is on its way.' });
    }
    const verificationToken = crypto.randomBytes(20).toString('hex');
    user.verificationToken = verificationToken;
    await user.save();
    const verificationLink = `https://fantasymmadness-game-server-three.vercel.app/verify-email?token=${verificationToken}`;
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: email,
      subject: 'Email Verification',
      html: `<p>Click below to verify your email:</p><a href="${verificationLink}">Verify Email</a>`,
    });
    res.status(200).json({ message: 'Verification email resent.' });
  } catch (error) {
    console.error('Error resending verification email:', error);
    res.status(500).json({ message: 'Could not resend the verification email.' });
  }
});

app.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  const frontendOrigin = String(process.env.FRONTEND_URL || process.env.APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');

  const user = await User.findOne({ verificationToken: token });

  if (!user) {
    return res.redirect(`${frontendOrigin}/auth?mode=login&role=player&verification=invalid`);
  }

  user.verified = true;
  user.verificationToken = null; // Clear the token after verification
  await user.save();

  return res.redirect(`${frontendOrigin}/auth?mode=login&role=player&verified=1`);
});




// Default route
app.get("/", (req, res) =>{
  res.send("Backend server has started running successfully...");
});

app.delete('/usertodelete/:id', verifyAdminToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Find the user by ID
    const user = await User.findById(id).select('+profileDeleteUrl firstName email');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

 if (user.profileDeleteUrl) {
  try {
    await cloudinary.uploader.destroy(user.profileDeleteUrl);
  } catch (error) {
    console.error('Error deleting profile image from Cloudinary:', error.message);
  }
}

    // Remove user from all affiliate leagues
    const affiliates = await Affiliate.find({ 'usersJoined.userId': id });
    for (const affiliate of affiliates) {
      affiliate.usersJoined = affiliate.usersJoined.filter(user => user.userId.toString() !== id);
      await affiliate.save();
      console.log(`User ${user.email} removed from Affiliate League: ${affiliate.playerName} (${affiliate._id})`);
    }

    // Delete the user from the database
    await User.findByIdAndDelete(id);
 const notification = new Notification({
      title: `User deleted: ${user.firstName}`,
    });
    await notification.save();
    res.status(200).json({ message: 'User and profile image deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Get user details by email (for checking verification status and returning additional user info)
// SECURITY: authenticated but not authorised â€” any signed-in player could read
// any other player's phone number and zip code by knowing their email address.
// Callers now get their own record, or a name-and-avatar projection of someone
// else's. Admin tokens still see the full record.
app.get('/user/:email', verifyToken, async (req, res) => {
  const { email } = req.params;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
    }

    const callerId = String(req.user?.id || req.user?._id || '');
    const isSelf = callerId && callerId === String(user._id);
    if (!isSelf) {
      // Public projection only: no phone, no zip, no contact detail.
      return res.json({
        _id: user._id,
        verified: user.verified,
        playerName: user.playerName,
        firstName: user.firstName,
        profileUrl: user.profileUrl,
      });
    }

    // Destructure necessary fields from the user object
    const { verified, firstName, lastName, playerName, phone, zipCode, profileUrl , _id } = user;

    // Return the user information along with the verification status
    res.json({ 
      verified, 
      firstName, 
      lastName, 
      playerName, 
      phone, 
      zipCode,
      profileUrl ,
      _id
    });
  } catch (error) {
    res.status(500).send('Internal server error');
  }
});


// SECURITY: the email came from the request body, so anyone could overwrite
// another player's avatar (and delete their Cloudinary asset).
app.post('/upload-avatar', verifyToken, upload.single('image'), async (req, res) => {
  try {
    const tokenUser = await User.findById(req.user?.id || req.user?._id).select('email').lean();
    const email = tokenUser?.email;
    if (!email) return res.status(403).json({ message: 'You can only change your own avatar.' });

    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    // Find the user to retrieve the previous avatar details
    const user = await User.findOne({ email }).select('+profileDeleteUrl profileUrl email');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Delete the previous avatar from Cloudinary if it exists
    if (user.profileDeleteUrl) {
      await cloudinary.uploader.destroy(user.profileDeleteUrl);
    }

    // Upload the new avatar to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'avatars' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    // Update the user with the new avatar URL and public ID
    user.profileUrl = result.secure_url; // New avatar URL
    user.profileDeleteUrl = result.public_id; // Cloudinary public ID for deletion
    await user.save();

    res.status(200).json({ message: 'Avatar uploaded and saved successfully', profileUrl: user.profileUrl });
  } catch (error) {
    console.error('Error uploading avatar:', error);
    res.status(500).json({ message: 'Server error' });
  }
});




app.post('/user/:email/subscribe', verifyToken, async (req, res) => {
  // Bound to the signed-in account so one user cannot alter another's subscription.
  {
    const caller = await User.findById(String(req.user?.id || req.user?._id || '')).select('email').lean();
    if (!caller || String(caller.email).toLowerCase() !== String(req.params.email).toLowerCase()) {
      return res.status(403).json({ message: 'You can only change your own subscription.', code: 'NOT_OWNER' });
    }
  }
  const { email } = req.params;
  const { plan } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).send('User not found');
    }

    // Check if the user has already availed the free plan
    let freePlanBefore = NaN;
    let stdPlanBefore = NaN;
    if (plan === 'Free') {
      if (user.hasAvailedFreePlan) {
        return res.status(400).json({ message: 'User has already availed the free plan' });
      }

      // Set the current plan to "Free", set the expiry date to one month from now, and allot 20 free tokens
      user.currentPlan = 'Free';
      user.freePlanExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 1 month from now
      user.hasAvailedFreePlan = true;
      freePlanBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
      user.tokens = '20'; // Allot 20 free tokens for the Free plan

    } else if (plan === 'Standard') {
      user.currentPlan = 'Standard';
      stdPlanBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
      user.tokens = '100'; // Allot 100 free tokens for the Standard plan
    }

    await user.save();
    // Plan allotments SET a balance rather than adjust it, so the movement was
    // previously invisible in any history.
    const planAfter = Number.parseInt(String(user.tokens || '0'), 10) || 0;
    const planBefore = plan === 'Standard' ? stdPlanBefore : freePlanBefore;
    if (Number.isFinite(planBefore)) {
      await recordWalletMove({
        userId: user._id,
        amount: planAfter - planBefore,
        balanceBefore: planBefore,
        balanceAfter: planAfter,
        reason: 'plan_allotment',
        reference: String(plan || '') + ':' + Date.now(),
        meta: { plan },
      });
    }
    res.status(200).json({ message: 'Subscription updated successfully' });

  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).send('Internal server error');
  }
});


// Job to reset the current plan to "None" after the free plan expires
const cron = require('node-cron');


// Job to reset the current plan to "None" after the free plan expires
cron.schedule('0 0 * * *', async () => { // Runs daily at midnight
  const users = await User.find({
    currentPlan: 'Free',
    freePlanExpiryDate: { $lte: new Date() }
  });

  for (const user of users) {
    user.currentPlan = 'None';
    await user.save();
  }

  console.log('Expired free plans have been reset to "None"');
});



// Cron Job Route
function buildShadowTemplatePayloadFromLiveMatch(match = {}) {
  return {
    sourceMatchId: match._id,
    convertedFromLiveAt: new Date(),
    matchCategory: match.matchCategory,
    matchCategoryTwo: match.matchCategoryTwo,
    matchName: match.matchName,
    matchFighterA: match.matchFighterA,
    matchFighterB: match.matchFighterB,
    fighterAId: match.fighterAId,
    fighterBId: match.fighterBId,
    promotionBackground: match.promotionBackground,
    matchDescription: match.matchDescription,
    matchVideoUrl: match.matchVideoUrl,
    matchDate: match.matchDate,
    matchDateKey: match.matchDateKey || extractCalendarDateKey(match.matchDate),
    eventTimeZone: match.eventTimeZone,
    matchTime: match.matchTime,
    venue: match.venue,
    fighterAImage: match.fighterAImage,
    fighterBImage: match.fighterBImage,
    matchType: 'SHADOW',
    matchTokens: Number.isFinite(Number(match.matchTokens)) ? Math.max(0, Number(match.matchTokens)) : 0,
    pot: Number.isFinite(Number(match.pot)) ? Math.max(0, Number(match.pot)) : 0,
    maxRounds: match.maxRounds,
    fighterAImageDeleteUrl: match.fighterAImageDeleteUrl,
    fighterBImageDeleteUrl: match.fighterBImageDeleteUrl,
    promotionBackgroundDeleteUrl: match.promotionBackgroundDeleteUrl,
    matchStatus: match.matchStatus === 'Draft' ? 'Draft' : 'Ongoing',
    matchShadowStatus: 'active',
    matchShadowOpenStatus: 'open',
    BoxingMatch: match.BoxingMatch,
    MMAMatch: match.MMAMatch,
    homepagePromoted: false,
    homepagePromotionRank: 0,
  };
}

async function convertPastLiveFightsToShadowTemplates({ notifyAffiliates = false } = {}) {
  const now = new Date();
  const liveMatches = await Match.find(applyFightPublicVisibilityFilter({ matchType: 'LIVE' }, { includeDrafts: 'false' }));
  const expiredUnresolved = liveMatches.filter((match) => {
    const fightDate = parseFightDateTime(match);
    const status = String(match.matchStatus || '').trim().toLowerCase();
    const completed = ['finished', 'completed', 'closed', 'settled'].includes(status) || Boolean(match.prizesSettledAt);
    return Boolean(fightDate && fightDate.getTime() < now.getTime() && !completed);
  });

  // Never convert a production fight merely because its scheduled time passed.
  // It may be delayed, awaiting official scoring, or need an admin to close it.
  // Shadow creation must be an explicit admin action after the result is known.
  return {
    processedAt: now.toISOString(),
    converted: [],
    skipped: expiredUnresolved.map((match) => ({
      sourceMatchId: String(match._id),
      matchName: match.matchName,
      reason: 'expired-live-fight-requires-admin-review',
    })),
    requiresAdminReview: expiredUnresolved.length,
    checked: liveMatches.length,
    notifyAffiliates: Boolean(notifyAffiliates),
  };
}

app.get('/api/cron-job', verifyCronSecret, async (req, res) => {
  try {
    const notifyAffiliates = ['true', '1', 'yes'].includes(String(req.query.notifyAffiliates || '').toLowerCase());
    const result = await convertPastLiveFightsToShadowTemplates({ notifyAffiliates });
    res.status(200).json({ ok: true, message: 'Expired live-fight review completed. No fights were converted automatically.', ...result });
  } catch (error) {
    console.error('Error in cron job:', error);
    res.status(500).json({ ok: false, error: 'Cron job failed.' });
  }
});



// Login API
app.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email }).select('_id +password verified').lean();

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    if (!user.verified) {
      return res.status(403).json({ message: 'Please verify your email before logging in' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user._id, scope: TOKEN_SCOPES.PLAYER }, process.env.JWT_SECRET, { expiresIn: SESSION_TOKEN_TTL });

    res.cookie('token', token, { httpOnly: true, maxAge: SESSION_COOKIE_MAX_AGE });

    res.status(200).json({
      message: 'Login successful',
      token,  // Return token in response body
      user: {
        id: user._id,
        verified: user.verified,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});




const optionalVerifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  return jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (error) return res.status(403).json({ ok: false, message: 'Your session is invalid. Please sign in again.' });
    req.user = user;
    return next();
  });
};

const coinOrderItemSchema = new mongoose.Schema({
  sku: { type: String, required: true },
  label: { type: String, required: true },
  coins: { type: Number, required: true, min: 1 },
  quantity: { type: Number, required: true, min: 1, max: 20 },
  unitPriceCents: { type: Number, required: true, min: 1 },
  lineCoins: { type: Number, required: true, min: 1 },
  lineTotalCents: { type: Number, required: true, min: 1 },
}, { _id: false });

const coinPurchaseOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  billing: {
    address: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
  },
  items: { type: [coinOrderItemSchema], required: true },
  baseCoins: { type: Number, required: true, min: 1 },
  bonusCoins: { type: Number, default: 0, min: 0 },
  creditedCoins: { type: Number, default: 0, min: 0 },
  subtotalCents: { type: Number, required: true, min: 1 },
  currency: { type: String, default: 'USD' },
  firstPurchaseOffer: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['CREATED', 'PROCESSING', 'CREDITED', 'FAILED', 'CANCELLED'],
    default: 'CREATED',
    index: true,
  },
  provider: { type: String, default: 'authorize-net' },
  providerReference: String,
  providerEventId: String,
  providerInvoiceNumber: { type: String, index: true },
  checkoutUrl: String,
  checkoutToken: { type: String, select: false },
  checkoutTokenCreatedAt: Date,
  returnUrl: String,
  creditedAt: Date,
  failureReason: String,
}, { timestamps: true });
coinPurchaseOrderSchema.index({ email: 1, createdAt: -1 });
const CoinPurchaseOrder = mongoose.models.CoinPurchaseOrder || mongoose.model('CoinPurchaseOrder', coinPurchaseOrderSchema);

const fmPlusOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  email: { type: String, required: true, lowercase: true, trim: true, index: true },
  firstName: { type: String, trim: true },
  lastName: { type: String, trim: true },
  billing: { address: String, city: String, state: String, zipCode: String, country: String },
  plan: { type: String, enum: ['monthly', 'pass'], required: true },
  recurring: { type: Boolean, default: false },
  durationDays: { type: Number, default: 30 },
  bonusCoins: { type: Number, default: 1000 },
  subtotalCents: { type: Number, required: true, min: 1 },
  currency: { type: String, default: 'USD' },
  status: { type: String, enum: ['CREATED', 'PROCESSING', 'CREDITED', 'FAILED', 'CANCELLED'], default: 'CREATED', index: true },
  provider: { type: String, default: 'authorize-net' },
  providerReference: String,
  providerEventId: String,
  providerInvoiceNumber: { type: String, index: true },
  checkoutUrl: String,
  checkoutToken: { type: String, select: false },
  checkoutTokenCreatedAt: Date,
  returnUrl: String,
  benefitStartsAt: Date,
  benefitExpiresAt: Date,
  creditedAt: Date,
  failureReason: String,
}, { timestamps: true });
fmPlusOrderSchema.index({ email: 1, createdAt: -1 });
const FmPlusOrder = mongoose.models.FmPlusOrder || mongoose.model('FmPlusOrder', fmPlusOrderSchema);

function normalizeCheckoutEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function buildCoinOrderNumber() {
  return `FMM-COIN-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function buildFmPlusOrderNumber() {
  return `FMM-PLUS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function getSafeCheckoutReturnUrl(value) {
  const appOrigin = String(process.env.PUBLIC_APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');
  const fallback = `${appOrigin}/checkout?status=return`;
  try {
    const requested = new URL(String(value || fallback));
    const allowed = new Set([
      'fantasymmadness.com',
      'www.fantasymmadness.com',
      ...(process.env.NODE_ENV === 'production' ? [] : ['localhost', '127.0.0.1']),
    ]);
    return allowed.has(requested.hostname) ? requested.toString() : fallback;
  } catch (_error) {
    return fallback;
  }
}

function buildKurvHostedCheckoutUrl(order) {
  const hostedUrl = process.env.KURV_HOSTED_CHECKOUT_URL;
  if (!hostedUrl) return '';
  const url = new URL(hostedUrl);
  url.searchParams.set('reference', order.orderNumber);
  url.searchParams.set('merchant_reference', order.orderNumber);
  url.searchParams.set('amount', (order.subtotalCents / 100).toFixed(2));
  url.searchParams.set('currency', order.currency);
  url.searchParams.set('email', order.email);
  const isMembership = Boolean(order.plan);
  url.searchParams.set('description', isMembership
    ? `${order.plan === 'monthly' ? 'FM+ Monthly' : 'FM+ 30-Day Pass'} membership`
    : `${order.baseCoins.toLocaleString('en-US')} FM coins`);
  if (isMembership) {
    url.searchParams.set('product', 'fm-plus');
    url.searchParams.set('plan', order.plan);
    url.searchParams.set('recurring', order.recurring ? 'true' : 'false');
  }
  url.searchParams.set('return_url', order.returnUrl);
  return url.toString();
}

function readKurvWebhookReference(payload = {}) {
  const data = payload.data || payload.payment || payload.transaction || {};
  return String(
    data.merchant_reference || data.merchantReference || data.reference || data.orderNumber ||
    payload.merchant_reference || payload.merchantReference || payload.reference || payload.orderNumber || ''
  ).trim();
}

function readKurvWebhookAmountCents(payload = {}) {
  const data = payload.data || payload.payment || payload.transaction || {};
  const cents = data.amount_cents ?? data.amountCents ?? payload.amount_cents ?? payload.amountCents;
  if (Number.isFinite(Number(cents))) return Math.round(Number(cents));
  const amount = data.amount ?? payload.amount;
  return Number.isFinite(Number(amount)) ? Math.round(Number(amount) * 100) : null;
}

function isKurvPaymentSuccess(payload = {}) {
  const eventType = String(payload.type || payload.event || payload.eventType || '').trim().toLowerCase();
  const status = String(payload.status || payload.data?.status || payload.payment?.status || '').trim().toLowerCase();
  return ['payment.completed', 'payment.succeeded', 'checkout.completed', 'transaction.approved'].includes(eventType)
    || ['paid', 'completed', 'succeeded', 'approved'].includes(status);
}

function getAuthorizeNetEnvironment() {
  const requested = String(process.env.AUTHORIZE_NET_ENVIRONMENT || 'sandbox').trim().toLowerCase();
  const live = ['production', 'prod', 'live'].includes(requested);
  return {
    live,
    isLive: live,
    apiUrl: live
      ? 'https://api.authorize.net/xml/v1/request.api'
      : 'https://apitest.authorize.net/xml/v1/request.api',
    hostedPaymentUrl: live
      ? 'https://accept.authorize.net/payment/payment'
      : 'https://test.authorize.net/payment/payment',
  };
}

// TEMPORARY DIAGNOSTIC â€” remove once the payment issue is confirmed fixed.
// Verifies the 4 Authorize.Net credentials without touching the payment flow:
// masked presence check + a real authenticateTestRequest call (no charge, no
// customer/card data) to confirm the login/transaction key pair is accepted.
const mask = (value) => {
  const str = String(value || '').trim();
  if (!str) return null;
  return str.length <= 4 ? '*'.repeat(str.length) : `${str.slice(0, 2)}${'*'.repeat(Math.max(0, str.length - 6))}${str.slice(-4)}`;
};

app.get('/api/diagnostics/authorize-net-checkout-test', async (req, res) => {
  try {
    const testOrder = { subtotalCents: 1000, orderNumber: `DIAG-${Date.now()}`, returnUrl: '' };
    const hosted = await requestAuthorizeNetHostedToken(testOrder);
    res.send(`<!doctype html><html><body style="margin:0"><form id="f" method="POST" action="${hosted.checkoutUrl}"><input type="hidden" name="token" value="${hosted.token}"></form><script>document.getElementById('f').submit()</script>Redirecting to Authorize.Net test checkout ($10.00, not charged unless you complete it)...</body></html>`);
  } catch (error) {
    res.status(500).send(`Failed to create test checkout: ${error.message}`);
  }
});

app.get('/api/diagnostics/authorize-net', async (req, res) => {
  const keys = {
    AUTHORIZE_NET_API_LOGIN_ID: process.env.AUTHORIZE_NET_API_LOGIN_ID,
    AUTHORIZE_NET_TRANSACTION_KEY: process.env.AUTHORIZE_NET_TRANSACTION_KEY,
    AUTHORIZE_NET_SIGNATURE_KEY: process.env.AUTHORIZE_NET_SIGNATURE_KEY,
    AUTHORIZE_NET_CLIENT_KEY: process.env.AUTHORIZE_NET_CLIENT_KEY,
  };
  const keyStatus = Object.fromEntries(Object.entries(keys).map(([name, value]) => [
    name,
    { loaded: Boolean(String(value || '').trim()), masked: mask(value) },
  ]));
  const allLoaded = Object.values(keyStatus).every((entry) => entry.loaded);
  const environment = getAuthorizeNetEnvironment();

  const result = {
    ok: false,
    checkedAt: new Date().toISOString(),
    environment: environment.live ? 'production' : 'sandbox',
    keys: keyStatus,
    allKeysLoaded: allLoaded,
    credentialsValid: false,
    authorizeNet: null,
  };

  if (!allLoaded) {
    result.message = 'One or more Authorize.Net keys are missing from the environment.';
    return res.status(200).json(result);
  }

  try {
    const response = await axios.post(environment.apiUrl, {
      authenticateTestRequest: {
        merchantAuthentication: authorizeNetMerchantAuthentication(),
      },
    }, { headers: { 'Content-Type': 'application/json' } });

    // Authorize.Net's JSON API replies with a leading BOM on some payloads.
    const raw = typeof response.data === 'string' ? response.data.replace(/^\uFEFF/, '') : response.data;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const resultCode = payload?.messages?.resultCode;
    const messages = (payload?.messages?.message || []).map((m) => ({ code: m.code, text: m.text }));

    result.authorizeNet = { resultCode, messages };
    result.credentialsValid = resultCode === 'Ok';
    result.ok = result.credentialsValid;
    result.message = result.credentialsValid
      ? 'Authorize.Net accepted the API Login ID / Transaction Key pair.'
      : 'Authorize.Net rejected the credentials â€” see authorizeNet.messages.';

    // The real coin/FM+ checkout doesn't use authenticateTestRequest â€” it calls
    // getHostedPaymentPageRequest (redirect-to-Authorize.Net flow). That request
    // can fail on its own (e.g. Hosted Payment Page not enabled on the account)
    // even when the basic credential check above passes, so probe it too with a
    // throwaway $0.01 request â€” no order is created, nothing is saved.
    if (result.credentialsValid) {
      try {
        const hppResponse = await axios.post(environment.apiUrl, {
          getHostedPaymentPageRequest: {
            merchantAuthentication: authorizeNetMerchantAuthentication(),
            transactionRequest: {
              transactionType: 'authOnlyTransaction',
              amount: '0.01',
              order: { invoiceNumber: `DIAG-${Date.now()}`, description: 'Diagnostic check (not charged)' },
              billTo: { firstName: 'Diagnostic', lastName: 'Check', address: '123 Test St', city: 'Test', state: 'GA', zip: '30000', country: 'US' },
            },
            hostedPaymentSettings: { setting: [{ settingName: 'hostedPaymentSecurityOptions', settingValue: JSON.stringify({ captcha: false }) }] },
          },
        }, { headers: { 'Content-Type': 'application/json' } });
        const hppRaw = typeof hppResponse.data === 'string' ? hppResponse.data.replace(/^\uFEFF/, '') : hppResponse.data;
        const hppPayload = typeof hppRaw === 'string' ? JSON.parse(hppRaw) : hppRaw;
        const hppResultCode = hppPayload?.messages?.resultCode;
        result.hostedPaymentPage = {
          ok: hppResultCode === 'Ok' && Boolean(hppPayload.token),
          resultCode: hppResultCode,
          messages: (hppPayload?.messages?.message || []).map((m) => ({ code: m.code, text: m.text })),
          hasToken: Boolean(hppPayload.token),
        };
      } catch (hppError) {
        result.hostedPaymentPage = { ok: false, error: hppError.message };
      }
    }
  } catch (error) {
    result.message = 'Could not reach Authorize.Net to verify credentials.';
    result.error = error.message;
  }

  return res.status(200).json(result);
});

function hasAuthorizeNetCredentials() {
  return Boolean(
    String(process.env.AUTHORIZE_NET_API_LOGIN_ID || '').trim()
    && String(process.env.AUTHORIZE_NET_TRANSACTION_KEY || '').trim()
    && String(process.env.AUTHORIZE_NET_SIGNATURE_KEY || '').trim(),
  );
}

function buildAuthorizeNetInvoiceNumber(order = {}) {
  const prefix = order.plan ? 'FP' : 'FC';
  const digest = crypto.createHash('sha256').update(String(order.orderNumber || '')).digest('hex').slice(0, 16).toUpperCase();
  return `${prefix}${digest}`;
}

function buildCheckoutResultUrl(order = {}, status = 'return') {
  const url = new URL(getSafeCheckoutReturnUrl(order.returnUrl));
  url.searchParams.set('status', status);
  url.searchParams.set('order', order.orderNumber);
  return url.toString();
}

function authorizeNetMerchantAuthentication() {
  return {
    name: String(process.env.AUTHORIZE_NET_API_LOGIN_ID || '').trim(),
    transactionKey: String(process.env.AUTHORIZE_NET_TRANSACTION_KEY || '').trim(),
  };
}

function getAuthorizeNetMessage(payload = {}) {
  const messages = payload?.messages?.message;
  const first = Array.isArray(messages) ? messages[0] : messages;
  return String(first?.text || first?.description || 'The secure payment form could not be created.').trim();
}

async function requestAuthorizeNetHostedToken(order) {
  if (!hasAuthorizeNetCredentials()) {
    const error = new Error('Secure payment is awaiting merchant gateway configuration.');
    error.status = 503;
    error.code = 'AUTHORIZE_NET_NOT_CONFIGURED';
    throw error;
  }

  const environment = getAuthorizeNetEnvironment();
  const invoiceNumber = order.providerInvoiceNumber || buildAuthorizeNetInvoiceNumber(order);
  const description = order.plan
    ? `${order.plan === 'monthly' ? 'FM+ Monthly' : 'FM+ 30-Day Pass'} membership`
    : `${Number(order.baseCoins || 0).toLocaleString('en-US')} FM coins`;
  const requestBody = {
    getHostedPaymentPageRequest: {
      merchantAuthentication: authorizeNetMerchantAuthentication(),
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: (Number(order.subtotalCents || 0) / 100).toFixed(2),
      },
      hostedPaymentSettings: {
        setting: [
          {
            settingName: 'hostedPaymentReturnOptions',
            settingValue: JSON.stringify({
              url: buildCheckoutResultUrl(order, 'return'),
              urlText: 'Return to Fantasy MMAdness',
              cancelUrl: buildCheckoutResultUrl(order, 'cancelled'),
              cancelUrlText: 'Cancel',
            }),
          },
          { settingName: 'hostedPaymentBillingAddressOptions', settingValue: JSON.stringify({ show: true, required: true }) },
        ],
      },
    },
  };

  const response = await axios.post(environment.apiUrl, requestBody, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 15000,
  });
  const payload = response.data || {};
  if (String(payload?.messages?.resultCode || '').toLowerCase() !== 'ok' || !payload.token) {
    const error = new Error(getAuthorizeNetMessage(payload));
    error.status = 502;
    throw error;
  }
  return { token: payload.token, checkoutUrl: environment.hostedPaymentUrl, invoiceNumber };
}

async function attachAuthorizeNetHostedCheckout(order) {
  const hosted = await requestAuthorizeNetHostedToken(order);
  order.provider = 'authorize-net';
  order.providerInvoiceNumber = hosted.invoiceNumber;
  order.checkoutUrl = hosted.checkoutUrl;
  order.checkoutToken = hosted.token;
  order.checkoutTokenCreatedAt = new Date();
  await order.save();
  return hosted;
}

// Direct in-page charge via Accept.js: the browser tokenizes the card with
// Authorize.Net directly (raw card digits never touch our server), and this
// takes the resulting opaqueData token and settles the order synchronously â€”
// the alternative to the hostedPaymentPage redirect above.
async function authorizeNetChargeOpaqueData(order, opaqueData) {
  if (!hasAuthorizeNetCredentials()) {
    const error = new Error('Secure payment is awaiting merchant gateway configuration.');
    error.status = 503;
    error.code = 'AUTHORIZE_NET_NOT_CONFIGURED';
    throw error;
  }
  const environment = getAuthorizeNetEnvironment();
  const invoiceNumber = order.providerInvoiceNumber || buildAuthorizeNetInvoiceNumber(order);
  const requestBody = {
    createTransactionRequest: {
      merchantAuthentication: authorizeNetMerchantAuthentication(),
      transactionRequest: {
        transactionType: 'authCaptureTransaction',
        amount: (Number(order.subtotalCents || 0) / 100).toFixed(2),
        payment: { opaqueData: { dataDescriptor: String(opaqueData?.dataDescriptor || ''), dataValue: String(opaqueData?.dataValue || '') } },
        order: {
          invoiceNumber,
          description: order.plan ? `${order.plan === 'monthly' ? 'FM+ Monthly' : 'FM+ 30-Day Pass'} membership` : `${Number(order.baseCoins || 0).toLocaleString('en-US')} FM coins`,
        },
        billTo: {
          firstName: order.firstName || '',
          lastName: order.lastName || '',
          address: order.billing?.address || '',
          city: order.billing?.city || '',
          state: order.billing?.state || '',
          zip: order.billing?.zipCode || '',
          country: order.billing?.country || 'US',
        },
      },
    },
  };
  const response = await axios.post(environment.apiUrl, requestBody, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 15000,
  });
  const payload = response.data || {};
  const txn = payload.transactionResponse || {};
  const approved = String(txn.responseCode || '').trim() === '1';
  if (!approved) {
    const declineMessage = txn.errors?.[0]?.errorText || txn.messages?.[0]?.description || getAuthorizeNetMessage(payload);
    const error = new Error(declineMessage || 'The card was declined.');
    error.status = 402;
    error.declined = true;
    throw error;
  }
  return { transactionId: txn.transId, invoiceNumber };
}

function getAuthorizeNetClientConfig() {
  const clientKey = String(process.env.AUTHORIZE_NET_CLIENT_KEY || '').trim();
  const apiLoginId = String(process.env.AUTHORIZE_NET_API_LOGIN_ID || '').trim();
  const environment = getAuthorizeNetEnvironment();
  return {
    ok: Boolean(clientKey && apiLoginId),
    apiLoginID: apiLoginId,
    clientKey,
    jsUrl: environment.live ? 'https://js.authorize.net/v1/Accept.js' : 'https://jstest.authorize.net/v1/Accept.js',
  };
}

app.get('/api/checkout/accept-js-config', (req, res) => {
  const config = getAuthorizeNetClientConfig();
  if (!config.ok) return res.status(503).json({ ok: false, code: 'AUTHORIZE_NET_NOT_CONFIGURED', message: 'Secure card entry is awaiting merchant gateway configuration.' });
  return res.json(config);
});

function verifyAuthorizeNetWebhookSignature(rawBody, signatureHeader) {

  const signatureKey = String(process.env.AUTHORIZE_NET_SIGNATURE_KEY || '').replace(/\s+/g, '').trim();
  const received = String(signatureHeader || '').replace(/^sha512=/i, '').trim().toLowerCase();
  if (!signatureKey || !/^[a-f0-9]+$/i.test(signatureKey) || signatureKey.length % 2 !== 0 || !/^[a-f0-9]{128}$/i.test(received)) return false;
  const expected = crypto.createHmac('sha512', Buffer.from(signatureKey, 'hex')).update(String(rawBody || ''), 'utf8').digest('hex').toLowerCase();
  const expectedBuffer = Buffer.from(expected, 'hex');
  const receivedBuffer = Buffer.from(received, 'hex');
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function getAuthorizeNetTransactionDetails(transactionId) {
  const environment = getAuthorizeNetEnvironment();
  const response = await axios.post(environment.apiUrl, {
    getTransactionDetailsRequest: {
      merchantAuthentication: authorizeNetMerchantAuthentication(),
      transId: String(transactionId || '').trim(),
    },
  }, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 15000,
  });
  const payload = response.data || {};
  if (String(payload?.messages?.resultCode || '').toLowerCase() !== 'ok' || !payload.transaction) {
    const error = new Error(getAuthorizeNetMessage(payload));
    error.status = 502;
    throw error;
  }
  return payload.transaction;
}

async function sendCoinCheckoutAccountEmail({ user, resetToken, order }) {
  if (!resetToken) return;
  const appOrigin = String(process.env.PUBLIC_APP_URL || 'https://www.fantasymmadness.com').replace(/\/$/, '');
  const passwordUrl = `${appOrigin}/resetPassword-user/${resetToken}`;
  await transporter.sendMail({
    from: FMM_MAIL_FROM,
    to: user.email,
    subject: 'Set your Fantasy MMAdness player password',
    text: `Your payment was confirmed and your player wallet was created. Set your password using this single-use link within 24 hours: ${passwordUrl}\n\nOrder: ${order.orderNumber}\nWallet credit: ${order.creditedCoins} FM`,
  });
}

async function settlePaidCoinOrder(orderNumber, providerEventId = '') {
  let createdAccountEmail = null;
  let createdAccountResetToken = null;

  const settled = await mongoose.connection.transaction(async (session) => {
    const order = await CoinPurchaseOrder.findOne({ orderNumber }).session(session);
    if (!order) {
      const error = new Error('Coin order not found.');
      error.status = 404;
      throw error;
    }
    if (order.status === 'CREDITED') return { order, alreadyCredited: true };
    if (!['CREATED', 'PROCESSING'].includes(order.status)) {
      const error = new Error(`Coin order cannot be credited from status ${order.status}.`);
      error.status = 409;
      throw error;
    }
    order.status = 'PROCESSING';
    order.providerEventId = providerEventId || order.providerEventId;
    await order.save({ session });

    let user = order.userId ? await User.findById(order.userId).session(session) : null;
    if (!user) user = await User.findOne({ email: order.email }).select('+password +resetPasswordToken +resetPasswordExpires').session(session);

    if (!user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const documents = await User.create([{
        firstName: order.firstName || order.email.split('@')[0],
        lastName: order.lastName || '',
        playerName: order.firstName || order.email.split('@')[0],
        email: order.email,
        password: await bcrypt.hash(randomPassword, 10),
        verified: true,
        tokens: '500',
        signupBonusGranted: true,
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: Date.now() + 24 * 60 * 60 * 1000,
        isAgreed: true,
      }], { session });
      user = documents[0];
      createdAccountEmail = user.email;
      createdAccountResetToken = resetToken;
    }

    const firstPurchase = !user.hasReceivedFirstPurchaseBonus;
    const bonusCoins = firstPurchase ? order.baseCoins : 0;
    const creditedCoins = order.baseCoins + bonusCoins;
    const coinBalanceBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
    user.tokens = addWalletTokens(user.tokens, creditedCoins);
    await recordWalletMove({
      userId: user._id,
      amount: creditedCoins,
      balanceBefore: coinBalanceBefore,
      balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
      reason: 'coin_purchase',
      reference: String(order.orderNumber || ''),
      meta: { baseCoins: order.baseCoins, bonusCoins },
      session,
    });
    user.hasReceivedFirstPurchaseBonus = true;
    await user.save({ session });

    order.userId = user._id;
    order.firstPurchaseOffer = firstPurchase;
    order.bonusCoins = bonusCoins;
    order.creditedCoins = creditedCoins;
    order.status = 'CREDITED';
    order.creditedAt = new Date();
    await order.save({ session });
    return { order, user, alreadyCredited: false };
  });

  if (createdAccountResetToken && settled?.user?.email === createdAccountEmail) {
    sendCoinCheckoutAccountEmail({ user: settled.user, resetToken: createdAccountResetToken, order: settled.order })
      .catch((error) => console.error('[coin-checkout] Password-set email failed:', error.message));
  }

  // Receipt. People expect something in writing after paying.
  if (settled && !settled.alreadyCredited && settled.user?.email) {
    const credited = Number(settled.order?.creditedCoins || 0);
    const bonus = Number(settled.order?.bonusCoins || 0);
    sendMoneyNotice({
      to: settled.user.email,
      subject: 'Your FM coins have been added',
      heading: 'PURCHASE CONFIRMED',
      lines: [
        `<strong>${credited.toLocaleString()} FM</strong> has been added to your wallet.`,
        bonus > 0 ? `That includes a <strong>${bonus.toLocaleString()} FM</strong> bonus.` : '',
        `Order: ${settled.order?.orderNumber || 'n/a'}`,
        'Your coins are ready to use â€” jump back in and enter a fight.',
      ].filter(Boolean),
    });
  }
  return settled;
}

async function settlePaidFmPlusOrder(orderNumber, providerEventId = '') {
  let createdAccountResetToken = null;
  const settled = await mongoose.connection.transaction(async (session) => {
    const order = await FmPlusOrder.findOne({ orderNumber }).session(session);
    if (!order) {
      const error = new Error('FM+ order not found.');
      error.status = 404;
      throw error;
    }
    if (order.status === 'CREDITED') return { order, alreadyCredited: true };
    if (!['CREATED', 'PROCESSING'].includes(order.status)) {
      const error = new Error(`FM+ order cannot be credited from status ${order.status}.`);
      error.status = 409;
      throw error;
    }
    order.status = 'PROCESSING';
    order.providerEventId = providerEventId || order.providerEventId;
    await order.save({ session });

    let user = order.userId ? await User.findById(order.userId).session(session) : null;
    if (!user) user = await User.findOne({ email: order.email }).select('+password +resetPasswordToken +resetPasswordExpires').session(session);
    if (!user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const documents = await User.create([{
        firstName: order.firstName || order.email.split('@')[0],
        lastName: order.lastName || '',
        playerName: order.firstName || order.email.split('@')[0],
        email: order.email,
        password: await bcrypt.hash(randomPassword, 10),
        verified: true,
        tokens: '500',
        signupBonusGranted: true,
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: Date.now() + 24 * 60 * 60 * 1000,
        isAgreed: true,
      }], { session });
      user = documents[0];
      createdAccountResetToken = resetToken;
    }

    const now = new Date();
    const currentExpiry = user.fmPlusExpiresAt && new Date(user.fmPlusExpiresAt) > now
      ? new Date(user.fmPlusExpiresAt)
      : now;
    const expiry = new Date(currentExpiry.getTime() + Number(order.durationDays || 30) * 24 * 60 * 60 * 1000);
    const fmPlusBalanceBefore = Number.parseInt(String(user.tokens || '0'), 10) || 0;
    user.tokens = addWalletTokens(user.tokens, order.bonusCoins);
    await recordWalletMove({
      userId: user._id,
      amount: order.bonusCoins,
      balanceBefore: fmPlusBalanceBefore,
      balanceAfter: Number.parseInt(String(user.tokens || '0'), 10) || 0,
      reason: 'fm_plus_bonus',
      reference: String(order.orderNumber || ''),
      session,
    });
    user.isSubscribed = true;
    user.currentPlan = 'FM+';
    user.fmPlusPlan = order.plan;
    user.fmPlusExpiresAt = expiry;
    user.fmPlusLastCoinCreditAt = now;
    await user.save({ session });

    order.userId = user._id;
    order.status = 'CREDITED';
    order.benefitStartsAt = now;
    order.benefitExpiresAt = expiry;
    order.creditedAt = now;
    await order.save({ session });
    return { order, user, alreadyCredited: false };
  });

  if (settled && !settled.alreadyCredited && settled.user?.email) {
    sendMoneyNotice({
      to: settled.user.email,
      subject: 'FM+ is active on your account',
      heading: 'FM+ ACTIVE',
      lines: [
        'Your FM+ membership is now active.',
        Number(settled.order?.bonusCoins || 0) > 0
          ? `<strong>${Number(settled.order.bonusCoins).toLocaleString()} FM</strong> in bonus coins has been added to your wallet.`
          : '',
        settled.user.fmPlusExpiresAt
          ? `Your membership runs until <strong>${new Date(settled.user.fmPlusExpiresAt).toLocaleDateString()}</strong>.`
          : '',
        'Streak saves are half price for you, and you get early access to new fight cards.',
      ].filter(Boolean),
    });
  }

  if (createdAccountResetToken && settled?.user) {
    sendCoinCheckoutAccountEmail({ user: settled.user, resetToken: createdAccountResetToken, order: {
      ...settled.order.toObject(),
      creditedCoins: settled.order.bonusCoins,
    } }).catch((error) => console.error('[fm-plus-checkout] Password-set email failed:', error.message));
  }
  return settled;
}

// A signed-in player is checked against their stored state. A guest checkout has
// no account yet, so the state they type at checkout is used; it is re-checked
// once the account exists.
async function blockPurchaseOutsidePaidStates(req) {
  const userId = String(req.user?.id || req.user?._id || '').trim();
  let state = String(req.body?.state || '').trim().toUpperCase();
  if (userId) {
    const account = await User.findById(userId).select('residenceState').lean();
    if (account?.residenceState) state = String(account.residenceState).toUpperCase();
  }
  if (!state) return null; // nothing to judge on yet; the entry gate still applies

  const mode = resolveStateMode(state);
  if (mode === 'paid') return null;
  return {
    ok: false,
    code: mode === 'blocked' ? 'STATE_BLOCKED' : 'FREE_PLAY_ONLY',
    state,
    message: mode === 'blocked'
      ? `Fantasy MMAdness is not available in ${state}.`
      : `Coin purchases are not available in ${state}. You can still play every fight for free â€” coins are won and used for status there, not cash.`,
  };
}

// Lets the app render free-play or paid mode from one build.
app.get('/api/public/jurisdiction', optionalVerifyToken, async (req, res) => {
  try {
    let state = String(req.query.state || '').trim().toUpperCase();
    const userId = String(req.user?.id || req.user?._id || '').trim();
    if (userId) {
      const account = await User.findById(userId).select('residenceState dateOfBirth').lean();
      if (account?.residenceState) state = String(account.residenceState).toUpperCase();
    }
    const mode = resolveStateMode(state);
    return res.json({
      ok: true,
      state: state || null,
      mode,
      minimumAge: minimumAgeForState(state),
      canPayEntryFees: mode === 'paid',
      canBuyCoins: mode === 'paid',
      canWinCashValue: mode === 'paid',
      canPlayFree: mode !== 'blocked',
      message: mode === 'paid'
        ? 'Paid contests available.'
        : mode === 'blocked'
          ? 'Not available in this state.'
          : 'Free play only â€” coins are for status here, not cash value.',
    });
  } catch (error) {
    console.error('Jurisdiction lookup failed:', error);
    return res.status(500).json({ ok: false, message: 'Could not determine availability.' });
  }
});

app.get('/api/public/coin-products', (_req, res) => {
  const products = Object.values(FM_COIN_PRODUCTS).map((product) => ({
    ...product,
    mostPopular: product.sku === 'fm-5000',
  }));
  res.json({ ok: true, currency: 'USD', firstPurchaseMultiplier: 2, signupBonusCoins: 500, products });
});

app.get('/api/public/fm-plus-plans', (_req, res) => {
  res.json({
    ok: true,
    currency: 'USD',
    plans: Object.values(FM_PLUS_PLANS),
    entitlements: ['1,000 FM bonus', 'Early Fantasy Card access', 'Exclusive FM+ leagues', 'No ads', '25 FM streak save'],
  });
});

app.post('/api/checkout/coin-orders', optionalVerifyToken, async (req, res) => {
  try {
    // TEST ACCOUNTS MUST NEVER REACH A LIVE PAYMENT PAGE.
    // The gateway runs in production, so a tester tapping "buy coins" would be
    // charged a real card. Checkout previously knew nothing about test accounts.
    // Admins grant coins to testers instead: POST /api/admin/test-accounts/grant.
    if (getAuthorizeNetEnvironment().isLive) {
      const buyerEmail = String(
        req.body?.email
        || (req.user?.id ? (await User.findById(req.user.id).select('email').lean())?.email : '')
        || '',
      ).trim().toLowerCase();
      const buyer = req.user?.id
        ? await User.findById(req.user.id).select('isTestAccount').lean()
        : null;
      if (buyer?.isTestAccount || buyerEmail.endsWith('@fmmtest.com')) {
        return res.status(403).json({
          ok: false,
          code: 'TEST_ACCOUNT_LIVE_PAYMENT_BLOCKED',
          message: 'This is a test account and the payment gateway is live. Ask an admin to add coins to your wallet instead of buying them.',
        });
      }
    }

    // Free-play states must not be able to buy coins. If they could, the coins
    // would have cash value there and the free mode would be the paid product
    // with extra steps.
    const purchaseBlock = await blockPurchaseOutsidePaidStates(req);
    if (purchaseBlock) return res.status(403).json(purchaseBlock);

    if (!hasAuthorizeNetCredentials()) {
      return res.status(503).json({
        ok: false,
        code: 'AUTHORIZE_NET_NOT_CONFIGURED',
        message: 'Secure coin checkout is awaiting merchant gateway configuration.',
      });
    }

    const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 160) {
      return res.status(400).json({ ok: false, message: 'A valid idempotency key is required.' });
    }
    const existingOrder = await CoinPurchaseOrder.findOne({ idempotencyKey }).select('+checkoutToken');
    if (existingOrder) {
      const tokenAge = Date.now() - new Date(existingOrder.checkoutTokenCreatedAt || 0).getTime();
      // Hosted Payment Page tokens are single-use â€” reusing one that already
      // rendered (even without a completed payment) hands the browser back a
      // spent token, which renders as a blank Order Summary. Always mint fresh.
      const hosted = await attachAuthorizeNetHostedCheckout(existingOrder);
      return res.status(200).json({
        ok: true,
        orderNumber: existingOrder.orderNumber,
        checkoutUrl: hosted.checkoutUrl,
        checkoutMethod: 'POST',
        formToken: hosted.token,
        subtotalCents: existingOrder.subtotalCents,
        baseCoins: existingOrder.baseCoins,
        reused: true,
      });
    }

    const cart = resolveCoinCart(req.body?.items);
    const billing = req.body?.billing || {};
    const authenticatedUser = req.user?.id ? await User.findById(req.user.id).lean() : null;
    const email = normalizeCheckoutEmail(authenticatedUser?.email || req.body?.email || billing.email);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, message: 'A valid email address is required.' });
    }
    if (!authenticatedUser) {
      const existingUser = await User.findOne({ email }).select('_id').lean();
      if (existingUser) {
        return res.status(409).json({ ok: false, code: 'SIGN_IN_REQUIRED', message: 'This email already has a player account. Sign in before buying coins.' });
      }
    }

    const firstName = String(authenticatedUser?.firstName || billing.firstName || req.body?.firstName || '').trim();
    const lastName = String(authenticatedUser?.lastName || billing.lastName || req.body?.lastName || '').trim();
    if (!authenticatedUser && (!firstName || !lastName)) {
      return res.status(400).json({ ok: false, message: 'First and last name are required to create the player wallet after payment.' });
    }

    const order = new CoinPurchaseOrder({
      orderNumber: buildCoinOrderNumber(),
      idempotencyKey,
      userId: authenticatedUser?._id,
      email,
      firstName,
      lastName,
      billing: {
        address: String(billing.address || '').trim(),
        city: String(billing.city || '').trim(),
        state: String(billing.state || '').trim(),
        zipCode: String(billing.zipCode || billing.zip || '').trim(),
        country: String(billing.country || 'US').trim(),
      },
      items: cart.items,
      baseCoins: cart.baseCoins,
      subtotalCents: cart.subtotalCents,
      firstPurchaseOffer: authenticatedUser ? !authenticatedUser.hasReceivedFirstPurchaseBonus : true,
      provider: 'authorize-net',
      returnUrl: getSafeCheckoutReturnUrl(req.body?.returnUrl),
    });
    order.providerInvoiceNumber = buildAuthorizeNetInvoiceNumber(order);
    await order.save();

    if (req.body?.opaqueData?.dataValue) {
      try {
        const charge = await authorizeNetChargeOpaqueData(order, req.body.opaqueData);
        await CoinPurchaseOrder.updateOne({ orderNumber: order.orderNumber }, { $set: { provider: 'authorize-net', providerReference: charge.transactionId } });
        const result = await settlePaidCoinOrder(order.orderNumber, charge.transactionId);
        return res.status(201).json({ ok: true, orderNumber: order.orderNumber, charged: true, creditedCoins: result?.order?.creditedCoins ?? order.baseCoins ?? 0, firstPurchaseOffer: order.firstPurchaseOffer });
      } catch (chargeError) {
        return res.status(chargeError.status || 402).json({ ok: false, declined: true, message: chargeError.message || 'The card was declined.' });
      }
    }

    const hosted = await attachAuthorizeNetHostedCheckout(order);

    return res.status(201).json({
      ok: true,
      orderNumber: order.orderNumber,
      checkoutUrl: hosted.checkoutUrl,
      checkoutMethod: 'POST',
      formToken: hosted.token,
      subtotalCents: order.subtotalCents,
      baseCoins: order.baseCoins,
      firstPurchaseOffer: order.firstPurchaseOffer,
    });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.idempotencyKey) {
      const reused = await CoinPurchaseOrder.findOne({ idempotencyKey: String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim() }).select('+checkoutToken');
      if (reused) {
        const hosted = await attachAuthorizeNetHostedCheckout(reused);
        return res.status(200).json({ ok: true, orderNumber: reused.orderNumber, checkoutUrl: hosted.checkoutUrl, checkoutMethod: 'POST', formToken: hosted.token, reused: true });
      }
    }
    console.error('[coin-checkout] Create order failed:', error);
    return res.status(error.status || 500).json({ ok: false, message: error.message || 'Unable to create coin checkout.' });
  }
});

app.post('/api/checkout/fm-plus-orders', optionalVerifyToken, async (req, res) => {
  try {
    const purchaseBlock = await blockPurchaseOutsidePaidStates(req);
    if (purchaseBlock) return res.status(403).json(purchaseBlock);

    if (!hasAuthorizeNetCredentials()) {
      return res.status(503).json({ ok: false, code: 'AUTHORIZE_NET_NOT_CONFIGURED', message: 'Secure FM+ checkout is awaiting merchant gateway configuration.' });
    }
    const plan = resolveFmPlusPlan(req.body?.plan);
    if (plan.recurring) {
      return res.status(409).json({
        ok: false,
        code: 'AUTHORIZE_NET_RECURRING_NOT_ENABLED',
        message: 'Monthly auto-renew requires a separate recurring-billing setup. Choose the 30-day pass to continue today.',
      });
    }
    const idempotencyKey = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length < 12 || idempotencyKey.length > 160) {
      return res.status(400).json({ ok: false, message: 'A valid idempotency key is required.' });
    }
    const existingOrder = await FmPlusOrder.findOne({ idempotencyKey }).select('+checkoutToken');
    if (existingOrder) {
      const hosted = await attachAuthorizeNetHostedCheckout(existingOrder);
      return res.status(200).json({ ok: true, orderNumber: existingOrder.orderNumber, checkoutUrl: hosted.checkoutUrl, checkoutMethod: 'POST', formToken: hosted.token, plan: existingOrder.plan, reused: true });
    }

    const billing = req.body?.billing || {};
    const authenticatedUser = req.user?.id ? await User.findById(req.user.id).lean() : null;
    const email = normalizeCheckoutEmail(authenticatedUser?.email || req.body?.email || billing.email);
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ ok: false, message: 'A valid email address is required.' });
    }
    if (!authenticatedUser) {
      const existingUser = await User.findOne({ email }).select('_id').lean();
      if (existingUser) return res.status(409).json({ ok: false, code: 'SIGN_IN_REQUIRED', message: 'This email already has a player account. Sign in before joining FM+.' });
    }
    const firstName = String(authenticatedUser?.firstName || billing.firstName || req.body?.firstName || '').trim();
    const lastName = String(authenticatedUser?.lastName || billing.lastName || req.body?.lastName || '').trim();
    if (!authenticatedUser && (!firstName || !lastName)) {
      return res.status(400).json({ ok: false, message: 'First and last name are required to create the player account after payment.' });
    }

    const order = new FmPlusOrder({
      orderNumber: buildFmPlusOrderNumber(),
      idempotencyKey,
      userId: authenticatedUser?._id,
      email,
      firstName,
      lastName,
      billing: {
        address: String(billing.address || '').trim(), city: String(billing.city || '').trim(),
        state: String(billing.state || '').trim(), zipCode: String(billing.zipCode || billing.zip || '').trim(),
        country: String(billing.country || 'US').trim(),
      },
      plan: plan.id,
      recurring: plan.recurring,
      durationDays: plan.durationDays,
      bonusCoins: plan.bonusCoins,
      subtotalCents: plan.priceCents,
      provider: 'authorize-net',
      returnUrl: getSafeCheckoutReturnUrl(req.body?.returnUrl),
    });
    order.providerInvoiceNumber = buildAuthorizeNetInvoiceNumber(order);
    await order.save();

    if (req.body?.opaqueData?.dataValue) {
      try {
        const charge = await authorizeNetChargeOpaqueData(order, req.body.opaqueData);
        await FmPlusOrder.updateOne({ orderNumber: order.orderNumber }, { $set: { provider: 'authorize-net', providerReference: charge.transactionId } });
        const result = await settlePaidFmPlusOrder(order.orderNumber, charge.transactionId);
        return res.status(201).json({ ok: true, orderNumber: order.orderNumber, charged: true, creditedCoins: result.order.bonusCoins, plan: order.plan });
      } catch (chargeError) {
        return res.status(chargeError.status || 402).json({ ok: false, declined: true, message: chargeError.message || 'The card was declined.' });
      }
    }

    const hosted = await attachAuthorizeNetHostedCheckout(order);
    return res.status(201).json({
      ok: true,
      orderNumber: order.orderNumber,
      checkoutUrl: hosted.checkoutUrl,
      checkoutMethod: 'POST',
      formToken: hosted.token,
      plan: order.plan,
      subtotalCents: order.subtotalCents,
    });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.idempotencyKey) {
      const reused = await FmPlusOrder.findOne({ idempotencyKey: String(req.headers['idempotency-key'] || req.body?.idempotencyKey || '').trim() }).select('+checkoutToken');
      if (reused) {
        const hosted = await attachAuthorizeNetHostedCheckout(reused);
        return res.status(200).json({ ok: true, orderNumber: reused.orderNumber, checkoutUrl: hosted.checkoutUrl, checkoutMethod: 'POST', formToken: hosted.token, plan: reused.plan, reused: true });
      }
    }
    console.error('[fm-plus-checkout] Create order failed:', error);
    return res.status(error.status || 500).json({ ok: false, message: error.message || 'Unable to create FM+ checkout.' });
  }
});

app.get('/api/checkout/orders/:orderNumber/status', async (req, res) => {
  try {
    const orderNumber = String(req.params.orderNumber || '').trim();
    if (!/^FMM-(?:COIN|PLUS)-[A-Z0-9-]{12,80}$/i.test(orderNumber)) {
      return res.status(400).json({ ok: false, message: 'Invalid checkout order reference.' });
    }
    const isFmPlus = orderNumber.startsWith('FMM-PLUS-');
    const order = await (isFmPlus ? FmPlusOrder : CoinPurchaseOrder)
      .findOne({ orderNumber })
      .select('orderNumber status creditedCoins bonusCoins creditedAt benefitExpiresAt failureReason')
      .lean();
    if (!order) return res.status(404).json({ ok: false, message: 'Checkout order not found.' });
    return res.json({
      ok: true,
      orderNumber,
      status: order.status,
      creditedCoins: isFmPlus ? Number(order.bonusCoins || 0) : Number(order.creditedCoins || 0),
      creditedAt: order.creditedAt,
      benefitExpiresAt: isFmPlus ? order.benefitExpiresAt : undefined,
      message: order.status === 'FAILED' ? 'Payment confirmation could not be completed. Please contact support with the order reference.' : undefined,
    });
    if (order.status === 'FAILED') {
      recordPaymentFailure({ orderNumber, reason: 'Order settled as FAILED' });
    }
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Checkout status is temporarily unavailable.' });
  }
});

app.post('/api/webhooks/authorize-net', async (req, res) => {
  try {
    if (!verifyAuthorizeNetWebhookSignature(req.rawBody, req.headers['x-anet-signature'])) {
      return res.status(401).json({ ok: false, message: 'Invalid webhook signature.' });
    }
    const eventType = String(req.body?.eventType || '').trim();
    if (eventType !== 'net.authorize.payment.authcapture.created') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const transactionId = String(req.body?.payload?.id || '').trim();
    if (!/^\d+$/.test(transactionId)) return res.status(400).json({ ok: false, message: 'Transaction reference is missing.' });
    const transaction = await getAuthorizeNetTransactionDetails(transactionId);
    const invoiceNumber = String(transaction?.order?.invoiceNumber || '').trim();
    const order = invoiceNumber
      ? await (invoiceNumber.startsWith('FP') ? FmPlusOrder : CoinPurchaseOrder).findOne({ providerInvoiceNumber: invoiceNumber }).lean()
      : null;
    if (!order) return res.status(404).json({ ok: false, message: 'Checkout order not found.' });

    const responseCode = String(transaction.responseCode || req.body?.payload?.responseCode || '').trim();
    const transactionStatus = String(transaction.transactionStatus || '').trim().toLowerCase();
    if (responseCode !== '1' || !['capturedpendingsettlement', 'settledsuccessfully'].includes(transactionStatus)) {
      return res.status(409).json({ ok: false, message: 'The transaction is not an approved captured payment.' });
    }
    const paidAmount = Number(transaction.authAmount ?? transaction.settleAmount ?? req.body?.payload?.authAmount);
    if (!Number.isFinite(paidAmount) || Math.round(paidAmount * 100) !== Number(order.subtotalCents)) {
      return res.status(409).json({ ok: false, message: 'Paid amount does not match the server-priced order.' });
    }

    const Model = invoiceNumber.startsWith('FP') ? FmPlusOrder : CoinPurchaseOrder;
    await Model.updateOne({ orderNumber: order.orderNumber }, {
      $set: {
        provider: 'authorize-net',
        providerReference: transactionId,
        providerEventId: String(req.body?.notificationId || transactionId),
      },
    });
    const result = invoiceNumber.startsWith('FP')
      ? await settlePaidFmPlusOrder(order.orderNumber, String(req.body?.notificationId || transactionId))
      : await settlePaidCoinOrder(order.orderNumber, String(req.body?.notificationId || transactionId));
    return res.status(200).json({
      ok: true,
      orderNumber: order.orderNumber,
      creditedCoins: invoiceNumber.startsWith('FP') ? (result?.order?.bonusCoins ?? 0) : (result?.order?.creditedCoins ?? 0),
      alreadyCredited: result?.alreadyCredited,
    });
  } catch (error) {
    console.error('[authorize-net-checkout] Webhook settlement failed:', error);
    return res.status(error.status || 500).json({ ok: false, message: 'Payment settlement failed.' });
  }
});

app.post('/api/webhooks/kurv', async (req, res) => {
  try {
    const signature = req.headers['x-kurv-signature'] || req.headers['x-signature'];
    if (!timingSafeSignatureMatch(req.rawBody, signature, process.env.KURV_WEBHOOK_SECRET)) {
      return res.status(401).json({ ok: false, message: 'Invalid webhook signature.' });
    }
    if (!isKurvPaymentSuccess(req.body || {})) {
      return res.status(202).json({ ok: true, ignored: true });
    }
    const orderNumber = readKurvWebhookReference(req.body || {});
    const isFmPlus = orderNumber.startsWith('FMM-PLUS-');
    const order = orderNumber
      ? await (isFmPlus ? FmPlusOrder : CoinPurchaseOrder).findOne({ orderNumber }).lean()
      : null;
    if (!order) return res.status(404).json({ ok: false, message: 'Checkout order not found.' });

    const paidAmountCents = readKurvWebhookAmountCents(req.body || {});
    if (paidAmountCents !== null && paidAmountCents !== Number(order.subtotalCents)) {
      return res.status(409).json({ ok: false, message: 'Paid amount does not match the server-priced order.' });
    }
    const providerEventId = String(req.body?.id || req.body?.eventId || req.body?.data?.id || '').trim();
    const result = isFmPlus
      ? await settlePaidFmPlusOrder(orderNumber, providerEventId)
      : await settlePaidCoinOrder(orderNumber, providerEventId);
    return res.json({
      ok: true,
      orderNumber,
      creditedCoins: isFmPlus ? (result?.order?.bonusCoins ?? 0) : (result?.order?.creditedCoins ?? 0),
      benefitExpiresAt: isFmPlus ? result?.order?.benefitExpiresAt : undefined,
      alreadyCredited: result?.alreadyCredited,
    });
  } catch (error) {
    console.error('[coin-checkout] Webhook settlement failed:', error);
    return res.status(error.status || 500).json({ ok: false, message: error.message || 'Coin settlement failed.' });
  }
});


// Profile API
app.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(USER_SAFE_SELECT);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (isWalletTokenValueInvalid(user.tokens)) {
      user.tokens = normalizeWalletTokenString(user.tokens);
      await user.save();
    }

    if (
      String(user.currentPlan || '').toUpperCase() === 'FM+' &&
      user.fmPlusExpiresAt &&
      new Date(user.fmPlusExpiresAt).getTime() <= Date.now()
    ) {
      user.isSubscribed = false;
      user.currentPlan = 'None';
      user.fmPlusPlan = 'none';
      await user.save();
    }

    res.status(200).json({ user: sanitizeAccountObject(user) });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.put('/api/users/me/profile', verifyToken, async (req, res) => {
  try {
    const updates = {};
    ['firstName', 'lastName', 'playerName'].forEach((field) => {
      if (req.body?.[field] === undefined) return;
      updates[field] = String(req.body[field] || '').trim().slice(0, field === 'playerName' ? 40 : 80);
    });
    if (!Object.keys(updates).length) return res.status(400).json({ ok: false, message: 'No profile fields were provided.' });
    const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true, runValidators: true }).select(USER_SAFE_SELECT);
    if (!user) return res.status(404).json({ ok: false, message: 'User not found.' });
    return res.json({ ok: true, user: sanitizeAccountObject(user) });
  } catch (error) {
    console.error('[profile] Signed-in profile update failed:', error);
    return res.status(500).json({ ok: false, message: 'Unable to update your profile.' });
  }
});

function utcDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function hasActiveFmPlusBenefits(user = {}, now = new Date()) {
  if (!user.isSubscribed || String(user.currentPlan || '').toUpperCase() !== 'FM+') return false;
  if (!user.fmPlusExpiresAt) return true;
  return new Date(user.fmPlusExpiresAt).getTime() > now.getTime();
}

async function loadStreakUser(req, res) {
  const user = await User.findById(req.user?.id).select(USER_SAFE_SELECT);
  if (!user) {
    res.status(404).json({ ok: false, message: 'User not found.' });
    return null;
  }
  return user;
}

app.post('/api/users/me/streak/claim', verifyToken, async (req, res) => {
  try {
    const user = await loadStreakUser(req, res);
    if (!user) return;
    const now = new Date();
    const lastClaim = user.dailyRewardClaimedAt ? new Date(user.dailyRewardClaimedAt) : null;
    const skipUnlocked = user.streakSkipUnlockedAt ? new Date(user.streakSkipUnlockedAt) : null;
    const claimedToday = lastClaim && utcDayKey(lastClaim) === utcDayKey(now);
    const hasUnusedSkip = claimedToday && skipUnlocked && skipUnlocked.getTime() > lastClaim.getTime();
    if (claimedToday && !hasUnusedSkip) return res.status(409).json({ ok: false, message: 'Todayâ€™s reward has already been claimed.' });

    const yesterday = new Date(now.getTime() - 86400000);
    const consecutive = lastClaim && (utcDayKey(lastClaim) === utcDayKey(yesterday) || claimedToday);
    user.loginStreak = consecutive ? Math.min(3650, Number(user.loginStreak || 0) + 1) : 1;
    user.dailyRewardClaimedAt = now;
    user.streakExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    user.tokens = normalizeWalletTokenString(Number(normalizeWalletTokenString(user.tokens)) + 250);
    await user.save();
    clearPublicResponseCache();
    return res.json({ ok: true, creditedCoins: 250, user: sanitizeAccountObject(user) });
  } catch (error) {
    console.error('[streak] Reward claim failed:', error);
    return res.status(500).json({ ok: false, message: 'Unable to claim the reward.' });
  }
});

app.post('/api/users/me/streak/save', verifyToken, async (req, res) => {
  try {
    const user = await loadStreakUser(req, res);
    if (!user) return;
    const now = new Date();
    const cost = hasActiveFmPlusBenefits(user, now) ? 25 : 50;
    const balance = Number(normalizeWalletTokenString(user.tokens));
    if (balance < cost) return res.status(409).json({ ok: false, message: `You need ${cost} FM to save this streak.` });
    user.tokens = normalizeWalletTokenString(balance - cost);
    await recordWalletMove({
      userId: user._id, amount: -cost, balanceBefore: balance, balanceAfter: balance - cost,
      reason: 'streak_save_legacy', reference: String(Date.now()),
    });
    user.streakExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await user.save();
    clearPublicResponseCache();
    return res.json({ ok: true, debitedCoins: cost, user: sanitizeAccountObject(user) });
  } catch (error) {
    console.error('[streak] Streak save failed:', error);
    return res.status(500).json({ ok: false, message: 'Unable to save the streak.' });
  }
});

app.post('/api/users/me/streak/skip-wait', verifyToken, async (req, res) => {
  try {
    const user = await loadStreakUser(req, res);
    if (!user) return;
    const balance = Number(normalizeWalletTokenString(user.tokens));
    if (balance < 75) return res.status(409).json({ ok: false, message: 'You need 75 FM to skip the wait.' });
    user.tokens = normalizeWalletTokenString(balance - 75);
    user.streakSkipUnlockedAt = new Date();
    await user.save();
    clearPublicResponseCache();
    return res.json({ ok: true, debitedCoins: 75, user: sanitizeAccountObject(user) });
  } catch (error) {
    console.error('[streak] Skip-wait failed:', error);
    return res.status(500).json({ ok: false, message: 'Unable to skip the wait.' });
  }
});


// Profile API
app.get('/profileAffiliate', verifyToken, requireScope(TOKEN_SCOPES.AFFILIATE), async (req, res) => {
  try {
    const user = await Affiliate.findById(req.user.id).select(AFFILIATE_SAFE_SELECT);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});










const adminTokensSchema = new mongoose.Schema({
  tokens: { type: String, default: '0' },
  affiliateRewarded: { type: String, default: '0' },
  matchId: String, 
  matchName: String, 
  totalTokens: { type: String, default: '0' }, // New field to track total tokens
}, { timestamps: true });

const Admintokens = mongoose.models.Admintokens || mongoose.model('Admintokens', adminTokensSchema);

// POST API to reward tokens to the admin and update matchReward status
// SECURITY: admin-only.
app.post('/api/reward-tokens-to-admin', verifyAdminToken, async (req, res) => {
  try {
    const { tokens, matchId, matchName, affiliateRewarded } = req.body;

    // Fetch or create an admin token document
    let adminToken = await Admintokens.findOne({ matchId });

    if (!adminToken) {
      adminToken = new Admintokens({ matchId, matchName });
    }

    // Add tokens to the admin's account and update totalTokens
    adminToken.tokens = addWalletTokens(adminToken.tokens, tokens);
    adminToken.affiliateRewarded = (parseInt(adminToken.affiliateRewarded, 10) + parseInt(affiliateRewarded, 10)).toString();
    adminToken.totalTokens = addWalletTokens(adminToken.totalTokens, tokens);

    await adminToken.save();

    res.status(200).json({ success: true, message: 'Tokens added to Admin wallet successfully', adminToken });
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});





// GET API to fetch all admin token details
app.get('/api/admin-tokens', verifyAdminToken, async (req, res) => {
  try {
    // Fetch all admin tokens from the database
    const adminTokens = await Admintokens.find().sort({ _id: -1 }).limit(1000).lean();

    if (adminTokens.length === 0) {
      return res.status(404).json({ success: false, message: 'No admin tokens found' });
    }

    // Return all admin token details
    res.status(200).json({ 
      success: true, 
      message: 'Admin token data fetched successfully', 
      adminTokens 
    });
  } catch (error) {
    console.error('Request failed:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});




















const affiliateSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  playerName: String,
  zipCode: String,
  email: String,
  phone: String,
  hearing: String,
  password: { type: String, select: false },
  isNotificationsEnabled: Boolean,
  isSubscribed: Boolean,
  isUSCitizen: Boolean,
  isAgreed: Boolean,
  // --- Tax reporting (1099-NEC at $600/yr) ---------------------------------
  // taxIdLast4 is what admin screens display. The full value is write-only and
  // must never be returned by an API (it is excluded from AFFILIATE_SAFE_SELECT).
  taxIdEncrypted: { type: String, select: false },
  taxIdLast4: String,
  taxIdType: { type: String, enum: ['SSN', 'EIN', ''], default: '' },
  taxFormW9SignedAt: Date,
  taxLegalName: String,
  taxBusinessName: String,
  taxAddress: String,
  earningsYtdCents: { type: Number, min: 0, default: 0 },
  taxYear: Number,
  totalViews: { type: Number, default: 0 },
verified: { type: Boolean, default: false },
  profileUrl: String,
  profileDeleteUrl: { type: String, select: false },
  tokens: { type: String, default: '0' },
  preferredPaymentMethod: String, 
  preferredPaymentMethodValue: { type: String, select: false }, 
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpires: { type: Date, select: false },
  rewardTitle: String,
rewardImageUrl: String,
rewardImageDeleteUrl: { type: String, select: false },

  usersJoined: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who joined
    email: String,  // Email of the user who joined
    joinedAt: { type: Date, default: Date.now } // Timestamp
  }],
  payouts: [{
    amount: Number, // Example of amount paid
    createdAt: { type: Date, default: Date.now }, // Timestamp for payout creation
    status: { type: String, default: 'pending' }, // pending | paid | rejected
    resolvedAt: Date,      // when an admin approved or rejected it
    resolvedBy: String,    // admin id that actioned it
    reason: String         // rejection reason, or payment reference on approval
  }],
  // Set only by POST /api/admin/test-accounts. Lets test data be excluded from
  // public numbers and purged in one call without ever touching a real account.
  isTestAccount: { type: Boolean, default: false, index: true },

}, { timestamps: true });
affiliateSchema.index({ email: 1 });
affiliateSchema.index({ createdAt: -1 });
affiliateSchema.index({ totalViews: -1, createdAt: -1 });
attachSafeAccountJsonTransform(affiliateSchema);

const Affiliate = mongoose.models.Affiliate || mongoose.model('Affiliate', affiliateSchema);

// Instant-approval affiliate invites â€” the admin generates a link for a known
// fighter/influencer to skip the manual-approval wait entirely. One-time use,
// expires after 14 days by default.
const affiliateInviteSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  note: { type: String, default: '' },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  usedByAffiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate', default: null },
}, { timestamps: true });
const AffiliateInvite = mongoose.models.AffiliateInvite || mongoose.model('AffiliateInvite', affiliateInviteSchema);


app.post('/upload-affiliate-reward', verifyAdminToken, upload.single('image'), async (req, res) => {
  try {
    const { affiliateId, rewardTitle } = req.body;

    if (!affiliateId) {
      return res.status(400).json({ message: 'Affiliate ID is required' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    const affiliate = await Affiliate.findById(affiliateId).select('+rewardImageDeleteUrl rewardTitle rewardImageUrl');
    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Delete old reward image from Cloudinary if exists
    if (affiliate.rewardImageDeleteUrl) {
      await cloudinary.uploader.destroy(affiliate.rewardImageDeleteUrl);
    }

    // Upload new reward image to Cloudinary
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'affiliate_rewards' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    // Update affiliate reward fields
    affiliate.rewardTitle = rewardTitle;
    affiliate.rewardImageUrl = result.secure_url;
    affiliate.rewardImageDeleteUrl = result.public_id;
    await affiliate.save();

    res.status(200).json({
      message: 'Reward info uploaded and saved successfully',
      rewardTitle: affiliate.rewardTitle,
      rewardImageUrl: affiliate.rewardImageUrl
    });
  } catch (error) {
    console.error('Error uploading reward image:', error);
    res.status(500).json({ message: 'Server error' });
  }
});





app.post('/admin/add-affiliate', verifyAdminToken, async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ message: 'All fields are required.' });
  }

  try {
    // Check if affiliate already exists
    const existingAffiliate = await Affiliate.findOne({ email });
    if (existingAffiliate) {
      return res.status(400).json({ message: 'Affiliate with this email already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new affiliate with default values and profileUrl
    const newAffiliate = new Affiliate({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      verified: true,
      isNotificationsEnabled: true,
      isSubscribed: true,
      isAgreed: true,
      profileUrl: "https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png",
    });

    await newAffiliate.save();

    // Email to the affiliate
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: email,
      subject: 'Welcome to Fantasy Madness Affiliate Program!',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${firstName},</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                You have been successfully added to the Fantasy Madness Affiliate Program by our administrators!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Below are your login credentials:
              </p>
              <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                <li><strong>Email:</strong> ${email}</li>
                <li><strong>Password:</strong> ${password}</li>
              </ul>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                Please log in at <a href="https://fantasymmadness.com/login" style="color: #191164; text-decoration: none;">https://fantasymmadness.com/login</a> to explore your account and get started!
              </p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                If you have any questions, feel free to reach out to us!
              </p>
            </td>
          </tr>

          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
    
        </table>
      `,
    });

    // Email to the admin
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: ADMIN_ALERT_EMAILS, // Replace with admin email
      subject: 'Affiliate Successfully Added',
      html: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
  
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You have successfully added a new affiliate to the Fantasy Madness program with the following details:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>First Name:</strong> ${firstName}</li>
              <li><strong>Last Name:</strong> ${lastName}</li>
              <li><strong>Email:</strong> ${email}</li>
            </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              No approval is needed as the account was added directly by you. The affiliate has been notified of their login credentials.
            </p>
          </td>
        </tr>
  
          <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
          <div style="padding-top: 10px;">
            <!-- Social Icons -->
            <a href="https://www.facebook.com/share/2pzYV9XdQpAU7n6p/?mibextid=LQQJ4d" style="margin: 0 5px; width:35px; height:35px; border-radius:50%; background:#fff; background-color:#fff;">
              <img src="https://i.ibb.co/G9wVH2g/facebook-removebg-preview-two.png" alt="Facebook" style="width:35px; height:35px; border-radius:50%; background-color:#fff; background:#fff;" />
            </a>
            <a href="https://www.instagram.com/fantasymmadness" style="margin: 0 5px;">
              <img src="https://i.ibb.co/tKj4px0/insta-removebg-preview-two.png" alt="Instagram" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
            <a href="https://x.com/davis_kell51697" style="margin: 0 5px;">
              <img src="https://i.ibb.co/T0cvy2Q/twitter-removebg-preview-two.png" alt="Twitter" style="width:35px; height:35px; border-radius:50%; background-color:#fff;" />
            </a>
          </div>
        </td>
      </tr>
      
      </table> `,
    });

    res.status(201).json({ message: 'Affiliate added successfully and emails sent.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'An error occurred while adding the affiliate.' });
  }
});




app.post('/affiliate-google-login', loginLimiter, async (req, res) => {
  const { token } = req.body;

  try {
    // Verify Google token
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { name, email, picture } = ticket.getPayload();

    // Check if the affiliate exists
    let affiliate = await Affiliate.findOne({ email });

    if (!affiliate) {
      // If affiliate does not exist, create a new one
      affiliate = new Affiliate({
        firstName: name.split(' ')[0],
        lastName: name.split(' ')[1] || '', // Handle single-word names
        email,
        profileUrl: picture,
        verified: false, // Mark as unverified, admin will verify
        isNotificationsEnabled: true, // Notifications enabled
        isSubscribed: true, // Subscribed to updates
        isAgreed: true, // Agreed to terms and conditions
      });

      await affiliate.save();

const notification = new Notification({
      title: `Affiliate Signed Up: ${affiliate.firstName}`,
    });
    await notification.save();
    


      // Send welcome email to the affiliate
      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: email, // Affiliate's email
        subject: 'Welcome to Fantasy Madness Affiliate Program!',
        html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
              </td>
            </tr>

            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${affiliate.firstName},</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  Welcome to Fantasy Madness! Your registration as an affiliate has been received and is pending approval by our administrators.
                </p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  You will be notified once your account is approved. Meanwhile, feel free to explore our platform and learn more about our affiliate program.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
      });



      // Send email notification to admin for approval
      const approvalLink = `https://fantasymmadness-game-server-three.vercel.app/approveAffiliate/${affiliate._id}?t=${signActionToken('affiliate-approval', affiliate._id)}`;
      sendAdminPush({ title: 'New affiliate sign-up', body: `${affiliate.firstName} needs approval.`, url: '/administration/AffiliateUsers' }).catch(() => null);

      await transporter.sendMail({
        from: FMM_MAIL_FROM,
        to: ADMIN_ALERT_EMAILS, // Admin email
        subject: 'New Affiliate Registration - Approval Needed',
        html: `
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
                <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
              </td>
            </tr>

            <tr>
              <td style="padding: 10px 0;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear Admin,</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  A new affiliate <strong>${affiliate.firstName} ${affiliate.lastName}</strong> has registered via Google Login on Fantasy Madness. Please review and approve their profile.
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
                <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Affiliate Details</h3>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  Name: ${affiliate.firstName} ${affiliate.lastName}<br>
                  Email: ${affiliate.email}
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 20px;">
                <a href="${approvalLink}" style="display:inline-block; padding:10px 20px; color:#fff; background-color:#191164; border-radius:5px; text-decoration:none; font-family: Arial, sans-serif;">Approve Now</a>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding: 15px 0;">
                <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
                <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
              </td>
            </tr>
          </table>
        `,
      });
    }

    // Generate JWT token
    const jwtToken = jwt.sign({ id: affiliate._id, scope: TOKEN_SCOPES.AFFILIATE }, process.env.JWT_SECRET, { expiresIn: SESSION_TOKEN_TTL });

    // Return JWT token and affiliate info
    res.status(200).json({
      message: 'Affiliate Google login successful',
      token: jwtToken,
      affiliate: {
        id: affiliate._id,
        name: `${affiliate.firstName} ${affiliate.lastName}`.trim(),
        email: affiliate.email,
        profileUrl: affiliate.profileUrl,
        verified: affiliate.verified,
      },
    });
  } catch (error) {
    console.error('Affiliate Google login error', error);

    // Send email notification about login failure
    await transporter.sendMail({
      from: FMM_MAIL_FROM,
      to: ADMIN_ALERT_EMAILS,
      subject: 'Affiliate Google Login Failed',
      html: `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
              <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
            </td>
          </tr>

          <tr>
            <td style="padding: 10px 0;">
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear Admins,</p>
              <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                An error occurred during an affiliate Google login attempt:
              </p>
              <p style="font-size: 16px; font-family: 'Courier New', monospace; color: #d20a0a; background-color: #f8d7da; border-radius: 5px; padding: 10px; border: 1px solid #f5c6cb;">
                ${error.message}
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <p style="font-family: Arial, sans-serif; color: #191164;">Please investigate the issue at your earliest convenience.</p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding: 15px 0;">
              <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
              <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
            </td>
          </tr>
        </table>
      `,
    });

    res.status(500).json({ message: 'Internal server error' });
  }
});



// Route to increment totalViews
app.post('/affiliate/:affiliateId/incrementViews', submitLimiter, async (req, res) => {
  try {
    const { affiliateId } = req.params;
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(
      affiliateId,
      { $inc: { totalViews: 1 } },
      { new: true }
    );

    if (!updatedAffiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    res.status(200).json(updatedAffiliate);
  } catch (error) {
    console.error('Error incrementing views:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


app.post('/forgotPassword', submitLimiter, async (req, res) => {
  const { email } = req.body;

  try {
    // Find the affiliate by email
    const affiliate = await Affiliate.findOne({ email });
    if (!affiliate) {
      return res.status(404).send('Affiliate not found');
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    // Set reset token and expiration time (e.g., 1 hour)
    affiliate.resetPasswordToken = resetTokenHash;
    affiliate.resetPasswordExpires = Date.now() + 3600000;

    await affiliate.save();

    // Send email with reset token
    const resetURL = `https://fantasymmadness.com/resetPassword/${resetToken}`;

    const mailOptions = {
      to: affiliate.email,
      from: FMM_MAIL_FROM,
      subject: 'Password Reset Request',
      text: `You are receiving this because you have requested a password reset for your account.\n\n
      Please click the following link to reset your password:\n\n
      ${resetURL}\n\n
      If you did not request this, please ignore this email.\n`,
    };

    await transporter.sendMail(mailOptions);
    
    res.status(200).send('Password reset email sent');
  } catch (error) {
    console.error('Error sending reset password email:', error);
    res.status(500).send('Server error');
  }
});


app.post('/resetPassword/:token', submitLimiter, async (req, res) => {
  try {
    // Hash the token from the URL to match the stored hash
    const resetTokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');

    // Find the affiliate by the token and ensure the token hasn't expired
    const affiliate = await Affiliate.findOne({
      resetPasswordToken: resetTokenHash,
      resetPasswordExpires: { $gt: Date.now() }, // Ensure token is not expired
    });

    if (!affiliate) {
      return res.status(400).send('Invalid or expired token');
    }

    // Update the password and remove the reset token and expiry
    affiliate.password = await bcrypt.hash(req.body.password, 10);
    affiliate.resetPasswordToken = undefined;
    affiliate.resetPasswordExpires = undefined;

    await affiliate.save();

    res.status(200).send('Password has been reset');
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).send('Server error');
  }
});


app.delete('/affiliates/:id/payouts-to-delete', verifyAdminToken, async (req, res) => {
  const affiliateId = req.params.id;

  try {
      // Find the affiliate by id
      const affiliate = await Affiliate.findById(affiliateId);

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      // Remove all payouts
      affiliate.payouts = [];

      // Save the updated affiliate document
      await affiliate.save();

      // Send success response
      res.status(200).json({ message: 'All payouts have been deleted for this affiliate', affiliate });
  } catch (error) {
      console.error('Error deleting payouts:', error);
      res.status(500).json({ message: 'Server error. Unable to delete payouts.' });
  }
});






// SECURITY + MONEY: authenticated, and the affiliate comes from the verified
// token rather than the :id in the URL. The amount is validated against the real
// balance and debited immediately, so the same balance cannot be requested twice.
// (:id is kept in the path for backward compatibility but is no longer trusted.)
app.post('/affiliate/:id/payout', verifyToken, requireScope(TOKEN_SCOPES.AFFILIATE), async (req, res) => {
  try {
    const affiliateId = String(req.user?.id || req.user?._id || '').trim();
    if (!affiliateId) {
      return res.status(401).json({ message: 'Authentication is required to request a payout.' });
    }

    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    const balance = Number.parseInt(String(affiliate.tokens || '0'), 10) || 0;
    const requested = Math.floor(Number(req.body?.amount));

    if (!Number.isFinite(requested) || requested <= 0) {
      return res.status(400).json({ message: 'Enter a payout amount greater than zero.', code: 'INVALID_AMOUNT' });
    }
    if (requested > balance) {
      return res.status(400).json({
        message: 'Payout amount is more than your available balance.',
        code: 'INSUFFICIENT_BALANCE',
        balance,
        requested,
      });
    }

    // Block a second request while one is still outstanding.
    const hasPending = Array.isArray(affiliate.payouts)
      && affiliate.payouts.some((item) => String(item?.status || 'pending').toLowerCase() === 'pending');
    if (hasPending) {
      return res.status(409).json({
        message: 'You already have a payout request awaiting review.',
        code: 'PAYOUT_ALREADY_PENDING',
      });
    }

    // Debit now so the same balance cannot be requested again before the admin
    // processes it. A rejected payout must credit this back.
    // Atomic: only applies while tokens still equals what we read, so a second
    // simultaneous request cannot claim the same balance.
    const debited = await Affiliate.findOneAndUpdate(
      { _id: affiliateId, tokens: String(balance) },
      { tokens: String(balance - requested) },
      { new: true }
    );
    if (!debited) {
      return res.status(409).json({
        message: 'Your balance just changed. Please review and request again.',
        code: 'BALANCE_CHANGED',
      });
    }
    affiliate.tokens = String(balance - requested);
    await recordWalletMove({
      userId: affiliate._id,
      amount: -requested,
      balanceBefore: balance,
      balanceAfter: balance - requested,
      reason: 'payout_requested',ãNùïfòµë(š+my×BÒæWrFFR‚“°¢&W6öÇfVBæFö2æ†öÖWvU&öÖ÷F–öåWFFVD'’Ò&WæFÖ–ãòæ–BÇÂ&WæFÖ–ãòåö–BÇÂ&WæFÖ–ãòæVÖ–ÂÇÂvFÖ–âs°¢v—B&W6öÇfVBæFö2ç6fR‚“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ7W&f6RÂ6VÆV7FVBÂ6÷W&6UG—S¢&W6öÇfVBç6÷W&6UG—RÂf–v‡C¢–6µV&Æ–4f–v‡Df–VÆG2‡&W6öÇfVBæFö2Â&W6öÇfVBç6÷W&6UG—R’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tW'&÷"WFF–ær†öÖWvRÆ6VÖVçC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–ÆVBFòWFFR†öÖWvRÆ6VÖVçBârÒ“°¢Ð§Ò“° ¦gVæ7F–öâ'6U66÷WF–ætÖöFVÄ§6öâ‡fÇVRÒrr’°¢6öç7B&rÒ7G&–ær‡fÇVRÇÂrr’çG&–Ò‚“°¢–b‚&r’&WGW&âçVÆÃ°¢6öç7Bv—F†÷WDfVæ6RÒ&rç&WÆ6R‚õæƒó¦§6öâ“õÇ2¢ö’Ârr’ç&WÆ6R‚õÇ2¦Bö’Ârr’çG&–Ò‚“°¢G'’°¢6öç7B'6VBÒ¥4ôâç'6R‡v—F†÷WDfVæ6R“°¢&WGW&â'6VBbbG—Vöb'6VBÓÓÒvö&¦V7Brò'6VB¢çVÆÃ°¢Ò6F6‚…öW'&÷"’°¢&WGW&âçVÆÃ°¢Ð§Ð ¦7–æ2gVæ7F–öâvVæW&FUfÆ–FFVE66÷WF–æu&W÷'B‡–ÆöBÒ·Ò’°¢6öç7BfÆÆ&6²Ò'V–ÆEFV×ÆFU66÷WF–æu&W÷'B‡–ÆöB“°¢6öç7B”¶W’Ò7G&–ær‡&ö6W72æVçbäõTä•ô•ô´U’ÇÂrr’çG&–Ò‚“°¢–b‚”¶W’ÇÂfÆÆ&6²’&WGW&âfÆÆ&6³° ¢6öç7B7—7FVÕ&ö×BÒ°¢u–÷Rw&—FR6öæ6—6R6öÖ&B×7÷'G266÷WF–ær&Wf–Wrg&öÒöæÇ’F†R7WÆ–VB¥4ôâârÀ¢u&WGW&â¥4ôâv—F‚W†7FÇ’7VÖÖ'’Â–6µ7Æ—Dæ÷FRÂæBVæFW&FötævÆR7G&–ærf–VÆG2ârÀ¢tæWfW"–çfVçB&V6÷&G2ÂöFG2Â–æ§W&–W2ÂæWw2Â&æ¶–æw2ÂFFW2ÂW&6VçFvW2Â÷"7FF—7F–72ârÀ¢uW6RæòçVÖ&W'2W†6WBçVÖ&W'2F†BV"–âF†R7WÆ–VB¥4ôââ–bF†RFF—2–ç7Vff–6–VçBÂ6’6òÆ–æÇ’ârÀ¢Òæ¦ö–â‚rr“° ¢f÷"†ÆWBGFV×BÒ²GFV×BÂ#²GFV×B³Ò’°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚‚v‡GG3¢òö’æ÷Væ’æ6öÒ÷cö6†Bö6ö×ÆWF–öç2rÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²WF†÷&—¦F–öã¢&V&W"G¶”¶W—ÖÂt6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢ÖöFVÃ¢&ö6W72æVçbäõTä•õ44õUD”äuôÔôDTÂÇÂvwBÓFòÖÖ–æ’rÀ¢FV×W&GW&S¢ã"À¢&W7öç6Uöf÷&ÖC¢²G—S¢v§6öåöö&¦V7BrÒÀ¢ÖW76vW3¢°¢²&öÆS¢w7—7FVÒrÂ6öçFVçC¢7—7FVÕ&ö×BÒÀ¢²&öÆS¢wW6W"rÂ6öçFVçC¢¥4ôâç7G&–æv–g’‡–ÆöB’ÒÀ¢ÒÀ¢Ò’À¢Ò“°¢–b‚&W7öç6Ræö²’6öçF–çVS°¢6öç7B&öG’Òv—B&W7öç6Ræ§6öâ‚“°¢6öç7B6æF–FFRÒ'6U66÷WF–ætÖöFVÄ§6öâ†&öG“òæ6†ö–6W3òå³ÓòæÖW76vSòæ6öçFVçB“°¢–b‚6æF–FFRÇÂfÆ–FFU66÷WF–æu&W÷'DçVÖ&W'2†6æF–FFRÂ–ÆöB’’6öçF–çVS°¢&WGW&â°¢7VÖÖ'“¢7G&–ær†6æF–FFRç7VÖÖ'’ÇÂrr’çG&–Ò‚’À¢–6µ7Æ—Dæ÷FS¢7G&–ær†6æF–FFRç–6µ7Æ—Dæ÷FRÇÂrr’çG&–Ò‚’À¢VæFW&FötævÆS¢7G&–ær†6æF–FFRçVæFW&FötævÆRÇÂrr’çG&–Ò‚’À¢6÷W&6S¢wfÆ–FFVBÖÖöFVÂrÀ¢–ÆöEfW'6–öã¢À¢vVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢Ó°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â‚u¶’×66÷WF–æuÒvVæW&F–öâGFV×Bf–ÆVC¢rÂW'&÷"æÖW76vR“°¢Ð¢Ð¢&WGW&âfÆÆ&6³°§Ð ¢òòFÖ–â×G&–vvW&VBÂW"Öf–v‡BvVæW&F–öââF†R6fVB&W÷'B—2Çv—2FW&—fV@¢òòg&öÒF†R&Vv—7FW&VBf–v‡BæB7V&Ö—GFVB66÷&V6&G3²–çfÆ–BÖöFVÂ÷WGWB—0¢òòF—66&FVB–âff÷"öbF†RfÆ–FFVBFWFW&Ö–æ—7F–2fÆÆ&6²à¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦–Bö’×66÷WF–ær×&W÷'BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W6öÇfVBÒv—B&W6öÇfTf–v‡DFö7VÖVçDf÷$FÖ–å&öÖ÷F–öâ‡&Wç&×2æ–BÂ&Wæ&öG“òç6÷W&6UG—RÇÂ&WçVW'’ç6÷W&6UG—R“°¢–b‚&W6öÇfVB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“°¢6öç7B66÷&W2Òv—B66÷&Ræf–æB‡²ÖF6„–C¢7G&–ær‡&W6öÇfVBæFö2åö–B’Ò’ç6VÆV7B‚w&VF–7F–öç2r’æÆVâ‚“°¢6öç7B–ÆöBÒ'V–ÆE66÷WF–æu–ÆöB‡&W6öÇfVBæFö2Â66÷&W2“°¢6öç7BvVæW&FVE&W÷'BÒv—BvVæW&FUfÆ–FFVE66÷WF–æu&W÷'B‡–ÆöB“°¢–b‚vVæW&FVE&W÷'B’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†Rf–v‡BæVVG2&÷F‚&Vv—7FW&VBf–v‡FW"æÖW2&Vf÷&R&W÷'B6â&RvVæW&FVBârÒ“°¢6öç7B&W÷'BÒ²ââævVæW&FVE&W÷'BÂ–6´6÷VçC¢–ÆöBç–6´6÷VçBÂ–6µ7Æ—C¢–ÆöBç–6µ7Æ—BÓ°¢&W6öÇfVBæFö2æ•66÷WF–æu&W÷'BÒ&W÷'C°¢v—B&W6öÇfVBæFö2ç6fR‚“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ6÷W&6UG—S¢&W6öÇfVBç6÷W&6UG—RÂ&W÷'BÂ–6´6÷VçC¢–ÆöBç–6´6÷VçBÂ–6µ7Æ—C¢–ÆöBç–6µ7Æ—BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u¶’×66÷WF–æuÒf–ÆVBFòvVæW&FR&W÷'C¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uVæ&ÆRFòvVæW&FRF†—2f–v‡B66÷WF–ær&W÷'BârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷V&Æ–2öf–v‡BÖ6ÆVæF"rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ–Ö—BÒ'6U÷6—F—fT–çFVvW"‡&WçVW'’æÆ–Ö—BÂSÂ“°¢ÆWB&6Tf–ÇFW"Ò·Ó°¢–b‚—4ÆÄf–ÇFW%fÇVR‡&WçVW'’æ6FVv÷'’’’&6Tf–ÇFW"ÒVæDæDf–ÇFW"†&6Tf–ÇFW"Â'V–ÆDVffV7F—fTf–v‡D6FVv÷'”f–ÇFW"‡&WçVW'’æ6FVv÷'’’“°¢6öç7Bf—6–&ÆTf–ÇFW"ÒÇ”f–v‡EV&Æ–5f—6–&–Æ—G”f–ÇFW"†&6Tf–ÇFW"Â&WçVW'’“°¢6öç7B¶ÖF6†W2Â6†F÷w5ÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æf–æB‡f—6–&ÆTf–ÇFW"’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²ÖF6„FFS¢ÂWFFVDC¢ÓÒ’æÆ–Ö—B†Æ–Ö—B’æÆVâ‚’À¢6†F÷ræf–æB‡f—6–&ÆTf–ÇFW"’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²ÖF6„FFS¢ÂWFFVDC¢ÓÒ’æÆ–Ö—B†Æ–Ö—B’æÆVâ‚’æ6F6‚‚‚’ÓâµÒ’À¢Ò“°¢ÆWB—FV×2Ò°¢ââæÖF6†W2æÖ‚†f–v‡B’Óâ–6µV&Æ–4f–v‡Df–VÆG2†f–v‡BÂvÖF6‚r’’À¢ââç6†F÷w2æÖ‚†f–v‡B’Óâ–6µV&Æ–4f–v‡Df–VÆG2†f–v‡BÂw6†F÷rr’’À¢Òæf–ÇFW"‚†f–v‡B’Óâ—4G&gDf–v‡E&V6÷&B†f–v‡B’bb'6Tf–v‡DFFUF–ÖR†f–v‡B’“°¢—FV×2ÒÇ•V&Æ–4f–v‡E7FGW4–çFVçB†—FV×2Â&WçVW'’“°¢6öç7Bw&÷WVD'”FFRÒ—FV×2ç&VGV6R‚†62Âf–v‡B’Óâ°¢6öç7BFFRÒ'6Tf–v‡DFFUF–ÖR†f–v‡B“°¢–b‚FFR’&WGW&â63°¢6öç7B¶W’ÒFFRçFô•4õ7G&–ær‚’ç6Æ–6RƒÂ“°¢–b‚65¶¶W•Ò’65¶¶W•ÒÒµÓ°¢65¶¶W•ÒçW6‚‡°¢–C¢7G&–ær†f–v‡Båö–BÇÂf–v‡Bæ–B’À¢6÷W&6UG—S¢f–v‡Bç6÷W&6UG—RÀ¢F—FÆS¢f–v‡BæÖF6„æÖRÇÂG¶f–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÖÀ¢f–v‡FW$¢f–v‡BæÖF6„f–v‡FW$À¢f–v‡FW$#¢f–v‡BæÖF6„f–v‡FW$"À¢6FVv÷'“¢f–v‡BæF—7Æ”6FVv÷'’ÇÂf–v‡BæÖF6„6FVv÷'•GvòÇÂf–v‡BæÖF6„6FVv÷'’À¢ÖF6…F–ÖS¢f–v‡BæÖF6…F–ÖRÀ¢F–ÖVÆ–æT'V6¶WC¢f–v‡BçF–ÖVÆ–æT'V6¶WBÇÂvWDf–v‡EF–ÖVÆ–æT'V6¶WB†f–v‡B’À¢Ò“°¢&WGW&â63°¢ÒÂ·Ò“°¢&W2æ§6öâ‡²ö³¢G'VRÂ—FV×2Âw&÷WVD'”FFRÂFFW3¢ö&¦V7Bæ¶W—2†w&÷WVD'”FFR’ç6÷'B‚’Â6÷VçC¢—FV×2æÆVæwF‚ÂvVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ærf–v‡B6ÆVæF#¢rÂW'&÷"“°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–ÆVBFòÆöBf–v‡B6ÆVæF"ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷V&Æ–2ö†öÖWvR÷&öÖ÷FVBÖf–v‡G2rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ–Ö—BÒ'6U÷6—F—fT–çFVvW"‡&WçVW'’æÆ–Ö—BÂ‚Â#B“°¢6öç7Bæ÷rÒæWrFFR‚“°¢6öç7Bf—6–&ÆU&öÖ÷FVDf–ÇFW"ÒÇ”f–v‡EV&Æ–5f—6–&–Æ—G”f–ÇFW"‡°¢F÷#¢·²†öÖWvU&öÖ÷FVC¢G'VRÒÂ²fVGW&VEF†—5vVV³¢G'VRÒÂ²fVGW&VDf–v‡C¢G'VRÕÒÀ¢ÒÂ²Æ–&ÆS¢wG'VRrÒ“°¢6öç7BVW'”Æ–Ö—BÒÖF‚æÖ–â„ÖF‚æÖ‚†Æ–Ö—B¢BÂÆ–Ö—B’Â#“°¢6öç7B¶ÖF6†W2Â6†F÷w5ÒÒv—B&öÖ—6RæÆÂ…°¢Ç”f–v‡Dg&W6…6÷'DÆVâ„ÖF6‚æf–æB‡f—6–&ÆU&öÖ÷FVDf–ÇFW"’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’’æÆ–Ö—B‡VW'”Æ–Ö—B’À¢Ç”f–v‡Dg&W6…6÷'DÆVâ…6†F÷ræf–æB‡f—6–&ÆU&öÖ÷FVDf–ÇFW"’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’’æÆ–Ö—B‡VW'”Æ–Ö—B’æ6F6‚‚‚’ÓâµÒ’À¢Ò“°¢6öç7B—FV×2Ò°¢ââæÖF6†W2æÖ‚†f–v‡B’Óâ–6µV&Æ–4f–v‡Df–VÆG2†f–v‡BÂvÖF6‚r’’À¢ââç6†F÷w2æÖ‚†f–v‡B’Óâ–6µV&Æ–4f–v‡Df–VÆG2†f–v‡BÂw6†F÷rr’’À¢Ð¢æf–ÇFW"‚†f–v‡B’Óâ—4†öÖWvU&öÖ÷F–öåf—6–&ÆR†f–v‡BÂæ÷r’bb—5V&Æ–4†öÖT7F—fTf–v‡E&V6÷&B†f–v‡BÂæ÷r’¢ç6÷'B†6ö×&T†öÖWvU&öÖ÷FVDf–v‡G2¢ç6Æ–6RƒÂÆ–Ö—B“° ¢&W2ç6WD†VFW"‚t66†RÔ6öçG&öÂrÂw&—fFRÂæò×7F÷&RÂæòÖ66†RÂÖ‚ÖvSÓÂ×W7B×&WfÆ–FFRr“°¢&W2ç6WD†VFW"‚u&vÖrÂvæòÖ66†Rr“°¢&W2ç6WD†VFW"‚tW‡—&W2rÂsr“°¢&W2ç6WD†VFW"‚u‚Ô&6¶VæBÔ66†RrÂt%•52r“°¢&W2æ§6öâ‡²ö³¢G'VRÂ—FV×2Â6÷VçC¢—FV×2æÆVæwF‚ÂvVæW&FVDC¢æ÷rçFô•4õ7G&–ær‚’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ær&öÖ÷FVB†öÖWvRf–v‡G3¢rÂW'&÷"“°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–ÆVBFòÆöB&öÖ÷FVB†öÖWvRf–v‡G2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öff–Æ–FRó¦ff–Æ–FT–B÷&öÖ÷FVBÖf–v‡G2rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&Wç&×2æff–Æ–FT–BÇÂrr’çG&–Ò‚“°¢–b‚ff–Æ–FT–B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tff–Æ–FR–B—2&WV—&VBârÒ“° ¢6öç7B7F—fTöæÇ’Ò²wG'VRrÂsrÂw–W2uÒæ–æ6ÇVFW2…7G&–ær‡&WçVW'’æ7F—fTöæÇ’ÇÂ&WçVW'’æ÷VäöæÇ’ÇÂrr’çFôÆ÷vW$66R‚’“°¢6öç7Bff–Æ–FTö&¦V7D–BÒÖöævö÷6RåG—W2äö&¦V7D–Bæ—5fÆ–B†ff–Æ–FT–B’òæWrÖöævö÷6RåG—W2äö&¦V7D–B†ff–Æ–FT–B’¢çVÆÃ°¢6öç7B6†F÷tf–ÇFW"Òff–Æ–FTö&¦V7D–@¢ò²tff–Æ–FT–G2äff–Æ–FT–Bs¢ff–Æ–FTö&¦V7D–BÐ¢¢²tff–Æ–FT–G2äff–Æ–FT–Bs¢ff–Æ–FT–BÓ° ¢6öç7B¶F—&V7DÖF6†W2Â&öÖ÷FVE6†F÷uFV×ÆFW2ÂÆÅ6†F÷uFV×ÆFW5ÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æf–æB‡²F÷#¢·²ff–Æ–FT–BÒÂ²6÷W&6U6†F÷t–C¢²FW†—7G3¢G'VRÒÂff–Æ–FT–BÕÒÒ’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²WFFVDC¢ÓÂ7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ3’æÆVâ‚’À¢6†F÷ræf–æB‡6†F÷tf–ÇFW"’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²WFFVDC¢ÓÂ7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ3’æÆVâ‚’æ6F6‚‚‚’ÓâµÒ’À¢6†F÷ræf–æB†Ç”f–v‡EV&Æ–5f—6–&–Æ—G”f–ÇFW"‡·ÒÂ²–æ6ÇVFTG&gG3¢&WçVW'’æ–æ6ÇVFTG&gG2Ò’’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²WFFVDC¢ÓÂ7&VFVDC¢ÓÒ’æÆ–Ö—BƒS’æÆVâ‚’æ6F6‚‚‚’ÓâµÒ’À¢Ò“° ¢6öç7BÆ–æ¶VDÖF6„–G2Ò²ââææWr6WB‡&öÖ÷FVE6†F÷uFV×ÆFW2æfÆDÖ‚‡6†F÷r’Óâ„'&’æ—4'&’‡6†F÷räff–Æ–FT–G2’ò6†F÷räff–Æ–FT–G2¢µÒ¢æf–ÇFW"‚†—FVÒ’Óâ7G&–ær†—FVÓòäff–Æ–FT–BÇÂrr’ÓÓÒff–Æ–FT–BÇÂ7G&–ær†—FVÓòäff–Æ–FT–Còåö–BÇÂrr’ÓÓÒff–Æ–FT–B¢æÖ‚†—FVÒ’Óâ7G&–ær†—FVÓòæÖF6„–BÇÂ—FVÓòæÖF6„–Còåö–BÇÂrr’¢æf–ÇFW"‚†–B’ÓâÖöævö÷6RåG—W2äö&¦V7D–Bæ—5fÆ–B†–B’’’•Ó° ¢6öç7BÆ–æ¶VDÖF6†W2ÒÆ–æ¶VDÖF6„–G2æÆVæwF€¢òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢Æ–æ¶VDÖF6„–G2ÒÒ’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²WFFVDC¢ÓÂ7&VFVDC¢ÓÒ’æÆVâ‚¢¢µÓ° ¢6öç7B'”¶W’ÒæWrÖ‚“°¢6öç7BFD—FVÒÒ†f–v‡BÂ6÷W&6UG—RÂW‡G&Ò·Ò’Óâ°¢–b‚f–v‡BÇÂ—4G&gDf–v‡E&V6÷&B†f–v‡B’’&WGW&ã°¢–b†7F—fTöæÇ’bbvWDf–v‡EF–ÖVÆ–æT'V6¶WB‡²ââæf–v‡BÂ6÷W&6UG—RÒ’ÓÓÒw7Br’&WGW&ã°¢6öç7B¶W’ÒG·6÷W&6UG—WÓ¢Gµ7G&–ær†f–v‡Båö–B—Ö°¢'”¶W’ç6WB†¶W’Â°¢ââç–6µV&Æ–4f–v‡Df–VÆG2†f–v‡BÂ6÷W&6UG—R’À¢ff–Æ–FU&öÖ÷F–öã¢°¢—5&öÖ÷FVC¢G'VRÀ¢ff–Æ–FT–BÀ¢6÷W&6UG—RÀ¢ââæW‡G&À¢ÒÀ¢Ò“°¢Ó° ¢F—&V7DÖF6†W2æf÷$V6‚‚†ÖF6‚’ÓâFD—FVÒ†ÖF6‚ÂvÖF6‚rÂ²ÖöFS¢vff–Æ–FRÖ7&VFVBÖÖF6‚rÒ’“°¢Æ–æ¶VDÖF6†W2æf÷$V6‚‚†ÖF6‚’ÓâFD—FVÒ†ÖF6‚ÂvÖF6‚rÂ²ÖöFS¢vÆ–æ¶VB×6†F÷rÖÖF6‚rÒ’“°¢&öÖ÷FVE6†F÷uFV×ÆFW2æf÷$V6‚‚‡6†F÷r’ÓâFD—FVÒ‡6†F÷rÂw6†F÷rrÂ²ÖöFS¢w&öÖ÷FVB×6†F÷r×FV×ÆFRrÒ’“° ¢6öç7B&öÖ÷FVE6†F÷t–G2ÒæWr6WB‡&öÖ÷FVE6†F÷uFV×ÆFW2æÖ‚‡6†F÷r’Óâ7G&–ær‡6†F÷råö–B’’“°¢6öç7Bf–Æ&ÆU6†F÷uFV×ÆFW2ÒÆÅ6†F÷uFV×ÆFW0¢æf–ÇFW"‚‡6†F÷r’Óâ—4G&gDf–v‡E&V6÷&B‡6†F÷r’¢æÖ‚‡6†F÷r’Óâ‡°¢ââç–6µV&Æ–4f–v‡Df–VÆG2‡6†F÷rÂw6†F÷rr’À¢ff–Æ–FU&öÖ÷F–öã¢°¢—5&öÖ÷FVC¢&öÖ÷FVE6†F÷t–G2æ†2…7G&–ær‡6†F÷råö–B’’À¢ff–Æ–FT–BÀ¢6÷W&6UG—S¢w6†F÷rrÀ¢ÒÀ¢Ò’“° ¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ff–Æ–FT–BÀ¢—FV×3¢'&’æg&öÒ†'”¶W’çfÇVW2‚’’ç6÷'B†6ö×&T†öÖWvU&öÖ÷FVDf–v‡G2’À¢&öÖ÷FVE6†F÷uFV×ÆFW3¢&öÖ÷FVE6†F÷uFV×ÆFW2æÖ‚‡6†F÷r’Óâ–6µV&Æ–4f–v‡Df–VÆG2‡6†F÷rÂw6†F÷rr’’À¢f–Æ&ÆU6†F÷uFV×ÆFW2À¢6†F÷uFV×ÆFW3¢f–Æ&ÆU6†F÷uFV×ÆFW2À¢vVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ærff–Æ–FR&öÖ÷FVBf–v‡G3¢rÂW'&÷"“°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–ÆVBFòÆöBff–Æ–FR&öÖ÷FVBf–v‡G2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öff–Æ–FRó¦ff–Æ–FT–B÷6†F÷rÖf–v‡G2rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&Wç&×2æff–Æ–FT–BÇÂrr’çG&–Ò‚“°¢6öç7B&öÖ÷FVBÒv—B6†F÷ræf–æB‡°¢âââ†Ööævö÷6RåG—W2äö&¦V7D–Bæ—5fÆ–B†ff–Æ–FT–B¢ò²tff–Æ–FT–G2äff–Æ–FT–Bs¢æWrÖöævö÷6RåG—W2äö&¦V7D–B†ff–Æ–FT–B’Ð¢¢²tff–Æ–FT–G2äff–Æ–FT–Bs¢ff–Æ–FT–BÒ’À¢Ò’ç6VÆV7B‚uö–Br’æÆVâ‚’æ6F6‚‚‚’ÓâµÒ“°¢6öç7B&öÖ÷FVD–G2ÒæWr6WB‡&öÖ÷FVBæÖ‚†—FVÒ’Óâ7G&–ær†—FVÒåö–B’’“°¢6öç7B6†F÷w2Òv—B6†F÷ræf–æB†Ç”f–v‡EV&Æ–5f—6–&–Æ—G”f–ÇFW"‡·ÒÂ&WçVW'’’’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’ç6÷'B‡²WFFVDC¢ÓÂ7&VFVDC¢ÓÒ’æÆ–Ö—BƒS’æÆVâ‚“°¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ff–Æ–FT–BÀ¢—FV×3¢6†F÷w2æf–ÇFW"‚‡6†F÷r’Óâ—4G&gDf–v‡E&V6÷&B‡6†F÷r’’æÖ‚‡6†F÷r’Óâ‡°¢ââç–6µV&Æ–4f–v‡Df–VÆG2‡6†F÷rÂw6†F÷rr’À¢ff–Æ–FU&öÖ÷F–öã¢²—5&öÖ÷FVC¢&öÖ÷FVD–G2æ†2…7G&–ær‡6†F÷råö–B’’Âff–Æ–FT–BÂ6÷W&6UG—S¢w6†F÷rrÒÀ¢Ò’’À¢vVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tW'&÷"ÆöF–ærff–Æ–FR6†F÷rf–v‡G3¢rÂW'&÷"“°¢&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–ÆVBFòÆöBff–Æ–FR6†F÷rf–v‡G2ârÒ“°¢Ð§Ò“°   ¢òò„4R#¢6VçG&Æ—¦VB”ôäõ27v&ÒvFWv’&÷WFW2â¶WB—6öÆFVB–â7v&Ò×†6S"æ§0¢òò6òF†RW†—7F–ær&6¶VæB6öFRÂÖöFVÇ2ÂæB'W6–æW72'VÆW2&VÖ–âWF†÷&—FF—fRà§&Vv—7FW%7v&Õ†6S%&÷WFW2‡°¢À¢Ööævö÷6RÀ¢†–÷2À¢7'—FòÀ¢fW&–g”FÖ–åFö¶VâÀ¢&ÆörÀ¢æ÷F–f–6F–öâÀ¢WÆöBÀ¢6Æ÷VF–æ'’À§Ò“° ¢òòvöövÆRæWw2ÓâTd2WfVçBF—66÷fW'’âF†—2¶VW2F†RW†—7F–ærf–v‡B6ÆVæF"æ@¢òò7v&Òv÷&¶fÆ÷r–çF7Bv†–ÆR&VÖ÷f–ærF†RW‡—&VB%52vw&VvF÷"FWVæFVæ7’à¦6öç7BVf4WfVçDF—66÷fW'’Ò&Vv—7FW%Vf4WfVçDF—66÷fW'’‡°¢À¢7&öâÀ¢'6W"À¢fWF6‚À¢ÖF6‚À¢æ÷F–f–6F–öâÀ¢fW&–g”FÖ–åFö¶VâÀ¢G&–vvW%W6öÖ–ætWfVçDWFöÖF–öäf÷$ÖF6‚À¢6ÆV%V&Æ–5&W7öç6T66†RÀ§Ò“°¦æÆö6Ç2çVf4WfVçDF—66÷fW'’ÒVf4WfVçDF—66÷fW'“°   ¢òò„4R"4TòõU$dõ$Ôä4S¢V&Æ–24TòFFÂv–æF–öâÂ6—FVÖ÷66†VÖ†VÇW'2À¢òòæBFÖ–â&÷fÂVæGö–çG2f÷"7v&Ò4Tò–çFVÆÆ–vVæ6Râ¶WB—6öÆFVB6òF†P¢òòW†—7F–ær&6¶VæB&÷WFW2æB'W6–æW72'VÆW2&VÖ–âVæ6†ævVBà§&Vv—7FW%6VõW&f÷&Öæ6U†6S%&÷WFW2‡°¢À¢Ööævö÷6RÀ¢fW&–g”FÖ–åFö¶VâÀ¢ÖöFVÇ3¢°¢ÖF6‚À¢6†F÷rÀ¢&ÆörÀ¢æWw2À¢–÷WGV&Uf–FV÷2À¢66÷&RÀ¢W6W"À¢&õw&W7FÆW"À¢&õw&W7FÆ–ætÖF6‚À¢ÒÀ§Ò“° ¢òò„4S¢6fRf–v‡BFF×VÆ—G’²6öÖ&Bf–v‡FW"Æ–'&'’†VÇW'2âFF—F—fRöæÇ“°¢òòöÆBÖF6‚f–VÆG2÷&÷WFW27F’Væ6†ævVBæB&VÖ–âF†RfÆÆ&6²f÷"V&Æ–2vW2à§&Vv—7FW$f–v‡DFFVÆ—G•&÷WFW2‡°¢À¢Ööævö÷6RÀ¢†–÷2À¢WÆöBÀ¢6Æ÷VF–æ'’À¢fW&–g”FÖ–åFö¶VâÀ¢ÖF6‚À¢66÷&RÀ¢6†F÷rÀ§Ò“° ¢òò„4S¢FÖ–âW6‚ÆW'G2(	BÆWG2âFÖ–â–ç7FÆÂF†R&6²öff–6RFòF†V— ¢òò†öæR†öÖR67&VVâæBvWB&VÂW6‚†æ÷B§W7BVÖ–Â’öâæWr6–vçW2à¢‡²6VæDFÖ–åW6‚ÒÒ&Vv—7FW$FÖ–åW6…&÷WFW2‡²ÂÖöævö÷6RÂfW&–g”FÖ–åFö¶VâÒ’“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòDôÔ”2d”t…BTåE%’(	B6†&vW2F†RVçG'’fVRæB6fW2F†R&VF–7F–öâFövWF†W ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò&WÆ6W2F†RVç6fR—"…õ5Bö’÷66÷&W2²õ5Bö’öÖF6†W2ó¦–Bð¢òòWFFU&VF–7F–öå7FGW2’Âv†–6‚6fVB&VF–7F–öât•D„õUBWfW"FV&—F–ærF†P¢òòvÆÆWB(	BÆ–W'26÷VÆBVçFW"–B6öçFW7G2f÷"g&VRà¢òð¢òòwV&çFVW3 ¢òò¢fVR—2&VBg&öÒF†Rf–v‡B&V6÷&BÂæWfW"g&öÒF†R&WVW7B&öG¢òò¢vÆÆWBFV&—B²&VF–7F–öâ6fR²÷B–æ7&VÖVçB7V66VVB÷"f–ÂFövWF†W ¢òò¢–FV×÷FVçC¢&WVB7V&Ö—B&WGW&ç2F†R÷&–v–æÂ&W7VÇBÂæWfW"&RÖ6†&vW0¢òò¢WfW'’FV&—Bw&—FW2âVF—B&÷p¢òòÖöFVÆÆVBöâ¦ö–åw&W7FÆ–ætÖF6‚Âv†–6‚Ç&VG’F–BF†—26÷'&V7FÇ’à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ ¦6öç7Bf–v‡DVçG'”ÆVFvW%66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢W6W$–C¢²G—S¢Ööævö÷6Rå66†VÖåG—W2äö&¦V7D–BÂ&Vc¢uW6W"rÂ–æFWƒ¢G'VRÒÀ¢ÖF6„–C¢²G—S¢7G&–ærÂ–æFWƒ¢G'VRÒÀ¢6÷W&6UG—S¢²G—S¢7G&–ærÂVçVÓ¢²vÖF6‚rÂw6†F÷ruÒÂFVfVÇC¢vÖF6‚rÒÀ¢G—S¢²G—S¢7G&–ærÂVçVÓ¢²td”t…EôTåE%’rÂtd”t…EôTåE%•õ$TeTäBuÒÂFVfVÇC¢td”t…EôTåE%’rÒÀ¢Ö÷VçC¢²G—S¢çVÖ&W"Â&WV—&VC¢G'VRÒÀ¢&Ææ6T&Vf÷&S¢²G—S¢çVÖ&W"Â&WV—&VC¢G'VRÒÀ¢&Ææ6TgFW#¢²G—S¢çVÖ&W"Â&WV—&VC¢G'VRÒÀ¢–FV×÷FVæ7”¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ¢ÖWFFF¢Ööævö÷6Rå66†VÖåG—W2äÖ—†VBÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“°¦6öç7Bf–v‡DVçG'”ÆVFvW"ÒÖöævö÷6RæÖöFVÇ2äf–v‡DVçG'”ÆVFvW ¢ÇÂÖöævö÷6RæÖöFVÂ‚tf–v‡DVçG'”ÆVFvW"rÂf–v‡DVçG'”ÆVFvW%66†VÖ“° ¦6öç7Bf–v‡EFö¶Vä&Ææ6RÒ‡fÇVR’Óâ°¢6öç7B'6VBÒçVÖ&W"ç'6T–çB…7G&–ær‡fÇVRóòsr’Â“°¢&WGW&âçVÖ&W"æ—4f–æ—FR‡'6VB’òÖF‚æÖ‚ƒÂ'6VB’¢°§Ó° ¦6öç7B'Väf–v‡DVçG'•G&ç67F–öâÒ7–æ2‡v÷&²’Óâ°¢6öç7B6W76–öâÒv—BÖöævö÷6Rç7F'E6W76–öâ‚“°¢G'’°¢ÆWB&W7VÇC°¢G'’°¢v—B6W76–öâçv—F…G&ç67F–öâ†7–æ2‚’Óâ²&W7VÇBÒv—Bv÷&²‡6W76–öâ“²Ò“°¢&WGW&â&W7VÇC°¢Ò6F6‚†W'&÷"’°¢òò7FæFÆöæRÖöævò†æò&WÆ–66WB’6ææ÷B'VâG&ç67F–öç2âÆÆ÷rà¢òòW‡Æ–6—B÷BÖ÷WBf÷"Æö6ÂFWböæÇ’(	BæWfW"Væ&ÆRF†—2–â&öGV7F–öâÀ¢òò&V6W6RÖ–B×6WVVæ6Rf–ÇW&R6÷VÆB6†&vRv—F†÷WB6f–ærâVçG'’à¢6öç7BVç7W÷'FVBÒõG&ç67F–öâçVÖ&W'2&RöæÇ’ÆÆ÷vVGÇ&WÆ–66WGÇG&ç67F–öç2&Ræ÷B7W÷'FVBö¢çFW7B…7G&–ær†W'&÷"æÖW76vRÇÂrr’“° ¢òòF†R÷BÖ÷WB—2f÷"Æö6ÂFWfVÆ÷ÖVçBöæÇ’â†öæ÷W&–ær—B–â&öGV7F–öà¢òòv÷VÆBÆWBÖ–B×6WVVæ6Rf–ÇW&R6†&vRÆ–W"v—F†÷WB&V6÷&F–ærF†P¢òòVçG'’(	BF†RW†7B'VrG&ç67F–öç2W†—7BFò&WfVçBà¢–b‡Vç7W÷'FVBbb&ö6W72æVçbääôDUôTåbÓÓÒw&öGV7F–öâr’°¢6öç6öÆRæW'&÷"‚tdDÂDD$•4³¢ÖöæW’÷W&F–öâv2GFV×FVBv–ç7Bæöâ×G&ç67F–öæÂÖöævôD"âÖ¶RF†RFF&6R&WÆ–66WBâr“°¢F‡&÷rf–v‡DVçG'”W'&÷"€¢S2À¢tVçG&–W2&RFV×÷&&–Ç’Væf–Æ&ÆRâ÷W"FVÒ†2&VVâÆW'FVBârÀ¢tDD$4UôäõEõE$å45D”ôäÂrÀ¢“°¢Ð¢–b‡Vç7W÷'FVBbb7G&–ær‡&ö6W72æVçbäd”t…EôTåE%•ôÄÄõuôäôåõE$å45D”ôäÂÇÂrr’çFôÆ÷vW$66R‚’ÓÓÒwG'VRr’°¢6öç6öÆRçv&â‚ut$ä”äs¢'Vææ–ærf–v‡BVçG'’v—F†÷WBÖöævôD"G&ç67F–öâ„d”t…EôTåE%•ôÄÄõuôäôåõE$å45D”ôäÃ×G'VR’âFWfVÆ÷ÖVçBöæÇ’âr“°¢&WGW&âv÷&²†çVÆÂ“°¢Ð¢F‡&÷rW'&÷#°¢Ð¢Òf–æÆÇ’°¢v—B6W76–öâæVæE6W76–öâ‚“°¢Ð§Ó° ¦6öç7Bv—F„f–v‡E6W76–öâÒ‡VW'’Â6W76–öâ’Óâ‡6W76–öâòVW'’ç6W76–öâ‡6W76–öâ’¢VW'’“° ¦6öç7Bf–v‡DVçG'”W'&÷"Ò‡7FGW2ÂÖW76vRÂ6öFRÂW‡G&Ò·Ò’Óâ°¢6öç7BW'&÷"ÒæWrW'&÷"†ÖW76vR“°¢W'&÷"ç7FGW2Ò7FGW3°¢W'&÷"æ6öFRÒ6öFS°¢W'&÷"æW‡G&ÒW‡G&°¢&WGW&âW'&÷#°§Ó° ¢òòVçG'’—26Æ÷6VBöæ6RF†Rf–v‡B—2f–æ—6†VBö6Æ÷6VBÂ6†F÷r—26Æ÷6VBÂ÷"F†P¢òò66†VGVÆVB7F'BF–ÖR†276VBà¦6öç7B—4f–v‡D÷Väf÷$VçG'’Ò†f–v‡B’Óâ°¢6öç7B7FGW2Ò7G&–ær†f–v‡CòæÖF6…7FGW2ÇÂrr’çFôÆ÷vW$66R‚“°¢–b…²vf–æ—6†VBrÂv6Æ÷6VBrÂvG&gBuÒæ–æ6ÇVFW2‡7FGW2’’&WGW&âfÇ6S°¢–b…7G&–ær†f–v‡CòæÖF6…6†F÷t÷Vå7FGW2ÇÂv÷Vâr’çFôÆ÷vW$66R‚’ÓÓÒv6Æ÷6VBr’&WGW&âfÇ6S°¢–b…7G&–ær†f–v‡CòæÖF6…6†F÷u7FGW2ÇÂv7F—fRr’çFôÆ÷vW$66R‚’ÓÓÒv–æ7F—fRr’&WGW&âfÇ6S°¢6öç7BÆö6´BÒf–v‡CòæÆö6´BÇÂf–v‡CòæÖF6„FFS°¢–b†Æö6´BbbæWrFFR†Æö6´B’ævWEF–ÖR‚’ÂFFRææ÷r‚’’&WGW&âfÇ6S°¢&WGW&âG'VS°§Ó° ¢òò6†&VB'’$õD‚F†RæWrVæGö–çBæBF†RÆVv7’õ5Bö’÷66÷&W2Â6òF†W&R—0¢òòW†7FÇ’öæR6öFRF‚F†B6â7&VFR–BVçG'’âFV6Æ&VB2†ö—7FV@¢òògVæ7F–öæ6òF†RöÆFW"&÷WFR&÷fR6â6ÆÂ—Bà¦7–æ2gVæ7F–öâ7&VFTf–v‡DVçG'’‡²W6W$–BÂf–v‡D–BÂ&VF–7F–öç2Â–FV×÷FVæ7”¶W’Ò’°¢–b‚W6W$–B’F‡&÷rf–v‡DVçG'”W'&÷"ƒCÂtWF†VçF–6F–öâ—2&WV—&VBFòVçFW"f–v‡BârÂuTäUD„TåD”4DTBr“°¢–b‚f–v‡D–B’F‡&÷rf–v‡DVçG'”W'&÷"ƒCÂtf–v‡B–B—2&WV—&VBârÂt”ådÄ”Eôd”t…Eô”Br“°¢–b‚'&’æ—4'&’‡&VF–7F–öç2’ÇÂ&VF–7F–öç2æÆVæwF‚’°¢F‡&÷rf–v‡DVçG'”W'&÷"ƒC#"Ât&VF–7F–öç2'&’—2&WV—&VBârÂt”ådÄ”Eõ$TD”5D”ôâr“°¢Ð ¢6öç7B¶W’Ò7G&–ær†–FV×÷FVæ7”¶W’ÇÂf–v‡C¦VçG'“¢G¶f–v‡D–GÓ¢G·W6W$–GÖ’ç6Æ–6RƒÂƒ“° ¢òòf7BFƒ¢Ç&VG’VçFW&VBâæWfW"&RÖ6†&vRÂæWfW"GWÆ–6FRà¢òò&VgVæFVBVçG&–W2&Rfö–FVBÂ6òF†W’×W7BäõB6÷VçB2&Ç&VG’VçFW&VB"(	@¢òò÷F†W'v—6R&VgVæFVBÆ–W"&RÖVçFW&–ærv÷VÆB&RG&VFVB2g&VRVF—Bà¢6öç7BÇ&VG”VçFW&VBÒv—B66÷&Ræf–æDöæR‡²Æ–W$–C¢W6W$–BÂÖF6„–C¢f–v‡D–BÂ&VgVæFVC¢²FæS¢G'VRÒÒ’æÆVâ‚“°¢–b†Ç&VG”VçFW&VB’°¢6öç7BW†—7F–æuW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚wFö¶Vç2r’æÆVâ‚“°¢&WGW&â°¢VçG'“¢Ç&VG”VçFW&VBÀ¢–FV×÷FVçC¢G'VRÀ¢VçG'”fVT6†&vVC¢À¢&Ææ6TgFW#¢f–v‡EFö¶Vä&Ææ6R†W†—7F–æuW6W#òçFö¶Vç2’À¢f–v‡C¢çVÆÂÀ¢Ó°¢Ð ¢6öç7B&W7VÇBÒv—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢ÆWB6÷W&6UG—RÒvÖF6‚s°¢ÆWBf–v‡BÒv—Bv—F„f–v‡E6W76–öâ„ÖF6‚æf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢–b‚f–v‡B’°¢6÷W&6UG—RÒw6†F÷rs°¢f–v‡BÒv—Bv—F„f–v‡E6W76–öâ…6†F÷ræf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢Ð¢–b‚f–v‡B’F‡&÷rf–v‡DVçG'”W'&÷"ƒCBÂtf–v‡Bæ÷Bf÷VæBârÂtd”t…EôäõEôdõTäBr“°¢–b‚—4f–v‡D÷Väf÷$VçG'’†f–v‡B’’°¢F‡&÷rf–v‡DVçG'”W'&÷"ƒC’ÂuF†—2f–v‡B—2æòÆöævW"÷Vâf÷"VçG'’ârÂtd”t…EôÄô4´TBr“°¢Ð ¢òò&RÖ6†V6²–ç6–FRF†RG&ç67F–öâFò6Æ÷6RF†RF÷V&ÆR×7V&Ö—B&6Rà¢6öç7BGWÆ–6FRÒv—Bv—F„f–v‡E6W76–öâ…66÷&Ræf–æDöæR‡²Æ–W$–C¢W6W$–BÂÖF6„–C¢f–v‡D–BÂ&VgVæFVC¢²FæS¢G'VRÒÒ’Â6W76–öâ’æÆVâ‚“°¢–b†GWÆ–6FR’°¢&WGW&â²VçG'“¢GWÆ–6FRÂ–FV×÷FVçC¢G'VRÂVçG'”fVT6†&vVC¢Â6÷W&6UG—RÂf–v‡BÓ°¢Ð ¢òòUD„õ$•DD•dRdTRâFVÆ–&W&FVÇ’–væ÷&W2ç—F†–ærF†R6Æ–VçB6VçBà¢6öç7BVçG'”fVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’“° ¢òò4TÄbÔTåE%’$âââff–Æ–FRÖ’æ÷BVçFW"6öçFW7BF†W’&öÖ÷FRà¢òòVæf÷&6VB6W'fW"×6–FR&V6W6RF†R6Æ–VçB×6–FR6†V6²—2G&—f–ÆÇ’'—76VBÀ¢òòæB&öÖ÷FW"VçFW&–ærF†V—"÷vâ÷B—2g&VBv–ç7BF†V—"÷vâÖVÖ&W'2à¢6öç7B&öÖ÷FW$–G2Ò°¢f–v‡Bæff–Æ–FT–BÀ¢âââ„'&’æ—4'&’†f–v‡Bäff–Æ–FT–G2’òf–v‡Bäff–Æ–FT–G2æÖ‚†’Óâòäff–Æ–FT–B’¢µÒ’À¢Òæf–ÇFW"„&ööÆVâ’æÖ‚‡‚’Óâ7G&–ær‡‚’“°¢–b‡&öÖ÷FW$–G2æ–æ6ÇVFW2…7G&–ær‡W6W$–B’’’°¢F‡&÷rf–v‡DVçG'”W'&÷"ƒC2Âu–÷R&öÖ÷FRF†—26öçFW7BÂ6ò–÷R6ææ÷BVçFW"—BârÂtdd”Ä”DUõ4TÄeôTåE%’r“°¢Ð ¢òòVÆ–v–&–Æ—G’vFR(	B”B6öçFW7G2öæÇ’âg&VRVçG&–W27F’÷Vâ6òæWp¢òòÆ–W"6âG'’F†RvÖR&Vf÷&R7WÇ––ærFFRöb&—'F‚à¢–b†VçG'”fVRâ’°¢6öç7BvFUW6W"Òv—Bv—F„f–v‡E6W76–öâ€¢W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–Âr’Â6W76–öà¢’æÆVâ‚“°¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’†vFUW6W"“°¢–b†&Æö6¶VB’F‡&÷rf–v‡DVçG'”W'&÷"ƒC2Â&Æö6¶VBæÖW76vRÂ&Æö6¶VBæ6öFR“°¢Ð ¢ÆWB&Ææ6T&Vf÷&RÒ°¢ÆWB&Ææ6TgFW"Ò° ¢–b†VçG'”fVRâ’°¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ…W6W"æf–æD'”–B‡W6W$–B’Â6W76–öâ“°¢–b‚W6W"’F‡&÷rf–v‡DVçG'”W'&÷"ƒCBÂuW6W"æ÷Bf÷VæBârÂuU4U%ôäõEôdõTäBr“° ¢&Ææ6T&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢&Ææ6TgFW"Ò&Ææ6T&Vf÷&RÒVçG'”fVS°¢–b†&Ææ6TgFW"Â’°¢F‡&÷rf–v‡DVçG'”W'&÷"ƒC"Âtæ÷BVæ÷Vv‚dÒ6ö–ç2FòVçFW"F†—2f–v‡BârÂt”å5Tdd”4”TåEôeTäE2rÂ°¢&Ææ6S¢&Ææ6T&Vf÷&RÀ¢VçG'”fVRÀ¢6†÷'FfÆÃ¢VçG'”fVRÒ&Ææ6T&Vf÷&RÀ¢Ò“°¢Ð ¢W6W"çFö¶Vç2Ò7G&–ær†&Ææ6TgFW"“°¢v—BW6W"ç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢òò&V6÷&FVBW"f–v‡B6ò6WGFÆVÖVçB6â6†÷rFV6Æ&VB&—¦Rg2fVW2F¶Vâ(	@¢òòF†RçVÖ&W"F†Bw&÷w2v—F‚VçG&çG2à¢f–v‡Bæ6öÆÆV7FVDfVW2ÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bæ6öÆÆV7FVDfVW2’ÇÂ’²VçG'”fVS°¢v—Bf–v‡Bç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–BÀ¢ÖF6„–C¢f–v‡D–BÀ¢6÷W&6UG—RÀ¢G—S¢td”t…EôTåE%’rÀ¢Ö÷VçC¢ÖVçG'”fVRÀ¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W“¢f–v‡C¦ÆVFvW#¢G¶¶W—ÖÀ¢ÖWFFF¢²6FVv÷'“¢f–v‡BæÖF6„6FVv÷'’ÇÂçVÆÂÒÀ¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“°¢ÒVÇ6R°¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ…W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚wFö¶Vç2r’Â6W76–öâ’æÆVâ‚“°¢&Ææ6T&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W#òçFö¶Vç2“°¢&Ææ6TgFW"Ò&Ææ6T&Vf÷&S°¢Ð ¢6öç7B66÷&TFö72Òv—B66÷&Ræ7&VFR…·°¢Æ–W$–C¢W6W$–BÀ¢ÖF6„–C¢f–v‡D–BÀ¢&VF–7F–öç2À¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“°¢6öç7BVçG'’Ò66÷&TFö75³Ó° ¢–b‚'&’æ—4'&’†f–v‡BçW6W%&VF–7F–öç2’’f–v‡BçW6W%&VF–7F–öç2ÒµÓ°¢6öç7BW†—7F–ætÖ&¶W"Òf–v‡BçW6W%&VF–7F–öç2æf–æB‚†—FVÒ’Óâ7G&–ær†—FVÓòçW6W$–B’ÓÓÒ7G&–ær‡W6W$–B’“°¢–b†W†—7F–ætÖ&¶W"’W†—7F–ætÖ&¶W"ç&VF–7F–öå7FGW2Òw7V&Ö—GFVBs°¢VÇ6Rf–v‡BçW6W%&VF–7F–öç2çW6‚‡²W6W$–BÂ&VF–7F–öå7FGW3¢w7V&Ö—GFVBrÒ“° ¢f–v‡Bç÷BÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷B’ÇÂ’²VçG'”fVS° ¢òò6†F÷rf–v‡B&öf—B¦öæS¢F†R&öÖ÷FW"7F¶W2÷BWg&öçBæBöæÇ¢òò7F'G2V&æ–æröæ6RVçG&–W2†fR6÷fW&VB—BâfÆ—F†RfÆrF†Rf—'7BF–ÖP¢òòF†R÷B6ÆV'2F†RF&vWB6òF†Rff–Æ–FRF6†&ö&B6â6†÷r—BÆ—fRà¢6öç7B÷EF&vWBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷EF&vWB’ÇÂ“°¢–b‡÷EF&vWBâbbf–v‡Bç&öf—E¦öæU&V6†VDBbbçVÖ&W"†f–v‡Bç÷B’ãÒ÷EF&vWB’°¢f–v‡Bç&öf—E¦öæU&V6†VDBÒæWrFFR‚“°¢Ð ¢v—Bf–v‡Bç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢&WGW&â²VçG'’ÂVçG'”fVT6†&vVC¢VçG'”fVRÂ&Ææ6T&Vf÷&RÂ&Ææ6TgFW"Â6÷W&6UG—RÂf–v‡BÓ°¢Ò“° ¢6ÆV%V&Æ–5&W7öç6T66†R‚“° ¢–b‚&W7VÇBæ–FV×÷FVçBbb&W7VÇBæf–v‡B’°¢W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–Âr’æÆVâ‚¢çF†Vâ‚†VçG&çB’Óâ°¢–b‚VçG&çCòæVÖ–Â’&WGW&ã°¢6öç7BfVRÒçVÖ&W"‡&W7VÇBæVçG'”fVT6†&vVBÇÂ“°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢VçG&çBæVÖ–ÂÀ¢7V&¦V7C¢u–÷W"&VF–7F–öç2&RÆö6¶VB–ârÀ¢†VF–æs¢u”õR$R”ârÀ¢Æ–æW3¢°¢–÷W"6&Bf÷"Ç7G&öæsâG²‡&W7VÇBæf–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"r—Òg2G²‡&W7VÇBæf–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""r—ÓÂ÷7G&öæsâ†2&VVâ7V&Ö—GFVBæÀ¢fVRâ ¢òVçG'’fVS¢Ç7G&öæsâG¶fVRçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsââæWr&Ææ6S¢Ç7G&öæsâG´çVÖ&W"‡&W7VÇBæ&Ææ6TgFW"ÇÂ’çFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâæ ¢¢uF†—2v2g&VRVçG'’(	Bæò6ö–ç2vW&R6†&vVBârÀ¢u–÷R6âVF—B–÷W"–6·2&–v‡BWVçF–ÂF†Rf–v‡BÆö6·2ârÀ¢ÒÀ¢Ò“°¢Ò¢æ6F6‚‚‚’Óâ·Ò“°¢Ð ¢&WGW&â&W7VÇC°§Ð ¦ç÷7B‚rö’öf–v‡G2ó¦f–v‡D–BöVçG&–W2rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B7&VFTf–v‡DVçG'’‡°¢W6W$–C¢7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚’À¢f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’À¢&VF–7F–öç3¢&Wæ&öG“òç&VF–7F–öç2À¢–FV×÷FVæ7”¶W“¢&Wæ†VFW'5²v–FV×÷FVæ7’Ö¶W’uÒÇÂ&Wæ&öG“òæ–FV×÷FVæ7”¶W’À¢Ò“° ¢–b‡&W7VÇBæ–FV×÷FVçB’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢VçG'”–C¢&W7VÇBæVçG'’åö–BÀ¢–FV×÷FVçC¢G'VRÀ¢Ç&VG”VçFW&VC¢G'VRÀ¢VçG'”fVT6†&vVC¢À¢vÆÆWD&Ææ6S¢&W7VÇBæ&Ææ6TgFW"À¢ÖW76vS¢u–÷R†fRÇ&VG’VçFW&VBF†—2f–v‡BârÀ¢Ò“°¢Ð ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢VçG'”–C¢&W7VÇBæVçG'’åö–BÀ¢VçG'”fVT6†&vVC¢&W7VÇBæVçG'”fVT6†&vVBÀ¢vÆÆWD&Ææ6S¢&W7VÇBæ&Ææ6TgFW"À¢÷EF÷FÃ¢ÖF‚æÖ‚ƒÂçVÖ&W"‡&W7VÇBæf–v‡Còç÷B’ÇÂ’À¢Æ–W$6÷VçC¢'&’æ—4'&’‡&W7VÇBæf–v‡CòçW6W%&VF–7F–öç2¢ò&W7VÇBæf–v‡BçW6W%&VF–7F–öç2æf–ÇFW"‚†—FVÒ’Óâ7G&–ær†—FVÓòç&VF–7F–öå7FGW2’ÓÓÒw7V&Ö—GFVBr’æÆVæwF€¢¢À¢&VF–7F–öå7FGW3¢w7V&Ö—GFVBrÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢–b†W'&÷#òæ6öFRÓÓÒ’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²–FV×÷FVçC¢G'VRÂÖW76vS¢uF†—2VçG'’v2Ç&VG’&ö6W76VBârÒ“°¢Ð¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚tf–v‡BVçG'’f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B6ö×ÆWFR–÷W"f–v‡BVçG'’ârÀ¢6öFS¢W'&÷#òæ6öFRÇÂtTåE%•ôd”ÄTBrÀ¢âââ†W'&÷#òæW‡G&ÇÂ·Ò’À¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò$TeTäE2(	BW6VBv†Vâf–v‡B—26æ6VÆÆVBÂ÷"Fò6WGFÆR6–ævÆRF—7WFRà¢òð¢òòF†R&VgVæBÖ÷VçB6öÖW2g&öÒF†RÄTDtU"Âæ÷Bg&öÒf–v‡BæÖF6…Fö¶Vç2âF†RfVP¢òò6â&RVF—FVBgFW"Æ–W'2VçFW"Â6òF†RÆVFvW"—2F†RöæÇ’&V6÷&Böbv†@¢òòV6‚Æ–W"v27GVÆÇ’6†&vVBâ&VgVæF–ærF†R7W'&VçBfVRv÷VÆBv—fR6öÖP¢òòÆ–W'2Föò×V6‚æB÷F†W'2FöòÆ—GFÆRà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦7–æ2gVæ7F–öâ&VgVæDf–v‡DVçG&–W2‡²f–v‡D–BÂW6W$–BÒçVÆÂÂ&V6öâÒtf–v‡B6æ6VÆÆVBrÂFÖ–ä–BÒçVÆÂÒ’°¢–b‚f–v‡D–B’F‡&÷rf–v‡DVçG'”W'&÷"ƒCÂtf–v‡B–B—2&WV—&VBârÂt”ådÄ”Eôd”t…Eô”Br“° ¢&WGW&â'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢ÆWB6÷W&6UG—RÒvÖF6‚s°¢ÆWBf–v‡BÒv—Bv—F„f–v‡E6W76–öâ„ÖF6‚æf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢–b‚f–v‡B’°¢6÷W&6UG—RÒw6†F÷rs°¢f–v‡BÒv—Bv—F„f–v‡E6W76–öâ…6†F÷ræf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢Ð¢–b‚f–v‡B’F‡&÷rf–v‡DVçG'”W'&÷"ƒCBÂtf–v‡Bæ÷Bf÷VæBârÂtd”t…EôäõEôdõTäBr“° ¢6öç7B66÷&Tf–ÇFW"Ò²ÖF6„–C¢7G&–ær†f–v‡D–B’Â&VgVæFVC¢²FæS¢G'VRÒÓ°¢–b‡W6W$–B’66÷&Tf–ÇFW"çÆ–W$–BÒ7G&–ær‡W6W$–B“° ¢6öç7BVçG&–W2Òv—Bv—F„f–v‡E6W76–öâ…66÷&Ræf–æB‡66÷&Tf–ÇFW"’Â6W76–öâ“°¢–b‚VçG&–W2æÆVæwF‚’°¢&WGW&â²&VgVæFVD6÷VçC¢ÂF÷FÅ&VgVæFVC¢ÂÇ&VG•6WGFÆVC¢G'VRÂ6÷W&6UG—RÂf–v‡BÓ°¢Ð ¢ÆWBF÷FÅ&VgVæFVBÒ°¢6öç7B&VgVæG2ÒµÓ° ¢f÷"†6öç7BVçG'’öbVçG&–W2’°¢6öç7B–FV×÷FVæ7”¶W’Òf–v‡C§&VgVæC¢G¶f–v‡D–GÓ¢G¶VçG'’çÆ–W$–GÖ° ¢òòÇ&VG’&VgVæFVB–â&Wf–÷W2'Vâ(	B6¶—ÂæWfW"’Gv–6Rà¢6öç7BW†—7F–æu&VgVæBÒv—Bv—F„f–v‡E6W76–öâ€¢f–v‡DVçG'”ÆVFvW"æf–æDöæR‡²–FV×÷FVæ7”¶W’Ò’Â6W76–öà¢’æÆVâ‚“° ¢–b‚W†—7F–æu&VgVæB’°¢òòv†BvW&RF†W’7GVÆÇ’6†&vVCò&VBF†R÷&–v–æÂFV&—Bà¢6öç7B÷&–v–æÄFV&—BÒv—Bv—F„f–v‡E6W76–öâ€¢f–v‡DVçG'”ÆVFvW"æf–æDöæR‡°¢ÖF6„–C¢7G&–ær†f–v‡D–B’À¢W6W$–C¢VçG'’çÆ–W$–BÀ¢G—S¢td”t…EôTåE%’rÀ¢Ò’Â6W76–öà¢’æÆVâ‚“° ¢òòæòFV&—B&÷rÖVç2F†RVçG'’&VFFW2F†R6†&v–ærf—‚†—Bv2g&VR’À¢òò6òF†W&R—2æ÷F†–ærFòv—fR&6²à¢6öç7B&VgVæDÖ÷VçBÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„ÖF‚æ'2„çVÖ&W"†÷&–v–æÄFV&—CòæÖ÷VçB’ÇÂ’’“° ¢–b‡&VgVæDÖ÷VçBâ’°¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ…W6W"æf–æD'”–B†VçG'’çÆ–W$–B’Â6W76–öâ“°¢–b‡W6W"’°¢6öç7B&Ææ6T&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢6öç7B&Ææ6TgFW"Ò&Ææ6T&Vf÷&R²&VgVæDÖ÷VçC°¢W6W"çFö¶Vç2Ò7G&–ær†&Ææ6TgFW"“°¢v—BW6W"ç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–C¢VçG'’çÆ–W$–BÀ¢ÖF6„–C¢7G&–ær†f–v‡D–B’À¢6÷W&6UG—RÀ¢G—S¢td”t…EôTåE%•õ$TeTäBrÀ¢Ö÷VçC¢&VgVæDÖ÷VçBÀ¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W’À¢ÖWFFF¢²&V6öâÂFÖ–ä–BÂ÷&–v–æÄÆVFvW$–C¢÷&–v–æÄFV&—Còåö–BÇÂçVÆÂÒÀ¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢F÷FÅ&VgVæFVB³Ò&VgVæDÖ÷VçC°¢&VgVæG2çW6‚‡²W6W$–C¢VçG'’çÆ–W$–BÂÖ÷VçC¢&VgVæDÖ÷VçBÂ&Ææ6TgFW"ÂVÖ–Ã¢W6W"æVÖ–ÂÒ“°¢ÒVÇ6R°¢6öç6öÆRçv&â†&VgVæB6¶—VC¢W6W"G¶VçG'’çÆ–W$–GÒæ÷Bf÷VæBf÷"f–v‡BG¶f–v‡D–GÒæ“°¢Ð¢ÒVÇ6R°¢&VgVæG2çW6‚‡²W6W$–C¢VçG'’çÆ–W$–BÂÖ÷VçC¢Âæ÷FS¢væò6†&vRöâ&V6÷&BrÒ“°¢Ð¢Ð ¢VçG'’ç&VgVæFVBÒG'VS°¢VçG'’ç&VgVæFVDBÒæWrFFR‚“°¢VçG'’ç&VgVæE&V6öâÒ&V6öã°¢v—BVçG'’ç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢òòfö–BF†RVçG'’Ö&¶W"6òF†RÆ–W"æòÆöævW"6÷VçG22VçFW&VBà¢–b„'&’æ—4'&’†f–v‡BçW6W%&VF–7F–öç2’’°¢6öç7BÖ&¶W"Òf–v‡BçW6W%&VF–7F–öç2æf–æB‚†—FVÒ’Óâ7G&–ær†—FVÓòçW6W$–B’ÓÓÒ7G&–ær†VçG'’çÆ–W$–B’“°¢–b†Ö&¶W"’Ö&¶W"ç&VF–7F–öå7FGW2Òvæ÷E7V&Ö—GFVBs°¢Ð¢Ð ¢òòF¶RF†R&VgVæFVBÖöæW’&6²÷WBöbF†R÷Bà¢f–v‡Bç÷BÒÖF‚æÖ‚ƒÂ„ÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷B’ÇÂ’’ÒF÷FÅ&VgVæFVB“°¢v—Bf–v‡Bç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢òòVWVVBf÷"gFW"6öÖÖ—B(	BÖ–Âf–ÇW&R×W7BæWfW"&öÆÂ&6²&VgVæBà¢&ö6W72ææW‡EF–6²‚‚’Óâ°¢&VgVæG2æf–ÇFW"‚‡"’Óâ"æÖ÷VçBâbb"æVÖ–Â’æf÷$V6‚‚‡"’Óâ°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢"æVÖ–ÂÀ¢7V&¦V7C¢u–÷W"VçG'’fVR†2&VVâ&VgVæFVBrÀ¢†VF–æs¢u$TeTäB•55TTBrÀ¢Æ–æW3¢°¢–÷W"VçG'’f÷"Ç7G&öæsâG²†f–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"r—Òg2G²†f–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""r—ÓÂ÷7G&öæsâ†2&VVâ&VgVæFVBæÀ¢Ç7G&öæsâG·"æÖ÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ—2&6²–â–÷W"vÆÆWBæÀ¢&V6öã¢G·&V6öçÖÀ¢ÒÀ¢Ò“°¢Ò“°¢Ò“° ¢&WGW&â²&VgVæFVD6÷VçC¢&VgVæG2æÆVæwF‚ÂF÷FÅ&VgVæFVBÂ&VgVæG2Â6÷W&6UG—RÂf–v‡BÓ°¢Ò“°§Ð ¢òò&VgVæBWfW'’Vç&VgVæFVBVçG'’öâf–v‡B†6æ6VÆÆF–öâ’à¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷&VgVæBrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&VgVæDf–v‡DVçG&–W2‡°¢f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’À¢&V6öã¢7G&–ær‡&Wæ&öG“òç&V6öâÇÂtf–v‡B6æ6VÆÆVBr’ç6Æ–6RƒÂ3’À¢FÖ–ä–C¢&WæFÖ–ãòæ–BÇÂçVÆÂÀ¢Ò“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢&W7VÇBæÇ&VG•6WGFÆV@¢òtæò÷WG7FæF–ærVçG&–W2Fò&VgVæBâp¢¢&VgVæFVBG·&W7VÇBç&VgVæFVD6÷VçGÒVçG"G·&W7VÇBç&VgVæFVD6÷VçBÓÓÒòw’r¢v–W2wÒæÀ¢ââç&W7VÇBÀ¢f–v‡C¢VæFVf–æVBÀ¢÷EF÷FÃ¢ÖF‚æÖ‚ƒÂçVÖ&W"‡&W7VÇBæf–v‡Còç÷B’ÇÂ’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚tf–v‡B&VgVæBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B&VgVæBF†—2f–v‡BârÀ¢6öFS¢W'&÷#òæ6öFRÇÂu$TeTäEôd”ÄTBrÀ¢Ò“°¢Ð§Ò“° ¢òò&VgVæBöæRÆ–W"w2VçG'’†F—7WFRÂ÷"&VÖ÷f–ær6–ævÆRÆ–W"’à¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷&VgVæBó§W6W$–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&VgVæDf–v‡DVçG&–W2‡°¢f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’À¢W6W$–C¢7G&–ær‡&Wç&×2çW6W$–BÇÂrr’çG&–Ò‚’À¢&V6öã¢7G&–ær‡&Wæ&öG“òç&V6öâÇÂtVçG'’&VgVæFVB'’FÖ–âr’ç6Æ–6RƒÂ3’À¢FÖ–ä–C¢&WæFÖ–ãòæ–BÇÂçVÆÂÀ¢Ò“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢&W7VÇBæÇ&VG•6WGFÆV@¢òuF†BVçG'’v2Ç&VG’&VgVæFVB÷"FöW2æ÷BW†—7Bâp¢¢tVçG'’&VgVæFVBârÀ¢ââç&W7VÇBÀ¢f–v‡C¢VæFVf–æVBÀ¢÷EF÷FÃ¢ÖF‚æÖ‚ƒÂçVÖ&W"‡&W7VÇBæf–v‡Còç÷B’ÇÂ’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚u6–ævÆRf–v‡B&VgVæBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B&VgVæBF†—2VçG'’ârÀ¢6öFS¢W'&÷#òæ6öFRÇÂu$TeTäEôd”ÄTBrÀ¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòdd”Ä”DR”õUBDÔ”ä•5E$D”ôà¢òð¢òò–÷WB&WVW7BDT$•E2F†Rff–Æ–FRw2&Ææ6R–ÖÖVF–FVÇ’‡6òF†R6ÖP¢òòV&æ–æw26ææ÷B&R6Æ–ÖVBGv–6Rv†–ÆR&WVW7B—2÷WG7FæF–ær’âF†BÖ¶W0¢òò&V¦V7Bö6æ6VÂF‚ÖæFF÷'“¢v—F†÷WB—BÂFV6Æ–æVB–÷WB6–ÆVçFÇ¢òòFW7G&÷—2F†Rff–Æ–FRw2&Ææ6Rà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ ¢òòWfW'’VæF–ær&WVW7B7&÷72ÆÂff–Æ–FW2(	BF†RFÖ–âv÷&²VWVRà¦ævWB‚rö’öFÖ–âöff–Æ–FR×–÷WG2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7FGW2Ò7G&–ær‡&WçVW'’ç7FGW2ÇÂwVæF–ærr’çFôÆ÷vW$66R‚“°¢6öç7Bff–Æ–FW2Òv—Bff–Æ–FRæf–æB‡²w–÷WG2ãs¢²FW†—7G3¢G'VRÒÒ¢ç6VÆV7B‚uö–Bf—'7DæÖRÆ7DæÖRÆ–W$æÖRVÖ–ÂFö¶Vç2–÷WG2&VfW'&VE–ÖVçDÖWF†öBr¢æÆVâ‚“° ¢6öç7B&÷w2ÒµÓ°¢ff–Æ–FW2æf÷$V6‚‚†ff–Æ–FR’Óâ°¢†ff–Æ–FRç–÷WG2ÇÂµÒ’æf÷$V6‚‚‡–÷WBÂ–æFW‚’Óâ°¢6öç7B–÷WE7FGW2Ò7G&–ær‡–÷WCòç7FGW2ÇÂwVæF–ærr’çFôÆ÷vW$66R‚“°¢–b‡7FGW2ÓÒvÆÂrbb–÷WE7FGW2ÓÒ7FGW2’&WGW&ã°¢&÷w2çW6‚‡°¢ff–Æ–FT–C¢ff–Æ–FRåö–BÀ¢–÷WD–æFWƒ¢–æFW‚À¢–÷WD–C¢–÷WCòåö–BÇÂçVÆÂÀ¢æÖS¢ff–Æ–FRçÆ–W$æÖRÇÂ¶ff–Æ–FRæf—'7DæÖRÂff–Æ–FRæÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’À¢VÖ–Ã¢ff–Æ–FRæVÖ–ÂÀ¢&VfW'&VE–ÖVçDÖWF†öC¢ff–Æ–FRç&VfW'&VE–ÖVçDÖWF†öBÇÂçVÆÂÀ¢7W'&VçD&Ææ6S¢çVÖ&W"ç'6T–çB…7G&–ær†ff–Æ–FRçFö¶Vç2ÇÂsr’Â’ÇÂÀ¢Ö÷VçC¢çVÖ&W"‡–÷WCòæÖ÷VçB’ÇÂÀ¢7FGW3¢–÷WE7FGW2À¢7&VFVDC¢–÷WCòæ7&VFVDBÇÂçVÆÂÀ¢Ò“°¢Ò“°¢Ò“° ¢&÷w2ç6÷'B‚†Â"’ÓâæWrFFR†"æ7&VFVDBÇÂ’ÒæWrFFR†æ7&VFVDBÇÂ’“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6÷VçC¢&÷w2æÆVæwF‚Â–÷WG3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tÆ—7F–ærff–Æ–FR–÷WG2f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöB–÷WB&WVW7G2ârÒ“°¢Ð§Ò“° ¢òòWfW'’f–v‡Bâff–Æ–FR†27&VFVBÂÆ—fR÷"æ÷B(	BF†RFÖ–âw2÷vâf–Wr–çFð¢òòff–Æ–FR×'Vâ6&G2â7F¶–ærwV&çFVVB÷B—2÷F–öæÂ‡&öÖ÷FW%7F¶Râ“°¢òòÖ÷7Bff–Æ–FRf–v‡G2'V–ÆBF†V—"÷BW&VÇ’g&öÒVçG&–W2à¦ævWB‚rö’öFÖ–âöff–Æ–FRÖf–v‡G2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FTf–ÇFW"Ò²F÷#¢·²ff–Æ–FT–C¢²FW†—7G3¢G'VRÂFæS¢rrÒÒÂ²tff–Æ–FT–G2ãs¢²FW†—7G3¢G'VRÒÕÒÓ°¢6öç7Bf–VÆG2ÒvÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„6FVv÷'’ÖF6„6FVv÷'•GvòÖF6…7FGW2ÖF6„FFRÖF6…Fö¶Vç2÷B÷EF&vWB&öÖ÷FW%7F¶R&öf—E¦öæU&V6†VDBff–Æ–FT–Bff–Æ–FT–G2f–v‡FW$–Bf–v‡FW$$–Bs°¢6öç7B¶ÖF6†W2Â6†F÷w2Âff–Æ–FW5ÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æf–æB†ff–Æ–FTf–ÇFW"’ç6VÆV7B†f–VÆG2’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’æÆVâ‚’À¢6†F÷ræf–æB†ff–Æ–FTf–ÇFW"’ç6VÆV7B†f–VÆG2’ç÷VÆFR‚vf–v‡FW$–Bf–v‡FW$$–Br’æÆVâ‚’À¢ff–Æ–FRæf–æB‚’ç6VÆV7B‚uö–Bf—'7DæÖRÆ7DæÖRÆ–W$æÖRVÖ–ÂfW&–f–VBr’æÆVâ‚’À¢Ò“°¢6öç7Bff–Æ–FT'”–BÒæWrÖ†ff–Æ–FW2æÖ‚†ff–Æ–FR’Óâµ7G&–ær†ff–Æ–FRåö–B’Âff–Æ–FUÒ’“°¢6öç7B&÷w4f÷"Ò†Fö72Â6÷W&6UG—R’ÓâFö72æÖ‚†f–v‡B’Óâ°¢6öç7B—FVÒÒGF6„6öÖ&Df–v‡FW%&VDfÆÆ&6·2†f–v‡BÂ6÷W&6UG—R“°¢6öç7B÷væW$–G2Ò°¢—FVÒæff–Æ–FT–BÀ¢âââ„'&’æ—4'&’†—FVÒäff–Æ–FT–G2’ò—FVÒäff–Æ–FT–G2æÖ‚†VçG'’’ÓâVçG'“òäff–Æ–FT–B’¢µÒ’À¢Òæf–ÇFW"„&ööÆVâ’æÖ…7G&–ær“°¢6öç7B÷væW"Ò÷væW$–G2æÖ‚†–B’Óâff–Æ–FT'”–BævWB†–B’’æf–æB„&ööÆVâ’ÇÂçVÆÃ°¢6öç7B7F¶RÒÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒç&öÖ÷FW%7F¶R’ÇÂ“°¢6öç7B÷EF&vWBÒÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒç÷EF&vWB’ÇÂ“°¢&WGW&â°¢ö–C¢—FVÒåö–BÀ¢6÷W&6UG—RÀ¢ÖF6„æÖS¢—FVÒæÖF6„æÖRÇÂG¶—FVÒæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶—FVÒæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÖÀ¢ÖF6„f–v‡FW$¢—FVÒæÖF6„f–v‡FW$À¢ÖF6„f–v‡FW$#¢—FVÒæÖF6„f–v‡FW$"À¢ÖF6„6FVv÷'“¢—FVÒæÖF6„6FVv÷'•GvòÇÂ—FVÒæÖF6„6FVv÷'’À¢ÖF6…7FGW3¢—FVÒæÖF6…7FGW2À¢ÖF6„FFS¢—FVÒæÖF6„FFRÀ¢VçG'”fVS¢ÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒæÖF6…Fö¶Vç2’ÇÂ’À¢÷C¢ÖF‚æÖ‚ƒÂçVÖ&W"†—FVÒç÷B’ÇÂ’À¢÷EF&vWBÀ¢&öÖ÷FW%7F¶S¢7F¶RÀ¢wV&çFVVC¢7F¶RâÀ¢&öf—E¦öæU&V6†VC¢&ööÆVâ†—FVÒç&öf—E¦öæU&V6†VDB’À¢ff–Æ–FT–C¢÷væW"ò7G&–ær†÷væW"åö–B’¢†÷væW$–G5³ÒÇÂçVÆÂ’À¢ff–Æ–FTæÖS¢÷væW"ò†÷væW"çÆ–W$æÖRÇÂ¶÷væW"æf—'7DæÖRÂ÷væW"æÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’’¢uVæ¶æ÷vâff–Æ–FRrÀ¢ff–Æ–FTVÖ–Ã¢÷væW#òæVÖ–ÂÇÂrrÀ¢ff–Æ–FUfW&–f–VC¢&ööÆVâ†÷væW#òçfW&–f–VB’À¢Ó°¢Ò“°¢6öç7B&÷w2Ò²ââç&÷w4f÷"†ÖF6†W2ÂvÖF6‚r’Âââç&÷w4f÷"‡6†F÷w2Âw6†F÷rr•Ð¢ç6÷'B‚†Â"’ÓâæWrFFR†"æÖF6„FFRÇÂ’ÒæWrFFR†æÖF6„FFRÇÂ’“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6÷VçC¢&÷w2æÆVæwF‚Âf–v‡G3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tÆ—7F–ærff–Æ–FRf–v‡G2f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöBff–Æ–FRf–v‡G2ârÒ“°¢Ð§Ò“° ¦6öç7B&W6öÇfTff–Æ–FU–÷WBÒ7–æ2‡²ff–Æ–FT–BÂ–÷WD–æFW‚ÂæW‡E7FGW2Â&V6öâÂFÖ–ä–BÂ7&VF—D&6²Ò’Óâ°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B“°¢–b‚ff–Æ–FR’F‡&÷rf–v‡DVçG'”W'&÷"ƒCBÂtff–Æ–FRæ÷Bf÷VæBârÂtdd”Ä”DUôäõEôdõTäBr“° ¢6öç7B–÷WBÒ'&’æ—4'&’†ff–Æ–FRç–÷WG2’òff–Æ–FRç–÷WG5·–÷WD–æFW…Ò¢çVÆÃ°¢–b‚–÷WB’F‡&÷rf–v‡DVçG'”W'&÷"ƒCBÂu–÷WB&WVW7Bæ÷Bf÷VæBârÂu”õUEôäõEôdõTäBr“° ¢6öç7B7W'&VçE7FGW2Ò7G&–ær‡–÷WBç7FGW2ÇÂwVæF–ærr’çFôÆ÷vW$66R‚“°¢–b†7W'&VçE7FGW2ÓÒwVæF–ærr’°¢òò–FV×÷FVçC¢&R×'Vææ–ær6ö×ÆWFVB7F–öâ×W7Bæ÷BÖ÷fRÖöæW’v–âà¢&WGW&â²ff–Æ–FRÂ–÷WBÂÇ&VG•&W6öÇfVC¢G'VRÂ7FGW3¢7W'&VçE7FGW2Ó°¢Ð ¢6öç7BÖ÷VçBÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡–÷WBæÖ÷VçB’ÇÂ’“° ¢–b†7&VF—D&6²bbÖ÷VçBâ’°¢6öç7B&Ææ6RÒçVÖ&W"ç'6T–çB…7G&–ær†ff–Æ–FRçFö¶Vç2ÇÂsr’Â’ÇÂ°¢ff–Æ–FRçFö¶Vç2Ò7G&–ær†&Ææ6R²Ö÷VçB“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢ff–Æ–FRåö–BÀ¢Ö÷VçBÀ¢&Ææ6T&Vf÷&S¢&Ææ6RÀ¢&Ææ6TgFW#¢&Ææ6R²Ö÷VçBÀ¢&V6öã¢w–÷WE÷&V¦V7FVEö7&VF—Eö&6²rÀ¢&VfW&Væ6S¢7G&–ær‡–÷WD–æFW‚’À¢Ò“°¢Ð ¢–÷WBç7FGW2ÒæW‡E7FGW3°¢–÷WBç&W6öÇfVDBÒæWrFFR‚“°¢–b‡&V6öâ’–÷WBç&V6öâÒ&V6öã°¢–b†FÖ–ä–B’–÷WBç&W6öÇfVD'’Ò7G&–ær†FÖ–ä–B“° ¢v—Bff–Æ–FRç6fR‚“° ¢6öç7B–BÒæW‡E7FGW2ÓÓÒw–Bs°¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢ff–Æ–FRæVÖ–ÂÀ¢7V&¦V7C¢–Bòu–÷W"–÷WB†2&VVâ6VçBr¢u–÷W"–÷WB&WVW7Bv2FV6Æ–æVBrÀ¢†VF–æs¢–Bòu”õUB4TåBr¢u”õUBDT4Ä”äTBrÀ¢Æ–æW3¢–@¢ò°¢–÷W"–÷WBöbÇ7G&öæsâG¶Ö÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâ&ö6W76VBæÀ¢&V6öâò&VfW&Væ6S¢G·&V6öçÖ¢t—B6†÷VÆB'&—fRf––÷W"&VfW'&VB–ÖVçBÖWF†öB6†÷'FÇ’ârÀ¢Ð¢¢°¢–÷W"–÷WB&WVW7Bf÷"Ç7G&öæsâG¶Ö÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâv2æ÷B&÷fVBæÀ¢Ç7G&öæsâG¶Ö÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâ&WGW&æVBFò–÷W"&Ææ6RÂ6òæ÷F†–ærv2Æ÷7BæÀ¢&V6öã¢G·&V6öçÖÀ¢ÒÀ¢Ò“° ¢&WGW&â²ff–Æ–FRÂ–÷WBÂÇ&VG•&W6öÇfVC¢fÇ6RÂ7&VF—FVD&6³¢&ööÆVâ†7&VF—D&6²’bbÖ÷VçBâÂÖ÷VçBÓ°§Ó° ¢òò&÷fR(	BF†RÖöæW’v27GVÆÇ’6VçBâ&Ææ6R7F—2FV&—FVBà¦ç÷7B‚rö’öFÖ–âöff–Æ–FR×–÷WG2ó¦ff–Æ–FT–Bó§–÷WD–æFW‚ö&÷fRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&W6öÇfTff–Æ–FU–÷WB‡°¢ff–Æ–FT–C¢7G&–ær‡&Wç&×2æff–Æ–FT–BÇÂrr’çG&–Ò‚’À¢–÷WD–æFWƒ¢çVÖ&W"ç'6T–çB‡&Wç&×2ç–÷WD–æFW‚Â’À¢æW‡E7FGW3¢w–BrÀ¢&V6öã¢7G&–ær‡&Wæ&öG“òç&VfW&Væ6RÇÂ&Wæ&öG“òç&V6öâÇÂrr’ç6Æ–6RƒÂ3’À¢FÖ–ä–C¢&WæFÖ–ãòæ–BÇÂçVÆÂÀ¢7&VF—D&6³¢fÇ6RÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢&W7VÇBæÇ&VG•&W6öÇfVBòuF†B–÷WBv2Ç&VG’&W6öÇfVBâr¢u–÷WBÖ&¶VB2–BârÀ¢Ç&VG•&W6öÇfVC¢&W7VÇBæÇ&VG•&W6öÇfVBÀ¢7FGW3¢&W7VÇBç–÷WBç7FGW2À¢&Ææ6S¢çVÖ&W"ç'6T–çB…7G&–ær‡&W7VÇBæff–Æ–FRçFö¶Vç2ÇÂsr’Â’ÇÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚t&÷f–ær–÷WBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡²ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B&÷fR–÷WBârÂ6öFS¢W'&÷#òæ6öFRÇÂt$õdUôd”ÄTBrÒ“°¢Ð§Ò“° ¢òò&V¦V7Bò6æ6VÂ(	B5$TD•E2D„RÔõTåB$4²âv—F†÷WBF†—2F†Rff–Æ–FR6–×Ç¢òòÆ÷6W2F†R&Ææ6RF†Bv2FV&—FVBv†VâF†W’&WVW7FVB—Bà¦ç÷7B‚rö’öFÖ–âöff–Æ–FR×–÷WG2ó¦ff–Æ–FT–Bó§–÷WD–æFW‚÷&V¦V7BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&W6öÇfTff–Æ–FU–÷WB‡°¢ff–Æ–FT–C¢7G&–ær‡&Wç&×2æff–Æ–FT–BÇÂrr’çG&–Ò‚’À¢–÷WD–æFWƒ¢çVÖ&W"ç'6T–çB‡&Wç&×2ç–÷WD–æFW‚Â’À¢æW‡E7FGW3¢w&V¦V7FVBrÀ¢&V6öã¢7G&–ær‡&Wæ&öG“òç&V6öâÇÂu–÷WB&WVW7BFV6Æ–æVBâr’ç6Æ–6RƒÂ3’À¢FÖ–ä–C¢&WæFÖ–ãòæ–BÇÂçVÆÂÀ¢7&VF—D&6³¢G'VRÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢&W7VÇBæÇ&VG•&W6öÇfV@¢òuF†B–÷WBv2Ç&VG’&W6öÇfVB(	Bæ÷F†–ærv27&VF—FVBâp¢¢–÷WB&V¦V7FVBæBG·&W7VÇBæÖ÷VçGÒdÒ&WGW&æVBFòF†Rff–Æ–FRæÀ¢Ç&VG•&W6öÇfVC¢&W7VÇBæÇ&VG•&W6öÇfVBÀ¢7&VF—FVD&6³¢&W7VÇBæ7&VF—FVD&6²ÇÂfÇ6RÀ¢7FGW3¢&W7VÇBç–÷WBç7FGW2À¢&Ææ6S¢çVÖ&W"ç'6T–çB…7G&–ær‡&W7VÇBæff–Æ–FRçFö¶Vç2ÇÂsr’Â’ÇÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚u&V¦V7F–ær–÷WBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡²ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B&V¦V7B–÷WBârÂ6öFS¢W'&÷#òæ6öFRÇÂu$T¤T5Eôd”ÄTBrÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòdTEU$Rt•DÄ•5@¢òò†VB×FòÔ†VB—2æ÷B'V–ÇBâ&F†W"F†â6†—'WGFöâF†BFöW2æ÷F†–ærÂF†P¢òò6öÆÆV7G2–çFW&W7C¢v†òvçG2—BÂæBv†B7F¶RF†W’6’F†W’v÷VÆBW6Rà¢òòæ÷F†–ær†W&RÖ÷fW2ÖöæW’(	B—B—26–væÂ7F÷&RÂFVÆ–&W&FVÇ’GVÖ"à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7Bt•DÄ•5EôdTEU$U2Òö&¦V7Bæg&VW¦R‡°¢v†VB×FòÖ†VBs¢²Æ&VÃ¢t†VB×FòÔ†VB6†ÆÆVævW2rÒÀ§Ò“° ¦6öç7BfVGW&Uv—FÆ—7E66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢fVGW&S¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢W6W$–C¢²G—S¢7G&–ærÂFVfVÇC¢çVÆÂÂ–æFWƒ¢G'VRÒÀ¢VÖ–Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢æ÷&ÖÆ—¦VDVÖ–Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÂ–æFWƒ¢G'VRÒÀ¢F—7Æ”æÖS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òò6VÆb×&W÷'FVBÂf÷"6—¦–æröæÇ’âæWfW"W6VB2Æ–Ö—Bà¢vvW$&æC¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢æ÷FS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢6÷W&6S¢²G—S¢7G&–ærÂFVfVÇC¢vÖö&–ÆRÖrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦fVGW&Uv—FÆ—7E66†VÖæ–æFW‚‡²fVGW&S¢Âæ÷&ÖÆ—¦VDVÖ–Ã¢ÒÂ²Væ—VS¢G'VRÂ'F–Äf–ÇFW$W‡&W76–öã¢²æ÷&ÖÆ—¦VDVÖ–Ã¢²GG—S¢w7G&–ærrÂFæS¢rrÒÒÒ“° ¦6öç7BfVGW&Uv—FÆ—7BÒÖöævö÷6RæÖöFVÇ2äfVGW&Uv—FÆ—7@¢ÇÂÖöævö÷6RæÖöFVÂ‚tfVGW&Uv—FÆ—7BrÂfVGW&Uv—FÆ—7E66†VÖ“° ¦ç÷7B‚rö’÷v—FÆ—7Bó¦fVGW&RrÂ7V&Ö—DÆ–Ö—FW"Â÷F–öæÅfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BfVGW&RÒ7G&–ær‡&Wç&×2æfVGW&RÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢–b‚t•DÄ•5EôdTEU$U5¶fVGW&UÒ’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uVæ¶æ÷vâfVGW&RârÒ“°¢Ð ¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚’ÇÂçVÆÃ°¢ÆWBVÖ–ÂÒ7G&–ær‡&Wæ&öG“òæVÖ–ÂÇÂrr’çG&–Ò‚“°¢ÆWBF—7Æ”æÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“° ¢òò&VfW"F†R6–væVBÖ–â66÷VçB÷fW"ç—F†–ærF†R6Æ–VçB6VçBà¢–b‡W6W$–B’°¢6öç7B66÷VçBÒv—BW6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–Âf—'7DæÖRÆ–W$æÖRr’æÆVâ‚“°¢–b†66÷VçB’°¢VÖ–ÂÒ66÷VçBæVÖ–ÂÇÂVÖ–Ã°¢F—7Æ”æÖRÒ66÷VçBçÆ–W$æÖRÇÂ66÷VçBæf—'7DæÖRÇÂF—7Æ”æÖS°¢Ð¢Ð¢–b‚VÖ–ÂÇÂõåµäÇ5Ò´µäÇ5ÒµÂåµäÇ5Ò²BòçFW7B†VÖ–Â’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tâVÖ–ÂFG&W72—2&WV—&VBFò¦ö–âF†Rv—FÆ—7BârÒ“°¢Ð ¢6öç7Bæ÷&ÖÆ—¦VDVÖ–ÂÒVÖ–ÂçFôÆ÷vW$66R‚“°¢6öç7BvvW$&æBÒ7G&–ær‡&Wæ&öG“òçvvW$&æBÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂ#B“°¢6öç7Bæ÷FRÒ7G&–ær‡&Wæ&öG“òææ÷FRÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂC“° ¢v—BfVGW&Uv—FÆ—7Bæf–æDöæTæEWFFR€¢²fVGW&RÂæ÷&ÖÆ—¦VDVÖ–ÂÒÀ¢°¢G6WC¢°¢fVGW&RÀ¢æ÷&ÖÆ—¦VDVÖ–ÂÀ¢VÖ–ÂÀ¢W6W$–BÀ¢F—7Æ”æÖS¢F—7Æ”æÖRç6Æ–6RƒÂƒ’À¢âââ‡vvW$&æBò²vvW$&æBÒ¢·Ò’À¢âââ†æ÷FRò²æ÷FRÒ¢·Ò’À¢6÷W&6S¢7G&–ær‡&Wæ&öG“òç6÷W&6RÇÂvÖö&–ÆRÖr’ç6Æ–6RƒÂC’À¢ÒÀ¢ÒÀ¢²W6W'C¢G'VRÂæWs¢G'VRÂ6WDFVfVÇG4öä–ç6W'C¢G'VRÒÀ¢“° ¢6öç7BF÷FÂÒv—BfVGW&Uv—FÆ—7Bæ6÷VçDFö7VÖVçG2‡²fVGW&RÒ“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢fVGW&RÀ¢¦ö–æVC¢G'VRÀ¢F÷FÂÀ¢ÖW76vS¢–÷Rw&RöâF†RÆ—7Bf÷"Gµt•DÄ•5EôdTEU$U5¶fVGW&UÒæÆ&VÇÒâvRvÆÂVÖ–Â–÷Rv†Vâ—B÷Vç2æÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uv—FÆ—7B6–vçWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BFB–÷RFòF†Rv—FÆ—7B§W7Bæ÷rârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷v—FÆ—7Bó¦fVGW&RöÖRrÂ÷F–öæÅfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BfVGW&RÒ7G&–ær‡&Wç&×2æfVGW&RÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢–b‚t•DÄ•5EôdTEU$U5¶fVGW&UÒ’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uVæ¶æ÷vâfVGW&RârÒ“° ¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BVW'”VÖ–ÂÒ7G&–ær‡&WçVW'’æVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢ÆWBæ÷&ÖÆ—¦VDVÖ–ÂÒVW'”VÖ–Ã°¢–b‡W6W$–B’°¢6öç7B66÷VçBÒv—BW6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–Âr’æÆVâ‚“°¢–b†66÷VçCòæVÖ–Â’æ÷&ÖÆ—¦VDVÖ–ÂÒ7G&–ær†66÷VçBæVÖ–Â’çFôÆ÷vW$66R‚“°¢Ð ¢6öç7B¶¦ö–æVBÂF÷FÅÒÒv—B&öÖ—6RæÆÂ…°¢æ÷&ÖÆ—¦VDVÖ–À¢òfVGW&Uv—FÆ—7BæW†—7G2‡²fVGW&RÂæ÷&ÖÆ—¦VDVÖ–ÂÒ¢¢&öÖ—6Rç&W6öÇfR†çVÆÂ’À¢fVGW&Uv—FÆ—7Bæ6÷VçDFö7VÖVçG2‡²fVGW&RÒ’À¢Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂfVGW&RÂ¦ö–æVC¢&ööÆVâ†¦ö–æVB’ÂF÷FÂÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uv—FÆ—7B7FGW2—2Væf–Æ&ÆRârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–â÷v—FÆ—7BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BfVGW&RÒ7G&–ær‡&WçVW'’æfVGW&RÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7Bf–ÇFW"ÒfVGW&Rò²fVGW&RÒ¢·Ó°¢6öç7B·F÷FÇ2Â&V6VçEÒÒv—B&öÖ—6RæÆÂ…°¢fVGW&Uv—FÆ—7Bævw&VvFR…°¢²FÖF6ƒ¢f–ÇFW"ÒÀ¢°¢Fw&÷W¢°¢ö–C¢rFfVGW&RrÀ¢F÷FÃ¢²G7VÓ¢ÒÀ¢6–væVD–ã¢²G7VÓ¢²F6öæC¢·²F–dçVÆÃ¢²rGW6W$–BrÂfÇ6UÒÒÂÂÒÒÒÀ¢ÒÀ¢ÒÀ¢²G6÷'C¢²F÷FÃ¢ÓÒÒÀ¢Ò’À¢fVGW&Uv—FÆ—7Bæf–æB†f–ÇFW"’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#¢ç6VÆV7B‚vfVGW&RVÖ–ÂF—7Æ”æÖRvvW$&æBæ÷FR6÷W&6R7&VFVDBr’æÆVâ‚’À¢Ò“° ¢òòv†B7F¶R&æG2V÷ÆR6’F†W’v÷VÆBW6R(	BF†RçVÖ&W"v÷'F‚&VF–æp¢òò&Vf÷&RFV6–F–ærFò'V–ÆBF†RW67&÷rà¢6öç7B&æG2Ò&V6VçBç&VGV6R‚†62Â&÷r’Óâ°¢–b‚&÷rçvvW$&æB’&WGW&â63°¢65·&÷rçvvW$&æEÒÒ†65·&÷rçvvW$&æEÒÇÂ’²°¢&WGW&â63°¢ÒÂ·Ò“° ¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂF÷FÇ2Â&æG2Â&V6VçBÂfVGW&W3¢ö&¦V7Bæ¶W—2…t•DÄ•5EôdTEU$U2’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uv—FÆ—7B&W÷'Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†Rv—FÆ—7BârÒ“°¢Ð§Ò“° ¢òò6–ÆVçB6W76–öâ&VæWvÂâF†R6ÆÇ2F†—2öâÆVæ6ƒ²7F–ÆÂ×fÆ–BFö¶Vâ—0¢òòW†6†ævVBf÷"g&W6‚öæR6òâ7F—fRÆ–W"—2æWfW"ÆövvVB÷WBÖ–B×6W76–öâà¦ç÷7B‚rö’öWF‚÷&Vg&W6‚rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢–b‚W6W$–B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u6W76–öâ6÷VÆBæ÷B&R&VæWvVBârÒ“°¢òò6''’F†R÷&–v–æÂ66÷RF‡&÷Vv‚F†R&Vg&W6‚â&VæWv–ær×W7BæWfW"v–FVâ¢òò6W76–öâw2VF–Væ6Rà¢6öç7B66÷RÒ7G&–ær‡&WçW6W#òç66÷RÇÂrr’çG&–Ò‚“°¢6öç7BFö¶VâÒ§wBç6–vâ€¢66÷Rò²–C¢W6W$–BÂ66÷RÒ¢²–C¢W6W$–BÒÀ¢&ö6W72æVçbä¥uEõ4T5$UBÀ¢²W‡—&W4–ã¢4U54”ôåõDô´TåõEDÂÒÀ¢“°¢&W2æ6öö¶–R‚wFö¶VârÂFö¶VâÂ²‡GGöæÇ“¢G'VRÂÖ„vS¢4U54”ôåô4ôô´”UôÔ…ôtRÒ“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²Fö¶VâÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢u6W76–öâ6÷VÆBæ÷B&R&VæWvVBârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòÔôäU’äõD”d”4D”ôå0¢òòWfW'’&Ææ6R6†ævR6†÷VÆBÆVfRF†RÆ–W"÷"ff–Æ–FRw&—GFVâ&V6÷&Bà¢òòf–ÇW&W2&RÆövvVBÂæWfW"F‡&÷vâ(	BâVÖ–Â&ö&ÆVÒ×W7Bæ÷B&öÆÂ&6²÷ ¢òò&Æö6²6ö×ÆWFVBÖöæW’÷W&F–öâà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B6VæDÖöæW”æ÷F–6RÒ7–æ2‡²FòÂ7V&¦V7BÂ†VF–ærÂÆ–æW2ÒµÒÂfö÷FW"Ò’Óâ°¢–b‚Fò’&WGW&ã°¢G'’°¢v—BG&ç7÷'FW"ç6VæDÖ–Â‡°¢g&öÓ¢dÔÕôÔ”Åôe$ôÒÀ¢FòÀ¢7V&¦V7BÀ¢‡FÖÃ¢ ¢ÆF—b7G–ÆSÒ&föçBÖfÖ–Ç“¤&–ÂÄ†VÇfWF–6Ç6ç2×6W&–c¶Ö‚×v–GFƒ£cƒ¶Ö&v–ã¦WFó¶&6¶w&÷VæC¢3#3¶6öÆ÷#¢6ffc·FF–æs£#Gƒ¶&÷&FW"×&F—W3£'ƒ²#à¢Æƒ"7G–ÆSÒ&6öÆ÷#¢6c&#SCC¶Ö&v–ã£'ƒ²#âG¶†VF–æwÓÂöƒ#à¢G¶Æ–æW2æÖ‚†Æ–æR’ÓâÇ7G–ÆSÒ&Ö&v–ã£ƒ¶Æ–æRÖ†V–v‡C£ãc¶6öÆ÷#§&v&ƒ#SRÃ#SRÃ#SRÂãƒR“²#âG¶Æ–æWÓÂ÷æ’æ¦ö–â‚rr—Ð¢Ç7G–ÆSÒ&Ö&v–ã£‡‚¶föçB×6—¦S£'ƒ¶6öÆ÷#§&v&ƒ#SRÃ#SRÃ#SRÂãCR“²#âG¶fö÷FW"ÇÂtfçF7’ÔÔFæW72wÓÂ÷à¢ÂöF—cæÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â‚tÖöæW’æ÷F–f–6F–öâf–ÆVBFò6VæC¢rÂ7V&¦V7BÂW'&÷"æÖW76vR“°¢Ð§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòdÒ²5T%45$•D”ôâ4ä4TÂò$TeTä@¢òò6ö–âVçG&–W2æBff–Æ–FR–÷WG2vW&R&WfW'6–&ÆS²dÒ²v2æ÷Bâ6†&vV&6°¢òò÷"7W÷'B6æ6VÆÆF–öâ†BæòF‚ÂÆVf–ærF†R7V'67&—F–öâ7F—fRà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–âöfÒ×ÇW2ó§W6W$–Bö6æ6VÂrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&Wç&×2çW6W$–BÇÂrr’çG&–Ò‚“°¢6öç7B&VgVæD6ö–ç2ÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òç&VgVæD6ö–ç2’ÇÂ’“°¢6öç7B&V6öâÒ7G&–ær‡&Wæ&öG“òç&V6öâÇÂu7V'67&—F–öâ6æ6VÆÆVB'’FÖ–æ—7G&F÷"âr’ç6Æ–6RƒÂ3“° ¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÂ6öFS¢uU4U%ôäõEôdõTäBrÒ“° ¢6öç7Bv57V'67&–&VBÒ&ööÆVâ‡W6W"æ—57V'67&–&VB“°¢–b‚v57V'67&–&VBbb&VgVæD6ö–ç2’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ÖW76vS¢uF†B66÷VçB†2æò7F—fRdÒ²7V'67&—F–öâârÂÇ&VG”6æ6VÆÆVC¢G'VRÒ“°¢Ð ¢W6W"æ—57V'67&–&VBÒfÇ6S°¢W6W"æ7W'&VçEÆâÒrs°¢W6W"ç7V'67&—F–öäVæG4BÒæWrFFR‚“° ¢ÆWB&Ææ6TgFW"ÒçVÖ&W"ç'6T–çB…7G&–ær‡W6W"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢–b‡&VgVæD6ö–ç2â’°¢6öç7B&Ææ6T&Vf÷&RÒ&Ææ6TgFW#°¢&Ææ6TgFW"Ò&Ææ6T&Vf÷&R²&VgVæD6ö–ç3°¢W6W"çFö¶Vç2Ò7G&–ær†&Ææ6TgFW"“°¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–BÀ¢ÖF6„–C¢vfÒ×ÇW2rÀ¢6÷W&6UG—S¢vÖF6‚rÀ¢G—S¢td”t…EôTåE%•õ$TeTäBrÀ¢Ö÷VçC¢&VgVæD6ö–ç2À¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W“¢f×ÇW3§&VgVæC¢G·W6W$–GÓ¢G´FFRææ÷r‚—ÖÀ¢ÖWFFF¢²&V6öâÂ&öGV7C¢vfÒ×ÇW2rÒÀ¢ÕÒ“°¢Ð ¢v—BW6W"ç6fR‚“° ¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢u–÷W"dÒ²7V'67&—F–öâ†2&VVâ6æ6VÆÆVBrÀ¢†VF–æs¢tdÒ²4ä4TÄÄTBrÀ¢Æ–æW3¢°¢u–÷W"dÒ²7V'67&—F–öâ†2&VVâ6æ6VÆÆVBæBv–ÆÂæ÷B&VæWrârÀ¢&VgVæD6ö–ç2âòÇ7G&öæsâG·&VgVæD6ö–ç2çFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâ&WGW&æVBFò–÷W"vÆÆWBæ¢tæò6ö–ç2vW&R&VgVæFVBv—F‚F†—26æ6VÆÆF–öâârÀ¢&V6öã¢G·&V6öçÖÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢&VgVæD6ö–ç2â ¢òdÒ²6æ6VÆÆVBæBG·&VgVæD6ö–ç7ÒdÒ&VgVæFVBæ ¢¢tdÒ²6æ6VÆÆVBârÀ¢v57V'67&–&VBÀ¢&VgVæFVD6ö–ç3¢&VgVæD6ö–ç2À¢vÆÆWD&Ææ6S¢&Ææ6TgFW"À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tdÒ²6æ6VÆÆF–öâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6æ6VÂF†B7V'67&—F–öâârÂ6öFS¢tdÕõÅU5ô4ä4TÅôd”ÄTBrÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòuTU5BU$4„4R4Ä”Ð¢òòwVW7G2Ö’'W’6ö–ç2&Vf÷&R7&VF–ærâ66÷VçB†FVÆ–&W&FRÂf÷"6öçfW'6–öâ’à¢òòF†—2GF6†W2ç’6ö×ÆWFVBwVW7B÷&FW"ÖFRv—F‚F†R6ÖRVÖ–ÂFòF†RæWp¢òò66÷VçBÂ6òW&6†6R—2æWfW"7G&æFVBà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’ö6†V6¶÷WBö6Æ–ÒÖwVW7BÖ÷&FW'2rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢6öç7BVÖ–ÂÒ7G&–ær‡W6W"æVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢–b‚VÖ–Â’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uF†—266÷VçB†2æòVÖ–Âöâf–ÆRârÒ“° ¢6öç7B6†V6¶÷WD÷&FW"ÒÖöævö÷6RæÖöFVÇ2ä6†V6¶÷WD÷&FW#°¢–b‚6†V6¶÷WD÷&FW"’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6Æ–ÖVC¢ÂÖW76vS¢tæòwVW7B÷&FW'2Fò6Æ–ÒârÒ“°¢Ð ¢6öç7B÷&FW'2Òv—B6†V6¶÷WD÷&FW"æf–æB‡°¢VÖ–Ã¢æWr&VtW‡†âG¶VÖ–Âç&WÆ6R‚õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÂuÅÂBbr—ÒFÂv’r’À¢F÷#¢·²W6W$–C¢²FW†—7G3¢fÇ6RÒÒÂ²W6W$–C¢çVÆÂÕÒÀ¢7FGW3¢t5$TD•DTBrÀ¢Ò“° ¢–b‚÷&FW'2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6Æ–ÖVC¢ÂÖW76vS¢tæòwVW7B÷&FW'2Fò6Æ–ÒârÒ“° ¢ÆWBF÷FÄ6ö–ç2Ò°¢f÷"†6öç7B÷&FW"öb÷&FW'2’°¢6öç7BÇ&VG”6Æ–ÖVBÒv—Bf–v‡DVçG'”ÆVFvW"æf–æDöæR‡²–FV×÷FVæ7”¶W“¢wVW7F6Æ–Ó¢G¶÷&FW"åö–GÖÒ’æÆVâ‚“°¢–b†Ç&VG”6Æ–ÖVB’6öçF–çVS° ¢6öç7B6ö–ç2ÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"†÷&FW"æ7&VF—FVD6ö–ç2ÇÂ÷&FW"æ6ö–ç2ÇÂ’’“°¢6öç7B&Ææ6T&Vf÷&RÒçVÖ&W"ç'6T–çB…7G&–ær‡W6W"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢6öç7B&Ææ6TgFW"Ò&Ææ6T&Vf÷&R²6ö–ç3° ¢–b†6ö–ç2â’°¢W6W"çFö¶Vç2Ò7G&–ær†&Ææ6TgFW"“°¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–BÀ¢ÖF6„–C¢vwVW7BÖ6Æ–ÒrÀ¢6÷W&6UG—S¢vÖF6‚rÀ¢G—S¢td”t…EôTåE%•õ$TeTäBrÀ¢Ö÷VçC¢6ö–ç2À¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W“¢wVW7F6Æ–Ó¢G¶÷&FW"åö–GÖÀ¢ÖWFFF¢²÷&FW$çVÖ&W#¢÷&FW"æ÷&FW$çVÖ&W"ÇÂçVÆÂÂ&öGV7C¢vwVW7BÖ6ö–âÖ6Æ–ÒrÒÀ¢ÕÒ“°¢F÷FÄ6ö–ç2³Ò6ö–ç3°¢Ð ¢÷&FW"çW6W$–BÒW6W$–C°¢v—B÷&FW"ç6fR‚“°¢Ð ¢–b‡F÷FÄ6ö–ç2â’°¢v—BW6W"ç6fR‚“°¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢u–÷W"V&Æ–W"W&6†6R†2&VVâFFVBrÀ¢†VF–æs¢t4ô”å2DDTBrÀ¢Æ–æW3¢°¢vRf÷VæBW&6†6RÖFRv—F‚F†—2VÖ–Â&Vf÷&R–÷R7&VFVB–÷W"66÷VçBæÀ¢Ç7G&öæsâG·F÷FÄ6ö–ç2çFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâFFVBFò–÷W"vÆÆWBæÀ¢ÒÀ¢Ò“°¢Ð ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢6Æ–ÖVC¢÷&FW'2æÆVæwF‚À¢6ö–ç4FFVC¢F÷FÄ6ö–ç2À¢vÆÆWD&Ææ6S¢çVÖ&W"ç'6T–çB…7G&–ær‡W6W"çFö¶Vç2ÇÂsr’Â’ÇÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚twVW7B÷&FW"6Æ–Òf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6†V6²f÷"V&Æ–W"W&6†6W2ârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòTÄ”t”$”Ä•E’Â$U5ôå4”$ÄRÄ’ÂD‚b5Uõ%@¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ ¢òòÖ–æ–×VÒvRf÷"–BVçG'’â6öæf–wW&&ÆR&V6W6R6öÖR§W&—6F–7F–öç2F–ffW"à¦6öç7BÔ”ä”ÕTÕõÄ•ôtRÒçVÖ&W"‡&ö6W72æVçbäÔ”ä”ÕTÕõÄ•ôtRÇÂ‚“° ¢òò7FFW2v†W&R–BfçF7’—2&W7G&–7FVBâ÷VÆFRgFW"ÆVvÂ&Wf–Wr(	@¢òòÆVgBV×G’FVÆ–&W&FVÇ’6òæ÷F†–ær—2&Æö6¶VBöâwVW72âFB"ÖÆWGFW"6öFW2à¦6öç7B$U5E$”5DTEõ5DDU2Ò7G&–ær‡&ö6W72æVçbå$U5E$”5DTEõ5DDU2ÇÂrr¢ç7Æ—B‚rÂr’æÖ‚‡‚’Óâ‚çG&–Ò‚’çFõWW$66R‚’’æf–ÇFW"„&ööÆVâ“° ¦6öç7BvTg&öÔFö"Ò†Fö"’Óâ°¢–b‚Fö"’&WGW&âçVÆÃ°¢6öç7B&—'F‚ÒæWrFFR†Fö"“°¢–b„çVÖ&W"æ—4æâ†&—'F‚ævWEF–ÖR‚’’’&WGW&âçVÆÃ°¢6öç7Bæ÷rÒæWrFFR‚“°¢ÆWBvRÒæ÷rævWDgVÆÅ–V"‚’Ò&—'F‚ævWDgVÆÅ–V"‚“°¢6öç7BÒÒæ÷rævWDÖöçF‚‚’Ò&—'F‚ævWDÖöçF‚‚“°¢–b†ÒÂÇÂ†ÒÓÓÒbbæ÷rævWDFFR‚’Â&—'F‚ævWDFFR‚’’’vRÓÒ°¢&WGW&âvS°§Ó° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òò¥U$•4D”5D”ôâÔôDU0¢òð¢òòöæR6öFV&6RÂF‡&VRÖöFW2W"7FFRâWfW'–öæR6âÆ’F†R6ÖRf–v‡G2öâF†P¢òò6ÖR66÷&V6&G3²v†B6†ævW2—2v†WF†W"ÖöæW’—2–çföÇfVBà¢òð¢òò–BVçG'’fVW2Â6ö–âW&6†6W2æB66‚×fÇVR&—¦W0¢òòg&VRg&VRVçG'’Âæò6ö–âW&6†6W2Âæò66‚×fÇVR&—¦W2(	B6ö–ç2&P¢òò7FGW2öæÇ’âæò6öç6–FW&F–öâÂ6ò—B—2æ÷BvvW"à¢òò&Æö6¶VBæò66W72BÆÂÂf÷"7FFW2v†W&RWfVâg&VRÆ’—2VçvVÆ6öÖP¢òð¢òòF†Rg&VRÖöFRöæÇ’†öÆG2–b6ö–ç2vVçV–æVÇ’†fRæò66‚fÇVRf÷"F†÷6P¢òòÆ–W'2â–bF†W’6÷VÆB'W’÷"&VFVVÒ6ö–ç2—Bv÷VÆB&RF†R6ÖR–B&öGV7@¢òòv—F‚W‡G&7FW2Âv†–6‚—2W†7FÇ’F†R'&ævVÖVçB6WfW&Â7FFW2W'7VRâ6ð¢òòW&6†6W2æB66‚×fÇVR&—¦W2&R&VgW6VB6W'fW"×6–FRÂæ÷B†–FFVâ–âF†RT’à¢òð¢òòFVfVÇB—2e$TRÂæ÷B–C¢7FFR×W7B&RæÖVB–â”Eõ5DDU2FòF¶RÖöæW’à¢òòf–Æ–ær6Æ÷6VB—2F†RöæÇ’6fRFVfVÇBf÷"F†—2à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7B'6U7FFTÆ—7BÒ‡fÇVR’Óâ7G&–ær‡fÇVRÇÂrr¢ç7Æ—B‚rÂr’æÖ‚‡‚’Óâ‚çG&–Ò‚’çFõWW$66R‚’’æf–ÇFW"„&ööÆVâ“° ¢òò„$B”åDU$Äô4²âF†W6Rf—fR7FFW2&ö†–&—B–BF–Ç’ÖfçF7’6öçFW7G2Â6òF†W¢òò&Rg&VR×Æ’æòÖGFW"v†Bç’Vçf—&öæÖVçBf&–&ÆR6—2âÆ—7F–ær7FFR–à¢òò”Eõ5DDU26ææ÷B÷fW'&–FRF†—2(	BÖ—66öæf–wW&VBFWÆ÷’×W7Bæ÷B&R&ÆRFð¢òò7F'BF¶–ærVçG'’fVW2–â7FFRF†Bf÷&&–G2F†VÒà¦6öç7Be$TUôôäÅ•õ5DDU2Òö&¦V7Bæg&VW¦R…²t„’rÂt”BrÂtÕBrÂtåbrÂutuÒ“° ¢òòWfW'—v†W&RVÇ6RDe2÷W&FW2â–B'’FVfVÇC²âGF÷&æW’6âæ'&÷r—Bà¦6öç7BDTdTÅEõ”Eõ5DDU2Òö&¦V7Bæg&VW¦R…°¢tÂrÂt²rÂt¢rÂt"rÂt4rÂt4òrÂt5BrÂtDRrÂtD2rÂtdÂrÂttrÂt”ÂrÂt”ârÀ¢t”rÂtµ2rÂtµ’rÂtÄrÂtÔRrÂtÔBrÂtÔrÂtÔ’rÂtÔârÂtÕ2rÂtÔòrÂtäRrÂtä‚rÀ¢tä¢rÂtäÒrÂtå’rÂtä2rÂtäBrÂtô‚rÂtô²rÂtõ"rÂurÂu$’rÂu42rÂu4BrÂuDârÀ¢uE‚rÂuUBrÂueBrÂudrÂuubrÂut’rÂuu’rÀ¥Ò“° ¦6öç7B6öæf–wW&VE–E7FFW2Ò'6U7FFTÆ—7B‡&ö6W72æVçbå”Eõ5DDU2“°¢òòF†R–çFW&Æö6²—2Æ–VB†W&R2vVÆÂ2–â&W6öÇfU7FFTÖöFRÂ6òF†R&W6öÇfV@¢òòÆ—7B—G6VÆb—2æWfW"w&öær(	Bæ÷B§W7BF†RFV6—6–öâÖFRg&öÒ—Bà¦6öç7B”Eõ5DDU2Ò†6öæf–wW&VE–E7FFW2æÆVæwF‚ò6öæf–wW&VE–E7FFW2¢²ââäDTdTÅEõ”Eõ5DDU5Ò¢æf–ÇFW"‚†6öFR’Óâe$TUôôäÅ•õ5DDU2æ–æ6ÇVFW2†6öFR’“° ¦6öç7B$Äô4´TEõ5DDU2Ò'6U7FFTÆ—7B‡&ö6W72æVçbä$Äô4´TEõ5DDU2“°¢òòÆVv7’f&–&ÆR¶WBv÷&¶–æs¢ç—F†–ærÆ—7FVBF†W&R—2G&VFVB2g&VR×Æ’à¦6öç7BÄTt5•õ$U5E$”5DTBÒ'6U7FFTÆ—7B‡&ö6W72æVçbå$U5E$”5DTEõ5DDU2“° ¦–b†6öæf–wW&VE–E7FFW2ç6öÖR‚†6öFR’Óâe$TUôôäÅ•õ5DDU2æ–æ6ÇVFW2†6öFR’’’°¢6öç6öÆRçv&â†t$ä”äs¢”Eõ5DDU2æÖVBG¶6öæf–wW&VE–E7FFW2æf–ÇFW"‚†2’Óâe$TUôôäÅ•õ5DDU2æ–æ6ÇVFW2†2’’æ¦ö–â‚rÂr—Ò(	B–væ÷&VBâF†÷6R7FFW2&Rg&VR×Æ’öæÇ’æ“°§Ð ¢òòÖ÷7B§W&—6F–7F–öç2&R‚³²F†W6R&WV—&R#²à¦6öç7BtUó#õ5DDU2Òö&¦V7Bæg&VW¦R‡'6U7FFTÆ—7B€¢&ö6W72æVçbätUó#õ5DDU2ÇÂtÔÄ¢Ä”ÄÄÄÂÄäRrÀ¢’“° ¦6öç7BÖ–æ–×VÔvTf÷%7FFRÒ‡7FFR’Óâ„tUó#õ5DDU2æ–æ6ÇVFW2…7G&–ær‡7FFRÇÂrr’çFõWW$66R‚’’ò#¢‚“° ¦6öç7B&W6öÇfU7FFTÖöFRÒ‡7FFR’Óâ°¢6öç7B6öFRÒ7G&–ær‡7FFRÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢–b‚6öFR’&WGW&âwVæ¶æ÷vâs°¢–b„$Äô4´TEõ5DDU2æ–æ6ÇVFW2†6öFR’’&WGW&âv&Æö6¶VBs°¢òò–çFW&Æö6²f—'7C¢æ÷F†–ærF÷vç7G&VÒ6â&öÖ÷FRF†W6RFò–Bà¢–b„e$TUôôäÅ•õ5DDU2æ–æ6ÇVFW2†6öFR’’&WGW&âvg&VRs°¢–b„ÄTt5•õ$U5E$”5DTBæ–æ6ÇVFW2†6öFR’’&WGW&âvg&VRs°¢–b…”Eõ5DDU2æ–æ6ÇVFW2†6öFR’’&WGW&âw–Bs°¢òòç—F†–ærVç&V6övæ—6VB†÷"FW'&—F÷'’’7F—2g&VR&F†W"F†â&V–ær77VÖV@¢òò–BâVæ¶æ÷vâ×W7BæWfW"ÖVâ6†&vV&ÆRà¢&WGW&âvg&VRs°§Ó° ¢òòv†BF†—2Æ–W"Ö’7GVÆÇ’FòÂ–âöæRö&¦V7Bà¦6öç7BÆ–W$§W&—6F–7F–öâÒ‡W6W"’Óâ°¢6öç7B7FFRÒ7G&–ær‡W6W#òç&W6–FVæ6U7FFRÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢6öç7BÖöFRÒ&W6öÇfU7FFTÖöFR‡7FFR“°¢6öç7BÖ–æ–×VÔvRÒÖ–æ–×VÔvTf÷%7FFR‡7FFR“°¢&WGW&â°¢7FFRÀ¢ÖöFRÀ¢Ö–æ–×VÔvRÀ¢6å”VçG'”fVW3¢ÖöFRÓÓÒw–BrÀ¢6ä'W”6ö–ç3¢ÖöFRÓÓÒw–BrÀ¢6åv–ä66…fÇVS¢ÖöFRÓÓÒw–BrÀ¢6åÆ”g&VS¢ÖöFRÓÒv&Æö6¶VBrÀ¢Ó°§Ó° ¢òò6–ævÆRvFRW6VB&Vf÷&Rç’”B7F–öââ&WGW&ç2çVÆÂv†VâF†RW6W"Ö’Æ’à¦6öç7B6†V6µÆ”VÆ–v–&–Æ—G’Ò‡W6W"’Óâ°¢–b‚W6W"’&WGW&â²6öFS¢uU4U%ôäõEôdõTäBrÂÖW76vS¢t66÷VçBæ÷Bf÷VæBârÓ° ¢–b‡W6W"ç6VÆdW†6ÇVFVEVçF–ÂbbæWrFFR‡W6W"ç6VÆdW†6ÇVFVEVçF–Â’âæWrFFR‚’’°¢&WGW&â°¢6öFS¢u4TÄeôU„4ÅTDTBrÀ¢ÖW76vS¢–÷R†fR6VÆbÖW†6ÇVFVBVçF–ÂG¶æWrFFR‡W6W"ç6VÆdW†6ÇVFVEVçF–Â’çFôÆö6ÆTFFU7G&–ær‚—ÒæÀ¢Ó°¢Ð ¢6öç7B§W&—6F–7F–öâÒÆ–W$§W&—6F–7F–öâ‡W6W"“° ¢–b‚§W&—6F–7F–öâç7FFR’°¢&WGW&â²6öFS¢u5DDUõTådU$”d”TBrÂÖW76vS¢tFB–÷W"7FFRöb&W6–FVæ6R&Vf÷&RVçFW&–ær–B6öçFW7BârÓ°¢Ð¢–b†§W&—6F–7F–öâæÖöFRÓÓÒv&Æö6¶VBr’°¢&WGW&â²6öFS¢u5DDUô$Äô4´TBrÂÖW76vS¢fçF7’ÔÔFæW72—2æ÷Bf–Æ&ÆR–âG¶§W&—6F–7F–öâç7FFWÒæÓ°¢Ð ¢6öç7BvRÒvTg&öÔFö"‡W6W"æFFTöd&—'F‚“°¢–b†vRÓÓÒçVÆÂ’°¢&WGW&â²6öFS¢ttUõTådU$”d”TBrÂÖW76vS¢tFB–÷W"FFRöb&—'F‚&Vf÷&RVçFW&–ær–B6öçFW7BârÓ°¢Ð¢òòW"×7FFRF‡&W6†öÆC¢#²v†W&RF†R7FFR&WV—&W2—BÂ‚²VÇ6Wv†W&Rà¢6öç7B&WV—&VDvRÒÖF‚æÖ‚†§W&—6F–7F–öâæÖ–æ–×VÔvRÂÔ”ä”ÕTÕõÄ•ôtRÇÂ‚“°¢–b†vRÂ&WV—&VDvR’°¢&WGW&â°¢6öFS¢uTäDU$tRrÀ¢ÖW76vS¢–÷R×W7B&RG·&WV—&VDvWÒ÷"öÆFW"FòVçFW"–B6öçFW7B–âG¶§W&—6F–7F–öâç7FFWÒæÀ¢Ó°¢Ð ¢–b‚§W&—6F–7F–öâæ6å”VçG'”fVW2’°¢&WGW&â°¢6öFS¢te$TUõÄ•ôôäÅ’rÀ¢ÖW76vS¢–B6öçFW7G2&Ræ÷Bf–Æ&ÆR–âG¶§W&—6F–7F–öâç7FFWÒâg&VR6öçFW7G2&R÷VâFò–÷RæB6ö–ç26â7F–ÆÂ&Rvöâ(	BF†W’§W7B†fRæò66‚fÇVRF†W&RæÀ¢Ó°¢Ð ¢&WGW&âçVÆÃ°§Ó° ¢òòÆ–W"7WÆ–W2FFRöb&—'F‚æB7FFRöb&W6–FVæ6Rà¦ç÷7B‚rö’÷W6W'2öÖRöVÆ–v–&–Æ—G’rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢6öç7BFö"Ò&Wæ&öG“òæFFTöd&—'Fƒ°¢6öç7B7FFRÒ7G&–ær‡&Wæ&öG“òç&W6–FVæ6U7FFRÇÂrr’çG&–Ò‚’çFõWW$66R‚“° ¢–b†Fö"’°¢6öç7BvRÒvTg&öÔFö"†Fö"“°¢–b†vRÓÓÒçVÆÂ’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uF†BFFRöb&—'F‚—2æ÷BfÆ–BârÂ6öFS¢t”ådÄ”EôDô"rÒ“°¢–b†vRÂÔ”ä”ÕTÕõÄ•ôtR’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢–÷R×W7B&RG´Ô”ä”ÕTÕõÄ•ôtWÒ÷"öÆFW"FòÆ’æÂ6öFS¢uTäDU$tRrÒ“°¢Ð¢W6W"æFFTöd&—'F‚ÒæWrFFR†Fö"“°¢W6W"ævUfW&–f–VDBÒæWrFFR‚“°¢Ð¢–b‡7FFR’°¢–b‚õå´Õ¥×³'ÒBòçFW7B‡7FFR’’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uW6RGvòÖÆWGFW"7FFR6öFRârÂ6öFS¢t”ådÄ”Eõ5DDRrÒ“°¢W6W"ç&W6–FVæ6U7FFRÒ7FFS°¢Ð¢W6W"æVÆ–v–&–Æ—G”6†V6¶VDBÒæWrFFR‚“°¢v—BW6W"ç6fR‚“° ¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’‡W6W"“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢VÆ–v–&ÆS¢&Æö6¶VBÀ¢&V6öã¢&Æö6¶VCòæ6öFRÇÂçVÆÂÀ¢ÖW76vS¢&Æö6¶VCòæÖW76vRÇÂu–÷R&RVÆ–v–&ÆRFòVçFW"–B6öçFW7G2ârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tVÆ–v–&–Æ—G’WFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6fR–÷W"FWF–Ç2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷W6W'2öÖRöVÆ–v–&–Æ—G’rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’’æÆVâ‚“°¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’‡W6W"“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢VÆ–v–&ÆS¢&Æö6¶VBÀ¢&V6öã¢&Æö6¶VCòæ6öFRÇÂçVÆÂÀ¢ÖW76vS¢&Æö6¶VCòæÖW76vRÇÂtVÆ–v–&ÆRârÀ¢Ö–æ–×VÔvS¢Ô”ä”ÕTÕõÄ•ôtRÀ¢†4FFTöd&—'Fƒ¢&ööÆVâ‡W6W#òæFFTöd&—'F‚’À¢&W6–FVæ6U7FFS¢W6W#òç&W6–FVæ6U7FFRÇÂçVÆÂÀ¢6VÆdW†6ÇVFVEVçF–Ã¢W6W#òç6VÆdW†6ÇVFVEVçF–ÂÇÂçVÆÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6†V6²VÆ–v–&–Æ—G’ârÒ“°¢Ð§Ò“° ¢òò6VÆbÖW†6ÇW6–öââFVÆ–&W&FVÇ’öæR×v“¢Æ–W"6â7F'B÷"W‡FVæB—BÂ'W@¢òò6ææ÷B6†÷'FVâ—BF†V×6VÇfW2(	BF†B—2F†RVçF—&Rö–çBöbF†RFööÂà¦ç÷7B‚rö’÷W6W'2öÖR÷6VÆbÖW†6ÇVFRrÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BF—2ÒÖF‚æÖ–âƒ3cSÂÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òæF—2’ÇÂ3’’“°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢6öç7BVçF–ÂÒæWrFFR„FFRææ÷r‚’²F—2¢#B¢c¢c¢“°¢6öç7BW†—7F–ærÒW6W"ç6VÆdW†6ÇVFVEVçF–ÂòæWrFFR‡W6W"ç6VÆdW†6ÇVFVEVçF–Â’¢çVÆÃ°¢–b†W†—7F–ærbbW†—7F–ærâVçF–Â’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°¢ÖW76vS¢u–÷RÇ&VG’†fRÆöævW"6VÆbÖW†6ÇW6–öâ–âÆ6Râ6öçF7B7W÷'BFòF—67W72—BârÀ¢6öFS¢tÅ$TE•ôU„4ÅTDTEôÄôätU"rÀ¢6VÆdW†6ÇVFVEVçF–Ã¢W†—7F–ærÀ¢Ò“°¢Ð ¢W6W"ç6VÆdW†6ÇVFVEVçF–ÂÒVçF–Ã°¢W6W"ç6VÆdW†6ÇW6–öå&V6öâÒ7G&–ær‡&Wæ&öG“òç&V6öâÇÂrr’ç6Æ–6RƒÂ3“°¢v—BW6W"ç6fR‚“° ¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢u–÷W"6VÆbÖW†6ÇW6–öâ—27F—fRrÀ¢†VF–æs¢u4TÄbÔU„4ÅU4”ôâ5D•dRrÀ¢Æ–æW3¢°¢–÷Rv–ÆÂæ÷B&R&ÆRFòVçFW"–B6öçFW7G2VçF–ÂÇ7G&öæsâG·VçF–ÂçFôÆö6ÆTFFU7G&–ær‚—ÓÂ÷7G&öæsâæÀ¢tç’6ö–ç2Ç&VG’–â–÷W"vÆÆWB7F’F†W&RâF†—26ææ÷B&R&WfW'6VBV&Ç’g&öÒ–÷W"66÷VçB(	B6öçF7B7W÷'B–b–÷W"6—&7V×7Fæ6W26†ævRârÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6VÆdW†6ÇVFVEVçF–Ã¢VçF–ÂÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6VÆbÖW†6ÇW6–öâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6WB6VÆbÖW†6ÇW6–öâârÒ“°¢Ð§Ò“° ¢òòFW÷6—BÆ–Ö—G2Â–â6VçG2âÆ÷vW&–ærF¶W2VffV7B–ÖÖVF–FVÇ“²&—6–ær—0¢òòFVÆ–VB#F‚6òÆ–Ö—B6ææ÷B&R&VÖ÷fVB–âF†RÖöÖVçB—B7F'G2Fò&—FRà¦ç÷7B‚rö’÷W6W'2öÖRöFW÷6—BÖÆ–Ö—G2rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢6öç7BF–Ç’ÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òæF–Ç”6VçG2’ÇÂ’“°¢6öç7BÖöçF†Ç’ÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òæÖöçF†Ç”6VçG2’ÇÂ’“°¢6öç7B&—6–ærÒ†F–Ç’â‡W6W"æF–Ç”FW÷6—DÆ–Ö—D6VçG2ÇÂ’bb‡W6W"æF–Ç”FW÷6—DÆ–Ö—D6VçG2ÇÂ’â¢ÇÂ†ÖöçF†Ç’â‡W6W"æÖöçF†Ç”FW÷6—DÆ–Ö—D6VçG2ÇÂ’bb‡W6W"æÖöçF†Ç”FW÷6—DÆ–Ö—D6VçG2ÇÂ’â“° ¢–b‡&—6–ær’°¢&WGW&â&W2ç7FGW2ƒ#"’æ§6öâ‡°¢ÖW76vS¢t–æ7&V6W2F¶RVffV7BgFW"#B†÷W'2â–÷W"7W'&VçBÆ–Ö—B7F—2–âÆ6RVçF–ÂF†VâârÀ¢6öFS¢t”ä5$T4UõTäD”ärrÀ¢VffV7F—fTC¢æWrFFR„FFRææ÷r‚’²#B¢c¢c¢’À¢Ò“°¢Ð ¢W6W"æF–Ç”FW÷6—DÆ–Ö—D6VçG2ÒF–Ç“°¢W6W"æÖöçF†Ç”FW÷6—DÆ–Ö—D6VçG2ÒÖöçF†Ç“°¢v—BW6W"ç6fR‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²F–Ç”6VçG3¢F–Ç’ÂÖöçF†Ç”6VçG3¢ÖöçF†Ç’Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BWFFR–÷W"Æ–Ö—G2ârÒ“°¢Ð§Ò“° ¢òòÒÒÒff–Æ–FRF‚FWF–Ç2…rÓ’’ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòF†RF‚–B—2Væ7'—FVBB&W7BæBæWfW"&WGW&æVBâöæÇ’F†RÆ7BBF–v—G0¢òò&R&VF&ÆRÂv†–6‚—2ÆÂâFÖ–â67&VVâæVVG2à¦6öç7BVæ7'—EF„–BÒ‡fÇVR’Óâ°¢G'’°¢6öç7B¶W’Ò7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR…7G&–ær‡&ö6W72æVçbä¥uEõ4T5$UBÇÂvfÖÒr’’æF–vW7B‚“°¢6öç7B—dÆö6ÂÒ7'—Fòç&æFöÔ'—FW2ƒb“°¢6öç7B6—†W"Ò7'—Fòæ7&VFT6—†W&—b‚vW2Ó#SbÖ6&2rÂ¶W’Â—dÆö6Â“°¢&WGW&â—dÆö6ÂçFõ7G&–ær‚v†W‚r’²s¢r²'VffW"æ6öæ6B…¶6—†W"çWFFR…7G&–ær‡fÇVR’ÂwWFc‚r’Â6—†W"æf–æÂ‚•Ò’çFõ7G&–ær‚v†W‚r“°¢Ò6F6‚†W'&÷"’°¢&WGW&âçVÆÃ°¢Ð§Ó° ¦ç÷7B‚rö’öff–Æ–FW2öÖR÷F‚ÖFWF–Ç2rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tff–Æ–FR66÷VçBæ÷Bf÷VæBârÒ“° ¢6öç7B&t–BÒ7G&–ær‡&Wæ&öG“òçF„–BÇÂrr’ç&WÆ6R‚õµãÓ•ÒörÂrr“°¢6öç7BF„–EG—RÒ7G&–ær‡&Wæ&öG“òçF„–EG—RÇÂrr’çFõWW$66R‚“° ¢–b‡&t–Bbb&t–BæÆVæwF‚ÓÒ’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tU2F‚”B—2’F–v—G2ârÂ6öFS¢t”ådÄ”EõD…ô”BrÒ“°¢Ð¢–b‡&t–Bbb²u54ârÂtT”âuÒæ–æ6ÇVFW2‡F„–EG—R’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u7V6–g’v†WF†W"F†—2—2â54â÷"âT”âârÂ6öFS¢t”ådÄ”EõD…ô”EõE•RrÒ“°¢Ð ¢–b‡&t–B’°¢6öç7BVæ7'—FVBÒVæ7'—EF„–B‡&t–B“°¢–b‚Væ7'—FVB’&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B7F÷&RF†B6V7W&VÇ’âG'’v–âârÒ“°¢ff–Æ–FRçF„–DVæ7'—FVBÒVæ7'—FVC°¢ff–Æ–FRçF„–DÆ7CBÒ&t–Bç6Æ–6R‚ÓB“°¢ff–Æ–FRçF„–EG—RÒF„–EG—S°¢ff–Æ–FRçF„f÷&Õs•6–væVDBÒæWrFFR‚“°¢Ð ¢–b‡&Wæ&öG“òæÆVvÄæÖR’ff–Æ–FRçF„ÆVvÄæÖRÒ7G&–ær‡&Wæ&öG’æÆVvÄæÖR’ç6Æ–6RƒÂ#“°¢–b‡&Wæ&öG“òæ'W6–æW74æÖR’ff–Æ–FRçF„'W6–æW74æÖRÒ7G&–ær‡&Wæ&öG’æ'W6–æW74æÖR’ç6Æ–6RƒÂ#“°¢–b‡&Wæ&öG“òæFG&W72’ff–Æ–FRçF„FG&W72Ò7G&–ær‡&Wæ&öG’æFG&W72’ç6Æ–6RƒÂC“° ¢v—Bff–Æ–FRç6fR‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢uF‚FWF–Ç26fVBârÀ¢F„–DÆ7CC¢ff–Æ–FRçF„–DÆ7CBÇÂçVÆÂÀ¢s•6–væVDC¢ff–Æ–FRçF„f÷&Õs•6–væVDBÇÂçVÆÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uF‚FWF–Ç26fRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6fRF‚FWF–Ç2ârÒ“°¢Ð§Ò“° ¢òòFÖ–ã¢v†ò†27&÷76VBF†RCc“’F‡&W6†öÆBÂæBv†ò—2Ö—76–ærrÓ’à¦ævWB‚rö’öFÖ–âöff–Æ–FR×F‚×&W÷'BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–V"ÒçVÖ&W"‡&WçVW'’ç–V"’ÇÂæWrFFR‚’ævWDgVÆÅ–V"‚“°¢6öç7BF‡&W6†öÆD6VçG2ÒçVÖ&W"‡&ö6W72æVçbåD…ó“•õD…$U4„ôÄEô4TåE2ÇÂc“²òòCc ¢6öç7Bff–Æ–FW2Òv—Bff–Æ–FRæf–æB‡·Ò¢ç6VÆV7B‚uö–Bf—'7DæÖRÆ7DæÖRÆ–W$æÖRVÖ–ÂF„–DÆ7CBF„f÷&Õs•6–væVDBF„ÆVvÄæÖRV&æ–æw5—FD6VçG2F…–V"–÷WG2r¢æÆVâ‚“° ¢6öç7B&÷w2Òff–Æ–FW2æÖ‚†’Óâ°¢6öç7B–D6VçG2Ò†ç–÷WG2ÇÂµÒ¢æf–ÇFW"‚‡’Óâ7G&–ær‡òç7FGW2ÇÂrr’çFôÆ÷vW$66R‚’ÓÓÒw–Bp¢bbæWrFFR‡òæ7&VFVDBÇÂ’ævWDgVÆÅ–V"‚’ÓÓÒ–V"¢ç&VGV6R‚‡7VÒÂ’Óâ7VÒ²„çVÖ&W"‡æÖ÷VçB’ÇÂ’¢Â“°¢&WGW&â°¢ff–Æ–FT–C¢åö–BÀ¢æÖS¢çF„ÆVvÄæÖRÇÂçÆ–W$æÖRÇÂ¶æf—'7DæÖRÂæÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’À¢VÖ–Ã¢æVÖ–ÂÀ¢–D6VçG2À¢–C¢BG²‡–D6VçG2ò’çFôf—†VBƒ"—ÖÀ¢&WV—&W3““¢–D6VçG2ãÒF‡&W6†öÆD6VçG2À¢†5s“¢&ööÆVâ†çF„f÷&Õs•6–væVDBbbçF„–DÆ7CB’À¢F„–DÆ7CC¢çF„–DÆ7CBÇÂçVÆÂÀ¢Ó°¢Ò’æf–ÇFW"‚‡"’Óâ"ç–D6VçG2â“° ¢&÷w2ç6÷'B‚†Â"’Óâ"ç–D6VçG2Òç–D6VçG2“°¢6öç7B&Æö6¶VBÒ&÷w2æf–ÇFW"‚‡"’Óâ"ç&WV—&W3“’bb"æ†5s’“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢–V"À¢F‡&W6†öÆEW6C¢F‡&W6†öÆD6VçG2òÀ¢ff–Æ–FW3¢&÷w2À¢&WV—&–æs““¢&÷w2æf–ÇFW"‚‡"’Óâ"ç&WV—&W3“’’æÆVæwF‚À¢Ö—76–æus“¢&Æö6¶VBæÆVæwF‚À¢v&æ–æs¢&Æö6¶VBæÆVæwF‚òG¶&Æö6¶VBæÆVæwF‡Òff–Æ–FR‡2’æVVB“’'WB†fRæòrÓ’öâf–ÆRæ¢çVÆÂÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uF‚&W÷'Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B'V–ÆBF†RF‚&W÷'BârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòDU5DU"dTTD$4°¢òð¢òò¶WB6W&FRg&öÒ7W÷'BF–6¶WG2öâW'÷6Râ7W÷'BF–6¶WB—2&†VÇÖR"(	@¢òò—BæVVG2&WÇ’âFW7BfVVF&6²—2&†W&R—2v†B'&ö¶R"ÂæB—BæVVG2¢òòF–ffW&VçB6†S¢v†–6‚7FWÂv†B–÷RW‡V7FVBÂv†B†VæVBÂöâv†B†öæRà¢òð¢òòF†RW‡V7FVB×g2Ö7GVÂ—"—2F†Rv†öÆRö–çBâ$—Bw2'&ö¶Vâ"6ææ÷B&R7FV@¢òòöã²$’W‡V7FVB×’&Ææ6RFòG&÷SæB—BG&÷VB"6â&Rf—†VB–à¢òòÖ–çWFW2âF†RVæGö–çB6·2f÷"&÷F‚à¢òð¢òò÷VâFòwVW7G2†÷F–öæÅfW&–g•Fö¶Vâ’6òv†öWfW"—2FW7F–ærF†R6–væVBÖ÷W@¢òòW‡W&–Væ6R6â&W÷'BFöò(	BF†W’&RF†RöæW2v†ò6VRF†Rf—'7B–×&W76–öâà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BdTTD$4µô$T2Òö&¦V7Bæg&VW¦R…°¢w6–vçWrÂw6–væ–ârÂw66÷&V6&BrÂvVçG'’ÖfVRrÂwFVÒÖ6&BrÂw6V6öâÖ6&BrÀ¢w7FæF–æw2rÂvÆVwVW2rÂw&öÖ÷FW"×FööÇ2rÂvæ÷F–f–6F–öç2rÂv6ö–ç2×W&6†6RrÀ¢wvÆÆWBrÂv&VÂrÂw&Wv&G2rÂv&6²Ööff–6RrÂvÆöö·2×w&öærrÂw6Æ÷rrÂv÷F†W"rÀ¥Ò“°¦6öç7BdTTD$4µõ4UdU$•E’Òö&¦V7Bæg&VW¦R…²v&Æö6¶W"rÂww&öærrÂv6öægW6–ærrÂv6÷6ÖWF–2rÂw&—6RuÒ“° ¦6öç7BFW7FW$fVVF&6µ66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢&VfW&Væ6S¢²G—S¢7G&–ærÂVæ—VS¢G'VRÂ–æFWƒ¢G'VRÒÀ¢òòv†òÂ2Æö÷6VÇ’2÷76–&ÆR(	BFW7FW"6†÷VÆBæWfW"&R&Æö6¶VBg&öÐ¢òò&W÷'F–ær&V6W6RF†W’vW&R6–væVB÷WBv†Vâ—B†VæVBà¢W6W$–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&W÷'FVD'“¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&öÆS¢²G—S¢7G&–ærÂVçVÓ¢²wÆ–W"rÂvÆVwVRrÂvFÖ–ârÂvwVW7BuÒÂFVfVÇC¢wÆ–W"rÒÀ ¢&V¢²G—S¢7G&–ærÂFVfVÇC¢v÷F†W"rÒÀ¢6WfW&—G“¢²G—S¢7G&–ærÂFVfVÇC¢ww&öærrÂ–æFWƒ¢G'VRÒÀ¢7FW¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ ¢W‡V7FVC¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7GVÃ¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢67&VVç6†÷EW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ ¢òò6GW&VBWFöÖF–6ÆÇ’(	BFW7FW"6†÷VÆBæ÷B†fRFò¶æ÷rF†V—"÷vâ'&÷w6W"à¢FWf–6S¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢67&VVã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢Fƒ¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ ¢7FGW3¢²G—S¢7G&–ærÂVçVÓ¢²væWrrÂwG&–vVBrÂvf—†VBrÂwvöçFf—‚rÂv6ææ÷B×&W&öGV6RuÒÂFVfVÇC¢væWrrÂ–æFWƒ¢G'VRÒÀ¢÷væW$æ÷FS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7BFW7FW$fVVF&6²ÒÖöævö÷6RæÖöFVÇ2åFW7FW$fVVF&6²ÇÂÖöævö÷6RæÖöFVÂ‚uFW7FW$fVVF&6²rÂFW7FW$fVVF&6µ66†VÖ“° ¦ç÷7B‚rö’öfVVF&6²rÂ7V&Ö—DÆ–Ö—FW"Â÷F–öæÅfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7GVÂÒ7G&–ær‡&Wæ&öG“òæ7GVÂÇÂrr’çG&–Ò‚“°¢–b†7GVÂæÆVæwF‚Â2’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uFVÆÂW2v†B†VæVBârÂ6öFS¢t5ETÅõ$UT•$TBrÒ“°¢Ð ¢6öç7B&VfW&Væ6RÒtd"Òr²FFRææ÷r‚’çFõ7G&–ærƒ3b’çFõWW$66R‚’ç6Æ–6R‚Ób¢²rÒr²ÖF‚ç&æFöÒ‚’çFõ7G&–ærƒ3b’ç6Æ–6Rƒ"ÂR’çFõWW$66R‚“° ¢òò&W6öÇfRF†R&W÷'FW"g&öÒF†RFö¶Vâv†W&R÷76–&ÆRÂ6òF†R&W÷'B—0¢òòGG&–'WF&ÆRv—F†÷WB6¶–ærF†VÒFòG—RF†V—"÷vâVÖ–Âà¢ÆWB&W÷'FVD'’Ò7G&–ær‡&Wæ&öG“òç&W÷'FVD'’ÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂc“°¢ÆWB&öÆRÒvwVW7Bs°¢6öç7B6ÆÆW$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢–b†6ÆÆW$–B’°¢6öç7B66÷RÒ7G&–ær‡&WçW6W#òç66÷RÇÂrr’çG&–Ò‚“°¢&öÆRÒ66÷RÓÓÒvff–Æ–FRròvÆVwVRr¢wÆ–W"s°¢–b‚&W÷'FVD'’’°¢6öç7Bv†òÒ66÷RÓÓÒvff–Æ–FRp¢òv—Bff–Æ–FRæf–æD'”–B†6ÆÆW$–B’ç6VÆV7B‚vVÖ–ÂÆVwVTæÖRr’æÆVâ‚¢¢v—BW6W"æf–æD'”–B†6ÆÆW$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRr’æÆVâ‚“°¢&W÷'FVD'’Òv†óòæVÖ–ÂÇÂrs°¢Ð¢Ð ¢6öç7BF–6¶WBÒv—BFW7FW$fVVF&6²æ7&VFR‡°¢&VfW&Væ6RÀ¢W6W$–C¢6ÆÆW$–BÀ¢&W÷'FVD'’À¢&öÆRÀ¢&V¢dTTD$4µô$T2æ–æ6ÇVFW2…7G&–ær‡&Wæ&öG“òæ&V’’ò&Wæ&öG’æ&V¢v÷F†W"rÀ¢6WfW&—G“¢dTTD$4µõ4UdU$•E’æ–æ6ÇVFW2…7G&–ær‡&Wæ&öG“òç6WfW&—G’’’ò&Wæ&öG’ç6WfW&—G’¢ww&öærrÀ¢7FW¢7G&–ær‡&Wæ&öG“òç7FWÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂC’À¢W‡V7FVC¢7G&–ær‡&Wæ&öG“òæW‡V7FVBÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂ’À¢7GVÃ¢7GVÂç6Æ–6RƒÂ#’À¢67&VVç6†÷EW&Ã¢7G&–ær‡&Wæ&öG“òç67&VVç6†÷EW&ÂÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂS’À¢FWf–6S¢7G&–ær‡&Wæ&öG“òæFWf–6RÇÂ&Wæ†VFW'5²wW6W"ÖvVçBuÒÇÂrr’ç6Æ–6RƒÂ3’À¢67&VVã¢7G&–ær‡&Wæ&öG“òç67&VVâÇÂrr’ç6Æ–6RƒÂC’À¢Fƒ¢7G&–ær‡&Wæ&öG“òæF‚ÇÂrr’ç6Æ–6RƒÂ#’À¢Ò“° ¢òò&Æö6¶W"6†÷VÆBæ÷Bv—Bf÷"6öÖVöæRFò6†V6²F6†&ö&Bà¢–b‡F–6¶WBç6WfW&—G’ÓÓÒv&Æö6¶W"r’°¢G'’°¢v—BG&ç7÷'FW"ç6VæDÖ–Â‡°¢g&öÓ¢dÔÕôÔ”Åôe$ôÒÀ¢Fó¢õtäU%ôTÔ”ÂÀ¢7V&¦V7C¢$Äô4´U"g&öÒFW7F–ær(	BG·F–6¶WBç&VfW&Væ6WÖÀ¢‡FÖÃ¢ÆF—b7G–ÆSÒ&föçBÖfÖ–Ç“¤&–ÂÇ6ç2×6W&–b#à¢ÇãÇ7G&öæsâG¶W66T‡FÖÂ‡F–6¶WBæ&V—ÓÂ÷7G&öæsâG·F–6¶WBç7FWòr+r7FWr²W66T‡FÖÂ‡F–6¶WBç7FW’¢rwÓÂ÷à¢G·F–6¶WBæW‡V7FVBòÇãÆVÓäW‡V7FVC£ÂöVÓâG¶W66T‡FÖÂ‡F–6¶WBæW‡V7FVB—ÓÂ÷æ¢rwÐ¢ÇãÆVÓä†VæVC£ÂöVÓâG¶W66T‡FÖÂ‡F–6¶WBæ7GVÂ—ÓÂ÷à¢Ç7G–ÆSÒ&6öÆ÷#¢3ccc¶föçB×6—¦S£'‚#âG¶W66T‡FÖÂ‡F–6¶WBç&W÷'FVD'’ÇÂvwVW7Br—Ò+rG¶W66T‡FÖÂ‡F–6¶WBæFWf–6R—ÓÂ÷à¢ÂöF—cæÀ¢Ò“°¢Ò6F6‚†Ö–ÄW'&÷"’²ò¢æWfW"f–ÂF†R&W÷'B&V6W6RÖ–Âf–ÆVB¢òÐ¢Ð ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢&VfW&Væ6RÀ¢ÖW76vS¢uF†æ·2(	BÆövvVB2r²&VfW&Væ6R²rârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tfVVF&6²7V&Ö—76–öâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6fRF†BâG'’v–âÂ÷"FW‡B—BFòÖRârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–âöfVVF&6²rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7FGW2Ò7G&–ær‡&WçVW'’ç7FGW2ÇÂvæWrr“°¢6öç7BVW'’Ò7FGW2ÓÓÒvÆÂrò·Ò¢²7FGW2Ó°¢6öç7B—FV×2Òv—BFW7FW$fVVF&6²æf–æB‡VW'’¢ç6÷'B‡²6WfW&—G“¢Â7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ3’æÆVâ‚“°¢6öç7B6÷VçG2Òv—BFW7FW$fVVF&6²ævw&VvFR…°¢²Fw&÷W¢²ö–C¢rG6WfW&—G’rÂã¢²G7VÓ¢ÒÒÒÀ¢Ò“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6÷VçG3¢6÷VçG2ç&VGV6R‚†62Â&÷r’Óâ‡²ââæ62Â·&÷råö–EÓ¢&÷ræâÒ’Â·Ò’À¢—FV×2À¢Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBfVVF&6²ârÒ“°¢Ð§Ò“° ¦çF6‚‚rö’öFÖ–âöfVVF&6²ó¦–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæW‡BÒ7G&–ær‡&Wæ&öG“òç7FGW2ÇÂrr’çG&–Ò‚“°¢6öç7BÆÆ÷vVBÒ²væWrrÂwG&–vVBrÂvf—†VBrÂwvöçFf—‚rÂv6ææ÷B×&W&öGV6RuÓ°¢6öç7BWFFRÒ·Ó°¢–b†ÆÆ÷vVBæ–æ6ÇVFW2†æW‡B’’WFFRç7FGW2ÒæW‡C°¢–b‡G—Vöb&Wæ&öG“òæ÷væW$æ÷FRÓÓÒw7G&–ærr’WFFRæ÷væW$æ÷FRÒ&Wæ&öG’æ÷væW$æ÷FRç6Æ–6RƒÂ“°¢6öç7B—FVÒÒv—BFW7FW$fVVF&6²æf–æD'”–DæEWFFR‡&Wç&×2æ–BÂ²G6WC¢WFFRÒÂ²æWs¢G'VRÒ’æÆVâ‚“°¢–b‚—FVÒ’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&VfW&Væ6S¢—FVÒç&VfW&Væ6RÂ7FGW3¢—FVÒç7FGW2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BWFFRF†BârÒ“°¢Ð§Ò“° ¢òòD„Rô”åBôbÄÂD„•3¢Æ–â×FW‡BF–vW7BÂw&÷WVB'’6WfW&—G’ÂF†B6â&P¢òò6÷–VB7G&–v‡B–çFò6öçfW'6F–öâv—F‚v†öWfW"—2f—†–ærF†–æw2â¥4ôâ—2f÷ ¢òòÖ6†–æW3²F†—2—2f÷"7F–ærà¦ævWB‚rö’öFÖ–âöfVVF&6²öF–vW7BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7FGW2Ò7G&–ær‡&WçVW'’ç7FGW2ÇÂvæWrr“°¢6öç7BVW'’Ò7FGW2ÓÓÒvÆÂrò·Ò¢²7FGW2Ó°¢6öç7B—FV×2Òv—BFW7FW$fVVF&6²æf–æB‡VW'’’ç6÷'B‡²7&VFVDC¢Ò’æÆ–Ö—Bƒ3’æÆVâ‚“° ¢6öç7B÷&FW"Ò²v&Æö6¶W"rÂww&öærrÂv6öægW6–ærrÂv6÷6ÖWF–2rÂw&—6RuÓ°¢6öç7BÆ&VÂÒ°¢&Æö6¶W#¢t$Äô4´U%2(	B6÷VÆBæ÷B6öçF–çVRrÀ¢w&öæs¢uu$ôär(	B—BF–BF†Rw&öærF†–ærrÀ¢6öægW6–æs¢t4ôäeU4”är(	Bv÷&¶VBÂ'WBVæ6ÆV"rÀ¢6÷6ÖWF–3¢t4õ4ÔUD”2(	BÆöö·2öfbrÀ¢&—6S¢utõ$´TBtTÄÂrÀ¢Ó° ¢6öç7BÆ–æW2Ò°¢r2FW7FW"fVVF&6²(	Br²æWrFFR‚’çFô•4õ7G&–ær‚’ç6Æ–6RƒÂ’À¢rrÀ¢—FV×2æÆVæwF‚²r&W÷'Br²†—FV×2æÆVæwF‚ÓÓÒòrr¢w2r’²r‚r²7FGW2²r’rÀ¢rrÀ¢Ó° ¢÷&FW"æf÷$V6‚‚‡6Wb’Óâ°¢6öç7Bw&÷WÒ—FV×2æf–ÇFW"‚‡&÷r’Óâ&÷rç6WfW&—G’ÓÓÒ6Wb“°¢–b‚w&÷WæÆVæwF‚’&WGW&ã°¢Æ–æW2çW6‚‚r22r²Æ&VÅ·6WeÒ²r‚r²w&÷WæÆVæwF‚²r’rÂrr“°¢w&÷Wæf÷$V6‚‚‡&÷r’Óâ°¢Æ–æW2çW6‚‚r222r²&÷rç&VfW&Væ6R²r+rr²&÷ræ&V²‡&÷rç7FWòr+r7FWr²&÷rç7FW¢rr’“°¢–b‡&÷ræW‡V7FVB’Æ–æW2çW6‚‚rÒW‡V7FVC¢r²&÷ræW‡V7FVB“°¢Æ–æW2çW6‚‚rÒ†VæVC¢r²&÷ræ7GVÂ“°¢–b‡&÷ræF‚’Æ–æW2çW6‚‚rÒ67&VVã¢r²&÷ræF‚“°¢–b‡&÷rç67&VVç6†÷EW&Â’Æ–æW2çW6‚‚rÒ67&VVç6†÷C¢r²&÷rç67&VVç6†÷EW&Â“°¢Æ–æW2çW6‚‚rÒ&W÷'FW#¢r²‡&÷rç&W÷'FVD'’ÇÂvwVW7Br’²r‚r²&÷rç&öÆR²r’r“°¢òòFWf–6R7G&–ærG&–ÖÖVB(	BF†RgVÆÂW6W"ÖvVçB—2æö—6R–âF–vW7Bà¢6öç7BFWf–6RÒ7G&–ær‡&÷ræFWf–6RÇÂrr’ç&WÆ6R‚ôÖ÷¦–ÆÆÂõµÆBåÒ²òÂrr’ç6Æ–6RƒÂ““°¢–b†FWf–6R’Æ–æW2çW6‚‚rÒFWf–6S¢r²FWf–6R²‡&÷rç67&VVâòr+rr²&÷rç67&VVâ¢rr’“°¢Æ–æW2çW6‚‚rr“°¢Ò“°¢Ò“° ¢–b‚—FV×2æÆVæwF‚’Æ–æW2çW6‚‚uôæò&W÷'G2–WBåòr“° ¢&W2ç6WD†VFW"‚t6öçFVçBÕG—RrÂwFW‡B÷Æ–ã²6†'6WC×WFbÓ‚r“°¢&WGW&â&W2ç6VæB†Æ–æW2æ¦ö–â‚uÆâr’“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tfVVF&6²F–vW7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’ç6VæB‚t6÷VÆBæ÷B'V–ÆBF†RF–vW7Bâr“°¢Ð§Ò“° ¢òòÒÒÒ7W÷'BF–6¶WG2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B7W÷'EF–6¶WE66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢F–6¶WDçVÖ&W#¢²G—S¢7G&–ærÂVæ—VS¢G'VRÂ–æFWƒ¢G'VRÒÀ¢W6W$–C¢²G—S¢Ööævö÷6Rå66†VÖåG—W2äö&¦V7D–BÂ&Vc¢uW6W"rÂ–æFWƒ¢G'VRÒÀ¢VÖ–Ã¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂÆ÷vW&66S¢G'VRÂG&–Ó¢G'VRÂ–æFWƒ¢G'VRÒÀ¢æÖS¢7G&–ærÀ¢6FVv÷'“¢²G—S¢7G&–ærÂVçVÓ¢²w–ÖVçBrÂw66÷&–ærrÂv66÷VçBrÂvff–Æ–FRrÂv÷F†W"uÒÂFVfVÇC¢v÷F†W"rÒÀ¢7V&¦V7C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢ÖW76vS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢7FGW3¢²G—S¢7G&–ærÂVçVÓ¢²v÷VârÂv–å÷&öw&W72rÂw&W6öÇfVBrÂv6Æ÷6VBuÒÂFVfVÇC¢v÷VârÂ–æFWƒ¢G'VRÒÀ¢&–÷&—G“¢²G—S¢7G&–ærÂVçVÓ¢²vÆ÷rrÂvæ÷&ÖÂrÂv†–v‚uÒÂFVfVÇC¢væ÷&ÖÂrÒÀ¢&VÆFVD÷&FW$çVÖ&W#¢7G&–ærÀ¢&VÆFVDf–v‡D–C¢7G&–ærÀ¢&W7öç6W3¢·²&öG“¢7G&–ærÂg&öÔFÖ–ã¢&ööÆVâÂ7&VFVDC¢²G—S¢FFRÂFVfVÇC¢FFRææ÷rÒÕÒÀ¢&W6öÇfVDC¢FFRÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“°¦6öç7B7W÷'EF–6¶WBÒÖöævö÷6RæÖöFVÇ2å7W÷'EF–6¶WBÇÂÖöævö÷6RæÖöFVÂ‚u7W÷'EF–6¶WBrÂ7W÷'EF–6¶WE66†VÖ“° ¦ç÷7B‚rö’÷7W÷'B÷F–6¶WG2rÂ7V&Ö—DÆ–Ö—FW"Â÷F–öæÅfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG“òæVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B7V&¦V7BÒ7G&–ær‡&Wæ&öG“òç7V&¦V7BÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂ#“°¢6öç7BÖW76vRÒ7G&–ær‡&Wæ&öG“òæÖW76vRÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂS“°¢–b‚VÖ–ÂÇÂ7V&¦V7BÇÂÖW76vR’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tVÖ–ÂÂ7V&¦V7BæBÖW76vR&R&WV—&VBârÒ“°¢Ð ¢6öç7BF–6¶WDçVÖ&W"ÒtdÔÒÒr²FFRææ÷r‚’çFõ7G&–ærƒ3b’çFõWW$66R‚’²rÒr²ÖF‚ç&æFöÒ‚’çFõ7G&–ærƒ3b’ç6Æ–6Rƒ"Âb’çFõWW$66R‚“°¢6öç7B6FVv÷'’Ò²w–ÖVçBrÂw66÷&–ærrÂv66÷VçBrÂvff–Æ–FRrÂv÷F†W"uÒæ–æ6ÇVFW2…7G&–ær‡&Wæ&öG“òæ6FVv÷'’’¢ò&Wæ&öG’æ6FVv÷'’¢v÷F†W"s° ¢6öç7BF–6¶WBÒv—B7W÷'EF–6¶WBæ7&VFR‡°¢F–6¶WDçVÖ&W"À¢W6W$–C¢&WçW6W#òæ–BÇÂçVÆÂÀ¢VÖ–ÂÀ¢æÖS¢7G&–ær‡&Wæ&öG“òææÖRÇÂrr’ç6Æ–6RƒÂ#’À¢6FVv÷'’À¢7V&¦V7BÀ¢ÖW76vRÀ¢òòÖöæW’&ö&ÆV×2vòFòF†RF÷öbF†RVWVRà¢&–÷&—G“¢6FVv÷'’ÓÓÒw–ÖVçBròv†–v‚r¢væ÷&ÖÂrÀ¢&VÆFVD÷&FW$çVÖ&W#¢7G&–ær‡&Wæ&öG“òæ÷&FW$çVÖ&W"ÇÂrr’ç6Æ–6RƒÂc’À¢&VÆFVDf–v‡D–C¢7G&–ær‡&Wæ&öG“òæf–v‡D–BÇÂrr’ç6Æ–6RƒÂc’À¢Ò“° ¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢VÖ–ÂÀ¢7V&¦V7C¢vR&V6V—fVB–÷W"ÖW76vR(	BG·F–6¶WDçVÖ&W'ÖÀ¢†VF–æs¢u5Uõ%B$UTU5B$T4T•dTBrÀ¢Æ–æW3¢°¢–÷W"&VfW&Væ6R—2Ç7G&öæsâG·F–6¶WDçVÖ&W'ÓÂ÷7G&öæsââV÷FR—B–âç’&WÇ’æÀ¢7V&¦V7C¢G·7V&¦V7GÖÀ¢6FVv÷'’ÓÓÒw–ÖVçBp¢òu–ÖVçB—77VW2&R&–÷&—F—6VB(	BvRv–ÆÂ6öÖR&6²Fò–÷R26ööâ2vR6ââp¢¢uvRv–ÆÂ6öÖR&6²Fò–÷R26ööâ2vR6âârÀ¢ÒÀ¢Ò“° ¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢5Uõ%EôTÔ”ÂÀ¢7V&¦V7C¢²G¶6FVv÷'’çFõWW$66R‚—ÕÒG·F–6¶WDçVÖ&W'Ò(	BG·7V&¦V7GÖÀ¢†VF–æs¢täUr5Uõ%BD”4´UBrÀ¢Æ–æW3¢¶g&öÓ¢G¶VÖ–ÇÖÂ6FVv÷'“¢G¶6FVv÷'—ÖÂÖW76vUÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²F–6¶WDçVÖ&W"Â7FGW3¢F–6¶WBç7FGW2Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u7W÷'BF–6¶WBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B7V&Ö—B–÷W"&WVW7BârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–â÷7W÷'B÷F–6¶WG2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7FGW2Ò7G&–ær‡&WçVW'’ç7FGW2ÇÂv÷Vâr“°¢6öç7BVW'’Ò7FGW2ÓÓÒvÆÂrò·Ò¢²7FGW2Ó°¢6öç7BF–6¶WG2Òv—B7W÷'EF–6¶WBæf–æB‡VW'’’ç6÷'B‡²&–÷&—G“¢ÓÂ7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6÷VçC¢F–6¶WG2æÆVæwF‚ÂF–6¶WG2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöBF–6¶WG2ârÒ“°¢Ð§Ò“° ¦çF6‚‚rö’öFÖ–â÷7W÷'B÷F–6¶WG2ó¦–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BF–6¶WBÒv—B7W÷'EF–6¶WBæf–æD'”–B‡&Wç&×2æ–B“°¢–b‚F–6¶WB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uF–6¶WBæ÷Bf÷VæBârÒ“° ¢6öç7B&WÇ’Ò7G&–ær‡&Wæ&öG“òç&WÇ’ÇÂrr’çG&–Ò‚“°¢6öç7BæW‡E7FGW2Ò7G&–ær‡&Wæ&öG“òç7FGW2ÇÂrr’çFôÆ÷vW$66R‚“° ¢–b‡&WÇ’’°¢F–6¶WBç&W7öç6W2çW6‚‡²&öG“¢&WÇ’Âg&öÔFÖ–ã¢G'VRÒ“°¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢F–6¶WBæVÖ–ÂÀ¢7V&¦V7C¢&S¢G·F–6¶WBç7V&¦V7GÒ(	BG·F–6¶WBçF–6¶WDçVÖ&W'ÖÀ¢†VF–æs¢u$UÅ’e$ôÒ5Uõ%BrÀ¢Æ–æW3¢·&WÇ•ÒÀ¢Ò“°¢Ð¢–b…²v÷VârÂv–å÷&öw&W72rÂw&W6öÇfVBrÂv6Æ÷6VBuÒæ–æ6ÇVFW2†æW‡E7FGW2’’°¢F–6¶WBç7FGW2ÒæW‡E7FGW3°¢–b†æW‡E7FGW2ÓÓÒw&W6öÇfVBr’F–6¶WBç&W6öÇfVDBÒæWrFFR‚“°¢Ð¢v—BF–6¶WBç6fR‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²F–6¶WDçVÖ&W#¢F–6¶WBçF–6¶WDçVÖ&W"Â7FGW3¢F–6¶WBç7FGW2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BWFFRF†BF–6¶WBârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò”ÔTåBd”ÅU$RÄU%D”äp¢òòv—F†÷WBF†—2Â&ö6W76÷"÷WFvR—26–ÆVçB(	B–÷Rf–æB÷WBg&öÒæw'¢òò7W7FöÖW'2âÆW'G2&RF‡&÷GFÆVB6òöæR&B†÷W"6ææ÷BfÆööBF†R–æ&÷‚à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B–ÖVçDf–ÇW&U7FFRÒ²6÷VçC¢Âv–æF÷u7F'C¢FFRææ÷r‚’ÂÆ7DÆW'DC¢Ó°¦6öç7B”ÔTåEôd”ÅU$UõD…$U4„ôÄBÒçVÖ&W"‡&ö6W72æVçbå”ÔTåEôd”ÅU$UõD…$U4„ôÄBÇÂ2“°¦6öç7B”ÔTåEôd”ÅU$Uõt”äDõuôÕ2ÒçVÖ&W"‡&ö6W72æVçbå”ÔTåEôd”ÅU$Uõt”äDõuôÕ2ÇÂR¢c¢“°¦6öç7B”ÔTåEôÄU%Eô4ôôÄDõtåôÕ2ÒçVÖ&W"‡&ö6W72æVçbå”ÔTåEôÄU%Eô4ôôÄDõtåôÕ2ÇÂc¢c¢“° ¦6öç7B&V6÷&E–ÖVçDf–ÇW&RÒ†6öçFW‡BÒ·Ò’Óâ°¢6öç7Bæ÷rÒFFRææ÷r‚“°¢–b†æ÷rÒ–ÖVçDf–ÇW&U7FFRçv–æF÷u7F'Bâ”ÔTåEôd”ÅU$Uõt”äDõuôÕ2’°¢–ÖVçDf–ÇW&U7FFRæ6÷VçBÒ°¢–ÖVçDf–ÇW&U7FFRçv–æF÷u7F'BÒæ÷s°¢Ð¢–ÖVçDf–ÇW&U7FFRæ6÷VçB³Ò° ¢6öç7B÷fW%F‡&W6†öÆBÒ–ÖVçDf–ÇW&U7FFRæ6÷VçBãÒ”ÔTåEôd”ÅU$UõD…$U4„ôÄC°¢6öç7B6ööÆVDF÷vâÒæ÷rÒ–ÖVçDf–ÇW&U7FFRæÆ7DÆW'DBâ”ÔTåEôÄU%Eô4ôôÄDõtåôÕ3°¢–b‚÷fW%F‡&W6†öÆBÇÂ6ööÆVDF÷vâ’&WGW&ã° ¢–ÖVçDf–ÇW&U7FFRæÆ7DÆW'DBÒæ÷s°¢6öç7BÖ–çWFW2ÒÖF‚ç&÷VæB…”ÔTåEôd”ÅU$Uõt”äDõuôÕ2òc“°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢DÔ”åôÄU%EôTÔ”Å2À¢7V&¦V7C¢´ÄU%EÒG·–ÖVçDf–ÇW&U7FFRæ6÷VçGÒ–ÖVçBf–ÇW&W2–âG¶Ö–çWFW7ÒÖ–çWFW6À¢†VF–æs¢u”ÔTåBd”ÅU$U2DUDT5DTBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG·–ÖVçDf–ÇW&U7FFRæ6÷VçGÓÂ÷7G&öæsâ–ÖVçG2f–ÆVB–âF†RÆ7BG¶Ö–çWFW7ÒÖ–çWFW2æÀ¢uF†—2W7VÆÇ’ÖVç2&ö6W76÷"÷WFvR÷"7&VFVçF–Â&ö&ÆVÒâ7W7FöÖW'2&R&V–ærGW&æVBv’&–v‡Bæ÷rârÀ¢6öçFW‡Bæ÷&FW$çVÖ&W"òÖ÷7B&V6VçB÷&FW#¢G¶6öçFW‡Bæ÷&FW$çVÖ&W'Ö¢rrÀ¢6öçFW‡Bç&V6öâò&V6öâv—fVã¢G¶6öçFW‡Bç&V6öçÖ¢rrÀ¢t6†V6²–÷W"–ÖVçB&ö6W76÷"F6†&ö&BârÀ¢Òæf–ÇFW"„&ööÆVâ’À¢Ò“°§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòEUÄ”4DR44õTåB$UdTåD”ôà¢òò&Æö6·2F†Rö'f–÷W266W3¢&WW6–ærFWf–6Rf÷"6V6öæB6–vçW&öçW2Âæ@¢òòVÖ–ÂÆ–6–ær†vÖ–ÂF÷G2ò·Fw2’Fò&Vv—7FW"&æWr"66÷VçG2à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B6–vçWFWf–6U66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢FWf–6T–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢æ÷&ÖÆ—¦VDVÖ–Ã¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢W6W$–C¢²G—S¢Ööævö÷6Rå66†VÖåG—W2äö&¦V7D–BÂ&Vc¢uW6W"rÒÀ¢—¢7G&–ærÀ¢66÷VçD6÷VçC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“°¦6öç7B6–vçWFWf–6RÒÖöævö÷6RæÖöFVÇ2å6–vçWFWf–6RÇÂÖöævö÷6RæÖöFVÂ‚u6–vçWFWf–6RrÂ6–vçWFWf–6U66†VÖ“° ¢òòvÖ–ÂG&VG2F÷G2æB·Fw22F†R6ÖR–æ&÷‚Â6ò&æ"·„vÖ–Âæ6öÒ"æ@¢òò&$vÖ–Âæ6öÒ"&RöæRW'6öââæ÷&ÖÆ—6R&Vf÷&R6ö×&–ærà¦6öç7Bæ÷&ÖÆ—¦TVÖ–Äf÷$GWW2Ò†VÖ–Â’Óâ°¢6öç7B&rÒ7G&–ær†VÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B¶Æö6ÂÂFöÖ–åÒÒ&rç7Æ—B‚tr“°¢–b‚Æö6ÂÇÂFöÖ–â’&WGW&â&s°¢6öç7B&6RÒÆö6Âç7Æ—B‚r²r•³Ó°¢6öç7B—4vöövÆRÒ²vvÖ–Âæ6öÒrÂvvöövÆVÖ–Âæ6öÒuÒæ–æ6ÇVFW2†FöÖ–â“°¢&WGW&âG¶—4vöövÆRò&6Rç&WÆ6R‚õÂâörÂrr’¢&6WÔG¶FöÖ–çÖ°§Ó° ¦6öç7BÔ…ô44õTåE5õU%ôDUd”4RÒçVÖ&W"‡&ö6W72æVçbäÔ…ô44õTåE5õU%ôDUd”4RÇÂ"“° ¢òò&WGW&ç2&Æö6¶–ær&V6öâÂ÷"çVÆÂv†VâF†R6–vçWÆöö·2ÆVv—F–ÖFRà¦6öç7B6†V6´GWÆ–6FU6–vçWÒ7–æ2‡²VÖ–ÂÂFWf–6T–BÂ—Ò’Óâ°¢6öç7Bæ÷&ÖÆ—¦VDVÖ–ÂÒæ÷&ÖÆ—¦TVÖ–Äf÷$GWW2†VÖ–Â“° ¢òòv3¢F—66&FVBf–æDöæR‚’–ÖÖVF–FVÇ’föÆÆ÷vVB'’âVæ6öæF—F–öæÀ¢òògVÆÂÖ6öÆÆV7F–öâVÖ–Â66â‡WFòSFö72’öâUdU%’6–vçWGFV×B(	@¢òòöæRv7FVB&÷VæBG&—ÇW2Æ&vRöæRÂ&÷F‚&Vf÷&RF†RW6W"w266÷VçB—0¢òòWfVâ7&VFVBâöâÆ&vRW6W"&6RF†—2—26Æ÷rVæ÷Vv‚FòF–ÖR÷WBF†P¢òòv†öÆR÷&Vv—7FW"&WVW7Böâ6W'fW&ÆW72Âv†–6‚—2v†B&6âwB6–vâW ¢òò&W÷'G2G&6VB&6²FòâVW'’—2æ÷rF—&V7B†æòv7FVB6ÆÂ’ÂæB6V@¢òòv—F‚†&BF–ÖV÷WB6ò6Æ÷r66âf–Ç2õTâ–ç7FVBöb†æv–ær6–vçWà¢6öç7BÆ–4ÖF6‚Òv—B&öÖ—6Rç&6R…°¢W6W"æf–æB‡·Ò’ç6VÆV7B‚vVÖ–Âr’æÆ–Ö—BƒS’æÆVâ‚¢çF†Vâ‚†6æF–FFW2’Óâ6æF–FFW2æf–æB‚‡R’Óâæ÷&ÖÆ—¦TVÖ–Äf÷$GWW2‡RæVÖ–Â’ÓÓÒæ÷&ÖÆ—¦VDVÖ–Â’’À¢æWr&öÖ—6R‚‡&W6öÇfR’Óâ6WEF–ÖV÷WB‚‚’Óâ&W6öÇfR†çVÆÂ’Â#S’’À¢Ò’æ6F6‚‚‚’ÓâçVÆÂ“° ¢–b†Æ–4ÖF6‚’°¢&WGW&â°¢6öFS¢tEUÄ”4DUôTÔ”ÅôÄ”2rÀ¢ÖW76vS¢tâ66÷VçBÇ&VG’W†—7G2f÷"F†—2VÖ–ÂFG&W72ârÀ¢Ó°¢Ð ¢–b†FWf–6T–B’°¢6öç7B6VVâÒv—B6–vçWFWf–6Ræf–æB‡²FWf–6T–BÒ’æÆVâ‚’æ6F6‚‚‚’ÓâµÒ“°¢–b‡6VVâæÆVæwF‚ãÒÔ…ô44õTåE5õU%ôDUd”4R’°¢&WGW&â°¢6öFS¢tDUd”4UôÄ”Ô•Eõ$T4„TBrÀ¢ÖW76vS¢uF†—2FWf–6R†2Ç&VG’&VVâW6VBFò7&VFRâ66÷VçBâ6öçF7B7W÷'B–b–÷R&VÆ–WfRF†—2—2w&öærârÀ¢Ó°¢Ð¢Ð¢&WGW&âçVÆÃ°§Ó° ¢òò6ÆÆVBgFW"7V66W76gVÂ6–vçW6òF†RFWf–6R—2&VÖVÖ&W&VBà¦6öç7B&V6÷&E6–vçWFWf–6RÒ7–æ2‡²VÖ–ÂÂFWf–6T–BÂ—ÂW6W$–BÒ’Óâ°¢–b‚FWf–6T–B’&WGW&ã°¢G'’°¢v—B6–vçWFWf–6Ræ7&VFR‡°¢FWf–6T–BÀ¢æ÷&ÖÆ—¦VDVÖ–Ã¢æ÷&ÖÆ—¦TVÖ–Äf÷$GWW2†VÖ–Â’À¢W6W$–C¢W6W$–BÇÂçVÆÂÀ¢—¢7G&–ær†—ÇÂrr’ç6Æ–6RƒÂcB’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRçv&â‚u6–vçWFWf–6R&V6÷&Bf–ÆVC¢rÂW'&÷"æÖW76vR“°¢Ð§Ó° ¢òòVæGö–çBF†R6ÆÇ2$Tdõ$R7&VF–ærâ66÷VçBÂ6ò&Æö6¶VB6–vçWf–Ç0¢òòf7B–ç7FVBöb†ÆbÖ7&VF–ærW6W"à¦ç÷7B‚rö’öWF‚ö6†V6²ÖGWÆ–6FRrÂ7V&Ö—DÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG“òæVÖ–ÂÇÂrr’çG&–Ò‚“°¢–b‚VÖ–Â’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tVÖ–Â—2&WV—&VBârÒ“°¢6öç7B&Æö6¶VBÒv—B6†V6´GWÆ–6FU6–vçW‡°¢VÖ–ÂÀ¢FWf–6T–C¢7G&–ær‡&Wæ&öG“òæFWf–6T–BÇÂrr’ç6Æ–6RƒÂ#‚’À¢—¢&Wæ†VFW'5²w‚Öf÷'v&FVBÖf÷"uÒÇÂ&Wç6ö6¶WCòç&VÖ÷FTFG&W72À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÆÆ÷vVC¢&Æö6¶VBÀ¢6öFS¢&Æö6¶VCòæ6öFRÇÂçVÆÂÀ¢ÖW76vS¢&Æö6¶VCòæÖW76vRÇÂtÆöö·2vööBârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢òòf–Â÷Vâ(	BæWfW"&Æö6²&VÂ6–vçW&V6W6RF†—26†V6²W'&÷&VBà¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ÆÆ÷vVC¢G'VRÒ“°¢Ð§Ò“° ¢òòFÖ–âf–WröbFWf–6W2F–VBFòÖ÷&RF†âöæR66÷VçBà¦ævWB‚rö’öFÖ–âöGWÆ–6FR×6–vçW2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&÷w2Òv—B6–vçWFWf–6Rævw&VvFR…°¢²Fw&÷W¢²ö–C¢rFFWf–6T–BrÂ66÷VçG3¢²G7VÓ¢ÒÂVÖ–Ç3¢²FFEFõ6WC¢rFæ÷&ÖÆ—¦VDVÖ–ÂrÒÂÆ7E6VVã¢²FÖƒ¢rF7&VFVDBrÒÒÒÀ¢²FÖF6ƒ¢²66÷VçG3¢²FwC¢ÒÒÒÀ¢²G6÷'C¢²66÷VçG3¢ÓÂÆ7E6VVã¢ÓÒÒÀ¢²FÆ–Ö—C¢#ÒÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²6÷VçC¢&÷w2æÆVæwF‚ÂFWf–6W3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B'V–ÆBF†RGWÆ–6FR&W÷'BârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòtÄÄUB5TäE2bD”Å’$Ut$@¢òò&–6W2Æ—fR„U$RÂæ÷B–âF†R&WVW7BâF†R6VæG2W'÷6RÂæWfW"6÷7B(	@¢òò÷F†W'v—6R6ÆÆW"6WG2F†V—"÷vâ&–6Rf÷"7G&V²6fRà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7BtÄÄUEõ5TäEõ$”4U2Òö&¦V7Bæg&VW¦R‡°¢7G&Vµ÷6fS¢²&6S¢SÂfÕÇW3¢#RÂÆ&VÃ¢u7G&V²6fRrÒÀ¢6¶—÷v—C¢²&6S¢sRÂfÕÇW3¢sRÂÆ&VÃ¢u6¶—F†Rv—BrÒÀ§Ò“° ¦ç÷7B‚rö’÷vÆÆWB÷7VæBrÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BW'÷6RÒ7G&–ær‡&Wæ&öG“òçW'÷6RÇÂrr’çG&–Ò‚“°¢6öç7B&–6RÒtÄÄUEõ5TäEõ$”4U5·W'÷6UÓ°¢–b‚&–6R’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uVæ¶æ÷vâW&6†6RârÂ6öFS¢uTä´äõtåõU%õ4RrÒ“°¢Ð ¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢òòdÒ²&–6–ær—2FV6–FVB'’F†R6W'fW"g&öÒF†R&VÂ7V'67&—F–öâ7FFRà¢6öç7B—57V'67&–&VBÒ&ööÆVâ‡W6W"æ—57V'67&–&VB“°¢6öç7B6÷7BÒ—57V'67&–&VBò&–6RæfÕÇW2¢&–6Ræ&6S° ¢6öç7B&Ææ6T&Vf÷&RÒçVÖ&W"ç'6T–çB…7G&–ær‡W6W"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢–b†&Ææ6T&Vf÷&RÂ6÷7B’°¢&WGW&â&W2ç7FGW2ƒC"’æ§6öâ‡°¢ÖW76vS¢æ÷BVæ÷Vv‚dÒ6ö–ç2f÷"G·&–6RæÆ&VÂçFôÆ÷vW$66R‚—ÒæÀ¢6öFS¢t”å5Tdd”4”TåEôeTäE2rÀ¢&Ææ6S¢&Ææ6T&Vf÷&RÀ¢6÷7BÀ¢6†÷'FfÆÃ¢6÷7BÒ&Ææ6T&Vf÷&RÀ¢Ò“°¢Ð ¢6öç7B&Ææ6TgFW"Ò&Ææ6T&Vf÷&RÒ6÷7C°¢òòFöÖ–3¢öæÇ’Æ–W2–bFö¶Vç27F–ÆÂWVÇ2v†BvR&VBâ6öæ7W'&Vç@¢òò&WVW7BF†BÇ&VG’7VçB6†ævW2F†RfÇVRÂ6òF†—2ÖF6†W2æ÷F†–ærà¢6öç7BÆ–VBÒv—BW6W"æf–æDöæTæEWFFR€¢²ö–C¢W6W$–BÂFö¶Vç3¢7G&–ær†&Ææ6T&Vf÷&R’ÒÀ¢²Fö¶Vç3¢7G&–ær†&Ææ6TgFW"’ÒÀ¢²æWs¢G'VRÐ¢“°¢–b‚Æ–VB’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°¢ÖW76vS¢u–÷W"&Ææ6R§W7B6†ævVBâÆV6RG'’v–âârÀ¢6öFS¢t$Ää4Uô4„ätTBrÀ¢Ò“°¢Ð ¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–BÀ¢ÖF6„–C¢W'÷6RÀ¢6÷W&6UG—S¢vÖF6‚rÀ¢G—S¢td”t…EôTåE%’rÀ¢Ö÷VçC¢Ö6÷7BÀ¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W“¢7VæC¢G·W'÷6WÓ¢G·W6W$–GÓ¢G´FFRææ÷r‚—ÖÀ¢ÖWFFF¢²W'÷6RÂÆ&VÃ¢&–6RæÆ&VÂÂfÕÇW3¢—57V'67&–&VBÒÀ¢ÕÒ“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢W'÷6RÀ¢6÷7BÀ¢6ö–ç3¢&Ææ6TgFW"À¢7G&V´W‡—&W4–ã¢W'÷6RÓÓÒw7G&Vµ÷6fRrò#B¢3c¢VæFVf–æVBÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uvÆÆWB7VæBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6ö×ÆWFRF†BW&6†6RârÒ“°¢Ð§Ò“° ¢òòF–Ç’&Wv&Bâ6W'fW"÷vç2F†Röæ6R×W"ÖF’'VÆR(	B6Æ–VçB×6–FR6†V6²—0¢òòG&—f–ÆÇ’'—76VB'’6ÆV&–ærÆö6Â7F÷&vRà¦6öç7BD”Å•õ$Ut$Eô4ô”å2ÒçVÖ&W"‡&ö6W72æVçbäD”Å•õ$Ut$Eô4ô”å2ÇÂ#R“° ¦ç÷7B‚rö’÷&Wv&G2ö6Æ–ÒÖF–Ç’rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“° ¢6öç7Bæ÷rÒæWrFFR‚“°¢6öç7BÆ7BÒW6W"æÆ7DF–Ç•&Wv&DBòæWrFFR‡W6W"æÆ7DF–Ç•&Wv&DB’¢çVÆÃ°¢–b†Æ7B’°¢6öç7B6ÖTF’ÒÆ7BçFôFFU7G&–ær‚’ÓÓÒæ÷rçFôFFU7G&–ær‚“°¢–b‡6ÖTF’’°¢6öç7BFöÖ÷'&÷rÒæWrFFR†æ÷r“²FöÖ÷'&÷rç6WD†÷W'2ƒ#BÂÂÂ“°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°¢ÖW76vS¢u–÷R†fRÇ&VG’6Æ–ÖVBFöF’â6öÖR&6²FöÖ÷'&÷rârÀ¢6öFS¢tÅ$TE•ô4Ä”ÔTBrÀ¢æW‡D6Æ–ÔC¢FöÖ÷'&÷rÀ¢Ò“°¢Ð¢òò6öç6V7WF—fRÖF’7G&V²Â&W6WB–bF’v2Ö—76VBà¢6öç7B–W7FW&F’ÒæWrFFR†æ÷r“²–W7FW&F’ç6WDFFR‡–W7FW&F’ævWDFFR‚’Ò“°¢W6W"æF–Ç•&Wv&E7G&V²ÒÆ7BçFôFFU7G&–ær‚’ÓÓÒ–W7FW&F’çFôFFU7G&–ær‚¢ò„çVÖ&W"‡W6W"æF–Ç•&Wv&E7G&V²’ÇÂ’²¢¢°¢ÒVÇ6R°¢W6W"æF–Ç•&Wv&E7G&V²Ò°¢Ð ¢6öç7B7G&V²ÒçVÖ&W"‡W6W"æF–Ç•&Wv&E7G&V²’ÇÂ°¢òò6ÖÆÂ7G&V²&öçW2Â6VB6ò—B6ææ÷B'Vâv’à¢6öç7B6ö–ç2ÒD”Å•õ$Ut$Eô4ô”å2²ÖF‚æÖ–âƒsRÂ‡7G&V²Ò’¢R“° ¢6öç7B&Ææ6T&Vf÷&RÒçVÖ&W"ç'6T–çB…7G&–ær‡W6W"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢6öç7B&Ææ6TgFW"Ò&Ææ6T&Vf÷&R²6ö–ç3°¢òòFöÖ–26Æ–Ó¢ÖF6†W2öæÇ’v†–ÆRÆ7DF–Ç•&Wv&DB—27F–ÆÂF†RfÇVRvP¢òò&VBÂ6ò6V6öæB6–×VÇFæV÷W2Ff–æG2æ÷F†–æræB6ææ÷BF÷V&ÆRÖ7&VF—Bà¢6öç7B6Æ–ÖVBÒv—BW6W"æf–æDöæTæEWFFR€¢²ö–C¢W6W$–BÂÆ7DF–Ç•&Wv&DC¢Æ7BÇÂ²F–ã¢¶çVÆÂÂVæFVf–æVEÒÒÒÀ¢²Fö¶Vç3¢7G&–ær†&Ææ6TgFW"’ÂÆ7DF–Ç•&Wv&DC¢æ÷rÂF–Ç•&Wv&E7G&V³¢W6W"æF–Ç•&Wv&E7G&V²ÒÀ¢²æWs¢G'VRÐ¢“°¢–b‚6Æ–ÖVB’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°¢ÖW76vS¢u–÷R†fRÇ&VG’6Æ–ÖVBFöF’ârÀ¢6öFS¢tÅ$TE•ô4Ä”ÔTBrÀ¢Ò“°¢Ð ¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR…·°¢W6W$–BÀ¢ÖF6„–C¢vF–Ç’×&Wv&BrÀ¢6÷W&6UG—S¢vÖF6‚rÀ¢G—S¢td”t…EôTåE%•õ$TeTäBrÀ¢Ö÷VçC¢6ö–ç2À¢&Ææ6T&Vf÷&RÀ¢&Ææ6TgFW"À¢–FV×÷FVæ7”¶W“¢F–Ç“¢G·W6W$–GÓ¢G¶æ÷rçFô•4õ7G&–ær‚’ç6Æ–6RƒÂ—ÖÀ¢ÖWFFF¢²7G&V²ÒÀ¢ÕÒ“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ6ö–ç3¢&Ææ6TgFW"Âv&FVC¢6ö–ç2Â7G&V²Ò“°¢Ò6F6‚†W'&÷"’°¢–b†W'&÷#òæ6öFRÓÓÒ’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ÖW76vS¢u–÷R†fRÇ&VG’6Æ–ÖVBFöF’ârÂ6öFS¢tÅ$TE•ô4Ä”ÔTBrÒ“°¢Ð¢6öç6öÆRæW'&÷"‚tF–Ç’&Wv&Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6Æ–Ò–÷W"&Wv&BârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòäõD”d”4D”ôâ$TB5DDP¢òòF†R&FvRv26ÆV&VB–â†öæRÖVÖ÷'’öæÇ’Â6ò—B&VV&VBöâWfW'’&V÷Và¢òòæBÆ–W'2ÆV&æVBFò–væ÷&R—Bâ7F÷&R&VBF–ÖW7F×W"W6W"–ç7FVBà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’÷W6W'2öÖRöæ÷F–f–6F–öç2÷&VBrÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B&VDBÒæWrFFR‚“°¢6öç7BW6W"Òv—BW6W"æf–æD'”–DæEWFFR€¢W6W$–BÀ¢²æ÷F–f–6F–öç5&VDC¢&VDBÒÀ¢²æWs¢G'VRÂ6VÆV7C¢væ÷F–f–6F–öç5&VDBrÐ¢“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uW6W"æ÷Bf÷VæBârÒ“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂæ÷F–f–6F–öç5&VDC¢&VDBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tÖ&¶–æræ÷F–f–6F–öç2&VBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BWFFRæ÷F–f–6F–öç2ârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòDTÔò4$B(	B6öÖWF†–ærf÷"FW7FW'2Fò7GVÆÇ’7VæB6ö–ç2öà¢òð¢òòFW7B66÷VçG2v—F‚#RÃ6ö–ç2&RW6VÆW72v–ç7BâV×G’FF&6RâF†—0¢òò6VVG2gVÆÂ6&B6òFW7FW"6âW†W&6—6RWfW'’F‚v—F†÷WBv—F–ærf÷"¢òò&VÂf–v‡Bæ–v‡C ¢òð¢òòÒöæRW6öÖ–ærf–v‡B–âV6‚öbF†Rf—fRF—66—Æ–æW2ÂÖ—†VBg&VRæB–@¢òòÒöæRf–v‡BÅ$TE’44õ$TBÂ6ò&W7VÇG2Â7FæF–æw2æB'&W7VÇG2&R–â ¢òòæ÷F–f–6F–öç2v÷&²F†RÖöÖVçBF†W’6–vâ–â&F†W"F†âgFW"6WGFÆP¢òòÒÆVwVRF†W’6â¦ö–à¢òòÒFVÒ6&B÷fW"F†RW6öÖ–ær&÷WG2ÂæBg&VR6V6öâ6&@¢òð¢òòvFVB&V†–æBF†R6ÖRDU5Eô44õTåE5ôTä$ÄTB7v—F6‚Â6ò—B6ææ÷B7&VFP¢òòf–7F–öæÂf–v‡G2öâ&öGV7F–öâà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BDTÔõõDrÒu´DTÔõÒs° ¢òò&÷VæB7FG2–âF†R6†RF†R66÷&V6&G2æB6V6öâõFVÒ66÷&–ærÇ&VG’&VBà¦6öç7BFVÖõ&÷VæG2Ò†fÖ–Ç’Â&÷VæG2Â&–2Ò’Óâ'&’æg&öÒ‡²ÆVæwFƒ¢&÷VæG2ÒÂ…òÂ–æFW‚’Óâ°¢6öç7B"Ò–æFW‚²°¢–b†fÖ–Ç’ÓÓÒv&÷†–ærr’°¢&WGW&â°¢&÷VæC¢"À¢…¢ÖF‚ç&÷VæB‚ƒB²"¢"’¢&–2’À¢%¢ÖF‚ç&÷VæB‚ƒ’²"’¢&–2’À¢E¢ÖF‚ç&÷VæB‚ƒ3²"¢2’¢&–2’À¢%s¢&–2ãÒbb"R"ÓÓÒò¢À¢´ó¢À¢Ó°¢Ð¢–b†fÖ–Ç’ÓÓÒww&W7FÆ–ærr’°¢&WGW&â²&÷VæC¢"Â4”s¢ÖF‚ç&÷VæBƒ2¢&–2’Âäc¢ÖF‚ç&÷VæBƒ"¢&–2’Â%c¢ÖF‚ç&÷VæBƒ"¢&–2’Â”ã¢Ó°¢Ð¢&WGW&â°¢&÷VæC¢"À¢5C¢ÖF‚ç&÷VæB‚ƒ#"²"¢2’¢&–2’À¢´“¢ÖF‚ç&÷VæB‚ƒb²"’¢&–2’À¢´ã¢ÖF‚ç&÷VæBƒ"¢&–2’À¢TÃ¢ÖF‚ç&÷VæBƒ¢&–2’À¢%s¢&–2ãÒbb"R"ÓÓÒò¢À¢´ó¢À¢Ó°§Ò“° ¢òò7F¶W2ÆFFW"Âæ÷Bf—fRæV"Ö–FVçF–6ÂfVW2âF†RF÷'Vær—2FVÆ–&W&FVÇ’¢òòÆ&vR6†&RöbF†R7F'F–ær&Ææ6R6òVçFW&–ær—B—2â7GVÂFV6—6–öâ(	@¢òòv†–6‚—2F†RöæÇ’v’FW7FW"&V†fW2Æ–¶RÆ–W"à¦6öç7BDTÔõô4$BÒö&¦V7Bæg&VW¦R…°¢òòg&VS¢ç–öæR6âVçFW"ÂFW7G2F†RæòÖ6öç6–FW&F–öâF‚à¢²6C¢v¶–6¶&÷†–ærrÂ¢u4ôÔ4„’UD4‚rÂ#¢tÄ%2T”DRrÂ&÷VæG3¢2ÂfVS¢ÂF—3¢2ÒÀ¢òò6†V¢VçFW"v—F†÷WBF†–æ¶–ærà¢²6C¢ww&W7FÆ–ærrÂ¢uD„R$4„•DT5BrÂ#¢t´”BE”äÔòrÂ&÷VæG3¢ÂfVS¢ÂF—3¢BÒÀ¢òòÖ–C¢v÷'F‚Æöö²BF†R÷Bf—'7Bà¢²6C¢v&&V¶çV6¶ÆRrÂ¢tEU5E’t„TTÄU"rÂ#¢tÔ$5U2däRrÂ&÷VæG3¢RÂfVS¢SÂF—3¢RÒÀ¢òòÖ–âWfVçBv—F‚uT$åDTTB÷BF†R&öÖ÷FW"†27F¶VBâVçG&–W2f–ÆÂ—C°¢òò7B'&V²ÖWfVâF†R&öÖ÷FW"&öf—G2âF†—2—2F†R6†F÷rf–v‡BÖV6†æ–2Â6ð¢òòFW7FW'2W†W&6—6R—B&F†W"F†âÖö6¶VB×WçVÖ&W"à¢°¢6C¢v&÷†–ærrÂ¢t•$ôâ¤4µ4ôârÂ#¢tDU…DU"dôÄBrÂ&÷VæG3¢"ÂfVS¢SÂF—3¢bÀ¢fVGW&VC¢G'VRÂ÷EF&vWC¢#Â&öÖ÷FW%7F¶S¢#À¢ÒÀ¢òò†–v‚&öÆÆW#¢6W&–÷W26†&RöbF†R7F6²âFW7G2F†R6†÷'FfÆÂwV&BFöò(	@¢òò–bFöòfWrVçFW"Â—B×W7Bfö–BæB&VgVæB&F†W"F†â’F†–â&—¦Rà¢²6C¢vÖÖrÂ¢u$dTÂÔTäDU2rÂ#¢t4ôÄR%$ää”târÂ&÷VæG3¢2ÂfVS¢CÂF—3¢rÂÖ–æ–×VÔVçG&çG3¢BÒÀ¥Ò“° ¦ç÷7B‚rö’öFÖ–âöFVÖòÖ6&BrÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7&VFVBÒ²W6öÖ–æs¢µÒÂ66÷&VC¢çVÆÂÂÆVwVS¢çVÆÂÂFVÔ6öçFW7C¢çVÆÂÂ6V6öã¢çVÆÂÓ° ¢òòâW6öÖ–ærf–v‡G2ÂöæRW"F—66—Æ–æRâFFVB–âF†RgWGW&R6òVçG'’—0¢òò÷Vâ(	B—4f–v‡D÷Väf÷$VçG'’Æö6·2öâÖF6„FFRà¢f÷"†6öç7B7V2öbDTÔõô4$B’°¢6öç7BÖF6„æÖRÒG´DTÔõõDwÒG·7V2æÒg2G·7V2æ'Ö°¢6öç7BW†—7F–ærÒv—BÖF6‚æf–æDöæR‡²ÖF6„æÖRÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b†W†—7F–ær’²7&VFVBçW6öÖ–ærçW6‚‡²–C¢W†—7F–æråö–BÂæÖS¢ÖF6„æÖRÂ&WW6VC¢G'VRÒ“²6öçF–çVS²Ð ¢6öç7BÖF6„FFRÒæWrFFR„FFRææ÷r‚’²7V2æF—2¢ƒcC“°¢6öç7Bf–v‡BÒv—BÖF6‚æ7&VFR‡°¢ÖF6„æÖRÀ¢ÖF6„6FVv÷'“¢7V2æ6BÀ¢ÖF6„f–v‡FW$¢7V2æÀ¢ÖF6„f–v‡FW$#¢7V2æ"À¢ÖF6„FFRÀ¢ÖF6…F–ÖS¢s#£rÀ¢Ö…&÷VæG3¢7V2ç&÷VæG2À¢ÖF6…Fö¶Vç3¢7V2æfVRÀ¢ÖF6…7FGW3¢v7F—fRrÀ¢ÖF6…6†F÷u7FGW3¢v7F—fRrÀ¢òòFVfVÇBÆ÷rVæ÷Vv‚F†B†æFgVÂöbFW7FW'26ÆV'2—BÂ'WBF†R†–v€¢òò&öÆÆW"6WG2—G2÷vâ6òF†Rfö–BÖæB×&VgVæBwV&BvWG2W†W&6—6VBà¢Ö–æ–×VÔVçG&çG3¢7V2æÖ–æ–×VÔVçG&çG2óò"À¢WFõ&VgVæD–e6†÷'C¢G'VRÀ¢òòFV6Æ&VB÷BF†R&öÖ÷FW"†2WBWâVçG&–W2f–ÆÂ—C²F†R&öÖ÷FW ¢òòF¶W2F†R7W'ÇW27B'&V²ÖWfVâà¢âââ‡7V2ç÷EF&vWBò²÷EF&vWC¢7V2ç÷EF&vWBÂ÷C¢7V2ç÷EF&vWBÒ¢·Ò’À¢âââ‡7V2ç&öÖ÷FW%7F¶Rò²&öÖ÷FW%7F¶S¢7V2ç&öÖ÷FW%7F¶RÒ¢·Ò’À¢fVGW&VEF†—5vVV³¢&ööÆVâ‡7V2æfVGW&VB’À¢fVçVS¢tFVÖò&VærÀ¢ÖF6„FW67&—F–öã¢u6VVFVBFVÖòf–v‡Bf÷"F†R&—fFRFW7F–ærw&÷WârÀ¢Ò“°¢7&VFVBçW6öÖ–ærçW6‚‡²–C¢f–v‡Båö–BÂæÖS¢ÖF6„æÖRÂ6FVv÷'“¢7V2æ6BÂfVS¢7V2æfVRÂ&WW6VC¢fÇ6RÒ“° ¢òò¶VWF†R&÷7FW"–â7FWÂ6òf–v‡FW"&öf–ÆW2W†—7Bf÷"F†W6RæÖW2à¢G'’°¢v—BW6W'Df–v‡FW%&öf–ÆR‡²æÖS¢7V2æÂ7÷'C¢7V2æ6BÒ“°¢v—BW6W'Df–v‡FW%&öf–ÆR‡²æÖS¢7V2æ"Â7÷'C¢7V2æ6BÒ“°¢Ò6F6‚‡&÷7FW$W'&÷"’²ò¢æöâÖfFÂ¢òÐ¢Ð ¢òò"âöæRf–v‡BÇ&VG’–âF†R7Bt•D‚7FG2Â6òFW7FW"6VW2f–æ—6†V@¢òò&W7VÇB–ÖÖVF–FVÇ’–ç7FVBöbv—F–ærf÷"6öÖVöæRFò6WGFÆR6öÖWF†–ærà¢6öç7B66÷&VDæÖRÒG´DTÔõõDwÒd”5Dõ"„ÄRg2ôÔ"4”f°¢ÆWB66÷&VBÒv—BÖF6‚æf–æDöæR‡²ÖF6„æÖS¢66÷&VDæÖRÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b‚66÷&VB’°¢66÷&VBÒv—BÖF6‚æ7&VFR‡°¢ÖF6„æÖS¢66÷&VDæÖRÀ¢ÖF6„6FVv÷'“¢vÖÖrÀ¢ÖF6„f–v‡FW$¢ud”5Dõ"„ÄRrÀ¢ÖF6„f–v‡FW$#¢tôÔ"4”brÀ¢ÖF6„FFS¢æWrFFR„FFRææ÷r‚’Ò"¢ƒcC’À¢Ö…&÷VæG3¢2À¢ÖF6…Fö¶Vç3¢À¢ÖF6…7FGW3¢vf–æ—6†VBrÀ¢ÖF6…6†F÷u7FGW3¢v7F—fRrÀ¢Ö–æ–×VÔVçG&çG3¢À¢fVçVS¢tFVÖò&VærÀ¢ÔÔÖF6ƒ¢°¢f–v‡FW$öæU7FG3¢FVÖõ&÷VæG2‚vÖÖrÂ2ÂãR’À¢f–v‡FW%Gvõ7FG3¢FVÖõ&÷VæG2‚vÖÖrÂ2ÂãƒR’À¢ÒÀ¢Ò“°¢Ð¢7&VFVBç66÷&VBÒ²–C¢66÷&VBåö–BÂæÖS¢66÷&VDæÖRÓ° ¢òò2âÆVwVRFò¦ö–ââGF6†VBFòF†Rf—'7BFW7BÆVwVR66÷VçB–böæP¢òòW†—7G2Â6òF†R&öÖ÷FW"æVÂ†26öÖWF†–ær&VÂ&V†–æB—Bà¢òò7&VBF†Rf–v‡G27&÷72F†RÆVwVR66÷VçG2âöæR&öÖ÷FW"÷væ–ærÆÂ6—€¢òò6ææ÷B6†÷rv†BÆ–W"6VW2v†VâGvòÆVwVW2&öÖ÷FRF†R6ÖRæ–v‡Bà¢6öç7BÆVwVT÷væW'2Òv—Bff–Æ–FRæf–æB‡²—5FW7D66÷VçC¢G'VRÒ¢ç6VÆV7B‚uö–BÆVwVTæÖRr’ç6÷'B‡²7&VFVDC¢Ò’æÆVâ‚“°¢–b†ÆVwVT÷væW'2æÆVæwF‚’°¢7&VFVBæÆVwVRÒ²–C¢ÆVwVT÷væW'5³Òåö–BÂæÖS¢ÆVwVT÷væW'5³ÒæÆVwVTæÖRÓ°¢7&VFVBæÆVwVW2ÒÆVwVT÷væW'2æÖ‚‡&÷r’Óâ‡²–C¢&÷råö–BÂæÖS¢&÷ræÆVwVTæÖRÒ’“°¢6öç7BFVÖôf–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢f÷"†ÆWB’Ò²’ÂFVÖôf–v‡G2æÆVæwFƒ²’³Ò’°¢6öç7B÷væW"ÒÆVwVT÷væW'5¶’RÆVwVT÷væW'2æÆVæwF…Ó°¢v—BÖF6‚çWFFTöæR‡²ö–C¢FVÖôf–v‡G5¶•Òåö–BÒÂ²G6WC¢²ff–Æ–FT–C¢7G&–ær†÷væW"åö–B’ÒÒ“°¢Ð¢Ð ¢òò6"âdTEU$RdÄu2âv—F†÷WBF†W6RF†Rw2$fVGW&VBF†—2vVV²"æ@¢òò$fVGW&VBf–v‡B"6V7F–öç2†fRæ÷F†–ærFò&VæFW"ÂæBF†RvV'6—FRw0¢òò&öÖ÷FVBÖf–v‡G2VW'’(	Bv†–6‚f–ÇFW'2öâ†öÖWvU&öÖ÷FVBð¢òòfVGW&VEF†—5vVV²òfVGW&VDf–v‡B(	B&WGW&ç2âV×G’Æ—7BâF†R6VV@¢òò7&VFVBf–v‡G2'WBæWfW"fÆvvVBç’Â6ò&÷F‚7W&f6W2Æöö¶VB'&ö¶Và¢òòv†–ÆRF†RFFv27GVÆÇ’F†W&Rà¢°¢6öç7B6VVFVBÒv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò¢ç6VÆV7B‚uö–BÖF6„FFRr’ç6÷'B‡²ÖF6„FFS¢Ò’æÆVâ‚“°¢–b‡6VVFVBæÆVæwF‚’°¢òòf—'7BW6öÖ–ær&÷WB6'&–W2F†R&–r6&C²6V6öæBf–ÆÇ2F†R6ö×7@¢òòfVGW&VBÖf–v‡B7G&—â&÷F‚&R†öÖWvR×&öÖ÷FVB6òF†RvV'6—FR6†÷w0¢òòF†VÒFöòà¢v—BÖF6‚çWFFTöæR‡²ö–C¢6VVFVE³Òåö–BÒÂ°¢G6WC¢²fVGW&VEF†—5vVV³¢G'VRÂ†öÖWvU&öÖ÷FVC¢G'VRÒÀ¢Ò“°¢–b‡6VVFVE³Ò’°¢v—BÖF6‚çWFFTöæR‡²ö–C¢6VVFVE³Òåö–BÒÂ°¢G6WC¢²fVGW&VDf–v‡C¢G'VRÂ†öÖWvU&öÖ÷FVC¢G'VRÒÀ¢Ò“°¢Ð¢òòWfW'—F†–ærVÇ6R7F–ÆÂV'2–âF†R÷VâÖ6&G2w&–Bà¢6öç7B&W7BÒ6VVFVBç6Æ–6Rƒ"’æÖ‚‡&÷r’Óâ&÷råö–B“°¢–b‡&W7BæÆVæwF‚’°¢v—BÖF6‚çWFFTÖç’‡²ö–C¢²F–ã¢&W7BÒÒÂ²G6WC¢²†öÖWvU&öÖ÷FVC¢G'VRÒÒ“°¢Ð¢7&VFVBæfVGW&VBÒ°¢fVGW&VEF†—5vVV³¢7G&–ær‡6VVFVE³Òåö–B’À¢fVGW&VDf–v‡C¢6VVFVE³Òò7G&–ær‡6VVFVE³Òåö–B’¢çVÆÂÀ¢†öÖWvU&öÖ÷FVC¢6VVFVBæÆVæwF‚À¢Ó°¢Ð¢Ð ¢òòBâFVÒ6&B÷fW"F†RW6öÖ–ær&÷WG2âæVVG2BÆV7B2Öç’&÷WG20¢òò–6·2Âv†–6‚—2v‡’ÆÂf—fRF—66—Æ–æW2&R6VVFVBà¢6öç7BW6öÖ–æt–G2Ò7&VFVBçW6öÖ–æræÖ‚‡&÷r’Óâ7G&–ær‡&÷ræ–B’“°¢–b…DTÕô4$E5ôTä$ÄTBbbW6öÖ–æt–G2æÆVæwF‚ãÒR’°¢6öç7BæÖRÒG´DTÔõõDwÒf–v‡Bæ–v‡BFVÒ6&F°¢ÆWB6öçFW7BÒv—BFVÔ6öçFW7Bæf–æDöæR‡²æÖRÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b‚6öçFW7B’°¢6öçFW7BÒv—BFVÔ6öçFW7Bæ7&VFR‡°¢æÖRÀ¢WfVçDæÖS¢tFVÖòf–v‡Bæ–v‡BrÀ¢f–v‡D–G3¢W6öÖ–æt–G2À¢–6·5&WV—&VC¢RÀ¢òòg&VRÂ6òæö&öG’—2&Æö6¶VB'’7FFR'VÆRv†–ÆRFW7F–ærà¢VçG'”fVS¢À¢ff–Æ–FT–C¢ÆVwVT÷væW"ò7G&–ær†ÆVwVT÷væW"åö–B’¢rrÀ¢Ò“°¢Ð¢7&VFVBçFVÔ6öçFW7BÒ²–C¢6öçFW7Båö–BÂæÖRÓ°¢Ð ¢òòRâg&VR6V6öâÂG&gF–ær÷VâÂ6ò6V6öâ6&G26â&RW†W&6—6VBFöòà¢–b…4T4ôåô4$E5ôTä$ÄTB’°¢6öç7BæÖRÒG´DTÔõõDwÒFW7B6V6öæ°¢ÆWB6V6öâÒv—B6V6öâæf–æDöæR‡²æÖRÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b‚6V6öâ’°¢6V6öâÒv—B6V6öâæ7&VFR‡°¢æÖRÀ¢FW67&—F–öã¢u6VVFVB6V6öâf÷"F†R&—fFRFW7F–ærw&÷WârÀ¢7F'G4C¢æWrFFR„FFRææ÷r‚’ÒƒcC’À¢VæG4C¢æWrFFR„FFRææ÷r‚’²3¢ƒcC’À¢G&gD6Æ÷6W4C¢æWrFFR„FFRææ÷r‚’²"¢ƒcC’À¢VçG'”fVS¢À¢7FGW3¢tE$eEôõTârÀ¢Ò“°¢Ð¢7&VFVBç6V6öâÒ²–C¢6V6öâåö–BÂæÖRÓ°¢Ð ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢6öç6öÆRçv&â†¶FVÖòÖ6&EÒ6VVFVB'’FÖ–âG·&WæFÖ–ãòæ–BÇÂwVæ¶æ÷vâwÖ“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢7&VFVBÀ¢æW‡C¢°¢uFW7FW'26âæ÷rVçFW"f–v‡G2–âÆÂf—fRF—66—Æ–æW2ârÀ¢töæRf–v‡B—2Ç&VG’66÷&VBÂ6ò&W7VÇG2æB7FæF–æw2v÷&²–ÖÖVF–FVÇ’ârÀ¢7&VFVBçFVÔ6öçFW7Bòtg&VRFVÒ6&B—2÷Vâ÷fW"F†Rf—fRW6öÖ–ær&÷WG2âr¢uFVÒ6&G2&RF—6&ÆVBârÀ¢7&VFVBç6V6öâòtg&VR6V6öâ—2÷Vâf÷"G&gF–ærâr¢u6V6öâ6&G2&RF—6&ÆVBârÀ¢ÒÀ¢&VÖ–æFW#¢u'VâDTÄUDRö’öFÖ–âöFVÖòÖ6&B&Vf÷&Rvö–ærÆ—fRârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tFVÖò6&B6VVBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6VVBF†RFVÖò6&BârÂFWF–Ã¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð§Ò“° ¢òòÆ—fR÷B7FFRf÷"F†RFVÖò6&BâF†Rv†öÆRö–çBöb7F¶W2ÆFFW"—2F†@¢òòFW7FW'2vF6‚F†R÷BÖ÷fR2V÷ÆRVçFW"(	Bv—F†÷WBF†—2F†W’v÷VÆB†fRFð¢òòF¶R—BöâG'W7Bà¦ævWB‚rö’÷V&Æ–2öFVÖòÖ6&B÷÷G2rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò¢ç6VÆV7B‚vÖF6„æÖRÖF6„6FVv÷'’ÖF6…Fö¶Vç2÷B÷EF&vWB&öÖ÷FW%7F¶RÖ–æ–×VÔVçG&çG2ÖF6„FFR&—¦W56WGFÆVDBr¢ç6÷'B‡²ÖF6„FFS¢Ò’æÆVâ‚“°¢–b‚f–v‡G2æÆVæwF‚’&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂf–v‡G3¢µÒÒ“° ¢6öç7B–G2Òf–v‡G2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢òòVçG'’6÷VçG2g&öÒF†R&VÂ66÷&R&÷w2Â6òF†RçVÖ&W"6ææ÷BG&–gBg&öÐ¢òòv†B6WGFÆVÖVçBv–ÆÂ7GVÆÇ’6VRà¢6öç7B6÷VçG2Òv—B66÷&Rævw&VvFR…°¢²FÖF6ƒ¢²ÖF6„–C¢²F–ã¢–G2ÒÂ&VgVæFVC¢²FæS¢G'VRÒÒÒÀ¢²Fw&÷W¢²ö–C¢rFÖF6„–BrÂVçG&–W3¢²G7VÓ¢ÒÒÒÀ¢Ò“°¢6öç7B'”f–v‡BÒæWrÖ†6÷VçG2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷ræVçG&–W5Ò’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢f–v‡G3¢f–v‡G2æÖ‚†f–v‡B’Óâ°¢6öç7BVçG&–W2Ò'”f–v‡BævWB…7G&–ær†f–v‡Båö–B’’ÇÂ°¢6öç7BfVRÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ“°¢6öç7B6öÆÆV7FVBÒVçG&–W2¢fVS°¢6öç7BwV&çFVVBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷EF&vWB’ÇÂ“°¢6öç7BÖ–æ–×VÒÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡BæÖ–æ–×VÔVçG&çG2’ÇÂ“°¢&WGW&â°¢–C¢f–v‡Båö–BÀ¢æÖS¢7G&–ær†f–v‡BæÖF6„æÖR’ç&WÆ6R„DTÔõõDrÂrr’çG&–Ò‚’À¢6FVv÷'“¢f–v‡BæÖF6„6FVv÷'’À¢VçG'”fVS¢fVRÀ¢VçG&–W2À¢òòv†Bv–ææW"v÷VÆB7GVÆÇ’&RÆ––ærf÷"&–v‡Bæ÷rà¢Æ—fU÷C¢wV&çFVVBâòÖF‚æÖ‚†wV&çFVVBÂ6öÆÆV7FVB’¢6öÆÆV7FVBÀ¢wV&çFVVE÷C¢wV&çFVVBÇÂçVÆÂÀ¢òò†öæW7B&÷WBv†WF†W"F†—26öçFW7B6â’–WBà¢VçG&–W4æVVFVC¢ÖF‚æÖ‚ƒÂÖ–æ–×VÒÒVçG&–W2’À¢v–ÆÅfö–D–e6WGFÆVDæ÷s¢Ö–æ–×VÒâbbVçG&–W2ÂÖ–æ–×VÒÀ¢6WGFÆVC¢&ööÆVâ†f–v‡Bç&—¦W56WGFÆVDB’À¢Ó°¢Ò’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tFVÖò÷B7FFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB÷B7FFRârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòd5BÔdõ%t$B(	B6öÆÆ6Rv†öÆRf–v‡Bæ–v‡B–çFòöæR6ÆÀ¢òð¢òòFW7FW'26†÷VÆBæ÷B†fRFòv—BF—2Fò6VR66÷&RâF†—2f–ÆÇ2–âöff–6–À¢òò&÷VæB7FG2ÂÖ÷fW2F†RFVÖòf–v‡G2–çFòF†R7BÂæB6WGFÆW2WfW'—F†–ærÂ6ð¢òòö–çG2Â&—¦W2æB7FæF–æw2ÆÂV"–ÖÖVF–FVÇ’à¢òð¢òò—B6WGFÆW2F‡&÷Vv‚F†R$TÂVæGö–çB&F†W"F†â6†÷'F7WB(	BF†RFÖ–âw2÷và¢òòWF†÷&—¦F–öâ†VFW"—2f÷'v&FVBFòõ5Bö’öFÖ–âöf–v‡G2ó¦–B÷6WGFÆRâF†@¢òòÖGFW'3¢FVÖòF‚F†Bf¶W26WGFÆVÖVçBv÷VÆB&÷fRæ÷F†–ær&÷WBF†R6öFP¢òòF†Bv–ÆÂ7GVÆÇ’’V÷ÆRà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7BFVÖõFu&VvW‚Ò‚’ÓâæWr&VtW‡‚uåÅÂr²DTÔõõDrç&WÆ6R‚õµµÅÕÒörÂuÅÂBbr’“° ¢òò6WG2F†RfVGW&RfÆw2öâÇ&VG’×6VVFVBFVÖòf–v‡G2âF†Rf—'7BfW'6–öâöbF†P¢òò6VVB7&VFVBf–v‡G2'WBæWfW"fÆvvVBç’Â6òFF&6R6VVFVB&Vf÷&RF†—0¢òò6†÷w2V×G’$fVGW&VBF†—2vVV²"æB$fVGW&VBf–v‡B"6V7F–öç2–âF†Ræ@¢òòâV×G’&öÖ÷FVBÆ—7BöâF†RvV'6—FR(	BF†RFFv2f–æRÂæ÷F†–ærv2fÆvvVBà¦ç÷7B‚rö’öFÖ–âöFVÖòÖ6&B÷&W—"ÖfVGW&VBrÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6VVFVBÒv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò¢ç6VÆV7B‚uö–BÖF6„æÖRÖF6„FFRr’ç6÷'B‡²ÖF6„FFS¢Ò’æÆVâ‚“°¢–b‚6VVFVBæÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæòFVÖòf–v‡G2f÷VæB(	B6VVBF†R6&Bf—'7BârÒ“°¢Ð¢v—BÖF6‚çWFFTöæR‡²ö–C¢6VVFVE³Òåö–BÒÂ²G6WC¢²fVGW&VEF†—5vVV³¢G'VRÂ†öÖWvU&öÖ÷FVC¢G'VRÒÒ“°¢–b‡6VVFVE³Ò’°¢v—BÖF6‚çWFFTöæR‡²ö–C¢6VVFVE³Òåö–BÒÂ²G6WC¢²fVGW&VDf–v‡C¢G'VRÂ†öÖWvU&öÖ÷FVC¢G'VRÒÒ“°¢Ð¢v—BÖF6‚çWFFTÖç’‡²ö–C¢²F–ã¢6VVFVBæÖ‚‡&÷r’Óâ&÷råö–B’ÒÒÂ²G6WC¢²†öÖWvU&öÖ÷FVC¢G'VRÒÒ“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢fVGW&VEF†—5vVV³¢6VVFVE³ÒæÖF6„æÖRÀ¢fVGW&VDf–v‡C¢6VVFVE³Òò6VVFVE³ÒæÖF6„æÖR¢çVÆÂÀ¢†öÖWvU&öÖ÷FVC¢6VVFVBæÆVæwF‚À¢ÖW76vS¢tfVGW&VBfÆw26WBâ&VÆöBF†RæBF†RvV'6—FRârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&W—"fVGW&VBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6WBF†RfVGW&VBfÆw2ârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–âöFVÖòÖ6&Böf7BÖf÷'v&BrÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò¢ç6VÆV7B‚uö–BÖF6„æÖRÖF6„6FVv÷'’Ö…&÷VæG2&—¦W56WGFÆVDBr’æÆVâ‚“°¢–b‚f–v‡G2æÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæòFVÖòf–v‡G2f÷VæBâ6VVBF†R6&Bf—'7BârÂ6öFS¢täõôDTÔõô4$BrÒ“°¢Ð ¢6öç7B&W&VBÒµÓ°¢f÷"†6öç7Bf–v‡Böbf–v‡G2’°¢–b†f–v‡Bç&—¦W56WGFÆVDB’²&W&VBçW6‚‡²æÖS¢f–v‡BæÖF6„æÖRÂ6¶—VC¢vÇ&VG’6WGFÆVBrÒ“²6öçF–çVS²Ð¢6öç7BfÖ–Ç’Ò7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚’æ–æ6ÇVFW2‚v&÷‚r¢ÇÂ7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚’æ–æ6ÇVFW2‚v¶çV6¶ÆRr’òv&÷†–ærp¢¢7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚’æ–æ6ÇVFW2‚ww&W7FÂr’òww&W7FÆ–ærr¢vÖÖs°¢6öç7B&÷VæG2ÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡BæÖ…&÷VæG2’ÇÂ2“° ¢òòf–v‡FW"6Æ–v‡FÇ’†VBÂ6òF†W&R—26ÆV"v–ææW"Fò&VBà¢6öç7BWFFRÒ°¢òò–âF†R7BÂ6òF†Rf–v‡B&VG226ö×ÆWFRæBVçG'’—2Æö6¶VBà¢ÖF6„FFS¢æWrFFR„FFRææ÷r‚’Ò3c’À¢ÖF6…7FGW3¢vf–æ—6†VBrÀ¢Ó°¢6öç7B7FG4&Æö6²Ò°¢f–v‡FW$öæU7FG3¢FVÖõ&÷VæG2†fÖ–Ç’Â&÷VæG2Âã"’À¢f–v‡FW%Gvõ7FG3¢FVÖõ&÷VæG2†fÖ–Ç’Â&÷VæG2ÂãƒR’À¢Ó°¢–b†fÖ–Ç’ÓÓÒv&÷†–ærr’WFFRä&÷†–ætÖF6‚Ò7FG4&Æö6³°¢VÇ6RWFFRäÔÔÖF6‚Ò7FG4&Æö6³° ¢v—BÖF6‚çWFFTöæR‡²ö–C¢f–v‡Båö–BÒÂ²G6WC¢WFFRÒ“°¢&W&VBçW6‚‡²–C¢7G&–ær†f–v‡Båö–B’ÂæÖS¢f–v‡BæÖF6„æÖRÒ“°¢Ð ¢òò6WGFÆRF‡&÷Vv‚F†R&VÂ&÷WFRÂf÷'v&F–ærF†R6ÆÆW"w2÷vâFÖ–âFö¶Vâà¢6öç7B&6RÒG·&Wç&÷Fö6öÇÓ¢òòG·&WævWB‚v†÷7Br—Ö°¢6öç7BWF„†VFW"Ò&Wæ†VFW'2æWF†÷&—¦F–öâÇÂrs°¢6öç7B6WGFÆVBÒµÓ°¢f÷"†6öç7BVçG'’öb&W&VB’°¢–b‚VçG'’æ–B’6öçF–çVS°¢G'’°¢6öç7B&W7öç6RÒv—BfWF6‚†G¶&6WÒö’öFÖ–âöf–v‡G2òG¶VçG'’æ–GÒ÷6WGFÆVÂ°¢ÖWF†öC¢uõ5BrÀ¢†VFW'3¢²WF†÷&—¦F–öã¢WF„†VFW"Ât6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢Ò“°¢6öç7B–ÆöBÒv—B&W7öç6Ræ§6öâ‚’æ6F6‚‚‚’Óâ‡·Ò’“°¢6WGFÆVBçW6‚‡²æÖS¢VçG'’ææÖRÂ7FGW3¢&W7öç6Rç7FGW2Â–C¢–ÆöCòç–÷WBóò–ÆöCòç&—¦UööÅ–BóòçVÆÂÒ“°¢Ò6F6‚†W'&÷"’°¢6WGFÆVBçW6‚‡²æÖS¢VçG'’ææÖRÂW'&÷#¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð¢Ð ¢òòFVÒ6&G26WGFÆRöæ6RWfW'’&÷WBöâF†R6&B—266÷&VBÂv†–6‚†2§W7@¢òò†VæVB(	B6òF†W’6â&R7vWBæ÷r&F†W"F†âv—F–ærf÷"F†R7&öâà¢6öç7BFVÕ&W7VÇG2ÒµÓ°¢–b…DTÕô4$E5ôTä$ÄTB’°¢6öç7B6öçFW7G2Òv—BFVÔ6öçFW7Bæf–æB‡²æÖS¢FVÖõFu&VvW‚‚’Â7FGW3¢²F–ã¢²tõTârÂtÄô4´TBuÒÒÒ’ç6VÆV7B‚uö–BæÖRr’æÆVâ‚“°¢f÷"†6öç7B6öçFW7Böb6öçFW7G2’°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆUFVÔ6öçFW7B…7G&–ær†6öçFW7Båö–B’“°¢FVÕ&W7VÇG2çW6‚‡²æÖS¢6öçFW7BææÖRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢FVÕ&W7VÇG2çW6‚‡²æÖS¢6öçFW7BææÖRÂW'&÷#¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð¢Ð¢Ð ¢òò6V6öç2æVVBFò&R%Tää”är&Vf÷&RF†W’6â6WGFÆRà¢6öç7B6V6öå&W7VÇG2ÒµÓ°¢–b…4T4ôåô4$E5ôTä$ÄTB’°¢6öç7B6V6öç2Òv—B6V6öâæf–æB‡²æÖS¢FVÖõFu&VvW‚‚’Â7FGW3¢²F–ã¢²tE$eEôõTârÂu%Tää”äruÒÒÒ’ç6VÆV7B‚uö–BæÖRr’æÆVâ‚“°¢f÷"†6öç7B6V6öâöb6V6öç2’°¢G'’°¢v—B6V6öâçWFFTöæR‡²ö–C¢6V6öâåö–BÒÂ²G6WC¢²7FGW3¢u%Tää”ärrÒÒ“°¢6öç7B7VÖÖ'’Òv—B6WGFÆU6V6öâ…7G&–ær‡6V6öâåö–B’“°¢6V6öå&W7VÇG2çW6‚‡²æÖS¢6V6öâææÖRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6V6öå&W7VÇG2çW6‚‡²æÖS¢6V6öâææÖRÂW'&÷#¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð¢Ð¢Ð ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢f–v‡G3¢6WGFÆVBÀ¢FVÔ6öçFW7G3¢FVÕ&W7VÇG2À¢6V6öç3¢6V6öå&W7VÇG2À¢æW‡C¢uFW7FW'26âæ÷r6VRF†V—"66÷&W2æB7FæF–æw2â6ÆÂö’öFÖ–âöFVÖòÖ6&B÷&WÆ’Fò&W6WBæBvòv–âârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tFVÖòf7BÖf÷'v&Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf7BÖf÷'v&Bf–ÆVBârÂFWF–Ã¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò$UÄ’(	B&W6WBF†RFVÖò6&B6òF†R6ÖRFW7FW'26âvòv–à¢òð¢òò6ÆV'2WfW'’FVÖòVçG'’Â&V÷Vç2F†Rf–v‡G2v—F‚g&W6‚gWGW&RFFW2Âv—W2F†P¢òò6WGFÆVÖVçB7F×2ÂæBF÷2F†RFW7B66÷VçG2&6²WâF÷V6†W2öæÇ’´DTÔõÐ¢òòf–v‡G2æBöæÇ’—5FW7D66÷VçBÆ–W'2à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–âöFVÖòÖ6&B÷&WÆ’rÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6ö–ç2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæ6ö–ç2óòDU5Eô44õTåEõ5D%Eô4ô”å2’’“°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6„æÖS¢FVÖõFu&VvW‚‚’Ò’ç6VÆV7B‚uö–BÖF6„æÖRr’æÆVâ‚“°¢6öç7Bf–v‡D–G2Òf–v‡G2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢–b‚f–v‡D–G2æÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæòFVÖòf–v‡G2f÷VæBâ6VVBF†R6&Bf—'7BârÂ6öFS¢täõôDTÔõô4$BrÒ“°¢Ð ¢òòâ6ÆV"F†RVçG&–W26òWfW'–öæR6âVçFW"v–ââ66÷VBFòFVÖòf–v‡G2à¢6öç7B6ÆV&VE66÷&W2Òv—B66÷&RæFVÆWFTÖç’‡²ÖF6„–C¢²F–ã¢f–v‡D–G2ÒÒ“° ¢6öç7B6öçFW7G2Òv—BFVÔ6öçFW7Bæf–æB‡²æÖS¢FVÖõFu&VvW‚‚’Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢6öç7B6öçFW7D–G2Ò6öçFW7G2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢6öç7B6ÆV&VEFV×2Ò6öçFW7D–G2æÆVæwF€¢òv—BFVÔVçG'’æFVÆWFTÖç’‡²6öçFW7D–C¢²F–ã¢6öçFW7D–G2ÒÒ¢¢²FVÆWFVD6÷VçC¢Ó° ¢6öç7B6V6öç2Òv—B6V6öâæf–æB‡²æÖS¢FVÖõFu&VvW‚‚’Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢6öç7B6V6öä–G2Ò6V6öç2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢6öç7B6ÆV&VE&÷7FW'2Ò6V6öä–G2æÆVæwF€¢òv—B6V6öå&÷7FW"æFVÆWFTÖç’‡²6V6öä–C¢²F–ã¢6V6öä–G2ÒÒ¢¢²FVÆWFVD6÷VçC¢Ó° ¢òò"â&V÷VâF†Rf–v‡G2â7FvvW&VBgWGW&RFFW26òF†R6&BÆöö·2&VÂÂæ@¢òòF†R6WGFÆVÖVçB7F×2&R6ÆV&VB÷"6WGFÆRv÷VÆB&VgW6RæW‡BF–ÖRà¢ÆWBF’Ò3°¢f÷"†6öç7Bf–v‡Böbf–v‡G2’°¢v—BÖF6‚çWFFTöæR‡²ö–C¢f–v‡Båö–BÒÂ°¢G6WC¢°¢ÖF6„FFS¢æWrFFR„FFRææ÷r‚’²F’¢ƒcC’À¢ÖF6…7FGW3¢v7F—fRrÀ¢ÖF6…6†F÷u7FGW3¢v7F—fRrÀ¢ÒÀ¢GVç6WC¢°¢&—¦W56WGFÆVDC¢rrÂ&—¦UööÅ–C¢rrÂ†÷W6T7WEF¶Vã¢rrÀ¢fö–FVDC¢rrÂfö–E&V6öã¢rrÂ6öÆÆV7FVDfVW3¢rrÂ&öf—C¢rrÀ¢ÒÀ¢Ò“°¢F’³Ò°¢Ð ¢òò2â&V÷VâF†R6öçFW7G2Â6ÆV&–ærF†V—"÷G2(	BF†R6ö–ç2–âF†VÒvW&R§W7@¢òò&VgVæFVBFòF†RFW7FW'2Â6òÆVf–ær÷B&V†–æBv÷VÆBF÷V&ÆRÖ6÷VçBà¢–b†6öçFW7D–G2æÆVæwF‚’°¢v—BFVÔ6öçFW7BçWFFTÖç’‡²ö–C¢²F–ã¢6öçFW7D–G2ÒÒÂ°¢G6WC¢²7FGW3¢tõTârÂ&—¦UööÃ¢Â6WGFÆVDC¢çVÆÂÂfö–E&V6öã¢rrÒÀ¢Ò“°¢Ð¢–b‡6V6öä–G2æÆVæwF‚’°¢v—B6V6öâçWFFTÖç’‡²ö–C¢²F–ã¢6V6öä–G2ÒÒÂ°¢G6WC¢°¢7FGW3¢tE$eEôõTârÀ¢&—¦UööÃ¢À¢6WGFÆVDC¢çVÆÂÀ¢G&gD6Æ÷6W4C¢æWrFFR„FFRææ÷r‚’²"¢ƒcC’À¢VæG4C¢æWrFFR„FFRææ÷r‚’²3¢ƒcC’À¢ÒÀ¢Ò“°¢Ð ¢òòBâF÷F†RFW7FW'2&6²WâöæÇ’—5FW7D66÷VçB&÷w2à¢6öç7B&Vf–ÆÆVBÒv—BW6W"çWFFTÖç’‡²—5FW7D66÷VçC¢G'VRÒÂ²G6WC¢²Fö¶Vç3¢7G&–ær†6ö–ç2’ÒÒ“° ¢òòRâ6ÆV"F†V—"æ÷F–f–6F–öâ&VBÖ&·26òF†R&VÆÂÆ–v‡G2Wv–âà¢v—BW6W"çWFFTÖç’‡²—5FW7D66÷VçC¢G'VRÒÂ²G6WC¢²æ÷F–f–6F–öç5&VDC¢çVÆÂÒÒ“° ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&W6WC¢°¢f–v‡G3¢f–v‡G2æÆVæwF‚À¢&VF–7F–öç46ÆV&VC¢6ÆV&VE66÷&W3òæFVÆWFVD6÷VçBÇÂÀ¢FVÔVçG&–W46ÆV&VC¢6ÆV&VEFV×3òæFVÆWFVD6÷VçBÇÂÀ¢6V6öå&÷7FW'46ÆV&VC¢6ÆV&VE&÷7FW'3òæFVÆWFVD6÷VçBÇÂÀ¢FW7FW'5&Vf–ÆÆVC¢&Vf–ÆÆVCòæÖöF–f–VD6÷VçBÇÂÀ¢6ö–ç2À¢ÒÀ¢æW‡C¢t6&B—2÷Vâv–ââFW7FW'26âVçFW"ÂF†Vâ6ÆÂf7BÖf÷'v&BFò6VR&W7VÇG2ârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tFVÖò&WÆ’f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u&WÆ’f–ÆVBârÂFWF–Ã¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð§Ò“° ¢òò&VÖ÷fW2WfW'—F†–ærF†R6VVB7&VFVBÂæBöæÇ’F†B(	BÖF6†VBöâF†R´DTÔõÐ¢òò&Vf—‚Â6ò&VÂf–v‡B6âæWfW"&R6Vv‡B'’—Bà¦æFVÆWFR‚rö’öFÖ–âöFVÖòÖ6&BrÂfW&–g”FÖ–åFö¶VâÂ&WV—&T'VÆ´6öæf—&ÖF–öâ‚tDTÔô4$Br’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BFu&VvW‚ÒæWr&VtW‡‚uåÅÂr²DTÔõõDrç&WÆ6R‚õµµÅÕÒörÂuÅÂBbr’“°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6„æÖS¢Fu&VvW‚Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢6öç7Bf–v‡D–G2Òf–v‡G2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“° ¢òò6öÆÆV7BF†RFVÖò6öçFW7BæB6V6öâ–G2$Tdõ$RFVÆWF–ærF†VÒÂ6òF†V— ¢òòVçG&–W26â&R66÷VB&V6—6VÇ’à¢6öç7B¶FVÖô6öçFW7G2ÂFVÖõ6V6öç5ÒÒv—B&öÖ—6RæÆÂ…°¢FVÔ6öçFW7Bæf–æB‡²æÖS¢Fu&VvW‚Ò’ç6VÆV7B‚uö–Br’æÆVâ‚’À¢6V6öâæf–æB‡²æÖS¢Fu&VvW‚Ò’ç6VÆV7B‚uö–Br’æÆVâ‚’À¢Ò“°¢6öç7B6öçFW7D–G2ÒFVÖô6öçFW7G2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢6öç7B6V6öä–G2ÒFVÖõ6V6öç2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“° ¢6öç7B·66÷&W2ÂFVÔVçG&–W2Â&÷7FW'2Â6öçFW7G2Â6V6öç2ÂÖF6†W5ÒÒv—B&öÖ—6RæÆÂ…°¢66÷&RæFVÆWFTÖç’‡²ÖF6„–C¢²F–ã¢f–v‡D–G2ÒÒ’À¢òò66÷VBFòF†RFVÖò6öçFW7G2ââVç66÷VBf–ÇFW"†W&Rv÷VÆB†fRv—V@¢òòWfW'’FVÒVçG'’öâF†RÆFf÷&Òà¢6öçFW7D–G2æÆVæwF‚òFVÔVçG'’æFVÆWFTÖç’‡²6öçFW7D–C¢²F–ã¢6öçFW7D–G2ÒÒ’¢&öÖ—6Rç&W6öÇfR‡²FVÆWFVD6÷VçC¢Ò’À¢6V6öä–G2æÆVæwF‚ò6V6öå&÷7FW"æFVÆWFTÖç’‡²6V6öä–C¢²F–ã¢6V6öä–G2ÒÒ’¢&öÖ—6Rç&W6öÇfR‡²FVÆWFVD6÷VçC¢Ò’À¢FVÔ6öçFW7BæFVÆWFTÖç’‡²æÖS¢Fu&VvW‚Ò’À¢6V6öâæFVÆWFTÖç’‡²æÖS¢Fu&VvW‚Ò’À¢ÖF6‚æFVÆWFTÖç’‡²ÖF6„æÖS¢Fu&VvW‚Ò’À¢Ò“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FVÆWFVC¢°¢f–v‡G3¢ÖF6†W3òæFVÆWFVD6÷VçBÇÂÀ¢&VF–7F–öç3¢66÷&W3òæFVÆWFVD6÷VçBÇÂÀ¢FVÔ6öçFW7G3¢6öçFW7G3òæFVÆWFVD6÷VçBÇÂÀ¢FVÔVçG&–W3¢FVÔVçG&–W3òæFVÆWFVD6÷VçBÇÂÀ¢6V6öç3¢6V6öç3òæFVÆWFVD6÷VçBÇÂÀ¢6V6öå&÷7FW'3¢&÷7FW'3òæFVÆWFVD6÷VçBÇÂÀ¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tFVÖò6&BW&vRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B&VÖ÷fRF†RFVÖò6&BârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòDU5B44õTåE2(	Bf÷"&—fFRFW7F–ærw&÷W ¢òð¢òòF†Rö'f–÷W2&ö6‚(	BöæR6†&VBÆöv–â†æFVBFòWfW'–öæR(	BFöW2æ÷Bv÷&²f÷ ¢òòF†—2âFW7FW'2v÷VÆB÷fW'w&—FRV6‚÷F†W"w2&VF–7F–öç2Â7VæBF†R6ÖP¢òò6ö–ç2ÂæBWfW'’VçG'’v÷VÆB6öÆÆ–FRöâF†RöæRÖVçG'’×W"×Æ–W"'VÆRâ—BÇ6ð¢òò6ææ÷BW†W&6—6RGWÆ–6FRÖ66÷VçB&WfVçF–öâÂW"×W6W"æ÷F–f–6F–öç2Â÷ ¢òò†VB×FòÖ†VBÂÆÂöbv†–6‚æVVBGvòF—7F–æ7BV÷ÆRà¢òð¢òò6òF†—2Ö–çG24U$DR&R×fW&–f–VBÂ&RÖgVæFVB66÷VçBW"FW7FW"Âæ@¢òò&WGW&ç2F†R7&VFVçF–Ç2öæ6R6òF†W’6â&R†æFVB÷WBà¢òð¢òò—B—2Æöv–âvVæW&F÷"Âv†–6‚—2&6¶Fö÷"–b—BWfW"6†—2Væ&ÆVBâF‡&VP¢òòwV&G3¢öfbVæÆW72DU5Eô44õTåE5ôTä$ÄTC×G'VRÂFÖ–âÖöæÇ’ÂæB—B&VgW6W2Fð¢òò'Vâ–â&öGV7F–öâVæÆW72ÄÄõuõDU5Eô44õTåE5ô”åõ$ôET5D”ôâ—2Ç6ò6WBâWfW'¢òò66÷VçB—B7&VFW2—2fÆvvVB—5FW7D66÷VçB6òF†W’6â&RW†6ÇVFVBg&öÐ¢òòV&Æ–2çVÖ&W'2æBW&vVB–âöæR6ÆÂgFW'v&G2à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BDU5Eô44õTåE5ôTä$ÄTBÒ7G&–ær‡&ö6W72æVçbåDU5Eô44õTåE5ôTä$ÄTBÇÂvfÇ6Rr’çG&–Ò‚’çFôÆ÷vW$66R‚’ÓÓÒwG'VRs°¦6öç7BDU5Eô44õTåEôDôÔ”âÒ7G&–ær‡&ö6W72æVçbåDU5Eô44õTåEôDôÔ”âÇÂvfÖ×FW7Bæ6öÒr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢òòFVÆ–&W&FVÇ’ÖöFW7Bâv—F‚#RÃ6ö–ç2æ÷F†–æröâF†R6&B—2FV6—6–öâÂæB¢òòFW7FW"v†ò6ææ÷B'Vâ÷WBæWfW"&V†fW2Æ–¶RÆ–W"âbÃÖ¶W2F†RÖ–à¢òòWfVçBV'FW"öbF†R7F6²æBF†R†–v‚&öÆÆW"GvòF†—&G2öb—B(	B6òF†W¢òò†fRFò6†ö÷6RÂv†–6‚—2v†VâF†R–çFW&W7F–ær'Vw27W&f6Rà¦6öç7BDU5Eô44õTåEõ5D%Eô4ô”å2ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbåDU5Eô44õTåEõ5D%Eô4ô”å2ÇÂc’“° ¢òò†ö—7FVBgVæ7F–öâÂäõB6öç7B'&÷s¢F†RFVÖòÖ6&B&÷WFW2&Vv—7FW"V&Æ–W"–à¢òòF†—2f–ÆRF†âF†—2Æ–æRÂæB6öç7Bv÷VÆB7F–ÆÂ&R–âF†RFV×÷&ÂFVB¦öæP¢òòBF†Bö–çB(	Bv†–6‚—2W†7FÇ’v†B7&6†VBF†R6W'fW"öâF†RÆ7BwV&Bà¦gVæ7F–öâ&WV—&UFW7D66÷VçG2‡&WÂ&W2ÂæW‡B’°¢–b‚DU5Eô44õTåE5ôTä$ÄTB’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢uFW7B66÷VçB7&VF–öâ—2F—6&ÆVBâ6WBDU5Eô44õTåE5ôTä$ÄTC×G'VRöâF†R&Wf–WrVçf—&öæÖVçBârÀ¢6öFS¢uDU5Eô44õTåE5ôD•4$ÄTBrÀ¢Ò“°¢Ð¢–b‡&ö6W72æVçbääôDUôTåbÓÓÒw&öGV7F–öârbb&ö6W72æVçbäÄÄõuõDU5Eô44õTåE5ô”åõ$ôET5D”ôâÓÒwG'VRr’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢u&VgW6–ærFòÖ–çBFW7BÆöv–ç2–â&öGV7F–öââW6RF†R&Wf–WrVçf—&öæÖVçBârÀ¢6öFS¢u$ôET5D”ôåô$Äô4´TBrÀ¢Ò“°¢Ð¢&WGW&âæW‡B‚“°§Ð ¢òò&VF–7F&ÆR6òF†W’6â&R&VÆ–VB'’FW‡BÖW76vRv—F†÷WB77v÷&BÖævW"à¢òò6fRöæÇ’&V6W6RF†Rv†öÆRfVGW&R—2VçbÖvFVBæBF†R66÷VçG2&P¢òòF—7÷6&ÆR(	BæWfW"Væ&ÆRF†—2öâ&öGV7F–öâà¢òòF—7F–æ7BæÖW2Â&V6W6R6—‚ÆVwVW26ÆÆVB%FW7BÆVwVRâ"FVÆÇ2–÷Ræ÷F†–æp¢òò&÷WBv†–6‚öæRFW7FW"7GVÆÇ’¦ö–æVBà¦6öç7BDTÔõôÄTuTUôäÔU2Òö&¦V7Bæg&VW¦R…°¢u6÷WF‡6–FRf–v‡B6ÇV"rÂuF†R7WFÖVârÂt—&öâ&÷r6öÆÆV7F—fRrÀ¢t&6·–&B'&vÆW'2rÂt6†×–öç6†—6—&6ÆRrÂuF†R6÷&æW"7&WrrÀ¥Ò“° ¦6öç7BFW7D7&VFVçF–Ç2Ò‡&öÆRÂ–æFW‚’Óâ‡°¢VÖ–Ã¢G·&öÆWÒG¶–æFW‡ÔGµDU5Eô44õTåEôDôÔ”çÖÀ¢77v÷&C¢f–v‡Dæ–v‡BÒG·&öÆWÒG¶–æFW‡ÖÀ§Ò“° ¦ç÷7B‚rö’öFÖ–â÷FW7BÖ66÷VçG2rÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ–W'2ÒÖF‚æÖ‚ƒÂÖF‚æÖ–âƒ#RÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òçÆ–W'2óòb’’’“°¢6öç7Bff–Æ–FW2ÒÖF‚æÖ‚ƒÂÖF‚æÖ–âƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæff–Æ–FW2óòb’’’“°¢òò–BÖ6öçFW7B7FFR'’FVfVÇBÂ÷"æ÷F†–ær–B6â&RFW7FVBBÆÂà¢6öç7B7FFRÒ7G&–ær‡&Wæ&öG“òç7FFRÇÂttr’çG&–Ò‚’çFõWW$66R‚’ç6Æ–6RƒÂ"“°¢6öç7B6ö–ç2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæ6ö–ç2óòDU5Eô44õTåEõ5D%Eô4ô”å2’’“°¢òò6öÖf÷'F&Ç’÷fW"F†R#²F‡&W6†öÆB–âWfW'’7FFRF†B†2öæRà¢6öç7BFFTöd&—'F‚ÒæWrFFR‚s““ÓÓRr“° ¢6öç7B7&VFVBÒ²Æ–W'3¢µÒÂff–Æ–FW3¢µÒÓ° ¢f÷"†ÆWB–æFW‚Ò²–æFW‚ÃÒÆ–W'3²–æFW‚³Ò’°¢6öç7B²VÖ–ÂÂ77v÷&BÒÒFW7D7&VFVçF–Ç2‚wFW7FW"rÂ–æFW‚“°¢6öç7BW†—7F–ærÒv—BW6W"æf–æDöæR‡²VÖ–ÂÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b†W†—7F–ær’°¢òò&RÖ—77VR&F†W"F†â6¶—¢FW7FW"v†òf÷&v÷BF†V—"77v÷&B6†÷VÆB&P¢òò&V6÷fW&&ÆRv—F†÷WBFVÆWF–ærF†V—"VçG&–W2à¢v—BW6W"çWFFTöæR‡²ö–C¢W†—7F–æråö–BÒÂ°¢G6WC¢°¢77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢fW&–f–VC¢G'VRÀ¢Fö¶Vç3¢7G&–ær†6ö–ç2’À¢—5FW7D66÷VçC¢G'VRÀ¢ÒÀ¢Ò“°¢7&VFVBçÆ–W'2çW6‚‡²VÖ–ÂÂ77v÷&BÂ&W6WC¢G'VRÒ“°¢6öçF–çVS°¢Ð¢v—BW6W"æ7&VFR‡°¢VÖ–ÂÀ¢77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢f—'7DæÖS¢uFW7FW"rÀ¢Æ7DæÖS¢7G&–ær†–æFW‚’À¢Æ–W$æÖS¢DU5DU"G¶–æFW‡ÖÀ¢òò&R×fW&–f–VC¢âVÖ–Â×fW&–f–6F–öâ7FWv÷VÆB&Æö6²FW7FW'2öà¢òòFG&W76W2F†BFòæ÷B&V6V—fRÖ–Âà¢fW&–f–VC¢G'VRÀ¢Fö¶Vç3¢7G&–ær†6ö–ç2’À¢&W6–FVæ6U7FFS¢7FFRÀ¢—5U46—F—¦Vã¢G'VRÀ¢FFTöd&—'F‚À¢—5FW7D66÷VçC¢G'VRÀ¢Ò“°¢7&VFVBçÆ–W'2çW6‚‡²VÖ–ÂÂ77v÷&BÂ&W6WC¢fÇ6RÒ“°¢Ð ¢f÷"†ÆWB–æFW‚Ò²–æFW‚ÃÒff–Æ–FW3²–æFW‚³Ò’°¢6öç7B²VÖ–ÂÂ77v÷&BÒÒFW7D7&VFVçF–Ç2‚vÆVwVRrÂ–æFW‚“°¢6öç7BW†—7F–ærÒv—Bff–Æ–FRæf–æDöæR‡²VÖ–ÂÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b†W†—7F–ær’°¢v—Bff–Æ–FRçWFFTöæR‡²ö–C¢W†—7F–æråö–BÒÂ°¢G6WC¢°¢77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢òòfW&–f–VBÂ÷"F†W’6ææ÷B'Vâ6öçFW7B÷"6VæBÆVwVRæ÷F–6Rà¢fW&–f–VC¢G'VRÀ¢—5FW7D66÷VçC¢G'VRÀ¢ÒÀ¢Ò“°¢7&VFVBæff–Æ–FW2çW6‚‡²VÖ–ÂÂ77v÷&BÂ&W6WC¢G'VRÒ“°¢6öçF–çVS°¢Ð¢v—Bff–Æ–FRæ7&VFR‡°¢VÖ–ÂÀ¢77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢f—'7DæÖS¢tÆVwVRrÀ¢Æ7DæÖS¢7G&–ær†–æFW‚’À¢Æ–W$æÖS¢DU5DÄTuTRG¶–æFW‡ÖÀ¢ÆVwVTæÖS¢DTÔõôÄTuTUôäÔU5¶–æFW‚ÒÒÇÂFW7BÆVwVRG¶–æFW‡ÖÀ¢fW&–f–VC¢G'VRÀ¢&W6–FVæ6U7FFS¢7FFRÀ¢FFTöd&—'F‚À¢òò6VVFVB&Ææ6R6ò–÷WB&WVW7B—2FW7F&ÆR–ÖÖVF–FVÇ’Â–ç7FVBö`¢òòv—F–ærf÷"&¶RFò'V–ÆBW7&÷726WfW&Â6WGFÆVB6öçFW7G2à¢Fö¶Vç3¢7G&–ær†6ö–ç2’À¢—5FW7D66÷VçC¢G'VRÀ¢Ò“°¢7&VFVBæff–Æ–FW2çW6‚‡²VÖ–ÂÂ77v÷&BÂ&W6WC¢fÇ6RÒ“°¢Ð ¢òòöæRFÖ–âÆöv–âÂ6òF†R&6²öff–6R6â&RvÆ¶VBVæBFòVæB(	B6WGFÆR¢òòf–v‡BÂ&VgVæBÆ–W"Â&÷fR–÷WB(	Bv—F†÷WBW6–ærF†R&VÂFÖ–à¢òò66÷VçBâ6–ævÆRÂ&V6W6R6V6öæBFÖ–â&÷fW2æ÷F†–ærW‡G&æBWfW'¢òòW‡G&&—f–ÆVvVBÆöv–â—2æ÷F†W"F†–ærFò&VÖVÖ&W"FòFVÆWFRà¢–b‡&Wæ&öG“òæFÖ–âÓÒfÇ6R’°¢6öç7B²VÖ–ÂÂ77v÷&BÒÒFW7D7&VFVçF–Ç2‚v&6¶öff–6RrÂ“°¢6öç7BW†—7F–ærÒv—BFÖ–âæf–æDöæR‡²VÖ–ÂÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b†W†—7F–ær’°¢v—BFÖ–âçWFFTöæR‡²ö–C¢W†—7F–æråö–BÒÂ°¢G6WC¢²77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’Â—5FW7D66÷VçC¢G'VRÒÀ¢Ò“°¢7&VFVBæFÖ–âÒ²VÖ–ÂÂ77v÷&BÂ&W6WC¢G'VRÓ°¢ÒVÇ6R°¢v—BFÖ–âæ7&VFR‡°¢f—'7DæÖS¢t&6²rÀ¢Æ7DæÖS¢töff–6RrÀ¢VÖ–ÂÀ¢77v÷&C¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢—5FW7D66÷VçC¢G'VRÀ¢Ò“°¢7&VFVBæFÖ–âÒ²VÖ–ÂÂ77v÷&BÂ&W6WC¢fÇ6RÓ°¢Ð¢Ð ¢6öç6öÆRçv&â†·FW7BÖ66÷VçG5ÒG·Æ–W'7ÒÆ–W"²G¶ff–Æ–FW7Òff–Æ–FR²G¶7&VFVBæFÖ–âò¢ÒFÖ–âÆöv–ç2Ö–çFVB'’FÖ–âG·&WæFÖ–ãòæ–BÇÂwVæ¶æ÷vâwÖ“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢7FFRÀ¢6ö–ç2À¢7&VFVBÀ¢&VÖ–æFW#¢u6WBDU5Eô44õTåE5ôTä$ÄTCÖfÇ6RæBW&vRF†W6R&Vf÷&Rvö–ærÆ—fRârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFW7B66÷VçB7&VF–öâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7&VFRFW7B66÷VçG2ârÒ“°¢Ð§Ò“° ¢òòv†BW†—7G2Âv—F†÷WB&RÖ—77V–ærç—F†–ærà¦ævWB‚rö’öFÖ–â÷FW7BÖ66÷VçG2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B·Æ–W'2Âff–Æ–FW2ÂFÖ–ç5ÒÒv—B&öÖ—6RæÆÂ…°¢W6W"æf–æB‡²—5FW7D66÷VçC¢G'VRÒ’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRFö¶Vç2&W6–FVæ6U7FFR7&VFVDBr’æÆVâ‚’À¢ff–Æ–FRæf–æB‡²—5FW7D66÷VçC¢G'VRÒ’ç6VÆV7B‚vVÖ–ÂÆVwVTæÖRfW&–f–VB7&VFVDBr’æÆVâ‚’À¢FÖ–âæf–æB‡²—5FW7D66÷VçC¢G'VRÒ’ç6VÆV7B‚vVÖ–Â7&VFVDBr’æÆVâ‚’À¢Ò“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Væ&ÆVC¢DU5Eô44õTåE5ôTä$ÄTBÀ¢Æ–W'3¢Æ–W'2æÖ‚‡&÷r’Óâ‡°¢VÖ–Ã¢&÷ræVÖ–ÂÀ¢æÖS¢&÷rçÆ–W$æÖRÀ¢6ö–ç3¢çVÖ&W"ç'6T–çB…7G&–ær‡&÷rçFö¶Vç2ÇÂsr’Â’ÇÂÀ¢7FFS¢&÷rç&W6–FVæ6U7FFRÀ¢Ò’’À¢ff–Æ–FW3¢ff–Æ–FW2æÖ‚‡&÷r’Óâ‡²VÖ–Ã¢&÷ræVÖ–ÂÂÆVwVS¢&÷ræÆVwVTæÖRÂfW&–f–VC¢&÷rçfW&–f–VBÒ’’À¢FÖ–ç3¢FÖ–ç2æÖ‚‡&÷r’Óâ‡²VÖ–Ã¢&÷ræVÖ–ÂÒ’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBFW7B66÷VçG2ârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò$T4ôä4”ÄR(	B&ööbF†B6–×VÇFæV÷W26W76–öâF–Bæ÷B6÷''WBç—F†–æp¢òð¢òòWfW'’ÖöæW’'Vrf÷VæB–âF†—26öFV&6Rv2&6S¢Gvò6WGFÆW2––ærF†R6ÖP¢òò÷BÂGvò66WG2FV&—F–ærF†R6ÖR7F¶RÂâVçG'’6†&vVBv—F†÷WB&V–æp¢òò&V6÷&FVBâ&6W2öæÇ’V"VæFW"6öæ7W'&Væ7’Âv†–6‚Ö¶W2w&÷W6W76–öâF†P¢òòÖ÷7BfÇV&ÆRFW7Bf–Æ&ÆR(	BæBW6VÆW72v—F†÷WBv’Fò6†V6²gFW'v&G2à¢òð¢òòFW7FW"v–ÆÂæ÷Bæ÷F–6RÖ—76–ær6ö–ç2âF†—2FöW3¢—B&RÖFW&—fW2WfW'’FW7@¢òò66÷VçBw2&Ææ6Rg&öÒF†RÆVFvW"æB6ö×&W2—BFòF†R7F÷&VB&Ææ6Râ–`¢òòF†÷6Rw&VRf÷"WfW'–öæRÂæò&6RÆ÷7B÷"GWÆ–6FVBÖöæW’à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’öFÖ–â÷FW7BÖ66÷VçG2÷&V6öæ6–ÆRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ–W'2Òv—BW6W"æf–æB‡²—5FW7D66÷VçC¢G'VRÒ’ç6VÆV7B‚uö–BVÖ–ÂFö¶Vç2r’æÆVâ‚“°¢–b‚Æ–W'2æÆVæwF‚’°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÖW76vS¢tæòFW7B66÷VçG2f÷VæBârÂÆ–W'3¢µÒÒ“°¢Ð¢6öç7B–G2ÒÆ–W'2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“° ¢òòÆVFvW"&÷w2&RF†R6÷W&6RöbG'WFƒ¢WfW'’7&VF—BæBFV&—BF†Bç’ÖöæW¢òòF‚6Æ–×2Fò†fRÖFRà¢6öç7BÆVFvW%&÷w2Òv—Bf–v‡DVçG'”ÆVFvW"æf–æB‡²W6W$–C¢²F–ã¢–G2ÒÒ¢ç6VÆV7B‚wW6W$–BÖ÷VçB&Ææ6TgFW"&V6öâ7&VFVDBr’æÆVâ‚“°¢6öç7B'•W6W"ÒæWrÖ‚“°¢ÆVFvW%&÷w2æf÷$V6‚‚‡&÷r’Óâ°¢6öç7BÆ—7BÒ'•W6W"ævWB…7G&–ær‡&÷rçW6W$–B’’ÇÂµÓ°¢Æ—7BçW6‚‡&÷r“°¢'•W6W"ç6WB…7G&–ær‡&÷rçW6W$–B’ÂÆ—7B“°¢Ò“° ¢6öç7B7F'D6ö–ç2ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&WçVW'’ç7F'D6ö–ç2óòDU5Eô44õTåEõ5D%Eô4ô”å2’“°¢6öç7Bf–æF–æw2ÒµÓ° ¢6öç7B&W÷'BÒÆ–W'2æÖ‚‡Æ–W"’Óâ°¢6öç7B&÷w2Ò†'•W6W"ævWB…7G&–ær‡Æ–W"åö–B’’ÇÂµÒ¢ç6÷'B‚†Â"’ÓâæWrFFR†æ7&VFVDB’ÒæWrFFR†"æ7&VFVDB’“°¢6öç7BæWBÒ&÷w2ç&VGV6R‚‡7VÒÂ&÷r’Óâ7VÒ²„çVÖ&W"‡&÷ræÖ÷VçB’ÇÂ’Â“°¢6öç7B7GVÂÒçVÖ&W"ç'6T–çB…7G&–ær‡Æ–W"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢6öç7BW‡V7FVBÒ7F'D6ö–ç2²æWC°¢6öç7BG&–gBÒ7GVÂÒW‡V7FVC° ¢òò&Ææ6TgFW"öâV6‚&÷r6†÷VÆB6†–ã¢WfW'’&÷rw2gFW"×fÇVR×W7BWVÀ¢òòF†RæW‡B&÷rw2&Vf÷&R×fÇVRâ'&V²ÖVç2Gvòw&—FW2–çFW&ÆVfVBà¢ÆWB6†–ä'&V²ÒçVÆÃ°¢f÷"†ÆWB’Ò²’Â&÷w2æÆVæwFƒ²’³Ò’°¢6öç7B&WdgFW"ÒçVÖ&W"‡&÷w5¶’ÒÒæ&Ææ6TgFW"“°¢6öç7BF†—4&Vf÷&RÒçVÖ&W"‡&÷w5¶•Òæ&Ææ6TgFW"’Ò„çVÖ&W"‡&÷w5¶•ÒæÖ÷VçB’ÇÂ“°¢–b„çVÖ&W"æ—4f–æ—FR‡&WdgFW"’bbçVÖ&W"æ—4f–æ—FR‡F†—4&Vf÷&R’bb&WdgFW"ÓÒF†—4&Vf÷&R’°¢6†–ä'&V²Ò²C¢&÷w5¶•Òæ7&VFVDBÂ&V6öã¢&÷w5¶•Òç&V6öâÂW‡V7FVC¢&WdgFW"Â6s¢F†—4&Vf÷&RÓ°¢'&V³°¢Ð¢Ð ¢–b†G&–gBÓÒ’°¢f–æF–æw2çW6‚†G·Æ–W"æVÖ–ÇÓ¢&Ææ6R—2G¶7GVÇÒÂÆVFvW"6—2G¶W‡V7FVGÒ†öfb'’G¶G&–gBâòr²r¢rwÒG¶G&–gGÒ–“°¢Ð¢–b†6†–ä'&V²’°¢f–æF–æw2çW6‚†G·Æ–W"æVÖ–ÇÓ¢ÆVFvW"6†–â'&V·2B"G¶6†–ä'&V²ç&V6öçÒ"(	BGvòw&—FW2–çFW&ÆVfVF“°¢Ð ¢&WGW&â°¢VÖ–Ã¢Æ–W"æVÖ–ÂÀ¢&Ææ6S¢7GVÂÀ¢ÆVFvW$W‡V7FVC¢W‡V7FVBÀ¢G&–gBÀ¢Ö÷fVÖVçG3¢&÷w2æÆVæwF‚À¢6†–ä'&V²À¢Ó°¢Ò“° ¢òòGWÆ–6FRVçG&–W3¢F†RöæRÖVçG'’×W"×Æ–W"'VÆR6†÷VÆBÖ¶RF†—0¢òò–×÷76–&ÆRÂ6òç’†—B—2&6RF†Bv÷BF‡&÷Vv‚à¢6öç7BGWW2Òv—B66÷&Rævw&VvFR…°¢²FÖF6ƒ¢²Æ–W$–C¢²F–ã¢–G2ÒÂ&VgVæFVC¢²FæS¢G'VRÒÒÒÀ¢²Fw&÷W¢²ö–C¢²Æ–W$–C¢rGÆ–W$–BrÂÖF6„–C¢rFÖF6„–BrÒÂ6÷VçC¢²G7VÓ¢ÒÒÒÀ¢²FÖF6ƒ¢²6÷VçC¢²FwC¢ÒÒÒÀ¢Ò“°¢–b†GWW2æÆVæwF‚’f–æF–æw2çW6‚†G¶GWW2æÆVæwF‡ÒGWÆ–6FRf–v‡BVçG&–W2(	BF†RöæRÖVçG'’'VÆRv2'—76VF“° ¢òò6öçFW7B÷G26†÷VÆBWVÂv†Bv27GVÆÇ’6öÆÆV7FVBà¢6öç7B6öçFW7G2Òv—BFVÔ6öçFW7Bæf–æB‡²æÖS¢FVÖõFu&VvW‚‚’Ò’ç6VÆV7B‚uö–BæÖRVçG'”fVR&—¦UööÂ7FGW2r’æÆVâ‚“°¢6öç7B÷D6†V6·2ÒµÓ°¢f÷"†6öç7B6öçFW7Böb6öçFW7G2’°¢6öç7B–DVçG&–W2Òv—BFVÔVçG'’æ6÷VçDFö7VÖVçG2‡²6öçFW7D–C¢7G&–ær†6öçFW7Båö–B’ÂVçG'”fVU–C¢²FwC¢ÒÒ“°¢6öç7BW‡V7FVE÷BÒ–DVçG&–W2¢ÖF‚æÖ‚ƒÂçVÖ&W"†6öçFW7BæVçG'”fVR’ÇÂ“°¢6öç7B7GVÅ÷BÒÖF‚æÖ‚ƒÂçVÖ&W"†6öçFW7Bç&—¦UööÂ’ÇÂ“°¢òò6WGFÆVB6öçFW7B†2–B—G2÷B÷WBÂ6ò¦W&òF†W&R—26÷'&V7Bà¢6öç7BÖ—6ÖF6‚Ò6öçFW7Bç7FGW2ÓÒu4UEDÄTBrbb7GVÅ÷BÓÒW‡V7FVE÷C°¢–b†Ö—6ÖF6‚’f–æF–æw2çW6‚†G¶6öçFW7BææÖWÓ¢÷B—2G¶7GVÅ÷GÒÂG·–DVçG&–W7Ò–BVçG&–W26†÷VÆBÖ¶R—BG¶W‡V7FVE÷GÖ“°¢÷D6†V6·2çW6‚‡²æÖS¢6öçFW7BææÖRÂ7FGW3¢6öçFW7Bç7FGW2Â–DVçG&–W2ÂW‡V7FVE÷BÂ7GVÅ÷BÂÖ—6ÖF6‚Ò“°¢Ð ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6ÆVã¢f–æF–æw2æÆVæwF‚ÓÓÒÀ¢òòF†R†VFÆ–æS¢öæRÆ–æRF†R÷væW"6â&VBv—F†÷WB–çFW'&WF–ærF†R&W7Bà¢fW&F–7C¢f–æF–æw2æÆVæwF‚ÓÓÒ ¢òt&öö·2&Ææ6RâWfW'’FW7B66÷VçBÖF6†W2—G2ÆVFvW"ÂæòGWÆ–6FRVçG&–W2Â÷G26÷'&V7Bâp¢¢G¶f–æF–æw2æÆVæwF‡Ò&ö&ÆVÒG¶f–æF–æw2æÆVæwF‚ÓÓÒòrr¢w2wÒf÷VæB(	B6VRf–æF–æw2æÀ¢f–æF–æw2À¢77VÖVE7F'F–æt6ö–ç3¢7F'D6ö–ç2À¢Æ–W'3¢&W÷'BÀ¢GWÆ–6FTVçG&–W3¢GWW2æÆVæwF‚À¢÷G3¢÷D6†V6·2À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&V6öæ6–ÆRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u&V6öæ6–ÆRf–ÆVBârÂFWF–Ã¢7G&–ær†W'&÷#òæÖW76vRÇÂrr’ç6Æ–6RƒÂ#’Ò“°¢Ð§Ò“° ¢òòF÷WfW'–öæR&6²WÖ–B×6W76–öâÂ6òFW7FW"v†ò7VçBF†V—"6ö–ç2—2æ÷@¢òò7GV6²v—F–æröâ–÷Rà¦ç÷7B‚rö’öFÖ–â÷FW7BÖ66÷VçG2÷&Vf–ÆÂrÂfW&–g”FÖ–åFö¶VâÂ&WV—&UFW7D66÷VçG2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6ö–ç2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæ6ö–ç2óòDU5Eô44õTåEõ5D%Eô4ô”å2’’“°¢6öç7B&W7VÇBÒv—BW6W"çWFFTÖç’‡²—5FW7D66÷VçC¢G'VRÒÂ²G6WC¢²Fö¶Vç3¢7G&–ær†6ö–ç2’ÒÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&Vf–ÆÆVC¢&W7VÇCòæÖöF–f–VD6÷VçBÇÂÂ6ö–ç2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B&Vf–ÆÂFW7B66÷VçG2ârÒ“°¢Ð§Ò“° ¢òòW&vRâW6W2F†R6ÖR6öæf—&ÖF–öâwV&B2F†R÷F†W"FW7G'V7F—fR&÷WFW2Âæ@¢òòöæÇ’WfW"F÷V6†W2&÷w2fÆvvVB—5FW7D66÷VçB(	B&VÂÆ–W"6ææ÷B&R6Vv‡@¢òò'’—Bà¦æFVÆWFR‚rö’öFÖ–â÷FW7BÖ66÷VçG2rÂfW&–g”FÖ–åFö¶VâÂ&WV—&T'VÆ´6öæf—&ÖF–öâ‚uDU5D44õTåE2r’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ–W'2Òv—BW6W"æf–æB‡²—5FW7D66÷VçC¢G'VRÒ’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢6öç7B–G2ÒÆ–W'2æÖ‚‡&÷r’Óâ7G&–ær‡&÷råö–B’“°¢6öç7B·66÷&W2ÂÆVFvW"ÂW6W'2Âff–Æ–FW2ÂFÖ–ç5ÒÒv—B&öÖ—6RæÆÂ…°¢66÷&RæFVÆWFTÖç’‡²Æ–W$–C¢²F–ã¢–G2ÒÒ’À¢f–v‡DVçG'”ÆVFvW"æFVÆWFTÖç’‡²W6W$–C¢²F–ã¢–G2ÒÒ’À¢W6W"æFVÆWFTÖç’‡²—5FW7D66÷VçC¢G'VRÒ’À¢ff–Æ–FRæFVÆWFTÖç’‡²—5FW7D66÷VçC¢G'VRÒ’À¢òòÆVgF÷fW"&—f–ÆVvVBÆöv–â—2F†Rv÷'7BF†–ærFòf÷&vWBÂ6ò—BvöW0¢òòv—F‚F†R6ÖRW&vR&F†W"F†âæVVF–ær6W&FR7FWà¢FÖ–âæFVÆWFTÖç’‡²—5FW7D66÷VçC¢G'VRÒ’À¢Ò“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FVÆWFVC¢°¢Æ–W'3¢W6W'3òæFVÆWFVD6÷VçBÇÂÀ¢ff–Æ–FW3¢ff–Æ–FW3òæFVÆWFVD6÷VçBÇÂÀ¢FÖ–ç3¢FÖ–ç3òæFVÆWFVD6÷VçBÇÂÀ¢&VF–7F–öç3¢66÷&W3òæFVÆWFVD6÷VçBÇÂÀ¢ÆVFvW%&÷w3¢ÆVFvW#òæFVÆWFVD6÷VçBÇÂÀ¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFW7B66÷VçBW&vRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BW&vRFW7B66÷VçG2ârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòd”t…DU"$ôd”ÄU2(	BF†R&÷7FW"f÷VæFF–öà¢òð¢òò6öÖ&Df–v‡FW"Æ–'&'’Ç&VG’W†—7G2†f–v‡G26''’f–v‡FW$–Böf–v‡FW$$–B’À¢òò'WB—G266†VÖÆ—fW2–â6–&Æ–ærÖöGVÆRÂæB—B†öÆG2æöæRöbF†R&÷7FW ¢òò–FVçF—G’'&æF–ær—VÆ–æRæVVG2â&F†W"F†âÖöF–g’ÖöFVÂFVf–æV@¢òòVÇ6Wv†W&RÂF†—2—24ôÕä”ôâ6öÆÆV7F–öâ¶W–VB'’æ÷&ÖÆ—6VBf–v‡FW"æÖRà¢òð¢òòv‡’¶W–VB'’æÖRæBæ÷B'’6öÖ&Df–v‡FW"–C¢Ö÷7BW†—7F–ærf–v‡G26''’öæÇ¢òòÖF6„f–v‡FW$òÖF6„f–v‡FW$"7G&–æw2Â6òæÖR¶W’6÷fW'2F†Rv†öÆR&6°¢òò6FÆöwVRâv†W&R6öÖ&Df–v‡FW"&÷rW†—7G2—B—2Æ–æ¶VBFöòà¢òð¢òòFVÆ–&W&FVÇ’†öÆG2æò’vVæW&F–öââF†—2—2F†Rf–Æ–ær7—7FVÓ¢W&ÖæVçB”G2À¢òòV&æ6R6÷VçG26ö×WFVBg&öÒ&VÂf–v‡G2ÂvV"F–W'22FFÂfW'6–öà¢òò†—7F÷'’ÂæB6öç6VçBvFRF†Bç’gWGW&RvVæW&F–öâ×W7B72à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7Bf–v‡FW$¶W”öbÒ†æÖR’Óâ7G&–ær†æÖRÇÂrr¢çFôÆ÷vW$66R‚’ç&WÆ6R‚õµæ×£Ó•Ò²örÂrr’çG&–Ò‚“° ¦6öç7Bd”t…DU%ôÄUdTÅ2Òö&¦V7Bæg&VW¦R…°¢²¶W“¢u$ôô´”RrÂÖ–äV&æ6W3¢ÒÀ¢²¶W“¢t4ôåDTäDU"rÂÖ–äV&æ6W3¢2ÒÀ¢²¶W“¢udUDU$ârÂÖ–äV&æ6W3¢bÒÀ¢²¶W“¢tTÄ•DRrÂÖ–äV&æ6W3¢ÒÀ¢²¶W“¢tÄTtTäBrÂÖ–äV&æ6W3¢#RÒÀ¥Ò“° ¦6öç7Bf–v‡FW%&öf–ÆU66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢òòW&ÖæVçBÂæWfW"&WW6VBâÆÆö6FVBg&öÒâFöÖ–26÷VçFW"à¢fÔ–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ¢f–v‡FW$¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÂ–æFWƒ¢G'VRÒÀ¢F—7Æ”æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢6öÖ&Df–v‡FW$–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7÷'C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ ¢òò–ÖvW2âF†R÷&–v–æÂ—2æWfW"÷fW'w&—GFVâ(	BF†B—2F†Rv†öÆRö–çBà¢÷&–v–æÄ–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢'&æFVD–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢W6T'&æFVD–ÖvS¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢–ÖvU7FGW3¢°¢G—S¢7G&–ærÀ¢VçVÓ¢²væ÷E÷7F'FVBrÂwVWVVBrÂw&ö6W76–ærrÂw&Wf–WrrÂv6ö×ÆWFVBrÂvf–ÆVBuÒÀ¢FVfVÇC¢væ÷E÷7F'FVBrÀ¢ÒÀ¢–ÖvTW'&÷#¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ ¢òòÄ”´TäU524ôå4TåBâæòvVæW&F–öâÖ’'Vâv—F†÷WBF†—2â&V6÷&FVBv—F‚FFP¢òòæB6÷W&6R6ò—B—2VF—F&ÆRÂæ÷B6†V6¶&÷‚6öÖVöæR&VÖVÖ&W'2F–6¶–ærà¢Æ–¶VæW746öç6VçC¢°¢w&çFVC¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢w&çFVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢6÷W&6S¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&V6÷&FVD'“¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢ÒÀ ¢òò6ö×WFVBg&öÒ&VÂf–v‡G2ÂæWfW"G—VB–âà¢V&æ6W3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢V&æ6W5WFFVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢vV%F–W#¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢ÆWfVÃ¢²G—S¢7G&–ærÂFVfVÇC¢u$ôô´”RrÒÀ ¢ff–Æ–FU7FGW3¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢ff–Æ–FU6–æ6S¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢f÷VæF–ætff–Æ–FS¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7Bf–v‡FW$–ÖvUfW'6–öå66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢f–v‡FW$¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢6÷W&6T–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢vVæW&FVD–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7÷'C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢vV$FW6–vä–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&ö×EfW'6–öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&÷f–FW#¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7FGW3¢²G—S¢7G&–ærÂFVfVÇC¢w&Wf–WrrÒÀ¢&÷fVC¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢æ÷FS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7BvV$FW6–vå66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢7÷'C¢²G—S¢7G&–ærÂFVfVÇC¢vÆÂrÒÀ¢F–W#¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢Ö–æ–×VÔV&æ6W3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢Ö†–×VÔV&æ6W3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢&–Ö'”6öÆ÷#¢²G—S¢7G&–ærÂFVfVÇC¢r3rÒÀ¢6V6öæF'”6öÆ÷#¢²G—S¢7G&–ærÂFVfVÇC¢r6Fc"rÒÀ¢66VçD6öÆ÷#¢²G—S¢7G&–ærÂFVfVÇC¢r6c&#SCBrÒÀ¢FW6–vå&ö×C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢ÆövõÆ6VÖVçC¢²G—S¢7G&–ærÂFVfVÇC¢w6†÷'G5öÆ÷vW%öÆVrrÒÀ¢Æövõ66ÆS¢²G—S¢çVÖ&W"ÂFVfVÇC¢ãbÒÀ¢7V6–Å&WV—&VÖVçC¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7F—fS¢²G—S¢&ööÆVâÂFVfVÇC¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7Bf–v‡FW$–D6÷VçFW%66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢ö–C¢²G—S¢7G&–ærÂFVfVÇC¢vf–v‡FW"rÒÀ¢6W¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ§Ò“° ¦6öç7Bf–v‡FW%&öf–ÆRÒÖöævö÷6RæÖöFVÇ2äf–v‡FW%&öf–ÆRÇÂÖöævö÷6RæÖöFVÂ‚tf–v‡FW%&öf–ÆRrÂf–v‡FW%&öf–ÆU66†VÖ“°¦6öç7Bf–v‡FW$–ÖvUfW'6–öâÒÖöævö÷6RæÖöFVÇ2äf–v‡FW$–ÖvUfW'6–öâÇÂÖöævö÷6RæÖöFVÂ‚tf–v‡FW$–ÖvUfW'6–öârÂf–v‡FW$–ÖvUfW'6–öå66†VÖ“°¦6öç7BvV$FW6–vâÒÖöævö÷6RæÖöFVÇ2ävV$FW6–vâÇÂÖöævö÷6RæÖöFVÂ‚tvV$FW6–vârÂvV$FW6–vå66†VÖ“°¦6öç7Bf–v‡FW$–D6÷VçFW"ÒÖöævö÷6RæÖöFVÇ2äf–v‡FW$–D6÷VçFW"ÇÂÖöævö÷6RæÖöFVÂ‚tf–v‡FW$–D6÷VçFW"rÂf–v‡FW$–D6÷VçFW%66†VÖ“° ¢òòFöÖ–2Â6òGvò6–×VÇFæV÷W2f–v‡FW"7&VF–öç26ææ÷B6öÆÆ–FRöââ–Bà¦6öç7BÆÆö6FTf–v‡FW$–BÒ7–æ2‚’Óâ°¢6öç7B6÷VçFW"Òv—Bf–v‡FW$–D6÷VçFW"æf–æD'”–DæEWFFR€¢vf–v‡FW"rÀ¢²F–æ3¢²6W¢ÒÒÀ¢²æWs¢G'VRÂW6W'C¢G'VRÒÀ¢“°¢&WGW&âtdÒÒr²7G&–ær†6÷VçFW"ç6W’çE7F'BƒbÂsr“°§Ó° ¦6öç7BÆWfVÄf÷$V&æ6W2Ò†V&æ6W2’Óâ°¢ÆWBÆWfVÂÒu$ôô´”Rs°¢d”t…DU%ôÄUdTÅ2æf÷$V6‚‚†VçG'’’Óâ²–b†V&æ6W2ãÒVçG'’æÖ–äV&æ6W2’ÆWfVÂÒVçG'’æ¶W“²Ò“°¢&WGW&âÆWfVÃ°§Ó° ¢òòF–W'22F‡&W6†öÆG2†W&RÂ'WBF†RDU4”tå2&R&÷w2–âvV$FW6–vâ(	B6òæWp¢òòÆöö²—2&6²Ööff–6R&V6÷&BÂæ÷B6öFR6†ævRà¦6öç7BF–W$f÷$V&æ6W2Ò†V&æ6W2’Óâ°¢–b†V&æ6W2ãÒ’&WGW&âC°¢–b†V&æ6W2ãÒb’&WGW&â3°¢–b†V&æ6W2ãÒ2’&WGW&â#°¢&WGW&â°§Ó° ¢òòf–æB÷"7&VFR'’æÖRâ6ÆÆVBv†VæWfW"f–v‡BæÖW2f–v‡FW"Â6òF†R&÷7FW ¢òò'V–ÆG2—G6VÆbg&öÒF†Rf–v‡G2F†BÇ&VG’W†—7Bà¦6öç7BW6W'Df–v‡FW%&öf–ÆRÒ7–æ2‡²æÖRÂ7÷'BÒrrÂ–ÖvUW&ÂÒrrÂ6öÖ&Df–v‡FW$–BÒrrÒ’Óâ°¢6öç7Bf–v‡FW$¶W’Òf–v‡FW$¶W”öb†æÖR“°¢–b‚f–v‡FW$¶W’’&WGW&âçVÆÃ° ¢6öç7BW†—7F–ærÒv—Bf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò“°¢–b†W†—7F–ær’°¢ÆWBF—'G’ÒfÇ6S°¢òòf–ÆÂ&Ææ·2öæÇ’âæWfW"÷fW'w&—FRâ÷&–v–æÂ–ÖvRÂæBæWfW"&VæÖR¢òòf–v‡FW"g&öÒf–v‡B&V6÷&B(	BâFÖ–â÷vç2F†÷6Rf–VÆG2à¢–b‚W†—7F–æræ÷&–v–æÄ–ÖvUW&Âbb–ÖvUW&Â’²W†—7F–æræ÷&–v–æÄ–ÖvUW&ÂÒ–ÖvUW&Ã²F—'G’ÒG'VS²Ð¢–b‚W†—7F–ærç7÷'Bbb7÷'B’²W†—7F–ærç7÷'BÒ7÷'C²F—'G’ÒG'VS²Ð¢–b‚W†—7F–æræ6öÖ&Df–v‡FW$–Bbb6öÖ&Df–v‡FW$–B’²W†—7F–æræ6öÖ&Df–v‡FW$–BÒ7G&–ær†6öÖ&Df–v‡FW$–B“²F—'G’ÒG'VS²Ð¢–b†F—'G’’v—BW†—7F–ærç6fR‚“°¢&WGW&âW†—7F–æs°¢Ð ¢G'’°¢&WGW&âv—Bf–v‡FW%&öf–ÆRæ7&VFR‡°¢fÔ–C¢v—BÆÆö6FTf–v‡FW$–B‚’À¢f–v‡FW$¶W’À¢F—7Æ”æÖS¢7G&–ær†æÖR’çG&–Ò‚’ç6Æ–6RƒÂ#’À¢7÷'BÀ¢÷&–v–æÄ–ÖvUW&Ã¢–ÖvUW&ÂÀ¢6öÖ&Df–v‡FW$–C¢7G&–ær†6öÖ&Df–v‡FW$–BÇÂrr’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢òòVæ—VR–æFW‚&6S¢æ÷F†W"&WVW7B7&VFVB—BÖöÖVçBvòà¢–b†W'&÷#òæ6öFRÓÓÒ’&WGW&âf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò“°¢F‡&÷rW'&÷#°¢Ð§Ó° ¢òòV&æ6W26÷VçFVBg&öÒ7GVÂf–v‡G2Â2F†R7V26·2(	BçVÖ&W"æö&öG’6à¢òò–æfÆFR'’G—–ærà¦6öç7B&V6÷VçDf–v‡FW$V&æ6W2Ò7–æ2†f–v‡FW$¶W’’Óâ°¢6öç7B&öf–ÆRÒv—Bf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò“°¢–b‚&öf–ÆR’&WGW&âçVÆÃ°¢6öç7BæÖU&VvW‚ÒæWr&VtW‡‚uâr²&öf–ÆRæF—7Æ”æÖRç&WÆ6R‚õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÂuÅÂBbr’²rBrÂv’r“°¢6öç7B¶4Â4%ÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æ6÷VçDFö7VÖVçG2‡²ÖF6„f–v‡FW$¢æÖU&VvW‚Ò’À¢ÖF6‚æ6÷VçDFö7VÖVçG2‡²ÖF6„f–v‡FW$#¢æÖU&VvW‚Ò’À¢Ò“°¢6öç7BV&æ6W2Ò4²4#°¢6öç7BF–W"ÒF–W$f÷$V&æ6W2†V&æ6W2“°¢6öç7BF–W$6†ævVBÒF–W"ÓÒ&öf–ÆRævV%F–W#° ¢&öf–ÆRæV&æ6W2ÒV&æ6W3°¢&öf–ÆRæV&æ6W5WFFVDBÒæWrFFR‚“°¢&öf–ÆRævV%F–W"ÒF–W#°¢&öf–ÆRæÆWfVÂÒÆWfVÄf÷$V&æ6W2†V&æ6W2“°¢v—B&öf–ÆRç6fR‚“° ¢&WGW&â²&öf–ÆRÂF–W$6†ævVBÓ°§Ó° ¢òòD„R$U4ôÅdU"âöæRÆ6RFV6–FW2v†–6‚–7GW&R&W&W6VçG2f–v‡FW"Â6ò¢òò7v—F6‚g&öÒ÷&–v–æÂFò'&æFVB6†ævW2WfW'’67&VVâBöæ6Rà¦6öç7BvWD7F—fTf–v‡FW$–ÖvRÒ‡&öf–ÆR’Óâ°¢–b‚&öf–ÆR’&WGW&ârs°¢–b‡&öf–ÆRçW6T'&æFVD–ÖvRbb&öf–ÆRæ'&æFVD–ÖvUW&Â’&WGW&â&öf–ÆRæ'&æFVD–ÖvUW&Ã°¢&WGW&â&öf–ÆRæ÷&–v–æÄ–ÖvUW&ÂÇÂrs°§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòT$Ä”0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’öf–v‡FW'2ó¦¶W’rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡FW$¶W’Òf–v‡FW$¶W”öb‡&Wç&×2æ¶W’“°¢6öç7B&öf–ÆRÒv—Bf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò’æÆVâ‚“°¢–b‚&öf–ÆR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡FW"æ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢f–v‡FW#¢°¢fÔ–C¢&öf–ÆRæfÔ–BÀ¢æÖS¢&öf–ÆRæF—7Æ”æÖRÀ¢7÷'C¢&öf–ÆRç7÷'BÀ¢–ÖvS¢vWD7F—fTf–v‡FW$–ÖvR‡&öf–ÆR’À¢V&æ6W3¢&öf–ÆRæV&æ6W2À¢ÆWfVÃ¢&öf–ÆRæÆWfVÂÀ¢vV%F–W#¢&öf–ÆRævV%F–W"À¢ff–Æ–FS¢&öf–ÆRæff–Æ–FU7FGW2À¢f÷VæF–ætff–Æ–FS¢&öf–ÆRæf÷VæF–ætff–Æ–FRÀ¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡FW"Æöö·Wf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†Bf–v‡FW"ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öf–v‡FW'2rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–ÇFW"Ò·Ó°¢6öç7B7÷'BÒ7G&–ær‡&WçVW'’ç7÷'BÇÂrr’çG&–Ò‚“°¢–b‡7÷'B’f–ÇFW"ç7÷'BÒ7÷'C°¢6öç7Bf–v‡FW'2Òv—Bf–v‡FW%&öf–ÆRæf–æB†f–ÇFW"¢ç6÷'B‡²V&æ6W3¢ÓÂF—7Æ”æÖS¢Ò¢æÆ–Ö—B‡'6U÷6—F—fT–çFVvW"‡&WçVW'’æÆ–Ö—BÂÂ3’¢æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢f–v‡FW'3¢f–v‡FW'2æÖ‚‡&öf–ÆR’Óâ‡°¢fÔ–C¢&öf–ÆRæfÔ–BÀ¢¶W“¢&öf–ÆRæf–v‡FW$¶W’À¢æÖS¢&öf–ÆRæF—7Æ”æÖRÀ¢7÷'C¢&öf–ÆRç7÷'BÀ¢–ÖvS¢vWD7F—fTf–v‡FW$–ÖvR‡&öf–ÆR’À¢V&æ6W3¢&öf–ÆRæV&æ6W2À¢ÆWfVÃ¢&öf–ÆRæÆWfVÂÀ¢ff–Æ–FS¢&öf–ÆRæff–Æ–FU7FGW2À¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡FW"Æ—7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBf–v‡FW'2ârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòDÔ”à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò'V–ÆG2F†R&÷7FW"g&öÒWfW'’f–v‡BÇ&VG’–âF†RFF&6Râ6fRFò&R×'Vã ¢òòW6W'Df–v‡FW%&öf–ÆRf–ÆÇ2&Ææ·2æBæWfW"÷fW'w&—FW2à¦ç÷7B‚rö’öFÖ–âöf–v‡FW'2ö&6¶f–ÆÂrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡·Ò¢ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"f–v‡FW$–ÖvRf–v‡FW$$–ÖvRÖF6„6FVv÷'’f–v‡FW$–Bf–v‡FW$$–Br¢æÆ–Ö—BƒS’æÆVâ‚“° ¢ÆWB7&VFVBÒ°¢6öç7B6VVâÒæWr6WB‚“°¢f÷"†6öç7Bf–v‡Böbf–v‡G2’°¢f÷"†6öç7B¶æÖRÂ–ÖvRÂ–EÒöb°¢¶f–v‡BæÖF6„f–v‡FW$Âf–v‡Bæf–v‡FW$–ÖvRÂf–v‡Bæf–v‡FW$–EÒÀ¢¶f–v‡BæÖF6„f–v‡FW$"Âf–v‡Bæf–v‡FW$$–ÖvRÂf–v‡Bæf–v‡FW$$–EÒÀ¢Ò’°¢6öç7B¶W’Òf–v‡FW$¶W”öb†æÖR“°¢–b‚¶W’ÇÂ6VVâæ†2†¶W’’’6öçF–çVS°¢6VVâæFB†¶W’“°¢6öç7B&Vf÷&RÒv—Bf–v‡FW%&öf–ÆRæ6÷VçDFö7VÖVçG2‡²f–v‡FW$¶W“¢¶W’Ò“°¢v—BW6W'Df–v‡FW%&öf–ÆR‡°¢æÖRÀ¢7÷'C¢7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚’À¢–ÖvUW&Ã¢–ÖvRÇÂrrÀ¢6öÖ&Df–v‡FW$–C¢–Bò7G&–ær†–B’¢rrÀ¢Ò“°¢–b‚&Vf÷&R’7&VFVB³Ò°¢Ð¢Ð ¢òòF†Vâ6÷VçBV&æ6W2f÷"WfW'–öæRf÷VæBà¢ÆWB&V6÷VçFVBÒ°¢f÷"†6öç7B¶W’öb6VVâ’°¢G'’²v—B&V6÷VçDf–v‡FW$V&æ6W2†¶W’“²&V6÷VçFVB³Ò²Ò6F6‚†W'&÷"’²ò¢¶VWvö–ær¢òÐ¢Ð ¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂf–v‡G566ææVC¢f–v‡G2æÆVæwF‚Âf–v‡FW'4f÷VæC¢6VVâç6—¦RÂ7&VFVBÂ&V6÷VçFVBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡FW"&6¶f–ÆÂf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t&6¶f–ÆÂf–ÆVBârÒ“°¢Ð§Ò“° ¢òò6öç6VçBâFVÆ–&W&FVÇ’—G2÷vâVæGö–çBv—F‚—G2÷vâVF—Bf–VÆG2(	BF†—2—2F†P¢òòvFRç’gWGW&RvVæW&F–öâ×W7B72Â6ò—B6†÷VÆB&R†&BFò6WB'’66–FVçBà¦ç÷7B‚rö’öFÖ–âöf–v‡FW'2ó¦¶W’ö6öç6VçBrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡FW$¶W’Òf–v‡FW$¶W”öb‡&Wç&×2æ¶W’“°¢6öç7Bw&çFVBÒ&Wæ&öG“òæw&çFVBÓÓÒG'VS°¢6öç7B6÷W&6RÒ7G&–ær‡&Wæ&öG“òç6÷W&6RÇÂrr’çG&–Ò‚“°¢–b†w&çFVBbb6÷W&6R’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢u&V6÷&Bv†W&RF†R6öç6VçB6ÖRg&öÒ‡6–væVBw&VVÖVçBÂVÖ–ÂÂff–Æ–FR6öçG&7B’ârÀ¢6öFS¢t4ôå4TåEõ4õU$4Uõ$UT•$TBrÀ¢Ò“°¢Ð¢6öç7B&öf–ÆRÒv—Bf–v‡FW%&öf–ÆRæf–æDöæTæEWFFR€¢²f–v‡FW$¶W’ÒÀ¢°¢G6WC¢°¢vÆ–¶VæW746öç6VçBæw&çFVBs¢w&çFVBÀ¢vÆ–¶VæW746öç6VçBæw&çFVDBs¢w&çFVBòæWrFFR‚’¢çVÆÂÀ¢vÆ–¶VæW746öç6VçBç6÷W&6Rs¢w&çFVBò6÷W&6Rç6Æ–6RƒÂ#’¢rrÀ¢vÆ–¶VæW746öç6VçBç&V6÷&FVD'’s¢7G&–ær‡&WæFÖ–ãòæ–BÇÂvFÖ–âr’À¢ÒÀ¢ÒÀ¢²æWs¢G'VRÒÀ¢’æÆVâ‚“°¢–b‚&öf–ÆR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡FW"æ÷Bf÷VæBârÒ“°¢6öç6öÆRæÆör†¶6öç6VçEÒG¶f–v‡FW$¶W—ÒÆ–¶VæW726öç6VçBG¶w&çFVBòtu$åDTBr¢w&Wfö¶VBwÒ'’G·&WæFÖ–ãòæ–BÇÂvFÖ–âwÖ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂfÔ–C¢&öf–ÆRæfÔ–BÂÆ–¶VæW746öç6VçC¢&öf–ÆRæÆ–¶VæW746öç6VçBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6öç6VçBWFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B&V6÷&B6öç6VçBârÒ“°¢Ð§Ò“° ¢òòF†RvFR—G6VÆbÂ6ò—BW†—7G2&Vf÷&Rç—F†–ær6âvVæW&FRà¦6öç7B76W'DÆ–¶VæW746öç6VçBÒ7–æ2†f–v‡FW$¶W’’Óâ°¢6öç7B&öf–ÆRÒv—Bf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò’ç6VÆV7B‚vÆ–¶VæW746öç6VçBF—7Æ”æÖRr’æÆVâ‚“°¢–b‚&öf–ÆR’F‡&÷ræWrW'&÷"‚td”t…DU%ôäõEôdõTäBr“°¢–b‚&öf–ÆRæÆ–¶VæW746öç6VçCòæw&çFVB’°¢6öç7BW'&÷"ÒæWrW'&÷"†æòÆ–¶VæW726öç6VçB&V6÷&FVBf÷"G·&öf–ÆRæF—7Æ”æÖWÒâvVæW&F–öâ&VgW6VBæ“°¢W'&÷"æ6öFRÒtÄ”´TäU55ô4ôå4TåEôÔ•54”ärs°¢F‡&÷rW'&÷#°¢Ð¢&WGW&â&öf–ÆS°§Ó° ¦ç÷7B‚rö’öFÖ–âöf–v‡FW'2ó¦¶W’ö–ÖvRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡FW$¶W’Òf–v‡FW$¶W”öb‡&Wç&×2æ¶W’“°¢6öç7B&öf–ÆRÒv—Bf–v‡FW%&öf–ÆRæf–æDöæR‡²f–v‡FW$¶W’Ò“°¢–b‚&öf–ÆR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡FW"æ÷Bf÷VæBârÒ“° ¢òò'&æFVB–ÖvRÖ’öæÇ’&RGF6†VBFòf–v‡FW"v†ò6öç6VçFVB(	BF†R6ÖP¢òòvFRvVæW&F÷"v÷VÆB†—BÂÆ–VBFòÖçVÂWÆöBFöòà¢–b‡&Wæ&öG“òæ'&æFVD–ÖvUW&Â’°¢G'’°¢v—B76W'DÆ–¶VæW746öç6VçB†f–v‡FW$¶W’“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢W'&÷"æÖW76vRÂ6öFS¢W'&÷"æ6öFRÇÂt4ôå4TåEõ$UT•$TBrÒ“°¢Ð¢òò¶VWF†R&Wf–÷W2Æöö²&V6÷fW&&ÆR&Vf÷&R&WÆ6–ær—Bà¢–b‡&öf–ÆRæ'&æFVD–ÖvUW&Â’°¢v—Bf–v‡FW$–ÖvUfW'6–öâæ7&VFR‡°¢f–v‡FW$¶W’À¢6÷W&6T–ÖvUW&Ã¢&öf–ÆRæ÷&–v–æÄ–ÖvUW&ÂÀ¢vVæW&FVD–ÖvUW&Ã¢&öf–ÆRæ'&æFVD–ÖvUW&ÂÀ¢7÷'C¢&öf–ÆRç7÷'BÀ¢7FGW3¢w7WW'6VFVBrÀ¢&÷fVC¢&öf–ÆRçW6T'&æFVD–ÖvRÀ¢æ÷FS¢u&WÆ6VB'’æWvW"'&æFVB–ÖvRârÀ¢Ò“°¢Ð¢&öf–ÆRæ'&æFVD–ÖvUW&ÂÒ7G&–ær‡&Wæ&öG’æ'&æFVD–ÖvUW&Â’çG&–Ò‚“°¢&öf–ÆRæ–ÖvU7FGW2Òw&Wf–Wrs°¢Ð ¢–b‡G—Vöb&Wæ&öG“òçW6T'&æFVD–ÖvRÓÓÒv&ööÆVâr’°¢–b‡&Wæ&öG’çW6T'&æFVD–ÖvRbb&öf–ÆRæ'&æFVD–ÖvUW&Â’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæò'&æFVB–ÖvRFò7v—F6‚FòârÒ“°¢Ð¢&öf–ÆRçW6T'&æFVD–ÖvRÒ&Wæ&öG’çW6T'&æFVD–ÖvS°¢–b‡&Wæ&öG’çW6T'&æFVD–ÖvR’&öf–ÆRæ–ÖvU7FGW2Òv6ö×ÆWFVBs°¢Ð¢–b‡&Wæ&öG“òæ÷&–v–æÄ–ÖvUW&Âbb&öf–ÆRæ÷&–v–æÄ–ÖvUW&Â’°¢&öf–ÆRæ÷&–v–æÄ–ÖvUW&ÂÒ7G&–ær‡&Wæ&öG’æ÷&–v–æÄ–ÖvUW&Â’çG&–Ò‚“°¢Ð ¢v—B&öf–ÆRç6fR‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢fÔ–C¢&öf–ÆRæfÔ–BÀ¢7F—fT–ÖvS¢vWD7F—fTf–v‡FW$–ÖvR‡&öf–ÆR’À¢–ÖvU7FGW3¢&öf–ÆRæ–ÖvU7FGW2À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡FW"–ÖvRWFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BWFFRF†Bf–v‡FW"ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–âöf–v‡FW'2ó¦¶W’÷fW'6–öç2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BfW'6–öç2Òv—Bf–v‡FW$–ÖvUfW'6–öâæf–æB‡²f–v‡FW$¶W“¢f–v‡FW$¶W”öb‡&Wç&×2æ¶W’’Ò¢ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—BƒS’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂfW'6–öç2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBfW'6–öç2ârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–âöf–v‡FW'2ó¦¶W’÷&V6÷VçBrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&V6÷VçDf–v‡FW$V&æ6W2†f–v‡FW$¶W”öb‡&Wç&×2æ¶W’’“°¢–b‚&W7VÇB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡FW"æ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢fÔ–C¢&W7VÇBç&öf–ÆRæfÔ–BÀ¢V&æ6W3¢&W7VÇBç&öf–ÆRæV&æ6W2À¢vV%F–W#¢&W7VÇBç&öf–ÆRævV%F–W"À¢ÆWfVÃ¢&W7VÇBç&öf–ÆRæÆWfVÂÀ¢F–W$6†ævVC¢&W7VÇBçF–W$6†ævVBÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&V6÷VçBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u&V6÷VçBf–ÆVBârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–âövV"ÖFW6–vç2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“°¢–b‚æÖR’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tFW6–vâæÖR—2&WV—&VBârÒ“°¢6öç7BFW6–vâÒv—BvV$FW6–vâæ7&VFR‡°¢æÖS¢æÖRç6Æ–6RƒÂ#’À¢7÷'C¢7G&–ær‡&Wæ&öG“òç7÷'BÇÂvÆÂr’çFôÆ÷vW$66R‚’À¢F–W#¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òçF–W"’ÇÂ’’À¢Ö–æ–×VÔV&æ6W3¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæÖ–æ–×VÔV&æ6W2’ÇÂ’’À¢Ö†–×VÔV&æ6W3¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæÖ†–×VÔV&æ6W2’ÇÂ’’À¢&–Ö'”6öÆ÷#¢7G&–ær‡&Wæ&öG“òç&–Ö'”6öÆ÷"ÇÂr3r’À¢6V6öæF'”6öÆ÷#¢7G&–ær‡&Wæ&öG“òç6V6öæF'”6öÆ÷"ÇÂr6Fc"r’À¢66VçD6öÆ÷#¢7G&–ær‡&Wæ&öG“òæ66VçD6öÆ÷"ÇÂr6c&#SCBr’À¢FW6–vå&ö×C¢7G&–ær‡&Wæ&öG“òæFW6–vå&ö×BÇÂrr’ç6Æ–6RƒÂ#’À¢ÆövõÆ6VÖVçC¢7G&–ær‡&Wæ&öG“òæÆövõÆ6VÖVçBÇÂw6†÷'G5öÆ÷vW%öÆVrr’À¢Æövõ66ÆS¢çVÖ&W"‡&Wæ&öG“òæÆövõ66ÆR’ÇÂãbÀ¢7V6–Å&WV—&VÖVçC¢7G&–ær‡&Wæ&öG“òç7V6–Å&WV—&VÖVçBÇÂrr’ç6Æ–6RƒÂ#’À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂFW6–vä–C¢FW6–vâåö–BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tvV"FW6–vâ7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7&VFRF†BFW6–vâârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–âövV"ÖFW6–vç2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BFW6–vç2Òv—BvV$FW6–vâæf–æB‡·Ò’ç6÷'B‡²7÷'C¢ÂF–W#¢Ò’æÆ–Ö—Bƒ#’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂFW6–vç2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBFW6–vç2ârÒ“°¢Ð§Ò“° ¢òò&÷7FW"÷fW'f–Wrf÷"F†R&6²öff–6S¢v†òæVVG26öç6VçBÂv†òæVVG2â–ÖvRà¦ævWB‚rö’öFÖ–âöf–v‡FW'2ö÷fW'f–WrrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B·F÷FÂÂ6öç6VçFVBÂ'&æFVBÂÆ—fUÒÒv—B&öÖ—6RæÆÂ…°¢f–v‡FW%&öf–ÆRæ6÷VçDFö7VÖVçG2‡·Ò’À¢f–v‡FW%&öf–ÆRæ6÷VçDFö7VÖVçG2‡²vÆ–¶VæW746öç6VçBæw&çFVBs¢G'VRÒ’À¢f–v‡FW%&öf–ÆRæ6÷VçDFö7VÖVçG2‡²'&æFVD–ÖvUW&Ã¢²FæS¢rrÒÒ’À¢f–v‡FW%&öf–ÆRæ6÷VçDFö7VÖVçG2‡²W6T'&æFVD–ÖvS¢G'VRÒ’À¢Ò“°¢6öç7BæVVG46öç6VçBÒv—Bf–v‡FW%&öf–ÆRæf–æB‡²vÆ–¶VæW746öç6VçBæw&çFVBs¢²FæS¢G'VRÒÒ¢ç6VÆV7B‚vfÔ–BF—7Æ”æÖRV&æ6W27÷'Br’ç6÷'B‡²V&æ6W3¢ÓÒ’æÆ–Ö—BƒS’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢F÷FÇ3¢²f–v‡FW'3¢F÷FÂÂv—F„6öç6VçC¢6öç6VçFVBÂv—F„'&æFVD–ÖvS¢'&æFVBÂ6†÷v–æt'&æFVC¢Æ—fRÒÀ¢òò†–v†W7BV&æ6R6÷VçBf—'7B(	BF†Rf–v‡FW'2v÷'F‚6¶–ærf—'7Bà¢æVVG46öç6VçBÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡FW"÷fW'f–Wrf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†R&÷7FW"÷fW'f–WrârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòÄTuTRäõD”4U2(	B†÷r&öÖ÷FW"&V6†W2F†RÆ–W'2F†W’'&÷Vv‡B–à¢òð¢òòæ÷F†–ærW†—7FVBâ&öÖ÷FW"6÷VÆBWB6&BWæBF†V—"ÆVwVRÖVÖ&W'2†@¢òòæòv’FòÆV&â&÷WB—BW†6WB÷Væ–ærF†RæBæ÷F–6–ærâF†B'&V·2F†P¢òòff–Æ–FRÖöFVÃ¢–÷R6²6öÖVöæRFò'&–ær–÷RÆ–W'2ÂF†Vâv—fRF†VÒæòv¢òòFò&V6‚F†VÒà¢òð¢òò&öÖ÷FW"ääõTä4U2FVÆ–&W&FVÇ’&F†W"F†âF†R7—7FVÒf—&–æröâWfW'¢òò&öÖ÷F–öââGvò&V6öç3¢F†R&öÖ÷FW"¶æ÷w2v†–6‚öbF†V—"6&G2—2v÷'F‚à¢òò–æ&÷‚ÂæBâWFöÖF–26VæBöâWfW'’w&—FRF‚†7&VF–öâÂ6†F÷rÆ–æ²ÂFÖ–à¢òòVF—B’v÷VÆBf—&R6WfW&ÂF–ÖW2f÷"öæRf–v‡Bà¢òð¢òòWfW'’æ÷F–6R&V6†W2F†RÆVwVRw2&VÆÇ2âVÖ–Â—2&FRÖÆ–Ö—FVBÂ&V6W6RöæP¢òò&öÖ÷FW"v—F‚Æ&vRÆVwVRÖ–Æ–ærWfW'’6&Bv÷VÆB'W&âF†RÆFf÷&Òw0¢òò6VæF–ær&WWFF–öâW†7FÇ’2F†RöÆBÆFf÷&Ò×v–FR&Æ7BF–Bà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbäÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2ÇÂ#B’“°¦6öç7BÄTuTUôTÔ”ÅôÔ…õ$T4•”TåE2ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbäÄTuTUôTÔ”ÅôÔ…õ$T4•”TåE2ÇÂS’“° ¦6öç7BÆVwVTæ÷F–6U66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢ff–Æ–FT–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢ff–Æ–FTæÖS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢f–v‡D–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢6÷W&6UG—S¢²G—S¢7G&–ærÂVçVÓ¢²vÖF6‚rÂw6†F÷ruÒÂFVfVÇC¢vÖF6‚rÒÀ¢†VFÆ–æS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢&öG“¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òò6æ6†÷Böbv†ò—BvVçBFòÂ6ò&V6‚—2ç7vW&&ÆRÆFW"æBF†R&öÖ÷FW ¢òò6â6VRv†WF†W"—BÆæFVBà¢ÖVÖ&W$6÷VçC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢VÖ–ÆVD6÷VçC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢VÖ–Å6¶—VE&V6öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦ÆVwVTæ÷F–6U66†VÖæ–æFW‚‡²ff–Æ–FT–C¢Â7&VFVDC¢ÓÒ“° ¦6öç7BÆVwVTæ÷F–6RÒÖöævö÷6RæÖöFVÇ2äÆVwVTæ÷F–6RÇÂÖöævö÷6RæÖöFVÂ‚tÆVwVTæ÷F–6RrÂÆVwVTæ÷F–6U66†VÖ“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòääõTä4P¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öff–Æ–FW2öÖR÷&öÖ÷F–öç2ó¦f–v‡D–Böææ÷Væ6RrÂ7V&Ö—DÆ–Ö—FW"ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“° ¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B¢ç6VÆV7B‚uö–BfW&–f–VBÆ–W$æÖRf—'7DæÖRÆ7DæÖRÆVwVTæÖRW6W'4¦ö–æVBr’æÆVâ‚“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tff–Æ–FR66÷VçBæ÷Bf÷VæBârÒ“°¢–b‚ff–Æ–FRçfW&–f–VB’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u–÷W"ÆVwVR×W7B&R&÷fVB&Vf÷&R–÷R6â6VæBæ÷F–6W2ârÂ6öFS¢täõEõdU$”d”TBrÒ“°¢Ð ¢òòF†R&öÖ÷FW"×W7B7GVÆÇ’&RGF6†VBFòF†—2f–v‡B(	B÷F†W'v—6R¢òò&öÖ÷FW"6÷VÆBææ÷Væ6RÂæBF¶R7&VF—Bf÷"Â6öÖV&öG’VÇ6Rw26&Bà¢ÆWBf–v‡BÒçVÆÃ°¢ÆWB6÷W&6UG—RÒvÖF6‚s°¢–b†Ööævö÷6Ræ—5fÆ–Dö&¦V7D–B†f–v‡D–B’’°¢f–v‡BÒv—BÖF6‚æf–æDöæR‡²ö–C¢f–v‡D–BÂff–Æ–FT–BÒ’ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6…Fö¶Vç2ÖF6„6FVv÷'’r’æÆVâ‚“°¢–b‚f–v‡B’°¢6öç7B6†F÷rÒv—B6†F÷ræf–æDöæR‡°¢ö–C¢f–v‡D–BÀ¢tff–Æ–FT–G2äff–Æ–FT–Bs¢Ööævö÷6RåG—W2äö&¦V7D–Bæ—5fÆ–B†ff–Æ–FT–B’òæWrÖöævö÷6RåG—W2äö&¦V7D–B†ff–Æ–FT–B’¢ff–Æ–FT–BÀ¢Ò’ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6…Fö¶Vç2ÖF6„6FVv÷'’r’æÆVâ‚“°¢–b‡6†F÷r’²f–v‡BÒ6†F÷s²6÷W&6UG—RÒw6†F÷rs²Ð¢Ð¢Ð¢–b‚f–v‡B’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†Bf–v‡B—2æ÷BöæRöb–÷W'2Fòææ÷Væ6RârÂ6öFS¢täõEõ”õU%ôd”t…BrÒ“°¢Ð ¢6öç7BÖVÖ&W'2Ò'&’æ—4'&’†ff–Æ–FRçW6W'4¦ö–æVB’òff–Æ–FRçW6W'4¦ö–æVB¢µÓ°¢–b†ÖVÖ&W'2æÆVæwF‚ÓÓÒ’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæö&öG’†2¦ö–æVB–÷W"ÆVwVR–WBârÂ6öFS¢tTÕE•ôÄTuTRrÒ“°¢Ð ¢6öç7B&öÖ÷FW$æÖRÒ¶ff–Æ–FRæÆVwVTæÖRÂff–Æ–FRçÆ–W$æÖRÂff–Æ–FRæf—'7DæÖUÒæÖ‚‡b’Óâ7G&–ær‡bÇÂrr’çG&–Ò‚’’æf–æB„&ööÆVâ’ÇÂu–÷W"ÆVwVRs°¢6öç7B—"Ò¶f–v‡BæÖF6„f–v‡FW$Âf–v‡BæÖF6„f–v‡FW$%Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rg2r“°¢6öç7BfVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’“°¢6öç7B†VFÆ–æRÒ7G&–ær‡&Wæ&öG“òæ†VFÆ–æRÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂ#¢ÇÂ‡—"òG·&öÖ÷FW$æÖWÒWBWG·—'Ö¢G·&öÖ÷FW$æÖWÒ†2æWr6&F“°¢6öç7B&öG’Ò7G&–ær‡&Wæ&öG“òæÖW76vRÇÂrr’çG&–Ò‚’ç6Æ–6RƒÂ3¢ÇÂ†fVRâòG¶fVRçFôÆö6ÆU7G&–ær‚—ÒdÒFòVçFW"æ¢tg&VRFòVçFW"âr“° ¢òòVÖ–Â6ööÆF÷vâÂW"&öÖ÷FW"âF†Ræ÷F–6R7F–ÆÂvöW2FòWfW'’&VÆÂ(	@¢òòöæÇ’F†R–æ&÷‚—2F‡&÷GFÆVBà¢6öç7B7WFöfbÒæWrFFR„FFRææ÷r‚’ÒÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2¢3c¢“°¢6öç7B&V6VçDVÖ–ÂÒv—BÆVwVTæ÷F–6Ræf–æDöæR‡°¢ff–Æ–FT–BÂVÖ–ÆVD6÷VçC¢²FwC¢ÒÂ7&VFVDC¢²FwFS¢7WFöfbÒÀ¢Ò’ç6VÆV7B‚v7&VFVDBr’æÆVâ‚“° ¢ÆWBVÖ–ÆVD6÷VçBÒ°¢ÆWBVÖ–Å6¶—VE&V6öâÒrs° ¢–b‡&V6VçDVÖ–Â’°¢6öç7B†÷W'4ÆVgBÒÖF‚æÖ‚ƒÂÖF‚æ6V–Â‚†æWrFFR‡&V6VçDVÖ–Âæ7&VFVDB’ævWEF–ÖR‚’²ÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2¢3c¢ÒFFRææ÷r‚’’ò3c’“°¢VÖ–Å6¶—VE&V6öâÒVÖ–Â6ööÆF÷vâ(	B–÷R6âVÖ–Â–÷W"ÆVwVRv–â–â&÷WBG¶†÷W'4ÆVgGÖ‚âF†—2æ÷F–6R7F–ÆÂvVçBFòWfW'’ÖVÖ&W"w2æ÷F–f–6F–öç2æ°¢ÒVÇ6R°¢òòöæÇ’ÖVÖ&W'2v†ò†fRæ÷B÷FVB÷WBöbÖ–Âà¢6öç7BÖVÖ&W$–G2ÒÖVÖ&W'2æÖ‚†Ò’Óâ7G&–ær†ÒçW6W$–B’’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7B&V6—–VçG2ÒÖVÖ&W$–G2æÆVæwF€¢òv—BW6W"æf–æB‡°¢ö–C¢²F–ã¢ÖVÖ&W$–G2ÒÀ¢—57V'67&–&VC¢²FæS¢fÇ6RÒÀ¢—4æ÷F–f–6F–öç4Væ&ÆVC¢²FæS¢fÇ6RÒÀ¢Ò’ç6VÆV7B‚vVÖ–Âf—'7DæÖRr’æÆ–Ö—B„ÄTuTUôTÔ”ÅôÔ…õ$T4•”TåE2’æÆVâ‚¢¢µÓ° ¢6öç7BW&ÂÒ7G&–ær‡&ö6W72æVçbåT$Ä”5ôõU$ÂÇÂv‡GG3¢ò÷wwræfçF7–ÖÖFæW72æ6öÒr’ç&WÆ6R‚õÂòBòÂrr“°¢v—B&öÖ—6RæÆÅ6WGFÆVB‡&V6—–VçG2æf–ÇFW"‚‡"’Óâ"æVÖ–Â’æÖ‚‡&V6—–VçB’ÓâG&ç7÷'FW"ç6VæDÖ–Â‡°¢g&öÓ¢dÔÕôÔ”Åôe$ôÒÀ¢Fó¢&V6—–VçBæVÖ–ÂÀ¢7V&¦V7C¢†VFÆ–æRÀ¢‡FÖÃ¢ÆF—b7G–ÆSÒ&föçBÖfÖ–Ç“¤&–ÂÄ†VÇfWF–6Ç6ç2×6W&–c¶6öÆ÷#¢3#cC¶Ö‚×v–GFƒ£cƒ¶Ö&v–ã¦WFò#à¢Çä†’G¶W66T‡FÖÂ‡&V6—–VçBæf—'7DæÖRÇÂwF†W&Rr—ÒÃÂ÷à¢Ç7G–ÆSÒ&föçB×6—¦S£w‚#ãÇ7G&öæsâG¶W66T‡FÖÂ††VFÆ–æR—ÓÂ÷7G&öæsãÂ÷à¢ÇâG¶W66T‡FÖÂ†&öG’—ÓÂ÷à¢G¶f–v‡BæÖF6„FFRòÇ7G–ÆSÒ&6öÆ÷#¢3VCVSR#äf–v‡BFFS¢G¶W66T‡FÖÂ…7G&–ær†f–v‡BæÖF6„FFR’ç6Æ–6RƒÂ’—ÓÂ÷æ¢rwÐ¢ÇãÆ‡&VcÒ"G¶W&ÇÒ"7G–ÆSÒ&F—7Æ“¦–æÆ–æRÖ&Æö6³·FF–æs£‚#ƒ¶&6¶w&÷VæC¢6c&#SCC¶6öÆ÷#¢3&##·FW‡BÖFV6÷&F–öã¦æöæS¶&÷&FW"×&F—W3£gƒ¶föçB×vV–v‡C¦&öÆB#ä÷VâfçF7’ÔÔFæW73ÂöãÂ÷à¢Ç7G–ÆSÒ&föçB×6—¦S£'ƒ¶6öÆ÷#¢3†ƒSs’#å–÷R&RvWGF–ærF†—2&V6W6R–÷R¦ö–æVBG¶W66T‡FÖÂ‡&öÖ÷FW$æÖR—ÒöâfçF7’ÔÔFæW72â–÷R6âGW&âÆVwVRVÖ–Ç2öfb–â–÷W"66÷VçB6WGF–æw2ãÂ÷à¢ÂöF—cæÀ¢Ò’æ6F6‚‚†W'&÷"’Óâ²6öç6öÆRæW'&÷"‚tÆVwVRæ÷F–6RÖ–Âf–ÆVC¢rÂW'&÷"æÖW76vR“²Ò’’“°¢VÖ–ÆVD6÷VçBÒ&V6—–VçG2æÆVæwFƒ°¢Ð ¢6öç7Bæ÷F–6RÒv—BÆVwVTæ÷F–6Ræ7&VFR‡°¢ff–Æ–FT–BÀ¢ff–Æ–FTæÖS¢&öÖ÷FW$æÖRÀ¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢6÷W&6UG—RÀ¢†VFÆ–æRÀ¢&öG’À¢ÖVÖ&W$6÷VçC¢ÖVÖ&W'2æÆVæwF‚À¢VÖ–ÆVD6÷VçBÀ¢VÖ–Å6¶—VE&V6öâÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢æ÷F–6T–C¢æ÷F–6Råö–BÀ¢&V6†VD&VÆÇ3¢ÖVÖ&W'2æÆVæwF‚À¢VÖ–ÆVC¢VÖ–ÆVD6÷VçBÀ¢VÖ–Å6¶—VE&V6öã¢VÖ–Å6¶—VE&V6öâÇÂVæFVf–æVBÀ¢ÖW76vS¢VÖ–ÆVD6÷Vç@¢ò6VçBFòG¶ÖVÖ&W'2æÆVæwF‡ÒÖVÖ&W"G¶ÖVÖ&W'2æÆVæwF‚ÓÓÒòrr¢w2wÒ(	BG¶VÖ–ÆVD6÷VçGÒ'’VÖ–Âæ ¢¢÷7FVBFòG¶ÖVÖ&W'2æÆVæwF‡ÒÖVÖ&W"G¶ÖVÖ&W'2æÆVæwF‚ÓÓÒòrr¢w2wÒræ÷F–f–6F–öç2æÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tÆVwVRææ÷Væ6Rf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6VæBF†Bæ÷F–6RârÒ“°¢Ð§Ò“° ¢òòv†BF†R&öÖ÷FW"6â6VR&÷WBF†V—"÷vâ&V6‚à¦ævWB‚rö’öff–Æ–FW2öÖR÷&öÖ÷F–öç2÷&V6‚rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B’ç6VÆV7B‚wW6W'4¦ö–æVBÆVwVTæÖRÆ–W$æÖRr’æÆVâ‚“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tff–Æ–FR66÷VçBæ÷Bf÷VæBârÒ“° ¢6öç7BÖVÖ&W'2Ò'&’æ—4'&’†ff–Æ–FRçW6W'4¦ö–æVB’òff–Æ–FRçW6W'4¦ö–æVB¢µÓ°¢6öç7Bæ÷F–6W2Òv—BÆVwVTæ÷F–6Ræf–æB‡²ff–Æ–FT–BÒ’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7B7WFöfbÒæWrFFR„FFRææ÷r‚’ÒÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2¢3c¢“°¢6öç7BÆ7DVÖ–ÂÒæ÷F–6W2æf–æB‚†â’ÓââæVÖ–ÆVD6÷VçBâbbæWrFFR†âæ7&VFVDB’ãÒ7WFöfb“° ¢òò†÷rÖç’öbF†—2&öÖ÷FW"w2ÖVÖ&W'2†fR7GVÆÇ’VçFW&VB6öÖWF†–ær(	BF†P¢òòçVÖ&W"F†BFVÆÇ2F†VÒv†WF†W"F†V—"ÆVwVR—2Æ—fRà¢6öç7BÖVÖ&W$–G2ÒÖVÖ&W'2æÖ‚†Ò’Óâ7G&–ær†ÒçW6W$–B’’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7B7F—fTÖVÖ&W'2ÒÖVÖ&W$–G2æÆVæwF€¢ò†v—B66÷&RæF—7F–æ7B‚wÆ–W$–BrÂ²Æ–W$–C¢²F–ã¢ÖVÖ&W$–G2ÒÒ’’æÆVæwF€¢¢° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ÆVwVTæÖS¢¶ff–Æ–FRæÆVwVTæÖRÂff–Æ–FRçÆ–W$æÖUÒæÖ‚‡b’Óâ7G&–ær‡bÇÂrr’çG&–Ò‚’’æf–æB„&ööÆVâ’ÇÂu–÷W"ÆVwVRrÀ¢ÖVÖ&W'3¢ÖVÖ&W'2æÆVæwF‚À¢7F—fTÖVÖ&W'2À¢¦ö–æVDÆ7CtF—3¢ÖVÖ&W'2æf–ÇFW"‚†Ò’ÓâÒæ¦ö–æVDBbb„FFRææ÷r‚’ÒæWrFFR†Òæ¦ö–æVDB’ævWEF–ÖR‚’’Âr¢ƒcC’æÆVæwF‚À¢VÖ–Äf–Æ&ÆS¢Æ7DVÖ–ÂÀ¢VÖ–Ä6ööÆF÷vä†÷W'3¢ÄTuTUôTÔ”Åô4ôôÄDõtåô„õU%2À¢æ÷F–6W3¢æ÷F–6W2æÖ‚†â’Óâ‡°¢–C¢âåö–BÀ¢†VFÆ–æS¢âæ†VFÆ–æRÀ¢6VçDC¢âæ7&VFVDBÀ¢&V6†VD&VÆÇ3¢âæÖVÖ&W$6÷VçBÀ¢VÖ–ÆVC¢âæVÖ–ÆVD6÷VçBÀ¢æ÷FS¢âæVÖ–Å6¶—VE&V6öâÇÂrrÀ¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&öÖ÷FW"&V6‚f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"&V6‚ârÒ“°¢Ð§Ò“° ¢òò&VG’ÖÖFR6†&RFW‡BæBÆ–æ²Â6ò&öÖ÷FW"—2æ÷B6ö×÷6–ær÷7Bg&öÐ¢òò67&F6‚WfW'’F–ÖRâF—7G&–'WF–öâ—2Ö÷7FÇ’g&–7F–öâ(	BF†—2&VÖ÷fW26öÖRà¦ævWB‚rö’öff–Æ–FW2öÖR÷&öÖ÷F–öç2ó¦f–v‡D–B÷6†&RrÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B’ç6VÆV7B‚vÆVwVTæÖRÆ–W$æÖR&öf–ÆUW&Âr’æÆVâ‚“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tff–Æ–FR66÷VçBæ÷Bf÷VæBârÒ“° ¢6öç7Bf–v‡BÒÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†f–v‡D–B¢òv—BÖF6‚æf–æD'”–B†f–v‡D–B’ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6…Fö¶Vç2ÖF6„6FVv÷'’r’æÆVâ‚¢¢çVÆÃ° ¢6öç7BW&ÂÒ7G&–ær‡&ö6W72æVçbåT$Ä”5ôõU$ÂÇÂv‡GG3¢ò÷wwræfçF7–ÖÖFæW72æ6öÒr’ç&WÆ6R‚õÂòBòÂrr“°¢òòF†R&Vb&ÖWFW"—2v†BF–W26–vçW&6²FòF†—2&öÖ÷FW"à¢6öç7B¦ö–äÆ–æ²ÒG¶W&ÇÒó÷&VcÒG¶Væ6öFUU$”6ö×öæVçB†ff–Æ–FT–B—Ö°¢6öç7Bf–v‡DÆ–æ²Òf–v‡BòG¶W&ÇÒó÷&VcÒG¶Væ6öFUU$”6ö×öæVçB†ff–Æ–FT–B—Òff–v‡CÒG¶Væ6öFUU$”6ö×öæVçB†f–v‡D–B—Ö¢¦ö–äÆ–æ³°¢6öç7B—"Òf–v‡Bò¶f–v‡BæÖF6„f–v‡FW$Âf–v‡BæÖF6„f–v‡FW$%Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rg2r’¢rs°¢6öç7BfVRÒf–v‡BòÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’’¢°¢6öç7BÆVwVRÒ¶ff–Æ–FRæÆVwVTæÖRÂff–Æ–FRçÆ–W$æÖUÒæÖ‚‡b’Óâ7G&–ær‡bÇÂrr’çG&–Ò‚’’æf–æB„&ööÆVâ’ÇÂv×’ÆVwVRs° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢¦ö–äÆ–æ²À¢f–v‡DÆ–æ²À¢òòW"ÆFf÷&ÒÂ&V6W6R÷7BF†Bv÷&·2öâ‚&VG2w&öæröâf6V&öö²à¢6†&S¢°¢6†÷'C¢—"òG·—'Ò(	B&VF–7B—Bv—F‚G¶ÆVwVWÒâG¶f–v‡DÆ–æ·Ö¢Æ’f–v‡B&VF–7F–öç2v—F‚G¶ÆVwVWÒâG¶¦ö–äÆ–æ·ÖÀ¢f6V&öö³¢— ¢ò’wfRv÷BG·—'ÒWöâfçF7’ÔÔFæW72â66÷&R—B&÷VæB'’&÷VæBv–ç7BG¶ÆVwVWÒG¶fVRâò(	BG¶fVRçFôÆö6ÆU7G&–ær‚—ÒdÒFòVçFW&¢r(	Bg&VRFòVçFW"wÒâG¶f–v‡DÆ–æ·Ö ¢¢¦ö–âG¶ÆVwVWÒöâfçF7’ÔÔFæW72æB&VF–7BF†Rf–v‡G2&÷VæB'’&÷VæBâG¶¦ö–äÆ–æ·ÖÀ¢F–·Fö³¢—"òG·—'Òâ×’–6·2&RÆö6¶VBâ&VBÖS¢G¶f–v‡DÆ–æ·Ö¢&VB×’f–v‡B–6·3¢G¶¦ö–äÆ–æ·ÖÀ¢6×3¢—"òG·—'Ò—2WöâfçF7’ÔÔFæW72(	B6öÖR66÷&R—C¢G¶f–v‡DÆ–æ·Ö¢¦ö–â×’fçF7’ÔÔFæW72ÆVwVS¢G¶¦ö–äÆ–æ·ÖÀ¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6†&R–ÆöBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B'V–ÆB6†&RÆ–æ²ârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòÄ”U"äõD”d”4D”ôâdTT@¢òòV&Æ—6†–ærf–v‡Bw&÷FR6–ævÆRvÆö&Âæ÷F–f–6F–öâ&÷rv—F‚æòW6W$–BÂ6ð¢òòæòÆ–W"WfW"6r—BæBöæRFÖ–âÖ&¶–ær—B&VB6ÆV&VB—Bf÷"WfW'–öæRà¢òòF†R&VÆÂ†B&VBF–ÖW7F×'WBæ÷F†–ærFò6÷VçBv–ç7Bà¢òð¢òòFW&—fVB&F†W"F†âfææVB÷WC¢&÷rW"W6W"W"f–v‡Bv÷VÆBÖVâFVç2ö`¢òòF†÷W6æG2öbw&—FW2V6‚F–ÖR6&B—2V&Æ—6†VBÂæBv÷VÆBæVVB'Væ–ærà¢òòF†—2&VG2&V6VçBf–v‡G2æBF†R6ÆÆW"w2÷vâÖöæW’WfVçG2ÂF†Vâ6ö×&W0¢òòv–ç7Bæ÷F–f–6F–öç5&VDBf÷"F†RVç&VB6÷VçBà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’÷W6W'2öÖRöæ÷F–f–6F–öç2rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚væ÷F–f–6F–öç5&VDB&W6–FVæ6U7FFRr’æÆVâ‚“°¢–b‚W6W"’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t66÷VçBæ÷Bf÷VæBârÒ“° ¢6öç7B&VDBÒW6W"ææ÷F–f–6F–öç5&VDBòæWrFFR‡W6W"ææ÷F–f–6F–öç5&VDB’¢æWrFFRƒ“°¢6öç7B6–æ6RÒæWrFFR„FFRææ÷r‚’Ò#¢#B¢3c¢“°¢6öç7Bæ÷F–f–6F–öç2ÒµÓ° ¢òòâf–v‡G2V&Æ—6†VB–âF†RÆ7BF‡&VRvVV·2(	BF†RF†–ærF†Bv2Ö—76–ærà¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²7&VFVDC¢²FwFS¢6–æ6RÒÒ¢ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6„6FVv÷'’ÖF6…Fö¶Vç27&VFVDB&—¦W56WGFÆVDBr¢ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—BƒC’æÆVâ‚“° ¢f–v‡G2æf÷$V6‚‚†f–v‡B’Óâ°¢6öç7B—"Ò¶f–v‡BæÖF6„f–v‡FW$Âf–v‡BæÖF6„f–v‡FW$%Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rg2r“°¢æ÷F–f–6F–öç2çW6‚‡°¢–C¢vf–v‡C¢r²f–v‡Båö–BÀ¢G—S¢täUuôd”t…BrÀ¢F—FÆS¢—"òæWrf–v‡C¢G·—'Ö¢æWrf–v‡C¢G¶f–v‡BæÖF6„æÖRÇÂv6&BV&Æ—6†VBwÖÀ¢&öG“¢†f–v‡BæÖF6„6FVv÷'’ò7G&–ær†f–v‡BæÖF6„6FVv÷'’’çFõWW$66R‚’²r+rr¢rr¢²„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’âòG´çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’çFôÆö6ÆU7G&–ær‚—ÒdÒVçG'–¢tg&VRVçG'’r’À¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢C¢f–v‡Bæ7&VFVDBÀ¢Ò“°¢Ò“° ¢òò"â&W7VÇG2f÷"f–v‡G2F†—2Æ–W"7GVÆÇ’VçFW&VB(	B6WGFÆVBf–v‡BF†W¢òòvW&Ræ÷B–â—2æ÷BæWw2f÷"F†VÒà¢6öç7B×”VçG&–W2Òv—B66÷&Ræf–æB‡²Æ–W$–C¢W6W$–BÂ&VgVæFVC¢²FæS¢G'VRÒÒ¢ç6VÆV7B‚vÖF6„–Br’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7B×”f–v‡D–G2Ò×”VçG&–W2æÖ‚‡&÷r’Óâ7G&–ær‡&÷ræÖF6„–B’’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢–b†×”f–v‡D–G2æÆVæwF‚’°¢6öç7B6WGFÆVBÒv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢×”f–v‡D–G2ÒÂ&—¦W56WGFÆVDC¢²FwFS¢6–æ6RÒÒ¢ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"&—¦W56WGFÆVDBr’ç6÷'B‡²&—¦W56WGFÆVDC¢ÓÒ’æÆ–Ö—Bƒ#R’æÆVâ‚“°¢6WGFÆVBæf÷$V6‚‚†f–v‡B’Óâ°¢æ÷F–f–6F–öç2çW6‚‡°¢–C¢w6WGFÆVC¢r²f–v‡Båö–BÀ¢G—S¢td”t…Eõ4UEDÄTBrÀ¢F—FÆS¢u&W7VÇG2&R–ã¢r²¶f–v‡BæÖF6„f–v‡FW$Âf–v‡BæÖF6„f–v‡FW$%Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rg2r’À¢&öG“¢u–÷W"66÷&V6&B†2&VVâ66÷&VB(	B6†V6²v†W&R–÷Rf–æ—6†VBârÀ¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢C¢f–v‡Bç&—¦W56WGFÆVDBÀ¢Ò“°¢Ò“°¢Ð ¢òò2âæ÷F–6W2g&öÒÆVwVW2F†—2Æ–W"†2¦ö–æVBâF†—2—2F†R&öÖ÷FW"w0¢òò6†ææVÂFòF†RÆ–W'2F†W’'&÷Vv‡B–â(	B—B&V6†W2WfW'’ÖVÖ&W"w2&VÆÀ¢òòWfVâv†VâF†RVÖ–Âv2†VÆB&6²'’F†R6ööÆF÷vâà¢6öç7B×”ÆVwVW2Òv—Bff–Æ–FRæf–æB‡²wW6W'4¦ö–æVBçW6W$–Bs¢W6W$–BÒ¢ç6VÆV7B‚uö–BÆVwVTæÖRÆ–W$æÖRr’æÆ–Ö—Bƒ#R’æÆVâ‚“°¢–b†×”ÆVwVW2æÆVæwF‚’°¢6öç7BÆVwVTæÖW2ÒæWrÖ†×”ÆVwVW2æÖ‚†ÆVwVR’Óâ°¢7G&–ær†ÆVwVRåö–B’À¢¶ÆVwVRæÆVwVTæÖRÂÆVwVRçÆ–W$æÖUÒæÖ‚‡b’Óâ7G&–ær‡bÇÂrr’çG&–Ò‚’’æf–æB„&ööÆVâ’ÇÂu–÷W"ÆVwVRrÀ¢Ò’“°¢6öç7Bæ÷F–6W2Òv—BÆVwVTæ÷F–6Ræf–æB‡°¢ff–Æ–FT–C¢²F–ã¢×”ÆVwVW2æÖ‚†ÆVwVR’Óâ7G&–ær†ÆVwVRåö–B’’ÒÀ¢7&VFVDC¢²FwFS¢6–æ6RÒÀ¢Ò’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#R’æÆVâ‚“° ¢æ÷F–6W2æf÷$V6‚‚†æ÷F–6R’Óâ°¢æ÷F–f–6F–öç2çW6‚‡°¢–C¢vÆVwVS¢r²æ÷F–6Råö–BÀ¢G—S¢tÄTuTUôäõD”4RrÀ¢F—FÆS¢æ÷F–6Ræ†VFÆ–æRÀ¢&öG“¢¶æ÷F–6Ræ&öG’ÂÆVwVTæÖW2ævWB…7G&–ær†æ÷F–6Ræff–Æ–FT–B’•Òæf–ÇFW"„&ööÆVâ’æ¦ö–â‚r+rr’À¢f–v‡D–C¢æ÷F–6Ræf–v‡D–BÇÂVæFVf–æVBÀ¢C¢æ÷F–6Ræ7&VFVDBÀ¢Ò“°¢Ò“°¢Ð ¢òòBâF†—2Æ–W"w2÷vâÖöæW’Ö÷fVÖVçG2Â7G&–v‡BöfbF†RÆVFvW"à¢6öç7BÖ÷fW2Òv—Bf–v‡DVçG'”ÆVFvW"æf–æB‡²W6W$–BÂ7&VFVDC¢²FwFS¢6–æ6RÒÒ¢ç6VÆV7B‚wG—RÖ÷VçBÖF6„–B7&VFVDBr’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#R’æÆVâ‚“°¢Ö÷fW2æf÷$V6‚‚†Ö÷fR’Óâ°¢6öç7B7&VF—BÒçVÖ&W"†Ö÷fRæÖ÷VçB’â°¢æ÷F–f–6F–öç2çW6‚‡°¢–C¢vÆVFvW#¢r²Ö÷fRåö–BÀ¢G—S¢7&VF—Bòt4ô”å5ô”âr¢t4ô”å5ôõUBrÀ¢F—FÆS¢7&VF—@¢ò²G´ÖF‚æ'2„çVÖ&W"†Ö÷fRæÖ÷VçB’’çFôÆö6ÆU7G&–ær‚—ÒdÒFFVF ¢¢G´ÖF‚æ'2„çVÖ&W"†Ö÷fRæÖ÷VçB’’çFôÆö6ÆU7G&–ær‚—ÒdÒ7VçFÀ¢&öG“¢7G&–ær†Ö÷fRçG—RÇÂrr’ç&WÆ6R‚õòörÂrr’çFôÆ÷vW$66R‚’À¢C¢Ö÷fRæ7&VFVDBÀ¢Ò“°¢Ò“° ¢æ÷F–f–6F–öç2ç6÷'B‚†Â"’ÓâæWrFFR†"æB’ÒæWrFFR†æB’“°¢6öç7BG&–ÖÖVBÒæ÷F–f–6F–öç2ç6Æ–6RƒÂS“°¢6öç7BVç&VBÒG&–ÖÖVBæf–ÇFW"‚‡&÷r’ÓâæWrFFR‡&÷ræB’â&VDB’æÆVæwFƒ° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Vç&VBÀ¢æ÷F–f–6F–öç5&VDC¢W6W"ææ÷F–f–6F–öç5&VDBÇÂçVÆÂÀ¢æ÷F–f–6F–öç3¢G&–ÖÖVBæÖ‚‡&÷r’Óâ‡²ââç&÷rÂVç&VC¢æWrFFR‡&÷ræB’â&VDBÒ’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tæ÷F–f–6F–öâfVVBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBæ÷F–f–6F–öç2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷W6W'2öÖRöæ÷F–f–6F–öç2÷7FFRrÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B…7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’¢ç6VÆV7B‚væ÷F–f–6F–öç5&VDBr’æÆVâ‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²æ÷F–f–6F–öç5&VDC¢W6W#òææ÷F–f–6F–öç5&VDBÇÂçVÆÂÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B&VBæ÷F–f–6F–öâ7FFRârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòtÄÄUBTD•BE$”À¢òòWfW'’&Ææ6R6†ævR6†÷VÆB&Rç7vW&&ÆRÆFW"‚$’†B2Ã6ö–ç0¢òò–W7FW&F’"’â&V6÷&EvÆÆWDÖ÷fRw&—FW2öæRÆVFvW"&÷rW"Ö÷fVÖVçBà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B&V6÷&EvÆÆWDÖ÷fRÒ7–æ2‡²W6W$–BÂÖ÷VçBÂ&Ææ6T&Vf÷&RÂ&Ææ6TgFW"Â&V6öâÂ&VfW&Væ6RÒrrÂÖWFÒ·ÒÂ6W76–öâÒçVÆÂÒ’Óâ°¢6öç7BFVÇFÒÖF‚ç&÷VæB„çVÖ&W"†Ö÷VçB’ÇÂ“°¢–b‚W6W$–BÇÂFVÇF’&WGW&ã°¢G'’°¢6öç7B¶W’ÒÖ÷fS¢G·&V6öçÓ¢G·W6W$–GÓ¢G·&VfW&Væ6RÇÂFFRææ÷r‚—Ö°¢v—Bf–v‡DVçG'”ÆVFvW"æ7&VFR€¢·°¢W6W$–BÀ¢ÖF6„–C¢7G&–ær‡&VfW&Væ6RÇÂ&V6öâ’ç6Æ–6RƒÂ#’À¢6÷W&6UG—S¢vÖF6‚rÀ¢G—S¢FVÇFÂòtd”t…EôTåE%’r¢td”t…EôTåE%•õ$TeTäBrÀ¢Ö÷VçC¢FVÇFÀ¢&Ææ6T&Vf÷&S¢ÖF‚ç&÷VæB„çVÖ&W"†&Ææ6T&Vf÷&R’ÇÂ’À¢&Ææ6TgFW#¢ÖF‚ç&÷VæB„çVÖ&W"†&Ææ6TgFW"’ÇÂ’À¢–FV×÷FVæ7”¶W“¢¶W’À¢ÖWFFF¢²&V6öâÂââæÖWFÒÀ¢ÕÒÀ¢6W76–öâò²6W76–öâÒ¢VæFVf–æV@¢“°¢Ò6F6‚†W'&÷"’°¢òòGWÆ–6FR¶W’ÒF†—2Ö÷fVÖVçBv2Ç&VG’&V6÷&FVBâç—F†–ærVÇ6R—2¢òò&VÂVF—Bf–ÇW&Rv÷'F‚6VV–ær–âF†RÆöw2à¢–b†W'&÷#òæ6öFRÓÒ’6öç6öÆRçv&â‚uvÆÆWBVF—Bw&—FRf–ÆVC¢rÂ&V6öâÂW'&÷"æÖW76vR“°¢Ð§Ó°  ¢òòv–ææW"öbf–æ—6†VBf–v‡BÂ6ö×WFVBv—F‚F†R6W'fW"w2÷vâ66÷&–ærVæv–æRà¢òò&WÆ6W26Æ–VçB×6–FR66÷&–ær–âv–ææW%WF–Ç2æ§2Âv†–6‚æVVFVBWfW'’Æ–W"w0¢òò&r&VF–7F–öç2–âF†R'&÷w6W"Fòv÷&²à¦ævWB‚rö’öÖF6†W2ó¦ÖF6„–B÷v–ææW"rÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖF6„–BÒ7G&–ær‡&Wç&×2æÖF6„–BÇÂrr’çG&–Ò‚“°¢–b‚ÖF6„–B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tÖF6‚–B—2&WV—&VBârÒ“° ¢ÆWBf–v‡BÒv—BÖF6‚æf–æD'”–B†ÖF6„–B’æÆVâ‚“°¢–b‚f–v‡B’f–v‡BÒv—B6†F÷ræf–æD'”–B†ÖF6„–B’æÆVâ‚“°¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7B&÷w2Òv—B66÷&Ræf–æB‡²ÖF6„–BÒ’æÆVâ‚“°¢–b‚&÷w2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²v–ææW#¢çVÆÂÂVçG&çG3¢Ò“° ¢6öç7B6FVv÷'’Ò7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚“°¢6öç7BöæU7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærp¢òf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW$öæU7FG0¢¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW$öæU7FG3°¢6öç7BGvõ7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærp¢òf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW%Gvõ7FG0¢¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW%Gvõ7FG3° ¢–b‚'&’æ—4'&’†öæU7FG2’ÇÂ'&’æ—4'&’‡Gvõ7FG2’’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²v–ææW#¢çVÆÂÂVçG&çG3¢&÷w2æÆVæwF‚ÂÖW76vS¢töff–6–Â7FG2&Ræ÷B–â–WBârÒ“°¢Ð ¢ÆWB&W7BÒçVÆÃ°¢f÷"†6öç7B&÷röb&÷w2’°¢–b…7G&–ær‡&÷ræVçG'•7FGW2ÇÂrr’çFôÆ÷vW$66R‚’ÓÓÒw&VgVæFVBr’6öçF–çVS°¢6öç7Bö–çG2Ò6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2‡&÷rç&VF–7F–öç2ÂöæU7FG2ÂGvõ7FG2Â6FVv÷'’“°¢–b‚&W7BÇÂö–çG2â&W7Bçö–çG2’&W7BÒ²Æ–W$–C¢&÷rçÆ–W$–BÂö–çG2Ó°¢Ð¢–b‚&W7B’&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²v–ææW#¢çVÆÂÂVçG&çG3¢&÷w2æÆVæwF‚Ò“° ¢6öç7BW6W"Òv—BW6W"æf–æD'”–B†&W7BçÆ–W$–B¢ç6VÆV7B‚uö–Bf—'7DæÖRÆ7DæÖRÆ–W$æÖR&öf–ÆUW&Âr’æÆVâ‚“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢v–ææW#¢W6W"ò°¢W6W$–C¢W6W"åö–BÀ¢f—'7DæÖS¢W6W"æf—'7DæÖRÀ¢Æ7DæÖS¢W6W"æÆ7DæÖRÀ¢Æ–W$æÖS¢W6W"çÆ–W$æÖRÀ¢&öf–ÆUW&Ã¢W6W"ç&öf–ÆUW&ÂÀ¢F÷FÅö–çG3¢&W7Bçö–çG2À¢ÖF6„–BÀ¢Ò¢çVÆÂÀ¢VçG&çG3¢&÷w2æÆVæwF‚À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uv–ææW"Æöö·Wf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷Bv÷&²÷WBF†Rv–ææW"ârÒ“°¢Ð§Ò“°  ¢òò66÷&VBÂ&æ¶VBÆVFW&&ö&Bf÷"f–v‡Bâf÷W"g&öçFVæB6ö×öæVçG2&Wf–÷W6Ç¢òò66÷&VBWfW'’VçG&çB–âF†R'&÷w6W"Âv†–6‚—2v‡’F†R’†BFòW‡÷6RÆÀ¢òò&r&VF–7F–öç2âF†—26ö×WFW2v—F‚F†R&VÂVæv–æRæB&WGW&ç2ö–çG2öæÇ’à¦ævWB‚rö’öÖF6†W2ó¦ÖF6„–BöÆVFW&&ö&BrÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖF6„–BÒ7G&–ær‡&Wç&×2æÖF6„–BÇÂrr’çG&–Ò‚“°¢–b‚ÖF6„–B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tÖF6‚–B—2&WV—&VBârÒ“° ¢ÆWBf–v‡BÒv—BÖF6‚æf–æD'”–B†ÖF6„–B’æÆVâ‚“°¢–b‚f–v‡B’f–v‡BÒv—B6†F÷ræf–æD'”–B†ÖF6„–B’æÆVâ‚“°¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7B&÷w2Òv—B66÷&Ræf–æB‡²ÖF6„–BÒ’æÆVâ‚“°¢6öç7B6FVv÷'’Ò7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚“°¢6öç7BöæU7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW$öæU7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW$öæU7FG3°¢6öç7BGvõ7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW%Gvõ7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW%Gvõ7FG3°¢6öç7B66÷&V&ÆRÒ'&’æ—4'&’†öæU7FG2’bb'&’æ—4'&’‡Gvõ7FG2“° ¢6öç7B7F—fRÒ&÷w2æf–ÇFW"‚‡"’Óâ7G&–ær‡"æVçG'•7FGW2ÇÂrr’çFôÆ÷vW$66R‚’ÓÒw&VgVæFVBr“°¢6öç7B–G2Ò7F—fRæÖ‚‡"’Óâ"çÆ–W$–B’æf–ÇFW"„&ööÆVâ“°¢6öç7BW6W'2Òv—BW6W"æf–æB‡²ö–C¢²F–ã¢–G2ÒÒ¢ç6VÆV7B‚uö–Bf—'7DæÖRÆ7DæÖRÆ–W$æÖR&öf–ÆUW&Âr’æÆVâ‚“°¢6öç7B'”–BÒæWrÖ‡W6W'2æÖ‚‡R’Óâµ7G&–ær‡Råö–B’ÂUÒ’“° ¢6öç7BVçG&–W2Ò7F—fRæÖ‚‡&÷r’Óâ°¢6öç7BW6W"Ò'”–BævWB…7G&–ær‡&÷rçÆ–W$–B’“°¢&WGW&â°¢W6W$–C¢&÷rçÆ–W$–BÀ¢f—'7DæÖS¢W6W#òæf—'7DæÖRÇÂrrÀ¢Æ7DæÖS¢W6W#òæÆ7DæÖRÇÂrrÀ¢Æ–W$æÖS¢W6W#òçÆ–W$æÖRÇÂrrÀ¢&öf–ÆUW&Ã¢W6W#òç&öf–ÆUW&ÂÇÂrrÀ¢F÷FÅö–çG3¢66÷&V&ÆP¢ò6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2‡&÷rç&VF–7F–öç2ÂöæU7FG2ÂGvõ7FG2Â6FVv÷'’¢¢À¢Ó°¢Ò’ç6÷'B‚†Â"’Óâ"çF÷FÅö–çG2ÒçF÷FÅö–çG2¢æÖ‚‡&÷rÂ–æFW‚’Óâ‡²ââç&÷rÂ&æ³¢–æFW‚²Ò’“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖF6„–BÀ¢66÷&VC¢66÷&V&ÆRÀ¢VçG&çG3¢VçG&–W2æÆVæwF‚À¢ÆVFW&&ö&C¢VçG&–W2À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tÆVFW&&ö&B'V–ÆBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B'V–ÆBF†RÆVFW&&ö&BârÒ“°¢Ð§Ò“°  ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò$•¤R4UEDÄTÔTå@¢òòF†R÷B&Wf–÷W6Ç’öæÇ’WfW"vVçBU†VçG&–W2’÷"Dõtâ‡&VgVæG2’âæ÷F†–æp¢òò–Bv–ææW"Â6òf–æ—6†VB6öçFW7BÆVgBF†RÖöæW’7G&æFVBà¢òð¢òò†÷W6R7WC ¢òò¢ff–Æ–FR×&öÖ÷FVBf–v‡G3¢SóSv—F‚F†R&öÖ÷FW"†÷væW"w27FæF–ær'VÆR¢òò¢FÖ–âf–v‡G3¢ÄDdõ$Õõ$´Uõ5BöbF†R÷@¢òò&—¦R7Æ—B66ÆW2v—F‚f–VÆB6—¦R(	B2×Æ–W"6öçFW7B––ærF‡&VRÆ6W2—0¢òòö–çFÆW72ÂæB#×Æ–W"6öçFW7B––æröæR—2F—66÷W&v–ærà¢òòF–W26†&RF†V—"Æ6W2r6öÖ&–æVB&—¦RWVÆÇ’à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7BÄDdõ$Õõ$´Uõ5BÒçVÖ&W"‡&ö6W72æVçbåÄDdõ$Õõ$´Uõ5BÇÂR“°¦6öç7Bdd”Ä”DUõ5Ä•Eõ5BÒçVÖ&W"‡&ö6W72æVçbädd”Ä”DUõ5Ä•Eõ5BÇÂS“° ¦6öç7B&—¦U7Æ—Df÷"Ò†VçG&çG2’Óâ°¢–b†VçG&çG2ÃÒ’&WGW&â³Ó°¢–b†VçG&çG2ÂR’&WGW&â³Ó²òòFöò6ÖÆÂFò7&V@¢–b†VçG&çG2Â#’&WGW&â³cÂ#RÂUÓ°¢&WGW&â³SÂ3Â#Ó°§Ó° ¢òòw&÷W2VçG&çG2'’ö–çG26òF–W26â6†&RÆ6Rw2ÖöæW’à¦6öç7B'V–ÆE&—¦Tv&G2Ò‡&÷w2Â&—¦UööÂ’Óâ°¢6öç7B7Æ—BÒ&—¦U7Æ—Df÷"‡&÷w2æÆVæwF‚“°¢6öç7B&æ¶VBÒ²ââç&÷w5Òç6÷'B‚†Â"’Óâ"çö–çG2Òçö–çG2“° ¢6öç7BF–W'2ÒµÓ°¢f÷"†6öç7B&÷röb&æ¶VB’°¢6öç7BÆ7BÒF–W'5·F–W'2æÆVæwF‚ÒÓ°¢–b†Æ7BbbÆ7Bçö–çG2ÓÓÒ&÷rçö–çG2’Æ7BçÆ–W'2çW6‚‡&÷r“°¢VÇ6RF–W'2çW6‚‡²ö–çG3¢&÷rçö–çG2ÂÆ–W'3¢·&÷uÒÒ“°¢Ð ¢6öç7Bv&G2ÒµÓ°¢ÆWBÆ6RÒ°¢f÷"†6öç7BF–W"öbF–W'2’°¢–b‡Æ6RãÒ7Æ—BæÆVæwF‚’'&V³°¢òòF–R7ææ–ær6WfW&ÂÆ6W2ööÇ2F†÷6RÆ6W2r6†&W2à¢6öç7BÆ6W46÷fW&VBÒÖF‚æÖ–â‡F–W"çÆ–W'2æÆVæwF‚Â7Æ—BæÆVæwF‚ÒÆ6R“°¢6öç7BööÆVE7BÒ7Æ—Bç6Æ–6R‡Æ6RÂÆ6R²Æ6W46÷fW&VB’ç&VGV6R‚†Â"’Óâ²"Â“°¢6öç7BööÆVBÒÖF‚æfÆö÷"‚‡&—¦UööÂ¢ööÆVE7B’ò“°¢6öç7BV6‚ÒÖF‚æfÆö÷"‡ööÆVBòF–W"çÆ–W'2æÆVæwF‚“°¢–b†V6‚â’°¢F–W"çÆ–W'2æf÷$V6‚‚‡Â’Óâv&G2çW6‚‡°¢W6W$–C¢ÂçW6W$–BÀ¢Ö÷VçC¢V6‚À¢Æ6S¢Æ6R²À¢F–VC¢F–W"çÆ–W'2æÆVæwF‚âÀ¢Ò’“°¢Ð¢Æ6R³ÒF–W"çÆ–W'2æÆVæwFƒ°¢Ð¢&WGW&â²v&G2Â7Æ—BÓ°§Ó° ¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷6WGFÆRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢–b‚f–v‡D–B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tf–v‡B–B—2&WV—&VBârÒ“° ¢ÆWBf–v‡BÒv—BÖF6‚æf–æD'”–B†f–v‡D–B“°¢ÆWB—56†F÷rÒfÇ6S°¢–b‚f–v‡B’²f–v‡BÒv—B6†F÷ræf–æD'”–B†f–v‡D–B“²—56†F÷rÒG'VS²Ð¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÂ6öFS¢td”t…EôäõEôdõTäBrÒ“° ¢–b†f–v‡Bç&—¦W56WGFÆVDB’°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢uF†—2f–v‡Bv2Ç&VG’6WGFÆVBârÀ¢Ç&VG•6WGFÆVC¢G'VRÀ¢6WGFÆVDC¢f–v‡Bç&—¦W56WGFÆVDBÀ¢Ò“°¢Ð ¢6öç7B6FVv÷'’Ò7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚“°¢6öç7BöæU7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW$öæU7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW$öæU7FG3°¢6öç7BGvõ7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW%Gvõ7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW%Gvõ7FG3°¢–b‚'&’æ—4'&’†öæU7FG2’ÇÂ'&’æ—4'&’‡Gvõ7FG2’’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡°¢ÖW76vS¢tVçFW"F†Röff–6–Â&÷VæB7FG2&Vf÷&R6WGFÆ–ær&—¦W2ârÀ¢6öFS¢u5DE5ôÔ•54”ärrÀ¢Ò“°¢Ð ¢òòg&VR6öçFW7B†2æò÷BæBæ÷F†–ærFò’÷WBÂ'WB—B7F–ÆÂæVVG0¢òò6WGFÆ–ær6ò&FvW2ÂF—FÆW2æB7öç6÷"&—¦W2&R†æFVB÷WBà¢6öç7B—4g&VT6öçFW7BÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’ÓÓÒ°¢6öç7B&÷w2Ò†v—B66÷&Ræf–æB‡²ÖF6„–C¢f–v‡D–BÒ’æÆVâ‚’¢æf–ÇFW"‚‡"’Óâ7G&–ær‡"æVçG'•7FGW2ÇÂrr’çFôÆ÷vW$66R‚’ÓÒw&VgVæFVBr“°¢–b‚&÷w2æÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ÖW76vS¢tæòVçG&–W2Fò6WGFÆRârÂ6öFS¢täõôTåE$”U2rÒ“°¢Ð ¢òò„õU4R$•4²uT$Bà¢òòF†R&—¦R—2FV6Æ&VB&Vf÷&RVçG'’æBæWfW"w&÷w2v—F‚&Vv—7G&F–öç2Â6ð¢òòF†–â6öçFW7Bv÷VÆB÷F†W'v—6R&R–B÷WBöbÆFf÷&ÒgVæG2(	Bv†–6‚—0¢òòF†R&†÷W6R&—6²"fçF7’W†V×F–öâ6ææ÷B–æ6ÇVFRâ&VÆ÷rF†RFV6Æ&V@¢òòÖ–æ–×VÒF†R6öçFW7Bfö–G2æBWfW'’VçG'’—2&VgVæFVBg&öÒF†RÆVFvW"à¢òò'&V²ÖWfVâ—2F†R†öæW7BfÆö÷#¢Væ÷Vv‚–BVçG&–W2Fò6÷fW"F†R&—¦RF†P¢òòÆ–W'2vW&R6†÷vââff–Æ–FW2Ç&VG’6—¦R6×–vç2F†—2v’‡F†P¢òò6×–vâ67&VVâ6ö×WFW2÷B;r'W’Ö–â’Â6òv†Vâæö&öG’6WG2âW‡Æ–6—@¢òòÖ–æ–×VÒvRW6RF†Bf–wW&R&F†W"F†âÆVf–æröÆBf–v‡G2Vç&÷FV7FVBà¢6öç7BFV6Æ&VE÷BÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç÷B’ÇÂ’“°¢6öç7BVçG'”fVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’“°¢6öç7B6öÖÖ—GFVDgVæF–ærÒÖF‚æÖ–â†FV6Æ&VE÷BÀ¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç&öÖ÷FW%7F¶R’ÇÂ’¢²ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BçÆFf÷&Ô6öçG&–'WF–öâ’ÇÂ’’“°¢6öç7BVæ6÷fW&VE&—¦RÒÖF‚æÖ‚ƒÂFV6Æ&VE÷BÒ6öÖÖ—GFVDgVæF–ær“°¢6öç7B'&V´WfVäVçG&çG2ÒVçG'”fVRâòÖF‚æ6V–Â‡Væ6÷fW&VE&—¦RòVçG'”fVR’¢°¢6öç7BÖ–æ–×VÔVçG&çG2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖ–æ–×VÔVçG&çG2’ÇÂ’’ÇÂ'&V´WfVäVçG&çG3°¢òòæ÷F†–ærv26†&vVBÂ6òF†W&R—2æò6†÷'FfÆÂFò&÷FV7Bv–ç7Bà¢6öç7BWFõ&VgVæD–e6†÷'BÒ—4g&VT6öçFW7Bbbf–v‡BæWFõ&VgVæD–e6†÷'BÓÒfÇ6S°¢–b†Ö–æ–×VÔVçG&çG2âbb&÷w2æÆVæwF‚ÂÖ–æ–×VÔVçG&çG2bbWFõ&VgVæD–e6†÷'B’°¢6öç7B&VgVæBÒv—B&VgVæDf–v‡DVçG&–W2‡°¢f–v‡D–BÀ¢&V6öã¢6öçFW7Bfö–FVC¢G·&÷w2æÆVæwF‡ÒöbG¶Ö–æ–×VÔVçG&çG7Ò&WV—&VBVçG&–W2æÀ¢FÖ–ä–C¢&WæFÖ–ãòæ–BÇÂçVÆÂÀ¢Ò“°¢v—B†—56†F÷rò6†F÷r¢ÖF6‚’çWFFTöæR‡²ö–C¢f–v‡D–BÒÂ°¢G6WC¢°¢fö–FVDC¢æWrFFR‚’À¢fö–E&V6öã¢Ö–æ–×VÒöbG¶Ö–æ–×VÔVçG&çG7ÒVçG&çG2æ÷BÖWB‚G·&÷w2æÆVæwF‡Ò’æÀ¢ÒÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢fö–FVC¢G'VRÀ¢&V6öã¢tÔ”ä”ÕTÕôTåE$åE5ôäõEôÔUBrÀ¢VçG&çG3¢&÷w2æÆVæwF‚À¢Ö–æ–×VÔVçG&çG2À¢&VgVæFVD6÷VçC¢&VgVæBç&VgVæFVD6÷VçBÀ¢F÷FÅ&VgVæFVC¢&VgVæBçF÷FÅ&VgVæFVBÀ¢ÖW76vS¢6öçFW7Bfö–FVBæBG·&VgVæBç&VgVæFVD6÷VçGÒVçG"G·&VgVæBç&VgVæFVD6÷VçBÓÓÒòw’r¢v–W2wÒ&VgVæFVBâF†RFV6Æ&VB&—¦Rv2æ÷B6÷fW&VB'’VçG&–W2æÀ¢Ò“°¢Ð ¢6öç7B66÷&VBÒ&÷w2æÖ‚‡"’Óâ‡°¢W6W$–C¢7G&–ær‡"çÆ–W$–B’À¢ö–çG3¢6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2‡"ç&VF–7F–öç2ÂöæU7FG2ÂGvõ7FG2Â6FVv÷'’’À¢Ò’“° ¢6öç7B÷BÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç÷B’ÇÂ’“°¢6öç7B&öÖ÷FW$–BÒf–v‡Bæff–Æ–FT–@¢ÇÂ„'&’æ—4'&’†f–v‡Bäff–Æ–FT–G2’bbf–v‡Bäff–Æ–FT–G5³Óòäff–Æ–FT–B¢ÇÂçVÆÃ° ¢òò†÷W6R7WB&Vf÷&Rç—F†–ær—2–Bà¢6öç7B†÷W6U7BÒ&öÖ÷FW$–Bòdd”Ä”DUõ5Ä•Eõ5B¢ÄDdõ$Õõ$´Uõ5C°¢6öç7B†÷W6T7WBÒÖF‚æfÆö÷"‚‡÷B¢†÷W6U7B’ò“°¢6öç7B&—¦UööÂÒÖF‚æÖ‚ƒÂ÷BÒ†÷W6T7WB“° ¢òòfVW2F¶Vâ&÷fRF†RFV6Æ&VB&—¦R&R&WfVçVRÂæ÷B&—¦RÖöæW’â¶VW–æp¢òòF†W6R6W&FR—2F†Rv†öÆR6ö×Æ–æ6Rö–çC¢F†R$•¤R6ææ÷BFWVæBöà¢òò†÷rÖç’VçFW&VBÂ'WB$UdTåTR6âæB6†÷VÆBà¢6öç7B6öÆÆV7FVDfVW2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bæ6öÆÆV7FVDfVW2’ÇÂ’“°¢6öç7B7W'ÇW2ÒÖF‚æÖ‚ƒÂ6öÆÆV7FVDfVW2Ò÷B“°¢6öç7B&öÖ÷FW%7W'ÇW56†&RÒ&öÖ÷FW$–BòÖF‚æfÆö÷"‚‡7W'ÇW2¢dd”Ä”DUõ5Ä•Eõ5B’ò’¢° ¢6öç7B²v&G2Â7Æ—BÒÒ'V–ÆE&—¦Tv&G2‡66÷&VBÂ&—¦UööÂ“° ¢òò6Æ–ÒF†R6WGFÆVÖVçBFöÖ–6ÆÇ’$Tdõ$Rç’ÖöæW’Ö÷fW2âF†RV&Æ–W ¢òò&—¦W56WGFÆVDB6†V6²—2&VB×F†Vâ×w&—FS¢Gvò6öæ7W'&VçB6ÆÇ2†¢òòF÷V&ÆRÖ6Æ–6²Â&WG&–VB&WVW7B’&÷F‚76VB—BæB&÷F‚–BF†RgVÆÀ¢òò÷BâöæÇ’F†R&WVW7BF†Bv–ç2F†—2WFFR—2ÆÆ÷vVBFò’à¢6öç7Bf–v‡DÖöFVÂÒ—56†F÷rò6†F÷r¢ÖF6ƒ°¢6öç7B6WGFÆVÖVçE7F'FVDBÒæWrFFR‚“°¢6öç7B6Æ–ÖVBÒv—Bf–v‡DÖöFVÂæf–æDöæTæEWFFR€¢²ö–C¢f–v‡D–BÂF÷#¢·²&—¦W56WGFÆVDC¢çVÆÂÒÂ²&—¦W56WGFÆVDC¢²FW†—7G3¢fÇ6RÒÕÒÒÀ¢²G6WC¢²&—¦W56WGFÆVDC¢6WGFÆVÖVçE7F'FVDBÒÒÀ¢²æWs¢G'VRÒÀ¢“°¢–b‚6Æ–ÖVB’°¢6öç7B7W'&VçBÒv—Bf–v‡DÖöFVÂæf–æD'”–B†f–v‡D–B’ç6VÆV7B‚w&—¦W56WGFÆVDBr’æÆVâ‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ÖW76vS¢uF†—2f–v‡Bv2Ç&VG’6WGFÆVBârÀ¢Ç&VG•6WGFÆVC¢G'VRÀ¢6WGFÆVDC¢7W'&VçCòç&—¦W56WGFÆVDBÇÂçVÆÂÀ¢Ò“°¢Ð ¢òò&öÖ÷FW"w2†ÆböbF†R†÷W6R7WBöââff–Æ–FRf–v‡Bà¢ÆWB&öÖ÷FW%–BÒ°¢–b‡&öÖ÷FW$–Bbb†÷W6T7WBâ’°¢6öç7B&öÖ÷FW"Òv—Bff–Æ–FRæf–æD'”–B‡&öÖ÷FW$–B“°¢–b‡&öÖ÷FW"’°¢6öç7B&Vf÷&RÒçVÖ&W"ç'6T–çB…7G&–ær‡&öÖ÷FW"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢òòf—†VB7WBöbF†RFV6Æ&VB÷BÂÇW2F†V—"6†&RöbWfW'—F†–ærF†P¢òò6öçFW7BFöö²&÷fR—BâF†—2—2†÷r&öÖ÷FW"V&æ–æw2w&÷rv—F‚VçG&çG0¢òòv†–ÆRF†R&—¦R7F—2W†7FÇ’2GfW'F—6VBà¢&öÖ÷FW%–BÒ†÷W6T7WB²&öÖ÷FW%7W'ÇW56†&S°¢&öÖ÷FW"çFö¶Vç2Ò7G&–ær‡&Vf÷&R²&öÖ÷FW%–B“°¢v—B&öÖ÷FW"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢&öÖ÷FW"åö–BÀ¢Ö÷VçC¢&öÖ÷FW%–BÀ¢&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²&öÖ÷FW%–BÀ¢&V6öã¢vff–Æ–FU÷÷E÷6†&RrÀ¢&VfW&Væ6S¢f–v‡D–BÀ¢ÖWF¢°¢÷EF÷FÃ¢÷BÂ6†&U7C¢†÷W6U7BÀ¢f—†VD7WC¢†÷W6T7WBÂ7W'ÇW56†&S¢&öÖ÷FW%7W'ÇW56†&RÀ¢6öÆÆV7FVDfVW2ÂVçG&çG3¢66÷&VBæÆVæwF‚À¢ÒÀ¢Ò“°¢Ð¢Ð ¢òò7&VF—BV6‚v–ææW"à¢ÆWBF÷FÅ–BÒ°¢f÷"†6öç7Bv&Böbv&G2’°¢6öç7Bv–ææW"Òv—BW6W"æf–æD'”–B†v&BçW6W$–B“°¢–b‚v–ææW"’6öçF–çVS°¢6öç7Bt&Vf÷&RÒçVÖ&W"ç'6T–çB…7G&–ær‡v–ææW"çFö¶Vç2ÇÂsr’Â’ÇÂ°¢v–ææW"çFö¶Vç2Ò7G&–ær‡t&Vf÷&R²v&BæÖ÷VçB“°¢v—Bv–ææW"ç6fR‚“°¢F÷FÅ–B³Òv&BæÖ÷VçC°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢v–ææW"åö–BÀ¢Ö÷VçC¢v&BæÖ÷VçBÀ¢&Ææ6T&Vf÷&S¢t&Vf÷&RÀ¢&Ææ6TgFW#¢t&Vf÷&R²v&BæÖ÷VçBÀ¢&V6öã¢w&—¦Uöv&BrÀ¢&VfW&Væ6S¢f–v‡D–B²s¢r²v&BçÆ6RÀ¢ÖWF¢²Æ6S¢v&BçÆ6RÂF–VC¢v&BçF–VBÂ÷EF÷FÃ¢÷BÒÀ¢Ò“°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢v–ææW"æVÖ–ÂÀ¢7V&¦V7C¢v&BçÆ6RÓÓÒòu–÷Rvöâr¢–÷Rf–æ—6†VB2G¶v&BçÆ6WÖÀ¢†VF–æs¢v&BçÆ6RÓÓÒòu”õRtôâr¢2G¶v&BçÆ6WÒd”ä•4†À¢Æ–æW3¢°¢G¶f–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÒ†2&VVâ6WGFÆVBæÀ¢Ç7G&öæsâG¶v&BæÖ÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâFFVBFò–÷W"vÆÆWBG¶v&BçF–VBòr‡6†&VBv—F‚F–VBÆ–W"’r¢rwÒæÀ¢ÒÀ¢Ò“°¢Ð ¢òò&—¦W56WGFÆVDBv2Ç&VG’7F×VB'’F†RFöÖ–26Æ–Ò&÷fRà¢v—Bf–v‡DÖöFVÂçWFFTöæR€¢²ö–C¢f–v‡D–BÒÀ¢²G6WC¢²&—¦UööÅ–C¢F÷FÅ–BÂ†÷W6T7WEF¶Vã¢†÷W6T7WBÒÒÀ¢“° ¢òòFVÒ6&G3¢7&VF—B&÷F‚f–v‡FW'2FòWfW'’FVÒ†öÆF–ærF†VÒöâF†—26&Bà¢ÆWBFVÕ7VÖÖ'’ÒçVÆÃ°¢–b…DTÕô4$E5ôTä$ÄTB’°¢G'’°¢FVÕ7VÖÖ'’Òv—B7&VF—EFVÔVçG&–W2†f–v‡BÂöæU7FG2ÂGvõ7FG2“°¢Ò6F6‚‡FVÔ7&VF—DW'&÷"’°¢6öç6öÆRæW'&÷"‚tf–v‡B6WGFÆVB'WBFVÒ7&VF—F–ærf–ÆVC¢rÂFVÔ7&VF—DW'&÷"“°¢FVÕ7VÖÖ'’Ò²W'&÷#¢uDTÕô5$TD•Eôd”ÄTBrÓ°¢Ð¢Ð ¢òò6V6öâ6&G3¢v†FWfW"F†W6RGvòf–v‡FW'27GVÆÇ’F–B—27&VF—FVBFòWfW'¢òò&÷7FW"F†BG&gFVBF†VÒâ'Vç2öfbF†R6ÖRöff–6–Â&÷VæB7FG2Â6ò¢òò6V6öâ6âæWfW"F—6w&VRv—F‚F†Rf–v‡B—Bv266÷&VBg&öÒà¢ÆWB6V6öå7VÖÖ'’ÒçVÆÃ°¢–b…4T4ôåô4$E5ôTä$ÄTB’°¢G'’°¢6V6öå7VÖÖ'’Òv—B7&VF—E6V6öå&÷7FW'2†f–v‡BÂöæU7FG2ÂGvõ7FG2“°¢Ò6F6‚‡6V6öäW'&÷#"’°¢6öç6öÆRæW'&÷"‚tf–v‡B6WGFÆVB'WB6V6öâ7&VF—F–ærf–ÆVC¢rÂ6V6öäW'&÷#"“°¢6V6öå7VÖÖ'’Ò²W'&÷#¢u4T4ôåô5$TD•Eôd”ÄTBrÓ°¢Ð¢Ð ¢òò&FvW2ÂF—FÆW2Â7öç6÷"ÖW&6‚æBb6öFW2â'Vç2f÷"WfW'’6öçFW7BÂ–@¢òò÷"g&VR(	B'WB—B—2v†BÖ¶W2e$TR6öçFW7Bv÷'F‚VçFW&–ærÂ6–æ6RF†W&P¢òò—2æò÷BFò’g&öÒâ–FV×÷FVçBÂ6ò&R×'Vâ6ææ÷BF÷V&ÆRÖv&Bà¢ÆWB&—¦U7VÖÖ'’ÒçVÆÃ°¢G'’°¢&—¦U7VÖÖ'’Òv—Bv&Dæöä66…&—¦W2†f–v‡D–BÂ66÷&VBÂf–v‡B“°¢Ò6F6‚‡&—¦TW'&÷"’°¢6öç6öÆRæW'&÷"‚t66‚&—¦W26WGFÆVB'WBæöâÖ66‚v&G2f–ÆVC¢rÂ&—¦TW'&÷"“°¢&—¦U7VÖÖ'’Ò²W'&÷#¢tt$E5ôd”ÄTBrÓ°¢Ð ¢òò†VB×FòÖ†VB6†ÆÆVævW2öâF†—2f–v‡B6WGFÆR–âF†R6ÖR7F–öâÂ6òà¢òòFÖ–âæWfW"†2Fò&VÖVÖ&W"6V6öæB'WGFöââ÷vâ6Æ–ÒW"6†ÆÆVævRÂ6ò¢òòf–ÇW&R†W&R6ææ÷BVçv–æBF†R÷B–÷WB&÷fRà¢ÆWB6†ÆÆVævU7VÖÖ'’ÒçVÆÃ°¢–b„„TEõDõô„TEôTä$ÄTB’°¢G'’°¢6†ÆÆVævU7VÖÖ'’Òv—B6WGFÆTf–v‡D6†ÆÆVævW2†f–v‡D–B“°¢Ò6F6‚†6†ÆÆVævTW'&÷"’°¢6öç6öÆRæW'&÷"‚u÷B6WGFÆVB'WB6†ÆÆVævR6WGFÆVÖVçBf–ÆVC¢rÂ6†ÆÆVævTW'&÷"“°¢6†ÆÆVævU7VÖÖ'’Ò²W'&÷#¢t4„ÄÄTätUõ4UEDÄUôd”ÄTBrÓ°¢Ð¢Ð ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢f–v‡D–BÀ¢6†ÆÆVævW3¢6†ÆÆVævU7VÖÖ'’À¢v&G4v—fVã¢&—¦U7VÖÖ'’À¢6V6öä6&G3¢6V6öå7VÖÖ'’À¢FVÔ6&G3¢FVÕ7VÖÖ'’À¢÷EF÷FÃ¢÷BÀ¢†÷W6U7BÀ¢†÷W6T7WBÀ¢&öÖ÷FW%–BÀ¢6öÆÆV7FVDfVW2À¢FV6Æ&VE&—¦UööÃ¢&—¦UööÂÀ¢7W'ÇW2À¢&öÖ÷FW%7W'ÇW56†&RÀ¢ÆFf÷&Ô¶WC¢††÷W6T7WBÒ‡&öÖ÷FW$–Bò†÷W6T7WB¢’’²‡7W'ÇW2Ò&öÖ÷FW%7W'ÇW56†&R’À¢VçG&çG3¢66÷&VBæÆVæwF‚À¢Ö–æ–×VÔVçG&çG2À¢'&V´WfVäVçG&çG2À¢&—¦UööÂÀ¢F÷FÅ–BÀ¢7Æ—BÀ¢v&G3¢v&G2æÖ‚†’Óâ‡²W6W$–C¢çW6W$–BÂÆ6S¢çÆ6RÂÖ÷VçC¢æÖ÷VçBÂF–VC¢çF–VBÒ’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&—¦R6WGFÆVÖVçBf–ÆVC¢rÂW'&÷"“°¢òò&VÆV6RF†R6Æ–Ò6òâ÷W&F÷"6â&WG'’âÖöæW’Ç&VG’7&VF—FVB—0¢òò&V6÷&FVB–âF†RvÆÆWBÆVFvW"Â6ò&WG'’—2VF—F&ÆR&F†W"F†â6–ÆVçBà¢G'’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢v—B&öÖ—6RæÆÂ…°¢ÖF6‚çWFFTöæR‡²ö–C¢f–v‡D–BÂ&—¦UööÅ–C¢²FW†—7G3¢fÇ6RÒÒÂ²GVç6WC¢²&—¦W56WGFÆVDC¢rrÒÒ’À¢6†F÷rçWFFTöæR‡²ö–C¢f–v‡D–BÂ&—¦UööÅ–C¢²FW†—7G3¢fÇ6RÒÒÂ²GVç6WC¢²&—¦W56WGFÆVDC¢rrÒÒ’À¢Ò“°¢Ò6F6‚‡&VÆV6TW'&÷"’°¢6öç6öÆRæW'&÷"‚t6÷VÆBæ÷B&VÆV6R6WGFÆVÖVçB6Æ–Ó¢rÂ&VÆV6TW'&÷"“°¢Ð¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6WGFÆR&—¦W2ârÂ6öFS¢u4UEDÄUôd”ÄTBrÒ“°¢Ð§Ò“°  ¢òò6†F÷rf–v‡B&öÖ÷FW"6öçG&öÇ2âF†R&öÖ÷FW"7F¶W2÷BWg&öçBÂVçG&–W0¢òòf–ÆÂ—BÂæBöæÇ’öæ6R—B—26÷fW&VB&RF†W’–â&öf—B(	Bv†–6‚—2v‡’F†W’À¢òòæ÷BW2ÂFV6–FRv†VâF†R6öçFW7B7F'G2à¦ç÷7B‚rö’öff–Æ–FW2öÖR÷6†F÷rÖf–v‡G2ó¦f–v‡D–B÷7F¶RrÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7B7F¶RÒÖF‚æÖ‚ƒÂÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òç÷EF&vWB’ÇÂ’“°¢–b‚7F¶R’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u6WBF†R÷B–÷R&RWGF–ærWârÂ6öFS¢t”ådÄ”Eõ5D´RrÒ“° ¢6öç7Bf–v‡BÒv—B6†F÷ræf–æD'”–B†f–v‡D–B’ÇÂv—BÖF6‚æf–æD'”–B†f–v‡D–B“°¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7B&öÖ÷FW$–G2Ò¶f–v‡Bæff–Æ–FT–BÂâââ„'&’æ—4'&’†f–v‡Bäff–Æ–FT–G2’òf–v‡Bäff–Æ–FT–G2æÖ‚†’Óâòäff–Æ–FT–B’¢µÒ•Ð¢æf–ÇFW"„&ööÆVâ’æÖ…7G&–ær“°¢–b‚&öÖ÷FW$–G2æ–æ6ÇVFW2†ff–Æ–FT–B’’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢u–÷RFòæ÷B&öÖ÷FRF†—2f–v‡BârÂ6öFS¢täõEõ$ôÔõDU"rÒ“°¢Ð¢–b„çVÖ&W"†f–v‡Bç÷B’â’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ÖW76vS¢tVçG&–W2†fRÇ&VG’7F'FVB(	BF†R÷B6ææ÷B&R6†ævVBæ÷rârÂ6öFS¢tTåE$”U5õ5D%DTBrÒ“°¢Ð ¢f–v‡Bç÷EF&vWBÒ7F¶S°¢f–v‡Bç&öÖ÷FW%7F¶RÒ7F¶S°¢f–v‡Bç&öf—E¦öæU&V6†VDBÒçVÆÃ°¢v—Bf–v‡Bç6fR‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²f–v‡D–BÂ÷EF&vWC¢7F¶RÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u7F¶RWFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6WBF†B÷BârÒ“°¢Ð§Ò“° ¢òòÆ—fRf–ÆÂ7FGW2f÷"F†R&öÖ÷FW"w2F6†&ö&Bà¦ævWB‚rö’öff–Æ–FW2öÖR÷6†F÷rÖf–v‡G2ó¦f–v‡D–B÷7FGW2rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡BÒv—B6†F÷ræf–æD'”–B‡&Wç&×2æf–v‡D–B’æÆVâ‚¢ÇÂv—BÖF6‚æf–æD'”–B‡&Wç&×2æf–v‡D–B’æÆVâ‚“°¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7B&öÖ÷FW$–G2Ò¶f–v‡Bæff–Æ–FT–BÂâââ„'&’æ—4'&’†f–v‡Bäff–Æ–FT–G2’òf–v‡Bäff–Æ–FT–G2æÖ‚†’Óâòäff–Æ–FT–B’¢µÒ•Ð¢æf–ÇFW"„&ööÆVâ’æÖ…7G&–ær“°¢–b‚&öÖ÷FW$–G2æ–æ6ÇVFW2†ff–Æ–FT–B’’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢u–÷RFòæ÷B&öÖ÷FRF†—2f–v‡BârÂ6öFS¢täõEõ$ôÔõDU"rÒ“°¢Ð ¢6öç7B÷BÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷B’ÇÂ“°¢6öç7BF&vWBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷EF&vWB’ÇÂ“°¢6öç7BVçG&çG2Ò'&’æ—4'&’†f–v‡BçW6W%&VF–7F–öç2¢òf–v‡BçW6W%&VF–7F–öç2æf–ÇFW"‚‡R’Óâ7G&–ær‡Sòç&VF–7F–öå7FGW2’ÓÓÒw7V&Ö—GFVBr’æÆVæwF€¢¢°¢6öç7B–å&öf—BÒF&vWBâbb÷BãÒF&vWC°¢òòWfW'—F†–ær7BF†R7F¶VB÷B—2&öf—BÂ7Æ—Bv—F‚F†RÆFf÷&Òà¢6öç7B&öf—D&÷fU7F¶RÒÖF‚æÖ‚ƒÂ÷BÒF&vWB“°¢6öç7B–÷W%6†&RÒÖF‚æfÆö÷"‚‡&öf—D&÷fU7F¶R¢dd”Ä”DUõ5Ä•Eõ5B’ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢÷EF&vWC¢F&vWBÀ¢÷Df–ÆÆVC¢÷BÀ¢f–ÆÅ7C¢F&vWBòÖF‚æÖ–âƒÂÖF‚ç&÷VæB‚‡÷BòF&vWB’¢’’¢çVÆÂÀ¢VçG&çG2À¢–å&öf—E¦öæS¢–å&öf—BÀ¢&öf—E¦öæU&V6†VDC¢f–v‡Bç&öf—E¦öæU&V6†VDBÇÂçVÆÂÀ¢&öf—D&÷fU7F¶RÀ¢–÷W%&ö¦V7FVE6†&S¢–÷W%6†&RÀ¢6å7F'C¢–å&öf—BÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöBF†B7FGW2ârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òò„TBÕDòÔ„TB4„ÄÄTätU0¢òð¢òò†VB×FòÖ†VB—2æ÷BæWrÖöæW’7—7FVÒ(	B—B—26öçFW7Bv—F‚GvòVçG&çG2à¢òòF†RÆFf÷&Ò—2Ç&VG’F†R&VfW&VS¢—BW67&÷w2&÷F‚7F¶W2–â—G2÷vâÆVFvW"À¢òò66÷&W2&÷F‚6&G26W'fW"×6–FRg&öÒF†Röff–6–Â&÷VæB7FG2ÂæB—2÷WBà¢òò6òF†—2f–ÆR&WW6W2F†R†&FVæVB—VÆ–æR&F†W"F†â–çfVçF–ær&ÆÆVÂöæS ¢òð¢òòÒ7F¶W2&RFV&—FVBF‡&÷Vv‚G&ç67F–öâv—F‚ÆVFvW"&÷rÂÆ–¶RVçG&–W0¢òòÒ&÷F‚Æ–W'266÷&Rv—F‚6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2ÂÆ–¶R6öçFW7G0¢òòÒ6WGFÆVÖVçB—26Æ–ÖVBFöÖ–6ÆÇ’&Vf÷&RÖöæW’Ö÷fW2ÂÆ–¶Rf–v‡B6WGFÆVÖVç@¢òòÒ&VgVæG2vò&6²F‡&÷Vv‚F†RvÆÆWBv—F‚âVF—B&÷rÂÆ–¶R6æ6VÆÆF–öç0¢òð¢òòv†B—2vVçV–æVÇ’æWr—2öæÇ’F†R–çf—FRÆ–fV7–6ÆS¢6†ÆÆVævRÂ66WBÂFV6Æ–æRÀ¢òòW‡—&R(	BÇW2F–R'VÆRÂv†–6‚ÖGFW'2†W&R&V6W6RF–R&WGvVVâGvòÆ–W'0¢òò—26öÖÖöâv†W&RF–R7&÷72C×Æ–W"÷B—2æ÷Bà¢òð¢òò4„•TBôdbâ„TEõDõô„TEôTä$ÄTB×W7B&RwG'VRrFòW‡÷6Rç’öb—BâVW"×FòÐ¢òòVW"7F¶–ær—26Æ76–f–VBF–ffW&VçFÇ’g&öÒööÆVBfçF7’6öçFW7G2–â6öÖP¢òò7FFW2Â6òF†—27F—2F&²VçF–ÂF†R$U5E$”5DTEõ5DDU2ÆVvÂ&Wf–WrÆæG2à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7B„TEõDõô„TEôTä$ÄTBÒ²wG'VRrÂsrÂw–W2rÂvöâuÐ¢æ–æ6ÇVFW2…7G&–ær‡&ö6W72æVçbä„TEõDõô„TEôTä$ÄTBÇÂvfÇ6Rr’çG&–Ò‚’çFôÆ÷vW$66R‚’“° ¢òò7G&–7FW"F†âF†RÆFf÷&ÒÆ—7Bv†Vâ6WBÂ&V6W6RF†—2—2F†R&öGV7BÖ÷7@¢òòÆ–¶VÇ’Fò&R&W7G&–7FVBv†W&RööÆVB6öçFW7G2&Ræ÷Bà¦6öç7B„TEõDõô„TEõ$U5E$”5DTEõ5DDU2Ò7G&–ær‡&ö6W72æVçbä„TEõDõô„TEõ$U5E$”5DTEõ5DDU2ÇÂrr¢ç7Æ—B‚rÂr’æÖ‚‡‚’Óâ‚çG&–Ò‚’çFõWW$66R‚’’æf–ÇFW"„&ööÆVâ“° ¢òòÆFf÷&Ò7WBöâ†VB×FòÖ†VB÷BâF†—2—2†÷rDe2÷W&F÷'2&–6Rƒ$‚(	BF†P¢òò†÷W6RF¶W2W&6VçFvRöbF†RGvò7F¶W2&F†W"F†â6†&RöbööÂâF¶Và¢òòôäÅ’öâFV6–FVB&W7VÇC¢F–R&WGW&ç2&÷F‚7F¶W2v†öÆRÂ&V6W6RG&và¢òò6öçFW7B—2æ÷B6W'f–6RvR6†÷VÆB&R6†&v–ærf÷"à¦6öç7Bƒ$…õ$´UõU$4TåBÒÖF‚æÖ–âƒ#RÂÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbä„TEõDõô„TEõ$´UõU$4TåBóò’’“° ¦6öç7Bƒ$…ôÔ”åõ5D´RÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbä„TEõDõô„TEôÔ”åõ5D´RÇÂ’“°¦6öç7Bƒ$…ôÔ…õ5D´RÒÖF‚æÖ‚„ƒ$…ôÔ”åõ5D´RÂçVÖ&W"‡&ö6W72æVçbä„TEõDõô„TEôÔ…õ5D´RÇÂS’“° ¦6öç7B6†ÆÆVævU66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢f–v‡D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢6÷W&6UG—S¢²G—S¢7G&–ærÂVçVÓ¢²vÖF6‚rÂw6†F÷ruÒÂFVfVÇC¢vÖF6‚rÒÀ¢6†ÆÆVævW$–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢÷öæVçD–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢7F¶S¢²G—S¢çVÖ&W"Â&WV—&VC¢G'VRÂÖ–ã¢ÒÀ¢7FGW3¢°¢G—S¢7G&–ærÀ¢VçVÓ¢²uTäD”ärrÂt44UDTBrÂtDT4Ä”äTBrÂtU…•$TBrÂu4UEDÄTBrÂudô”BuÒÀ¢FVfVÇC¢uTäD”ärrÀ¢–æFWƒ¢G'VRÀ¢ÒÀ¢W‡—&W4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ¢òòf–ÆÆVBB6WGFÆVÖVçBâv–ææW$–B7F—2çVÆÂöâF–Rà¢v–ææW$–C¢²G—S¢7G&–ærÂFVfVÇC¢çVÆÂÒÀ¢F–S¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢–÷WC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢òòÆFf÷&Ò7WB7GVÆÇ’F¶VâÂ–â6ö–ç2â¦W&òöâF–R÷"fö–Bà¢&¶S¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6†ÆÆVævW%ö–çG3¢²G—S¢çVÖ&W"ÂFVfVÇC¢çVÆÂÒÀ¢÷öæVçEö–çG3¢²G—S¢çVÖ&W"ÂFVfVÇC¢çVÆÂÒÀ¢6WGFÆVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢fö–E&V6öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¢òòöæRÆ—fR6†ÆÆVævRW"—"W"f–v‡Bâ6WGFÆVBöFV6Æ–æVB&÷w2&RW†6ÇVFVB6ò¢òò&VÖF6‚öâÆFW"f–v‡B(	B÷"gFW"FV6Æ–æR(	B—27F–ÆÂ÷76–&ÆRà¦6†ÆÆVævU66†VÖæ–æFW‚€¢²f–v‡D–C¢Â6†ÆÆVævW$–C¢Â÷öæVçD–C¢Â7FGW3¢ÒÀ¢²'F–Äf–ÇFW$W‡&W76–öã¢²7FGW3¢²F–ã¢²uTäD”ärrÂt44UDTBuÒÒÒÒÀ¢“° ¦6öç7B6†ÆÆVævRÒÖöævö÷6RæÖöFVÇ2ä6†ÆÆVævRÇÂÖöævö÷6RæÖöFVÂ‚t6†ÆÆVævRrÂ6†ÆÆVævU66†VÖ“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòDU5E%T5D•dR%TÄ²õU$D”ôå0¢òò6WfW&ÂFÖ–â&÷WFW26ÆÂFVÆWFTÖç’‡·Ò’(	Bv—–ærâVçF—&R6öÆÆV7F–öâ–âöæP¢òò&WVW7BâFÖ–âÖöæÇ’7F÷2÷WG6–FW'2Â'WBæ÷BÖ—2×FÂ7FÆR'&÷w6W"F"Â÷ ¢òò67&—Bö–çFVBBF†Rw&öærVçf—&öæÖVçBâV6‚æ÷ræVVG2F†R6öÆÆV7F–öâæÖV@¢òò&6²W‡Æ–6—FÇ’ÂæBV6‚Æöw2v†òF–B—Bà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòFV6Æ&VB2†ö—7FVBgVæ7F–öâÂäõB6öç7B'&÷s¢F†R&÷WFW2F†BW6R—B&P¢òò&Vv—7FW&VBV&Æ–W"–âF†—2f–ÆRÂæB6öç7Bv÷VÆB7F–ÆÂ&R–âF†RFV×÷&À¢òòFVB¦öæRBF†Bö–çB(	Bv†–6‚7&6†VBF†R6W'fW"B&ö÷Bv—F€¢òò$6ææ÷B66W72w&WV—&T'VÆ´6öæf—&ÖF–öâr&Vf÷&R–æ—F–Æ—¦F–öâ"à¦gVæ7F–öâ&WV—&T'VÆ´6öæf—&ÖF–öâ†6öÆÆV7F–öäæÖR’°¢&WGW&â‡&WÂ&W2ÂæW‡B’Óâ°¢6öç7B7WÆ–VBÒ7G&–ær‡&Wæ&öG“òæ6öæf—&ÒÇÂ&WçVW'“òæ6öæf—&ÒÇÂrr’çG&–Ò‚“°¢–b‡7WÆ–VBÓÒDTÄUDRÔÄÂÒG¶6öÆÆV7F–öäæÖWÖ’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢F†—2W&ÖæVçFÇ’FVÆWFW2WfW'’&V6÷&B–âG¶6öÆÆV7F–öäæÖWÒâ6VæB6öæf—&ÓÒ$DTÄUDRÔÄÂÒG¶6öÆÆV7F–öäæÖWÒ"Fò&ö6VVBæÀ¢6öFS¢t%TÄµô4ôäd•$ÔD”ôåõ$UT•$TBrÀ¢Ò“°¢Ð¢6öç6öÆRçv&â†¶'VÆ²ÖFVÆWFUÒG¶6öÆÆV7F–öäæÖWÒv—VB'’FÖ–âG·&WæFÖ–ãòæ–BÇÂwVæ¶æ÷vâwÒBG¶æWrFFR‚’çFô•4õ7G&–ær‚—Ö“°¢&WGW&âæW‡B‚“°¢Ó°§Ð ¦6öç7Bƒ&„W'&÷"Ò‡7FGW2ÂÖW76vRÂ6öFRÂW‡G&Ò·Ò’Óâ°¢6öç7BW'&÷"ÒæWrW'&÷"†ÖW76vR“°¢W'&÷"ç7FGW2Ò7FGW3°¢W'&÷"æ6öFRÒ6öFS°¢W'&÷"æW‡G&ÒW‡G&°¢&WGW&âW'&÷#°§Ó° ¦6öç7B&WV—&T†VEFô†VBÒ‡&WÂ&W2ÂæW‡B’Óâ°¢–b‚„TEõDõô„TEôTä$ÄTB’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢t†VB×FòÔ†VB—2æ÷B÷Vâ–WBâ¦ö–âF†Rv—FÆ—7BæBvRv–ÆÂVÖ–Â–÷RârÀ¢6öFS¢tdTEU$UôD•4$ÄTBrÀ¢Ò“°¢Ð¢&WGW&âæW‡B‚“°§Ó° ¢òò†VB×FòÖ†VB—2–BÂVW"×Fò×VW"7F–öâÂ6ò—B6ÆV'2F†Ræ÷&ÖÂÆ’vFP¢òòäB—G2÷vâ7FFRÆ—7Bà¦6öç7B6†V6´†VEFô†VDVÆ–v–&–Æ—G’Ò‡W6W"’Óâ°¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’‡W6W"“°¢–b†&Æö6¶VB’&WGW&â&Æö6¶VC°¢6öç7B7FFRÒ7G&–ær‡W6W#òç&W6–FVæ6U7FFRÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢–b‡7FFRbb„TEõDõô„TEõ$U5E$”5DTEõ5DDU2æ–æ6ÇVFW2‡7FFR’’°¢&WGW&â°¢6öFS¢tƒ$…õ5DDUõ$U5E$”5DTBrÀ¢ÖW76vS¢t†VB×FòÔ†VB6†ÆÆVævW2&Ræ÷Bf–Æ&ÆR–â–÷W"7FFRârÀ¢Ó°¢Ð¢&WGW&âçVÆÃ°§Ó° ¦6öç7BÆöDf–v‡Df÷$6†ÆÆVævRÒ7–æ2†f–v‡D–BÂ6W76–öâÒçVÆÂ’Óâ°¢ÆWB6÷W&6UG—RÒvÖF6‚s°¢ÆWBf–v‡BÒv—Bv—F„f–v‡E6W76–öâ„ÖF6‚æf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢–b‚f–v‡B’°¢6÷W&6UG—RÒw6†F÷rs°¢f–v‡BÒv—Bv—F„f–v‡E6W76–öâ…6†F÷ræf–æD'”–B†f–v‡D–B’Â6W76–öâ“°¢Ð¢&WGW&â²f–v‡BÂ6÷W&6UG—RÓ°§Ó° ¢òò&÷F‚Æ–W'2vvW"öâF†R66÷&V6&BF†W’Ç&VG’7V&Ö—GFVBf÷"F†—2f–v‡Bà¢òòæò6V6öæB&VF–7F–öâ7W&f6RÂæòv’Fò66÷&R6†ÆÆVævRöfb6&BF†P¢òòÆ–W"æWfW"VçFW&VBà¦6öç7B&WV—&TVçG'”f÷$6†ÆÆVævRÒ7–æ2‡W6W$–BÂf–v‡D–BÂ6W76–öâÒçVÆÂ’Óâ°¢6öç7BVçG'’Òv—Bv—F„f–v‡E6W76–öâ€¢66÷&Ræf–æDöæR‡²Æ–W$–C¢7G&–ær‡W6W$–B’ÂÖF6„–C¢7G&–ær†f–v‡D–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ’À¢6W76–öâÀ¢’æÆVâ‚“°¢–b‚VçG'’’°¢F‡&÷rƒ&„W'&÷"ƒC’Âu–÷RæVVB66÷&V6&B–âF†—2f–v‡B&Vf÷&R–÷R6âvvW"öâ—BârÂtäõôTåE%•õ”UBr“°¢Ð¢&WGW&âVçG'“°§Ó° ¢òòÖ÷fW27F¶R÷WBöbvÆÆWBæB–çFòW67&÷rÂ÷"&6²v–ââ6ÖRÆVFvW"F†P¢òò&W7BöbF†RÖöæW’F‡2w&—FRFòÂ6ò6†ÆÆVævR—2VF—F&ÆRÆöæw6–FRVçG&–W2à¦6öç7BÖ÷fT6†ÆÆVævU7F¶RÒ7–æ2‡²W6W$–BÂFVÇFÂ&V6öâÂ&VfW&Væ6RÂ6W76–öâÂÖWFÒ·ÒÒ’Óâ°¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ…W6W"æf–æD'”–B‡W6W$–B’Â6W76–öâ“°¢–b‚W6W"’F‡&÷rƒ&„W'&÷"ƒCBÂt66÷VçBæ÷Bf÷VæBârÂuU4U%ôäõEôdõTäBr“°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢6öç7BgFW"Ò&Vf÷&R²FVÇF°¢–b†gFW"Â’°¢F‡&÷rƒ&„W'&÷"ƒC"Âtæ÷BVæ÷Vv‚dÒ6ö–ç2f÷"F†B7F¶RârÂt”å5Tdd”4”TåEôeTäE2rÂ°¢&Ææ6S¢&Vf÷&RÀ¢7F¶S¢ÖF‚æ'2†FVÇF’À¢6†÷'FfÆÃ¢ÖF‚æ'2†FVÇF’Ò&Vf÷&RÀ¢Ò“°¢Ð¢W6W"çFö¶Vç2Ò7G&–ær†gFW"“°¢v—BW6W"ç6fR‡6W76–öâò²6W76–öâÒ¢VæFVf–æVB“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–BÀ¢Ö÷VçC¢FVÇFÀ¢&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢gFW"À¢&V6öâÀ¢&VfW&Væ6RÀ¢ÖWFÀ¢6W76–öâÀ¢Ò“°¢&WGW&â²&Vf÷&RÂgFW"Ó°§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò5$TDR(	B6†ÆÆVævW"w27F¶R—2W67&÷vVB–ÖÖVF–FVÇ’Â6òF†R6ö–ç2F†W’&P¢òòöffW&–ær6ææ÷B&R7VçBVÇ6Wv†W&Rv†–ÆRF†R–çf—FR—2÷WG7FæF–ærà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’ö6†ÆÆVævW2rÂ&WV—&T†VEFô†VBÂ7V&Ö—DÆ–Ö—FW"ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6†ÆÆVævW$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wæ&öG“òæf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7B7F¶RÒÖF‚æfÆö÷"„çVÖ&W"‡&Wæ&öG“òç7F¶R’ÇÂ“°¢6öç7B÷öæVçD†æFÆRÒ7G&–ær‡&Wæ&öG“òæ÷öæVçBÇÂrr’çG&–Ò‚“° ¢–b‚f–v‡D–B’F‡&÷rƒ&„W'&÷"ƒCÂtf–v‡B—2&WV—&VBârÂt”ådÄ”Eôd”t…Eô”Br“°¢–b‚÷öæVçD†æFÆR’F‡&÷rƒ&„W'&÷"ƒCÂt6†ö÷6Rv†ò–÷R&R6†ÆÆVæv–ærârÂt”ådÄ”EôõôäTåBr“°¢–b‡7F¶RÂƒ$…ôÔ”åõ5D´RÇÂ7F¶Râƒ$…ôÔ…õ5D´R’°¢F‡&÷rƒ&„W'&÷"ƒC#"Â7F¶R×W7B&R&WGvVVâG´ƒ$…ôÔ”åõ5D´WÒæBG´ƒ$…ôÔ…õ5D´WÒdÒæÂt”ådÄ”Eõ5D´RrÂ°¢Ö–ã¢ƒ$…ôÔ”åõ5D´RÀ¢Öƒ¢ƒ$…ôÔ…õ5D´RÀ¢Ò“°¢Ð ¢òò&W6öÇfRF†R÷öæVçB'’Æ–W"æÖR÷"VÖ–ÂÂæWfW"'’â–BF†R6Æ–Vç@¢òò7WÆ–W2(	B6ò6†ÆÆVævR6ææ÷B&R–ÖVBBâ&&—G&'’66÷VçB&÷rà¢6öç7B÷öæVçBÒv—BW6W"æf–æDöæR‡°¢F÷#¢°¢²Æ–W$æÖS¢æWr&VtW‡†âG¶÷öæVçD†æFÆRç&WÆ6R‚õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÂuÅÂBbr—ÒFÂv’r’ÒÀ¢²VÖ–Ã¢÷öæVçD†æFÆRçFôÆ÷vW$66R‚’ÒÀ¢ÒÀ¢Ò’ç6VÆV7B‚uö–BVÖ–ÂÆ–W$æÖRf—'7DæÖRFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–Âr’æÆVâ‚“° ¢–b‚÷öæVçB’F‡&÷rƒ&„W'&÷"ƒCBÂuvR6÷VÆBæ÷Bf–æBF†BÆ–W"ârÂtõôäTåEôäõEôdõTäBr“°¢–b…7G&–ær†÷öæVçBåö–B’ÓÓÒ6†ÆÆVævW$–B’°¢F‡&÷rƒ&„W'&÷"ƒC#"Âu–÷R6ææ÷B6†ÆÆVævR–÷W'6VÆbârÂu4TÄeô4„ÄÄTätRr“°¢Ð ¢6öç7B&W7VÇBÒv—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢6öç7B²f–v‡BÂ6÷W&6UG—RÒÒv—BÆöDf–v‡Df÷$6†ÆÆVævR†f–v‡D–BÂ6W76–öâ“°¢–b‚f–v‡B’F‡&÷rƒ&„W'&÷"ƒCBÂtf–v‡Bæ÷Bf÷VæBârÂtd”t…EôäõEôdõTäBr“°¢–b‚—4f–v‡D÷Väf÷$VçG'’†f–v‡B’’°¢F‡&÷rƒ&„W'&÷"ƒC’Âu&VF–7F–öç2&RÆö6¶VBf÷"F†—2f–v‡BârÂtd”t…EôÄô4´TBr“°¢Ð ¢6öç7B6†ÆÆVævW"Òv—Bv—F„f–v‡E6W76–öâ€¢W6W"æf–æD'”–B†6†ÆÆVævW$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRf—'7DæÖRFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–Âr’À¢6W76–öâÀ¢’æÆVâ‚“° ¢6öç7B6†ÆÆVævW$&Æö6¶VBÒ6†V6´†VEFô†VDVÆ–v–&–Æ—G’†6†ÆÆVævW"“°¢–b†6†ÆÆVævW$&Æö6¶VB’F‡&÷rƒ&„W'&÷"ƒC2Â6†ÆÆVævW$&Æö6¶VBæÖW76vRÂ6†ÆÆVævW$&Æö6¶VBæ6öFR“°¢6öç7B÷öæVçD&Æö6¶VBÒ6†V6´†VEFô†VDVÆ–v–&–Æ—G’†÷öæVçB“°¢–b†÷öæVçD&Æö6¶VB’°¢F‡&÷rƒ&„W'&÷"ƒC’ÂuF†BÆ–W"6ææ÷B66WB6†ÆÆVævW2&–v‡Bæ÷rârÂtõôäTåEô”äTÄ”t”$ÄRr“°¢Ð ¢v—B&WV—&TVçG'”f÷$6†ÆÆVævR†6†ÆÆVævW$–BÂf–v‡D–BÂ6W76–öâ“° ¢6öç7BW†—7F–ærÒv—Bv—F„f–v‡E6W76–öâ„6†ÆÆVævRæf–æDöæR‡°¢f–v‡D–BÀ¢7FGW3¢²F–ã¢²uTäD”ärrÂt44UDTBuÒÒÀ¢F÷#¢°¢²6†ÆÆVævW$–BÂ÷öæVçD–C¢7G&–ær†÷öæVçBåö–B’ÒÀ¢²6†ÆÆVævW$–C¢7G&–ær†÷öæVçBåö–B’Â÷öæVçD–C¢6†ÆÆVævW$–BÒÀ¢ÒÀ¢Ò’Â6W76–öâ’æÆVâ‚“°¢–b†W†—7F–ær’°¢F‡&÷rƒ&„W'&÷"ƒC’Âu–÷RÇ&VG’†fR6†ÆÆVævR'Vææ–ærv—F‚F†BÆ–W"öâF†—2f–v‡BârÂt4„ÄÄTätUôU„•5E2r“°¢Ð ¢òòF†R–çf—FRF–W2BF†R&VF–7F–öâÆö6²BF†RÆFW7B(	BâVæ66WFV@¢òò6†ÆÆVævR×W7BæWfW"÷WFÆ—fRF†RF†–ær—B—2&WGF–æröâà¢6öç7BÆö6´BÒf–v‡BæÖF6„FFRòæWrFFR†f–v‡BæÖF6„FFR’¢çVÆÃ°¢6öç7B–ã#F‚ÒæWrFFR„FFRææ÷r‚’²#B¢c¢c¢“°¢6öç7BW‡—&W4BÒÆö6´BbbÆö6´BævWEF–ÖR‚’âFFRææ÷r‚’bbÆö6´BÂ–ã#F‚òÆö6´B¢–ã#Fƒ° ¢v—BÖ÷fT6†ÆÆVævU7F¶R‡°¢W6W$–C¢6†ÆÆVævW$–BÀ¢FVÇF¢×7F¶RÀ¢&V6öã¢vƒ&…÷7F¶UöW67&÷rrÀ¢&VfW&Væ6S¢ƒ&ƒ¢G¶f–v‡D–GÓ¢G¶6†ÆÆVævW$–GÖÀ¢6W76–öâÀ¢ÖWF¢²÷öæVçD–C¢7G&–ær†÷öæVçBåö–B’Â7F¶RÒÀ¢Ò“° ¢6öç7B¶6†ÆÆVævUÒÒv—B6†ÆÆVævRæ7&VFR…·°¢f–v‡D–BÀ¢6÷W&6UG—RÀ¢6†ÆÆVævW$–BÀ¢÷öæVçD–C¢7G&–ær†÷öæVçBåö–B’À¢7F¶RÀ¢7FGW3¢uTäD”ärrÀ¢W‡—&W4BÀ¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢&WGW&â²6†ÆÆVævRÂf–v‡BÂ6†ÆÆVævW"Â÷öæVçBÓ°¢Ò“° ¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢&W7VÇBæ÷öæVçBæVÖ–ÂÀ¢7V&¦V7C¢u–÷R†fR&VVâ6†ÆÆVævVBrÀ¢†VF–æs¢t„TBÕDòÔ„TB4„ÄÄTätRrÀ¢Æ–æW3¢°¢G·&W7VÇBæ6†ÆÆVævW#òçÆ–W$æÖRÇÂtÆ–W"wÒ†26†ÆÆVævVB–÷RöâG·&W7VÇBæf–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G·&W7VÇBæf–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÒæÀ¢7F¶S¢Ç7G&öæsâG·&W7VÇBæ6†ÆÆVævRç7F¶RçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâV6‚âv–ææW"F¶W2G´ÖF‚æfÆö÷"‚‡&W7VÇBæ6†ÆÆVævRç7F¶R¢"’¢ƒÒƒ$…õ$´UõU$4TåB’ò’çFôÆö6ÆU7G&–ær‚—ÒdÒgFW"G´ƒ$…õ$´UõU$4TåGÒRÆFf÷&ÒfVRâG&r&WGW&ç2&÷F‚7F¶W2–âgVÆÂæÀ¢u7V&Ö—B–÷W"66÷&V6&Bf÷"F†—2f–v‡BÂF†Vâ66WBF†R6†ÆÆVævR&Vf÷&R&VF–7F–öç2Æö6²ârÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢6†ÆÆVævT–C¢&W7VÇBæ6†ÆÆVævRåö–BÀ¢7FGW3¢&W7VÇBæ6†ÆÆVævRç7FGW2À¢7F¶S¢&W7VÇBæ6†ÆÆVævRç7F¶RÀ¢÷C¢&W7VÇBæ6†ÆÆVævRç7F¶R¢"À¢&¶UW&6VçC¢ƒ$…õ$´UõU$4TåBÀ¢v–ææW%&V6V—fW3¢ÖF‚æfÆö÷"‚‡&W7VÇBæ6†ÆÆVævRç7F¶R¢"’¢ƒÒƒ$…õ$´UõU$4TåB’ò’À¢W‡—&W4C¢&W7VÇBæ6†ÆÆVævRæW‡—&W4BÀ¢÷öæVçC¢²–C¢&W7VÇBæ÷öæVçBåö–BÂæÖS¢&W7VÇBæ÷öæVçBçÆ–W$æÖRÇÂ&W7VÇBæ÷öæVçBæf—'7DæÖRÇÂuÆ–W"rÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚t6†ÆÆVævR7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B6VæBF†B6†ÆÆVævRârÀ¢6öFS¢W'&÷#òæ6öFRÇÂt4„ÄÄTätUôd”ÄTBrÀ¢âââ†W'&÷#òæW‡G&ÇÂ·Ò’À¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò44UB(	BW67&÷w2F†R÷öæVçBw27F¶Râ6Æ–ÖVBFöÖ–6ÆÇ’6òF÷V&ÆR×F ¢òò6ææ÷BFV&—BGv–6Rà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’ö6†ÆÆVævW2ó¦–Bö66WBrÂ&WV—&T†VEFô†VBÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B6†ÆÆVævT–BÒ7G&–ær‡&Wç&×2æ–BÇÂrr’çG&–Ò‚“° ¢6öç7B&W7VÇBÒv—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢6öç7B6†ÆÆVævRÒv—Bv—F„f–v‡E6W76–öâ„6†ÆÆVævRæf–æD'”–B†6†ÆÆVævT–B’Â6W76–öâ“°¢–b‚6†ÆÆVævR’F‡&÷rƒ&„W'&÷"ƒCBÂt6†ÆÆVævRæ÷Bf÷VæBârÂt4„ÄÄTätUôäõEôdõTäBr“°¢–b…7G&–ær†6†ÆÆVævRæ÷öæVçD–B’ÓÒW6W$–B’°¢F‡&÷rƒ&„W'&÷"ƒC2ÂuF†—26†ÆÆVævRv2æ÷B6VçBFò–÷RârÂtäõEõ”õU%ô4„ÄÄTätRr“°¢Ð¢–b†6†ÆÆVævRç7FGW2ÓÒuTäD”ärr’°¢F‡&÷rƒ&„W'&÷"ƒC’ÂF†—26†ÆÆVævR—2Ç&VG’G¶6†ÆÆVævRç7FGW2çFôÆ÷vW$66R‚—ÒæÂt4„ÄÄTätUôäõEõTäD”ärr“°¢Ð¢–b†6†ÆÆVævRæW‡—&W4BævWEF–ÖR‚’ÃÒFFRææ÷r‚’’°¢F‡&÷rƒ&„W'&÷"ƒC’ÂuF†—26†ÆÆVævR†2W‡—&VBârÂt4„ÄÄTätUôU…•$TBr“°¢Ð ¢6öç7B²f–v‡BÒÒv—BÆöDf–v‡Df÷$6†ÆÆVævR†6†ÆÆVævRæf–v‡D–BÂ6W76–öâ“°¢–b‚f–v‡B’F‡&÷rƒ&„W'&÷"ƒCBÂtf–v‡Bæ÷Bf÷VæBârÂtd”t…EôäõEôdõTäBr“°¢–b‚—4f–v‡D÷Väf÷$VçG'’†f–v‡B’’°¢F‡&÷rƒ&„W'&÷"ƒC’Âu&VF–7F–öç2&RÆö6¶VBf÷"F†—2f–v‡BârÂtd”t…EôÄô4´TBr“°¢Ð ¢6öç7BÖRÒv—Bv—F„f–v‡E6W76–öâ€¢W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–Âr’À¢6W76–öâÀ¢’æÆVâ‚“°¢6öç7B&Æö6¶VBÒ6†V6´†VEFô†VDVÆ–v–&–Æ—G’†ÖR“°¢–b†&Æö6¶VB’F‡&÷rƒ&„W'&÷"ƒC2Â&Æö6¶VBæÖW76vRÂ&Æö6¶VBæ6öFR“° ¢v—B&WV—&TVçG'”f÷$6†ÆÆVævR‡W6W$–BÂ6†ÆÆVævRæf–v‡D–BÂ6W76–öâ“° ¢òò6Æ–ÒF†R66WFæ6R&Vf÷&RF†RFV&—Bà¢6öç7B6Æ–ÖVBÒv—Bv—F„f–v‡E6W76–öâ€¢6†ÆÆVævRæf–æDöæTæEWFFR€¢²ö–C¢6†ÆÆVævT–BÂ7FGW3¢uTäD”ärrÒÀ¢²G6WC¢²7FGW3¢t44UDTBrÒÒÀ¢²æWs¢G'VRÒÀ¢’À¢6W76–öâÀ¢“°¢–b‚6Æ–ÖVB’F‡&÷rƒ&„W'&÷"ƒC’ÂuF†—26†ÆÆVævRv2Ç&VG’ç7vW&VBârÂt4„ÄÄTätUôäõEõTäD”ärr“° ¢6öç7B&Ææ6RÒv—BÖ÷fT6†ÆÆVævU7F¶R‡°¢W6W$–BÀ¢FVÇF¢Ö6†ÆÆVævRç7F¶RÀ¢&V6öã¢vƒ&…÷7F¶UöW67&÷rrÀ¢&VfW&Væ6S¢ƒ&ƒ¢G¶6†ÆÆVævRæf–v‡D–GÓ¢G·W6W$–GÖÀ¢6W76–öâÀ¢ÖWF¢²6†ÆÆVævT–C¢7G&–ær†6†ÆÆVævRåö–B’Â7F¶S¢6†ÆÆVævRç7F¶RÒÀ¢Ò“° ¢&WGW&â²6†ÆÆVævS¢6Æ–ÖVBÂf–v‡BÂ&Ææ6RÂÖRÓ°¢Ò“° ¢6öç7B6†ÆÆVævW"Òv—BW6W"æf–æD'”–B‡&W7VÇBæ6†ÆÆVævRæ6†ÆÆVævW$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRr’æÆVâ‚“°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢6†ÆÆVævW#òæVÖ–ÂÀ¢7V&¦V7C¢u–÷W"6†ÆÆVævRv266WFVBrÀ¢†VF–æs¢t4„ÄÄTätR44UDTBrÀ¢Æ–æW3¢°¢G·&W7VÇBæÖSòçÆ–W$æÖRÇÂu–÷W"÷öæVçBwÒ66WFVB–÷W"G·&W7VÇBæ6†ÆÆVævRç7F¶RçFôÆö6ÆU7G&–ær‚—ÒdÒ6†ÆÆVævRæÀ¢v–ææW"F¶W2Ç7G&öæsâG²‡&W7VÇBæ6†ÆÆVævRç7F¶R¢"’çFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâöæ6RF†Rf–v‡B—266÷&VBæÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢6†ÆÆVævT–C¢&W7VÇBæ6†ÆÆVævRåö–BÀ¢7FGW3¢&W7VÇBæ6†ÆÆVævRç7FGW2À¢÷C¢&W7VÇBæ6†ÆÆVævRç7F¶R¢"À¢&¶UW&6VçC¢ƒ$…õ$´UõU$4TåBÀ¢v–ææW%&V6V—fW3¢ÖF‚æfÆö÷"‚‡&W7VÇBæ6†ÆÆVævRç7F¶R¢"’¢ƒÒƒ$…õ$´UõU$4TåB’ò’À¢vÆÆWD&Ææ6S¢&W7VÇBæ&Ææ6RægFW"À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚t6†ÆÆVævR66WBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷B66WBF†B6†ÆÆVævRârÀ¢6öFS¢W'&÷#òæ6öFRÇÂt44UEôd”ÄTBrÀ¢âââ†W'&÷#òæW‡G&ÇÂ·Ò’À¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòDT4Ä”äRòt•D„E$r(	B&WGW&ç2F†RW67&÷vVB7F¶RâV—F†W"6–FRÖ’&6²÷W@¢òòv†–ÆRF†R–çf—FR—27F–ÆÂVæF–ærà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B&VÆV6T6†ÆÆVævRÒ7–æ2‡²6†ÆÆVævT–BÂ7F÷$–BÂæW‡E7FGW2Â&V6öâÒ’Óâ'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢6öç7B6†ÆÆVævRÒv—Bv—F„f–v‡E6W76–öâ„6†ÆÆVævRæf–æD'”–B†6†ÆÆVævT–B’Â6W76–öâ“°¢–b‚6†ÆÆVævR’F‡&÷rƒ&„W'&÷"ƒCBÂt6†ÆÆVævRæ÷Bf÷VæBârÂt4„ÄÄTätUôäõEôdõTäBr“°¢–b†7F÷$–Bbbµ7G&–ær†6†ÆÆVævRæ6†ÆÆVævW$–B’Â7G&–ær†6†ÆÆVævRæ÷öæVçD–B•Òæ–æ6ÇVFW2…7G&–ær†7F÷$–B’’’°¢F‡&÷rƒ&„W'&÷"ƒC2ÂuF†—26†ÆÆVævR—2æ÷B–÷W'2ârÂtäõEõ”õU%ô4„ÄÄTätRr“°¢Ð ¢òòFöÖ–26Æ–Ó¢öæÇ’öæR6ÆÆW"vWG2Fò&VÆV6RF†RW67&÷rà¢6öç7B6Æ–ÖVBÒv—Bv—F„f–v‡E6W76–öâ€¢6†ÆÆVævRæf–æDöæTæEWFFR€¢²ö–C¢6†ÆÆVævT–BÂ7FGW3¢uTäD”ärrÒÀ¢²G6WC¢²7FGW3¢æW‡E7FGW2Âfö–E&V6öã¢&V6öâÇÂrrÒÒÀ¢²æWs¢G'VRÒÀ¢’À¢6W76–öâÀ¢“°¢–b‚6Æ–ÖVB’°¢6öç7B7W'&VçBÒv—Bv—F„f–v‡E6W76–öâ„6†ÆÆVævRæf–æD'”–B†6†ÆÆVævT–B’Â6W76–öâ’æÆVâ‚“°¢&WGW&â²Ç&VG•&W6öÇfVC¢G'VRÂ6†ÆÆVævS¢7W'&VçBÓ°¢Ð ¢v—BÖ÷fT6†ÆÆVævU7F¶R‡°¢W6W$–C¢6†ÆÆVævRæ6†ÆÆVævW$–BÀ¢FVÇF¢6†ÆÆVævRç7F¶RÀ¢&V6öã¢vƒ&…÷7F¶U÷&WGW&æVBrÀ¢&VfW&Væ6S¢ƒ&ƒ§&VÆV6S¢G¶6†ÆÆVævT–GÖÀ¢6W76–öâÀ¢ÖWF¢²6†ÆÆVævT–C¢7G&–ær†6†ÆÆVævT–B’Â7FGW3¢æW‡E7FGW2ÒÀ¢Ò“° ¢&WGW&â²Ç&VG•&W6öÇfVC¢fÇ6RÂ6†ÆÆVævS¢6Æ–ÖVBÓ°§Ò“° ¦ç÷7B‚rö’ö6†ÆÆVævW2ó¦–BöFV6Æ–æRrÂ&WV—&T†VEFô†VBÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W7VÇBÒv—B&VÆV6T6†ÆÆVævR‡°¢6†ÆÆVævT–C¢7G&–ær‡&Wç&×2æ–BÇÂrr’çG&–Ò‚’À¢7F÷$–C¢7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚’À¢æW‡E7FGW3¢tDT4Ä”äTBrÀ¢&V6öã¢tFV6Æ–æVB'’F†R÷öæVçBârÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢Ç&VG•&W6öÇfVC¢&W7VÇBæÇ&VG•&W6öÇfVBÀ¢ÖW76vS¢&W7VÇBæÇ&VG•&W6öÇfV@¢òuF†B6†ÆÆVævRv2Ç&VG’&W6öÇfVBâp¢¢t6†ÆÆVævRFV6Æ–æVBæBF†R7F¶R&WGW&æVBârÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚t6†ÆÆVævRFV6Æ–æRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷BFV6Æ–æRârÂ6öFS¢W'&÷#òæ6öFRÇÂtDT4Ä”äUôd”ÄTBrÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòÕ’4„ÄÄTätU0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’ö6†ÆÆVævW2öÖRrÂ&WV—&T†VEFô†VBÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B&÷w2Òv—B6†ÆÆVævRæf–æB‡²F÷#¢·²6†ÆÆVævW$–C¢W6W$–BÒÂ²÷öæVçD–C¢W6W$–BÕÒÒ¢ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ’æÆVâ‚“° ¢6öç7B÷F†W$–G2Ò²ââææWr6WB‡&÷w2æÖ‚‡&÷r’Óâ…7G&–ær‡&÷ræ6†ÆÆVævW$–B’ÓÓÒW6W$–Bò&÷ræ÷öæVçD–B¢&÷ræ6†ÆÆVævW$–B’’•Ó°¢6öç7B÷F†W'2Ò÷F†W$–G2æÆVæwF€¢òv—BW6W"æf–æB‡²ö–C¢²F–ã¢÷F†W$–G2æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’’ÒÒ¢ç6VÆV7B‚wÆ–W$æÖRf—'7DæÖR&öf–ÆUW&Âr’æÆVâ‚¢¢µÓ°¢6öç7B'”–BÒæWrÖ†÷F†W'2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢6öç7Bf–v‡D–G2Ò²ââææWr6WB‡&÷w2æÖ‚‡&÷r’Óâ7G&–ær‡&÷ræf–v‡D–B’’•Òæf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7Bf–v‡G2Òf–v‡D–G2æÆVæwF€¢òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢f–v‡D–G2ÒÒ’ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6„6FVv÷'’r’æÆVâ‚¢¢µÓ°¢6öç7Bf–v‡D'”–BÒæWrÖ†f–v‡G2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6†ÆÆVævW3¢&÷w2æÖ‚‡&÷r’Óâ°¢6öç7B”Ô6†ÆÆVævW"Ò7G&–ær‡&÷ræ6†ÆÆVævW$–B’ÓÓÒW6W$–C°¢6öç7B÷F†W"Ò'”–BævWB…7G&–ær†”Ô6†ÆÆVævW"ò&÷ræ÷öæVçD–B¢&÷ræ6†ÆÆVævW$–B’“°¢6öç7Bf–v‡BÒf–v‡D'”–BævWB…7G&–ær‡&÷ræf–v‡D–B’“°¢&WGW&â°¢–C¢&÷råö–BÀ¢f–v‡D–C¢&÷ræf–v‡D–BÀ¢f–v‡C¢f–v‡Bò²f–v‡FW$¢f–v‡BæÖF6„f–v‡FW$Âf–v‡FW$#¢f–v‡BæÖF6„f–v‡FW$"ÂFFS¢f–v‡BæÖF6„FFRÒ¢çVÆÂÀ¢F—&V7F–öã¢”Ô6†ÆÆVævW"òw6VçBr¢w&V6V—fVBrÀ¢÷öæVçDæÖS¢÷F†W#òçÆ–W$æÖRÇÂ÷F†W#òæf—'7DæÖRÇÂuÆ–W"rÀ¢÷öæVçDfF#¢÷F†W#òç&öf–ÆUW&ÂÇÂrrÀ¢7F¶S¢&÷rç7F¶RÀ¢÷C¢&÷rç7F¶R¢"À¢7FGW3¢&÷rç7FGW2À¢W‡—&W4C¢&÷ræW‡—&W4BÀ¢òòöæÇ’ÖVæ–ævgVÂöæ6R6WGFÆVBà¢÷WF6öÖS¢&÷rç7FGW2ÓÒu4UEDÄTBp¢òçVÆÀ¢¢&÷rçF–RòwF–Rr¢…7G&–ær‡&÷rçv–ææW$–B’ÓÓÒW6W$–Bòwvöâr¢vÆ÷7Br’À¢×•ö–çG3¢”Ô6†ÆÆVævW"ò&÷ræ6†ÆÆVævW%ö–çG2¢&÷ræ÷öæVçEö–çG2À¢F†V—%ö–çG3¢”Ô6†ÆÆVævW"ò&÷ræ÷öæVçEö–çG2¢&÷ræ6†ÆÆVævW%ö–çG2À¢–÷WC¢&÷rç–÷WBÀ¢&¶S¢&÷rç&¶RÇÂÀ¢v–ææW%&V6V—fW3¢ÖF‚æfÆö÷"‚‡&÷rç7F¶R¢"’¢ƒÒƒ$…õ$´UõU$4TåB’ò’À¢Ó°¢Ò’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6†ÆÆVævRÆ—7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"6†ÆÆVævW2ârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò4UEDÄTÔTåB(	B66÷&VBg&öÒF†R6ÖRöff–6–Â&÷VæB7FG22F†R÷B6öçFW7Bà¢òòv–ææW"F¶W2&÷F‚7F¶W3²F–R&WGW&ç2&÷F‚â'Vç2W"6†ÆÆVævRv—F‚à¢òòFöÖ–26Æ–ÒÂ6ò&WG&–VB6WGFÆR6ææ÷B’Gv–6Rà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B6WGFÆTf–v‡D6†ÆÆVævW2Ò7–æ2†f–v‡D–B’Óâ°¢6öç7B²f–v‡BÒÒv—BÆöDf–v‡Df÷$6†ÆÆVævR†f–v‡D–B“°¢–b‚f–v‡B’&WGW&â²6WGFÆVC¢Â6¶—VC¢Â&V6öã¢td”t…EôäõEôdõTäBrÓ° ¢6öç7B6FVv÷'’Ò7G&–ær†f–v‡BæÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚“°¢6öç7BöæU7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW$öæU7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW$öæU7FG3°¢6öç7BGvõ7FG2Ò6FVv÷'’ÓÓÒv&÷†–ærròf–v‡Còä&÷†–ætÖF6ƒòæf–v‡FW%Gvõ7FG2¢f–v‡CòäÔÔÖF6ƒòæf–v‡FW%Gvõ7FG3°¢–b‚'&’æ—4'&’†öæU7FG2’ÇÂ'&’æ—4'&’‡Gvõ7FG2’’°¢&WGW&â²6WGFÆVC¢Â6¶—VC¢Â&V6öã¢u5DE5ôÔ•54”ärrÓ°¢Ð ¢6öç7B÷VâÒv—B6†ÆÆVævRæf–æB‡²f–v‡D–C¢7G&–ær†f–v‡D–B’Â7FGW3¢²F–ã¢²uTäD”ärrÂt44UDTBuÒÒÒ’æÆVâ‚“°¢ÆWB6WGFÆVBÒ°¢ÆWBfö–FVBÒ° ¢f÷"†6öç7B&÷röb÷Vâ’°¢òòæWfW"66WFVB(	BF†R7F¶RvöW2&6²Fòv†öWfW"WB—BWà¢–b‡&÷rç7FGW2ÓÓÒuTäD”ärr’°¢G'’°¢v—B&VÆV6T6†ÆÆVævR‡°¢6†ÆÆVævT–C¢&÷råö–BÀ¢7F÷$–C¢çVÆÂÀ¢æW‡E7FGW3¢tU…•$TBrÀ¢&V6öã¢tæWfW"66WFVB&Vf÷&RF†Rf–v‡Bv266÷&VBârÀ¢Ò“°¢fö–FVB³Ò°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6÷VÆBæ÷BW‡—&R6†ÆÆVævRrÂ7G&–ær‡&÷råö–B’ÂW'&÷"æÖW76vR“°¢Ð¢6öçF–çVS°¢Ð ¢G'’°¢v—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢òò6Æ–Ò&Vf÷&R––ærà¢6öç7B6Æ–ÖVBÒv—Bv—F„f–v‡E6W76–öâ€¢6†ÆÆVævRæf–æDöæTæEWFFR€¢²ö–C¢&÷råö–BÂ7FGW3¢t44UDTBrÒÀ¢²G6WC¢²7FGW3¢u4UEDÄTBrÂ6WGFÆVDC¢æWrFFR‚’ÒÒÀ¢²æWs¢G'VRÒÀ¢’À¢6W76–öâÀ¢“°¢–b‚6Æ–ÖVB’&WGW&ã° ¢6öç7B¶6†ÆÆVævW$6&BÂ÷öæVçD6&EÒÒv—B&öÖ—6RæÆÂ…°¢v—F„f–v‡E6W76–öâ…66÷&Ræf–æDöæR‡²Æ–W$–C¢7G&–ær‡&÷ræ6†ÆÆVævW$–B’ÂÖF6„–C¢7G&–ær†f–v‡D–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ’Â6W76–öâ’æÆVâ‚’À¢v—F„f–v‡E6W76–öâ…66÷&Ræf–æDöæR‡²Æ–W$–C¢7G&–ær‡&÷ræ÷öæVçD–B’ÂÖF6„–C¢7G&–ær†f–v‡D–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ’Â6W76–öâ’æÆVâ‚’À¢Ò“° ¢6öç7B6†ÆÆVævW%ö–çG2Ò6†ÆÆVævW$6&@¢ò6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2†6†ÆÆVævW$6&Bç&VF–7F–öç2ÂöæU7FG2ÂGvõ7FG2Â6FVv÷'’¢¢çVÆÃ°¢6öç7B÷öæVçEö–çG2Ò÷öæVçD6&@¢ò6Æ7VÆFT6Æ76–5&VF–7F–öåö–çG2†÷öæVçD6&Bç&VF–7F–öç2ÂöæU7FG2ÂGvõ7FG2Â6FVv÷'’¢¢çVÆÃ° ¢òò&VgVæFVB÷"Ö—76–ær6&B6ææ÷Bv–ââ–bæV—F†W"†2öæRÂ&÷F‚7F¶W0¢òòvò†öÖR(	BF†RÆFf÷&ÒFöW2æ÷B¶VWÖöæW’g&öÒ6öçFW7BF†BæWfW ¢òò&VÆÇ’†VæVBà¢6öç7B÷BÒ&÷rç7F¶R¢#°¢ÆWBv–ææW$–BÒçVÆÃ°¢ÆWBF–RÒfÇ6S° ¢–b†6†ÆÆVævW%ö–çG2ÓÓÒçVÆÂbb÷öæVçEö–çG2ÓÓÒçVÆÂ’°¢F–RÒG'VS°¢ÒVÇ6R–b†6†ÆÆVævW%ö–çG2ÓÓÒçVÆÂ’°¢v–ææW$–BÒ7G&–ær‡&÷ræ÷öæVçD–B“°¢ÒVÇ6R–b†÷öæVçEö–çG2ÓÓÒçVÆÂ’°¢v–ææW$–BÒ7G&–ær‡&÷ræ6†ÆÆVævW$–B“°¢ÒVÇ6R–b†6†ÆÆVævW%ö–çG2â÷öæVçEö–çG2’°¢v–ææW$–BÒ7G&–ær‡&÷ræ6†ÆÆVævW$–B“°¢ÒVÇ6R–b†÷öæVçEö–çG2â6†ÆÆVævW%ö–çG2’°¢v–ææW$–BÒ7G&–ær‡&÷ræ÷öæVçD–B“°¢ÒVÇ6R°¢F–RÒG'VS°¢Ð ¢òò&¶R—26†&vVBöâFV6–FVB&W7VÇBöæÇ’ÂæBfÆö÷&VB6ò&÷VæF–ær6à¢òòæWfW"’÷WBÖ÷&RF†âF†R÷B†öÆG2à¢6öç7B&¶RÒF–Rò¢ÖF‚æfÆö÷"‚‡÷B¢ƒ$…õ$´UõU$4TåB’ò“°¢6öç7BæWE–÷WBÒ÷BÒ&¶S° ¢–b‡F–R’°¢òò&WGW&âV6‚6–FRw2÷vâ7F¶R&F†W"F†â7Æ—GF–ær÷B(	B6ÖP¢òòÖ÷VçBÂ'WB—B&VG26÷'&V7FÇ’–âF†RÆVFvW"à¢f÷"†6öç7BÆ–W$–Böb·&÷ræ6†ÆÆVævW$–BÂ&÷ræ÷öæVçD–EÒ’°¢v—BÖ÷fT6†ÆÆVævU7F¶R‡°¢W6W$–C¢Æ–W$–BÀ¢FVÇF¢&÷rç7F¶RÀ¢&V6öã¢vƒ&…÷F–U÷&WGW&æVBrÀ¢&VfW&Væ6S¢ƒ&ƒ§F–S¢G·&÷råö–GÓ¢G·Æ–W$–GÖÀ¢6W76–öâÀ¢ÖWF¢²6†ÆÆVævT–C¢7G&–ær‡&÷råö–B’ÒÀ¢Ò“°¢Ð¢ÒVÇ6R°¢v—BÖ÷fT6†ÆÆVævU7F¶R‡°¢W6W$–C¢v–ææW$–BÀ¢FVÇF¢æWE–÷WBÀ¢&V6öã¢vƒ&…÷&—¦RrÀ¢&VfW&Væ6S¢ƒ&ƒ§v–ã¢G·&÷råö–GÖÀ¢6W76–öâÀ¢ÖWF¢²6†ÆÆVævT–C¢7G&–ær‡&÷råö–B’Â7F¶S¢&÷rç7F¶RÂ÷BÂ&¶RÂ&¶UW&6VçC¢ƒ$…õ$´UõU$4TåBÒÀ¢Ò“°¢Ð ¢v—Bv—F„f–v‡E6W76–öâ€¢6†ÆÆVævRæf–æD'”–DæEWFFR‡&÷råö–BÂ°¢G6WC¢°¢v–ææW$–BÀ¢F–RÀ¢–÷WC¢F–Rò&÷rç7F¶R¢æWE–÷WBÀ¢&¶RÀ¢6†ÆÆVævW%ö–çG2À¢÷öæVçEö–çG2À¢ÒÀ¢Ò’À¢6W76–öâÀ¢“° ¢6WGFÆVB³Ò° ¢6öç7B¶6†ÆÆVævW%W6W"Â÷öæVçEW6W%ÒÒv—B&öÖ—6RæÆÂ…°¢W6W"æf–æD'”–B‡&÷ræ6†ÆÆVævW$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRr’æÆVâ‚’À¢W6W"æf–æD'”–B‡&÷ræ÷öæVçD–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRr’æÆVâ‚’À¢Ò“°¢6öç7BÆ&VÂÒG¶f–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÖ°¢µ¶6†ÆÆVævW%W6W"Â6†ÆÆVævW%ö–çG2Â÷öæVçEö–çG5ÒÂ¶÷öæVçEW6W"Â÷öæVçEö–çG2Â6†ÆÆVævW%ö–çG5ÕÐ¢æf÷$V6‚‚…·W'6öâÂÖ–æRÂF†V—'5Ò’Óâ°¢–b‚W'6öãòæVÖ–Â’&WGW&ã°¢6öç7BvöâÒF–Rbb7G&–ær‡W'6öâåö–B’ÓÓÒv–ææW$–C°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢W'6öâæVÖ–ÂÀ¢7V&¦V7C¢F–Ròu–÷W"6†ÆÆVævRv2G&rr¢vöâòu–÷Rvöâ–÷W"6†ÆÆVævRr¢u–÷W"6†ÆÆVævR&W7VÇBrÀ¢†VF–æs¢F–RòtE$rr¢vöâòt4„ÄÄTätRtôâr¢t4„ÄÄTätRÄõ5BrÀ¢Æ–æW3¢°¢G¶Æ&VÇÒ†2&VVâ66÷&VBæÀ¢–÷W"6&C¢Ç7G&öæsâG¶Ö–æRóòÓÂ÷7G&öæsâ+rF†V—'3¢Ç7G&öæsâG·F†V—'2óòÓÂ÷7G&öæsæÀ¢F–P¢ò66÷&W2vW&RÆWfVÂÂ6ò–÷W"G·&÷rç7F¶RçFôÆö6ÆU7G&–ær‚—ÒdÒ7F¶R†2&VVâ&WGW&æVBæ ¢¢vöà¢òÇ7G&öæsâG¶æWE–÷WBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâFFVBFò–÷W"vÆÆWB(	BG·÷BçFôÆö6ÆU7G&–ær‚—ÒdÒ÷BÆW72F†RG´ƒ$…õ$´UõU$4TåGÒRÆFf÷&ÒfVRæ ¢¢–÷W"G·&÷rç7F¶RçFôÆö6ÆU7G&–ær‚—ÒdÒ7F¶RvöW2Fò–÷W"÷öæVçBæÀ¢ÒÀ¢Ò“°¢Ò“°¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6†ÆÆVævR6WGFÆVÖVçBf–ÆVBf÷"rÂ7G&–ær‡&÷råö–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â²6WGFÆVBÂfö–FVBÂF÷FÃ¢÷VâæÆVæwF‚Ó°§Ó° ¢òò7F—fFR&WW6&ÆR6†F÷rFV×ÆFR2æWrÆ—fR6öçFW7BâF†R6÷W&6P¢òòFV×ÆFR—2æWfW"ÖöF–f–VBÂ6ò—B&VÖ–ç2f–Æ&ÆRf÷"gWGW&RV–WBvVV·2à¦ç÷7B‚rö’öFÖ–â÷6†F÷ró§6†F÷t–Bö7F—fFRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6†F÷t–BÒ7G&–ær‡&Wç&×2ç6†F÷t–BÇÂrr’çG&–Ò‚“°¢6öç7B6†F÷rÒv—B6†F÷ræf–æD'”–B‡6†F÷t–B’æÆVâ‚“°¢–b‚6†F÷r’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6†F÷rf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7B°¢ö–BÂõ÷bÂ7&VFVDBÂWFFVDBÂ6÷W&6TÖF6„–BÂ6öçfW'FVDg&öÔÆ—fTBÀ¢ÖF6…6†F÷u7FGW2ÂÖF6…6†F÷t÷Vå7FGW2Â6†F÷t–FVçF—G”†–FFVâÀ¢6†F÷tWFõV&Æ—6†VBÂ6†F÷uV&Æ—6†VDBÂ6†F÷tW‡—&W4BÂ6†F÷tÆ7EW6VDBÀ¢6†F÷t÷&–v–æÄÖF6„FFRÂW6W%&VF–7F–öç2Â6öÆÆV7FVDfVW2Â&—¦W56WGFÆVDBÀ¢fö–FVDBÂfö–E&V6öâÂ6†÷'FfÆÅ&öÖ÷FW%v&æVDBÂ6†÷'FfÆÅÆ–W'5v&æVDBÀ¢ââçFV×ÆFP¢ÒÒ6†F÷s° ¢6öç7BçVÖ&W$÷%FV×ÆFRÒ†¶W’’Óâ&Wæ&öG“òå¶¶W•ÒÓÒVæFVf–æV@¢òÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG•¶¶W•Ò’ÇÂ’¢¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡6†F÷u¶¶W•Ò’ÇÂ’“°¢6öç7B&WVW7FVE7FGW2Ò7G&–ær‡&Wæ&öG“òæÖF6…7FGW2ÇÂtG&gBr“°¢6öç7BÖF6…7FGW2Ò²tG&gBrÂu66†VGVÆVBrÂt÷VâuÒæ–æ6ÇVFW2‡&WVW7FVE7FGW2’ò&WVW7FVE7FGW2¢tG&gBs° ¢6öç7BÆ—fTf–v‡BÒv—BÖF6‚æ7&VFR‡°¢ââçFV×ÆFRÀ¢6÷W&6U6†F÷t–C¢6†F÷råö–BÀ¢7F—fFVDg&öÕ6†F÷tC¢æWrFFR‚’À¢ÖF6…G—S¢tÄ•dRrÀ¢ÖF6…7FGW2À¢ÖF6„FFS¢&Wæ&öG“òæÖF6„FFRÇÂ6†F÷ræÖF6„FFRÇÂæWrFFR‚’À¢ÖF6…F–ÖS¢&Wæ&öG“òæÖF6…F–ÖRóò6†F÷ræÖF6…F–ÖRÀ¢ÖF6…Fö¶Vç3¢çVÖ&W$÷%FV×ÆFR‚vÖF6…Fö¶Vç2r’À¢÷C¢çVÖ&W$÷%FV×ÆFR‚w÷Br’À¢&öÖ÷FW%7F¶S¢çVÖ&W$÷%FV×ÆFR‚w&öÖ÷FW%7F¶Rr’À¢ÆFf÷&Ô6öçG&–'WF–öã¢çVÖ&W$÷%FV×ÆFR‚wÆFf÷&Ô6öçG&–'WF–öâr’À¢&ö¦V7FVDVçG&çG3¢çVÖ&W$÷%FV×ÆFR‚w&ö¦V7FVDVçG&çG2r’À¢Ö–æ–×VÔVçG&çG3¢çVÖ&W$÷%FV×ÆFR‚vÖ–æ–×VÔVçG&çG2r’À¢WFõ&VgVæD–e6†÷'C¢&Wæ&öG“òæWFõ&VgVæD–e6†÷'BÓÒfÇ6RÀ¢†öÖWvU&öÖ÷FVC¢&ööÆVâ‡&Wæ&öG“òæ†öÖWvU&öÖ÷FVB’À¢fVGW&VEF†—5vVV³¢&ööÆVâ‡&Wæ&öG“òæfVGW&VEF†—5vVV²’À¢fVGW&VDf–v‡C¢&ööÆVâ‡&Wæ&öG“òæfVGW&VDf–v‡B’À¢æ÷F–g“¢fÇ6RÀ¢FEFõ6†F÷s¢fÇ6RÀ¢W6W%&VF–7F–öç3¢µÒÀ¢6öÆÆV7FVDfVW3¢À¢&öf—E¦öæU&V6†VDC¢çVÆÂÀ¢Ò“° ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢ÖW76vS¢u6†F÷rFV×ÆFR7F—fFVB2æWrÆ—fR6öçFW7BârÀ¢6÷W&6U6†F÷t–C¢6†F÷t–BÀ¢f–v‡C¢Æ—fTf–v‡BçFôö&¦V7B‚’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6†F÷r7F—fF–öâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7F—fFRF†B6†F÷rf–v‡BârÒ“°¢Ð§Ò“° ¢òòÆWG2âFÖ–â6WB÷"v—fRF†R†÷W6R×&—6²wV&Bf÷"öæRf–v‡Bâv—f–ær—BÖVç0¢òòF†RÆFf÷&Ò6÷fW'2ç’6†÷'FfÆÂ—G6VÆbÂ6ò—B—2&V6÷&FVBW‡Æ–6—FÇ’&F†W ¢òòF†â&V–ærâ66–FVçBöb&Ææ²f–VÆBà¦7–æ2gVæ7F–öâ6VæDf–v‡EV&Æ—6†VDæ÷F–6W2†f–v‡B’°¢6öç7BÆ&VÂÒf–v‡DÆ&VÄöb†f–v‡B“°¢6öç7Bf–v‡EW&ÂÒG´ôõ$”t”çÒöf–v‡BòG¶f–v‡Båö–GÖ°¢6öç7B·Æ–W'2Âff–Æ–FW5ÒÒv—B&öÖ—6RæÆÂ…°¢W6W"æf–æB‡²—57V'67&–&VC¢²FæS¢fÇ6RÒÂ—4æ÷F–f–6F–öç4Væ&ÆVC¢²FæS¢fÇ6RÒÒ¢ç6VÆV7B‚vVÖ–Âf—'7DæÖRr’æÆ–Ö—Bƒ#’æÆVâ‚’À¢ff–Æ–FRæf–æB‡²fW&–f–VC¢G'VRÒ’ç6VÆV7B‚vVÖ–ÂgVÆÄæÖRÆVwVTæÖRr’æÆ–Ö—Bƒ’æÆVâ‚’À¢Ò“°¢6öç7BFVÆ—fW&–W2Ò°¢ââçÆ–W'2æf–ÇFW"‚‡&÷r’Óâ&÷ræVÖ–Â’æÖ‚‡Æ–W"’Óâ6VæDÖöæW”æ÷F–6R‡°¢Fó¢Æ–W"æVÖ–ÂÀ¢7V&¦V7C¢æWrf–v‡B6&C¢G¶Æ&VÇÖÀ¢†VF–æs¢täUrd”t…B4$B•2õTârÀ¢Æ–æW3¢°¢G·Æ–W"æf—'7DæÖRòG·Æ–W"æf—'7DæÖWÒÂ¢rwÓÇ7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâ—2&VG’f÷"&VF–7F–öç2æÀ¢Æ‡&VcÒ"G¶f–v‡EW&ÇÒ"7G–ÆSÒ&6öÆ÷#¢6c&#SCC²#ä÷VâF†Rf–v‡B6&CÂöæÀ¢ÒÀ¢fö÷FW#¢VW7F–öç3òGµ5Uõ%EôTÔ”ÇÖÀ¢Ò’’À¢ââæff–Æ–FW2æf–ÇFW"‚‡&÷r’Óâ&÷ræVÖ–Â’æÖ‚†ff–Æ–FR’Óâ6VæDÖöæW”æ÷F–6R‡°¢Fó¢ff–Æ–FRæVÖ–ÂÀ¢7V&¦V7C¢æWr6&Bf–Æ&ÆRFò&öÖ÷FS¢G¶Æ&VÇÖÀ¢†VF–æs¢täUrdd”Ä”DRd”t…Bõõ%ETä•E’rÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâ—2æ÷rf–Æ&ÆR–âF†Rf–v‡B7—7FVÒæÀ¢Æ‡&VcÒ"G´ôõ$”t”çÒôff–Æ–FTF6†&ö&B"7G–ÆSÒ&6öÆ÷#¢6c&#SCC²#ä÷Vâff–Æ–FR6öÖÖæCÂöæÀ¢ÒÀ¢fö÷FW#¢ff–Æ–FR7W÷'C¢Gµ5Uõ%EôTÔ”ÇÖÀ¢Ò’’À¢Ó°¢6öç7B&W7VÇG2Òv—B&öÖ—6RæÆÅ6WGFÆVB†FVÆ—fW&–W2“°¢&WGW&â°¢GFV×FVC¢FVÆ—fW&–W2æÆVæwF‚À¢FVÆ—fW&VC¢&W7VÇG2æf–ÇFW"‚‡&÷r’Óâ&÷rç7FGW2ÓÓÒvgVÆf–ÆÆVBr’æÆVæwF‚À¢f–ÆVC¢&W7VÇG2æf–ÇFW"‚‡&÷r’Óâ&÷rç7FGW2ÓÓÒw&V¦V7FVBr’æÆVæwF‚À¢Ó°§Ð ¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷&—¦RÖwV&BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7BWFFRÒ·Ó°¢–b‡&Wæ&öG“òæÖ–æ–×VÔVçG&çG2ÓÒVæFVf–æVB’°¢6öç7BfÇVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG’æÖ–æ–×VÔVçG&çG2’ÇÂ’“°¢WFFRæÖ–æ–×VÔVçG&çG2ÒfÇVS°¢Ð¢–b‡&Wæ&öG“òæWFõ&VgVæD–e6†÷'BÓÒVæFVf–æVB’°¢WFFRæWFõ&VgVæD–e6†÷'BÒ²wG'VRrÂsrÂw–W2rÂG'VUÒæ–æ6ÇVFW2‡&Wæ&öG’æWFõ&VgVæD–e6†÷'B“°¢Ð¢–b‡&Wæ&öG“òæÖF6…Fö¶Vç2ÓÒVæFVf–æVB’°¢WFFRæÖF6…Fö¶Vç2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG’æÖF6…Fö¶Vç2’ÇÂ’“°¢Ð¢–b‡&Wæ&öG“òç÷BÓÒVæFVf–æVB’°¢WFFRç÷BÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG’ç÷B’ÇÂ’“°¢Ð¢²w&öÖ÷FW%7F¶RrÂwÆFf÷&Ô6öçG&–'WF–öârÂw&ö¦V7FVDVçG&çG2uÒæf÷$V6‚‚†¶W’’Óâ°¢–b‡&Wæ&öG“òå¶¶W•ÒÓÒVæFVf–æVB’WFFU¶¶W•ÒÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG•¶¶W•Ò’ÇÂ’“°¢Ò“°¢–b‡&Wæ&öG“òæÖ…&÷VæG2ÓÒVæFVf–æVB’°¢WFFRæÖ…&÷VæG2ÒÖF‚æÖ‚ƒÂÖF‚æÖ–âƒ3ÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG’æÖ…&÷VæG2’ÇÂ"’’“°¢Ð¢–b‡&Wæ&öG“òæÖF6„FFRÓÒVæFVf–æVBbb&Wæ&öG’æÖF6„FFR’°¢WFFRæÖF6„FFRÒ&Wæ&öG’æÖF6„FFS°¢Ð¢–b‡&Wæ&öG“òæÖF6…F–ÖRÓÒVæFVf–æVB’°¢WFFRæÖF6…F–ÖRÒ&Wæ&öG’æÖF6…F–ÖS°¢Ð¢²væ÷F–g’rÂvFEFõ6†F÷rrÂv†öÖWvU&öÖ÷FVBrÂvfVGW&VEF†—5vVV²rÂvfVGW&VDf–v‡BuÒæf÷$V6‚‚†¶W’’Óâ°¢–b‡&Wæ&öG“òå¶¶W•ÒÓÒVæFVf–æVB’WFFU¶¶W•ÒÒ²wG'VRrÂsrÂw–W2rÂG'VUÒæ–æ6ÇVFW2‡&Wæ&öG•¶¶W•Ò“°¢Ò“°¢–b‡&Wæ&öG“òæÖF6…7FGW2ÓÒVæFVf–æVB’°¢6öç7BÆÆ÷vVE7FGW6W2Ò²tG&gBrÂu66†VGVÆVBrÂt÷VârÂtÆ—fRrÂt6Æ÷6VBrÂtf–æ—6†VBuÓ°¢–b‚ÆÆ÷vVE7FGW6W2æ–æ6ÇVFW2‡&Wæ&öG’æÖF6…7FGW2’’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t–çfÆ–BV&Æ—6†–ær7FGW2ârÒ“°¢WFFRæÖF6…7FGW2Ò&Wæ&öG’æÖF6…7FGW3°¢Ð¢–b‚ö&¦V7Bæ¶W—2‡WFFR’æÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæ÷F†–ærFò6†ævRârÒ“°¢Ð ¢6öç7B·&Wf–÷W4ÖF6‚Â&Wf–÷W56†F÷uÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æf–æD'”–B†f–v‡D–B’ç6VÆV7B‚væ÷F–g’r’æÆVâ‚’À¢6†F÷ræf–æD'”–B†f–v‡D–B’ç6VÆV7B‚væ÷F–g’r’æÆVâ‚’À¢Ò“°¢6öç7B¶ÖF6…&W7VÇBÂ6†F÷u&W7VÇEÒÒv—B&öÖ—6RæÆÂ…°¢ÖF6‚æf–æDöæTæEWFFR‡²ö–C¢f–v‡D–BÒÂ²G6WC¢WFFRÒÂ²æWs¢G'VRÒ¢ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"÷BÖF6…Fö¶Vç2&öÖ÷FW%7F¶RÆFf÷&Ô6öçG&–'WF–öâ&ö¦V7FVDVçG&çG2Ö–æ–×VÔVçG&çG2WFõ&VgVæD–e6†÷'BÖ…&÷VæG2ÖF6„FFRÖF6…F–ÖRÖF6…7FGW2æ÷F–g’FEFõ6†F÷r†öÖWvU&öÖ÷FVBfVGW&VEF†—5vVV²fVGW&VDf–v‡Br’æÆVâ‚’À¢6†F÷ræf–æDöæTæEWFFR‡²ö–C¢f–v‡D–BÒÂ²G6WC¢WFFRÒÂ²æWs¢G'VRÒ¢ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"÷BÖF6…Fö¶Vç2&öÖ÷FW%7F¶RÆFf÷&Ô6öçG&–'WF–öâ&ö¦V7FVDVçG&çG2Ö–æ–×VÔVçG&çG2WFõ&VgVæD–e6†÷'BÖ…&÷VæG2ÖF6„FFRÖF6…F–ÖRÖF6…7FGW2æ÷F–g’FEFõ6†F÷r†öÖWvU&öÖ÷FVBfVGW&VEF†—5vVV²fVGW&VDf–v‡Br’æÆVâ‚’À¢Ò“°¢6öç7Bf–v‡BÒÖF6…&W7VÇBÇÂ6†F÷u&W7VÇC°¢–b‚f–v‡B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“°¢6öç7B&Wf–÷W6Ç”æ÷F–f–VBÒ&ööÆVâ‚‡&Wf–÷W4ÖF6‚ÇÂ&Wf–÷W56†F÷r“òææ÷F–g’“°¢6öç7Bæ÷F–f–6F–öäFVÆ—fW'’ÒWFFRææ÷F–g’ÓÓÒG'VRbb&Wf–÷W6Ç”æ÷F–f–V@¢òv—B6VæDf–v‡EV&Æ—6†VDæ÷F–6W2†f–v‡B¢¢çVÆÃ° ¢6öç7BVçG'”fVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’“°¢6öç7BFV6Æ&VE÷BÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç÷B’ÇÂ’“°¢6öç7B6öÖÖ—GFVDgVæF–ærÒÖF‚æÖ–â†FV6Æ&VE÷BÂÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç&öÖ÷FW%7F¶R’ÇÂ’²ÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡BçÆFf÷&Ô6öçG&–'WF–öâ’ÇÂ’“°¢6öç7B'&V´WfVâÒVçG'”fVRâòÖF‚æ6V–Â„ÖF‚æÖ‚ƒÂFV6Æ&VE÷BÒ6öÖÖ—GFVDgVæF–ær’òVçG'”fVR’¢°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢f–v‡D–BÀ¢ÖF6…Fö¶Vç3¢f–v‡BæÖF6…Fö¶Vç2À¢÷C¢f–v‡Bç÷BÀ¢&öÖ÷FW%7F¶S¢f–v‡Bç&öÖ÷FW%7F¶RÇÂÀ¢ÆFf÷&Ô6öçG&–'WF–öã¢f–v‡BçÆFf÷&Ô6öçG&–'WF–öâÇÂÀ¢&ö¦V7FVDVçG&çG3¢f–v‡Bç&ö¦V7FVDVçG&çG2ÇÂÀ¢Ö…&÷VæG3¢f–v‡BæÖ…&÷VæG2À¢ÖF6„FFS¢f–v‡BæÖF6„FFRÀ¢ÖF6…F–ÖS¢f–v‡BæÖF6…F–ÖRÀ¢ÖF6…7FGW3¢f–v‡BæÖF6…7FGW2À¢æ÷F–g“¢f–v‡Bææ÷F–g’À¢FEFõ6†F÷s¢f–v‡BæFEFõ6†F÷rÀ¢†öÖWvU&öÖ÷FVC¢f–v‡Bæ†öÖWvU&öÖ÷FVBÀ¢fVGW&VEF†—5vVV³¢f–v‡BæfVGW&VEF†—5vVV²À¢fVGW&VDf–v‡C¢f–v‡BæfVGW&VDf–v‡BÀ¢Ö–æ–×VÔVçG&çG3¢f–v‡BæÖ–æ–×VÔVçG&çG2ÇÂ'&V´WfVâÀ¢'&V´WfVäVçG&çG3¢'&V´WfVâÀ¢WFõ&VgVæD–e6†÷'C¢f–v‡BæWFõ&VgVæD–e6†÷'BÓÒfÇ6RÀ¢æ÷F–f–6F–öäFVÆ—fW'’À¢v&æ–æs¢f–v‡BæWFõ&VgVæD–e6†÷'BÓÓÒfÇ6P¢òtWFò×&VgVæB—2ôdbf÷"F†—2f–v‡Bâç’6†÷'FfÆÂ&WGvVVâVçG&–W2æBF†RFV6Æ&VB&—¦R—2–B'’F†RÆFf÷&Òâp¢¢VæFVf–æVBÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&—¦RwV&BWFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BWFFRF†R&—¦RwV&BârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷6WGFÆRÖ6†ÆÆVævW2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆTf–v‡D6†ÆÆVævW2…7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6†ÆÆVævR6WGFÆR7vVWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6WGFÆR6†ÆÆVævW2f÷"F†Bf–v‡BârÒ“°¢Ð§Ò“° ¢òòW‡—'’7vVWâ'Vç2g&öÒF†R66†VGVÆW"6òâVæç7vW&VB6†ÆÆVævRFöW2æ÷B6—@¢òòöâÆ–W"w26ö–ç2–æFVf–æ—FVÇ’à¦ævWB‚rö’ö7&öâö6†ÆÆVævW2öW‡—&RrÂfW&–g”7&öå6V7&WBÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BGVRÒv—B6†ÆÆVævRæf–æB‡²7FGW3¢uTäD”ärrÂW‡—&W4C¢²FÇFS¢æWrFFR‚’ÒÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢ÆWB&VÆV6VBÒ°¢f÷"†6öç7B&÷röbGVR’°¢G'’°¢6öç7B&W7VÇBÒv—B&VÆV6T6†ÆÆVævR‡°¢6†ÆÆVævT–C¢&÷råö–BÀ¢7F÷$–C¢çVÆÂÀ¢æW‡E7FGW3¢tU…•$TBrÀ¢&V6öã¢tæ÷B66WFVB&Vf÷&R—BW‡—&VBârÀ¢Ò“°¢–b‚&W7VÇBæÇ&VG•&W6öÇfVB’&VÆV6VB³Ò°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6÷VÆBæ÷BW‡—&R6†ÆÆVævRrÂ7G&–ær‡&÷råö–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂW†Ö–æVC¢GVRæÆVæwF‚Â&VÆV6VBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t6†ÆÆVævRW‡—'’7vVWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tW‡—'’7vVWf–ÆVBârÒ“°¢Ð§Ò“° ¢òò&VF–æW72&ö&Râç7vW'2F†RöæRVW7F–öâF†BFV6–FW2v†WF†W"ÖöæW’F‡0¢òòv÷&²BÆÂÂv—F†÷WBæVVF–ær6†VÆÂ66W72FòF†RFF&6Rà¦ævWB‚rö’ö†VÇF‚öF"rÂ7–æ2…÷&WÂ&W2’Óâ°¢v—BVç7W&TFF&6T6&–Æ—G’‚“°¢6öç7B&VG’ÒFF&6T6&–Æ—G’çG&ç67F–öç57W÷'FVC°¢&WGW&â&W2ç7FGW2‡&VG’ò#¢S2’æ§6öâ‡°¢ö³¢&VG’À¢6öææV7FVC¢Ööævö÷6Ræ6öææV7F–öâç&VG•7FFRÓÓÒÀ¢F÷öÆöw“¢FF&6T6&–Æ—G’çF÷öÆöw’À¢G&ç67F–öç57W÷'FVC¢FF&6T6&–Æ—G’çG&ç67F–öç57W÷'FVBÀ¢ÖW76vS¢&VG¢òtFF&6R7W÷'G2G&ç67F–öç2âÖöæW’F‡2&R6fRFòW6Râp¢¢tFF&6RFöW2äõB7W÷'BG&ç67F–öç2â–BVçG&–W2Â&VgVæG2æB6WGFÆVÖVçBv–ÆÂf–ÂâÖ¶RÖöævôD"&WÆ–66WBârÀ¢Ò“°§Ò“° ¢òòÆWG2F†RFV6–FR&WGvVVâF†RÆ—fRfVGW&RæBF†Rv—FÆ—7B6&Bv—F†÷W@¢òò6†—–ær6V6öæB'V–ÆBà¦ævWB‚rö’÷V&Æ–2öfVGW&W2rÂ…÷&WÂ&W2’Óâ°¢&W2æ§6öâ‡°¢ö³¢G'VRÀ¢fVGW&W3¢°¢†VEFô†VC¢°¢Væ&ÆVC¢„TEõDõô„TEôTä$ÄTBÀ¢Ö–å7F¶S¢ƒ$…ôÔ”åõ5D´RÀ¢Ö…7F¶S¢ƒ$…ôÔ…õ5D´RÀ¢&¶UW&6VçC¢ƒ$…õ$´UõU$4TåBÀ¢ÒÀ¢FVÔ6&G3¢°¢Væ&ÆVC¢DTÕô4$E5ôTä$ÄTBÀ¢–6·5&WV—&VC¢DTÕõ”4µ5õ$UT•$TBÀ¢6ÆÄ&öçW46¢DTÕô4ÄÅô$ôåU5ô4À¢ÒÀ¢6V6öä6&G3¢°¢Væ&ÆVC¢4T4ôåô4$E5ôTä$ÄTBÀ¢6Æ÷G3¢4T4ôåõ4ÄõE2À¢6Æ÷DÖƒ¢4T4ôåõ4ÄõEôÔ‚À¢6ÆÄ&öçW46¢4T4ôåô4ÄÅô$ôåU5ô4À¢ÒÀ¢ÒÀ¢Ò“°§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òò4T4ôâ4$E2(	BF†R×VÇF’×7÷'BÆöærvÖP¢òð¢òòÆ–W"G&gG2ôäRf–v‡FW"W"7÷'Bâ÷fW"F†R6V6öâF†÷6Rf—fRf–v‡FW'0¢òò6ö×WFRöâF†V—"÷vâ66†VGVÆW2ÂæBv†FWfW"V6‚öæR7GVÆÇ’FöW2–âF†P¢òò6vR÷"&–ær—27&VF—FVBFòv†öWfW"G&gFVBF†VÒâ—B—2fçF7’&÷7FW"Âæ÷@¢òò&VF–7F–öâ6öçFW7B(	B'WB—B¶VW2F†RÆFf÷&Òw2Dä–âGvòv—3 ¢òð¢òòâ÷WGWB—266÷&VBv—F‚F†R4ÔR6FVv÷&–W2F†R66÷&V6&G2W6Râ&÷†W ¢òòV&ç2g&öÒ†VBVæ6†W2Â&öG’Væ6†W2ÂF÷FÂVæ6†W2Â&÷VæBv–ç2æ@¢òò¶æö6¶F÷vç3²âÔÔf–v‡FW"g&öÒ7G&–¶W2Â¶–6·2Â¶æVW2ÂVÆ&÷w2âæ÷F†–æp¢òòæWr—2–çfVçFVBÂ6ò6V6öâ6&B66÷&RÖVç2F†R6ÖRF†–ærf–v‡@¢òò66÷&RÖVç2à¢òð¢òò"âV6‚–6²6'&–W24ÄÄTBåTÔ$U"âF†RÆ–W"æÖW26FVv÷'’æB¢òòf–wW&RF†V—"f–v‡FW"v–ÆÂ&V6‚7&÷72F†R6V6öââ—B66÷&W2'’W†7FÇ¢òòF†RÆFf÷&Òw2W†—7F–ær'VÆR(	B–b–÷R6ÆÆVBB÷"VæFW"v†BF†Rf–v‡FW ¢òò7GVÆÇ’F–BÂ–÷R66÷&Rv†B–÷R6ÆÆVBâ6ÆÂÆ÷ræB—B—26fR'W@¢òò6ÖÆÃ²6ÆÂ†–v‚æB–÷R&—6²F†Rv†öÆR&öçW2â6ÖRG&FRÖöfb2¢òò66÷&V6&BÂ7G&WF6†VB÷fW"F‡&VRÖöçF‡2à¢òð¢òò5$õ52Õ5õ%Bd•$äU52âGvVÇfR×&÷VæB&÷†–ærÖF6‚vVæW&FW26WfW&ÂF–ÖW2F†P¢òò6÷VçF&ÆR÷WGWBöbF‡&VR×&÷VæBÔÔf–v‡BÂ6ò&rF÷FÇ2v÷VÆBÖ¶RF†P¢òò&÷†–ær6Æ÷BFV6–FRWfW'’6V6öââV6‚6Æ÷B—2F†W&Vf÷&R66÷&VB÷WBöb ¢òòt•D„”â•E2õtâ5õ%B(	BÖV7W&VBv–ç7BF†R&W7BW&f÷&Öæ6Rç’VçG&çBv÷@¢òòg&öÒF†B6Æ÷B(	BæBF†Rf—fR6Æ÷G27VÒFò66÷&R÷WBöbSâF†R&rçVÖ&W ¢òò—2¶WBæB6†÷vâÆöæw6–FR—C²F†Ræ÷&ÖÆ—6F–öâ—2F†R6öçfW'6–öâÂæ÷B¢òò&WÆ6VÖVçBf÷"F†RÆFf÷&Òw266÷&–ærà¢òð¢òò4„•TBôdbâ4T4ôåô4$E5ôTä$ÄTB×W7B&RwG'VRrFòW‡÷6Rç’öb—Bà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòÄ•dR%’DTdTÅBâ6WB4T4ôåô4$E5ôTä$ÄTCÖfÇ6RFòVÆÂ—Bà¦6öç7B4T4ôåô4$E5ôTä$ÄTBÒ²wG'VRrÂsrÂw–W2rÂvöâuÐ¢æ–æ6ÇVFW2…7G&–ær‡&ö6W72æVçbå4T4ôåô4$E5ôTä$ÄTBÇÂwG'VRr’çG&–Ò‚’çFôÆ÷vW$66R‚’“° ¢òòf—fR6Æ÷G2Â'WBöæÇ’F‡&VR66÷&–ærfÖ–Æ–W3¢F†RÆFf÷&Ò66÷&W2&÷†–æræ@¢òò&&R¶çV6¶ÆR–FVçF–6ÆÇ’ÂæBÔÔæB¶–6¶&÷†–ær–FVçF–6ÆÇ’à¦6öç7B4T4ôåõ4ÄõE2Òö&¦V7Bæg&VW¦R…°¢²¶W“¢v&÷†–ærrÂÆ&VÃ¢t&÷†–ærrÂfÖ–Ç“¢v&÷†–ærrÒÀ¢²¶W“¢v&&V¶çV6¶ÆRrÂÆ&VÃ¢t&&R¶çV6¶ÆRrÂfÖ–Ç“¢v&÷†–ærrÒÀ¢²¶W“¢vÖÖrÂÆ&VÃ¢tÔÔrÂfÖ–Ç“¢vÖÖrÒÀ¢²¶W“¢v¶–6¶&÷†–ærrÂÆ&VÃ¢t¶–6¶&÷†–ærrÂfÖ–Ç“¢vÖÖrÒÀ¢²¶W“¢ww&W7FÆ–ærrÂÆ&VÃ¢u&òw&W7FÆ–ærrÂfÖ–Ç“¢ww&W7FÆ–ærrÒÀ¥Ò“°¦6öç7B4T4ôåõ4ÄõEô´U•2Òö&¦V7Bæg&VW¦R…4T4ôåõ4ÄõE2æÖ‚‡6Æ÷B’Óâ6Æ÷Bæ¶W’’“°¦6öç7B4ÄõEô%•ô´U’ÒæWrÖ…4T4ôåõ4ÄõE2æÖ‚‡6Æ÷B’Óâ·6Æ÷Bæ¶W’Â6Æ÷EÒ’“° ¢òò6FVv÷&–W26ÆÆVBçVÖ&W"Ö’&RÆ6VBöâÂW"fÖ–Ç’âF†W6R&RF†R6ÖP¢òòf–VÆG2F†R66÷&V6&G2&VBÂ6ò6ÆÆVBçVÖ&W"—26†V6¶&ÆRv–ç7BF†RfW'¢òò7FG2âFÖ–âÇ&VG’VçFW'2à¦6öç7B4T4ôåô4ÄÅô4DTtõ$”U2Òö&¦V7Bæg&VW¦R‡°¢&÷†–æs¢ö&¦V7Bæg&VW¦R‡²…¢t†VBVæ6†W2rÂ%¢t&öG’Væ6†W2rÂE¢uF÷FÂVæ6†W2rÂ%s¢u&÷VæG2vöârÂ´ó¢t¶æö6¶F÷vç2rÒ’À¢ÖÖ¢ö&¦V7Bæg&VW¦R‡²5C¢u7G&–¶W2rÂ´“¢t¶–6·2rÂ´ã¢t¶æVW2rÂTÃ¢tVÆ&÷w2rÂ%s¢u&÷VæG2vöârÂ´ó¢t¶æö6¶F÷vç2rÒ’À¢w&W7FÆ–æs¢ö&¦V7Bæg&VW¦R‡²4”s¢u6–væGW&RÖ÷fW2rÂäc¢tæV"fÆÇ2rÂ%c¢u&WfW'6Ç2rÂ”ã¢u–æfÆÇ2rÒ’À§Ò“° ¢òò6ÆÆVBçVÖ&W"6ææ÷B÷WB×vV–v‚F†Rf–v‡FW"w27GVÂ÷WGWBà¦6öç7B4T4ôåô4ÄÅô$ôåU5ô4ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbå4T4ôåô4ÄÅô$ôåU5ô4óò’“°¦6öç7B4T4ôåõ4ÄõEôÔ‚Ò° ¦6öç7B6V6öå66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢FW67&—F–öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7F'G4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ¢VæG4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ¢òò¦W&òÖVç2g&VR6V6öâ(	B'Vç2–âWfW'’7FFRÂv&G2æöâÖ66‚&—¦W2öæÇ’à¢VçG'”fVS¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÂÖ–ã¢ÒÀ¢&WV—&VE6Æ÷G3¢²G—S¢µ7G&–æuÒÂFVfVÇC¢‚’Óâ²ââå4T4ôåõ4ÄõEô´U•5ÒÒÀ¢7FGW3¢²G—S¢7G&–ærÂVçVÓ¢²tE$eEôõTârÂu%Tää”ärrÂu4UEDÄTBrÂudô”BuÒÂFVfVÇC¢tE$eEôõTârÂ–æFWƒ¢G'VRÒÀ¢òòG&gF–ær6Æ÷6W2†W&S²gFW"—BÂ&÷7FW'2&RÆö6¶VBf÷"F†R6V6öâà¢G&gD6Æ÷6W4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ¢&—¦UööÃ¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6WGFÆVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢fö–E&V6öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B6V6öå&÷7FW%66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢6V6öä–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢W6W$–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢–6·3¢°¢G—S¢¶æWrÖöævö÷6Rå66†VÖ‡°¢6Æ÷C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢f–v‡FW$æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢òòÆ÷vW"Ö66VBf÷"ÖF6†–ærÂ&V6W6Rf–v‡G26''’f–v‡FW"äÔU2æ÷B–G2à¢ÖF6„¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢6ÆÆVD6FVv÷'“¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢6ÆÆVEfÇVS¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢òò67V×VÆFVB2F†R6V6öâ'Vç2à¢&uö–çG3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6FVv÷'•F÷FÇ3¢²G—S¢ö&¦V7BÂFVfVÇC¢‚’Óâ‡·Ò’ÒÀ¢WfVçG46÷VçFVC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢òòf–ÆÆVBB6WGFÆVÖVçBà¢æ÷&ÖÆ—¦VC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6ÆÄ&öçW3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6ÆÄ†—C¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢ÒÂ²ö–C¢fÇ6RÒ•ÒÀ¢FVfVÇC¢µÒÀ¢ÒÀ¢VçG'”fVU–C¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢F÷FÅ66÷&S¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6WGFÆVC¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢òòwV&G2&R×'Vâöb6WGFÆVÖVçBæBF÷V&ÆRVçG'’6†&vRà¢–FV×÷FVæ7”¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¢òòöæR&÷7FW"W"Æ–W"W"6V6öâà§6V6öå&÷7FW%66†VÖæ–æFW‚‡²6V6öä–C¢ÂW6W$–C¢ÒÂ²Væ—VS¢G'VRÒ“°¢òò7&VF—BÆöö·W2vÆ²F†—3¢'v†–6‚&÷7FW'2†öÆBF†—2f–v‡FW"–âF†—26Æ÷Cò §6V6öå&÷7FW%66†VÖæ–æFW‚‡²6V6öä–C¢Âw–6·2æÖF6„¶W’s¢Ò“° ¦6öç7B6V6öâÒÖöævö÷6RæÖöFVÇ2å6V6öâÇÂÖöævö÷6RæÖöFVÂ‚u6V6öârÂ6V6öå66†VÖ“°¦6öç7B6V6öå&÷7FW"ÒÖöævö÷6RæÖöFVÇ2å6V6öå&÷7FW"ÇÂÖöævö÷6RæÖöFVÂ‚u6V6öå&÷7FW"rÂ6V6öå&÷7FW%66†VÖ“° ¦6öç7B6V6öäW'&÷"Ò‡7FGW2ÂÖW76vRÂ6öFRÂW‡G&Ò·Ò’Óâ°¢6öç7BW'&÷"ÒæWrW'&÷"†ÖW76vR“°¢W'&÷"ç7FGW2Ò7FGW3°¢W'&÷"æ6öFRÒ6öFS°¢W'&÷"æW‡G&ÒW‡G&°¢&WGW&âW'&÷#°§Ó° ¦6öç7B&WV—&U6V6öä6&G2Ò‡&WÂ&W2ÂæW‡B’Óâ°¢–b‚4T4ôåô4$E5ôTä$ÄTB’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢u6V6öâ6&G2&Ræ÷B÷Vâ–WBârÀ¢6öFS¢tdTEU$UôD•4$ÄTBrÀ¢Ò“°¢Ð¢&WGW&âæW‡B‚“°§Ó° ¢òòf–v‡FW"æÖW2&RF†RöæÇ’–FVçF–f–W"f–v‡B6'&–W2Â6òÖF6†–ær—2FöæRöà¢òòæ÷&ÖÆ—6VB¶W’&F†W"F†âF†R&r7G&–ærà¦6öç7Bf–v‡FW$ÖF6„¶W’Ò†æÖR’Óâ7G&–ær†æÖRÇÂrr¢çFôÆ÷vW$66R‚’ç&WÆ6R‚õµæ×£Ó•Ò²örÂrr’çG&–Ò‚“° ¦6öç7B6V6öäfÖ–Ç”f÷$6FVv÷'’Ò†ÖF6„6FVv÷'’’Óâ°¢6öç7B6FVv÷'’Ò7G&–ær†ÖF6„6FVv÷'’ÇÂrr’çFôÆ÷vW$66R‚“°¢–b†6FVv÷'’æ–æ6ÇVFW2‚v&÷‚r’ÇÂ6FVv÷'’æ–æ6ÇVFW2‚v¶çV6¶ÆRr’’&WGW&âv&÷†–ærs°¢–b†6FVv÷'’æ–æ6ÇVFW2‚ww&W7FÂr’’&WGW&âww&W7FÆ–ærs°¢&WGW&âvÖÖs°§Ó° ¢òò6öçfW'G2v†Bf–v‡FW"5ETÄÅ’F–B–çFòö–çG2æBW"Ö6FVv÷'’F÷FÇ2À¢òòW6–ærF†R6ÖRf–VÆG2F†R66÷&V6&G266÷&Rv–ç7Bà¦6öç7Bf–v‡FW$÷WGWDg&öÕ&÷VæG2Ò‡&÷VæG2ÂfÖ–Ç’’Óâ°¢6öç7BF÷FÇ2Ò·Ó°¢ÆWBö–çG2Ò°¢–b‚'&’æ—4'&’‡&÷VæG2’’&WGW&â²ö–çG2ÂF÷FÇ2Ó° ¢6öç7Bf–VÆG2ÒfÖ–Ç’ÓÓÒv&÷†–ærp¢ò²t…rÂt%rÂuErÂu%rrÂt´òuÐ¢¢fÖ–Ç’ÓÓÒww&W7FÆ–ærp¢ò²u4”rrÂtäbrÂu%brÂu”âuÐ¢¢²u5BrÂt´’rÂt´ârÂtTÂrÂu%rrÂt´òuÓ°¢òòFV6—6—fRWfVçG2&R&&RÂ6òF†W’6''’vV–v‡B&F†W"F†â&r6÷VçBà¢6öç7BvV–v‡G2Ò²%s¢Â´ó¢#RÂ”ã¢#RÂäc¢RÓ° ¢&÷VæG2æf÷$V6‚‚‡&÷VæB’Óâ°¢–b‚&÷VæB’&WGW&ã°¢f–VÆG2æf÷$V6‚‚†f–VÆB’Óâ°¢6öç7BfÇVRÒçVÖ&W"‡&÷VæE¶f–VÆEÒ“°¢–b‚çVÖ&W"æ—4f–æ—FR‡fÇVR’ÇÂfÇVRÃÒ’&WGW&ã°¢F÷FÇ5¶f–VÆEÒÒ‡F÷FÇ5¶f–VÆEÒÇÂ’²fÇVS°¢ö–çG2³ÒfÇVR¢‡vV–v‡G5¶f–VÆEÒÇÂ“°¢Ò“°¢Ò“°¢&WGW&â²ö–çG2ÂF÷FÇ2Ó°§Ó° ¢òò6ÆÆVBBf–v‡B6WGFÆVÖVçBâ7&VF—G2WfW'’&÷7FW"F†BG&gFVBV—F†W"f–v‡FW"à¦6öç7B7&VF—E6V6öå&÷7FW'2Ò7–æ2†f–v‡BÂöæU7FG2ÂGvõ7FG2’Óâ°¢–b‚4T4ôåô4$E5ôTä$ÄTB’&WGW&â²7&VF—FVC¢Ó°¢6öç7Bv†VâÒf–v‡CòæÖF6„FFRòæWrFFR†f–v‡BæÖF6„FFR’¢æWrFFR‚“°¢6öç7B6V6öç2Òv—B6V6öâæf–æB‡°¢7FGW3¢u%Tää”ärrÀ¢7F'G4C¢²FÇFS¢v†VâÒÀ¢VæG4C¢²FwFS¢v†VâÒÀ¢Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b‚6V6öç2æÆVæwF‚’&WGW&â²7&VF—FVC¢Ó° ¢6öç7BfÖ–Ç’Ò6V6öäfÖ–Ç”f÷$6FVv÷'’†f–v‡CòæÖF6„6FVv÷'’“°¢6öç7B6–FW2Ò°¢²æÖS¢f–v‡CòæÖF6„f–v‡FW$Â&÷VæG3¢öæU7FG2ÒÀ¢²æÖS¢f–v‡CòæÖF6„f–v‡FW$"Â&÷VæG3¢Gvõ7FG2ÒÀ¢Ó°¢ÆWB7&VF—FVBÒ° ¢f÷"†6öç7B6V6öâöb6V6öç2’°¢f÷"†6öç7B6–FRöb6–FW2’°¢6öç7B¶W’Òf–v‡FW$ÖF6„¶W’‡6–FRææÖR“°¢–b‚¶W’’6öçF–çVS°¢6öç7B²ö–çG2ÂF÷FÇ2ÒÒf–v‡FW$÷WGWDg&öÕ&÷VæG2‡6–FRç&÷VæG2ÂfÖ–Ç’“°¢–b‡ö–çG2ÃÒ’6öçF–çVS° ¢6öç7B&÷7FW'2Òv—B6V6öå&÷7FW"æf–æB‡°¢6V6öä–C¢7G&–ær‡6V6öâåö–B’À¢6WGFÆVC¢fÇ6RÀ¢w–6·2æÖF6„¶W’s¢¶W’À¢Ò“° ¢f÷"†6öç7B&÷7FW"öb&÷7FW'2’°¢ÆWBF÷V6†VBÒfÇ6S°¢&÷7FW"ç–6·2æf÷$V6‚‚‡–6²’Óâ°¢–b‡–6²æÖF6„¶W’ÓÒ¶W’’&WGW&ã°¢òòöæÇ’7&VF—BF†R6Æ÷Bv†÷6R7÷'BF†—2f–v‡B7GVÆÇ’&VÆöæw2FòÂ6ð¢òòæÖR6öÆÆ—6–öâ7&÷727÷'G26ææ÷B7&÷72Ö7&VF—Bà¢–b…4ÄõEô%•ô´U’ævWB‡–6²ç6Æ÷B“òæfÖ–Ç’ÓÒfÖ–Ç’’&WGW&ã°¢–6²ç&uö–çG2³Òö–çG3°¢–6²æWfVçG46÷VçFVB³Ò°¢6öç7BÖW&vVBÒ²âââ‡–6²æ6FVv÷'•F÷FÇ2ÇÂ·Ò’Ó°¢ö&¦V7BæVçG&–W2‡F÷FÇ2’æf÷$V6‚‚…¶f–VÆBÂfÇVUÒ’Óâ°¢ÖW&vVE¶f–VÆEÒÒ†ÖW&vVE¶f–VÆEÒÇÂ’²fÇVS°¢Ò“°¢–6²æ6FVv÷'•F÷FÇ2ÒÖW&vVC°¢F÷V6†VBÒG'VS°¢Ò“°¢–b‡F÷V6†VB’°¢&÷7FW"æÖ&´ÖöF–f–VB‚w–6·2r“°¢v—B&÷7FW"ç6fR‚“°¢7&VF—FVB³Ò°¢Ð¢Ð¢Ð¢Ð¢&WGW&â²7&VF—FVBÓ°§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòE$eB(	B6†&vW2F†RVçG'’fVRF‡&÷Vv‚F†R6ÖRG&ç67F–öâæBÆVFvW"F†P¢òòf–v‡BVçG&–W2W6RÂ6ò6V6öâ6&BVçG'’—2VF—F&ÆRF†R6ÖRv’à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’÷6V6öç2ó§6V6öä–BöG&gBrÂ&WV—&U6V6öä6&G2Â7V&Ö—DÆ–Ö—FW"ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B6V6öä–BÒ7G&–ær‡&Wç&×2ç6V6öä–BÇÂrr’çG&–Ò‚“°¢6öç7B7V&Ö—GFVBÒ'&’æ—4'&’‡&Wæ&öG“òç–6·2’ò&Wæ&öG’ç–6·2¢µÓ° ¢6öç7B&W7VÇBÒv—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢6öç7B6V6öâÒv—Bv—F„f–v‡E6W76–öâ…6V6öâæf–æD'”–B‡6V6öä–B’Â6W76–öâ“°¢–b‚6V6öâ’F‡&÷r6V6öäW'&÷"ƒCBÂu6V6öâæ÷Bf÷VæBârÂu4T4ôåôäõEôdõTäBr“°¢–b‡6V6öâç7FGW2ÓÒtE$eEôõTâr’°¢F‡&÷r6V6öäW'&÷"ƒC’ÂtG&gF–ær†26Æ÷6VBf÷"F†—26V6öâârÂtE$eEô4Äõ4TBr“°¢Ð¢–b‡6V6öâæG&gD6Æ÷6W4BævWEF–ÖR‚’ÃÒFFRææ÷r‚’’°¢F‡&÷r6V6öäW'&÷"ƒC’ÂtG&gF–ær†26Æ÷6VBf÷"F†—26V6öâârÂtE$eEô4Äõ4TBr“°¢Ð ¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ€¢W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–ÂFö¶Vç2r’À¢6W76–öâÀ¢“°¢–b‚W6W"’F‡&÷r6V6öäW'&÷"ƒCBÂt66÷VçBæ÷Bf÷VæBârÂuU4U%ôäõEôdõTäBr“° ¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’‡W6W"“°¢–b†&Æö6¶VB’F‡&÷r6V6öäW'&÷"ƒC2Â&Æö6¶VBæÖW76vRÂ&Æö6¶VBæ6öFR“° ¢òò–B6V6öâ—2–B6öçFW7C¢—Bö&W—2F†R7FFRÖöFRW†7FÇ’2¢òò–Bf–v‡BFöW2à¢6öç7BfVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡6V6öâæVçG'”fVR’ÇÂ’“°¢–b†fVRâ’°¢6öç7BÖöFRÒ&W6öÇfU7FFTÖöFR‡W6W"ç&W6–FVæ6U7FFR“°¢–b†ÖöFRÓÒw–Br’°¢F‡&÷r6V6öäW'&÷"ƒC2Âu–B6V6öç2&Ræ÷Bf–Æ&ÆR–â–÷W"7FFRâg&VR6V6öç2&RârÂu5DDUôe$TUõÄ•ôôäÅ’r“°¢Ð¢Ð ¢6öç7B&WV—&VBÒ'&’æ—4'&’‡6V6öâç&WV—&VE6Æ÷G2’bb6V6öâç&WV—&VE6Æ÷G2æÆVæwF€¢ò6V6öâç&WV—&VE6Æ÷G0¢¢²ââå4T4ôåõ4ÄõEô´U•5Ó° ¢6öç7B–6·2ÒµÓ°¢f÷"†6öç7B6Æ÷Böb&WV—&VB’°¢6öç7B&rÒ7V&Ö—GFVBæf–æB‚†VçG'’’Óâ7G&–ær†VçG'“òç6Æ÷BÇÂrr’çG&–Ò‚’ÓÓÒ6Æ÷B“°¢6öç7Bf–v‡FW$æÖRÒ7G&–ær‡&sòæf–v‡FW$æÖRÇÂrr’çG&–Ò‚“°¢–b‚f–v‡FW$æÖR’°¢F‡&÷r6V6öäW'&÷"ƒC#"Â–6²f–v‡FW"f÷"WfW'’6Æ÷B(	BGµ4ÄõEô%•ô´U’ævWB‡6Æ÷B“òæÆ&VÂÇÂ6Æ÷GÒ—2V×G’æÂt”ä4ôÕÄUDUõ$õ5DU"rÂ²6Æ÷BÒ“°¢Ð¢6öç7BfÖ–Ç’Ò4ÄõEô%•ô´U’ævWB‡6Æ÷B“òæfÖ–Ç’ÇÂvÖÖs°¢6öç7BÆÆ÷vVBÒ4T4ôåô4ÄÅô4DTtõ$”U5¶fÖ–Ç•ÒÇÂ·Ó°¢6öç7B6ÆÆVD6FVv÷'’Ò7G&–ær‡&sòæ6ÆÆVD6FVv÷'’ÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢6öç7B6ÆÆVEfÇVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&sòæ6ÆÆVEfÇVR’ÇÂ’“°¢–b†6ÆÆVD6FVv÷'’bbÆÆ÷vVE¶6ÆÆVD6FVv÷'•Ò’°¢F‡&÷r6V6öäW'&÷"ƒC#"ÂG¶6ÆÆVD6FVv÷'—Ò—2æ÷B6FVv÷'’f÷"Gµ4ÄõEô%•ô´U’ævWB‡6Æ÷B“òæÆ&VÂÇÂ6Æ÷GÒæÂt$Eô4ÄÅô4DTtõ%’rÂ²6Æ÷BÒ“°¢Ð¢–6·2çW6‚‡°¢6Æ÷BÀ¢f–v‡FW$æÖS¢f–v‡FW$æÖRç6Æ–6RƒÂ#’À¢ÖF6„¶W“¢f–v‡FW$ÖF6„¶W’†f–v‡FW$æÖR’À¢6ÆÆVD6FVv÷'“¢6ÆÆVD6FVv÷'’bb6ÆÆVEfÇVRâò6ÆÆVD6FVv÷'’¢rrÀ¢6ÆÆVEfÇVS¢6ÆÆVD6FVv÷'’bb6ÆÆVEfÇVRâò6ÆÆVEfÇVR¢À¢Ò“°¢Ð ¢òòæòG&gF–ærF†R6ÖRf–v‡FW"–çFòGvò6Æ÷G2à¢6öç7B¶W—2Ò–6·2æÖ‚‡–6²’Óâ–6²æÖF6„¶W’“°¢–b†æWr6WB†¶W—2’ç6—¦RÓÒ¶W—2æÆVæwF‚’°¢F‡&÷r6V6öäW'&÷"ƒC#"ÂtV6‚6Æ÷BæVVG2F–ffW&VçBf–v‡FW"ârÂtEUÄ”4DUõ”4²r“°¢Ð ¢6öç7BW†—7F–ærÒv—Bv—F„f–v‡E6W76–öâ…6V6öå&÷7FW"æf–æDöæR‡²6V6öä–BÂW6W$–BÒ’Â6W76–öâ’æÆVâ‚“°¢–b†W†—7F–ær’F‡&÷r6V6öäW'&÷"ƒC’Âu–÷RÇ&VG’†fR6&B–âF†—26V6öâârÂtÅ$TE•ôE$eDTBr“° ¢–b†fVRâ’°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢–b†&Vf÷&RÂfVR’°¢F‡&÷r6V6öäW'&÷"ƒC"Âtæ÷BVæ÷Vv‚dÒ6ö–ç2f÷"F†—26V6öâârÂt”å5Tdd”4”TåEôeTäE2rÂ°¢&Ææ6S¢&Vf÷&RÂVçG'”fVS¢fVRÂ6†÷'FfÆÃ¢fVRÒ&Vf÷&RÀ¢Ò“°¢Ð¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&RÒfVR“°¢v—BW6W"ç6fR‡²6W76–öâÒ“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–BÂÖ÷VçC¢ÖfVRÂ&Ææ6T&Vf÷&S¢&Vf÷&RÂ&Ææ6TgFW#¢&Vf÷&RÒfVRÀ¢&V6öã¢w6V6öåöVçG'’rÂ&VfW&Væ6S¢6V6öã¢G·6V6öä–GÓ¢G·W6W$–GÖÀ¢ÖWF¢²6V6öä–BÂ6V6öäæÖS¢6V6öâææÖRÒÂ6W76–öâÀ¢Ò“°¢v—B6V6öâçWFFTöæR‡²ö–C¢6V6öä–BÒÂ²F–æ3¢²&—¦UööÃ¢fVRÒÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“°¢Ð ¢6öç7B·&÷7FW%ÒÒv—B6V6öå&÷7FW"æ7&VFR…·°¢6V6öä–BÂW6W$–BÂ–6·2ÂVçG'”fVU–C¢fVRÀ¢–FV×÷FVæ7”¶W“¢6V6öã¢G·6V6öä–GÓ¢G·W6W$–GÖÀ¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢&WGW&â²&÷7FW"Â6V6öâÂW6W"ÂfVRÓ°¢Ò“° ¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢&W7VÇBçW6W"æVÖ–ÂÀ¢7V&¦V7C¢–÷W"6V6öâ6&B—2Æö6¶VB–â(	BG·&W7VÇBç6V6öâææÖWÖÀ¢†VF–æs¢u4T4ôâ4$BÄô4´TBrÀ¢Æ–æW3¢°¢–÷W"f—fRf–v‡FW'2&R6WBf÷"Ç7G&öæsâG¶W66T‡FÖÂ‡&W7VÇBç6V6öâææÖR—ÓÂ÷7G&öæsâæÀ¢&W7VÇBç&÷7FW"ç–6·2æÖ‚‡–6²’ÓâGµ4ÄõEô%•ô´U’ævWB‡–6²ç6Æ÷B“òæÆ&VÂÇÂ–6²ç6Æ÷GÓ¢Ç7G&öæsâG¶W66T‡FÖÂ‡–6²æf–v‡FW$æÖR—ÓÂ÷7G&öæsâG·–6²æ6ÆÆVD6FVv÷'’ò(	B6ÆÆVBG·–6²æ6ÆÆVEfÇVWÒG²…4T4ôåô4ÄÅô4DTtõ$”U5µ4ÄõEô%•ô´U’ævWB‡–6²ç6Æ÷B“òæfÖ–Ç’ÇÂvÖÖuÒÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•ÒÇÂ–6²æ6ÆÆVD6FVv÷'—Ö¢rwÖ’æ¦ö–â‚sÆ'#âr’À¢&W7VÇBæfVRâòVçG'“¢G·&W7VÇBæfVRçFôÆö6ÆU7G&–ær‚—ÒdÒæ¢tg&VRVçG'’ârÀ¢tWfW'’F–ÖRöæRöb–÷W"f—fR6ö×WFW2Âv†BF†W’Fò—27&VF—FVBFò–÷W"6&BârÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢&÷7FW$–C¢&W7VÇBç&÷7FW"åö–BÀ¢6V6öäæÖS¢&W7VÇBç6V6öâææÖRÀ¢–6·3¢&W7VÇBç&÷7FW"ç–6·2æÖ‚‡–6²’Óâ‡°¢6Æ÷C¢–6²ç6Æ÷BÂf–v‡FW$æÖS¢–6²æf–v‡FW$æÖRÀ¢6ÆÆVD6FVv÷'“¢–6²æ6ÆÆVD6FVv÷'’Â6ÆÆVEfÇVS¢–6²æ6ÆÆVEfÇVRÀ¢Ò’’À¢VçG'”fVU–C¢&W7VÇBæfVRÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚u6V6öâG&gBf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷BÆö6²–âF†B6&BârÀ¢6öFS¢W'&÷#òæ6öFRÇÂtE$eEôd”ÄTBrÀ¢âââ†W'&÷#òæW‡G&ÇÂ·Ò’À¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò4UEDÄTÔTåB(	Bæ÷&ÖÆ—6RV6‚6Æ÷Bv—F†–â—G2÷vâ7÷'BÂÇ’F†R6ÆÆV@¢òòçVÖ&W"ÂF†Vâ†æBF†R6V6öâFòF†RW†—7F–ær&—¦RÖ6†–æW'’à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B6WGFÆU6V6öâÒ7–æ2‡6V6öä–B’Óâ°¢òò6Æ–Ò&Vf÷&R66÷&–ærÂW†7FÇ’2f–v‡B6WGFÆVÖVçBFöW2à¢6öç7B6Æ–ÖVBÒv—B6V6öâæf–æDöæTæEWFFR€¢²ö–C¢6V6öä–BÂ7FGW3¢u%Tää”ärrÒÀ¢²G6WC¢²7FGW3¢u4UEDÄTBrÂ6WGFÆVDC¢æWrFFR‚’ÒÒÀ¢²æWs¢G'VRÒÀ¢“°¢–b‚6Æ–ÖVB’°¢6öç7B7W'&VçBÒv—B6V6öâæf–æD'”–B‡6V6öä–B’ç6VÆV7B‚w7FGW26WGFÆVDBr’æÆVâ‚“°¢&WGW&â²Ç&VG•6WGFÆVC¢G'VRÂ7FGW3¢7W'&VçCòç7FGW2ÇÂçVÆÂÓ°¢Ð ¢6öç7B&÷7FW'2Òv—B6V6öå&÷7FW"æf–æB‡²6V6öä–C¢7G&–ær‡6V6öä–B’Ò“°¢–b‚&÷7FW'2æÆVæwF‚’&WGW&â²6WGFÆVC¢ÂVçG&çG3¢Ó° ¢òòæ÷&ÖÆ—6F–öâæVVG2f–VÆBFòÖV7W&Rv–ç7Bâv—F‚6–ævÆR–BVçG&ç@¢òòF†W&R—2æò6öçFW7B(	B&VgVæB&F†W"F†â†æBF†VÒF†V—"÷vâÖöæW’&6°¢òòÖ–çW2æ÷F†–ærÂ÷"v÷'6RÂ’F†VÒ&—¦RF†W’F–Bæ÷B6ö×WFRf÷"à¢6öç7B–DVçG&çG2Ò&÷7FW'2æf–ÇFW"‚‡&÷7FW"’ÓâçVÖ&W"‡&÷7FW"æVçG'”fVU–B’â“°¢òò6WBv†VâF†R÷B†2&VVâ†æFVB&6²Â6òF†R&—¦R7FW&VÆ÷r×W7Bæ÷B'Vâà¢ÆWB&VgVæFVDæôf–VÆBÒfÇ6S°¢–b‡–DVçG&çG2æÆVæwF‚ÓÓÒ’°¢&VgVæFVDæôf–VÆBÒG'VS°¢6öç7B6öÆòÒ–DVçG&çG5³Ó°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡6öÆòçW6W$–B’ç6VÆV7B‚wFö¶Vç2VÖ–Âr“°¢–b‡W6W"’°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&R²6öÆòæVçG'”fVU–B“°¢v—BW6W"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢6öÆòçW6W$–BÂÖ÷VçC¢6öÆòæVçG'”fVU–BÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²6öÆòæVçG'”fVU–BÂ&V6öã¢w6V6öå÷&VgVæEöæõöf–VÆBrÀ¢&VfW&Væ6S¢6V6öã§6öÆò×&VgVæC¢G·6V6öä–GÓ¢G·6öÆòçW6W$–GÖÀ¢ÖWF¢²6V6öä–C¢7G&–ær‡6V6öä–B’ÒÀ¢Ò“°¢–b‡W6W"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢G¶6Æ–ÖVBææÖWÒ(	B&VgVæFVBÂæ÷BVæ÷Vv‚VçG&çG6À¢†VF–æs¢u4T4ôâ$TeTäDTBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†6Æ–ÖVBææÖR—ÓÂ÷7G&öæsâf–æ—6†VBv—F‚öæÇ’öæR–B6&BÂ6òF†W&Rv2æòf–VÆBFò66÷&Rv–ç7BæÀ¢–÷W"G·6öÆòæVçG'”fVU–BçFôÆö6ÆU7G&–ær‚—ÒdÒVçG'’†2&VVâ&WGW&æVB–âgVÆÂæÀ¢ÒÀ¢Ò“°¢Ð¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6öÆòÖVçG&çB6V6öâ&VgVæBf–ÆVC¢rÂW'&÷"“°¢Ð¢Ð ¢òò&W7B&r÷WGWB6†–WfVB–âV6‚6Æ÷B7&÷72F†Rv†öÆRf–VÆBâF†—2—2F†P¢òò–&G7F–6²6Æ÷B—266÷&VBv–ç7BÂ6òF†R66ÆR—26WB'’v†Bv27GVÆÇ¢òò6†–Wf&ÆR–âF†B7÷'BF†—26V6öâ&F†W"F†âwVW76VB6öç7FçBà¢6öç7B&W7D'•6Æ÷BÒæWrÖ‚“°¢&÷7FW'2æf÷$V6‚‚‡&÷7FW"’Óâ°¢&÷7FW"ç–6·2æf÷$V6‚‚‡–6²’Óâ°¢6öç7B&W7BÒ&W7D'•6Æ÷BævWB‡–6²ç6Æ÷B’ÇÂ°¢–b‡–6²ç&uö–çG2â&W7B’&W7D'•6Æ÷Bç6WB‡–6²ç6Æ÷BÂ–6²ç&uö–çG2“°¢Ò“°¢Ò“° ¢f÷"†6öç7B&÷7FW"öb&÷7FW'2’°¢ÆWBF÷FÂÒ°¢&÷7FW"ç–6·2æf÷$V6‚‚‡–6²’Óâ°¢6öç7B&W7BÒ&W7D'•6Æ÷BævWB‡–6²ç6Æ÷B’ÇÂ°¢òò6Æ÷Bæö&öG’66÷&VB–â—2v÷'F‚æ÷F†–ærFòWfW'–&öG’(	Bæòg&VRö–çG0¢òòf÷"f–v‡FW"v†òæWfW"6ö×WFVBÂæBæòF—f—6–öâ'’¦W&òà¢–6²ææ÷&ÖÆ—¦VBÒ&W7BâòÖF‚ç&÷VæB‚‡–6²ç&uö–çG2ò&W7B’¢4T4ôåõ4ÄõEôÔ‚’¢° ¢òòF†RÆFf÷&Òw2÷vâ'VÆS¢–÷R66÷&Rv†B–÷R6ÆÆVBÂ&÷f–FVB–÷R6ÆÆV@¢òòB÷"VæFW"v†BF†Rf–v‡FW"7GVÆÇ’F–Bà¢6öç7B7GVÂÒçVÖ&W"‚‡–6²æ6FVv÷'•F÷FÇ2ÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•Ò’ÇÂ°¢6öç7B†—BÒ&ööÆVâ‡–6²æ6ÆÆVD6FVv÷'’’bb–6²æ6ÆÆVEfÇVRâbb–6²æ6ÆÆVEfÇVRÃÒ7GVÃ°¢–6²æ6ÆÄ†—BÒ†—C°¢–6²æ6ÆÄ&öçW2Ò†—BòÖF‚æÖ–â‡–6²æ6ÆÆVEfÇVRÂ4T4ôåô4ÄÅô$ôåU5ô4’¢° ¢F÷FÂ³Ò–6²ææ÷&ÖÆ—¦VB²–6²æ6ÆÄ&öçW3°¢Ò“°¢&÷7FW"çF÷FÅ66÷&RÒF÷FÃ°¢&÷7FW"ç6WGFÆVBÒG'VS°¢&÷7FW"æÖ&´ÖöF–f–VB‚w–6·2r“°¢v—B&÷7FW"ç6fR‚“°¢Ð ¢òò†æBöfbFòF†RÖ6†–æW'’F†BÇ&VG’—2f–v‡B6öçFW7G2Â6ò6V6öà¢òò&—¦W2W6RF†R6ÖRF—7G&–'WF–öâÂF†R6ÖRÆVFvW"æBF†R6ÖRVÖ–Ç2à¢6öç7B66÷&VBÒ&÷7FW'0¢æÖ‚‡&÷7FW"’Óâ‡²W6W$–C¢7G&–ær‡&÷7FW"çW6W$–B’Âö–çG3¢&÷7FW"çF÷FÅ66÷&RÒ’¢ç6÷'B‚†Â"’Óâ"çö–çG2Òçö–çG2“° ¢ÆWB–÷WBÒçVÆÃ°¢òò&VgVæFVB÷B—2vöæR(	B––ær&—¦W2g&öÒ—B2vVÆÂv÷VÆB’F†R6ÖP¢òò6ö–ç2÷WBGv–6Rà¢6öç7B&—¦UööÂÒ&VgVæFVDæôf–VÆBò¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†6Æ–ÖVBç&—¦UööÂ’ÇÂ’“°¢–b‡&VgVæFVDæôf–VÆB’–÷WBÒ²&—¦UööÃ¢Â–C¢Â&VgVæFVC¢G'VRÓ°¢–b‡&—¦UööÂâ’°¢6öç7B²v&G2ÒÒ'V–ÆE&—¦Tv&G2‡66÷&VBÂ&—¦UööÂ“°¢ÆWB–BÒ°¢f÷"†6öç7Bv&Böbv&G2’°¢–b‚v&CòæÖ÷VçBÇÂv&BæÖ÷VçBÃÒ’6öçF–çVS°¢6öç7Bv–ææW"Òv—BW6W"æf–æD'”–B†v&BçW6W$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRFö¶Vç2r“°¢–b‚v–ææW"’6öçF–çVS°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡v–ææW"çFö¶Vç2“°¢v–ææW"çFö¶Vç2Ò7G&–ær†&Vf÷&R²v&BæÖ÷VçB“°¢v—Bv–ææW"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢v&BçW6W$–BÂÖ÷VçC¢v&BæÖ÷VçBÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²v&BæÖ÷VçBÂ&V6öã¢w6V6öå÷&—¦RrÀ¢&VfW&Væ6S¢6V6öã§&—¦S¢G·6V6öä–GÓ¢G¶v&BçW6W$–GÖÀ¢ÖWF¢²6V6öä–BÂÆ6S¢v&BçÆ6RÒÀ¢Ò“°¢–B³Òv&BæÖ÷VçC°¢–b‡v–ææW"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢v–ææW"æVÖ–ÂÀ¢7V&¦V7C¢G¶6Æ–ÖVBææÖWÒ(	B–÷Rf–æ—6†VB2G¶v&BçÆ6WÖÀ¢†VF–æs¢4T4ôâ$U5TÅB+r2G¶v&BçÆ6WÖÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†6Æ–ÖVBææÖR—ÓÂ÷7G&öæsâ†2&VVâ6WGFÆVBæÀ¢Ç7G&öæsâG¶v&BæÖ÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâFFVBFò–÷W"vÆÆWBæÀ¢ÒÀ¢Ò“°¢Ð¢Ð¢–÷WBÒ²&—¦UööÂÂ–BÓ°¢Ð ¢òò&FvW2ÂF—FÆW2æB7öç6÷"&—¦W2GF6‚Fò6V6öâF†R6ÖRv’F†W¢òòGF6‚Fòf–v‡B(	Bg&VR6V6öâ—266÷&VBæBv&FVBÂ§W7Bæ÷B–Bà¢ÆWBv&G4v—fVâÒçVÆÃ°¢G'’°¢v&G4v—fVâÒv—Bv&Dæöä66…&—¦W2‡6V6öä–BÂ66÷&VBÂ²ÖF6„f–v‡FW$¢6Æ–ÖVBææÖRÂÖF6„f–v‡FW$#¢u6V6öârÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâæöâÖ66‚v&G2f–ÆVC¢rÂW'&÷"“°¢v&G4v—fVâÒ²W'&÷#¢tt$E5ôd”ÄTBrÓ°¢Ð ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â²6WGFÆVC¢&÷7FW'2æÆVæwF‚ÂVçG&çG3¢&÷7FW'2æÆVæwF‚Â–÷WBÂv&G4v—fVâÓ°§Ó° ¢òò'Vç2g&öÒF†R66†VGVÆW"âGvò¦ö'3¢7F'B6V6öç2v†÷6RG&gBv–æF÷r†26Æ÷6VBÀ¢òòæB6WGFÆR6V6öç2F†B†fRVæFVBâ6V6öâF†BæVVG2âFÖ–âFò&VÖVÖ&W"—@¢òò—26V6öâF†B7G&æG2VçG'’fVW2à¦ævWB‚rö’ö7&öâ÷6V6öç2öGfæ6RrÂfW&–g”7&öå6V7&WBÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bæ÷rÒæWrFFR‚“°¢6öç7B7F'FVBÒv—B6V6öâçWFFTÖç’€¢²7FGW3¢tE$eEôõTârÂG&gD6Æ÷6W4C¢²FÇFS¢æ÷rÒÒÀ¢²G6WC¢²7FGW3¢u%Tää”ärrÒÒÀ¢“° ¢6öç7BGVRÒv—B6V6öâæf–æB‡²7FGW3¢u%Tää”ärrÂVæG4C¢²FÇFS¢æ÷rÒÒ’ç6VÆV7B‚uö–BæÖRr’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7B6WGFÆVBÒµÓ°¢f÷"†6öç7B6V6öâöbGVR’°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆU6V6öâ…7G&–ær‡6V6öâåö–B’“°¢6WGFÆVBçW6‚‡²–C¢6V6öâåö–BÂæÖS¢6V6öâææÖRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâWFò×6WGFÆRf–ÆVBf÷"rÂ7G&–ær‡6V6öâåö–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ7F'FVC¢7F'FVCòæÖöF–f–VD6÷VçBÇÂÂ6WGFÆVBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâGfæ6R7vVWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6V6öâ7vVWf–ÆVBârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–â÷6V6öç2ó§6V6öä–B÷6WGFÆRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆU6V6öâ…7G&–ær‡&Wç&×2ç6V6öä–BÇÂrr’çG&–Ò‚’“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâ6WGFÆRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6WGFÆRF†B6V6öâârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–â÷6V6öç2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“°¢–b‚æÖR’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6V6öâæÖR—2&WV—&VBârÒ“°¢6öç7B7F'G4BÒæWrFFR‡&Wæ&öG“òç7F'G4B“°¢6öç7BVæG4BÒæWrFFR‡&Wæ&öG“òæVæG4B“°¢6öç7BG&gD6Æ÷6W4BÒæWrFFR‡&Wæ&öG“òæG&gD6Æ÷6W4BÇÂ&Wæ&öG“òç7F'G4B“°¢–b…·7F'G4BÂVæG4BÂG&gD6Æ÷6W4EÒç6öÖR‚†FFR’ÓâçVÖ&W"æ—4æâ†FFRævWEF–ÖR‚’’’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u&÷f–FRfÆ–B7F'BÂVæBæBG&gBÖ6Æ÷6RFFW2ârÒ“°¢Ð¢–b†VæG4BÃÒ7F'G4B’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†R6V6öâ×W7BVæBgFW"—B7F'G2ârÒ“° ¢6öç7B&WVW7FVBÒ'&’æ—4'&’‡&Wæ&öG“òç&WV—&VE6Æ÷G2’ò&Wæ&öG’ç&WV—&VE6Æ÷G2¢4T4ôåõ4ÄõEô´U•3°¢6öç7B&WV—&VE6Æ÷G2Ò&WVW7FVBæf–ÇFW"‚‡6Æ÷B’Óâ4T4ôåõ4ÄõEô´U•2æ–æ6ÇVFW2…7G&–ær‡6Æ÷B’’“°¢–b‚&WV—&VE6Æ÷G2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6V6öâæVVG2BÆV7BöæR6Æ÷BârÒ“° ¢6öç7B6V6öâÒv—B6V6öâæ7&VFR‡°¢æÖS¢æÖRç6Æ–6RƒÂ#’À¢FW67&—F–öã¢7G&–ær‡&Wæ&öG“òæFW67&—F–öâÇÂrr’ç6Æ–6RƒÂS’À¢7F'G4BÂVæG4BÂG&gD6Æ÷6W4BÀ¢VçG'”fVS¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæVçG'”fVR’ÇÂ’’À¢&WV—&VE6Æ÷G2À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ6V6öä–C¢6V6öâåö–BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâ7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7&VFRF†B6V6öâârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–â÷6V6öç2ó§6V6öä–B÷7FGW2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæW‡BÒ7G&–ær‡&Wæ&öG“òç7FGW2ÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢–b‚²tE$eEôõTârÂu%Tää”ärrÂudô”BuÒæ–æ6ÇVFW2†æW‡B’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢w7FGW2×W7B&RE$eEôõTâÂ%Tää”är÷"dô”BârÒ“°¢Ð¢6öç7B6V6öâÒv—B6V6öâæf–æD'”–B…7G&–ær‡&Wç&×2ç6V6öä–BÇÂrr’’æÆVâ‚“°¢–b‚6V6öâ’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6V6öâæ÷Bf÷VæBârÒ“°¢–b‡6V6öâç7FGW2ÓÓÒu4UEDÄTBr’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B6V6öâ—2Ç&VG’6WGFÆVBârÒ“°¢Ð ¢òòfö–F–ær×W7B&WGW&âWfW'’VçG'’fVR(	B6V6öâæö&öG’6âv–â—26V6öà¢òòæö&öG’6†÷VÆB†fR–Bf÷"à¢–b†æW‡BÓÓÒudô”Br’°¢6öç7B&÷7FW'2Òv—B6V6öå&÷7FW"æf–æB‡²6V6öä–C¢7G&–ær‡6V6öâåö–B’ÂVçG'”fVU–C¢²FwC¢ÒÒ’æÆVâ‚“°¢f÷"†6öç7B&÷7FW"öb&÷7FW'2’°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡&÷7FW"çW6W$–B’ç6VÆV7B‚wFö¶Vç2VÖ–Âr“°¢–b‚W6W"’6öçF–çVS°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&R²&÷7FW"æVçG'”fVU–B“°¢v—BW6W"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢&÷7FW"çW6W$–BÂÖ÷VçC¢&÷7FW"æVçG'”fVU–BÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²&÷7FW"æVçG'”fVU–BÂ&V6öã¢w6V6öå÷&VgVæBrÀ¢&VfW&Væ6S¢6V6öã§&VgVæC¢G·6V6öâåö–GÓ¢G·&÷7FW"çW6W$–GÖÀ¢ÖWF¢²6V6öä–C¢7G&–ær‡6V6öâåö–B’ÒÀ¢Ò“°¢–b‡W6W"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢G·6V6öâææÖWÒv26æ6VÆÆVB(	B–÷R†fR&VVâ&VgVæFVFÀ¢†VF–æs¢u4T4ôâ4ä4TÄÄTBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ‡6V6öâææÖR—ÓÂ÷7G&öæsâ†2&VVâ6æ6VÆÆVBæÀ¢–÷W"G·&÷7FW"æVçG'”fVU–BçFôÆö6ÆU7G&–ær‚—ÒdÒVçG'’†2&VVâ&WGW&æVB–âgVÆÂæÀ¢ÒÀ¢Ò“°¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâ&VgVæBf–ÆVBf÷"rÂ7G&–ær‡&÷7FW"çW6W$–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð¢Ð ¢v—B6V6öâçWFFTöæR‡²ö–C¢6V6öâåö–BÒÂ°¢G6WC¢²7FGW3¢æW‡BÂfö–E&V6öã¢æW‡BÓÓÒudô”Brò7G&–ær‡&Wæ&öG“òç&V6öâÇÂt6æ6VÆÆVB'’âFÖ–æ—7G&F÷"âr’¢rrÒÀ¢Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ7FGW3¢æW‡BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâ7FGW26†ævRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6†ævRF†B6V6öâârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòÄ”U"$TE0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’÷6V6öç2ö÷VârÂ&WV—&U6V6öä6&G2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6V6öç2Òv—B6V6öâæf–æB‡²7FGW3¢²F–ã¢²tE$eEôõTârÂu%Tää”äruÒÒÒ¢ç6÷'B‡²7F'G4C¢Ò’æÆ–Ö—Bƒ#’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6Æ÷G3¢4T4ôåõ4ÄõE2À¢6ÆÄ6FVv÷&–W3¢4T4ôåô4ÄÅô4DTtõ$”U2À¢6ÆÄ&öçW46¢4T4ôåô4ÄÅô$ôåU5ô4À¢6Æ÷DÖƒ¢4T4ôåõ4ÄõEôÔ‚À¢6V6öç3¢v—B&öÖ—6RæÆÂ‡6V6öç2æÖ†7–æ2‡6V6öâ’Óâ‡°¢–C¢6V6öâåö–BÀ¢æÖS¢6V6öâææÖRÀ¢FW67&—F–öã¢6V6öâæFW67&—F–öâÀ¢7F'G4C¢6V6öâç7F'G4BÀ¢VæG4C¢6V6öâæVæG4BÀ¢G&gD6Æ÷6W4C¢6V6öâæG&gD6Æ÷6W4BÀ¢G&gD÷Vã¢6V6öâç7FGW2ÓÓÒtE$eEôõTârbb6V6öâæG&gD6Æ÷6W4BævWEF–ÖR‚’âFFRææ÷r‚’À¢VçG'”fVS¢6V6öâæVçG'”fVRÀ¢&WV—&VE6Æ÷G3¢6V6öâç&WV—&VE6Æ÷G2À¢&—¦UööÃ¢6V6öâç&—¦UööÂÀ¢VçG&çG3¢v—B6V6öå&÷7FW"æ6÷VçDFö7VÖVçG2‡²6V6öä–C¢7G&–ær‡6V6öâåö–B’Ò’À¢Ò’’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâÆ—7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB6V6öç2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷6V6öç2öÖRrÂ&WV—&U6V6öä6&G2ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B&÷7FW'2Òv—B6V6öå&÷7FW"æf–æB‡²W6W$–BÒ’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ3’æÆVâ‚“°¢6öç7B6V6öä–G2Ò²ââææWr6WB‡&÷7FW'2æÖ‚‡"’Óâ"ç6V6öä–B’•Òæf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7B6V6öç2Ò6V6öä–G2æÆVæwF‚òv—B6V6öâæf–æB‡²ö–C¢²F–ã¢6V6öä–G2ÒÒ’æÆVâ‚’¢µÓ°¢6öç7B'”–BÒæWrÖ‡6V6öç2æÖ‚‡3"’Óâµ7G&–ær‡3"åö–B’Â3%Ò’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6&G3¢&÷7FW'2æÖ‚‡&÷7FW"’Óâ°¢6öç7B6V6öâÒ'”–BævWB…7G&–ær‡&÷7FW"ç6V6öä–B’“°¢&WGW&â°¢&÷7FW$–C¢&÷7FW"åö–BÀ¢6V6öä–C¢&÷7FW"ç6V6öä–BÀ¢6V6öäæÖS¢6V6öãòææÖRÇÂu6V6öârÀ¢7FGW3¢6V6öãòç7FGW2ÇÂu%Tää”ärrÀ¢VæG4C¢6V6öãòæVæG4BÇÂçVÆÂÀ¢VçG'”fVU–C¢&÷7FW"æVçG'”fVU–BÀ¢F÷FÅ66÷&S¢&÷7FW"çF÷FÅ66÷&RÀ¢6WGFÆVC¢&÷7FW"ç6WGFÆVBÀ¢Ö…÷76–&ÆS¢‡&÷7FW"ç–6·3òæÆVæwF‚ÇÂ’¢4T4ôåõ4ÄõEôÔ‚À¢–6·3¢‡&÷7FW"ç–6·2ÇÂµÒ’æÖ‚‡–6²’Óâ°¢6öç7BfÖ–Ç’Ò4ÄõEô%•ô´U’ævWB‡–6²ç6Æ÷B“òæfÖ–Ç’ÇÂvÖÖs°¢&WGW&â°¢6Æ÷C¢–6²ç6Æ÷BÀ¢6Æ÷DÆ&VÃ¢4ÄõEô%•ô´U’ævWB‡–6²ç6Æ÷B“òæÆ&VÂÇÂ–6²ç6Æ÷BÀ¢f–v‡FW$æÖS¢–6²æf–v‡FW$æÖRÀ¢&uö–çG3¢–6²ç&uö–çG2À¢WfVçG46÷VçFVC¢–6²æWfVçG46÷VçFVBÀ¢æ÷&ÖÆ—¦VC¢–6²ææ÷&ÖÆ—¦VBÀ¢6ÆÆVD6FVv÷'“¢–6²æ6ÆÆVD6FVv÷'’À¢6ÆÆVD6FVv÷'”Æ&VÃ¢…4T4ôåô4ÄÅô4DTtõ$”U5¶fÖ–Ç•ÒÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•ÒÇÂrrÀ¢6ÆÆVEfÇVS¢–6²æ6ÆÆVEfÇVRÀ¢7GVÅ6ôf#¢çVÖ&W"‚‡–6²æ6FVv÷'•F÷FÇ2ÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•Ò’ÇÂÀ¢6ÆÄ†—C¢–6²æ6ÆÄ†—BÀ¢6ÆÄ&öçW3¢–6²æ6ÆÄ&öçW2À¢Ó°¢Ò’À¢Ó°¢Ò’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâ6&G2Æöö·Wf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"6&G2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷6V6öç2ó§6V6öä–BöÆVFW&&ö&BrÂ&WV—&U6V6öä6&G2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6V6öä–BÒ7G&–ær‡&Wç&×2ç6V6öä–BÇÂrr’çG&–Ò‚“°¢6öç7B&÷7FW'2Òv—B6V6öå&÷7FW"æf–æB‡²6V6öä–BÒ’æÆVâ‚“°¢òòÖ–B×6V6öâF†Ræ÷&ÖÆ—6VBf–wW&R—2æ÷Bf–æÂÂ6ò&æ²öâ&r÷WGWBæ@¢òòÆ&VÂ—B2&÷f—6–öæÂ&F†W"F†âV&Æ—6†–ærçVÖ&W"F†Bv–ÆÂÖ÷fRà¢6öç7B6WGFÆVBÒ&÷7FW'2ç6öÖR‚‡&÷7FW"’Óâ&÷7FW"ç6WGFÆVB“°¢6öç7B&æ¶VBÒ&÷7FW'0¢æÖ‚‡&÷7FW"’Óâ‡°¢W6W$–C¢&÷7FW"çW6W$–BÀ¢66÷&S¢6WGFÆVBò&÷7FW"çF÷FÅ66÷&R¢‡&÷7FW"ç–6·2ÇÂµÒ’ç&VGV6R‚‡7VÒÂ–6²’Óâ7VÒ²–6²ç&uö–çG2Â’À¢Ò’¢ç6÷'B‚†Â"’Óâ"ç66÷&RÒç66÷&R¢ç6Æ–6RƒÂ“° ¢6öç7BW6W'2Ò&æ¶VBæÆVæwF€¢òv—BW6W"æf–æB‡²ö–C¢²F–ã¢&æ¶VBæÖ‚‡"’Óâ"çW6W$–B’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’’ÒÒ¢ç6VÆV7B‚wÆ–W$æÖRf—'7DæÖR&öf–ÆUW&Âr’æÆVâ‚¢¢µÓ°¢6öç7B'”–BÒæWrÖ‡W6W'2æÖ‚‡R’Óâµ7G&–ær‡Råö–B’ÂUÒ’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢&÷f—6–öæÃ¢6WGFÆVBÀ¢66ÆS¢6WGFÆVBòvæ÷&ÖÆ—¦VBr¢w&rrÀ¢ÆVFW&&ö&C¢&æ¶VBæÖ‚‡&÷rÂ–æFW‚’Óâ‡°¢Æ6S¢–æFW‚²À¢æÖS¢'”–BævWB‡&÷rçW6W$–B“òçÆ–W$æÖRÇÂ'”–BævWB‡&÷rçW6W$–B“òæf—'7DæÖRÇÂuÆ–W"rÀ¢fF#¢'”–BævWB‡&÷rçW6W$–B“òç&öf–ÆUW&ÂÇÂrrÀ¢66÷&S¢&÷rç66÷&RÀ¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6V6öâÆVFW&&ö&Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†RÆVFW&&ö&BârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòDTÒ4$E2(	B–6²f—fRf–v‡FW'2g&öÒöæRWfVç@¢òð¢òòF†RÆ–W"'V–ÆG2FVÒöbf—fRf–v‡FW'2g&öÒ6–ævÆR6&BÂöæRg&öÒV6‚ö`¢òòf—fRF–ffW&VçB&÷WG2ÂæBF†V—"6öÖ&–æVB÷WGWB÷fW"F†Bæ–v‡B—2F†R66÷&Rà¢òð¢òòF†—2—2F†R7G&öævW7B6†RF†RÆFf÷&Ò†3 ¢òð¢òòÒWfW'’f–v‡FW"—2–âF†R6ÖR7÷'BVæFW"F†R6ÖR'VÆW2Â6òF†R66÷&R—2¢òòÆ–âF÷FÂâæòæ÷&ÖÆ—6F–öâÂæò6öçfW'6–öâÂæ÷F†–ærFòW‡Æ–â(	BF†P¢òòÆFf÷&Òw2÷vâ66÷&–ær'Vç2VçF÷V6†VBà¢òòÒ—B&W6öÇfW2F†R6ÖRæ–v‡BÂv†–6‚ÖF6†W2†÷rF†R&W7BöbF†R&V†fW2à¢òòÒ—B—2f—fRÖF†ÆWFRÆ–æWW7&÷72f—fR&÷WG2Âv†–6‚—2F†R6Æ76–0¢òòF–Ç’ÖfçF7’6†R&F†W"F†â6–ævÆRÖWfVçB6öçFW7Bà¢òð¢òòôäRd”t…DU"U"$õUB—2Væf÷&6VBÂæ÷BGf—6VBâv—F†÷WB—BÆ–W"–6·2&÷F€¢òò6–FW2öbf–v‡BæB&æ·2ö–çG2v†–6†WfW"v’—BvöW2(	B†VFvRÂæ÷B6ÆÂà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BDTÕô4$E5ôTä$ÄTBÒ²wG'VRrÂsrÂw–W2rÂvöâuÐ¢æ–æ6ÇVFW2…7G&–ær‡&ö6W72æVçbåDTÕô4$E5ôTä$ÄTBÇÂwG'VRr’çG&–Ò‚’çFôÆ÷vW$66R‚’“° ¦6öç7BDTÕõ”4µ5õ$UT•$TBÒÖF‚æÖ‚ƒ"ÂÖF‚æÖ–âƒÂçVÖ&W"‡&ö6W72æVçbåDTÕõ”4µ5õ$UT•$TBÇÂR’’“°¦6öç7BDTÕô4ÄÅô$ôåU5ô4ÒÖF‚æÖ‚ƒÂçVÖ&W"‡&ö6W72æVçbåDTÕô4ÄÅô$ôåU5ô4óòS’“° ¦6öç7BFVÔ6öçFW7E66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢WfVçDæÖS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òòF†R&÷WG2F†—26&B—2'V–ÇBg&öÒâ–6²×W7BæÖRf–v‡FW"–âöæRöbF†VÒà¢f–v‡D–G3¢²G—S¢µ7G&–æuÒÂFVfVÇC¢µÒÂ&WV—&VC¢G'VRÒÀ¢–6·5&WV—&VC¢²G—S¢çVÖ&W"ÂFVfVÇC¢DTÕõ”4µ5õ$UT•$TBÒÀ¢VçG'”fVS¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÂÖ–ã¢ÒÀ¢&—¦UööÃ¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢òò6WBv†Vâ&öÖ÷FW"'Vç2F†R6öçFW7Bf÷"F†V—"ÆVwVRà¢ff–Æ–FT–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7FGW3¢²G—S¢7G&–ærÂVçVÓ¢²tõTârÂtÄô4´TBrÂu4UEDÄTBrÂudô”BuÒÂFVfVÇC¢tõTârÂ–æFWƒ¢G'VRÒÀ¢6WGFÆVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢fö–E&V6öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7BFVÔVçG'•66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢6öçFW7D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢W6W$–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢–6·3¢°¢G—S¢¶æWrÖöævö÷6Rå66†VÖ‡°¢f–v‡D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢f–v‡FW$æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢ÖF6„¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢6ÆÆVD6FVv÷'“¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢6ÆÆVEfÇVS¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢ö–çG3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6FVv÷'•F÷FÇ3¢²G—S¢ö&¦V7BÂFVfVÇC¢‚’Óâ‡·Ò’ÒÀ¢66÷&VC¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢6ÆÄ†—C¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢6ÆÄ&öçW3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢ÒÂ²ö–C¢fÇ6RÒ•ÒÀ¢FVfVÇC¢µÒÀ¢ÒÀ¢VçG'”fVU–C¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢F÷FÅö–çG3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢6WGFÆVC¢²G—S¢&ööÆVâÂFVfVÇC¢fÇ6RÒÀ¢–FV×÷FVæ7”¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° §FVÔVçG'•66†VÖæ–æFW‚‡²6öçFW7D–C¢ÂW6W$–C¢ÒÂ²Væ—VS¢G'VRÒ“°§FVÔVçG'•66†VÖæ–æFW‚‡²6öçFW7D–C¢Âw–6·2æf–v‡D–Bs¢Ò“° ¦6öç7BFVÔ6öçFW7BÒÖöævö÷6RæÖöFVÇ2åFVÔ6öçFW7BÇÂÖöævö÷6RæÖöFVÂ‚uFVÔ6öçFW7BrÂFVÔ6öçFW7E66†VÖ“°¦6öç7BFVÔVçG'’ÒÖöævö÷6RæÖöFVÇ2åFVÔVçG'’ÇÂÖöævö÷6RæÖöFVÂ‚uFVÔVçG'’rÂFVÔVçG'•66†VÖ“° ¦6öç7B&WV—&UFVÔ6&G2Ò‡&WÂ&W2ÂæW‡B’Óâ°¢–b‚DTÕô4$E5ôTä$ÄTB’°¢&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uFVÒ6&G2&Ræ÷B÷Vâ–WBârÂ6öFS¢tdTEU$UôD•4$ÄTBrÒ“°¢Ð¢&WGW&âæW‡B‚“°§Ó° ¦6öç7BFVÔW'&÷"Ò‡7FGW2ÂÖW76vRÂ6öFRÂW‡G&Ò·Ò’Óâ°¢6öç7BW'&÷"ÒæWrW'&÷"†ÖW76vR“°¢W'&÷"ç7FGW2Ò7FGW3°¢W'&÷"æ6öFRÒ6öFS°¢W'&÷"æW‡G&ÒW‡G&°¢&WGW&âW'&÷#°§Ó° ¢òò7&VF—G2WfW'’FVÒVçG'’†öÆF–ærV—F†W"f–v‡FW"g&öÒ6WGFÆVB&÷WBâ6ÆÆV@¢òòg&öÒF†R6ÖR6WGFÆVÖVçBF†B66÷&W2F†Rf–v‡BÂöfbF†R6ÖRöff–6–Â7FG2à¦6öç7B7&VF—EFVÔVçG&–W2Ò7–æ2†f–v‡BÂöæU7FG2ÂGvõ7FG2’Óâ°¢–b‚DTÕô4$E5ôTä$ÄTB’&WGW&â²7&VF—FVC¢Ó°¢6öç7Bf–v‡D–BÒ7G&–ær†f–v‡Còåö–BÇÂrr“°¢–b‚f–v‡D–B’&WGW&â²7&VF—FVC¢Ó° ¢6öç7B6öçFW7G2Òv—BFVÔ6öçFW7Bæf–æB‡°¢f–v‡D–G3¢f–v‡D–BÀ¢7FGW3¢²F–ã¢²tõTârÂtÄô4´TBuÒÒÀ¢Ò’ç6VÆV7B‚uö–Br’æÆVâ‚“°¢–b‚6öçFW7G2æÆVæwF‚’&WGW&â²7&VF—FVC¢Ó° ¢6öç7BfÖ–Ç’Ò6V6öäfÖ–Ç”f÷$6FVv÷'’†f–v‡CòæÖF6„6FVv÷'’“°¢6öç7B6–FW2Ò°¢²æÖS¢f–v‡CòæÖF6„f–v‡FW$Â&÷VæG3¢öæU7FG2ÒÀ¢²æÖS¢f–v‡CòæÖF6„f–v‡FW$"Â&÷VæG3¢Gvõ7FG2ÒÀ¢Ó°¢ÆWB7&VF—FVBÒ° ¢f÷"†6öç7B6öçFW7Böb6öçFW7G2’°¢6öç7BVçG&–W2Òv—BFVÔVçG'’æf–æB‡²6öçFW7D–C¢7G&–ær†6öçFW7Båö–B’Â6WGFÆVC¢fÇ6RÂw–6·2æf–v‡D–Bs¢f–v‡D–BÒ“°¢f÷"†6öç7BVçG'’öbVçG&–W2’°¢ÆWBF÷V6†VBÒfÇ6S°¢VçG'’ç–6·2æf÷$V6‚‚‡–6²’Óâ°¢–b…7G&–ær‡–6²æf–v‡D–B’ÓÒf–v‡D–BÇÂ–6²ç66÷&VB’&WGW&ã°¢6öç7B6–FRÒ6–FW2æf–æB‚†6æF–FFR’Óâf–v‡FW$ÖF6„¶W’†6æF–FFRææÖR’ÓÓÒ–6²æÖF6„¶W’“°¢–b‚6–FR’&WGW&ã°¢6öç7B²ö–çG2ÂF÷FÇ2ÒÒf–v‡FW$÷WGWDg&öÕ&÷VæG2‡6–FRç&÷VæG2ÂfÖ–Ç’“°¢–6²çö–çG2Òö–çG3°¢–6²æ6FVv÷'•F÷FÇ2ÒF÷FÇ3°¢–6²ç66÷&VBÒG'VS°¢F÷V6†VBÒG'VS°¢Ò“°¢–b‡F÷V6†VB’°¢VçG'’æÖ&´ÖöF–f–VB‚w–6·2r“°¢v—BVçG'’ç6fR‚“°¢7&VF—FVB³Ò°¢Ð¢Ð¢Ð¢&WGW&â²7&VF—FVBÓ°§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòTåDU"(	BöæRf–v‡FW"W"&÷WBÂ6†&vVBF‡&÷Vv‚F†R6ÖRG&ç67F–öâ2f–v‡@¢òòVçG'’6òF†RÖöæW’F‚—2F†RöæRÇ&VG’†&FVæVBà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’÷FVÒÖ6öçFW7G2ó¦6öçFW7D–BöVçFW"rÂ&WV—&UFVÔ6&G2Â7V&Ö—DÆ–Ö—FW"ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B6öçFW7D–BÒ7G&–ær‡&Wç&×2æ6öçFW7D–BÇÂrr’çG&–Ò‚“°¢6öç7B7V&Ö—GFVBÒ'&’æ—4'&’‡&Wæ&öG“òç–6·2’ò&Wæ&öG’ç–6·2¢µÓ° ¢6öç7B&W7VÇBÒv—B'Väf–v‡DVçG'•G&ç67F–öâ†7–æ2‡6W76–öâ’Óâ°¢6öç7B6öçFW7BÒv—Bv—F„f–v‡E6W76–öâ…FVÔ6öçFW7Bæf–æD'”–B†6öçFW7D–B’Â6W76–öâ“°¢–b‚6öçFW7B’F‡&÷rFVÔW'&÷"ƒCBÂt6öçFW7Bæ÷Bf÷VæBârÂt4ôåDU5EôäõEôdõTäBr“°¢–b†6öçFW7Bç7FGW2ÓÒtõTâr’°¢F‡&÷rFVÔW'&÷"ƒC’ÂuF†—26öçFW7B—26Æ÷6VBf÷"VçG'’ârÂt4ôåDU5Eô4Äõ4TBr“°¢Ð ¢6öç7BW6W"Òv—Bv—F„f–v‡E6W76–öâ€¢W6W"æf–æD'”–B‡W6W$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRFFTöd&—'F‚&W6–FVæ6U7FFR6VÆdW†6ÇVFVEVçF–ÂFö¶Vç2r’À¢6W76–öâÀ¢“°¢–b‚W6W"’F‡&÷rFVÔW'&÷"ƒCBÂt66÷VçBæ÷Bf÷VæBârÂuU4U%ôäõEôdõTäBr“°¢6öç7B&Æö6¶VBÒ6†V6µÆ”VÆ–v–&–Æ—G’‡W6W"“°¢–b†&Æö6¶VB’F‡&÷rFVÔW'&÷"ƒC2Â&Æö6¶VBæÖW76vRÂ&Æö6¶VBæ6öFR“° ¢6öç7BfVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†6öçFW7BæVçG'”fVR’ÇÂ’“°¢–b†fVRâbb&W6öÇfU7FFTÖöFR‡W6W"ç&W6–FVæ6U7FFR’ÓÒw–Br’°¢F‡&÷rFVÔW'&÷"ƒC2Âu–B6öçFW7G2&Ræ÷Bf–Æ&ÆR–â–÷W"7FFRâg&VR6öçFW7G2&RârÂu5DDUôe$TUõÄ•ôôäÅ’r“°¢Ð ¢òò&öÖ÷FW"6ææ÷BVçFW"F†V—"÷vâ6öçFW7BÂÖF6†–ærF†Rf–v‡B'VÆRà¢–b†6öçFW7Bæff–Æ–FT–Bbb7G&–ær†6öçFW7Bæff–Æ–FT–B’ÓÓÒW6W$–B’°¢F‡&÷rFVÔW'&÷"ƒC2Âu–÷R6ææ÷BVçFW"6öçFW7B–÷R&R&öÖ÷F–ærârÂtdd”Ä”DUõ4TÄeôTåE%’r“°¢Ð ¢6öç7B&WV—&VBÒÖF‚æÖ‚ƒ"ÂÖF‚ç&÷VæB„çVÖ&W"†6öçFW7Bç–6·5&WV—&VB’ÇÂDTÕõ”4µ5õ$UT•$TB’“°¢–b‡7V&Ö—GFVBæÆVæwF‚ÓÒ&WV—&VB’°¢F‡&÷rFVÔW'&÷"ƒC#"Â–6²W†7FÇ’G·&WV—&VGÒf–v‡FW'2æÂuu$ôäuõ”4µô4õTåBrÂ²&WV—&VBÒ“°¢Ð ¢òòÆöBWfW'’&÷WBöâF†R6&Böæ6RÂF†VâfÆ–FFRV6‚–6²v–ç7B—Bà¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢6öçFW7Bæf–v‡D–G2æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’’ÒÒ¢ç6VÆV7B‚uö–BÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6…7FGW2ÖF6„6FVv÷'’r’æÆVâ‚“°¢6öç7Bf–v‡D'”–BÒæWrÖ†f–v‡G2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢6öç7B–6·2ÒµÓ°¢6öç7BW6VD&÷WG2ÒæWr6WB‚“°¢f÷"†6öç7B&röb7V&Ö—GFVB’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&sòæf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡FW$æÖRÒ7G&–ær‡&sòæf–v‡FW$æÖRÇÂrr’çG&–Ò‚“°¢6öç7B&÷WBÒf–v‡D'”–BævWB†f–v‡D–B“°¢–b‚&÷WB’F‡&÷rFVÔW'&÷"ƒC#"ÂtöæRöb–÷W"–6·2—2æ÷BöâF†—26&BârÂu”4µôäõEôôåô4$BrÂ²f–v‡D–BÒ“°¢–b‚—4f–v‡D÷Väf÷$VçG'’†&÷WB’’°¢F‡&÷rFVÔW'&÷"ƒC’ÂG¶&÷WBæÖF6„f–v‡FW$Òg2G¶&÷WBæÖF6„f–v‡FW$'Ò—2Ç&VG’Æö6¶VBæÂt$õUEôÄô4´TBrÂ²f–v‡D–BÒ“°¢Ð¢òòD„R%TÄS¢öæRf–v‡FW"W"&÷WBÂ6òÆ–W"6ææ÷B&6²&÷F‚6–FW2à¢–b‡W6VD&÷WG2æ†2†f–v‡D–B’’°¢F‡&÷rFVÔW'&÷"ƒC#"Âu–6²öæRf–v‡FW"W"&÷WB(	B–÷R6ææ÷BF¶R&÷F‚6–FW2öbf–v‡BârÂtEUÄ”4DUô$õUBrÂ²f–v‡D–BÒ“°¢Ð¢6öç7B¶W’Òf–v‡FW$ÖF6„¶W’†f–v‡FW$æÖR“°¢–b‚¶&÷WBæÖF6„f–v‡FW$Â&÷WBæÖF6„f–v‡FW$%ÒæÖ†f–v‡FW$ÖF6„¶W’’æ–æ6ÇVFW2†¶W’’’°¢F‡&÷rFVÔW'&÷"ƒC#"ÂG¶f–v‡FW$æÖWÒ—2æ÷B–âF†B&÷WBæÂtd”t…DU%ôäõEô”åô$õUBrÂ²f–v‡D–BÒ“°¢Ð¢W6VD&÷WG2æFB†f–v‡D–B“° ¢6öç7BfÖ–Ç’Ò6V6öäfÖ–Ç”f÷$6FVv÷'’†&÷WBæÖF6„6FVv÷'’“°¢6öç7BÆÆ÷vVBÒ4T4ôåô4ÄÅô4DTtõ$”U5¶fÖ–Ç•ÒÇÂ·Ó°¢6öç7B6ÆÆVD6FVv÷'’Ò7G&–ær‡&sòæ6ÆÆVD6FVv÷'’ÇÂrr’çG&–Ò‚’çFõWW$66R‚“°¢6öç7B6ÆÆVEfÇVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&sòæ6ÆÆVEfÇVR’ÇÂ’“°¢–b†6ÆÆVD6FVv÷'’bbÆÆ÷vVE¶6ÆÆVD6FVv÷'•Ò’°¢F‡&÷rFVÔW'&÷"ƒC#"ÂG¶6ÆÆVD6FVv÷'—Ò—2æ÷B6FVv÷'’f÷"F†B&÷WBæÂt$Eô4ÄÅô4DTtõ%’r“°¢Ð ¢–6·2çW6‚‡°¢f–v‡D–BÀ¢f–v‡FW$æÖS¢f–v‡FW$æÖRç6Æ–6RƒÂ#’À¢ÖF6„¶W“¢¶W’À¢6ÆÆVD6FVv÷'“¢6ÆÆVD6FVv÷'’bb6ÆÆVEfÇVRâò6ÆÆVD6FVv÷'’¢rrÀ¢6ÆÆVEfÇVS¢6ÆÆVD6FVv÷'’bb6ÆÆVEfÇVRâò6ÆÆVEfÇVR¢À¢Ò“°¢Ð ¢6öç7BW†—7F–ærÒv—Bv—F„f–v‡E6W76–öâ…FVÔVçG'’æf–æDöæR‡²6öçFW7D–BÂW6W$–BÒ’Â6W76–öâ’æÆVâ‚“°¢–b†W†—7F–ær’F‡&÷rFVÔW'&÷"ƒC’Âu–÷RÇ&VG’†fRFVÒ–âF†—26öçFW7BârÂtÅ$TE•ôTåDU$TBr“° ¢–b†fVRâ’°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢–b†&Vf÷&RÂfVR’°¢F‡&÷rFVÔW'&÷"ƒC"Âtæ÷BVæ÷Vv‚dÒ6ö–ç2f÷"F†—26öçFW7BârÂt”å5Tdd”4”TåEôeTäE2rÂ°¢&Ææ6S¢&Vf÷&RÂVçG'”fVS¢fVRÂ6†÷'FfÆÃ¢fVRÒ&Vf÷&RÀ¢Ò“°¢Ð¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&RÒfVR“°¢v—BW6W"ç6fR‡²6W76–öâÒ“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–BÂÖ÷VçC¢ÖfVRÂ&Ææ6T&Vf÷&S¢&Vf÷&RÂ&Ææ6TgFW#¢&Vf÷&RÒfVRÀ¢&V6öã¢wFVÕöVçG'’rÂ&VfW&Væ6S¢FVÓ¢G¶6öçFW7D–GÓ¢G·W6W$–GÖÀ¢ÖWF¢²6öçFW7D–BÂ6öçFW7DæÖS¢6öçFW7BææÖRÒÂ6W76–öâÀ¢Ò“°¢v—BFVÔ6öçFW7BçWFFTöæR‡²ö–C¢6öçFW7D–BÒÂ²F–æ3¢²&—¦UööÃ¢fVRÒÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“°¢Ð ¢6öç7B¶VçG'•ÒÒv—BFVÔVçG'’æ7&VFR…·°¢6öçFW7D–BÂW6W$–BÂ–6·2ÂVçG'”fVU–C¢fVRÀ¢–FV×÷FVæ7”¶W“¢FVÓ¢G¶6öçFW7D–GÓ¢G·W6W$–GÖÀ¢ÕÒÂ6W76–öâò²6W76–öâÒ¢VæFVf–æVB“° ¢&WGW&â²VçG'’Â6öçFW7BÂW6W"ÂfVRÓ°¢Ò“° ¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢&W7VÇBçW6W"æVÖ–ÂÀ¢7V&¦V7C¢–÷W"FVÒ—2–â(	BG·&W7VÇBæ6öçFW7BææÖWÖÀ¢†VF–æs¢uDTÒÄô4´TB”ârÀ¢Æ–æW3¢°¢–÷W"G·&W7VÇBæVçG'’ç–6·2æÆVæwF‡Òf–v‡FW'2&R6WBf÷"Ç7G&öæsâG¶W66T‡FÖÂ‡&W7VÇBæ6öçFW7BææÖR—ÓÂ÷7G&öæsâæÀ¢&W7VÇBæVçG'’ç–6·2æÖ‚‡–6²’ÓâÇ7G&öæsâG¶W66T‡FÖÂ‡–6²æf–v‡FW$æÖR—ÓÂ÷7G&öæsâG·–6²æ6ÆÆVD6FVv÷'’ò(	B6ÆÆVBG·–6²æ6ÆÆVEfÇVWÖ¢rwÖ’æ¦ö–â‚sÆ'#âr’À¢&W7VÇBæfVRâòVçG'“¢G·&W7VÇBæfVRçFôÆö6ÆU7G&–ær‚—ÒdÒæ¢tg&VRVçG'’ârÀ¢u–÷W"66÷&R—2v†BÆÂöbF†VÒFòöâF†Ræ–v‡BÂFFVBFövWF†W"ârÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡°¢ö³¢G'VRÀ¢VçG'”–C¢&W7VÇBæVçG'’åö–BÀ¢6öçFW7DæÖS¢&W7VÇBæ6öçFW7BææÖRÀ¢–6·3¢&W7VÇBæVçG'’ç–6·2æÖ‚‡–6²’Óâ‡°¢f–v‡D–C¢–6²æf–v‡D–BÂf–v‡FW$æÖS¢–6²æf–v‡FW$æÖRÀ¢6ÆÆVD6FVv÷'“¢–6²æ6ÆÆVD6FVv÷'’Â6ÆÆVEfÇVS¢–6²æ6ÆÆVEfÇVRÀ¢Ò’’À¢VçG'”fVU–C¢&W7VÇBæfVRÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç7B7FGW2ÒW'&÷#òç7FGW2ÇÂS°¢–b‡7FGW2ãÒS’6öç6öÆRæW'&÷"‚uFVÒVçG'’f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2‡7FGW2’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢W'&÷#òæÖW76vRÇÂt6÷VÆBæ÷BÆö6²–âF†BFVÒârÀ¢6öFS¢W'&÷#òæ6öFRÇÂuDTÕôTåE%•ôd”ÄTBrÀ¢âââ†W'&÷#òæW‡G&ÇÂ·Ò’À¢Ò“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò4UEDÄTÔTåB(	BÆ–âF÷FÂÂ&V6W6RWfW'’f–v‡FW"v266÷&VB'’F†R6ÖP¢òò'VÆW2â6Æ–ÖVBFöÖ–6ÆÇ’&Vf÷&Rç’ÖöæW’Ö÷fW2à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B6WGFÆUFVÔ6öçFW7BÒ7–æ2†6öçFW7D–B’Óâ°¢6öç7B6Æ–ÖVBÒv—BFVÔ6öçFW7Bæf–æDöæTæEWFFR€¢²ö–C¢6öçFW7D–BÂ7FGW3¢²F–ã¢²tõTârÂtÄô4´TBuÒÒÒÀ¢²G6WC¢²7FGW3¢u4UEDÄTBrÂ6WGFÆVDC¢æWrFFR‚’ÒÒÀ¢²æWs¢G'VRÒÀ¢“°¢–b‚6Æ–ÖVB’°¢6öç7B7W'&VçBÒv—BFVÔ6öçFW7Bæf–æD'”–B†6öçFW7D–B’ç6VÆV7B‚w7FGW26WGFÆVDBr’æÆVâ‚“°¢&WGW&â²Ç&VG•6WGFÆVC¢G'VRÂ7FGW3¢7W'&VçCòç7FGW2ÇÂçVÆÂÓ°¢Ð ¢6öç7BVçG&–W2Òv—BFVÔVçG'’æf–æB‡²6öçFW7D–C¢7G&–ær†6öçFW7D–B’Ò“°¢–b‚VçG&–W2æÆVæwF‚’&WGW&â²6WGFÆVC¢ÂVçG&çG3¢Ó° ¢f÷"†6öç7BVçG'’öbVçG&–W2’°¢ÆWBF÷FÂÒ°¢VçG'’ç–6·2æf÷$V6‚‚‡–6²’Óâ°¢6öç7B7GVÂÒçVÖ&W"‚‡–6²æ6FVv÷'•F÷FÇ2ÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•Ò’ÇÂ°¢6öç7B†—BÒ&ööÆVâ‡–6²æ6ÆÆVD6FVv÷'’’bb–6²æ6ÆÆVEfÇVRâbb–6²æ6ÆÆVEfÇVRÃÒ7GVÃ°¢–6²æ6ÆÄ†—BÒ†—C°¢–6²æ6ÆÄ&öçW2Ò†—BòÖF‚æÖ–â‡–6²æ6ÆÆVEfÇVRÂDTÕô4ÄÅô$ôåU5ô4’¢°¢F÷FÂ³Ò–6²çö–çG2²–6²æ6ÆÄ&öçW3°¢Ò“°¢VçG'’çF÷FÅö–çG2ÒF÷FÃ°¢VçG'’ç6WGFÆVBÒG'VS°¢VçG'’æÖ&´ÖöF–f–VB‚w–6·2r“°¢v—BVçG'’ç6fR‚“°¢Ð ¢6öç7B66÷&VBÒVçG&–W0¢æÖ‚†VçG'’’Óâ‡²W6W$–C¢7G&–ær†VçG'’çW6W$–B’Âö–çG3¢VçG'’çF÷FÅö–çG2Ò’¢ç6÷'B‚†Â"’Óâ"çö–çG2Òçö–çG2“° ¢òò6–ævÆR–BVçG&çB†2æòf–VÆBFò&VBÂ6òF†RVçG'’vöW2&6²&F†W ¢òòF†â&—¦R&V–ær–B÷WBöbF†V—"÷vâÖöæW’à¢6öç7B–BÒVçG&–W2æf–ÇFW"‚†VçG'’’ÓâçVÖ&W"†VçG'’æVçG'”fVU–B’â“°¢ÆWB&VgVæFVDæôf–VÆBÒfÇ6S°¢–b‡–BæÆVæwF‚ÓÓÒ’°¢&VgVæFVDæôf–VÆBÒG'VS°¢6öç7B6öÆòÒ–E³Ó°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B‡6öÆòçW6W$–B’ç6VÆV7B‚wFö¶Vç2VÖ–Âr“°¢–b‡W6W"’°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&R²6öÆòæVçG'”fVU–B“°¢v—BW6W"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢6öÆòçW6W$–BÂÖ÷VçC¢6öÆòæVçG'”fVU–BÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²6öÆòæVçG'”fVU–BÂ&V6öã¢wFVÕ÷&VgVæEöæõöf–VÆBrÀ¢&VfW&Væ6S¢FVÓ§6öÆò×&VgVæC¢G¶6öçFW7D–GÓ¢G·6öÆòçW6W$–GÖÀ¢ÖWF¢²6öçFW7D–C¢7G&–ær†6öçFW7D–B’ÒÀ¢Ò“°¢–b‡W6W"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢G¶6Æ–ÖVBææÖWÒ(	B&VgVæFVBÂæ÷BVæ÷Vv‚VçG&çG6À¢†VF–æs¢t4ôåDU5B$TeTäDTBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†6Æ–ÖVBææÖR—ÓÂ÷7G&öæsâf–æ—6†VBv—F‚öæÇ’öæR–BFVÒÂ6òF†W&Rv2æòf–VÆBFò66÷&Rv–ç7BæÀ¢–÷W"G·6öÆòæVçG'”fVU–BçFôÆö6ÆU7G&–ær‚—ÒdÒVçG'’†2&VVâ&WGW&æVB–âgVÆÂæÀ¢ÒÀ¢Ò“°¢Ð¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6öÆòÖVçG&çBFVÒ&VgVæBf–ÆVC¢rÂW'&÷"“°¢Ð¢Ð ¢ÆWB–÷WBÒçVÆÃ°¢6öç7B&—¦UööÂÒ&VgVæFVDæôf–VÆBò¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†6Æ–ÖVBç&—¦UööÂ’ÇÂ’“°¢–b‡&VgVæFVDæôf–VÆB’–÷WBÒ²&—¦UööÃ¢Â–C¢Â&VgVæFVC¢G'VRÓ°¢–b‡&—¦UööÂâ’°¢6öç7B²v&G2ÒÒ'V–ÆE&—¦Tv&G2‡66÷&VBÂ&—¦UööÂ“°¢ÆWBF÷FÅ–BÒ°¢f÷"†6öç7Bv&Böbv&G2’°¢–b‚v&CòæÖ÷VçBÇÂv&BæÖ÷VçBÃÒ’6öçF–çVS°¢6öç7Bv–ææW"Òv—BW6W"æf–æD'”–B†v&BçW6W$–B’ç6VÆV7B‚vVÖ–ÂFö¶Vç2r“°¢–b‚v–ææW"’6öçF–çVS°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡v–ææW"çFö¶Vç2“°¢v–ææW"çFö¶Vç2Ò7G&–ær†&Vf÷&R²v&BæÖ÷VçB“°¢v—Bv–ææW"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢v&BçW6W$–BÂÖ÷VçC¢v&BæÖ÷VçBÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²v&BæÖ÷VçBÂ&V6öã¢wFVÕ÷&—¦RrÀ¢&VfW&Væ6S¢FVÓ§&—¦S¢G¶6öçFW7D–GÓ¢G¶v&BçW6W$–GÖÀ¢ÖWF¢²6öçFW7D–BÂÆ6S¢v&BçÆ6RÒÀ¢Ò“°¢F÷FÅ–B³Òv&BæÖ÷VçC°¢–b‡v–ææW"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢v–ææW"æVÖ–ÂÀ¢7V&¦V7C¢G¶6Æ–ÖVBææÖWÒ(	B–÷Rf–æ—6†VB2G¶v&BçÆ6WÖÀ¢†VF–æs¢DTÒ$U5TÅB+r2G¶v&BçÆ6WÖÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†6Æ–ÖVBææÖR—ÓÂ÷7G&öæsâ†2&VVâ6WGFÆVBæÀ¢Ç7G&öæsâG¶v&BæÖ÷VçBçFôÆö6ÆU7G&–ær‚—ÒdÓÂ÷7G&öæsâ†2&VVâFFVBFò–÷W"vÆÆWBæÀ¢ÒÀ¢Ò“°¢Ð¢Ð¢–÷WBÒ²&—¦UööÂÂ–C¢F÷FÅ–BÓ°¢Ð ¢ÆWBv&G4v—fVâÒçVÆÃ°¢G'’°¢v&G4v—fVâÒv—Bv&Dæöä66…&—¦W2†6öçFW7D–BÂ66÷&VBÂ²ÖF6„f–v‡FW$¢6Æ–ÖVBææÖRÂÖF6„f–v‡FW$#¢uFVÒ6&BrÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒæöâÖ66‚v&G2f–ÆVC¢rÂW'&÷"“°¢v&G4v—fVâÒ²W'&÷#¢tt$E5ôd”ÄTBrÓ°¢Ð ¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢&WGW&â²6WGFÆVC¢VçG&–W2æÆVæwF‚ÂVçG&çG3¢VçG&–W2æÆVæwF‚Â–÷WBÂv&G4v—fVâÓ°§Ó° ¦ç÷7B‚rö’öFÖ–â÷FVÒÖ6öçFW7G2ó¦6öçFW7D–B÷6WGFÆRrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆUFVÔ6öçFW7B…7G&–ær‡&Wç&×2æ6öçFW7D–BÇÂrr’çG&–Ò‚’“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒ6WGFÆRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6WGFÆRF†B6öçFW7BârÒ“°¢Ð§Ò“° ¢òòWFò×6WGFÆW26&Böæ6RWfW'’&÷WBöâ—B†2&VVâ66÷&VBÂ6òF†R&W7VÇBÆæG0¢òòF†R6ÖRæ–v‡B&F†W"F†âv—F–ærf÷"âFÖ–âFò&VÖVÖ&W"à¦ævWB‚rö’ö7&öâ÷FVÒÖ6öçFW7G2÷6WGFÆRrÂfW&–g”7&öå6V7&WBÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÆ—fRÒv—BFVÔ6öçFW7Bæf–æB‡²7FGW3¢²F–ã¢²tõTârÂtÄô4´TBuÒÒÒ’ç6VÆV7B‚uö–BæÖRf–v‡D–G2r’æÆ–Ö—BƒC’æÆVâ‚“°¢6öç7B6WGFÆVBÒµÓ°¢f÷"†6öç7B6öçFW7BöbÆ—fR’°¢6öç7B–G2Ò†6öçFW7Bæf–v‡D–G2ÇÂµÒ’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢–b‚–G2æÆVæwF‚’6öçF–çVS°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢–G2ÒÒ’ç6VÆV7B‚w&—¦W56WGFÆVDBr’æÆVâ‚“°¢òòWfW'’&÷WB×W7B&R6WGFÆVB(	B'F–Â6&Bv÷VÆB66÷&Râ–æ6ö×ÆWFRFVÒà¢–b†f–v‡G2æÆVæwF‚ÓÒ–G2æÆVæwF‚ÇÂf–v‡G2æWfW'’‚†f–v‡B’Óâf–v‡Bç&—¦W56WGFÆVDB’’6öçF–çVS°¢G'’°¢6öç7B7VÖÖ'’Òv—B6WGFÆUFVÔ6öçFW7B…7G&–ær†6öçFW7Båö–B’“°¢6WGFÆVBçW6‚‡²–C¢6öçFW7Båö–BÂæÖS¢6öçFW7BææÖRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒWFò×6WGFÆRf–ÆVBf÷"rÂ7G&–ær†6öçFW7Båö–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂW†Ö–æVC¢Æ—fRæÆVæwF‚Â6WGFÆVBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒ6WGFÆR7vVWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uFVÒ7vVWf–ÆVBârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòDÔ”â²$ôÔõDU ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–â÷FVÒÖ6öçFW7G2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–G2Ò„'&’æ—4'&’‡&Wæ&öG“òæf–v‡D–G2’ò&Wæ&öG’æf–v‡D–G2¢µÒ¢æÖ‚†–B’Óâ7G&–ær†–B’çG&–Ò‚’’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢–b‚æÖR’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6öçFW7BæÖR—2&WV—&VBârÒ“° ¢6öç7B–6·5&WV—&VBÒÖF‚æÖ‚ƒ"ÂÖF‚æÖ–âƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òç–6·5&WV—&VB’ÇÂDTÕõ”4µ5õ$UT•$TB’’“°¢òòF†RöæRÖf–v‡FW"×W"Ö&÷WB'VÆRÖVç2F†R6&BæVVG2BÆV7B2Öç’&÷WG0¢òò2–6·2Â÷"F†R6öçFW7B—2–×÷76–&ÆRFòVçFW"à¢–b†f–v‡D–G2æÆVæwF‚Â–6·5&WV—&VB’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢G·–6·5&WV—&VGÒ×–6²6öçFW7BæVVG2BÆV7BG·–6·5&WV—&VGÒ&÷WG2öâF†R6&BæÀ¢6öFS¢täõEôTäõTt…ô$õUE2rÀ¢Ò“°¢Ð ¢6öç7B6öçFW7BÒv—BFVÔ6öçFW7Bæ7&VFR‡°¢æÖS¢æÖRç6Æ–6RƒÂ#’À¢WfVçDæÖS¢7G&–ær‡&Wæ&öG“òæWfVçDæÖRÇÂrr’ç6Æ–6RƒÂ#’À¢f–v‡D–G3¢²ââææWr6WB†f–v‡D–G2•ÒÀ¢–6·5&WV—&VBÀ¢VçG'”fVS¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæVçG'”fVR’ÇÂ’’À¢ff–Æ–FT–C¢7G&–ær‡&Wæ&öG“òæff–Æ–FT–BÇÂrr’çG&–Ò‚’À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ6öçFW7D–C¢6öçFW7Båö–BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒ6öçFW7B7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7&VFRF†B6öçFW7BârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–â÷FVÒÖ6öçFW7G2ó¦6öçFW7D–B÷fö–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6öçFW7BÒv—BFVÔ6öçFW7Bæf–æD'”–B…7G&–ær‡&Wç&×2æ6öçFW7D–BÇÂrr’’æÆVâ‚“°¢–b‚6öçFW7B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6öçFW7Bæ÷Bf÷VæBârÒ“°¢–b†6öçFW7Bç7FGW2ÓÓÒu4UEDÄTBr’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B6öçFW7B—2Ç&VG’6WGFÆVBârÒ“°¢Ð¢6öç7BVçG&–W2Òv—BFVÔVçG'’æf–æB‡²6öçFW7D–C¢7G&–ær†6öçFW7Båö–B’ÂVçG'”fVU–C¢²FwC¢ÒÒ’æÆVâ‚“°¢f÷"†6öç7BVçG'’öbVçG&–W2’°¢G'’°¢6öç7BW6W"Òv—BW6W"æf–æD'”–B†VçG'’çW6W$–B’ç6VÆV7B‚wFö¶Vç2VÖ–Âr“°¢–b‚W6W"’6öçF–çVS°¢6öç7B&Vf÷&RÒf–v‡EFö¶Vä&Ææ6R‡W6W"çFö¶Vç2“°¢W6W"çFö¶Vç2Ò7G&–ær†&Vf÷&R²VçG'’æVçG'”fVU–B“°¢v—BW6W"ç6fR‚“°¢v—B&V6÷&EvÆÆWDÖ÷fR‡°¢W6W$–C¢VçG'’çW6W$–BÂÖ÷VçC¢VçG'’æVçG'”fVU–BÂ&Ææ6T&Vf÷&S¢&Vf÷&RÀ¢&Ææ6TgFW#¢&Vf÷&R²VçG'’æVçG'”fVU–BÂ&V6öã¢wFVÕ÷&VgVæBrÀ¢&VfW&Væ6S¢FVÓ§&VgVæC¢G¶6öçFW7Båö–GÓ¢G¶VçG'’çW6W$–GÖÀ¢ÖWF¢²6öçFW7D–C¢7G&–ær†6öçFW7Båö–B’ÒÀ¢Ò“°¢–b‡W6W"æVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢W6W"æVÖ–ÂÀ¢7V&¦V7C¢G¶6öçFW7BææÖWÒv26æ6VÆÆVB(	B–÷R†fR&VVâ&VgVæFVFÀ¢†VF–æs¢t4ôåDU5B4ä4TÄÄTBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†6öçFW7BææÖR—ÓÂ÷7G&öæsâ†2&VVâ6æ6VÆÆVBæÀ¢–÷W"G¶VçG'’æVçG'”fVU–BçFôÆö6ÆU7G&–ær‚—ÒdÒVçG'’†2&VVâ&WGW&æVB–âgVÆÂæÀ¢ÒÀ¢Ò“°¢Ð¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒ&VgVæBf–ÆVBf÷"rÂ7G&–ær†VçG'’çW6W$–B’ÂW'&÷"æÖW76vR“°¢Ð¢Ð¢v—BFVÔ6öçFW7BçWFFTöæR‡²ö–C¢6öçFW7Båö–BÒÂ°¢G6WC¢²7FGW3¢udô”BrÂfö–E&V6öã¢7G&–ær‡&Wæ&öG“òç&V6öâÇÂt6æ6VÆÆVB'’âFÖ–æ—7G&F÷"âr’ç6Æ–6RƒÂ3’ÒÀ¢Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&VgVæFVC¢VçG&–W2æÆVæwF‚Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒfö–Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6æ6VÂF†B6öçFW7BârÒ“°¢Ð§Ò“° ¢òò&öÖ÷FW"'Vç2FVÒ6&Bf÷"F†V—"÷vâÆVwVRà¦ç÷7B‚rö’öff–Æ–FW2öÖR÷FVÒÖ6öçFW7G2rÂ&WV—&UFVÔ6&G2ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B’ç6VÆV7B‚uö–BfW&–f–VBr’æÆVâ‚“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tff–Æ–FR66÷VçBæ÷Bf÷VæBârÒ“°¢–b‚ff–Æ–FRçfW&–f–VB’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u–÷W"ÆVwVR×W7B&R&÷fVB&Vf÷&R–÷R6â'Vâ6öçFW7G2ârÂ6öFS¢täõEõdU$”d”TBrÒ“°¢Ð ¢6öç7BæÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“°¢6öç7Bf–v‡D–G2Ò„'&’æ—4'&’‡&Wæ&öG“òæf–v‡D–G2’ò&Wæ&öG’æf–v‡D–G2¢µÒ¢æÖ‚†–B’Óâ7G&–ær†–B’çG&–Ò‚’’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7B–6·5&WV—&VBÒÖF‚æÖ‚ƒ"ÂÖF‚æÖ–âƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òç–6·5&WV—&VB’ÇÂDTÕõ”4µ5õ$UT•$TB’’“°¢–b‚æÖR’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæÖR–÷W"6öçFW7BârÒ“°¢–b†f–v‡D–G2æÆVæwF‚Â–6·5&WV—&VB’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢–6²BÆV7BG·–6·5&WV—&VGÒ&÷WG2f÷"G·–6·5&WV—&VGÒ×–6²6öçFW7BæÂ6öFS¢täõEôTäõTt…ô$õUE2rÒ“°¢Ð ¢6öç7B6öçFW7BÒv—BFVÔ6öçFW7Bæ7&VFR‡°¢æÖS¢æÖRç6Æ–6RƒÂ#’À¢WfVçDæÖS¢7G&–ær‡&Wæ&öG“òæWfVçDæÖRÇÂrr’ç6Æ–6RƒÂ#’À¢f–v‡D–G3¢²ââææWr6WB†f–v‡D–G2•ÒÀ¢–6·5&WV—&VBÀ¢VçG'”fVS¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òæVçG'”fVR’ÇÂ’’À¢ff–Æ–FT–BÀ¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ6öçFW7D–C¢6öçFW7Båö–BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&öÖ÷FW"FVÒ6öçFW7B7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7&VFRF†B6öçFW7BârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòÄ”U"$TE0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’÷FVÒÖ6öçFW7G2ö÷VârÂ&WV—&UFVÔ6&G2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6öçFW7G2Òv—BFVÔ6öçFW7Bæf–æB‡²7FGW3¢tõTârÒ’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7BÆÄf–v‡D–G2Ò²ââææWr6WB†6öçFW7G2æfÆDÖ‚†6öçFW7B’Óâ6öçFW7Bæf–v‡D–G2ÇÂµÒ’•Ð¢æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7Bf–v‡G2ÒÆÄf–v‡D–G2æÆVæwF€¢òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢ÆÄf–v‡D–G2ÒÒ¢ç6VÆV7B‚vÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6„6FVv÷'’Ö…&÷VæG2ÖF6…7FGW2r’æÆVâ‚¢¢µÓ°¢6öç7Bf–v‡D'”–BÒæWrÖ†f–v‡G2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢6ÆÄ6FVv÷&–W3¢4T4ôåô4ÄÅô4DTtõ$”U2À¢6ÆÄ&öçW46¢DTÕô4ÄÅô$ôåU5ô4À¢6öçFW7G3¢v—B&öÖ—6RæÆÂ†6öçFW7G2æÖ†7–æ2†6öçFW7B’Óâ‡°¢–C¢6öçFW7Båö–BÀ¢æÖS¢6öçFW7BææÖRÀ¢WfVçDæÖS¢6öçFW7BæWfVçDæÖRÀ¢VçG'”fVS¢6öçFW7BæVçG'”fVRÀ¢&—¦UööÃ¢6öçFW7Bç&—¦UööÂÀ¢–6·5&WV—&VC¢6öçFW7Bç–6·5&WV—&VBÀ¢&öÖ÷FVC¢&ööÆVâ†6öçFW7Bæff–Æ–FT–B’À¢VçG&çG3¢v—BFVÔVçG'’æ6÷VçDFö7VÖVçG2‡²6öçFW7D–C¢7G&–ær†6öçFW7Båö–B’Ò’À¢&÷WG3¢†6öçFW7Bæf–v‡D–G2ÇÂµÒ’æÖ‚†–B’Óâ°¢6öç7B&÷WBÒf–v‡D'”–BævWB…7G&–ær†–B’“°¢–b‚&÷WB’&WGW&âçVÆÃ°¢&WGW&â°¢f–v‡D–C¢7G&–ær†–B’À¢f–v‡FW$¢&÷WBæÖF6„f–v‡FW$À¢f–v‡FW$#¢&÷WBæÖF6„f–v‡FW$"À¢6FVv÷'“¢&÷WBæÖF6„6FVv÷'’À¢&÷VæG3¢&÷WBæÖ…&÷VæG2À¢FFS¢&÷WBæÖF6„FFRÀ¢÷Vã¢—4f–v‡D÷Väf÷$VçG'’†&÷WB’À¢Ó°¢Ò’æf–ÇFW"„&ööÆVâ’À¢Ò’’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒ6öçFW7BÆ—7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB6öçFW7G2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷FVÒÖ6öçFW7G2öÖRrÂ&WV—&UFVÔ6&G2ÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2åÄ”U"’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7BVçG&–W2Òv—BFVÔVçG'’æf–æB‡²W6W$–BÒ’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ3’æÆVâ‚“°¢6öç7B6öçFW7D–G2Ò²ââææWr6WB†VçG&–W2æÖ‚†VçG'’’ÓâVçG'’æ6öçFW7D–B’•Òæf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7B6öçFW7G2Ò6öçFW7D–G2æÆVæwF‚òv—BFVÔ6öçFW7Bæf–æB‡²ö–C¢²F–ã¢6öçFW7D–G2ÒÒ’æÆVâ‚’¢µÓ°¢6öç7B'”–BÒæWrÖ†6öçFW7G2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢FV×3¢VçG&–W2æÖ‚†VçG'’’Óâ°¢6öç7B6öçFW7BÒ'”–BævWB…7G&–ær†VçG'’æ6öçFW7D–B’“°¢&WGW&â°¢VçG'”–C¢VçG'’åö–BÀ¢6öçFW7D–C¢VçG'’æ6öçFW7D–BÀ¢6öçFW7DæÖS¢6öçFW7CòææÖRÇÂuFVÒ6&BrÀ¢WfVçDæÖS¢6öçFW7CòæWfVçDæÖRÇÂrrÀ¢7FGW3¢6öçFW7Còç7FGW2ÇÂtõTârÀ¢VçG'”fVU–C¢VçG'’æVçG'”fVU–BÀ¢F÷FÅö–çG3¢VçG'’çF÷FÅö–çG2À¢6WGFÆVC¢VçG'’ç6WGFÆVBÀ¢66÷&VD6÷VçC¢†VçG'’ç–6·2ÇÂµÒ’æf–ÇFW"‚‡–6²’Óâ–6²ç66÷&VB’æÆVæwF‚À¢–6·3¢†VçG'’ç–6·2ÇÂµÒ’æÖ‚‡–6²’Óâ‡°¢f–v‡FW$æÖS¢–6²æf–v‡FW$æÖRÀ¢ö–çG3¢–6²çö–çG2À¢66÷&VC¢–6²ç66÷&VBÀ¢6ÆÆVD6FVv÷'“¢–6²æ6ÆÆVD6FVv÷'’À¢6ÆÆVEfÇVS¢–6²æ6ÆÆVEfÇVRÀ¢7GVÃ¢çVÖ&W"‚‡–6²æ6FVv÷'•F÷FÇ2ÇÂ·Ò•·–6²æ6ÆÆVD6FVv÷'•Ò’ÇÂÀ¢6ÆÄ†—C¢–6²æ6ÆÄ†—BÀ¢6ÆÄ&öçW3¢–6²æ6ÆÄ&öçW2À¢Ò’’À¢Ó°¢Ò’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒÆöö·Wf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"FV×2ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’÷FVÒÖ6öçFW7G2ó¦6öçFW7D–BöÆVFW&&ö&BrÂ&WV—&UFVÔ6&G2Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B6öçFW7D–BÒ7G&–ær‡&Wç&×2æ6öçFW7D–BÇÂrr’çG&–Ò‚“°¢6öç7BVçG&–W2Òv—BFVÔVçG'’æf–æB‡²6öçFW7D–BÒ’æÆVâ‚“°¢6öç7B6WGFÆVBÒVçG&–W2ç6öÖR‚†VçG'’’ÓâVçG'’ç6WGFÆVB“°¢6öç7B&æ¶VBÒVçG&–W0¢æÖ‚†VçG'’’Óâ‡°¢W6W$–C¢VçG'’çW6W$–BÀ¢òòÆ—fRF÷FÇ2Ö–BÖ6&B6òF†RÆVFW&&ö&BÖ÷fW22F†Ræ–v‡BvöW2öâà¢66÷&S¢6WGFÆVBòVçG'’çF÷FÅö–çG2¢†VçG'’ç–6·2ÇÂµÒ’ç&VGV6R‚‡7VÒÂ–6²’Óâ7VÒ²–6²çö–çG2Â’À¢66÷&VD6÷VçC¢†VçG'’ç–6·2ÇÂµÒ’æf–ÇFW"‚‡–6²’Óâ–6²ç66÷&VB’æÆVæwF‚À¢Ò’¢ç6÷'B‚†Â"’Óâ"ç66÷&RÒç66÷&R¢ç6Æ–6RƒÂ“° ¢6öç7BW6W'2Ò&æ¶VBæÆVæwF€¢òv—BW6W"æf–æB‡²ö–C¢²F–ã¢&æ¶VBæÖ‚‡&÷r’Óâ&÷rçW6W$–B’æf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’’ÒÒ¢ç6VÆV7B‚wÆ–W$æÖRf—'7DæÖR&öf–ÆUW&Âr’æÆVâ‚¢¢µÓ°¢6öç7B'”–BÒæWrÖ‡W6W'2æÖ‚‡&÷r’Óâµ7G&–ær‡&÷råö–B’Â&÷uÒ’“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Æ—fS¢6WGFÆVBÀ¢ÆVFW&&ö&C¢&æ¶VBæÖ‚‡&÷rÂ–æFW‚’Óâ‡°¢Æ6S¢–æFW‚²À¢æÖS¢'”–BævWB‡&÷rçW6W$–B“òçÆ–W$æÖRÇÂ'”–BævWB‡&÷rçW6W$–B“òæf—'7DæÖRÇÂuÆ–W"rÀ¢fF#¢'”–BævWB‡&÷rçW6W$–B“òç&öf–ÆUW&ÂÇÂrrÀ¢66÷&S¢&÷rç66÷&RÀ¢f–v‡G566÷&VC¢&÷rç66÷&VD6÷VçBÀ¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚uFVÒÆVFW&&ö&Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†RÆVFW&&ö&BârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòäôâÔ44‚$•¤U2(	Bv†BÖ¶W2g&VR6öçFW7Bv÷'F‚v–ææ–æp¢òð¢òò–âg&VR×Æ’7FFW2F†RVçG'’fVR—2¦W&òÂ6òF†W&R—2æò6öç6–FW&F–öâæBæð¢òòvvW"âF†BÇ6òÖVç2F†W&R—2æ÷F†–ærFò’÷WBöbâ&—¦W2†W&R&RF†–æw0¢òòv—F‚æò66‚fÇVRFòF†RÆ–W#¢&FvW2ÂÆVFW&&ö&BF—FÆW2Â7öç6÷"ÖW&6€¢òòæBb6öFW2F†R7öç6÷"gVæG2à¢òð¢òòFVÆ–&W&FVÇ’¶WB6W&FRg&öÒF†RvÆÆWBâ6ö–ç2&R&Ææ6S²F†W6R&P¢òòv&G2âÖ—†–ærF†VÒv÷VÆBv—fRF†R&g&VR"6ö–ç266‚fÇVRæB6öÆÆ6RF†P¢òòF—7F–æ7F–öâF†Rg&VRÖöFRFWVæG2öâà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7B$•¤UõE•U2Òö&¦V7Bæg&VW¦R…²v&FvRrÂwF—FÆRrÂvÖW&6‚rÂweö6öFRrÂw7öç6÷%ö÷F†W"uÒ“°¢òòF–v—FÂÖöæÇ’G—W2æVVBæò6†—–æræB&R6ö×ÆWFRF†RÖöÖVçBF†W’&Rvöâà¦6öç7B”å5DåEõ$•¤UõE•U2Òö&¦V7Bæg&VW¦R…²v&FvRrÂwF—FÆRrÂweö6öFRuÒ“° ¦6öç7B6öçFW7E&—¦U66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢f–v‡D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢òòÂ"Â2(
b÷"ÖVæ–ær&WfW'–öæRv†òVçFW&VB"‡'F–6—F–öâ&FvW2’à¢Æ6S¢²G—S¢çVÖ&W"Â&WV—&VC¢G'VRÂÖ–ã¢ÒÀ¢G—S¢²G—S¢7G&–ærÂVçVÓ¢$•¤UõE•U2Â&WV—&VC¢G'VRÒÀ¢æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢FW67&—F–öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7öç6÷$æÖS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òòf÷"eö6öFS¢ööÂöb6–ævÆR×W6R6öFW2Â6Æ–ÖVBöæRW"v–ææW"à¢6öFUööÃ¢²G—S¢µ7G&–æuÒÂFVfVÇC¢µÒÒÀ¢VçF—G“¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÂÖ–ã¢ÒÀ¢v&FVD6÷VçC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢7F—fS¢²G—S¢&ööÆVâÂFVfVÇC¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7BÆ–W$v&E66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢W6W$–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢f–v‡D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢&—¦T–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢G—S¢²G—S¢7G&–ærÂVçVÓ¢$•¤UõE•U2Â&WV—&VC¢G'VRÒÀ¢æÖS¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢FW67&—F–öã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢–ÖvUW&Ã¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢7öç6÷$æÖS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢Æ6S¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢òò6–ævÆR×W6R6öFR†æFVBFòF†—2v–ææW"‡eö6öFRöæÇ’’à¢6öFS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òò‡—6–6ÂvööG2æVVBgVÆf–ÆÖVçC²F–v—FÂv&G2&RFöæRöâ7&VF–öâà¢gVÆf–ÆÖVçC¢²G—S¢7G&–ærÂVçVÓ¢²væ÷E÷&WV—&VBrÂwVæF–ærrÂw6†—VBrÂv6æ6VÆÆVBuÒÂFVfVÇC¢væ÷E÷&WV—&VBrÒÀ¢6†—–ætæ÷FS¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òò&WfVçG2&R×'Vâöb6WGFÆVÖVçBv&F–ærF†R6ÖR&—¦RGv–6Rà¢–FV×÷FVæ7”¶W“¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B6öçFW7E&—¦RÒÖöævö÷6RæÖöFVÇ2ä6öçFW7E&—¦RÇÂÖöævö÷6RæÖöFVÂ‚t6öçFW7E&—¦RrÂ6öçFW7E&—¦U66†VÖ“°¦6öç7BÆ–W$v&BÒÖöævö÷6RæÖöFVÇ2åÆ–W$v&BÇÂÖöævö÷6RæÖöFVÂ‚uÆ–W$v&BrÂÆ–W$v&E66†VÖ“° ¢òò&æ·2VçG&çG2'’66÷&RæB†æG2÷WBv†FWfW"æöâÖ66‚&—¦W2F†Rf–v‡B†0¢òò6öæf–wW&VBâ6fRFò&R×'Vã¢V6‚v&B†2â–FV×÷FVæ7’¶W’à¦6öç7Bv&Dæöä66…&—¦W2Ò7–æ2†f–v‡D–BÂ66÷&VE&÷w2Âf–v‡B’Óâ°¢6öç7B&—¦W2Òv—B6öçFW7E&—¦Ræf–æB‡²f–v‡D–C¢7G&–ær†f–v‡D–B’Â7F—fS¢G'VRÒ’æÆVâ‚“°¢–b‚&—¦W2æÆVæwF‚’&WGW&â²v&FVC¢Â&—¦W3¢Ó° ¢òò6ÖR÷&FW&–ærF†R66‚&—¦W2W6RÂ6òv–ææW"—2v–ææW"–â&÷F‚à¢6öç7B&æ¶VBÒ²ââç66÷&VE&÷w5Òç6÷'B‚†Â"’Óâ"çö–çG2Òçö–çG2“°¢ÆWBv&FVBÒ° ¢f÷"†6öç7B&—¦Röb&—¦W2’°¢6öç7B&V6—–VçG2Ò&—¦RçÆ6RÓÓÒ ¢ò&æ¶V@¢¢‡&æ¶VE·&—¦RçÆ6RÒÒò·&æ¶VE·&—¦RçÆ6RÒÕÒ¢µÒ“° ¢f÷"†6öç7B&V6—–VçBöb&V6—–VçG2’°¢–b‡&—¦Ræv&FVD6÷VçBãÒ&—¦RçVçF—G’bb&—¦RçÆ6RÓÒ’'&V³° ¢6öç7B–FV×÷FVæ7”¶W’Òv&C¢G¶f–v‡D–GÓ¢G·&—¦Råö–GÓ¢G·&V6—–VçBçW6W$–GÖ°¢6öç7BW†—7F–ærÒv—BÆ–W$v&Bæf–æDöæR‡²–FV×÷FVæ7”¶W’Ò’æÆVâ‚“°¢–b†W†—7F–ær’6öçF–çVS° ¢òò6Æ–ÒöæR6öFRg&öÒF†RööÂFöÖ–6ÆÇ’Â6òGvòv–ææW'26ææ÷B&V6V—fP¢òòF†R6ÖRb6öFRà¢ÆWB6öFRÒrs°¢–b‡&—¦RçG—RÓÓÒweö6öFRr’°¢6öç7B6Æ–ÖVBÒv—B6öçFW7E&—¦Ræf–æDöæTæEWFFR€¢²ö–C¢&—¦Råö–BÂv6öFUööÂãs¢²FW†—7G3¢G'VRÒÒÀ¢²G÷¢²6öFUööÃ¢ÓÒÂF–æ3¢²v&FVD6÷VçC¢ÒÒÀ¢²æWs¢fÇ6RÒÀ¢’æÆVâ‚“°¢–b‚6Æ–ÖVCòæ6öFUööÃòæÆVæwF‚’°¢6öç6öÆRçv&â†·&—¦W5Ò6öFRööÂV×G’f÷"&—¦RG·&—¦Råö–GÓ²6¶—–ærG·&V6—–VçBçW6W$–GÖ“°¢6öçF–çVS°¢Ð¢6öFRÒ6Æ–ÖVBæ6öFUööÅ³Ó°¢ÒVÇ6R°¢v—B6öçFW7E&—¦RçWFFTöæR‡²ö–C¢&—¦Råö–BÒÂ²F–æ3¢²v&FVD6÷VçC¢ÒÒ“°¢Ð ¢G'’°¢v—BÆ–W$v&Bæ7&VFR‡°¢W6W$–C¢7G&–ær‡&V6—–VçBçW6W$–B’À¢f–v‡D–C¢7G&–ær†f–v‡D–B’À¢&—¦T–C¢7G&–ær‡&—¦Råö–B’À¢G—S¢&—¦RçG—RÀ¢æÖS¢&—¦RææÖRÀ¢FW67&—F–öã¢&—¦RæFW67&—F–öâÀ¢–ÖvUW&Ã¢&—¦Ræ–ÖvUW&ÂÀ¢7öç6÷$æÖS¢&—¦Rç7öç6÷$æÖRÀ¢Æ6S¢&—¦RçÆ6RÀ¢6öFRÀ¢gVÆf–ÆÖVçC¢”å5DåEõ$•¤UõE•U2æ–æ6ÇVFW2‡&—¦RçG—R’òvæ÷E÷&WV—&VBr¢wVæF–ærrÀ¢–FV×÷FVæ7”¶W’À¢Ò“°¢v&FVB³Ò°¢Ò6F6‚†W'&÷"’°¢–b†W'&÷#òæ6öFRÓÒ’6öç6öÆRæW'&÷"‚tv&B7&VF–öâf–ÆVC¢rÂW'&÷"æÖW76vR“°¢6öçF–çVS°¢Ð ¢6öç7Bv–ææW"Òv—BW6W"æf–æD'”–B‡&V6—–VçBçW6W$–B’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRr’æÆVâ‚“°¢–b‡v–ææW#òæVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢v–ææW"æVÖ–ÂÀ¢7V&¦V7C¢–÷Rvöã¢G·&—¦RææÖWÖÀ¢†VF–æs¢&—¦RçÆ6RÓÓÒòu”õRT$äTBât$Br¢2G·&—¦RçÆ6WÒd”ä•4†À¢Æ–æW3¢°¢G¶f–v‡CòæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶f–v‡CòæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÒ†2&VVâ66÷&VBæÀ¢–÷RvöâÇ7G&öæsâG¶W66T‡FÖÂ‡&—¦RææÖR—ÓÂ÷7G&öæsâG·&—¦Rç7öç6÷$æÖRòÂ6÷W'FW7’öbG¶W66T‡FÖÂ‡&—¦Rç7öç6÷$æÖR—Ö¢rwÒæÀ¢6öFRò–÷W"6öFS¢Ç7G&öæsâG¶W66T‡FÖÂ†6öFR—ÓÂ÷7G&öæsæ¢rrÀ¢”å5DåEõ$•¤UõE•U2æ–æ6ÇVFW2‡&—¦RçG—R¢òt—B—2Ç&VG’öâ–÷W"&öf–ÆRâp¢¢uvRv–ÆÂ&R–âF÷V6‚&÷WBFVÆ—fW'’ârÀ¢Òæf–ÇFW"„&ööÆVâ’À¢Ò“°¢Ð¢Ð¢Ð ¢&WGW&â²v&FVBÂ&—¦W3¢&—¦W2æÆVæwF‚Ó°§Ó° ¢òòÒÒÒFÖ–ã¢6öæf–wW&R&—¦W2öâf–v‡BÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷&—¦W2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7BG—RÒ7G&–ær‡&Wæ&öG“òçG—RÇÂrr’çG&–Ò‚“°¢–b‚$•¤UõE•U2æ–æ6ÇVFW2‡G—R’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢G—R×W7B&RöæRöc¢Gµ$•¤UõE•U2æ¦ö–â‚rÂr—ÖÒ“°¢Ð¢6öç7BæÖRÒ7G&–ær‡&Wæ&öG“òææÖRÇÂrr’çG&–Ò‚“°¢–b‚æÖR’&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t&—¦RæÖR—2&WV—&VBârÒ“° ¢6öç7B6öFUööÂÒ'&’æ—4'&’‡&Wæ&öG“òæ6öFUööÂ¢ò&Wæ&öG’æ6öFUööÂæÖ‚†2’Óâ7G&–ær†2’çG&–Ò‚’’æf–ÇFW"„&ööÆVâ’ç6Æ–6RƒÂS¢¢µÓ°¢–b‡G—RÓÓÒweö6öFRrbb6öFUööÂæÆVæwF‚’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u&÷f–FRBÆV7BöæR6öFRf÷"b6öFR&—¦RârÒ“°¢Ð ¢6öç7B&—¦RÒv—B6öçFW7E&—¦Ræ7&VFR‡°¢f–v‡D–BÀ¢Æ6S¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òçÆ6R’ÇÂ’’À¢G—RÀ¢æÖS¢æÖRç6Æ–6RƒÂ#’À¢FW67&—F–öã¢7G&–ær‡&Wæ&öG“òæFW67&—F–öâÇÂrr’ç6Æ–6RƒÂS’À¢–ÖvUW&Ã¢7G&–ær‡&Wæ&öG“òæ–ÖvUW&ÂÇÂrr’ç6Æ–6RƒÂS’À¢7öç6÷$æÖS¢7G&–ær‡&Wæ&öG“òç7öç6÷$æÖRÇÂrr’ç6Æ–6RƒÂ#’À¢6öFUööÂÀ¢VçF—G“¢G—RÓÓÒweö6öFRrò6öFUööÂæÆVæwF‚¢ÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"‡&Wæ&öG“òçVçF—G’’ÇÂ’’À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ&—¦T–C¢&—¦Råö–BÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u&—¦R7&VFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BFBF†B&—¦RârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷&—¦W2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&—¦W2Òv—B6öçFW7E&—¦Ræf–æB‡²f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’Ò¢ç6VÆV7B‚rÖ6öFUööÂr’ç6÷'B‡²Æ6S¢Ò’æÆVâ‚“°¢òòæWfW"&WGW&âF†RVæ6Æ–ÖVB6öFW2F†V×6VÇfW3²F†R6÷VçB—2v†BFÖ–ç2æVVBà¢6öç7Bv—F„6÷VçG2Òv—B&öÖ—6RæÆÂ‡&—¦W2æÖ†7–æ2‡&—¦R’Óâ°¢6öç7BgVÆÂÒv—B6öçFW7E&—¦Ræf–æD'”–B‡&—¦Råö–B’ç6VÆV7B‚v6öFUööÂr’æÆVâ‚“°¢&WGW&â²ââç&—¦RÂ6öFW5&VÖ–æ–æs¢gVÆÃòæ6öFUööÃòæÆVæwF‚ÇÂÓ°¢Ò’“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&—¦W3¢v—F„6÷VçG2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB&—¦W2ârÒ“°¢Ð§Ò“° ¦æFVÆWFR‚rö’öFÖ–â÷&—¦W2ó§&—¦T–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢v—B6öçFW7E&—¦RçWFFTöæR‡²ö–C¢7G&–ær‡&Wç&×2ç&—¦T–BÇÂrr’ÒÂ²G6WC¢²7F—fS¢fÇ6RÒÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÖW76vS¢u&—¦RFV7F—fFVBâv&G2Ç&VG’v—fVâ&RVæffV7FVBârÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B&VÖ÷fRF†B&—¦RârÒ“°¢Ð§Ò“° ¢òòÒÒÒFÖ–ã¢gVÆf–ÆÖVçBVWVRf÷"‡—6–6ÂvööG2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’öFÖ–âöv&G2ögVÆf–ÆÖVçBrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B7FGW2Ò7G&–ær‡&WçVW'’ç7FGW2ÇÂwVæF–ærr’çG&–Ò‚“°¢6öç7B&÷w2Òv—BÆ–W$v&Bæf–æB‡²gVÆf–ÆÖVçC¢7FGW2Ò’ç6÷'B‡²7&VFVDC¢Ò’æÆ–Ö—Bƒ3’æÆVâ‚“°¢6öç7BW6W$–G2Ò²ââææWr6WB‡&÷w2æÖ‚‡"’Óâ"çW6W$–B’•Òæf–ÇFW"‚†–B’ÓâÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B†–B’“°¢6öç7BW6W'2ÒW6W$–G2æÆVæwF€¢òv—BW6W"æf–æB‡²ö–C¢²F–ã¢W6W$–G2ÒÒ’ç6VÆV7B‚vVÖ–ÂÆ–W$æÖRf—'7DæÖRÆ7DæÖR†öæR¦—6öFRr’æÆVâ‚¢¢µÓ°¢6öç7B'”–BÒæWrÖ‡W6W'2æÖ‚‡R’Óâµ7G&–ær‡Råö–B’ÂUÒ’“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢v&G3¢&÷w2æÖ‚‡&÷r’Óâ‡°¢–C¢&÷råö–BÀ¢æÖS¢&÷rææÖRÀ¢G—S¢&÷rçG—RÀ¢7öç6÷$æÖS¢&÷rç7öç6÷$æÖRÀ¢Æ6S¢&÷rçÆ6RÀ¢vöäC¢&÷ræ7&VFVDBÀ¢gVÆf–ÆÖVçC¢&÷rægVÆf–ÆÖVçBÀ¢v–ææW#¢'”–BævWB‡&÷rçW6W$–B¢ò°¢æÖS¢'”–BævWB‡&÷rçW6W$–B’çÆ–W$æÖP¢ÇÂ¶'”–BævWB‡&÷rçW6W$–B’æf—'7DæÖRÂ'”–BævWB‡&÷rçW6W$–B’æÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’À¢VÖ–Ã¢'”–BævWB‡&÷rçW6W$–B’æVÖ–ÂÀ¢†öæS¢'”–BævWB‡&÷rçW6W$–B’ç†öæRÀ¢¦—6öFS¢'”–BævWB‡&÷rçW6W$–B’ç¦—6öFRÀ¢Ð¢¢çVÆÂÀ¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tgVÆf–ÆÖVçBVWVRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBF†RVWVRârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’öFÖ–âöv&G2ó¦v&D–BögVÆf–ÂrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BæW‡BÒ7G&–ær‡&Wæ&öG“òç7FGW2ÇÂw6†—VBr’çG&–Ò‚“°¢–b‚²w6†—VBrÂv6æ6VÆÆVBrÂwVæF–æruÒæ–æ6ÇVFW2†æW‡B’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢w7FGW2×W7B&R6†—VBÂ6æ6VÆÆVB÷"VæF–ærârÒ“°¢Ð¢6öç7Bv&BÒv—BÆ–W$v&Bæf–æDöæTæEWFFR€¢²ö–C¢7G&–ær‡&Wç&×2æv&D–BÇÂrr’ÒÀ¢²G6WC¢²gVÆf–ÆÖVçC¢æW‡BÂ6†—–ætæ÷FS¢7G&–ær‡&Wæ&öG“òææ÷FRÇÂrr’ç6Æ–6RƒÂ3’ÒÒÀ¢²æWs¢G'VRÒÀ¢’æÆVâ‚“°¢–b‚v&B’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tv&Bæ÷Bf÷VæBârÒ“° ¢–b†æW‡BÓÓÒw6†—VBr’°¢6öç7Bv–ææW"Òv—BW6W"æf–æD'”–B†v&BçW6W$–B’ç6VÆV7B‚vVÖ–Âr’æÆVâ‚“°¢–b‡v–ææW#òæVÖ–Â’°¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢v–ææW"æVÖ–ÂÀ¢7V&¦V7C¢–÷W"&—¦R—2öâF†Rv“¢G¶v&BææÖWÖÀ¢†VF–æs¢u$•¤R4„•TBrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶W66T‡FÖÂ†v&BææÖR—ÓÂ÷7G&öæsâ†2&VVâ6VçB÷WBæÀ¢v&Bç6†—–ætæ÷FRòW66T‡FÖÂ†v&Bç6†—–ætæ÷FR’¢rrÀ¢Òæf–ÇFW"„&ööÆVâ’À¢Ò“°¢Ð¢Ð¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂgVÆf–ÆÖVçC¢v&BægVÆf–ÆÖVçBÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tgVÆf–ÆÖVçBWFFRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BWFFRF†Bv&BârÒ“°¢Ð§Ò“° ¢òòÒÒÒÆ–W#¢×’G&÷‡’66RÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’÷W6W'2öÖRöv&G2rÂfW&–g•Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BW6W$–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7B&÷w2Òv—BÆ–W$v&Bæf–æB‡²W6W$–BÒ’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢v&G3¢&÷w2æÖ‚‡&÷r’Óâ‡°¢–C¢&÷råö–BÀ¢G—S¢&÷rçG—RÀ¢æÖS¢&÷rææÖRÀ¢FW67&—F–öã¢&÷ræFW67&—F–öâÀ¢–ÖvUW&Ã¢&÷ræ–ÖvUW&ÂÀ¢7öç6÷$æÖS¢&÷rç7öç6÷$æÖRÀ¢Æ6S¢&÷rçÆ6RÀ¢6öFS¢&÷ræ6öFRÇÂVæFVf–æVBÀ¢gVÆf–ÆÖVçC¢&÷rægVÆf–ÆÖVçBÀ¢vöäC¢&÷ræ7&VFVDBÀ¢f–v‡D–C¢&÷ræf–v‡D–BÀ¢Ò’’À¢&FvW3¢&÷w2æf–ÇFW"‚‡"’Óâ"çG—RÓÓÒv&FvRr’æÆVæwF‚À¢F—FÆW3¢&÷w2æf–ÇFW"‚‡"’Óâ"çG—RÓÓÒwF—FÆRr’æÖ‚‡"’Óâ"ææÖR’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tv&G2Æöö·Wf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"v&G2ârÒ“°¢Ð§Ò“° ¢òòV&Æ–2G&÷‡’66RÂf÷"F†RÆVFW&&ö&BæB&öf–ÆR6†÷v66RâæÖW2öæÇ’à¦ævWB‚rö’÷V&Æ–2öv&G2ó§W6W$–BrÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&÷w2Òv—BÆ–W$v&Bæf–æB‡²W6W$–C¢7G&–ær‡&Wç&×2çW6W$–BÇÂrr’çG&–Ò‚’Ò¢ç6VÆV7B‚wG—RæÖR–ÖvUW&Â7öç6÷$æÖRÆ6R7&VFVDBr’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—BƒS’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂv&G3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷BÆöBv&G2ârÒ“°¢Ð§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòõtäU"4„T4²(	B&VBÖöæÇ’–ç7V7F–öâöbF†Rv†öÆRÆFf÷&Ð¢òð¢òò7&VFVçF–ÂF†B6â6VRWfW'—F†–ær—27&VFVçF–Âv÷'F‚7FVÆ–ærÂ6òF†—0¢òòöæR6ææ÷BDòç—F†–æs¢F†W&R—2æòw&—FRVæGö–çB†W&R&W–öæB6–væ–ær–âà¢òòWfW'’ÖöæW’7F–öâ7F—2&V†–æBFÖ–âWF‚v—F‚—G2÷vâVF—BG&–ÂâF†Bv¢òòÆV¶VB÷væW"6öFR6÷7G2–÷R–æf÷&ÖF–öâÂæ÷BÖöæW’à¢òð¢òò6W&FR6V7&WBg&öÒFÖ–â„¥uEõ4T5$UEôõtäU"’6òæV—F†W"&öÆRw26ö×&öÖ—6P¢òò–æ6ÇVFW2F†R÷F†W"â6†÷'B6W76–öâ(	B–÷R&R6†V6¶–ærÂæ÷BÆ—f–ær†W&Rà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦6öç7BõtäU%ôTÔ”ÂÒ7G&–ær‡&ö6W72æVçbäõtäU%ôTÔ”ÂÇÂ5Uõ%EôTÔ”Â’çG&–Ò‚’çFôÆ÷vW$66R‚“°¦6öç7BõtäU%ô4ôDUõEDÅôÕ2Ò¢c¢°¦6öç7BõtäU%õ4U54”ôåõEDÂÒ&ö6W72æVçbäõtäU%õ4U54”ôåõEDÂÇÂs‚s°¦6öç7BõtäU%ô4ôDUôÔ…ôEDTÕE2ÒS° ¦6öç7B÷væW$Æöv–ä6öFU66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢6öFT†6ƒ¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢GFV×G3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢W‡—&W4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B÷væW$Æöv–ä6öFRÒÖöævö÷6RæÖöFVÇ2ä÷væW$Æöv–ä6öFP¢ÇÂÖöævö÷6RæÖöFVÂ‚t÷væW$Æöv–ä6öFRrÂ÷væW$Æöv–ä6öFU66†VÖ“° ¦6öç7B÷væW%6V7&WBÒ‚’Óâ7G&–ær‡&ö6W72æVçbä¥uEõ4T5$UEôõtäU"ÇÂrr’çG&–Ò‚“° ¦ç÷7B‚rö’ö÷væW"öÆöv–â÷&WVW7BrÂÆöv–äÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢òò–FVçF–6Â&W7öç6RV—F†W"v’(	BF†—2×W7BæWfW"6öæf—&ÒF†R÷væW"FG&W72à¢6öç7BvVæW&–2Ò²ö³¢G'VRÂÖW76vS¢t–bF†BFG&W726â66W72F†R÷væW"f–WrÂ6öFR—2öâ—G2v’ârÓ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG“òæVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢–b†VÖ–ÂÓÒõtäU%ôTÔ”Â’&WGW&â&W2æ§6öâ†vVæW&–2“°¢–b‚÷væW%6V7&WB‚’’°¢6öç6öÆRæW'&÷"‚t÷væW"6–vâÖ–âGFV×FVB'WB¥uEõ4T5$UEôõtäU"—2æ÷B6öæf–wW&VBâr“°¢&WGW&â&W2æ§6öâ†vVæW&–2“°¢Ð ¢6öç7B6öFRÒ7G&–ær†7'—Fòç&æFöÔ–çBƒÂ’“°¢v—B÷væW$Æöv–ä6öFRæFVÆWFTÖç’‡·Ò“°¢v—B÷væW$Æöv–ä6öFRæ7&VFR‡°¢6öFT†6ƒ¢7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR†6öFR’æF–vW7B‚v†W‚r’À¢W‡—&W4C¢æWrFFR„FFRææ÷r‚’²õtäU%ô4ôDUõEDÅôÕ2’À¢Ò“° ¢v—BG&ç7÷'FW"ç6VæDÖ–Â‡°¢g&öÓ¢dÔÕôÔ”Åôe$ôÒÀ¢Fó¢õtäU%ôTÔ”ÂÀ¢7V&¦V7C¢tfçF7’ÔÔFæW72÷væW"6–vâÖ–â6öFRrÀ¢‡FÖÃ¢ÆF—b7G–ÆSÒ&föçBÖfÖ–Ç“¤vV÷&v–ÂuF–ÖW2æWr&öÖârÇ6W&–c¶6öÆ÷#¢3#cB#à¢Çå–÷W"÷væW"6–vâÖ–â6öFS£Â÷à¢Ç7G–ÆSÒ&föçB×6—¦S£3'ƒ¶ÆWGFW"×76–æs£‡ƒ¶föçB×f&–çBÖçVÖW&–3§F'VÆ"ÖçV×2#ãÇ7G&öæsâG¶6öFWÓÂ÷7G&öæsãÂ÷à¢ÇåfÆ–Bf÷"Ö–çWFW2âÇ7G&öæsä–b–÷RF–Bæ÷B&WVW7BF†—2Â6öÖVöæR¶æ÷w2–÷W"÷væW"FG&W72(	B6†ævR–÷W"VÖ–Â77v÷&BæBFVÆÂ–÷W"FWfVÆ÷W"ãÂ÷7G&öæsãÂ÷à¢ÂöF—cæÀ¢Ò“°¢&WGW&â&W2æ§6öâ†vVæW&–2“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"6öFR&WVW7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2æ§6öâ†vVæW&–2“°¢Ð§Ò“° ¦ç÷7B‚rö’ö÷væW"öÆöv–â÷fW&–g’rÂÆöv–äÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG“òæVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B6öFRÒ7G&–ær‡&Wæ&öG“òæ6öFRÇÂrr’çG&–Ò‚“°¢–b†VÖ–ÂÓÒõtäU%ôTÔ”ÂÇÂõåÆG³gÒBòçFW7B†6öFR’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B6öFR—2æ÷B6÷'&V7BârÒ“°¢Ð¢–b‚÷væW%6V7&WB‚’’&WGW&â&W2ç7FGW2ƒS2’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t÷væW"66W72—2æ÷B6öæf–wW&VBârÒ“° ¢6öç7B&V6÷&BÒv—B÷væW$Æöv–ä6öFRæf–æDöæR‡·Ò’ç6÷'B‡²7&VFVDC¢ÓÒ“°¢–b‚&V6÷&BÇÂ&V6÷&BæW‡—&W4BævWEF–ÖR‚’ÂFFRææ÷r‚’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B6öFR†2W‡—&VBâ&WVW7BæWröæRârÒ“°¢Ð¢–b‡&V6÷&BæGFV×G2ãÒõtäU%ô4ôDUôÔ…ôEDTÕE2’°¢&WGW&â&W2ç7FGW2ƒC#’’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uFöòÖç’GFV×G2â&WVW7BæWr6öFRârÒ“°¢Ð¢6öç7B7WÆ–VBÒ'VffW"æg&öÒ†7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR†6öFR’æF–vW7B‚v†W‚r’“°¢6öç7BW‡V7FVBÒ'VffW"æg&öÒ‡&V6÷&Bæ6öFT†6‚“°¢–b‡7WÆ–VBæÆVæwF‚ÓÒW‡V7FVBæÆVæwF‚ÇÂ7'—FòçF–Ö–æu6fTWVÂ‡7WÆ–VBÂW‡V7FVB’’°¢&V6÷&BæGFV×G2³Ò°¢v—B&V6÷&Bç6fR‚“°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B6öFR—2æ÷B6÷'&V7BârÒ“°¢Ð¢v—B÷væW$Æöv–ä6öFRæFVÆWFTÖç’‡·Ò“° ¢6öç7BFö¶VâÒ§wBç6–vâ‡²VÖ–Ã¢õtäU%ôTÔ”ÂÂ66÷S¢v÷væW"rÒÂ÷væW%6V7&WB‚’Â²W‡—&W4–ã¢õtäU%õ4U54”ôåõEDÂÒ“° ¢òòWfW'’7V66W76gVÂ÷væW"6–vâÖ–â—2ææ÷Væ6VBÂ6òâVæW‡V7FVBöæR—2f—6–&ÆRà¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢õtäU%ôTÔ”ÂÀ¢7V&¦V7C¢t÷væW"f–Wr66W76VBrÀ¢†VF–æs¢tõtäU"4”tâÔ”ârÀ¢Æ–æW3¢°¢6öÖVöæR6–væVB–âFòF†R÷væW"f–WrBG¶æWrFFR‚’çFõUD57G&–ær‚—ÒæÀ¢•¢Gµ7G&–ær‡&Wæ†VFW'5²w‚Öf÷'v&FVBÖf÷"uÒÇÂ&Wç6ö6¶WCòç&VÖ÷FTFG&W72ÇÂwVæ¶æ÷vâr—ÖÀ¢t–bF†—2v2æ÷B–÷RÂ6†ævR–÷W"VÖ–Â77v÷&B–ÖÖVF–FVÇ’ârÀ¢ÒÀ¢Ò“° ¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂFö¶VâÂW‡—&W4–ã¢õtäU%õ4U54”ôåõEDÂÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"fW&–g’f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6–vâÖ–â—2FV×÷&&–Ç’Væf–Æ&ÆRârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòE%U5DTBDUd”4R²”à¢òð¢òòVÖ–Æ–ær6öFRWfW'’F–ÖR—2&–v‡Bf÷"æWrFWf–6RæBw&öærf÷"F†R†öæP¢òò–â–÷W"ö6¶WBâ6ó¢&÷fR—Böæ6R'’VÖ–ÂÂF†Vâ¶VWFWf–6R6V7&WBöâF†@¢òò†öæRæBVæÆö6²v—F‚6†÷'B”âà¢òð¢òòF†—2—2öæÇ’FVfVç6–&ÆR&V6W6RF†R÷væW"f–Wr—2$TBÔôäÅ’â”âv÷VÆB&R¢òò&BwV&Böâç—F†–ærF†B6âÖ÷fRÖöæW“²†W&RF†Rv÷'7B66R—2F†B6öÖVöæP¢òò†öÆF–ær–÷W"VæÆö6¶VB†öæR6â&VBçVÖ&W'2F†W’6÷VÆBÇ6ò&VB÷fW"–÷W ¢òò6†÷VÆFW"âF†RFWf–6R6V7&WB—2ÆöæræB&æFöÒ(	BF†R”âÆöæR—2W6VÆW70¢òòv—F†÷WB—BÂæBf—fRw&öær”ç2FW7G&÷’F†RFWf–6R&V6÷&BVçF—&VÇ’à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B÷væW$FWf–6U66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢FWf–6T¶W”†6ƒ¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂVæ—VS¢G'VRÒÀ¢–ä†6ƒ¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢Æ&VÃ¢²G—S¢7G&–ærÂFVfVÇC¢u†öæRrÒÀ¢f–ÆVDGFV×G3¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢Æ7EW6VDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢W‡—&W4C¢²G—S¢FFRÂ&WV—&VC¢G'VRÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B÷væW$FWf–6RÒÖöævö÷6RæÖöFVÇ2ä÷væW$FWf–6RÇÂÖöævö÷6RæÖöFVÂ‚t÷væW$FWf–6RrÂ÷væW$FWf–6U66†VÖ“° ¦6öç7BõtäU%ôDUd”4UõEDÅôÕ2ÒçVÖ&W"‡&ö6W72æVçbäõtäU%ôDUd”4UõEDÅôD•2ÇÂ3’¢#B¢c¢c¢°¦6öç7BõtäU%õ”åôÔ…ôEDTÕE2ÒS°¦6öç7B†6„÷væW%fÇVRÒ‡fÇVR’Óâ7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR…7G&–ær‡fÇVR’’æF–vW7B‚v†W‚r“° ¦ç÷7B‚rö’ö÷væW"öFWf–6R÷G'W7BrÂ‡&WÂ&W2ÂæW‡B’ÓâfW&–g”÷væW%Fö¶Vâ‡&WÂ&W2ÂæW‡B’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B–âÒ7G&–ær‡&Wæ&öG“òç–âÇÂrr’çG&–Ò‚“°¢–b‚õåÆG³BÃ‡ÒBòçFW7B‡–â’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6†ö÷6R”âöbBFò‚F–v—G2ârÒ“°¢Ð¢òò&VgW6RF†R”ç26öÖVöæRv÷VÆBwVW72f—'7Bà¢–b‚õâ…ÆB•Ã²BòçFW7B‡–â’ÇÂ²s#3BrÂs#3CRrÂs#3CSbrÂsuÒæ–æ6ÇVFW2‡–â’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u–6²ÆW72&VF–7F&ÆR”âârÒ“°¢Ð ¢6öç7BFWf–6T¶W’Ò7'—Fòç&æFöÔ'—FW2ƒ3"’çFõ7G&–ær‚v†W‚r“°¢v—B÷væW$FWf–6Ræ7&VFR‡°¢FWf–6T¶W”†6ƒ¢†6„÷væW%fÇVR†FWf–6T¶W’’À¢–ä†6ƒ¢v—B&7'—Bæ†6‚‡–âÂ’À¢Æ&VÃ¢7G&–ær‡&Wæ&öG“òæÆ&VÂÇÂu†öæRr’ç6Æ–6RƒÂC’À¢W‡—&W4C¢æWrFFR„FFRææ÷r‚’²õtäU%ôDUd”4UõEDÅôÕ2’À¢Ò“° ¢6VæDÖöæW”æ÷F–6R‡°¢Fó¢õtäU%ôTÔ”ÂÀ¢7V&¦V7C¢tFWf–6Rv2G'W7FVBf÷"÷væW"66W72rÀ¢†VF–æs¢tDUd”4RE%U5DTBrÀ¢Æ–æW3¢°¢FWf–6Rv26WBWf÷"V–6²÷væW"6–vâÖ–âöâG¶æWrFFR‚’çFõUD57G&–ær‚—ÒæÀ¢t–bF†—2v2æ÷B–÷RÂ÷VâF†R÷væW"f–WræB6†ö÷6R$f÷&vWBÆÂFWf–6W2"ârÀ¢ÒÀ¢Ò“° ¢òò&WGW&æVBöæ6RæBæWfW"v–â(	BF†R†öæR7F÷&W2—BÂF†R6W'fW"¶VW2öæÇ’†6‚à¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂFWf–6T¶W’ÂW‡—&W4–äF—3¢ÖF‚ç&÷VæB„õtäU%ôDUd”4UõEDÅôÕ2òƒcC’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"FWf–6RG'W7Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6WBWV–6²66W72ârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’ö÷væW"öÆöv–âöFWf–6RrÂÆöv–äÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BFWf–6T¶W’Ò7G&–ær‡&Wæ&öG“òæFWf–6T¶W’ÇÂrr’çG&–Ò‚“°¢6öç7B–âÒ7G&–ær‡&Wæ&öG“òç–âÇÂrr’çG&–Ò‚“°¢6öç7BvVæW&–2Ò²ö³¢fÇ6RÂÖW76vS¢uF†B”â—2æ÷B6÷'&V7BârÓ°¢–b‚FWf–6T¶W’ÇÂõåÆG³BÃ‡ÒBòçFW7B‡–â’ÇÂ÷væW%6V7&WB‚’’&WGW&â&W2ç7FGW2ƒC’æ§6öâ†vVæW&–2“° ¢6öç7BFWf–6RÒv—B÷væW$FWf–6Ræf–æDöæR‡²FWf–6T¶W”†6ƒ¢†6„÷væW%fÇVR†FWf–6T¶W’’Ò“°¢–b‚FWf–6R’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†—2FWf–6R—2æòÆöævW"G'W7FVBâ6–vâ–âv—F‚âVÖ–Â6öFRârÂ&W6WC¢G'VRÒ“°¢–b†FWf–6RæW‡—&W4BævWEF–ÖR‚’ÂFFRææ÷r‚’’°¢v—BFWf–6RæFVÆWFTöæR‚“°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uV–6²66W72W‡—&VBâ6–vâ–âv—F‚âVÖ–Â6öFRârÂ&W6WC¢G'VRÒ“°¢Ð¢–b†FWf–6Ræf–ÆVDGFV×G2ãÒõtäU%õ”åôÔ…ôEDTÕE2’°¢v—BFWf–6RæFVÆWFTöæR‚“°¢&WGW&â&W2ç7FGW2ƒC#’’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uFöòÖç’w&öær”ç2(	BF†—2FWf–6Rv2Vâ×G'W7FVBâ6–vâ–âv—F‚âVÖ–Â6öFRârÂ&W6WC¢G'VRÒ“°¢Ð ¢–b‚†v—B&7'—Bæ6ö×&R‡–âÂFWf–6Rç–ä†6‚’’’°¢FWf–6Ræf–ÆVDGFV×G2³Ò°¢v—BFWf–6Rç6fR‚“°¢6öç7BÆVgBÒõtäU%õ”åôÔ…ôEDTÕE2ÒFWf–6Ræf–ÆVDGFV×G3°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡°¢ö³¢fÇ6RÀ¢ÖW76vS¢ÆVgBâòF†B”â—2æ÷B6÷'&V7BâG¶ÆVgGÒGFV×BG¶ÆVgBÓÓÒòrr¢w2wÒÆVgBæ¢uF†B”â—2æ÷B6÷'&V7BârÀ¢Ò“°¢Ð ¢FWf–6Ræf–ÆVDGFV×G2Ò°¢FWf–6RæÆ7EW6VDBÒæWrFFR‚“°¢òò6Æ–F–ærv–æF÷s¢†öæR–÷R7GVÆÇ’W6R7F—2G'W7FVBà¢FWf–6RæW‡—&W4BÒæWrFFR„FFRææ÷r‚’²õtäU%ôDUd”4UõEDÅôÕ2“°¢v—BFWf–6Rç6fR‚“° ¢6öç7BFö¶VâÒ§wBç6–vâ‡²VÖ–Ã¢õtäU%ôTÔ”ÂÂ66÷S¢v÷væW"rÂf–¢vFWf–6RrÒÂ÷væW%6V7&WB‚’Â²W‡—&W4–ã¢õtäU%õ4U54”ôåõEDÂÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂFö¶VâÂW‡—&W4–ã¢õtäU%õ4U54”ôåõEDÂÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"FWf–6R6–vâÖ–âf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6–vâÖ–â—2FV×÷&&–Ç’Væf–Æ&ÆRârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’ö÷væW"öFWf–6Röf÷&vWBÖÆÂrÂ‡&WÂ&W2ÂæW‡B’ÓâfW&–g”÷væW%Fö¶Vâ‡&WÂ&W2ÂæW‡B’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B²FVÆWFVD6÷VçBÒÒv—B÷væW$FWf–6RæFVÆWFTÖç’‡·Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&VÖ÷fVC¢FVÆWFVD6÷VçBÇÂÂÖW76vS¢tÆÂG'W7FVBFWf–6W2&VÖ÷fVBâWfW'’FWf–6Ræ÷ræVVG2âVÖ–Â6öFRârÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"FWf–6Rv—Rf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B&VÖ÷fRG'W7FVBFWf–6W2ârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòd”Ur2(	B6VRF†R27V6–f–2Æ–W"÷"ff–Æ–FRÂ&VBÖöæÇ¢òð¢òòæ÷B–×W'6öæF–öã¢F†RFö¶VâF†—2Ö–çG26ææ÷Bw&—FRâ—B—2v’Fòç7vW ¢òò'v†BFöW2F†—2W'6öâ7GVÆÇ’6VR"Âv†–6‚7W÷'BVW7F–öç26öç7FçFÇ’æVV@¢òòæB67&VVç6†÷G2æWfW"6WGFÆRà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7BõtäU%õ$Ud”UuõEDÂÒ&ö6W72æVçbäõtäU%õ$Ud”UuõEDÂÇÂs#Òs° ¦ævWB‚rö’ö÷væW"÷&Wf–Wr÷6V&6‚rÂ‡&WÂ&W2ÂæW‡B’ÓâfW&–g”÷væW%Fö¶Vâ‡&WÂ&W2ÂæW‡B’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÒ7G&–ær‡&WçVW'’çÇÂrr’çG&–Ò‚“°¢–b‡æÆVæwF‚Â"’&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÆ–W'3¢µÒÂff–Æ–FW3¢µÒÒ“°¢6öç7B6fRÒç&WÆ6R‚õ²â¢³õâG·Ò‚—ÅµÅÕÅÅÒörÂuÅÂBbr“°¢6öç7BÖF6‚ÒæWr&VtW‡‡6fRÂv’r“°¢6öç7Bf–ÇFW"Ò²F÷#¢·²VÖ–Ã¢ÖF6‚ÒÂ²Æ–W$æÖS¢ÖF6‚ÒÂ²f—'7DæÖS¢ÖF6‚ÒÂ²Æ7DæÖS¢ÖF6‚ÕÒÓ° ¢6öç7B·Æ–W'2Âff–Æ–FW5ÒÒv—B&öÖ—6RæÆÂ…°¢W6W"æf–æB†f–ÇFW"’ç6VÆV7B‚uö–BVÖ–ÂÆ–W$æÖRf—'7DæÖRÆ7DæÖRFö¶Vç2r’æÆ–Ö—Bƒ’æÆVâ‚’À¢ff–Æ–FRæf–æB†f–ÇFW"’ç6VÆV7B‚uö–BVÖ–ÂÆ–W$æÖRf—'7DæÖRÆ7DæÖRFö¶Vç2fW&–f–VBr’æÆ–Ö—Bƒ’æÆVâ‚’À¢Ò“° ¢6öç7B6†RÒ‡&÷r’Óâ‡°¢–C¢7G&–ær‡&÷råö–B’À¢æÖS¢&÷rçÆ–W$æÖRÇÂ·&÷ræf—'7DæÖRÂ&÷ræÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’ÇÂuVææÖVBrÀ¢VÖ–Ã¢&÷ræVÖ–ÂÀ¢6ö–ç3¢çVÖ&W"ç'6T–çB…7G&–ær‡&÷rçFö¶Vç2ÇÂsr’Â’ÇÂÀ¢fW&–f–VC¢&÷rçfW&–f–VBÀ¢Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÆ–W'3¢Æ–W'2æÖ‡6†R’Âff–Æ–FW3¢ff–Æ–FW2æÖ‡6†R’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"&Wf–Wr6V&6‚f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u6V&6‚f–ÆVBârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’ö÷væW"÷&Wf–Wr÷Fö¶VârÂ‡&WÂ&W2ÂæW‡B’ÓâfW&–g”÷væW%Fö¶Vâ‡&WÂ&W2ÂæW‡B’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BF&vWEG—RÒ7G&–ær‡&Wæ&öG“òçF&vWEG—RÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7BF&vWD–BÒ7G&–ær‡&Wæ&öG“òçF&vWD–BÇÂrr’çG&–Ò‚“°¢–b‚²wÆ–W"rÂvff–Æ–FRuÒæ–æ6ÇVFW2‡F&vWEG—R’ÇÂÖöævö÷6Ræ—5fÆ–Dö&¦V7D–B‡F&vWD–B’’°¢&WGW&â&W2ç7FGW2ƒC#"’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6†ö÷6RÆ–W"÷"ff–Æ–FRFòf–WrârÒ“°¢Ð¢6öç7B66÷VçBÒF&vWEG—RÓÓÒvff–Æ–FRp¢òv—Bff–Æ–FRæf–æD'”–B‡F&vWD–B’ç6VÆV7B‚uö–BVÖ–ÂÆ–W$æÖRf—'7DæÖRÆ7DæÖRr’æÆVâ‚¢¢v—BW6W"æf–æD'”–B‡F&vWD–B’ç6VÆV7B‚uö–BVÖ–ÂÆ–W$æÖRf—'7DæÖRÆ7DæÖRr’æÆVâ‚“°¢–b‚66÷VçB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢uF†B66÷VçBæòÆöævW"W†—7G2ârÒ“° ¢òò6–væVBv—F‚¥uEõ4T5$UB6ò÷&F–æ'’&VB&÷WFW266WB—B(	B'WB6''––ær¢òò66÷RF†BfW&–g•Fö¶Vâ&VgW6W2FòÆWBw&—FRà¢6öç7BFö¶VâÒ§wBç6–vâ€¢²–C¢7G&–ær†66÷VçBåö–B’Â66÷S¢v÷væW"×&Wf–WrrÂ&Wf–Wtöc¢F&vWEG—RÂ7F÷#¢õtäU%ôTÔ”ÂÒÀ¢&ö6W72æVçbä¥uEõ4T5$UBÀ¢²W‡—&W4–ã¢õtäU%õ$Ud”UuõEDÂÒÀ¢“° ¢6öç6öÆRæÆör†¶÷væW"×&Wf–WuÒG´õtäU%ôTÔ”ÇÒ7F'FVB&VBÖöæÇ’&Wf–WröbG·F&vWEG—WÒG¶66÷VçBåö–GÖ“°¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢Fö¶VâÀ¢W‡—&W4–ã¢õtäU%õ$Ud”UuõEDÂÀ¢F&vWC¢°¢–C¢7G&–ær†66÷VçBåö–B’À¢G—S¢F&vWEG—RÀ¢æÖS¢66÷VçBçÆ–W$æÖRÇÂ¶66÷VçBæf—'7DæÖRÂ66÷VçBæÆ7DæÖUÒæf–ÇFW"„&ööÆVâ’æ¦ö–â‚rr’ÇÂ66÷VçBæVÖ–ÂÀ¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"&Wf–WrFö¶Vâf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B7F'BF†R&Wf–WrârÒ“°¢Ð§Ò“° ¦6öç7BfW&–g”÷væW%Fö¶VâÒ‡&WÂ&W2ÂæW‡B’Óâ°¢6öç7B†VFW"Ò7G&–ær‡&Wæ†VFW'2æWF†÷&—¦F–öâÇÂrr“°¢6öç7BFö¶VâÒ†VFW"ç7F'G5v—F‚‚t&V&W"r’ò†VFW"ç6Æ–6Rƒr’¢çVÆÃ°¢–b‚Fö¶VâÇÂ÷væW%6V7&WB‚’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t÷væW"6–vâÖ–â&WV—&VBârÂ6†÷VÆDÆöv–ã¢G'VRÒ“°¢Ð¢G'’°¢6öç7B6Æ–×2Ò§wBçfW&–g’‡Fö¶VâÂ÷væW%6V7&WB‚’“°¢–b†6Æ–×3òç66÷RÓÒv÷væW"r’F‡&÷ræWrW'&÷"‚ww&öær66÷Rr“°¢&Wæ÷væW"Ò6Æ–×3°¢&WGW&âæW‡B‚“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢u–÷W"÷væW"6W76–öâ†2W‡—&VBârÂ6†÷VÆDÆöv–ã¢G'VRÒ“°¢Ð§Ó° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòõdU%d”Ur(	B6öæf–wW&F–öâÂÆ—fR6÷VçG2ÂfVGW&RfÆw0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’ö÷væW"ö÷fW'f–WrrÂfW&–g”÷væW%Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢v—BVç7W&TFF&6T6&–Æ—G’‚“°¢6öç7BæWBÒvWDWF†÷&—¦TæWDVçf—&öæÖVçB‚“°¢6öç7B6WBÒ†æÖR’Óâ&ööÆVâ…7G&–ær‡&ö6W72æVçe¶æÖUÒÇÂrr’çG&–Ò‚’“° ¢6öç7B·Æ–W'2Âff–Æ–FW2Â÷Väf–v‡G2ÂVçG&–W5FöF’ÂVæF–æu–÷WG5ÒÒv—B&öÖ—6RæÆÂ…°¢W6W"æ6÷VçDFö7VÖVçG2‡·Ò’À¢ff–Æ–FRæ6÷VçDFö7VÖVçG2‡·Ò’À¢ÖF6‚æ6÷VçDFö7VÖVçG2‡²ÖF6…7FGW3¢²Fæ–ã¢²vf–æ—6†VBrÂv6Æ÷6VBrÂvG&gBuÒÒÒ’À¢66÷&Ræ6÷VçDFö7VÖVçG2‡²7&VFVDC¢²FwFS¢æWrFFR„FFRææ÷r‚’Ò#B¢c¢c¢’ÒÒ’À¢ff–Æ–FRæ6÷VçDFö7VÖVçG2‡²w–÷WG2ç7FGW2s¢wVæF–ærrÒ’À¢Ò“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢vVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢6öæf–s¢°¢²Æ&VÃ¢tFF&6RG&ç67F–öç2rÂö³¢FF&6T6&–Æ—G’çG&ç67F–öç57W÷'FVBÂfÇVS¢FF&6T6&–Æ—G’çF÷öÆöw’À¢æ÷FS¢FF&6T6&–Æ—G’çG&ç67F–öç57W÷'FVBòtÖöæW’F‡26fRr¢u”BTåE$”U2t”ÄÂd”ÂrÒÀ¢²Æ&VÃ¢u–ÖVçB&÷f–FW"ÖöFRrÂö³¢æWBæ—4Æ—fRÂfÇVS¢æWBæ—4Æ—fRòw&öGV7F–öâr¢w6æF&÷‚rÀ¢æ÷FS¢æWBæ—4Æ—fRòuF¶–ær&VÂ–ÖVçG2r¢u6æF&÷‚(	Bæò&VÂÖöæW’Ö÷fW2rÒÀ¢²Æ&VÃ¢u–ÖVçBvV&†öö²6–væ–ærrÂö³¢6WB‚tUD„õ$•¤UôäUEõ4”täEU$Uô´U’r’ÂfÇVS¢6WB‚tUD„õ$•¤UôäUEõ4”täEU$Uô´U’r’òv6öæf–wW&VBr¢vÖ—76–ærrÀ¢æ÷FS¢uv—F†÷WB—BÂ–ÖVçB6öæf—&ÖF–öç2&R&V¦V7FVBrÒÀ¢²Æ&VÃ¢tVÖ–ÂFVÆ—fW'’rÂö³¢6WB‚u4ÕEõ52r’ÇÂ6WB‚ttÔ”Åôõ55tõ$Br’ÂfÇVS¢‡6WB‚u4ÕEõ52r’ÇÂ6WB‚ttÔ”Åôõ55tõ$Br’’òv6öæf–wW&VBr¢vÖ—76–ærrÀ¢æ÷FS¢u&V6V—G2Â–÷WG2æBÆW'G2ÆÂFWVæBöâF†—2rÒÀ¢²Æ&VÃ¢u66†VGVÆVB¦ö'2rÂö³¢6WB‚t5$ôåõ4T5$UBr’ÂfÇVS¢6WB‚t5$ôåõ4T5$UBr’òw&÷FV7FVBr¢vF—6&ÆVBrÀ¢æ÷FS¢6WB‚t5$ôåõ4T5$UBr’òt7&öâVæGö–çG2&WV—&RF†R6V7&WBr¢t¦ö'2&WGW&âS2VçF–Â5$ôåõ4T5$UB—26WBrÒÀ¢²Æ&VÃ¢tFÖ–â÷Æ–W"6V7&WG2F–ffW"rÂö³¢&ö6W72æVçbä¥uEõ4T5$UBÓÒ&ö6W72æVçbä¥uEõ4T5$UEôDÔ”âÂfÇVS¢&ö6W72æVçbä¥uEõ4T5$UBÓÒ&ö6W72æVçbä¥uEõ4T5$UEôDÔ”âòw–W2r¢t”DTåD”4ÂrÀ¢æ÷FS¢t–b–FVçF–6ÂÂç’Æ–W"Fö¶Vâ76W2FÖ–â6†V6·2rÒÀ¢²Æ&VÃ¢u–B7FFW2rÂö³¢”Eõ5DDU2æÆVæwF‚âÂfÇVS¢Gµ”Eõ5DDU2æÆVæwF‡Ò7FFW6À¢æ÷FS¢u&VÂÖÖöæW’6öçFW7G2&R÷Vâ–âF†W6RrÒÀ¢²Æ&VÃ¢tg&VR×Æ’öæÇ’†Æö6¶VB’rÂö³¢G'VRÂfÇVS¢e$TUôôäÅ•õ5DDU2æ¦ö–â‚rÂr’À¢æ÷FS¢u–B6öçFW7G26âæWfW"&RVæ&ÆVB†W&RÂ'’FW6–vârÒÀ¢²Æ&VÃ¢t&Æö6¶VB7FFW2rÂö³¢G'VRÂfÇVS¢$Äô4´TEõ5DDU2æÆVæwF‚ò$Äô4´TEõ5DDU2æ¦ö–â‚rÂr’¢væöæRrÀ¢æ÷FS¢tæò66W72BÆÂrÒÀ¢ÒÀ¢6÷VçG3¢²Æ–W'2Âff–Æ–FW2Â÷Väf–v‡G2ÂVçG&–W4Æ7C#Fƒ¢VçG&–W5FöF’ÂVæF–æu–÷WG2ÒÀ¢G'W7FVDFWf–6W3¢v—B÷væW$FWf–6Ræ6÷VçDFö7VÖVçG2‡·Ò’À¢fVGW&W3¢°¢†VEFô†VC¢„TEõDõô„TEôTä$ÄTBÀ¢&õw&W7FÆ–æs¢²wG'VRrÂsrÂw–W2rÂvöâuÒæ–æ6ÇVFW2…7G&–ær‡&ö6W72æVçbå$õõu$U5DÄ”äuôTä$ÄTBÇÂvfÇ6Rr’çFôÆ÷vW$66R‚’’À¢ÒÀ¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"÷fW'f–Wrf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B'V–ÆBF†R÷fW'f–WrârÒ“°¢Ð§Ò“° ¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò”åDTu$•E’(	BF†RVW7F–öç2F†BFVÆÂ–÷Rv†WF†W"F†R&öö·2&R7G&–v‡Bà¢òò&VBÖöæÇ“²WfW'’6†V6²&W÷'G26÷VçG2æB6ÖÆÂ6×ÆRÂæWfW"'VÆ²GV×à¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7B'Vä÷væW$–çFVw&—G”6†V6·2Ò7–æ2‚’Óâ°¢6öç7B6†V6·2ÒµÓ°¢6öç7BFBÒ†æÖRÂ6÷VçBÂFWF–ÂÂ6×ÆRÒµÒ’Óâ6†V6·2çW6‚‡°¢æÖRÂ6÷VçBÂö³¢6÷VçBÓÓÒÂFWF–ÂÂ6×ÆS¢6×ÆRç6Æ–6RƒÂ’À¢Ò“° ¢òòâVçG&–W26†&vVBv—F‚æòÆVFvW"&÷r(	BâVçG'’fVRF¶Vâv—F†÷WBâVF—BG&–Âà¢6öç7B–Df–v‡G2Òv—BÖF6‚æf–æB‡²ÖF6…Fö¶Vç3¢²FwC¢ÒÒ’ç6VÆV7B‚uö–Br’æÆ–Ö—BƒS’æÆVâ‚“°¢6öç7B–D–G2Ò–Df–v‡G2æÖ‚†b’Óâ7G&–ær†båö–B’“°¢6öç7BVçG&–W2Ò–D–G2æÆVæwF€¢òv—B66÷&Ræf–æB‡²ÖF6„–C¢²F–ã¢–D–G2ÒÂ&VgVæFVC¢²FæS¢G'VRÒÒ’ç6VÆV7B‚wÆ–W$–BÖF6„–Br’æÆ–Ö—BƒS’æÆVâ‚¢¢µÓ°¢6öç7BÆVFvW%&÷w2ÒVçG&–W2æÆVæwF€¢òv—Bf–v‡DVçG'”ÆVFvW"æf–æB‡²ÖF6„–C¢²F–ã¢–D–G2ÒÂG—S¢td”t…EôTåE%’rÒ’ç6VÆV7B‚wW6W$–BÖF6„–Br’æÆ–Ö—Bƒ#’æÆVâ‚¢¢µÓ°¢6öç7BÆVFvW$¶W—2ÒæWr6WB†ÆVFvW%&÷w2æÖ‚‡"’ÓâG·"çW6W$–GÓ¢G·"æÖF6„–GÖ’“°¢6öç7BVæVF—FVBÒVçG&–W2æf–ÇFW"‚†R’ÓâÆVFvW$¶W—2æ†2†G¶RçÆ–W$–GÓ¢G¶RæÖF6„–GÖ’“°¢FB‚u–BVçG&–W2v—F‚æòÆVFvW"&÷rrÂVæVF—FVBæÆVæwF‚À¢tÆ–W"v2VçFW&VB–çFò–Bf–v‡Bv—F†÷WB&V6÷&FVB6†&vRâVçG&–W27&VFVB&Vf÷&R6†&v–ærW†—7FVBv–ÆÂ6†÷r†W&RârÀ¢VæVF—FVBæÖ‚†R’Óâ‡²Æ–W$–C¢RçÆ–W$–BÂÖF6„–C¢RæÖF6„–BÒ’’“° ¢òò"â'&ö¶VâvÆÆWB6†–ç2(	BV6‚ÆVFvW"&÷r&V6÷&G2F†R&Ææ6R&Vf÷&Ræ@¢òògFW"Â6òv&WGvVVâ6öç6V7WF—fR&÷w2ÖVç2&Ææ6R6†ævVBv—F†÷W@¢òò&V–ær&V6÷&FVBç—v†W&Rà¢6öç7B&V6VçDÆVFvW"Òv—Bf–v‡DVçG'”ÆVFvW"æf–æB‡·Ò¢ç6VÆV7B‚wW6W$–BÖ÷VçB&Ææ6T&Vf÷&R&Ææ6TgFW"7&VFVDBr¢ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—BƒC’æÆVâ‚“°¢6öç7B'•W6W"ÒæWrÖ‚“°¢&V6VçDÆVFvW"æf÷$V6‚‚‡&÷r’Óâ°¢6öç7B¶W’Ò7G&–ær‡&÷rçW6W$–B“°¢–b‚'•W6W"æ†2†¶W’’’'•W6W"ç6WB†¶W’ÂµÒ“°¢'•W6W"ævWB†¶W’’çW6‚‡&÷r“°¢Ò“°¢6öç7B'&ö¶Vä6†–ç2ÒµÓ°¢'•W6W"æf÷$V6‚‚‡&÷w2ÂW6W$–B’Óâ°¢6öç7B÷&FW&VBÒ&÷w2ç6Æ–6R‚’ç&WfW'6R‚“°¢f÷"†ÆWB’Ò²’Â÷&FW&VBæÆVæwFƒ²’³Ò’°¢–b„çVÖ&W"†÷&FW&VE¶•Òæ&Ææ6T&Vf÷&R’ÓÒçVÖ&W"†÷&FW&VE¶’ÒÒæ&Ææ6TgFW"’’°¢'&ö¶Vä6†–ç2çW6‚‡°¢W6W$–BÀ¢W‡V7FVC¢çVÖ&W"†÷&FW&VE¶’ÒÒæ&Ææ6TgFW"’À¢f÷VæC¢çVÖ&W"†÷&FW&VE¶•Òæ&Ææ6T&Vf÷&R’À¢C¢÷&FW&VE¶•Òæ7&VFVDBÀ¢Ò“°¢'&V³°¢Ð¢Ð¢Ò“°¢FB‚uvÆÆWG2v—F‚âVç&V6÷&FVB&Ææ6R6†ævRrÂ'&ö¶Vä6†–ç2æÆVæwF‚À¢t&Ææ6RÖ÷fVB&WGvVVâGvò&V6÷&FVBÖ÷fW2âW7VÆÇ’âFÖ–âF§W7FÖVçBÖFR÷WG6–FRF†RÆVFvW"ârÀ¢'&ö¶Vä6†–ç2“° ¢òò2âf–v‡G2F†B†fRVçG&–W2æBöff–6–Â7FG2'WBvW&RæWfW"6WGFÆVBà¢6öç7Bf–æ—6†VEv—F…7FG2Òv—BÖF6‚æf–æB‡°¢&—¦W56WGFÆVDC¢²F–ã¢¶çVÆÂÂVæFVf–æVEÒÒÀ¢ÖF6„FFS¢²FÇC¢æWrFFR„FFRææ÷r‚’Ò"¢c¢c¢’ÒÀ¢Ò’ç6VÆV7B‚uö–BÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFR÷Br’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7BVç6WGFÆVBÒµÓ°¢f÷"†6öç7Bf–v‡Böbf–æ—6†VEv—F…7FG2’°¢6öç7BVçG'”6÷VçBÒv—B66÷&Ræ6÷VçDFö7VÖVçG2‡²ÖF6„–C¢7G&–ær†f–v‡Båö–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ“°¢–b†VçG'”6÷VçBâ’°¢Vç6WGFÆVBçW6‚‡°¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢f–v‡C¢G¶f–v‡BæÖF6„f–v‡FW$ÇÂsòwÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂsòwÖÀ¢VçG&–W3¢VçG'”6÷VçBÀ¢÷C¢çVÖ&W"†f–v‡Bç÷B’ÇÂÀ¢FFS¢f–v‡BæÖF6„FFRÀ¢Ò“°¢Ð¢Ð¢FB‚tf–v‡G2v—F‚VçG&–W2v—F–ær6WGFÆVÖVçBrÂVç6WGFÆVBæÆVæwF‚À¢uÆ–W'2–B–âæB†fRæ÷B&VVâ–B÷WBâ6WGFÆRF†W6Rg&öÒF†RFÖ–âf–v‡B67&VVâârÀ¢Vç6WGFÆVB“° ¢òò6"â6öçFW7G2v†W&RF†RFV6Æ&VB&—¦R—2æ÷B6÷fW&VB'’F†RVçG&–W2F¶Vâ(	@¢òòF†RÆFf÷&Òv÷VÆB&R––ærF†RF–ffW&Væ6Rà¢6öç7B÷Vå–BÒv—BÖF6‚æf–æB‡°¢&—¦W56WGFÆVDC¢²F–ã¢¶çVÆÂÂVæFVf–æVEÒÒÀ¢fö–FVDC¢²F–ã¢¶çVÆÂÂVæFVf–æVEÒÒÀ¢ÖF6…Fö¶Vç3¢²FwC¢ÒÀ¢÷C¢²FwC¢ÒÀ¢Ò’ç6VÆV7B‚uö–BÖF6„f–v‡FW$ÖF6„f–v‡FW$"÷BÖF6…Fö¶Vç26öÆÆV7FVDfVW2Ö–æ–×VÔVçG&çG2r’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7BVæ6÷fW&VBÒ÷Vå–@¢æÖ‚†f–v‡B’Óâ°¢6öç7B6öÆÆV7FVBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bæ6öÆÆV7FVDfVW2’ÇÂ“°¢6öç7BFV6Æ&VBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷B’ÇÂ“°¢&WGW&â°¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢f–v‡C¢G¶f–v‡BæÖF6„f–v‡FW$ÇÂsòwÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂsòwÖÀ¢FV6Æ&VE&—¦S¢FV6Æ&VBÀ¢fVW46öÆÆV7FVC¢6öÆÆV7FVBÀ¢6†÷'FfÆÃ¢ÖF‚æÖ‚ƒÂFV6Æ&VBÒ6öÆÆV7FVB’À¢Ó°¢Ò¢æf–ÇFW"‚‡&÷r’Óâ&÷rç6†÷'FfÆÂâ“°¢FB‚t÷Vâ6öçFW7G2æ÷B–WB6÷fW&–ærF†V—"&—¦RrÂVæ6÷fW&VBæÆVæwF‚À¢tVçG&–W26òf"Fòæ÷B6÷fW"F†R&—¦R&öÖ—6VBâF†W’v–ÆÂfö–BæB&VgVæBB6WGFÆVÖVçBVæÆW72Ö÷&RÆ–W'2VçFW"ârÀ¢Væ6÷fW&VB“° ¢òò62â‡—6–6Â&—¦W2vöâ'WBæ÷B–WB6VçBà¢6öç7BVæF–ætv&G2Òv—BÆ–W$v&Bæf–æB‡²gVÆf–ÆÖVçC¢wVæF–ærrÒ¢ç6VÆV7B‚væÖR7öç6÷$æÖR7&VFVDBr’ç6÷'B‡²7&VFVDC¢Ò’æÆ–Ö—Bƒ’æÆVâ‚“°¢6öç7B7FÆU&—¦W2ÒVæF–ætv&G2æf–ÇFW"‚‡&÷r’Óâ„FFRææ÷r‚’ÒæWrFFR‡&÷ræ7&VFVDB’ævWEF–ÖR‚’’âr¢#B¢3c¢“°¢FB‚u&—¦W2vöâ'WBæ÷B6VçBgFW"vVV²rÂ7FÆU&—¦W2æÆVæwF‚À¢uv–ææW'2&Rv—F–æröâÖW&6‚÷"7öç6÷"vööG2â6ÆV"F†W6Rg&öÒF†RgVÆf–ÆÖVçBVWVRârÀ¢7FÆU&—¦W2æÖ‚‡"’Óâ‡²&—¦S¢"ææÖRÂ7öç6÷#¢"ç7öç6÷$æÖRÂvöäC¢"æ7&VFVDBÒ’’“° ¢òòBâ–ÖVçG2F†BFöö²ÖöæW’'WBæWfW"7&VF—FVBà¢6öç7B7GV6´÷&FW'2Òv—B6ö–åW&6†6T÷&FW"æf–æB‡°¢7FGW3¢²F–ã¢²u$ô4U54”ärrÂtd”ÄTBuÒÒÀ¢7&VFVDC¢²FÇC¢æWrFFR„FFRææ÷r‚’Òc¢c¢’ÒÀ¢Ò’ç6VÆV7B‚v÷&FW$çVÖ&W"VÖ–Â7FGW27V'F÷FÄ6VçG27&VFVDBr’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ’æÆVâ‚“°¢FB‚t6ö–â÷&FW'27GV6²÷"f–ÆVBrÂ7GV6´÷&FW'2æÆVæwF‚À¢t–ÖVçBÖ’†fR&VVâF¶Vâv—F†÷WB6ö–ç2&V–ær7&VF—FVBâ6†V6²V6‚v–ç7BF†R–ÖVçB&÷f–FW"ârÀ¢7GV6´÷&FW'2æÖ‚†ò’Óâ‡²÷&FW$çVÖ&W#¢òæ÷&FW$çVÖ&W"ÂVÖ–Ã¢òæVÖ–ÂÂ7FGW3¢òç7FGW2ÂÖ÷VçC¢†òç7V'F÷FÄ6VçG2ÇÂ’òÒ’’“° ¢òòRâ–÷WG2âff–Æ–FR—2v—F–æröâà¢6öç7Bv—F…VæF–ærÒv—Bff–Æ–FRæf–æB‡²w–÷WG2ç7FGW2s¢wVæF–ærrÒ¢ç6VÆV7B‚vf—'7DæÖRÆ7DæÖRVÖ–Â–÷WG2r’æÆ–Ö—Bƒ#’æÆVâ‚“°¢6öç7B7FÆU–÷WG2ÒµÓ°¢v—F…VæF–æræf÷$V6‚‚†ff–Æ–FR’Óâ°¢†ff–Æ–FRç–÷WG2ÇÂµÒ’æf÷$V6‚‚‡–÷WBÂ–æFW‚’Óâ°¢6öç7B7&VFVBÒ–÷WCòç&WVW7FVDBÇÂ–÷WCòæ7&VFVDC°¢6öç7BvT†÷W'2Ò7&VFVBò„FFRææ÷r‚’ÒæWrFFR†7&VFVB’ævWEF–ÖR‚’’ò3c¢°¢–b…7G&–ær‡–÷WCòç7FGW2ÇÂrr’çFôÆ÷vW$66R‚’ÓÓÒwVæF–ærrbbvT†÷W'2âC‚’°¢7FÆU–÷WG2çW6‚‡°¢ff–Æ–FS¢G¶ff–Æ–FRæf—'7DæÖRÇÂrwÒG¶ff–Æ–FRæÆ7DæÖRÇÂrwÖçG&–Ò‚’À¢Ö÷VçC¢çVÖ&W"‡–÷WBæÖ÷VçB’ÇÂÀ¢v—F–æt†÷W'3¢ÖF‚ç&÷VæB†vT†÷W'2’À¢–÷WD–æFWƒ¢–æFW‚À¢Ò“°¢Ð¢Ò“°¢Ò“°¢FB‚u–÷WG2VæF–ær÷fW"C‚†÷W'2rÂ7FÆU–÷WG2æÆVæwF‚À¢tff–Æ–FW2&Rv—F–æröâÖöæW’â&÷fR÷"&V¦V7Bg&öÒF†R–÷WG267&VVâârÀ¢7FÆU–÷WG2“° ¢òòbâ†VB×FòÖ†VBW67&÷rÆVgB†öÆF–ær6ö–ç2öâ6WGFÆVBf–v‡Bà¢–b„„TEõDõô„TEôTä$ÄTB’°¢6öç7B6WGFÆVDf–v‡D–G2Ò†v—BÖF6‚æf–æB‡²&—¦W56WGFÆVDC¢²FæS¢çVÆÂÒÒ’ç6VÆV7B‚uö–Br’æÆ–Ö—BƒS’æÆVâ‚’¢æÖ‚†b’Óâ7G&–ær†båö–B’“°¢6öç7B7GV6²Ò6WGFÆVDf–v‡D–G2æÆVæwF€¢òv—B6†ÆÆVævRæf–æB‡²f–v‡D–C¢²F–ã¢6WGFÆVDf–v‡D–G2ÒÂ7FGW3¢²F–ã¢²uTäD”ärrÂt44UDTBuÒÒÒ¢ç6VÆV7B‚vf–v‡D–B7F¶R7FGW2r’æÆ–Ö—Bƒ#’æÆVâ‚¢¢µÓ°¢FB‚t6†ÆÆVævW2†öÆF–ær6ö–ç2öâ6WGFÆVBf–v‡BrÂ7GV6²æÆVæwF‚À¢tW67&÷rv2æ÷B&VÆV6VBâ&R×'Vâ6WGFÆRÖ6†ÆÆVævW2f÷"F†÷6Rf–v‡G2ârÀ¢7GV6²æÖ‚†2’Óâ‡²6†ÆÆVævT–C¢7G&–ær†2åö–B’Âf–v‡D–C¢2æf–v‡D–BÂ7F¶S¢2ç7F¶RÂ7FGW3¢2ç7FGW2Ò’’“°¢Ð ¢6öç7B&ö&ÆV×2Ò6†V6·2æf–ÇFW"‚†2’Óâ2æö²“°¢&WGW&â°¢vVæW&FVDC¢æWrFFR‚’çFô•4õ7G&–ær‚’À¢ÆÄ6ÆV#¢&ö&ÆV×2æÆVæwF‚ÓÓÒÀ¢&ö&ÆVÔ6÷VçC¢&ö&ÆV×2æÆVæwF‚À¢6†V6·2À¢Ó°§Ó° ¦ævWB‚rö’ö÷væW"ö–çFVw&—G’rÂfW&–g”÷væW%Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂâââ†v—B'Vä÷væW$–çFVw&—G”6†V6·2‚’’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t÷væW"–çFVw&—G’6†V6²f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢t6÷VÆBæ÷B6ö×ÆWFRF†R6†V6·2ârÒ“°¢Ð§Ò“° ¢òòæ–v‡FÇ’'VââVÖ–Ç2ôäÅ’v†Vâ6öÖWF†–ær—2w&öærÂ6ò6–ÆVæ6RÖVç2F†R&öö·0¢òò&Ææ6RæBF†RÖ–Â7F—2v÷'F‚&VF–ærà¦ævWB‚rö’ö7&öâö÷væW"Ö–çFVw&—G’rÂfW&–g”7&öå6V7&WBÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&W÷'BÒv—B'Vä÷væW$–çFVw&—G”6†V6·2‚“°¢–b‡&W÷'BæÆÄ6ÆV"’&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÆÄ6ÆV#¢G'VRÂVÖ–ÆVC¢fÇ6RÒ“° ¢6öç7B&ö&ÆV×2Ò&W÷'Bæ6†V6·2æf–ÇFW"‚†2’Óâ2æö²“°¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢õtäU%ôTÔ”ÂÀ¢7V&¦V7C¢´dÔÕÒG·&ö&ÆV×2æÆVæwF‡ÒF†–ærG·&ö&ÆV×2æÆVæwF‚ÓÓÒòrr¢w2wÒæVVBG·&ö&ÆV×2æÆVæwF‚ÓÓÒòw2r¢rwÒ–÷W"GFVçF–öæÀ¢†VF–æs¢tä”t…DÅ’4„T4²rÀ¢Æ–æW3¢&ö&ÆV×2æÖ‚‡’ÓâÇ7G&öæsâG·ææÖWÓ¢G·æ6÷VçGÓÂ÷7G&öæsãÆ'"óâG¶W66T‡FÖÂ‡æFWF–Â—Ö’À¢fö÷FW#¢t÷VâF†R÷væW"f–Wrf÷"F†RgVÆÂÆ—7Bâ–÷RöæÇ’vWBF†—2VÖ–Âv†Vâ6öÖWF†–ær—2öfbârÀ¢Ò“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂÆÄ6ÆV#¢fÇ6RÂ&ö&ÆVÔ6÷VçC¢&ö&ÆV×2æÆVæwF‚ÂVÖ–ÆVC¢G'VRÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tæ–v‡FÇ’–çFVw&—G’6†V6²f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ö³¢fÇ6RÂÖW76vS¢tæ–v‡FÇ’6†V6²f–ÆVBârÒ“°¢Ð§Ò“° ¢òò6VçG&Æ—¦VB&WVW7B÷WÆöBW'&÷"†æFÆ–ærâF†—2¶VW2W†—7F–ærWÆöB&÷WFW2–çF7@¢òòv†–ÆR&WGW&æ–ærFWFW&Ö–æ—7F–2G‡‚&W7öç6W2f÷"ÖÆf÷&ÖVB÷"÷fW'6—¦VB&WVW7G2à¦çW6R‚†W'&÷"Â&WÂ&W2ÂæW‡B’Óâ°¢–b†W'&÷"–ç7Fæ6Vöb×VÇFW"ä×VÇFW$W'&÷"’°¢6öç7B—4f–ÆUFöôÆ&vRÒW'&÷"æ6öFRÓÓÒtÄ”Ô•Eôd”ÄUõ4•¤Rs°¢&WGW&â&W2ç7FGW2†—4f–ÆUFöôÆ&vRòC2¢C’æ§6öâ‡°¢ÖW76vS¢—4f–ÆUFöôÆ&vP¢òWÆöFVBf–ÆR—2FöòÆ&vRâÖ†–×VÒÆÆ÷vVB6—¦R—2G´Ô…õUÄôEôd”ÄUõ4•¤Uô%•DU7Ò'—FW2æ ¢¢W'&÷"æÖW76vRÀ¢6öFS¢W'&÷"æ6öFRÀ¢Ò“°¢Ð ¢–b‡&Wæf–ÆUfÆ–FF–öäW'&÷"’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢&Wæf–ÆUfÆ–FF–öäW'&÷"Ò“°¢Ð ¢–b†W'&÷#òç7FGW46öFR’°¢&WGW&â&W2ç7FGW2†W'&÷"ç7FGW46öFR’æ§6öâ‡²ÖW76vS¢W'&÷"æÖW76vRÂ6öFS¢W'&÷"æ6öFRÒ“°¢Ð ¢–b†W'&÷#òæÖW76vRÓÓÒtæ÷BÆÆ÷vVB'’4õ%2r’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢t÷&–v–â—2æ÷BÆÆ÷vVB'’4õ%2ârÒ“°¢Ð ¢–b†W'&÷#òçG—RÓÓÒvVçF—G’çFöòæÆ&vRr’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢&WVW7B&öG’—2FöòÆ&vRâÖ†–×VÒ¥4ôâ&öG’6—¦R—2G´¥4ôåô$ôE•ôÄ”Ô•GÒæÒ“°¢Ð ¢–b†W'&÷"–ç7Fæ6Vöb7–çF„W'&÷"bbW'&÷"ç7FGW2ÓÓÒCbbv&öG’r–âW'&÷"’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tÖÆf÷&ÖVB¥4ôâ&WVW7B&öG’ârÒ“°¢Ð ¢&WGW&âæW‡B†W'&÷"“°§Ò“° ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òò44õ$U"DTÄTtD”ôà¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò×VÇF—ÆRÆ—fRWfVçG2öâöæRæ–v‡BÖVç2F†R÷væW"6ææ÷B&RBWfW'’6&Bà¢òò66÷&W"—2FVÆVvFVB—"öb†æG3¢F†W’Væ6‚&÷VæG2–â2F†W’†Và¢òòæBF†÷6R&÷VæG2vòÆ—fR–ÖÖVF–FVÇ’Â'WBF†W’6âäUdU"f–æÆ—¦Rf–v‡BÀ¢òò6WGFÆR—BÂ÷"’ç–&öG’âf–æÆ—¦F–öâ7F—2FÖ–âÖöæÇ’Âv†–6‚—2F†Rv†öÆP¢òò6fWG’&÷W'G’†W&Rà¢òð¢òòGvòv—2–âÂ&÷F‚ÆæF–æröâF†R6ÖR66÷VBFö¶Vã ¢òò¢Ä”ä²ÒöæR×F–ÖRU$Âf÷"67VÂ†VÇW"âæò66÷VçBâ&÷VæBFòöæP¢òòf–v‡BÂW‡—&W2Â6–ævÆR6Æ–ÒÂ&Wfö6&ÆRà¢òò¢44õTåBÒW&ÖæVçB7FfbÆöv–âF†BöæÇ’WfW"6VW2f–v‡G2W‡Æ–6—FÇ¢òò76–væVBFò—Bà¢òð¢òòv†B66÷&W"×W7Bæ÷B6VR†÷væW"w26ÆÂ“¢F†R÷BæBVçG'’fVW2ÂF†P¢òòVçG&çBÆ—7BæBF†V—"&VF–7F–öç2Â÷F†W"f–v‡G2öâF†R6&BÂæBç—F†–æp¢òò&÷WBF†Rff–Æ–FR÷&öÖ÷FW"â'V–ÆE66÷&W$f–v‡Ef–Wr‚’—2F†RöæÇ’6†R¢òò66÷&W"Fö¶Vâ6âWfW"&VBÂ6òF†÷6Rf–VÆG26ææ÷BÆV²'’66–FVçBà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ ¦6öç7B44õ$U%õ44õRÒw66÷&W"s°¦6öç7B44õ$U%ôÄ”äµõEDÅô„õU%2ÒçVÖ&W"‡&ö6W72æVçbå44õ$U%ôÄ”äµõEDÅô„õU%2ÇÂ#B“°¦6öç7B44õ$U%õ4U54”ôåõEDÂÒ&ö6W72æVçbå44õ$U%õ4U54”ôåõEDÂÇÂs&‚s° ¦6öç7B66÷&W$66÷VçE66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢æÖS¢²G—S¢7G&–ærÂG&–Ó¢G'VRÂFVfVÇC¢rrÒÀ¢VÖ–Ã¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂG&–Ó¢G'VRÂÆ÷vW&66S¢G'VRÂVæ—VS¢G'VRÒÀ¢77v÷&D†6ƒ¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÒÀ¢7F—fS¢²G—S¢&ööÆVâÂFVfVÇC¢G'VRÒÀ¢7&VFVD'“¢²G—S¢7G&–ærÂFVfVÇC¢vFÖ–ârÒÀ¢Æ7DÆöv–äC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B66÷&W$76–væÖVçE66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢f–v‡D–C¢²G—S¢7G&–ærÂ&WV—&VC¢G'VRÂ–æFWƒ¢G'VRÒÀ¢f–v‡DÆ&VÃ¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢ÖöFS¢²G—S¢7G&–ærÂVçVÓ¢²vÆ–æ²rÂv66÷VçBuÒÂ&WV—&VC¢G'VRÒÀ¢66÷&W$æÖS¢²G—S¢7G&–ærÂG&–Ó¢G'VRÂFVfVÇC¢rrÒÀ¢66÷&W$VÖ–Ã¢²G—S¢7G&–ærÂG&–Ó¢G'VRÂÆ÷vW&66S¢G'VRÂFVfVÇC¢rrÒÀ¢66÷VçD–C¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢òòöæÇ’F†R†6‚—27F÷&VBâF†R&rÆ–æ²Fö¶Vâ—26†÷vâöæ6RÂB7&VF–öâà¢Fö¶Vä†6ƒ¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢W‡—&W4C¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢6Æ–ÖVDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢&Wfö¶VDC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ¢7&VFVD'“¢²G—S¢7G&–ærÂFVfVÇC¢vFÖ–ârÒÀ¢&÷VæG57V&Ö—GFVC¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢Æ7E7V&Ö—DC¢²G—S¢FFRÂFVfVÇC¢çVÆÂÒÀ§ÒÂ²F–ÖW7F×3¢G'VRÒ“° ¦6öç7B66÷&W$Æöu66†VÖÒæWrÖöævö÷6Rå66†VÖ‡°¢76–væÖVçD–C¢²G—S¢7G&–ærÂ–æFWƒ¢G'VRÒÀ¢f–v‡D–C¢²G—S¢7G&–ærÂ–æFWƒ¢G'VRÒÀ¢66÷&W#¢²G—S¢7G&–ærÂFVfVÇC¢rrÒÀ¢&÷VæDçVÖ&W#¢²G—S¢çVÖ&W"ÂFVfVÇC¢ÒÀ¢–ÆöC¢²G—S¢Ööævö÷6Rå66†VÖåG—W2äÖ—†VBÂFVfVÇC¢·ÒÒÀ¢C¢²G—S¢FFRÂFVfVÇC¢FFRææ÷rÒÀ§Ò“° ¦6öç7B66÷&W$66÷VçBÒÖöævö÷6RæÖöFVÇ2å66÷&W$66÷VçBÇÂÖöævö÷6RæÖöFVÂ‚u66÷&W$66÷VçBrÂ66÷&W$66÷VçE66†VÖ“°¦6öç7B66÷&W$76–væÖVçBÒÖöævö÷6RæÖöFVÇ2å66÷&W$76–væÖVçBÇÂÖöævö÷6RæÖöFVÂ‚u66÷&W$76–væÖVçBrÂ66÷&W$76–væÖVçE66†VÖ“°¦6öç7B66÷&W$ÆörÒÖöævö÷6RæÖöFVÇ2å66÷&W$ÆörÇÂÖöævö÷6RæÖöFVÂ‚u66÷&W$ÆörrÂ66÷&W$Æöu66†VÖ“° ¢òòÆ—fR66÷&–ær—2'W'7G’(	B66÷&W"6÷'&V7F–ær&÷VæBrF‡&VRF–ÖW2–âÖ–çWFP¢òò—2æ÷&ÖÂâF†RvVæW&–27V&Ö—DÆ–Ö—FW"ƒ#W"Ö–â’v÷VÆBÆö6²F†VÒ÷W@¢òòÖ–BÖf–v‡BÂ6ò66÷&–ærvWG2—G2÷vâÂ&ööÖ–W"Æ–Ö—Bà¦6öç7B66÷&W$Æ–Ö—FW"Ò&FTÆ–Ö—B‡°¢v–æF÷t×3¢R¢c¢À¢Öƒ¢#À¢7FæF&D†VFW'3¢G'VRÀ¢ÆVv7”†VFW'3¢fÇ6RÀ¢ÖW76vS¢²ÖW76vS¢uFöòÖç’66÷&R7V&Ö—76–öç2âv—BÖöÖVçBæBG'’v–âârÒÀ§Ò“° ¦6öç7B†6…66÷&W%Fö¶VâÒ‡&r’Óâ7'—Fòæ7&VFT†6‚‚w6†#Sbr’çWFFR…7G&–ær‡&r’’æF–vW7B‚v†W‚r“° ¦6öç7B6–vå66÷&W%6W76–öâÒ†76–væÖVçB’Óâ§wBç6–vâ‡°¢–C¢7G&–ær†76–væÖVçBåö–B’À¢66÷S¢44õ$U%õ44õRÀ¢f–v‡D–C¢7G&–ær†76–væÖVçBæf–v‡D–B’À¢66÷VçD–C¢7G&–ær†76–væÖVçBæ66÷VçD–BÇÂrr’À§ÒÂ&ö6W72æVçbä¥uEõ4T5$UBÂ²W‡—&W4–ã¢44õ$U%õ4U54”ôåõEDÂÒ“° ¢òò66÷&W"Fö¶Vâ—2FVÆ–&W&FVÇ’äõB66WFVB'’fW&–g•Fö¶Vâw2Æ–W"&÷WFW3 ¢òòF†—2Ö–FFÆWv&R—2F†RöæÇ’Fö÷"—B÷Vç2à¦6öç7BfW&–g•66÷&W%Fö¶VâÒ7–æ2‡&WÂ&W2ÂæW‡B’Óâ°¢6öç7B†VFW"Ò&Wæ†VFW'2æWF†÷&—¦F–öâÇÂrs°¢6öç7B&rÒ†VFW"ç7F'G5v—F‚‚t&V&W"r’ò†VFW"ç6Æ–6Rƒr’¢çVÆÃ°¢–b‚&r’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u66÷&W"6W76–öâ&WV—&VBârÂ6öFS¢täõõ44õ$U%õDô´TârÒ“°¢G'’°¢6öç7B6Æ–×2Ò§wBçfW&–g’‡&rÂ&ö6W72æVçbä¥uEõ4T5$UB“°¢–b†6Æ–×2ç66÷RÓÒ44õ$U%õ44õR’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢uF†—26W76–öâ6ææ÷B66÷&Rf–v‡G2ârÂ6öFS¢uu$ôäuõ44õRrÒ“°¢Ð¢6öç7B76–væÖVçBÒv—B66÷&W$76–væÖVçBæf–æD'”–B†6Æ–×2æ–B“°¢–b‚76–væÖVçBÇÂ76–væÖVçBç&Wfö¶VDB’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢uF†—266÷&–ær76–væÖVçB†2&VVâ&Wfö¶VBârÂ6öFS¢u$Udô´TBrÒ“°¢Ð¢–b†76–væÖVçBæW‡—&W4Bbb76–væÖVçBæW‡—&W4BævWEF–ÖR‚’ÂFFRææ÷r‚’’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢uF†—266÷&–ær76–væÖVçB†2W‡—&VBârÂ6öFS¢tU…•$TBrÒ“°¢Ð¢&Wç66÷&W"Ò76–væÖVçC°¢&WGW&âæW‡B‚“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢t–çfÆ–B÷"W‡—&VB66÷&W"6W76–öâârÂ6öFS¢t$Eõ44õ$U%õDô´TârÒ“°¢Ð§Ó° ¢òòF†RôäÅ’f–v‡B6†R66÷&W"Fö¶Vâ6â&VBâæò÷BÂæòÖF6…Fö¶Vç2Âæð¢òòVçG&çG2Âæòff–Æ–FRÂæò6–&Æ–ærf–v‡G2öâF†R6&Bà¦gVæ7F–öâ'V–ÆE66÷&W$f–v‡Ef–Wr†ÖF6‚Â76–væÖVçB’°¢6öç7B6FVv÷'’Òæ÷&ÖÆ—¦T6öÖ&D6FVv÷'’†ÖF6‚æÖF6„6FVv÷'’“°¢6öç7B6öçF–æW"Ò6FVv÷'’ÓÓÒv&÷†–ærrò†ÖF6‚ä&÷†–ætÖF6‚ÇÂ·Ò’¢†ÖF6‚äÔÔÖF6‚ÇÂ·Ò“°¢&WGW&â°¢–C¢7G&–ær†ÖF6‚åö–B’À¢æÖS¢ÖF6‚æÖF6„æÖRÇÂrrÀ¢6FVv÷'’À¢6FVv÷'•Gvó¢ÖF6‚æÖF6„6FVv÷'•GvòÇÂrrÀ¢f–v‡FW$¢ÖF6‚æÖF6„f–v‡FW$ÇÂrrÀ¢f–v‡FW$#¢ÖF6‚æÖF6„f–v‡FW$"ÇÂrrÀ¢f–v‡FW$–ÖvS¢ÖF6‚æf–v‡FW$–ÖvRÇÂrrÀ¢f–v‡FW$$–ÖvS¢ÖF6‚æf–v‡FW$$–ÖvRÇÂrrÀ¢Ö…&÷VæG3¢çVÖ&W"†ÖF6‚æÖ…&÷VæG2ÇÂ’ÇÂ"À¢ÖF6„FFS¢ÖF6‚æÖF6„FFRÇÂrrÀ¢ÖF6…F–ÖS¢ÖF6‚æÖF6…F–ÖRÇÂrrÀ¢7FGW3¢ÖF6‚æÖF6…7FGW2ÇÂrrÀ¢7FE6WC¢6FVv÷'’ÓÓÒv&÷†–ærrò²t…rÂt%rÂuEuÒ¢²u5BrÂt´’rÂt´ârÂtTÂuÒÀ¢f–v‡FW$öæU7FG3¢'&’æ—4'&’†6öçF–æW"æf–v‡FW$öæU7FG2’ò6öçF–æW"æf–v‡FW$öæU7FG2¢µÒÀ¢f–v‡FW%Gvõ7FG3¢'&’æ—4'&’†6öçF–æW"æf–v‡FW%Gvõ7FG2’ò6öçF–æW"æf–v‡FW%Gvõ7FG2¢µÒÀ¢76–væÖVçC¢°¢–C¢7G&–ær†76–væÖVçBåö–B’À¢66÷&W$æÖS¢76–væÖVçBç66÷&W$æÖRÇÂrrÀ¢ÖöFS¢76–væÖVçBæÖöFRÀ¢W‡—&W4C¢76–væÖVçBæW‡—&W4BÀ¢&÷VæG57V&Ö—GFVC¢76–væÖVçBç&÷VæG57V&Ö—GFVBÇÂÀ¢òò7FFVBFòF†R66÷&W"w2÷vâT’6òF†RÆ–Ö—B—2f—6–&ÆRÂæ÷B7W'&—6RC2à¢6äf–æÆ—¦S¢fÇ6RÀ¢ÒÀ¢Ó°§Ð ¢òòÒÒÒFÖ–ã¢7Ffb66÷&W"66÷VçG2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–â÷66÷&W'2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG’æVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B77v÷&BÒ7G&–ær‡&Wæ&öG’ç77v÷&BÇÂrr“°¢–b‚VÖ–ÂÇÂ77v÷&B’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢tVÖ–ÂæB77v÷&B&R&WV—&VBârÒ“°¢–b‡77v÷&BæÆVæwF‚Â‚’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u77v÷&B×W7B&RBÆV7B‚6†&7FW'2ârÒ“°¢6öç7BW†—7F–ærÒv—B66÷&W$66÷VçBæf–æDöæR‡²VÖ–ÂÒ“°¢–b†W†—7F–ær’&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ÖW76vS¢t66÷&W"Ç&VG’W†—7G2v—F‚F†BVÖ–ÂârÒ“°¢6öç7B66÷VçBÒv—B66÷&W$66÷VçBæ7&VFR‡°¢VÖ–ÂÀ¢æÖS¢7G&–ær‡&Wæ&öG’ææÖRÇÂrr’çG&–Ò‚’À¢77v÷&D†6ƒ¢v—B&7'—Bæ†6‚‡77v÷&BÂ’À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ66÷&W#¢²–C¢66÷VçBåö–BÂVÖ–Ã¢66÷VçBæVÖ–ÂÂæÖS¢66÷VçBææÖRÂ7F—fS¢66÷VçBæ7F—fRÒÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t7&VFR66÷&W"f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B7&VFRF†R66÷&W"66÷VçBârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–â÷66÷&W'2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2…÷&WÂ&W2’Óâ°¢G'’°¢6öç7B66÷VçG2Òv—B66÷&W$66÷VçBæf–æB‡·Ò’ç6VÆV7B‚væÖRVÖ–Â7F—fRÆ7DÆöv–äB7&VFVDBr’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ66÷&W'3¢66÷VçG2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöB66÷&W'2ârÒ“°¢Ð§Ò“° ¦çF6‚‚rö’öFÖ–â÷66÷&W'2ó¦–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BWFFRÒ·Ó°¢–b‡G—Vöb&Wæ&öG’æ7F—fRÓÓÒv&ööÆVâr’WFFRæ7F—fRÒ&Wæ&öG’æ7F—fS°¢–b‡&Wæ&öG’ææÖRÓÒVæFVf–æVB’WFFRææÖRÒ7G&–ær‡&Wæ&öG’ææÖR’çG&–Ò‚“°¢–b‡&Wæ&öG’ç77v÷&B’°¢–b…7G&–ær‡&Wæ&öG’ç77v÷&B’æÆVæwF‚Â‚’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u77v÷&B×W7B&RBÆV7B‚6†&7FW'2ârÒ“°¢WFFRç77v÷&D†6‚Òv—B&7'—Bæ†6‚…7G&–ær‡&Wæ&öG’ç77v÷&B’Â“°¢Ð¢6öç7B66÷VçBÒv—B66÷&W$66÷VçBæf–æD'”–DæEWFFR‡&Wç&×2æ–BÂWFFRÂ²æWs¢G'VRÒ’ç6VÆV7B‚væÖRVÖ–Â7F—fRr“°¢–b‚66÷VçB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢u66÷&W"æ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ66÷&W#¢66÷VçBÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BWFFRF†R66÷&W"ârÒ“°¢Ð§Ò“° ¢òòÒÒÒFÖ–ã¢†æBf–v‡BFò6öÖV&öG’ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷66÷&W'2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bf–v‡D–BÒ7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚“°¢6öç7BÖF6‚Òv—BÖF6‚æf–æD'”–B†f–v‡D–B’ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"r“°¢–b‚ÖF6‚’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7BÖöFRÒ7G&–ær‡&Wæ&öG’æÖöFRÇÂvÆ–æ²r’çFôÆ÷vW$66R‚’ÓÓÒv66÷VçBròv66÷VçBr¢vÆ–æ²s°¢6öç7Bf–v‡DÆ&VÂÒÖF6‚æÖF6„æÖRÇÂG¶ÖF6‚æÖF6„f–v‡FW$Òg2G¶ÖF6‚æÖF6„f–v‡FW$'Ö° ¢–b†ÖöFRÓÓÒv66÷VçBr’°¢6öç7B66÷VçBÒv—B66÷&W$66÷VçBæf–æD'”–B…7G&–ær‡&Wæ&öG’æ66÷VçD–BÇÂrr’“°¢–b‚66÷VçBÇÂ66÷VçBæ7F—fR’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u–6²â7F—fR66÷&W"66÷VçBârÒ“°¢6öç7B76–væÖVçBÒv—B66÷&W$76–væÖVçBæ7&VFR‡°¢f–v‡D–BÂf–v‡DÆ&VÂÂÖöFS¢v66÷VçBrÀ¢66÷VçD–C¢7G&–ær†66÷VçBåö–B’À¢66÷&W$æÖS¢66÷VçBææÖRÇÂ66÷VçBæVÖ–ÂÀ¢66÷&W$VÖ–Ã¢66÷VçBæVÖ–ÂÀ¢7&VFVD'“¢7G&–ær‡&WæFÖ–ãòæ–BÇÂvFÖ–âr’À¢Ò“°¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ76–væÖVçC¢²–C¢76–væÖVçBåö–BÂÖöFS¢v66÷VçBrÂ66÷&W$æÖS¢76–væÖVçBç66÷&W$æÖRÒÒ“°¢Ð ¢6öç7B&uFö¶VâÒ7'—Fòç&æFöÔ'—FW2ƒ#B’çFõ7G&–ær‚v†W‚r“°¢6öç7BW‡—&W4BÒæWrFFR„FFRææ÷r‚’²44õ$U%ôÄ”äµõEDÅô„õU%2¢c¢c¢“°¢6öç7B76–væÖVçBÒv—B66÷&W$76–væÖVçBæ7&VFR‡°¢f–v‡D–BÂf–v‡DÆ&VÂÂÖöFS¢vÆ–æ²rÀ¢66÷&W$æÖS¢7G&–ær‡&Wæ&öG’ç66÷&W$æÖRÇÂrr’çG&–Ò‚’À¢66÷&W$VÖ–Ã¢7G&–ær‡&Wæ&öG’ç66÷&W$VÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚’À¢Fö¶Vä†6ƒ¢†6…66÷&W%Fö¶Vâ‡&uFö¶Vâ’À¢W‡—&W4BÀ¢7&VFVD'“¢7G&–ær‡&WæFÖ–ãòæ–BÇÂvFÖ–âr’À¢Ò“° ¢6öç7B÷&–v–âÒ7G&–ær‡&ö6W72æVçbåT$Ä”5ôõU$ÂÇÂv‡GG3¢ò÷wwræfçF7–ÖÖFæW72æ6öÒr’ç&WÆ6R‚õÂòBòÂrr“°¢6öç7BÆ–æ²ÒG¶÷&–v–çÒ÷66÷&RòG·&uFö¶VçÖ° ¢ÆWBVÖ–Å6VçBÒfÇ6S°¢ÆWBVÖ–ÄW'&÷"Òrs°¢–b†76–væÖVçBç66÷&W$VÖ–Â’°¢G'’°¢v—BG&ç7÷'FW"ç6VæDÖ–Â‡°¢g&öÓ¢dÔÕôÔ”Åôe$ôÒÀ¢Fó¢76–væÖVçBç66÷&W$VÖ–ÂÀ¢7V&¦V7C¢–÷R&R66÷&–ærG¶f–v‡DÆ&VÇÖÀ¢‡FÖÃ¢Çå–÷R†fR&VVâ6¶VBFò66÷&RÇ7G&öæsâG¶f–v‡DÆ&VÇÓÂ÷7G&öæsâãÂ÷à¢ÇãÆ‡&VcÒ"G¶Æ–æ·Ò#ä÷VâF†R66÷&V6&CÂöãÂ÷à¢ÇåF†—2Æ–æ²v÷&·2öæ6RæBW‡—&W2–âGµ44õ$U%ôÄ”äµõEDÅô„õU%7Ò†÷W'2â–÷R6â7V&Ö—B&÷VæG22F†W’†Vã²öæÇ’F†R&öÖ÷FW"6âf–æÆ—¦RF†Rf–v‡BãÂ÷æÀ¢Ò“°¢VÖ–Å6VçBÒG'VS°¢Ò6F6‚†Ö–ÄW'&÷"’°¢6öç6öÆRçv&â‚u66÷&W"–çf—FRVÖ–Âf–ÆVC¢rÂÖ–ÄW'&÷#òæÖW76vR“°¢VÖ–ÄW'&÷"ÒÖ–ÄW'&÷#òæÖW76vRÇÂtVÖ–ÂFVÆ—fW'’f–ÆVBâs°¢Ð¢Ð ¢òòF†R&rFö¶Vâ—2&WGW&æVBW†7FÇ’öæ6RÂ†W&RÇS#B6òF†RFÖ–â6â7F–ÆÀ¢òò6÷’÷7FR—BÖçVÆÇ’–bF†RVÖ–Âf–ÆVBFò6VæBà¢&WGW&â&W2ç7FGW2ƒ#’æ§6öâ‡²ö³¢G'VRÂ76–væÖVçC¢²–C¢76–væÖVçBåö–BÂÖöFS¢vÆ–æ²rÂW‡—&W4BÒÂÆ–æ²ÂVÖ–Å6VçBÂVÖ–ÄW'&÷"Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚t76–vâ66÷&W"f–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B76–vâ66÷&W"ârÒ“°¢Ð§Ò“° ¦ævWB‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷66÷&W'2rÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&÷w2Òv—B66÷&W$76–væÖVçBæf–æB‡²f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’Ò¢ç6VÆV7B‚r×Fö¶Vä†6‚r’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ76–væÖVçG3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöB66÷&W"76–væÖVçG2ârÒ“°¢Ð§Ò“° ¦æFVÆWFR‚rö’öFÖ–â÷66÷&W"Ö76–væÖVçG2ó¦–BrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B76–væÖVçBÒv—B66÷&W$76–væÖVçBæf–æD'”–DæEWFFR‡&Wç&×2æ–BÂ²&Wfö¶VDC¢æWrFFR‚’ÒÂ²æWs¢G'VRÒ“°¢–b‚76–væÖVçB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢t76–væÖVçBæ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂ&Wfö¶VDC¢76–væÖVçBç&Wfö¶VDBÒ“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B&Wfö¶RF†R76–væÖVçBârÒ“°¢Ð§Ò“° ¢òòVF—C¢v†BF–BF†RFVÆVvFVB66÷&W"7GVÆÇ’Væ6‚–âà¦ævWB‚rö’öFÖ–âöf–v‡G2ó¦f–v‡D–B÷66÷&W"ÖÆörrÂfW&–g”FÖ–åFö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&÷w2Òv—B66÷&W$Æöræf–æB‡²f–v‡D–C¢7G&–ær‡&Wç&×2æf–v‡D–BÇÂrr’çG&–Ò‚’Ò¢ç6÷'B‡²C¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂVçG&–W3¢&÷w2Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöBF†R66÷&W"ÆörârÒ“°¢Ð§Ò“° ¢òòÒÒÒ66÷&W#¢vWGF–ær–âÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ç÷7B‚rö’÷66÷&W"ö6Æ–ÒrÂ7V&Ö—DÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7B&rÒ7G&–ær‡&Wæ&öG’çFö¶VâÇÂrr’çG&–Ò‚“°¢–b‚&r’&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢u66÷&–ærÆ–æ²Fö¶Vâ—2&WV—&VBârÒ“°¢6öç7B76–væÖVçBÒv—B66÷&W$76–væÖVçBæf–æDöæR‡²Fö¶Vä†6ƒ¢†6…66÷&W%Fö¶Vâ‡&r’ÂÖöFS¢vÆ–æ²rÒ“°¢–b‚76–væÖVçBÇÂ76–væÖVçBç&Wfö¶VDB’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢uF†—266÷&–ærÆ–æ²—2æòÆöævW"fÆ–BârÒ“°¢–b†76–væÖVçBæW‡—&W4Bbb76–væÖVçBæW‡—&W4BævWEF–ÖR‚’ÂFFRææ÷r‚’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uF†—266÷&–ærÆ–æ²†2W‡—&VBâ6²f÷"æWröæRârÒ“°¢Ð¢–b‚76–væÖVçBæ6Æ–ÖVDB’°¢76–væÖVçBæ6Æ–ÖVDBÒæWrFFR‚“°¢v—B76–væÖVçBç6fR‚“°¢Ð¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂFö¶Vã¢6–vå66÷&W%6W76–öâ†76–væÖVçB’Âf–v‡DÆ&VÃ¢76–væÖVçBæf–v‡DÆ&VÂÒ“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u66÷&W"6Æ–Òf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B÷VâF†R66÷&V6&BârÒ“°¢Ð§Ò“° ¦ç÷7B‚rö’÷66÷&W"öÆöv–ârÂ7V&Ö—DÆ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BVÖ–ÂÒ7G&–ær‡&Wæ&öG’æVÖ–ÂÇÂrr’çG&–Ò‚’çFôÆ÷vW$66R‚“°¢6öç7B77v÷&BÒ7G&–ær‡&Wæ&öG’ç77v÷&BÇÂrr“°¢6öç7B66÷VçBÒv—B66÷&W$66÷VçBæf–æDöæR‡²VÖ–ÂÒ“°¢–b‚66÷VçBÇÂ66÷VçBæ7F—fRÇÂ†v—B&7'—Bæ6ö×&R‡77v÷&BÂ66÷VçBç77v÷&D†6‚’’’°¢&WGW&â&W2ç7FGW2ƒC’æ§6öâ‡²ÖW76vS¢uw&öærVÖ–Â÷"77v÷&BârÒ“°¢Ð¢6öç7B76–væÖVçG2Òv—B66÷&W$76–væÖVçBæf–æB‡°¢66÷VçD–C¢7G&–ær†66÷VçBåö–B’À¢&Wfö¶VDC¢çVÆÂÀ¢Ò’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆVâ‚“°¢–b‚76–væÖVçG2æÆVæwF‚’&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢u–÷R†fRæòf–v‡G276–væVB&–v‡Bæ÷rârÒ“° ¢66÷VçBæÆ7DÆöv–äBÒæWrFFR‚“°¢v—B66÷VçBç6fR‚“° ¢òòöæR6W76–öâW"76–væÖVçC¢F†RFö¶Vâ—2f–v‡BÖ&÷VæB'’FW6–vâÂ6ò¢òò7Ffb66÷&W"–6·2F†Rf–v‡BæBvWG2F†RFö¶Vâf÷"F†Bf–v‡BöæÇ’à¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢66÷&W#¢²æÖS¢66÷VçBææÖRÂVÖ–Ã¢66÷VçBæVÖ–ÂÒÀ¢f–v‡G3¢76–væÖVçG2æÖ‚†’Óâ‡°¢76–væÖVçD–C¢7G&–ær†åö–B’À¢f–v‡D–C¢æf–v‡D–BÀ¢f–v‡DÆ&VÃ¢æf–v‡DÆ&VÂÀ¢Fö¶Vã¢6–vå66÷&W%6W76–öâ†’À¢Ò’’À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u66÷&W"Æöv–âf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6–vâ–âârÒ“°¢Ð§Ò“° ¢òòÒÒÒ66÷&W#¢F†RFW6²ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦ævWB‚rö’÷66÷&W"öf–v‡BrÂfW&–g•66÷&W%Fö¶VâÂ7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖF6‚Òv—BÖF6‚æf–æD'”–B‡&Wç66÷&W"æf–v‡D–B“°¢–b‚ÖF6‚’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂf–v‡C¢'V–ÆE66÷&W$f–v‡Ef–Wr†ÖF6‚Â&Wç66÷&W"’Ò“°¢Ò6F6‚†W'&÷"’°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöBF†Rf–v‡BârÒ“°¢Ð§Ò“° ¢òò&÷VæG2vòÆ—fRF†RÖöÖVçBF†W’&R7V&Ö—GFVBâF†—2—2F†R6ÖRw&—FRF€¢òòF†RFÖ–âFW6²W6W2†Ç•&÷VæE&W7VÇG5FôÖF6‚’Â6òE—27F–ÆÂæWfW ¢òò6ö×WFVBg&öÒ…²%æBF†R7FB6WB7F–ÆÂföÆÆ÷w2F†R6FVv÷'’à¦ç÷7B‚rö’÷66÷&W"öf–v‡B÷&÷VæG2rÂfW&–g•66÷&W%Fö¶VâÂ66÷&W$Æ–Ö—FW"Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7BÖF6‚Òv—BÖF6‚æf–æD'”–B‡&Wç66÷&W"æf–v‡D–B“°¢–b‚ÖF6‚’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tf–v‡Bæ÷Bf÷VæBârÒ“° ¢6öç7Bf–æ—6†VBÒ7G&–ær†ÖF6‚æÖF6…7FGW2ÇÂrr’çFôÆ÷vW$66R‚“°¢–b…²v6ö×ÆWFVBrÂvf–æ—6†VBrÂw6WGFÆVBuÒæ–æ6ÇVFW2†f–æ—6†VB’’°¢&WGW&â&W2ç7FGW2ƒC’’æ§6öâ‡²ÖW76vS¢uF†—2f–v‡B—2Ç&VG’f–æÆ—¦VBâ&÷VæG2&RÆö6¶VBârÂ6öFS¢td”äÄ•¤TBrÒ“°¢Ð ¢G'’°¢Ç•&÷VæE&W7VÇG5FôÖF6‚†ÖF6‚Â°¢f–v‡FW$öæU7FG3¢&Wæ&öG’æf–v‡FW$öæU7FG2À¢f–v‡FW%Gvõ7FG3¢&Wæ&öG’æf–v‡FW%Gvõ7FG2À¢Ò“°¢Ò6F6‚‡66÷&–ætW'&÷"’°¢&WGW&â&W2ç7FGW2‡66÷&–ætW'&÷"ç7FGW46öFRÇÂC’æ§6öâ‡²ÖW76vS¢66÷&–ætW'&÷"æÖW76vRÒ“°¢Ð¢v—BÖF6‚ç6fR‚“° ¢6öç7B&÷VæDçVÖ&W"ÒçVÖ&W"‡&Wæ&öG“òæf–v‡FW$öæU7FG3òç&÷VæDçVÖ&W"ÇÂ&Wæ&öG“òæf–v‡FW%Gvõ7FG3òç&÷VæDçVÖ&W"ÇÂ“°¢&Wç66÷&W"ç&÷VæG57V&Ö—GFVBÒ‡&Wç66÷&W"ç&÷VæG57V&Ö—GFVBÇÂ’²°¢&Wç66÷&W"æÆ7E7V&Ö—DBÒæWrFFR‚“°¢v—B&Wç66÷&W"ç6fR‚“°¢v—B66÷&W$Æöræ7&VFR‡°¢76–væÖVçD–C¢7G&–ær‡&Wç66÷&W"åö–B’À¢f–v‡D–C¢7G&–ær‡&Wç66÷&W"æf–v‡D–B’À¢66÷&W#¢&Wç66÷&W"ç66÷&W$æÖRÇÂ&Wç66÷&W"ç66÷&W$VÖ–ÂÇÂw66÷&W"rÀ¢&÷VæDçVÖ&W"À¢–ÆöC¢²f–v‡FW$öæU7FG3¢&Wæ&öG’æf–v‡FW$öæU7FG2Âf–v‡FW%Gvõ7FG3¢&Wæ&öG’æf–v‡FW%Gvõ7FG2ÒÀ¢Ò“° ¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂf–v‡C¢'V–ÆE66÷&W$f–v‡Ef–Wr†ÖF6‚Â&Wç66÷&W"’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u66÷&W"&÷VæB7V&Ö—Bf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷B6fRF†R&÷VæBârÒ“°¢Ð§Ò“° ¢òòW‡Æ–6—BÂ6ò66÷&W"†—GF–ærF†RvÆÂvWG2âW‡ÆæF–öâ&F†W"F†âCBà¦ç÷7B‚rö’÷66÷&W"öf–v‡Böf–æÆ—¦RrÂfW&–g•66÷&W%Fö¶VâÂ…÷&WÂ&W2’Óâ&W2ç7FGW2ƒC2’æ§6öâ‡°¢ÖW76vS¢u66÷&W'26ææ÷Bf–æÆ—¦Rf–v‡BâF†R&öÖ÷FW"f–æÆ—¦W2æB—2÷WBârÀ¢6öFS¢td”äÄ•¤Uô•5ôDÔ”åôôäÅ’rÀ§Ò’“°  ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òòdd”Ä”DRÔôäU’tP¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòöæR&VBf÷"F†R&öÖ÷FW"w2v†öÆRf–ææ6–Â–7GW&RâFVÆ–&W&FVÇ’æ'&÷vW ¢òòF†âF†RFÖ–âf–Ws¢&öÖ÷FW"6VW2D„T•"f–v‡G2ÂD„T•"&¶RæBD„T• ¢òò–÷WG2ÂæBæ÷F†–ær&÷WB÷F†W"ff–Æ–FW2ÂF†RÆFf÷&Òw2÷vâ7WBÂ÷"F†P¢òòFÖ–âÖöæÇ’ÆWfW'2‡WÆöF–ærÆ—fR6&BÂ6WGF–ær÷B’âF†÷6R7F’–âF†P¢òò&6²öff–6Rà¢òð¢òòV&æ–æw2&Ræ÷B&V6Æ7VÆFVB†W&RâF†W’&R&VB&6²÷WBöbF†RvÆÆW@¢òòÆVFvW"&÷w26WGFÆVÖVçBÇ&VG’w&÷FR‡&V6öã¢vff–Æ–FU÷÷E÷6†&Rr’Â6òF†—0¢òòvR6âæWfW"F—6w&VRv—F‚v†Bv27GVÆÇ’–Bà¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¦ævWB‚rö’öff–Æ–FW2öÖRöÖöæW’rÂfW&–g•Fö¶VâÂ&WV—&U66÷R…Dô´Tåõ44õU2ädd”Ä”DR’Â7–æ2‡&WÂ&W2’Óâ°¢G'’°¢6öç7Bff–Æ–FT–BÒ7G&–ær‡&WçW6W#òæ–BÇÂ&WçW6W#òåö–BÇÂrr’çG&–Ò‚“°¢6öç7Bff–Æ–FRÒv—Bff–Æ–FRæf–æD'”–B†ff–Æ–FT–B’ç6VÆV7B‚vff–Æ–FTæÖRVÖ–ÂFö¶Vç2–÷WG2r“°¢–b‚ff–Æ–FR’&WGW&â&W2ç7FGW2ƒCB’æ§6öâ‡²ÖW76vS¢tff–Æ–FRæ÷Bf÷VæBârÒ“° ¢6öç7B&Ææ6RÒçVÖ&W"ç'6T–çB…7G&–ær†ff–Æ–FRçFö¶Vç2ÇÂsr’Â’ÇÂ° ¢òòÒÒÒV&æ–æw2Â7G&–v‡Bg&öÒF†R6WGFÆVÖVçBÆVFvW"ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢6öç7BÆVFvW%&÷w2Òv—Bf–v‡DVçG'”ÆVFvW"æf–æB‡°¢W6W$–C¢ff–Æ–FT–BÀ¢vÖWFFFç&V6öâs¢vff–Æ–FU÷÷E÷6†&RrÀ¢Ò’ç6÷'B‡²7&VFVDC¢ÓÒ’æÆ–Ö—Bƒ#’æÆVâ‚“° ¢6öç7Bf–v‡D–G2Ò²ââææWr6WB†ÆVFvW%&÷w2æÖ‚‡&÷r’Óâ7G&–ær‡&÷ræÖF6„–B’’æf–ÇFW"„&ööÆVâ’•Ó°¢6öç7Bf–v‡DFö72Òv—BÖF6‚æf–æB‡²ö–C¢²F–ã¢f–v‡D–G2ÒÒ¢ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6„6FVv÷'’÷B6öÆÆV7FVDfVW2r¢æÆVâ‚“°¢6öç7Bf–v‡D'”–BÒæWrÖ†f–v‡DFö72æÖ‚†b’Óâµ7G&–ær†båö–B’ÂeÒ’“° ¢6öç7BV&æ–æw2ÒÆVFvW%&÷w2æÖ‚‡&÷r’Óâ°¢6öç7BÖWFÒ&÷ræÖWFFFÇÂ·Ó°¢6öç7Bf–v‡BÒf–v‡D'”–BævWB…7G&–ær‡&÷ræÖF6„–B’’ÇÂ·Ó°¢&WGW&â°¢f–v‡D–C¢7G&–ær‡&÷ræÖF6„–B’À¢f–v‡DÆ&VÃ¢f–v‡BæÖF6„æÖRÇÂG¶f–v‡BæÖF6„f–v‡FW$ÇÂrwÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂrwÖçG&–Ò‚’À¢6FVv÷'“¢f–v‡BæÖF6„6FVv÷'’ÇÂrrÀ¢6WGFÆVDC¢&÷ræ7&VFVDBÀ¢VçG&çG3¢çVÖ&W"†ÖWFæVçG&çG2ÇÂ’À¢òòv†BF†R6öçFW7BFöö²–âÂg2F†R÷BF†Bv2&öÖ—6VB÷WBà¢&WfVçVS¢çVÖ&W"†ÖWFæ6öÆÆV7FVDfVW2ÇÂ’À¢÷EF÷FÃ¢çVÖ&W"†ÖWFç÷EF÷FÂÇÂ’À¢6†&U7C¢çVÖ&W"†ÖWFç6†&U7BÇÂdd”Ä”DUõ5Ä•Eõ5B’À¢òòF†RSR&¶R7Æ—G2–çFòf—†VB7WBöbF†RFV6Æ&VB÷BÇW2†Æbö`¢òòWfW'—F†–ærF†R6öçFW7BFöö²&÷fR—Bâ6†÷vâ'B&V6W6RF†R6V6öæ@¢òòçVÖ&W"—2F†RöæRF†Bw&÷w2v—F‚&–vvW"f–VÆBà¢f—†VD7WC¢çVÖ&W"†ÖWFæf—†VD7WBÇÂ’À¢7W'ÇW56†&S¢çVÖ&W"†ÖWFç7W'ÇW56†&RÇÂ’À¢F÷FÃ¢ÖF‚ç&÷VæB„çVÖ&W"‡&÷ræÖ÷VçB’ÇÂ’À¢Ó°¢Ò“° ¢6öç7BÆ–fWF–ÖTV&æVBÒV&æ–æw2ç&VGV6R‚‡7VÒÂ&÷r’Óâ7VÒ²&÷rçF÷FÂÂ“° ¢òòÒÒÒ7F¶VB6†F÷rf–v‡G3¢÷Bf–ÆÂæB&öf—B¦öæRÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òò7F¶VB6&G2Æ—fR–â$õD‚6öÆÆV7F–öç3¢6†F÷rFV×ÆFRF†R&öÖ÷FW ¢òò7F¶VBÂæBÆ—fR6&BF†W’7&VFVBF‡&÷Vv‚F†R&öÖ÷F–öâFW6²‡v†–6€¢òò6fW2FòÖF6‚’â&VF–æröæÇ’6†F÷r6–ÆVçFÇ’†–B†ÆbF†V—"ÖöæW’à¢6öç7B7F¶UVW'’Ò°¢F÷#¢·²ff–Æ–FT–BÒÂ²tff–Æ–FT–G2äff–Æ–FT–Bs¢ff–Æ–FT–BÕÒÀ¢÷EF&vWC¢²FwC¢ÒÀ¢Ó°¢6öç7B7F¶Tf–VÆG2ÒvÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"÷B÷EF&vWB&öÖ÷FW%7F¶R&öf—E¦öæU&V6†VDBW6W%&VF–7F–öç2ÖF6„FFRs°¢6öç7B7F¶VDf–v‡G2Ò°¢âââ†v—B6†F÷ræf–æB‡7F¶UVW'’’ç6VÆV7B‡7F¶Tf–VÆG2’æÆVâ‚’’À¢âââ†v—BÖF6‚æf–æB‡7F¶UVW'’’ç6VÆV7B‡7F¶Tf–VÆG2’æÆVâ‚’’À¢Ó° ¢6öç7B7F¶W2Ò7F¶VDf–v‡G2æÖ‚†f–v‡B’Óâ°¢6öç7BF&vWBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷EF&vWB’ÇÂ“°¢6öç7Bf–ÆÆVBÒÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç÷B’ÇÂ“°¢6öç7BVçG&çG2Ò'&’æ—4'&’†f–v‡BçW6W%&VF–7F–öç2¢òf–v‡BçW6W%&VF–7F–öç2æf–ÇFW"‚‡R’Óâ7G&–ær‡Sòç&VF–7F–öå7FGW2’ÓÓÒw7V&Ö—GFVBr’æÆVæwF€¢¢°¢6öç7B&öf—D&÷fU7F¶RÒÖF‚æÖ‚ƒÂf–ÆÆVBÒF&vWB“°¢&WGW&â°¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢f–v‡DÆ&VÃ¢f–v‡BæÖF6„æÖRÇÂG¶f–v‡BæÖF6„f–v‡FW$ÇÂrwÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂrwÖçG&–Ò‚’À¢ÖF6„FFS¢f–v‡BæÖF6„FFRÇÂrrÀ¢7F¶VC¢ÖF‚æÖ‚ƒÂçVÖ&W"†f–v‡Bç&öÖ÷FW%7F¶R’ÇÂF&vWB’À¢÷EF&vWC¢F&vWBÀ¢÷Df–ÆÆVC¢f–ÆÆVBÀ¢f–ÆÅ7C¢F&vWBòÖF‚æÖ–âƒÂÖF‚ç&÷VæB‚†f–ÆÆVBòF&vWB’¢’’¢À¢VçG&çG2À¢–å&öf—E¦öæS¢F&vWBâbbf–ÆÆVBãÒF&vWBÀ¢&öf—E¦öæU&V6†VDC¢f–v‡Bç&öf—E¦öæU&V6†VDBÇÂçVÆÂÀ¢&öf—D&÷fU7F¶RÀ¢–÷W%&ö¦V7FVE6†&S¢ÖF‚æfÆö÷"‚‡&öf—D&÷fU7F¶R¢dd”Ä”DUõ5Ä•Eõ5B’ò’À¢Ó°¢Ò“° ¢òòÒÒÒ–÷WG2ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢6öç7B–÷WG2Ò†ff–Æ–FRç–÷WG2ÇÂµÒ’æÖ‚‡Â–æFW‚’Óâ‡°¢–æFW‚À¢Ö÷VçC¢çVÖ&W"‡æÖ÷VçBÇÂ’À¢7FGW3¢ç7FGW2ÇÂwVæF–ærrÀ¢&WVW7FVDC¢æ7&VFVDBÀ¢&W6öÇfVDC¢ç&W6öÇfVDBÇÂçVÆÂÀ¢&V6öã¢ç&V6öâÇÂrrÀ¢Ò’’ç6÷'B‚†Â"’ÓâæWrFFR†"ç&WVW7FVDBÇÂ’ÒæWrFFR†ç&WVW7FVDBÇÂ’“° ¢6öç7B–D÷WBÒ–÷WG2æf–ÇFW"‚‡’Óâç7FGW2ÓÓÒw–Br’ç&VGV6R‚‡7VÒÂ’Óâ7VÒ²æÖ÷VçBÂ“°¢6öç7BVæF–ærÒ–÷WG2æf–ÇFW"‚‡’Óâç7FGW2ÓÓÒwVæF–ærr’ç&VGV6R‚‡7VÒÂ’Óâ7VÒ²æÖ÷VçBÂ“° ¢&WGW&â&W2æ§6öâ‡°¢ö³¢G'VRÀ¢ff–Æ–FS¢²æÖS¢ff–Æ–FRæff–Æ–FTæÖRÇÂrrÂVÖ–Ã¢ff–Æ–FRæVÖ–ÂÇÂrrÒÀ¢7VÖÖ'“¢°¢&Ææ6RÀ¢Æ–fWF–ÖTV&æVBÀ¢–D÷WBÀ¢VæF–æu–÷WG3¢VæF–ærÀ¢7Æ—E7C¢dd”Ä”DUõ5Ä•Eõ5BÀ¢f–v‡G56WGFÆVC¢V&æ–æw2æÆVæwF‚À¢F÷FÄVçG&çG3¢V&æ–æw2ç&VGV6R‚‡7VÒÂ&÷r’Óâ7VÒ²&÷ræVçG&çG2Â’À¢ÒÀ¢V&æ–æw2À¢7F¶W2À¢–÷WG2À¢Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚tff–Æ–FRÖöæW’vRf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢t6÷VÆBæ÷BÆöB–÷W"V&æ–æw2ârÒ“°¢Ð§Ò“°  ¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ¢òò4„õ%DdÄÂ5tTU(	Bf–ÆÇ2Â÷"—B&VgVæG0¢òòÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòF†RFVfVÇBFVÂöâ–B6&B—26–×ÆS¢–bVæ÷Vv‚V÷ÆRVçFW"Â—B'Vç3°¢òò–bF†W’FöâwBÂ—BæWfW"†Vç2æBWfW'–&öG’vWG2F†V—"ÖöæW’&6²âF†B—0¢òòv†BÖ¶W2&öÖ÷F–ær66W76–&ÆR(	B&öÖ÷FW"æVVG2âVF–Væ6RÂæ÷B6—FÂà¢òð¢òò&öÖ÷FW"4âWBÖöæW’&V†–æBF†R&—¦R‡&öÖ÷FW%7F¶RãÒ÷B’âF†B6&@¢òò—2wV&çFVVC¢—B'Vç2†÷vWfW"fWrGW&âWÂæBF†R6†÷'FfÆÂ6öÖW2÷WBö`¢òòF†V—"7F¶RâwV&çFVVB6&G2&R6¶—VB'’F†—27vVWVçF—&VÇ’à¢òð¢òòWFõ&VgVæD–e6†÷'BÇ&VG’W†—7FVB'WBöæÇ’&â–ç6–FR6WGFÆVÖVçB(	B’æRâgFW ¢òòf–v‡Bv2÷fW"æBöæÇ’v†VââFÖ–âv÷B&÷VæBFò—Bâ6òâVæFW&f–ÆÆV@¢òò6&B6B÷VâÂFöö²VçG&–W2ÂæBæö&öG’v2FöÆBâF†—26Æ÷6W2F†Bà¢òð¢òòF‡&VRÖöÖVçG2ÂV6‚f—&VBöæ6S ¢òòBÓf‚&öÖ÷FW"v&æVBÂv—F‚F†RçVÖ&W"F†W’7F–ÆÂæVVBâF–ÖRFòW6‚à¢òòBÓ‚VçG&çG2v&æVB—BÖ’fö–BÂv—F‚6&G2F†B$Rf–ÆÆ–ærâF–ÖRFòÖ÷fRà¢òòÆö6²fö–BÂ&VgVæBWfW'’VçG'’ÂFVÆÂF†VÒv†W&RVÇ6RFòÆ’à¢òð¢òòf—fRÖ–çWFW2ræ÷F–6Rv2F†R÷&–v–æÂ–FVæB—B—2FöòÆFRFò&RW6VgVÃ ¢òòF†R&öÖ÷FW"6ææ÷B&W67VR6&B–âf—fRÖ–çWFW2æBÆ–W"6ææ÷BvW@¢òò–çFòæ÷F†W"öæR&Vf÷&R—G2÷vâÆö6²à¢òòÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÐ ¦6öç7B$ôÔõDU%õt$åôÕ2ÒçVÖ&W"‡&ö6W72æVçbå4„õ%DdÄÅõ$ôÔõDU%õt$åôÕ2ÇÂb¢c¢c¢“°¦6öç7BÄ”U%õt$åôÕ2ÒçVÖ&W"‡&ö6W72æVçbå4„õ%DdÄÅõÄ”U%õt$åôÕ2ÇÂc¢c¢“°¦6öç7Bôõ$”t”âÒ7G&–ær‡&ö6W72æVçbåT$Ä”5ôõU$ÂÇÂv‡GG3¢ò÷wwræfçF7–ÖÖFæW72æ6öÒr’ç&WÆ6R‚õÂòBòÂrr“° ¢òòÆö6²—2F†Rf–v‡Bw2÷vâÆö6´Bv†Vâ6WBÂ÷F†W'v—6RF†R66†VGVÆVB7F'Bà¢òòÖF6…F–ÖR—2Æö6Â$„ƒ¤ÔÒ"7G&–ærÆöæw6–FRFFRÂ6ò—B†2Fò&RföÆFV@¢òò–â(	BW6–ærF†R&&RFFRv÷VÆBG&VBWfW'’6&B2Æö6¶–ærBÖ–Fæ–v‡Bà¦gVæ7F–öâ&W6öÇfTf–v‡DÆö6´B†f–v‡B’°¢–b†f–v‡BæÆö6´B’&WGW&âæWrFFR†f–v‡BæÆö6´B“°¢–b‚f–v‡BæÖF6„FFR’&WGW&âçVÆÃ°¢6öç7B&6RÒæWrFFR†f–v‡BæÖF6„FFR“°¢–b„çVÖ&W"æ—4æâ†&6RævWEF–ÖR‚’’’&WGW&âçVÆÃ°¢6öç7BF–ÖRÒ7G&–ær†f–v‡BæÖF6…F–ÖRÇÂrr’çG&–Ò‚“°¢6öç7B'G2ÒF–ÖRæÖF6‚‚õâ…ÆG³Ã'Ò“¢…ÆG³'Ò’Bò“°¢–b‡'G2’&6Rç6WD†÷W'2„çVÖ&W"‡'G5³Ò’ÂçVÖ&W"‡'G5³%Ò’ÂÂ“°¢&WGW&â&6S°§Ð ¦gVæ7F–öâf–v‡DÆ&VÄöb†f–v‡B’°¢&WGW&âf–v‡BæÖF6„æÖRÇÂG¶f–v‡BæÖF6„f–v‡FW$ÇÂtf–v‡FW"wÒg2G¶f–v‡BæÖF6„f–v‡FW$"ÇÂtf–v‡FW""wÖ°§Ð ¢òò6&G27G&æFVBÆ–W"6âÖ÷fRFó¢÷VâÂ–B÷"g&VRÂ6ööæW7Bf—'7BÂæ@¢òòæWfW"F†RöæRF†W’vW&R§W7B&VgVæFVBg&öÒà¦7–æ2gVæ7F–öâf–æDÇFW&æF—fTf–v‡G2†W†6ÇVFT–BÂÆ–Ö—BÒ2’°¢6öç7Bæ÷rÒæWrFFR‚“°¢6öç7B&÷w2Òv—BÖF6‚æf–æB‡°¢ö–C¢²FæS¢W†6ÇVFT–BÒÀ¢fö–FVDC¢²FW†—7G3¢fÇ6RÒÀ¢ÖF6„FFS¢²FwFS¢æ÷rÒÀ¢ÖF6…7FGW3¢²Fæ–ã¢²vf–æ—6†VBrÂv6ö×ÆWFVBrÂtG&gBrÂvG&gBuÒÒÀ¢Ò’ç6VÆV7B‚vÖF6„æÖRÖF6„f–v‡FW$ÖF6„f–v‡FW$"ÖF6„FFRÖF6…Fö¶Vç2÷Br’ç6÷'B‡²ÖF6„FFS¢Ò’æÆ–Ö—B†Æ–Ö—B’æÆVâ‚“°¢&WGW&â&÷w2æÖ‚‡&÷r’Óâ‡°¢–C¢7G&–ær‡&÷råö–B’À¢Æ&VÃ¢f–v‡DÆ&VÄöb‡&÷r’À¢fVS¢ÖF‚æÖ‚ƒÂçVÖ&W"‡&÷ræÖF6…Fö¶Vç2’ÇÂ’À¢÷C¢ÖF‚æÖ‚ƒÂçVÖ&W"‡&÷rç÷B’ÇÂ’À¢Ò’“°§Ð ¦gVæ7F–öâÇFW&æF—fW4‡FÖÂ†ÇFW&æF—fW2’°¢–b‚ÇFW&æF—fW2æÆVæwF‚’&WGW&âtæWr6&G2÷VâÆÂF†RF–ÖR(	B¶VWâW–RöâF†Râs°¢6öç7B—FV×2ÒÇFW&æF—fW2æÖ‚†ÇB’Óâ°¢6öç7B6÷7BÒÇBæfVRâòG¶ÇBæfVRçFôÆö6ÆU7G&–ær‚—ÒFòVçFW&¢tg&VRFòVçFW"s°¢&WGW&âÆ‡&VcÒ"G´ôõ$”t”çÒöf–v‡BòG¶ÇBæ–GÒ"7G–ÆSÒ&6öÆ÷#¢6c&#SCC²#âG¶ÇBæÆ&VÇÓÂöâ(	BG¶6÷7GÒÂG¶ÇBç÷BçFôÆö6ÆU7G&–ær‚—Ò÷F°¢Ò“°¢&WGW&âF†W6R&R÷Vâ&–v‡Bæ÷s£Æ'#âG¶—FV×2æ¦ö–â‚sÆ'#âr—Ö°§Ð ¦7–æ2gVæ7F–öâVçG&çG4öb†f–v‡D–B’°¢6öç7B&÷w2Òv—B66÷&Ræf–æB‡²ÖF6„–C¢7G&–ær†f–v‡D–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ¢ç6VÆV7B‚wÆ–W$–Br’æÆVâ‚“°¢6öç7B–G2Ò²ââææWr6WB‡&÷w2æÖ‚‡&÷r’Óâ7G&–ær‡&÷rçÆ–W$–B’’æf–ÇFW"„&ööÆVâ’•Ó°¢–b‚–G2æÆVæwF‚’&WGW&âµÓ°¢&WGW&âW6W"æf–æB‡²ö–C¢²F–ã¢–G2ÒÒ’ç6VÆV7B‚vVÖ–Âf—'7DæÖRÆ–W$æÖRr’æÆVâ‚“°§Ð ¦7–æ2gVæ7F–öâ7vVW6†÷'Df–v‡G2‡²æ÷rÒæWrFFR‚’ÒÒ·Ò’°¢6öç7B7VÖÖ'’Ò²6†V6¶VC¢Â&öÖ÷FW%v&æVC¢ÂÆ–W'5v&æVC¢Âfö–FVC¢Â&VgVæFVC¢Ó° ¢òòöæÇ’–BÂVç6WGFÆVBÂVçfö–FVB6&G2v—F‚FV6Æ&VB&—¦R6â&R6†÷'Bà¢6öç7B†÷&—¦öâÒæWrFFR†æ÷rævWEF–ÖR‚’²$ôÔõDU%õt$åôÕ2“°¢6öç7Bf–v‡G2Òv—BÖF6‚æf–æB‡°¢fö–FVDC¢²FW†—7G3¢fÇ6RÒÀ¢&—¦W56WGFÆVDC¢²FW†—7G3¢fÇ6RÒÀ¢ÖF6…Fö¶Vç3¢²FwC¢ÒÀ¢÷C¢²FwC¢ÒÀ¢ÖF6„FFS¢²FÇFS¢†÷&—¦öâÒÀ¢Ò’æÆ–Ö—Bƒ#“° ¢f÷"†6öç7Bf–v‡Böbf–v‡G2’°¢6öç7BÆö6´BÒ&W6öÇfTf–v‡DÆö6´B†f–v‡B“°¢–b‚Æö6´B’6öçF–çVS°¢7VÖÖ'’æ6†V6¶VB³Ò° ¢6öç7BfVRÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖF6…Fö¶Vç2’ÇÂ’“°¢6öç7B÷BÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç÷B’ÇÂ’“°¢6öç7B7F¶RÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡Bç&öÖ÷FW%7F¶R’ÇÂ’“°¢6öç7BÆFf÷&ÔgVæF–ærÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BçÆFf÷&Ô6öçG&–'WF–öâ’ÇÂ’“° ¢òòwV&çFVVB6&C¢F†R&öÖ÷FW"w2ÖöæW’—2Ç&VG’&V†–æBF†R&—¦RÂ6ò¢òòF†–â&ööÒ—2F†V—"&ö&ÆVÒæBF†Rf–v‡B7F–ÆÂ'Vç2à¢–b‡7F¶R²ÆFf÷&ÔgVæF–ærãÒ÷Bbb÷Bâ’6öçF–çVS°¢–b†f–v‡BæWFõ&VgVæD–e6†÷'BÓÓÒfÇ6R’6öçF–çVS° ¢6öç7B'&V´WfVâÒfVRâòÖF‚æ6V–Â„ÖF‚æÖ‚ƒÂ÷BÒ7F¶RÒÆFf÷&ÔgVæF–ær’òfVR’¢°¢6öç7B&WV—&VBÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB„çVÖ&W"†f–v‡BæÖ–æ–×VÔVçG&çG2’ÇÂ’’ÇÂ'&V´WfVã°¢–b‡&WV—&VBÃÒ’6öçF–çVS° ¢6öç7BVçG&–W2Òv—B66÷&Ræ6÷VçDFö7VÖVçG2‡²ÖF6„–C¢7G&–ær†f–v‡Båö–B’Â&VgVæFVC¢²FæS¢G'VRÒÒ“°¢–b†VçG&–W2ãÒ&WV—&VB’6öçF–çVS° ¢6öç7B×5FôÆö6²ÒÆö6´BævWEF–ÖR‚’Òæ÷rævWEF–ÖR‚“°¢6öç7B6†÷'BÒ&WV—&VBÒVçG&–W3°¢6öç7BÆ&VÂÒf–v‡DÆ&VÄöb†f–v‡B“° ¢òòÒÒÒÒÆö6²&V6†VC¢fö–BæB&VgVæBÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢–b†×5FôÆö6²ÃÒ’°¢6öç7B&VgVæBÒv—B&VgVæDf–v‡DVçG&–W2‡°¢f–v‡D–C¢7G&–ær†f–v‡Båö–B’À¢&V6öã¢6&Bfö–FVC¢G¶VçG&–W7ÒöbG·&WV—&VGÒVçG&–W2æVVFVBæÀ¢Ò“°¢f–v‡Bçfö–FVDBÒæWrFFR‚“°¢f–v‡Bçfö–E&V6öâÒöæÇ’G¶VçG&–W7ÒöbG·&WV—&VGÒ&WV—&VBVçG&–W2BÆö6²æ°¢v—Bf–v‡Bç6fR‚“°¢6ÆV%V&Æ–5&W7öç6T66†R‚“°¢7VÖÖ'’çfö–FVB³Ò°¢7VÖÖ'’ç&VgVæFVB³Ò&VgVæBç&VgVæFVD6÷VçBÇÂ° ¢6öç7BÇFW&æF—fW2Òv—Bf–æDÇFW&æF—fTf–v‡G2†f–v‡Båö–B“°¢6öç7BV÷ÆRÒv—BVçG&çG4öb†f–v‡Båö–B“°¢v—B&öÖ—6RæÆÅ6WGFÆVB‡V÷ÆRæÖ‚‡W'6öâ’Óâ6VæDÖöæW”æ÷F–6R‡°¢Fó¢W'6öâæVÖ–ÂÀ¢7V&¦V7C¢G¶Æ&VÇÒv2fö–FVB(	B–÷W"VçG'’†2&VVâ&VgVæFVFÀ¢†VF–æs¢t4$Bdô”DTBÂÔôäU’$4²rÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâF–Bæ÷BvWBF†RVçG&–W2—BæVVFVBÂ6ò—Bv2fö–FVB&Vf÷&R—B7F'FVBæÀ¢u–÷W"VçG'’fVR—2&6²–â–÷W"vÆÆWB–âgVÆÂâæ÷F†–ærv266÷&VBæBæ÷F†–ærv26†&vVBârÀ¢ÇFW&æF—fW4‡FÖÂ†ÇFW&æF—fW2’À¢ÒÀ¢fö÷FW#¢u–÷RvW&RFöÆB&Vf÷&RF†Rf–v‡BÂæ÷BGW&–ær—B(	BF†B—2F†Rö–çBöbF†RÆö6²6†V6²ârÀ¢Ò’’“° ¢6öç7B&öÖ÷FW"Òf–v‡Bæff–Æ–FT–Bòv—Bff–Æ–FRæf–æD'”–B†f–v‡Bæff–Æ–FT–B’ç6VÆV7B‚vVÖ–Âr’æÆVâ‚’¢çVÆÃ°¢–b‡&öÖ÷FW#òæVÖ–Â’°¢v—B6VæDÖöæW”æ÷F–6R‡°¢Fó¢&öÖ÷FW"æVÖ–ÂÀ¢7V&¦V7C¢G¶Æ&VÇÒfö–FVB(	BG¶VçG&–W7ÒöbG·&WV—&VGÒVçG&–W6À¢†VF–æs¢u”õU"4$BD”BäõBd”ÄÂrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâ6Æ÷6VBöâG¶VçG&–W7ÒVçG&–W2v–ç7BF†RG·&WV—&VGÒ—BæVVFVBÂ6ò—Bfö–FVBæBWfW'–öæRv2&VgVæFVBæÀ¢u–÷RvW&Ræ÷B6†&vVBç—F†–ærâæW‡BF–ÖS¢6ÖÆÆW"÷BÂ÷"†–v†W"'W’Ö–âÂf–ÆÇ2f7FW"ârÀ¢ÒÀ¢Ò“°¢Ð¢6öçF–çVS°¢Ð ¢òòÒÒÒÒBÓƒ¢v&âF†RV÷ÆRv†òÇ&VG’–BÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢–b†×5FôÆö6²ÃÒÄ”U%õt$åôÕ2bbf–v‡Bç6†÷'FfÆÅÆ–W'5v&æVDB’°¢6öç7BÇFW&æF—fW2Òv—Bf–æDÇFW&æF—fTf–v‡G2†f–v‡Båö–B“°¢6öç7BV÷ÆRÒv—BVçG&çG4öb†f–v‡Båö–B“°¢v—B&öÖ—6RæÆÅ6WGFÆVB‡V÷ÆRæÖ‚‡W'6öâ’Óâ6VæDÖöæW”æ÷F–6R‡°¢Fó¢W'6öâæVÖ–ÂÀ¢7V&¦V7C¢G¶Æ&VÇÒ—26†÷'B(	B—BÖ’fö–Bv—F†–âF†R†÷W&À¢†VF–æs¢uD„•24$BÔ’äõB%TârÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâ—2G·6†÷'GÒG·6†÷'BÓÓÒòvVçG'’r¢vVçG&–W2wÒ6†÷'Bv—F‚VæFW"â†÷W"&Vf÷&R&VF–7F–öç2Æö6²æÀ¢t–b—BFöW2æ÷Bf–ÆÂÂF†R6&Bfö–G2æB–÷W"VçG'’—2&VgVæFVB–âgVÆÂæBWFöÖF–6ÆÇ’(	B–÷RFòæ÷BæVVBFòFòç—F†–ærârÀ¢uFVÆÆ–ær–÷Ræ÷r6ò–÷R&Ræ÷B6—GF–ærF÷vâFòvF6‚f–v‡B–÷RæòÆöævW"†fR7F–öâöâârÀ¢ÇFW&æF—fW4‡FÖÂ†ÇFW&æF—fW2’À¢ÒÀ¢Ò’’“°¢f–v‡Bç6†÷'FfÆÅÆ–W'5v&æVDBÒæWrFFR‚“°¢v—Bf–v‡Bç6fR‚“°¢7VÖÖ'’çÆ–W'5v&æVB³Ò°¢6öçF–çVS°¢Ð ¢òòÒÒÒÒBÓfƒ¢v&âF†R&öÖ÷FW"v†–ÆRF†W’6â7F–ÆÂf—‚—BÒÒÒÒÒÒÒÒÒÒÒÒÐ¢–b†×5FôÆö6²ÃÒ$ôÔõDU%õt$åôÕ2bbf–v‡Bç6†÷'FfÆÅ&öÖ÷FW%v&æVDB’°¢6öç7B&öÖ÷FW"Òf–v‡Bæff–Æ–FT–Bòv—Bff–Æ–FRæf–æD'”–B†f–v‡Bæff–Æ–FT–B’ç6VÆV7B‚vVÖ–Âr’æÆVâ‚’¢çVÆÃ°¢6öç7BFòÒ&öÖ÷FW#òæVÖ–ÂÇÂdÔÕôÔ”Åôe$ôÓ°¢6öç7B†÷W'2ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB†×5FôÆö6²ò3c’“°¢v—B6VæDÖöæW”æ÷F–6R‡°¢FòÀ¢7V&¦V7C¢G¶Æ&VÇÒæVVG2G·6†÷'GÒÖ÷&RG·6†÷'BÓÓÒòvVçG'’r¢vVçG&–W2wÖÀ¢†VF–æs¢u”õU"4$B•24„õ%BrÀ¢Æ–æW3¢°¢Ç7G&öæsâG¶Æ&VÇÓÂ÷7G&öæsâ†2G¶VçG&–W7ÒöbF†RG·&WV—&VGÒVçG&–W2—BæVVG2ÂæB&VF–7F–öç2Æö6²–â&÷WBG¶†÷W'7ÒG¶†÷W'2ÓÓÒòv†÷W"r¢v†÷W'2wÒæÀ¢G·6†÷'GÒÖ÷&RæB—B'Vç2â÷7B—BFò–÷W"ÆVwVRæ÷r(	BF†B—2W7VÆÇ’ÆÂ—BF¶W2æÀ¢Æ‡&VcÒ"G´ôõ$”t”çÒôff–Æ–FTF6†&ö&B"7G–ÆSÒ&6öÆ÷#¢6c&#SCC²#ä÷Vâ–÷W"&öÖ÷F–öâFW6³ÂöæÀ¢t–b—BFöW2æ÷Bf–ÆÂ—Bfö–G2BÆö6²æBWfW'’VçG'’—2&VgVæFVBâ–÷R&Ræ÷B6†&vVBf÷"6&BF†BFöW2æ÷B'VâârÀ¢ÒÀ¢Ò“°¢f–v‡Bç6†÷'FfÆÅ&öÖ÷FW%v&æVDBÒæWrFFR‚“°¢v—Bf–v‡Bç6fR‚“°¢7VÖÖ'’ç&öÖ÷FW%v&æVB³Ò°¢Ð¢Ð ¢&WGW&â7VÖÖ'“°§Ð ¢òò66†VGVÆVBVçG'’ö–çBâfW&6VÂ7&öâ†—G2F†—3²F†R6†&VB6V7&WB¶VW2—Bg&öÐ¢òò&V–ærV&Æ–2'&VgVæBWfW'—F†–ær"'WGFöâà¦6öç7B'Vå6†÷'FfÆÅ7vVWÒ7–æ2‡&WÂ&W2’Óâ°¢6öç7B6V7&WBÒ7G&–ær‡&ö6W72æVçbä5$ôåõ4T5$UBÇÂrr“°¢6öç7B&÷f–FVBÒ7G&–ær‡&Wæ†VFW'5²w‚Ö7&öâ×6V7&WBuÒÇÂ&WçVW'’ç6V7&WBÇÂrr“°¢6öç7B—4FÖ–âÒ&ööÆVâ‡&WæFÖ–â“°¢–b‡6V7&WBbb&÷f–FVBÓÒ6V7&WBbb—4FÖ–â’°¢&WGW&â&W2ç7FGW2ƒC2’æ§6öâ‡²ÖW76vS¢tæ÷BWF†÷&—6VBârÂ6öFS¢t$Eô5$ôåõ4T5$UBrÒ“°¢Ð¢G'’°¢6öç7B7VÖÖ'’Òv—B7vVW6†÷'Df–v‡G2‚“°¢&WGW&â&W2æ§6öâ‡²ö³¢G'VRÂââç7VÖÖ'’Ò“°¢Ò6F6‚†W'&÷"’°¢6öç6öÆRæW'&÷"‚u6†÷'FfÆÂ7vVWf–ÆVC¢rÂW'&÷"“°¢&WGW&â&W2ç7FGW2ƒS’æ§6öâ‡²ÖW76vS¢u7vVWf–ÆVBârÂFWF–Ã¢W'&÷"æÖW76vRÒ“°¢Ð§Ó°¦ævWB‚rö’ö7&öâ÷7vVW×6†÷'BÖf–v‡G2rÂ'Vå6†÷'FfÆÅ7vVW“°¦ç÷7B‚rö’ö7&öâ÷7vVW×6†÷'BÖf–v‡G2rÂ'Vå6†÷'FfÆÅ7vVW“° ¢òòæò66†VGVÆW"'’FW6–vââF†R7vVW&–FW2÷&F–æ'’G&ff–2–ç7FVC¢WfW'¢òò&WVW7B6†V6·2F†R6Æö6²ÂæBBÖ÷7BöæR7vVW'Vç2WfW'’f—fRÖ–çWFW26ò—@¢òò6âæWfW"–ÆRW÷"6Æ÷r&W7öç6R†—B—2f—&VBeDU"æW‡B‚’Â6òæ÷F†–æp¢òòv—G2öâ—B’âf—fRÖ–çWFW2—2F–v‡BVæ÷Vv‚F†BÆö6²×F–ÖRfö–B†Vç0¢òòv†–ÆRF†R6&B—27F–ÆÂg&W6‚ÂæBF†R6—FRÇv—2†2G&ff–2&÷VæB6&@¢òò6Æ÷6–ær(	BF†B—2W†7FÇ’v†VâVçG&–W2&R6öÖ–ær–âà¦ÆWBÆ7D÷÷'GVæ—7F–57vVWÒ°¦6öç7Bõõ%ETä•5D”5õ5tTUôÕ2ÒR¢c¢°¦çW6R‚‡&WÂ÷&W2ÂæW‡B’Óâ°¢æW‡B‚“°¢–b„FFRææ÷r‚’ÒÆ7D÷÷'GVæ—7F–57vVWÂõõ%ETä•5D”5õ5tTUôÕ2’&WGW&ã°¢Æ7D÷÷'GVæ—7F–57vVWÒFFRææ÷r‚“°¢7vVW6†÷'Df–v‡G2‚’æ6F6‚‚†W'&÷"’Óâ6öç6öÆRçv&â‚t÷÷'GVæ—7F–27vVWf–ÆVC¢rÂW'&÷"æÖW76vR’“°§Ò“°  ¢òò7F'B6W'fW ¦6öç7B6W'fW"ÒæÆ—7FVâ…õ%BÂ‚’Óâ°¢6öç6öÆRæÆör†6W'fW"7F'FVBöâ÷'BGµõ%GÖ“°§Ò“°