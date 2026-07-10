const UA = 'Mozilla/5.0 (compatible; PAC-Harvester/1.0)';
const CASE_PATH = /(case-stud|customer-stor|customer-success|success-stor|\/stories\/|\/customers?\/|\/clients?\/|\/references?\/|our-work)/i;
const RELEVANT = /(customer|stor|resource|case|reference|client|success|work)/i;
const MAX_SUBS = 60, MAX_URLS_PER_DOMAIN = 1200;
const NOT_A_STORY = /^(customers?|customer-stories|case-studies|case-studies-landing|clients?|references?|resources?|stories|success-stories|index|en|us|uk|de|fr|es|it|ja|en-us)$/i;

function env(){
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  return { base: SUPABASE_URL.replace(/\/$/,''), key: SUPABASE_SERVICE_KEY };
}
async function rest(base,key,path){
  const r=await fetch(base+'/rest/v1/'+path,{headers:{apikey:key,authorization:'Bearer '+key}});
  if(!r.ok) throw new Error('REST '+r.status+' '+(await r.text())); return r.json();
}
async function pagedGet(base,key,table,select,extra=''){
  let out=[],off=0;
  while(true){ const rows=await rest(base,key,`${table}?select=${select}${extra}&limit=1000&offset=${off}`);
    out=out.concat(rows); if(rows.length<1000) break; off+=1000; }
  return out;
}
async function fetchText(url){
  try{ const r=await fetch(url,{headers:{'user-agent':UA,accept:'*/*'},redirect:'follow'}); return r.ok?await r.text():''; }catch{ return ''; }
}
const locs = xml => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m=>m[1]);
function domainOf(u){ try{ return new URL(u.startsWith('http')?u:'https://'+u).host.replace(/^www\./,''); }catch{ return null; } }
function norm(u){ try{ const p=new URL(u.startsWith('http')?u:'https://'+u); return (p.host.replace(/^www\./,'')+p.pathname).replace(/\/+$/,'').toLowerCase(); }catch{ return (u||'').toLowerCase(); } }
function lastSeg(u){ try{ const parts=new URL(u).pathname.replace(/\/+$/,'').split('/').filter(Boolean); return parts[parts.length-1]||''; }catch{ return ''; } }
function humanize(seg){ return seg.replace(/\.(html|shtml|aspx|php)$/,'').replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase()).trim(); }
function hashId(u){ let h=0; for(let i=0;i<u.length;i++){ h=(h*31+u.charCodeAt(i))>>>0; } return 'HRV-'+h.toString(36).toUpperCase(); }

async function sitemapRoots(domain){
  const roots=[];
  for(const host of [`https://www.${domain}`,`https://${domain}`]){
    const rob=await fetchText(host+'/robots.txt');
    if(rob) for(const m of rob.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.push(m[1]);
  }
  roots.push(`https://www.${domain}/sitemap.xml`,`https://${domain}/sitemap.xml`,`https://www.${domain}/sitemap_index.xml`);
  return [...new Set(roots)];
}
async function storyUrls(domain){
  const roots=await sitemapRoots(domain);
  let out=[],seen=new Set();
  for(const root of roots){
    const xml=await fetchText(root); if(!xml) continue;
    const entries=locs(xml); const subs=entries.filter(u=>/\.xml/i.test(u));
    if(subs.length){
      subs.sort((a,b)=>(RELEVANT.test(b)?1:0)-(RELEVANT.test(a)?1:0));
      const read=subs.slice(0,MAX_SUBS);
      for(let b=0;b<read.length && out.length<MAX_URLS_PER_DOMAIN;b+=10){
        const texts=await Promise.all(read.slice(b,b+10).map(fetchText));
        for(const sx of texts) for(const u of locs(sx)){
          if(CASE_PATH.test(u) && !seen.has(u)){ seen.add(u); out.push(u); }
        }
      }
    } else {
      for(const u of entries) if(CASE_PATH.test(u) && !seen.has(u)){ seen.add(u); out.push(u); }
    }
    if(out.length) break;
  }
  return out.filter(u=>{ const seg=lastSeg(u); return seg && !NOT_A_STORY.test(seg) && seg.length>2; });
}

async function insertRows(base,key,rows){
  for(let i=0;i<rows.length;i+=500){
    const chunk=rows.slice(i,i+500);
    const res=await fetch(base+'/rest/v1/case_studies',{ method:'POST',
      headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify(chunk) });
    if(!res.ok) throw new Error('insert '+res.status+' '+(await res.text()));
  }
}

async function main(){
  const {base,key}=env();
  const existing=await pagedGet(base,key,'case_studies','id,url,vendor');
  const haveUrl=new Set(existing.map(r=>norm(r.url)));
  const haveId=new Set(existing.map(r=>r.id));
  const domVendor={};
  for(const r of existing){ const d=domainOf(r.url); if(!d) continue; (domVendor[d]=domVendor[d]||{}); domVendor[d][r.vendor]=(domVendor[d][r.vendor]||0)+1; }
  const domains=Object.keys(domVendor);
  console.log(`existing records: ${existing.length}, vendor domains: ${domains.length}`);

  const newRows=[]; const usedId=new Set(haveId);
  for(const domain of domains){
    const vendor=Object.entries(domVendor[domain]).sort((a,b)=>b[1]-a[1])[0][0];
    const urls=await storyUrls(domain);
    let added=0;
    for(const u of urls){
      if(haveUrl.has(norm(u))) continue;
      let id=hashId(u); while(usedId.has(id)) id=id+'X'; usedId.add(id);
      const seg=lastSeg(u); const name=humanize(seg).slice(0,80);
      newRows.push({ id, type:'Vendor', vendor, product:vendor, customer:name,
        industry:'Other', geo:null, size:null, entities:null, legacy:null, erp:null,
        uses:[], synopsis:humanize(seg), benefits:null, quality:3,
        url:u.replace(/^https?:\/\//,''), flag:'Imported from vendor sitemap \u2014 pending review',
        quote:null, attribution:null });
      haveUrl.add(norm(u)); added++;
    }
    if(added) console.log(`  ${domain} (${vendor}): +${added}`);
  }
  console.log(`\nnew records to add: ${newRows.length}`);
  await insertRows(base,key,newRows);
  console.log(`inserted ${newRows.length} new records (flagged, hidden until reviewed).`);
}
main().catch(e=>{ console.error(e.message); process.exit(1); });
