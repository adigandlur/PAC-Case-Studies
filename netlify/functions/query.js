// Serverless proxy so the Anthropic API key stays server-side.
// The frontend posts { question, records } and gets back the raw Anthropic response.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: 'ANTHROPIC_API_KEY is not set in the site environment variables.' });
  }

  let question, records;
  try {
    const body = JSON.parse(event.body || '{}');
    question = body.question;
    records = body.records;
  } catch (e) {
    return json(400, { error: 'Invalid JSON body' });
  }
  if (!question || !Array.isArray(records)) {
    return json(400, { error: 'Body must include a question string and a records array.' });
  }

  const prompt = [
    'You are a search assistant for a B2B EPM (enterprise performance management) case study database.',
    'Below are candidate case study records as JSON. Each has an id, customer, vendor, firm, industry, geo, size, legacy system, erp, uses, synopsis, and benefits.',
    '',
    'Records:',
    JSON.stringify(records),
    '',
    'User question: ' + question,
    '',
    'Pick the records that best answer the question. Reply with ONLY a JSON object, no markdown fences, in exactly this shape:',
    '{"answer": "a 2 to 4 sentence plain-text summary that answers the question and names the most relevant customers", "ids": ["id1", "id2"]}',
    'Include at most 8 ids, most relevant first. If nothing fits, return an empty ids array and say so in the answer.'
  ].join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    return json(r.ok ? 200 : r.status, data);
  } catch (e) {
    return json(502, { error: 'Upstream request failed: ' + String(e) });
  }
};

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  };
}
