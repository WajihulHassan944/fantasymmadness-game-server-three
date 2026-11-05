'use strict';
const he=require('he');
function readable(value){let s=String(value??'');for(let i=0;i<3;i++){const next=he.decode(s,{isAttributeValue:false});if(next===s)break;s=next;}return s.replace(/\u0000/g,'');}
const GENERIC=/^(?:open|info|support|contact|hello|team|admin|office|sales|press|media|editor|editorial|booking|bookings|business|marketing|podcast|show|company|partners?|partnerships?|mail|enquiries|inquiries|noreply|no-reply)$/i;
function personalFirstName(contact,show={}){
 if(!contact||contact.nameVerified!==true||contact.type!=='person'||!/^https:\/\//.test(contact.nameSource||''))return null;
 const name=readable(contact.name).trim(),first=name.split(/\s+/)[0];
 const mailbox=String(contact.email||'').split('@')[0].replace(/[+._-].*$/,'');
 if(GENERIC.test(mailbox)||GENERIC.test(first)||/\b(?:podcast|media|network|company|inc|llc|studio|productions?|radio|support|contact|team)\b/i.test(name)||name.toLowerCase()===readable(show.title).trim().toLowerCase())return null;
 if(!/^[\p{L}\p{M}'’ -]+$/u.test(name)||!/^\p{L}[\p{L}\p{M}'’-]{1,39}$/u.test(first))return null;
 return first;
}
const greetingFor=(contact,show)=>{const first=personalFirstName(contact,show);return first?`Hi ${first},`:'Hi,';};
module.exports={readable,personalFirstName,greetingFor};
