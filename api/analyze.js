const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, zip, concern, images } = req.body;

  if (!zip) return res.status(400).json({ error: 'Zip code is required.' });

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server configuration error: missing API key.' });

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

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
  "grass_type": "<most likely grass species, e.g. St. Augustine, Bermuda, Zoysia, Fescue, Kentucky Bluegrass>",
  "grass_confidence": "<Low|Medium|High>",
  "summary": "<2-3 sentence plain-English assessment of overall lawn condition>",
  "issues": [
    { "icon": "<relevant emoji>", "title": "<short issue name>", "description": "<one sentence explanation>" }
  ],
  "recommendations": [
    { "priority": "<Immediate|Soon|Seasonal>", "action": "<short imperative action>", "detail": "<1-2 sentence how-to or why>" }
  ],
  "seasonal_note": "<one sentence about what to focus on right now based on their region and the current season>",
  "next_analysis": "<suggested timeframe for next photo submission, e.g. '4-6 weeks'>"
}

Rules:
- health_score must reflect what is visible in photos (or estimated if no photos)
- List 2-4 issues (skip if lawn looks healthy)
- List 3-5 recommendations ordered by urgency
- Be specific, practical, and encouraging`;

  // Build Gemini content parts
  const parts = [];

  // Add images first
  if (hasImages) {
    for (const img of images.slice(0, 5)) {
      if (img && img.data && img.mediaType) {
        parts.push({
          inlineData: {
            mimeType: img.mediaType,
            data: img.data,
          },
        });
      }
    }
  }

  // Add text prompt
  parts.push({ text: prompt });

  try {
    const result = await model.generateContent(parts);
    const raw = result.response.text().trim();

    let report;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
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
    console.error('Gemini API error:', err);
    return res.status(500).json({ error: 'AI analysis failed.', message: err.message });
  }
};
