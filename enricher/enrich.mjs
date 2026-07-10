const UA='Mozilla/5.0 (compatible; PAC-Enricher/1.0)';
const CONC=10, TIMEOUT=20000;

const INDUSTRIES=[
 ['Aerospace & Defense',['aerospace','defense contractor','defence contractor','aircraft manufacturer','missile','satellite operator']],
 ['Apparel & Luxury Goods',['apparel','fashion brand','luxury goods','footwear','clothing brand','sportswear brand']],
 ['Asset & Wealth Management',['asset management','wealth management','asset manager','investment management','fund manager']],
 ['Automotive',['automotive','automaker','auto parts','car manufacturer','vehicle manufacturer']],
 ['Construction & Engineering',['construction company','engineering firm','civil engineering','general contractor']],
 ['Education & Non-Profit',['university','college','education','non-profit','nonprofit','charity','school','academic']],
 ['Financial Services',['financial services','fintech','payments','capital markets','brokerage']],
 ['Food & Beverage',['food','beverage','brewery','dairy','snack','restaurant','confectionery','winery']],
 ['Government & Public Sector',['government','public sector','municipality','federal','ministry','council','agency']],
 ['Hardware & Semiconductors',['semiconductor','hardware manufacturer','chipmaker','electronics manufacturer']],
 ['Healthcare Providers & Services',['healthcare','hospital','health system','clinic','patient care','health services']],
 ['Hospitality & Leisure',['hospitality','hotel','resort','leisure','casino','travel']],
 ['Household & Personal Products',['consumer goods','personal care','cosmetics','household products','toiletries']],
 ['Industrial Manufacturing',['manufacturing','industrial','factory','machinery','equipment manufacturer']],
 ['Insurance',['insurance','insurer','reinsurance','underwriting']],
 ['Materials & Chemicals',['chemical','materials','mining','metals','plastics']],
 ['Media & Entertainment',['media','entertainment','broadcasting','publishing','gaming','film','streaming']],
 ['Medical Devices',['medical device','medtech','medical equipment']],
 ['Pharmaceuticals & Biotech',['pharmaceutical','biotech','life sciences','biopharma']],
 ['Professional Services',['consulting','professional services','advisory','accounting firm','law firm','staffing']],
 ['Real Estate',['real estate','property','reit']],
 ['Software & IT Services',['software','saas','technology company','it services','cloud provider']],
 ['Telecommunications',['telecom','telecommunications','mobile operator','wireless carrier','broadband']],
 ['Transportation & Logistics',['logistics','transportation','shipping','freight','airline','trucking','supply chain']],
 ['Utilities',['utility','utilities','water company','electric utility','power grid']],
];
const FALLBACK=[['Banking',['bank','banking']],['Retail',['retail','retailer','grocery','ecommerce','e-commerce']],['Energy',['energy','oil','gas','power generation','renewable']]];
const USES=[
 ['AI',['artificial intelligence','machine learning','ai-powered','ai-driven','ai-native','predictive analytics','generative']],
 ['Account Reconciliation',['reconciliation','reconcile','account recs']],
 ['Disclosure Management',['disclosure management','regulatory reporting','xbrl','esef','narrative reporting']],
 ['Financial Close',['financial close','close process','month-end close','fast close','record to report']],
 ['FP&A',['fp&a','financial planning and analysis','financial planning & analysis']],
 ['Management Reporting',['management reporting','management report','board reporting']],
 ['Planning, Budgeting & Forecasting',['budgeting','forecasting','budget','forecast','scenario planning','workforce planning']],
 ['S&OP',['s&op','sales and operations','demand planning','supply planning','integrated business planning']],
 ['Statutory Consolidation',['consolidation','group reporting','intercompany','statutory reporting']],
];

