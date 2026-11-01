'use strict';
// TEST ONLY, READ-ONLY: public evidence of whether the legacy automation produces
// anything on the LIVE site. Only GET requests to public endpoints (what any visitor
// sees) plus anonymous status checks of admin endpoints (which must refuse).
const API = 'https://fantasymmadness-game-server-three-taupe.vercel.app';
const SITE = 'https://www.fantasymmadness.com';
const get = async (url) => { const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'FMM-audit-readonly/1.0' } }); let j = null; try { j = await r.json(); } catch { /* not json */ } return { status: r.status, j }; };
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
(async () => {
  const out = {};
  const blogs = await get(`${API}/api/public/blogs?limit=50`);
  const bItems = blogs.j?.items || [];
  out.blogs = { status: blogs.status, total: blogs.j?.pagination?.total ?? bItems.length, newest: bItems.slice(0, 8).map((b) => ({ created: day(b.createdAt), updated: day(b.updatedAt), title: String(b.metaTitle || b.title || '').slice(0, 70) })), automationDraftTitles: bItems.filter((b) => /automation draft/i.test(`${b.metaTitle} ${b.title}`)).length, createdLast30d: bItems.filter((b) => Date.now() - Date.parse(b.createdAt) < 30 * 864e5).length };
  const vids = await get(`${API}/youtubeVideos`);
  const vArr = Array.isArray(vids.j) ? vids.j : (vids.j?.videos || vids.j?.items || []);
  out.videoArchive = { status: vids.status, count: vArr.length, newest: vArr.map((v) => day(v.createdAt || v.updatedAt)).filter(Boolean).sort().slice(-3) };
  const pf = await get(`${API}/api/public/prediction-fights?limit=100`);
  const fights = pf.j?.items || [];
  const auto = fights.filter((f) => f.autoDiscovered);
  out.fights = { status: pf.status, listed: fights.length, autoDiscovered: auto.length, autoDiscoveryLatestSeen: auto.map((f) => day(f.autoDiscoveryLastSeenAt)).filter(Boolean).sort().slice(-1)[0] || null, providers: [...new Set(auto.map((f) => f.autoDiscoveryProvider).filter(Boolean))] };
  const cal = await get(`${API}/api/public/fight-news-calendar`);
  out.fightNewsCalendar = { status: cal.status, keys: cal.j ? Object.keys(cal.j).slice(0, 8) : null, count: cal.j?.count ?? (cal.j?.items || []).length };
  const home = await get(`${API}/api/public/home-summary`);
  out.homeSummary = { status: home.status, keys: home.j ? Object.keys(home.j).slice(0, 12) : null };
  out.adminEndpointsAnonymous = {};
  for (const p of ['/api/admin/swarm/health', '/api/admin/swarm/dashboard', '/api/admin/seo/metadata', '/api/admin/fan-acquisition/campaigns', '/api/admin/revenue/summary', '/api/admin/analytics/ga4', '/api/admin/swarm/growth/july-10000/dashboard']) out.adminEndpointsAnonymous[p] = (await get(`${API}${p}`)).status;
  out.websitePages = {};
  for (const p of ['/blogs', '/administration/swarm', '/administration/MakePost', '/administration/jarvis']) { const r = await fetch(`${SITE}${p}`, { redirect: 'manual' }); out.websitePages[p] = r.status; }
  console.log('AUDIT_PROBE ' + JSON.stringify(out));
})().catch((e) => { console.log('AUDIT_PROBE_FAILED ' + e.message); process.exit(1); });
