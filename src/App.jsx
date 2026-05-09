import { useState, useEffect, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = import.meta.env.VITE_ANTHROPIC_KEY;
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY  = import.meta.env.VITE_SUPABASE_KEY;
const MASTER_CODE   = "FORTIS-MASTER"; // keep for backward compat

const SPORTS = ["Football","Basketball","Volleyball","Soccer","Baseball","Archery","Olympic Weightlifting","Running","General Fitness"];

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
  return r.json();
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

// ─── VIDEO FRAME EXTRACTION ───────────────────────────────────────────────────
const extractVideoFrames = (file, numFrames=4) => new Promise((resolve,reject) => {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = url; video.muted = true; video.playsInline = true;
  video.onloadedmetadata = async () => {
    const dur = video.duration;
    if(!isFinite(dur)||dur===0){URL.revokeObjectURL(url);reject(new Error("Cannot read video duration"));return;}
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext("2d");
    const frames = [];
    for(let i=0;i<numFrames;i++){
      const t = Math.min((dur/(numFrames+1))*(i+1), dur-0.1);
      await new Promise(res=>{
        video.currentTime = t;
        video.onseeked = () => {
          ctx.drawImage(video,0,0,640,360);
          frames.push(canvas.toDataURL("image/jpeg",0.7).split(",")[1]);
          res();
        };
      });
    }
    URL.revokeObjectURL(url);
    resolve(frames);
  };
  video.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Video load error")); };
});

// ─── CLAUDE ──────────────────────────────────────────────────────────────────
const askClaude = async (system, user, maxTokens=600, images=[]) => {
  const content = [];
  for(const img of images){
    content.push({type:"image",source:{type:"base64",media_type:"image/jpeg",data:img}});
  }
  content.push({type:"text",text:user});
  const r = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:maxTokens,system,messages:[{role:"user",content}]})
  });
  const d = await r.json();
  if(d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text||"";
};

const parseWorkout = async (message, name, sport) => {
  const sys = `Extract workout data from an athlete message. Return ONLY valid JSON, no markdown.
{"exercises":[{"name":string,"sets":number|null,"reps":number|null,"weight":number|null,"unit":"lbs"|"kg"|"bodyweight","feel":"easy"|"good"|"hard"|null,"notes":string|null}],"pain_flags":[{"area":string,"description":string}],"equipment_issues":[string],"questions":[string],"pr_attempts":[{"exercise":string,"weight":number,"reps":number,"achieved":boolean}],"session_feel":"great"|"good"|"average"|"rough"|null,"general_notes":string|null,"is_program_update":boolean}
Set is_program_update:true if the athlete is describing a training plan, program, or schedule (e.g. "my program is...", "here's my plan...", "my schedule this week is...").`;
  const text = await askClaude(sys,`Athlete: ${name} (${sport})\nMessage: ${message}`,900);
  try { return JSON.parse(text.replace(/```json|```/g,"").trim()); }
  catch { return {exercises:[],pain_flags:[],equipment_issues:[],questions:[],pr_attempts:[],session_feel:null,general_notes:message,is_program_update:false}; }
};

