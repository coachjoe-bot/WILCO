import { useState, useEffect, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CLAUDE_PROXY  = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/claude-proxy`;
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = import.meta.env.VITE_SUPABASE_KEY;
const MASTER_CODE   = "FORTIS-MASTER"; // keep for backward compat

const SPORTS = ["Football","Basketball","Volleyball","Soccer","Baseball","Archery","Olympic Weightlifting","Running","General Fitness"];

// ─── TIERS ────────────────────────────────────────────────────────────────────
const TIERS = {
  free:  { label:"FREE",  color:"#6b7280", price:"Free",        priceNote:"No credit card needed",            badge:"FREE"  },
  pro:   { label:"PRO",   color:"#d4a017", price:"$14.99/mo",   priceNote:"or $150/yr · Cancel anytime",      badge:"PRO"   },
  elite: { label:"ELITE", color:"#3b82f6", price:"$99.99/mo",   priceNote:"or $1,000/yr · Cancel anytime",    badge:"ELITE" },
};

// ─── SUPABASE ────────────────────────────────────────────────────────────────
const sbH = {"Content-Type":"application/json","apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`};
const sbGet = async (table,params="") => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`,{headers:{...sbH,"Prefer":"return=representation"}});
  return r.json();
};
const sbInsert = async (table,data) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`,{method:"POST",headers:{...sbH,"Prefer":"return=representation"},body:JSON.stringify(data)});
  return r.json();
};
const sbUpdate = async (table,id,data) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,{method:"PATCH",headers:{...sbH,"Prefer":"return=representation"},body:JSON.stringify(data)});
  const json = await r.json();
  if(!r.ok) throw new Error(json?.message||json?.error||`Update failed (${r.status})`);
  return json;
};
const sbDelete = async (table,params="") => {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`,{method:"DELETE",headers:sbH});
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
// Compare dates at midnight local time — fixes the "-1d" timezone bug
const daysBetween = (date) => {
  if(!date) return null;
  const now = new Date();
  const then = new Date(date);
  const nowMid  = new Date(now.getFullYear(),  now.getMonth(),  now.getDate());
  const thenMid = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  return Math.round((nowMid - thenMid) / (1000*60*60*24));
};

const fmtDate = (d) => new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"});
const fmtDateShort = (d) => new Date(d).toLocaleDateString("en-US",{month:"short",day:"numeric"});

// Epley estimated 1-rep max: weight × (1 + reps/30)
// Lets us compare e.g. 225×5 vs 225×3 — more reps at same weight = more strength.
const epley1RM = (weight, reps) => {
  if(!weight||weight<=0) return 0;
  if(!reps||reps<=1) return weight;
  return Math.round(weight * (1 + reps / 30));
};

// Format weight with correct unit label. Falls back to "lbs" for legacy data.
const fmtWeight = (weight, unit) => {
  if(!weight) return "—";
  const u = unit==="kg" ? "kg" : "lbs";
  return `${weight}${u}`;
};

// Normalize any weight to lbs-equivalent for cross-unit comparison.
const toLbs = (weight, unit) => (unit==="kg" ? weight*2.205 : weight);

// A "real session" has at least one parsed exercise or run_data (filters out pure Q&A messages)
const isRealSession = (w) => w?.parsed_data?.exercises?.length > 0 || !!w?.parsed_data?.run_data;

// Normalize exercise names so minor wording variations map to the same PR key.
// Preserves meaningful distinctions (e.g. "Power Snatch" vs "Power Snatch from the Floor").
const normalizeExName = (name) => {
  if(!name) return "";
  return name.toLowerCase().trim()
    .replace(/\s+/g," ")
    .replace(/\bohp\b/g,"overhead press")
    .replace(/\bbb\b/g,"barbell")
    .replace(/\bdb\b/g,"dumbbell")
    .replace(/\bkb\b/g,"kettlebell")
    .replace(/\brdl\b/g,"romanian deadlift")
    .replace(/pull[ -]?ups?\b/g,"pull-up")
    .replace(/chin[ -]?ups?\b/g,"chin-up")
    .replace(/push[ -]?ups?\b/g,"push-up")
    .trim();
};

// Groups workout entries into sessions using time-gap logic.
// Entries within gapMs of each other (same athlete) = same session.
// new_session:true in parsed_data forces a split even within the gap window.
const groupIntoSessions = (workouts, gapMs = 3*60*60*1000) => {
  const byAthlete = {};
  workouts.filter(isRealSession).forEach(w => {
    if(!byAthlete[w.athlete_id]) byAthlete[w.athlete_id] = [];
    byAthlete[w.athlete_id].push(w);
  });
  const sessions = [];
  Object.values(byAthlete).forEach(entries => {
    const sorted = [...entries].sort((a,b)=>new Date(a.created_at)-new Date(b.created_at));
    let lastTime = null; let cur = null;
    sorted.forEach(w => {
      const t = new Date(w.created_at).getTime();
      if(!lastTime || w.parsed_data?.new_session===true || t-lastTime>gapMs){
        cur = {entries:[w],athleteId:w.athlete_id}; sessions.push(cur);
      } else { cur.entries.push(w); }
      lastTime = t;
    });
  });
  return sessions;
};


// ─── CLAUDE ──────────────────────────────────────────────────────────────────
const askClaude = async (system, user, maxTokens=600, images=[]) => {
  const content = [];
  for(const img of images){
    content.push({type:"image",source:{type:"base64",media_type:"image/jpeg",data:img}});
  }
  content.push({type:"text",text:user});
  const r = await fetch(CLAUDE_PROXY,{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":`Bearer ${SUPABASE_KEY}`},
    body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:maxTokens,system,messages:[{role:"user",content}]})
  });
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text||"";
};

const extractProgramText = async (message) => {
  const text = await askClaude(
    "Extract the training program from this athlete message. Return only the program content — days, exercises, sets, reps, weights. Clean formatting. No intro, no commentary, no explanation.",
    message, 800
  );
  return text?.trim() || message;
};

const parseWorkout = async (message, name, sport) => {
  const sys = `Extract workout data from an athlete message. Return ONLY valid JSON, no markdown.
{
  "exercises":[{"name":string,"sets":number|null,"reps":number|null,"weight":number|null,"unit":"lbs"|"kg"|"bodyweight","feel":"easy"|"good"|"hard"|null,"notes":string|null}],
  "run_data":{"run_type":"easy"|"tempo"|"interval"|"long_run"|"race"|"recovery"|"fartlek"|null,"distance_miles":number|null,"distance_km":number|null,"duration_minutes":number|null,"pace_per_mile":string|null,"pace_per_km":string|null,"heart_rate_avg":number|null,"heart_rate_max":number|null,"intervals":[{"repeat":number|null,"distance":string|null,"time":string|null,"pace":string|null,"rest":string|null}]|null,"notes":string|null}|null,
  "pain_flags":[{"area":string,"description":string}],
  "equipment_issues":[string],
  "questions":[string],
  "pr_attempts":[{"exercise":string,"weight":number,"reps":number,"achieved":boolean}],
  "session_feel":"great"|"good"|"average"|"rough"|null,
  "general_notes":string|null,
  "is_program_update":boolean,
  "is_temp_program_update":boolean,
  "is_program_revert":boolean
}
Rules:
- Populate "run_data" when the message describes any run, jog, cardio, or running workout. Set run_type to the best match. Calculate pace if distance and time are both given.
- For interval runs, populate "intervals" array with one entry per repeat type.
- Populate "exercises" for strength/lifting/conditioning work. Leave empty for pure runs.
- If the athlete mentions heart rate, bpm, avg HR, or max HR, populate heart_rate_avg and/or heart_rate_max in run_data.
- Set is_program_update:true ONLY if the message itself CONTAINS the actual program content with specific exercises, sets, and reps. The program data must be present in the message itself — NOT for requests like "update my program", "save my program", "can you update that", or any message that requests an update without providing the program content.
- Set is_temp_program_update:true when the athlete has described their available equipment or conditions for a non-standard training situation (hotel, cruise, travel, beach, limited equipment, injury restrictions). Must include actual condition info — NOT set just because they mention traveling or ask what to do.
- Set is_program_revert:true when the athlete signals they are returning to their normal training environment ("I'm back", "home now", "back at the gym", "back to normal", "cruise is over", etc.).
- If weight is given in kg (e.g. "100kg squat"), set unit:"kg".`;
  const text = await askClaude(sys,`Athlete: ${name} (${sport})\nMessage: ${message}`,1000);
  try { return JSON.parse(text.replace(/```json|```/g,"").trim()); }
  catch { return {exercises:[],run_data:null,pain_flags:[],equipment_issues:[],questions:[],pr_attempts:[],session_feel:null,general_notes:message,is_program_update:false,is_temp_program_update:false,is_program_revert:false}; }
};

const getJoeBotReply = async (message, athlete, history, workoutHistory=[]) => {
  const hist = history.slice(-6).map(m=>`${m.role==="user"?athlete.name:"Coach Joe"}: ${m.content}`).join("\n");

  // Improved history context with explicit dates so bot can answer "what did I do Monday" etc.
  let pastContext = "";
  if(workoutHistory?.length>0){
    const recent = workoutHistory.slice(0,10).map(w=>{
      const d = new Date(w.created_at);
      const dateStr = d.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric",year:"numeric"});
      const runD = w.parsed_data?.run_data;
      const exs = runD
        ? `${runD.run_type||"run"}${runD.distance_miles?" "+runD.distance_miles+"mi":runD.distance_km?" "+runD.distance_km+"km":""}${runD.pace_per_mile?" @ "+runD.pace_per_mile+"/mi":runD.pace_per_km?" @ "+runD.pace_per_km+"/km":""}${runD.duration_minutes?" ("+runD.duration_minutes+"min)":""}`
        : w.parsed_data?.exercises?.map(e=>`${e.name}${e.weight?" "+fmtWeight(e.weight,e.unit):""}${e.sets&&e.reps?" "+e.sets+"x"+e.reps:""}${e.feel?" ("+e.feel+")":""}`).join(", ")||"";
      const pain = w.parsed_data?.pain_flags?.map(p=>p.area).join(", ")||"";
      const feel = w.parsed_data?.session_feel?` | Session feel: ${w.parsed_data.session_feel}`:"";
      return `• ${dateStr}: ${exs||w.raw_message?.slice(0,120)}${pain?" | PAIN: "+pain:""}${feel}`;
    }).filter(Boolean).join("\n");
    pastContext = `\n\nATHLETE WORKOUT HISTORY (most recent first):\n${recent}\nWhen asked what they did on a specific day or recently, reference these exact dates and numbers.`;
  }

  let programContext = "";
  if(athlete.temp_program_text){
    programContext = `\n\nTEMPORARY ADAPTED PROGRAM (currently active — use this, not the regular program):\n${athlete.temp_program_text}`;
    if(athlete.program_text){
      programContext += `\n\nREGULAR PROGRAM (on hold — restore when athlete returns to normal):\n${athlete.program_text}`;
    }
  } else if(athlete.program_text){
    programContext = `\n\nATHLETE'S CURRENT PROGRAM:\n${athlete.program_text}\nReference this when giving programming feedback.`;
  }

  const goalMap = {
    strength:"GOAL: Maximum strength. Compound lifts, progressive overload, volume. Keep it simple and heavy.",
    sport:"GOAL: Sport performance. Build the strength base first, then convert to power and speed. Tie advice to their sport.",
    speed:"GOAL: Speed and endurance. Mix strength with conditioning. Running-specific guidance when relevant.",
    body:"GOAL: Body composition. Strength training with hypertrophy volume. Track consistency over perfection.",
    fitness:"GOAL: General health and fitness. Balanced program — squat, hinge, push, pull, carry. Longevity focus.",
  };
  const phaseContext = goalMap[athlete.goal||"strength"] || goalMap.strength;

  const sportPriorities = {
    "Football":"Lower body power (squat/deadlift/hip hinge), upper body strength (bench/row), explosive hip extension.",
    "Basketball":"Lower body explosiveness, vertical (after strength base), lateral quickness, core stability.",
    "Volleyball":"Vertical jump (after strength base), shoulder stability, core power, lower body strength.",
    "Soccer":"Lower body strength and power, single-leg stability, change of direction, aerobic base.",
    "Baseball":"Rotational power, posterior chain, shoulder health, single-leg strength.",
    "Archery":"Shoulder stability, posterior chain, core anti-rotation, grip strength.",
    "Olympic Weightlifting":"Snatch and clean technique, posterior chain, mobility, overhead stability.",
    "Running":"Single-leg strength, posterior chain, hip stability, calf/ankle strength.",
    "General Fitness":"Build a balanced foundation -- squat, hinge, push, pull, carry. Health and longevity focus."
  };

  const todayStr = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const sys = `You are Coach Joe Thomas -- high school strength coach, 20+ years military S&C. Direct, real, no fluff.
TODAY'S DATE: ${todayStr}
Athlete: ${athlete.name}, Sport: ${athlete.sport}${athlete.level?", Level: "+athlete.level:""}
${phaseContext}
SPORT: ${sportPriorities[athlete.sport]||"Build a general strength base."}

BANNED PHRASES:
- "Atta boy/girl": BANNED except when athlete explicitly hits a NEW PR.
- Exclamation points: Maximum ONE per response.
- "Let's go!" / "Get after it!": BANNED as fillers.

FOR NORMAL WORKOUT LOGS respond with one of: "Good work." / "Solid session." / "Numbers are moving." / "Nice." -- then one specific observation. That's it.

RESERVED (only when situation genuinely matches):
- "Atta boy/girl": New PR only.
- "If it were easy, everybody would do it.": Athlete struggling mentally only.
- "It's not about workout 1, it's about workout 100.": Athlete missed sessions only.
- "You're only in competition with the you of yesterday.": Athlete comparing to others only.

FORMATTING: Use numbered lists for exercises/alternatives/steps. Never paragraph format for exercise lists.
Keep under 200 words. Use their name once naturally.
Pain → suggest alternatives. Equipment unavailable → 2-3 specific alternatives.
Out of scope: "That's one for Coach Joe directly -- email joe.thomas@commandengineering.com."

UNUSUAL TRAINING CONDITIONS (travel, cruise, hotel, beach, limited equipment, injury layoff, etc.):
- If athlete mentions they'll be away or have limited access but HASN'T described what's available yet: ask 2-3 direct questions — what equipment is on hand, how much space they have, how long the situation lasts. Do not give a program yet.
- Once conditions ARE described: build a specific day-by-day program for exactly those conditions. Be clear it's temporary.
- When athlete signals they're back to normal ("I'm back", "home now", "back at the gym"): transition them back to their regular program and reference it.${pastContext}${programContext}`;

  return askClaude(sys,`${hist}\n\n${athlete.name}: ${message}`,450);
};

// ─── STYLES ──────────────────────────────────────────────────────────────────
const C = {navy:"#060d1e",navy2:"#0a1228",navy3:"#0d1836",border:"#1e2a4a",gold:"#d4a017",green:"#10b981",red:"#ef4444",text:"#e2e8f0",muted:"#64748b",muted2:"#94a3b8",blue:"#3b82f6"};
const GS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{background:${C.navy};color:${C.text};font-family:'DM Sans',sans-serif;}
input,textarea,select,button{font-family:'DM Sans',sans-serif;}
::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-track{background:${C.navy2};}::-webkit-scrollbar-thumb{background:${C.border};border-radius:2px;}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.4;}}
.fade-up{animation:fadeUp 0.25s ease forwards;}
`;
const inp = (extra={}) => ({width:"100%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",color:C.text,fontSize:15,outline:"none",...extra});
const btn = (bg,color,extra={}) => ({background:bg,color,border:"none",borderRadius:12,padding:"14px",fontWeight:700,fontSize:16,cursor:"pointer",width:"100%",fontFamily:"'Bebas Neue'",letterSpacing:2,...extra});

// ─── RESPONSIVE HOOK ──────────────────────────────────────────────────────────
function useIsMobile(bp=640) {
  const [isMobile,setIsMobile] = useState(typeof window!=="undefined"?window.innerWidth<bp:false);
  useEffect(()=>{
    const handler=()=>setIsMobile(window.innerWidth<bp);
    window.addEventListener("resize",handler);
    return()=>window.removeEventListener("resize",handler);
  },[bp]);
  return isMobile;
}

// ─── LINE CHART ───────────────────────────────────────────────────────────────
function LineChart({data, color=C.gold, unit=""}) {
  if(!data||data.length<2) return (
    <div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"16px 0"}}>Not enough data yet.</div>
  );
  const vals = data.map(d=>d.y);
  const min = Math.min(...vals), max = Math.max(...vals), range = max-min||1;
  const W=300,H=90,pt=8,pr=8,pb=20,pl=30;
  const iw=W-pl-pr, ih=H-pt-pb;
  const px = i => pl+(i/(data.length-1))*iw;
  const py = v => pt+(1-(v-min)/range)*ih;
  const pts = data.map((d,i)=>`${px(i)},${py(d.y)}`).join(" ");
  const area = `${pl},${pt+ih} ${pts} ${px(data.length-1)},${pt+ih}`;
  const gid = `g${color.replace("#","")}${Math.random().toString(36).slice(2,6)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",overflow:"visible"}}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={color} stopOpacity="0.25"/>
        <stop offset="100%" stopColor={color} stopOpacity="0"/>
      </linearGradient></defs>
      <polygon points={area} fill={`url(#${gid})`}/>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round"/>
      {data.map((d,i)=>(
        <g key={i}>
          <circle cx={px(i)} cy={py(d.y)} r={2.5} fill={color}/>
          <text x={px(i)} y={H-3} textAnchor="middle" fill={C.muted} fontSize={7} fontFamily="DM Sans">{d.label}</text>
        </g>
      ))}
      <text x={pl-3} y={pt+6} textAnchor="end" fill={C.muted} fontSize={7}>{max}{unit}</text>
      <text x={pl-3} y={pt+ih+4} textAnchor="end" fill={C.muted} fontSize={7}>{min}{unit}</text>
    </svg>
  );
}

