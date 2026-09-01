// ─── FIRST-RUN APP TOUR ───────────────────────────────────────────────────────
// Coach-mark spotlight tour shown once per account (athlete + coach), narrated in
// Joe's voice. The offer re-appears every login until the user RESOLVES it (takes
// the tour or taps "No thanks") — closing the app mid-offer doesn't count.
// Resolution is tour_done_at on the athletes/coaches row, so it follows the
// account across devices.
//
// COPY RULE (Will, 2026-07-27): every card is written for someone who has never
// seen WILCO, doesn't keep a workout journal, and may be new to the gym. No
// insider shorthand, no undefined terms ("1RM", "The Proof", "program" all get
// spelled out), and every step names the screen it's talking about via `banner`.
//
// Everything the tour shows is display-only. The Quick Log demo runs on the
// fixture below (never the athlete's parked draft — see the `demo` guards in
// QuickLogSheet), the chat exchange is scripted (no AI call, no transcript
// write), and Replay from Settings runs the identical rails: real data is never
// deleted, never written, and is exactly as it was the moment the tour ends.
//
// Deliberately NOT importing from App.jsx: App imports this file eagerly, so a
// back-import would be a live circular init (coach.jsx/builder.jsx get away with
// it only because they're lazy). The handful of palette values are copied.
import { useEffect, useState } from "react";

// REBRAND 2026-08-07. These MUST be kept in sync by hand with CA in App.jsx — the
// comment above explains why this file cannot import them. If CA changes, change these.
// DARK MODE (Will, 08-10): same hand-sync constraint applies to the theme flag — this
// re-reads the localStorage key App.jsx's IS_DARK reads, values frozen from 6c8737d.
const TOUR_DARK = (() => { try { return localStorage.getItem("wilco_theme") === "dark"; } catch (_) { return false; } })();
const T = TOUR_DARK ? {
  navy2:"#0a0f1d", navy3:"#0e1830", border:"#182543",
  text:"#e6ecf6", muted:"#7c8aa3", muted2:"#aeb9cf",
  accent:"#3a7bff", cyan:"#37e6ff",
  btn:"linear-gradient(180deg,#57a0ff,#2a63e6)",
  glow:"rgba(58,123,255,.5)",
  onAccent:"#04070f",
} : {
  navy2:"#FFFFFF", navy3:"#F7F4EF", border:"#D9D2C7",
  text:"#1F2A37", muted:"#6B7280", muted2:"#4B5563",
  accent:"#28508B", cyan:"#5B7FB5",
  btn:"#28508B",            // flat: the brand bans gradients
  glow:"transparent",       // and glows
  onAccent:"#F7F4EF",
};
// Spotlight scrim. Still a DARK dim even though the app is now light — a spotlight has
// to suppress everything around the cutout, and dimming light-on-light reads as nothing.
// Dropped 0.82 -> 0.55 and moved off near-black onto the brand ink (dark keeps 0.82).
const DIM = TOUR_DARK ? "rgba(2,5,15,0.82)" : "rgba(31,42,55,0.55)";
// Hand-synced copy of App.jsx's DISP (same no-import constraint as T above). The
// relight referenced DISP here without any local definition, which crashed every
// tour surface at render — caught 08-10 on the store-capture pass.
const DISP = TOUR_DARK
  ? { fontFamily:"'Bebas Neue','Inter',system-ui,-apple-system,sans-serif", fontWeight:400, textTransform:"uppercase" }
  : { fontFamily:"'Inter',system-ui,-apple-system,sans-serif", fontWeight:800, textTransform:"uppercase" };

// ── SAMPLE DATA (Quick Log demo) ─────────────────────────────────────────────
// One believable bench day. Number-first like a real draft; the top single is
// the PR the scripted reply celebrates. Tagged SAMPLE in the sheet header so
// nobody thinks they already have a session on file.
export const TOUR_QL_FIXTURE = {
  draft:
`Bench Press 3x5 @ 175
Bench Press 1x1 @ 190
Incline DB Press 3x10 @ 60
Chest-Supported Row 3x12 @ 120
Tricep Pushdown 3x15 @ 45`,
  notes: "Bench day. 175 moved fast last week, if the top sets feel crisp, 190 is there for a single.",
};

