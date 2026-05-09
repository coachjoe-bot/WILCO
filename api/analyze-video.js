// Vercel serverless function — proxies video to Gemini File API server-side,
// avoiding browser CORS restrictions on the upload headers.

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: "50mb",
  },
};

const getRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPORT_FOCUS = {
  Football: "hip hinge depth, knee tracking over toes, bar path on squats/deadlifts, core bracing, shoulder position on pressing",
  Basketball: "landing mechanics, knee valgus on jumps, hip loading on deceleration",
  Volleyball: "shoulder position on overhead movements, jump mechanics and landing",
  Soccer: "single-leg stability, hip alignment, ankle position",
  Baseball: "rotational mechanics, shoulder/hip separation, arm path",
  Archery: "stance width, draw arm position, bow shoulder, anchor point consistency",
  "Olympic Weightlifting": "bar path, receiving position, catch depth, overhead stability",
  Running: "foot strike relative to hips, hip extension at push-off, arm drive, forward lean",
  "General Fitness": "joint alignment, bracing, range of motion, symmetry",
};

export default async function handler(req, res) {
  // CORS headers so the browser fetch succeeds
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-File-Name, X-Sport, X-Athlete-Name");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const GEMINI_KEY = process.env.VITE_GEMINI_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_KEY not configured on server" });

  const mimeType = req.headers["content-type"] || "video/mp4";
  const fileName = req.headers["x-file-name"] || "video.mp4";
  const sport = req.headers["x-sport"] || "General Fitness";
  const athleteName = req.headers["x-athlete-name"] || "Athlete";

  try {
    // ── Step 1: Read the uploaded video ──────────────────────────────────────
    const body = await getRawBody(req);
    const fileSize = body.length;

    // ── Step 2: Initiate resumable upload to Gemini ───────────────────────────
    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(fileSize),
          "X-Goog-Upload-Header-Content-Type": mimeType,
        },
        body: JSON.stringify({ file: { display_name: fileName } }),
      }
    );
    if (!initRes.ok) throw new Error(`Gemini upload init failed: ${initRes.status}`);

    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("No Gemini upload URL returned");

    // ── Step 3: Upload the file bytes ─────────────────────────────────────────
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(fileSize),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body,
    });
    if (!uploadRes.ok) throw new Error(`Gemini upload failed: ${uploadRes.status}`);

    const { file: geminiFile } = await uploadRes.json();

    // ── Step 4: Poll until Gemini finishes processing ─────────────────────────
    let activeFile = geminiFile;
    for (let i = 0; i < 40; i++) {
      if (activeFile.state === "ACTIVE") break;
      if (activeFile.state === "FAILED") throw new Error("Gemini video processing failed");
      await sleep(1500);
      const pollRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${geminiFile.name}?key=${GEMINI_KEY}`
      );
      activeFile = await pollRes.json();
    }
    if (activeFile.state !== "ACTIVE") throw new Error("Video processing timed out — try a shorter clip");

    // ── Step 5: Generate coaching feedback ────────────────────────────────────
    const sportFocus = SPORT_FOCUS[sport] || "joint alignment, bracing, range of motion";

    const prompt = `You are Coach Joe Thomas -- high school strength coach, 20+ years military S&C. You are watching a workout video of ${athleteName} (sport: ${sport}).

Give direct, specific coaching feedback on their form. Focus on: ${sportFocus}.

Format your response exactly like this:
Movement: [name what you see them doing]
What's solid: [1-2 things done well]
Fix these:
1. [Most important cue — be specific, e.g. "Drive knees out at the bottom, not in"]
2. [Second cue]
3. [Third cue if applicable]

Keep it under 200 words. No fluff. If the video is unclear or you can't see the movement well, say so.`;

    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { fileData: { mimeType: activeFile.mimeType, fileUri: activeFile.uri } },
                { text: prompt },
              ],
            },
          ],
        }),
      }
    );

    const genData = await genRes.json();
    if (genData.error) throw new Error(genData.error.message);

    const analysis = genData.candidates?.[0]?.content?.parts?.[0]?.text || "No analysis returned.";
    return res.status(200).json({ analysis });

  } catch (err) {
    console.error("analyze-video error:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