// ─── RUN CARD ─────────────────────────────────────────────────────────────────
// Reusable component for displaying a parsed run workout.
const RUN_TYPE_LABELS = {
  easy:"Easy Run", tempo:"Tempo", interval:"Intervals", long_run:"Long Run",
  race:"Race", recovery:"Recovery", fartlek:"Fartlek", null:"Run"
};
function RunCard({runData, feel}) {
  if(!runData) return null;
  const typeLabel = RUN_TYPE_LABELS[runData.run_type] || "Run";
  const dist = runData.distance_miles!=null
    ? `${runData.distance_miles} mi`
    : runData.distance_km!=null
    ? `${runData.distance_km} km`
    : null;
  const pace = runData.pace_per_mile
    ? `${runData.pace_per_mile}/mi`
    : runData.pace_per_km
    ? `${runData.pace_per_km}/km`
    : null;
  const dur = runData.duration_minutes!=null
    ? runData.duration_minutes>=60
      ? `${Math.floor(runData.duration_minutes/60)}h ${runData.duration_minutes%60}m`
      : `${runData.duration_minutes}m`
    : null;
  const typeColor = {easy:C.green,tempo:C.gold,interval:C.blue,long_run:C.gold,race:C.red,recovery:C.green,fartlek:C.blue}[runData.run_type]||C.muted2;
  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,flexWrap:"wrap"}}>
        <div style={{background:`${typeColor}22`,border:`1px solid ${typeColor}`,borderRadius:6,padding:"2px 10px",color:typeColor,fontSize:11,fontWeight:700,letterSpacing:1}}>
          {typeLabel.toUpperCase()}
        </div>
        {feel&&<div style={{fontSize:11,color:feel==="great"||feel==="good"?C.green:feel==="rough"?C.red:C.gold,fontWeight:600}}>{feel}</div>}
      </div>
      <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:runData.intervals?.length>0?10:0}}>
        {dist&&<div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>DISTANCE</div><div style={{color:C.text,fontSize:15,fontWeight:700}}>{dist}</div></div>}
        {dur&&<div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>TIME</div><div style={{color:C.text,fontSize:15,fontWeight:700}}>{dur}</div></div>}
        {pace&&<div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>PACE</div><div style={{color:C.text,fontSize:15,fontWeight:700}}>{pace}</div></div>}
        {runData.heart_rate_avg&&<div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>AVG HR</div><div style={{color:"#ef4444",fontSize:15,fontWeight:700}}>{runData.heart_rate_avg}<span style={{fontSize:11,color:"#64748b"}}> bpm</span></div></div>}
        {runData.heart_rate_max&&<div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>MAX HR</div><div style={{color:"#ef4444",fontSize:15,fontWeight:700}}>{runData.heart_rate_max}<span style={{fontSize:11,color:"#64748b"}}> bpm</span></div></div>}
      </div>
      {runData.intervals?.length>0&&(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginTop:6}}>
          <thead>
            <tr>{["Rep","Distance","Time","Pace","Rest"].map(h=>(
              <th key={h} style={{color:C.muted,fontWeight:600,fontSize:10,letterSpacing:1,textAlign:"left",paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {runData.intervals.map((iv,j)=>(
              <tr key={j}>
                <td style={{color:C.muted2,padding:"4px 8px 4px 0"}}>{iv.repeat||"—"}</td>
                <td style={{color:C.text,fontWeight:600,padding:"4px 8px 4px 0"}}>{iv.distance||"—"}</td>
                <td style={{color:C.muted2,padding:"4px 8px 4px 0"}}>{iv.time||"—"}</td>
                <td style={{color:C.muted2,padding:"4px 8px 4px 0"}}>{iv.pace||"—"}</td>
                <td style={{color:C.muted2,padding:"4px 0"}}>{iv.rest||"—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runData.notes&&<div style={{color:C.muted2,fontSize:12,marginTop:6,fontStyle:"italic"}}>{runData.notes}</div>}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function WilcoApp() {
  const [view,setView] = useState("home");
  const [athlete,setAthlete] = useState(null);
  const [coach,setCoach] = useState(null);
  const [err,setErr] = useState("");

  if(view==="athlete"&&athlete) return <AthleteView athlete={athlete} onLogout={()=>{setAthlete(null);setView("home");}}/>;
  if(view==="coach"&&coach) return <CoachDashboard coach={coach} onLogout={()=>{setCoach(null);setView("home");}}/>;

  return (
    <div style={{minHeight:"100vh",background:C.navy,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",paddingTop:"calc(24px + env(safe-area-inset-top, 0px))",paddingBottom:24,paddingLeft:24,paddingRight:24}}>
      <style>{GS}</style>
      <div style={{width:"100%",maxWidth:420}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:56,color:C.gold,letterSpacing:6,lineHeight:1}}>WILCO</div>
          <div style={{color:C.muted,fontSize:12,letterSpacing:4,marginTop:4}}>COACH JOE-BOT</div>
        </div>
        {view==="home"      && <HomeScreen setView={setView}/>}
        {view==="signup"    && <SignupScreen setView={setView} setAthlete={setAthlete} setErr={setErr} err={err}/>}
        {view==="login"     && <LoginScreen setView={setView} setAthlete={setAthlete} setErr={setErr} err={err}/>}
        {view==="coachLogin"&& <CoachLoginScreen setView={setView} setCoach={setCoach} setErr={setErr} err={err}/>}
        {view==="coachSetup"&& <CoachSetupScreen setView={setView} setCoach={setCoach} setErr={setErr} err={err}/>}
      </div>
    </div>
  );
}

// ─── HOME SCREEN ──────────────────────────────────────────────────────────────
function HomeScreen({setView}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <button onClick={()=>setView("login")} style={btn(C.gold,"#000")}>Athlete Login</button>
      <button onClick={()=>setView("signup")} style={btn("transparent",C.gold,{border:`2px solid ${C.gold}`})}>New Athlete Sign Up</button>
      <div style={{height:1,background:C.border,margin:"8px 0"}}/>
      <button onClick={()=>setView("coachLogin")} style={btn(C.navy2,C.muted2,{border:`1px solid ${C.border}`})}>Coach Login</button>
      <button onClick={()=>setView("coachSetup")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer",textAlign:"center",marginTop:4}}>
        First time coach? Enter access code
      </button>
    </div>
  );
}

// ─── ATHLETE SIGNUP ───────────────────────────────────────────────────────────
function SignupScreen({setView,setAthlete,setErr,err}) {
  const [step,setStep] = useState(1);
  const [data,setData] = useState({name:"",sport:SPORTS[0],pin:"",confirmPin:"",email:"",goal:"strength",coachCode:"",coachName:"",coachEmail:"",tier:"free",billing:"monthly"});
  const [loading,setLoading] = useState(false);
  const setD = (k,v) => setData(p=>({...p,[k]:v}));

  const nextStep = async () => {
    setErr("");
    if(step===1){
      if(!data.name.trim()){setErr("Enter your name.");return;}
      setLoading(true);
      const existing = await sbGet("athletes",`?name=ilike.${encodeURIComponent(data.name.trim())}`);
      setLoading(false);
      if(existing?.length>0){setErr("That name is already registered. Go to Athlete Login instead.");return;}
      setStep(2);
    } else if(step===2){
      if(data.pin.length!==4){setErr("PIN must be 4 digits.");return;}
      if(data.pin!==data.confirmPin){setErr("PINs don't match.");return;}
      setStep(3);
    } else if(step===3){
      setStep(4);
    } else if(step===4){
      setStep(5);
    } else if(step===5){
      setLoading(true);
      try {
        const created = await sbInsert("athletes",{name:data.name.trim(),sport:data.sport,pin:data.pin,tier:data.tier,billing:data.billing,email:data.email.trim().toLowerCase()||null});
        if(created?.length>0){
          const newAthlete = created[0];
          try {
            // Look up coach by access code if provided, get coach_id + school_id
            let coachId = null, schoolId = null;
            if(data.coachCode.trim()){
              const matchedCoach = await sbGet("coaches",`?access_code=eq.${encodeURIComponent(data.coachCode.trim().toUpperCase())}&select=id,school_id`);
              if(matchedCoach?.length>0){ coachId = matchedCoach[0].id; schoolId = matchedCoach[0].school_id||null; }
            }
            await fetch(`${SUPABASE_URL}/rest/v1/athletes?id=eq.${newAthlete.id}`,{
              method:"PATCH",headers:{...sbH,"Prefer":"return=representation"},
              body:JSON.stringify({
                goal:data.goal||"strength",
                coach_name:data.coachName.trim()||null,
                coach_email:data.coachEmail.trim().toLowerCase()||null,
                ...(coachId ? {coach_id:coachId} : {}),
                ...(schoolId ? {school_id:schoolId} : {})
              })
            });
            // Send welcome email to coach for all tiers
            if(data.coachEmail.trim()){
              fetch("/api/send-coach-welcome",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({
                  athleteName: data.name.trim(),
                  athleteSport: data.sport,
                  coachName: data.coachName.trim()||null,
                  coachEmail: data.coachEmail.trim().toLowerCase(),
                  tier: data.tier
                })
              }).catch(()=>{});
            }
            // For Elite tier: notify admin to assign a Wilco Certified Coach
            if(data.tier==="elite"){
              fetch("/api/send-coach-welcome",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({
                  athleteName: data.name.trim(),
                  athleteSport: data.sport,
                  coachName: "WILCO Admin",
                  coachEmail: "coachjoe@trainwilco.com",
                  tier: "elite",
                  isAdminAlert: true
                })
              }).catch(()=>{});
            }
          } catch(e){}
          setAthlete({...newAthlete,goal:data.goal||"strength",tier:data.tier});
          setView("athlete");
        } else {
          setErr("Error: "+(created?.message||created?.error||JSON.stringify(created)));
        }
      } catch(e){setErr("Connection error.");}
      setLoading(false);
    }
  };

  // Tier card component used in step 5
  const TierCard = ({tierKey}) => {
    const t = TIERS[tierKey];
    const selected = data.tier===tierKey;
    const annual = data.billing==="annual";
    const pricing = {
      free:  {monthly:"Free",        annual:"Free",       monthlyNote:"No credit card needed", annualNote:"No credit card needed"},
      pro:   {monthly:"$14.99/mo",   annual:"$150/yr",    monthlyNote:"Billed monthly",        annualNote:"~$12.50/mo · Save $30"},
      elite: {monthly:"$99.99/mo",   annual:"$1,000/yr",  monthlyNote:"Billed monthly",        annualNote:"~$83/mo · Save ~$200"},
    };
    const p = pricing[tierKey];
    const features = {
      free:  ["Full AI coaching chat","Form review (video upload)","Coach welcome email","No session memory (fresh start each login)"],
      pro:   ["Everything in Free","Workout history saved","Progress tracking & PRs","Training program stored","Workout log viewable","Weekly coach progress reports"],
      elite: ["Everything in Pro","Assigned WILCO Certified Coach","Guaranteed weekly check-in","Initial onboarding Zoom call"],
    };
    return (
      <div onClick={()=>setD("tier",tierKey)} style={{background:selected?`${t.color}18`:C.navy3,border:`2px solid ${selected?t.color:C.border}`,borderRadius:12,padding:"14px 16px",marginBottom:10,cursor:"pointer",transition:"all 0.15s"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:t.color,letterSpacing:2}}>{t.label}</div>
            {tierKey==="pro"&&<div style={{background:`${t.color}33`,color:t.color,fontSize:10,fontWeight:700,letterSpacing:1,padding:"2px 8px",borderRadius:4}}>POPULAR</div>}
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{color:t.color,fontWeight:700,fontSize:15}}>{annual?p.annual:p.monthly}</div>
            <div style={{color:C.muted,fontSize:10}}>{annual?p.annualNote:p.monthlyNote}</div>
          </div>
        </div>
        <ul style={{listStyle:"none",padding:0,margin:0}}>
          {features[tierKey].map((f,i)=>(
            <li key={i} style={{color:selected?C.text:C.muted2,fontSize:12,lineHeight:1.8,display:"flex",alignItems:"center",gap:6}}>
              <span style={{color:t.color,fontSize:10}}>✓</span>{f}
            </li>
          ))}
        </ul>
      </div>
    );
  };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>step>1?setStep(step-1):setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>NEW ATHLETE — STEP {step} OF 5</div>
      </div>
      {step===1&&<>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>FULL NAME</label>
          <input value={data.name} onChange={e=>setD("name",e.target.value)} placeholder="Your name" style={inp()}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>PRIMARY SPORT</label>
          <select value={data.sport} onChange={e=>setD("sport",e.target.value)} style={inp()}>
            {SPORTS.map(s=><option key={s}>{s}</option>)}
          </select>
        </div>
      </>}
      {step===2&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>Choose a 4-digit PIN you'll remember. Add a recovery email if you ever forget it.</div>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CREATE PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={data.pin}
            onChange={e=>setD("pin",e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CONFIRM PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={data.confirmPin}
            onChange={e=>setD("confirmPin",e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>RECOVERY EMAIL <span style={{color:C.muted,fontWeight:400}}>(optional — used only to recover your PIN)</span></label>
          <input type="email" inputMode="email" value={data.email}
            onChange={e=>setD("email",e.target.value)}
            placeholder="you@email.com" style={inp()}/>
        </div>
      </>}
      {step===3&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>What's your primary training goal? Joe-bot tailors every recommendation to this.</div>
        {[
          {key:"strength",label:"Get Stronger",sub:"Maximal strength — squat, deadlift, bench, Olympic lifts"},
          {key:"sport",label:"Sport Performance",sub:"Explosiveness, speed, and conditioning for my sport"},
          {key:"speed",label:"Get Faster / Improve Endurance",sub:"Running performance, cardio base, speed work"},
          {key:"body",label:"Body Composition",sub:"Build muscle, lose fat, look and feel better"},
          {key:"fitness",label:"General Health & Fitness",sub:"Stay active, balanced approach, longevity"},
        ].map(g=>(
          <div key={g.key} onClick={()=>setD("goal",g.key)}
            style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer",marginBottom:8,padding:"12px 14px",background:data.goal===g.key?`${C.gold}18`:C.navy3,borderRadius:10,border:`2px solid ${data.goal===g.key?C.gold:C.border}`,transition:"all 0.15s"}}>
            <div style={{width:20,height:20,borderRadius:"50%",border:`2px solid ${data.goal===g.key?C.gold:C.muted}`,background:data.goal===g.key?C.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {data.goal===g.key&&<span style={{color:"#000",fontSize:10,fontWeight:700}}>✓</span>}
            </div>
            <div>
              <div style={{color:C.text,fontWeight:600,fontSize:14}}>{g.label}</div>
              <div style={{color:C.muted,fontSize:11,marginTop:2}}>{g.sub}</div>
            </div>
          </div>
        ))}
        <div style={{marginBottom:12}}/>
      </>}
      {step===4&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:6,lineHeight:1.6}}>
          Are you training with a school or team on WILCO?
        </div>
        <div style={{color:C.muted,fontSize:12,marginBottom:16,lineHeight:1.6}}>
          If your coach or athletic director gave you a team code, enter it below — it connects you to their dashboard automatically. <span style={{color:C.text,fontWeight:600}}>Training on your own? Just leave this blank and hit Next.</span>
        </div>
        {/* Team code — joins athlete to a specific coach's dashboard */}
        <div style={{marginBottom:14,background:`${C.gold}0f`,border:`1px solid ${C.gold}44`,borderRadius:10,padding:"12px 14px"}}>
          <label style={{color:C.gold,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>TEAM CODE <span style={{color:C.muted,fontWeight:400,textTransform:"none",letterSpacing:0}}>(optional — from your coach or athletic director)</span></label>
          <input value={data.coachCode} onChange={e=>setD("coachCode",e.target.value.toUpperCase())}
            placeholder="e.g. LHS01" style={inp({textTransform:"uppercase",letterSpacing:3,fontWeight:700})}/>
          <div style={{color:C.muted,fontSize:11,marginTop:6,lineHeight:1.5}}>No team code? No problem — WILCO works great on its own.</div>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH'S NAME <span style={{color:C.muted,fontWeight:400}}>(optional)</span></label>
          <input value={data.coachName} onChange={e=>setD("coachName",e.target.value)}
            placeholder="Coach Smith" style={inp()}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH'S EMAIL <span style={{color:C.muted,fontWeight:400}}>(optional)</span></label>
          <input type="email" value={data.coachEmail} onChange={e=>setD("coachEmail",e.target.value)}
            placeholder="coach@school.edu" style={inp()}/>
          <div style={{color:C.muted,fontSize:11,marginTop:6,lineHeight:1.5}}>Pro/Elite: coach gets weekly progress reports. All tiers: coach gets a welcome email.</div>
        </div>
      </>}
      {step===5&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:12,lineHeight:1.6}}>Choose your plan. You can upgrade anytime from settings.</div>
        {/* Billing toggle */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:0,marginBottom:14,background:C.navy3,borderRadius:10,padding:4,border:`1px solid ${C.border}`}}>
          {["monthly","annual"].map(b=>(
            <button key={b} onClick={()=>setD("billing",b)}
              style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:700,letterSpacing:1,fontFamily:"'Bebas Neue'",
                background:data.billing===b?C.gold:"transparent",
                color:data.billing===b?"#000":C.muted,transition:"all 0.15s"}}>
              {b==="monthly"?"MONTHLY":"ANNUAL · SAVE ~17%"}
            </button>
          ))}
        </div>
        <TierCard tierKey="free"/>
        <TierCard tierKey="pro"/>
        <TierCard tierKey="elite"/>
        {data.tier==="elite"&&(
          <div style={{background:`${C.blue}18`,border:`1px solid ${C.blue}`,borderRadius:10,padding:"10px 14px",marginBottom:12,marginTop:-4}}>
            <div style={{color:C.blue,fontSize:12,fontWeight:600,marginBottom:2}}>What happens next with Elite:</div>
            <div style={{color:C.muted2,fontSize:11,lineHeight:1.6}}>After you create your account, a WILCO Certified Coach will reach out within 24 hours to schedule your initial Zoom call and get you paired up.</div>
          </div>
        )}
      </>}
      {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
      <button onClick={nextStep} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1,cursor:loading?"not-allowed":"pointer"})}>
        {loading?"Please wait...":(step===5?"Create Account →":"Next →")}
      </button>
    </div>
  );
}

// ─── ATHLETE LOGIN ────────────────────────────────────────────────────────────
function LoginScreen({setView,setAthlete,setErr,err}) {
  const [name,setName] = useState("");
  const [pin,setPin] = useState("");
  const [loading,setLoading] = useState(false);
  const [mode,setMode] = useState("login"); // "login" | "forgot"
  const [recoveryName,setRecoveryName] = useState("");
  const [recoveryEmail,setRecoveryEmail] = useState("");
  const [recoverySent,setRecoverySent] = useState(false);

  const login = async () => {
    if(!name.trim()||pin.length!==4){setErr("Enter your name and 4-digit PIN.");return;}
    setLoading(true); setErr("");
    try {
      const results = await sbGet("athletes",`?name=ilike.${encodeURIComponent(name.trim())}&pin=eq.${pin}&select=*`);
      if(results?.length>0){setAthlete(results[0]);setView("athlete");}
      else {
        const nameCheck = await sbGet("athletes",`?name=ilike.${encodeURIComponent(name.trim())}`);
        if(nameCheck?.length>0) setErr("Wrong PIN. Try again.");
        else setErr("Name not found. Check spelling or sign up as a new athlete.");
      }
    } catch(e){setErr("Connection error. Check your internet.");}
    setLoading(false);
  };

  const sendRecovery = async () => {
    if(!recoveryName.trim()||!recoveryEmail.trim()){setErr("Enter your name and recovery email.");return;}
    setLoading(true); setErr("");
    try {
      await fetch("/api/send-pin-recovery",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({type:"athlete",name:recoveryName.trim(),email:recoveryEmail.trim().toLowerCase()})
      });
      setRecoverySent(true);
    } catch(e){setErr("Connection error. Try again.");}
    setLoading(false);
  };

  const enterForgot = () => { setMode("forgot"); setErr(""); setRecoverySent(false); };
  const backToLogin = () => { setMode("login"); setErr(""); setRecoverySent(false); };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={mode==="forgot"?backToLogin:()=>setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>
          {mode==="forgot"?"FORGOT PIN":"ATHLETE LOGIN"}
        </div>
      </div>

      {mode==="login"&&<>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>YOUR NAME</label>
          <input value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&login()} placeholder="Exact name you signed up with" style={inp()}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>YOUR PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pin}
            onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
            onKeyDown={e=>e.key==="Enter"&&login()}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
        <button onClick={login} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1,cursor:loading?"not-allowed":"pointer"})}>
          {loading?"Checking...":"Let's Get to Work ->"}
        </button>
        <div style={{textAlign:"center",marginTop:12,display:"flex",flexDirection:"column",gap:6}}>
          <button onClick={enterForgot} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>Forgot your PIN?</button>
          <button onClick={()=>setView("signup")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>New athlete? Sign up here</button>
        </div>
      </>}

      {mode==="forgot"&&<>
        {recoverySent
          ? <div style={{textAlign:"center",padding:"16px 0"}}>
              <div style={{fontSize:32,marginBottom:12}}>📬</div>
              <div style={{color:C.text,fontWeight:600,fontSize:15,marginBottom:8}}>Check your inbox</div>
              <div style={{color:C.muted2,fontSize:13,lineHeight:1.6,marginBottom:20}}>
                If we found an account matching that name and email, your PIN has been sent. Check your spam folder too.
              </div>
              <button onClick={backToLogin} style={btn(C.gold,"#000")}>Back to Login</button>
            </div>
          : <>
              <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>
                Enter the name and recovery email you signed up with and we'll email you your PIN.
              </div>
              <div style={{marginBottom:16}}>
                <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>YOUR NAME</label>
                <input value={recoveryName} onChange={e=>setRecoveryName(e.target.value)} placeholder="Exact name you signed up with" style={inp()}/>
              </div>
              <div style={{marginBottom:20}}>
                <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>RECOVERY EMAIL</label>
                <input type="email" inputMode="email" value={recoveryEmail} onChange={e=>setRecoveryEmail(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&sendRecovery()}
                  placeholder="you@email.com" style={inp()}/>
              </div>
              {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
              <button onClick={sendRecovery} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1,cursor:loading?"not-allowed":"pointer"})}>
                {loading?"Sending...":"Email My PIN →"}
              </button>
              <div style={{textAlign:"center",marginTop:10}}>
                <button onClick={backToLogin} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>Back to login</button>
              </div>
            </>
        }
      </>}
    </div>
  );
}