// The scripted chat exchange the demo send plays. No AI call — the reply is
// fixed, which also keeps the tour working on preview deploys (no AI key).
// `session` drives the WORKOUT #N stamp that follows the NEW MAX stamp, exactly
// like a real logged session does (see the send() stamp handoff in App.jsx).
export const TOUR_SCRIPT = {
  pr: { exercise:"Bench Press", weight:190, unit:"lb" },
  session: 1,
  reply: "Workout Logged. Good job on that bench press personal record. I am updating your numbers to reflect the new max. Rows and pushdowns are in the book too.",
};

// ── COPY ─────────────────────────────────────────────────────────────────────
// Per step:
//   banner  — screen name pinned to the top of the display ("you are here")
//   target  — data-tour anchor. An ARRAY unions the rects (chat + its input box
//             read as one region). null → centered card over a full dim.
//   parts   — tap-through text stages; the second lands with emphasis
//   partTargets / interactive / noDim — scalars, or arrays indexed by part
//   cta     — label of a button that must be pressed instead of tapping through
// ── STEPS ────────────────────────────────────────────────────────────────────
// One athlete tour (Will's 09-01 script). The old chat-first and legacy variants
// are gone: the legacy one spotlit `builder-tab` and `quicklog-btn`, both of
// which are retired surfaces, so it had been silently broken for every native
// signup since chat-first shipped.
//
// Step fields, beyond the display ones documented above:
//   enter   — {pane, tab, sub} the tour opens for them BEFORE the card shows.
//             This is what lets the tour walk Memory's three subtabs and
//             Progress's without the athlete hunting for anything. App.jsx
//             applies it; nothing here touches app state.
//   ring    — an extra emphasis ring, on top of the normal spotlight.
//   stamp   — plays a full-screen stamp and auto-advances. No tap.
//   sample  — this step is standing on fixture data (documentation only; the
//             surfaces get their fixtures from App.jsx).
export const athleteTourSteps = ({ free }) => free ? [
  { key:"chat", banner:"WILCO CHAT BOT", target:["chat","chat-input"], title:"TALK TO ME",
    parts:["WILCO is your AI strength coach. Text me like you'd text a real coach: workouts you finished, questions, a knee that's acting up. All of it goes in the box at the bottom."] },
  { key:"thanks", banner:null, target:null, title:"THANKS FOR TRYING WILCO",
    parts:["We hope you love it as much as we do.\n-Joe"], cta:"LET'S GO" },
] : [
  // ── the program tab ──
  { key:"program", banner:"THE PROGRAM TAB", target:"program-btn", title:null, interactive:true,
    parts:["Let's start in the Program tab. This is the bread and butter WILCO runs off of."],
    hint:"Tap Program" },

  { key:"programWhat", banner:"THE PROGRAM TAB", target:"program-doc", title:"YOUR PROGRAM", sample:true,
    enter:{pane:"program", tab:"program"},
    parts:["This is where your program will live. Your program is your training plan: which days you train, and exactly what you do on each of those days."] },

  { key:"programPaste", banner:"THE PROGRAM TAB", target:"program-paste", title:null, sample:true,
    parts:["If you already have a program you can paste it here or drop a screenshot of it, and I'll read it exactly as written."] },

  { key:"memoryTab", banner:"THE PROGRAM TAB", target:"memory-tab", title:null, interactive:[false,true],
    parts:[
      "Don't have a program, or don't know how to write one? That's fine, we'll get to it in a minute.",
      "Right next to your program is your Memory tab, which contains everything I'll remember for you.",
    ],
    hint:"Tap Memory" },

  // ── memory, one subtab per card, each opened for them ──
  { key:"memBlocks", banner:"MEMORY", target:"mem-blocks", title:null, sample:true, card:"bottom",
    enter:{pane:"program", tab:"phases", sub:"blocks"},
    parts:["Past Blocks includes your training history and every program you've run with WILCO."] },

  { key:"memDrafts", banner:"MEMORY", target:"mem-drafts", title:null, sample:true, card:"bottom",
    enter:{pane:"program", tab:"phases", sub:"drafts"},
    parts:["Drafts is your parking garage. Any program, edit, or interview you didn't finish waits here until you come back to it."] },

  { key:"memContext", banner:"MEMORY", target:"mem-context", title:null, sample:true, card:"bottom",
    enter:{pane:"program", tab:"phases", sub:"context"},
    parts:["Athlete Context is what I read before every single reply: your goals, your injuries, how you like to train, and anything you tell me to remember."] },

  // ── building a program ──
  // Closes the pane for them on the way out, the same courtesy the old hand-off
  // step did (Will: no tap-the-X step).
  { key:"buildStamp", banner:null, target:null, title:null, stamp:"build",
    enter:{pane:null},
    parts:[] },

  { key:"builder", banner:"PROGRAM BUILDER", target:["tour-blueprint","chat"], title:"TAKE YOUR TIME ON THIS ONE",
    parts:["Tell me what you're working toward, right here in chat, and we'll write it together. The more you give me, the better it fits."] },

  // ── the workout ──
  { key:"opener", banner:"TODAY'S WORKOUT", target:"start-workout-btn", title:null, interactive:true,
    parts:["Each time you open the app, I'll tell you the workout for the day so you don't have to go looking for it."],
    hint:"Tap Start Workout" },

  { key:"bar", banner:"LOGGING A WORKOUT", target:"session-bar", title:null, interactive:true,
    parts:["As you press Start Workout, the workout log will appear at the bottom of your screen."],
    hint:"Tap the workout log" },

  // noDim so the whole prefilled sheet stays readable — the point of the step is
  // seeing what a filled-out session looks like.
  // TWO PARTS, and the split is load-bearing. Part 0 dims nothing so the whole
  // prefilled session is readable. Part 1 dims and spotlights Finish Workout.
  // An interactive step can NEVER be noDim: the no-dim branch lays a transparent
  // full-screen blocker over everything, which swallows the very tap the step is
  // waiting for.
  { key:"sheet", banner:null, target:"finish-btn", title:null, sample:true,
    noDim:[true,false], interactive:[false,true], partTargets:[null,"finish-btn"],
    parts:[
      "As you go through the workout, fill in numbers, make any adjustments, and tap Finish Workout to log it.",
      "This one's a sample session. Go ahead and finish it.",
    ],
    hint:"Tap Finish Workout" },

  { key:"script", banner:null, target:null, script:true, parts:[] },

  { key:"logged", banner:"WILCO CHAT BOT", target:null, noDim:true, title:null,
    parts:["Finishing the workout logged the whole session and caught your PR. Anything else you tell me, injuries included, I take note of too."] },

  // ── the numbers ──
  { key:"benchmarks", banner:"PROGRESS", target:"prog-benchmarks", title:null, sample:true, card:"bottom",
    enter:{pane:"progress", sub:"benchmarks"},
    parts:["Your numbers live here. Benchmarks ranks your lifts against real strength standards for your age and bodyweight."] },

  { key:"strength", banner:"PROGRESS", target:"prog-strength", title:null, sample:true, card:"bottom",
    enter:{pane:"progress", sub:"strength"},
    parts:["Strength tracks every lift you've logged over time and shows your progress."] },

  { key:"prs", banner:"PROGRESS", target:"prog-prs", title:null, sample:true, card:"bottom",
    enter:{pane:"progress", sub:"prs"},
    parts:["PRs is every personal record you've set. You can enter any you already know manually as a starting point."] },

  { key:"percent", banner:"PROGRESS", target:null, title:null, sample:true,
    parts:["When your program calls for a percentage, I work it off your true one-rep max if you've given me one, or off my best estimate from what you've actually logged."] },

  // ── finding your way back (Will, 09-01) ──
  // Progress closes itself, they land on the chat, and they open My Log
  // themselves. Draft 3 teleported them and they never learned to navigate.
  { key:"navBack", banner:"MY LOG", target:"mylog-btn", title:null, interactive:true,
    enter:{pane:null},
    parts:["Closing a tab always brings you back here, to your chat. Everything else lives along the top. Tap My Log to see the session you just finished."],
    hint:"Tap My Log" },

  { key:"mylog", banner:"MY LOG", target:"mylog-entry", title:null, sample:true, card:"bottom",
    enter:{pane:"log", sub:"workouts"},
    parts:["Every session you've logged lives here."] },

  { key:"proof", banner:"THE PROOF", target:"mylog-proof", title:null, sample:true, card:"bottom",
    enter:{pane:"log", sub:"proof"},
    parts:["Once a week, The Proof drops. It's a news-feed look at your training: you zoom out from the day to day, see which direction you're headed, and evaluate your progress and any changes you want to make."] },

  { key:"thanks", banner:null, target:null, title:"THANKS FOR TRYING WILCO",
    enter:{pane:null},
    parts:["We hope you love it as much as we do.\n-Joe"], cta:"LET'S GO" },
];

