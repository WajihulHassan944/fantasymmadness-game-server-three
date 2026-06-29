'use strict';

/**
 * Phase 2 SEO + Performance backend routes for FantasyMMAdness.
 *
 * This module is intentionally additive. It does not change or remove legacy
 * routes; it exposes new SEO/public-data/admin-approval endpoints that the
 * frontend can adopt in phases 3-5.
 */

const DEFAULT_SITE_URL = 'https://www.fantasymmadness.com';
const PUBLIC_CACHE_SECONDS = Number(process.env.PUBLIC_SEO_CACHE_SECONDS || 60);
const PUBLIC_STALE_SECONDS = Number(process.env.PUBLIC_SEO_STALE_SECONDS || 300);
const MAX_LIMIT = 100;

const STATIC_PUBLIC_PAGES = [
  { path: '/', priority: 1, changefreq: 'daily', label: 'Home' },
  { path: '/upcomingfights', priority: 0.9, changefreq: 'hourly', label: 'Upcoming fights' },
  { path: '/fight-news', priority: 0.8, changefreq: 'daily', label: 'Fight news' },
  { path: '/guides', priority: 0.75, changefreq: 'weekly', label: 'Guides' },
  { path: '/pro-wrestling', priority: 0.85, changefreq: 'daily', label: 'Pro Wrestling' },
  { path: '/pro-wrestling/wrestlers', priority: 0.8, changefreq: 'weekly', label: 'Wrestlers' },
  { path: '/pro-wrestling/history', priority: 0.65, changefreq: 'monthly', label: 'Pro Wrestling history' },
  { path: '/fantasy-mma', priority: 0.9, changefreq: 'weekly', label: 'Fantasy MMA' },
  { path: '/fantasy-boxing', priority: 0.9, changefreq: 'weekly', label: 'Fantasy Boxing' },
  { path: '/fantasy-pro-wrestling', priority: 0.9, changefreq: 'weekly', label: 'Fantasy Pro Wrestling' },
  { path: '/how-to-play', priority: 0.85, changefreq: 'weekly', label: 'How to Play' },
];

const PRIVATE_ROBOTS_DISALLOW = [
  '/administration',
  '/admin',
  '/dashboard',
  '/user-dashboard/private',
  '/api/',
  '/checkout',
  '/login',
  '/signup',
];

