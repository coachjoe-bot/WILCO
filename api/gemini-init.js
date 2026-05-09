// Returns a Gemini resumable upload URL — server-side so the API key
// isn't used in the browser and the custom response headers can be read.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const GEMINI_KEY = process.env.VITE_GEMINI_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_KEY not configured" });

  const { type, size, name } = req.query;
  if (!type || !size || !name) return res.status(400).json({ error: "Missing type, size, or name" });

  try {
    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(size),
          "X-Goog-Upload-Header-Content-Type": type,
        },
        body: JSON.stringify({ file: { display_name: name } }),
      }
    );

    if (!initRes.ok) {
      const text = await initRes.text();
      return res.status(500).json({ error: `Gemini init failed (${initRes.status}): ${text}` });
    }

    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) return res.status(500).json({ error: "Gemini did not return an upload URL" });

    return res.status(200).json({ uploadUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
