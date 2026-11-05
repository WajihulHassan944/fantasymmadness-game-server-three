'use strict';
// Production Growth host only. Preserve the existing Meta callbacks, poster URLs,
// unsubscribe, verified attribution ingest and every live website/game route.
const HOST='fantasymmadness-growth-isolated-tes.vercel.app';
const SRC='^(/api/growth/(?:health|console(?:/app\\.(?:js|css))?|admin/(?:sso/(?:assertion|revoke)|session|logout|autonomy/(?:stop|resume)|status|overview|drafts|research|affiliates|reports|alerts|audit|attribution|jobs|social|connections|analytics)))$';
function productionRoute(origin){const u=new URL(origin);if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||!/^fantasymmadness-growth-isolated-test-[a-z0-9]+\.vercel\.app$/.test(u.hostname)||u.pathname!=='/')throw Error('verified_growth_deployment_origin_required');return{name:'Growth production preparation only',description:'Owner-authorized preparation endpoints; no website, callback, tracking, posting or payment route changes.',enabled:true,srcSyntax:'regex',route:{src:SRC,dest:u.origin+'$1',has:[{type:'host',value:'^fantasymmadness-growth-isolated-tes\\.vercel\\.app$'}]}};}
function matches(host,path){return host===HOST&&new RegExp(SRC).test(path);}
module.exports={productionRoute,matches,HOST,SRC};