function registerSeoPerformancePhase2Routes(options = {}) {
  const {
    app,
    mongoose,
    verifyAdminToken,
    models = {},
  } = options;

  if (!app || !mongoose || !verifyAdminToken) {
    throw new Error('registerSeoPerformancePhase2Routes requires app, mongoose, and verifyAdminToken.');
  }

  const seoModels = buildSeoModels(mongoose);
  const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.locals.seoPerformancePhase2 = {
    buildSitemapData: () => buildSitemapData({ models, seoModels }),
    getPublicMetadata: (query) => resolvePublicMetadata({ query, models, seoModels }),
  };

  // Public SEO and performance data APIs. Frontend Phase 3-5 can consume these
  // to render metadata, sitemap routes, landing pages, cards, and related links.
  app.get('/api/public/seo/health', cachePublicResponse, asyncHandler(async (req, res) => {
    res.json({ ok: true, service: 'fantasymmadness-seo-performance-backend', timestamp: new Date().toISOString() });
  }));

  app.get('/api/public/seo/robots-data', cachePublicResponse, asyncHandler(async (req, res) => {
    const siteUrl = getSiteUrl(req);
    res.json({
      ok: true,
      robots: {
        userAgent: '*',
        allow: ['/'],
        disallow: PRIVATE_ROBOTS_DISALLOW,
        sitemaps: [`${siteUrl}/sitemap.xml`],
      },
    });
  }));

  app.get('/api/public/seo/sitemap-data', cachePublicResponse, asyncHandler(async (req, res) => {
    const data = await buildSitemapData({ models, seoModels, req, type: req.query.type });
    res.json({ ok: true, ...data });
  }));

  app.get('/api/public/seo/metadata', cachePublicResponse, asyncHandler(async (req, res) => {
    const metadata = await resolvePublicMetadata({ query: req.query, req, models, seoModels });
    res.json({ ok: true, metadata });
  }));

  app.get('/api/public/seo/schema', cachePublicResponse, asyncHandler(async (req, res) => {
    const schema = await resolveStructuredData({ query: req.query, req, models, seoModels });
    if (!schema) return res.status(404).json({ ok: false, code: 'SCHEMA_TARGET_NOT_FOUND', message: 'No schema target found for the supplied entity.' });
    res.json({ ok: true, schema });
  }));

  app.get('/api/public/seo/internal-links', cachePublicResponse, asyncHandler(async (req, res) => {
    const links = await buildInternalLinks({ query: req.query, req, models });
    res.json({ ok: true, ...links });
  }));

  app.get('/api/public/fights', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listFights({ req, Match: models.Match });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/fights/:id', cachePublicResponse, asyncHandler(async (req, res) => {
    const fight = await findFightById(models.Match, req.params.id, req.query);
    if (!fight) return res.status(404).json({ ok: false, code: 'FIGHT_NOT_FOUND', message: 'Fight not found.' });
    const related = await buildInternalLinks({ query: { entityType: 'fight', entityId: req.params.id, limit: 8 }, req, models });
    res.json({ ok: true, fight: serializeFight(fight, req), related });
  }));

  app.get('/api/public/blogs', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listBlogs({ req, Blog: models.Blog });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/blogs/:id/related', cachePublicResponse, asyncHandler(async (req, res) => {
    const related = await findRelatedBlogs({ Blog: models.Blog, blogId: req.params.id, limit: safeLimit(req.query.limit, 6) });
    res.json({ ok: true, items: related });
  }));

  app.get('/api/public/fighters', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listCombatFighters({ req, Match: models.Match });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/wrestlers', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listWrestlers({ req, ProWrestler: models.ProWrestler });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/pro-wrestling/matches', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listProWrestlingMatches({ req, ProWrestlingMatch: models.ProWrestlingMatch });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/videos', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listVideos({ req, YoutubeVideos: models.YoutubeVideos });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/public/leaderboards', cachePublicResponse, asyncHandler(async (req, res) => {
    const result = await listLeaderboards({ req, Score: models.Score });
    res.json({ ok: true, ...result });
  }));

  // Admin SEO storage/review APIs. These let swarm recommendations become
  // reviewable/applyable without giving the swarm direct write access.
  app.get('/api/admin/seo/metadata', verifyAdminToken, asyncHandler(async (req, res) => {
    const filter = buildSeoMetadataFilter(req.query);
    const page = safePage(req.query.page);
    const limit = safeLimit(req.query.limit, 25);
    const total = await seoModels.SEOPageMetadata.countDocuments(filter);
    const items = await seoModels.SEOPageMetadata.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ ok: true, items, pagination: paginationMeta({ page, limit, total }) });
  }));

  app.post('/api/admin/seo/metadata', verifyAdminToken, asyncHandler(async (req, res) => {
    const saved = await upsertSeoMetadata({ seoModels, body: req.body, admin: req.admin });
    res.status(201).json({ ok: true, metadata: saved });
  }));

  app.post('/api/admin/seo/apply', verifyAdminToken, asyncHandler(async (req, res) => {
    const result = await applySeoToTarget({ body: req.body, admin: req.admin, models, seoModels });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/admin/seo/swarm-reports', verifyAdminToken, asyncHandler(async (req, res) => {
    const result = await listSwarmSeoReports({ req, mongoose });
    res.json({ ok: true, ...result });
  }));

  app.post('/api/admin/seo/internal-links/preview', verifyAdminToken, asyncHandler(async (req, res) => {
    const links = await buildInternalLinks({ query: req.body || {}, req, models });
    res.json({ ok: true, ...links });
  }));

  app.get('/api/admin/seo/implementation-roadmap', verifyAdminToken, asyncHandler(async (req, res) => {
    res.json({ ok: true, roadmap: buildSeoImplementationRoadmap() });
  }));

  // Central error response for this module only. Existing global behavior remains unchanged.
  app.use((error, req, res, next) => {
    if (!req.path.startsWith('/api/public/seo') && !req.path.startsWith('/api/public/fights') && !req.path.startsWith('/api/public/blogs') && !req.path.startsWith('/api/public/fighters') && !req.path.startsWith('/api/public/wrestlers') && !req.path.startsWith('/api/public/pro-wrestling') && !req.path.startsWith('/api/public/videos') && !req.path.startsWith('/api/public/leaderboards') && !req.path.startsWith('/api/admin/seo')) {
      return next(error);
    }
    const status = error.statusCode || error.status || 500;
    res.status(status).json({ ok: false, code: error.code || 'SEO_PHASE2_ERROR', message: error.message || 'SEO phase 2 request failed.' });
  });
}

function buildSeoModels(mongoose) {
  const seoPageMetadataSchema = new mongoose.Schema({
    entityType: { type: String, trim: true, lowercase: true, index: true },
    entityId: { type: String, trim: true, index: true },
    path: { type: String, trim: true, index: true },
    canonicalUrl: String,
    metaTitle: String,
    metaDescription: String,
    keywords: [String],
    openGraph: mongoose.Schema.Types.Mixed,
    twitterCard: mongoose.Schema.Types.Mixed,
    schemaMarkup: mongoose.Schema.Types.Mixed,
    internalLinks: [mongoose.Schema.Types.Mixed],
    source: { type: String, default: 'manual' },
    lastAppliedFromArtifactId: String,
    status: { type: String, enum: ['draft', 'approved', 'applied'], default: 'draft', index: true },
    createdBy: mongoose.Schema.Types.Mixed,
    updatedBy: mongoose.Schema.Types.Mixed,
  }, { timestamps: true });

  seoPageMetadataSchema.index({ entityType: 1, entityId: 1 }, { unique: false });
  seoPageMetadataSchema.index({ path: 1 }, { unique: false });

  const seoReportSchema = new mongoose.Schema({
    reportType: { type: String, index: true },
    source: { type: String, default: 'backend' },
    status: { type: String, default: 'generated', index: true },
    payload: mongoose.Schema.Types.Mixed,
    createdBy: mongoose.Schema.Types.Mixed,
  }, { timestamps: true });

  return {
    SEOPageMetadata: mongoose.models.SEOPageMetadata || mongoose.model('SEOPageMetadata', seoPageMetadataSchema),
    SEOAuditReport: mongoose.models.SEOAuditReport || mongoose.model('SEOAuditReport', seoReportSchema),
  };
}

