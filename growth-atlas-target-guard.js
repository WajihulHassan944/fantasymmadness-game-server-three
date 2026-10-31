'use strict';
// Guard the isolated Atlas database target before opening a connection.
// The URI is never logged.
function validateIsolatedAtlasTarget(uri){
 if(typeof uri!=='string'||!uri.startsWith('mongodb+srv://'))throw Error('Atlas SRV URI required');
 let parsed;
 try{parsed=new URL(uri)}catch{throw Error('Invalid Atlas URI')}
 if(parsed.protocol!=='mongodb+srv:'||!parsed.hostname)throw Error('Atlas host required');
 if(parsed.pathname!=='/fmgrowthtest'&&parsed.pathname!=='/'&&parsed.pathname!=='')throw Error('Unexpected database path');
 return true;
}
module.exports={validateIsolatedAtlasTarget};