// ─── COACH LOGIN ──────────────────────────────────────────────────────────────
function CoachLoginScreen({setView,setCoach,setErr,err}) {
  const [pin,setPin] = useState("");
  const [loading,setLoading] = useState(false);
  const [mode,setMode] = useState("login"); // "login" | "forgot"
  const [recoveryEmail,setRecoveryEmail] = useState("");
  const [recoverySent,setRecoverySent] = useState(false);

  const login = async () => {
    if(pin.length!==4){setErr("Enter your 4-digit PIN.");return;}
    setLoading(true); setErr("");
    try {
      const results = await sbGet("coaches",`?pin=eq.${pin}&select=*`);
      if(results?.length>0){setCoach(results[0]);setView("coach");}
      else setErr("PIN not found. Check your PIN or set up your coach account first.");
    } catch(e){setErr("Connection error.");}
    setLoading(false);
  };

  const sendRecovery = async () => {
    if(!recoveryEmail.trim()){setErr("Enter your email address.");return;}
    setLoading(true); setErr("");
    try {
      await fetch("/api/send-pin-recovery",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({type:"coach",email:recoveryEmail.trim().toLowerCase()})
      });
      setRecoverySent(true);
    } catch(e){setErr("Connection error. Try again.");}
    setLoading(false);
  };

  const enterForgot = () => { setMode("forgot"); setErr(""); setRecoverySent(false); };
  const backToLogin = () => { setMode("login"); setErr(""); setRecoverySent(false); };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={mode==="forgot"?backToLogin:()=>setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>
          {mode==="forgot"?"FORGOT PIN":"COACH LOGIN"}
        </div>
      </div>

      {mode==="login"&&<>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pin}
            onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
            onKeyDown={e=>e.key==="Enter"&&login()}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
        <button onClick={login} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1})}>
          {loading?"Checking...":"Access Dashboard ->"}
        </button>
        <div style={{textAlign:"center",marginTop:12,display:"flex",flexDirection:"column",gap:6}}>
          <button onClick={enterForgot} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>Forgot your PIN?</button>
          <button onClick={()=>setView("coachSetup")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>First time? Enter access code</button>
        </div>
      </>}

      {mode==="forgot"&&<>
        {recoverySent
          ? <div style={{textAlign:"center",padding:"16px 0"}}>
              <div style={{fontSize:32,marginBottom:12}}>📬</div>
              <div style={{color:C.text,fontWeight:600,fontSize:15,marginBottom:8}}>Check your inbox</div>
              <div style={{color:C.muted2,fontSize:13,lineHeight:1.6,marginBottom:20}}>
                If we found a coach account linked to that email, your PIN has been sent. Check your spam folder too.
              </div>
              <button onClick={backToLogin} style={btn(C.gold,"#000")}>Back to Login</button>
            </div>
          : <>
              <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>
                Enter the email address on your coach account and we'll send you your PIN.
              </div>
              <div style={{marginBottom:20}}>
                <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH EMAIL</label>
                <input type="email" inputMode="email" value={recoveryEmail} onChange={e=>setRecoveryEmail(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&sendRecovery()}
                  placeholder="coach@school.edu" style={inp()}/>
              </div>
              {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
              <button onClick={sendRecovery} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1,cursor:loading?"not-allowed":"pointer"})}>
                {loading?"Sending...":"Email My PIN →"}
              </button>
              <div style={{textAlign:"center",marginTop:10}}>
                <button onClick={backToLogin} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>Back to login</button>
              </div>
            </>
        }
      </>}
    </div>
  );
}

// ─── COACH SETUP ──────────────────────────────────────────────────────────────
function CoachSetupScreen({setView,setCoach,setErr,err}) {
  const [step,setStep] = useState(1);
  const [code,setCode] = useState("");
  const [coachRecord,setCoachRecord] = useState(null);
  const [pin,setPin] = useState("");
  const [confirmPin,setConfirmPin] = useState("");
  const [loading,setLoading] = useState(false);

  const verifyCode = async () => {
    if(!code.trim()){setErr("Enter your access code.");return;}
    setLoading(true); setErr("");
    try {
      const results = await sbGet("coaches",`?access_code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=*`);
      if(results?.length>0){
        if(results[0].pin){setErr("This code has already been used. Go to Coach Login.");setLoading(false);return;}
        setCoachRecord(results[0]); setStep(2);
      } else setErr("Invalid access code. Check with your athletic director.");
    } catch(e){setErr("Connection error.");}
    setLoading(false);
  };

  const setCoachPin = async () => {
    if(pin.length!==4){setErr("PIN must be 4 digits.");return;}
    if(pin!==confirmPin){setErr("PINs don't match.");return;}
    setLoading(true); setErr("");
    try {
      const updated = await sbUpdate("coaches",coachRecord.id,{pin});
      if(updated?.length>0){setCoach({...coachRecord,pin});setView("coach");}
      else setErr("Could not save PIN. Try again.");
    } catch(e){setErr("Connection error.");}
    setLoading(false);
  };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>step>1?setStep(1):setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>COACH SETUP — STEP {step} OF 2</div>
      </div>
      {step===1&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>Enter the access code provided by your athletic director.</div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>ACCESS CODE</label>
          <input value={code} onChange={e=>setCode(e.target.value)} placeholder="e.g. FORTIS-FOOTBALL" style={inp({textTransform:"uppercase",letterSpacing:2})}/>
        </div>
        {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
        <button onClick={verifyCode} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1})}>
          {loading?"Verifying...":"Verify Code ->"}
        </button>
      </>}
      {step===2&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:4,lineHeight:1.6}}>Welcome, {coachRecord?.name}. Set your 4-digit PIN.</div>
        <div style={{color:C.muted,fontSize:12,marginBottom:16}}>You'll use this every time you log in.</div>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CREATE PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={pin}
            onChange={e=>setPin(e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CONFIRM PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={confirmPin}
            onChange={e=>setConfirmPin(e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
        <button onClick={setCoachPin} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1})}>
          {loading?"Saving...":"Set PIN & Enter Dashboard ->"}
        </button>
      </>}
    </div>
  );
}