function cachePublicResponse(req, res, next) {
  res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}, stale-while-revalidate=${PUBLIC_STALE_SECONDS}`);
  next();
}

function getSiteUrl(req) {
  const configured = cleanString(process.env.PUBLIC_SITE_URL || process.env.FRONTEND_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL);
  if (configured) return configured.replace(/\/$/, '');
  const host = req?.get?.('x-forwarded-host') || req?.get?.('host');
  if (host && !String(host).includes('localhost')) {
    const proto = req?.get?.('x-forwarded-proto') || 'https';
    return `${proto}://${host}`.replace(/\/$/, '');
  }
  return DEFAULT_SITE_URL;
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function safePage(value) {
  const n = Number(value || 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function safeLimit(value, fallback = 20) {
  const n = Number(value || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function paginationMeta({ page, limit, total }) {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasNextPage: page * limit < total,
    hasPrevPage: page > 1,
  };
}

function escapeRegex(value) {
  return cleanString(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordsFromText(value) {
  return cleanString(value).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3).slice(0, 8);
}

function slugify(value) {
  const slug = cleanString(value).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'fantasy-mmadness';
}

function buildSearchFilter(search, fields) {
  const term = escapeRegex(search);
  if (!term) return null;
  return { $or: fields.map((field) => ({ [field]: { $regex: term, $options: 'i' } })) };
}

const FIGHT_DRAFT_STATUSES = ['Draft', 'draft', 'DRAFT'];

function shouldIncludeDraftFights(query = {}) {
  return ['true', '1', 'yes'].includes(String(query.includeDrafts || query.admin || '').toLowerCase());
}

function publicFightVisibilityFilter(query = {}) {
  if (shouldIncludeDraftFights(query)) return null;
  return {
    $and: [
      { matchStatus: { $nin: FIGHT_DRAFT_STATUSES } },
      { status: { $nin: FIGHT_DRAFT_STATUSES } },
      { draft: { $ne: true } },
      { isDraft: { $ne: true } },
      { publicVisible: { $ne: false } },
    ],
  };
}

function mergeMongoFilters(base = {}, extra = null) {
  if (!extra) return base;
  const pieces = [];
  if (Object.keys(base || {}).length) pieces.push(base);
  if (Array.isArray(extra.$and)) pieces.push(...extra.$and); else pieces.push(extra);
  return pieces.length ? { $and: pieces } : {};
}

function buildFightFilter(query = {}) {
  const filter = {};
  const sport = cleanString(query.sport || query.category || query.matchCategory).toLowerCase();
  if (sport && sport !== 'all') filter.matchCategory = sport;
  if (query.status) filter.matchStatus = query.status;
  if (query.openStatus) filter.matchShadowOpenStatus = query.openStatus;
  if (query.shadowStatus) filter.matchShadowStatus = query.shadowStatus;
  const searchFilter = buildSearchFilter(query.search, ['matchName', 'matchFighterA', 'matchFighterB', 'matchDescription']);
  if (searchFilter) Object.assign(filter, searchFilter);
  return mergeMongoFilters(filter, publicFightVisibilityFilter(query));
}

function fightSort(query = {}) {
  const sort = cleanString(query.sort || 'fresh').toLowerCase();
  if (sort === 'upcoming') return { matchDate: 1, updatedAt: -1, createdAt: -1, _id: -1 };
  if (sort === 'oldest') return { createdAt: 1, _id: 1 };
  if (sort === 'date_desc') return { matchDate: -1, updatedAt: -1, createdAt: -1, _id: -1 };
  return { matchStatus: -1, matchShadowOpenStatus: -1, updatedAt: -1, createdAt: -1, matchDate: -1, _id: -1 };
}

async function listFights({ req, Match }) {
  if (!Match) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 20);
  const filter = buildFightFilter(req.query);
  const total = await Match.countDocuments(filter);
  const docs = await Match.find(filter).sort(fightSort(req.query)).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((fight) => serializeFight(fight, req)), pagination: paginationMeta({ page, limit, total }) };
}

async function findFightById(Match, id, query = {}) {
  if (!Match || !cleanString(id)) return null;
  if (!id.match(/^[a-f0-9]{24}$/i)) return null;
  const filter = mergeMongoFilters({ _id: id }, publicFightVisibilityFilter(query));
  return Match.findOne(filter).lean();
}

function serializeFight(fight, req) {
  const id = String(fight?._id || '');
  const title = cleanString(fight?.matchName) || `${cleanString(fight?.matchFighterA)} vs ${cleanString(fight?.matchFighterB)}`.trim();
  return {
    id,
    title,
    slug: `${slugify(title)}-${id.slice(-6)}`,
    sport: cleanString(fight?.matchCategory || fight?.matchCategoryTwo || 'combat').toLowerCase(),
    status: fight?.matchStatus,
    openStatus: fight?.matchShadowOpenStatus,
    shadowStatus: fight?.matchShadowStatus,
    fighterA: { name: fight?.matchFighterA, image: fight?.fighterAImage },
    fighterB: { name: fight?.matchFighterB, image: fight?.fighterBImage },
    description: fight?.matchDescription,
    date: fight?.matchDate,
    time: fight?.matchTime,
    videoUrl: fight?.matchVideoUrl,
    promotionalVideoUrl: fight?.matchPromotionalVideoUrl,
    image: fight?.promotionBackground || fight?.fighterAImage || fight?.fighterBImage,
    updatedAt: fight?.updatedAt,
    createdAt: fight?.createdAt,
    seoUrl: `${getSiteUrl(req)}/fights/${id}`,
  };
}

async function listBlogs({ req, Blog }) {
  if (!Blog) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 12);
  const filter = {};
  const searchFilter = buildSearchFilter(req.query.search || req.query.category, ['metaTitle', 'metaDescription', 'header', 'sections.title', 'sections.content']);
  if (searchFilter) Object.assign(filter, searchFilter);
  const total = await Blog.countDocuments(filter);
  const docs = await Blog.find(filter).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((blog) => serializeBlog(blog, req)), pagination: paginationMeta({ page, limit, total }) };
}

