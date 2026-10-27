'use strict';

// Sidecar bootstrap keeps Full Card isolated from the 25k-line legacy server.
// It captures the existing Express app, lets server.js register/start normally,
// then attaches the additive Full Card routes using the already-compiled models.
const expressPath = require.resolve('express');
const expressOriginal = require(expressPath);
let capturedApp = null;
const expressCapture = (...args) => { capturedApp = expressOriginal(...args); capturedApp.use(require('./passive-incident-monitor').passiveIncidentMonitor); capturedApp.use(require('./fan-acquisition-attribution').registrationCapture); capturedApp.use(require('./registration-attempts').attemptRecorder); return capturedApp; };
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
require('./etsy-integration')({app:capturedApp,mongoose,verifyAdminToken});
require('./merchant-statement-routes').registerMerchantStatementRoutes({app:capturedApp,mongoose,verifyAdminToken});
require('./fan-acquisition-attribution').installReports({app:capturedApp,mongoose,verifyAdminToken});
require('./ga4-admin-report')({app:capturedApp,verifyAdminToken});
// Optional acquisition sidecar: failures must never prevent the established back office from booting.
try {
  require('./fan-acquisition-discovery')({app:capturedApp,verifyAdminToken,mongoose});
} catch (error) {
  console.error('[fan-acquisition] Optional module disabled:', error?.message || 'initialization failed');
}
// Registration attempt tracking (admin-only report + limited browser reports).
try {
  require('./registration-attempts').registerRegistrationAttemptRoutes({ app: capturedApp, verifyAdminToken });
} catch (error) {
  console.error('[registration-attempts] Optional routes disabled:', error?.message || 'initialization failed');
}
// Admin Player Recovery (read-mostly; never edits player records). Optional: a failure here
// must never stop the rest of the server from starting.
try {
  require('./player-recovery')({ app: capturedApp, mongoose, verifyAdminToken });
} catch (error) {
  console.error('[player-recovery] Optional module disabled:', error?.message || 'initialization failed');
}
const { registerIncidentRoutes } = require('./admin-incidents');
const { reportIncident } = registerIncidentRoutes({ app: capturedApp, mongoose, verifyAdminToken });
// Read-only proactive inspection; runs only when an authenticated admin requests it.
// Resolve readiness incidents whenever a Match document is saved or updated.
// The write is intentionally fire-and-forget; it cannot block match publishing.
const readinessComplete = fight => {
  const has = value => typeof value === 'string' ? !!value.trim() : !!value;
  return has(fight.matchFighterA) && has(fight.matchFighterB) &&
    has(fight.fighterAImage) && has(fight.fighterBImage);
};
const resolveFightReadiness = async fightId => {
  if (!fightId) return;
  const record=await Match.findById(fightId).select('matchFighterA matchFighterB fighterAImage fighterBImage').lean();
  if (!record || !readinessComplete(record)) return;
  const Incident=mongoose.models.AdminIncident;
  if (Incident) await Incident.updateOne({key:'fight-readiness:'+String(fightId),status:{$ne:'resolved'}},
    {$set:{status:'resolved',resolvedAt:new Date(),resolutionNote:'Verified complete after fight record update.'}});
};
Match.schema.post('save',function(doc){resolveFightReadiness(doc?._id).catch(()=>{});});
for(const operation of ['findOneAndUpdate','updateOne','updateMany','replaceOne']){
  Match.schema.post(operation,function(){
    const query=this.getQuery();
    const id=query?._id;
    if(id && (typeof id==='string' || id.toString))resolveFightReadiness(id).catch(()=>{});
  });
}
const runFightReadinessScan = async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ok:false,message:'Fight readiness scan deferred: database is not connected.'});
    const fights = await Match.find({matchStatus:{$nin:['Finished','Cancelled','Canceled','Deleted']}})
      .select('_id matchName matchFighterA matchFighterB fighterAImage fighterBImage matchDate matchStatus')
      .sort({updatedAt:-1}).limit(250).lean();
    const warnings=[];
    for(const fight of fights){
      const missing=[];
      if(!String(fight.matchFighterA||'').trim())missing.push('fighter A name');
      if(!String(fight.matchFighterB||'').trim())missing.push('fighter B name');
      if(!String(fight.fighterAImage||'').trim())missing.push('fighter A photo');
      if(!String(fight.fighterBImage||'').trim())missing.push('fighter B photo');
      const scheduled=fight.matchDate ? new Date(fight.matchDate) : null;
      const hoursToFight=scheduled && !Number.isNaN(scheduled.getTime()) ? (scheduled.getTime()-Date.now())/3600000 : null;
      // Warn early for incomplete cards due in the next 48 hours; do not
      // manufacture a deadline for TBA or invalid dates.
      if(missing.length && hoursToFight!==null && hoursToFight>=0 && hoursToFight<=48){
        missing.push(hoursToFight<=24?'fight starts within 24 hours':'fight starts within 48 hours');
      }
      if(!missing.length)continue;
      const id=String(fight._id);
      const title='Fight record needs review: '+String(fight.matchName||id).slice(0,100);
      const description='Missing '+missing.join(', ')+'. Verify this fight before promoting it.';
      warnings.push({fightId:id,title,description});
      await reportIncident({key:'fight-readiness:'+id,source:'fight-readiness-scan',severity:'review',title,description,affectedType:'fight',affectedId:id,actionUrl:'/administration/DeleteUpdateMatches?matchId='+encodeURIComponent(id)});
    }
    // A previously reported issue is cleared only when this scan verifies the
    // same fight record is now complete. No changes to the fight itself.
    // Recheck all outstanding readiness incidents by exact record ID, even when
    // their fights fall outside the latest-250 scan window.
    const Incident=mongoose.models.AdminIncident;
    if(Incident){
      const open=await Incident.find({source:'fight-readiness-scan',status:{$ne:'resolved'}}).select('affectedId').limit(1000).lean();
      const outside=open.map(x=>String(x.affectedId||'')).filter(id=>mongoose.isValidObjectId(id) && !fights.some(f=>String(f._id)===id));
      if(outside.length){
        const records=await Match.find({_id:{$in:outside}}).select('_id matchFighterA matchFighterB fighterAImage fighterBImage').lean();
        const byId=new Map(records.map(x=>[String(x._id),x]));
        const clear=outside.filter(id=>!byId.has(id)||readinessComplete(byId.get(id)));
        if(clear.length)await Incident.updateMany({key:{$in:clear.map(id=>'fight-readiness:'+id)},status:{$ne:'resolved'}},
          {$set:{status:'resolved',resolvedAt:new Date(),resolutionNote:'Verified complete or removed from registry by readiness rescan.'}});
      }
    }
    const inspectedIds=fights.map(f=>String(f._id));
    const warningIds=new Set(warnings.map(w=>w.fightId));
    const healthyIds=inspectedIds.filter(id=>!warningIds.has(id));
    if(Incident && healthyIds.length)await Incident.updateMany({
      key:{$in:healthyIds.map(id=>'fight-readiness:'+id)},status:{$ne:'resolved'}
    },{$set:{status:'resolved',resolvedAt:new Date(),resolutionNote:'Verified by subsequent fight readiness inspection: required names and photos are present.'}});
    res.json({ok:true,inspected:fights.length,warnings,limited:fights.length===250,checkedAt:new Date().toISOString()});
  }catch(error){res.status(500).json({ok:false,message:'Fight readiness inspection failed.'});}
};
capturedApp.get('/api/admin/incidents/scan', verifyAdminToken, runFightReadinessScan);
capturedApp.get('/api/cron/jarvis-health', (req,res,next) => {
  const secret=process.env.CRON_SECRET;
  if(!secret || req.headers.authorization !== 'Bearer '+secret)
    return res.status(401).json({ok:false,message:'Monitoring cron authorization required'});
  return next();
}, runFightReadinessScan);
require('./operations-snapshot').registerOperationsSnapshot({app:capturedApp,mongoose,verifyAdminToken});
const { registerRevenueAnalyticsRoutes } = require('./revenue-analytics');
registerRevenueAnalyticsRoutes({ app: capturedApp, mongoose, verifyAdminToken });

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

