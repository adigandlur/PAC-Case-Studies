// ============================================================================
// PAC selective harvester
// ----------------------------------------------------------------------------
// Crawls a curated list of EPM vendor / SI-partner "customer story" index pages,
// finds case studies that are NEW (not already in the database), scores each one
// for quality + relevance + recency, and inserts only the best few per run.
//
// Design goals (why this is "selective", not a firehose):
//   * Only real links: every candidate page is fetched and must return 200 with
//     enough body text — dead or empty links are dropped, so no broken records.
//   * Only relevant: the page must match the EPM use-case taxonomy (close,
//     consolidation, FP&A, planning, reconciliation, etc.).
//   * Only detailed: minimum body length + a bonus for quantified outcomes
//     (%, days, $, "reduced"), so thin marketing pages are skipped.
//   * Only the best, few: capped per source and per run, ranked by score.
//   * Only the latest: recency (from page meta dates) breaks ties.
//   * Never duplicates: candidate URLs are matched against existing rows, and
//     row IDs are a deterministic hash of the URL, so re-runs are idempotent.
//
// Env (set as GitHub Actions secrets):
//   SUPABASE_URL          = https://xujokkplmsvsfoojycvl.supabase.co
//   SUPABASE_SERVICE_KEY  = <service_role key — never the public key>
//
// Run:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node harvest.mjs
// Node 18+ (uses built-in fetch). No npm dependencies.
// ============================================================================

const UA = 'Mozilla/5.0 (compatible; PAC-Harvester/1.0)';
const CONC = 8;              // parallel page fetches
const TIMEOUT = 20000;       // ms per request
const MIN_TEXT = 900;        // page body chars required = "good info"
const MAX_NEW = 6;           // max new case studies inserted per run (total)
const PER_SOURCE = 2;        // max new case studies per source per run
const DEFAULT_QUALITY = 3;

// ---------------------------------------------------------------------------
// SOURCES — edit this list to add/remove where we look. Each entry is one
// index/listing page that links out to individual customer stories.
//   type   : 'Vendor' or 'SI Firm'  (how it shows in the app)
//   vendor : the software vendor
//   firm   : the consulting/SI firm (only for type 'SI Firm')
//   index  : the listing page to crawl for story links
//   match  : substrings a story URL must contain to be considered a case study
// ---------------------------------------------------------------------------
const SOURCES = [
  { type:'SI Firm', vendor:'OneStream', firm:'Ascend Partners',        index:'https://ascend.partners/success-stories',                     match:['success-story','case-study'] },
  { type:'SI Firm', vendor:'SAP',       firm:'VantagePoint Solutions', index:'https://vantagepoint-solutions.com/success-stories/',         match:['/success-stories/'] },
  { type:'Vendor',  vendor:'OneStream',                                index:'https://www.onestream.com/customers/',                        match:['/customers/','/resources/'] },
  { type:'Vendor',  vendor:'Vena',                                     index:'https://www.venasolutions.com/customer-stories',              match:['customer','case-stud'] },
  { type:'Vendor',  vendor:'Planful',                                  index:'https://planful.com/customers/',                              match:['/customers/','case-stud'] },
  { type:'Vendor',  vendor:'Prophix',                                  index:'https://www.prophix.com/customers/',                          match:['/customers/','success'] },
  { type:'Vendor',  vendor:'Board',                                    index:'https://www.board.com/en/customers',                          match:['/customers/','case-stud'] },
  { type:'Vendor',  vendor:'Jedox',                                    index:'https://www.jedox.com/en/customers/',                         match:['/customers/','case-stud'] },
  { type:'Vendor',  vendor:'insightsoftware',                          index:'https://insightsoftware.com/case-studies/',                   match:['/case-studies/'] },
  { type:'Vendor',  vendor:'Anaplan',                                  index:'https://www.anaplan.com/customers/',                          match:['/customers/'] },
  { type:'Vendor',  vendor:'Workday Adaptive Planning',                index:'https://www.workday.com/en-us/customer-stories.html',         match:['customer-stories'] },
];