function serializeBlog(blog, req) {
  const id = String(blog?._id || '');
  const title = cleanString(blog?.metaTitle || blog?.header || 'Fantasy MMAdness Blog');
  return {
    id,
    title,
    slug: `${slugify(title)}-${id.slice(-6)}`,
    metaTitle: blog?.metaTitle,
    metaDescription: blog?.metaDescription,
    header: blog?.header,
    image: blog?.blogHeaderImage,
    excerpt: blog?.metaDescription || cleanString(blog?.sections?.[0]?.content).slice(0, 180),
    updatedAt: blog?.updatedAt,
    createdAt: blog?.createdAt,
    seoUrl: `${getSiteUrl(req)}/fight-news/${id}`,
  };
}

async function findRelatedBlogs({ Blog, blogId, limit = 6 }) {
  if (!Blog || !blogId?.match?.(/^[a-f0-9]{24}$/i)) return [];
  const source = await Blog.findById(blogId).lean();
  if (!source) return [];
  const terms = wordsFromText(`${source.metaTitle || ''} ${source.header || ''} ${source.metaDescription || ''}`);
  const filter = { _id: { $ne: source._id } };
  if (terms.length) {
    const regex = terms.map(escapeRegex).join('|');
    filter.$or = [
      { metaTitle: { $regex: regex, $options: 'i' } },
      { header: { $regex: regex, $options: 'i' } },
      { metaDescription: { $regex: regex, $options: 'i' } },
    ];
  }
  const docs = await Blog.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean();
  return docs.map((blog) => ({ id: String(blog._id), title: blog.metaTitle || blog.header, description: blog.metaDescription, image: blog.blogHeaderImage }));
}

async function listCombatFighters({ req, Match }) {
  if (!Match) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 24);
  const filter = buildFightFilter({ sport: req.query.sport || req.query.category });
  const matches = await Match.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(2000).lean();
  const fighters = new Map();
  for (const match of matches) {
    addFighterToMap(fighters, match.matchFighterA, match.fighterAImage, match.matchCategory, match.updatedAt || match.createdAt);
    addFighterToMap(fighters, match.matchFighterB, match.fighterBImage, match.matchCategory, match.updatedAt || match.createdAt);
  }
  let items = Array.from(fighters.values());
  const search = cleanString(req.query.search).toLowerCase();
  if (search) items = items.filter((fighter) => fighter.name.toLowerCase().includes(search));
  items.sort((a, b) => Number(new Date(b.lastSeenAt || 0)) - Number(new Date(a.lastSeenAt || 0)) || a.name.localeCompare(b.name));
  const total = items.length;
  items = items.slice((page - 1) * limit, page * limit);
  return { items, pagination: paginationMeta({ page, limit, total }) };
}

function addFighterToMap(map, name, image, sport, lastSeenAt) {
  const cleanName = cleanString(name);
  if (!cleanName) return;
  const key = cleanName.toLowerCase();
  const existing = map.get(key) || { id: slugify(cleanName), name: cleanName, image: '', sports: [], lastSeenAt: null };
  if (image && !existing.image) existing.image = image;
  if (sport && !existing.sports.includes(sport)) existing.sports.push(sport);
  if (!existing.lastSeenAt || Number(new Date(lastSeenAt || 0)) > Number(new Date(existing.lastSeenAt || 0))) existing.lastSeenAt = lastSeenAt;
  map.set(key, existing);
}

async function listWrestlers({ req, ProWrestler }) {
  if (!ProWrestler) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 24);
  const filter = {};
  if (req.query.active !== undefined) filter.active = String(req.query.active) !== 'false';
  const searchFilter = buildSearchFilter(req.query.search, ['displayName', 'promotion', 'country', 'wrestlingStyle', 'biography']);
  if (searchFilter) Object.assign(filter, searchFilter);
  const total = await ProWrestler.countDocuments(filter);
  const docs = await ProWrestler.find(filter).sort({ featured: -1, updatedAt: -1, displayName: 1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((w) => ({ id: String(w._id), slug: w.slug, name: w.displayName, image: w.profileImage, bannerImage: w.bannerImage, promotion: w.promotion, country: w.country, style: w.wrestlingStyle, featured: w.featured, seo: w.seo, updatedAt: w.updatedAt })), pagination: paginationMeta({ page, limit, total }) };
}