capturedApp.post('/api/admin/fights/:fightId/social-poster', verifyAdminToken, upload.single('poster'), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.fightId)) return res.status(400).json({ ok: false, message: 'Invalid fight id.' });
    if (!req.file?.buffer) return res.status(400).json({ ok: false, message: 'Choose a fight poster to upload.' });
    const fight = await Match.findById(req.params.fightId).select('_id').lean();
    if (!fight) return res.status(404).json({ ok: false, message: 'Fight not found.' });
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'fantasymmadness/fight-posters', resource_type: 'image' }, (error, result) => error ? reject(error) : resolve(result));
      stream.end(req.file.buffer);
    });
    await Match.collection.updateOne({ _id: new mongoose.Types.ObjectId(req.params.fightId) }, { $set: { fightPosterImage: uploaded.secure_url, promotionBackground: uploaded.secure_url, fightPosterUpdatedAt: new Date() } });
    return res.status(201).json({ ok: true, poster: uploaded.secure_url });
  } catch (error) { return next(error); }
});

require('./full-card-promoter')({
  app: capturedApp, mongoose, crypto, Affiliate, Match, Score, User,
  verifyToken, verifyAdminToken, requireScope,
  affiliateScope: 'affiliate', playerScope: 'player', calculateClassicPredictionPoints,
  clearPublicResponseCache: () => {}, appOrigin: process.env.APP_ORIGIN || 'https://fantasymmadness.com',
  upload, cloudinary,
});

// Existing affiliate social OAuth and publishing use the canonical fight entry lock.
try {
  require('./affiliate-social').registerAffiliateSocialRoutes({
    app: capturedApp, mongoose, Affiliate, Match, verifyToken, requireScope,
    affiliateScope: 'affiliate',
    isFightOpenForEntry: require('./fight-entry-time').isFightOpenForEntry,
  });
} catch (error) {
  console.error('[affiliate-social] Optional routes unavailable:', error?.message);
}

// Exact-file upload path for large fight posters.
try {
  require('./affiliate-custom-poster').registerPosterDirectUpload({ app: capturedApp, mongoose, verifyAdminToken, cloudinary });
} catch (error) {
  console.error('[poster-direct-upload] Optional routes unavailable:', error?.message);
}

// Custom fight posters for one affiliate (QR placed by the owner, approved
// image attached to that affiliate's email). Optional: if the image library
// cannot load, every other back-office function keeps working.
try {
  require('./affiliate-custom-poster')({
    app: capturedApp, mongoose, verifyAdminToken, cloudinary,
    sharp: require('sharp'), QRCode: require('qrcode'),
  });
} catch (error) {
  console.error('[affiliate-custom-poster] Optional routes unavailable:', error?.message);
}

require('./affiliate-league-roster')({
  app: capturedApp, mongoose, Affiliate, User, verifyToken, requireScope,
  affiliateScope: 'affiliate',
});

