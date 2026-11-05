'use strict';
const {getFightEntryLockTime}=require('./fight-entry-time');
const zoneValid=z=>{try{new Intl.DateTimeFormat('en',{timeZone:z});return Boolean(z);}catch{return false;}};
const dayIn=(iso,z)=>new Intl.DateTimeFormat('en-CA',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(iso));
function timingFromRegistry(item){
 const errors=[],zone=zoneValid(item.eventTimeZone)?item.eventTimeZone:null;
 if(item.eventTimeZone&&!zone)errors.push('event_timezone_invalid');
 const storedDate=item.matchDate instanceof Date?item.matchDate.toISOString():String(item.matchDate||'');const date=String(item.matchDateKey||storedDate.slice(0,10));
 const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
 if(!validDate(date))errors.push('event_date_invalid');
 if(item.matchDateKey&&item.matchDate&&storedDate.slice(0,10)!==item.matchDateKey)errors.push('event_date_fields_disagree');
 const clock=String(item.matchTime||'').trim();
 if(clock&&(!/^([01]?\d|2[0-3]):[0-5]\d$/.test(clock)))errors.push('registry_time_invalid');
 if(item.timeTba===true&&clock)errors.push('registry_time_tba_conflicts_with_clock');
 let cutoff=null;
 if(item.lockAt&&!/(Z|[+-]\d{2}:\d{2})$/.test(String(item.lockAt)))errors.push('entry_cutoff_timezone_missing');
 if(item.entryClosedAt&&!Number.isFinite(Date.parse(item.entryClosedAt)))errors.push('entry_closed_timestamp_invalid');
 if(item.lockAt||item.timeTba!==true&&clock){const n=getFightEntryLockTime(item);if(!Number.isFinite(n))errors.push('entry_cutoff_invalid');else cutoff=new Date(n).toISOString();}
 const raw=item.eventStartAt||item.eventStartDateTime||null;
 let event=null;
 if(raw){if(!/(Z|[+-]\d{2}:\d{2})$/.test(String(raw))||!Number.isFinite(Date.parse(raw)))errors.push('event_start_invalid_or_timezone_missing');else if(!validDate(String(raw).slice(0,10)))errors.push('event_start_calendar_date_invalid');else event=new Date(raw).toISOString();}
 const source=item.eventTimeSourceUrl||item.eventTiming?.sourceUrl;
 const verified=Boolean(event&&zone&&(item.eventTimeVerified===true||item.eventTiming?.verified===true)&&/^https:\/\//.test(source||''));
 if(verified&&dayIn(event,zone)!==date)errors.push('event_start_date_disagrees_with_registry');
 if(event&&cutoff&&Date.parse(cutoff)>Date.parse(event))errors.push('entry_cutoff_after_event_start');
 return {eventStartAt:verified?event:null,eventTimeVerified:verified,eventTimeSourceUrl:verified?source:null,entryCutoffAt:cutoff,entryTimeZone:zone,eventTimeZone:zone,errors};
}
function validateTiming(c){const t=c.timing;if(!t)return [];const e=[...(t.errors||[])];if(t.eventTimeVerified&&(!t.eventStartAt||!t.eventTimeSourceUrl||!zoneValid(t.eventTimeZone)))e.push('verified_event_time_has_no_evidence');if(t.eventStartAt&&t.entryCutoffAt&&Date.parse(t.entryCutoffAt)>Date.parse(t.eventStartAt))e.push('entry_cutoff_after_event_start');return [...new Set(e)];}
function timeLabel(c){const t=c.timing;if(!t?.eventTimeVerified)return 'Event start time unconfirmed';return 'Event start: '+new Intl.DateTimeFormat('en-US',{timeZone:t.eventTimeZone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(t.eventStartAt));}
function captionTimeErrors(text,c){
 const s=String(text||'').replace(/https?:\/\/\S+/g,''),out=[];const t=c.timing;
 const minutes=(at,zone)=>{if(!at||!zone)return null;const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(at));return Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);};
 const expected=t?.eventTimeVerified?minutes(t.eventStartAt,t.eventTimeZone):null,cutoff=minutes(t?.entryCutoffAt,t?.entryTimeZone);
 for(const m of s.matchAll(/\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi)){
  const n=m[3]?((Number(m[1])%12)+(m[3].toLowerCase()==='pm'?12:0))*60+Number(m[2]||0):Number(m[4])*60+Number(m[5]);
  const line=s.slice(0,m.index).split('\n').pop();if(/entry|entries|cutoff/i.test(line)){if(cutoff===null||n!==cutoff)out.push('caption_entry_cutoff_disagrees');}else if(expected===null)out.push('caption_event_time_unverified');else if(n!==expected)out.push('caption_event_time_disagrees');
 }
 for(const match of s.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g))if(match[0]!==c.dateKey)out.push('caption_event_date_disagrees');
 return [...new Set(out)];
}
module.exports={timingFromRegistry,validateTiming,timeLabel,captionTimeErrors};
