// PAC link fixer: finds the correct URL for broken case-study links.
// Reads broken links (state gone/soft) from Supabase, fetches each vendor's
// sitemap (incl. robots.txt discovery + deep sub-sitemap crawl), matches every
// broken record to the right URL by company name, and writes suggestions into
// `link_fixes` for review. Never overwrites your data.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role key, never public)

import { bestMatch, slugTokens } from './match.mjs';

const UA = 'Mozilla/5.0 (compatible; PAC-LinkFixer/1.0)';
// Broadened: vendors file case studies under many paths, not just /case-studies.
const CASE_PATH = /(case-stud|customer-stor|customer-success|success-stor|\/stories\/|\/customers?\/|\/clients?\/|\/references?\/|our-work|\/resources?\/)/i;
// Sub-sitemaps whose names hint at customer content get read first.
const RELEVANT = /(customer|stor|resource|case|reference|client|success|work)/i;
const MAX_SUBS = 60;
const MAX_CANDS = 8000;

function env(){
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  return { base: SUPABASE_URL.replace(/\/$/,''), key: SUPABASE_SERVICE_KEY };
}
async function rest(base, key, path){
  const res = await fetch(base+'/rest/v1/'+path, { headers:{ apikey:key, authorization:'Bearer '+key }});
  if(!res.ok) throw new Error('REST '+res.status+' '+(await res.text()));
  return res.json();
}
async function pagedGet(base, key, table, select, extra=''){
  let out=[], offset=0;
  while(true){
    const rows = await rest(base, key, `${table}?select=${select}${extra}&limit=1000&offset=${offset}`);
    out = out.concat(rows);
    if(rows.length<1000) break;
    offset += 1000;
  }
  return out;
}
function domainOf(u){ try{ return new URL(u.startsWith('http')?u:'https://'+u).host.replace(/^www\./,''); }catch{ return null; } }

async function fetchText(url){
  try{
    const r = await fetch(url, { headers:{ 'user-agent':UA, accept:'*/*' }, redirect:'follow' });
    if(!r.ok) return '';
    return await r.text();
  }catch{ return ''; }
}
function locs(xml){ return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m=>m[1]); }

// Find sitemap roots: robots.txt declarations first, then common defaults.
async function sitemapRoots(domain){
  const roots = [];
  for(const host of [`https://www.${domain}`, `https://${domain}`]){
    const robots = await fetchText(host+'/robots.txt');
    if(robots) for(const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.push(m[1]);
  }
  roots.push(`https://www.${domain}/sitemap.xml`, `https://${domain}/sitemap.xml`,
             `https://www.${domain}/sitemap_index.xml`, `https://www.${domain}/sitemap-index.xml`);
  return [...new Set(roots)];
}

async function sitemapUrls(domain){
  const roots = await sitemapRoots(domain);
  let cands=[], seen=new Set();
  for(const root of roots){
    const xml = await fetchText(root);
    if(!xml) continue;
    const entries = locs(xml);
    const subs = entries.filter(u=>/\.xml/i.test(u));
    if(subs.length){
      // read customer/resource-looking sub-sitemaps first
      subs.sort((a,b)=> (RELEVANT.test(b)?1:0)-(RELEVANT.test(a)?1:0));
      const toRead = subs.slice(0, MAX_SUBS);
      for(let b=0;b<toRead.length && cands.length<MAX_CANDS;b+=10){
        const texts = await Promise.all(toRead.slice(b,b+10).map(fetchText));
        for(const sx of texts) for(const u of locs(sx)){
          if(CASE_PATH.test(u) && !seen.has(u)){ seen.add(u); cands.push(u); }
        }
      }
    } else {
      for(const u of entries) if(CASE_PATH.test(u) && !seen.has(u)){ seen.add(u); cands.push(u); }
    }
    if(cands.length) break;
  }
  return cands.filter(u=>slugTokens(u).length>=1);
}

async function upsertFixes(base, key, rows){
  for(let i=0;i<rows.length;i+=500){
    const chunk = rows.slice(i,i+500);
    const res = await fetch(base+'/rest/v1/link_fixes', {
      method:'POST',
      headers:{ apikey:key, authorization:'Bearer '+key, 'content-type':'application/json',
                prefer:'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(chunk)
    });
    if(!res.ok) throw new Error('write '+res.status+' '+(await res.text()));
  }
}

async function main(){
  const { base, key } = env();
  const broken = await pagedGet(base, key, 'link_status', 'study_id,url,state', '&state=in.(gone,soft)');
  const cat = await pagedGet(base, key, 'case_studies', 'id,customer,url');
  const custById = {}; for(const c of cat) custById[c.id] = c.customer;
  console.log(`broken links: ${broken.length}`);

  const byDomain = {};
  for(const b of broken){ const d = domainOf(b.url); if(!d) continue; (byDomain[d]=byDomain[d]||[]).push(b); }
  console.log(`domains to process: ${Object.keys(byDomain).length}`);

  const out=[]; const now=new Date().toISOString();
  for(const [domain, recs] of Object.entries(byDomain)){
    const cands = await sitemapUrls(domain);
    process.stdout.write(`  ${domain}: ${cands.length} candidate urls (${recs.length} broken)\n`);
    for(const r of recs){
      const m = cands.length ? bestMatch(custById[r.study_id]||'', cands) : null;
      out.push({ study_id:r.study_id, customer:custById[r.study_id]||null, old_url:r.url,
        suggested_url: m?m.url:null, confidence: m?m.confidence:'none',
        method: cands.length?'sitemap':'no-sitemap', checked_at:now });
    }
  }
  const c={}; for(const o of out) c[o.confidence]=(c[o.confidence]||0)+1;
  console.log('suggestions by confidence:', c);
  await upsertFixes(base, key, out);
  console.log(`wrote ${out.length} rows to link_fixes.`);
}
main().catch(e=>{ console.error(e.message); process.exit(1); });