async function listProWrestlingMatches({ req, ProWrestlingMatch }) {
  if (!ProWrestlingMatch) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 20);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.publicVisible !== undefined) filter.publicVisible = String(req.query.publicVisible) !== 'false';
  const searchFilter = buildSearchFilter(req.query.search, ['eventName', 'promotionName', 'matchTitle', 'description', 'competitorA.displayName', 'competitorB.displayName']);
  if (searchFilter) Object.assign(filter, searchFilter);
  const total = await ProWrestlingMatch.countDocuments(filter);
  const docs = await ProWrestlingMatch.find(filter).sort({ featured: -1, matchDate: -1, updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((m) => ({ id: String(m._id), slug: m.slug, title: m.matchTitle, eventName: m.eventName, promotionName: m.promotionName, competitorA: m.competitorA, competitorB: m.competitorB, status: m.status, matchDate: m.matchDate, matchTime: m.matchTime, featured: m.featured, publicVisible: m.publicVisible, bannerImage: m.bannerImage, seo: m.seo, updatedAt: m.updatedAt })), pagination: paginationMeta({ page, limit, total }) };
}

async function listVideos({ req, YoutubeVideos }) {
  if (!YoutubeVideos) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 20);
  const total = await YoutubeVideos.countDocuments({});
  const docs = await YoutubeVideos.find({}).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((v) => ({ id: String(v._id), videoUrl: v.videoUrl })), pagination: paginationMeta({ page, limit, total }) };
}

async function listLeaderboards({ req, Score }) {
  if (!Score) return emptyPaginated(req);
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 25);
  const filter = {};
  if (req.query.matchId) filter.matchId = String(req.query.matchId);
  const total = await Score.countDocuments(filter);
  const docs = await Score.find(filter).sort({ _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs.map((s) => ({ id: String(s._id), playerId: s.playerId, matchId: s.matchId, predictionCount: Array.isArray(s.predictions) ? s.predictions.length : 0 })), pagination: paginationMeta({ page, limit, total }) };
}

function emptyPaginated(req) {
  const page = safePage(req?.query?.page);
  const limit = safeLimit(req?.query?.limit, 20);
  return { items: [], pagination: paginationMeta({ page, limit, total: 0 }) };
}

async function buildSitemapData({ models, seoModels, req, type = 'all' }) {
  const siteUrl = getSiteUrl(req);
  const normalizedType = cleanString(type || 'all').toLowerCase();
  const sections = {};

  if (normalizedType === 'all' || normalizedType === 'static') {
    sections.static = STATIC_PUBLIC_PAGES.map((page) => ({ ...page, url: `${siteUrl}${page.path}`, lastmod: new Date().toISOString() }));
  }
  if ((normalizedType === 'all' || normalizedType === 'fights') && models.Match) {
    const fights = await models.Match.find(mergeMongoFilters({}, publicFightVisibilityFilter({}))).sort({ updatedAt: -1, createdAt: -1 }).limit(1000).lean();
    sections.fights = fights.map((fight) => ({ url: `${siteUrl}/fights/${fight._id}`, lastmod: dateToIso(fight.updatedAt || fight.createdAt || fight.matchDate), priority: 0.85, changefreq: fight.matchStatus === 'Ongoing' ? 'hourly' : 'weekly', title: fight.matchName || `${fight.matchFighterA} vs ${fight.matchFighterB}` }));
  }
  if ((normalizedType === 'all' || normalizedType === 'blogs') && models.Blog) {
    const blogs = await models.Blog.find({}).sort({ updatedAt: -1, createdAt: -1 }).limit(1000).lean();
    sections.blogs = blogs.map((blog) => ({ url: `${siteUrl}/fight-news/${blog._id}`, lastmod: dateToIso(blog.updatedAt || blog.createdAt), priority: 0.75, changefreq: 'weekly', title: blog.metaTitle || blog.header }));
  }
  if ((normalizedType === 'all' || normalizedType === 'wrestlers') && models.ProWrestler) {
    const wrestlers = await models.ProWrestler.find({ active: { $ne: false } }).sort({ updatedAt: -1 }).limit(1000).lean();
    sections.wrestlers = wrestlers.map((w) => ({ url: `${siteUrl}/pro-wrestling/wrestlers/${w.slug || w._id}`, lastmod: dateToIso(w.updatedAt || w.createdAt), priority: 0.7, changefreq: 'weekly', title: w.displayName }));
  }
  if ((normalizedType === 'all' || normalizedType === 'pro-wrestling-matches') && models.ProWrestlingMatch) {
    const matches = await models.ProWrestlingMatch.find({ publicVisible: { $ne: false } }).sort({ updatedAt: -1, matchDate: -1 }).limit(1000).lean();
    sections.proWrestlingMatches = matches.map((m) => ({ url: `${siteUrl}/pro-wrestling/matches/${m.slug || m._id}`, lastmod: dateToIso(m.updatedAt || m.createdAt || m.matchDate), priority: 0.78, changefreq: m.status === 'PUBLISHED' || m.status === 'LIVE' ? 'hourly' : 'weekly', title: m.matchTitle }));
  }

  const customMetadata = await seoModels.SEOPageMetadata.find({ path: { $exists: true, $ne: '' }, status: { $in: ['approved', 'applied'] } }).sort({ updatedAt: -1 }).limit(1000).lean();
  sections.customSeoPages = customMetadata.map((item) => ({ url: item.canonicalUrl || `${siteUrl}${item.path.startsWith('/') ? item.path : `/${item.path}`}`, lastmod: dateToIso(item.updatedAt || item.createdAt), priority: 0.7, changefreq: 'weekly', title: item.metaTitle }));

  return { siteUrl, generatedAt: new Date().toISOString(), sections };
}

