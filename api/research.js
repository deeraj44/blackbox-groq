// Backend function. Runs on the server, never in the visitor's browser.
// It holds your secret Groq API key and forwards each request to Groq's
// OpenAI-compatible endpoint, using the "groq/compound" system which has
// built-in web search. Visitors never see the key and need no account.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: "The server has no GROQ_API_KEY set. Add it in your hosting dashboard.",
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
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model: "groq/compound-mini",
        max_tokens: 2048,
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        // Turn on Groq's built-in live web search (single search per request).
        compound_custom: { tools: { enabled_tools: ["web_search"] } },
      }),
    });

    // Read as text first so we can report Groq's real error if parsing fails.
    const rawBody = await r.text();
    let data = null;
    try { data = JSON.parse(rawBody); } catch { /* non-JSON error body */ }

    if (!r.ok) {
      const detail =
        (data && data.error && data.error.message) ||
        (rawBody ? rawBody.slice(0, 300) : "") ||
        ("HTTP " + r.status);
      res.status(r.status).json({ error: "Groq error (" + r.status + "): " + detail });
      return;
    }

    const text =
      (data &&
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content) ||
      "";

    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message || "The request failed." });
  }
}
