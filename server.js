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
  'https://fantasymmadness-version2.vercel.app', // Production
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

app.use(cors({
  origin: function (origin, callback) {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // Allow credentials (cookies, headers, etc.)
}));

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
const PORT = process.env.PORT || 3000;

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Middleware
app.use(bodyParser.urlencoded({ extended: false, limit: URLENCODED_BODY_LIMIT }));
app.use(bodyParser.json({ limit: JSON_BODY_LIMIT }));




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
  return String(category || '').trim().toLowerCase();
}

async function resolveCombatFighterSelectionForMatchInput({ fighterAId, fighterBId }) {
  const CombatFighter = mongoose.models.CombatFighter;
  const result = { fighterA: null, fighterB: null };
  const ids = [fighterAId, fighterBId].map((value) => String(value || '').trim()).filter(Boolean);
  const uniqueIds = [...new Set(ids)].filter((id) => mongoose.isValidObjectId(id));

  if (!CombatFighter || uniqueIds.length === 0) return result;

  const fighters = await CombatFighter.find({ _id: { $in: uniqueIds }, status: { $ne: 'inactive' } }).lean();
  const byId = new Map(fighters.map((fighter) => [String(fighter._id), fighter]));
  const fighterAKey = String(fighterAId || '').trim();
  const fighterBKey = String(fighterBId || '').trim();

  result.fighterA = byId.get(fighterAKey) || null;
  result.fighterB = byId.get(fighterBKey) || null;
  return result;
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
  output.KN = pickExplicitNumericField(input, ['KN', 'kn', 'knockdowns'], output.KN);
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

function getFightStatusBucket(match = {}) {
  const normalize = (value) => String(value || '').trim().toLowerCase();
  const status = normalize(match.matchStatus || match.status);
  const openStatus = normalize(match.matchShadowOpenStatus);
  if (['finished', 'closed', 'completed', 'complete', 'cancelled', 'canceled'].includes(status) || openStatus === 'closed') return 'completed';
  if (['scheduled', 'open', 'live', 'ongoing', 'active'].includes(status) || openStatus === 'open') return 'playable';
  return 'playable';
}

async function attachPlayerPredictionStateToFightItems(items = [], query = {}) {
  const playerId = getRequestedClassicPlayerId(query);
  const baseItems = Array.isArray(items) ? items : [];
  if (!baseItems.length) return [];

  let submittedMatchIds = new Set();
  if (playerId) {
    const matchIds = [...new Set(baseItems.map((item) => String(item && item._id || '').trim()).filter(Boolean))];
    if (matchIds.length) {
      const scores = await Score.find({ playerId, matchId: { $in: matchIds } }).select('matchId').lean();
      submittedMatchIds = new Set(scores.map((score) => String(score.matchId)));
    }
  }

  return baseItems.map((item) => {
    const plain = toPlainObject(item) || {};
    const predictionSubmitted = submittedMatchIds.has(String(plain._id));
    return {
      ...plain,
      predictionSubmitted,
      userPredictionSubmitted: predictionSubmitted,
      userPredictionStatus: predictionSubmitted ? 'submitted' : 'not_submitted',
      userFightBucket: predictionSubmitted ? 'completed' : 'playable',
      fightStatusBucket: getFightStatusBucket(plain),
      canSubmitPrediction: !predictionSubmitted && !isDraftFightRecord(plain),
    };
  });
}

function applyPublicFightStatusIntent(items = [], query = {}) {
  const statusValue = String(query.status || query.bucket || query.view || '').trim().toLowerCase();
  if (!statusValue || ['all', 'any'].includes(statusValue)) return items;
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

function sanitizeAccountObject(value) {
  const account = toPlainObject(value);
  if (!account || typeof account !== 'object' || Array.isArray(account)) return account;

  SENSITIVE_ACCOUNT_FIELDS.forEach((field) => {
    delete account[field];
  });

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
  res.setHeader('Cache-Control', `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`);
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
    matchName: item.matchName,
    matchFighterA: item.matchFighterA,
    matchFighterB: item.matchFighterB,
    fighterAId: item.fighterAId,
    fighterBId: item.fighterBId,
    fighterA: item.fighterA,
    fighterB: item.fighterB,
    fighterAImage: item.fighterAImage,
    fighterBImage: item.fighterBImage,
    promotionBackground: item.promotionBackground,
    matchDescription: item.matchDescription,
    matchType: item.matchType,
    matchTokens: item.matchTokens,
    matchDate: item.matchDate,
    matchTime: item.matchTime,
    venue: item.venue,
    homepagePromoted: Boolean(item.homepagePromoted),
    homepagePromotionRank: Number(item.homepagePromotionRank || 0),
    homepagePromotion: {
      isPromoted: Boolean(item.homepagePromoted),
      rank: Number(item.homepagePromotionRank || 0),
      title: item.homepagePromotionTitle || '',
      subtitle: item.homepagePromotionSubtitle || '',
      ctaLabel: item.homepagePromotionCtaLabel || '',
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
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function calculateClassicPredictionPoints(userPrediction = [], fighterOneStats = [], fighterTwoStats = [], matchCategory = '') {
  if (!Array.isArray(userPrediction) || !Array.isArray(fighterOneStats) || !Array.isArray(fighterTwoStats)) return 0;

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

    if (String(matchCategory).toLowerCase() === 'boxing') {
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
    } else if (String(matchCategory).toLowerCase() === 'mma') {
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
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_BYTES,
    files: MAX_UPLOAD_FILES_PER_REQUEST,
  },
  fileFilter: (req, file, callback) => {
    const mimeType = String(file.mimetype || '').toLowerCase();

    // Existing uploads are image-focused. Keep application/octet-stream as a
    // compatibility escape hatch for browsers/devices that omit a precise type.
    if (!mimeType || mimeType.startsWith('image/') || mimeType === 'application/octet-stream') {
      return callback(null, true);
    }

    const error = new Error(`Unsupported upload type: ${mimeType}`);
    error.statusCode = 415;
    error.code = 'UNSUPPORTED_UPLOAD_TYPE';
    return callback(error);
  },
});
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
  matchDescription: String,
  matchVideoUrl: String,
  matchDate: Date,
  matchTime: String,
  venue: String,
  homepagePromoted: { type: Boolean, default: false, index: true },
  homepagePromotionRank: { type: Number, default: 0 },
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
  maxRounds: Number,
  fighterAImageDeleteUrl: String, // ImgBB delete URL for Fighter A's image
  fighterBImageDeleteUrl: String, 
  promotionBackgroundDeleteUrl: String, 
  matchStatus: { type: String, enum: ['Finished', 'Ongoing', 'Draft', 'Scheduled', 'Live', 'Open', 'Closed'], default: 'Ongoing' },
  
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
shadowSchema.index({ fighterAId: 1, fighterBId: 1 });


const Shadow = mongoose.model('Shadow', shadowSchema);
app.post('/compare-matches', async (req, res) => {
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
      res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

app.post(
  '/editShadow',
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


app.post('/finishShadow/:matchId', async (req, res) => {
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


app.post('/shadow/addShadowRoundResults/:id', async (req, res) => {
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





app.post('/updateShadowVideo', async (req, res) => {
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

app.delete('/shadowfighttodelete/:id', async (req, res) => {
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
    const matches = await Shadow.find().populate('fighterAId fighterBId').sort({ _id: -1 }).lean(); // Sort by _id in descending order
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
matchShadowOpenStatus: { type: String, enum: ['open', 'closed'], default: 'open' },
matchReward: { type: String, enum: ['Rewarded', 'NotRewarded'], default: 'NotRewarded' },
  matchVideoUrl: String,
  matchPromotionalVideoUrl: String,
  matchDate: Date,
  matchTime: String,  // Store the match time as a string in 'HH:MM' format
  venue: String,
  homepagePromoted: { type: Boolean, default: false, index: true },
  homepagePromotionRank: { type: Number, default: 0 },
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
  profit: Number,
  amountOverPotBudget: Number,
  fighterAImage: String,  // URL of Fighter A's image
  fighterBImage: String,  // URL of Fighter B's image
  matchType: String,      // LIVE or SHADOW
  maxRounds: Number,
  fighterAImageDeleteUrl: String,
  fighterBImageDeleteUrl: String,

  promotionBackgroundDeleteUrl:String,
  promotionBackground:String,

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

  userPredictions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Reference to the user
    predictionStatus: { type: String, enum: ['submitted', 'notSubmitted'], default: 'notSubmitted' }
  }],
  
  __v: Number
} , { timestamps: true });
matchSchema.index({ matchStatus: 1, matchShadowOpenStatus: 1, updatedAt: -1 });
matchSchema.index({ matchDate: -1, updatedAt: -1 });
matchSchema.index({ homepagePromoted: 1, homepagePromotionRank: -1, matchDate: 1, updatedAt: -1 });
matchSchema.index({ affiliateId: 1, updatedAt: -1 });


const Match = mongoose.model('Match', matchSchema);

app.get('/api/update-shadow-open-status', async (req, res) => {
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

app.post("/update-match-shadow-open-status/:matchId", async (req, res) => {
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



app.post("/update-match-status-shadow/:matchId", async (req, res) => {
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



app.post("/activate-match/:matchId", async (req, res) => {
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

    // Fetch users
    const users = await User.find();
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
        from: "Fantasymmadness2@gmail.com",
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
                  ${isRegistered ? "A new fight has been added!" : "We noticed you haven’t registered yet. Join now and don’t miss out!"}
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


app.post('/api/matches/:matchId/promotional-video', async (req, res) => {
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
app.post('/api/update-match-reward', async (req, res) => {
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
    res.status(500).json({ success: false, message: 'Server error', error });
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
app.post('/updateMatchVideo', async (req, res) => {
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



app.post('/finishMatch/:matchId', async (req, res) => {
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
    res.status(500).json({ message: 'Server error', error });
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
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/admin/matches/:id/video', async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight video' });
  }
});

app.post('/api/admin/matches/:id/video', async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight video' });
  }
});

app.put('/api/admin/shadow/:id/video', async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight video' });
  }
});

app.post('/api/admin/shadow/:id/video', async (req, res) => {
  try {
    const updatedMatch = await updateFightVideoFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight video updated successfully', match: updatedMatch });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight video' });
  }
});

app.put('/api/admin/matches/:id/scoring', async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight scoring' });
  }
});

app.post('/api/admin/matches/:id/scoring', async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Match, req.params.id, req.body);
    res.status(200).json({ message: 'Fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update fight scoring' });
  }
});

app.put('/api/admin/shadow/:id/scoring', async (req, res) => {
  try {
    const updatedMatch = await updateFightScoringFields(Shadow, req.params.id, req.body);
    res.status(200).json({ message: 'Shadow fight scoring updated successfully', match: updatedMatch, manualTotalPunches: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message || 'Failed to update shadow fight scoring' });
  }
});

app.post('/api/admin/shadow/:id/scoring', async (req, res) => {
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
      user.tokens = String((parseInt(user.tokens) || 0) + matchTokens);
      await user.save();
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

  return {
    ok: true,
    id,
    sourceType: resolvedSourceType,
    title: fight.matchName,
    deletedScores: scoreDeleteResult?.deletedCount || 0,
    refundedUsers: refundResult.refundedUsers || 0,
  };
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
    return res.status(500).json({ ok: false, message: 'Server error', error: error.message });
  }
}

app.post('/api/admin/fights/bulk-delete', handleBulkFightDelete);
app.delete('/api/admin/fights/bulk-delete', handleBulkFightDelete);
app.post('/api/matches/bulk-delete', handleBulkFightDelete);
app.delete('/api/matches/bulk-delete', handleBulkFightDelete);

app.delete('/api/matches/:id', async (req, res) => {
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
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});


app.post(
  '/addMatch',
  upload.fields([
    { name: 'fighterAImage' },
    { name: 'fighterBImage' },
    { name: 'promotionBackground' }
  ]),
  async (req, res) => {
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

      if (req.files.fighterAImage) {
        const resultA = await uploadToCloudinary(req.files.fighterAImage[0].buffer, 'fighter_images');
        fighterAImage = resultA.secure_url;
        fighterAImageDeleteUrl = resultA.public_id;
      }

      if (req.files.fighterBImage) {
        const resultB = await uploadToCloudinary(req.files.fighterBImage[0].buffer, 'fighter_images');
        fighterBImage = resultB.secure_url;
        fighterBImageDeleteUrl = resultB.public_id;
      }

      if (req.files.promotionBackground) {
        const resultBackground = await uploadToCloudinary(req.files.promotionBackground[0].buffer, 'promotion_backgrounds');
        promotionBackground = resultBackground.secure_url;
        promotionBackgroundDeleteUrl = resultBackground.public_id;
      }

      const fighterSelection = await resolveCombatFighterSelectionForMatchInput({ fighterAId, fighterBId });

      // Create match data object
      const matchData = applyCombatFighterSelectionToMatchPayload({
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
        affiliateId,
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

      clearLegacyFighterFieldsForLibraryRefs(matchData);
      Object.assign(matchData, buildAutoHomepagePromotionFields({
        body: req.body,
        admin: req.admin,
        actor: matchBy || affiliateId || 'addMatch',
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

  const notification = new Notification({
      title: `New Fight Added: ${savedMatch.matchName}`,
    });
    await notification.save();
 

  // Now that match is saved, store affiliateId and matchId in the Shadow schema
  const shadowFight = await Shadow.findById(shadowFightId);
  if (shadowFight) {
    const affiliateExists = shadowFight.AffiliateIds.some(item => item.AffiliateId.toString() === affiliateId && item.matchId.toString() === savedMatch._id.toString());

    if (!affiliateExists) {
      shadowFight.AffiliateIds.push({
        AffiliateId: affiliateId,
        matchId: savedMatch._id,
      });
      await shadowFight.save();
    }
  }
  

  if (req.body.notify === 'true' || req.body.notify === true) {

  const users = await User.find();
  
  
  const registeredUserMailPromises = users.map(user => {
    const mailOptions = {
      from: 'Fantasymmadness2@gmail.com',
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
    from: 'Fantasymmadness2@gmail.com',
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

  const swarmAutomation = await app.locals.swarmPhase2?.triggerAutomationEvent?.({
    trigger: 'upcoming_event',
    vertical: 'combat',
    sourceEntity: {
      type: 'combat_match',
      id: String(savedMatch._id),
      label: savedMatch.matchName || `${savedMatch.matchFighterA || ''} vs ${savedMatch.matchFighterB || ''}`.trim(),
    },
    input: {
      matchId: String(savedMatch._id),
      matchName: savedMatch.matchName,
      title: savedMatch.matchName,
      fighterA: savedMatch.matchFighterA,
      fighterB: savedMatch.matchFighterB,
      matchDate: savedMatch.matchDate,
      matchTime: savedMatch.matchTime,
      matchType: savedMatch.matchType,
      maxRounds: savedMatch.maxRounds,
      description: savedMatch.matchDescription,
    },
    metadata: { route: '/addMatch', action: 'legacy-upcoming-event-created' },
    reason: 'combat-match-added-in-backend',
  }).catch((error) => ({ ok: false, warning: 'Fight was added but upcoming-event automation failed.', error: error.message }));

  // Respond with success and the saved match ID
  res.status(200).json({ message: 'Match Added Successfully and Notifications Sent', matchId: savedMatch._id, automation: swarmAutomation || null });
} catch (error) {
  console.error('Error adding match:', error);
  res.status(500).json({ message: 'Server error', error: error.message });
}
}
);
app.post(
  '/editMatch',
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

      const fighterSelection = await resolveCombatFighterSelectionForMatchInput({ fighterAId, fighterBId });
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
      assignIfProvided(existingMatch, 'matchDate', matchDate);
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

      clearLegacyFighterFieldsForLibraryRefs(existingMatch);

      // Save the updated match to the database
      const updatedMatch = await existingMatch.save();

  const notification = new Notification({
      title: `Fight Updated: ${updatedMatch.matchName}`,
    });
    await notification.save();
 
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
    let match = await applyFightFreshSortLean(Match.find(visibleQuery).populate('fighterAId fighterBId'));

    // Safety fallback for legacy records: if the stricter public query produces no
    // results, keep the same base filters and remove only explicit Draft fights in
    // memory. This prevents public fight pages from going blank while still hiding drafts.
    if (!match.length && !shouldIncludeDraftFights(req.query)) {
      const fallback = await applyFightFreshSortLean(Match.find(query).populate('fighterAId fighterBId'));
      match = fallback.filter((item) => !isDraftFightRecord(item));
    }

    // Legacy fallback: many admin/public fight cards are stored as Shadow
    // fights before being promoted. Keep /match backward compatible by falling
    // back to Shadow records when Match returns empty. Public requests still hide
    // explicit drafts, while admin/includeDrafts requests can see draft shadows.
    if (!match.length) {
      try {
        const shadowFallback = await applyFightFreshSortLean(Shadow.find(query).populate('fighterAId fighterBId'));
        const visibleShadowFallback = shouldIncludeDraftFights(req.query)
          ? shadowFallback
          : shadowFallback.filter((item) => !isDraftFightRecord(item));
        match = visibleShadowFallback.map((item) => ({ ...item, sourceType: 'shadow' }));
      } catch (fallbackError) {
        console.warn('Legacy /match shadow fallback failed:', fallbackError.message);
      }
    }

    if (shouldUseStrictPlayableFightFilter(req.query) && shouldRequestPredictionEligibleFights(req.query)) {
      match = match.filter((item) => isPredictionEligibleFightRecord(item));
    }

    if (!isAllFilterValue(req.query.category)) {
      match = match.filter((item) => isFightRecordInEffectiveCategory(item, req.query.category));
    }

    let responseItems = match.map((item) => attachCombatFighterReadFallbacks(item, item.sourceType || 'match'));
    responseItems = await attachPlayerPredictionStateToFightItems(responseItems, req.query);
    responseItems = applyPublicFightStatusIntent(responseItems, req.query);

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
    const { payload, cacheState } = await readThroughPublicCache(
      getPublicCacheKey(req, 'public-prediction-fights'),
      async () => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const queryLimit = Math.min(Math.max(limit * 6, 200), 500);
        let baseFilter = {};
        baseFilter = appendAndFilter(baseFilter, buildEffectiveFightCategoryFilter(req.query.category));
        if (shouldUseStrictPlayableFightFilter(req.query)) {
          baseFilter = appendAndFilter(baseFilter, buildPredictionEligibleFightFilter());
        }
        const visibleFilter = applyFightPublicVisibilityFilter(baseFilter, req.query);
        const [matches, shadows] = await Promise.all([
          applyFightFreshSortLean(Match.find(visibleFilter).populate('fighterAId fighterBId')).limit(queryLimit),
          applyFightFreshSortLean(Shadow.find(visibleFilter).populate('fighterAId fighterBId')).limit(queryLimit).catch(() => []),
        ]);
        let items = [
          ...matches.map((item) => ({ ...item, sourceType: 'match' })),
          ...shadows.map((item) => ({ ...item, sourceType: 'shadow' })),
        ].filter((item) => !isDraftFightRecord(item));

        if (shouldUseStrictPlayableFightFilter(req.query)) {
          items = items.filter((item) => isPredictionEligibleFightRecord(item));
        }

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
        items = applyPublicFightStatusIntent(items, req.query).slice(0, limit);

        return {
          ok: true,
          items,
          count: items.length,
          categoryMode: 'matchCategoryTwo-preferred',
          generatedAt: new Date().toISOString(),
        };
      }
    );

    setPublicCacheHeaders(res, PUBLIC_CACHE_TTL_SECONDS, cacheState);
    res.json(payload);
  } catch (error) {
    console.error('Error loading prediction-ready fights:', error);
    res.status(500).json({ ok: false, message: 'Failed to load prediction-ready fights.' });
  }
});

// Update user prediction status
app.post('/api/matches/:matchId/updatePredictionStatus', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { userId, predictionStatus } = req.body;

    const match = await Match.findById(matchId);

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const userPrediction = match.userPredictions.find(pred => pred.userId.toString() === userId);

    if (userPrediction) {
      userPrediction.predictionStatus = predictionStatus;
    } else {
      match.userPredictions.push({ userId, predictionStatus });
    }

    await match.save();
    res.status(200).json({ message: 'Prediction status updated successfully' });
  } catch (error) {
    console.error('Error updating prediction status:', error);
    res.status(500).json({ message: 'Failed to update prediction status' });
  }
});


app.post('/match/addRoundResults/:id', async (req, res) => {
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

const DeviceInfo = mongoose.model('DeviceInfo', DeviceInfoSchema);
app.post('/admin/add-device', async (req, res) => {
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
app.get('/admin/device-info', async (req, res) => {
  try {
    const devices = await DeviceInfo.find().lean();
    res.status(200).json(devices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to fetch device info.' });
  }
});
app.delete('/admin/device-info', async (req, res) => {
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

const DeviceInfoSpinWheel = mongoose.model('DeviceInfoSpinWheel', DeviceInfoSchemaForSpinWheel);
app.post('/admin/add-device-spin-wheel', async (req, res) => {
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
app.get('/admin/device-info-spin-wheel', async (req, res) => {
  try {
    const devices = await DeviceInfoSpinWheel.find().lean();
    res.status(200).json(devices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to fetch device info.' });
  }
});
app.delete('/admin/device-info-spin-wheel', async (req, res) => {
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
  verificationToken: { type: String, select: false },
  verified: { type: Boolean, default: false },
  profileUrl: String,
  profileDeleteUrl: { type: String, select: false },
  currentPlan: { type: String, default: 'None' }, // Current subscription plan
  freePlanExpiryDate: Date, // Date when the free plan expires
  hasAvailedFreePlan: { type: Boolean, default: false }, // Indicates if the user has availed the free plan
  preferredPaymentMethod: String,
  preferredPaymentMethodValue: { type: String, select: false },
  resetPasswordToken: { type: String, select: false },
  resetPasswordExpires: { type: Date, select: false },
  hasSubmittedTestimonial: { type: Boolean, default: false },
  billing: {
    cardNumber: { type: String, select: false },  // Encrypted
    expirationDate: { type: String, select: false },  // Encrypted
    cardCode: { type: String, select: false },  // Encrypted
    address: String,
    city: String,
    state: String,
    zip: String,
    country: String
  },
}, { timestamps: true });
userSchema.index({ playerName: 1 });
userSchema.index({ createdAt: -1 });
attachSafeAccountJsonTransform(userSchema);

const User = mongoose.model('User', userSchema);
app.put('/update-profile-url', async (req, res) => {
  try {
      const { profileUrl } = req.body;
      if (!profileUrl) {
          return res.status(400).json({ message: 'profileUrl is required' });
      }

      // Update all users' profileUrl
      const result = await User.updateMany({}, { $set: { profileUrl } });
      const result2 = await Affiliate.updateMany({}, { $set: { profileUrl } });

      res.json({ message: 'Profile URLs updated successfully', modifiedCount: result.modifiedCount ,  modifiedCount2: result2.modifiedCount });
  } catch (error) {
      res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});
app.post('/admin/add-tokens-won', async (req, res) => {
  const { email, deviceId } = req.body;

  if (!email || !deviceId) {
    return res.status(400).json({ message: 'Email and deviceId are required.' });
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
      existingUser.tokens = (parseInt(existingUser.tokens) + 200).toString();
      await existingUser.save();

      // Notify User and Admin
      const emailPromises = [
        transporter.sendMail({
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
          to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
          to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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


app.post('/admin/add-tokens-won-spin-wheel', async (req, res) => {
  const { email, deviceId, results } = req.body;

  if (!email || !deviceId) {
    return res.status(400).json({ message: 'Email and deviceId are required.' });
  }

  try {
    const existingDevice = await DeviceInfoSpinWheel.findOne({ deviceId });

    if (existingDevice) {
      return res.status(400).json({ message: 'Device ID already registered.' });
    }
    
    await new DeviceInfoSpinWheel({ email, deviceId }).save();
    
    // Check if User already exists
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // User found, add 200 tokens
      existingUser.tokens = (parseInt(existingUser.tokens) + results).toString();
      await existingUser.save();

      // Notify User and Admin
      const emailPromises = [
        transporter.sendMail({
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
          to: email,
          subject: `${results} Tokens Added!`,
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
                    You have received ${results} tokens added to your account! Your new token balance is ${existingUser.tokens}.
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
          to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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
                    ${results} tokens have been successfully added to the user with the email: ${email}.
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
        tokens: String(results),
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
          from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
          to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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


app.post('/admin/add-user', async (req, res) => {
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
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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



app.post('/forgotPassword-user', async (req, res) => {
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
      from: 'wajih786hassan@gmail.com',
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


app.post('/resetPassword-user/:token', async (req, res) => {
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


app.post('/api/authorize-net/first-payment', async (req, res) => {
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
          user.tokens = (parseInt(user.tokens, 10) + parseInt(amount, 10)).toString();
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
    return res.status(500).json({ message: 'Error processing payment', error: error.message });
  }
});
app.post('/api/authorize-net/transaction', async (req, res) => {
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
        user.tokens = (parseInt(user.tokens, 10) + parseInt(amount, 10)).toString();
        await user.save();

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
    return res.status(500).json({ message: 'Error processing transaction', error: error.message });
  }
});

// Google Login API
app.post('/google-login', async (req, res) => {
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
        from: 'Fantasymmadness2@gmail.com',
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

      const currentTokens = parseInt(referrer.tokens ?? "0", 10);
      referrer.tokens = (currentTokens + 3).toString();
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
        from: 'Fantasymmadness2@gmail.com',
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
        from: 'Fantasymmadness2@gmail.com',
        to: ['wajih786hassan@gmail.com', 'Fantasymmadness2@gmail.com'], // Replace with actual admin emails
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
    const jwtToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

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
      from: 'Fantasymmadness2@gmail.com',
      to: ['wajih786hassan@gmail.com', 'Fantasymmadness2@gmail.com'], // Replace with actual admin emails
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




app.post('/user/updatePayment/:id', async (req, res) => {
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
    res.status(500).json({ message: 'Server error', error });
  }
});

// Update Profile API
app.put('/update-profile/:userId', upload.single('image'), async (req, res) => {
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
app.post('/api/reward-tokens/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens, matchId } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

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
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});

// POST API to reward tokens to the user and update matchReward status
app.post('/api/reward-tokens-only-forcibly/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { tokens } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

    // Save the updated user
    await user.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded successfully', user});
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});


app.post('/api/deduct-tokens', async (req, res) => {
  try {
    const { userId, matchTokens } = req.body;

    // Find the user by ID
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if the user has enough tokens
    if (user.tokens < matchTokens) {
      return res.status(400).json({ message: 'Insufficient tokens' });
    }

    // Deduct the tokens
    user.tokens -= matchTokens;
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
app.get('/users', async (req, res) => {
  try {
    const users = await User.find().select(USER_SAFE_SELECT).lean();
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

app.post('/contact-us-fantasymmadness', (req, res) => {
  const { fullName, email, subject, message } = req.body;

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
    from: email,
    to: 'Fantasymmadness2@gmail.com',
    subject: `Contact Form Submission: ${subject}`,
    html: adminHtml,
  };

  // User email options
  const userMailOptions = {
    from: 'Fantasymmadness2@gmail.com',
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
app.get('/notify', async (req, res) => {
  try {
    // Fetch all matches
    const matches = await Match.find({});
    if (!matches || matches.length === 0) {
      return res.status(404).json({ message: 'No matches found' });
    }

    // Fetch all users
    const users = await User.find({});
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
            (user) => usersJoinedIds.includes(user._id.toString()) && parseInt(user.tokens, 10) >= match.matchTokens
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
                  from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
    res.status(500).json({ message: 'Error processing notifications', error });
  }
});


app.post('/send-emails-to-all-users', async (req, res) => {
  const { emails, subject, message } = req.body;

  if (!emails || emails.length === 0) {
    return res.status(400).json({ error: 'No email addresses provided.' });
  }

  try {
    // Loop through each email and send the message
    for (let email of emails) {
      await transporter.sendMail({
        from: '"Fantasy MMAdness" <Fantasymmadness2@gmail.com>', // sender address
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


app.post('/register', async (req, res) => {
  try {
    console.log("Incoming /register request body:", req.body);

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

    // Basic input validation to prevent malformed requests
    if (!email || !password || !firstName || !lastName) {
      console.warn("Missing required fields:", { email, password, firstName, lastName });
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Check if email exists in Redusers
    const redListedUser = await Redusers.findOne({ email }).lean();
    if (redListedUser) {
      console.log(`Blocked registration for redlisted email: ${email}`);

      const mailOptions = {
        from: 'Fantasymmadness2@gmail.com',
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
    });

    await newUser.save();
    console.log(`✅ User created successfully: ${email}`);

    // Notification
    await new Notification({ title: `New User Signed Up: ${newUser.firstName}` }).save();

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
          const currentTokens = parseInt(referrer.tokens ?? "0", 10);
          referrer.tokens = (currentTokens + 3).toString();
          await referrer.save();
          console.log(`🎁 3 tokens awarded to referrer: ${referrer.email}`);
        }
      } catch (err) {
        console.error('Referral processing error:', err);
      }
    }

    // Schedule verification timeout cleanup
    setTimeout(async () => {
      try {
        const user = await User.findOne({ email });
        if (user && !user.verified) {
          console.log(`Deleting unverified user: ${email}`);
          await transporter.sendMail({
            from: 'Fantasymmadness2@gmail.com',
            to: email,
            subject: 'Verification Failed',
            html: `<p>Dear ${user.firstName}, your registration was removed due to unverified email.</p>`,
          });
          await User.deleteOne({ email });
        }
      } catch (err) {
        console.error('Error during verification timeout cleanup:', err);
      }
    }, 120000);

    // Send verification email
    const verificationLink = `https://fantasymmadness-game-server-three.vercel.app/verify-email?token=${verificationToken}`;
    try {
      await transporter.sendMail({
        from: 'Fantasymmadness2@gmail.com',
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
      return res.status(500).json({ error: 'Error sending verification email' });
    }
  } catch (error) {
    console.error("Unhandled registration error:", error);
    return res.status(500).json({ error: 'Error during registration' });
  }
});

app.get('/verify-email', async (req, res) => {
  const { token } = req.query;

  const user = await User.findOne({ verificationToken: token });

  if (!user) {
    return res.status(400).send('Invalid or expired token');
  }

  user.verified = true;
  user.verificationToken = null; // Clear the token after verification
  await user.save();

  res.status(200).send('Email verified successfully!');
});




// Default route
app.get("/", (req, res) =>{
  res.send("Backend server has started running successfully...");
});

app.delete('/usertodelete/:id', async (req, res) => {
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
app.get('/user/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).send('User not found');
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


app.post('/upload-avatar', upload.single('image'), async (req, res) => {
  try {
    const { email } = req.body;

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




app.post('/user/:email/subscribe', async (req, res) => {
  const { email } = req.params;
  const { plan } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).send('User not found');
    }

    // Check if the user has already availed the free plan
    if (plan === 'Free') {
      if (user.hasAvailedFreePlan) {
        return res.status(400).json({ message: 'User has already availed the free plan' });
      }

      // Set the current plan to "Free", set the expiry date to one month from now, and allot 20 free tokens
      user.currentPlan = 'Free';
      user.freePlanExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 1 month from now
      user.hasAvailedFreePlan = true;
      user.tokens = '20'; // Allot 20 free tokens for the Free plan

    } else if (plan === 'Standard') {
      user.currentPlan = 'Standard';
      user.tokens = '100'; // Allot 100 free tokens for the Standard plan
    }

    await user.save();
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
app.get('/api/cron-job', async (req, res) => {
  console.log('Cron job started.');

  try {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0); // Normalize 'now' to midnight UTC

    // Find all LIVE matches
    const liveMatches = await Match.find(applyFightPublicVisibilityFilter({ matchType: 'LIVE' }, {}));

    // Filter matches to only include those with a past date (ignoring time)
    const matchesToConvert = liveMatches.filter((match) => {
      const matchDate = new Date(match.matchDate);
      matchDate.setUTCHours(0, 0, 0, 0); // Normalize match date to midnight UTC
      return matchDate < now; // Match date is in the past
    });

    if (matchesToConvert.length === 0) {
      console.log('No matches to convert to shadow.');
      return res.status(200).json({ message: 'No matches to convert to shadow.' });
    }

    for (const match of matchesToConvert) {
      // Create and save shadow match
      const shadowMatch = new Shadow({
        matchCategory: match.matchCategory,
        matchCategoryTwo: match.matchCategoryTwo,
        matchName: match.matchName,
        matchFighterA: match.matchFighterA,
        matchFighterB: match.matchFighterB,
        promotionBackground: match.promotionBackground,
        matchDescription: match.matchDescription,
        fighterAImage: match.fighterAImage,
        fighterBImage: match.fighterBImage,
        matchType: 'SHADOW',
        maxRounds: match.maxRounds,
        fighterAImageDeleteUrl: match.fighterAImageDeleteUrl,
        fighterBImageDeleteUrl: match.fighterBImageDeleteUrl,
        promotionBackgroundDeleteUrl: match.promotionBackgroundDeleteUrl,
      });

      await shadowMatch.save();


      // Optionally, update the original match to reflect the conversion
      match.matchType = 'SHADOW';
      await match.save();

      console.log(`Converted match ${match._id} to shadow.`);
      const users = await Affiliate.find();
      const mailPromises = users.map((user) => {
        const mailOptions = {
          from: 'Fantasymmadness2@gmail.com',
          to: user.email,
          subject: 'Fantasy MMAdness - New Fight Announcement',
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
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We're thrilled to announce that a new Shadow Fight has been added to your dashboard, ready for promotion.</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Name:</strong> ${match.matchName}</p>
                </td>
              </tr>
              
              <!-- Affiliate Call-to-Action Section -->
              <tr>
                <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                  <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Take the Lead!</h2>
                  <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                    The new Shadow Fight is now available for promotion. Share the excitement with your audience, build anticipation, and engage them in this thrilling event. 
                  </p>
                  <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                    Boost your league’s activity by encouraging fans to participate, and don’t miss the opportunity to expand your reach and earn rewards.
                  </p>
                </td>
              </tr>
    
              <!-- Match Details Section -->
              <tr>
                <td style="padding: 10px;">
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${match.maxRounds}</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Match Type:</strong> SHADOW</p>
                  <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                    Now is the time to activate your followers and get them involved. Start promoting the fight today, and keep the excitement growing in your community!
                  </p>
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
          `,
        };
        return transporter.sendMail(mailOptions);
      });

      try {
        await Promise.all(mailPromises);
        console.log(`Emails sent successfully for match ${match._id}`);
      } catch (error) {
        console.error(`Error sending emails for match ${match._id}:`, error);
      }
    }

    res.status(200).json({ message: 'Cron job completed successfully.' });
  } catch (error) {
    console.error('Error in cron job:', error);
    res.status(500).json({ error: 'Cron job failed.' });
  }
});



// Login API
app.post('/login', async (req, res) => {
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

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

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


const verifyToken = (req, res, next) => {
  console.log('Request headers:', req.headers); // Debugging line
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Extract token from Bearer scheme

  if (token == null) return res.sendStatus(401); // No token, unauthorized

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Token invalid, forbidden

    req.user = user; // Attach user info to request object
    next();
  });
};


// Profile API
app.get('/profile', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(USER_SAFE_SELECT);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});


// Profile API
app.get('/profileAffiliate', verifyToken, async (req, res) => {
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

const Admintokens = mongoose.model('Admintokens', adminTokensSchema);

// POST API to reward tokens to the admin and update matchReward status
app.post('/api/reward-tokens-to-admin', async (req, res) => {
  try {
    const { tokens, matchId, matchName, affiliateRewarded } = req.body;

    // Fetch or create an admin token document
    let adminToken = await Admintokens.findOne({ matchId });

    if (!adminToken) {
      adminToken = new Admintokens({ matchId, matchName });
    }

    // Add tokens to the admin's account and update totalTokens
    adminToken.tokens = (parseInt(adminToken.tokens, 10) + parseInt(tokens, 10)).toString();
    adminToken.affiliateRewarded = (parseInt(adminToken.affiliateRewarded, 10) + parseInt(affiliateRewarded, 10)).toString();
    adminToken.totalTokens = (parseInt(adminToken.totalTokens, 10) + parseInt(tokens, 10)).toString();

    await adminToken.save();

    res.status(200).json({ success: true, message: 'Tokens added to Admin wallet successfully', adminToken });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});





// GET API to fetch all admin token details
app.get('/api/admin-tokens', async (req, res) => {
  try {
    // Fetch all admin tokens from the database
    const adminTokens = await Admintokens.find().lean();

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
    res.status(500).json({ success: false, message: 'Server error', error });
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
    status: { type: String, default: 'pending' } // Status of the payout, default is 'pending'
  }]
}, { timestamps: true });
affiliateSchema.index({ email: 1 });
affiliateSchema.index({ createdAt: -1 });
affiliateSchema.index({ totalViews: -1, createdAt: -1 });
attachSafeAccountJsonTransform(affiliateSchema);

const Affiliate = mongoose.model('Affiliate', affiliateSchema);


app.post('/upload-affiliate-reward', upload.single('image'), async (req, res) => {
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





app.post('/admin/add-affiliate', async (req, res) => {
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
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Replace with admin email
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




app.post('/affiliate-google-login', async (req, res) => {
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
        from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
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
      const approvalLink = `https://fantasymmadness-game-server-three.vercel.app/approveAffiliate/${affiliate._id}`;

      await transporter.sendMail({
        from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
        to: 'Fantasymmadness2@gmail.com', // Admin email
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
    const jwtToken = jwt.sign({ id: affiliate._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

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
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: ['Fantasymmadness2@gmail.com', 'wajih786hassan@gmail.com'], // Recipients
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
app.post('/affiliate/:affiliateId/incrementViews', async (req, res) => {
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


app.post('/forgotPassword', async (req, res) => {
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
      from: 'wajih786hassan@gmail.com',
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


app.post('/resetPassword/:token', async (req, res) => {
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


app.delete('/affiliates/:id/payouts-to-delete', async (req, res) => {
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






app.post('/affiliate/:id/payout', async (req, res) => {
  try {
    const { amount } = req.body; // The payout amount should be passed in the request body
    const affiliateId = req.params.id;

    // Find the affiliate by ID
    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Add the new payout to the payouts array
    const payout = { amount, createdAt: new Date() };
    affiliate.payouts.push(payout);

    // Save the updated affiliate
    await affiliate.save();

    // Send email notification
    const mailOptions = {
      from: 'Fantasymmadness2@gmail.com',
      to: 'Fantasymmadness2@gmail.com', // Admin email
      subject: 'New Payout Request',
      text: `
        Hello Admin,
        
        There is a new payout request from the following affiliate:
        
        Affiliate Details:
        Name: ${affiliate.firstName} ${affiliate.lastName}
        Email: ${affiliate.email}
        Phone: ${affiliate.phone}

        Payout Request Details:
        Amount: $${amount}
        Requested On: ${payout.createdAt}

        Thank you!
      `,
    };

    // Send email
    await transporter.sendMail(mailOptions);

    // Respond to the client
    res.status(200).json({ message: 'Payout request created and email sent successfully', payout });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error });
  }
});


// Endpoint to confirm payment
app.post('/confirm-payment-affiliate', async (req, res) => {
    const { affiliateId, amount, payoutId } = req.body;

    try {
        // Find the affiliate by ID
        const affiliate = await Affiliate.findById(affiliateId);

        if (!affiliate) {
            return res.status(404).json({ message: 'Affiliate not found' });
        }

        // Convert tokens to a number for comparison and deduction
        const currentTokens = Number(affiliate.tokens); // Convert string to number

        // Check if the affiliate has enough tokens
        if (currentTokens < amount) {
            return res.status(400).json({ message: 'Insufficient tokens' });
        }

        // Deduct the amount from tokens
        affiliate.tokens = (currentTokens - amount).toString(); // Convert back to string

        // Update the payout status to completed
        const payout = affiliate.payouts.id(payoutId);
        if (payout) {
            payout.status = 'completed';
        } else {
            return res.status(404).json({ message: 'Payout not found' });
        }

        // Save the changes
        await affiliate.save();

        // Return a success response
        res.status(200).json({ message: 'Payment processed successfully', affiliate });
    } catch (error) {
        console.error('Error processing payment:', error);
        res.status(500).json({ message: 'Server error', error });
    }
});


app.post('/affiliate/:affiliateId/remove-user', async (req, res) => {
  const { affiliateId } = req.params;
  const { userId } = req.body;

  try {
    const affiliate = await Affiliate.findById(affiliateId);
    const user = await User.findById(userId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userExists = affiliate.usersJoined.some(joined => joined.userId.toString() === userId.toString());

    if (!userExists) {
      return res.status(400).json({ message: 'User not found in this league' });
    }

    // Remove user from affiliate
    await Affiliate.findByIdAndUpdate(
      affiliateId,
      { $pull: { usersJoined: { userId: userId } } },
      { new: true }
    );

    // Prepare and send email to affiliate
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
            <p style="font-size: 16px;">Hello ${affiliate.firstName},</p>
            <p style="font-size: 16px; color: #555;">
              This is to inform you that <strong>${user.firstName || user.lastName }</strong> has left your league on Fantasy MMA Madness.
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
      from: '"Fantasy MMA Madness" <Fantasymmadness2@gmail.com>',
      to: affiliate.email,
      subject: 'A User Has Left Your League',
      html: emailHtml,
    });

    return res.status(200).json({ message: 'User removed and email sent to affiliate' });

  } catch (error) {
    console.error('Error in remove-user route:', error);
    return res.status(500).json({ message: 'Error removing user from the league', error });
  }
});


app.post('/clean-affiliate-users', async (req, res) => {
  try {
    const affiliates = await Affiliate.find(); // Get all affiliates
    
    for (const affiliate of affiliates) {
      const validUsers = [];
      const removedUsers = [];

      for (const user of affiliate.usersJoined) {
        const userExists = await User.findById(user.userId);
        if (userExists) {
          validUsers.push(user); // Retain valid users
        } else {
          removedUsers.push(user);
        }
      }

      // Update the affiliate with the filtered users
      await Affiliate.findByIdAndUpdate(affiliate._id, { usersJoined: validUsers });
      
      if (removedUsers.length > 0) {
        console.log(`Affiliate League: ${affiliate.playerName} (${affiliate._id}) - Removed Users:`, removedUsers.map(u => u.email));
      }
    }

    return res.status(200).json({ message: 'Affiliate user lists cleaned successfully' });
  } catch (error) {
    return res.status(500).json({ message: 'Error cleaning affiliate users', error });
  }
});

// POST API to reward tokens to the user and update matchReward status
app.post('/api/reward-tokens-to-affiliate/:affiliateId', async (req, res) => {
  try {
    const { affiliateId } = req.params;
    const { tokens } = req.body;

    // Find the user by ID
    const user = await Affiliate.findById(affiliateId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add tokens to the user's account
    user.tokens = parseInt(user.tokens, 10) + parseInt(tokens, 10);

    // Save the updated user
    await user.save();

    res.status(200).json({ success: true, message: 'Tokens rewarded to affiliate successfully', user });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error', error });
  }
});





app.get('/affiliateByName', async (req, res) => {
  const { fullName } = req.query;

  if (!fullName) {
      return res.status(400).json({ error: 'FullName is required.' });
  }

  try {
      // Assuming you have a model called Affiliate
      const affiliate = await Affiliate.findOne({
          $expr: { 
              $eq: [{ $concat: ["$firstName", " ", "$lastName"] }, fullName] 
          }
      });

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      res.status(200).json(affiliate);
  } catch (error) {
      console.error('Error fetching affiliate details:', error);
      res.status(500).json({ message: 'Server error' });
  }
});



app.post('/affiliate/updatePayment/:id', async (req, res) => {
  const { id } = req.params; // Get the affiliate ID from URL params
  const { preferredPaymentMethod, preferredPaymentMethodValue } = req.body; // Get data from request body

  try {
    // Find the affiliate by ID and update the payment method and value
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(
      id, 
      {
        preferredPaymentMethod,
        preferredPaymentMethodValue
      }, 
      { new: true } // Return the updated document
    );

    if (!updatedAffiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    res.status(200).json({ message: 'Affiliate updated successfully', data: updatedAffiliate });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error', error });
  }
});







const sendUserEmail = async (user, affiliate) => {
  const mailOptions = {
    from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
    to: user.email,
    subject: `Thank You for Joining ${affiliate.firstName}'s League!`,
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
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Thank you for joining <strong>${affiliate.firstName}</strong>'s league!
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              We are thrilled to have you on board. Stay tuned for more exciting updates and matches ahead!
            </p>
          </td>
        </tr>
        
        <!-- Affiliate Profile Section -->
        <tr>
          <td align="center" style="padding: 20px; background-color:#f8f8f8;">
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
            <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">${affiliate.firstName}'s League</h3>
            <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
              Get ready for the ultimate competition! We’re excited to see you in action.
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
  };

  await transporter.sendMail(mailOptions);
};


const sendAffiliateEmail = async (affiliate, user) => {
  const mailOptions = {
    from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
    to: affiliate.email,
    subject: `${user.firstName} ${user.lastName} has joined your league!`,
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
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${affiliate.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              We are excited to inform you that <strong>${user.firstName} ${user.lastName}</strong> has joined your league!
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              You are now one step closer to building a fantastic team. Keep an eye on the upcoming matches and engage with your new members.
            </p>
          </td>
        </tr>

        <!-- Affiliate Profile Section -->
        <tr>
          <td align="center" style="padding: 20px; background-color:#f8f8f8;">
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
            <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">${affiliate.firstName}'s League</h3>
            <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
              Keep building your team and prepare for thrilling challenges ahead!
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
  };

  await transporter.sendMail(mailOptions);
};

app.post('/affiliate/:affiliateId/join', async (req, res) => {
  const { affiliateId } = req.params;
  const { userId, userEmail } = req.body; // Receive userId and userEmail from the request body

  try {
    const affiliate = await Affiliate.findById(affiliateId);

    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    // Check if user has already joined
    const alreadyJoined = affiliate.usersJoined.some(user => user.userId.toString() === userId.toString());

    if (alreadyJoined) {
      return res.status(400).json({ message: 'User already joined this league' });
    }

    // Fetch the user's details from the User collection using userId
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Add the user to the league
    affiliate.usersJoined.push({ userId, email: userEmail });
    await affiliate.save();

    // Send emails to both the user and the affiliate
    await sendUserEmail(user, affiliate);
    await sendAffiliateEmail(affiliate, user);

    return res.status(200).json({ message: 'User successfully joined the league', affiliate });
  } catch (error) {
    return res.status(500).json({ message: 'Error joining the league', error });
  }
});
app.put('/update-profile-affiliate/:userId', upload.single('image'), async (req, res) => {
  const { userId } = req.params;
  const { firstName, lastName, playerName, phone, zipCode, shortBio } = req.body;

  try {
    // Create an object to hold the fields that should be updated
    const updateFields = {};

    if (firstName) updateFields.firstName = firstName;
    if (lastName) updateFields.lastName = lastName;
    if (playerName) updateFields.playerName = playerName;
    if (phone) updateFields.phone = phone;
    if (zipCode) updateFields.zipCode = zipCode;
    if (shortBio) updateFields.shortBio = shortBio;

    // Check if a new image is provided
    if (req.file) {
      // Find the affiliate to retrieve the previous delete URL
      const affiliate = await Affiliate.findById(userId).select('+profileDeleteUrl');
      if (!affiliate) {
        return res.status(404).send('Affiliate not found');
      }

      // Delete the previous image from Cloudinary if delete URL exists
      if (affiliate.profileDeleteUrl) {
        await cloudinary.uploader.destroy(affiliate.profileDeleteUrl);
      }

      // Upload new avatar image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'affiliates' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      updateFields.profileUrl = result.secure_url;
      updateFields.profileDeleteUrl = result.public_id;
    }

    // Update the affiliate document with the specified fields
    const updatedAffiliate = await Affiliate.findByIdAndUpdate(userId, updateFields, { new: true });

    if (!updatedAffiliate) {
      return res.status(404).send('Affiliate not found');
    }

    res.status(200).json({
      message: 'Profile updated successfully',
      user: updatedAffiliate,
    });
  } catch (error) {
    console.error('Error updating affiliate profile:', error);
    res.status(500).send('Server error');
  }
});

// Delete Affiliate API
app.delete('/affiliatetodelete/:id', async (req, res) => {
  const { id } = req.params;
  console.log('Received DELETE request for Affiliate ID:', id);

  try {
    // Find the affiliate by ID
    const affiliate = await Affiliate.findById(id).select('+profileDeleteUrl firstName');
    if (!affiliate) {
      return res.status(404).json({ message: 'Affiliate not found' });
    }

    if (affiliate.profileDeleteUrl) {
  try {
    await cloudinary.uploader.destroy(affiliate.profileDeleteUrl);
  } catch (error) {
    console.error('Error deleting affiliate profile image from Cloudinary:', error.message);
  }
}

    // Delete the affiliate from the database
    await Affiliate.findByIdAndDelete(id);
const notification = new Notification({
      title: `Affiliate Removed: ${affiliate.firstName}`,
    });
    await notification.save();
   
    res.status(200).json({ message: 'Affiliate and profile image deleted successfully' });
  } catch (error) {
    console.error('Error deleting affiliate:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});



// Get affiliates. Kept at the legacy /affiliates path for compatibility,
// with sensitive credential/reset/payment values removed from each payload.
app.get('/affiliates', async (req, res) => {
  try {
    const affiliates = await Affiliate.find().select(AFFILIATE_SAFE_SELECT).lean();
    res.send(sanitizeAccountList(affiliates));
  } catch (error) {
    console.error('Error fetching affiliates:', error);
    res.status(500).json({ message: 'Error fetching affiliates' });
  }
});

app.post('/send-email-affiliate', async (req, res) => {
  const { email, subject, message } = req.body;

  // Check if email, subject, and message are provided
  if (!email || !subject || !message) {
      return res.status(400).json({ message: 'Email, subject, and message are required' });
  }

  try {
      // Send mail with the defined transport object
      await transporter.sendMail({
          from: '"Fantasy mmadnress Team" <Fantasymmadness2@gmail.com>', // sender address
          to: email, // list of receivers
          subject: subject, // Subject line
          text: message, // plain text body
      });

      res.status(200).json({ message: 'Email sent successfully' });
  } catch (error) {
      console.error('Error sending email:', error);
      res.status(500).json({ message: 'Internal server error' });
  }
});




app.post('/affiliates/:id/verify', async (req, res) => {
  try {
      const { id } = req.params;
      const affiliate = await Affiliate.findById(id);

      if (!affiliate) {
          return res.status(404).json({ message: 'Affiliate not found' });
      }

      affiliate.verified = true;
      await affiliate.save();

      res.status(200).json({ message: 'Affiliate verified successfully', affiliate });
  } catch (error) {
      console.error('Error verifying affiliate:', error);
      res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/registerAffiliate', upload.single('image'), async (req, res) => {
  try {
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
      hearing
    } = req.body;

    // Check if email already exists
    const existingUser = await Affiliate.findOne({ email });
    if (existingUser) {
      return res.status(400).send('Email already registered');
    }

    // Handle image upload if an image is provided
    let profileUrl = '';
    let profileDeleteUrl = '';
    if (req.file) {
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'affiliates' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      profileUrl = result.secure_url;
      profileDeleteUrl = result.public_id;
    }

    // Create new user with hashed password
    const newUser = new Affiliate({
      firstName,
      lastName,
      playerName,
      email,
      phone,
      zipCode,
      hearing,
      isNotificationsEnabled,
      isSubscribed,
      isUSCitizen,
      isAgreed,
      verified: false,
      password: await bcrypt.hash(password, 10),
      profileUrl, // Save the profile image URL
      profileDeleteUrl, // Save the delete URL for future image deletion
    });

    // Save the new user to the database
    await newUser.save();

const notification = new Notification({
      title: `Affiliate Signed Up: ${newUser.firstName}`,
    });
    await notification.save();
    const approvalLink = `https://fantasymmadness-game-server-three.vercel.app/approveAffiliate/${newUser._id}`;

    // Send email notification to the admin
    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: 'Fantasymmadness2@gmail.com', // Admin email
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
                A new affiliate <strong>${newUser.firstName} ${newUser.lastName}</strong> has registered on Fantasy Madness. Please review and approve their profile.
              </p>
            </td>
          </tr>
          
          <tr>
            <td align="center" style="padding: 20px; background-color:#f8f8f8;">
              <img src="${newUser.profileUrl}" alt="Affiliate Profile" style="width:60px; height:60px; border-radius:50%; border:3px solid #191164;" />
              <h3 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Affiliate Details</h3>
              <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                Name: ${newUser.firstName} ${newUser.lastName}<br>
                Email: ${newUser.email}<br>
                Phone: ${newUser.phone}<br>
                ZIP Code: ${newUser.zipCode}
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

    res.status(201).send('User registered successfully');
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).send('Server error');
  }
});

app.get('/approveAffiliate/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const affiliate = await Affiliate.findById(id);

    if (!affiliate) {
      return res.status(404).send(`
        <html>
          <body style="display: flex; align-items: center; justify-content: center; height: 100vh; background-color: #333; color: white; font-family: Arial, sans-serif;">
            <h1 style="color: #ff0000; font-size: 48px;">Affiliate not found</h1>
          </body>
        </html>
      `);
    }

    // Check if the affiliate is already verified
    if (affiliate.verified) {
      return res.send(`
        <html>
          <head>
            <style>
              body {
                background-color: #000;
                color: #fff;
                font-family: Arial, sans-serif;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .container {
                text-align: center;
                border: 2px solid #ff0000;
                padding: 20px;
                width: 80%;
                max-width: 500px;
                background-color: #222;
                border-radius: 10px;
                box-shadow: 0px 4px 15px rgba(255, 0, 0, 0.6);
              }
              h1 {
                font-size: 36px;
                margin-bottom: 15px;
                color: #ff0000;
                text-shadow: 2px 2px #000;
              }
              p {
                font-size: 18px;
                margin-bottom: 20px;
                color: #ccc;
              }
              .profile-img {
                width: 100px;
                height: 100px;
                border-radius: 50%;
                border: 3px solid #ff0000;
                margin-top: 15px;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Affiliate Already Approved</h1>
              <p>This affiliate has already been approved previously.</p>
              <img src="${affiliate.profileUrl}" alt="Affiliate Profile Image" class="profile-img" />
            </div>
             <script>
              setTimeout(() => window.close(), 3000); // Close tab after 2 seconds
            </script>
          </body>
        </html>
      `);
    }

    // Mark affiliate as verified if not already verified
    affiliate.verified = true;
    await affiliate.save();

    // Send success response
    res.send(`
      <html>
        <head>
          <style>
            body {
              background-color: #000;
              color: #fff;
              font-family: Arial, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
            }
            .container {
              text-align: center;
              border: 2px solid #ff0000;
              padding: 20px;
              width: 80%;
              max-width: 500px;
              background-color: #222;
              border-radius: 10px;
              box-shadow: 0px 4px 15px rgba(255, 0, 0, 0.6);
            }
            h1 {
              font-size: 36px;
              margin-bottom: 15px;
              color: #ff0000;
              text-shadow: 2px 2px #000;
            }
            p {
              font-size: 18px;
              margin-bottom: 20px;
              color: #ccc;
            }
            .profile-img {
              width: 100px;
              height: 100px;
              border-radius: 50%;
              border: 3px solid #ff0000;
              margin-top: 15px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Affiliate Approved!</h1>
            <p>Congratulations! The affiliate has been successfully approved.</p>
            <img src="${affiliate.profileUrl}" alt="Affiliate Profile Image" class="profile-img" />
            <script>
              setTimeout(() => window.close(), 3000); // Close tab after 2 seconds
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error approving affiliate:', error);
    res.status(500).send(`
      <html>
        <body style="display: flex; align-items: center; justify-content: center; height: 100vh; background-color: #333; color: white; font-family: Arial, sans-serif;">
          <h1 style="color: #ff0000; font-size: 48px;">Internal Server Error</h1>
        </body>
      </html>
    `);
  }
});

// Login API
app.post('/loginAffiliate', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await Affiliate.findOne({ email }).select('_id +password verified').lean();

    if (!user) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.cookie('token', token, { httpOnly: true, maxAge: 3600000 }); // 1 hour

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






















const scoreSchema = new mongoose.Schema({
  playerId: String,
  matchId: String,
  predictions: [{ 
    round: Number, 
    hpPrediction1: Number,  // For Boxing or MMA (HP or ST)
    bpPrediction1: Number,  // For Boxing or MMA (BP or KI)
    hpPrediction2: Number,  // For Boxing or MMA (HP or ST)
    bpPrediction2: Number,  // For Boxing or MMA (BP or KI)
    tpPrediction1: Number,  // For Boxing or MMA (TP or KN)
    tpPrediction2: Number,  // For Boxing or MMA (TP or KN)
    rwPrediction1: Number, 
    rwPrediction2: Number, 
    koPrediction1: Number, 
    koPrediction2: Number,
    elPrediction1: Number,  // For MMA only (EL)
    elPrediction2: Number   // For MMA only (EL)
  }],
});
scoreSchema.index({ matchId: 1, playerId: 1 });
scoreSchema.index({ playerId: 1 });
scoreSchema.index({ matchId: 1 });

const Score = mongoose.model('Score', scoreSchema);
app.post('/api/scores', async (req, res) => {
  try {
    const { playerId, matchId, predictions } = req.body;

    if (!playerId || !matchId || !Array.isArray(predictions)) {
      return res.status(400).json({
        message: 'playerId, matchId, and predictions array are required.',
      });
    }

    // Check if there's an existing record with the same playerId and matchId
    let existingScore = await Score.findOne({ playerId, matchId });

    if (existingScore) {
      // If a record exists, update its values
      existingScore.predictions = predictions;
      await existingScore.save();
      clearPublicResponseCache();
      res.status(200).send(existingScore);
    } else {
      // If no record exists, create a new one
      const score = new Score({ playerId, matchId, predictions });
      await score.save();
      clearPublicResponseCache();
      res.status(201).send(score);
    }
  } catch (error) {
    res.status(400).send(error);
  }
});

// API endpoint to retrieve scores
app.get('/api/scores', async (req, res) => {
  try {
    const query = {};
    if (req.query.matchId) query.matchId = String(req.query.matchId);
    if (req.query.playerId) query.playerId = String(req.query.playerId);

    const scoreQuery = Score.find(query).lean();
    if (req.query.limit) scoreQuery.limit(parsePositiveInteger(req.query.limit, 100, 1000));

    const scores = await scoreQuery;
    res.send(scores);
  } catch (error) {
    res.status(500).send(error);
  }
});


async function buildClassicLeaderboard({ limit = 10 } = {}) {
  const scoreRows = await Score.find().select('playerId matchId predictions').lean();
  if (!scoreRows.length) return { leaderboard: [], playerCount: 0 };

  const validMatchObjectIds = [...new Set(scoreRows
    .map((score) => String(score.matchId || '').trim())
    .filter((matchId) => mongoose.isValidObjectId(matchId)))]
    .map((matchId) => new mongoose.Types.ObjectId(matchId));

  const matchRows = validMatchObjectIds.length
    ? await Match.find({ _id: { $in: validMatchObjectIds } })
      .select('matchName matchFighterA matchFighterB matchDate matchCategory matchCategoryTwo matchStatus matchShadowStatus matchShadowOpenStatus fighterAImage fighterBImage promotionBackground matchType matchTokens fighterAId fighterBId BoxingMatch.fighterOneStats BoxingMatch.fighterTwoStats MMAMatch.fighterOneStats MMAMatch.fighterTwoStats createdAt updatedAt')
      .populate('fighterAId fighterBId')
      .lean()
    : [];

  const matchById = new Map(matchRows
    .filter((match) => !isDraftFightRecord(match))
    .map((match) => [String(match._id), match]));

  const playerIds = [...new Set(scoreRows.map((score) => String(score.playerId || '').trim()).filter(Boolean))];
  const validPlayerObjectIds = playerIds
    .filter((playerId) => mongoose.isValidObjectId(playerId))
    .map((playerId) => new mongoose.Types.ObjectId(playerId));

  const userRows = validPlayerObjectIds.length
    ? await User.find({ _id: { $in: validPlayerObjectIds } }).select(USER_SAFE_SELECT).lean()
    : [];
  const userById = new Map(sanitizeAccountList(userRows).map((user) => [String(user._id), user]));

  const pointsByPlayer = new Map();
  const playerMatchId = new Map();

  scoreRows.forEach((score) => {
    const match = matchById.get(String(score.matchId));
    if (!match) return;

    const fighterOneStats = String(match.matchCategory || '').toLowerCase() === 'boxing'
      ? match.BoxingMatch?.fighterOneStats
      : match.MMAMatch?.fighterOneStats;
    const fighterTwoStats = String(match.matchCategory || '').toLowerCase() === 'boxing'
      ? match.BoxingMatch?.fighterTwoStats
      : match.MMAMatch?.fighterTwoStats;

    const pointsEarned = calculateClassicPredictionPoints(
      score.predictions,
      fighterOneStats,
      fighterTwoStats,
      match.matchCategory
    );

    if (pointsEarned <= 0) return;

    const playerId = String(score.playerId);
    pointsByPlayer.set(playerId, (pointsByPlayer.get(playerId) || 0) + pointsEarned);
    playerMatchId.set(playerId, String(match._id));
  });

  const leaderboard = [...pointsByPlayer.entries()]
    .map(([playerId, totalPoints]) => {
      const user = userById.get(playerId) || { _id: playerId };
      const match = matchById.get(playerMatchId.get(playerId));
      return {
        ...user,
        totalPoints,
        matchId: match ? String(match._id) : playerMatchId.get(playerId),
        match: match ? pickPublicFightFields(match, 'match') : null,
      };
    })
    .sort((a, b) => b.totalPoints - a.totalPoints)
    .slice(0, limit);

  return { leaderboard, playerCount: pointsByPlayer.size };
}

async function loadPublicFightCards({ limit = 6, category } = {}) {
  let baseFilter = {};
  baseFilter = appendAndFilter(baseFilter, buildEffectiveFightCategoryFilter(category));
  const visibleFilter = applyFightPublicVisibilityFilter(baseFilter, { playable: 'true' });
  const queryLimit = Math.min(Math.max(limit * 6, limit), 500);

  const [matches, shadows] = await Promise.all([
    applyFightFreshSortLean(Match.find(visibleFilter).populate('fighterAId fighterBId')).limit(queryLimit),
    applyFightFreshSortLean(Shadow.find(visibleFilter).populate('fighterAId fighterBId')).limit(queryLimit).catch(() => []),
  ]);

  let items = [
    ...matches.map((item) => ({ ...pickPublicFightFields(item, 'match'), __raw: item })),
    ...shadows.map((item) => ({ ...pickPublicFightFields(item, 'shadow'), __raw: item })),
  ].filter((item) => !isDraftFightRecord(item.__raw || item));

  if (!isAllFilterValue(category)) {
    items = items.filter((item) => isFightRecordInEffectiveCategory(item.__raw || item, category));
  }

  return items
    .sort((a, b) => {
      const toTime = (value) => {
        const date = value ? new Date(value) : null;
        return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
      };
      return Math.max(toTime(b.updatedAt), toTime(b.createdAt), toTime(b.matchDate))
        - Math.max(toTime(a.updatedAt), toTime(a.createdAt), toTime(a.matchDate));
    })
    .slice(0, limit)
    .map(({ __raw, ...item }) => item);
}

app.get('/api/public/leaderboard', async (req, res) => {
  try {
    const { payload, cacheState } = await readThroughPublicCache(
      getPublicCacheKey(req, 'public-leaderboard'),
      async () => {
        const limit = parsePositiveInteger(req.query.limit, 10, 100);
        const result = await buildClassicLeaderboard({ limit });

        return {
          ok: true,
          leaderboard: result.leaderboard,
          playerCount: result.playerCount,
          generatedAt: new Date().toISOString(),
        };
      }
    );

    setPublicCacheHeaders(res, PUBLIC_CACHE_TTL_SECONDS, cacheState);
    res.json(payload);
  } catch (error) {
    console.error('Error building public leaderboard:', error);
    res.status(500).json({ ok: false, message: 'Failed to build public leaderboard.' });
  }
});

app.get('/api/public/home-summary', async (req, res) => {
  try {
    const { payload, cacheState } = await readThroughPublicCache(
      getPublicCacheKey(req, 'public-home-summary'),
      async () => {
        const fightLimit = parsePositiveInteger(req.query.fightLimit || req.query.limit, 6, 24);
        const leaderboardLimit = parsePositiveInteger(req.query.leaderboardLimit, 5, 25);

        const [featuredFights, leaderboardResult, totalPlayers, activeClassicFights] = await Promise.all([
          loadPublicFightCards({ limit: fightLimit, category: req.query.category }),
          buildClassicLeaderboard({ limit: leaderboardLimit }),
          User.countDocuments(),
          Match.countDocuments(applyFightPublicVisibilityFilter({}, { playable: 'true' })),
        ]);

        return {
          ok: true,
          featuredFights,
          leaderboard: leaderboardResult.leaderboard,
          stats: {
            players: totalPlayers,
            activeFights: activeClassicFights,
            leaderboardPlayers: leaderboardResult.playerCount,
          },
          generatedAt: new Date().toISOString(),
        };
      }
    );

    setPublicCacheHeaders(res, PUBLIC_CACHE_TTL_SECONDS, cacheState);
    res.json(payload);
  } catch (error) {
    console.error('Error building public home summary:', error);
    res.status(500).json({ ok: false, message: 'Failed to build public home summary.' });
  }
});

app.delete('/api/scores', async (req, res) => {
  try {
    await Score.deleteMany({}); // This will delete all records in the Score collection
    clearPublicResponseCache();
    res.status(200).send({ message: 'All records deleted successfully' });
  } catch (error) {
    res.status(500).send({ error: 'Failed to delete records' });
  }
});

















const adminSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: String,
  password: { type: String, select: false },
  profileUrl: String, // Add profileUrl field
});
adminSchema.index({ email: 1 });
adminSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.password;
    return ret;
  },
});

const Admin = mongoose.model('Admin', adminSchema);

app.post('/admin/register', async (req, res) => {
  const { firstName, lastName, email, password, profileUrl } = req.body;

  try {
    // Check if the email already exists
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ message: 'Admin already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new admin
    const newAdmin = new Admin({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      profileUrl,
    });

    // Save the admin to the database
    await newAdmin.save();

    res.status(201).json({ message: 'Admin registered successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find the admin by email
    const admin = await Admin.findOne({ email }).select('_id email +password').lean();
    if (!admin) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // Compare the provided password with the stored hashed password
    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid email or password.' });
    }

    // Generate a JWT token
    const token = jwt.sign(
      { id: admin._id, email: admin.email },
      process.env.JWT_SECRET_ADMIN,
      { expiresIn: '1h' }
    );

    

    res.status(200).json({ token, message: 'Login successful.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error. Please try again later.' });
  }
});

















const youtubeVideosSchema = new mongoose.Schema({
  videoUrl: String, 
});
youtubeVideosSchema.index({ videoUrl: 1 });



const YoutubeVideos = mongoose.model('YoutubeVideos', youtubeVideosSchema);



// Delete Match API
app.delete('/youtubevideotodelete/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    const user = await YoutubeVideos.findByIdAndDelete(id);
    
    res.status(200).json({ message: 'YoutubeVideos deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.post('/youtubeVideos', async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ message: 'Video URL is required' });
  }

  try {
    // Check if the video URL already exists in the database
    const existingVideo = await YoutubeVideos.findOne({ videoUrl });

    if (existingVideo) {
      return res.status(409).json({ message: 'This video already exists in the library' });
    }

    // If not, create a new video entry
    const newVideo = new YoutubeVideos({ videoUrl });
    await newVideo.save();

    res.status(201).json({ message: 'YouTube video added successfully', video: newVideo });
  } catch (error) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get Matches API
app.get('/youtubeVideos', async (req, res) => {
  const match = await YoutubeVideos.find().lean();
  res.send(match);
});


app.post('/addShadow', upload.fields([
  { name: 'fighterAImage' },
  { name: 'fighterBImage' },
  { name: 'promotionBackground' },
]), async (req, res) => {
  try {
    const {
      matchCategoryTwo,
      maxRounds,
      matchCategory,
      matchName,
      matchFighterA,
      matchFighterB,
      matchDescription,
      matchVideoUrl,
      matchType,
      fighterAImageUrl,
      fighterAImageDeleteUrlFromReq,
      fighterBImageUrl,
      fighterBImageDeleteUrlFromReq,
      promotionBackgroundUrl,
      promotionBackgroundDeleteUrlFromReq
    } = req.body;

    // Helper function to upload to Cloudinary
    const uploadToCloudinary = (fileBuffer, folder) => {
      return new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(fileBuffer);
      });
    };

    let fighterAImage = fighterAImageUrl || null;
    let fighterBImage = fighterBImageUrl || null;
    let promotionBackground = promotionBackgroundUrl || null;

    let fighterAImageDeleteUrl = fighterAImageDeleteUrlFromReq || null;
    let fighterBImageDeleteUrl = fighterBImageDeleteUrlFromReq || null;
    let promotionBackgroundDeleteUrl = promotionBackgroundDeleteUrlFromReq || null;

    if (req.files.fighterAImage) {
      const resultA = await uploadToCloudinary(req.files.fighterAImage[0].buffer, 'fighters');
      fighterAImage = resultA.secure_url;
      fighterAImageDeleteUrl = resultA.public_id;
    }

    if (req.files.fighterBImage) {
      const resultB = await uploadToCloudinary(req.files.fighterBImage[0].buffer, 'fighters');
      fighterBImage = resultB.secure_url;
      fighterBImageDeleteUrl = resultB.public_id;
    }

    if (req.files.promotionBackground) {
      const resultBackground = await uploadToCloudinary(req.files.promotionBackground[0].buffer, 'promotions');
      promotionBackground = resultBackground.secure_url;
      promotionBackgroundDeleteUrl = resultBackground.public_id;
    }

    const newMatch = new Shadow({
      matchCategory,
      matchCategoryTwo,
      matchName,
      matchFighterA,
      matchFighterB,
      matchDescription,
      matchVideoUrl,
      fighterAImage,
      fighterBImage,
      fighterAImageDeleteUrl,
      fighterBImageDeleteUrl,
      promotionBackground,
      promotionBackgroundDeleteUrl,
      matchType,
      maxRounds,
      ...buildAutoHomepagePromotionFields({
        body: req.body,
        admin: req.admin,
        actor: 'addShadow',
      }),
    });

    await newMatch.save();
    clearPublicResponseCache();

 const notification = new Notification({
      title: `Shadow Fight Added: ${newMatch.matchName}`,
    });
    await notification.save();
    if (req.body.notify === 'true' || req.body.notify === true) {
      const users = await Affiliate.find();

      const mailPromises = users.map((user) => {
        const mailOptions = {
          from: 'Fantasymmadness2@gmail.com',
          to: user.email,
          subject: 'Fantasy MMAdness - New Fight Announcement',
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
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We're thrilled to announce that a new Shadow Fight has been added to your dashboard, ready for promotion.</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Fight Name:</strong> ${matchName}</p>
              </td>
            </tr>
            
            <!-- Affiliate Call-to-Action Section -->
            <tr>
              <td align="center" style="padding: 20px; background-color:#f8f8f8;">
                <h2 style="color: #191164; font-family: 'Impact', fantasy, sans-serif;">Take the Lead!</h2>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  The new Shadow Fight is now available for promotion. Share the excitement with your audience, build anticipation, and engage them in this thrilling event. 
                </p>
                <p style="font-size: 17px; font-family: 'Comic Sans MS', fantasy, sans-serif; color: #555;">
                  Boost your league’s activity by encouraging fans to participate, and don’t miss the opportunity to expand your reach and earn rewards.
                </p>
              </td>
            </tr>
        
            <!-- Match Details Section -->
            <tr>
              <td style="padding: 10px;">
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Max Rounds:</strong> ${maxRounds}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;"><strong>Match Type:</strong> ${matchType}</p>
                <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
                  Now is the time to activate your followers and get them involved. Start promoting the fight today, and keep the excitement growing in your community!
                </p>
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
        `,
        };

        return transporter.sendMail(mailOptions);
      });

      try {
        await Promise.all(mailPromises);
        console.log('Emails sent successfully');
      } catch (error) {
        console.error('Error sending emails:', error);
      }
    } else {
      console.log('Notification skipped because notify is set to false');
    }

    res.status(200).json({
      message: 'Match Added Successfully and Notifications Sent',
      matchId: newMatch._id,
    });
  } catch (error) {
    console.error('Error adding shadow match:', error);
    res.status(500).send('Server error');
  }
});


app.get('/dashboard-counts', async (req, res) => {
  try {
    // Fetch entity counts
    const affiliatesCount = await Affiliate.countDocuments({});
    const matchesCount = await Match.countDocuments({});
    const usersCount = await User.countDocuments({});
    const shadowTemplatesCount = await Shadow.countDocuments({});

    // Fetch total clicks from SiteStats
    const stats = await SiteStats.findOne({}).lean();
    const totalClicks = stats ? stats.totalClicks : 0;

    // Count unread notifications
    const unreadNotificationsCount = await Notification.countDocuments({ read: false });

    // Send response
    res.json({
      affiliatesCount,
      matchesCount,
      usersCount,
      shadowTemplatesCount,
      totalClicks,
      unreadNotificationsCount
    });
  } catch (error) {
    console.error('Error fetching dashboard counts:', error);
    res.status(500).json({ error: 'Failed to fetch counts' });
  }
});



const userRemovedMatchesSchema = new mongoose.Schema({
  userId: { type: String, required: true },  // userId as a string
  removedMatchesIds: { 
      type: [String],  // array of strings to store removed match IDs
      default: [] 
  },
}, { timestamps: true });
userRemovedMatchesSchema.index({ userId: 1 });


const UserRemovedMatches = mongoose.model('UserRemovedMatches', userRemovedMatchesSchema);


app.delete('/remove-matches-of-user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
      const result = await UserRemovedMatches.deleteMany({ userId });
      
      if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'No records found for this userId.' });
      }
      
      res.status(200).json({ message: 'All records removed successfully.' });
  } catch (error) {
      console.error('Error deleting records:', error);
      res.status(500).json({ message: 'Internal server error.' });
  }
});

// Add removed match for a user
app.post('/remove-match-from-my-dashboard', async (req, res) => {
  const { userId, matchId } = req.body;

  try {
      // Find the user's removed matches document
      let userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          // If the document doesn't exist, create it
          userMatches = new UserRemovedMatches({
              userId,
              removedMatchesIds: [matchId]
          });
      } else {
          // If it exists, check if the matchId already exists
          if (!userMatches.removedMatchesIds.includes(matchId)) {
              userMatches.removedMatchesIds.push(matchId);
          } else {
              return res.status(409).json({ message: 'Match already removed for this user' });
          }
      }

      // Save the updated document
      await userMatches.save();

      res.status(201).json({ message: 'Match removed successfully', data: userMatches });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});

// Remove a removed match for a user
app.delete('/remove-match-from-my-dashboard', async (req, res) => {
  const { userId, matchId } = req.body;

  try {
      // Find the user's removed matches document
      let userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          return res.status(404).json({ message: 'No removed matches found for this user' });
      }

      // Check if the matchId exists in the removedMatchesIds array
      const matchIndex = userMatches.removedMatchesIds.indexOf(matchId);

      if (matchIndex === -1) {
          return res.status(404).json({ message: 'Match not found in removed list' });
      }

      // Remove the matchId from the array
      userMatches.removedMatchesIds.splice(matchIndex, 1);

      // Save the updated document
      await userMatches.save();

      res.status(200).json({ message: 'Match removed from dashboard successfully', data: userMatches });
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});


app.get('/user/:userId/removed-matches', async (req, res) => {
  const { userId } = req.params;

  try {
      // Find the user's removed matches document
      const userMatches = await UserRemovedMatches.findOne({ userId });

      if (!userMatches) {
          return res.status(404).json({ message: 'No matches found for this user' });
      }

      res.status(200).json(userMatches);
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});


app.get('/users/removed-matches', async (req, res) => {
  try {
      // Find all documents in the UserRemovedMatches collection
      const allUserMatches = await UserRemovedMatches.find().lean();

      if (!allUserMatches || allUserMatches.length === 0) {
          return res.status(404).json({ message: 'No removed matches found for any user' });
      }

      res.status(200).json(allUserMatches);
  } catch (error) {
      res.status(500).json({ message: 'Server error', error });
  }
});

















const customUserSchema = new mongoose.Schema({
  fullName: String,
  email: { type: String, required: true, unique: true },
  
}, { timestamps: true });

customUserSchema.index({ createdAt: -1 });
const Usernonregistered = mongoose.model('Usernonregistered', customUserSchema);

// POST API to create a new non-registered user
app.post('/api/users/nonregistered', async (req, res) => {
  try {
    const { fullName, email } = req.body;

    // Check if the email already exists in the User collection
    const existingUser = await User.findOne({ email });

    if (existingUser) {
      // If the email already exists, return an error
      return res.status(400).json({ message: 'Email is already registered' });
    }

    // If the email does not exist, create a new non-registered user
    const newUser = new Usernonregistered({ fullName, email });
    await newUser.save();
    
    res.status(201).json({ message: 'User created successfully', newUser });
  } catch (error) {
    res.status(400).json({ message: 'Error creating user', error });
  }
});


// GET API to fetch all non-registered users
app.get('/api/users/nonregistered', async (req, res) => {
  try {
      const users = await Usernonregistered.find().lean();
      res.status(200).json(users);
  } catch (error) {
      res.status(500).json({ message: 'Error fetching users', error });
  }
});


// DELETE API to remove a non-registered user by ID
app.delete('/api/users/nonregistered/:id', async (req, res) => {
  try {
      const { id } = req.params;
      const deletedUser = await Usernonregistered.findByIdAndDelete(id);
      if (deletedUser) {
          res.status(200).json({ message: 'User deleted successfully' });
      } else {
          res.status(404).json({ message: 'User not found' });
      }
  } catch (error) {
      res.status(500).json({ message: 'Error deleting user', error });
  }
});





const ForumSchema = new mongoose.Schema({
  threads: [
    {
      title: { type: String, required: true }, // Thread title
      body: { type: String, required: true }, // Thread body content
      profileUrl: String,
      author: {
        userId: { type: String, required: true }, // Author's user ID stored as a string
        username: { type: String, required: true } // Author's username
      },
      views: { type: Number, default: 0 }, // Thread view count
      replies: [
        {
          body: { type: String, required: true }, // Reply content
          author: {
            userId: { type: String, required: true }, // Reply author's user ID as a string
            username: { type: String, required: true } // Reply author's username
          },
          createdDate: { type: Date, default: Date.now }, // Reply creation date
          likes: [{ type: String }] // User IDs of those who liked the reply, stored as strings
        }
      ],
      createdDate: { type: Date, default: Date.now }, // Thread creation date
      lastUpdated: { type: Date, default: Date.now }, // Last update timestamp for the thread
      locked: { type: Boolean, default: false }, // If the thread is locked
      pinned: { type: Boolean, default: false } // If the thread is pinned
    }
  ],
  notifications: [
    {
      type: { type: String, enum: ['reply', 'like', 'follow', 'mention'], required: true }, // Notification type
      recipient: { type: String, required: true }, // Recipient's user ID as a string
      sender: { type: String, required: true }, // Sender's user ID as a string
      thread: { type: String }, // Associated thread ID as a string
      post: { type: String }, // Associated post ID as a string
      read: { type: Boolean, default: false }, // Whether the notification has been read
      createdDate: { type: Date, default: Date.now } // Date of notification creation
    }
  ]
});

const Forum = mongoose.model('Forum', ForumSchema);
app.post('/threads', async (req, res) => {
  try {
    const newThread = {
      title: req.body.title,
      body: req.body.body,
      profileUrl: req.body.profileUrl,
      author: {
        userId: req.body.author.userId,
        username: req.body.author.username
      },
      createdDate: new Date(),
      lastUpdated: new Date()
    };

    // Find the forum instance, or create a new one if it doesn't exist
    let forum = await Forum.findOne();
    if (!forum) {
      forum = new Forum({ threads: [] }); // Create a new forum if none exists
    }

    forum.threads.push(newThread);
    await forum.save();

    res.status(201).json(newThread);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Reply to a thread
app.post('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);

    const newReply = {
      body: req.body.body,
      author: {
        userId: req.body.author.userId,
        username: req.body.author.username
      },
      createdDate: new Date()
    };

    thread.replies.push(newReply);
    thread.lastUpdated = new Date(); // Update the thread's last update time
    await forum.save();

    res.status(201).json(newReply);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Like a reply
app.post('/threads/:threadId/replies/:replyId/like', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);
    const reply = thread.replies.id(req.params.replyId);

    reply.likes.push(req.body.userId); // Push userId into likes array
    await forum.save();

    res.status(200).json({ message: 'Reply liked!' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Create a notification
app.post('/notifications', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const newNotification = {
      type: req.body.type,
      recipient: req.body.recipient,
      sender: req.body.sender,
      thread: req.body.thread || null,
      post: req.body.post || null,
      read: req.body.read || false,
      createdDate: new Date()
    };

    forum.notifications.push(newNotification);
    await forum.save();

    res.status(201).json(newNotification);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Mark a notification as read
app.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    notification.read = true;
    await forum.save();

    res.status(200).json({ message: 'Notification marked as read' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get all threads
app.get('/threads', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance

    if (!forum) {
      return res.status(200).json([]); // No forum found, return an empty array
    }

    res.status(200).json(forum.threads);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Get a single thread by ID
app.get('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    res.status(200).json(thread);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get all replies in a thread
app.get('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    res.status(200).json(thread.replies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all notifications for a user
app.get('/notifications/:userId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notifications = forum.notifications.filter(
      notification => notification.recipient === req.params.userId
    );

    res.status(200).json(notifications);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Get a single notification by ID
app.get('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    res.status(200).json(notification);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a thread
app.delete('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    forum.threads.pull(req.params.threadId); // Remove thread using pull
    await forum.save(); // Save the updated forum

    res.status(200).json({ message: 'Thread deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
// Delete a reply from a thread
app.delete('/threads/:threadId/replies/:replyId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    const reply = thread.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    thread.replies.pull(req.params.replyId); // Remove reply using pull
    await forum.save();

    res.status(200).json({ message: 'Reply deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// Delete a notification
app.delete('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    notification.remove(); // Remove notification
    await forum.save();

    res.status(200).json({ message: 'Notification deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete all replies from a thread
app.delete('/threads/:threadId/replies', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    thread.replies = []; // Clear all replies
    await forum.save();

    res.status(200).json({ message: 'All replies deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete all threads in the forum
app.delete('/threads', async (req, res) => {
  try {
    const forum = await Forum.findOne(); // Assuming one forum instance
    forum.threads = []; // Clear all threads
    await forum.save();

    res.status(200).json({ message: 'All threads deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Update a thread (only by the author)
app.put('/threads/:threadId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    // Check if the user is the author of the thread
    if (thread.author.userId !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update thread fields
    thread.title = req.body.title || thread.title;
    thread.body = req.body.body || thread.body;
    thread.lastUpdated = Date.now();

    await forum.save();
    res.status(200).json({ message: 'Thread updated successfully', thread });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update a reply (only by the author)
app.put('/threads/:threadId/replies/:replyId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    const reply = thread.replies.id(req.params.replyId);
    if (!reply) return res.status(404).json({ message: 'Reply not found' });

    // Check if the user is the author of the reply
    if (reply.author.userId !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update reply fields
    reply.body = req.body.body || reply.body;
    reply.lastUpdated = Date.now();

    await forum.save();
    res.status(200).json({ message: 'Reply updated successfully', reply });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update a notification (only by the recipient)
app.put('/notifications/:notificationId', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const notification = forum.notifications.id(req.params.notificationId);

    if (!notification) return res.status(404).json({ message: 'Notification not found' });

    // Check if the user is the recipient of the notification
    if (notification.recipient !== req.body.userId) {
      return res.status(403).json({ message: 'Permission denied' });
    }

    // Update notification fields
    notification.read = req.body.read || notification.read;

    await forum.save();
    res.status(200).json({ message: 'Notification updated successfully', notification });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Increment thread views
app.put('/threads/:threadId/views', async (req, res) => {
  try {
    const forum = await Forum.findOne();
    const thread = forum.threads.id(req.params.threadId);

    if (!thread) return res.status(404).json({ message: 'Thread not found' });

    // Increment views count
    thread.views += 1;

    await forum.save();
    res.status(200).json({ message: 'Thread view count updated', views: thread.views });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



















const redListSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  profileUrl: String,
}, { timestamps: true });

const Redusers = mongoose.model('Redusers', redListSchema);

app.post('/redusers', async (req, res) => {
  try {
    const { email, profileUrl } = req.body;

    // Find and delete user from User collection
    const user = await User.findOneAndDelete({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found in the system' });
    }

    // Add user to the red list
    const newRedUser = new Redusers({ email, profileUrl });
    await newRedUser.save();


    const mailOptions = {
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: user.email,
      subject: 'Account Flagged Due to Violation',
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
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Due to violations of our terms and conditions, your account has been flagged and removed from Fantasy Madness. 
            </p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Please contact our support team if you believe this was a mistake.
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
    };

    await transporter.sendMail(mailOptions);

    res.status(201).json({ message: 'User added to the red list and notification sent', data: newRedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error adding user to the red list or sending email', error: error.message });
  }
});

// GET API - Get all users from the red list
app.get('/redusers', async (req, res) => {
  try {
    const redUsers = await Redusers.find().lean();
    res.status(200).json({ message: 'Red list users retrieved', data: redUsers });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving red list users', error: error.message });
  }
});

// DELETE API - Remove a user from the red list by email
app.delete('/redusers/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const deletedUser = await Redusers.findOneAndDelete({ email });
    if (!deletedUser) {
      return res.status(404).json({ message: 'User not found in the red list' });
    }
    res.status(200).json({ message: 'User removed from the red list', data: deletedUser });
  } catch (error) {
    res.status(500).json({ message: 'Error removing user from the red list', error: error.message });
  }
});




const siteStatsSchema = new mongoose.Schema({
  domain: { type: String, required: true },  // New: Track by domain
  totalClicks: { type: Number, default: 0 },
  allClicks: { type: Number, default: 0 },
  trackedDevices: { type: [String], default: [] },
  clicksByDate: {
    type: Map,
    of: Number,
    default: new Map(),
  },
  allClicksByDate: {
    type: Map,
    of: Number,
    default: new Map(),
  },
});

siteStatsSchema.index({ domain: 1 });
const SiteStats = mongoose.model('SiteStats', siteStatsSchema);

app.post('/track-click', async (req, res) => {
  const { deviceId, domain } = req.body;
  const targetDomain = domain || "https://fantasymmadness.com/"; // default fallback

  if (!deviceId) {
    return res.status(400).send({ message: 'Device ID is required' });
  }

  try {
    const today = new Date().toISOString().split('T')[0];

    let stats = await SiteStats.findOne({ domain: targetDomain });
    if (!stats) {
      stats = await SiteStats.create({
        domain: targetDomain,
        totalClicks: 0,
        allClicks: 0,
        trackedDevices: [],
        clicksByDate: new Map(),
        allClicksByDate: new Map(),
      });
    }

    stats.allClicks += 1;
    stats.allClicksByDate.set(today, (stats.allClicksByDate.get(today) || 0) + 1);

    let isNewDevice = false;

    if (!stats.trackedDevices.includes(deviceId)) {
      stats.totalClicks += 1;
      stats.trackedDevices.push(deviceId);
      stats.clicksByDate.set(today, (stats.clicksByDate.get(today) || 0) + 1);
      isNewDevice = true;
    }

    await stats.save();

    res.status(200).send({ 
      message: isNewDevice ? 'Click tracked (unique)' : 'Click tracked (repeat)',
      totalClicks: stats.totalClicks,
      allClicks: stats.allClicks,
      clicksByDate: Object.fromEntries(stats.clicksByDate),
      allClicksByDate: Object.fromEntries(stats.allClicksByDate),
    });

  } catch (error) {
    console.error('Error tracking click:', error);
    res.status(500).send({ message: 'Error tracking click' });
  }
});


app.get('/get-total-clicks', async (req, res) => {
  const domain = req.query.domain || "https://fantasymmadness.com/";

  try {
    const stats = await SiteStats.findOne({ domain });

    if (!stats) {
      return res.status(404).send({ message: `No stats found for domain ${domain}.` });
    }

    res.status(200).send({ stats });
  } catch (error) {
    console.error('Error fetching total clicks:', error);
    res.status(500).send({ message: 'Error fetching total clicks' });
  }
});

app.get('/get-all-time-clicks', async (req, res) => {
  
  try {
    const stats = await SiteStats.find({ }).lean();

    if (!stats) {
      return res.status(404).send({ message: `No stats found.` });
    }

    res.status(200).send({ stats });
  } catch (error) {
    console.error('Error fetching total clicks:', error);
    res.status(500).send({ message: 'Error fetching total clicks' });
  }
});
app.post('/reset-stats', async (req, res) => {
  try {
    await SiteStats.deleteMany({});
    
    res.status(200).send({ message: 'All site stats have been reset successfully.' });
  } catch (error) {
    console.error('Error resetting stats:', error);
    res.status(500).send({ message: 'Error resetting stats.' });
  }
});


app.post('/reset-unique-visitors', async (req, res) => {
  const domain = req.body.domain || "https://fantasymmadness.com/";

  try {
    const stats = await SiteStats.findOne({ domain });
    if (!stats) return res.status(404).send({ message: `No stats found for domain ${domain}.` });

    stats.totalClicks = 0;
    stats.trackedDevices = [];
    stats.clicksByDate = new Map();

    await stats.save();

    res.status(200).send({ message: `Unique visitor stats reset for domain ${domain}.` });
  } catch (error) {
    console.error('Error resetting unique visitors:', error);
    res.status(500).send({ message: 'Error resetting unique visitor stats.' });
  }
});

app.post('/reset-all-visitors', async (req, res) => {
  const domain = req.body.domain || "https://fantasymmadness.com/";

  try {
    const stats = await SiteStats.findOne({ domain });
    if (!stats) return res.status(404).send({ message: `No stats found for domain ${domain}.` });

    stats.allClicks = 0;
    stats.allClicksByDate = new Map();

    await stats.save();

    res.status(200).send({ message: `All visitor stats reset for domain ${domain}.` });
  } catch (error) {
    console.error('Error resetting all visitors:', error);
    res.status(500).send({ message: 'Error resetting all visitor stats.' });
  }
});

app.post('/assign-default-domain', async (req, res) => {
  const defaultDomain = "https://fantasymmadness.com/";

  try {
    const result = await SiteStats.updateMany(
      { domain: { $exists: false } },
      { $set: { domain: defaultDomain } }
    );

    res.status(200).send({
      message: `Domain assigned to ${result.modifiedCount} documents.`,
    });
  } catch (error) {
    console.error('Error assigning default domain:', error);
    res.status(500).send({ message: 'Failed to assign domain.' });
  }
});












const faqSchema = new mongoose.Schema({
  title: String,
  description:String,
});

faqSchema.index({ title: 1 });
const Faqs = mongoose.model('Faqs', faqSchema);


app.delete('/all/delete/faqs', async (req, res) => {
  try {
    // Delete all documents from the Faqs collection
    const result = await Faqs.deleteMany({});
    res.status(200).json({
      message: 'All FAQs deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting FAQs:', error);
    res.status(500).json({ error: 'Failed to delete FAQs from the database.' });
  }
});
app.post('/faqs', async (req, res) => {
  try {
    const faq = new Faqs(req.body);
    await faq.save();

    // Create a notification when a new FAQ is added
    const notification = new Notification({
      title: `New FAQ Added: ${faq.title}`,
    });
    await notification.save();

    res.status(201).json({ success: true, data: faq });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/faqs', async (req, res) => {
  try {
    const faqs = await Faqs.find().lean();
    res.status(200).json({ success: true, data: faqs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/faqs/:id', async (req, res) => {
  try {
    const faq = await Faqs.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });

    // Create a notification for FAQ update
    const notification = new Notification({
      title: `FAQ Updated: ${faq.title}`,
    });
    await notification.save();

    res.status(200).json({ success: true, data: faq });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.delete('/faqs/:id', async (req, res) => {
  try {
    const faq = await Faqs.findByIdAndDelete(req.params.id);
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });

    // Create a notification for FAQ deletion
    const notification = new Notification({
      title: `FAQ Deleted: ${faq.title}`,
    });
    await notification.save();

    res.status(200).json({ success: true, message: 'FAQ deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});


app.post('/faqs/bulk', async (req, res) => {
  const faqs = req.body; // Expecting an array of FAQ objects in the request body

  if (!Array.isArray(faqs) || faqs.length === 0) {
    return res.status(400).json({ error: 'Request body should be an array of FAQs.' });
  }

  try {
    // Insert the array of FAQs into the database
    const insertedFaqs = await Faqs.insertMany(faqs);
    res.status(201).json({
      message: 'FAQs added successfully.',
      data: insertedFaqs,
    });
  } catch (error) {
    console.error('Error adding FAQs:', error);
    res.status(500).json({ error: 'Failed to add FAQs to the database.' });
  }
});
















const testimonialSchema = new mongoose.Schema({
  author: String,
  description:String,
});
testimonialSchema.index({ author: 1 });

const Testimonials = mongoose.model('Testimonials', testimonialSchema);


app.delete('/all/delete/testimonials', async (req, res) => {
  try {
    // Delete all documents from the Faqs collection
    const result = await Testimonials.deleteMany({});
    res.status(200).json({
      message: 'All Testimonials deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting Testimonials:', error);
    res.status(500).json({ error: 'Failed to delete Testimonials from the database.' });
  }
});


app.post('/testimonials', async (req, res) => {
  const { userId, ...testimonialData } = req.body;

  try {
    // Create and save the new testimonial
    const testimonial = new Testimonials(testimonialData);
    await testimonial.save();

    // Update the User's hasSubmittedTestimonial status
    const user = await User.findByIdAndUpdate(
      userId,
      { hasSubmittedTestimonial: true },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(201).json({
      success: true,
      data: {
        testimonial,
        user,
      },
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.get('/testimonials', async (req, res) => {
  try {
    const testimonials = await Testimonials.find().lean();
    res.status(200).json({ success: true, data: testimonials });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/testimonials/:id', async (req, res) => {
  try {
    const testimonials = await Testimonials.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!testimonials) return res.status(404).json({ success: false, message: 'testimonials not found' });
    res.status(200).json({ success: true, data: testimonials });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

app.delete('/testimonials/:id', async (req, res) => {
  try {
    const testimonials = await Testimonials.findByIdAndDelete(req.params.id);
    if (!testimonials) return res.status(404).json({ success: false, message: 'testimonials not found' });
    res.status(200).json({ success: true, message: 'testimonials deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});



















const newsSchema = new mongoose.Schema({
  title: String,
  description: String,
  dateCreated: { type: Date, default: Date.now }, // Automatically set the creation date
});

newsSchema.index({ dateCreated: -1 });
newsSchema.index({ title: 1 });
const News = mongoose.model('News', newsSchema);


// Delete all News articles
app.delete('/all/delete/news', async (req, res) => {
  try {
    const result = await News.deleteMany({});
    res.status(200).json({
      message: 'All News articles deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting News:', error);
    res.status(500).json({ error: 'Failed to delete News articles from the database.' });
  }
});




// Add a new News article
app.post('/news', async (req, res) => {
  try {
    // Create and save the news article
    const news = new News(req.body);
    await news.save();

    const notification = new Notification({
      title: `New News Added: ${news.title}`,
    });
    await notification.save();


    // Check if notifications are enabled in the request
    if (req.body.notify === 'true' || req.body.notify === true) {
      // Fetch all users with isSubscribed set to true
      const subscribedUsers = await User.find({ isSubscribed: true });

      if (subscribedUsers.length > 0) {
        const emailPromises = subscribedUsers.map(user => {
          const unsubscribeUrl = `https://fantasymmadness-game-server-three.vercel.app/unsubscribe-user/${user._id}`;
          const mailOptions = {
            from: 'Fantasymmadness2@gmail.com',
            to: user.email,
            subject: 'Fantasy mmadness - New Update!',
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
                    <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${user.firstName} ${user.lastName},</p>
                    <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">We have some exciting news for you:</p>
                    <p style="font-size: 20px; font-family: 'Georgia', serif; font-weight: bold; color: #d20a0a; margin-top: 20px; border-bottom: 2px solid #d20a0a; padding-bottom: 5px;">
                      ${news.title}
                    </p>
                    <p style="font-size: 16px; font-family: Arial, sans-serif; line-height: 1.6; color: #555; margin-top: 10px; padding: 10px; background: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
                      ${news.description}
                    </p>
                  </td>
                </tr>
                     <!-- Footer Section with Social Icons -->
      <tr>
        <td align="center" style="padding: 20px 0;">
          <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
          <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>
                   <p>If you no longer wish to receive updates, you can <a href="${unsubscribeUrl}" style="color: #d20a0a; text-decoration: none;">unsubscribe</a>.</p>
           
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
          };

          return transporter.sendMail(mailOptions);
        });

        // Send all emails
        try {
          await Promise.all(emailPromises);
          console.log('Emails sent successfully to subscribed users.');
        } catch (error) {
          console.error('Error sending emails:', error);
        }
      }
    } else {
      console.log('Notification skipped because notify is set to false');
    }

    res.status(201).json({ success: true, message: 'News article added successfully and notifications sent (if applicable).', data: news });
  } catch (error) {
    console.error('Error creating news article:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Unsubscribe a user
app.get('/unsubscribe-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Update the user's subscription status
    const user = await User.findByIdAndUpdate(userId, { isSubscribed: false }, { new: true });

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.send(`
      <div style="text-align: center; font-family: Arial, sans-serif; margin-top: 50px;">
        <h1 style="color: #d20a0a;">Unsubscribed Successfully</h1>
        <p style="font-size: 16px; color: #333;">You will no longer receive notifications from Fantasy Madness.</p>
        <a href="https://fantasymmadness.com" style="text-decoration: none; color: #191164; font-weight: bold;">Return to Fantasy Madness</a>
      </div>
    `);
  } catch (error) {
    console.error('Error unsubscribing user:', error);
    res.status(500).json({ success: false, message: 'An error occurred while unsubscribing the user.' });
  }
});



app.get('/news', async (req, res) => {
  try {
    // Fetch from database
    const dbArticles = await News.find().sort({ createdAt: -1 }).lean();

    // Fetch from RSS feed
    const feed = await parser.parseURL('https://rss.app/feeds/_6ePdUiq5QyfSygcS.xml');
    const rssArticles = feed.items.map(item => ({
      title: item.title,
      description: item.contentSnippet || item.content || item.description,
      link: item.link,
      pubDate: item.pubDate,
      image: item.enclosure?.url || item.media?.content?.url || null,
      creator: item.creator || null,
      source: 'rss'
    }));

    // Optionally add a source flag to DB articles too
    const formattedDbArticles = dbArticles.map(article => ({
      _id: article._id,
      title: article.title,
      description: article.description,
      link: article.link,
      pubDate: article.pubDate,
      image: article.image,
      creator: article.creator,
      source: 'database'
    }));

    // Combine both
    const allArticles = [...formattedDbArticles, ...rssArticles];

    // Optional: Sort by date (descending)
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    res.status(200).json({ success: true, data: allArticles });
  } catch (error) {
    console.error('Error loading news:', error.message);
    res.status(500).json({ success: false, message: 'Failed to load news.' });
  }
});
// Update a News article by ID
app.put('/news/:id', async (req, res) => {
  try {
    const news = await News.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!news) return res.status(404).json({ success: false, message: 'News article not found' });

    const notification = new Notification({
      title: `News Updated: ${news.title}`,
    });
    await notification.save();

    res.status(200).json({ success: true, data: news });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// Delete a News article by ID
app.delete('/news/:id', async (req, res) => {
  try {
    const news = await News.findByIdAndDelete(req.params.id);
    if (!news) return res.status(404).json({ success: false, message: 'News article not found' });
    
    const notification = new Notification({
      title: `News Deleted: ${news.title}`,
    });
    await notification.save();
    res.status(200).json({ success: true, message: 'News article deleted successfully' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});




















const sponsorSchema = new mongoose.Schema({
  name: String,
  email: String,
  description: String,
  image: String,
  imageDeleteUrl: String,
  websiteLink: String,
  instaLink: String,
  dateCreated: { type: Date, default: Date.now }, // Automatically set the creation date
});

sponsorSchema.index({ email: 1 });
sponsorSchema.index({ dateCreated: -1 });
const Sponsors = mongoose.model('Sponsors', sponsorSchema);

// Get all sponsors by email
app.get('/sponsors/email/:email', async (req, res) => {
  try {
    const { email } = req.params; // Extract email from the request parameters

    // Find all sponsors with the given email
    const sponsors = await Sponsors.find({ email }).lean();

    if (sponsors.length === 0) {
      return res.status(404).json({ success: false, message: 'No sponsors found for the given email' });
    }

    res.status(200).json({ success: true, data: sponsors });
  } catch (error) {
    console.error('Error fetching sponsors by email:', error);
    res.status(500).json({ success: false, message: 'An error occurred while fetching sponsors' });
  }
});


app.delete('/all/delete/sponsors', async (req, res) => {
  try {
    const result = await Sponsors.deleteMany({});
    res.status(200).json({
      message: 'All Sponsors articles deleted successfully.',
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error deleting Sponsors:', error);
    res.status(500).json({ error: 'Failed to delete Sponsors articles from the database.' });
  }
});



// POST route to upload sponsor
app.post('/upload-sponsor', upload.single('image'), async (req, res) => {
  try {
    const { name, description, websiteLink, instaLink, email } = req.body; // Extract sponsor data

    // Check if the sponsor already exists
    const existingSponsor = await Sponsors.findOne({ email });
    if (existingSponsor) {
      return res.status(400).json({ message: 'Sponsor with this email already exists.' });
    }

    // Ensure image is provided
    if (!req.file) {
      return res.status(400).json({ error: 'Image is required' });
    }

    // Upload image to Cloudinary
    let imageUrl = '';
    let imageDeleteUrl = '';
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'sponsors' },
        (error, result) => {
          if (error) return reject(error);
          resolve(result);
        }
      ).end(req.file.buffer);
    });

    imageUrl = result.secure_url;
    imageDeleteUrl = result.public_id;

    // Save sponsor details in the database
    const newSponsor = new Sponsors({
      name,
      description,
      email,
      image: imageUrl,
      imageDeleteUrl: imageDeleteUrl,
      websiteLink,
      instaLink,
    });

    await newSponsor.save();
  
    const notification = new Notification({
      title: `New Sponsor added: ${newSponsor.name}`,
    });
    await notification.save();
  
    const emailContent = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; margin:auto;">
        <tr>
          <td align="center" style="padding: 15px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:100px;" />
            <h2 style="margin: 0; color: #191164; font-family: 'New York', Charter, Georgia, serif;">Fantasy Madness</h2>
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0;">
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">Dear ${name},</p>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              Thank you for supporting Fantasy Madness! We have successfully added the following information to our website:
            </p>
            <ul style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              <li><strong>Name:</strong> ${name}</li>
              <li><strong>Description:</strong> ${description}</li>
              <li><strong>Website Link:</strong> <a href="${websiteLink}" style="color: #191164; text-decoration: none;">${websiteLink}</a></li>
              <li><strong>Instagram Link:</strong> <a href="${instaLink}" style="color: #191164; text-decoration: none;">${instaLink}</a></li>
              <li>You can use this email:<strong>${email}</strong> to access the sponsor dashboard </li>
           
              </ul>
            <p style="font-size: 16px; font-family: Arial, sans-serif; color: #333;">
              If you have any questions or updates, feel free to contact us.
            </p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding: 20px 0;">
            <img src="https://res.cloudinary.com/daflot6fo/image/upload/v1736068036/bywcrrcqmcyczdyhjmdv.png" alt="Fantasy Madness Logo" style="width:70px;" />
            <p><a href="https://fantasymmadness.com" style="font-family: Arial, sans-serif; color: #191164; text-decoration: none;">https://fantasymmadness.com</a></p>   
            <div style="padding-top: 10px;">
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

    await transporter.sendMail({
      from: '"Fantasy Madness" <Fantasymmadness2@gmail.com>',
      to: email,
      subject: 'Welcome to Fantasy Madness!',
      html: emailContent,
    });

    res.status(200).json({ message: 'Sponsor uploaded, saved successfully, and email sent', sponsor: newSponsor });
  } catch (error) {
    console.error('Error uploading sponsor:', error);
    res.status(500).json({ error: 'An error occurred while uploading the sponsor' });
  }
});


// Get all News articles
app.get('/sponsors', async (req, res) => {
  try {
    const sponsorArticles = await Sponsors.find().lean();
    res.status(200).json({ success: true, data: sponsorArticles });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// PUT route to update a sponsor by ID
app.put('/sponsor/:id', upload.single('image'), async (req, res) => {
  try {
    const { name, description, websiteLink, instaLink, email } = req.body; // Extract sponsor data

    // Find the existing sponsor
    const sponsor = await Sponsors.findById(req.params.id);
    if (!sponsor) {
      return res.status(404).json({ success: false, message: 'Sponsor not found' });
    }

    let updatedData = { name, description, websiteLink, instaLink, email };

    // Check if a new image is uploaded
    if (req.file) {
      // Upload the new image to Cloudinary
      const result = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          { folder: 'sponsors' },
          (error, result) => {
            if (error) return reject(error);
            resolve(result);
          }
        ).end(req.file.buffer);
      });

      const newImageUrl = result.secure_url;
      const newPublicId = result.public_id;

      // Delete the old image from Cloudinary if it exists
      if (sponsor.imageDeleteUrl) {
        await cloudinary.uploader.destroy(sponsor.imageDeleteUrl);
      }

      // Add new image details to the update data
      updatedData.image = newImageUrl;
      updatedData.imageDeleteUrl = newPublicId;
    }

    // Update the sponsor in the database
    const updatedSponsor = await Sponsors.findByIdAndUpdate(req.params.id, updatedData, {
      new: true,
      runValidators: true,
    });
    
    const notification = new Notification({
      title: `Sponsor updated: ${updatedSponsor.name}`,
    });
    await notification.save();

    res.status(200).json({ success: true, data: updatedSponsor });
  } catch (error) {
    console.error('Error updating sponsor:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});
app.delete('/sponsor/:id', async (req, res) => {
  try {
    const sponsor = await Sponsors.findByIdAndDelete(req.params.id);
    if (!sponsor) return res.status(404).json({ success: false, message: 'Sponsor not found' });

    // Delete the image from Cloudinary using public_id
    if (sponsor.imageDeleteUrl) {
      try {
        await cloudinary.uploader.destroy(sponsor.imageDeleteUrl);
      } catch (err) {
        console.warn('Failed to delete image from Cloudinary:', err.message);
      }
    }

    // Save notification
    const notification = new Notification({
      title: `Sponsor deleted: ${sponsor.name}`,
    });
    await notification.save();

    res.status(200).json({ success: true, message: 'Sponsor deleted successfully' });
  } catch (error) {
    console.error('Error deleting sponsor:', error);
    res.status(400).json({ success: false, message: error.message });
  }
});


















// Blogs of fantasy mmadness
const blogSchema = new mongoose.Schema({
  metaTitle: String,
  metaDescription: String,
  header: String,
  blogHeaderImage: String,
  blogHeaderImagePublicId: String, // For deletion

  sections: [
    {
      title: String,
      content: String,
      image: String,
      imagePublicId: String, // For deletion
      headings: [
        {
          title: String,
          content: String
        }
      ]
    }
  ]
}, { timestamps: true });
blogSchema.index({ createdAt: -1 });
blogSchema.index({ metaTitle: 1 });


const Blog = mongoose.model('Blog', blogSchema);

app.post('/api/create-blog', upload.fields([
  { name: 'blogHeaderImage', maxCount: 1 },
  { name: 'sectionImages' } // multiple section images
]), async (req, res) => {
  try {
    const {
      metaTitle,
      metaDescription,
      header,
      sections // stringified JSON array
    } = req.body;

    // Parse sections safely
    let parsedSections = [];
    try {
      parsedSections = JSON.parse(sections || '[]');
    } catch (e) {
      console.error('Invalid JSON in sections:', sections);
      return res.status(400).json({ error: 'Invalid sections format.' });
    }

    console.log('Parsed Sections:', parsedSections.length);
    const sectionImages = req.files['sectionImages'] || [];
    console.log('Received sectionImages:', sectionImages.length);

    let blogHeaderImage = '';
let blogHeaderImagePublicId = ''; // ✅ Declare this at the top
if (req.files['blogHeaderImage']) {
  const result = await new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: 'blogs/header' },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    ).end(req.files['blogHeaderImage'][0].buffer);
  });
  blogHeaderImage = result.secure_url;
  blogHeaderImagePublicId = result.public_id;
}

    // Upload section images and map them to parsedSections
    for (let i = 0; i < parsedSections.length; i++) {
      if (sectionImages[i]?.buffer) {
        const imageUpload = await new Promise((resolve, reject) => {
          cloudinary.uploader.upload_stream(
            { folder: 'blogs/sections' },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            }
          ).end(sectionImages[i].buffer);
        });
        parsedSections[i].image = imageUpload.secure_url;
        parsedSections[i].imagePublicId = imageUpload.public_id;
      } else {
        console.warn(`No image found for section index ${i}`);
      }
    }

    // Check if blog exists
    let blog = await Blog.findOne({ metaTitle });

    if (blog) {
      blog.sections.push(...parsedSections);
      await blog.save();
    } else {
      blog = new Blog({
        metaTitle,
        metaDescription,
        header,
        blogHeaderImage,
        blogHeaderImagePublicId,
        sections: parsedSections
      });
      await blog.save();
    }

 const notification = new Notification({
      title: `Blog Added: ${metaTitle}`,
    });
    await notification.save();
    const swarmAutomation = await app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'blog_approved',
      vertical: 'combat',
      sourceEntity: { type: 'blog', id: String(blog._id), label: blog.metaTitle || metaTitle },
      input: {
        blogId: String(blog._id),
        blogTitle: blog.metaTitle || metaTitle,
        title: blog.header || metaTitle,
        metaDescription: blog.metaDescription,
      },
      metadata: { route: '/api/create-blog', action: 'manual-blog-created-or-updated' },
      reason: 'blog-created-or-updated-in-backend',
    }).catch((error) => ({ ok: false, warning: 'Blog was saved but blog_approved automation failed.', error: error.message }));
    res.status(201).json({ message: 'Blog created/updated successfully', blog, automation: swarmAutomation || null });

  } catch (error) {
    console.error('Error creating blog:', error.message);
    console.error(error.stack);
    res.status(500).json({ error: 'Internal server error while creating blog.' });
  }
});


app.get('/api/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find().sort({ createdAt: -1 }).lean();
    res.status(200).json(blogs);
  } catch (err) {
    console.error('Error fetching blogs:', err);
    res.status(500).json({ error: 'Internal server error while fetching blogs.' });
  }
});

app.get('/api/blogs/:id', async (req, res) => {
  try {
    const blogId = req.params.id;
    const blog = await Blog.findById(blogId).lean();

    if (!blog) {
      return res.status(404).json({ error: 'Blog not found.' });
    }

    res.status(200).json(blog);
  } catch (err) {
    console.error('Error fetching blog by ID:', err);
    res.status(500).json({ error: 'Internal server error while fetching the blog.' });
  }
});


app.delete('/api/blogs/:id', async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: 'Blog not found.' });

    if (blog.blogHeaderImagePublicId) {
      await cloudinary.uploader.destroy(blog.blogHeaderImagePublicId);
    }

    for (const section of blog.sections) {
      if (section.imagePublicId) {
        await cloudinary.uploader.destroy(section.imagePublicId);
      }
    }

 const notification = new Notification({
      title: `Blog Deleted: ${blog.metaTitle}`,
    });
    await notification.save();

    await Blog.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Blog deleted successfully.' });
  } catch (err) {
    console.error('Error deleting blog:', err);
    res.status(500).json({ error: 'Internal server error while deleting blog.' });
  }
});

app.delete('/api/delete/blogs', async (req, res) => {
  try {
    const blogs = await Blog.find();

    const deletedHeaderImages = [];
    const deletedSectionImages = [];

    for (const blog of blogs) {
      if (blog.blogHeaderImagePublicId) {
        await cloudinary.uploader.destroy(blog.blogHeaderImagePublicId);
        deletedHeaderImages.push(blog.blogHeaderImagePublicId);
      }

      for (const section of blog.sections) {
        if (section.imagePublicId) {
          await cloudinary.uploader.destroy(section.imagePublicId);
          deletedSectionImages.push(section.imagePublicId);
        }
      }
    }

    await Blog.deleteMany();

    res.status(200).json({
      message: 'All blogs and associated images deleted successfully.',
      deletedHeaderImages,
      deletedSectionImages
    });
  } catch (err) {
    console.error('Error deleting all blogs:', err);
    res.status(500).json({ error: 'Internal server error while deleting blogs.' });
  }
});




















const referralSchema = new mongoose.Schema({
  referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  referredUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  rewarded: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
referralSchema.index({ referrer: 1, createdAt: -1 });
referralSchema.index({ referredUser: 1 });

const Referral = mongoose.model('Referral', referralSchema);

app.get('/api/referrals', async (req, res) => {
  try {
    const leaderboard = await Referral.aggregate([
      {
        $group: {
          _id: "$referrer",
          referralsCount: { $sum: 1 },
          referredUserIds: { $push: "$referredUser" }
        }
      },
      {
        $sort: { referralsCount: -1 }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "referrerDetails"
        }
      },
      { $unwind: "$referrerDetails" },
      {
        $lookup: {
          from: "users",
          localField: "referredUserIds",
          foreignField: "_id",
          as: "referredUsers"
        }
      },
      {
        $project: {
          _id: 0,
          referrer: {
            _id: "$referrerDetails._id",
            firstName: "$referrerDetails.firstName",
            lastName: "$referrerDetails.lastName"
          },
          referralsCount: 1,
          referredUsers: {
            $map: {
              input: "$referredUsers",
              as: "user",
              in: {
                _id: "$$user._id",
                firstName: "$$user.firstName",
                lastName: "$$user.lastName"
              }
            }
          }
        }
      }
    ]);

    res.status(200).json(leaderboard);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

app.get('/api/referrals/:id', async (req, res) => {
  try {
    const referral = await Referral.findById(req.params.id).populate('referrer referredUser');
    if (!referral) return res.status(404).send('Referral not found');
    res.status(200).json(referral);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch referral' });
  }
});

app.delete('/api/referrals/:id', async (req, res) => {
  try {
    await Referral.findByIdAndDelete(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete referral' });
  }
});







// admin notifications
const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  read: { type: Boolean, default: false },
}, { timestamps: true });

notificationSchema.index({ read: 1, createdAt: -1 });
const Notification = mongoose.model('Notification', notificationSchema);

// GET all notifications
app.get('/api/notifications', async (req, res) => {
  try {
    const notifications = await Notification.find().sort({ createdAt: -1 }).lean();
    res.status(200).json(notifications);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching notifications' });
  }
});

// DELETE a notification by ID
app.delete('/api/notifications/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Notification.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: 'Notification not found' });
    res.status(200).json({ message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting notification' });
  }
});

// PATCH - mark notification as read (automatically sets read to true)
app.patch('/api/notifications/:id/read', async (req, res) => {
  try {
    const { id } = req.params;

    const updated = await Notification.findByIdAndUpdate(
      id,
      { read: true },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Notification not found' });
    res.status(200).json(updated);
  } catch (error) {
    res.status(500).json({ message: 'Error updating read status' });
  }
});














const messageSchema = new mongoose.Schema({
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  senderName: String,
  text: String,
  time: String, // e.g., '10:45 AM'
  date: String, // e.g., '2025-05-28'
  profileUrl: String,
}, { timestamps: true });

const Message = mongoose.model('Message', messageSchema);


// --- Pusher config ---
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true,
});
app.post('/api/messages/send', async (req, res) => {
  const {
    senderId,
    senderName,
    text,
    profileUrl,
    time = moment().format('hh:mm A'),
    date = moment().format('YYYY-MM-DD'),
  } = req.body;

  try {
    const newMessage = await Message.create({
      senderId,
      senderName,
      text,
      time,
      date,
      profileUrl
    });

    const triggerResponse = await pusher.trigger('Fantasy-mmadness', 'new-message', {
      message: newMessage,
    });

    res.status(201).json({
      message: newMessage,
      pusherTriggered: triggerResponse === null, // Pusher returns null on success
    });
  } catch (err) {
    res.status(500).json({ error: 'Message send failed', details: err.message });
  }
});

app.get('/api/messages/get', async (req, res) => {
  try {
    const messages = await Message.find({}).sort({ createdAt: 1 }).lean();

    // Group messages by 'date'
    const messagesByDate = messages.reduce((acc, msg) => {
      const date = msg.date;
      if (!acc[date]) acc[date] = [];
      acc[date].push(msg);
      return acc;
    }, {});

    res.status(200).json(messagesByDate); // <- Return grouped structure
  } catch (err) {
    res.status(500).json({ error: 'Fetch failed', details: err.message });
  }
});


app.put('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Text is required for update' });
    }

    const updatedMessage = await Message.findByIdAndUpdate(
      id,
      { text },
      { new: true }
    );

    if (!updatedMessage) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await pusher.trigger('Fantasy-mmadness', 'message-updated', {
      message: updatedMessage,
    });

    res.status(200).json({ message: 'Message updated successfully', updatedMessage });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update message', details: err.message });
  }
});

app.delete('/api/message-to-del/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deletedMessage = await Message.findByIdAndDelete(id);

    if (!deletedMessage) {
      return res.status(404).json({ error: 'Message not found' });
    }

    await pusher.trigger('Fantasy-mmadness', 'message-deleted', {
      messageId: id,
    });

    res.status(200).json({ message: 'Message deleted successfully', deletedMessage });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete message', details: err.message });
  }
});

app.delete('/api/messages/delete-all', async (req, res) => {
  try {
    await Message.deleteMany({});

    await pusher.trigger('Fantasy-mmadness', 'all-messages-deleted', {
      message: 'All messages have been deleted',
    });

    res.status(200).json({ message: 'All messages deleted successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete messages', details: err.message });
  }
});





// ============================================================================
// PRO WRESTLING GAME MODE
// Additive implementation: existing MMA/boxing routes and collections remain
// untouched. Pro Wrestling reuses the existing User, Affiliate and wallet token
// records while keeping its contest, prediction and settlement data isolated.
// ============================================================================

const {
  WRESTLING_STAT_KEYS,
  WRESTLING_WINNER_VALUES,
  DEFAULT_WRESTLING_SCORING_RULE,
  DEFAULT_WRESTLING_PAYOUT_RULE,
  normalizeWrestlingStats,
  normalizeScoringRule,
  normalizePayoutRule,
  calculateProWrestlingScore,
  rankWrestlingPredictions,
  calculatePayoutDistribution,
  canTransitionWrestlingStatus,
  isWrestlingPredictionLocked,
  validateWrestlingPredictionPayload,
} = require('./pro-wrestling-core');

const PRO_WRESTLING_GAME_MODE = 'PRO_WRESTLING';
const PRO_WRESTLING_PREDICTION_FORMAT = 'FULL_MATCH';
const PRO_WRESTLING_MATCH_STATUSES = [
  'DRAFT',
  'OPEN',
  'LOCKED',
  'LIVE',
  'SCORING',
  'FINALIZED',
  'CANCELLED',
  'NO_CONTEST',
];
const PRO_WRESTLING_ENTRY_STATUSES = [
  'JOINED',
  'PREDICTION_SUBMITTED',
  'LOCKED',
  'SETTLED',
  'REFUNDED',
];
const PRO_WRESTLING_PREDICTION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'LOCKED',
  'SCORED',
  'SETTLED',
  'REFUNDED',
];

const wrestlingActionStatsSchema = new mongoose.Schema({
  HP: { type: Number, min: 0, default: 0 },
  BP: { type: Number, min: 0, default: 0 },
  K: { type: Number, min: 0, default: 0 },
  PM: { type: Number, min: 0, default: 0 },
  FM: { type: Number, min: 0, default: 0 },
}, { _id: false });

const wrestlingCompetitorSchema = new mongoose.Schema({
  wrestlerId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestler' },
  displayName: { type: String, required: true, trim: true },
  image: String,
  promotion: String,
}, { _id: false });

const proWrestlerSchema = new mongoose.Schema({
  displayName: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  profileImage: String,
  profileImageDeleteUrl: String,
  bannerImage: String,
  bannerImageDeleteUrl: String,
  promotion: String,
  country: String,
  height: String,
  weight: String,
  wrestlingStyle: String,
  signatureMoves: [{ type: String, trim: true }],
  finishingMoves: [{ type: String, trim: true }],
  careerRecord: {
    wins: { type: Number, min: 0, default: 0 },
    losses: { type: Number, min: 0, default: 0 },
    draws: { type: Number, min: 0, default: 0 },
    noContests: { type: Number, min: 0, default: 0 },
  },
  historicalStatistics: {
    matches: { type: Number, min: 0, default: 0 },
    HP: { type: Number, min: 0, default: 0 },
    BP: { type: Number, min: 0, default: 0 },
    K: { type: Number, min: 0, default: 0 },
    PM: { type: Number, min: 0, default: 0 },
    FM: { type: Number, min: 0, default: 0 },
  },
  biography: String,
  active: { type: Boolean, default: true },
  featured: { type: Boolean, default: false },
  seo: {
    title: String,
    description: String,
    keywords: [String],
  },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });
proWrestlerSchema.index({ active: 1, displayName: 1 });
proWrestlerSchema.index({ featured: -1, displayName: 1 });

const proWrestlingScoringRuleSchema = new mongoose.Schema({
  ruleId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });

const proWrestlingPayoutRuleSchema = new mongoose.Schema({
  ruleId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  name: { type: String, required: true },
  active: { type: Boolean, default: true },
  config: { type: mongoose.Schema.Types.Mixed, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });

const proWrestlingMatchSchema = new mongoose.Schema({
  gameMode: { type: String, enum: [PRO_WRESTLING_GAME_MODE], default: PRO_WRESTLING_GAME_MODE, index: true },
  predictionFormat: { type: String, enum: [PRO_WRESTLING_PREDICTION_FORMAT], default: PRO_WRESTLING_PREDICTION_FORMAT },
  scoringRuleVersion: { type: String, default: DEFAULT_WRESTLING_SCORING_RULE.ruleId },
  payoutRuleVersion: { type: String, default: DEFAULT_WRESTLING_PAYOUT_RULE.ruleId },
  scoringRules: { type: mongoose.Schema.Types.Mixed, required: true },
  payoutRules: { type: mongoose.Schema.Types.Mixed, required: true },
  eventName: { type: String, required: true, trim: true },
  promotionName: { type: String, trim: true },
  matchTitle: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  matchFormat: {
    type: String,
    enum: ['SINGLES', 'TAG_TEAM', 'TRIPLE_THREAT', 'FATAL_FOUR_WAY'],
    default: 'SINGLES',
  },
  competitorA: { type: wrestlingCompetitorSchema, required: true },
  competitorB: { type: wrestlingCompetitorSchema, required: true },
  matchDate: { type: Date, required: true, index: true },
  matchTime: String,
  lockAt: { type: Date, required: true, index: true },
  entryFeeTokens: { type: Number, min: 0, default: 0 },
  basePot: { type: Number, min: 0, default: 0 },
  currentPot: { type: Number, min: 0, default: 0 },
  minimumParticipants: { type: Number, min: 0, default: 0 },
  maximumParticipants: { type: Number, min: 0, default: 0 },
  participantCount: { type: Number, min: 0, default: 0 },
  autoCancelIfMinimumNotMet: { type: Boolean, default: true },
  status: { type: String, enum: PRO_WRESTLING_MATCH_STATUSES, default: 'DRAFT', index: true },
  officialStats: {
    competitorA: { type: wrestlingActionStatsSchema, default: () => ({}) },
    competitorB: { type: wrestlingActionStatsSchema, default: () => ({}) },
  },
  officialWinner: { type: String, enum: [...WRESTLING_WINNER_VALUES, 'NO_CONTEST', null], default: null },
  finishType: {
    type: String,
    enum: ['PINFALL', 'SUBMISSION', 'DQ', 'COUNT_OUT', 'DRAW', 'NO_CONTEST', 'OTHER', null],
    default: null,
  },
  statsVersion: { type: Number, min: 0, default: 0 },
  description: String,
  bannerImage: String,
  bannerImageDeleteUrl: String,
  featured: { type: Boolean, default: false },
  publicVisible: { type: Boolean, default: true },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
  affiliateCommissionPercentage: { type: Number, min: 0, max: 100, default: 0 },
  referralCode: String,
  seo: {
    title: String,
    description: String,
    keywords: [String],
  },
  settlement: {
    status: {
      type: String,
      enum: ['NOT_STARTED', 'PROCESSING', 'PAID', 'REFUNDED'],
      default: 'NOT_STARTED',
    },
    winnerCount: { type: Number, min: 0, default: 0 },
    grossPot: { type: Number, min: 0, default: 0 },
    platformFeeTokens: { type: Number, min: 0, default: 0 },
    affiliateCommissionTokens: { type: Number, min: 0, default: 0 },
    playerPayoutTokens: { type: Number, min: 0, default: 0 },
    completedAt: Date,
  },
  publishedAt: Date,
  lockedAt: Date,
  liveStartedAt: Date,
  scoringStartedAt: Date,
  finalizedAt: Date,
  cancelledAt: Date,
  cancellationReason: String,
  startingSoonNotificationSent: { type: Boolean, default: false },
  liveNotificationSent: { type: Boolean, default: false },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
}, { timestamps: true });
proWrestlingMatchSchema.index({ status: 1, matchDate: 1 });
proWrestlingMatchSchema.index({ publicVisible: 1, featured: -1, matchDate: 1 });
proWrestlingMatchSchema.index({ affiliateId: 1, status: 1 });

const proWrestlingEntrySchema = new mongoose.Schema({
  gameMode: { type: String, default: PRO_WRESTLING_GAME_MODE },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestlingMatch', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
  referralCode: String,
  entryFeeTokens: { type: Number, min: 0, required: true },
  status: { type: String, enum: PRO_WRESTLING_ENTRY_STATUSES, default: 'JOINED' },
  idempotencyKey: { type: String, required: true, unique: true },
  userSnapshot: {
    displayName: String,
    profileUrl: String,
  },
  joinedAt: { type: Date, default: Date.now },
  lockedAt: Date,
  settledAt: Date,
  refundedAt: Date,
  rank: { type: Number, min: 1 },
  payoutAmount: { type: Number, min: 0, default: 0 },
}, { timestamps: true });
proWrestlingEntrySchema.index({ matchId: 1, userId: 1 }, { unique: true });
proWrestlingEntrySchema.index({ userId: 1, createdAt: -1 });

const proWrestlingPredictionSchema = new mongoose.Schema({
  gameMode: { type: String, default: PRO_WRESTLING_GAME_MODE },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestlingMatch', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  competitorA: { type: wrestlingActionStatsSchema, required: true },
  competitorB: { type: wrestlingActionStatsSchema, required: true },
  winnerPrediction: { type: String, enum: WRESTLING_WINNER_VALUES, required: true },
  predictionStatus: { type: String, enum: PRO_WRESTLING_PREDICTION_STATUSES, default: 'DRAFT' },
  submittedAt: Date,
  lockedAt: Date,
  score: { type: Number, default: 0 },
  scoreBreakdown: { type: mongoose.Schema.Types.Mixed },
  normalizedError: { type: Number, default: 0 },
  exactPredictionCount: { type: Number, default: 0 },
  finisherError: { type: Number, default: 0 },
  rank: { type: Number, min: 1 },
  previousRank: { type: Number, min: 1 },
  payoutAmount: { type: Number, min: 0, default: 0 },
  scoringRuleVersion: String,
}, { timestamps: true });
proWrestlingPredictionSchema.index({ matchId: 1, userId: 1 }, { unique: true });
proWrestlingPredictionSchema.index({ matchId: 1, rank: 1 });
proWrestlingPredictionSchema.index({ userId: 1, createdAt: -1 });

const proWrestlingWalletLedgerSchema = new mongoose.Schema({
  accountType: { type: String, enum: ['USER', 'AFFILIATE', 'PLATFORM'], default: 'USER' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  affiliateId: { type: mongoose.Schema.Types.ObjectId, ref: 'Affiliate' },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestlingMatch', index: true },
  entryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestlingEntry' },
  type: {
    type: String,
    enum: ['WRESTLING_ENTRY', 'WRESTLING_WINNING', 'WRESTLING_REFUND', 'WRESTLING_AFFILIATE_COMMISSION', 'WRESTLING_PLATFORM_FEE', 'WRESTLING_ADMIN_ADJUSTMENT'],
    required: true,
  },
  amount: { type: Number, required: true },
  balanceBefore: Number,
  balanceAfter: Number,
  idempotencyKey: { type: String, required: true, unique: true },
  status: { type: String, enum: ['COMPLETED', 'FAILED'], default: 'COMPLETED' },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
proWrestlingWalletLedgerSchema.index({ userId: 1, createdAt: -1 });
proWrestlingWalletLedgerSchema.index({ affiliateId: 1, createdAt: -1 });

const proWrestlingAuditLogSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
  action: { type: String, required: true, index: true },
  entityType: { type: String, required: true, index: true },
  entityId: { type: String, required: true, index: true },
  before: { type: mongoose.Schema.Types.Mixed },
  after: { type: mongoose.Schema.Types.Mixed },
  reason: String,
  ipAddress: String,
}, { timestamps: true });
proWrestlingAuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const proWrestlingNotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProWrestlingMatch', index: true },
  gameMode: { type: String, default: PRO_WRESTLING_GAME_MODE },
  type: {
    type: String,
    enum: ['CONTEST_PUBLISHED', 'STARTING_SOON', 'ENTRY_CONFIRMED', 'PREDICTION_SUBMITTED', 'PREDICTION_LOCKED', 'MATCH_LIVE', 'RANK_CHANGED', 'RESULT_FINALIZED', 'WINNINGS_CREDITED', 'ENTRY_REFUNDED'],
    required: true,
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  read: { type: Boolean, default: false },
  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });
proWrestlingNotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

const ProWrestler = mongoose.models.ProWrestler || mongoose.model('ProWrestler', proWrestlerSchema);
const ProWrestlingScoringRule = mongoose.models.ProWrestlingScoringRule || mongoose.model('ProWrestlingScoringRule', proWrestlingScoringRuleSchema);
const ProWrestlingPayoutRule = mongoose.models.ProWrestlingPayoutRule || mongoose.model('ProWrestlingPayoutRule', proWrestlingPayoutRuleSchema);
const ProWrestlingMatch = mongoose.models.ProWrestlingMatch || mongoose.model('ProWrestlingMatch', proWrestlingMatchSchema);
const ProWrestlingEntry = mongoose.models.ProWrestlingEntry || mongoose.model('ProWrestlingEntry', proWrestlingEntrySchema);
const ProWrestlingPrediction = mongoose.models.ProWrestlingPrediction || mongoose.model('ProWrestlingPrediction', proWrestlingPredictionSchema);
const ProWrestlingWalletLedger = mongoose.models.ProWrestlingWalletLedger || mongoose.model('ProWrestlingWalletLedger', proWrestlingWalletLedgerSchema);
const ProWrestlingAuditLog = mongoose.models.ProWrestlingAuditLog || mongoose.model('ProWrestlingAuditLog', proWrestlingAuditLogSchema);
const ProWrestlingNotification = mongoose.models.ProWrestlingNotification || mongoose.model('ProWrestlingNotification', proWrestlingNotificationSchema);

const wrestlingHttpError = (status, message, code, details) => {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
};

const isProWrestlingEnabled = () => String(process.env.PRO_WRESTLING_ENABLED || 'true').toLowerCase() !== 'false';

const requireProWrestlingEnabled = (req, res, next) => {
  if (!isProWrestlingEnabled()) {
    return res.status(503).json({
      message: 'Pro Wrestling game mode is currently disabled.',
      code: 'PRO_WRESTLING_DISABLED',
    });
  }
  return next();
};

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

const verifyWrestlingCronOrAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (process.env.CRON_SECRET && bearer === process.env.CRON_SECRET) {
    req.admin = { id: null, cron: true };
    return next();
  }
  return verifyAdminToken(req, res, next);
};

const wrestlingRequestIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

const wrestlingPlainObject = (value) => {
  if (!value) return value;
  if (typeof value.toObject === 'function') return value.toObject({ depopulate: true });
  return JSON.parse(JSON.stringify(value));
};

const wrestlingSlugify = (value) => String(value || '')
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 100);

const wrestlingArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
};

const wrestlingObject = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (error) {
      return fallback;
    }
  }
  return fallback;
};

const wrestlingBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
};

const wrestlingNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const wrestlingTokenBalance = (value) => {
  const parsed = Number.parseInt(String(value || '0'), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
};

const applyWrestlingSession = (query, session) => (session ? query.session(session) : query);

const uploadWrestlingImage = (file, folder) => {
  if (!file || !file.buffer) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error) return reject(error);
        return resolve({ url: result.secure_url, deleteUrl: result.public_id });
      },
    );
    stream.end(file.buffer);
  });
};

const safeWrestlingTrigger = async (eventName, payload) => {
  try {
    if (typeof pusher !== 'undefined' && pusher) {
      await pusher.trigger('Fantasy-mmadness-wrestling', eventName, payload);
    }
  } catch (error) {
    console.error('Pro Wrestling Pusher event failed:', error.message);
  }
};

const writeWrestlingAudit = async ({ req, adminId, action, entityType, entityId, before, after, reason, session }) => {
  const values = [{
    adminId: adminId || req?.admin?.id || null,
    action,
    entityType,
    entityId: String(entityId),
    before: wrestlingPlainObject(before),
    after: wrestlingPlainObject(after),
    reason: reason || null,
    ipAddress: req ? wrestlingRequestIp(req) : null,
  }];
  return ProWrestlingAuditLog.create(values, session ? { session } : undefined);
};

const handleWrestlingError = (res, error) => {
  console.error('Pro Wrestling API error:', error);
  if (error && error.code === 11000) {
    return res.status(409).json({ message: 'A record with the same unique identity already exists.', code: 'DUPLICATE_RECORD' });
  }
  return res.status(error.status || 500).json({
    message: error.message || 'Pro Wrestling request failed.',
    code: error.code || 'PRO_WRESTLING_ERROR',
    details: error.details,
  });
};

const runWrestlingTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } catch (error) {
      const unsupported = /Transaction numbers are only allowed|replica set|transactions are not supported/i.test(String(error.message || ''));
      if (unsupported && String(process.env.PRO_WRESTLING_ALLOW_NON_TRANSACTIONAL || '').toLowerCase() === 'true') {
        console.warn('Running Pro Wrestling wallet operation without a MongoDB transaction because PRO_WRESTLING_ALLOW_NON_TRANSACTIONAL=true.');
        return work(null);
      }
      throw error;
    }
  } finally {
    await session.endSession();
  }
};

const ensureWrestlingDefaultRules = async () => {
  const scoring = normalizeScoringRule(DEFAULT_WRESTLING_SCORING_RULE);
  const payout = normalizePayoutRule(DEFAULT_WRESTLING_PAYOUT_RULE);
  await Promise.all([
    ProWrestlingScoringRule.findOneAndUpdate(
      { ruleId: scoring.ruleId },
      { $setOnInsert: { ruleId: scoring.ruleId, name: scoring.name, active: true, config: scoring } },
      { upsert: true, new: true },
    ),
    ProWrestlingPayoutRule.findOneAndUpdate(
      { ruleId: payout.ruleId },
      { $setOnInsert: { ruleId: payout.ruleId, name: payout.name, active: true, config: payout } },
      { upsert: true, new: true },
    ),
  ]);
};

mongoose.connection.once('open', () => {
  ensureWrestlingDefaultRules().catch((error) => console.error('Unable to seed Pro Wrestling rules:', error.message));
});

const getWrestlingScoringRule = async (ruleId) => {
  const requestedRuleId = ruleId ? String(ruleId).toUpperCase() : null;
  const normalizedRuleId = requestedRuleId || DEFAULT_WRESTLING_SCORING_RULE.ruleId;
  const record = await ProWrestlingScoringRule.findOne({ ruleId: normalizedRuleId, active: true }).lean();
  if (!record && requestedRuleId) {
    throw wrestlingHttpError(404, `Active wrestling scoring rule ${requestedRuleId} was not found.`, 'SCORING_RULE_NOT_FOUND');
  }
  return normalizeScoringRule(record?.config || DEFAULT_WRESTLING_SCORING_RULE);
};

const getWrestlingPayoutRule = async (ruleId) => {
  const requestedRuleId = ruleId ? String(ruleId).toUpperCase() : null;
  const normalizedRuleId = requestedRuleId || DEFAULT_WRESTLING_PAYOUT_RULE.ruleId;
  const record = await ProWrestlingPayoutRule.findOne({ ruleId: normalizedRuleId, active: true }).lean();
  if (!record && requestedRuleId) {
    throw wrestlingHttpError(404, `Active wrestling payout rule ${requestedRuleId} was not found.`, 'PAYOUT_RULE_NOT_FOUND');
  }
  return normalizePayoutRule(record?.config || DEFAULT_WRESTLING_PAYOUT_RULE);
};

const uniqueWrestlingSlug = async (Model, candidate, existingId) => {
  const base = wrestlingSlugify(candidate) || `wrestling-${Date.now()}`;
  let slug = base;
  let suffix = 1;
  while (await Model.exists({ slug, ...(existingId ? { _id: { $ne: existingId } } : {}) })) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
};

const resolveWrestlingCompetitor = async (input, wrestlerId) => {
  const source = wrestlingObject(input, {});
  const id = wrestlerId || source.wrestlerId || source.id;
  let wrestler = null;
  if (id && mongoose.isValidObjectId(id)) wrestler = await ProWrestler.findById(id).lean();
  const displayName = String(source.displayName || source.name || wrestler?.displayName || '').trim();
  if (!displayName) throw wrestlingHttpError(400, 'Both wrestling competitors require a display name.', 'COMPETITOR_NAME_REQUIRED');
  return {
    wrestlerId: wrestler?._id || (mongoose.isValidObjectId(id) ? id : undefined),
    displayName,
    image: source.image || source.profileImage || wrestler?.profileImage || '',
    promotion: source.promotion || wrestler?.promotion || '',
  };
};

const publicWrestlingMatch = (match, options = {}) => {
  const document = wrestlingPlainObject(match);
  const revealStats = options.revealStats || ['LIVE', 'SCORING', 'FINALIZED'].includes(document.status);
  if (!revealStats) {
    delete document.officialStats;
    delete document.officialWinner;
    delete document.finishType;
  }
  delete document.createdBy;
  delete document.updatedBy;
  if (!options.includeRules) {
    delete document.scoringRules;
    delete document.payoutRules;
  }
  return document;
};

const createWrestlingNotification = async ({ userId, matchId, type, title, message, metadata, session }) => {
  if (!userId) return null;
  const documents = [{ userId, matchId, type, title, message, metadata }];
  return ProWrestlingNotification.create(documents, session ? { session } : undefined);
};

const notifyWrestlingEntrants = async ({ match, type, title, message, metadata, session }) => {
  const query = ProWrestlingEntry.find({ matchId: match._id }).select('userId');
  const entries = await applyWrestlingSession(query, session).lean();
  if (!entries.length) return 0;
  const documents = entries.map((entry) => ({
    userId: entry.userId,
    matchId: match._id,
    type,
    title,
    message,
    metadata,
  }));
  await ProWrestlingNotification.insertMany(documents, session ? { session } : undefined);
  return documents.length;
};

const lockWrestlingMatch = async (match, session) => {
  if (!match || match.status !== 'OPEN') return match;
  match.status = 'LOCKED';
  match.lockedAt = new Date();
  await match.save(session ? { session } : undefined);
  await Promise.all([
    ProWrestlingEntry.updateMany(
      { matchId: match._id, status: { $in: ['JOINED', 'PREDICTION_SUBMITTED'] } },
      { $set: { status: 'LOCKED', lockedAt: match.lockedAt } },
      session ? { session } : undefined,
    ),
    ProWrestlingPrediction.updateMany(
      { matchId: match._id, predictionStatus: 'SUBMITTED' },
      { $set: { predictionStatus: 'LOCKED', lockedAt: match.lockedAt } },
      session ? { session } : undefined,
    ),
  ]);
  await notifyWrestlingEntrants({
    match,
    type: 'PREDICTION_LOCKED',
    title: 'Wrestling predictions locked',
    message: `${match.matchTitle} is now locked. Your submitted predictions are final.`,
    session,
  });
  return match;
};

const autoLockWrestlingMatches = async () => {
  const now = new Date();
  const dueMatches = await ProWrestlingMatch.find({ status: 'OPEN', lockAt: { $lte: now } }).limit(100);
  let locked = 0;
  for (const match of dueMatches) {
    if (match.minimumParticipants > match.participantCount && match.autoCancelIfMinimumNotMet) continue;
    await runWrestlingTransaction(async (session) => {
      const fresh = await applyWrestlingSession(ProWrestlingMatch.findById(match._id), session);
      if (fresh?.status === 'OPEN') {
        await lockWrestlingMatch(fresh, session);
        locked += 1;
      }
    });
  }
  return locked;
};

const adjustWrestlingUserTokens = async ({ userId, delta, session }) => {
  const user = await applyWrestlingSession(User.findById(userId), session);
  if (!user) throw wrestlingHttpError(404, 'User not found.', 'USER_NOT_FOUND');
  const balanceBefore = wrestlingTokenBalance(user.tokens);
  const balanceAfter = balanceBefore + Number(delta);
  if (balanceAfter < 0) throw wrestlingHttpError(400, 'Insufficient fight-wallet tokens.', 'INSUFFICIENT_TOKENS', { balance: balanceBefore });
  user.tokens = String(balanceAfter);
  await user.save(session ? { session } : undefined);
  return { user, balanceBefore, balanceAfter };
};

const adjustWrestlingAffiliateTokens = async ({ affiliateId, delta, session }) => {
  const affiliate = await applyWrestlingSession(Affiliate.findById(affiliateId), session);
  if (!affiliate) throw wrestlingHttpError(404, 'Affiliate not found.', 'AFFILIATE_NOT_FOUND');
  const balanceBefore = wrestlingTokenBalance(affiliate.tokens);
  const balanceAfter = balanceBefore + Number(delta);
  if (balanceAfter < 0) throw wrestlingHttpError(400, 'Affiliate token adjustment would produce a negative balance.', 'INVALID_AFFILIATE_BALANCE');
  affiliate.tokens = String(balanceAfter);
  await affiliate.save(session ? { session } : undefined);
  return { affiliate, balanceBefore, balanceAfter };
};

const recalculateWrestlingScores = async (match, session) => {
  const predictionQuery = ProWrestlingPrediction.find({
    matchId: match._id,
    predictionStatus: { $in: ['SUBMITTED', 'LOCKED', 'SCORED', 'SETTLED'] },
  });
  const predictions = await applyWrestlingSession(predictionQuery, session).lean();
  const actualResult = {
    competitorA: normalizeWrestlingStats(match.officialStats?.competitorA),
    competitorB: normalizeWrestlingStats(match.officialStats?.competitorB),
    officialWinner: match.officialWinner,
  };

  const calculated = predictions.map((prediction) => {
    const breakdown = calculateProWrestlingScore(prediction, actualResult, match.scoringRules);
    return {
      id: String(prediction._id),
      predictionId: prediction._id,
      userId: prediction.userId,
      submittedAt: prediction.submittedAt || prediction.createdAt,
      previousRank: prediction.rank,
      totalScore: breakdown.totalScore,
      normalizedError: breakdown.normalizedError,
      exactPredictionCount: breakdown.exactPredictionCount,
      finisherError: breakdown.finisherError,
      breakdown,
    };
  });
  const ranked = rankWrestlingPredictions(calculated);

  if (ranked.length) {
    const predictionOperations = ranked.map((row) => ({
      updateOne: {
        filter: { _id: row.predictionId },
        update: {
          $set: {
            previousRank: row.previousRank || row.rank,
            rank: row.rank,
            score: row.totalScore,
            normalizedError: row.normalizedError,
            exactPredictionCount: row.exactPredictionCount,
            finisherError: row.finisherError,
            scoreBreakdown: row.breakdown,
            scoringRuleVersion: match.scoringRuleVersion,
            predictionStatus: match.status === 'FINALIZED' ? 'SETTLED' : 'SCORED',
          },
        },
      },
    }));
    const entryOperations = ranked.map((row) => ({
      updateOne: {
        filter: { matchId: match._id, userId: row.userId, status: { $ne: 'REFUNDED' } },
        update: { $set: { rank: row.rank } },
      },
    }));

    await Promise.all([
      ProWrestlingPrediction.bulkWrite(predictionOperations, session ? { session } : undefined),
      ProWrestlingEntry.bulkWrite(entryOperations, session ? { session } : undefined),
    ]);

    const rankChanges = ranked.filter((row) => row.previousRank && row.previousRank !== row.rank);
    if (rankChanges.length) {
      const notifications = rankChanges.map((row) => ({
        userId: row.userId,
        matchId: match._id,
        type: 'RANK_CHANGED',
        title: 'Your Pro Wrestling rank changed',
        message: `You moved from #${row.previousRank} to #${row.rank} in ${match.matchTitle}.`,
        metadata: { previousRank: row.previousRank, rank: row.rank, score: row.totalScore },
      }));
      await ProWrestlingNotification.insertMany(notifications, session ? { session } : undefined);
    }
  }

  return ranked;
};

const refundWrestlingMatch = async ({ matchId, status, reason, req, adminId }) => runWrestlingTransaction(async (session) => {
  const match = await applyWrestlingSession(ProWrestlingMatch.findById(matchId), session);
  if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
  if (match.status === 'FINALIZED') throw wrestlingHttpError(409, 'A finalized contest cannot be refunded.', 'MATCH_ALREADY_FINALIZED');
  if (match.settlement?.status === 'REFUNDED') return match;

  const before = wrestlingPlainObject(match);
  const entries = await applyWrestlingSession(ProWrestlingEntry.find({ matchId: match._id, status: { $ne: 'REFUNDED' } }), session);
  for (const entry of entries) {
    const idempotencyKey = `wrestling:refund:${match._id}:${entry.userId}`;
    const existingLedger = await applyWrestlingSession(ProWrestlingWalletLedger.findOne({ idempotencyKey }), session).lean();
    if (!existingLedger && entry.entryFeeTokens > 0) {
      const balance = await adjustWrestlingUserTokens({ userId: entry.userId, delta: entry.entryFeeTokens, session });
      await ProWrestlingWalletLedger.create([{
        accountType: 'USER',
        userId: entry.userId,
        matchId: match._id,
        entryId: entry._id,
        type: 'WRESTLING_REFUND',
        amount: entry.entryFeeTokens,
        balanceBefore: balance.balanceBefore,
        balanceAfter: balance.balanceAfter,
        idempotencyKey,
        metadata: { reason },
      }], session ? { session } : undefined);
    }
    entry.status = 'REFUNDED';
    entry.refundedAt = new Date();
    entry.payoutAmount = 0;
    entry.rank = undefined;
    await entry.save(session ? { session } : undefined);
    await createWrestlingNotification({
      userId: entry.userId,
      matchId: match._id,
      type: 'ENTRY_REFUNDED',
      title: 'Wrestling contest entry refunded',
      message: `${entry.entryFeeTokens} token${entry.entryFeeTokens === 1 ? '' : 's'} were returned for ${match.matchTitle}.`,
      metadata: { reason },
      session,
    });
  }

  await ProWrestlingPrediction.updateMany(
    { matchId: match._id },
    { $set: { predictionStatus: 'REFUNDED', payoutAmount: 0 }, $unset: { rank: '', previousRank: '' } },
    session ? { session } : undefined,
  );

  match.status = status;
  match.cancelledAt = new Date();
  match.cancellationReason = reason;
  match.settlement = {
    ...(wrestlingPlainObject(match.settlement) || {}),
    status: 'REFUNDED',
    winnerCount: 0,
    grossPot: match.currentPot,
    platformFeeTokens: 0,
    affiliateCommissionTokens: 0,
    playerPayoutTokens: 0,
    completedAt: new Date(),
  };
  await match.save(session ? { session } : undefined);
  await writeWrestlingAudit({
    req,
    adminId,
    action: status === 'NO_CONTEST' ? 'WRESTLING_MATCH_NO_CONTEST_REFUND' : 'WRESTLING_MATCH_CANCEL_REFUND',
    entityType: 'ProWrestlingMatch',
    entityId: match._id,
    before,
    after: match,
    reason,
    session,
  });
  await safeWrestlingTrigger('match-refunded', { matchId: String(match._id), status, reason });
  return match;
});

// --------------------------------------------------------------------------
// Public Pro Wrestling discovery endpoints
// --------------------------------------------------------------------------

app.get('/api/wrestling/health', requireProWrestlingEnabled, async (req, res) => {
  try {
    await ensureWrestlingDefaultRules();
    res.status(200).json({
      enabled: true,
      gameMode: PRO_WRESTLING_GAME_MODE,
      predictionFormat: PRO_WRESTLING_PREDICTION_FORMAT,
      statCategories: WRESTLING_STAT_KEYS,
      statuses: PRO_WRESTLING_MATCH_STATUSES,
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/wrestling/config', requireProWrestlingEnabled, async (req, res) => {
  try {
    const [scoringRules, payoutRules] = await Promise.all([
      ProWrestlingScoringRule.find({ active: true }).sort({ createdAt: 1 }).lean(),
      ProWrestlingPayoutRule.find({ active: true }).sort({ createdAt: 1 }).lean(),
    ]);
    res.json({
      gameMode: PRO_WRESTLING_GAME_MODE,
      predictionFormat: PRO_WRESTLING_PREDICTION_FORMAT,
      categories: normalizeScoringRule(scoringRules[0]?.config || DEFAULT_WRESTLING_SCORING_RULE).categories,
      scoringRules: scoringRules.map((rule) => ({ ruleId: rule.ruleId, name: rule.name })),
      payoutRules: payoutRules.map((rule) => ({ ruleId: rule.ruleId, name: rule.name })),
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

const listWrestlingMatches = async (req, res) => {
  try {
    await autoLockWrestlingMatches();
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '20', 10)));
    const query = { publicVisible: true };
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').map((value) => value.trim().toUpperCase()).filter((value) => PRO_WRESTLING_MATCH_STATUSES.includes(value));
      if (statuses.length) query.status = { $in: statuses };
    } else {
      query.status = { $ne: 'DRAFT' };
    }
    if (req.query.featured !== undefined) query.featured = wrestlingBoolean(req.query.featured);
    if (req.query.affiliateId && mongoose.isValidObjectId(req.query.affiliateId)) query.affiliateId = req.query.affiliateId;
    if (req.query.upcoming === 'true') query.matchDate = { $gte: new Date() };
    if (req.query.search) {
      const search = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { eventName: { $regex: search, $options: 'i' } },
        { matchTitle: { $regex: search, $options: 'i' } },
        { 'competitorA.displayName': { $regex: search, $options: 'i' } },
        { 'competitorB.displayName': { $regex: search, $options: 'i' } },
      ];
    }

    const [matches, total] = await Promise.all([
      ProWrestlingMatch.find(query)
        .sort({ featured: -1, matchDate: 1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      ProWrestlingMatch.countDocuments(query),
    ]);
    res.json({
      data: matches.map((match) => publicWrestlingMatch(match)),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
};
app.get('/api/wrestling/matches', requireProWrestlingEnabled, listWrestlingMatches);
app.get('/api/wrestling/contests', requireProWrestlingEnabled, listWrestlingMatches);

const getWrestlingMatch = async (req, res) => {
  try {
    await autoLockWrestlingMatches();
    const identifier = req.params.matchId || req.params.contestId;
    const query = mongoose.isValidObjectId(identifier) ? { _id: identifier } : { slug: identifier };
    const match = await ProWrestlingMatch.findOne({ ...query, publicVisible: true }).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    res.json(publicWrestlingMatch(match, { includeRules: true }));
  } catch (error) {
    handleWrestlingError(res, error);
  }
};
app.get('/api/wrestling/matches/:matchId', requireProWrestlingEnabled, getWrestlingMatch);
app.get('/api/wrestling/contests/:contestId', requireProWrestlingEnabled, getWrestlingMatch);

app.get('/api/wrestling/wrestlers', requireProWrestlingEnabled, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '24', 10)));
    const query = { active: true };
    if (req.query.featured !== undefined) query.featured = wrestlingBoolean(req.query.featured);
    if (req.query.search) {
      const search = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { displayName: { $regex: search, $options: 'i' } },
        { promotion: { $regex: search, $options: 'i' } },
        { wrestlingStyle: { $regex: search, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      ProWrestler.find(query).sort({ featured: -1, displayName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestler.countDocuments(query),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/wrestling/wrestlers/:idOrSlug', requireProWrestlingEnabled, async (req, res) => {
  try {
    const identifier = req.params.idOrSlug;
    const query = mongoose.isValidObjectId(identifier) ? { _id: identifier } : { slug: identifier };
    const wrestler = await ProWrestler.findOne(query).lean();
    if (!wrestler) throw wrestlingHttpError(404, 'Wrestler not found.', 'WRESTLER_NOT_FOUND');
    const recentMatches = await ProWrestlingMatch.find({
      $or: [{ 'competitorA.wrestlerId': wrestler._id }, { 'competitorB.wrestlerId': wrestler._id }],
      publicVisible: true,
      status: { $ne: 'DRAFT' },
    }).sort({ matchDate: -1 }).limit(10).lean();
    res.json({ wrestler, recentMatches: recentMatches.map((match) => publicWrestlingMatch(match)) });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

// --------------------------------------------------------------------------
// Player entry, prediction, live scoring, results and history
// --------------------------------------------------------------------------

const joinWrestlingMatch = async (req, res) => {
  try {
    const matchId = req.params.matchId || req.params.contestId;
    if (!mongoose.isValidObjectId(matchId)) throw wrestlingHttpError(400, 'Invalid wrestling match ID.', 'INVALID_MATCH_ID');
    const userId = req.user.id;
    const deterministicKey = `wrestling:join:${matchId}:${userId}`;
    const requestedKey = String(req.headers['idempotency-key'] || req.body?.idempotencyKey || deterministicKey).slice(0, 180);

    const existing = await ProWrestlingEntry.findOne({ matchId, userId }).lean();
    if (existing) return res.status(200).json({ entry: existing, idempotent: true });

    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(matchId), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (match.status !== 'OPEN' || isWrestlingPredictionLocked(match)) {
        throw wrestlingHttpError(409, 'This wrestling contest is not open for entry.', 'CONTEST_NOT_OPEN');
      }
      if (match.maximumParticipants > 0 && match.participantCount >= match.maximumParticipants) {
        throw wrestlingHttpError(409, 'This wrestling contest has reached its participant limit.', 'CONTEST_FULL');
      }

      const duplicate = await applyWrestlingSession(ProWrestlingEntry.findOne({ matchId, userId }), session).lean();
      if (duplicate) return { entry: duplicate, idempotent: true };

      const balance = await adjustWrestlingUserTokens({ userId, delta: -match.entryFeeTokens, session });
      const affiliateId = match.affiliateId || (mongoose.isValidObjectId(req.body?.affiliateId) ? req.body.affiliateId : null);
      const entryDocuments = await ProWrestlingEntry.create([{
        matchId: match._id,
        userId,
        affiliateId,
        referralCode: req.body?.referralCode || match.referralCode || null,
        entryFeeTokens: match.entryFeeTokens,
        status: 'JOINED',
        idempotencyKey: requestedKey,
        userSnapshot: {
          displayName: balance.user.playerName || `${balance.user.firstName || ''} ${balance.user.lastName || ''}`.trim(),
          profileUrl: balance.user.profileUrl,
        },
      }], session ? { session } : undefined);
      const entry = entryDocuments[0];

      await ProWrestlingWalletLedger.create([{
        accountType: 'USER',
        userId,
        matchId: match._id,
        entryId: entry._id,
        type: 'WRESTLING_ENTRY',
        amount: -match.entryFeeTokens,
        balanceBefore: balance.balanceBefore,
        balanceAfter: balance.balanceAfter,
        idempotencyKey: `wrestling:ledger:${requestedKey}`,
        metadata: { gameMode: PRO_WRESTLING_GAME_MODE },
      }], session ? { session } : undefined);

      match.participantCount += 1;
      match.currentPot += match.entryFeeTokens;
      await match.save(session ? { session } : undefined);

      if (affiliateId) {
        const affiliate = await applyWrestlingSession(Affiliate.findById(affiliateId), session);
        if (affiliate && !affiliate.usersJoined.some((item) => String(item.userId) === String(userId))) {
          affiliate.usersJoined.push({ userId, email: balance.user.email, joinedAt: new Date() });
          await affiliate.save(session ? { session } : undefined);
        }
      }

      await createWrestlingNotification({
        userId,
        matchId: match._id,
        type: 'ENTRY_CONFIRMED',
        title: 'Wrestling contest entry confirmed',
        message: `You entered ${match.matchTitle} for ${match.entryFeeTokens} token${match.entryFeeTokens === 1 ? '' : 's'}.`,
        session,
      });
      return { entry: wrestlingPlainObject(entry), match: publicWrestlingMatch(match), balance: balance.balanceAfter };
    });

    await safeWrestlingTrigger('contest-entry', { matchId, userId, participantCount: result.match?.participantCount });
    return res.status(result.idempotent ? 200 : 201).json(result);
  } catch (error) {
    const existing = await ProWrestlingEntry.findOne({ matchId: req.params.matchId || req.params.contestId, userId: req.user?.id }).lean().catch(() => null);
    if (error.code === 11000 && existing) return res.status(200).json({ entry: existing, idempotent: true });
    return handleWrestlingError(res, error);
  }
};
app.post('/api/wrestling/matches/:matchId/join', requireProWrestlingEnabled, verifyToken, joinWrestlingMatch);
app.post('/api/wrestling/contests/:contestId/join', requireProWrestlingEnabled, verifyToken, joinWrestlingMatch);

app.get('/api/wrestling/matches/:matchId/my-entry', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const entry = await ProWrestlingEntry.findOne({ matchId: req.params.matchId, userId: req.user.id }).lean();
    if (!entry) throw wrestlingHttpError(404, 'You have not entered this wrestling contest.', 'ENTRY_NOT_FOUND');
    const prediction = await ProWrestlingPrediction.findOne({ matchId: req.params.matchId, userId: req.user.id }).lean();
    res.json({ entry, prediction });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

const saveWrestlingPrediction = async (req, res) => {
  try {
    const matchId = req.params.matchId;
    const userId = req.user.id;
    const match = await ProWrestlingMatch.findById(matchId);
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (isWrestlingPredictionLocked(match)) throw wrestlingHttpError(409, 'Predictions are locked for this wrestling contest.', 'PREDICTIONS_LOCKED');

    const entry = await ProWrestlingEntry.findOne({ matchId, userId });
    if (!entry) throw wrestlingHttpError(403, 'Join the wrestling contest before submitting predictions.', 'ENTRY_REQUIRED');
    if (!['JOINED', 'PREDICTION_SUBMITTED'].includes(entry.status)) {
      throw wrestlingHttpError(409, 'This contest entry can no longer be edited.', 'ENTRY_LOCKED');
    }

    const payload = {
      competitorA: normalizeWrestlingStats(req.body.competitorA || req.body.wrestlerA),
      competitorB: normalizeWrestlingStats(req.body.competitorB || req.body.wrestlerB),
      winnerPrediction: String(req.body.winnerPrediction || '').toUpperCase(),
    };
    const errors = validateWrestlingPredictionPayload(payload);
    if (errors.length) throw wrestlingHttpError(400, 'Invalid wrestling prediction payload.', 'INVALID_PREDICTION', errors);

    const requestedStatus = String(req.body.predictionStatus || 'SUBMITTED').toUpperCase();
    const predictionStatus = requestedStatus === 'DRAFT' ? 'DRAFT' : 'SUBMITTED';
    const now = new Date();
    const prediction = await ProWrestlingPrediction.findOneAndUpdate(
      { matchId, userId },
      {
        $set: {
          ...payload,
          predictionStatus,
          submittedAt: predictionStatus === 'SUBMITTED' ? now : undefined,
          scoringRuleVersion: match.scoringRuleVersion,
        },
        $setOnInsert: { gameMode: PRO_WRESTLING_GAME_MODE },
      },
      { upsert: true, new: true, runValidators: true },
    );

    entry.status = predictionStatus === 'SUBMITTED' ? 'PREDICTION_SUBMITTED' : 'JOINED';
    await entry.save();

    if (predictionStatus === 'SUBMITTED') {
      await createWrestlingNotification({
        userId,
        matchId,
        type: 'PREDICTION_SUBMITTED',
        title: 'Wrestling prediction submitted',
        message: `Your predictions for ${match.matchTitle} are saved and can be edited until lock time.`,
      });
    }
    res.status(req.method === 'POST' ? 201 : 200).json({ prediction, lockAt: match.lockAt });
  } catch (error) {
    handleWrestlingError(res, error);
  }
};
app.post('/api/wrestling/matches/:matchId/prediction', requireProWrestlingEnabled, verifyToken, saveWrestlingPrediction);
app.put('/api/wrestling/matches/:matchId/prediction', requireProWrestlingEnabled, verifyToken, saveWrestlingPrediction);

app.get('/api/wrestling/matches/:matchId/prediction', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const prediction = await ProWrestlingPrediction.findOne({ matchId: req.params.matchId, userId: req.user.id }).lean();
    if (!prediction) throw wrestlingHttpError(404, 'No wrestling prediction found for this user and match.', 'PREDICTION_NOT_FOUND');
    res.json(prediction);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/wrestling/matches/:matchId/live', requireProWrestlingEnabled, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.matchId).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (!['LIVE', 'SCORING', 'FINALIZED'].includes(match.status)) {
      return res.status(409).json({ message: 'Live wrestling statistics are not available yet.', status: match.status });
    }
    let myPosition = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        myPosition = await ProWrestlingPrediction.findOne({ matchId: match._id, userId: decoded.id })
          .select('score rank previousRank scoreBreakdown predictionStatus')
          .lean();
      } catch (error) {
        myPosition = null;
      }
    }
    res.json({
      match: publicWrestlingMatch(match, { revealStats: true, includeRules: true }),
      statsVersion: match.statsVersion,
      myPosition,
      pollAfterSeconds: 15,
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/wrestling/matches/:matchId/leaderboard', requireProWrestlingEnabled, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.matchId).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (!['LIVE', 'SCORING', 'FINALIZED'].includes(match.status)) {
      return res.json({ matchId: match._id, status: match.status, data: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 1 } });
    }
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = { matchId: match._id, rank: { $exists: true } };
    const [predictions, total] = await Promise.all([
      ProWrestlingPrediction.find(query).sort({ rank: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingPrediction.countDocuments(query),
    ]);
    const userIds = predictions.map((prediction) => prediction.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName playerName profileUrl').lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    const data = predictions.map((prediction) => {
      const user = userMap.get(String(prediction.userId));
      return {
        playerId: prediction.userId,
        playerName: user?.playerName || `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || 'Fantasy player',
        profileUrl: user?.profileUrl || null,
        score: prediction.score,
        rank: prediction.rank,
        previousRank: prediction.previousRank,
        rankMovement: prediction.previousRank ? prediction.previousRank - prediction.rank : 0,
        exactPredictionCount: prediction.exactPredictionCount,
        payoutAmount: match.status === 'FINALIZED' ? prediction.payoutAmount : undefined,
      };
    });
    res.json({ matchId: match._id, status: match.status, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/wrestling/matches/:matchId/results', requireProWrestlingEnabled, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.matchId).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (!['SCORING', 'FINALIZED'].includes(match.status)) {
      throw wrestlingHttpError(409, 'Official wrestling results are not available yet.', 'RESULTS_NOT_AVAILABLE');
    }
    let myResult = null;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        myResult = await ProWrestlingPrediction.findOne({ matchId: match._id, userId: decoded.id }).lean();
      } catch (error) {
        myResult = null;
      }
    }
    res.json({ match: publicWrestlingMatch(match, { revealStats: true, includeRules: true }), myResult });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/users/me/wrestling-history', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '20', 10)));
    const entryQuery = { userId: req.user.id };
    if (req.query.status) entryQuery.status = String(req.query.status).toUpperCase();
    const [entries, total] = await Promise.all([
      ProWrestlingEntry.find(entryQuery).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingEntry.countDocuments(entryQuery),
    ]);
    const matchIds = entries.map((entry) => entry.matchId);
    const [matches, predictions] = await Promise.all([
      ProWrestlingMatch.find({ _id: { $in: matchIds } }).lean(),
      ProWrestlingPrediction.find({ userId: req.user.id, matchId: { $in: matchIds } }).lean(),
    ]);
    const matchMap = new Map(matches.map((match) => [String(match._id), match]));
    const predictionMap = new Map(predictions.map((prediction) => [String(prediction.matchId), prediction]));
    const data = entries.map((entry) => ({
      entry,
      match: publicWrestlingMatch(matchMap.get(String(entry.matchId)) || {}, { revealStats: true }),
      prediction: predictionMap.get(String(entry.matchId)) || null,
    }));
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/users/me/wrestling-wallet-ledger', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '30', 10)));
    const query = { accountType: 'USER', userId: req.user.id };
    if (req.query.matchId && mongoose.isValidObjectId(req.query.matchId)) query.matchId = req.query.matchId;
    if (req.query.type) query.type = String(req.query.type).toUpperCase();
    const [data, total] = await Promise.all([
      ProWrestlingWalletLedger.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingWalletLedger.countDocuments(query),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/users/me/wrestling-notifications', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = { userId: req.user.id };
    if (req.query.unread === 'true') query.read = false;
    const notifications = await ProWrestlingNotification.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    res.json(notifications);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.patch('/api/users/me/wrestling-notifications/:id/read', requireProWrestlingEnabled, verifyToken, async (req, res) => {
  try {
    const notification = await ProWrestlingNotification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      { $set: { read: true } },
      { new: true },
    );
    if (!notification) throw wrestlingHttpError(404, 'Wrestling notification not found.', 'NOTIFICATION_NOT_FOUND');
    res.json(notification);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

// --------------------------------------------------------------------------
// Admin wrestler, contest, scoring, settlement, migration and analytics APIs
// --------------------------------------------------------------------------

app.get('/api/admin/wrestling/wrestlers', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = {};
    if (req.query.active !== undefined) query.active = wrestlingBoolean(req.query.active);
    if (req.query.search) {
      const search = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [
        { displayName: { $regex: search, $options: 'i' } },
        { promotion: { $regex: search, $options: 'i' } },
        { wrestlingStyle: { $regex: search, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      ProWrestler.find(query).sort({ active: -1, featured: -1, displayName: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestler.countDocuments(query),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/wrestlers', requireProWrestlingEnabled, verifyAdminToken, upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]), async (req, res) => {
  try {
    const profileUpload = await uploadWrestlingImage(req.files?.profileImage?.[0], 'fantasy-mmadness/pro-wrestling/wrestlers');
    const bannerUpload = await uploadWrestlingImage(req.files?.bannerImage?.[0], 'fantasy-mmadness/pro-wrestling/wrestlers');
    const slug = await uniqueWrestlingSlug(ProWrestler, req.body.slug || req.body.displayName);
    const wrestler = await ProWrestler.create({
      displayName: req.body.displayName,
      slug,
      profileImage: profileUpload?.url || req.body.profileImageUrl || req.body.profileImage,
      profileImageDeleteUrl: profileUpload?.deleteUrl,
      bannerImage: bannerUpload?.url || req.body.bannerImageUrl || req.body.bannerImage,
      bannerImageDeleteUrl: bannerUpload?.deleteUrl,
      promotion: req.body.promotion,
      country: req.body.country,
      height: req.body.height,
      weight: req.body.weight,
      wrestlingStyle: req.body.wrestlingStyle,
      signatureMoves: wrestlingArray(req.body.signatureMoves),
      finishingMoves: wrestlingArray(req.body.finishingMoves),
      careerRecord: wrestlingObject(req.body.careerRecord, {}),
      historicalStatistics: wrestlingObject(req.body.historicalStatistics, {}),
      biography: req.body.biography,
      active: wrestlingBoolean(req.body.active, true),
      featured: wrestlingBoolean(req.body.featured, false),
      seo: wrestlingObject(req.body.seo, {}),
      createdBy: req.admin.id,
      updatedBy: req.admin.id,
    });
    await writeWrestlingAudit({ req, action: 'WRESTLER_CREATED', entityType: 'ProWrestler', entityId: wrestler._id, after: wrestler });
    app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'wrestler_added',
      vertical: 'pro_wrestling',
      admin: req.admin,
      sourceEntity: { type: 'pro_wrestling_wrestler', id: String(wrestler._id), label: wrestler.displayName },
      input: {
        wrestlerId: String(wrestler._id),
        wrestlerName: wrestler.displayName,
        title: wrestler.displayName,
        promotion: wrestler.promotion,
        wrestlingStyle: wrestler.wrestlingStyle,
        biography: wrestler.biography,
      },
      metadata: { route: '/api/admin/wrestling/wrestlers', action: 'wrestler-added' },
      reason: 'wrestler-created-in-backend',
    }).catch((error) => console.error('Swarm wrestler added automation failed:', error.message));
    res.status(201).json(wrestler);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/wrestlers/:id', requireProWrestlingEnabled, verifyAdminToken, upload.fields([{ name: 'profileImage', maxCount: 1 }, { name: 'bannerImage', maxCount: 1 }]), async (req, res) => {
  try {
    const wrestler = await ProWrestler.findById(req.params.id);
    if (!wrestler) throw wrestlingHttpError(404, 'Wrestler not found.', 'WRESTLER_NOT_FOUND');
    const before = wrestlingPlainObject(wrestler);
    const profileUpload = await uploadWrestlingImage(req.files?.profileImage?.[0], 'fantasy-mmadness/pro-wrestling/wrestlers');
    const bannerUpload = await uploadWrestlingImage(req.files?.bannerImage?.[0], 'fantasy-mmadness/pro-wrestling/wrestlers');
    const fields = ['displayName', 'promotion', 'country', 'height', 'weight', 'wrestlingStyle', 'biography'];
    fields.forEach((field) => {
      if (req.body[field] !== undefined) wrestler[field] = req.body[field];
    });
    if (req.body.slug || req.body.displayName) wrestler.slug = await uniqueWrestlingSlug(ProWrestler, req.body.slug || req.body.displayName, wrestler._id);
    if (profileUpload || req.body.profileImageUrl) {
      wrestler.profileImage = profileUpload?.url || req.body.profileImageUrl;
      if (profileUpload?.deleteUrl) wrestler.profileImageDeleteUrl = profileUpload.deleteUrl;
    }
    if (bannerUpload || req.body.bannerImageUrl) {
      wrestler.bannerImage = bannerUpload?.url || req.body.bannerImageUrl;
      if (bannerUpload?.deleteUrl) wrestler.bannerImageDeleteUrl = bannerUpload.deleteUrl;
    }
    if (req.body.signatureMoves !== undefined) wrestler.signatureMoves = wrestlingArray(req.body.signatureMoves);
    if (req.body.finishingMoves !== undefined) wrestler.finishingMoves = wrestlingArray(req.body.finishingMoves);
    if (req.body.careerRecord !== undefined) wrestler.careerRecord = wrestlingObject(req.body.careerRecord, {});
    if (req.body.historicalStatistics !== undefined) wrestler.historicalStatistics = wrestlingObject(req.body.historicalStatistics, {});
    if (req.body.active !== undefined) wrestler.active = wrestlingBoolean(req.body.active);
    if (req.body.featured !== undefined) wrestler.featured = wrestlingBoolean(req.body.featured);
    if (req.body.seo !== undefined) wrestler.seo = wrestlingObject(req.body.seo, {});
    wrestler.updatedBy = req.admin.id;
    await wrestler.save();
    await writeWrestlingAudit({ req, action: 'WRESTLER_UPDATED', entityType: 'ProWrestler', entityId: wrestler._id, before, after: wrestler, reason: req.body.reason });
    res.json(wrestler);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.delete('/api/admin/wrestling/wrestlers/:id', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const wrestler = await ProWrestler.findById(req.params.id);
    if (!wrestler) throw wrestlingHttpError(404, 'Wrestler not found.', 'WRESTLER_NOT_FOUND');
    const before = wrestlingPlainObject(wrestler);
    wrestler.active = false;
    wrestler.updatedBy = req.admin.id;
    await wrestler.save();
    await writeWrestlingAudit({ req, action: 'WRESTLER_DEACTIVATED', entityType: 'ProWrestler', entityId: wrestler._id, before, after: wrestler, reason: req.body?.reason });
    res.json({ message: 'Wrestler deactivated without deleting historical match data.', wrestler });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches', requireProWrestlingEnabled, verifyAdminToken, upload.single('bannerImage'), async (req, res) => {
  try {
    const competitorA = await resolveWrestlingCompetitor(req.body.competitorA, req.body.competitorAId);
    const competitorB = await resolveWrestlingCompetitor(req.body.competitorB, req.body.competitorBId);
    if (competitorA.wrestlerId && competitorB.wrestlerId && String(competitorA.wrestlerId) === String(competitorB.wrestlerId)) {
      throw wrestlingHttpError(400, 'The two competitors must be different wrestlers.', 'DUPLICATE_COMPETITOR');
    }
    const scoringRules = await getWrestlingScoringRule(req.body.scoringRuleVersion);
    const payoutRules = await getWrestlingPayoutRule(req.body.payoutRuleVersion);
    const matchDate = new Date(req.body.matchDate);
    const lockAt = new Date(req.body.lockAt);
    if (Number.isNaN(matchDate.getTime()) || Number.isNaN(lockAt.getTime())) {
      throw wrestlingHttpError(400, 'Valid matchDate and lockAt values are required.', 'INVALID_MATCH_DATES');
    }
    if (lockAt >= matchDate) throw wrestlingHttpError(400, 'Prediction lock time must occur before match time.', 'INVALID_LOCK_TIME');
    const status = String(req.body.status || 'DRAFT').toUpperCase();
    if (!['DRAFT', 'OPEN'].includes(status)) throw wrestlingHttpError(400, 'New wrestling matches can only start as DRAFT or OPEN.', 'INVALID_INITIAL_STATUS');
    const basePot = Math.max(0, Math.round(wrestlingNumber(req.body.basePot ?? req.body.pot, 0)));
    const minimumParticipants = Math.max(0, Math.round(wrestlingNumber(req.body.minimumParticipants, 0)));
    const maximumParticipants = Math.max(0, Math.round(wrestlingNumber(req.body.maximumParticipants, 0)));
    if (maximumParticipants > 0 && minimumParticipants > maximumParticipants) {
      throw wrestlingHttpError(400, 'minimumParticipants cannot exceed maximumParticipants.', 'INVALID_PARTICIPANT_LIMITS');
    }
    const bannerUpload = await uploadWrestlingImage(req.file, 'fantasy-mmadness/pro-wrestling/matches');
    const matchTitle = String(req.body.matchTitle || `${competitorA.displayName} vs ${competitorB.displayName}`).trim();
    const slug = await uniqueWrestlingSlug(ProWrestlingMatch, req.body.slug || `${req.body.eventName}-${matchTitle}`);
    const match = await ProWrestlingMatch.create({
      eventName: req.body.eventName,
      promotionName: req.body.promotionName,
      matchTitle,
      slug,
      matchFormat: String(req.body.matchFormat || 'SINGLES').toUpperCase(),
      competitorA,
      competitorB,
      matchDate,
      matchTime: req.body.matchTime,
      lockAt,
      entryFeeTokens: Math.max(0, Math.round(wrestlingNumber(req.body.entryFeeTokens, 0))),
      basePot,
      currentPot: basePot,
      minimumParticipants,
      maximumParticipants,
      autoCancelIfMinimumNotMet: wrestlingBoolean(req.body.autoCancelIfMinimumNotMet, true),
      status,
      description: req.body.description,
      bannerImage: bannerUpload?.url || req.body.bannerImageUrl || req.body.bannerImage,
      bannerImageDeleteUrl: bannerUpload?.deleteUrl,
      featured: wrestlingBoolean(req.body.featured, false),
      publicVisible: wrestlingBoolean(req.body.publicVisible, true),
      affiliateId: mongoose.isValidObjectId(req.body.affiliateId) ? req.body.affiliateId : undefined,
      affiliateCommissionPercentage: Math.min(100, Math.max(0, wrestlingNumber(req.body.affiliateCommissionPercentage, 0))),
      referralCode: req.body.referralCode,
      seo: wrestlingObject(req.body.seo, {}),
      scoringRuleVersion: scoringRules.ruleId,
      payoutRuleVersion: payoutRules.ruleId,
      scoringRules,
      payoutRules,
      publishedAt: status === 'OPEN' ? new Date() : undefined,
      createdBy: req.admin.id,
      updatedBy: req.admin.id,
    });
    await writeWrestlingAudit({ req, action: 'WRESTLING_MATCH_CREATED', entityType: 'ProWrestlingMatch', entityId: match._id, after: match });
    res.status(201).json(match);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/matches', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const query = {};
    if (req.query.status) query.status = { $in: String(req.query.status).split(',').map((value) => value.trim().toUpperCase()) };
    if (req.query.search) {
      const search = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [{ eventName: { $regex: search, $options: 'i' } }, { matchTitle: { $regex: search, $options: 'i' } }];
    }
    const matches = await ProWrestlingMatch.find(query).sort({ createdAt: -1 }).lean();
    res.json(matches);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/matches/:id', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.id).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    const [entries, predictions] = await Promise.all([
      ProWrestlingEntry.countDocuments({ matchId: match._id }),
      ProWrestlingPrediction.countDocuments({ matchId: match._id, predictionStatus: { $ne: 'DRAFT' } }),
    ]);
    res.json({ match, counts: { entries, predictions } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/matches/:id', requireProWrestlingEnabled, verifyAdminToken, upload.single('bannerImage'), async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.id);
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (['FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(match.status)) {
      throw wrestlingHttpError(409, 'Closed wrestling matches cannot be edited.', 'MATCH_CLOSED');
    }
    const before = wrestlingPlainObject(match);
    const protectedFields = new Set(['status', 'settlement', 'officialStats', 'officialWinner', 'participantCount', 'currentPot']);
    const editableFields = ['eventName', 'promotionName', 'matchTitle', 'matchTime', 'description', 'referralCode'];
    editableFields.forEach((field) => {
      if (req.body[field] !== undefined && !protectedFields.has(field)) match[field] = req.body[field];
    });
    if (req.body.matchDate !== undefined) match.matchDate = new Date(req.body.matchDate);
    if (req.body.lockAt !== undefined) match.lockAt = new Date(req.body.lockAt);
    if (Number.isNaN(match.matchDate.getTime()) || Number.isNaN(match.lockAt.getTime()) || match.lockAt >= match.matchDate) {
      throw wrestlingHttpError(400, 'Match and lock dates are invalid.', 'INVALID_MATCH_DATES');
    }
    if (match.participantCount === 0 && match.status === 'DRAFT') {
      if (req.body.competitorA !== undefined || req.body.competitorAId) match.competitorA = await resolveWrestlingCompetitor(req.body.competitorA, req.body.competitorAId);
      if (req.body.competitorB !== undefined || req.body.competitorBId) match.competitorB = await resolveWrestlingCompetitor(req.body.competitorB, req.body.competitorBId);
      if (req.body.entryFeeTokens !== undefined) match.entryFeeTokens = Math.max(0, Math.round(wrestlingNumber(req.body.entryFeeTokens, 0)));
      if (req.body.basePot !== undefined || req.body.pot !== undefined) {
        match.basePot = Math.max(0, Math.round(wrestlingNumber(req.body.basePot ?? req.body.pot, 0)));
        match.currentPot = match.basePot;
      }
      if (req.body.scoringRuleVersion) {
        match.scoringRules = await getWrestlingScoringRule(req.body.scoringRuleVersion);
        match.scoringRuleVersion = match.scoringRules.ruleId;
      }
      if (req.body.payoutRuleVersion) {
        match.payoutRules = await getWrestlingPayoutRule(req.body.payoutRuleVersion);
        match.payoutRuleVersion = match.payoutRules.ruleId;
      }
    }
    if (req.body.minimumParticipants !== undefined) match.minimumParticipants = Math.max(0, Math.round(wrestlingNumber(req.body.minimumParticipants, 0)));
    if (req.body.maximumParticipants !== undefined) match.maximumParticipants = Math.max(0, Math.round(wrestlingNumber(req.body.maximumParticipants, 0)));
    if (match.maximumParticipants > 0 && match.minimumParticipants > match.maximumParticipants) {
      throw wrestlingHttpError(400, 'minimumParticipants cannot exceed maximumParticipants.', 'INVALID_PARTICIPANT_LIMITS');
    }
    if (req.body.autoCancelIfMinimumNotMet !== undefined) match.autoCancelIfMinimumNotMet = wrestlingBoolean(req.body.autoCancelIfMinimumNotMet);
    if (req.body.matchFormat !== undefined && match.status === 'DRAFT' && match.participantCount === 0) {
      match.matchFormat = String(req.body.matchFormat).toUpperCase();
    }
    if (req.body.affiliateId !== undefined) {
      if (!req.body.affiliateId) match.affiliateId = undefined;
      else if (mongoose.isValidObjectId(req.body.affiliateId)) match.affiliateId = req.body.affiliateId;
      else throw wrestlingHttpError(400, 'affiliateId must be a valid identifier.', 'INVALID_AFFILIATE_ID');
    }
    if (req.body.featured !== undefined) match.featured = wrestlingBoolean(req.body.featured);
    if (req.body.publicVisible !== undefined) match.publicVisible = wrestlingBoolean(req.body.publicVisible);
    if (req.body.affiliateCommissionPercentage !== undefined) match.affiliateCommissionPercentage = Math.min(100, Math.max(0, wrestlingNumber(req.body.affiliateCommissionPercentage, 0)));
    if (req.body.seo !== undefined) match.seo = wrestlingObject(req.body.seo, {});
    if (req.body.slug || req.body.matchTitle || req.body.eventName) match.slug = await uniqueWrestlingSlug(ProWrestlingMatch, req.body.slug || `${match.eventName}-${match.matchTitle}`, match._id);
    const bannerUpload = await uploadWrestlingImage(req.file, 'fantasy-mmadness/pro-wrestling/matches');
    if (bannerUpload || req.body.bannerImageUrl) {
      match.bannerImage = bannerUpload?.url || req.body.bannerImageUrl;
      if (bannerUpload?.deleteUrl) match.bannerImageDeleteUrl = bannerUpload.deleteUrl;
    }
    match.updatedBy = req.admin.id;
    await match.save();
    await writeWrestlingAudit({ req, action: 'WRESTLING_MATCH_UPDATED', entityType: 'ProWrestlingMatch', entityId: match._id, before, after: match, reason: req.body.reason });
    res.json(match);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.delete('/api/admin/wrestling/matches/:id', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.id);
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    if (match.participantCount > 0 || match.status !== 'DRAFT') {
      throw wrestlingHttpError(409, 'Only empty draft wrestling matches can be permanently deleted. Cancel active contests instead.', 'MATCH_DELETE_BLOCKED');
    }
    const before = wrestlingPlainObject(match);
    await match.deleteOne();
    await writeWrestlingAudit({ req, action: 'WRESTLING_MATCH_DELETED', entityType: 'ProWrestlingMatch', entityId: req.params.id, before, reason: req.body?.reason });
    res.json({ message: 'Draft wrestling match deleted.' });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/matches/:id/status', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const nextStatus = String(req.body.status || '').toUpperCase();
    if (!PRO_WRESTLING_MATCH_STATUSES.includes(nextStatus)) throw wrestlingHttpError(400, 'Invalid wrestling match status.', 'INVALID_STATUS');
    if (['FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(nextStatus)) {
      throw wrestlingHttpError(400, 'Use the finalize or cancel endpoints for terminal match states.', 'TERMINAL_STATUS_REQUIRES_WORKFLOW');
    }
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (!canTransitionWrestlingStatus(match.status, nextStatus)) {
        throw wrestlingHttpError(409, `Cannot transition wrestling match from ${match.status} to ${nextStatus}.`, 'INVALID_STATUS_TRANSITION');
      }
      const before = wrestlingPlainObject(match);
      if (nextStatus === 'OPEN') match.publishedAt = new Date();
      if (nextStatus === 'LOCKED') {
        await lockWrestlingMatch(match, session);
      } else {
        match.status = nextStatus;
        if (nextStatus === 'LIVE') match.liveStartedAt = new Date();
        if (nextStatus === 'SCORING') match.scoringStartedAt = new Date();
        match.updatedBy = req.admin.id;
        await match.save(session ? { session } : undefined);
      }
      if (nextStatus === 'LIVE') {
        await notifyWrestlingEntrants({
          match,
          type: 'MATCH_LIVE',
          title: 'Pro Wrestling match is live',
          message: `${match.matchTitle} is live. Follow your provisional score and rank.`,
          session,
        });
        match.liveNotificationSent = true;
        await match.save(session ? { session } : undefined);
      }
      await writeWrestlingAudit({ req, action: 'WRESTLING_MATCH_STATUS_UPDATED', entityType: 'ProWrestlingMatch', entityId: match._id, before, after: match, reason: req.body.reason, session });
      return match;
    });
    await safeWrestlingTrigger('match-status', { matchId: String(result._id), status: result.status });
    if (result.status === 'OPEN') {
      app.locals.swarmPhase2?.triggerAutomationEvent?.({
        trigger: 'pro_wrestling_match_published',
        vertical: 'pro_wrestling',
        admin: req.admin,
        sourceEntity: { type: 'pro_wrestling_match', id: String(result._id), label: result.matchTitle || result.eventName },
        input: {
          matchId: String(result._id),
          title: result.matchTitle,
          eventName: result.eventName,
          promotionName: result.promotionName,
          matchDate: result.matchDate,
          matchTime: result.matchTime,
          competitorA: result.competitorA,
          competitorB: result.competitorB,
          status: result.status,
        },
        metadata: { route: '/api/admin/wrestling/matches/:id/status', action: 'wrestling-match-published' },
        reason: 'pro-wrestling-match-opened-in-backend',
      }).catch((error) => console.error('Swarm pro-wrestling publish automation failed:', error.message));
    }
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/matches/:id/live-stats', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const statsA = normalizeWrestlingStats(req.body.competitorA || req.body.wrestlerA);
    const statsB = normalizeWrestlingStats(req.body.competitorB || req.body.wrestlerB);
    const officialWinner = req.body.officialWinner ? String(req.body.officialWinner).toUpperCase() : undefined;
    if (officialWinner && ![...WRESTLING_WINNER_VALUES, 'NO_CONTEST'].includes(officialWinner)) {
      throw wrestlingHttpError(400, 'officialWinner must be A, B, DRAW, or NO_CONTEST.', 'INVALID_WINNER');
    }
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (['FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(match.status)) throw wrestlingHttpError(409, 'Closed wrestling match statistics cannot be edited.', 'MATCH_CLOSED');
      const before = wrestlingPlainObject(match);
      match.officialStats = { competitorA: statsA, competitorB: statsB };
      if (officialWinner) match.officialWinner = officialWinner;
      if (req.body.finishType) match.finishType = String(req.body.finishType).toUpperCase();
      match.statsVersion += 1;
      if (['OPEN', 'LOCKED'].includes(match.status)) {
        match.status = 'LIVE';
        match.liveStartedAt = new Date();
      }
      match.updatedBy = req.admin.id;
      await match.save(session ? { session } : undefined);
      const ranked = await recalculateWrestlingScores(match, session);
      await writeWrestlingAudit({ req, action: 'WRESTLING_LIVE_STATS_UPDATED', entityType: 'ProWrestlingMatch', entityId: match._id, before, after: match, reason: req.body.reason, session });
      return { match, rankedCount: ranked.length };
    });
    await safeWrestlingTrigger('live-stats', { matchId: String(result.match._id), statsVersion: result.match.statsVersion });
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/matches/:id/result', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const officialWinner = String(req.body.officialWinner || '').toUpperCase();
    if (!WRESTLING_WINNER_VALUES.includes(officialWinner)) throw wrestlingHttpError(400, 'Official winner must be A, B, or DRAW.', 'INVALID_WINNER');
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (['FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(match.status)) throw wrestlingHttpError(409, 'Closed wrestling match result cannot be edited.', 'MATCH_CLOSED');
      const before = wrestlingPlainObject(match);
      if (req.body.competitorA || req.body.wrestlerA) match.officialStats.competitorA = normalizeWrestlingStats(req.body.competitorA || req.body.wrestlerA);
      if (req.body.competitorB || req.body.wrestlerB) match.officialStats.competitorB = normalizeWrestlingStats(req.body.competitorB || req.body.wrestlerB);
      match.officialWinner = officialWinner;
      match.finishType = String(req.body.finishType || (officialWinner === 'DRAW' ? 'DRAW' : 'OTHER')).toUpperCase();
      match.status = 'SCORING';
      match.scoringStartedAt = new Date();
      match.statsVersion += 1;
      match.updatedBy = req.admin.id;
      await match.save(session ? { session } : undefined);
      const ranked = await recalculateWrestlingScores(match, session);
      await writeWrestlingAudit({ req, action: 'WRESTLING_OFFICIAL_RESULT_SET', entityType: 'ProWrestlingMatch', entityId: match._id, before, after: match, reason: req.body.reason, session });
      return { match, rankedCount: ranked.length };
    });
    await safeWrestlingTrigger('official-result', { matchId: String(result.match._id), officialWinner: result.match.officialWinner });
    app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'pro_wrestling_result_updated',
      vertical: 'pro_wrestling',
      admin: req.admin,
      sourceEntity: { type: 'pro_wrestling_match', id: String(result.match._id), label: result.match.matchTitle || result.match.eventName },
      input: {
        matchId: String(result.match._id),
        title: result.match.matchTitle,
        eventName: result.match.eventName,
        promotionName: result.match.promotionName,
        officialWinner: result.match.officialWinner,
        finishType: result.match.finishType,
        statsVersion: result.match.statsVersion,
      },
      metadata: { route: '/api/admin/wrestling/matches/:id/result', action: 'wrestling-result-updated' },
      reason: 'pro-wrestling-result-set-in-backend',
    }).catch((error) => console.error('Swarm pro-wrestling result automation failed:', error.message));
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches/:id/recalculate', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (!['LIVE', 'SCORING'].includes(match.status)) throw wrestlingHttpError(409, 'Only live or scoring wrestling matches can be recalculated.', 'INVALID_RECALCULATION_STATUS');
      const ranked = await recalculateWrestlingScores(match, session);
      await writeWrestlingAudit({ req, action: 'WRESTLING_SCORES_RECALCULATED', entityType: 'ProWrestlingMatch', entityId: match._id, after: { rankedCount: ranked.length }, reason: req.body.reason, session });
      return ranked;
    });
    res.json({ rankedCount: result.length, leaderboard: result.map((row) => ({ userId: row.userId, rank: row.rank, score: row.totalScore })) });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches/:id/finalize', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (match.settlement?.status === 'PAID' && match.status === 'FINALIZED') return { match, idempotent: true };
      if (!['LIVE', 'SCORING', 'LOCKED'].includes(match.status)) throw wrestlingHttpError(409, 'Wrestling match is not ready for finalization.', 'INVALID_FINALIZATION_STATUS');
      if (!WRESTLING_WINNER_VALUES.includes(match.officialWinner)) throw wrestlingHttpError(400, 'Set the official wrestling winner before finalizing.', 'OFFICIAL_WINNER_REQUIRED');
      const before = wrestlingPlainObject(match);
      match.status = 'SCORING';
      match.scoringStartedAt = match.scoringStartedAt || new Date();
      match.settlement.status = 'PROCESSING';
      await match.save(session ? { session } : undefined);
      await recalculateWrestlingScores(match, session);
      const predictions = await applyWrestlingSession(ProWrestlingPrediction.find({ matchId: match._id, rank: { $exists: true } }).sort({ rank: 1 }), session);
      if (!predictions.length) throw wrestlingHttpError(409, 'No submitted wrestling predictions are available for settlement.', 'NO_PREDICTIONS_TO_SETTLE');

      const initialDistribution = calculatePayoutDistribution(match.currentPot, predictions.length, match.payoutRules);
      const affiliateCommissionTokens = match.affiliateId
        ? Math.floor(initialDistribution.distributablePot * (match.affiliateCommissionPercentage / 100))
        : 0;
      const playerPot = Math.max(0, initialDistribution.distributablePot - affiliateCommissionTokens);
      const playerDistribution = calculatePayoutDistribution(playerPot, predictions.length, { ...match.payoutRules, platformFeePercentage: 0 });
      const payoutByRank = new Map(playerDistribution.payouts.map((payout) => [payout.rank, payout.amount]));

      for (const prediction of predictions) {
        const payoutAmount = payoutByRank.get(prediction.rank) || 0;
        prediction.payoutAmount = payoutAmount;
        prediction.predictionStatus = 'SETTLED';
        if (payoutAmount > 0) {
          const idempotencyKey = `wrestling:payout:${match._id}:${prediction.userId}`;
          const existingLedger = await applyWrestlingSession(ProWrestlingWalletLedger.findOne({ idempotencyKey }), session).lean();
          if (!existingLedger) {
            const balance = await adjustWrestlingUserTokens({ userId: prediction.userId, delta: payoutAmount, session });
            await ProWrestlingWalletLedger.create([{
              accountType: 'USER',
              userId: prediction.userId,
              matchId: match._id,
              type: 'WRESTLING_WINNING',
              amount: payoutAmount,
              balanceBefore: balance.balanceBefore,
              balanceAfter: balance.balanceAfter,
              idempotencyKey,
              metadata: { rank: prediction.rank, scoringRuleVersion: match.scoringRuleVersion, payoutRuleVersion: match.payoutRuleVersion },
            }], session ? { session } : undefined);
          }
          await createWrestlingNotification({
            userId: prediction.userId,
            matchId: match._id,
            type: 'WINNINGS_CREDITED',
            title: 'Pro Wrestling winnings credited',
            message: `You finished #${prediction.rank} and won ${payoutAmount} token${payoutAmount === 1 ? '' : 's'} in ${match.matchTitle}.`,
            metadata: { rank: prediction.rank, payoutAmount },
            session,
          });
        } else {
          await createWrestlingNotification({
            userId: prediction.userId,
            matchId: match._id,
            type: 'RESULT_FINALIZED',
            title: 'Pro Wrestling result finalized',
            message: `Your final rank in ${match.matchTitle} is #${prediction.rank}.`,
            metadata: { rank: prediction.rank, score: prediction.score },
            session,
          });
        }
        await prediction.save(session ? { session } : undefined);
      }

      if (match.affiliateId && affiliateCommissionTokens > 0) {
        const idempotencyKey = `wrestling:affiliate:${match._id}:${match.affiliateId}`;
        const existingLedger = await applyWrestlingSession(ProWrestlingWalletLedger.findOne({ idempotencyKey }), session).lean();
        if (!existingLedger) {
          const balance = await adjustWrestlingAffiliateTokens({ affiliateId: match.affiliateId, delta: affiliateCommissionTokens, session });
          await ProWrestlingWalletLedger.create([{
            accountType: 'AFFILIATE',
            affiliateId: match.affiliateId,
            matchId: match._id,
            type: 'WRESTLING_AFFILIATE_COMMISSION',
            amount: affiliateCommissionTokens,
            balanceBefore: balance.balanceBefore,
            balanceAfter: balance.balanceAfter,
            idempotencyKey,
            metadata: { percentage: match.affiliateCommissionPercentage },
          }], session ? { session } : undefined);
        }
      }

      if (initialDistribution.platformFeeTokens > 0) {
        const platformKey = `wrestling:platform-fee:${match._id}`;
        const existingPlatformLedger = await applyWrestlingSession(ProWrestlingWalletLedger.findOne({ idempotencyKey: platformKey }), session).lean();
        if (!existingPlatformLedger) {
          await ProWrestlingWalletLedger.create([{
            accountType: 'PLATFORM',
            matchId: match._id,
            type: 'WRESTLING_PLATFORM_FEE',
            amount: initialDistribution.platformFeeTokens,
            idempotencyKey: platformKey,
            metadata: { percentage: match.payoutRules.platformFeePercentage || 0 },
          }], session ? { session } : undefined);
        }
      }

      const settledAt = new Date();
      await ProWrestlingEntry.updateMany(
        { matchId: match._id, status: { $ne: 'REFUNDED' } },
        { $set: { status: 'SETTLED', settledAt, payoutAmount: 0 }, $unset: { rank: '' } },
        session ? { session } : undefined,
      );
      const entrySettlementOperations = predictions.map((prediction) => ({
        updateOne: {
          filter: { matchId: match._id, userId: prediction.userId, status: { $ne: 'REFUNDED' } },
          update: {
            $set: {
              status: 'SETTLED',
              settledAt,
              rank: prediction.rank,
              payoutAmount: prediction.payoutAmount || 0,
            },
          },
        },
      }));
      if (entrySettlementOperations.length) {
        await ProWrestlingEntry.bulkWrite(entrySettlementOperations, session ? { session } : undefined);
      }
      const payoutTotal = playerDistribution.payouts.reduce((sum, payout) => sum + payout.amount, 0);
      match.status = 'FINALIZED';
      match.finalizedAt = new Date();
      match.settlement = {
        status: 'PAID',
        winnerCount: playerDistribution.winnerCount,
        grossPot: match.currentPot,
        platformFeeTokens: initialDistribution.platformFeeTokens,
        affiliateCommissionTokens,
        playerPayoutTokens: payoutTotal,
        completedAt: new Date(),
      };
      match.updatedBy = req.admin.id;
      await match.save(session ? { session } : undefined);
      await writeWrestlingAudit({ req, action: 'WRESTLING_MATCH_FINALIZED', entityType: 'ProWrestlingMatch', entityId: match._id, before, after: match, reason: req.body.reason, session });
      return { match, payoutDistribution: playerDistribution, affiliateCommissionTokens, idempotent: false };
    });
    await safeWrestlingTrigger('match-finalized', { matchId: String(result.match._id), settlement: result.match.settlement });
    app.locals.swarmPhase2?.triggerAutomationEvent?.({
      trigger: 'contest_completed',
      vertical: 'pro_wrestling',
      admin: req.admin,
      sourceEntity: { type: 'pro_wrestling_contest', id: String(result.match._id), label: result.match.matchTitle || result.match.eventName },
      input: {
        matchId: String(result.match._id),
        contestId: String(result.match._id),
        title: result.match.matchTitle,
        eventName: result.match.eventName,
        settlement: result.match.settlement,
      },
      metadata: { route: '/api/admin/wrestling/matches/:id/finalize', action: 'wrestling-contest-completed' },
      reason: 'pro-wrestling-contest-finalized-in-backend',
    }).catch((error) => console.error('Swarm contest completed automation failed:', error.message));
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches/:id/cancel', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const status = String(req.body.status || 'CANCELLED').toUpperCase();
    if (!['CANCELLED', 'NO_CONTEST'].includes(status)) throw wrestlingHttpError(400, 'Cancellation status must be CANCELLED or NO_CONTEST.', 'INVALID_CANCELLATION_STATUS');
    const reason = String(req.body.reason || (status === 'NO_CONTEST' ? 'Match declared a no contest.' : 'Match cancelled by administrator.'));
    const match = await refundWrestlingMatch({ matchId: req.params.id, status, reason, req, adminId: req.admin.id });
    res.json({ message: 'Wrestling contest closed and eligible entry fees refunded.', match });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches/:id/refund', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const reason = String(req.body.reason || 'Wrestling contest entry refund issued by administrator.');
    const match = await refundWrestlingMatch({ matchId: req.params.id, status: 'CANCELLED', reason, req, adminId: req.admin.id });
    res.json({ message: 'Wrestling contest entry fees refunded.', match });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/matches/:id/notify', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const match = await ProWrestlingMatch.findById(req.params.id).lean();
    if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
    const users = await User.find({ isNotificationsEnabled: { $ne: false } }).select('_id').limit(10000).lean();
    const documents = users.map((user) => ({
      userId: user._id,
      matchId: match._id,
      type: 'CONTEST_PUBLISHED',
      title: req.body.title || 'New Pro Wrestling contest',
      message: req.body.message || `${match.matchTitle} is now open for predictions.`,
      metadata: { slug: match.slug, lockAt: match.lockAt },
    }));
    if (documents.length) await ProWrestlingNotification.insertMany(documents);
    await writeWrestlingAudit({ req, action: 'WRESTLING_CONTEST_NOTIFICATION_SENT', entityType: 'ProWrestlingMatch', entityId: match._id, after: { recipients: documents.length } });
    res.json({ sent: documents.length });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/scoring-rules', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    res.json(await ProWrestlingScoringRule.find().sort({ createdAt: 1 }).lean());
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/scoring-rules', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const config = normalizeScoringRule({ ...wrestlingObject(req.body.config, req.body), ruleId: req.body.ruleId, name: req.body.name });
    const rule = await ProWrestlingScoringRule.create({ ruleId: config.ruleId, name: config.name, active: wrestlingBoolean(req.body.active, true), config, createdBy: req.admin.id, updatedBy: req.admin.id });
    await writeWrestlingAudit({ req, action: 'WRESTLING_SCORING_RULE_CREATED', entityType: 'ProWrestlingScoringRule', entityId: rule._id, after: rule });
    res.status(201).json(rule);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/scoring-rules/:ruleId', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const existing = await ProWrestlingScoringRule.findOne({ ruleId: String(req.params.ruleId).toUpperCase() });
    if (!existing) throw wrestlingHttpError(404, 'Wrestling scoring rule not found.', 'SCORING_RULE_NOT_FOUND');
    const before = wrestlingPlainObject(existing);
    const config = normalizeScoringRule({ ...wrestlingObject(req.body.config, req.body), ruleId: existing.ruleId, name: req.body.name || existing.name });
    existing.name = config.name;
    existing.config = config;
    if (req.body.active !== undefined) existing.active = wrestlingBoolean(req.body.active);
    existing.updatedBy = req.admin.id;
    await existing.save();
    await writeWrestlingAudit({ req, action: 'WRESTLING_SCORING_RULE_UPDATED', entityType: 'ProWrestlingScoringRule', entityId: existing._id, before, after: existing, reason: req.body.reason });
    res.json(existing);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/payout-rules', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    res.json(await ProWrestlingPayoutRule.find().sort({ createdAt: 1 }).lean());
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/payout-rules', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const config = normalizePayoutRule({ ...wrestlingObject(req.body.config, req.body), ruleId: req.body.ruleId, name: req.body.name });
    const rule = await ProWrestlingPayoutRule.create({ ruleId: config.ruleId, name: config.name, active: wrestlingBoolean(req.body.active, true), config, createdBy: req.admin.id, updatedBy: req.admin.id });
    await writeWrestlingAudit({ req, action: 'WRESTLING_PAYOUT_RULE_CREATED', entityType: 'ProWrestlingPayoutRule', entityId: rule._id, after: rule });
    res.status(201).json(rule);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/payout-rules/:ruleId', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const existing = await ProWrestlingPayoutRule.findOne({ ruleId: String(req.params.ruleId).toUpperCase() });
    if (!existing) throw wrestlingHttpError(404, 'Wrestling payout rule not found.', 'PAYOUT_RULE_NOT_FOUND');
    const before = wrestlingPlainObject(existing);
    const config = normalizePayoutRule({ ...wrestlingObject(req.body.config, req.body), ruleId: existing.ruleId, name: req.body.name || existing.name });
    existing.name = config.name;
    existing.config = config;
    if (req.body.active !== undefined) existing.active = wrestlingBoolean(req.body.active);
    existing.updatedBy = req.admin.id;
    await existing.save();
    await writeWrestlingAudit({ req, action: 'WRESTLING_PAYOUT_RULE_UPDATED', entityType: 'ProWrestlingPayoutRule', entityId: existing._id, before, after: existing, reason: req.body.reason });
    res.json(existing);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/analytics', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const [statusCounts, totalEntries, uniqueUsers, potTotals, predictionSummary, ledgerSummary] = await Promise.all([
      ProWrestlingMatch.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      ProWrestlingEntry.countDocuments(),
      ProWrestlingEntry.distinct('userId'),
      ProWrestlingMatch.aggregate([{ $group: { _id: null, grossPot: { $sum: '$currentPot' }, finalizedPot: { $sum: { $cond: [{ $eq: ['$status', 'FINALIZED'] }, '$currentPot', 0] } } } }]),
      ProWrestlingPrediction.aggregate([{ $match: { rank: { $exists: true } } }, { $group: { _id: null, averageScore: { $avg: '$score' }, averageNormalizedError: { $avg: '$normalizedError' }, scoredPredictions: { $sum: 1 } } }]),
      ProWrestlingWalletLedger.aggregate([{ $match: { status: 'COMPLETED' } }, { $group: { _id: '$type', amount: { $sum: '$amount' }, transactions: { $sum: 1 } } }]),
    ]);
    res.json({
      gameMode: PRO_WRESTLING_GAME_MODE,
      matchesByStatus: Object.fromEntries(statusCounts.map((item) => [item._id, item.count])),
      totalEntries,
      uniquePlayers: uniqueUsers.length,
      pots: potTotals[0] || { grossPot: 0, finalizedPot: 0 },
      predictions: predictionSummary[0] || { averageScore: 0, averageNormalizedError: 0, scoredPredictions: 0 },
      wallet: Object.fromEntries(ledgerSummary.map((item) => [item._id, { amount: item.amount, transactions: item.transactions }])),
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/audit-logs', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = {};
    if (req.query.entityType) query.entityType = req.query.entityType;
    if (req.query.entityId) query.entityId = String(req.query.entityId);
    if (req.query.action) query.action = req.query.action;
    const [data, total] = await Promise.all([
      ProWrestlingAuditLog.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingAuditLog.countDocuments(query),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/wallet-ledger', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = {};
    if (req.query.matchId && mongoose.isValidObjectId(req.query.matchId)) query.matchId = req.query.matchId;
    if (req.query.userId && mongoose.isValidObjectId(req.query.userId)) query.userId = req.query.userId;
    if (req.query.affiliateId && mongoose.isValidObjectId(req.query.affiliateId)) query.affiliateId = req.query.affiliateId;
    if (req.query.accountType) query.accountType = String(req.query.accountType).toUpperCase();
    if (req.query.type) query.type = String(req.query.type).toUpperCase();
    const [data, total] = await Promise.all([
      ProWrestlingWalletLedger.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingWalletLedger.countDocuments(query),
    ]);
    res.json({ data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/matches/:id/entries', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = { matchId: req.params.id };
    if (req.query.status) query.status = String(req.query.status).toUpperCase();
    const [entries, total] = await Promise.all([
      ProWrestlingEntry.find(query).sort({ rank: 1, joinedAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingEntry.countDocuments(query),
    ]);
    const userIds = entries.map((entry) => entry.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName playerName email profileUrl tokens').lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    res.json({
      data: entries.map((entry) => ({ ...entry, user: userMap.get(String(entry.userId)) || null })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/matches/:id/predictions', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '50', 10)));
    const query = { matchId: req.params.id };
    if (req.query.status) query.predictionStatus = String(req.query.status).toUpperCase();
    const [predictions, total] = await Promise.all([
      ProWrestlingPrediction.find(query).sort({ rank: 1, submittedAt: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      ProWrestlingPrediction.countDocuments(query),
    ]);
    const userIds = predictions.map((prediction) => prediction.userId);
    const users = await User.find({ _id: { $in: userIds } }).select('firstName lastName playerName email profileUrl').lean();
    const userMap = new Map(users.map((user) => [String(user._id), user]));
    res.json({
      data: predictions.map((prediction) => ({ ...prediction, user: userMap.get(String(prediction.userId)) || null })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.put('/api/admin/wrestling/matches/:id/predictions/:userId', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const result = await runWrestlingTransaction(async (session) => {
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(req.params.id), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      if (['FINALIZED', 'CANCELLED', 'NO_CONTEST'].includes(match.status)) {
        throw wrestlingHttpError(409, 'Predictions in a closed wrestling contest cannot be changed.', 'MATCH_CLOSED');
      }
      const prediction = await applyWrestlingSession(ProWrestlingPrediction.findOne({ matchId: match._id, userId: req.params.userId }), session);
      if (!prediction) throw wrestlingHttpError(404, 'Wrestling prediction not found.', 'PREDICTION_NOT_FOUND');
      const payload = {
        competitorA: normalizeWrestlingStats(req.body.competitorA || prediction.competitorA),
        competitorB: normalizeWrestlingStats(req.body.competitorB || prediction.competitorB),
        winnerPrediction: String(req.body.winnerPrediction || prediction.winnerPrediction).toUpperCase(),
      };
      const errors = validateWrestlingPredictionPayload(payload);
      if (errors.length) throw wrestlingHttpError(400, 'Invalid wrestling prediction payload.', 'INVALID_PREDICTION', errors);
      const before = wrestlingPlainObject(prediction);
      prediction.competitorA = payload.competitorA;
      prediction.competitorB = payload.competitorB;
      prediction.winnerPrediction = payload.winnerPrediction;
      prediction.predictionStatus = ['LIVE', 'SCORING'].includes(match.status) ? 'SCORED' : 'SUBMITTED';
      prediction.submittedAt = prediction.submittedAt || new Date();
      await prediction.save(session ? { session } : undefined);
      if (['LIVE', 'SCORING'].includes(match.status)) await recalculateWrestlingScores(match, session);
      await writeWrestlingAudit({
        req,
        action: 'WRESTLING_PREDICTION_ADMIN_CORRECTED',
        entityType: 'ProWrestlingPrediction',
        entityId: prediction._id,
        before,
        after: prediction,
        reason: req.body.reason,
        session,
      });
      return prediction;
    });
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/wallet-adjustment', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const userId = req.body.userId;
    const matchId = req.body.matchId;
    const amount = Math.max(1, Math.round(Math.abs(wrestlingNumber(req.body.amount, 0))));
    const direction = String(req.body.direction || 'CREDIT').toUpperCase();
    if (!mongoose.isValidObjectId(userId)) throw wrestlingHttpError(400, 'A valid userId is required.', 'INVALID_USER_ID');
    if (!mongoose.isValidObjectId(matchId)) throw wrestlingHttpError(400, 'A valid wrestling matchId is required.', 'INVALID_MATCH_ID');
    if (!['CREDIT', 'DEBIT'].includes(direction)) throw wrestlingHttpError(400, 'direction must be CREDIT or DEBIT.', 'INVALID_DIRECTION');
    if (!req.body.reason) throw wrestlingHttpError(400, 'A reason is required for wallet adjustments.', 'REASON_REQUIRED');
    const key = String(req.headers['idempotency-key'] || req.body.idempotencyKey || `wrestling:admin-adjustment:${matchId}:${userId}:${Date.now()}`).slice(0, 180);
    const result = await runWrestlingTransaction(async (session) => {
      const existing = await applyWrestlingSession(ProWrestlingWalletLedger.findOne({ idempotencyKey: key }), session).lean();
      if (existing) return { transaction: existing, idempotent: true };
      const match = await applyWrestlingSession(ProWrestlingMatch.findById(matchId), session);
      if (!match) throw wrestlingHttpError(404, 'Wrestling match not found.', 'MATCH_NOT_FOUND');
      const delta = direction === 'CREDIT' ? amount : -amount;
      const balance = await adjustWrestlingUserTokens({ userId, delta, session });
      const documents = await ProWrestlingWalletLedger.create([{
        accountType: 'USER',
        userId,
        matchId,
        type: 'WRESTLING_ADMIN_ADJUSTMENT',
        amount: delta,
        balanceBefore: balance.balanceBefore,
        balanceAfter: balance.balanceAfter,
        idempotencyKey: key,
        metadata: { reason: req.body.reason, adminId: req.admin.id, direction },
      }], session ? { session } : undefined);
      await writeWrestlingAudit({
        req,
        action: 'WRESTLING_WALLET_ADMIN_ADJUSTMENT',
        entityType: 'User',
        entityId: userId,
        before: { tokens: balance.balanceBefore },
        after: { tokens: balance.balanceAfter, transactionId: documents[0]._id },
        reason: req.body.reason,
        session,
      });
      return { transaction: documents[0], idempotent: false };
    });
    res.json(result);
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/system-check', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const [rules, payoutRules, indexes] = await Promise.all([
      ProWrestlingScoringRule.countDocuments({ active: true }),
      ProWrestlingPayoutRule.countDocuments({ active: true }),
      Promise.all([
        ProWrestlingMatch.collection.indexes(),
        ProWrestlingEntry.collection.indexes(),
        ProWrestlingPrediction.collection.indexes(),
        ProWrestlingWalletLedger.collection.indexes(),
      ]),
    ]);
    res.json({
      enabled: isProWrestlingEnabled(),
      databaseState: mongoose.connection.readyState,
      activeScoringRules: rules,
      activePayoutRules: payoutRules,
      transactionFallbackEnabled: String(process.env.PRO_WRESTLING_ALLOW_NON_TRANSACTIONAL || '').toLowerCase() === 'true',
      indexCounts: {
        matches: indexes[0].length,
        entries: indexes[1].length,
        predictions: indexes[2].length,
        walletLedger: indexes[3].length,
      },
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.post('/api/admin/wrestling/migrate-existing-matches', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  try {
    const applyMigration = wrestlingBoolean(req.body.apply, false);
    const legacyMatches = await Match.collection.find({ gameMode: { $exists: false } }, { projection: { _id: 1, matchCategory: 1, matchCategoryTwo: 1 } }).toArray();
    const inferMode = (match) => {
      const category = `${match.matchCategory || ''} ${match.matchCategoryTwo || ''}`.toLowerCase();
      if (category.includes('bare')) return 'BARE_KNUCKLE';
      if (category.includes('kick')) return 'KICKBOXING';
      if (category.includes('box')) return 'BOXING';
      return 'MMA';
    };
    const counts = {};
    const operations = legacyMatches.map((match) => {
      const gameMode = inferMode(match);
      counts[gameMode] = (counts[gameMode] || 0) + 1;
      return {
        updateOne: {
          filter: { _id: match._id, gameMode: { $exists: false } },
          update: { $set: { gameMode, predictionFormat: 'ROUND_BY_ROUND', scoringRuleVersion: 'LEGACY_V1' } },
        },
      };
    });
    let migrationResult = null;
    if (applyMigration && operations.length) migrationResult = await Match.collection.bulkWrite(operations, { ordered: false });
    await writeWrestlingAudit({ req, action: applyMigration ? 'LEGACY_GAME_MODE_MIGRATION_APPLIED' : 'LEGACY_GAME_MODE_MIGRATION_PREVIEWED', entityType: 'Match', entityId: 'legacy-match-collection', after: { counts, records: legacyMatches.length } });
    res.json({ dryRun: !applyMigration, records: legacyMatches.length, inferredGameModes: counts, modifiedCount: migrationResult?.modifiedCount || 0 });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

const verifyWrestlingAffiliateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Affiliate authentication is required.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return Affiliate.findById(decoded.id).then((affiliate) => {
      if (!affiliate) return res.status(403).json({ message: 'Affiliate account not found.' });
      req.wrestlingAffiliate = affiliate;
      return next();
    }).catch(() => res.status(500).json({ message: 'Affiliate authentication failed.' }));
  } catch (error) {
    return res.status(403).json({ message: 'Invalid or expired affiliate token.' });
  }
};

app.get('/api/affiliates/me/wrestling-summary', requireProWrestlingEnabled, verifyWrestlingAffiliateToken, async (req, res) => {
  try {
    const affiliateId = req.wrestlingAffiliate._id;
    const [matches, entries, commissions] = await Promise.all([
      ProWrestlingMatch.find({ affiliateId }).sort({ createdAt: -1 }).lean(),
      ProWrestlingEntry.countDocuments({ affiliateId }),
      ProWrestlingWalletLedger.find({ accountType: 'AFFILIATE', affiliateId, type: 'WRESTLING_AFFILIATE_COMMISSION' }).sort({ createdAt: -1 }).lean(),
    ]);
    const totalCommissionTokens = commissions.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    res.json({
      affiliate: {
        id: affiliateId,
        playerName: req.wrestlingAffiliate.playerName,
        tokens: req.wrestlingAffiliate.tokens,
      },
      matches: matches.map((match) => publicWrestlingMatch(match, { revealStats: true })),
      attributedEntries: entries,
      totalCommissionTokens,
      commissions,
    });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});

app.get('/api/admin/wrestling/docs', requireProWrestlingEnabled, verifyAdminToken, async (req, res) => {
  res.json({
    gameMode: PRO_WRESTLING_GAME_MODE,
    predictionFormat: PRO_WRESTLING_PREDICTION_FORMAT,
    lifecycle: PRO_WRESTLING_MATCH_STATUSES,
    actionStats: WRESTLING_STAT_KEYS,
    userFlow: ['discover', 'join', 'predict', 'lock', 'live scoring', 'leaderboard', 'results', 'wallet settlement'],
    safeguards: ['feature flag', 'JWT authorization', 'unique contest entry', 'idempotent wallet ledger', 'MongoDB transactions', 'versioned rule snapshots', 'audit logs', 'terminal-state protection'],
  });
});

app.get('/api/wrestling/cron/process', requireProWrestlingEnabled, verifyWrestlingCronOrAdmin, async (req, res) => {
  try {
    const now = new Date();
    const dueMatches = await ProWrestlingMatch.find({ status: 'OPEN', lockAt: { $lte: now } }).limit(100).lean();
    let locked = 0;
    let cancelled = 0;
    for (const due of dueMatches) {
      if (due.minimumParticipants > due.participantCount && due.autoCancelIfMinimumNotMet) {
        await refundWrestlingMatch({
          matchId: due._id,
          status: 'CANCELLED',
          reason: 'Minimum participant requirement was not met before prediction lock.',
          req,
          adminId: req.admin?.id,
        });
        cancelled += 1;
      } else {
        await runWrestlingTransaction(async (session) => {
          const match = await applyWrestlingSession(ProWrestlingMatch.findById(due._id), session);
          if (match?.status === 'OPEN') {
            await lockWrestlingMatch(match, session);
            locked += 1;
          }
        });
      }
    }

    const startingSoonLimit = new Date(now.getTime() + 60 * 60 * 1000);
    const startingSoonMatches = await ProWrestlingMatch.find({
      status: 'OPEN',
      matchDate: { $gt: now, $lte: startingSoonLimit },
      startingSoonNotificationSent: false,
    });
    let startingSoonNotifications = 0;
    for (const match of startingSoonMatches) {
      startingSoonNotifications += await notifyWrestlingEntrants({
        match,
        type: 'STARTING_SOON',
        title: 'Pro Wrestling contest starts soon',
        message: `${match.matchTitle} starts within one hour. Submit or review your predictions before lock time.`,
      });
      match.startingSoonNotificationSent = true;
      await match.save();
    }

    res.json({ processedAt: now, locked, cancelled, startingSoonNotifications });
  } catch (error) {
    handleWrestlingError(res, error);
  }
});


function parseHomepagePromotionBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'promote', 'promoted'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'unpromote', 'remove'].includes(normalized)) return false;
  return fallback;
}

function parseOptionalPromotionDate(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildAutoHomepagePromotionFields({ body = {}, admin = null, actor = '' } = {}) {
  const now = new Date();
  const update = {
    homepagePromoted: true,
    homepagePromotionRank: Number(body.homepagePromotionRank ?? body.rank ?? 0) || 0,
    homepagePromotionUpdatedAt: now,
    homepagePromotionUpdatedBy: admin?.id || admin?._id || admin?.email || actor || body.matchBy || body.createdBy || 'admin-create',
  };
  const title = body.homepagePromotionTitle ?? body.promotionTitle ?? body.title;
  const subtitle = body.homepagePromotionSubtitle ?? body.promotionSubtitle ?? body.subtitle;
  const ctaLabel = body.homepagePromotionCtaLabel ?? body.ctaLabel;
  const calendarSource = body.homepagePromotionCalendarSource ?? body.calendarSource;
  const externalSourceUrl = body.homepagePromotionExternalSourceUrl ?? body.externalSourceUrl;
  if (title !== undefined) update.homepagePromotionTitle = String(title || '').trim();
  if (subtitle !== undefined) update.homepagePromotionSubtitle = String(subtitle || '').trim();
  if (ctaLabel !== undefined) update.homepagePromotionCtaLabel = String(ctaLabel || '').trim();
  if (calendarSource !== undefined) update.homepagePromotionCalendarSource = String(calendarSource || '').trim();
  if (externalSourceUrl !== undefined) update.homepagePromotionExternalSourceUrl = String(externalSourceUrl || '').trim();
  const startsAt = parseOptionalPromotionDate(body.homepagePromotionStartsAt ?? body.startsAt);
  const endsAt = parseOptionalPromotionDate(body.homepagePromotionEndsAt ?? body.endsAt);
  if (startsAt !== undefined) update.homepagePromotionStartsAt = startsAt;
  if (endsAt !== undefined) update.homepagePromotionEndsAt = endsAt;
  return update;
}

function isHomepagePromotionVisible(fight = {}, now = new Date()) {
  if (!fight || !fight.homepagePromoted || isDraftFightRecord(fight)) return false;
  const startsAt = fight.homepagePromotionStartsAt ? new Date(fight.homepagePromotionStartsAt) : null;
  const endsAt = fight.homepagePromotionEndsAt ? new Date(fight.homepagePromotionEndsAt) : null;
  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt.getTime() > now.getTime()) return false;
  if (endsAt && !Number.isNaN(endsAt.getTime()) && endsAt.getTime() < now.getTime()) return false;
  return true;
}

function compareHomepagePromotedFights(a = {}, b = {}) {
  const rankDiff = Number(b.homepagePromotionRank || 0) - Number(a.homepagePromotionRank || 0);
  if (rankDiff) return rankDiff;
  const toTime = (value) => {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
  };
  const aMatch = toTime(a.matchDate);
  const bMatch = toTime(b.matchDate);
  if (aMatch && bMatch && aMatch !== bMatch) return aMatch - bMatch;
  return Math.max(toTime(b.homepagePromotionUpdatedAt), toTime(b.updatedAt), toTime(b.createdAt))
    - Math.max(toTime(a.homepagePromotionUpdatedAt), toTime(a.updatedAt), toTime(a.createdAt));
}

async function resolveFightDocumentForAdminPromotion(id, requestedSourceType = '') {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const source = String(requestedSourceType || '').toLowerCase();
  if (source === 'shadow') {
    const shadow = await Shadow.findById(id).populate('fighterAId fighterBId');
    return shadow ? { model: Shadow, doc: shadow, sourceType: 'shadow' } : null;
  }
  if (source === 'match' || source === 'live') {
    const match = await Match.findById(id).populate('fighterAId fighterBId');
    return match ? { model: Match, doc: match, sourceType: 'match' } : null;
  }
  const match = await Match.findById(id).populate('fighterAId fighterBId');
  if (match) return { model: Match, doc: match, sourceType: 'match' };
  const shadow = await Shadow.findById(id).populate('fighterAId fighterBId');
  if (shadow) return { model: Shadow, doc: shadow, sourceType: 'shadow' };
  return null;
}

function getHomepagePromotionUpdate(req) {
  const promoted = parseHomepagePromotionBoolean(
    req.body?.homepagePromoted ?? req.body?.promoted ?? req.body?.isPromoted,
    true,
  );
  const now = new Date();
  const update = {
    homepagePromoted: promoted,
    homepagePromotionUpdatedAt: now,
    homepagePromotionUpdatedBy: req.admin?.id || req.admin?._id || req.admin?.email || 'admin',
  };
  if (req.body?.rank !== undefined || req.body?.homepagePromotionRank !== undefined) {
    update.homepagePromotionRank = Number(req.body?.homepagePromotionRank ?? req.body?.rank) || 0;
  }
  if (req.body?.title !== undefined || req.body?.homepagePromotionTitle !== undefined) update.homepagePromotionTitle = String(req.body?.homepagePromotionTitle ?? req.body?.title ?? '').trim();
  if (req.body?.subtitle !== undefined || req.body?.homepagePromotionSubtitle !== undefined) update.homepagePromotionSubtitle = String(req.body?.homepagePromotionSubtitle ?? req.body?.subtitle ?? '').trim();
  if (req.body?.ctaLabel !== undefined || req.body?.homepagePromotionCtaLabel !== undefined) update.homepagePromotionCtaLabel = String(req.body?.homepagePromotionCtaLabel ?? req.body?.ctaLabel ?? '').trim();
  if (req.body?.calendarSource !== undefined || req.body?.homepagePromotionCalendarSource !== undefined) update.homepagePromotionCalendarSource = String(req.body?.homepagePromotionCalendarSource ?? req.body?.calendarSource ?? '').trim();
  if (req.body?.externalSourceUrl !== undefined || req.body?.homepagePromotionExternalSourceUrl !== undefined) update.homepagePromotionExternalSourceUrl = String(req.body?.homepagePromotionExternalSourceUrl ?? req.body?.externalSourceUrl ?? '').trim();
  const startsAt = parseOptionalPromotionDate(req.body?.startsAt ?? req.body?.homepagePromotionStartsAt);
  const endsAt = parseOptionalPromotionDate(req.body?.endsAt ?? req.body?.homepagePromotionEndsAt);
  if (startsAt !== undefined) update.homepagePromotionStartsAt = startsAt;
  if (endsAt !== undefined) update.homepagePromotionEndsAt = endsAt;
  return update;
}

app.patch('/api/admin/fights/:id/homepage-promotion', verifyAdminToken, async (req, res) => {
  try {
    const resolved = await resolveFightDocumentForAdminPromotion(req.params.id, req.body?.sourceType || req.query.sourceType);
    if (!resolved) return res.status(404).json({ ok: false, message: 'Fight not found.' });
    const update = getHomepagePromotionUpdate(req);
    Object.assign(resolved.doc, update);
    await resolved.doc.save();
    clearPublicResponseCache();
    res.json({
      ok: true,
      sourceType: resolved.sourceType,
      fight: pickPublicFightFields(resolved.doc, resolved.sourceType),
      message: update.homepagePromoted ? 'Fight promoted on homepage banner.' : 'Fight removed from homepage banner.',
    });
  } catch (error) {
    console.error('Error updating homepage promotion:', error);
    res.status(500).json({ ok: false, message: 'Failed to update homepage promotion.' });
  }
});

app.post('/api/admin/fights/:id/homepage-promotion', verifyAdminToken, async (req, res) => {
  try {
    const resolved = await resolveFightDocumentForAdminPromotion(req.params.id, req.body?.sourceType || req.query.sourceType);
    if (!resolved) return res.status(404).json({ ok: false, message: 'Fight not found.' });
    const update = getHomepagePromotionUpdate({ body: { ...(req.body || {}), homepagePromoted: req.body?.homepagePromoted ?? req.body?.promoted ?? true }, admin: req.admin });
    Object.assign(resolved.doc, update);
    await resolved.doc.save();
    clearPublicResponseCache();
    res.status(201).json({
      ok: true,
      sourceType: resolved.sourceType,
      fight: pickPublicFightFields(resolved.doc, resolved.sourceType),
      message: 'Fight promoted on homepage banner.',
    });
  } catch (error) {
    console.error('Error creating homepage promotion:', error);
    res.status(500).json({ ok: false, message: 'Failed to create homepage promotion.' });
  }
});

app.get('/api/public/homepage/promoted-fights', async (req, res) => {
  try {
    const { payload, cacheState } = await readThroughPublicCache(
      getPublicCacheKey(req, 'public-homepage-promoted-fights'),
      async () => {
        const limit = parsePositiveInteger(req.query.limit, 8, 24);
        const now = new Date();
        const visiblePromotedFilter = applyFightPublicVisibilityFilter({ homepagePromoted: true }, { playable: 'true' });
        const queryLimit = Math.min(Math.max(limit * 4, limit), 120);
        const [matches, shadows] = await Promise.all([
          applyFightFreshSortLean(Match.find(visiblePromotedFilter).populate('fighterAId fighterBId')).limit(queryLimit),
          applyFightFreshSortLean(Shadow.find(visiblePromotedFilter).populate('fighterAId fighterBId')).limit(queryLimit).catch(() => []),
        ]);
        const items = [
          ...matches.map((fight) => pickPublicFightFields(fight, 'match')),
          ...shadows.map((fight) => pickPublicFightFields(fight, 'shadow')),
        ]
          .filter((fight) => isHomepagePromotionVisible(fight, now))
          .sort(compareHomepagePromotedFights)
          .slice(0, limit);
        return { ok: true, items, count: items.length, generatedAt: now.toISOString() };
      }
    );
    setPublicCacheHeaders(res, PUBLIC_CACHE_TTL_SECONDS, cacheState);
    res.json(payload);
  } catch (error) {
    console.error('Error loading promoted homepage fights:', error);
    res.status(500).json({ ok: false, message: 'Failed to load promoted homepage fights.' });
  }
});

app.get('/api/affiliate/:affiliateId/promoted-fights', async (req, res) => {
  try {
    const affiliateId = String(req.params.affiliateId || '').trim();
    if (!affiliateId) return res.status(400).json({ ok: false, message: 'Affiliate id is required.' });
    const includeClosed = ['true', '1', 'yes'].includes(String(req.query.includeClosed || '').toLowerCase());
    const directMatches = await Match.find({ affiliateId }).populate('fighterAId fighterBId').sort({ updatedAt: -1, createdAt: -1 }).limit(120).lean();
    const shadowFilter = mongoose.Types.ObjectId.isValid(affiliateId)
      ? { 'AffiliateIds.AffiliateId': new mongoose.Types.ObjectId(affiliateId) }
      : { 'AffiliateIds.AffiliateId': affiliateId };
    const shadows = await Shadow.find(shadowFilter).populate('fighterAId fighterBId').sort({ updatedAt: -1, createdAt: -1 }).limit(120).lean().catch(() => []);
    const linkedMatchIds = [...new Set(shadows.flatMap((shadow) => (Array.isArray(shadow.AffiliateIds) ? shadow.AffiliateIds : [])
      .filter((item) => String(item?.AffiliateId || '') === affiliateId || String(item?.AffiliateId?._id || '') === affiliateId)
      .map((item) => String(item?.matchId || item?.matchId?._id || ''))
      .filter((id) => mongoose.Types.ObjectId.isValid(id))))];
    const linkedMatches = linkedMatchIds.length
      ? await Match.find({ _id: { $in: linkedMatchIds } }).populate('fighterAId fighterBId').sort({ updatedAt: -1, createdAt: -1 }).lean()
      : [];

    const byId = new Map();
    [...directMatches, ...linkedMatches].forEach((match) => {
      if (!match || isDraftFightRecord(match)) return;
      if (!includeClosed) {
        const closed = String(match.matchShadowOpenStatus || '').toLowerCase() === 'closed' || String(match.matchStatus || '').toLowerCase() === 'finished';
        if (closed) return;
      }
      byId.set(String(match._id), pickPublicFightFields(match, 'match'));
    });

    res.json({
      ok: true,
      affiliateId,
      items: Array.from(byId.values()).sort(compareHomepagePromotedFights),
      shadowTemplates: shadows.map((shadow) => pickPublicFightFields(shadow, 'shadow')),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error loading affiliate promoted fights:', error);
    res.status(500).json({ ok: false, message: 'Failed to load affiliate promoted fights.' });
  }
});


// PHASE 2: Centralized IONOS swarm gateway routes. Kept isolated in swarm-phase2.js
// so the existing backend code, models, and business rules remain authoritative.
registerSwarmPhase2Routes({
  app,
  mongoose,
  axios,
  crypto,
  verifyAdminToken,
  Blog,
  Notification,
  upload,
  cloudinary,
});



// PHASE 2 SEO/PERFORMANCE: Public SEO data, pagination, sitemap/schema helpers,
// and admin approval endpoints for swarm SEO intelligence. Kept isolated so the
// existing backend routes and business rules remain unchanged.
registerSeoPerformancePhase2Routes({
  app,
  mongoose,
  verifyAdminToken,
  models: {
    Match,
    Shadow,
    Blog,
    News,
    YoutubeVideos,
    Score,
    User,
    ProWrestler,
    ProWrestlingMatch,
  },
});

// PHASE: Safe fight data-quality + combat fighter library helpers. Additive only;
// old match fields/routes stay unchanged and remain the fallback for public pages.
registerFightDataQualityRoutes({
  app,
  mongoose,
  axios,
  upload,
  cloudinary,
  verifyAdminToken,
  Match,
  Shadow,
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

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