// ---------------------------------------------------------------------------
// Taxonomy (kept in sync with the enricher / app)
// ---------------------------------------------------------------------------
const INDUSTRIES=[
 ['Aerospace & Defense',['aerospace','defense','defence','aircraft','aviation']],
 ['Apparel & Luxury Goods',['apparel','fashion','luxury','footwear','clothing','sportswear']],
 ['Automotive',['automotive','vehicle manufacturer','automaker','auto parts','tire']],
 ['Construction & Engineering',['construction','engineering firm','infrastructure','contractor','homebuilder']],
 ['Education & Non-Profit',['university','college','education','non-profit','nonprofit','charity','school']],
 ['Financial Services',['financial services','fintech','payments','capital markets','brokerage']],
 ['Food & Beverage',['food','beverage','brewery','dairy','snack','restaurant','confectionery','winery','agribusiness','agriculture']],
 ['Government & Public Sector',['government','public sector','municipality','federal','ministry','council']],
 ['Hardware & Semiconductors',['semiconductor','chipmaker','electronics manufacturer']],
 ['Healthcare Providers & Services',['healthcare','hospital','health system','clinic','senior living','patient care']],
 ['Hospitality & Leisure',['hospitality','hotel','resort','leisure','casino','travel']],
 ['Household & Personal Products',['consumer goods','personal care','cosmetics','household products']],
 ['Industrial Manufacturing',['manufacturing','industrial','factory','machinery','packaging']],
 ['Insurance',['insurance','insurer','reinsurance','underwriting']],
 ['Materials & Chemicals',['chemical','materials','mining','metals','plastics','gold','copper']],
 ['Media & Entertainment',['media','entertainment','broadcasting','publishing','gaming','film','streaming']],
 ['Medical Devices',['medical device','medtech','medical equipment']],
 ['Pharmaceuticals & Biotech',['pharmaceutical','biotech','life sciences','biopharma']],
 ['Professional Services',['consulting','professional services','advisory','accounting firm','law firm']],
 ['Real Estate',['real estate','property','reit','homebuilder']],
 ['Software & IT Services',['software','saas','technology company','it services','cloud provider']],
 ['Telecommunications',['telecom','telecommunications','mobile operator','broadband']],
 ['Transportation & Logistics',['logistics','transportation','shipping','freight','airline','trucking']],
 ['Utilities',['utility','utilities','electric utility','power grid']],
];
const FALLBACK=[['Banking',['bank','banking']],['Retail',['retail','retailer','grocery','pharmacy','ecommerce','e-commerce']],['Energy',['energy','oil','gas','power generation','renewable']]];
const USES=[
 ['AI',['artificial intelligence','machine learning','ai-powered','ai-driven','predictive analytics','generative']],
 ['Account Reconciliation',['reconciliation','reconcile','account recs','transaction matching']],
 ['Disclosure Management',['disclosure management','regulatory reporting','xbrl','esef','narrative reporting','esg reporting']],
 ['Financial Close',['financial close','close process','month-end close','fast close','record to report']],
 ['FP&A',['fp&a','financial planning and analysis','financial planning & analysis']],
 ['Management Reporting',['management reporting','management report','board reporting','self-service reporting']],
 ['Planning, Budgeting & Forecasting',['budgeting','forecasting','budget','forecast','scenario planning','workforce planning','ibp']],
 ['S&OP',['s&op','sales and operations','demand planning','supply planning','integrated business planning']],
 ['Statutory Consolidation',['consolidation','group reporting','intercompany','statutory reporting']],
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function decode(s){return (s||'').replace(/&amp;/g,'&').replace(/&#39;|&rsquo;|&#8217;/g,"'").replace(/&quot;|&ldquo;|&rdquo;/g,'"').replace(/&nbsp;/g,' ').replace(/&#8211;|&ndash;/g,'–').replace(/&#8212;|&mdash;/g,'—').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&[a-z0-9#]+;/gi,' ').replace(/\s+/g,' ').trim();}
function metaOf(h,k){const a=new RegExp('<meta[^>]+(?:property|name)=["\']'+k+'["\'][^>]*content=["\']([^"\']*)["\']','i');const b=new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']'+k+'["\']','i');const m=h.match(a)||h.match(b);return m?decode(m[1]):'';}
function titleOf(h){const m=h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?decode(m[1]):'';}
function bodyText(h){return decode(h.replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' '));}
function firstPara(h){const b=h.replace(/<(script|style|nav|header|footer)[\s\S]*?<\/\1>/gi,' ');for(const m of b.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)){const t=decode(m[1].replace(/<[^>]+>/g,' '));if(t.length>=90&&/[a-z]/.test(t))return t;}return '';}
function cleanCustomer(raw,vendor){if(!raw)return '';let t=raw.split(/\s[|–—]\s|\s-\s/)[0].trim();if(vendor)t=t.replace(new RegExp(vendor.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'ig'),' ');t=t.replace(/\b(case study|customer story|success story|customer success|customer testimonial|story|testimonial)\b/ig,' ');return t.replace(/\s+/g,' ').replace(/^[\s\-|:,]+|[\s\-|:,]+$/g,'').trim();}
function classify(text){const t=' '+text.toLowerCase()+' ';let ind='Other';for(const [n,kw] of INDUSTRIES){if(kw.some(k=>t.includes(k))){ind=n;break;}}if(ind==='Other')for(const [n,kw] of FALLBACK){if(kw.some(k=>t.includes(k))){ind=n;break;}}const uses=[];for(const [n,kw] of USES)if(kw.some(k=>t.includes(k)))uses.push(n);return {ind,uses};}
function pageDate(h){for(const k of ['article:modified_time','og:updated_time','article:published_time']){const v=metaOf(h,k);const d=Date.parse(v);if(d)return d;}const m=h.match(/datetime=["\']([^"\']+)["\']/i);return m?(Date.parse(m[1])||0):0;}
function normUrl(u){return String(u||'').replace(/^https?:\/\//,'').replace(/[#?].*$/,'').replace(/\/+$/,'').toLowerCase();}
function hashId(u){let h=5381;const s=normUrl(u);for(let i=0;i<s.length;i++)h=((h<<5)+h+s.charCodeAt(i))>>>0;return 'HRV-'+h.toString(36);}

async function fetchPage(url){const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),TIMEOUT);try{const r=await fetch(url.startsWith('http')?url:'https://'+url,{headers:{'user-agent':UA,accept:'text/html'},redirect:'follow',signal:ctrl.signal});return r.ok?await r.text():'';}catch{return '';}finally{clearTimeout(t);}}
function links(html,baseUrl,match){const out=new Set();const origin=(()=>{try{return new URL(baseUrl).origin;}catch{return '';}})();for(const m of html.matchAll(/href=["\']([^"\'#]+)["\']/gi)){let href=m[1];if(!href||href.startsWith('mailto:')||href.startsWith('tel:')||href.startsWith('javascript'))continue;try{href=new URL(href,baseUrl).toString();}catch{continue;}if(origin&&!href.startsWith(origin))continue;const low=href.toLowerCase();if(match.some(x=>low.includes(x)))out.add(href.split('#')[0].split('?')[0]);}return [...out];}

function env(){const {SUPABASE_URL,SUPABASE_SERVICE_KEY}=process.env;if(!SUPABASE_URL||!SUPABASE_SERVICE_KEY)throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');return {base:SUPABASE_URL.replace(/\/$/,''),key:SUPABASE_SERVICE_KEY};}
async function rest(base,key,path){const r=await fetch(base+'/rest/v1/'+path,{headers:{apikey:key,authorization:'Bearer '+key}});if(!r.ok)throw new Error('REST '+r.status+' '+(await r.text()));return r.json();}
async function pagedGet(base,key,q){let out=[],off=0;while(true){const rows=await rest(base,key,`${q}&limit=1000&offset=${off}`);out=out.concat(rows);if(rows.length<1000)break;off+=1000;}return out;}
async function insert(base,key,rows){if(!rows.length)return;const res=await fetch(base+'/rest/v1/case_studies',{method:'POST',headers:{apikey:key,authorization:'Bearer '+key,'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});if(!res.ok)throw new Error('write '+res.status+' '+(await res.text()));}
async function pool(items,worker,size){let i=0;await Promise.all(Array.from({length:size},async()=>{while(i<items.length){const idx=i++;await worker(items[idx]);}}));}

// ---------------------------------------------------------------------------
// Score a candidate story page. Returns null if it fails the quality/relevance
// gate; otherwise a row + score object.
// ---------------------------------------------------------------------------
function evaluate(src,url,html){
  const text=bodyText(html);
  if(text.length<MIN_TEXT)return null;                      // too thin
  const desc=metaOf(html,'og:description')||metaOf(html,'description')||firstPara(html);
  const ttl=metaOf(html,'og:title')||titleOf(html);
  const {ind,uses}=classify(text+' '+desc);
  if(!uses.length)return null;                              // not EPM-relevant
  const customer=cleanCustomer(ttl,src.vendor);
  if(!customer||customer.length<2)return null;              // no clear customer
  const quantified=/\b\d+%|\b\d+\s*(days|weeks|hours|months)|\$\s*\d|reduced by|cut .* by|faster|automat/i.test(text);
  const date=pageDate(html);
  // score: relevance + detail + outcomes, recency breaks ties
  const score=uses.length*2 + (quantified?3:0) + Math.min(3,Math.floor(text.length/1500)) + (date? 1:0);
  const row={
    id:hashId(url), type:src.type, vendor:src.vendor, firm:src.firm||null,
    product:src.vendor+' — Customer Story', customer:customer.slice(0,120),
    industry:ind, geo:null, size:'Not stated', entities:'Not stated',
    legacy:'Not stated', erp:'Not stated', uses,
    synopsis:(desc||text.slice(0,400)).slice(0,600), benefits:null,
    quality:Math.max(2,Math.min(4,DEFAULT_QUALITY+(quantified?1:0))),
    url:normUrl(url), flag:null, quote:null, attribution:null,
  };
  return {row,score,date};
}

async function main(){
  const {base,key}=env();

  // 1) existing URLs, to skip anything already in the catalog
  const existing=await pagedGet(base,key,'case_studies?select=url');
  const seen=new Set(existing.map(r=>normUrl(r.url)));
  console.log(`existing rows: ${existing.length}`);

  // 2) collect candidate story links from every source index
  const candidates=[]; // {src,url}
  for(const src of SOURCES){
    const idx=await fetchPage(src.index);
    if(!idx){console.log(`  (no index) ${src.vendor} ${src.index}`);continue;}
    const urls=links(idx,src.index,src.match).filter(u=>{
      const n=normUrl(u);
      return n!==normUrl(src.index) && !seen.has(n);
    });
    for(const u of urls) candidates.push({src,url:u});
    console.log(`  ${src.vendor}: ${urls.length} new candidate link(s)`);
  }
  // de-dup candidate URLs across sources
  const uniq=[]; const cs=new Set();
  for(const c of candidates){const n=normUrl(c.url);if(cs.has(n))continue;cs.add(n);uniq.push(c);}
  console.log(`unique new candidates: ${uniq.length}`);

  // 3) fetch + evaluate each candidate
  const scored=[];
  await pool(uniq, async ({src,url})=>{
    const html=await fetchPage(url);
    if(!html)return;
    const r=evaluate(src,url,html);
    if(r) scored.push({src,...r});
  }, CONC);
  console.log(`passed quality gate: ${scored.length}`);

  // 4) rank: best score first, then most recent; cap per source and overall
  scored.sort((a,b)=> b.score-a.score || b.date-a.date);
  const perSource={}; const chosen=[];
  for(const s of scored){
    const v=s.src.vendor; perSource[v]=perSource[v]||0;
    if(perSource[v]>=PER_SOURCE) continue;
    perSource[v]++; chosen.push(s);
    if(chosen.length>=MAX_NEW) break;
  }

  if(!chosen.length){console.log('nothing new worth adding this run.');return;}
  console.log('\nadding:');
  for(const c of chosen) console.log(`  [${c.score}] ${c.row.vendor} — ${c.row.customer}  (${c.row.url})`);
  await insert(base,key,chosen.map(c=>c.row));
  console.log(`\ninserted ${chosen.length} case stud${chosen.length===1?'y':'ies'}.`);
}
main().catch(e=>{console.error('harvest failed:',e.message);process.exit(1);});