function dateToIso(date) {
  const parsed = date ? new Date(date) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

async function resolvePublicMetadata({ query, req, models, seoModels }) {
  const path = cleanString(query.path);
  const entityType = cleanString(query.entityType).toLowerCase();
  const entityId = cleanString(query.entityId);
  const siteUrl = getSiteUrl(req);

  let saved = null;
  if (entityType && entityId) saved = await seoModels.SEOPageMetadata.findOne({ entityType, entityId }).sort({ updatedAt: -1 }).lean();
  if (!saved && path) saved = await seoModels.SEOPageMetadata.findOne({ path }).sort({ updatedAt: -1 }).lean();
  if (saved) return serializeMetadata(saved, siteUrl);

  return fallbackMetadata({ path, entityType, entityId, siteUrl });
}

function serializeMetadata(item, siteUrl) {
  return {
    entityType: item.entityType,
    entityId: item.entityId,
    path: item.path,
    canonicalUrl: item.canonicalUrl || (item.path ? `${siteUrl}${item.path}` : undefined),
    title: item.metaTitle,
    description: item.metaDescription,
    keywords: item.keywords || [],
    openGraph: item.openGraph,
    twitterCard: item.twitterCard,
    schemaMarkup: item.schemaMarkup,
    status: item.status,
    updatedAt: item.updatedAt,
  };
}

function fallbackMetadata({ path, entityType, siteUrl }) {
  const label = path === '/' ? 'Fantasy MMAdness' : cleanString(path || entityType || 'Fantasy MMAdness').replace(/^\//, '').replace(/[-/]+/g, ' ');
  const title = `${capitalizeWords(label)} | Fantasy MMAdness`;
  return {
    canonicalUrl: path ? `${siteUrl}${path.startsWith('/') ? path : `/${path}`}` : siteUrl,
    title,
    description: 'Fantasy MMAdness brings fantasy MMA, boxing, combat sports, and pro-wrestling fight opportunities, previews, news, and play-to-compete experiences.',
    keywords: ['fantasy mma', 'fantasy boxing', 'combat sports', 'pro wrestling', 'fight predictions'],
    source: 'fallback',
  };
}

function capitalizeWords(value) {
  return cleanString(value).replace(/\b\w/g, (c) => c.toUpperCase());
}

async function resolveStructuredData({ query, req, models }) {
  const entityType = cleanString(query.entityType).toLowerCase();
  const entityId = cleanString(query.entityId);
  const siteUrl = getSiteUrl(req);

  if (entityType === 'fight' && models.Match) {
    const fight = await findFightById(models.Match, entityId);
    if (!fight) return null;
    return buildSportsEventSchema(serializeFight(fight, req), siteUrl);
  }
  if (entityType === 'blog' && models.Blog && entityId.match(/^[a-f0-9]{24}$/i)) {
    const blog = await models.Blog.findById(entityId).lean();
    if (!blog) return null;
    return buildArticleSchema(serializeBlog(blog, req), siteUrl);
  }
  if (entityType === 'wrestler' && models.ProWrestler) {
    const wrestler = await models.ProWrestler.findOne(entityId.match(/^[a-f0-9]{24}$/i) ? { _id: entityId } : { slug: entityId }).lean();
    if (!wrestler) return null;
    return { '@context': 'https://schema.org', '@type': 'Person', name: wrestler.displayName, image: wrestler.profileImage, description: wrestler.biography, url: `${siteUrl}/pro-wrestling/wrestlers/${wrestler.slug || wrestler._id}` };
  }
  return buildWebsiteSchema(siteUrl);
}

function buildWebsiteSchema(siteUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Fantasy MMAdness',
    url: siteUrl,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteUrl}/search?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

function buildSportsEventSchema(fight, siteUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: fight.title,
    sport: fight.sport,
    startDate: fight.date,
    eventStatus: fight.status === 'Finished' ? 'https://schema.org/EventCompleted' : 'https://schema.org/EventScheduled',
    url: `${siteUrl}/fights/${fight.id}`,
    image: fight.image,
    competitor: [fight.fighterA?.name, fight.fighterB?.name].filter(Boolean).map((name) => ({ '@type': 'SportsTeam', name })),
    description: fight.description,
  };
}

function buildArticleSchema(blog, siteUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: blog.title,
    description: blog.metaDescription || blog.excerpt,
    image: blog.image,
    datePublished: blog.createdAt,
    dateModified: blog.updatedAt,
    url: `${siteUrl}/fight-news/${blog.id}`,
    publisher: { '@type': 'Organization', name: 'Fantasy MMAdness', url: siteUrl },
  };
}