export const coachTourSteps = () => [
  { key:"overview", banner:"THE OVERVIEW TAB", target:"coach-tab-overview", title:"YOUR MORNING GLANCE",
    parts:["Start here. Who trained, who's gone quiet, and what needs your eyes today, before you've had your coffee."] },
  { key:"athletes", banner:"THE ATHLETES TAB", target:"coach-tab-athletes", title:"YOUR ROSTER",
    parts:[
      "Every athlete you coach lives here: their workout log, their numbers, and the training plan they're following.",
      "Any change you make to an athlete's plan is staged for you to review before they ever see it.",
    ] },
  { key:"reports", banner:"THE REPORTS TAB", target:"coach-tab-reports", title:"REPORTS",
    parts:["Weekly write-ups covering your whole roster. The story of your program, written while you coach it."] },
  { key:"thanks", banner:null, target:null, title:"THANKS FOR USING WILCO",
    parts:["We hope you love it as much as we do.\nJoe"], cta:"Finish" },
];

// Joe's first real message, landed the moment the first-run tour finishes (the
// scripted exchange and sample data are already gone). Free tier gets the
// no-Quick-Log variant.
export const tourWelcome = (firstName, free) => free
  ? `Welcome, ${firstName}. Tell me what you're training for and we'll get to work.`
  : `Welcome, ${firstName}. Glad to see you've joined, let's get to work. Ready to log your first workout, or want to build your program first?`;

