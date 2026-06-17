// Backend function. Runs on the server, never in the visitor's browser.
// Holds your secret Google Gemini API key and forwards each request to the
// Gemini API. Uses the free AI Studio tier (no credit card needed) and the
// model's own knowledge — no live web search. Visitors need no account.

// You can change this to any model available on your free tier. Find current
// names at https://aistudio.google.com (look for "Flash" / "Flash-Lite").
// Tip: "gemini-2.5-flash-lite" usually allows more requests per minute.
const MODEL = "gemini-2.5-flash";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Pull the suggested wait (in seconds) out of a Gemini 429 error, if present.
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
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";

  try {
    let r, rawBody, data;
    // Up to 2 attempts: if we hit a short rate-limit blip, wait and retry once.
    for (let attempt = 0; attempt < 2; attempt++) {
      r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: payload,
      });
      rawBody = await r.text();
      data = null;
      try { data = JSON.parse(rawBody); } catch { /* non-JSON */ }

      if (r.status !== 429) break;

      // Rate limited. Retry once only if the suggested wait is short.
      const wait = retrySeconds(data);
      if (attempt === 0 && wait != null && wait <= 6) {
        await sleep(wait * 1000 + 300);
        continue;
      }
      break;
    }

    if (!r.ok) {
      const detail =
        (data && data.error && data.error.message) ||
        (rawBody ? rawBody.slice(0, 300) : "") ||
        ("HTTP " + r.status);
      let friendly;
      if (r.status === 429) {
        const wait = retrySeconds(data);
        friendly =
          "Busy: the free Gemini tier limits how many requests you can make per minute/day. " +
          (wait != null
            ? "Try again in about " + wait + " seconds."
            : "Wait up to a minute and try again.");
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