function decode(s){ return (s||'').replace(/&amp;/g,'&').replace(/&#39;|&rsquo;|&#8217;/g,"'").replace(/&quot;|&ldquo;|&rdquo;/g,'"').replace(/&nbsp;/g,' ').replace(/&#8211;|&ndash;/g,'\u2013').replace(/&#8212;|&mdash;/g,'\u2014').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&[a-z0-9#]+;/gi,' ').replace(/\s+/g,' ').trim(); }
function metaOf(h,k){ const a=new RegExp('<meta[^>]+(?:property|name)=["\']'+k+'["\'][^>]*content=["\']([^"\']*)["\']','i'); const b=new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']'+k+'["\']','i'); const m=h.match(a)||h.match(b); return m?decode(m[1]):''; }
function titleOf(h){ const m=h.match(/<title[^>]*>([\s\S]*?)<\/title>/i); return m?decode(m[1]):''; }
function firstPara(h){ const b=h.replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi,' '); for(const m of b.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)){ const t=decode(m[1].replace(/<[^>]+>/g,' ')); if(t.length>=90&&/[a-z]/.test(t)) return t; } return ''; }
function cleanCustomer(raw,vendor){ if(!raw) return ''; let t=raw.split(/\s[|\u2013\u2014]\s|\s-\s/)[0].trim(); t=t.replace(new RegExp(vendor.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' '); t=t.replace(/\b(case study|customer story|success story|customer success|customer testimonial|story|testimonial)\b/ig,' '); return t.replace(/\s+/g,' ').replace(/^[\s\-|:,]+|[\s\-|:,]+$/g,'').trim(); }
function classify(text){ const t=' '+text.toLowerCase()+' '; let ind='Other', best=0; for(const [n,kw] of INDUSTRIES){ const hits=kw.reduce((a,k)=>a+(t.includes(k)?1:0),0); if(hits>best){ best=hits; ind=n; } } if(ind==='Other'){ for(const [n,kw] of FALLBACK){ const hits=kw.reduce((a,k)=>a+(t.includes(k)?1:0),0); if(hits>best){ best=hits; ind=n; } } } const uses=[]; for(const [n,kw] of USES) if(kw.some(k=>t.includes(k))) uses.push(n); return {ind,uses}; }

function env(){ const {SUPABASE_URL,SUPABASE_SERVICE_KEY}=process.env; if(!SUPABASE_URL||!SUPABASE_SERVICE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.'); return {base:SUPABASE_URL.replace(/\/$/,''),key:SUPABASE_SERVICE_KEY}; }
async function rest(base,key,path){ const r=await fetch(base+'/rest/v1/'+path,{headers:{apikey:key,authorization:'Bearer '+key}}); if(!r.ok) throw new Error('REST '+r.status+' '+(await r.text())); return r.json(); }
async function pagedGet(base,key,q){ let out=[],off=0; while(true){ const rows=await rest(base,key,`${q}&limit=1000&offset=${off}`); out=out.concat(rows); if(rows.length<1000) break; off+=1000; } return out; }
async function fetchPage(url){ const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),TIMEOUT); try{ const r=await fetch(url.startsWith('http')?url:'https://'+url,{headers:{'user-agent':UA,accept:'text/html'},redirect:'follow',signal:ctrl.signal}); return r.ok?await r.text():''; }catch{ return ''; } finally{ clearTimeout(t); } }

async function pool(items,worker,size){ let i=0; const runners=Array.from({length:size},async()=>{ while(i<items.length){ const idx=i++; await worker(items[idx],idx); if(idx%100===0) process.stdout.write(`  ${idx}/${items.length}\r`); } }); await Promise.all(runners); }
async function upsert(base,key,rows){ for(let i=0;i<rows.length;i+=400){ const chunk=rows.slice(i,i+400); const res=await fetch(base+'/rest/v1/case_studies',{method:'POST',headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(chunk)}); if(!res.ok) throw new Error('write '+res.status+' '+(await res.text())); } }

async function main(){
  const {base,key}=env();
  const recs=await pagedGet(base,key,`case_studies?select=id,vendor,customer,url&id=like.HRV-*`);
  console.log(`records to enrich: ${recs.length}`);
  const updates=[];
  await pool(recs, async (r)=>{
    const html=await fetchPage(r.url); if(!html) return;
    const desc=metaOf(html,'og:description')||metaOf(html,'description')||firstPara(html);
    const ttl=metaOf(html,'og:title')||titleOf(html);
    const name=cleanCustomer(ttl,r.vendor||'');
    const {ind,uses}=classify(html.replace(/<[^>]+>/g,' ')+' '+desc);
    const keepName = (name && name.split(' ').length<=4 && name.length>=2 && !/[.]/.test(name));
    const row={ id:r.id,
      synopsis: desc ? desc.slice(0,600) : r.customer,
      industry: (ind!=='Other') ? ind : 'Other',
      uses: uses.length ? uses : [],
      customer: keepName ? name : r.customer };
    if(desc || ind!=='Other' || uses.length || keepName) updates.push(row);
  }, CONC);
  process.stdout.write('\n');
  console.log(`enriched: ${updates.length}`);
  await upsert(base,key,updates);
  console.log('done.');
}
main().catch(e=>{ console.error(e.message); process.exit(1); });
