'use strict';
// Guard the isolated Atlas database target before opening a connection.
// The URI is never logged.
function validateIsolatedAtlasTarget(uri,expectedHostname){
 if(typeof uri!=='string'||!uri.startsWith('mongodb+srv://'))throw Error('Atlas SRV URI required');
 let parsed;
 try{parsed=new URL(uri)}catch{throw Error('Invalid Atlas URI')}
 if(parsed.protocol!=='mongodb+srv:'||!parsed.hostname)throw Error('Atlas host required');
 if(expectedHostname!==undefined){
  if(typeof expectedHostname!=='string'||!expectedHostname.trim())throw Error('Dedicated Atlas hostname attestation required');
  if(parsed.hostname.toLowerCase()!==expectedHostname.trim().toLowerCase())throw Error('Atlas host does not match approved staging cluster');
 }
 if(parsed.pathname!=='/fmgrowthtest')throw Error('Explicit fmgrowthtest database path required');
 if(parsed.searchParams.has('authSource')&&parsed.searchParams.get('authSource')!=='fmgrowthtest')throw Error('Unexpected authentication database');
 return true;
}
module.exports={validateIsolatedAtlasTarget};
