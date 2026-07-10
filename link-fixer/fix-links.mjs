// PAC link fixer: finds the correct URL for broken case-study links.
// Reads broken links (state gone/soft) from Supabase, fetches each vendor's
// sitemap, matches every broken record to the right URL by company name, and
// writes suggestions into the `link_fixes` table for review.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service_role key, never public)

import { bestMatch, slugTokens } from './match.mjs';

const UA = 'Mozilla/5.0 (compatible; PAC-LinkFixer/1.0)';
const CASE_PATH = /(case-stud|customer-stor|customer-success|success-stor|\/stories\/|customer\/)/i;

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

async function fetchXml(url){
  try{
    const r = await fetch(url, { headers:{ 'user-agent':UA, accept:'application/xml,text/xml,*/*' }});
    if(!r.ok) return '';
    return await r.text();
  }catch{ return ''; }
}
function locs(xml){ return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m=>m[1]); }

async function sitemapUrls(domain){
  const roots = [`https://www.${domain}/sitemap.xml`, `https://${domain}/sitemap.xml`, `https://www.${domain}/sitemap_index.xml`];
  let all=[], seen=new Set();
  for(const root of roots){
    const xml = await fetchXml(root);
    if(!xml) continue;
    let entries = locs(xml);
    const subs = entries.filter(u=>/\.xml/i.test(u));
    if(subs.length){
      for(const sub of subs.slice(0,25)){
        const sx = await fetchXml(sub);
        for(const u of locs(sx)) if(!seen.has(u)){ seen.add(u); all.push(u); }
      }
    } else {
      for(const u of entries) if(!seen.has(u)){ seen.add(u); all.push(u); }
    }
    if(all.length) break;
  }
  return all.filter(u=>CASE_PATH.test(u) && slugTokens(u).length>=1);
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
  for(const b of broken){
    const d = domainOf(b.url); if(!d) continue;
    (byDomain[d] = byDomain[d] || []).push(b);
  }
  console.log(`domains to process: ${Object.keys(byDomain).length}`);

  const out=[]; const now=new Date().toISOString();
  for(const [domain, recs] of Object.entries(byDomain)){
    const cands = await sitemapUrls(domain);
    if(!cands.length){
      for(const r of recs) out.push({ study_id:r.study_id, customer:custById[r.study_id]||null,
        old_url:r.url, suggested_url:null, confidence:'none', method:'no-sitemap', checked_at:now });
      continue;
    }
    for(const r of recs){
      const m = bestMatch(custById[r.study_id]||'', cands);
      out.push({ study_id:r.study_id, customer:custById[r.study_id]||null, old_url:r.url,
        suggested_url: m?m.url:null, confidence: m?m.confidence:'none', method:'sitemap', checked_at:now });
    }
    process.stdout.write(`  ${domain}: ${cands.length} candidate urls\n`);
  }

  const c = {}; for(const o of out) c[o.confidence]=(c[o.confidence]||0)+1;
  console.log('suggestions by confidence:', c);
  await upsertFixes(base, key, out);
  console.log(`wrote ${out.length} rows to link_fixes.`);
}
main().catch(e=>{ console.error(e.message); process.exit(1); });
