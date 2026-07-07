// PAC case study link checker
// Runs OUTSIDE the browser (no CORS limits). Reads the URLs straight out of
// index.html, checks each one, and writes the result into Supabase table `link_status`.
//
// Usage:  node check-links.mjs [path-to-index.html]
// Env:    SUPABASE_URL, SUPABASE_SERVICE_KEY   (service key, never the publishable one)

import { readFileSync } from 'node:fs';

const HTML_PATH = process.argv[2] || '../index.html';
const CONCURRENCY = 10;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (compatible; PAC-LinkChecker/1.0; +https://casestudiespac.netlify.app)';

// ---- 1. Pull the DATA array out of the HTML (bracket-matched, string-aware) ----
function extractRecords(html) {
  const marker = 'const DATA=';
  const at = html.indexOf(marker);
  if (at < 0) throw new Error('Could not find `const DATA=` in the HTML.');
  const start = html.indexOf('[', at);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end < 0) throw new Error('Could not bracket-match the DATA array.');
  const arr = JSON.parse(html.slice(start, end + 1));
  return arr.filter(r => r && r.url).map(r => ({
    id: r.id, url: r.url, customer: r.customer, vendor: r.vendor
  }));
}

// ---- 2. Classify one URL ----
function normalize(u) {
  try {
    const p = new URL(u);
    let host = p.host.replace(/^www\./, '').toLowerCase();
    let path = p.pathname.replace(/\/+$/, '');
    return host + path;
  } catch { return u; }
}
function pathDepth(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean).length; }
  catch { return 0; }
}

async function checkOne(rec) {
  const orig = 'https://' + rec.url.replace(/^https?:\/\//, '');
  const attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(orig, {
        method: 'GET',
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' }
      });
      return res;
    } finally { clearTimeout(t); }
  };

  let res;
  try {
    res = await attempt();
    if (res.status === 403 || res.status === 429) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      res = await attempt();
    }
  } catch (e) {
    return { study_id: rec.id, url: rec.url, status_code: null, final_url: null, state: 'error' };
  }

  const code = res.status;
  const finalUrl = res.url || orig;
  let state;

  if (code === 404 || code === 410) state = 'gone';
  else if (code === 401 || code === 403 || code === 429) state = 'blocked';
  else if (code >= 200 && code < 300) {
    if (normalize(finalUrl) === normalize(orig)) state = 'ok';
    else if (pathDepth(finalUrl) <= 1 && pathDepth(orig) >= 2) state = 'soft';
    else state = 'moved';
  }
  else if (code >= 300 && code < 400) state = 'moved';
  else state = 'error';

  return { study_id: rec.id, url: rec.url, status_code: code, final_url: finalUrl, state };
}

// ---- 3. Concurrency pool ----
async function runPool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx], idx);
      if (idx % 100 === 0) process.stdout.write(`  checked ${idx}/${items.length}\r`);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---- 4. Main ----
async function main() {
  const selfTest = process.argv.includes('--extract-only');
  const html = readFileSync(HTML_PATH, 'utf8');
  let records = extractRecords(html);
  console.log(`Found ${records.length} records with URLs.`);

  if (selfTest) {
    console.log('Sample:', records.slice(0, 3));
    console.log('Extract-only mode, not checking or writing.');
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.');
  }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  records = records.sort(() => Math.random() - 0.5);

  const results = await runPool(records, checkOne, CONCURRENCY);
  process.stdout.write('\n');

  const now = new Date().toISOString();
  const rows = results.map(r => ({ ...r, checked_at: now }));

  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  console.log('Results by state:', counts);

  for (let k = 0; k < rows.length; k += 500) {
    const chunk = rows.slice(k, k + 500);
    const { error } = await sb.from('link_status').upsert(chunk, { onConflict: 'study_id' });
    if (error) { console.error('Upsert error:', error.message); process.exitCode = 1; }
  }
  console.log(`Wrote ${rows.length} statuses to link_status.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
