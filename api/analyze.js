const { Redis } = require('@upstash/redis');

const DAILY_LIMIT = 5;

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `analyze:${ip}:${today}`;

  try {
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 60 * 60 * 24);
    }
    if (count > DAILY_LIMIT) {
      return res.status(429).json({
        error: `Daily limit reached. You can run up to ${DAILY_LIMIT} lawn analyses per day. Please try again tomorrow.`,
      });
    }
  } catch (err) {
    console.error('Rate limit check failed:', err);
  }

  const { name, zip, concern, images } = req.body;

  if (!zip) return res.status(400).json({ error: 'Zip code is required.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server configuration error: missing API key.' });

  const hasImages = Array.isArray(images) && images.length > 0;

  const prompt = `You are an expert lawn care specialist and agronomist. Analyze this homeowner's lawn and provide a detailed assessment.

Homeowner details:
- Name: ${name || 'Homeowner'}
- ZIP Code: ${zip} (use to determine growing zone, climate, grass expectations, and seasonal timing)
- Main concern: ${concern || 'General lawn health assessment'}
- Photos submitted: ${hasImages ? images.length : 0}

${hasImages
  ? 'Carefully analyze every photo for grass health, color, density, weed presence, disease, drought stress, bare patches, thatch, and overall condition.'
  : 'No photos were provided. Base your analysis on the ZIP code region and stated concern. Note in your summary that the score is an estimate without photos.'
}

Respond ONLY with a valid JSON object — no markdown fences, no explanation outside the JSON:

{
  "health_score": <integer 0-100>,
  "health_label": "<Poor|Fair|Good|Excellent>",
  "grass_type": "<most likely grass species>",
  "grass_confidence": "<Low|Medium|High>",
  "summary": "<2-3 sentence plain-English assessment>",
  "issues": [
    { "icon": "<emoji>", "title": "<short issue name>", "description": "<one sentence>" }
  ],
  "recommendations": [
    { "priority": "<Immediate|Soon|Seasonal>", "action": "<short action>", "detail": "<1-2 sentences>" }
  ],
  "seasonal_note": "<one sentence about what to focus on right now based on their region>",
  "next_analysis": "<suggested timeframe, e.g. 4-6 weeks>"
}

Rules:
- health_score must reflect what is visible in photos (or estimated if no photos)
- List 2-4 issues (skip if lawn looks healthy)
- List 3-5 recommendations ordered by urgency
- Be specific, practical, and encouraging`;

  // Build Anthropic message content
  const content = [];

  if (hasImages) {
    for (const img of images.slice(0, 5)) {
      if (img && img.data && img.mediaType) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType,
            data: img.data,
          },
        });
      }
    }
  }

  content.push({ type: 'text', text: prompt });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic error:', errText);
      return res.status(500).json({ error: 'AI analysis failed.', message: errText });
    }

    const anthropicData = await anthropicRes.json();
    const raw = anthropicData.content?.[0]?.text?.trim();

    if (!raw) {
      return res.status(500).json({ error: 'No response from AI.' });
    }

    let report;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      report = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('Parse error:', parseErr, '\nRaw:', raw);
      return res.status(500).json({ error: 'Failed to parse AI response.', raw });
    }

    return res.status(200).json({
      success: true,
      report,
      meta: { name: name || 'Homeowner', zip, analyzedAt: new Date().toISOString() },
    });

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(500).json({ error: 'AI analysis failed.', message: err.message });
  }
};