async function buildInternalLinks({ query, req, models }) {
  const limit = safeLimit(query.limit, 8);
  const entityType = cleanString(query.entityType).toLowerCase();
  const entityId = cleanString(query.entityId);
  const siteUrl = getSiteUrl(req);
  const output = { entityType, entityId, items: [] };

  let terms = wordsFromText(query.topic || query.title || query.keywords);
  if (entityType === 'fight' && models.Match) {
    const fight = await findFightById(models.Match, entityId);
    if (fight) terms = wordsFromText(`${fight.matchName} ${fight.matchFighterA} ${fight.matchFighterB} ${fight.matchCategory} ${fight.matchDescription}`);
  }
  if (entityType === 'blog' && models.Blog && entityId.match(/^[a-f0-9]{24}$/i)) {
    const blog = await models.Blog.findById(entityId).lean();
    if (blog) terms = wordsFromText(`${blog.metaTitle} ${blog.header} ${blog.metaDescription}`);
  }

  const regex = terms.length ? terms.map(escapeRegex).join('|') : '';
  if (models.Blog) {
    const filter = regex ? { $or: [{ metaTitle: { $regex: regex, $options: 'i' } }, { header: { $regex: regex, $options: 'i' } }, { metaDescription: { $regex: regex, $options: 'i' } }] } : {};
    const blogs = await models.Blog.find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(limit).lean();
    output.items.push(...blogs.map((blog) => ({ type: 'blog', id: String(blog._id), label: blog.metaTitle || blog.header, url: `${siteUrl}/fight-news/${blog._id}` })));
  }
  if (models.Match) {
    const filter = regex ? { $or: [{ matchName: { $regex: regex, $options: 'i' } }, { matchFighterA: { $regex: regex, $options: 'i' } }, { matchFighterB: { $regex: regex, $options: 'i' } }] } : {};
    const fights = await models.Match.find(mergeMongoFilters(filter, publicFightVisibilityFilter({}))).sort(fightSort({ sort: 'fresh' })).limit(limit).lean();
    output.items.push(...fights.map((fight) => ({ type: 'fight', id: String(fight._id), label: fight.matchName || `${fight.matchFighterA} vs ${fight.matchFighterB}`, url: `${siteUrl}/fights/${fight._id}` })));
  }
  return { ...output, items: output.items.slice(0, limit * 2) };
}

function buildSeoMetadataFilter(query = {}) {
  const filter = {};
  if (query.entityType) filter.entityType = cleanString(query.entityType).toLowerCase();
  if (query.entityId) filter.entityId = cleanString(query.entityId);
  if (query.path) filter.path = cleanString(query.path);
  if (query.status) filter.status = cleanString(query.status).toLowerCase();
  return filter;
}

async function upsertSeoMetadata({ seoModels, body = {}, admin }) {
  const entityType = cleanString(body.entityType).toLowerCase();
  const entityId = cleanString(body.entityId);
  const path = cleanString(body.path);
  if (!entityType && !path) throw httpError(400, 'SEO_TARGET_REQUIRED', 'Provide entityType/entityId or path.');
  const filter = entityType && entityId ? { entityType, entityId } : { path };
  const update = {
    $set: {
      entityType,
      entityId,
      path,
      canonicalUrl: cleanString(body.canonicalUrl),
      metaTitle: cleanString(body.metaTitle || body.title),
      metaDescription: cleanString(body.metaDescription || body.description),
      keywords: normalizeStringArray(body.keywords),
      openGraph: body.openGraph || {},
      twitterCard: body.twitterCard || {},
      schemaMarkup: body.schemaMarkup || {},
      internalLinks: Array.isArray(body.internalLinks) ? body.internalLinks : [],
      source: cleanString(body.source || 'manual'),
      status: cleanString(body.status || 'approved').toLowerCase(),
      updatedBy: adminActor(admin),
    },
    $setOnInsert: { createdBy: adminActor(admin) },
  };
  return seoModels.SEOPageMetadata.findOneAndUpdate(filter, update, { new: true, upsert: true }).lean();
}

