import { readFileSync } from 'node:fs';

const HTML_PATH = process.argv[2] || '../index.html';
const CONCURRENCY = 10;
const TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (compatible; PAC-LinkChecker/1.0; +https://casestudiespac.netlify.app)';

function extractRecords(html) {
  const at = html.indexOf('const DATA=');
  if (at < 0) throw new Error('Could not find `const DATA=` in the HTML.');
  const start = html.indexOf('[', at);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
  }
  if (end < 0) throw new Error('Could not bracket-match the DATA array.');
  const arr = JSON.parse(html.slice(start, end + 1));
  return arr.filter(r => r && r.url).map(r => ({ id: r.id, url: r.url }));
}

function normalize(u) {
  try { const p = new URL(u); return p.host.replace(/^www\./, '').toLowerCase() + p.pathname.replace(/\/+$/, ''); }
  catch { return u; }
}
function pathDepth(u) {
  try { return new URL(u).pathname.split('/').filter(Boolean).length; } catch { return 0; }
}

async function checkOne(rec) {
  const orig = 'https://' + rec.url.replace(/^https?:\/\//, '');
  const attempt = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(orig, {
        method: 'GET', redirect: 'follow', signal: ctrl.signal,
        headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml' }
      });
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

async function runPool(items, worker, size) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
      if (idx % 100 === 0) process.stdout.write(`  checked ${idx}/${items.length}\r`);
    }
  });
  await Promise.all(runners);
  return out;
}

async function upsertRows(rows, base, key) {
  const url = base.replace(/\/$/, '') + '/rest/v1/link_status';
  for (let k = 0; k < rows.length; k += 500) {
    const chunk = rows.slice(k, k + 500);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': key,
        'authorization': 'Bearer ' + key,
        'content-type': 'application/json',
        'prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Supabase write failed (${res.status}): ${t}`);
    }
  }
}

async function main() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const records = extractRecords(html);
  console.log(`Found ${records.length} records with URLs.`);
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY env vars.');
  }
  const shuffled = records.slice().sort(() => Math.random() - 0.5);
  const results = await runPool(shuffled, checkOne, CONCURRENCY);
  process.stdout.write('\n');
  const now = new Date().toISOString();
  const rows = results.map(r => ({ ...r, checked_at: now }));
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  console.log('Results by state:', counts);
  await upsertRows(rows, SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log(`Wrote ${rows.length} statuses to link_status.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
