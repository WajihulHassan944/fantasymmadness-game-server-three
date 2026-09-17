'use strict';

// Sidecar bootstrap keeps Full Card isolated from the 25k-line legacy server.
// It captures the existing Express app, lets server.js register/start normally,
// then attaches the additive Full Card routes using the already-compiled models.
const expressPath = require.resolve('express');
const expressOriginal = require(expressPath);
let capturedApp = null;
const expressCapture = (...args) => { capturedApp = expressOriginal(...args); return capturedApp; };
Object.assign(expressCapture, expressOriginal);
require.cache[expressPath].exports = expressCapture;
require('./server');
require.cache[expressPath].exports = expressOriginal;

if (!capturedApp) throw new Error('Full Card bootstrap could not locate the Express application.');

const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

const Affiliate = mongoose.models.Affiliate;
const Match = mongoose.models.Match;
const Score = mongoose.models.Score;
const User = mongoose.models.User;
if (!Affiliate || !Match || !Score || !User) throw new Error('Full Card bootstrap requires Affiliate, Match, Score and User models.');

Affiliate.schema.add({
  promoterRole: { type: String, enum: ['STANDARD', 'PROMOTER', 'PARTNER'], default: 'STANDARD', index: true },
  canCreateFullCards: { type: Boolean, default: false, index: true },
  canOfferFullCardPrize: { type: Boolean, default: false },
  promoterSuspendedAt: { type: Date, default: null },
  promoterVerifiedAt: { type: Date, default: null },
});
Match.schema.add({
  fullCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'FullCard', index: true },
  fullCardBoutOrder: Number,
});

const verifyToken = (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Authentication is required.' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); return next(); }
  catch (_error) { return res.status(403).json({ message: 'Invalid or expired session.' }); }
};
const verifyAdminToken = (req, res, next) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Admin authentication is required.' });
  try { req.admin = jwt.verify(token, process.env.JWT_SECRET_ADMIN); return next(); }
  catch (_error) { return res.status(401).json({ message: 'Invalid or expired admin session.' }); }
};
const requireScope = (...allowed) => (req, res, next) => {
  const scope = String(req.user?.scope || '');
  if (!scope || scope === 'owner-preview' || allowed.includes(scope)) return next();
  return res.status(403).json({ message: 'This account type cannot use that action.' });
};
const normalizeCategory = (value) => {
  const text = String(value || '').toLowerCase();
  return text.includes('box') || text.includes('bare') ? 'boxing' : text.includes('mma') || text.includes('kick') ? 'mma' : text;
};
const calculateClassicPredictionPoints = (predictions = [], one = [], two = [], category = '') => {
  if (!Array.isArray(predictions) || !Array.isArray(one) || !Array.isArray(two)) return 0;
  const sport = normalizeCategory(category);
  return predictions.reduce((total, row, index) => {
    if (!row || !one[index] || !two[index]) return total;
    let score = 0;
    const under = (guess, actual) => { const g = Number(guess); const a = Number(actual); if (Number.isFinite(g) && Number.isFinite(a) && g <= a) score += g; };
    const equal = (guess, actual, award = guess) => { const g = Number(guess); const a = Number(actual); const w = Number(award); if (Number.isFinite(g) && Number.isFinite(a) && g === a && Number.isFinite(w)) score += w; };
    const scoreFighter = (suffix, stats) => {
      if (sport === 'boxing') { under(row[`hpPrediction${suffix}`], stats.HP); under(row[`bpPrediction${suffix}`], stats.BP); under(row[`tpPrediction${suffix}`], stats.TP); }
      else { under(row[`hpPrediction${suffix}`], stats.ST); under(row[`bpPrediction${suffix}`], stats.KI); under(row[`tpPrediction${suffix}`], stats.KN); under(row[`elPrediction${suffix}`], stats.EL); }
      equal(row[`rwPrediction${suffix}`], stats.RW); equal(row[`koPrediction${suffix}`], stats.KO, stats.KO);
    };
    scoreFighter(1, one[index]); scoreFighter(2, two[index]); return total + score;
  }, 0);
};

const signatures = [[0xff,0xd8,0xff],[0x89,0x50,0x4e,0x47],[0x47,0x49,0x46,0x38]];
const rawUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const upload = { single: (field) => (req, res, next) => rawUpload.single(field)(req, res, (error) => {
  if (error) return next(error);
  const b = req.file?.buffer;
  const webp = b && b.slice(0,4).toString('ascii') === 'RIFF' && b.slice(8,12).toString('ascii') === 'WEBP';
  if (b && !webp && !signatures.some((sig) => sig.every((byte, i) => b[i] === byte))) return res.status(415).json({ message: 'Use a JPEG, PNG, GIF or WebP image.' });
  return next();
}) };

require('./full-card-promoter')({
  app: capturedApp, mongoose, crypto, Affiliate, Match, Score, User,
  verifyToken, verifyAdminToken, requireScope,
  affiliateScope: 'affiliate', playerScope: 'player', calculateClassicPredictionPoints,
  clearPublicResponseCache: () => {}, appOrigin: process.env.APP_ORIGIN || 'https://fantasymmadness.com',
  upload, cloudinary,
});

require('./affiliate-league-roster')({
  app: capturedApp, mongoose, Affiliate, User, verifyToken, requireScope,
  affiliateScope: 'affiliate',
});