// ── OFFER POPUP ──────────────────────────────────────────────────────────────
// Doubles as the app's welcome moment: it's the first thing a brand-new account
// ever sees. Replay (from Settings) skips it entirely and starts the tour, so
// the "welcome" framing only ever shows on a genuine first run.
// Two stages (Will, 09-01). Stage 0 introduces Joe-bot with the chat lit behind
// it and a ring around the composer, so a brand-new athlete learns where words
// go whether or not they take the tour. Stage 1 is the actual offer. Splitting
// them is why the intro copy can promise something before the question is asked.
// Replay from Settings skips stage 0 — they have met Joe-bot already.
export function TourOffer({ role="athlete", onStart, onDecline }) {
  const [stage, setStage] = useState(role==="coach" ? 1 : 0);
  const inputRect = useAnchorRect(stage===0 ? ["chat","chat-input"] : null);
  const ringRect  = useAnchorRect(stage===0 ? "chat-input" : null);
  const body = role==="coach"
    ? "Want a tutorial of WILCO? Give me two minutes and I'll show you where everything lives on your dashboard."
    : "Want a tutorial of WILCO? Give me two minutes and I'll give you the rundown.";

  // Stage 0: spotlight the chat, ring the composer, one card, tap to continue.
  if (stage === 0) {
    const pad = 2;
    const hole = inputRect
      ? { top:inputRect.top-pad, left:inputRect.left-pad, width:inputRect.width+pad*2, height:inputRect.height+pad*2 }
      : null;
    const panel = (extra) => ({ position:"fixed", background:DIM, zIndex:1201, ...extra });
    const next = () => setStage(1);
    return (
      <>
        {hole ? (
          <>
            <div style={panel({top:0,left:0,right:0,height:Math.max(0,hole.top)})} onClick={next}/>
            <div style={panel({top:hole.top,left:0,width:Math.max(0,hole.left),height:hole.height})} onClick={next}/>
            <div style={panel({top:hole.top,left:hole.left+hole.width,right:0,height:hole.height})} onClick={next}/>
            <div style={panel({top:hole.top+hole.height,left:0,right:0,bottom:0})} onClick={next}/>
            <div style={{position:"fixed",top:hole.top,left:hole.left,width:hole.width,height:hole.height,
              background:"transparent",zIndex:1201}} onClick={next}/>
          </>
        ) : (
          <div style={panel({inset:0})} onClick={next}/>
        )}
        {/* The composer gets its own, louder ring — Will asked for a glow around
            the text box specifically, not just the chat region. */}
        {ringRect && (
          <div style={{position:"fixed",top:ringRect.top-4,left:ringRect.left-4,
            width:ringRect.width+8,height:ringRect.height+8,borderRadius:14,
            border:`2.5px solid ${T.accent}`,
            boxShadow:`0 0 22px 5px ${T.accent}66`,
            animation:"tourPulse 1.8s ease-in-out infinite",
            pointerEvents:"none",zIndex:1202}}/>
        )}
        <div className="fade-up" onClick={next}
          style={{position:"fixed",left:16,right:16,marginLeft:"auto",marginRight:"auto",
            top:"32%",width:"100%",maxWidth:340,background:T.navy2,border:`1px solid ${T.border}`,
            borderRadius:14,padding:"16px 18px",zIndex:1202,cursor:"pointer",
            boxShadow:"0 12px 40px rgba(31,42,55,0.35)"}}>
          <div style={{...DISP,fontSize:19,color:T.cyan,letterSpacing:2,marginBottom:6}}>JOE-BOT</div>
          <div style={{color:T.text,fontSize:13.5,lineHeight:1.65}}>
            I'm Joe-bot, your assistant coach. Text me the way you'd text a real coach: log a workout, ask a question, mention any injuries. I'm here to help.
          </div>
          <div style={{color:T.muted,fontSize:10.5,marginTop:10,letterSpacing:.5}}>Tap to continue</div>
        </div>
        <style>{`@keyframes tourPulse{0%,100%{box-shadow:0 0 22px 5px ${T.accent}66,0 0 0 0 ${T.accent}55}50%{box-shadow:0 0 22px 5px ${T.accent}66,0 0 0 9px ${T.accent}00}}`}</style>
      </>
    );
  }

  // Stage 1: the offer itself. Two buttons, brand navy and cream.
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(31,42,55,0.55)",zIndex:1200,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div className="fade-up" style={{width:"100%",maxWidth:360,background:T.navy2,border:`1px solid ${T.border}`,borderRadius:16,padding:22,textAlign:"center"}}>
        <img src="/icon-192.png" alt="" width={52} height={52} style={{borderRadius:13,marginBottom:10}}/>
        <div style={{...DISP,fontSize:26,color:T.cyan,letterSpacing:2}}>WELCOME TO WILCO</div>
        <div style={{color:T.muted2,fontSize:13.5,lineHeight:1.6,marginTop:6,marginBottom:16}}>{body}</div>
        <button onClick={onStart}
          style={{width:"100%",background:T.btn,boxShadow:`0 0 12px ${T.glow}`,border:"none",color:T.onAccent,borderRadius:10,padding:"13px",cursor:"pointer",fontSize:15,fontWeight:700,...DISP,letterSpacing:2}}>
          START TUTORIAL
        </button>
        {/* Cream, not a bare text link: Will asked for two real buttons. */}
        <button onClick={onDecline}
          style={{width:"100%",background:T.navy3,border:`1px solid ${T.border}`,color:T.muted2,borderRadius:10,padding:"12px",cursor:"pointer",fontSize:14,fontWeight:600,marginTop:8,fontFamily:"'Inter'"}}>
          I'm good
        </button>
      </div>
    </div>
  );
}