async function applySeoToTarget({ body = {}, admin, models, seoModels }) {
  const entityType = cleanString(body.entityType || body.targetType).toLowerCase();
  const entityId = cleanString(body.entityId || body.targetId);
  if (!entityType || !entityId) throw httpError(400, 'SEO_TARGET_REQUIRED', 'entityType and entityId are required.');

  const metaTitle = cleanString(body.metaTitle || body.title);
  const metaDescription = cleanString(body.metaDescription || body.description);
  const keywords = normalizeStringArray(body.keywords);
  const payload = { ...body, entityType, entityId, metaTitle, metaDescription, keywords, status: 'applied', source: body.source || 'admin_apply' };

  let appliedEntity = null;
  if (entityType === 'blog' && models.Blog && entityId.match(/^[a-f0-9]{24}$/i)) {
    const blog = await models.Blog.findById(entityId);
    if (!blog) throw httpError(404, 'BLOG_NOT_FOUND', 'Target blog not found.');
    if (metaTitle) blog.metaTitle = metaTitle;
    if (metaDescription) blog.metaDescription = metaDescription;
    await blog.save();
    appliedEntity = { type: 'Blog', id: String(blog._id), fields: ['metaTitle', 'metaDescription'].filter((field) => field === 'metaTitle' ? metaTitle : metaDescription) };
  } else if (entityType === 'wrestler' && models.ProWrestler) {
    const wrestler = await models.ProWrestler.findOne(entityId.match(/^[a-f0-9]{24}$/i) ? { _id: entityId } : { slug: entityId });
    if (!wrestler) throw httpError(404, 'WRESTLER_NOT_FOUND', 'Target wrestler not found.');
    wrestler.seo = wrestler.seo || {};
    if (metaTitle) wrestler.seo.title = metaTitle;
    if (metaDescription) wrestler.seo.description = metaDescription;
    if (keywords.length) wrestler.seo.keywords = keywords;
    await wrestler.save();
    appliedEntity = { type: 'ProWrestler', id: String(wrestler._id), fields: ['seo.title', 'seo.description', 'seo.keywords'] };
  } else if ((entityType === 'pro_wrestling_match' || entityType === 'wrestling_match') && models.ProWrestlingMatch) {
    const match = await models.ProWrestlingMatch.findOne(entityId.match(/^[a-f0-9]{24}$/i) ? { _id: entityId } : { slug: entityId });
    if (!match) throw httpError(404, 'PRO_WRESTLING_MATCH_NOT_FOUND', 'Target pro-wrestling match not found.');
    match.seo = match.seo || {};
    if (metaTitle) match.seo.title = metaTitle;
    if (metaDescription) match.seo.description = metaDescription;
    if (keywords.length) match.seo.keywords = keywords;
    await match.save();
    appliedEntity = { type: 'ProWrestlingMatch', id: String(match._id), fields: ['seo.title', 'seo.description', 'seo.keywords'] };
  }

  const metadata = await upsertSeoMetadata({ seoModels, body: payload, admin });
  return {
    applied: Boolean(appliedEntity),
    action: appliedEntity ? 'applied_to_model_and_seo_metadata' : 'stored_in_seo_metadata_collection',
    entity: appliedEntity,
    metadata,
    note: appliedEntity ? undefined : 'This entity type has no native SEO fields yet, so metadata was stored for frontend Phase 3-5 usage.',
  };
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(cleanString).filter(Boolean);
  return [];
}

function adminActor(admin) {
  return {
    id: cleanString(admin?.id || admin?._id || admin?.adminId),
    email: cleanString(admin?.email),
    role: cleanString(admin?.role || 'admin'),
  };
}

async function listSwarmSeoReports({ req, mongoose }) {
  const page = safePage(req.query.page);
  const limit = safeLimit(req.query.limit, 25);
  const jobTypes = normalizeStringArray(req.query.jobType || 'seo.daily-audit,seo.weekly-traffic-opportunity,seo.missing-meta-detector,seo.low-quality-page-detector,seo.broken-link-detector,seo.keyword-opportunity,analytics.traffic-growth-dashboard');
  const Artifact = mongoose.models.SwarmBackendArtifact;
  const Job = mongoose.models.SwarmBackendJob;
  if (!Artifact && !Job) return { items: [], pagination: paginationMeta({ page, limit, total: 0 }), warning: 'Swarm backend cache models are not registered yet.' };
  const filter = { jobType: { $in: jobTypes } };
  const total = Artifact ? await Artifact.countDocuments(filter) : await Job.countDocuments(filter);
  const docs = Artifact
    ? await Artifact.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean()
    : await Job.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
  return { items: docs, pagination: paginationMeta({ page, limit, total }) };
}

function buildSeoImplementationRoadmap() {
  return [
    { phase: 2, area: 'Backend', items: ['Public paginated APIs', 'Sitemap data', 'Metadata storage', 'Schema endpoints', 'SEO approval/apply APIs', 'Internal-link suggestions'] },
    { phase: 3, area: 'Frontend foundation', items: ['Dynamic metadata', 'Robots/sitemap rendering', 'Image optimization', 'Caching integration', 'Thin-page cleanup'] },
    { phase: 4, area: 'Frontend SEO pages', items: ['Sport landing pages', 'Fight detail pages', 'Fighter/wrestler profiles', 'Blog category pages', 'How-to-play pages'] },
    { phase: 5, area: 'Admin SEO growth center', items: ['SEO reports dashboard', 'Keyword opportunities', 'Old blog refresh queue', 'Content calendar', '1000-user growth tracking'] },
  ];
}

function httpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  registerSeoPerformancePhase2Routes,
  _test: {
    safePage,
    safeLimit,
    slugify,
    fallbackMetadata,
    normalizeStringArray,
    paginationMeta,
  },
};
