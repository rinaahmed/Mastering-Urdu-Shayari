// Cloudflare Pages Function: POST /api/evaluate
// Evaluator call — receives ONLY the drill, the correct answer, and the user's
// response. No teaching context. Returns strict JSON enforced via structured
// outputs (output_config.format json_schema) — pedagogy is never parsed out
// of prose.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-8';

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    correct: { type: 'boolean' },
    errorCategoryId: {
      type: ['string', 'null'],
      description: 'id of a matched known error category, or null'
    },
    newCategory: {
      type: ['object', 'null'],
      properties: {
        name: { type: 'string' },
        rootCause: { type: 'string' }
      },
      required: ['name', 'rootCause'],
      additionalProperties: false,
      description: 'proposed new category when the error matches no known one; null otherwise'
    },
    confidenceDelta: {
      type: 'number',
      description: 'suggested confidence adjustment in [-0.3, 0.3]'
    },
    note: {
      type: 'string',
      description: 'one factual sentence on what was wrong or right — not teaching'
    }
  },
  required: ['correct', 'errorCategoryId', 'newCategory', 'confidenceDelta', 'note'],
  additionalProperties: false
};

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
  const { drill, correctAnswer, userResponse, knownErrorCategories, answerNote } = body || {};
  if (!drill || typeof userResponse !== 'string') {
    return json({ error: 'Expected { drill, correctAnswer, userResponse, knownErrorCategories }' }, 400);
  }

  const categories = (knownErrorCategories || [])
    .map((c) => `- ${c.id}: ${c.name} — ${c.rootCause}`)
    .join('\n');

  const anthropicBody = {
    model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: 1024,
    system:
      'You are a strict grader for Urdu prosody drills. You receive a drill, the correct ' +
      'answer, and the student response — nothing else, by design. Judge correctness. If ' +
      'incorrect, match the error to one of the known categories by id; only propose a ' +
      'newCategory when no known category fits. confidenceDelta: +0.1..+0.3 for correct ' +
      '(higher for hard drills), -0.1..-0.3 for incorrect. Do not teach, hint, or explain ' +
      'method — the note is one factual sentence.',
    messages: [
      {
        role: 'user',
        content:
          `Drill type: ${drill.type}\nFormat: ${drill.format}\nPrompt: ${drill.prompt}\n` +
          (drill.judgmentAxis ? `Judge ONLY this axis (another system graded the rest): ${drill.judgmentAxis}\n` : '') +
          `Correct answer: ${correctAnswer}\n` +
          (answerNote ? `Answer note: ${answerNote}\n` : '') +
          `Student response: ${userResponse}\n\nKnown error categories:\n${categories || '(none)'}`
      }
    ],
    output_config: {
      format: { type: 'json_schema', schema: RESULT_SCHEMA }
    }
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
    return json({ error: 'Evaluator declined the request' }, 502);
  }
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    return json({ error: 'Evaluator returned unparseable output', detail: text.slice(0, 300) }, 502);
  }

  // Defensive validation even though the schema is enforced upstream.
  if (typeof result.correct !== 'boolean' || typeof result.confidenceDelta !== 'number') {
    return json({ error: 'Evaluator result failed validation', detail: text.slice(0, 300) }, 502);
  }
  result.confidenceDelta = Math.max(-0.3, Math.min(0.3, result.confidenceDelta));
  return json(result);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
