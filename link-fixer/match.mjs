// Matching engine for the link fixer (pure, testable, no network).
export const STOP = new Set([
  'the','inc','inc.','incorporated','corp','corp.','corporation','co','co.','company','companies',
  'group','plc','ag','sa','llc','ltd','ltd.','limited','se','holdings','and','&','of','for','at',
  'a','an','leading','large','major','global','world','worldwide','top','premier','multinational',
  'provider','manufacturer','retailer','distributor','wholesaler','insurer','firm','enterprise',
  'enterprises','organization','organisation','organizations','industries','industry','technology',
  'tech','technologies','services','service','solutions','solution','healthcare','pharmaceutical',
  'financial','beverage','food','energy','media','digital','software','platform','maker','producer'
]);
const ANON = /(anonymous|undisclosed|unnamed|confidential|a leading|a global|a large|a major|a multinational|a fortune)/i;

export function tokens(str){
  return (str||'').toLowerCase()
    .replace(/\([^)]*\)/g,' ')
    .replace(/[^a-z0-9]+/g,' ')
    .split(' ').filter(t=>t && !STOP.has(t));
}
export function slugTokens(url){
  try{
    const path=new URL(url.startsWith('http')?url:'https://'+url).pathname;
    const last=path.replace(/\/+$/,'').split('/').pop()||'';
    return last.toLowerCase().replace(/[^a-z0-9]+/g,' ').split(' ').filter(Boolean);
  }catch{ return []; }
}

export function bestMatch(customer, candidates){
  if(ANON.test(customer||'')) return null;
  const ct = tokens(customer);
  if(!ct.length) return null;
  const primary = ct[0];
  if(primary.length<=2) return null;

  const scored = candidates.map(u=>{
    const sset = new Set(slugTokens(u));
    const overlap = ct.filter(t=>sset.has(t)).length;
    const hasPrimary = sset.has(primary);
    return { url:u, overlap, hasPrimary, score: overlap + (hasPrimary?0.5:0) };
  }).filter(x=>x.overlap>0);
  if(!scored.length) return null;
  scored.sort((a,b)=>b.score-a.score);

  const withPrimary = scored.filter(x=>x.hasPrimary);
  let confidence='low';
  if(withPrimary.length===1 && withPrimary[0]===scored[0]) confidence='high';
  else if(scored[0].overlap===ct.length && ct.length>=2) confidence='high';
  else if(withPrimary.length>=1) confidence='medium';
  return { url: scored[0].url, confidence, score: scored[0].score };
}
