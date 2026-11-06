'use strict';
function verifiedCurrentRecipient(lead,now=new Date()){
 const v=lead?.recipientVerification,age=+now-Date.parse(v?.checkedAt||'');
 return Boolean(v?.currentStatusVerified===true&&v.identityMatched===true&&['living_person','active_business'].includes(v.status)&&v.sourceKind==='primary'&&/^https:\/\//.test(v.sourceUrl||'')&&/^[a-f\d]{64}$/i.test(v.sourceHash||'')&&Number.isFinite(age)&&age>=0&&age<14*86400000&&!lead?.outreachHold&&!lead?.deceased);
}
module.exports={verifiedCurrentRecipient};
