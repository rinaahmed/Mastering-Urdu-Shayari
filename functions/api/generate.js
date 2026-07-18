// Cloudflare Pages Function: POST /api/generate
// Generator call — teaches, hints, explains. Receives the locally assembled
// context payload and returns prose. The Anthropic key lives only here
// (set ANTHROPIC_API_KEY in the Pages project's environment variables).

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ANTHROPIC_API_KEY is not configured on the Worker' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const { context, request: userRequest } = body || {};
  if (typeof context !== 'string' || typeof userRequest !== 'string') {
    return json({ error: 'Expected { context: string, request: string }' }, 400);
  }

  const anthropicBody = {
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1500,
    system:
      'You are the tutor inside a personal learning-session app. The app owns all state and ' +
      'is domain-agnostic; the subject, vocabulary, and method come entirely from the context ' +
      'block below. Follow the "Tutor instructions" section of the context verbatim — the ' +
      'teaching method is defined there, not here. Respond in prose. Never output JSON.',
    messages: [
      {
        role: 'user',
        content: `${context}\n\n## Student request\n${userRequest}`
      }
    ]
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(anthropicBody)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: `Anthropic API ${res.status}`, detail: detail.slice(0, 500) }, 502);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    return json({ text: 'The tutor declined to answer this request. Try rephrasing.' });
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return json({ text });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
