// Receives an already-uploaded, already-ACTIVE Gemini file name and
// generates coaching feedback. Fast — no upload, no polling.

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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const GEMINI_KEY = process.env.VITE_GEMINI_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_KEY not configured" });

  const { fileUri, mimeType, sport, athleteName } = req.body;
  if (!fileUri) return res.status(400).json({ error: "Missing fileUri" });

  const sportFocus = SPORT_FOCUS[sport] || "joint alignment, bracing, range of motion";

  const prompt = `You are Coach Joe Thomas -- high school strength coach, 20+ years military S&C. You are watching a workout video of ${athleteName || "an athlete"} (sport: ${sport || "General Fitness"}).

Give direct, specific coaching feedback on their form. Focus on: ${sportFocus}.

Format your response exactly like this:
Movement: [name what you see them doing]
What's solid: [1-2 things done well]
Fix these:
1. [Most important cue — be specific, e.g. "Drive knees out at the bottom, not in"]
2. [Second cue]
3. [Third cue if applicable]

Keep it under 200 words. No fluff. If the video is unclear, describe what you can see and flag it.`;

  try {
    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [
            { fileData: { mimeType: mimeType || "video/mp4", fileUri } },
            { text: prompt },
          ]}],
        }),
      }
    );

    const data = await genRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || "No analysis returned.";
    return res.status(200).json({ analysis });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