// ─── ATHLETE VIEW ─────────────────────────────────────────────────────────────
function AthleteView({athlete: initialAthlete, onLogout}) {
  const [athlete,setAthlete] = useState(initialAthlete);
  const [messages,setMessages] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [videoLoading,setVideoLoading] = useState(false);
  const [saved,setSaved] = useState(false);
  const [workoutHistory,setWorkoutHistory] = useState([]);
  const [historyLoaded,setHistoryLoaded] = useState(false);
  const [movementPrompt,setMovementPrompt] = useState(false);
  const [movementLabel,setMovementLabel] = useState("");
  const [sessionCheckPending,setSessionCheckPending] = useState(null);
  const [showLog,setShowLog] = useState(false);
  const [showSettings,setShowSettings] = useState(false);
  const [showProgram,setShowProgram] = useState(false);
  const [athleteProgramText,setAthleteProgramText] = useState(athlete.program_text||"");
  const [athleteProgramSaving,setAthleteProgramSaving] = useState(false);
  const [athleteProgramMsg,setAthleteProgramMsg] = useState("");
  const [athletePhotoProcessing,setAthletePhotoProcessing] = useState(false);
  const bottomRef = useRef(null);
  const videoInputRef = useRef(null);
  const athletePhotoRef = useRef(null);
  const isMobile = useIsMobile();
  const chatStorageKey = `wilco_chat_${athlete.id}_${new Date().toLocaleDateString()}`;

  const saveAthleteProgram = async () => {
    if(athleteProgramSaving) return;
    setAthleteProgramSaving(true); setAthleteProgramMsg("");
    try {
      await sbUpdate("athletes",athlete.id,{program_text:athleteProgramText.trim()||null});
      setAthlete(prev=>({...prev,program_text:athleteProgramText.trim()||null}));
      setAthleteProgramMsg("Saved.");
    } catch(e){ setAthleteProgramMsg("Couldn't save. Try again."); }
    setAthleteProgramSaving(false);
    setTimeout(()=>setAthleteProgramMsg(""),3000);
  };

  const handleAthletePhotoProgram = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    e.target.value="";
    setAthletePhotoProcessing(true); setAthleteProgramMsg("");
    try {
      const reader = new FileReader();
      const b64 = await new Promise((res,rej)=>{reader.onload=()=>res(reader.result.split(",")[1]);reader.onerror=rej;reader.readAsDataURL(file);});
      const extracted = await askClaude(
        "You are reading a photo of an athlete's training program. Extract the full program text exactly as written. Preserve all structure — exercises, sets, reps, weights, days, weeks. Output plain text only, no commentary.",
        "Extract the training program from this image.",600,[b64]
      );
      if(extracted) setAthleteProgramText(prev=>prev?prev+"\n\n"+extracted:extracted);
    } catch(err){ setAthleteProgramMsg("Couldn't read that image. Try a clearer photo."); }
    setAthletePhotoProcessing(false);
  };

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[messages,loading,videoLoading]);

  useEffect(()=>{
    if(historyLoaded&&messages.length>0){
      try{localStorage.setItem(chatStorageKey,JSON.stringify(messages));}catch(_){}
    }
  },[messages,historyLoaded]);

  useEffect(()=>{
    (async()=>{
      const tier = athlete.tier||"free";
      // Restore today's conversation from localStorage if available
      try {
        const storedChat = localStorage.getItem(chatStorageKey);
        const storedMsgs = storedChat ? JSON.parse(storedChat) : null;
        if(storedMsgs?.length>0){
          setMessages(storedMsgs);
          const logs = tier!=="free" ? await sbGet("workouts",`?athlete_id=eq.${athlete.id}&order=created_at.desc&limit=100&select=*`) : [];
          if(logs&&logs.length>0) setWorkoutHistory(logs);
          setHistoryLoaded(true);
          return;
        }
      } catch(_){}
      try {
        // Re-fetch athlete from Supabase so JoBot has the latest program_text
        // even if the coach set it after this athlete logged in
        const freshAthlete = await sbGet("athletes",`?id=eq.${athlete.id}&select=*`);
        if(freshAthlete?.length>0) setAthlete(freshAthlete[0]);

        // Free tier: no session memory — skip loading workout history
        const logs = tier!=="free" ? await sbGet("workouts",`?athlete_id=eq.${athlete.id}&order=created_at.desc&limit=100&select=*`) : [];
        if(logs&&logs.length>0) setWorkoutHistory(logs);

        const lastLog = logs?.[0];
        const dAgo = lastLog ? daysBetween(lastLog.created_at) : null;
        const lastRunD = lastLog?.parsed_data?.run_data;
        const lastExs = lastRunD
          ? `${lastRunD.run_type||"run"}${lastRunD.distance_miles?" "+lastRunD.distance_miles+"mi":lastRunD.distance_km?" "+lastRunD.distance_km+"km":""}${lastRunD.duration_minutes?" ("+lastRunD.duration_minutes+"min)":""}`
          : lastLog?.parsed_data?.exercises?.map(e=>`${e.name}${e.weight?" "+fmtWeight(e.weight,e.unit):""}${e.sets&&e.reps?" "+e.sets+"x"+e.reps:""}`).join(", ")||"";
        const lastDate = lastLog ? fmtDateShort(lastLog.created_at) : null;
        const summary = lastExs ? `Last session (${lastDate}): ${lastExs}.` : "";

        let greeting;
        // Free tier: always greet as fresh start (no memory between sessions)
        const isFree = tier==="free";
        if(!lastLog||isFree){
          greeting = isFree&&lastLog
            ? `What's up, ${athlete.name}. I'm starting fresh — Free tier doesn't store your history between sessions. What did you get after today?`
            : `Welcome to WILCO, ${athlete.name}. Tell me about your first workout -- what you did, how it felt, any questions.`;
        } else if(dAgo>=7){
          greeting = `${athlete.name}. It's been ${dAgo} days since your last log. That's a week. What happened? We can't build anything on inconsistency. ${summary} What did you get after today?`;
        } else if(dAgo>=4){
          greeting = `${athlete.name}. ${dAgo} days since your last log. It's not about workout 1 -- it's about workout 100. ${summary} What did you do today?`;
        } else if(dAgo>=2){
          greeting = `Back at it, ${athlete.name}. ${summary} What did you get after today?`;
        } else {
          greeting = summary ? `${athlete.name}. ${summary} What are you getting after today?` : `What's up, ${athlete.name}. What did you get after today?`;
        }
        setMessages([{role:"assistant",content:greeting}]);
      } catch(e){
        setMessages([{role:"assistant",content:`What's up, ${athlete.name}. What did you get after today?`}]);
      }
      setHistoryLoaded(true);
    })();
  },[]);

  const finalizeWorkout = async (parsed, msg, reply, updatedAthlete, isNewSession, addReply) => {
    const tier = updatedAthlete.tier||"free";
    try {
      const parsedFinal = isNewSession ? {...parsed,new_session:true} : parsed;
      // Free tier: no memory — don't persist workouts or PRs
      if(tier==="free"){
        if(addReply) setMessages(prev=>[...prev,{role:"assistant",content:reply}]);
        return;
      }
      await sbInsert("workouts",{athlete_id:updatedAthlete.id,raw_message:msg,bot_reply:reply,parsed_data:parsedFinal});
      setSaved(true); setTimeout(()=>setSaved(false),3000);

      // Auto PR detection
      const newPRs = [];
      if(parsed.exercises?.length>0){
        const existingPRs = await sbGet("prs",`?athlete_id=eq.${updatedAthlete.id}`);
        const prMap = {};
        if(Array.isArray(existingPRs)){
          existingPRs.forEach(pr=>{
            const k = pr.exercise?.toLowerCase().trim();
            if(!prMap[k]||epley1RM(pr.weight,pr.reps)>epley1RM(prMap[k].weight,prMap[k].reps)) prMap[k]=pr;
          });
        }
        for(const ex of parsed.exercises){
          if(!ex.name||!ex.weight||ex.unit==="bodyweight") continue;
          const k = normalizeExName(ex.name);
          // Normalize to lbs-equivalent for cross-unit comparison
          const exLbs = toLbs(ex.weight, ex.unit);
          const exE1RM = epley1RM(exLbs, ex.reps||1);
          const prE1RM = prMap[k] ? epley1RM(toLbs(prMap[k].weight, prMap[k].unit), prMap[k].reps||1) : 0;
          if(!prMap[k]){
            await sbInsert("prs",{athlete_id:updatedAthlete.id,exercise:ex.name,weight:ex.weight,reps:ex.reps||1,estimated_1rm:exE1RM,unit:ex.unit||"lbs"});
          } else if(exE1RM > prE1RM){
            await sbInsert("prs",{athlete_id:updatedAthlete.id,exercise:ex.name,weight:ex.weight,reps:ex.reps||1,estimated_1rm:exE1RM,unit:ex.unit||"lbs"});
            newPRs.push({exercise:ex.name,weight:ex.weight,unit:ex.unit||"lbs",reps:ex.reps||1,e1rm:exE1RM,prevE1RM:prE1RM,diff:exE1RM-prE1RM});
          }
        }
      }

      if(addReply) setMessages(prev=>[...prev,{role:"assistant",content:reply}]);
      setWorkoutHistory(prev=>[{raw_message:msg,parsed_data:parsedFinal,created_at:new Date().toISOString()},...prev]);

      if(newPRs.length>0){
        try {
          const prCallout = newPRs.map(pr=>`${pr.exercise}: ${fmtWeight(pr.weight,pr.unit)} x${pr.reps} reps (est. 1RM: ${Math.round(pr.e1rm)}lbs-equiv, +${Math.round(pr.diff)}lbs-equiv over prev)`).join("\n");
          const prReply = await askClaude(
            "You are Coach Joe Thomas. An athlete just hit a new PR. Acknowledge it directly -- short, punchy, in Coach Joe's voice. Atta boy/girl is appropriate here.",
            `Athlete: ${updatedAthlete.name} (${updatedAthlete.sport})\nNew PRs:\n${prCallout}`,150
          );
          setMessages(prev=>[...prev,{role:"assistant",content:prReply}]);
        } catch(e){
          setMessages(prev=>[...prev,{role:"assistant",content:newPRs.map(pr=>`New PR -- ${pr.exercise} at ${fmtWeight(pr.weight,pr.unit)} x${pr.reps} (est. 1RM: ${Math.round(pr.e1rm)}lbs-equiv). +${Math.round(pr.diff)}lbs-equiv over previous best. That's what the work is for.`).join("\n")}]);
        }
      }
    } catch(e){
      setMessages(prev=>[...prev,{role:"assistant",content:"Hit a snag saving that. Try again."}]);
    }
  };

  const confirmSession = async (isNew) => {
    if(!sessionCheckPending) return;
    const {parsed,msg,reply,updatedAthlete} = sessionCheckPending;
    setSessionCheckPending(null);
    setLoading(true);
    await finalizeWorkout(parsed,msg,reply,updatedAthlete,isNew,false);
    setLoading(false);
  };

  const send = async () => {
    const msg = input.trim();
    if(!msg||loading||videoLoading||!historyLoaded) return;

    // Intercept log-view requests — open the log modal instead of calling Claude (Pro/Elite only)
    const logKeywords = ["show me my log","my log","my workout log","show my workouts","view my workouts","workout history","my history","show my history","see my log","all my workouts","see my workouts","show my log"];
    if(logKeywords.some(kw=>msg.toLowerCase().includes(kw))){
      setInput("");
      if((athlete.tier||"free")==="free"){
        setMessages(prev=>[...prev,{role:"user",content:msg},{role:"assistant",content:`Your workout log is a Pro feature, ${athlete.name}. Upgrade to Pro to save your history between sessions and view your full log.`}]);
      } else {
        setMessages(prev=>[...prev,{role:"user",content:msg},{role:"assistant",content:`Here's your full workout log, ${athlete.name}.`}]);
        setShowLog(true);
      }
      return;
    }

    setInput("");
    const newMsgs = [...messages,{role:"user",content:msg}];
    setMessages(newMsgs);
    setLoading(true);

    try {
      let updatedAthlete = {...athlete};

      const [reply,parsed] = await Promise.all([
        getJoeBotReply(msg,updatedAthlete,newMsgs,workoutHistory),
        parseWorkout(msg,athlete.name,athlete.sport)
      ]);

      let finalReply = reply;

      // Detect and save program updates — any tier, as long as coach hasn't locked it
      if(parsed.is_program_update && !updatedAthlete.program_locked){
        try {
          const programText = await extractProgramText(msg);
          // Guard: only save if there's real program content (not a one-line command)
          const hasContent = programText && programText.trim().length > 60 && programText.trim().split("\n").length > 1;
          if(hasContent){
            await sbUpdate("athletes",athlete.id,{program_text:programText});
            updatedAthlete.program_text = programText;
            setAthlete(updatedAthlete);
            finalReply = reply + "\n\n📋 Program saved — I'll reference this in every session.";
          }
        } catch(e){}
      }

      // Temporary adapted program — conditions described, extract program from Joe-bot's reply
      if(parsed.is_temp_program_update && !updatedAthlete.program_locked){
        try {
          const tempText = await extractProgramText(reply);
          await sbUpdate("athletes",athlete.id,{temp_program_text:tempText});
          updatedAthlete.temp_program_text = tempText;
          setAthlete(updatedAthlete);
        } catch(e){}
      }

      // Revert — athlete is back, clear temp program
      if(parsed.is_program_revert && updatedAthlete.temp_program_text){
        try {
          await sbUpdate("athletes",athlete.id,{temp_program_text:null});
          updatedAthlete.temp_program_text = null;
          setAthlete(updatedAthlete);
          finalReply = reply + "\n\n✅ Temporary program cleared — back to your regular programming.";
        } catch(e){}
      }

      // Gap check: 1–3 hrs since last real entry → ask same workout or new session
      if(parsed.exercises?.length>0){
        const lastReal = workoutHistory.find(w=>isRealSession(w));
        if(lastReal){
          const gapMin = Math.round((Date.now()-new Date(lastReal.created_at))/60000);
          if(gapMin>=60&&gapMin<180){
            const sessionQ = `\n\nAlso — it's been ${gapMin} minutes since your last log. Same workout still, or is this a new session?`;
            setMessages(prev=>[...prev,{role:"assistant",content:finalReply+sessionQ}]);
            setSessionCheckPending({parsed,msg,reply:finalReply,updatedAthlete});
            setLoading(false);
            return;
          }
        }
      }

      await finalizeWorkout(parsed,msg,finalReply,updatedAthlete,false,true);
    } catch(e){
      console.error("JoBot error:",e);
      setMessages(prev=>[...prev,{role:"assistant",content:`Hit a snag. Try again. (${e?.message||"unknown error"})`}]);
    }
    setLoading(false);
  };

  // ── Frame extraction: pull N evenly-spaced frames from a video file ──────────
  // Approach: attach to DOM with real dimensions (iOS requirement), prime with
  // muted play() before seeking (iOS seeking requires prior playback), filter
  // blank frames by checking base64 length.
  const extractFrames = (file, numFrames=4) => new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline","");
    video.setAttribute("webkit-playsinline","");
    video.width  = 320;
    video.height = 240;
    // opacity:0.01 not 0 — iOS skips rendering fully invisible elements
    video.style.cssText = "position:fixed;top:0;left:0;width:320px;height:240px;opacity:0.01;pointer-events:none;z-index:-9999;";
    document.body.appendChild(video);

    const frames = [];
    const times  = [];
    let ti = 0;
    let started = false;
    let done    = false;

    const finish = () => {
      if(done) return; done = true;
      try { document.body.removeChild(video); } catch(_){}
      try { URL.revokeObjectURL(url); } catch(_){}
      resolve(frames);
    };

    const snap = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 320; c.height = 240;
        c.getContext("2d").drawImage(video, 0, 0, 320, 240);
        const d = c.toDataURL("image/jpeg", 0.65).split(",")[1];
        if(d && d.length > 500) frames.push(d); // blank frames are tiny — skip them
      } catch(_){}
    };

    const seekNext = () => {
      if(ti >= times.length){ finish(); return; }
      let ok = false;
      const t = setTimeout(()=>{ if(!ok){ ok=true; ti++; seekNext(); }}, 5000);
      video.onseeked = () => {
        if(ok) return; ok=true; clearTimeout(t);
        snap(); ti++;
        setTimeout(seekNext, 100);
      };
      video.currentTime = times[ti];
    };

    const begin = async () => {
      if(started) return; started = true;
      // Prime the iOS video player: muted autoplay is allowed and unlocks seeking
      try { await video.play(); video.pause(); } catch(_){}
      const dur = video.duration;
      if(!dur || !isFinite(dur) || dur <= 0){
        snap(); finish(); return; // grab whatever frame is available
      }
      const safe = Math.min(dur, 90); // cap at 90s
      const step = safe / (numFrames + 1);
      for(let i=0; i<numFrames; i++) times.push(Math.min(step*(i+1), safe - 0.3));
      seekNext();
    };

    video.onloadedmetadata = begin;
    video.onloadeddata     = begin;
    video.onerror          = () => finish();
    setTimeout(finish, 30000);

    video.src = url;
    video.load();
  });

  const handleVideoUpload = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    e.target.value="";
    setVideoLoading(true);

    const sizeMB = (file.size/1024/1024).toFixed(1);
    setMessages(prev=>[...prev,
      {role:"user",content:`[Form review video: ${file.name} — ${sizeMB}MB]`},
      {role:"assistant",content:`Reading your video...`}
    ]);

    const updateMsg = (text) => setMessages(prev=>{const u=[...prev];u[u.length-1]={role:"assistant",content:text};return u;});

    try {
      updateMsg("Extracting frames from your video...");
      const frames = await extractFrames(file, 4);

      if(frames.length === 0){
        throw new Error("Couldn't read that video. Try a shorter clip or a different format (MP4 works best).");
      }

      updateMsg(`Analyzing your form (${frames.length} frames)...`);

      const sportFocusMap = {
        Football:"hip hinge depth, knee tracking over toes, bar path, core bracing, shoulder position on pressing",
        Basketball:"landing mechanics, knee valgus on jumps, hip loading on deceleration",
        Volleyball:"shoulder position on overhead movements, jump mechanics and landing",
        Soccer:"single-leg stability, hip alignment, ankle position",
        Baseball:"rotational mechanics, shoulder/hip separation, arm path",
        Archery:"stance width, draw arm position, bow shoulder, anchor point consistency",
        "Olympic Weightlifting":"bar path, receiving position, catch depth, overhead stability",
        Running:"foot strike relative to hips, hip extension at push-off, arm drive, forward lean",
        "General Fitness":"joint alignment, bracing, range of motion, symmetry",
      };
      const focus = sportFocusMap[athlete.sport] || "joint alignment, bracing, range of motion";

      const movementCtx = movementLabel.trim()
        ? `The athlete says they are performing: ${movementLabel.trim()}. Use this as the movement label — do not second-guess it.`
        : `Identify the movement from the frames.`;

      const sys = `You are Coach Joe Thomas — high school strength coach, 20+ years military S&C. You are reviewing still frames from a workout video of ${athlete.name} (sport: ${athlete.sport}).

${movementCtx}
Give direct, specific coaching feedback on their form. Focus on: ${focus}.

Format your response exactly like this:
Movement: [name the movement — use the athlete's label if provided]
What's solid: [1-2 things done well]
Fix these:
1. [Most important cue — be specific, e.g. "Drive knees out at the bottom, not in"]
2. [Second cue]
3. [Third cue if applicable]

Keep it under 200 words. No fluff. If the frames are unclear, use the clearest one.`;

      const analysis = await askClaude(sys, `Here are ${frames.length} frames from ${athlete.name}'s workout video. Analyze their form.`, 400, frames);

      updateMsg(analysis);
      await sbInsert("workouts",{
        athlete_id:athlete.id,
        raw_message:`[Form review: ${file.name}]`,
        bot_reply:analysis,
        parsed_data:{exercises:[],pain_flags:[],equipment_issues:[],questions:[],session_feel:null,general_notes:"Video form review"}
      });
    } catch(err){
      updateMsg(`Couldn't analyze that video. ${err.message||"Try a shorter clip (MP4 works best)."}`);
    }
    setVideoLoading(false);
  };

  const quick = ["No squat rack today","My knee is sore","I'm at the hotel gym","Can't do pull-ups","Bench alternative?","My program is..."];

  return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",background:C.navy,maxWidth:600,margin:"0 auto"}}>
      <style>{GS}</style>
      {/* Header */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,paddingTop:"calc(10px + env(safe-area-inset-top, 0px))",paddingBottom:"10px",paddingLeft:"14px",paddingRight:"14px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,gap:8}}>
        <div style={{minWidth:0,flex:1}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2,lineHeight:1}}>COACH JOE-BOT</div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginTop:2,flexWrap:"wrap"}}>
            <div style={{color:C.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{athlete.name} · {athlete.sport}</div>
            {(()=>{const t=TIERS[athlete.tier||"free"];return(<span style={{background:`${t.color}22`,border:`1px solid ${t.color}`,borderRadius:4,padding:"1px 6px",color:t.color,fontSize:9,fontWeight:700,letterSpacing:1,flexShrink:0}}>{t.badge}</span>);})()}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
          {saved&&<div style={{background:"#0a1e0a",border:`1px solid ${C.green}`,borderRadius:8,padding:"4px 8px",color:C.green,fontSize:11,fontWeight:600,flexShrink:0}}>✓</div>}
          {(athlete.tier||"free")!=="free"&&(
            <button onClick={()=>setShowProgram(true)} title="View or edit your training program"
              style={{background:athlete.temp_program_text?`${C.gold}15`:athlete.program_text?"#0a0e1e":C.navy3,border:`1px solid ${athlete.temp_program_text?C.gold:athlete.program_text?C.blue:C.border}`,borderRadius:8,padding:"4px 10px",color:athlete.temp_program_text?C.gold:athlete.program_text?C.blue:C.muted,fontSize:11,cursor:"pointer",display:"flex",alignItems:"center",gap:4}}>
              {athlete.temp_program_text?"✈️ Temp Program":"📋 "+(athlete.program_text?"Program":"Add Program")}
            </button>
          )}
          {(athlete.tier||"free")!=="free"&&<button onClick={()=>setShowLog(true)} style={{background:C.navy3,border:`1px solid ${C.gold}`,color:C.gold,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:11,fontFamily:"'Bebas Neue'",letterSpacing:1}}>MY LOG</button>}
          <button onClick={()=>setShowSettings(true)} title="Settings" style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:14,lineHeight:1}}>⚙</button>
          {!isMobile&&<button onClick={onLogout} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Log Out</button>}
        </div>
      </div>

      {/* Messages */}
      <div style={{flex:1,overflowY:"auto",padding:"16px 16px 8px"}}>
        {!historyLoaded?(
          <div style={{textAlign:"center",padding:40,color:C.muted}}>Loading...</div>
        ):(
          <>
            {messages.map((m,i)=>(
              <div key={i} className="fade-up" style={{marginBottom:12,display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                {m.role==="assistant"&&<div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#000",flexShrink:0,marginRight:8,marginTop:2}}>J</div>}
                <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:m.role==="user"?"16px 16px 4px 16px":"16px 16px 16px 4px",background:m.role==="user"?C.gold:C.navy2,color:m.role==="user"?"#000":C.text,fontSize:14,lineHeight:1.7,border:m.role==="assistant"?`1px solid ${C.border}`:"none",whiteSpace:"pre-wrap"}}>
                  {m.content}
                </div>
              </div>
            ))}
            {(loading||videoLoading)&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#000"}}>J</div>
                <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:"16px 16px 16px 4px",padding:"12px 16px",display:"flex",gap:5}}>
                  {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:C.muted,animation:`pulse 1.2s ease ${i*0.2}s infinite`}}/>)}
                </div>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef}/>
      </div>

      {/* Quick replies / Session check prompt */}
      <div style={{padding:"0 16px 8px",display:"flex",gap:6,overflowX:"auto",flexShrink:0,alignItems:"center"}}>
        {sessionCheckPending?(
          <>
            <span style={{color:C.muted,fontSize:12,flexShrink:0}}>↑</span>
            <button onClick={()=>confirmSession(false)}
              style={{background:`${C.green}20`,border:`1px solid ${C.green}`,color:C.green,borderRadius:20,padding:"7px 18px",cursor:"pointer",fontSize:13,fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>
              Same workout
            </button>
            <button onClick={()=>confirmSession(true)}
              style={{background:`${C.gold}20`,border:`1px solid ${C.gold}`,color:C.gold,borderRadius:20,padding:"7px 18px",cursor:"pointer",fontSize:13,fontWeight:600,whiteSpace:"nowrap",flexShrink:0}}>
              New session
            </button>
          </>
        ):(
          quick.map(p=>(
            <button key={p} onClick={()=>setInput(p)} style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:20,padding:"6px 12px",cursor:"pointer",fontSize:12,whiteSpace:"nowrap",flexShrink:0}}>{p}</button>
          ))
        )}
      </div>

      {/* Input area */}
      <div style={{padding:"8px 14px",paddingBottom:"max(16px, env(safe-area-inset-bottom))",flexShrink:0,borderTop:`1px solid ${C.border}`,background:C.navy2}}>
        <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
          {/* Video upload button */}
          <input ref={videoInputRef} type="file" accept="video/*" style={{display:"none"}} onChange={handleVideoUpload}/>
          <button
            onClick={()=>{ setMovementLabel(""); setMovementPrompt(true); }}
            disabled={loading||videoLoading||!historyLoaded}
            title="Upload video for form review"
            style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,width:44,height:44,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18,opacity:(loading||videoLoading)?0.4:1}}>
            🎬
          </button>

          {/* Movement label modal */}
          {movementPrompt&&(
            <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:24}}>
              <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:360}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:C.gold,letterSpacing:2,marginBottom:4}}>FORM REVIEW</div>
                <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>What movement are you filming? <span style={{color:C.muted,fontSize:12}}>(optional but helps)</span></div>
                <input
                  autoFocus
                  value={movementLabel}
                  onChange={e=>setMovementLabel(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter"){ setMovementPrompt(false); videoInputRef.current?.click(); }}}
                  placeholder="e.g. snatch, back squat, deadlift..."
                  style={{width:"100%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"11px 14px",color:C.text,fontSize:15,outline:"none",marginBottom:14}}/>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>setMovementPrompt(false)}
                    style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontFamily:"'DM Sans'"}}>
                    Cancel
                  </button>
                  <button onClick={()=>{ setMovementPrompt(false); videoInputRef.current?.click(); }}
                    style={{flex:2,background:C.gold,border:"none",color:"#000",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1}}>
                    Choose Video →
                  </button>
                </div>
              </div>
            </div>
          )}
          <textarea value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!sessionCheckPending){e.preventDefault();send();}}}
            placeholder={sessionCheckPending?"Tap Same workout or New session above...":`Tell Coach Joe about your workout, ${athlete.name}...`} rows={2}
            disabled={!!sessionCheckPending}
            style={{flex:1,background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",color:C.text,fontSize:14,outline:"none",resize:"none",lineHeight:1.5,opacity:sessionCheckPending?0.4:1}}/>
          <button onClick={send} disabled={loading||videoLoading||!input.trim()||!historyLoaded||!!sessionCheckPending}
            style={{background:C.gold,border:"none",borderRadius:12,width:44,height:44,cursor:(loading||!input.trim()||sessionCheckPending)?"not-allowed":"pointer",opacity:(loading||!input.trim()||sessionCheckPending)?0.5:1,fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"#000",fontWeight:700}}>
            →
          </button>
        </div>
        <div style={{color:C.muted,fontSize:10,marginTop:6,textAlign:"center"}}>Type naturally to log workouts · 🎬 upload a video for form review (MP4 works best)</div>
      </div>

      {/* My Log Modal */}
      {showLog&&<MyLogModal workoutHistory={workoutHistory} athlete={athlete} onClose={()=>setShowLog(false)}/>}

      {/* Program View Modal */}
      {showProgram&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:400}}>
          <style>{GS}</style>
          <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderTopLeftRadius:20,borderTopRightRadius:20,width:"100%",maxWidth:600,maxHeight:"85dvh",display:"flex",flexDirection:"column"}}>
            <div style={{padding:"16px 20px 12px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2}}>MY PROGRAM</div>
              <button onClick={()=>setShowProgram(false)} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"4px 12px",cursor:"pointer",fontSize:12}}>✕ Close</button>
            </div>
            {athlete.temp_program_text?(
              <div style={{flex:1,overflowY:"auto",padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:`${C.gold}12`,border:`1px solid ${C.gold}50`,borderRadius:12,padding:14}}>
                  <div style={{color:C.gold,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8}}>✈️ TEMPORARY PROGRAM — ACTIVE NOW</div>
                  <pre style={{color:C.text,fontSize:13,lineHeight:1.7,fontFamily:"'DM Sans'",whiteSpace:"pre-wrap",wordBreak:"break-word",margin:0}}>{athlete.temp_program_text}</pre>
                </div>
                <div style={{color:C.muted,fontSize:12,lineHeight:1.6,textAlign:"center"}}>
                  Tell Joe-bot you're back home when you return and your regular program will resume automatically.
                </div>
                {athlete.program_text&&(
                  <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:14}}>
                    <div style={{color:C.muted,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:8}}>REGULAR PROGRAM — ON HOLD</div>
                    <pre style={{color:C.muted2,fontSize:12,lineHeight:1.6,fontFamily:"'DM Sans'",whiteSpace:"pre-wrap",wordBreak:"break-word",margin:0}}>{athlete.program_text}</pre>
                  </div>
                )}
              </div>
            ):athlete.program_locked?(
              <>
                <div style={{background:`${C.gold}15`,border:`1px solid ${C.gold}40`,margin:"12px 16px 0",borderRadius:10,padding:"8px 14px",color:C.gold,fontSize:12}}>
                  🔒 Program locked by coach — contact your coach to make changes.
                </div>
                <div style={{flex:1,overflowY:"auto",padding:"16px 20px"}}>
                  <pre style={{color:C.text,fontSize:13,lineHeight:1.7,fontFamily:"'DM Sans'",whiteSpace:"pre-wrap",wordBreak:"break-word",margin:0}}>
                    {athlete.program_text}
                  </pre>
                </div>
              </>
            ):(
              <div style={{flex:1,overflowY:"auto",padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
                <input ref={athletePhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handleAthletePhotoProgram}/>
                <button onClick={()=>athletePhotoRef.current?.click()} disabled={athletePhotoProcessing}
                  style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:10,padding:"9px 14px",cursor:"pointer",fontSize:13,textAlign:"left"}}>
                  {athletePhotoProcessing?"📷 Reading photo...":"📷 Upload a photo of your program"}
                </button>
                <textarea
                  value={athleteProgramText}
                  onChange={e=>setAthleteProgramText(e.target.value)}
                  placeholder="Paste or type your program here, or use the photo upload above..."
                  rows={10}
                  style={{background:C.navy3,border:`1px solid ${athleteProgramText!==(athlete.program_text||"")?C.gold:C.border}`,borderRadius:12,padding:"12px 14px",color:C.text,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6,fontFamily:"'DM Sans'",transition:"border-color 0.15s"}}
                />
                {athleteProgramMsg&&(
                  <div style={{color:athleteProgramMsg==="Saved."?C.green:C.red,fontSize:12,fontWeight:600,textAlign:"center"}}>
                    {athleteProgramMsg}
                  </div>
                )}
                <button onClick={saveAthleteProgram} disabled={athleteProgramSaving||athleteProgramText===(athlete.program_text||"")}
                  style={{background:athleteProgramSaving||athleteProgramText===(athlete.program_text||"")?C.navy3:C.gold,color:athleteProgramSaving||athleteProgramText===(athlete.program_text||"")?C.muted:"#000",border:`1px solid ${athleteProgramSaving||athleteProgramText===(athlete.program_text||"")?C.border:C.gold}`,borderRadius:10,padding:"11px 20px",cursor:athleteProgramSaving||athleteProgramText===(athlete.program_text||"")?"not-allowed":"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1}}>
                  {athleteProgramSaving?"Saving...":"Save Program →"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings&&(
        <SettingsModal
          athlete={athlete}
          onClose={()=>setShowSettings(false)}
          onCoachUpdate={(updates)=>setAthlete(prev=>({...prev,...updates}))}
          onLogout={onLogout}
        />
      )}
    </div>
  );
}

// ─── MY LOG MODAL ─────────────────────────────────────────────────────────────
function MyLogModal({workoutHistory, athlete, onClose}) {
  const [tab,setTab] = useState("workouts");
  const painKey = `wilco_resolved_pain_${athlete.id}`;
  const [resolvedPain,setResolvedPain] = useState(()=>{
    try{return JSON.parse(localStorage.getItem(painKey)||"[]");}catch{return[];}
  });
  const resolvePain = async (area) => {
    const updated=[...new Set([...resolvedPain,area.toLowerCase()])];
    setResolvedPain(updated);
    try{localStorage.setItem(painKey,JSON.stringify(updated));}catch(_){}
    try{await sbUpdate("athletes",athlete.id,{resolved_pain:updated});}catch(_){}
  };
  const sessionCount = groupIntoSessions(workoutHistory).length;
  const realWorkouts = workoutHistory.filter(w=>w.parsed_data?.exercises?.length>0);

  return (
    <div style={{position:"fixed",inset:0,zIndex:300,background:C.navy,display:"flex",flexDirection:"column",maxWidth:600,margin:"0 auto"}}>
      <style>{GS}</style>
      {/* Header */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2}}>MY WORKOUT LOG</div>
          <div style={{color:C.muted,fontSize:11}}>{athlete.name} · {athlete.sport} · {sessionCount} session{sessionCount!==1?"s":""}</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:13}}>✕ Close</button>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
        {["workouts","progress"].map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"10px 20px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?C.gold:"transparent"}`,color:tab===t?C.gold:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"color 0.15s"}}>
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{flex:1,overflowY:"auto",padding:16}}>

        {/* ── WORKOUTS TAB ── */}
        {tab==="workouts"&&(()=>{
          // Group entries into sessions (entries within 3hrs = same session)
          const sessions = groupIntoSessions(workoutHistory)
            .sort((a,b)=>new Date(b.entries[0].created_at)-new Date(a.entries[0].created_at));

          // Separate form checks (not grouped into sessions)
          const formChecks = workoutHistory.filter(w=>w.raw_message?.startsWith("[Form review:"));

          // Merge form checks into a unified timeline item list with sessions
          const timeline = [
            ...sessions.map(s=>({type:"session",data:s,date:new Date(s.entries[s.entries.length-1].created_at)})),
            ...formChecks.map(w=>({type:"formcheck",data:w,date:new Date(w.created_at)})),
          ].sort((a,b)=>b.date-a.date);

          if(timeline.length===0) return (
            <div style={{color:C.muted,textAlign:"center",padding:40,fontSize:13}}>No activity logged yet.</div>
          );

          return (
            <div>
              {timeline.map((item,i)=>{
                if(item.type==="session"){
                  const session = item.data;
                  // Merge all exercises and pain flags across entries in this session
                  const allExercises = session.entries.flatMap(e=>{
                    const pd = typeof e.parsed_data==="string"?(()=>{try{return JSON.parse(e.parsed_data);}catch{return {};}})():(e.parsed_data||{});
                    return pd.exercises||[];
                  });
                  const allPainFlags = session.entries.flatMap(e=>{
                    const pd = typeof e.parsed_data==="string"?(()=>{try{return JSON.parse(e.parsed_data);}catch{return {};}})():(e.parsed_data||{});
                    return pd.pain_flags||[];
                  });
                  const sessionFeel = session.entries.slice().reverse().find(e=>{
                    const pd = typeof e.parsed_data==="string"?(()=>{try{return JSON.parse(e.parsed_data);}catch{return {};}})():(e.parsed_data||{});
                    return pd.session_feel;
                  });
                  const feelVal = sessionFeel?(typeof sessionFeel.parsed_data==="string"?JSON.parse(sessionFeel.parsed_data):sessionFeel.parsed_data)?.session_feel:null;
                  const lastReply = [...session.entries].reverse().find(e=>e.bot_reply)?.bot_reply;
                  const sessionDate = session.entries[0].created_at;

                  // Check if this is a run session
                  const allRunData = session.entries.map(e=>{
                    const pd = typeof e.parsed_data==="string"?(()=>{try{return JSON.parse(e.parsed_data);}catch{return {};}})():(e.parsed_data||{});
                    return pd.run_data;
                  }).filter(Boolean);
                  const isRunSession = allRunData.length>0 && allExercises.length===0;
                  const runDotColor = isRunSession ? C.blue : C.green;

                  return (
                    <div key={i} style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:6,height:6,borderRadius:"50%",background:runDotColor,flexShrink:0}}/>
                          <div style={{color:C.gold,fontSize:11,fontWeight:700,letterSpacing:1}}>{isRunSession?"RUN":"WORKOUT"} — {fmtDate(sessionDate)}</div>
                        </div>
                        {!isRunSession&&feelVal&&<div style={{fontSize:11,color:feelVal==="great"||feelVal==="good"?C.green:feelVal==="rough"?C.red:C.gold,fontWeight:600}}>{feelVal}</div>}
                      </div>
                      {isRunSession?(
                        <RunCard runData={allRunData[0]} feel={feelVal}/>
                      ):(
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:allPainFlags.length>0?8:0}}>
                          <thead>
                            <tr>
                              {["Exercise","Sets","Reps","Weight","Feel"].map(h=>(
                                <th key={h} style={{color:C.muted,fontWeight:600,fontSize:10,letterSpacing:1,textAlign:"left",paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {allExercises.map((e,j)=>(
                              <tr key={j}>
                                <td style={{color:C.text,fontWeight:600,padding:"5px 8px 5px 0"}}>{e.name}</td>
                                <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{e.sets||"—"}</td>
                                <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{e.reps||"—"}</td>
                                <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{fmtWeight(e.weight,e.unit)}</td>
                                <td style={{color:e.feel==="easy"?C.blue:e.feel==="hard"?C.red:C.muted,padding:"5px 0"}}>{e.feel||"—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {allPainFlags.filter(p=>!resolvedPain.includes(p.area.toLowerCase())).length>0&&(
                        <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:6}}>
                          {allPainFlags.filter(p=>!resolvedPain.includes(p.area.toLowerCase())).map((p,pi)=>(
                            <div key={pi} style={{display:"flex",alignItems:"center",gap:4,background:"rgba(239,68,68,0.12)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"3px 8px"}}>
                              <span style={{color:"#ef4444",fontSize:11}}>⚠ {p.area}</span>
                              <button onClick={()=>resolvePain(p.area)} title="Mark resolved — hides from active view" style={{background:"none",border:"none",color:"#64748b",cursor:"pointer",fontSize:10,padding:"0 2px",lineHeight:1}}>✓ resolved</button>
                            </div>
                          ))}
                        </div>
                      )}
                      {lastReply&&<div style={{marginTop:8,borderTop:`1px solid ${C.border}`,paddingTop:8,color:C.muted2,fontSize:12,fontStyle:"italic"}}>Coach Joe: "{lastReply.slice(0,200)}{lastReply.length>200?"...":""}"</div>}
                    </div>
                  );
                }
                if(item.type==="formcheck"){
                  const w = item.data;
                  return (
                    <div key={i} style={{background:C.navy2,border:`1px solid ${C.blue}30`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:C.blue,flexShrink:0}}/>
                        <div style={{color:C.blue,fontSize:11,fontWeight:700,letterSpacing:1}}>FORM CHECK — {fmtDate(w.created_at)}</div>
                      </div>
                      <div style={{color:C.muted2,fontSize:12,marginBottom:6}}>{w.raw_message}</div>
                      {w.bot_reply&&<div style={{color:C.text,fontSize:12,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.bot_reply}</div>}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          );
        })()}

        {/* ── PROGRESS TAB ── */}
        {tab==="progress"&&(
          <div>
            {/* Strength */}
            {(()=>{
              const byEx={};
              workoutHistory.forEach(w=>{
                const pd=typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return{};}})():(w.parsed_data||{});
                (pd.exercises||[]).forEach(ex=>{
                  if(!ex.name||!ex.weight||ex.unit==="bodyweight") return;
                  const k=normalizeExName(ex.name);
                  const unit=ex.unit||"lbs";
                  if(!byEx[k]) byEx[k]={name:ex.name,unit,entries:[]};
                  const lbsW=toLbs(ex.weight,unit);
                  byEx[k].entries.push({date:new Date(w.created_at),weight:ex.weight,unit,reps:ex.reps||1,e1rm:epley1RM(lbsW,ex.reps||1)});
                });
              });
              const exercises=Object.values(byEx).map(ex=>{
                const sorted=[...ex.entries].sort((a,b)=>a.date-b.date);
                const best=Math.max(...sorted.map(e=>e.e1rm));
                const bestEntry=sorted.reduce((a,b)=>b.e1rm>a.e1rm?b:a);
                return{...ex,entries:sorted,best,bestEntry};
              }).sort((a,b)=>b.best-a.best);
              if(exercises.length===0) return null;
              return(
                <>
                  <div style={{color:"#d4a017",fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>STRENGTH</div>
                  {exercises.map((ex,i)=>(
                    <div key={i} style={{background:"#0a1228",border:"1px solid #1e2a4a",borderRadius:12,padding:16,marginBottom:14}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                        <div>
                          <div style={{color:"#e2e8f0",fontWeight:700,fontSize:14}}>{ex.name}</div>
                          <div style={{color:"#64748b",fontSize:11,marginTop:2}}>{ex.entries.length} logged set{ex.entries.length!==1?"s":""}</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{color:"#64748b",fontSize:10,letterSpacing:1,marginBottom:2}}>BEST EST. 1RM</div>
                          <div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:"#d4a017",lineHeight:1}}>{ex.best}<span style={{fontSize:13,color:"#64748b",fontFamily:"'DM Sans'",marginLeft:2}}>{ex.unit==="kg"?"kg":"lbs"}</span></div>
                          <div style={{color:"#64748b",fontSize:10,marginTop:2}}>{fmtWeight(ex.bestEntry.weight,ex.unit)} × {ex.bestEntry.reps} rep{ex.bestEntry.reps!==1?"s":""}</div>
                        </div>
                      </div>
                      {ex.entries.length>=2?(
                        <LineChart data={ex.entries.map(e=>({label:fmtDateShort(e.date),y:e.e1rm}))} color="#d4a017" unit={ex.unit==="kg"?"kg":"lbs"}/>
                      ):(
                        <div style={{background:"#0d1836",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#94a3b8"}}>Log again to see a trend.</div>
                      )}
                    </div>
                  ))}
                </>
              );
            })()}

            {/* Running */}
            {(()=>{
              const runs=workoutHistory.filter(w=>{
                const pd=typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return{};}})():(w.parsed_data||{});
                return!!pd.run_data;
              }).map(w=>{
                const pd=typeof w.parsed_data==="string"?JSON.parse(w.parsed_data):(w.parsed_data||{});
                return{date:new Date(w.created_at),run:pd.run_data};
              }).sort((a,b)=>a.date-b.date);
              if(runs.length<2) return null;
              const paceToMin=(p)=>{if(!p)return null;const pts=p.split(":");if(pts.length<2)return null;const m=parseFloat(pts[0]),s=parseFloat(pts[1]);return isNaN(m)||isNaN(s)?null:Math.round((m+s/60)*100)/100;};
              const distData=runs.filter(r=>r.run.distance_miles||r.run.distance_km).map(r=>({label:fmtDateShort(r.date),y:r.run.distance_miles||r.run.distance_km}));
              const paceData=runs.filter(r=>r.run.pace_per_mile||r.run.pace_per_km).map(r=>({label:fmtDateShort(r.date),y:paceToMin(r.run.pace_per_mile||r.run.pace_per_km)})).filter(d=>d.y!==null);
              const hrData=runs.filter(r=>r.run.heart_rate_avg).map(r=>({label:fmtDateShort(r.date),y:r.run.heart_rate_avg}));
              return(
                <div style={{marginTop:8}}>
                  <div style={{color:"#3b82f6",fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>RUNNING</div>
                  {distData.length>=2&&(
                    <div style={{background:"#0a1228",border:"1px solid #1e2a4a",borderRadius:12,padding:16,marginBottom:14}}>
                      <div style={{color:"#e2e8f0",fontWeight:700,fontSize:14,marginBottom:12}}>Distance per run</div>
                      <LineChart data={distData} color="#3b82f6" unit=" mi"/>
                    </div>
                  )}
                  {paceData.length>=2&&(
                    <div style={{background:"#0a1228",border:"1px solid #1e2a4a",borderRadius:12,padding:16,marginBottom:14}}>
                      <div style={{color:"#e2e8f0",fontWeight:700,fontSize:14,marginBottom:4}}>Pace (min/mi) — lower is faster</div>
                      <LineChart data={paceData} color="#10b981" unit=""/>
                    </div>
                  )}
                  {hrData.length>=2&&(
                    <div style={{background:"#0a1228",border:"1px solid #1e2a4a",borderRadius:12,padding:16,marginBottom:14}}>
                      <div style={{color:"#e2e8f0",fontWeight:700,fontSize:14,marginBottom:12}}>Avg heart rate (bpm)</div>
                      <LineChart data={hrData} color="#ef4444" unit=" bpm"/>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function SettingsModal({athlete, onClose, onCoachUpdate, onLogout}) {
  const [coachName,setCoachName] = useState(athlete.coach_name||"");
  const [coachEmail,setCoachEmail] = useState(athlete.coach_email||"");
  const [weightUnit,setWeightUnit] = useState(athlete.weight_unit||"lbs");
  const [saving,setSaving] = useState(false);
  const [savedMsg,setSavedMsg] = useState("");
  const [selectedTier,setSelectedTier] = useState(athlete.tier||"free");
  const [upgrading,setUpgrading] = useState(false);
  const [upgradeMsg,setUpgradeMsg] = useState("");

  const currentTier = athlete.tier||"free";
  const tierOrder = {free:0,pro:1,elite:2};
  const tierChanged = selectedTier !== currentTier;

  const upgradeTier = async () => {
    if(upgrading||!tierChanged) return;
    setUpgrading(true); setUpgradeMsg("");
    try {
      await sbUpdate("athletes",athlete.id,{tier:selectedTier});
      onCoachUpdate({tier:selectedTier});
      setUpgradeMsg(tierOrder[selectedTier]>tierOrder[currentTier]?"Plan upgraded! Changes are live now.":"Plan updated.");
    } catch(e){
      setUpgradeMsg("Couldn't update plan. Try again.");
    }
    setUpgrading(false);
    setTimeout(()=>setUpgradeMsg(""),4000);
  };

  const save = async () => {
    if(saving) return;
    if(coachEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coachEmail)){
      setSavedMsg("Enter a valid email address."); return;
    }
    setSaving(true); setSavedMsg("");
    try {
      await sbUpdate("athletes",athlete.id,{coach_name:coachName.trim()||null, coach_email:coachEmail.trim()||null, weight_unit:weightUnit});
      onCoachUpdate({coach_name:coachName.trim()||null, coach_email:coachEmail.trim()||null, weight_unit:weightUnit});
      setSavedMsg("Saved.");
    } catch(e){
      setSavedMsg("Couldn't save. Try again.");
    }
    setSaving(false);
    setTimeout(()=>setSavedMsg(""),3000);
  };

  return (
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400,padding:24,overflowY:"auto"}}>
      <style>{GS}</style>
      <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:380,margin:"auto"}}>

        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:C.gold,letterSpacing:3}}>SETTINGS</div>
          <button onClick={onClose} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"4px 12px",cursor:"pointer",fontSize:12}}>✕ Close</button>
        </div>

        {/* Athlete info */}
        <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",marginBottom:16}}>
          <div style={{color:C.muted,fontSize:10,letterSpacing:1,marginBottom:2}}>LOGGED IN AS</div>
          <div style={{color:C.text,fontWeight:600,fontSize:14}}>{athlete.name}</div>
          <div style={{color:C.muted,fontSize:11}}>{athlete.sport}</div>
        </div>

        {/* Tier selector */}
        <div style={{marginBottom:16}}>
          <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>YOUR PLAN</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {Object.entries(TIERS).map(([key,t])=>{
              const isCurrent = currentTier===key;
              const isSelected = selectedTier===key;
              const tierFeatures = {
                free:"Chat with JoBot, log workouts",
                pro:"Full history, progress charts, program assignments, weekly coach reports",
                elite:"Everything in Pro + a WILCO Certified Coach assigned to you",
              };
              return (
                <div key={key}
                  onClick={()=>setSelectedTier(key)}
                  style={{
                    background:isSelected?`${t.color}20`:C.navy3,
                    border:`2px solid ${isSelected?t.color:C.border}`,
                    borderRadius:10,padding:"10px 14px",cursor:"pointer",
                    transition:"all 0.15s",position:"relative"
                  }}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:2}}>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:t.color,letterSpacing:2}}>{t.label}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{color:C.text,fontSize:13,fontWeight:700}}>{t.price}</div>
                      {isCurrent&&(
                        <span style={{background:t.color,color:"#000",fontSize:9,fontWeight:800,borderRadius:4,padding:"2px 6px",letterSpacing:1}}>CURRENT</span>
                      )}
                    </div>
                  </div>
                  <div style={{color:C.muted2,fontSize:11,lineHeight:1.4}}>{tierFeatures[key]}</div>
                  {isSelected&&!isCurrent&&(
                    <div style={{position:"absolute",top:8,right:8,width:16,height:16,borderRadius:"50%",background:t.color,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#000",fontWeight:800}}>✓</div>
                  )}
                </div>
              );
            })}
          </div>
          {upgradeMsg&&(
            <div style={{color:upgradeMsg.includes("upgraded")||upgradeMsg.includes("updated")?C.green:C.red,fontSize:12,textAlign:"center",marginTop:8,fontWeight:600}}>
              {upgradeMsg}
            </div>
          )}
          {tierChanged&&(
            <button onClick={upgradeTier} disabled={upgrading}
              style={btn(TIERS[selectedTier].color,tierOrder[selectedTier]>0?"#000":C.text,{marginTop:10,opacity:upgrading?0.7:1,cursor:upgrading?"not-allowed":"pointer"})}>
              {upgrading?"Updating...":`Switch to ${TIERS[selectedTier].label} →`}
            </button>
          )}
          {currentTier==="elite"&&!tierChanged&&(
            <div style={{marginTop:8,color:C.muted2,fontSize:11,lineHeight:1.5,textAlign:"center"}}>
              A WILCO Certified Coach will be in touch within 24 hrs. Email joe.thomas@commandengineering.com with any questions.
            </div>
          )}
        </div>

        {/* Weight unit preference */}
        <div style={{marginBottom:20}}>
          <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>WEIGHT UNIT</div>
          <div style={{display:"flex",gap:0,background:C.navy3,borderRadius:10,padding:4,border:`1px solid ${C.border}`}}>
            {["lbs","kg"].map(u=>(
              <button key={u} onClick={()=>setWeightUnit(u)}
                style={{flex:1,padding:"8px 0",borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:700,letterSpacing:1,fontFamily:"'Bebas Neue'",background:weightUnit===u?C.gold:"transparent",color:weightUnit===u?"#000":C.muted,transition:"all 0.15s"}}>
                {u.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Coach section */}
        <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:6}}>MY COACH</div>
        <div style={{color:C.muted2,fontSize:12,marginBottom:16,lineHeight:1.5}}>
          {(athlete.tier||"free")==="free"
            ? "Your coach will receive a welcome email. Upgrade to Pro for weekly progress reports."
            : "Your coach receives weekly progress reports every Monday."}
        </div>

        <div style={{marginBottom:14}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH NAME</label>
          <input
            value={coachName}
            onChange={e=>setCoachName(e.target.value)}
            placeholder="Coach's full name"
            style={inp()}/>
        </div>

        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>COACH EMAIL</label>
          <input
            type="email"
            value={coachEmail}
            onChange={e=>setCoachEmail(e.target.value)}
            placeholder="coach@example.com"
            style={inp()}/>
        </div>

        {savedMsg&&(
          <div style={{color:savedMsg==="Saved."?C.green:C.red,fontSize:12,textAlign:"center",marginBottom:12,fontWeight:600}}>
            {savedMsg}
          </div>
        )}

        <button onClick={save} disabled={saving} style={btn(C.gold,"#000",{opacity:saving?0.7:1,cursor:saving?"not-allowed":"pointer",marginBottom:10})}>
          {saving?"Saving...":"Save Changes →"}
        </button>

        {onLogout&&(
          <button onClick={onLogout} style={btn("transparent",C.muted,{border:`1px solid ${C.border}`,fontSize:13,padding:"10px",letterSpacing:1})}>
            Log Out
          </button>
        )}
      </div>
    </div>
  );
}

// ─── SCHOOLS LIST (master only) ───────────────────────────────────────────────
function SchoolsList({schools,coaches,onRefresh}) {
  const [confirmDelete,setConfirmDelete] = useState(null); // school id pending delete
  const [deleting,setDeleting] = useState(false);
  const [addingCoachFor,setAddingCoachFor] = useState(null); // school id showing add-coach form
  const [newCoachName,setNewCoachName] = useState("");
  const [newCoachEmail,setNewCoachEmail] = useState("");
  const [addingCoach,setAddingCoach] = useState(false);
  const [addCoachErr,setAddCoachErr] = useState("");
  const [addCoachSuccess,setAddCoachSuccess] = useState("");

  const coachCountFor = (schoolId) => coaches.filter(c=>c.school_id===schoolId).length;

  const openAddCoach = (schoolId) => {
    setAddingCoachFor(schoolId);
    setNewCoachName(""); setNewCoachEmail(""); setAddCoachErr(""); setAddCoachSuccess("");
  };
  const cancelAddCoach = () => { setAddingCoachFor(null); setAddCoachErr(""); setAddCoachSuccess(""); };

  const handleAddCoach = async (school) => {
    if(!newCoachName.trim()){setAddCoachErr("Coach name is required.");return;}
    if(!newCoachEmail.trim()){setAddCoachErr("Coach email is required.");return;}
    setAddingCoach(true); setAddCoachErr(""); setAddCoachSuccess("");
    try {
      // Next coach number = max existing coach_number for this school + 1
      const schoolCoaches = coaches.filter(c=>c.school_id===school.id);
      const maxNum = schoolCoaches.reduce((m,c)=>Math.max(m,c.coach_number||0),0);
      const coachNum = maxNum + 1;
      const accessCode = school.code.toUpperCase() + String(coachNum).padStart(2,"0");
      const coachRow = await sbInsert("coaches",{
        name: newCoachName.trim(),
        email: newCoachEmail.trim().toLowerCase(),
        school_id: school.id,
        coach_number: coachNum,
        access_code: accessCode,
        role: "coach"
      });
      if(!coachRow?.length) throw new Error("Failed to create coach.");
      fetch("/api/send-coach-invite",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({coachName:newCoachName.trim(),coachEmail:newCoachEmail.trim().toLowerCase(),accessCode,schoolName:school.name})
      }).catch(()=>{});
      setAddCoachSuccess(`✓ ${newCoachName.trim()} added as ${accessCode} — invite sent!`);
      setNewCoachName(""); setNewCoachEmail("");
      onRefresh();
      setTimeout(()=>{ setAddingCoachFor(null); setAddCoachSuccess(""); },2500);
    } catch(e){ setAddCoachErr(e.message||"Something went wrong."); }
    setAddingCoach(false);
  };

  const handleDelete = async (school) => {
    setDeleting(true);
    try {
      // Clear school_id + coach_id on athletes belonging to this school's coaches
      const schoolCoaches = coaches.filter(c=>c.school_id===school.id);
      for(const c of schoolCoaches){
        await fetch(`${SUPABASE_URL}/rest/v1/athletes?coach_id=eq.${c.id}`,{
          method:"PATCH",headers:{...sbH,"Prefer":"return=representation"},
          body:JSON.stringify({coach_id:null,school_id:null})
        });
        await sbDelete("coaches",`?id=eq.${c.id}`);
      }
      await sbDelete("schools",`?id=eq.${school.id}`);
      setConfirmDelete(null);
      onRefresh();
    } catch(e){console.error(e);}
    setDeleting(false);
  };

  if(schools.length===0) return null;

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",marginBottom:16}}>
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>SCHOOLS / TEAMS</div>
      {schools.map((s,i)=>{
        const coachCount = coachCountFor(s.id);
        const hasOpenSlot = coachCount < (s.max_coaches||3);
        const isAddingHere = addingCoachFor===s.id;
        return (
          <div key={i}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:12}}>
              {s.logo_url
                ? <img src={s.logo_url} alt={s.name} style={{width:36,height:36,borderRadius:6,objectFit:"contain",background:"#fff",padding:2,flexShrink:0}}/>
                : <div style={{width:36,height:36,borderRadius:6,background:C.navy3,border:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:16,color:C.gold,flexShrink:0}}>{s.code}</div>
              }
              <div style={{flex:1}}>
                <div style={{color:C.text,fontWeight:600,fontSize:14}}>{s.name}</div>
                <div style={{color:C.muted,fontSize:11}}>
                  Code: <span style={{color:C.gold,fontWeight:700}}>{s.code}</span> · {coachCount}/{s.max_coaches||3} coach{coachCount!==1?"es":""} · {s.tier} tier
                  {hasOpenSlot&&<span style={{color:C.green,marginLeft:6}}>· {(s.max_coaches||3)-coachCount} slot{(s.max_coaches||3)-coachCount!==1?"s":""} open</span>}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                {hasOpenSlot&&!isAddingHere&&confirmDelete!==s.id&&(
                  <button onClick={()=>openAddCoach(s.id)}
                    style={{background:"none",border:`1px solid ${C.gold}66`,color:C.gold,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11}}>
                    + Add Coach
                  </button>
                )}
                {confirmDelete===s.id ? (
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:C.muted,fontSize:11}}>Remove school + coaches?</span>
                    <button onClick={()=>handleDelete(s)} disabled={deleting}
                      style={{background:C.red,border:"none",color:"#fff",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:700}}>
                      {deleting?"...":"Yes, delete"}
                    </button>
                    <button onClick={()=>setConfirmDelete(null)}
                      style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11}}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>setConfirmDelete(s.id)}
                    style={{background:"none",border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11,flexShrink:0}}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            {/* Add Coach inline form */}
            {isAddingHere&&(
              <div style={{padding:"14px 16px",background:C.navy3,borderBottom:`1px solid ${C.border}`}}>
                <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>
                  ADD COACH TO {s.name.toUpperCase()} — code will be <span style={{color:C.gold,fontWeight:700}}>{s.code}{String((coaches.filter(c=>c.school_id===s.id).reduce((m,c)=>Math.max(m,c.coach_number||0),0))+1).padStart(2,"0")}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <input value={newCoachName} onChange={e=>setNewCoachName(e.target.value)} placeholder="Coach name" style={inp()}/>
                  <input type="email" value={newCoachEmail} onChange={e=>setNewCoachEmail(e.target.value)} placeholder="coach@school.edu" style={inp()}/>
                </div>
                {addCoachErr&&<div style={{color:C.red,fontSize:12,marginBottom:8}}>{addCoachErr}</div>}
                {addCoachSuccess&&<div style={{color:C.green,fontSize:12,marginBottom:8,fontWeight:600}}>{addCoachSuccess}</div>}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>handleAddCoach(s)} disabled={addingCoach}
                    style={{background:C.gold,border:"none",color:"#000",borderRadius:6,padding:"7px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>
                    {addingCoach?"Adding...":"Add & Send Invite →"}
                  </button>
                  <button onClick={cancelAddCoach}
                    style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"7px 12px",cursor:"pointer",fontSize:12}}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── COACHES LIST (master only) ────────────────────────────────────────────────
function CoachesList({coaches,schools,onRefresh}) {
  const [editingId,setEditingId] = useState(null);
  const [editName,setEditName] = useState("");
  const [editEmail,setEditEmail] = useState("");
  const [saving,setSaving] = useState(false);
  const [confirmDelete,setConfirmDelete] = useState(null);
  const [deleting,setDeleting] = useState(false);
  const [resendStatus,setResendStatus] = useState({}); // coachId → "sending"|"sent"|"error"

  const schoolFor = (schoolId) => schools.find(s=>s.id===schoolId);

  const startEdit = (c) => { setEditingId(c.id); setEditName(c.name); setEditEmail(c.email||""); };
  const cancelEdit = () => { setEditingId(null); setEditName(""); setEditEmail(""); };

  const saveEdit = async (c) => {
    if(!editName.trim()){return;}
    setSaving(true);
    try {
      await sbUpdate("coaches",c.id,{name:editName.trim(),email:editEmail.trim().toLowerCase()||null,pin:null});
      cancelEdit();
      onRefresh();
    } catch(e){console.error(e);}
    setSaving(false);
  };

  const resendInvite = async (c) => {
    setResendStatus(p=>({...p,[c.id]:"sending"}));
    try {
      const school = schoolFor(c.school_id);
      await fetch("/api/send-coach-invite",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({coachName:c.name,coachEmail:c.email,accessCode:c.access_code,schoolName:school?.name||""})
      });
      setResendStatus(p=>({...p,[c.id]:"sent"}));
      setTimeout(()=>setResendStatus(p=>({...p,[c.id]:null})),3000);
    } catch(e){ setResendStatus(p=>({...p,[c.id]:"error"})); }
  };

  const handleDelete = async (c) => {
    setDeleting(true);
    try {
      // Clear coach_id on their athletes
      await fetch(`${SUPABASE_URL}/rest/v1/athletes?coach_id=eq.${c.id}`,{
        method:"PATCH",headers:{...sbH,"Prefer":"return=representation"},
        body:JSON.stringify({coach_id:null,school_id:null})
      });
      await sbDelete("coaches",`?id=eq.${c.id}`);
      setConfirmDelete(null);
      onRefresh();
    } catch(e){console.error(e);}
    setDeleting(false);
  };

  const nonMasterCoaches = coaches.filter(c=>c.role!=="master");
  if(nonMasterCoaches.length===0) return null;

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",marginBottom:16}}>
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>ALL COACHES</div>
      {nonMasterCoaches.map((c,i)=>{
        const school = schoolFor(c.school_id);
        const isEditing = editingId===c.id;
        const rs = resendStatus[c.id];
        return (
          <div key={i} style={{borderBottom:`1px solid ${C.border}`}}>
            {isEditing ? (
              <div style={{padding:"12px 16px",background:C.navy3}}>
                <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>EDIT COACH — <span style={{color:C.gold}}>{c.access_code}</span></div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="Coach name" style={inp()}/>
                  <input type="email" value={editEmail} onChange={e=>setEditEmail(e.target.value)} placeholder="Email" style={inp()}/>
                </div>
                <div style={{color:C.muted,fontSize:11,marginBottom:10}}>Saving will reset their PIN so the new coach can register fresh.</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>saveEdit(c)} disabled={saving} style={{background:C.gold,border:"none",color:"#000",borderRadius:6,padding:"7px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>
                    {saving?"Saving...":"Save"}
                  </button>
                  <button onClick={cancelEdit} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"7px 12px",cursor:"pointer",fontSize:12}}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:16,color:"#000",flexShrink:0}}>{c.name?.[0]?.toUpperCase()||"?"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:C.text,fontWeight:600,fontSize:14}}>{c.name}</div>
                  <div style={{color:C.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    <span style={{color:C.gold,fontWeight:700}}>{c.access_code}</span>
                    {school?` · ${school.name}`:""}
                    {c.email?` · ${c.email}`:""}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                  <div style={{color:c.pin?C.green:C.red,fontSize:10,marginRight:4}}>{c.pin?"✓ Active":"Not set up"}</div>
                  {/* Resend invite */}
                  {c.email&&c.role!=="master"&&(
                    <button onClick={()=>resendInvite(c)} disabled={!!rs}
                      style={{background:"none",border:`1px solid ${C.border}`,color:rs==="sent"?C.green:C.muted2,borderRadius:6,padding:"4px 8px",cursor:rs?"default":"pointer",fontSize:10}}>
                      {rs==="sending"?"...":rs==="sent"?"✓ Sent":rs==="error"?"Error":"Resend"}
                    </button>
                  )}
                  {/* Edit */}
                  {confirmDelete!==c.id&&(
                    <button onClick={()=>startEdit(c)}
                      style={{background:"none",border:`1px solid ${C.border}`,color:C.muted2,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
                      Replace
                    </button>
                  )}
                  {/* Delete */}
                  {confirmDelete===c.id ? (
                    <>
                      <button onClick={()=>handleDelete(c)} disabled={deleting}
                        style={{background:C.red,border:"none",color:"#fff",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:10,fontWeight:700}}>
                        {deleting?"...":"Confirm"}
                      </button>
                      <button onClick={()=>setConfirmDelete(null)}
                        style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={()=>setConfirmDelete(c.id)}
                      style={{background:"none",border:`1px solid ${C.red}44`,color:C.red,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SCHOOL ONBOARDING FORM (master only) ─────────────────────────────────────
function SchoolOnboardingForm({onCreated}) {
  const [schoolName,setSchoolName] = useState("");
  const [schoolCode,setSchoolCode] = useState("");
  const [contactEmail,setContactEmail] = useState("");
  const [tier,setTier] = useState("group");
  const [maxCoaches,setMaxCoaches] = useState(3);
  const [maxAthletes,setMaxAthletes] = useState(50);
  const [coaches,setCoaches] = useState([{name:"",email:""},{name:"",email:""},{name:"",email:""}]);
  const [logoFile,setLogoFile] = useState(null);
  const [logoPreview,setLogoPreview] = useState(null);
  const [saving,setSaving] = useState(false);
  const [err,setErr] = useState("");
  const [success,setSuccess] = useState("");

  // Auto-suggest 3-letter code from school name
  useEffect(()=>{
    if(!schoolName.trim()) return;
    const words = schoolName.trim().split(/\s+/);
    let code = "";
    if(words.length>=3)      code=(words[0][0]+words[1][0]+words[2][0]).toUpperCase();
    else if(words.length===2) code=(words[0].slice(0,2)+words[1][0]).toUpperCase();
    else                      code=schoolName.slice(0,3).toUpperCase();
    setSchoolCode(code);
  },[schoolName]);

  const updateCoach = (i,field,val) => setCoaches(prev=>prev.map((c,idx)=>idx===i?{...c,[field]:val}:c));

  const updateMaxCoaches = (n) => {
    setMaxCoaches(n);
    setCoaches(prev=>{
      const arr=[...prev];
      while(arr.length<n) arr.push({name:"",email:""});
      return arr.slice(0,n);
    });
  };

  const handleLogoChange = (e) => {
    const file=e.target.files?.[0];
    if(!file) return;
    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
  };

  const handleSubmit = async () => {
    if(!schoolName.trim()){setErr("School name is required.");return;}
    if(!schoolCode.trim()||schoolCode.length!==3){setErr("School code must be exactly 3 letters.");return;}
    const validCoaches=coaches.slice(0,maxCoaches).filter(c=>c.name.trim()&&c.email.trim());
    if(validCoaches.length===0){setErr("Add at least one coach with name and email.");return;}
    setSaving(true); setErr(""); setSuccess("");
    try {
      // 1. Upload logo if provided
      let logoUrl=null;
      if(logoFile){
        const ext=logoFile.name.split(".").pop();
        const fileName=`${schoolCode.toLowerCase()}-${Date.now()}.${ext}`;
        const uploadRes=await fetch(`${SUPABASE_URL}/storage/v1/object/school-logos/${fileName}`,{
          method:"POST",
          headers:{"apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`,"Content-Type":logoFile.type,"x-upsert":"true"},
          body:logoFile
        });
        if(uploadRes.ok) logoUrl=`${SUPABASE_URL}/storage/v1/object/public/school-logos/${fileName}`;
      }
      // 2. Create school record
      const schools=await sbInsert("schools",{
        name:schoolName.trim(),
        code:schoolCode.toUpperCase(),
        logo_url:logoUrl,
        tier,
        max_coaches:maxCoaches,
        max_athletes:maxAthletes,
        contact_email:contactEmail.trim()||null
      });
      if(!schools?.length) throw new Error("Failed to create school — check if that 3-letter code is already taken.");
      const school=schools[0];
      // 3. Create coaches + send invites
      let created=0;
      for(let i=0;i<validCoaches.length;i++){
        const c=validCoaches[i];
        const coachNum=i+1;
        const accessCode=schoolCode.toUpperCase()+String(coachNum).padStart(2,"0");
        const coachRow=await sbInsert("coaches",{
          name:c.name.trim(),
          email:c.email.trim().toLowerCase(),
          school_id:school.id,
          coach_number:coachNum,
          access_code:accessCode,
          role:"coach"
        });
        if(coachRow?.length){
          created++;
          fetch("/api/send-coach-invite",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({coachName:c.name.trim(),coachEmail:c.email.trim().toLowerCase(),accessCode,schoolName:schoolName.trim()})
          }).catch(()=>{});
        }
      }
      setSuccess(`✓ ${schoolName} onboarded! ${created} coach invite${created!==1?"s":""} sent.`);
      setSchoolName(""); setSchoolCode(""); setContactEmail(""); setLogoFile(null); setLogoPreview(null);
      setCoaches([{name:"",email:""},{name:"",email:""},{name:"",email:""}]); setMaxCoaches(3);
      if(onCreated) onCreated();
    } catch(e){ setErr(e.message||"Something went wrong."); }
    setSaving(false);
  };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:20,marginBottom:16}}>
      <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:16}}>ONBOARD NEW SCHOOL / TEAM</div>

      {/* Row 1: name + code */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>SCHOOL / TEAM NAME</label>
          <input value={schoolName} onChange={e=>setSchoolName(e.target.value)} placeholder="Lincoln High School" style={inp()}/>
        </div>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CODE</label>
          <input value={schoolCode} onChange={e=>setSchoolCode(e.target.value.toUpperCase().replace(/[^A-Z]/g,"").slice(0,3))}
            placeholder="LHS" style={inp({textAlign:"center",letterSpacing:4,fontWeight:700,textTransform:"uppercase"})}/>
        </div>
      </div>

      {/* Row 2: contact email + tier */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CONTACT EMAIL</label>
          <input type="email" value={contactEmail} onChange={e=>setContactEmail(e.target.value)} placeholder="ad@school.edu" style={inp()}/>
        </div>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>TIER</label>
          <select value={tier} onChange={e=>setTier(e.target.value)} style={{...inp(),cursor:"pointer"}}>
            <option value="group">Group</option>
            <option value="school">School</option>
            <option value="district">District</option>
          </select>
        </div>
      </div>

      {/* Row 3: max coaches + max athletes */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>MAX COACHES</label>
          <select value={maxCoaches} onChange={e=>updateMaxCoaches(Number(e.target.value))} style={{...inp(),cursor:"pointer"}}>
            {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>MAX ATHLETES</label>
          <input type="number" value={maxAthletes} min={1} onChange={e=>setMaxAthletes(Number(e.target.value))} style={inp()}/>
        </div>
      </div>

      {/* Logo upload */}
      <div style={{marginBottom:16}}>
        <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>SCHOOL LOGO <span style={{color:C.muted,fontWeight:400,letterSpacing:0}}>(optional — PNG, SVG, or JPG)</span></label>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {logoPreview&&<img src={logoPreview} alt="Preview" style={{width:40,height:40,borderRadius:8,objectFit:"contain",background:"#fff",padding:3}}/>}
          <label style={{background:C.navy3,border:`1px dashed ${C.border}`,borderRadius:8,padding:"8px 14px",cursor:"pointer",color:C.muted2,fontSize:12,display:"inline-block"}}>
            {logoFile?logoFile.name:"Upload logo"}
            <input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={handleLogoChange} style={{display:"none"}}/>
          </label>
        </div>
      </div>

      {/* Coach slots */}
      <div style={{marginBottom:16}}>
        <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>
          COACHES — codes: <span style={{color:C.gold,fontWeight:700}}>{schoolCode||"???"}01</span>, <span style={{color:C.gold,fontWeight:700}}>{schoolCode||"???"}02</span>…
        </div>
        {coaches.slice(0,maxCoaches).map((c,i)=>(
          <div key={i} style={{display:"grid",gridTemplateColumns:"56px 1fr 1fr",gap:8,marginBottom:8,alignItems:"center"}}>
            <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:6,padding:"7px 4px",fontSize:11,fontWeight:700,color:C.gold,letterSpacing:1,fontFamily:"'Bebas Neue'",textAlign:"center"}}>
              {(schoolCode||"???")+String(i+1).padStart(2,"0")}
            </div>
            <input value={c.name} onChange={e=>updateCoach(i,"name",e.target.value)} placeholder={`Coach ${i+1} name`} style={inp()}/>
            <input type="email" value={c.email} onChange={e=>updateCoach(i,"email",e.target.value)} placeholder="email@school.edu" style={inp()}/>
          </div>
        ))}
      </div>

      {err&&<div style={{color:C.red,fontSize:12,marginBottom:12}}>{err}</div>}
      {success&&<div style={{color:C.green,fontSize:13,marginBottom:12,fontWeight:600}}>{success}</div>}
      <button onClick={handleSubmit} disabled={saving} style={btn(C.gold,"#000",{opacity:saving?0.7:1})}>
        {saving?"Creating school...":"Create School & Send Coach Invites →"}
      </button>
    </div>
  );
}

// ─── COACH DASHBOARD ──────────────────────────────────────────────────────────
function CoachDashboard({coach,onLogout}) {
  const isMaster = coach.role==="master"||coach.access_code===MASTER_CODE;
  const [athletes,setAthletes] = useState([]);
  const [workouts,setWorkouts] = useState([]);
  const [prs,setPrs] = useState([]);
  const [allCoaches,setAllCoaches] = useState([]);
  const [loading,setLoading] = useState(true);
  const [activeTab,setActiveTab] = useState("athletes");
  const [selected,setSelected] = useState(null);
  const [search,setSearch] = useState("");
  const [filterPain,setFilterPain] = useState(false);
  const [filterInactive,setFilterInactive] = useState(false);
  const [sortBy,setSortBy] = useState("lastActive"); // "lastActive" | "name"
  const [recalcStatus,setRecalcStatus] = useState(null); // null | "running" | "done" | "error" | "X/Y
  const isMobile = useIsMobile();
  const [selectMode,setSelectMode] = useState(false);
  const [selectedIds,setSelectedIds] = useState(new Set());
  const [bulkProgram,setBulkProgram] = useState("");
  const [showBulkModal,setShowBulkModal] = useState(false);
  const [bulkSaving,setBulkSaving] = useState(false);
  const [school,setSchool] = useState(null);
  const [allSchools,setAllSchools] = useState([]);

  useEffect(()=>{loadAll();},[]);

  // Keep selected athlete's program in sync with what Joe-bot may have updated
  useEffect(()=>{
    if(!selected) return;
    const selectedId = selected.id;
    const poll = setInterval(async ()=>{
      try {
        const fresh = await sbGet("athletes",`?id=eq.${selectedId}&select=program_text,program_locked,temp_program_text`);
        if(Array.isArray(fresh)&&fresh.length>0){
          const {program_text,program_locked,temp_program_text} = fresh[0];
          setSelected(prev=>{
            if(!prev||prev.id!==selectedId) return prev;
            if(prev.program_text===program_text&&prev.program_locked===program_locked&&prev.temp_program_text===temp_program_text) return prev;
            return {...prev,program_text,program_locked,temp_program_text};
          });
          setAthletes(prev=>prev.map(a=>a.id===selectedId?{...a,program_text,program_locked,temp_program_text}:a));
        }
      } catch(e){}
    },30000);
    return ()=>clearInterval(poll);
  },[selected?.id]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [a,w,p,c,s,sc] = await Promise.all([
        sbGet("athletes","?order=created_at.desc&select=*"),
        sbGet("workouts","?order=created_at.desc&select=*"),
        sbGet("prs","?order=created_at.desc&select=*"),
        isMaster ? sbGet("coaches","?select=*&order=created_at.asc") : Promise.resolve([]),
        (!isMaster&&coach.school_id) ? sbGet("schools",`?id=eq.${coach.school_id}&select=*`) : Promise.resolve([]),
        isMaster ? sbGet("schools","?select=*&order=created_at.asc") : Promise.resolve([])
      ]);
      let filteredAthletes = Array.isArray(a)?a:[];
      if(!isMaster){
        filteredAthletes = filteredAthletes.filter(at=>at.coach_id===coach.id);
      }
      setAthletes(filteredAthletes);
      const ids = filteredAthletes.map(at=>at.id);
      setWorkouts((Array.isArray(w)?w:[]).filter(wk=>ids.includes(wk.athlete_id)));
      setPrs((Array.isArray(p)?p:[]).filter(pr=>ids.includes(pr.athlete_id)));
      setAllCoaches(Array.isArray(c)?c:[]);
      setSchool(Array.isArray(s)&&s.length>0?s[0]:null);
      setAllSchools(Array.isArray(sc)?sc:[]);
    } catch(e){console.error(e);}
    setLoading(false);
  };

  const recalcAllPRs = async () => {
    setRecalcStatus("running");
    try {
      // Fetch every workout ever logged (need all history, not just what's loaded)
      const allWorkouts = await sbGet("workouts","?select=*&order=created_at.asc");
      if(!Array.isArray(allWorkouts)) throw new Error("Could not load workouts");
      let done = 0;
      for(const ath of athletes){
        const athWorkouts = allWorkouts.filter(w=>w.athlete_id===ath.id);
        // Find best estimated 1RM per exercise across all sessions
        const best = {};
        for(const w of athWorkouts){
          // parsed_data may come back as a string in some cases — parse it if so
          const pd = typeof w.parsed_data==="string" ? (() => { try{return JSON.parse(w.parsed_data);}catch{return {};} })() : (w.parsed_data||{});
          for(const ex of (pd.exercises||[])){
            if(!ex.name||!ex.weight||ex.unit==="bodyweight") continue;
            const k = normalizeExName(ex.name);
            const e1rm = epley1RM(ex.weight, ex.reps||1);
            if(!best[k]||e1rm>best[k].e1rm){
              best[k] = {exercise:ex.name,weight:ex.weight,reps:ex.reps||1,e1rm};
            }
          }
        }
        // Only wipe and re-insert if we actually found exercises (safety guard)
        if(Object.keys(best).length>0){
          await sbDelete("prs",`?athlete_id=eq.${ath.id}`);
          for(const {exercise,weight,reps,e1rm} of Object.values(best)){
            await sbInsert("prs",{athlete_id:ath.id,exercise,weight,reps,estimated_1rm:e1rm});
          }
        }
        done++;
        setRecalcStatus(`${done} / ${athletes.length} athletes done`);
      }
      setRecalcStatus("done");
      await loadAll();
      setTimeout(()=>setRecalcStatus(null),4000);
    } catch(e){
      console.error(e);
      setRecalcStatus("error");
      setTimeout(()=>setRecalcStatus(null),4000);
    }
  };

  const handleBulkAssign = async () => {
    if(!bulkProgram.trim()||selectedIds.size===0) return;
    setBulkSaving(true);
    try {
      for(const id of selectedIds){
        await sbUpdate("athletes",id,{program_text:bulkProgram.trim()});
      }
      setAthletes(prev=>prev.map(a=>selectedIds.has(a.id)?{...a,program_text:bulkProgram.trim()}:a));
      setSelectedIds(new Set());
      setSelectMode(false);
      setBulkProgram("");
      setShowBulkModal(false);
    } catch(e){console.error(e);}
    setBulkSaving(false);
  };

  const lastActive = (id) => {
    const ws = workouts.filter(w=>w.athlete_id===id);
    return ws.length ? ws[0].created_at : null;
  };

  const filtered = athletes.filter(a=>{
    if(search&&!a.name.toLowerCase().includes(search.toLowerCase())&&!a.sport.toLowerCase().includes(search.toLowerCase())) return false;
    if(filterPain&&!workouts.filter(w=>w.athlete_id===a.id).some(w=>w.parsed_data?.pain_flags?.length>0)) return false;
    if(filterInactive){
      const d = daysBetween(lastActive(a.id));
      if(d!==null&&d<=7) return false;
    }
    return true;
  }).sort((a,b)=>{
    if(sortBy==="name") return a.name.localeCompare(b.name);
    // "lastActive": most recent first; athletes who've never logged go to the bottom
    const la = lastActive(a.id), lb = lastActive(b.id);
    if(!la&&!lb) return 0;
    if(!la) return 1;
    if(!lb) return -1;
    return new Date(lb) - new Date(la);
  });

  const tabs = ["athletes","stats",...(isMaster?["coaches"]:[])];

  return (
    <div style={{minHeight:"100dvh",background:C.navy}}>
      <style>{GS}</style>
      {/* Header */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,paddingTop:isMobile?"calc(10px + env(safe-area-inset-top, 0px))":"14px",paddingBottom:isMobile?"10px":"14px",paddingLeft:isMobile?"14px":"20px",paddingRight:isMobile?"14px":"20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50,gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0,flex:1}}>
          {/* School logo — shown for team coaches who have a logo set */}
          {!isMaster&&school?.logo_url&&(
            <img src={school.logo_url} alt={school.name} style={{width:isMobile?32:40,height:isMobile?32:40,borderRadius:8,objectFit:"contain",background:"#fff",padding:3,flexShrink:0}}/>
          )}
          <div style={{minWidth:0}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:isMobile?17:22,color:C.gold,letterSpacing:2,lineHeight:1.1,whiteSpace:isMobile?"nowrap":"normal",overflow:"hidden",textOverflow:"ellipsis"}}>
              {isMaster ? "WILCO MASTER" : (school?.name ? school.name.toUpperCase() : "WILCO COACH")}
            </div>
            <div style={{color:C.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {coach.name}{!isMaster&&school?" · "+school.name:""}
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexShrink:0}}>
          <button onClick={loadAll} style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:isMobile?16:12}}>↻</button>
          <button onClick={onLogout} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Log Out</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,display:"flex",padding:"0 20px"}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>{setActiveTab(t);if(t!=="athletes")setSelected(null);}}
            style={{padding:"12px 18px",background:"none",border:"none",borderBottom:`2px solid ${activeTab===t?C.gold:"transparent"}`,color:activeTab===t?C.gold:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"color 0.15s"}}>
            {t==="stats"?"Group Stats":t}
          </button>
        ))}
      </div>

      <div style={{padding:isMobile?12:20,maxWidth:1400,margin:"0 auto"}}>
        {loading?(
          <div style={{textAlign:"center",padding:60,color:C.muted}}>Loading...</div>
        ):(
          <>
            {/* ── ATHLETES TAB ── */}
            {activeTab==="athletes"&&(
              <div style={{display:"grid",gridTemplateColumns:(!isMobile&&selected)?"300px 1fr":"1fr",gap:20,alignItems:"start"}}>
                {/* Left: Athlete List — hidden on mobile when detail is open */}
                {(!isMobile||!selected)&&(
                <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",position:isMobile?"static":"sticky",top:90}}>
                  <div style={{padding:"12px 14px",borderBottom:`1px solid ${C.border}`}}>
                    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search athletes..."
                      style={{width:"100%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:8}}/>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>setFilterPain(p=>!p)}
                        style={{flex:1,background:filterPain?`${C.red}20`:"transparent",border:`1px solid ${filterPain?C.red:C.border}`,color:filterPain?C.red:C.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                        Pain flags
                      </button>
                      <button onClick={()=>setFilterInactive(p=>!p)}
                        style={{flex:1,background:filterInactive?`${C.gold}20`:"transparent",border:`1px solid ${filterInactive?C.gold:C.border}`,color:filterInactive?C.gold:C.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                        Inactive 7d+
                      </button>
                      <button onClick={()=>setSortBy(s=>s==="lastActive"?"name":"lastActive")}
                        style={{flex:1,background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                        <span>{sortBy==="lastActive"?"⏱":"A–Z"}</span>
                        <span>{sortBy==="lastActive"?"Active":"Name"}</span>
                      </button>
                    </div>
                  </div>
                  <div style={{padding:"6px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <button onClick={()=>{setSelectMode(p=>!p);setSelectedIds(new Set());}}
                      style={{background:selectMode?`${C.gold}20`:"transparent",border:`1px solid ${selectMode?C.gold:C.border}`,color:selectMode?C.gold:C.muted,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                      {selectMode?"✕ Cancel":"☑ Bulk Assign"}
                    </button>
                    {selectMode&&selectedIds.size>0&&(
                      <button onClick={()=>setShowBulkModal(true)}
                        style={{background:C.gold,border:"none",color:"#000",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1}}>
                        Assign ({selectedIds.size})
                      </button>
                    )}
                  </div>
                  <div style={{maxHeight:isMobile?"none":"calc(100dvh - 240px)",overflowY:"auto"}}>
                    {filtered.length===0?(
                      <div style={{padding:24,textAlign:"center",color:C.muted,fontSize:13}}>No athletes found</div>
                    ):filtered.map(a=>{
                      const la = lastActive(a.id);
                      const d = daysBetween(la);
                      const aResolvedPain = (a.resolved_pain||[]).map(x=>x.toLowerCase());
                      const hasPain = workouts.filter(w=>w.athlete_id===a.id).some(w=>w.parsed_data?.pain_flags?.some(p=>!aResolvedPain.includes(p.area.toLowerCase())));
                      const isSel = selected?.id===a.id;
                      const dot = d===null?C.muted:d===0?C.green:d<=3?C.green:d<=7?C.gold:C.red;
                      return (
                        <div key={a.id}
                          onClick={()=>selectMode?setSelectedIds(prev=>{const s=new Set(prev);s.has(a.id)?s.delete(a.id):s.add(a.id);return s;}):setSelected(isSel?null:a)}
                          style={{padding:"11px 14px",borderBottom:`1px solid ${C.border}`,cursor:"pointer",background:selectedIds.has(a.id)?`${C.gold}15`:isSel?C.navy3:"transparent",transition:"background 0.15s",display:"flex",alignItems:"center",gap:10}}>
                          {selectMode?(
                            <div style={{width:20,height:20,borderRadius:4,border:`2px solid ${selectedIds.has(a.id)?C.gold:C.muted}`,background:selectedIds.has(a.id)?C.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,color:"#000"}}>
                              {selectedIds.has(a.id)&&"✓"}
                            </div>
                          ):(
                          <div style={{width:34,height:34,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:15,color:"#000",flexShrink:0}}>{a.name[0].toUpperCase()}</div>
                          )}
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{color:C.text,fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</div>
                            <div style={{color:C.muted,fontSize:11}}>{a.sport} · {groupIntoSessions(workouts.filter(w=>w.athlete_id===a.id)).length} sessions</div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            {hasPain&&<div style={{color:C.red,fontSize:9,marginBottom:2}}>⚠ pain</div>}
                            <div style={{display:"flex",alignItems:"center",gap:4,justifyContent:"flex-end"}}>
                              <div style={{width:7,height:7,borderRadius:"50%",background:dot}}/>
                              <div style={{color:C.muted,fontSize:10}}>{d===null?"never":d===0?"today":`${d}d ago`}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}

                {/* Right: Athlete Detail — full-screen on mobile when selected */}
                {selected&&(
                  <div>
                    {isMobile&&(
                      <button onClick={()=>setSelected(null)}
                        style={{display:"flex",alignItems:"center",gap:6,background:C.navy2,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:13,marginBottom:12,fontFamily:"'DM Sans'"}}>
                        ← Athletes
                      </button>
                    )}
                    <AthleteDetail
                      athlete={selected}
                      workouts={workouts.filter(w=>w.athlete_id===selected.id)}
                      prs={prs.filter(p=>p.athlete_id===selected.id)}
                      onProgramSave={async (text)=>{
                        await sbUpdate("athletes",selected.id,{program_text:text});
                        setAthletes(prev=>prev.map(a=>a.id===selected.id?{...a,program_text:text}:a));
                        setSelected(prev=>({...prev,program_text:text}));
                      }}
                      onAthleteDelete={(id)=>{
                        setAthletes(prev=>prev.filter(a=>a.id!==id));
                        setSelected(null);
                      }}
                    />
                  </div>
                )}
                {!selected&&!isMobile&&(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:C.muted,fontSize:13,border:`1px dashed ${C.border}`,borderRadius:14}}>
                    Select an athlete to view details
                  </div>
                )}
              </div>
            )}

            {/* Bulk Program Modal */}
            {showBulkModal&&(
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:24}}>
                <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:500}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2,marginBottom:4}}>BULK ASSIGN PROGRAM</div>
                  <div style={{color:C.muted,fontSize:12,marginBottom:14}}>Assigning to {selectedIds.size} athlete{selectedIds.size!==1?"s":""} — overwrites any existing program.</div>
                  <textarea value={bulkProgram} onChange={e=>setBulkProgram(e.target.value)} placeholder={"Paste the program here...\n\nExample:\nWeek 1:\n  Mon: Squat 3×5, Bench 3×5\n  Wed: Deadlift 1×5, OHP 3×5"} rows={10}
                    style={{width:"100%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",color:C.text,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6,fontFamily:"'DM Sans'",marginBottom:14}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setShowBulkModal(false)} style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14}}>Cancel</button>
                    <button onClick={handleBulkAssign} disabled={bulkSaving||!bulkProgram.trim()}
                      style={{flex:2,background:C.gold,border:"none",color:"#000",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,opacity:bulkSaving||!bulkProgram.trim()?0.6:1}}>
                      {bulkSaving?"Saving...":"Assign to "+selectedIds.size+" Athletes →"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── GROUP STATS TAB ── */}
            {activeTab==="stats"&&(
              <GroupStats athletes={athletes} workouts={workouts} prs={prs}/>
            )}

            {/* ── COACHES TAB (master only) ── */}
            {activeTab==="coaches"&&isMaster&&(
              <div style={{maxWidth:800}}>
                {/* School onboarding form */}
                <SchoolOnboardingForm onCreated={loadAll}/>


                {/* ── PR Recalculation ── */}
                <div style={{marginBottom:16,background:C.navy2,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
                  <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:6}}>DATA MAINTENANCE</div>
                  <div style={{color:C.muted2,fontSize:13,lineHeight:1.6,marginBottom:14}}>
                    Recalculates every athlete's PRs from their full workout history using the Epley estimated 1RM formula.
                    Run this once to correct records that were saved before the 1RM update. Takes a few seconds per athlete.
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:14}}>
                    <button
                      onClick={recalcAllPRs}
                      disabled={!!recalcStatus}
                      style={{background:recalcStatus?C.navy3:C.gold,color:recalcStatus?C.muted:"#000",border:`1px solid ${recalcStatus?C.border:C.gold}`,borderRadius:10,padding:"10px 22px",cursor:recalcStatus?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,transition:"all 0.2s"}}>
                      {recalcStatus&&recalcStatus!=="done"&&recalcStatus!=="error"?"Recalculating...":"Recalculate All PRs"}
                    </button>
                    {recalcStatus&&(
                      <div style={{fontSize:13,color:recalcStatus==="done"?C.green:recalcStatus==="error"?C.red:C.muted2,fontWeight:recalcStatus==="done"||recalcStatus==="error"?600:400}}>
                        {recalcStatus==="done"?"✓ Done — all PRs updated"
                          :recalcStatus==="error"?"✗ Something went wrong — check console"
                          :recalcStatus}
                      </div>
                    )}
                  </div>
                </div>
                {/* ── SCHOOLS LIST ── */}
                <SchoolsList schools={allSchools} coaches={allCoaches} onRefresh={loadAll}/>

                {/* ── COACHES LIST ── */}
                <CoachesList coaches={allCoaches} schools={allSchools} onRefresh={loadAll}/>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── GROUP STATS ──────────────────────────────────────────────────────────────
function GroupStats({athletes,workouts,prs}) {
  const now = new Date();
  const weekAgo = new Date(now-7*24*60*60*1000);

  const weekWorkouts = workouts.filter(w=>new Date(w.created_at)>=weekAgo&&isRealSession(w));
  const weekPRs = prs.filter(p=>new Date(p.created_at||0)>=weekAgo);
  const weekPain = weekWorkouts.filter(w=>w.parsed_data?.pain_flags?.length>0); // weekWorkouts already filtered to real sessions

  const activeIds = new Set(weekWorkouts.map(w=>w.athlete_id));
  const inactiveAthletes = athletes.filter(a=>!activeIds.has(a.id));
  const activeAthletes = athletes.filter(a=>activeIds.has(a.id));

  // Sessions per day this week for sparkline
  const dayLabels = [];
  const dayCounts = [];
  for(let i=6;i>=0;i--){
    const d = new Date(now);
    d.setDate(d.getDate()-i);
    d.setHours(0,0,0,0);
    const next = new Date(d); next.setDate(next.getDate()+1);
    dayLabels.push(d.toLocaleDateString("en-US",{weekday:"short"}));
    dayCounts.push(groupIntoSessions(workouts.filter(w=>{const wd=new Date(w.created_at);return wd>=d&&wd<next;})).length);
  }

  // Sport breakdown
  const bySport = {};
  activeAthletes.forEach(a=>{bySport[a.sport]=(bySport[a.sport]||0)+1;});

  return (
    <div style={{maxWidth:900}}>
      {/* Stat cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:12,marginBottom:24}}>
        {[
          {label:"Total Athletes",val:athletes.length,color:C.gold},
          {label:"Active This Week",val:activeAthletes.length,color:C.green},
          {label:"Sessions This Week",val:groupIntoSessions(weekWorkouts).length,color:C.green},
          {label:"Pain Flags This Week",val:weekPain.length,color:C.red},
          {label:"New PRs This Week",val:weekPRs.length,color:C.blue},
        ].map(s=>(
          <div key={s.label} style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:34,color:s.color}}>{s.val}</div>
            <div style={{color:C.muted,fontSize:10,letterSpacing:1}}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Sessions this week sparkline */}
      <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16,marginBottom:16}}>
        <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:12}}>SESSIONS PER DAY — LAST 7 DAYS</div>
        <LineChart data={dayLabels.map((l,i)=>({label:l,y:dayCounts[i]}))} color={C.green} unit=""/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
        {/* Pain flags */}
        {weekPain.length>0&&(
          <div style={{background:C.navy2,border:`1px solid ${C.red}40`,borderRadius:14,padding:16}}>
            <div style={{color:C.red,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>PAIN FLAGS THIS WEEK</div>
            {weekPain.slice(0,8).map((w,i)=>{
              const a = athletes.find(at=>at.id===w.athlete_id);
              return (
                <div key={i} style={{padding:"5px 0",borderBottom:`1px solid ${C.border}20`,fontSize:12}}>
                  <span style={{color:C.text,fontWeight:600}}>{a?.name||"Unknown"}</span>
                  <span style={{color:C.muted}}> — {w.parsed_data.pain_flags.map(p=>p.area).join(", ")}</span>
                  <span style={{color:C.muted,fontSize:10,marginLeft:6}}>{fmtDateShort(w.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* New PRs */}
        {weekPRs.length>0&&(
          <div style={{background:C.navy2,border:`1px solid ${C.blue}40`,borderRadius:14,padding:16}}>
            <div style={{color:C.blue,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>NEW PRs THIS WEEK</div>
            {weekPRs.slice(0,8).map((p,i)=>{
              const a = athletes.find(at=>at.id===p.athlete_id);
              return (
                <div key={i} style={{padding:"5px 0",borderBottom:`1px solid ${C.border}20`,fontSize:12}}>
                  <span style={{color:C.text,fontWeight:600}}>{a?.name||"Unknown"}</span>
                  <span style={{color:C.muted}}> — {p.exercise} {fmtWeight(p.weight,p.unit)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Inactive athletes */}
      {inactiveAthletes.length>0&&(
        <div style={{background:C.navy2,border:`1px solid ${C.gold}40`,borderRadius:14,padding:16,marginBottom:16}}>
          <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>NO SESSIONS THIS WEEK ({inactiveAthletes.length})</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {inactiveAthletes.map((a,i)=>{
              const la = workouts.filter(w=>w.athlete_id===a.id)[0];
              const d = la ? daysBetween(la.created_at) : null;
              return (
                <div key={i} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 12px"}}>
                  <div style={{color:C.text,fontSize:12,fontWeight:600}}>{a.name}</div>
                  <div style={{color:C.muted,fontSize:10}}>{d===null?"never logged":`Last: ${d}d ago`}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}


      {/* Sport breakdown */}
      {Object.keys(bySport).length>0&&(
        <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16}}>
          <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>ACTIVE ATHLETES BY SPORT</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {Object.entries(bySport).map(([sport,count])=>(
              <div key={sport} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 14px"}}>
                <div style={{color:C.text,fontWeight:600,fontSize:13}}>{sport}</div>
                <div style={{color:C.muted,fontSize:11}}>{count} active this week</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ATHLETE DETAIL (Coach Dashboard) ────────────────────────────────────────
function AthleteDetail({athlete,workouts,prs,onProgramSave,onAthleteDelete}) {
  const [tab,setTab] = useState("overview");
  const [programText,setProgramText] = useState(athlete.program_text||"");
  const [programLocked,setProgramLocked] = useState(!!athlete.program_locked);
  const [programSaving,setProgramSaving] = useState(false);
  const [programSaved,setProgramSaved] = useState(false);
  const [programError,setProgramError] = useState("");
  const [photoProcessing,setPhotoProcessing] = useState(false);
  const [confirmDelete,setConfirmDelete] = useState(false);
  const programPhotoRef = useRef(null);

  const handleDelete = async () => {
    try {
      await sbDelete("workouts",`?athlete_id=eq.${athlete.id}`);
      await sbDelete("prs",`?athlete_id=eq.${athlete.id}`);
      await sbDelete("athletes",`?id=eq.${athlete.id}`);
      onAthleteDelete(athlete.id);
    } catch(e){ console.error(e); }
  };

  useEffect(()=>{ setProgramText(athlete.program_text||""); },[athlete.id,athlete.program_text]);

  const handleProgramSave = async () => {
    setProgramSaving(true);
    setProgramError("");
    try {
      await onProgramSave(programText);
      setProgramSaved(true);
      setTimeout(()=>setProgramSaved(false),3000);
    } catch(e){
      setProgramError("Save failed — " + (e?.message||"check your connection and try again."));
    }
    setProgramSaving(false);
  };

  const handlePhotoProgram = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    e.target.value="";
    setPhotoProcessing(true);
    setProgramError("");
    try {
      const reader = new FileReader();
      const b64 = await new Promise((res,rej)=>{reader.onload=()=>res(reader.result.split(",")[1]);reader.onerror=rej;reader.readAsDataURL(file);});
      const extracted = await askClaude(
        "You are reading a photo of an athlete's training program. Extract the full program text exactly as written. Preserve all structure — exercises, sets, reps, weights, days, weeks. Output plain text only, no commentary.",
        "Extract the training program from this image.",600,[b64]
      );
      if(extracted) setProgramText(prev=>prev?prev+"\n\n"+extracted:extracted);
    } catch(err){ setProgramError("Couldn't read that image. Try a clearer photo."); }
    setPhotoProcessing(false);
  };

  const toggleLock = async () => {
    const newLocked = !programLocked;
    try {
      await sbUpdate("athletes",athlete.id,{program_locked:newLocked});
      setProgramLocked(newLocked);
    } catch(err){ setProgramError("Couldn't update lock. Try again."); }
  };

  const lastWorkout = workouts[0];
  const resolvedPainAreas = (athlete.resolved_pain||[]).map(a=>a.toLowerCase());
  const hasPain = workouts.some(w=>w.parsed_data?.pain_flags?.some(p=>!resolvedPainAreas.includes(p.area.toLowerCase())));
  const tabs = ["overview","workouts","progress","program"];

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
      {/* Athlete header */}
      <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`,background:C.navy3,display:"flex",alignItems:"center",gap:14}}>
        <div style={{width:48,height:48,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:22,color:"#000",flexShrink:0}}>
          {athlete.name[0].toUpperCase()}
        </div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.text,letterSpacing:1}}>{athlete.name}</div>
          <div style={{color:C.muted,fontSize:12}}>{athlete.sport} · {groupIntoSessions(workouts).length} sessions</div>
          {athlete.season_date&&<div style={{color:C.gold,fontSize:11}}>Season: {fmtDate(athlete.season_date)}</div>}
        </div>
        <div style={{display:"flex",gap:8,flexShrink:0,alignItems:"center"}}>
          {hasPain&&<div style={{background:`${C.red}20`,border:`1px solid ${C.red}`,borderRadius:8,padding:"4px 10px",color:C.red,fontSize:11}}>⚠ Pain</div>}
          {athlete.temp_program_text&&<div style={{background:`${C.gold}15`,border:`1px solid ${C.gold}`,borderRadius:8,padding:"4px 10px",color:C.gold,fontSize:11}}>✈️ Temp program</div>}
          {!athlete.temp_program_text&&athlete.program_text&&<div style={{background:"#0a0e1e",border:`1px solid ${C.blue}`,borderRadius:8,padding:"4px 10px",color:C.blue,fontSize:11}}>Program set</div>}
          {confirmDelete?(
            <div style={{display:"flex",gap:6,alignItems:"center",background:`${C.red}15`,border:`1px solid ${C.red}40`,borderRadius:10,padding:"4px 10px"}}>
              <span style={{color:C.muted2,fontSize:11}}>Delete athlete?</span>
              <button onClick={handleDelete} style={{background:C.red,border:"none",color:"#fff",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:11,fontWeight:700}}>Delete</button>
              <button onClick={()=>setConfirmDelete(false)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:6,padding:"3px 8px",cursor:"pointer",fontSize:11}}>Cancel</button>
            </div>
          ):(
            <button onClick={()=>setConfirmDelete(true)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:11}}>Delete</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:`1px solid ${C.border}`}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"10px 16px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?C.gold:"transparent"}`,color:tab===t?C.gold:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"color 0.15s"}}>
            {t==="progress"?"Progress":t}
          </button>
        ))}
      </div>

      <div style={{padding:20,maxHeight:"calc(100vh - 320px)",overflowY:"auto"}}>

        {/* ── OVERVIEW TAB ── */}
        {tab==="overview"&&(
          <div>
            {lastWorkout?(
              <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:16}}>
                <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:8}}>LAST SESSION — {fmtDateShort(lastWorkout.created_at)}</div>
                {lastWorkout.parsed_data?.run_data?(
                  <RunCard runData={lastWorkout.parsed_data.run_data} feel={lastWorkout.parsed_data.session_feel}/>
                ):lastWorkout.parsed_data?.exercises?.length>0?(
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {lastWorkout.parsed_data.exercises.map((e,i)=>(
                      <div key={i} style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 10px"}}>
                        <div style={{color:C.text,fontSize:12,fontWeight:600}}>{e.name}</div>
                        <div style={{color:C.muted,fontSize:11}}>
                          {e.sets&&e.reps?`${e.sets}×${e.reps}`:""}{e.weight?` @ ${fmtWeight(e.weight,e.unit)}`:""}
                        </div>
                      </div>
                    ))}
                  </div>
                ):(
                  <div style={{color:C.muted2,fontSize:13}}>{lastWorkout.raw_message?.slice(0,200)}</div>
                )}
                {lastWorkout.parsed_data?.session_feel&&(
                  <div style={{marginTop:8,color:C.muted,fontSize:11}}>
                    Feel: <span style={{color:lastWorkout.parsed_data.session_feel==="great"||lastWorkout.parsed_data.session_feel==="good"?C.green:lastWorkout.parsed_data.session_feel==="rough"?C.red:C.gold}}>
                      {lastWorkout.parsed_data.session_feel}
                    </span>
                  </div>
                )}
              </div>
            ):(
              <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:16,color:C.muted,fontSize:13}}>No sessions logged yet.</div>
            )}

            {(()=>{
              const painLogs = workouts.filter(w=>w.parsed_data?.pain_flags?.some(p=>!resolvedPainAreas.includes(p.area.toLowerCase())));
              if(!painLogs.length) return null;
              const areaCounts = {};
              painLogs.flatMap(w=>w.parsed_data.pain_flags.filter(p=>!resolvedPainAreas.includes(p.area.toLowerCase())).map(p=>p.area)).forEach(a=>areaCounts[a]=(areaCounts[a]||0)+1);
              return (
                <div style={{background:`${C.red}10`,border:`1px solid ${C.red}40`,borderRadius:12,padding:16,marginBottom:16}}>
                  <div style={{color:C.red,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:8}}>ACTIVE PAIN FLAGS ({painLogs.length} sessions flagged)</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {Object.entries(areaCounts).map(([area,count])=>(
                      <div key={area} style={{background:`${C.red}20`,border:`1px solid ${C.red}40`,borderRadius:8,padding:"4px 10px",fontSize:12,color:C.red}}>
                        {area} ×{count}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {prs.length>0&&(
              <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
                <div style={{color:C.blue,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>TOP PRs</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {prs.slice(0,6).map((p,i)=>(
                    <div key={i} style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 12px"}}>
                      <div style={{color:C.text,fontSize:12,fontWeight:600}}>{p.exercise}</div>
                      <div style={{color:C.blue,fontSize:13,fontWeight:700}}>{fmtWeight(p.weight,p.unit)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── WORKOUTS TAB ── */}
        {tab==="workouts"&&(
          <div>
            {workouts.length===0?(
              <div style={{color:C.muted,textAlign:"center",padding:40,fontSize:13}}>No activity logged yet.</div>
            ):workouts.slice(0,60).map((w,i)=>{
              const pd = typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return {};}})():(w.parsed_data||{});
              const isRun = !!pd.run_data && !pd.exercises?.length;
              const isWorkout = pd.exercises?.length>0 || isRun;
              const isFormCheck = w.raw_message?.startsWith("[Form review:");
              // ── Workout entry ──
              if(isWorkout) return (
                <div key={i} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:isRun?C.blue:C.green,flexShrink:0}}/>
                      <div style={{color:C.gold,fontSize:11,fontWeight:700,letterSpacing:1}}>{isRun?"RUN":"WORKOUT"} — {fmtDate(w.created_at)}</div>
                    </div>
                    {!isRun&&pd.session_feel&&<div style={{fontSize:11,color:pd.session_feel==="great"||pd.session_feel==="good"?C.green:pd.session_feel==="rough"?C.red:C.gold,fontWeight:600}}>{pd.session_feel}</div>}
                  </div>
                  {isRun?(
                    <RunCard runData={pd.run_data} feel={pd.session_feel}/>
                  ):(
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:pd.pain_flags?.length>0?8:0}}>
                      <thead>
                        <tr>
                          {["Exercise","Sets","Reps","Weight","Feel"].map(h=>(
                            <th key={h} style={{color:C.muted,fontWeight:600,fontSize:10,letterSpacing:1,textAlign:"left",paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {pd.exercises.map((e,j)=>(
                          <tr key={j}>
                            <td style={{color:C.text,fontWeight:600,padding:"5px 8px 5px 0"}}>{e.name}</td>
                            <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{e.sets||"—"}</td>
                            <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{e.reps||"—"}</td>
                            <td style={{color:C.muted2,padding:"5px 8px 5px 0"}}>{fmtWeight(e.weight,e.unit)}</td>
                            <td style={{color:e.feel==="easy"?C.blue:e.feel==="hard"?C.red:C.muted,padding:"5px 0"}}>{e.feel||"—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {pd.pain_flags?.length>0&&<div style={{color:C.red,fontSize:11,marginTop:4}}>⚠ {pd.pain_flags.map(p=>p.area).join(", ")}</div>}
                  {w.bot_reply&&<div style={{marginTop:8,borderTop:`1px solid ${C.border}`,paddingTop:8,color:C.muted2,fontSize:12,fontStyle:"italic"}}>Coach Joe: "{w.bot_reply.slice(0,200)}{w.bot_reply.length>200?"...":""}"</div>}
                </div>
              );
              // ── Form check ──
              if(isFormCheck) return (
                <div key={i} style={{background:C.navy3,border:`1px solid ${C.blue}30`,borderRadius:12,padding:14,marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:C.blue,flexShrink:0}}/>
                    <div style={{color:C.blue,fontSize:11,fontWeight:700,letterSpacing:1}}>FORM CHECK — {fmtDate(w.created_at)}</div>
                  </div>
                  <div style={{color:C.muted2,fontSize:12,marginBottom:6}}>{w.raw_message}</div>
                  {w.bot_reply&&<div style={{color:C.text,fontSize:12,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.bot_reply}</div>}
                </div>
              );
              // ── Q&A / Chat ──
              return (
                <div key={i} style={{marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:C.muted,flexShrink:0}}/>
                    <div style={{color:C.muted,fontSize:10,letterSpacing:1}}>Q&A — {fmtDate(w.created_at)}</div>
                  </div>
                  <div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}>
                    <div style={{background:C.gold,color:"#000",borderRadius:"14px 14px 4px 14px",padding:"8px 12px",fontSize:12,maxWidth:"85%"}}>{w.raw_message}</div>
                  </div>
                  {w.bot_reply&&(
                    <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
                      <div style={{width:22,height:22,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#000",flexShrink:0,marginTop:2}}>J</div>
                      <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:"14px 14px 14px 4px",padding:"8px 12px",fontSize:12,color:C.text,maxWidth:"85%",lineHeight:1.5}}>{w.bot_reply}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── PROGRESS TAB ── */}
        {tab==="progress"&&(
          <div>
            {(()=>{
              // Build per-exercise progression from full workout history
              const byEx = {};
              workouts.forEach(w=>{
                const pd = typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return {};}})():(w.parsed_data||{});
                (pd.exercises||[]).forEach(ex=>{
                  if(!ex.name||!ex.weight||ex.unit==="bodyweight") return;
                  const k = normalizeExName(ex.name);
                  const unit = ex.unit||"lbs";
                  if(!byEx[k]) byEx[k]={name:ex.name,unit,entries:[]};
                  const lbsW = toLbs(ex.weight, unit);
                  byEx[k].entries.push({date:new Date(w.created_at),weight:ex.weight,unit,reps:ex.reps||1,e1rm:epley1RM(lbsW,ex.reps||1)});
                });
              });
              const exercises = Object.values(byEx)
                .map(ex=>{
                  const sorted=[...ex.entries].sort((a,b)=>a.date-b.date);
                  const best=Math.max(...sorted.map(e=>e.e1rm));
                  const bestEntry=sorted.reduce((a,b)=>b.e1rm>a.e1rm?b:a);
                  return {...ex,entries:sorted,best,bestEntry};
                })
                .sort((a,b)=>b.best-a.best);

              if(exercises.length===0) return (
                <div style={{color:C.muted,textAlign:"center",padding:40,fontSize:13}}>No weighted exercises logged yet.</div>
              );

              return exercises.map((ex,i)=>(
                <div key={i} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:16,marginBottom:14}}>
                  {/* Header row */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{color:C.text,fontWeight:700,fontSize:14}}>{ex.name}</div>
                      <div style={{color:C.muted,fontSize:11,marginTop:2}}>{ex.entries.length} logged set{ex.entries.length!==1?"s":""}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{color:C.muted,fontSize:10,letterSpacing:1,marginBottom:2}}>LIFETIME BEST EST. 1RM</div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:C.gold,lineHeight:1}}>
                        {ex.best}<span style={{fontSize:13,color:C.muted,fontFamily:"'DM Sans'",marginLeft:2}}>{ex.unit==="kg"?"kg":"lbs"}</span>
                      </div>
                      <div style={{color:C.muted,fontSize:10,marginTop:2}}>{fmtWeight(ex.bestEntry.weight,ex.unit)} × {ex.bestEntry.reps} rep{ex.bestEntry.reps!==1?"s":""}</div>
                    </div>
                  </div>
                  {/* Chart or single-entry note */}
                  {ex.entries.length>=2?(
                    <LineChart data={ex.entries.map(e=>({label:fmtDateShort(e.date),y:e.e1rm}))} color={C.gold} unit={ex.unit==="kg"?"kg":"lbs"}/>
                  ):(
                    <div style={{background:C.navy2,borderRadius:8,padding:"8px 12px",fontSize:12,color:C.muted2}}>
                      Logged once — log again to see a trend line.
                    </div>
                  )}
                </div>
              ));
            })()}
          </div>
        )}

        {/* ── PROGRAM TAB ── */}
        {tab==="program"&&(
          <div>
            {/* Temp program banner */}
            {athlete.temp_program_text&&(
              <div style={{background:`${C.gold}12`,border:`1px solid ${C.gold}50`,borderRadius:12,padding:14,marginBottom:16}}>
                <div style={{color:C.gold,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:6}}>✈️ TEMPORARY PROGRAM ACTIVE</div>
                <div style={{color:C.muted2,fontSize:12,lineHeight:1.6,marginBottom:10,whiteSpace:"pre-wrap"}}>{athlete.temp_program_text}</div>
                <div style={{color:C.muted,fontSize:11}}>Joe-bot is using this instead of the regular program. It will revert automatically when {athlete.name} tells Joe-bot they're back to normal.</div>
              </div>
            )}

            <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:16,color:C.muted2,fontSize:13,lineHeight:1.65}}>
              {athlete.temp_program_text
                ? <><span style={{color:C.muted,fontWeight:600}}>Regular program (on hold).</span> Joe-bot is currently using the temporary program above. This will resume when the athlete returns to normal training.</>
                : athlete.program_text
                  ? <><span style={{color:C.blue,fontWeight:600}}>Program active.</span> This was set via the Joe-bot conversation or submitted by a coach. Joe-bot references it whenever making recommendations or logging workouts. You can edit or replace it below.</>
                  : <>No program set yet. You can paste or write a program here and Joe-bot will reference it going forward. Alternatively, the athlete can describe their program to Joe-bot ("my program is...") and it will be saved automatically.</>
              }
            </div>

            {athlete.program_text&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:athlete.temp_program_text?C.muted:C.blue,flexShrink:0}}/>
                <div style={{color:athlete.temp_program_text?C.muted:C.blue,fontSize:12}}>{athlete.temp_program_text?"On hold — resumes when temporary program clears":"Joe-bot references this in every conversation with "+athlete.name}</div>
                {!athlete.program_locked&&!athlete.temp_program_text&&<div style={{background:`${C.blue}15`,border:`1px solid ${C.blue}30`,borderRadius:6,padding:"2px 8px",color:C.blue,fontSize:11}}>🔄 Live — updates when {athlete.name} describes their program to Joe-bot</div>}
              </div>
            )}

            <textarea
              value={programText}
              onChange={e=>setProgramText(e.target.value)}
              placeholder={"Paste or write the athlete's training program here...\n\nExamples:\n  Week 1: Squat 3×5, Bench 3×5, Deadlift 1×5\n  Week 2: Squat 3×5 +5lbs, Bench 3×5 +5lbs\n\nOr paste a full multi-week periodization plan — Joe-bot will read the whole thing."}
              rows={14}
              style={{width:"100%",background:C.navy3,border:`1px solid ${programText!==(athlete.program_text||"")?C.gold:C.border}`,borderRadius:12,padding:"12px 14px",color:C.text,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6,fontFamily:"'DM Sans'",transition:"border-color 0.15s"}}
            />

            <input ref={programPhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhotoProgram}/>
            <div style={{display:"flex",gap:8,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
              <button onClick={handleProgramSave} disabled={programSaving||programText===(athlete.program_text||"")}
                style={{background:programSaving||programText===(athlete.program_text||"")?C.navy3:C.gold,color:programSaving||programText===(athlete.program_text||"")?C.muted:"#000",border:`1px solid ${programSaving||programText===(athlete.program_text||"")?C.border:C.gold}`,borderRadius:10,padding:"10px 20px",cursor:programSaving||programText===(athlete.program_text||"")?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1}}>
                {programSaving?"Saving...":"Save Program"}
              </button>
              <button onClick={()=>programPhotoRef.current?.click()} disabled={photoProcessing}
                style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:10,padding:"10px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:6,opacity:photoProcessing?0.6:1}}>
                {photoProcessing?"Reading photo...":"📷 Photo upload"}
              </button>
              <button onClick={toggleLock}
                style={{background:programLocked?`${C.gold}20`:"transparent",border:`1px solid ${programLocked?C.gold:C.border}`,color:programLocked?C.gold:C.muted,borderRadius:10,padding:"10px 14px",cursor:"pointer",fontSize:13}}>
                {programLocked?"🔒 Program locked":"🔓 Unlocked"}
              </button>
              {programSaved&&<div style={{color:C.green,fontSize:13,fontWeight:600}}>✓ Saved</div>}
              {!programSaved&&programText!==(athlete.program_text||"")&&!programSaving&&!programError&&<div style={{color:C.muted,fontSize:12}}>Unsaved changes</div>}
              {programError&&<div style={{color:C.red,fontSize:12,fontWeight:600}}>⚠ {programError}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
