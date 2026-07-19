// netlify/functions/link-check-scheduled.mjs
// Scheduled link checker. Runs daily, checks the least-recently-checked slice of
// case_studies, and writes results to link_status. The app hides any row whose
// state is 'gone' or 'soft', so dead links disappear on their own.

import { createClient } from '@supabase/supabase-js';

const BATCH = 250;         // urls checked per run
const CONCURRENCY = 6;     // parallel requests
const MIN_TEXT = 500;      // html shorter than this = empty shell / soft-404
const REQ_TIMEOUT = 12000; // ms per url

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const normalize = u => (/^https?:\/\//.test(u) ? u : 'https://' + u);

function classify(status, finalUrl, requested, ct, textLen) {
  if (status === 0 || status >= 400) return 'gone';
  try {
    const f = new URL(finalUrl), r = new URL(requested);
    const fp = f.pathname.replace(/\/+$/, '');
    const rp = r.pathname.replace(/\/+$/, '');
    if (fp !== rp) {
      const slug = rp.split('/').filter(Boolean).pop();
      if (fp === '' || fp === '/') return 'soft';
      if (slug && !fp.endsWith(slug)) return 'soft';
    }
  } catch {}
  if (ct.includes('text/html') && textLen !== null && textLen < MIN_TEXT) return 'soft';
  return 'ok';
}

async function check(rawUrl) {
  const full = normalize(rawUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
  try {
    const res = await fetch(full, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (link-check)' },
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let textLen = null;
    if (ct.includes('text/html')) {
      const html = await res.text();
      textLen = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;
    }
    return { status: res.status, final: res.url, ct, textLen };
  } catch {
    return { status: 0, final: full, ct: '', textLen: 0 };
  } finally {
    clearTimeout(t);
  }
}

// paginate past Supabase's 1000-row default
async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
    if (from > 50000) break;
  }
  return out;
}

export default async () => {
  const started = Date.now();
  try {
    const studies = (await fetchAll('case_studies', 'id,url')).filter(r => r.url);
    const statuses = await fetchAll('link_status', 'study_id,checked_at');

    const lastChecked = new Map(statuses.map(s => [s.study_id, Date.parse(s.checked_at) || 0]));

    // never-checked first, then oldest-checked
    const queue = studies
      .sort((a, b) => (lastChecked.get(a.id) ?? -1) - (lastChecked.get(b.id) ?? -1))
      .slice(0, BATCH);

    let i = 0;
    const results = [];
    async function worker() {
      while (i < queue.length) {
        const r = queue[i++];
        const { status, final, ct, textLen } = await check(r.url);
        results.push({
          study_id: r.id,
          url: r.url,
          status_code: status,
          final_url: final,
          state: classify(status, final, normalize(r.url), ct, textLen),
          checked_at: new Date().toISOString(),
        });
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    for (let k = 0; k < results.length; k += 200) {
      const { error } = await sb
        .from('link_status')
        .upsert(results.slice(k, k + 200), { onConflict: 'study_id' });
      if (error) console.error('upsert:', error.message);
    }

    const count = s => results.filter(r => r.state === s).length;
    const summary = {
      checked: results.length,
      ok: count('ok'),
      soft: count('soft'),
      gone: count('gone'),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log('link-check', summary);
    return new Response(JSON.stringify(summary), {
      headers: { 'content-type': 'application/json' },
    });
  } catch (e) {
    console.error('link-check failed:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};

export const config = {
  schedule: '@daily',
};