const getJoeBotReply = async (message, athlete, history, workoutHistory=[]) => {
  const hist = history.slice(-6).map(m=>`${m.role==="user"?athlete.name:"Coach Joe"}: ${m.content}`).join("\n");

  // Improved history context with explicit dates so bot can answer "what did I do Monday" etc.
  let pastContext = "";
  if(workoutHistory?.length>0){
    const recent = workoutHistory.slice(0,10).map(w=>{
      const d = new Date(w.created_at);
      const dateStr = d.toLocaleDateString("en-US",{weekday:"long",month:"short",day:"numeric"});
      const exs = w.parsed_data?.exercises?.map(e=>`${e.name}${e.weight?" "+e.weight+"lbs":""}${e.sets&&e.reps?" "+e.sets+"x"+e.reps:""}${e.feel?" ("+e.feel+")":""}`).join(", ")||"";
      const pain = w.parsed_data?.pain_flags?.map(p=>p.area).join(", ")||"";
      const feel = w.parsed_data?.session_feel?` | Session feel: ${w.parsed_data.session_feel}`:"";
      return `• ${dateStr}: ${exs||w.raw_message?.slice(0,120)}${pain?" | PAIN: "+pain:""}${feel}`;
    }).filter(Boolean).join("\n");
    pastContext = `\n\nATHLETE WORKOUT HISTORY (most recent first):\n${recent}\nWhen asked what they did on a specific day or recently, reference these exact dates and numbers.`;
  }

  let programContext = "";
  if(athlete.program_text){
    programContext = `\n\nATHLETE'S CURRENT PROGRAM:\n${athlete.program_text}\nReference this when giving programming feedback.`;
  }

  let phaseContext = "";
  if(athlete.season_date){
    const weeks = Math.max(0,Math.round((new Date(athlete.season_date)-new Date())/(7*24*60*60*1000)));
    if(weeks>12) phaseContext=`PHASE: STRENGTH (${weeks} wks to season). Compound lifts, progressive overload. No plyos yet.`;
    else if(weeks>4) phaseContext=`PHASE: POWER (${weeks} wks to season). Convert strength to explosiveness.`;
    else if(weeks>0) phaseContext=`PHASE: PEAK (${weeks} wks to season). Reduce volume, stay sharp.`;
    else phaseContext=`PHASE: IN-SEASON or post-season. Maintenance and recovery.`;
  } else phaseContext=`PHASE: No season date set. Default to strength-first.`;

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

  const sys = `You are Coach Joe Thomas -- high school strength coach, 20+ years military S&C. Direct, real, no fluff.
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
Out of scope: "That's one for Coach Joe directly -- email joe.thomas@commandengineering.com."${pastContext}${programContext}`;

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

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function WilcoApp() {
  const [view,setView] = useState("home");
  const [athlete,setAthlete] = useState(null);
  const [coach,setCoach] = useState(null);
  const [err,setErr] = useState("");

  if(view==="athlete"&&athlete) return <AthleteView athlete={athlete} onLogout={()=>{setAthlete(null);setView("home");}}/>;
  if(view==="coach"&&coach) return <CoachDashboard coach={coach} onLogout={()=>{setCoach(null);setView("home");}}/>;

  return (
    <div style={{minHeight:"100vh",background:C.navy,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
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
  const [data,setData] = useState({name:"",sport:SPORTS[0],pin:"",confirmPin:"",seasonDate:"",noSeason:false});
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
      setLoading(true);
      try {
        const created = await sbInsert("athletes",{name:data.name.trim(),sport:data.sport,pin:data.pin});
        if(created?.length>0){
          const newAthlete = created[0];
          try {
            const seasonDate = data.noSeason ? null : data.seasonDate||null;
            await fetch(`${SUPABASE_URL}/rest/v1/athletes?id=eq.${newAthlete.id}`,{
              method:"PATCH",headers:{...sbH,"Prefer":"return=representation"},
              body:JSON.stringify({season_date:seasonDate,no_season:data.noSeason})
            });
          } catch(e){}
          setAthlete({...newAthlete,season_date:data.noSeason?null:data.seasonDate||null,no_season:data.noSeason});
          setView("athlete");
        } else {
          setErr("Error: "+(created?.message||created?.error||JSON.stringify(created)));
        }
      } catch(e){setErr("Connection error.");}
      setLoading(false);
    }
  };

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>step>1?setStep(step-1):setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>NEW ATHLETE — STEP {step} OF 3</div>
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
        <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>Choose a 4-digit PIN you'll remember. There's no way to recover it if you forget.</div>
        <div style={{marginBottom:16}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CREATE PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={data.pin}
            onChange={e=>setD("pin",e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
        <div style={{marginBottom:20}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CONFIRM PIN</label>
          <input type="password" inputMode="numeric" maxLength={4} value={data.confirmPin}
            onChange={e=>setD("confirmPin",e.target.value.replace(/\D/g,"").slice(0,4))}
            placeholder="----" style={inp({fontSize:24,letterSpacing:8,textAlign:"center"})}/>
        </div>
      </>}
      {step===3&&<>
        <div style={{color:C.muted2,fontSize:13,marginBottom:16,lineHeight:1.6}}>When does your season start? Helps Joe-bot tailor your training.</div>
        {!data.noSeason&&<div style={{marginBottom:12}}>
          <label style={{color:C.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>SEASON START DATE</label>
          <input type="date" value={data.seasonDate} onChange={e=>setD("seasonDate",e.target.value)} style={inp()}/>
        </div>}
        <div onClick={()=>setD("noSeason",!data.noSeason)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginBottom:20,padding:"10px 12px",background:C.navy3,borderRadius:10,border:`1px solid ${C.border}`}}>
          <div style={{width:20,height:20,borderRadius:4,border:`2px solid ${data.noSeason?C.gold:C.muted}`,background:data.noSeason?C.gold:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
            {data.noSeason&&<span style={{color:"#000",fontSize:12,fontWeight:700}}>✓</span>}
          </div>
          <div style={{color:C.muted2,fontSize:13}}>I don't have a season / general fitness only</div>
        </div>
      </>}
      {err&&<div style={{color:C.red,fontSize:12,marginBottom:12,textAlign:"center"}}>{err}</div>}
      <button onClick={nextStep} disabled={loading} style={btn(C.gold,"#000",{opacity:loading?0.7:1,cursor:loading?"not-allowed":"pointer"})}>
        {loading?"Please wait...":(step===3?"Create Account →":"Next →")}
      </button>
    </div>
  );
}

// ─── ATHLETE LOGIN ────────────────────────────────────────────────────────────
function LoginScreen({setView,setAthlete,setErr,err}) {
  const [name,setName] = useState("");
  const [pin,setPin] = useState("");
  const [loading,setLoading] = useState(false);

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

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>ATHLETE LOGIN</div>
      </div>
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
      <div style={{textAlign:"center",marginTop:12}}>
        <button onClick={()=>setView("signup")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>New athlete? Sign up here</button>
      </div>
    </div>
  );
}

// ─── COACH LOGIN ──────────────────────────────────────────────────────────────
function CoachLoginScreen({setView,setCoach,setErr,err}) {
  const [pin,setPin] = useState("");
  const [loading,setLoading] = useState(false);

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

  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}>
        <button onClick={()=>setView("home")} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>←</button>
        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>COACH LOGIN</div>
      </div>
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
      <div style={{textAlign:"center",marginTop:12}}>
        <button onClick={()=>setView("coachSetup")} style={{background:"none",border:"none",color:C.muted,fontSize:12,cursor:"pointer"}}>First time? Enter access code</button>
      </div>
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
  const bottomRef = useRef(null);
  const videoInputRef = useRef(null);

  useEffect(()=>{bottomRef.current?.scrollIntoView({behavior:"smooth"});},[messages,loading,videoLoading]);

  useEffect(()=>{
    (async()=>{
      try {
        const logs = await sbGet("workouts",`?athlete_id=eq.${athlete.id}&order=created_at.desc&limit=20&select=*`);
        if(logs&&logs.length>0) setWorkoutHistory(logs);

        const lastLog = logs?.[0];
        const dAgo = lastLog ? daysBetween(lastLog.created_at) : null;
        const lastExs = lastLog?.parsed_data?.exercises?.map(e=>`${e.name}${e.weight?" "+e.weight+"lbs":""}${e.sets&&e.reps?" "+e.sets+"x"+e.reps:""}`).join(", ")||"";
        const lastDate = lastLog ? fmtDateShort(lastLog.created_at) : null;
        const summary = lastExs ? `Last session (${lastDate}): ${lastExs}.` : "";

        let greeting;
        if(!lastLog){
          if(!athlete.season_date&&!athlete.no_season){
            greeting = `Hey ${athlete.name}, welcome to WILCO. I'm Coach Joe-bot. Before we get started -- when does your ${athlete.sport} season begin? Give me a rough date like "September 1" or check the box below if you don't have one.`;
          } else {
            greeting = `Welcome to WILCO, ${athlete.name}. Tell me about your first workout -- what you did, how it felt, any questions.`;
          }
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

  const send = async () => {
    const msg = input.trim();
    if(!msg||loading||videoLoading||!historyLoaded) return;
    setInput("");
    const newMsgs = [...messages,{role:"user",content:msg}];
    setMessages(newMsgs);
    setLoading(true);

    try {
      let updatedAthlete = {...athlete};

      // Season date detection for new athletes
      if(!athlete.season_date&&!athlete.no_season){
        const noSeasonPhrases = ["no season","don't have","dont have","general fitness","no date","not sure","unknown"];
        const hasNoSeason = noSeasonPhrases.some(p=>msg.toLowerCase().includes(p));
        if(hasNoSeason){
          await sbUpdate("athletes",athlete.id,{no_season:true});
          updatedAthlete.no_season = true;
        } else {
          try {
            const dateStr = await askClaude("Extract a season start date from the message. Return ONLY YYYY-MM-DD format or null. Nothing else.",msg,50);
            const cleaned = dateStr.trim().replace(/[^0-9-]/g,"");
            if(cleaned.match(/^\d{4}-\d{2}-\d{2}$/)){
              await sbUpdate("athletes",athlete.id,{season_date:cleaned});
              updatedAthlete.season_date = cleaned;
            }
          } catch(e){}
        }
      }

      const [reply,parsed] = await Promise.all([
        getJoeBotReply(msg,updatedAthlete,newMsgs,workoutHistory),
        parseWorkout(msg,athlete.name,athlete.sport)
      ]);

      // Detect and save program updates
      if(parsed.is_program_update){
        try {
          await sbUpdate("athletes",athlete.id,{program_text:msg});
          updatedAthlete.program_text = msg;
          setAthlete(updatedAthlete);
        } catch(e){}
      }

      await sbInsert("workouts",{athlete_id:athlete.id,raw_message:msg,bot_reply:reply,parsed_data:parsed});
      setSaved(true); setTimeout(()=>setSaved(false),3000);

      // Auto PR detection
      const newPRs = [];
      if(parsed.exercises?.length>0){
        const existingPRs = await sbGet("prs",`?athlete_id=eq.${athlete.id}`);
        const prMap = {};
        if(Array.isArray(existingPRs)){
          existingPRs.forEach(pr=>{
            const k = pr.exercise?.toLowerCase().trim();
            if(!prMap[k]||pr.weight>prMap[k].weight) prMap[k]=pr;
          });
        }
        for(const ex of parsed.exercises){
          if(!ex.name||!ex.weight||ex.unit==="bodyweight") continue;
          const k = ex.name.toLowerCase().trim();
          if(!prMap[k]){
            await sbInsert("prs",{athlete_id:athlete.id,exercise:ex.name,weight:ex.weight,reps:ex.reps||1});
          } else if(ex.weight>prMap[k].weight){
            await sbInsert("prs",{athlete_id:athlete.id,exercise:ex.name,weight:ex.weight,reps:ex.reps||1});
            newPRs.push({exercise:ex.name,weight:ex.weight,prev:prMap[k].weight,diff:ex.weight-prMap[k].weight});
          }
        }
      }

      setMessages(prev=>[...prev,{role:"assistant",content:reply}]);
      setWorkoutHistory(prev=>[{raw_message:msg,parsed_data:parsed,created_at:new Date().toISOString()},...prev]);

      if(newPRs.length>0){
        try {
          const prCallout = newPRs.map(pr=>`${pr.exercise}: ${pr.weight}lbs (+${pr.diff}lbs)`).join("\n");
          const prReply = await askClaude(
            "You are Coach Joe Thomas. An athlete just hit a new PR. Acknowledge it directly -- short, punchy, in Coach Joe's voice. Atta boy/girl is appropriate here.",
            `Athlete: ${athlete.name} (${athlete.sport})\nNew PRs:\n${prCallout}`,150
          );
          setMessages(prev=>[...prev,{role:"assistant",content:prReply}]);
        } catch(e){
          setMessages(prev=>[...prev,{role:"assistant",content:newPRs.map(pr=>`New PR -- ${pr.exercise} at ${pr.weight}lbs. +${pr.diff}lbs. That's what the work is for.`).join("\n")}]);
        }
      }
    } catch(e){
      setMessages(prev=>[...prev,{role:"assistant",content:"Hit a snag. Try again."}]);
    }
    setLoading(false);
  };

  const handleVideoUpload = async (e) => {
    const file = e.target.files?.[0];
    if(!file) return;
    e.target.value="";
    setVideoLoading(true);

    // Show placeholder message while analyzing
    setMessages(prev=>[...prev,
      {role:"user",content:`[Video uploaded: ${file.name}]`},
      {role:"assistant",content:"Pulling frames from your video now — give me a sec..."}
    ]);

    try {
      const frames = await extractVideoFrames(file,4);
      const sportFocus = {
        "Football":"hip hinge, knee tracking, bar path on squats/deadlifts, core bracing",
        "Basketball":"landing mechanics, knee valgus on jumps, hip loading",
        "Volleyball":"shoulder position on overhead movements, jump landing",
        "Soccer":"single-leg stability, hip alignment",
        "Baseball":"rotational mechanics, shoulder/hip separation",
        "Archery":"stance, draw arm position, anchor point",
        "Olympic Weightlifting":"bar path, receiving position, overhead stability",
        "Running":"foot strike, hip extension, arm drive",
        "General Fitness":"joint alignment, bracing, range of motion"
      }[athlete.sport]||"joint alignment, bracing, form consistency";

      const formReply = await askClaude(
        `You are Coach Joe Thomas -- high school strength coach, 20+ years military S&C. You are reviewing video frames of ${athlete.name}'s workout (sport: ${athlete.sport}).
Analyze the form and give direct, specific coaching feedback. Focus on: ${sportFocus}.
Structure your response:
1. What I see (brief)
2. What's good
3. What to fix (specific cues, numbered)
Keep it under 250 words. No fluff. If you can't clearly see the movement, say so and describe what you can see.`,
        `Review these ${frames.length} frames from ${athlete.name}'s video.`,
        700,
        frames
      );

      setMessages(prev=>{
        const updated = [...prev];
        // Replace the placeholder "give me a sec" message
        updated[updated.length-1] = {role:"assistant",content:formReply};
        return updated;
      });

      // Save video review as a workout log entry
      await sbInsert("workouts",{
        athlete_id:athlete.id,
        raw_message:`[Video form review: ${file.name}]`,
        bot_reply:formReply,
        parsed_data:{exercises:[],pain_flags:[],equipment_issues:[],questions:[],session_feel:null,general_notes:"Video form review"}
      });
    } catch(e){
      setMessages(prev=>{
        const updated = [...prev];
        updated[updated.length-1] = {role:"assistant",content:`Couldn't analyze that video. ${e.message||"Make sure it's a standard video format (mp4, mov) and try again."}`};
        return updated;
      });
    }
    setVideoLoading(false);
  };

  const quick = ["No squat rack today","My knee is sore","I'm at the hotel gym","Can't do pull-ups","Bench alternative?","My program is..."];

  return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",background:C.navy,maxWidth:600,margin:"0 auto"}}>
      <style>{GS}</style>
      {/* Header */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2}}>COACH JOE-BOT</div>
          <div style={{color:C.muted,fontSize:11}}>{athlete.name} · {athlete.sport}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {saved&&<div style={{background:"#0a1e0a",border:`1px solid ${C.green}`,borderRadius:8,padding:"4px 10px",color:C.green,fontSize:11,fontWeight:600}}>Saved</div>}
          {athlete.program_text&&<div style={{background:"#0a0e1e",border:`1px solid ${C.blue}`,borderRadius:8,padding:"4px 10px",color:C.blue,fontSize:11}}>Program set</div>}
          <button onClick={onLogout} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Log Out</button>
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

      {/* Quick replies */}
      <div style={{padding:"0 16px 8px",display:"flex",gap:6,overflowX:"auto",flexShrink:0}}>
        {quick.map(p=>(
          <button key={p} onClick={()=>setInput(p)} style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:20,padding:"6px 12px",cursor:"pointer",fontSize:12,whiteSpace:"nowrap",flexShrink:0}}>{p}</button>
        ))}
      </div>

      {/* Input area */}
      <div style={{padding:"8px 16px 20px",flexShrink:0,borderTop:`1px solid ${C.border}`,background:C.navy2}}>
        <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
          {/* Video upload button */}
          <input ref={videoInputRef} type="file" accept="video/*" style={{display:"none"}} onChange={handleVideoUpload}/>
          <button
            onClick={()=>videoInputRef.current?.click()}
            disabled={loading||videoLoading||!historyLoaded}
            title="Upload video for form review"
            style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,width:44,height:44,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18,opacity:(loading||videoLoading)?0.4:1}}>
            🎬
          </button>
          <textarea value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder={`Tell Coach Joe about your workout, ${athlete.name}...`} rows={2}
            style={{flex:1,background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 14px",color:C.text,fontSize:14,outline:"none",resize:"none",lineHeight:1.5}}/>
          <button onClick={send} disabled={loading||videoLoading||!input.trim()||!historyLoaded}
            style={{background:C.gold,border:"none",borderRadius:12,width:44,height:44,cursor:(loading||!input.trim())?"not-allowed":"pointer",opacity:(loading||!input.trim())?0.5:1,fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,color:"#000",fontWeight:700}}>
            →
          </button>
        </div>
        <div style={{color:C.muted,fontSize:10,marginTop:6,textAlign:"center"}}>Type naturally to log workouts · 🎬 to upload a video for form review</div>
      </div>
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

  useEffect(()=>{loadAll();},[]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [a,w,p,c] = await Promise.all([
        sbGet("athletes","?order=created_at.desc&select=*"),
        sbGet("workouts","?order=created_at.desc&select=*"),
        sbGet("prs","?order=created_at.desc&select=*"),
        isMaster ? sbGet("coaches","?select=*") : Promise.resolve([])
      ]);
      let filteredAthletes = Array.isArray(a)?a:[];
      if(!isMaster&&coach.sports?.length>0){
        filteredAthletes = filteredAthletes.filter(at=>coach.sports.includes(at.sport));
      }
      setAthletes(filteredAthletes);
      const ids = filteredAthletes.map(at=>at.id);
      setWorkouts((Array.isArray(w)?w:[]).filter(wk=>ids.includes(wk.athlete_id)));
      setPrs((Array.isArray(p)?p:[]).filter(pr=>ids.includes(pr.athlete_id)));
      setAllCoaches(Array.isArray(c)?c:[]);
    } catch(e){console.error(e);}
    setLoading(false);
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
  });

  const tabs = ["athletes","stats",...(isMaster?["coaches"]:[])];

  return (
    <div style={{minHeight:"100vh",background:C.navy}}>
      <style>{GS}</style>
      {/* Header */}
      <div style={{background:C.navy2,borderBottom:`1px solid ${C.border}`,padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50}}>
        <div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:C.gold,letterSpacing:2}}>WILCO {isMaster?"— MASTER":"— COACH"} DASHBOARD</div>
          <div style={{color:C.muted,fontSize:11}}>{coach.name}{coach.sports&&!isMaster?` · ${coach.sports.join(", ")}`:""}</div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={loadAll} style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:12}}>↻ Refresh</button>
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

      <div style={{padding:20,maxWidth:1400,margin:"0 auto"}}>
        {loading?(
          <div style={{textAlign:"center",padding:60,color:C.muted}}>Loading...</div>
        ):(
          <>
            {/* ── ATHLETES TAB ── */}
            {activeTab==="athletes"&&(
              <div style={{display:"grid",gridTemplateColumns:selected?"300px 1fr":"1fr",gap:20,alignItems:"start"}}>
                {/* Left: Athlete List */}
                <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden",position:"sticky",top:90}}>
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
                    </div>
                  </div>
                  <div style={{maxHeight:"calc(100vh - 240px)",overflowY:"auto"}}>
                    {filtered.length===0?(
                      <div style={{padding:24,textAlign:"center",color:C.muted,fontSize:13}}>No athletes found</div>
                    ):filtered.map(a=>{
                      const la = lastActive(a.id);
                      const d = daysBetween(la);
                      const hasPain = workouts.filter(w=>w.athlete_id===a.id).some(w=>w.parsed_data?.pain_flags?.length>0);
                      const isSel = selected?.id===a.id;
                      const dot = d===null?C.muted:d===0?C.green:d<=3?C.green:d<=7?C.gold:C.red;
                      return (
                        <div key={a.id} onClick={()=>setSelected(isSel?null:a)}
                          style={{padding:"11px 14px",borderBottom:`1px solid ${C.border}`,cursor:"pointer",background:isSel?C.navy3:"transparent",transition:"background 0.15s",display:"flex",alignItems:"center",gap:10}}>
                          <div style={{width:34,height:34,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:15,color:"#000",flexShrink:0}}>{a.name[0].toUpperCase()}</div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{color:C.text,fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.name}</div>
                            <div style={{color:C.muted,fontSize:11}}>{a.sport} · {workouts.filter(w=>w.athlete_id===a.id).length} sessions</div>
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

                {/* Right: Athlete Detail */}
                {selected?(
                  <AthleteDetail
                    athlete={selected}
                    workouts={workouts.filter(w=>w.athlete_id===selected.id)}
                    prs={prs.filter(p=>p.athlete_id===selected.id)}
                    onProgramSave={async (text)=>{
                      await sbUpdate("athletes",selected.id,{program_text:text});
                      setAthletes(prev=>prev.map(a=>a.id===selected.id?{...a,program_text:text}:a));
                      setSelected(prev=>({...prev,program_text:text}));
                    }}
                  />
                ):(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:C.muted,fontSize:13,border:`1px dashed ${C.border}`,borderRadius:14}}>
                    Select an athlete to view details
                  </div>
                )}
              </div>
            )}

            {/* ── GROUP STATS TAB ── */}
            {activeTab==="stats"&&(
              <GroupStats athletes={athletes} workouts={workouts} prs={prs}/>
            )}

            {/* ── COACHES TAB (master only) ── */}
            {activeTab==="coaches"&&isMaster&&(
              <div style={{maxWidth:800}}>
                <div style={{marginBottom:16,color:C.muted2,fontSize:13,lineHeight:1.6,background:C.navy2,border:`1px solid ${C.border}`,borderRadius:12,padding:16}}>
                  To add a new coach: Supabase dashboard → Table Editor → coaches → Insert row.<br/>
                  Set name, email, sports (array e.g. {"{Football}"}), access_code, and role ("coach" or "master").
                </div>
                <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
                  <div style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>ALL COACHES</div>
                  {allCoaches.length===0?(
                    <div style={{padding:24,textAlign:"center",color:C.muted}}>No coaches yet</div>
                  ):allCoaches.map((c,i)=>(
                    <div key={i} style={{padding:"12px 16px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",gap:12}}>
                      <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:16,color:"#000",flexShrink:0}}>{c.name?.[0]?.toUpperCase()||"?"}</div>
                      <div style={{flex:1}}>
                        <div style={{color:C.text,fontWeight:600,fontSize:14}}>{c.name}</div>
                        <div style={{color:C.muted,fontSize:11}}>{c.role==="master"?"Master Access":c.sports?.join(", ")||"No sports assigned"}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{color:C.muted,fontSize:11}}>Code: {c.access_code}</div>
                        <div style={{color:c.pin?C.green:C.red,fontSize:10}}>{c.pin?"PIN set":"Not activated"}</div>
                      </div>
                    </div>
                  ))}
                </div>
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

  const weekWorkouts = workouts.filter(w=>new Date(w.created_at)>=weekAgo);
  const weekPRs = prs.filter(p=>new Date(p.created_at||0)>=weekAgo);
  const weekPain = weekWorkouts.filter(w=>w.parsed_data?.pain_flags?.length>0);

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
    dayCounts.push(workouts.filter(w=>{const wd=new Date(w.created_at);return wd>=d&&wd<next;}).length);
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
          {label:"Sessions This Week",val:weekWorkouts.length,color:C.green},
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
                  <span style={{color:C.muted}}> — {p.exercise} {p.weight}lbs</span>
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
          <div style={{color:C.muted2,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>ACTIVE ATHLETES BY SPORT</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {Object.entries(bySport).sort((a,b)=>b[1]-a[1]).map(([sport,count])=>(
              <div key={sport} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:8,padding:"6px 14px",display:"flex",gap:8,alignItems:"center"}}>
                <span style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:20}}>{count}</span>
                <span style={{color:C.muted2,fontSize:12}}>{sport}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ATHLETE DETAIL ───────────────────────────────────────────────────────────
function AthleteDetail({athlete, workouts, prs, onProgramSave}) {
  const [subTab,setSubTab] = useState("general");
  const [showCharts,setShowCharts] = useState(false);
  const [editingProgram,setEditingProgram] = useState(false);
  const [programText,setProgramText] = useState(athlete.program_text||"");
  const [savingProgram,setSavingProgram] = useState(false);
  const [programErr,setProgramErr] = useState("");

  const now = new Date();
  const weekAgo = new Date(now-7*24*60*60*1000);
  const weekWorkouts = workouts.filter(w=>new Date(w.created_at)>=weekAgo);

  // All pain flags across all sessions with dates
  const allPainFlags = workouts.flatMap(w=>
    (w.parsed_data?.pain_flags||[]).map(pf=>({...pf,date:w.created_at}))
  );

  // Progress chart data per lift (top 6 by frequency)
  const liftHistory = {};
  [...workouts].reverse().forEach(w=>{
    (w.parsed_data?.exercises||[]).forEach(ex=>{
      if(!ex.name||!ex.weight||ex.unit==="bodyweight") return;
      const k = ex.name.toLowerCase().trim();
      if(!liftHistory[k]) liftHistory[k]={name:ex.name,points:[]};
      liftHistory[k].points.push({date:w.created_at,weight:ex.weight});
    });
  });
  const topLifts = Object.values(liftHistory).sort((a,b)=>b.points.length-a.points.length).slice(0,6);

  // Workouts per week chart (last 8 weeks)
  const weeklyData = [];
  for(let i=7;i>=0;i--){
    const start = new Date(now); start.setDate(start.getDate()-i*7-daysBetween(now)%7); start.setHours(0,0,0,0);
    const end = new Date(start); end.setDate(end.getDate()+7);
    const count = workouts.filter(w=>{const d=new Date(w.created_at);return d>=start&&d<end;}).length;
    const label = `W${8-i}`;
    weeklyData.push({label,y:count});
  }

  const saveProgram = async () => {
    setSavingProgram(true); setProgramErr("");
    try {
      await onProgramSave(programText);
      setEditingProgram(false);
    } catch(e){
      setProgramErr("Save failed. Make sure the athletes table has a program_text column in Supabase.");
    }
    setSavingProgram(false);
  };

  return (
    <div>
      {/* Athlete header card */}
      <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:20,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,flexWrap:"wrap"}}>
          <div style={{width:52,height:52,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:24,color:"#000",flexShrink:0}}>{athlete.name[0].toUpperCase()}</div>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:C.text,letterSpacing:1}}>{athlete.name}</div>
            <div style={{color:C.muted,fontSize:12}}>{athlete.sport} · Joined {fmtDate(athlete.created_at)}</div>
            {athlete.season_date&&<div style={{color:C.gold,fontSize:11,marginTop:2}}>Season: {fmtDate(athlete.season_date)}</div>}
          </div>
          <a href={`mailto:joe.thomas@commandengineering.com?subject=Feedback for ${athlete.name}`}
            style={{background:C.gold,color:"#000",borderRadius:8,padding:"8px 14px",fontSize:12,fontWeight:700,textDecoration:"none",flexShrink:0}}>
            Email Coach Joe
          </a>
        </div>
        {/* Quick stats */}
        <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
          {[
            {l:"Total Sessions",v:workouts.length,c:C.gold},
            {l:"This Week",v:weekWorkouts.length,c:C.green},
            {l:"PRs Logged",v:prs.length,c:C.blue},
            {l:"Pain Flags",v:allPainFlags.length,c:allPainFlags.length>0?C.red:C.muted},
          ].map(s=>(
            <div key={s.l} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 14px",minWidth:90}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:s.c}}>{s.v}</div>
              <div style={{color:C.muted,fontSize:10}}>{s.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        {["general","chat","program"].map(t=>(
          <button key={t} onClick={()=>setSubTab(t)}
            style={{padding:"8px 18px",borderRadius:10,border:`1px solid ${subTab===t?C.gold:C.border}`,background:subTab===t?`${C.gold}15`:"transparent",color:subTab===t?C.gold:C.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"all 0.15s"}}>
            {t}
          </button>
        ))}
      </div>

      {/* ── GENERAL SUB-TAB ── */}
      {subTab==="general"&&(
        <div>
          {/* PRs */}
          {prs.length>0&&(
            <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16,marginBottom:16}}>
              <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:12}}>PERSONAL RECORDS</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:8}}>
                {prs.map((pr,i)=>(
                  <div key={i} style={{background:C.navy3,border:`1px solid ${C.gold}30`,borderRadius:10,padding:"10px 14px"}}>
                    <div style={{color:C.muted2,fontSize:11,marginBottom:2}}>{pr.exercise}</div>
                    <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:24}}>{pr.weight} lbs</div>
                    <div style={{color:C.muted,fontSize:10}}>{pr.reps} rep{pr.reps!==1?"s":""} · {pr.created_at?fmtDate(pr.created_at):"–"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pain flags */}
          {allPainFlags.length>0&&(
            <div style={{background:C.navy2,border:`1px solid ${C.red}40`,borderRadius:14,padding:16,marginBottom:16}}>
              <div style={{color:C.red,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>PAIN FLAGS</div>
              {allPainFlags.map((pf,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:`1px solid ${C.border}20`,fontSize:13}}>
                  <div>
                    <span style={{color:C.text,fontWeight:600}}>{pf.area}</span>
                    {pf.description&&<span style={{color:C.muted,marginLeft:8,fontSize:12}}>{pf.description}</span>}
                  </div>
                  <span style={{color:C.muted,fontSize:11,flexShrink:0,marginLeft:12}}>{fmtDate(pf.date)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Progress charts */}
          <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
            <button onClick={()=>setShowCharts(p=>!p)}
              style={{width:"100%",padding:"14px 16px",background:"none",border:"none",color:C.muted2,cursor:"pointer",fontSize:13,fontWeight:600,display:"flex",justifyContent:"space-between",alignItems:"center",fontFamily:"'DM Sans'"}}>
              <span style={{color:C.text}}>Progress Charts</span>
              <span style={{color:C.muted}}>{showCharts?"▲ Hide":"▼ Show"}</span>
            </button>
            {showCharts&&(
              <div style={{padding:"0 16px 16px"}}>
                {/* Workouts per week */}
                <div style={{marginBottom:20}}>
                  <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>WORKOUTS PER WEEK</div>
                  <LineChart data={weeklyData} color={C.green} unit=""/>
                </div>
                {/* Per-lift charts */}
                {topLifts.length===0?(
                  <div style={{color:C.muted,fontSize:12}}>No weighted exercise data yet.</div>
                ):topLifts.map(lift=>(
                  <div key={lift.name} style={{marginBottom:20}}>
                    <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>{lift.name.toUpperCase()} (lbs)</div>
                    <LineChart
                      data={lift.points.map(p=>({label:fmtDateShort(p.date),y:p.weight}))}
                      color={C.gold}
                      unit="lbs"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CHAT SUB-TAB ── */}
      {subTab==="chat"&&(
        <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
          {workouts.length===0?(
            <div style={{padding:24,textAlign:"center",color:C.muted}}>No sessions logged yet.</div>
          ):workouts.map((w,i)=>(
            <div key={i} style={{padding:16,borderBottom:`1px solid ${C.border}`}}>
              <div style={{color:C.muted,fontSize:10,letterSpacing:1,marginBottom:10}}>{new Date(w.created_at).toLocaleString()}</div>
              <div style={{display:"flex",justifyContent:"flex-end",marginBottom:8}}>
                <div style={{maxWidth:"85%",background:C.gold,borderRadius:"12px 12px 4px 12px",padding:"10px 14px",fontSize:13,color:"#000",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.raw_message}</div>
              </div>
              {w.bot_reply&&(
                <div style={{display:"flex",gap:8,marginBottom:8,alignItems:"flex-start"}}>
                  <div style={{width:26,height:26,borderRadius:"50%",background:`linear-gradient(135deg,${C.gold},#8a6000)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#000",flexShrink:0}}>J</div>
                  <div style={{maxWidth:"85%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:"12px 12px 12px 4px",padding:"10px 14px",fontSize:13,color:C.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.bot_reply}</div>
                </div>
              )}
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:4}}>
                {w.parsed_data?.exercises?.map((ex,j)=>(
                  <div key={j} style={{background:"#0a1e14",border:`1px solid ${C.green}30`,borderRadius:6,padding:"2px 8px",fontSize:11,color:C.green}}>
                    {ex.name}{ex.weight?` ${ex.weight}lbs`:""}{ex.sets&&ex.reps?` ${ex.sets}x${ex.reps}`:""}
                  </div>
                ))}
                {w.parsed_data?.pain_flags?.map((pf,j)=>(
                  <div key={j} style={{background:"#1e0a0a",border:`1px solid ${C.red}30`,borderRadius:6,padding:"2px 8px",fontSize:11,color:C.red}}>pain: {pf.area}</div>
                ))}
                {w.parsed_data?.questions?.map((q,j)=>(
                  <div key={j} style={{background:"#0a0e1e",border:`1px solid ${C.blue}30`,borderRadius:6,padding:"2px 8px",fontSize:11,color:C.blue}}>Q: {q.length>50?q.slice(0,50)+"...":q}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── PROGRAM SUB-TAB ── */}
      {subTab==="program"&&(
        <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:20}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <div style={{color:C.gold,fontSize:11,letterSpacing:1,fontWeight:700}}>CURRENT PROGRAM</div>
            {!editingProgram&&(
              <button onClick={()=>{setEditingProgram(true);setProgramText(athlete.program_text||"");}}
                style={{background:C.navy3,border:`1px solid ${C.border}`,color:C.muted2,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans'"}}>
                {athlete.program_text?"Edit Program":"Add Program"}
              </button>
            )}
          </div>

          {editingProgram?(
            <>
              <div style={{color:C.muted2,fontSize:12,marginBottom:10,lineHeight:1.6}}>
                Write or paste the athlete's program here. This will be referenced by Joe-bot in every conversation.
                <br/><span style={{color:C.gold,fontSize:11}}>Note: requires a <code>program_text</code> column in your Supabase athletes table.</span>
              </div>
              <textarea
                value={programText}
                onChange={e=>setProgramText(e.target.value)}
                rows={12}
                placeholder="e.g. Monday: Squat 5x5, Bench 4x8, Row 4x10&#10;Wednesday: Deadlift 3x5, Press 4x8&#10;Friday: Squat 4x4, Bench 5x5, Chin-ups 4x8"
                style={{...inp(),resize:"vertical",lineHeight:1.6,fontSize:13}}/>
              {programErr&&<div style={{color:C.red,fontSize:12,marginTop:8}}>{programErr}</div>}
              <div style={{display:"flex",gap:8,marginTop:12}}>
                <button onClick={saveProgram} disabled={savingProgram}
                  style={{flex:1,background:C.gold,color:"#000",border:"none",borderRadius:10,padding:"11px",fontWeight:700,fontSize:14,cursor:"pointer",fontFamily:"'Bebas Neue'",letterSpacing:1,opacity:savingProgram?0.7:1}}>
                  {savingProgram?"Saving...":"Save Program"}
                </button>
                <button onClick={()=>setEditingProgram(false)}
                  style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:10,padding:"11px 18px",cursor:"pointer",fontSize:13,fontFamily:"'DM Sans'"}}>
                  Cancel
                </button>
              </div>
            </>
          ):(
            athlete.program_text?(
              <pre style={{color:C.text,fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:16}}>{athlete.program_text}</pre>
            ):(
              <div style={{color:C.muted,fontSize:13,textAlign:"center",padding:32,background:C.navy3,borderRadius:10,lineHeight:1.7}}>
                No program set yet.<br/>
                <span style={{fontSize:12}}>Athletes can say "my program is..." in chat, or you can add it directly above.</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