// ── SPOTLIGHT ENGINE ─────────────────────────────────────────────────────────
// Tracks anchor rects on an interval (cheap, and survives layout shifts / pane
// animations without wiring refs through 10k lines of App.jsx). An array target
// unions its rects into one region. The dim is the ring's own giant box-shadow,
// so the hole is genuinely clear; four blocker panels around it make everything
// outside inert, and passive steps cover the hole too, so the only thing a tap
// can do is advance.
function useAnchorRect(target) {
  const key = Array.isArray(target) ? target.join("|") : (target || "");
  const [rect, setRect] = useState(null);
  useEffect(() => {
    if (!key) { setRect(null); return; }
    const names = key.split("|");
    let alive = true;
    const measure = () => {
      if (!alive) return;
      let box = null;
      for (const n of names) {
        const el = document.querySelector(`[data-tour="${n}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        box = box
          ? { top:Math.min(box.top,r.top), left:Math.min(box.left,r.left),
              right:Math.max(box.right,r.right), bottom:Math.max(box.bottom,r.bottom) }
          : { top:r.top, left:r.left, right:r.right, bottom:r.bottom };
      }
      if (!box) { setRect(null); return; }
      const next = { top:box.top, left:box.left, width:box.right-box.left, height:box.bottom-box.top };
      setRect((prev) =>
        prev && Math.abs(prev.top-next.top)<1 && Math.abs(prev.left-next.left)<1 &&
        Math.abs(prev.width-next.width)<1 && Math.abs(prev.height-next.height)<1
          ? prev : next);
    };
    measure();
    const iv = setInterval(measure, 250);
    window.addEventListener("resize", measure);
    return () => { alive = false; clearInterval(iv); window.removeEventListener("resize", measure); };
  }, [key]);
  return rect;
}

// Scalar-or-per-part step fields.
const atPart = (v, part, fallback) =>
  Array.isArray(v) ? (v[part] !== undefined ? v[part] : fallback) : (v !== undefined ? v : fallback);

// Exported so App.jsx's tap handler agrees with the overlay about which parts
// wait on a real tap (a per-part array is truthy, so `!!step.interactive` lies).
export const tourInteractiveAt = (step, part) => !!atPart(step?.interactive, part, false);

export function TourSpotlight({ step, part, steps, stepIndex, onTap, onCta, onSkip }) {
  const target = step.partTargets ? atPart(step.partTargets, part, step.target) : step.target;
  const interactive = atPart(step.interactive, part, false);
  const noDim = atPart(step.noDim, part, false);
  const rect = useAnchorRect(noDim ? null : target);
  // Optional second ring, drawn tighter than the spotlight, for a step that
  // wants one control emphasised inside a larger lit region.
  const ringRect = useAnchorRect(step.ring || null);
  const pad = Array.isArray(target) || target === "chat" ? 2 : 6;
  const text = step.parts[Math.min(part, step.parts.length - 1)] || "";
  const lastPart = part >= step.parts.length - 1;
  const showCta = !!step.cta && lastPart;

  // Progress dots skip the invisible scripted step so the count matches what
  // the user actually sees.
  const visible = (steps || []).filter(s => !s.script);
  const dotCount = visible.length;
  const dotIndex = Math.max(0, visible.findIndex(s => s.key === step.key));

  const Banner = step.banner ? (
    <div style={{position:"fixed",top:0,left:0,right:0,zIndex:1104,display:"flex",justifyContent:"center",
      paddingTop:"calc(8px + env(safe-area-inset-top, 0px))",paddingBottom:8,pointerEvents:"none",
      background:"linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(31,42,55,0.55) 70%, rgba(247,244,239,0) 100%)"}}>
      <div style={{...DISP,fontSize:13,letterSpacing:3,color:T.cyan,
        border:`1px solid ${T.cyan}55`,borderRadius:999,padding:"4px 14px",background:"rgba(31,42,55,0.55)"}}>
        {step.banner}
      </div>
    </div>
  ) : null;

  // Script step: invisible full blocker — the chat plays underneath, taps do
  // nothing, Skip stays available.
  if (step.script) {
    return (
      <div style={{position:"fixed",inset:0,zIndex:1100}}>
        <SkipBtn onSkip={onSkip}/>
      </div>
    );
  }

  const hole = rect && !noDim
    ? { top:rect.top-pad, left:rect.left-pad, width:rect.width+pad*2, height:rect.height+pad*2 }
    : null;

  // Card below the hole when there's room, above it when there's room up top,
  // centered otherwise (a hole that fills the screen — the chat step).
  // WILL 09-01: the old fallback centred the card at 38% whenever neither side
  // had 250px, which put it ON TOP of the very control it was describing —
  // exactly what he caught on the opener (a tall bubble with three buttons under
  // it) and on the log sheet. A card must never cover its own target. So when
  // neither side fits outright, DOCK to whichever side has more room and let the
  // target keep its space, instead of centring over it. Only a hole that is
  // genuinely absent leaves the card centred.
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const FITS = 250;   // room for the card at its usual height
  const MIN  = 96;    // below this a docked card would sit off-screen
  let cardTop = "38%", cardBottom = null;
  // `card:"bottom"` overrides the geometry. Used where the spotlight sits at the
  // top of a screen whose CONTENT is the point of the step — The Proof's
  // masthead, the My Log entry — and a card docked under the tab would cover the
  // very thing the athlete is being told to look at.
  if (step.card === "bottom") { cardTop = null; cardBottom = 16; }
  else if (step.card === "top") { cardTop = 84; }
  else if (noDim) { cardTop = null; cardBottom = 16; }   // full screen visible; card sits at the bottom
  else if (hole) {
    const spaceBelow = vh - (hole.top + hole.height);
    const spaceAbove = hole.top;
    if (spaceBelow > FITS) cardTop = hole.top + hole.height + 12;
    else if (spaceAbove > FITS) { cardTop = null; cardBottom = vh - hole.top + 12; }
    else if (Math.max(spaceBelow, spaceAbove) > MIN) {
      // Neither side is roomy. Take the roomier one anyway and let the card
      // scroll its own overflow, rather than covering the target.
      if (spaceBelow >= spaceAbove) cardTop = hole.top + hole.height + 8;
      else { cardTop = null; cardBottom = vh - hole.top + 8; }
    }
    // else: the hole fills the screen (the chat step) — centred is correct.
  }

  // The dim is FOUR PANELS around the hole, not one giant box-shadow spread off
  // the ring. The shadow approach painted over the spotlit control and the card
  // no matter their z-index — a bright blue Send button rendered as muddy navy.
  // Panels leave the hole genuinely untouched, and they double as the tap
  // blockers that keep the tour on rails.
  const panel = (extra) => ({ position:"fixed", background:DIM, zIndex:1101, ...extra });
  const clear = (extra) => ({ position:"fixed", background:"transparent", zIndex:1101, ...extra });
  const tapProps = interactive ? {} : { onClick: onTap };

  return (
    <>
      {Banner}
      {/* Ring: 2px cyan + outer glow only, never a fill or inner glow (both wash
          over controls that have their own colour). Deliberately loud — at 1.5px
          over a dark UI the "highlighted" control read as merely less-dark. */}
      {hole && (
        <div style={{position:"fixed",top:hole.top,left:hole.left,width:hole.width,height:hole.height,
          borderRadius:12,border:`2px solid ${T.cyan}`,
          boxShadow:"0 0 18px 2px rgba(55,230,255,.55)",
          animation:"tourPulse 1.8s ease-in-out infinite",
          transition:"top .35s ease, left .35s ease, width .35s ease, height .35s ease",
          pointerEvents:"none",zIndex:1102}}/>
      )}
      {ringRect && (
        <div style={{position:"fixed",top:ringRect.top-4,left:ringRect.left-4,
          width:ringRect.width+8,height:ringRect.height+8,borderRadius:14,
          border:`2.5px solid ${T.accent}`,boxShadow:`0 0 22px 5px ${T.accent}66`,
          pointerEvents:"none",zIndex:1103}}/>
      )}
      {noDim ? (
        // Nothing dimmed (the whole sample log has to be readable), but the tour
        // still owns every tap.
        <div style={clear({inset:0})} {...tapProps}/>
      ) : hole ? (
        <>
          <div style={panel({top:0,left:0,right:0,height:Math.max(0,hole.top)})} {...tapProps}/>
          <div style={panel({top:hole.top,left:0,width:Math.max(0,hole.left),height:hole.height})} {...tapProps}/>
          <div style={panel({top:hole.top,left:hole.left+hole.width,right:0,height:hole.height})} {...tapProps}/>
          <div style={panel({top:hole.top+hole.height,left:0,right:0,bottom:0})} {...tapProps}/>
          {/* passive steps: the hole is inert too, so a stray tap just advances */}
          {!interactive && <div style={clear({top:hole.top,left:hole.left,width:hole.width,height:hole.height})} {...tapProps}/>}
        </>
      ) : (
        <div style={panel({inset:0})} {...tapProps}/>
      )}
      {/* card. Centered via left/right+margin, NOT translateX — the fade-up
          animation animates transform and would clobber it mid-flight. */}
      <div key={`${step.key}-${part}`} className="fade-up" onClick={interactive ? undefined : onTap}
        style={{position:"fixed",left:16,right:16,marginLeft:"auto",marginRight:"auto",
          ...(cardTop!==null ? {top:cardTop} : {bottom:cardBottom}),
          width:"100%",maxWidth:340,background:T.navy2,border:`1px solid ${T.border}`,
          borderRadius:14,padding:"16px 18px",zIndex:1102,cursor:interactive?"default":"pointer",
          maxHeight:"calc(100vh - 32px)",overflowY:"auto",
          boxShadow:"0 12px 40px rgba(31,42,55,0.35)"}}>
        {step.title && <div style={{...DISP,fontSize:19,color:T.cyan,letterSpacing:2,marginBottom:6}}>{step.title}</div>}
        <div style={{color:T.text,fontSize:13.5,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{text}</div>
        {showCta && (
          <button onClick={(e)=>{e.stopPropagation();onCta();}}
            style={{width:"100%",marginTop:12,background:T.btn,boxShadow:`0 0 12px ${T.glow}`,border:"none",color:T.onAccent,borderRadius:9,padding:"11px",cursor:"pointer",fontSize:13.5,fontWeight:700,...DISP,letterSpacing:1.5}}>
            {step.cta}
          </button>
        )}
        {interactive && step.hint && (
          <div style={{color:T.cyan,fontSize:11.5,marginTop:10,letterSpacing:.5,display:"flex",alignItems:"center",gap:6}}>
            <span style={{display:"inline-block",width:6,height:6,borderRadius:"50%",background:T.cyan,animation:"tourPulse 1.2s ease-in-out infinite"}}/>
            {step.hint}
          </div>
        )}
        {!interactive && !showCta && (
          <div style={{color:T.muted,fontSize:10.5,marginTop:10,letterSpacing:.5}}>Tap to continue</div>
        )}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:10}}>
          <div style={{display:"flex",gap:5}}>
            {Array.from({length:dotCount}).map((_,i)=>(
              <span key={i} style={{width:6,height:6,borderRadius:"50%",background:i===dotIndex?T.cyan:T.border,display:"inline-block"}}/>
            ))}
          </div>
          <button onClick={(e)=>{e.stopPropagation();onSkip();}}
            style={{background:"none",border:"none",color:T.muted,fontSize:11.5,cursor:"pointer",padding:"2px 4px"}}>
            Skip tour
          </button>
        </div>
      </div>
      <style>{`@keyframes tourPulse{0%,100%{box-shadow:0 0 18px 2px rgba(55,230,255,.55),0 0 0 0 rgba(55,230,255,.45)}50%{box-shadow:0 0 18px 2px rgba(55,230,255,.55),0 0 0 9px rgba(55,230,255,0)}}`}</style>
    </>
  );
}

function SkipBtn({ onSkip }) {
  return (
    <button onClick={onSkip}
      style={{position:"fixed",right:14,bottom:18,zIndex:1103,
        background:"rgba(255,255,255,0.94)",border:`1px solid ${T.border}`,color:T.muted,borderRadius:8,
        padding:"6px 12px",cursor:"pointer",fontSize:11.5}}>
      Skip tour
    </button>
  );
}
