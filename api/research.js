// Backend function. Runs on the server, never in the visitor's browser.
// Holds your secret Google Gemini API key and forwards each request to the
// Gemini API. Uses the free AI Studio tier (no credit card needed) and the
// model's own knowledge — no live web search. Visitors need no account.

// You can change this to any model available on your free tier. Find current
// names at https://aistudio.google.com (look for "Flash" / "Flash-Lite").
const MODEL = "gemini-2.5-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "The server has no GEMINI_API_KEY set. Add it in your hosting dashboard.",
    });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { system, prompt } = body || {};
  if (!system || !prompt) {
    res.status(400).json({ error: "Missing request data." });
    return;
  }

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.4,
            responseMimeType: "application/json", // ask Gemini for clean JSON
          },
        }),
      }
    );

    const rawBody = await r.text();
    let data = null;
    try { data = JSON.parse(rawBody); } catch { /* non-JSON error body */ }

    if (!r.ok) {
      const detail =
        (data && data.error && data.error.message) ||
        (rawBody ? rawBody.slice(0, 300) : "") ||
        ("HTTP " + r.status);
      let friendly;
      if (r.status === 429) {
        friendly =
          "Busy: the free Gemini tier limits requests per minute/day, and it's maxed out right now. Wait a bit and try again.";
      } else {
        friendly = "Gemini error (" + r.status + "): " + detail;
      }
      res.status(r.status).json({ error: friendly });
      return;
    }

    const cand = data && data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");

    if (!text) {
      res.status(502).json({ error: "Gemini returned an empty response. Try again." });
      return;
    }

    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message || "The request failed." });
  }
}
