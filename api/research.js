// Backend function. Runs on the server, never in the visitor's browser.
// Holds your secret Google Gemini API key and forwards each request to the
// Gemini API. Uses the free AI Studio tier (no credit card needed) and the
// model's own knowledge — no live web search. Visitors need no account.

// Tries each model in order. If one is rate-limited (429) or temporarily
// overloaded (503), it retries briefly, then falls back to the next model.
// Each model has its own separate free quota, so the fallback helps a lot.
// Find current free-tier model names at https://aistudio.google.com.
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"];

// Status codes worth retrying (transient): rate limit + server overload.
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Pull the suggested wait (seconds) out of a Gemini 429 error, if present.
function retrySeconds(data) {
  try {
    const details = (data && data.error && data.error.details) || [];
    for (const d of details) {
      if (d && typeof d.retryDelay === "string") {
        const m = d.retryDelay.match(/(\d+(\.\d+)?)/);
        if (m) return Math.ceil(parseFloat(m[1]));
      }
    }
  } catch { /* ignore */ }
  return null;
}

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

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const datedSystem =
    "Today's date is " +
    today +
    ". Treat every request as historical research about events that have already happened. " +
    "Never refuse a year, flight, or event on the grounds that it is in the future or has not occurred yet — " +
    "the current year and recent years are in the past. If you have knowledge of matching accidents, report them. " +
    "If you genuinely have no reliable information about the request, say so plainly instead.\n\n" +
    system;

  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: datedSystem }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 2048,
      temperature: 0.4,
      responseMimeType: "application/json", // ask Gemini for clean JSON
    },
  });

  async function attempt(model) {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: payload,
      }
    );
    const rawBody = await r.text();
    let data = null;
    try { data = JSON.parse(rawBody); } catch { /* non-JSON */ }
    return { status: r.status, ok: r.ok, data, rawBody };
  }

  try {
    let last = null;

    // Try each model; within a model, retry transient errors a couple times.
    for (let mi = 0; mi < MODELS.length; mi++) {
      const model = MODELS[mi];
      for (let a = 0; a < 2; a++) {
        last = await attempt(model);

        if (last.ok) {
          const cand = last.data && last.data.candidates && last.data.candidates[0];
          const parts = (cand && cand.content && cand.content.parts) || [];
          const text = parts.map((p) => p.text || "").join("");
          if (text) {
            res.status(200).json({ text });
            return;
          }
          // Empty (e.g. safety block): try next model rather than retrying same.
          break;
        }

        if (!TRANSIENT.has(last.status)) break; // non-retryable (e.g. 400)

        // Transient: wait briefly, then retry. Keep waits short to fit time budget.
        const suggested = last.status === 429 ? retrySeconds(last.data) : null;
        const wait = suggested != null ? Math.min(suggested, 5) : a === 0 ? 1 : 2;
        const isLastTry = mi === MODELS.length - 1 && a === 1;
        if (!isLastTry) await sleep(wait * 1000 + 200);
      }
    }

    // Everything failed — return a clear, friendly message.
    const status = (last && last.status) || 500;
    let friendly;
    if (status === 429) {
      friendly =
        "Busy: the free Gemini tier's quota is momentarily used up across all available models. " +
        "Wait 30–60 seconds and try again.";
    } else if (TRANSIENT.has(status)) {
      friendly =
        "Google's free Gemini servers are briefly overloaded right now (this is temporary and affects everyone). " +
        "Please try again in a few seconds.";
    } else {
      const detail =
        (last && last.data && last.data.error && last.data.error.message) ||
        (last && last.rawBody ? last.rawBody.slice(0, 300) : "") ||
        ("HTTP " + status);
      friendly = "Gemini error (" + status + "): " + detail;
    }
    res.status(status).json({ error: friendly });
  } catch (e) {
    res.status(500).json({ error: e.message || "The request failed." });
  }
}
