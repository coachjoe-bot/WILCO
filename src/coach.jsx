// ─── COACH DASHBOARD (lazy-loaded chunk) ─────────────────────────────────────
// Split out of App.jsx so athletes (95% of users) never download the coach UI.
// Loaded via React.lazy from WilcoRoot; shares App.jsx helpers (incl. the module-
// level CURRENT_AUTH session inside the sb*/idApi/askClaude helpers) by import —
// the dynamic import means the cycle App→coach→App is resolved at load time.
import { useState, useEffect, useRef, useMemo } from "react";
import {
  CA, CA_BTN, CA_GLOW, GS, LineChart, MASTER_CODE, RunCard, SUPABASE_KEY, SUPABASE_URL, askClaude, bestE1RMForExercise, btn, cleanerName, daysBetween, disablePush, displayForKey, enablePush, epley1RM, fmtDate, fmtDateRelative, fmtDateShort, fmtWeight, formatSetDetails, getAuth, getExerciseSets, getPushSubscription, groupIntoSessions, haptic, idApi, inpA, isRealSession, liftTier, normalizeExName, sbDelete, sbInsert, sbRead, sbUpdate, sbUpdateWhere, sbUpsert, toLbs, track, useIsMobile
} from "./App.jsx";
// Shared deterministic engine (Phase 0 extraction) — per-athlete session/adherence
// math, computed live client-side for the Overview. Aliased to avoid colliding with
// App.jsx's multi-athlete groupIntoSessions already imported above.
import {
  groupIntoSessions as pcGroup, compareProgramVsActual, buildOneRMs, aggregateInjuries, totalSetVolume,
  trueImprovementPRs, classifyTiers, blendAdherenceScore, adherenceBreakdown, buildLiftHistory,
} from "./proofcore.js";
import { computeGritSnapshot, TIER_NAMES, TIER_COLORS, getBenchKey, resolveLift } from "./grit.js";
// The Morning Brief — deterministic conversational beats (zero tokens to build;
// Haiku only reacts when the coach free-types). See coach-dashboard-v2-spec §C.
import { buildMorningBrief, decisionNote, briefWeekKey } from "./coachBrief.js";

// ─── ON-DEMAND PROGRAM PARSE ──────────────────────────────────────────────────
// The proof cron parses programs only on each athlete's weekly run, so a program
// assigned or edited mid-week has no structured prescription for days — and the
// Overview adherence math (and day inspector) grades against nothing. The coach
// dashboard closes that gap: any roster program that's missing or stale
// (source_hash mismatch) is parsed right here (Haiku, hash-guarded, ≤4/load) and
// upserted through the gateway. KEEP THE PROMPT VERBATIM-IN-SYNC with
// parseProgramIfNeeded in api/_proof.js so both paths cache identical shapes.
const PARSE_SYSTEM = `You convert a strength athlete's written training program into STRICT JSON. No prose, no markdown — JSON only. Shape:
{"blocks":[{"name":string,"weeks":number,"start":string|null,"days":[{"day":string,"label":string,"exercises":[{"name":string,"sets":number,"reps":number,"pct_by_week":number[],"ref_1rm_lift":string|null}]}]}],"ref_1rms":{}}
Rules: sets/reps are the prescribed working sets per session. pct_by_week is %1RM per week of the block (empty array if the program gives no percentages). ref_1rm_lift is which max the % is of (usually the lift itself). If the program has no blocks/weeks, use one block with weeks=1. Extract every exercise you can. Leave ref_1rms as {} (filled later from real data).`;
const sha256hex = async (text)=>{
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text||"")));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
};
// Parse one program text → prescription row, cache via gateway. Returns the row or
// null. maxTokens 4000 (api/claude.js's clamp), NOT 1500 — long multi-week programs
// overflow 1500 mid-JSON and silently never parse (proven in prod: 12 straight
// calls truncated at exactly the old cap). Shared by the dashboard-load backfill
// AND parse-at-save, so a program is gradeable the moment it's assigned.
const parseAndCacheProgram = async (athleteId, programText)=>{
  const text = String(programText||"");
  if(text.trim().length<20) return null;
  const raw = await askClaude(PARSE_SYSTEM, `Program:\n${text.slice(0,6000)}`, 4000, [], "claude-haiku-4-5", "program_parse");
  const parsed = JSON.parse(String(raw).replace(/```json|```/g,"").trim());
  if(!parsed||!Array.isArray(parsed.blocks)) throw new Error("no blocks in parse");
  const row = {athlete_id:athleteId, source_hash:await sha256hex(text), parsed_json:parsed, updated_at:new Date().toISOString()};
  await sbUpsert("program_prescriptions", row, "athlete_id");
  return row;
};

// ─── GSC — coach "control room" motion skin ──────────────────────────────────
// The coach dashboard is the CONTROL ROOM to the athlete's gym floor: denser,
// calmer, more mono, LESS motion. All keyframe names are NEW (c-prefixed) so they
// never collide with GS (mounted alongside). Every effect runs on transform/opacity
// only; elements are styled to their FINAL state, so reduced-motion (and any
// stutter) degrades to the static end state. Entrance animations ONLY — no loops
// except a single small pulsing LIVE dot.
const GSC = `
body{background:${CA.navy};}
/* calmer grid than the athlete .cyber (.04 @ 28px vs .07 @ 22px) */
.cyber-coach{background:#05060c;background-image:linear-gradient(rgba(58,123,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(58,123,255,.04) 1px,transparent 1px);background-size:28px 28px;}
/* card / chart entrance rise */
@keyframes cUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
.c-up{animation:cUp .5s cubic-bezier(.2,.7,.2,1) both;}
/* bar rise from baseline (staggered via --d inline) */
@keyframes cRise{from{transform:scaleY(0);}to{transform:scaleY(1);}}
.c-rise{transform-origin:bottom;animation:cRise .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:var(--d,0s);}
/* line-chart draw-in (stroke reveals left-to-right) */
@keyframes cDraw{from{stroke-dashoffset:1000;}to{stroke-dashoffset:0;}}
.c-draw,.a-draw{stroke-dasharray:1000;animation:cDraw 1.05s ease-out forwards;}
/* dot / cell fade after the line (staggered via --d inline) */
@keyframes cFade{from{opacity:0;}to{opacity:1;}}
.c-fade{opacity:0;animation:cFade .4s ease forwards;animation-delay:var(--d,0s);}
/* split-flap headline flip-in (copy of athlete aFlap) */
@keyframes cFlap{0%{transform:rotateX(-90deg);opacity:0;}60%{transform:rotateX(8deg);opacity:1;}100%{transform:rotateX(0);opacity:1;}}
.c-flap{display:inline-block;transform-origin:top;backface-visibility:hidden;animation:cFlap .5s ease both;}
/* faint cyan scanline overlay (edition page) */
.coach-scan::after{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,transparent 0 3px,rgba(55,230,255,.028) 3px 4px);z-index:8;}
/* POWER CELL — the athlete benchmark battery tube, verbatim (GSA .htube/.hfill),
   so team benchmarks read identically to the athlete Progress screen */
.htube{height:20px;border:1.5px solid ${CA.line2};border-radius:6px;position:relative;overflow:hidden;background:linear-gradient(180deg,#070d18,#05080f);}
.htube::after{content:"";position:absolute;right:-4px;top:50%;transform:translateY(-50%);width:4px;height:9px;border-radius:2px;background:${CA.line2};}
.hfill{position:absolute;left:0;top:0;bottom:0;width:100%;transform:scaleX(0);transform-origin:left;background:linear-gradient(90deg,color-mix(in srgb,var(--tc) 62%,#000),var(--tc));box-shadow:0 0 calc(8px + var(--tb,0)*22px) var(--tc);filter:brightness(calc(1 + var(--tb,0)*0.9)) saturate(calc(1 + var(--tb,0)*0.4));transition:transform 1.05s cubic-bezier(.3,.8,.3,1);}
.hfill::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(0,0,0,.28) 0 13px,transparent 13px 16px);opacity:.45;}
.hcell.go .hfill{transform:scaleX(var(--pct,0));}
/* the one allowed loop: a small pulsing LIVE dot */
@keyframes cLive{0%,100%{opacity:1;box-shadow:0 0 6px ${CA.cyan};}50%{opacity:.35;box-shadow:0 0 2px ${CA.cyan};}}
.c-live{animation:cLive 1.8s ease-in-out infinite;}
@media (prefers-reduced-motion: reduce){
  .c-up,.c-rise,.c-draw,.a-draw,.c-fade,.c-flap,.c-live{animation:none!important;transform:none!important;opacity:1!important;}
  .hcell.go .hfill{transform:scaleX(var(--pct,0))!important;}
  .c-draw,.a-draw{stroke-dasharray:none!important;}
}
`;

// Count a KPI figure up from 0 on mount (~700ms), respecting reduced-motion by
// jumping straight to the final value. Self-contained (rAF, no deps). Returns the
// current display value; pass the resolved numeric target.
function useCountUp(target, ms=700){
  const [v,setV] = useState(0);
  useEffect(()=>{
    const end = Number(target)||0;
    if(typeof window!=="undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches){ setV(end); return; }
    let raf, start;
    const step = (t)=>{ if(start==null) start=t; const p=Math.min(1,(t-start)/ms); setV(end*(1-Math.pow(1-p,3))); if(p<1) raf=requestAnimationFrame(step); else setV(end); };
    raf=requestAnimationFrame(step);
    return ()=>cancelAnimationFrame(raf);
  },[target,ms]);
  return v;
}

// Pixel-space SVG chart container. The Overview charts used a fixed 300-unit
// viewBox stretched with preserveAspectRatio="none", which deformed circles into
// ovals and inflated bar widths. This measures the real width (ResizeObserver)
// and hands it to the render function, so shapes keep their true proportions.
function ChartBox({h, children}){
  const ref = useRef(null);
  const [w,setW] = useState(0);
  useEffect(()=>{
    const el = ref.current; if(!el) return;
    const m = ()=>setW(el.clientWidth);
    m();
    const ro = new ResizeObserver(m); ro.observe(el);
    return ()=>ro.disconnect();
  },[]);
  return (
    <div ref={ref} style={{width:"100%"}}>
      {w>0 && <svg viewBox={`0 0 ${w} ${h}`} style={{width:"100%",height:h,overflow:"visible",display:"block"}}>{children(w)}</svg>}
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
        body:JSON.stringify({auth:getAuth(),coachName:newCoachName.trim(),coachEmail:newCoachEmail.trim().toLowerCase(),accessCode,schoolName:school.name})
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
        await sbUpdateWhere("athletes",`?coach_id=eq.${c.id}`,{coach_id:null,school_id:null});
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
    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,overflow:"hidden",marginBottom:16}}>
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${CA.border}`,color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>SCHOOLS / TEAMS</div>
      {schools.map((s,i)=>{
        const coachCount = coachCountFor(s.id);
        const hasOpenSlot = coachCount < (s.max_coaches||3);
        const isAddingHere = addingCoachFor===s.id;
        return (
          <div key={i}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${CA.border}`,display:"flex",alignItems:"center",gap:12}}>
              {s.logo_url
                ? <img src={s.logo_url} alt={s.name} style={{width:36,height:36,borderRadius:6,objectFit:"contain",background:"rgba(220,232,255,.92)",padding:2,flexShrink:0}}/>
                : <div style={{width:36,height:36,borderRadius:6,background:CA.navy3,border:`1px solid ${CA.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:16,color:CA.accent,flexShrink:0}}>{s.code}</div>
              }
              <div style={{flex:1}}>
                <div style={{color:CA.text,fontWeight:600,fontSize:14}}>{s.name}</div>
                <div style={{color:CA.muted,fontSize:11}}>
                  Code: <span style={{color:CA.accent,fontWeight:700}}>{s.code}</span> · {coachCount}/{s.max_coaches||3} coach{coachCount!==1?"es":""} · {s.tier} tier
                  {hasOpenSlot&&<span style={{color:CA.green,marginLeft:6}}>· {(s.max_coaches||3)-coachCount} slot{(s.max_coaches||3)-coachCount!==1?"s":""} open</span>}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                {hasOpenSlot&&!isAddingHere&&confirmDelete!==s.id&&(
                  <button onClick={()=>openAddCoach(s.id)}
                    style={{background:"none",border:`1px solid ${CA.accent}66`,color:CA.accent,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11}}>
                    + Add Coach
                  </button>
                )}
                {confirmDelete===s.id ? (
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{color:CA.muted,fontSize:11}}>Remove school + coaches?</span>
                    <button onClick={()=>handleDelete(s)} disabled={deleting}
                      style={{background:CA.red,border:"none",color:"#fff",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11,fontWeight:700}}>
                      {deleting?"...":"Yes, delete"}
                    </button>
                    <button onClick={()=>setConfirmDelete(null)}
                      style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11}}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button onClick={()=>setConfirmDelete(s.id)}
                    style={{background:"none",border:`1px solid ${CA.red}44`,color:CA.red,borderRadius:6,padding:"5px 10px",cursor:"pointer",fontSize:11,flexShrink:0}}>
                    Remove
                  </button>
                )}
              </div>
            </div>
            {/* Add Coach inline form */}
            {isAddingHere&&(
              <div style={{padding:"14px 16px",background:CA.navy3,borderBottom:`1px solid ${CA.border}`}}>
                <div style={{color:CA.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>
                  ADD COACH TO {s.name.toUpperCase()} — code will be <span style={{color:CA.accent,fontWeight:700}}>{s.code}{String((coaches.filter(c=>c.school_id===s.id).reduce((m,c)=>Math.max(m,c.coach_number||0),0))+1).padStart(2,"0")}</span>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <input value={newCoachName} onChange={e=>setNewCoachName(e.target.value)} placeholder="Coach name" style={inpA()}/>
                  <input type="email" value={newCoachEmail} onChange={e=>setNewCoachEmail(e.target.value)} placeholder="coach@school.edu" style={inpA()}/>
                </div>
                {addCoachErr&&<div style={{color:CA.red,fontSize:12,marginBottom:8}}>{addCoachErr}</div>}
                {addCoachSuccess&&<div style={{color:CA.green,fontSize:12,marginBottom:8,fontWeight:600}}>{addCoachSuccess}</div>}
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>handleAddCoach(s)} disabled={addingCoach}
                    style={{background:CA_BTN,boxShadow:"0 4px 16px "+CA_GLOW,border:"none",color:"#fff",borderRadius:6,padding:"7px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>
                    {addingCoach?"Adding...":"Add & Send Invite →"}
                  </button>
                  <button onClick={cancelAddCoach}
                    style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"7px 12px",cursor:"pointer",fontSize:12}}>
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
        body:JSON.stringify({auth:getAuth(),coachName:c.name,coachEmail:c.email,accessCode:c.access_code,schoolName:school?.name||""})
      });
      setResendStatus(p=>({...p,[c.id]:"sent"}));
      setTimeout(()=>setResendStatus(p=>({...p,[c.id]:null})),3000);
    } catch(e){ setResendStatus(p=>({...p,[c.id]:"error"})); }
  };

  const handleDelete = async (c) => {
    setDeleting(true);
    try {
      // Clear coach_id on their athletes
      await sbUpdateWhere("athletes",`?coach_id=eq.${c.id}`,{coach_id:null,school_id:null});
      await sbDelete("coaches",`?id=eq.${c.id}`);
      setConfirmDelete(null);
      onRefresh();
    } catch(e){console.error(e);}
    setDeleting(false);
  };

  const nonMasterCoaches = coaches.filter(c=>c.role!=="master");
  if(nonMasterCoaches.length===0) return null;

  return (
    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,overflow:"hidden",marginBottom:16}}>
      <div style={{padding:"12px 16px",borderBottom:`1px solid ${CA.border}`,color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>ALL COACHES</div>
      {nonMasterCoaches.map((c,i)=>{
        const school = schoolFor(c.school_id);
        const isEditing = editingId===c.id;
        const rs = resendStatus[c.id];
        return (
          <div key={i} style={{borderBottom:`1px solid ${CA.border}`}}>
            {isEditing ? (
              <div style={{padding:"12px 16px",background:CA.navy3}}>
                <div style={{color:CA.muted,fontSize:11,letterSpacing:1,marginBottom:8}}>EDIT COACH — <span style={{color:CA.accent}}>{c.access_code}</span></div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                  <input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="Coach name" style={inpA()}/>
                  <input type="email" value={editEmail} onChange={e=>setEditEmail(e.target.value)} placeholder="Email" style={inpA()}/>
                </div>
                <div style={{color:CA.muted,fontSize:11,marginBottom:10}}>Saving will reset their PIN so the new coach can register fresh.</div>
                <div style={{display:"flex",gap:8}}>
                  <button onClick={()=>saveEdit(c)} disabled={saving} style={{background:CA_BTN,boxShadow:"0 4px 16px "+CA_GLOW,border:"none",color:"#fff",borderRadius:6,padding:"7px 16px",cursor:"pointer",fontSize:12,fontWeight:700}}>
                    {saving?"Saving...":"Save"}
                  </button>
                  <button onClick={cancelEdit} style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"7px 12px",cursor:"pointer",fontSize:12}}>Cancel</button>
                </div>
              </div>
            ) : (
              <div style={{padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:36,height:36,borderRadius:"50%",background:`linear-gradient(135deg,#57a0ff,#2a63e6)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:16,color:"#fff",flexShrink:0}}>{c.name?.[0]?.toUpperCase()||"?"}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{color:CA.text,fontWeight:600,fontSize:14}}>{c.name}</div>
                  <div style={{color:CA.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    <span style={{color:CA.accent,fontWeight:700}}>{c.access_code}</span>
                    {school?` · ${school.name}`:""}
                    {c.email?` · ${c.email}`:""}
                  </div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                  <div style={{color:c.pin?CA.green:CA.red,fontSize:10,marginRight:4}}>{c.pin?"✓ Active":"Not set up"}</div>
                  {/* Resend invite */}
                  {c.email&&c.role!=="master"&&(
                    <button onClick={()=>resendInvite(c)} disabled={!!rs}
                      style={{background:"none",border:`1px solid ${CA.border}`,color:rs==="sent"?CA.green:CA.muted2,borderRadius:6,padding:"4px 8px",cursor:rs?"default":"pointer",fontSize:10}}>
                      {rs==="sending"?"...":rs==="sent"?"✓ Sent":rs==="error"?"Error":"Resend"}
                    </button>
                  )}
                  {/* Edit */}
                  {confirmDelete!==c.id&&(
                    <button onClick={()=>startEdit(c)}
                      style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted2,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
                      Replace
                    </button>
                  )}
                  {/* Delete */}
                  {confirmDelete===c.id ? (
                    <>
                      <button onClick={()=>handleDelete(c)} disabled={deleting}
                        style={{background:CA.red,border:"none",color:"#fff",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:10,fontWeight:700}}>
                        {deleting?"...":"Confirm"}
                      </button>
                      <button onClick={()=>setConfirmDelete(null)}
                        style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={()=>setConfirmDelete(c.id)}
                      style={{background:"none",border:`1px solid ${CA.red}44`,color:CA.red,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:10}}>
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
            body:JSON.stringify({auth:getAuth(),coachName:c.name.trim(),coachEmail:c.email.trim().toLowerCase(),accessCode,schoolName:schoolName.trim()})
          }).catch(()=>{});
        }
      }
      // Create admin account for contact email
      if(contactEmail.trim()){
        const adminCode=schoolCode.toUpperCase()+"AD";
        try {
          const adminRow=await sbInsert("coaches",{name:"Admin",email:contactEmail.trim().toLowerCase(),school_id:school.id,coach_number:0,access_code:adminCode,role:"admin"});
          if(adminRow?.length){
            fetch("/api/send-coach-invite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({auth:getAuth(),coachName:"Admin",coachEmail:contactEmail.trim().toLowerCase(),accessCode:adminCode,schoolName:schoolName.trim(),isAdmin:true})}).catch(()=>{});
          }
        }catch(_){}
      }
      setSuccess(`✓ ${schoolName} onboarded! ${created} coach invite${created!==1?"s":""} sent.`);
      setSchoolName(""); setSchoolCode(""); setContactEmail(""); setLogoFile(null); setLogoPreview(null);
      setCoaches([{name:"",email:""},{name:"",email:""},{name:"",email:""}]); setMaxCoaches(3);
      if(onCreated) onCreated();
    } catch(e){ setErr(e.message||"Something went wrong."); }
    setSaving(false);
  };

  return (
    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:20,marginBottom:16}}>
      <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:16}}>ONBOARD NEW SCHOOL / TEAM</div>

      {/* Row 1: name + code */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 90px",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>SCHOOL / TEAM NAME</label>
          <input value={schoolName} onChange={e=>setSchoolName(e.target.value)} placeholder="Lincoln High School" style={inpA()}/>
        </div>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CODE</label>
          <input value={schoolCode} onChange={e=>setSchoolCode(e.target.value.toUpperCase().replace(/[^A-Z]/g,"").slice(0,3))}
            placeholder="LHS" style={inpA({textAlign:"center",letterSpacing:4,fontWeight:700,textTransform:"uppercase"})}/>
        </div>
      </div>

      {/* Row 2: contact email + tier */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>CONTACT EMAIL</label>
          <input type="email" value={contactEmail} onChange={e=>setContactEmail(e.target.value)} placeholder="ad@school.edu" style={inpA()}/>
        </div>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>TIER</label>
          <select value={tier} onChange={e=>setTier(e.target.value)} style={{...inpA(),cursor:"pointer"}}>
            <option value="group">Group</option>
            <option value="school">School</option>
            <option value="district">District</option>
          </select>
        </div>
      </div>

      {/* Row 3: max coaches + max athletes */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>MAX COACHES</label>
          <select value={maxCoaches} onChange={e=>updateMaxCoaches(Number(e.target.value))} style={{...inpA(),cursor:"pointer"}}>
            {[1,2,3,4,5,6,7,8,9,10].map(n=><option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>MAX ATHLETES</label>
          <input type="number" value={maxAthletes} min={1} onChange={e=>setMaxAthletes(Number(e.target.value))} style={inpA()}/>
        </div>
      </div>

      {/* Logo upload */}
      <div style={{marginBottom:16}}>
        <label style={{color:CA.muted,fontSize:11,letterSpacing:1,display:"block",marginBottom:6}}>SCHOOL LOGO <span style={{color:CA.muted,fontWeight:400,letterSpacing:0}}>(optional — PNG, SVG, or JPG)</span></label>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {logoPreview&&<img src={logoPreview} alt="Preview" style={{width:40,height:40,borderRadius:8,objectFit:"contain",background:"rgba(220,232,255,.92)",padding:3}}/>}
          <label style={{background:CA.navy3,border:`1px dashed ${CA.border}`,borderRadius:8,padding:"8px 14px",cursor:"pointer",color:CA.muted2,fontSize:12,display:"inline-block"}}>
            {logoFile?logoFile.name:"Upload logo"}
            <input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={handleLogoChange} style={{display:"none"}}/>
          </label>
        </div>
      </div>

      {/* Coach slots */}
      <div style={{marginBottom:16}}>
        <div style={{color:CA.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>
          COACHES — codes: <span style={{color:CA.accent,fontWeight:700}}>{schoolCode||"???"}01</span>, <span style={{color:CA.accent,fontWeight:700}}>{schoolCode||"???"}02</span>…
        </div>
        {coaches.slice(0,maxCoaches).map((c,i)=>(
          <div key={i} style={{display:"grid",gridTemplateColumns:"56px 1fr 1fr",gap:8,marginBottom:8,alignItems:"center"}}>
            <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:6,padding:"7px 4px",fontSize:11,fontWeight:700,color:CA.accent,letterSpacing:1,fontFamily:"'Bebas Neue'",textAlign:"center"}}>
              {(schoolCode||"???")+String(i+1).padStart(2,"0")}
            </div>
            <input value={c.name} onChange={e=>updateCoach(i,"name",e.target.value)} placeholder={`Coach ${i+1} name`} style={inpA()}/>
            <input type="email" value={c.email} onChange={e=>updateCoach(i,"email",e.target.value)} placeholder="email@school.edu" style={inpA()}/>
          </div>
        ))}
      </div>

      {err&&<div style={{color:CA.red,fontSize:12,marginBottom:12}}>{err}</div>}
      {success&&<div style={{color:CA.green,fontSize:13,marginBottom:12,fontWeight:600}}>{success}</div>}
      <button onClick={handleSubmit} disabled={saving} style={btn(CA_BTN,"#fff",{opacity:saving?0.7:1,boxShadow:`0 6px 18px ${CA_GLOW}`})}>
        {saving?"Creating school...":"Create School & Send Coach Invites →"}
      </button>
    </div>
  );
}

// Fetch a scoped table through the gateway in bounded PAGES rather than one giant
// request. This replaces the coach dashboard's fixed-cap / uncapped pulls, which
// had two problems at scale: a single `limit=5000` query silently DROPPED the
// oldest history past 5000 (so all-time session counts would under-count), and
// PostgREST's own server-side max-rows (typically 1000) meant a large `limit` was
// quietly truncated anyway. Paging with a stable (created_at,id) sort returns the
// full scoped set correctly, one small request at a time, up to a hard ceiling we
// log if ever hit (the signal to move the roster list to true server aggregation).
// Ownership scoping is still forced server-side (api/data.js read op) — unchanged.
const COACH_PAGE = 1000;              // rows per request (aligns with PostgREST max)
const COACH_MAX_ROWS = 50000;         // safety ceiling across all pages
async function sbReadPaged(table, order = "created_at.desc") {
  const rows = [];
  for (let offset = 0; offset < COACH_MAX_ROWS; offset += COACH_PAGE) {
    const page = await sbRead(table, `?select=*&order=${order},id.desc&limit=${COACH_PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < COACH_PAGE) break;   // short page => last page
    if (offset + COACH_PAGE >= COACH_MAX_ROWS) {
      console.warn(`[coach] ${table} hit the ${COACH_MAX_ROWS}-row page ceiling — move this read to server-side aggregation`);
    }
  }
  return rows;
}

// ─── COACH DASHBOARD ──────────────────────────────────────────────────────────
function CoachDashboard({coach,onLogout}) {
  // isMobile (<640) = phone layout; isNarrow (<900) = too tight for list+detail side-by-side

  const isMaster = coach.role==="master"||coach.access_code===MASTER_CODE;
  const isAdmin = coach.role==="admin";
  const [athletes,setAthletes] = useState([]);
  const [workouts,setWorkouts] = useState([]);
  const [prs,setPrs] = useState([]);
  const [allCoaches,setAllCoaches] = useState([]);
  const [loading,setLoading] = useState(true);
  const [activeTab,setActiveTab] = useState("overview"); // graphs-first home (coach-experience-vision §1)
  const [selected,setSelected] = useState(null);
  const [search,setSearch] = useState("");
  const [filterPain,setFilterPain] = useState(false);
  const [filterInactive,setFilterInactive] = useState(false);
  const [sortBy,setSortBy] = useState("lastActive"); // "lastActive" | "name"
  const [recalcStatus,setRecalcStatus] = useState(null); // null | "running" | "done" | "error" | "X/Y
  const [allDigests,setAllDigests] = useState([]);
  const [manualRMs,setManualRMs] = useState([]);        // manual_one_rms — Grit + adherence-load
  const [prescriptions,setPrescriptions] = useState([]); // program_prescriptions (parsed programs) — Overview adherence
  const [changeRequests,setChangeRequests] = useState([]); // program_change_requests — locked-program inbox
  const [briefContext,setBriefContext] = useState([]);     // coach_context — Morning Brief suppression + notes
  const [programPrefill,setProgramPrefill] = useState(null); // {athleteId, note} — brief "Draft the change" deep-link
  const [parsingIds,setParsingIds] = useState(()=>new Set()); // programs being parsed on demand right now
  const parseAttempted = useRef(new Set());                 // one attempt per athlete per session
  const [notifPrefs,setNotifPrefs] = useState(coach.notification_prefs||{injury:true,big_pr:true,inactive:true,digest:true});
  const [pushOn,setPushOn] = useState(false);
  const [pushBusy,setPushBusy] = useState(false);
  useEffect(()=>{ (async()=>{ try{ setPushOn(!!(await getPushSubscription())); }catch{} })(); },[]);
  const savePref = async (key,val)=>{ const next={...notifPrefs,[key]:val}; setNotifPrefs(next); try{ await sbUpdate("coaches",coach.id,{notification_prefs:next}); }catch(e){ console.error("pref save",e); } };
  const togglePush = async ()=>{ setPushBusy(true); try{ if(pushOn){ await disablePush(); setPushOn(false); } else { await enablePush(); setPushOn(true); } }catch(e){ console.error("push toggle",e); } setPushBusy(false); };
  const [reportFilter,setReportFilter] = useState("all"); // "all" | "weekly" | "monthly"
  const [reportSearch,setReportSearch] = useState("");
  const [reportFlagFilter,setReportFlagFilter] = useState(false);
  const [selectedDigest,setSelectedDigest] = useState(null);
  useEffect(()=>{ track("coach_dashboard_view","coach_dashboard"); },[]);

  // On-demand program parse (see PARSE_SYSTEM note at top of file): fill missing/
  // stale prescription rows for this roster so adherence grades against something
  // TODAY, not after the athlete's next weekly proof run. Hash-guarded (no repeat
  // AI calls for unchanged text), ≤4 programs per dashboard load, one attempt per
  // athlete per session (failures don't loop).
  useEffect(()=>{
    if(loading||!athletes.length) return;
    let cancelled=false;
    (async()=>{
      const byId={}; prescriptions.forEach(p=>{byId[p.athlete_id]=p;});
      const targets=[];
      for(const a of athletes){
        if(!a.program_text||a.program_text.trim().length<20) continue;
        if(parseAttempted.current.has(a.id)) continue;
        const row=byId[a.id];
        if(row&&row.parsed_json){ const h=await sha256hex(a.program_text); if(row.source_hash===h) continue; }
        targets.push(a);
        if(targets.length>=4) break;
      }
      if(!targets.length||cancelled) return;
      targets.forEach(a=>parseAttempted.current.add(a.id));
      setParsingIds(new Set(targets.map(t=>t.id)));
      for(const a of targets){
        if(cancelled) break;
        try{
          const rowNew = await parseAndCacheProgram(a.id, a.program_text);
          if(rowNew&&!cancelled) setPrescriptions(prev=>[...prev.filter(p=>p.athlete_id!==a.id), rowNew]);
        }catch(e){ console.error("on-demand program parse failed",a.name,e); }
        if(!cancelled) setParsingIds(prev=>{const s=new Set(prev); s.delete(a.id); return s;});
      }
    })();
    return ()=>{cancelled=true;};
  },[loading,athletes,prescriptions]);
  const isMobile = useIsMobile();
  const isNarrow = useIsMobile(900);
  const [selectMode,setSelectMode] = useState(false);
  const [selectedIds,setSelectedIds] = useState(new Set());
  const [bulkProgram,setBulkProgram] = useState("");
  const [showBulkModal,setShowBulkModal] = useState(false);
  const [bulkSaving,setBulkSaving] = useState(false);
  const [school,setSchool] = useState(null);
  const [allSchools,setAllSchools] = useState([]);
  const [showAssignCoachModal,setShowAssignCoachModal] = useState(false);
  const [assignCoachId,setAssignCoachId] = useState("");
  const [assignSaving,setAssignSaving] = useState(false);
  const [assignError,setAssignError] = useState("");

  useEffect(()=>{loadAll();},[]);

  // Keep selected athlete's program in sync with what Joe-bot may have updated
  useEffect(()=>{
    if(!selected) return;
    const selectedId = selected.id;
    const poll = setInterval(async ()=>{
      try {
        const _r = await idApi("coach-athlete-fields",{coachId:coach.id,pin:coach.pin,athleteId:selectedId});
        const fresh = _r.fields ? [_r.fields] : [];
        if(fresh.length>0){
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
      // athletes/coaches/schools are RLS-protected — fetch them server-side (role-scoped).
      // workouts/prs now also go through the gateway, scoped to this coach's athletes
      // server-side (master -> all). The client-side filter below is kept as a harmless
      // belt-and-suspenders; the server has already narrowed the result set.
      // Paged (sbReadPaged) instead of a single capped query: the full scoped history
      // comes back correctly in bounded requests, without the old limit=5000 silently
      // dropping the oldest sessions (which made all-time counts/leaderboards drift).
      const [dash,w,p] = await Promise.all([
        idApi("coach-dashboard",{coachId:coach.id,pin:coach.pin}),
        sbReadPaged("workouts"),
        sbReadPaged("prs"),
      ]);
      const a  = dash.athletes||[];
      const c  = dash.coaches||[];
      const s  = dash.school||[];
      const sc = dash.schoolsAll||[];
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
      // Load proof digests: per-athlete digests for this coach's athletes, plus the
      // team-aggregate coach reports (athlete_id is null on those, so they're fetched
      // by digest_type — the gateway scopes both reads to this coach by coach_id).
      if(ids.length>0){
        const idList = ids.map(id=>`"${id}"`).join(",");
        // Digests + manual 1RMs + parsed programs, all gateway-scoped to this roster.
        // manual_one_rms feeds Grit strengths/weaknesses; program_prescriptions feeds
        // the Overview load-adherence band (both read-only for the dashboard).
        const [perAthlete, teamReports, manual, presc] = await Promise.all([
          sbRead("proof_digests",`?athlete_id=in.(${idList})&order=generated_at.desc&select=*`),
          sbRead("proof_digests",`?digest_type=in.(weekly_coach,monthly_coach)&order=generated_at.desc&select=*`),
          sbRead("manual_one_rms",`?athlete_id=in.(${idList})&select=*`),
          sbRead("program_prescriptions",`?athlete_id=in.(${idList})&select=*`),
        ]);
        setAllDigests([...(Array.isArray(perAthlete)?perAthlete:[]),...(Array.isArray(teamReports)?teamReports:[])]);
        setManualRMs(Array.isArray(manual)?manual:[]);
        setPrescriptions(Array.isArray(presc)?presc:[]);
        // Locked-program change requests routed to this coach (gateway scopes by coach_id).
        try {
          const reqs = await sbRead("program_change_requests","?status=eq.pending&order=created_at.desc&select=*");
          setChangeRequests(Array.isArray(reqs)?reqs:[]);
        } catch(e){ /* table/rows may be empty */ }
      }
      // Recent coach context (gateway scopes by coach_id) — the Morning Brief reads
      // this week's decisions from it so acted-on flags don't resurface.
      try {
        const ctx = await sbRead("coach_context","?order=created_at.desc&limit=200&select=*");
        setBriefContext(Array.isArray(ctx)?ctx:[]);
      } catch(e){ /* empty is fine */ }
    } catch(e){console.error(e);}
    setLoading(false);
  };

  const recalcAllPRs = async () => {
    setRecalcStatus("running");
    try {
      // Fetch every workout ever logged (need all history, not just what's loaded).
      // Paged so this can't fire one unbounded query that OOMs/times out on a big team.
      const allWorkouts = await sbReadPaged("workouts","created_at.asc");
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
            if(!ex.name||ex.unit==="bodyweight") continue;
            const e1rm = bestE1RMForExercise(ex);
            if(!e1rm) continue;
            const k = normalizeExName(ex.name);
            if(!best[k]||e1rm>best[k].e1rm){
              const topSet = getExerciseSets(ex).reduce((b,s)=>epley1RM(toLbs(s.weight,ex.unit),s.reps)>epley1RM(toLbs(b.weight,ex.unit),b.reps)?s:b, {weight:ex.weight??0, reps:ex.reps||1});
              best[k] = {exercise:ex.name,weight:topSet.weight,reps:topSet.reps||1,e1rm,unit:ex.unit||"lbs"};
            }
          }
        }
        // Only wipe and re-insert if we actually found exercises (safety guard).
        // One array insert per athlete — the per-PR loop paid a full gateway
        // round-trip per row.
        if(Object.keys(best).length>0){
          await sbDelete("prs",`?athlete_id=eq.${ath.id}`);
          await sbInsert("prs",Object.values(best).map(({exercise,weight,reps,e1rm,unit})=>(
            {athlete_id:ath.id,exercise,weight,reps,estimated_1rm:e1rm,unit}
          )));
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
      // parse-at-save for bulk: same text for everyone → ONE Haiku call, then the
      // parsed row is fanned out per athlete (fire-and-forget).
      (async()=>{
        try{
          const ids=[...selectedIds];
          const first=await parseAndCacheProgram(ids[0],bulkProgram.trim());
          if(!first) return;
          const rows=[first];
          for(const id of ids.slice(1)){
            const row={...first,athlete_id:id};
            await sbUpsert("program_prescriptions",row,"athlete_id");
            rows.push(row);
          }
          setPrescriptions(prev=>[...prev.filter(p=>!selectedIds.has(p.athlete_id)),...rows]);
        }catch(e){ console.error("bulk parse-at-save",e); }
      })();
      setSelectedIds(new Set());
      setSelectMode(false);
      setBulkProgram("");
      setShowBulkModal(false);
    } catch(e){console.error(e);}
    setBulkSaving(false);
  };

  // Assign (or unassign) selected athletes to a coach/school. assignCoachId==="" means unassign.
  const handleBulkAssignCoach = async () => {
    if(selectedIds.size===0) return;
    setAssignSaving(true);
    setAssignError("");
    try {
      const targetCoach = assignCoachId ? allCoaches.find(c=>c.id===assignCoachId) : null;
      if(assignCoachId && !targetCoach){ setAssignError("Coach not found — try again."); setAssignSaving(false); return; }
      const patch = targetCoach ? {coach_id:targetCoach.id, school_id:targetCoach.school_id||null} : {coach_id:null, school_id:null};
      for(const id of selectedIds){
        await sbUpdate("athletes",id,patch);
      }
      setAthletes(prev=>prev.map(a=>selectedIds.has(a.id)?{...a,...patch}:a));
      setSelectedIds(new Set());
      setSelectMode(false);
      setAssignCoachId("");
      setShowAssignCoachModal(false);
    } catch(e){
      console.error(e);
      setAssignError("Couldn't save that assignment. Try again.");
    }
    setAssignSaving(false);
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

  const tabs = ["overview","athletes","progress","reports",...(isMaster?[]:["settings"]),...(isMaster?["coaches"]:[]),...(!isMaster&&isAdmin?["account"]:[])];

  return (
    <div className="cyber-coach" style={{minHeight:"100dvh"}}>
      <style>{GS}{GSC}</style>
      {/* Header */}
      <div style={{background:CA.navy2,borderBottom:`1px solid ${CA.border}`,paddingTop:isMobile?"calc(10px + env(safe-area-inset-top, 0px))":"14px",paddingBottom:isMobile?"10px":"14px",paddingLeft:isMobile?"14px":"20px",paddingRight:isMobile?"14px":"20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:50,gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0,flex:1}}>
          {/* School logo — shown for team coaches who have a logo set */}
          {!isMaster&&school?.logo_url&&(
            <img src={school.logo_url} alt={school.name} style={{width:isMobile?32:40,height:isMobile?32:40,borderRadius:8,objectFit:"contain",background:"rgba(220,232,255,.92)",padding:3,flexShrink:0}}/>
          )}
          <div style={{minWidth:0}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:isMobile?17:22,color:CA.accent,letterSpacing:2,lineHeight:1.1,whiteSpace:isMobile?"nowrap":"normal",overflow:"hidden",textOverflow:"ellipsis"}}>
              {isMaster ? "WILCO MASTER" : (school?.name ? school.name.toUpperCase() : "WILCO COACH")}
            </div>
            <div style={{color:CA.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {coach.name}{!isMaster&&school?" · "+school.name:""}
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,flexShrink:0}}>
          <button onClick={loadAll} style={{background:CA.navy3,border:`1px solid ${CA.border}`,color:CA.muted2,borderRadius:8,padding:"6px 10px",cursor:"pointer",fontSize:isMobile?16:12}}>↻</button>
          <button onClick={onLogout} style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:12}}>Log Out</button>
        </div>
      </div>

      {/* Tabs — horizontally scrollable on narrow screens */}
      <div style={{background:CA.navy2,borderBottom:`1px solid ${CA.border}`,display:"flex",padding:isMobile?"0 8px":"0 20px",overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none"}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>{setActiveTab(t);if(t!=="athletes")setSelected(null);}}
            style={{padding:isMobile?"12px 13px":"12px 18px",background:"none",border:"none",borderBottom:`2px solid ${activeTab===t?CA.accent:"transparent"}`,color:activeTab===t?CA.accent:CA.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"color 0.15s",whiteSpace:"nowrap",flexShrink:0}}>
            {t==="stats"?"Group Stats":t}
          </button>
        ))}
      </div>

      <div style={{padding:isMobile?12:20,maxWidth:1400,margin:"0 auto"}}>
        {loading?(
          <div style={{textAlign:"center",padding:60,color:CA.muted}}>Loading...</div>
        ):(
          <>
            {/* ── OVERVIEW TAB ── */}
            {activeTab==="overview"&&(
              <CoachOverview athletes={athletes} workouts={workouts} prs={prs} manualRMs={manualRMs} prescriptions={prescriptions} coach={coach}
                changeRequests={changeRequests} briefContext={briefContext} parsingIds={parsingIds}
                onOpenAthlete={(id)=>{const at=athletes.find(a=>a.id===id); if(at){setSelected(at);setActiveTab("athletes");}}}
                onPrefillProgram={(id,note)=>{const at=athletes.find(a=>a.id===id); if(at){setProgramPrefill({athleteId:id,note});setSelected(at);setActiveTab("athletes");}}}
                onResolveRequest={async (requestId,status)=>{
                  await sbUpdate("program_change_requests",requestId,{status,resolved_at:new Date().toISOString()});
                  setChangeRequests(prev=>prev.filter(r=>r.id!==requestId));
                }}
                onContextWritten={(row)=>setBriefContext(prev=>[row,...prev])}/>
            )}

            {/* ── ATHLETES TAB ── */}
            {activeTab==="athletes"&&(
              <div style={{display:"grid",gridTemplateColumns:(!isNarrow&&selected)?"300px minmax(0,1fr)":"1fr",gap:20,alignItems:"start"}}>
                {/* Left: Athlete List — hidden on narrow screens when detail is open */}
                {(!isNarrow||!selected)&&(
                <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,overflow:"hidden",position:isNarrow?"static":"sticky",top:90}}>
                  <div style={{padding:"12px 14px",borderBottom:`1px solid ${CA.border}`}}>
                    <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search athletes..."
                      style={{width:"100%",background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:8,padding:"8px 12px",color:CA.text,fontSize:13,outline:"none",marginBottom:8}}/>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>setFilterPain(p=>!p)}
                        style={{flex:1,background:filterPain?`${CA.red}20`:"transparent",border:`1px solid ${filterPain?CA.red:CA.border}`,color:filterPain?CA.red:CA.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                        Pain flags
                      </button>
                      <button onClick={()=>setFilterInactive(p=>!p)}
                        style={{flex:1,background:filterInactive?`${CA.accent}20`:"transparent",border:`1px solid ${filterInactive?CA.accent:CA.border}`,color:filterInactive?CA.accent:CA.muted,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                        Inactive 7d+
                      </button>
                      <button onClick={()=>setSortBy(s=>s==="lastActive"?"name":"lastActive")}
                        style={{flex:1,background:CA.navy3,border:`1px solid ${CA.border}`,color:CA.muted2,borderRadius:6,padding:"4px 8px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'",display:"flex",alignItems:"center",justifyContent:"center",gap:4}}>
                        <span>{sortBy==="lastActive"?"⏱":"A–Z"}</span>
                        <span>{sortBy==="lastActive"?"Active":"Name"}</span>
                      </button>
                    </div>
                  </div>
                  <div style={{padding:"6px 14px",borderBottom:`1px solid ${CA.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:8}}>
                    <button onClick={()=>{setSelectMode(p=>!p);setSelectedIds(new Set());}}
                      style={{background:selectMode?`${CA.accent}20`:"transparent",border:`1px solid ${selectMode?CA.accent:CA.border}`,color:selectMode?CA.accent:CA.muted,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans'"}}>
                      {selectMode?"✕ Cancel":"☑ Bulk Assign"}
                    </button>
                    {selectMode&&selectedIds.size>0&&(
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>setShowBulkModal(true)}
                          style={{background:CA_BTN,boxShadow:"0 4px 16px "+CA_GLOW,border:"none",color:"#fff",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap"}}>
                          Program ({selectedIds.size})
                        </button>
                        {isMaster&&(
                          <button onClick={()=>setShowAssignCoachModal(true)}
                            style={{background:CA.blue,border:"none",color:"#fff",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap"}}>
                            Coach ({selectedIds.size})
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div style={{maxHeight:isMobile?"none":"calc(100dvh - 240px)",overflowY:"auto"}}>
                    {filtered.length===0?(
                      <div style={{padding:24,textAlign:"center",color:CA.muted,fontSize:13}}>No athletes found</div>
                    ):filtered.map(a=>{
                      const la = lastActive(a.id);
                      const d = daysBetween(la);
                      const aResolvedPain = (a.resolved_pain||[]).map(x=>x.toLowerCase());
                      const hasPain = workouts.filter(w=>w.athlete_id===a.id).some(w=>w.parsed_data?.pain_flags?.some(p=>!aResolvedPain.includes(p.area.toLowerCase())));
                      const isSel = selected?.id===a.id;
                      const dot = d===null?CA.muted:d===0?CA.green:d<=3?CA.green:d<=7?CA.amber:CA.red;
                      return (
                        <div key={a.id}
                          onClick={()=>selectMode?setSelectedIds(prev=>{const s=new Set(prev);s.has(a.id)?s.delete(a.id):s.add(a.id);return s;}):setSelected(isSel?null:a)}
                          style={{padding:"11px 14px",borderBottom:`1px solid ${CA.border}`,cursor:"pointer",background:selectedIds.has(a.id)?`${CA.accent}15`:isSel?CA.navy3:"transparent",transition:"background 0.15s",display:"flex",alignItems:"center",gap:10}}>
                          {selectMode?(
                            <div style={{width:20,height:20,borderRadius:4,border:`2px solid ${selectedIds.has(a.id)?CA.accent:CA.muted}`,background:selectedIds.has(a.id)?CA.accent:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:11,color:"#fff"}}>
                              {selectedIds.has(a.id)&&"✓"}
                            </div>
                          ):(
                          <div style={{width:34,height:34,borderRadius:"50%",background:`linear-gradient(135deg,#57a0ff,#2a63e6)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:15,color:"#fff",flexShrink:0}}>{a.name[0].toUpperCase()}</div>
                          )}
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{color:CA.text,fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}>{a.name}{a.certified_badge_earned_at&&<span title="WILCO Certified" style={{color:CA.accent,fontSize:10,flexShrink:0}}>✦</span>}</div>
                            <div style={{color:CA.muted,fontSize:11}}>{a.sport} · {groupIntoSessions(workouts.filter(w=>w.athlete_id===a.id)).length} sessions</div>
                          </div>
                          <div style={{textAlign:"right",flexShrink:0}}>
                            {hasPain&&<div style={{color:CA.red,fontSize:9,marginBottom:2}}>⚠ pain</div>}
                            <div style={{display:"flex",alignItems:"center",gap:4,justifyContent:"flex-end"}}>
                              <div style={{width:7,height:7,borderRadius:"50%",background:dot}}/>
                              <div style={{color:CA.muted,fontSize:10}}>{d===null?"never":d===0?"today":`${d}d ago`}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
                )}

                {/* Right: Athlete Detail — full-width on narrow screens when selected.
                    minWidth:0 lets the pane shrink inside the grid (grid children
                    default to min-width:auto → horizontal page overflow otherwise) */}
                {selected&&(
                  <div style={{minWidth:0}}>
                    {isNarrow&&(
                      <button onClick={()=>setSelected(null)}
                        style={{display:"flex",alignItems:"center",gap:6,background:CA.navy2,border:`1px solid ${CA.border}`,color:CA.muted2,borderRadius:8,padding:"8px 14px",cursor:"pointer",fontSize:13,marginBottom:12,fontFamily:"'DM Sans'"}}>
                        ← Athletes
                      </button>
                    )}
                    <AthleteDetail
                      athlete={selected}
                      workouts={workouts.filter(w=>w.athlete_id===selected.id)}
                      prs={prs.filter(p=>p.athlete_id===selected.id)}
                      requests={changeRequests.filter(r=>r.athlete_id===selected.id)}
                      prefill={programPrefill&&programPrefill.athleteId===selected.id?programPrefill:null}
                      onPrefillConsumed={()=>setProgramPrefill(null)}
                      onResolveRequest={async (req,status)=>{
                        await sbUpdate("program_change_requests",req.id,{status,resolved_at:new Date().toISOString()});
                        setChangeRequests(prev=>prev.filter(r=>r.id!==req.id));
                      }}
                      onProgramSave={async (text)=>{
                        await sbUpdate("athletes",selected.id,{program_text:text});
                        setAthletes(prev=>prev.map(a=>a.id===selected.id?{...a,program_text:text}:a));
                        setSelected(prev=>({...prev,program_text:text}));
                        // parse-at-save: the program is gradeable immediately, no
                        // "not parsed yet" window (fire-and-forget; backfill catches failures)
                        const aid=selected.id;
                        parseAndCacheProgram(aid,text)
                          .then(row=>{ if(row) setPrescriptions(prev=>[...prev.filter(p=>p.athlete_id!==aid),row]); })
                          .catch(e=>console.error("parse-at-save",e));
                      }}
                      onAthleteDelete={(id)=>{
                        setAthletes(prev=>prev.filter(a=>a.id!==id));
                        setSelected(null);
                      }}
                    />
                  </div>
                )}
                {!selected&&!isNarrow&&(
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:60,color:CA.muted,fontSize:13,border:`1px dashed ${CA.border}`,borderRadius:14}}>
                    Select an athlete to view details
                  </div>
                )}
              </div>
            )}

            {/* Bulk Program Modal */}
            {showBulkModal&&(
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:24}}>
                <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:500}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:CA.accent,letterSpacing:2,marginBottom:4}}>BULK ASSIGN PROGRAM</div>
                  <div style={{color:CA.muted,fontSize:12,marginBottom:14}}>Assigning to {selectedIds.size} athlete{selectedIds.size!==1?"s":""} — overwrites any existing program.</div>
                  <textarea value={bulkProgram} onChange={e=>setBulkProgram(e.target.value)} placeholder={"Paste the program here...\n\nExample:\nWeek 1:\n  Mon: Squat 3×5, Bench 3×5\n  Wed: Deadlift 1×5, OHP 3×5"} rows={10}
                    style={{width:"100%",background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:10,padding:"12px 14px",color:CA.text,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6,fontFamily:"'DM Sans'",marginBottom:14}}/>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setShowBulkModal(false)} style={{flex:1,background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14}}>Cancel</button>
                    <button onClick={handleBulkAssign} disabled={bulkSaving||!bulkProgram.trim()}
                      style={{flex:2,background:CA_BTN,boxShadow:"0 4px 16px "+CA_GLOW,border:"none",color:"#fff",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,opacity:bulkSaving||!bulkProgram.trim()?0.6:1}}>
                      {bulkSaving?"Saving...":"Assign to "+selectedIds.size+" Athletes →"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Bulk Assign Coach/School Modal (master only) */}
            {showAssignCoachModal&&(()=>{
              const schoolsById = Object.fromEntries(allSchools.map(s=>[s.id,s]));
              const sortedCoaches = [...allCoaches].sort((a,b)=>{
                const sa = schoolsById[a.school_id]?.name||"";
                const sb = schoolsById[b.school_id]?.name||"";
                return sa.localeCompare(sb) || a.name.localeCompare(b.name);
              });
              return (
                <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:500,padding:24}}
                  onClick={()=>!assignSaving&&setShowAssignCoachModal(false)}>
                  <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:460}}
                    onClick={e=>e.stopPropagation()}>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:CA.accent,letterSpacing:2,marginBottom:4}}>ASSIGN TO COACH</div>
                    <div style={{color:CA.muted,fontSize:12,marginBottom:14}}>
                      Moving {selectedIds.size} athlete{selectedIds.size!==1?"s":""} to a coach/school. This overwrites their current assignment.
                    </div>
                    <select value={assignCoachId} onChange={e=>setAssignCoachId(e.target.value)}
                      style={{width:"100%",background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:10,padding:"11px 12px",color:CA.text,fontSize:13,outline:"none",marginBottom:14}}>
                      <option value="">— Unassigned (remove from any school) —</option>
                      {sortedCoaches.map(c=>{
                        const s = schoolsById[c.school_id];
                        return (
                          <option key={c.id} value={c.id}>
                            {(s?.name||"No School")} — {c.name}{c.role==="admin"?" (Admin)":""}{c.access_code?` · ${c.access_code}`:""}
                          </option>
                        );
                      })}
                    </select>
                    {assignError&&<div style={{color:CA.red,fontSize:12,marginBottom:10}}>{assignError}</div>}
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>{setShowAssignCoachModal(false);setAssignCoachId("");setAssignError("");}}
                        style={{flex:1,background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14}}>Cancel</button>
                      <button onClick={handleBulkAssignCoach} disabled={assignSaving}
                        style={{flex:2,background:CA.blue,border:"none",color:"#fff",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,opacity:assignSaving?0.6:1}}>
                        {assignSaving?"Saving...":(assignCoachId?`Assign ${selectedIds.size} Athlete${selectedIds.size!==1?"s":""} →`:`Unassign ${selectedIds.size} Athlete${selectedIds.size!==1?"s":""} →`)}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── GROUP STATS TAB ── */}
            {/* ── PROGRESS TAB (group trends) ── */}
            {activeTab==="progress"&&(
              <GroupProgress athletes={athletes} workouts={workouts} manualRMs={manualRMs}/>
            )}

            {/* ── SETTINGS TAB (notifications) ── */}
            {activeTab==="settings"&&(()=>{
              const Toggle = ({on,onClick})=>(
                <button onClick={onClick} style={{width:42,height:24,borderRadius:999,background:on?`${CA.green}40`:CA.navy3,border:`1px solid ${on?CA.green:CA.border}`,position:"relative",cursor:"pointer",flexShrink:0}}>
                  <span style={{position:"absolute",top:2,left:on?20:2,width:18,height:18,borderRadius:"50%",background:on?CA.green:CA.muted,transition:"left 0.15s"}}/>
                </button>
              );
              const Row = ({title,desc,pkey})=>(
                <div style={{display:"flex",alignItems:"center",gap:14,padding:"13px 16px",borderBottom:`1px solid ${CA.border}80`}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13.5,color:CA.text}}>{title}</div>
                    <div style={{color:CA.muted,fontSize:12,marginTop:2}}>{desc}</div>
                  </div>
                  <Toggle on={notifPrefs[pkey]!==false} onClick={()=>savePref(pkey,!(notifPrefs[pkey]!==false))}/>
                </div>
              );
              return (
                <div style={{maxWidth:640}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,margin:"6px 2px 12px"}}>
                    <span style={{fontSize:10.5,letterSpacing:1.4,textTransform:"uppercase",color:CA.accent,fontWeight:700}}>Notifications</span>
                    <span style={{height:1,background:CA.border,flex:1}}/>
                  </div>
                  <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:"14px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:14}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:700,fontSize:13.5,color:CA.text}}>Push notifications on this device</div>
                      <div style={{color:CA.muted,fontSize:12,marginTop:2}}>{pushOn?"On — you'll get the alerts you've toggled below.":"Turn on to get alerts on this device."}</div>
                    </div>
                    <button onClick={togglePush} disabled={pushBusy} style={{background:pushOn?"transparent":CA_BTN,color:pushOn?CA.muted:"#fff",border:`1px solid ${pushOn?CA.border:CA.accent}`,boxShadow:pushOn?"none":`0 4px 16px ${CA_GLOW}`,borderRadius:9,padding:"8px 16px",fontWeight:700,fontSize:12.5,cursor:"pointer",fontFamily:"'DM Sans'",opacity:pushBusy?0.6:1}}>{pushBusy?"…":pushOn?"Turn off":"Enable"}</button>
                  </div>
                  <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,overflow:"hidden"}}>
                    <Row title="Athlete injury / pain" desc="When an athlete flags pain in a session." pkey="injury"/>
                    <Row title="Big PR" desc="Only real improvements on ranked lifts — never a first-time baseline." pkey="big_pr"/>
                    <Row title="Athlete inactive" desc="When someone on your roster goes quiet." pkey="inactive"/>
                    <Row title="Coach's Edition ready" desc="Your weekly + monthly team report, the moment it's generated." pkey="digest"/>
                  </div>
                  <div style={{color:CA.muted,fontSize:11.5,marginTop:12,lineHeight:1.5}}>WILCO never messages your athletes on your behalf — these alerts go only to you.</div>
                </div>
              );
            })()}

            {/* ── REPORTS TAB ── */}
            {activeTab==="reports"&&(()=>{
              const athleteById = Object.fromEntries(athletes.map(a=>[a.id,a]));
              // Team-aggregate coach reports vs per-athlete digests.
              const teamReports = allDigests.filter(d=>d.digest_type==="weekly_coach"||d.digest_type==="monthly_coach");
              const displayDigests = allDigests.filter(d=>d.digest_type==="weekly"||d.digest_type==="monthly");
              const latestTeamReport = teamReports[0]||null; // ordered desc by generated_at

              let filtered = displayDigests;
              if(reportFilter==="weekly") filtered = filtered.filter(d=>d.digest_type==="weekly");
              if(reportFilter==="monthly") filtered = filtered.filter(d=>d.digest_type==="monthly");
              if(reportFlagFilter) filtered = filtered.filter(d=>d.has_plateau||d.has_pain||d.has_missed);
              if(reportSearch) filtered = filtered.filter(d=>{
                const a = athleteById[d.athlete_id];
                return a?.name?.toLowerCase().includes(reportSearch.toLowerCase());
              });

              if(selectedDigest){
                const c = selectedDigest.content_json||{};
                const isTeam = selectedDigest.digest_type==="weekly_coach"||selectedDigest.digest_type==="monthly_coach";
                // New rich team report (The Coach's Edition) → dedicated render + check-in.
                // Legacy team reports (no content_json.team) fall through to the old view.
                if(isTeam && c.team){
                  return <CoachEdition digest={selectedDigest} athletes={athletes} coach={coach} school={school} onBack={()=>setSelectedDigest(null)} onRead={loadAll}/>;
                }
                const a = isTeam ? null : athleteById[selectedDigest.athlete_id];
                // New shape: sections[]. Legacy fallback: keyed fields.
                const sections = Array.isArray(c.sections)&&c.sections.length
                  ? c.sections
                  : [
                      ["opening_message","OPENING"],["week_vs_week","THIS WEEK VS LAST"],["month_summary","MONTH SUMMARY"],
                      ["consistency","CONSISTENCY"],["goal_progress","GOAL PROGRESS"],["month_patterns","PATTERNS"],
                      ["trend_callouts","TRENDS"],["plateau_flag","PLATEAU FLAG"],["unresolved_plateaus","PLATEAUS"],
                      ["encouragement","FROM COACH JOE"],["focus_next_week","FOCUS NEXT WEEK"],
                    ].filter(([k])=>c[k]).map(([k,l])=>({label:l,body:c[k]}));
                const ol = c.outliers||{};
                return (
                  <div style={{maxWidth:700}}>
                    <button onClick={()=>setSelectedDigest(null)} style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,marginBottom:14}}>← Back to Reports</button>
                    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:18}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                        <div>
                          <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>{selectedDigest.label}</div>
                          <div style={{color:CA.muted,fontSize:12}}>{isTeam?"Team report":`${a?.name||"Unknown"} · ${a?.sport||""}`}</div>
                        </div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
                          {selectedDigest.has_plateau&&<div style={{background:CA.red+"26",border:"1px solid "+CA.red+"66",borderRadius:4,padding:"2px 7px",color:CA.red,fontSize:10,fontWeight:700}}>PLATEAU</div>}
                          {selectedDigest.has_pain&&<div style={{background:CA.red+"1A",border:"1px solid "+CA.red+"4D",borderRadius:4,padding:"2px 7px",color:CA.red,fontSize:10}}>{isTeam?"INJURIES":"PAIN FLAG"}</div>}
                          {selectedDigest.has_missed&&<div style={{background:"rgba(100,116,139,0.2)",border:`1px solid ${CA.border}`,borderRadius:4,padding:"2px 7px",color:CA.muted,fontSize:10}}>{isTeam?"AT-RISK":"MISSED SESSIONS"}</div>}
                        </div>
                      </div>
                      {c.intro&&<div style={{color:CA.text,fontSize:13,lineHeight:1.65,marginBottom:12,fontStyle:"italic"}}>{c.intro}</div>}
                      {sections.map((s,i)=>(
                        <div key={i} style={{background:CA.navy3,border:`1px solid ${s.flag==="warn"?CA.red+"4D":CA.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                          <div style={{color:s.flag==="warn"?CA.red:CA.muted,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:6}}>{s.label}</div>
                          <div style={{color:CA.text,fontSize:13,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{s.body}</div>
                        </div>
                      ))}
                      {/* Team report: outliers + coach actions */}
                      {isTeam&&(ol.mostImproved?.length>0||ol.atRisk?.length>0||ol.volumeCratered?.length>0)&&(
                        <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                          <div style={{color:CA.muted,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:8}}>FLAGGED OUTLIERS</div>
                          {ol.mostImproved?.length>0&&<div style={{color:CA.text,fontSize:13,marginBottom:4}}><span style={{color:CA.green}}>↑ Most improved:</span> {ol.mostImproved.map(o=>`${o.name} (+${o.delta})`).join(", ")}</div>}
                          {ol.atRisk?.length>0&&<div style={{color:CA.text,fontSize:13,marginBottom:4}}><span style={{color:CA.red}}>⚠ At risk:</span> {ol.atRisk.join(", ")}</div>}
                          {ol.volumeCratered?.length>0&&<div style={{color:CA.text,fontSize:13}}><span style={{color:CA.accent}}>↓ Volume cratered:</span> {ol.volumeCratered.map(o=>`${o.name} (${o.gap}%)`).join(", ")}</div>}
                        </div>
                      )}
                      {isTeam&&Array.isArray(c.actions)&&c.actions.length>0&&(
                        <div style={{background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:10,padding:"12px 14px"}}>
                          <div style={{color:CA.green,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:6}}>COACH ACTIONS</div>
                          <ul style={{margin:0,paddingLeft:16,color:CA.text,fontSize:13,lineHeight:1.7}}>{c.actions.map((act,i)=><li key={i}>{act}</li>)}</ul>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              // ── Leaderboard (school accounts only) ───────────────────────────────
              const leaderboard = school ? (()=>{
                const now = Date.now();
                const d30 = 30*24*60*60*1000;
                const schoolAthletes = athletes.filter(a=>a.school_id===school.id);
                if(schoolAthletes.length<2) return null;
                // Most Improved
                const improved = schoolAthletes.map(a=>{
                  const aw=workouts.filter(w=>w.athlete_id===a.id);
                  const rb={};const pb={};
                  aw.filter(w=>now-new Date(w.created_at)<=d30).forEach(w=>(w.parsed_data?.exercises||[]).forEach(ex=>{if(!ex.name||ex.unit==="bodyweight")return;const k=normalizeExName(ex.name);const e=bestE1RMForExercise(ex);if(e&&(!rb[k]||e>rb[k]))rb[k]=e;}));
                  aw.filter(w=>{const age=now-new Date(w.created_at);return age>d30&&age<=d30*2;}).forEach(w=>(w.parsed_data?.exercises||[]).forEach(ex=>{if(!ex.name||ex.unit==="bodyweight")return;const k=normalizeExName(ex.name);const e=bestE1RMForExercise(ex);if(e&&(!pb[k]||e>pb[k]))pb[k]=e;}));
                  let best=0;
                  Object.keys(rb).forEach(k=>{if(pb[k]&&pb[k]>0){const p=(rb[k]-pb[k])/pb[k]*100;if(p>best)best=p;}});
                  return best>0?{athlete:a,metric:`+${Math.round(best)}% est. 1RM`}:null;
                }).filter(Boolean).sort((a,b)=>parseFloat(b.metric)-parseFloat(a.metric)).slice(0,3);
                // Most Impressive Lift
                const impressive = schoolAthletes.filter(a=>a.weight_lbs).map(a=>{
                  let bestRatio=0,bestLift="";
                  workouts.filter(w=>w.athlete_id===a.id).forEach(w=>(w.parsed_data?.exercises||[]).forEach(ex=>{if(!ex.name||ex.unit==="bodyweight")return;const e=bestE1RMForExercise(ex);if(!e)return;const r=e/a.weight_lbs;if(r>bestRatio){bestRatio=r;bestLift=ex.name;}}));
                  return bestRatio>0?{athlete:a,metric:`${bestLift} · ${bestRatio.toFixed(2)}×BW`,ratio:bestRatio}:null;
                }).filter(Boolean).sort((a,b)=>b.ratio-a.ratio).slice(0,3);
                // Most Consistent (sessions in last 30d)
                const consistent = schoolAthletes.map(a=>{
                  const cnt=workouts.filter(w=>w.athlete_id===a.id&&(now-new Date(w.created_at))<=d30).length;
                  return cnt>0?{athlete:a,metric:`${cnt} sessions`}:null;
                }).filter(Boolean).sort((a,b)=>parseInt(b.metric)-parseInt(a.metric)).slice(0,3);
                return {improved,impressive,consistent,asOf:new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})};
              })() : null;

              return (
                <div style={{maxWidth:700}}>
                  {/* ── Leaderboard Section ── */}
                  {leaderboard&&(
                    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:16,marginBottom:20}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>TEAM LEADERBOARD</div>
                        <div style={{color:CA.muted,fontSize:10}}>As of {leaderboard.asOf}</div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                        {[{label:"Most Improved",data:leaderboard.improved},{label:"Most Impressive Lift",data:leaderboard.impressive},{label:"Most Consistent",data:leaderboard.consistent}].map(({label,data})=>(
                          <div key={label}>
                            <div style={{color:CA.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>{label}</div>
                            {data.length===0?<div style={{color:CA.muted,fontSize:11,fontStyle:"italic"}}>Not enough data</div>:data.map((entry,i)=>(
                              <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                                <span style={{color:i===0?CA.accent:CA.muted,fontSize:i===0?14:11,flexShrink:0}}>{i===0?"🥇":i===1?"2.":"3."}</span>
                                <div style={{minWidth:0}}>
                                  <div style={{color:CA.text,fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.athlete.name}</div>
                                  <div style={{color:CA.muted,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.metric}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Team aggregate report (Coach Joe's read on the whole roster) */}
                  {latestTeamReport&&(
                    <button onClick={()=>setSelectedDigest(latestTeamReport)} style={{width:"100%",background:CA.navy2,border:`1px solid ${CA.accent}40`,borderRadius:14,padding:16,textAlign:"left",cursor:"pointer",display:"block",marginBottom:16}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>TEAM REPORT</div>
                        <div style={{display:"flex",gap:6}}>
                          {latestTeamReport.has_pain&&<div style={{background:CA.red+"1A",border:"1px solid "+CA.red+"4D",borderRadius:4,padding:"2px 6px",color:CA.red,fontSize:10}}>INJURIES</div>}
                          {latestTeamReport.has_missed&&<div style={{background:`${CA.navy3}`,border:`1px solid ${CA.border}`,borderRadius:4,padding:"2px 6px",color:CA.muted,fontSize:10}}>AT-RISK</div>}
                        </div>
                      </div>
                      {latestTeamReport.content_json?.intro&&<div style={{color:CA.text,fontSize:13,lineHeight:1.6,marginBottom:8}}>{latestTeamReport.content_json.intro}</div>}
                      <div style={{color:CA.accent,fontSize:12,fontWeight:700,letterSpacing:1}}>OPEN REPORT →</div>
                    </button>
                  )}
                  {/* Filters */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
                    <input value={reportSearch} onChange={e=>setReportSearch(e.target.value)} placeholder="Search athlete..."
                      style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:8,padding:"7px 12px",color:CA.text,fontSize:13,outline:"none",flex:1,minWidth:120}}/>
                    {["all","weekly","monthly"].map(f=>(
                      <button key={f} onClick={()=>setReportFilter(f)}
                        style={{background:reportFilter===f?`${CA.accent}20`:"transparent",border:`1px solid ${reportFilter===f?CA.accent:CA.border}`,color:reportFilter===f?CA.accent:CA.muted,borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans'",fontWeight:reportFilter===f?700:400}}>
                        {f.charAt(0).toUpperCase()+f.slice(1)}
                      </button>
                    ))}
                    <button onClick={()=>setReportFlagFilter(p=>!p)}
                      style={{background:reportFlagFilter?`${CA.red}20`:"transparent",border:`1px solid ${reportFlagFilter?CA.red:CA.border}`,color:reportFlagFilter?CA.red:CA.muted,borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12}}>
                      Flags only
                    </button>
                  </div>

                  {filtered.length===0?(
                    <div style={{textAlign:"center",padding:40,color:CA.muted,fontSize:13}}>No reports found.</div>
                  ):(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {filtered.map((d,i)=>{
                        const a = athleteById[d.athlete_id];
                        const isMonthly = d.digest_type==="monthly";
                        return (
                          <button key={i} onClick={()=>setSelectedDigest(d)}
                            style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:"12px 16px",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,transition:"border-color 0.15s"}}>
                            <div style={{minWidth:0}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                                <div style={{color:isMonthly?CA.blue:CA.accent,fontSize:10,fontWeight:700,letterSpacing:1.5}}>
                                  {isMonthly?"MONTHLY":"WEEKLY"}
                                </div>
                                <div style={{color:CA.text,fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a?.name||"Unknown"}</div>
                              </div>
                              <div style={{color:CA.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label}</div>
                            </div>
                            <div style={{display:"flex",gap:5,flexShrink:0,alignItems:"center"}}>
                              {d.has_plateau&&<div style={{background:CA.red+"26",border:"1px solid "+CA.red+"66",borderRadius:4,padding:"2px 6px",color:CA.red,fontSize:9,fontWeight:700}}>PLT</div>}
                              {d.has_pain&&<div style={{background:CA.red+"1A",border:"1px solid "+CA.red+"4D",borderRadius:4,padding:"2px 6px",color:CA.red,fontSize:9}}>PAIN</div>}
                              {d.has_missed&&<div style={{background:`${CA.navy3}`,border:`1px solid ${CA.border}`,borderRadius:4,padding:"2px 6px",color:CA.muted,fontSize:9}}>MISSED</div>}
                              <div style={{color:CA.muted,fontSize:18}}>›</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── ACCOUNT TAB (admin only) ── */}
            {/* hooks-order fix: account tab is a real component, not a conditional IIFE (mirrors the sales-demo fix) */}
            {activeTab==="account"&&isAdmin&&!isMaster&&<AccountTab coach={coach} allCoaches={allCoaches} school={school} athletes={athletes} loadAll={loadAll}/>}

            {/* ── COACHES TAB (master only) ── */}
            {activeTab==="coaches"&&isMaster&&(
              <div style={{maxWidth:800}}>
                {/* School onboarding form */}
                <SchoolOnboardingForm onCreated={loadAll}/>


                {/* ── PR Recalculation ── */}
                <div style={{marginBottom:16,background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16}}>
                  <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:6}}>DATA MAINTENANCE</div>
                  <div style={{color:CA.muted2,fontSize:13,lineHeight:1.6,marginBottom:14}}>
                    Recalculates every athlete's PRs from their full workout history using the Epley estimated 1RM formula.
                    Run this once to correct records that were saved before the 1RM update. Takes a few seconds per athlete.
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:14}}>
                    <button
                      onClick={recalcAllPRs}
                      disabled={!!recalcStatus}
                      style={{background:recalcStatus?CA.navy3:CA_BTN,color:recalcStatus?CA.muted:"#fff",border:`1px solid ${recalcStatus?CA.border:CA.accent}`,boxShadow:recalcStatus?"none":`0 4px 16px ${CA_GLOW}`,borderRadius:10,padding:"10px 22px",cursor:recalcStatus?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,transition:"all 0.2s"}}>
                      {recalcStatus&&recalcStatus!=="done"&&recalcStatus!=="error"?"Recalculating...":"Recalculate All PRs"}
                    </button>
                    {recalcStatus&&(
                      <div style={{fontSize:13,color:recalcStatus==="done"?CA.green:recalcStatus==="error"?CA.red:CA.muted2,fontWeight:recalcStatus==="done"||recalcStatus==="error"?600:400}}>
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
// ─── OVERVIEW (Coach Dashboard home) ─────────────────────────────────────────
// Graphs-first team-health home. Every number here is computed LIVE, client-side,
// from the shared proofcore engine (Phase 0) over the roster data already loaded —
// zero tokens, no new round-trip. See docs/coach-experience-vision.md §1.
const DAYMS = 86400000;
// Fixed Mon–Sun calendar week. Single source of the "this week" window for the
// whole Overview — every stat card and the briefing share it (no rolling 7d).
const weekBounds = (ref=Date.now())=>{
  const d=new Date(ref); d.setHours(0,0,0,0);
  const todayIdx=(d.getDay()+6)%7;                    // Mon=0 … Sun=6
  const start=d.getTime()-todayIdx*DAYMS;
  const days=Array.from({length:7},(_,i)=>{
    const dd=new Date(start+i*DAYMS);
    return {t:start+i*DAYMS, l:"MTWTFSS"[i], full:dd.toLocaleDateString("en-US",{weekday:"short"}), d:dd.getDate()};
  });
  return {start, end:start+7*DAYMS, days, todayIdx};
};
const FEEL_ORDER = [["great","Great",CA.green],["good","Good",CA.blue],["average","OK",CA.amber],["rough","Rough",CA.red]];
// prE1RM, trueImprovementPRs, classifyTiers, blendAdherenceScore now live in
// proofcore (shared with the server Coach's Edition so the two never disagree).

function StatBand({tone,label}){
  const c = tone==="good"?CA.green:tone==="warn"?CA.amber:tone==="crit"?CA.red:CA.blue;
  return <span style={{fontSize:9,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",padding:"2px 8px",borderRadius:999,whiteSpace:"nowrap",color:c,background:`${c}22`,border:`1px solid ${c}55`}}>{label}</span>;
}
function OverviewCard({title,trend,children,readout,tone,style}){
  return (
    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:16,...style}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:10}}>
        <div style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:CA.faint}}>{title}</div>
        {trend&&<div style={{fontSize:11.5,fontWeight:700,color:trend.dir==="up"?CA.green:trend.dir==="down"?CA.red:CA.muted,whiteSpace:"nowrap"}}>{trend.dir==="up"?"▲":trend.dir==="down"?"▼":"—"} {trend.txt}</div>}
      </div>
      {children}
      {readout&&<div style={{marginTop:11,display:"flex",alignItems:"center",gap:8,fontSize:12,color:CA.muted2,lineHeight:1.4}}><span style={{flex:1}}>{readout}</span>{tone&&<StatBand tone={tone.k} label={tone.t}/>}</div>}
    </div>
  );
}

function CoachOverview({athletes,workouts,prs,manualRMs,prescriptions,onOpenAthlete,coach,changeRequests,briefContext,onPrefillProgram,onResolveRequest,onContextWritten,parsingIds}){
  const isMobile = useIsMobile();
  const [tip,setTip] = useState(null);
  // one-shot entrance flag: charts render at their empty state on first paint,
  // then sweep/draw to their real values once this flips (next frame).
  const [mounted,setMounted] = useState(false);
  useEffect(()=>{ const r=requestAnimationFrame(()=>requestAnimationFrame(()=>setMounted(true))); return ()=>cancelAnimationFrame(r); },[]);
  const [showAllHeat,setShowAllHeat] = useState(false);
  const [dayPick,setDayPick] = useState(null); // {athleteId, di} — heatmap cell → day inspector
  const D = useMemo(()=>{
    const now = Date.now();
    const dstart = (t)=>{const x=new Date(t);x.setHours(0,0,0,0);return x.getTime();};
    const inWin = (w,from,to=now)=>{const t=new Date(w.created_at).getTime();return t>=from&&t<to;};
    const woByAth={}, prByAth={}, manByAth={}, prescByAth={};
    workouts.forEach(w=>{(woByAth[w.athlete_id]=woByAth[w.athlete_id]||[]).push(w);});
    prs.forEach(p=>{(prByAth[p.athlete_id]=prByAth[p.athlete_id]||[]).push(p);});
    manualRMs.forEach(m=>{(manByAth[m.athlete_id]=manByAth[m.athlete_id]||[]).push(m);});
    prescriptions.forEach(pp=>{prescByAth[pp.athlete_id]=pp;});
    // Fixed Mon–Sun calendar week — the ONE week window every "this week" stat on
    // this screen shares (heatmap, donut, wins, pain, by-sport, triage).
    const wk = weekBounds(now);
    const weekAgo=wk.start, twoWk=wk.start-7*DAYMS;
    const todayIdx = wk.todayIdx;

    const rows = athletes.map(a=>{
      const wo = woByAth[a.id]||[];
      const thisWk = pcGroup(wo.filter(w=>inWin(w,weekAgo,wk.end)));
      const lastWk = pcGroup(wo.filter(w=>inWin(w,twoWk,weekAgo)));
      const parsed = prescByAth[a.id]?.parsed_json || null;
      const oneRMs = buildOneRMs(prByAth[a.id]||[], manByAth[a.id]||[]);
      const adherence = parsed ? compareProgramVsActual(parsed, thisWk, oneRMs) : null;
      const injuries = aggregateInjuries([...lastWk,...thisWk]);
      const hasProgram = !!(a.program_text && a.program_text.trim().length>10);
      const presDays = a.training_days_per_week || parsed?.blocks?.[0]?.days?.length || null;
      // adherence v2: exercise choice (50) > volume (30) > load (20), targets
      // pro-rated for how much of the fixed Mon–Sun week has elapsed
      const elapsedFrac = (todayIdx+1)/7;
      const score = blendAdherenceScore(thisWk.length, adherence, hasProgram, presDays, elapsedFrac);
      const adhB = adherenceBreakdown(adherence, elapsedFrac);
      const lastAt = (wo[0]&&new Date(wo[0].created_at).getTime())||null;
      const daysSince = lastAt?Math.floor((now-lastAt)/DAYMS):null;
      // per-day logged flags for the heatmap — fixed Mon..Sun; days after today = null (future)
      const days = wk.days.map((day,i)=> i>todayIdx ? null :
        (wo.some(w=>{const t=new Date(w.created_at).getTime();return t>=day.t&&t<day.t+DAYMS&&(w.parsed_data?.exercises?.length>0||w.parsed_data?.run_data);})?1:0));
      const snap = computeGritSnapshot(wo, manByAth[a.id]||[], {bodyweightLbs:a.weight_lbs||a.weight||0, gender:a.gender, age:a.age});
      // per-lift e1RM delta this week vs last (for the team strength-movement win)
      const twL=buildLiftHistory(thisWk), lwL=buildLiftHistory(lastWk);
      const lifts=Object.entries(twL).map(([lift,entries])=>{ const best=entries.reduce((x,y)=>y.e1rm>x.e1rm?y:x); const lw=lwL[lift]; let delta=null; if(lw){const lb=lw.reduce((x,y)=>y.e1rm>x.e1rm?y:x); delta=best.e1rm-lb.e1rm;} return {lift,deltaVsLastWeek:delta}; });
      return {a, thisWk, lastWk, adherence, injuries, hasProgram, score, adhB, daysSince, days, snap, lifts};
    });

    // sessions/day — fixed Mon–Sun; today renders but is EXCLUDED from line + slope
    // (an in-progress day always looks like a cliff otherwise)
    const dayLabels = wk.days;
    const dayCounts = wk.days.map(day=>athletes.reduce((s,a)=>s+pcGroup((woByAth[a.id]||[]).filter(w=>{const t=new Date(w.created_at).getTime();return t>=day.t&&t<day.t+DAYMS;})).length,0));
    const completed = dayCounts.slice(0,todayIdx);   // full days only
    const half = Math.floor(completed.length/2);
    const firstHalf = completed.slice(0,half).reduce((a,b)=>a+b,0)||0, lastHalf = completed.slice(completed.length-half).reduce((a,b)=>a+b,0)||0;
    const trendKnown = completed.length>=2;

    // active this week
    const activeCount = rows.filter(r=>r.thisWk.length>0).length;
    const activePct = athletes.length?Math.round(100*activeCount/athletes.length):0;

    // team adherence (only athletes with a score)
    const scored = rows.filter(r=>r.score!=null);
    const teamAdh = scored.length?Math.round(scored.reduce((s,r)=>s+r.score,0)/scored.length):null;
    const noProgram = rows.filter(r=>r.score==null).length;

    // session feel this week
    const feelCounts={great:0,good:0,average:0,rough:0}; let feelTotal=0;
    workouts.filter(w=>inWin(w,weekAgo)).forEach(w=>{const f=w.parsed_data?.session_feel; if(f&&feelCounts[f]!=null){feelCounts[f]++;feelTotal++;}});

    // volume-load: total working sets across roster, last 4 calendar weeks (current partial)
    const volWeeks=[];
    for(let i=3;i>=0;i--){ const from=wk.start-i*7*DAYMS, to=from+7*DAYMS;
      volWeeks.push(athletes.reduce((s,a)=>s+totalSetVolume(pcGroup((woByAth[a.id]||[]).filter(w=>inWin(w,from,to)))),0));
    }

    // true PRs — this week + last 6 weeks (calendar-week bars, current week partial)
    const truePRs = trueImprovementPRs(prs);
    const prWeeks=[];
    for(let i=5;i>=0;i--){ const from=wk.start-i*7*DAYMS, to=from+7*DAYMS;
      prWeeks.push(truePRs.filter(p=>{const t=new Date(p.created_at||p.date||0).getTime();return t>=from&&t<to;}).length);
    }
    const prThisWk = prWeeks[prWeeks.length-1];

    // strengths & weaknesses — avg Grit tier per benchmark lift across roster,
    // classified by tier threshold (shared with the server so both agree).
    const byBench={};
    rows.forEach(r=>r.snap.rankedLifts.forEach(l=>{const bk=getBenchKey(l.key)||l.benchKey; if(!bk)return; (byBench[bk]=byBench[bk]||{name:l.name,tiers:[]}).tiers.push(l.tierIdx);}));
    const benchAgg = Object.entries(byBench).map(([bk,v])=>{const avgTier=v.tiers.reduce((a,b)=>a+b,0)/v.tiers.length; return {bench:bk,name:v.name,avgTier,tierName:TIER_NAMES[Math.round(avgTier)],n:v.tiers.length};})
      .sort((a,b)=>b.avgTier-a.avgTier);
    const {strengths,weaknesses} = classifyTiers(benchAgg);

    // team strength movement — avg e1RM delta per lift this week (for wins + tooltips)
    const dlt={};
    rows.forEach(r=>(r.lifts||[]).forEach(l=>{ if(l.deltaVsLastWeek!=null)(dlt[l.lift]=dlt[l.lift]||[]).push(l.deltaVsLastWeek); }));
    const movers=Object.entries(dlt).map(([lift,ds])=>({lift,avg:+(ds.reduce((a,b)=>a+b,0)/ds.length).toFixed(1),n:ds.length})).filter(m=>m.avg>0).sort((a,b)=>b.avg-a.avg);

    // wins — a MIX of notable stats + personal bests, deduped so it's never the same
    // athlete twice and not always a person.
    const recentTrue=truePRs.filter(p=>new Date(p.created_at||p.date||0).getTime()>=weekAgo).sort((a,b)=>b.gain-a.gain);
    const seenAth=new Set(); const personalWins=[];
    for(const p of recentTrue){ if(seenAth.has(p.athlete_id))continue; seenAth.add(p.athlete_id);
      personalWins.push({icon:"🏆",title:(athletes.find(a=>a.id===p.athlete_id)||{}).name||"Athlete",detail:`${p.exercise} ${fmtWeight(p.weight,p.unit)} — +${Math.round(p.gain)} lbs e1RM`}); }
    const statWins=[];
    if(prThisWk>0) statWins.push({icon:"🔥",title:`${prThisWk} true PR${prThisWk!==1?"s":""}`,detail:"across the roster this week"});
    if(movers[0]) statWins.push({icon:"📈",title:`${movers[0].lift} +${movers[0].avg} lbs`,detail:`team avg e1RM${movers[0].n>1?` · ${movers[0].n} athletes`:""}`});
    if(teamAdh!=null&&teamAdh>=80) statWins.push({icon:"✅",title:`${teamAdh}% adherence`,detail:"team on plan this week"});
    if(activePct>=80) statWins.push({icon:"⚡",title:`${activePct}% active`,detail:`${activeCount} of ${athletes.length} training this week`});
    // interleave stat / personal so it reads varied
    const wins=[]; while(wins.length<4){ if(statWins.length)wins.push(statWins.shift()); if(wins.length>=4)break; if(personalWins.length)wins.push(personalWins.shift()); if(!statWins.length&&!personalWins.length)break; }
    // raw standouts for the shareable image export (same shape exportWins expects)
    const notablePRs = recentTrue.slice(0,6).map(p=>({athlete:(athletes.find(a=>a.id===p.athlete_id)||{}).name||"Athlete",exercise:p.exercise,weight:fmtWeight(p.weight,p.unit),gain:Math.round(p.gain)}));

    // roster extras (folded in from the old Group Stats tab): active-by-sport,
    // this-week pain flags, inactive athletes.
    const bySport={}; rows.forEach(r=>{ if(r.thisWk.length>0){ const s=r.a.sport||"—"; bySport[s]=(bySport[s]||0)+1; } });
    const weekPain=[]; workouts.filter(w=>inWin(w,weekAgo)).forEach(w=>{ const pf=w.parsed_data?.pain_flags; if(pf&&pf.length){ const a=athletes.find(x=>x.id===w.athlete_id); weekPain.push({name:a?.name||"Athlete",areas:pf.map(p=>p.area).join(", "),at:w.created_at}); } });
    const inactive=rows.filter(r=>r.thisWk.length===0).map(r=>{ const last=(woByAth[r.a.id]||[])[0]||(woByAth[r.a.id]||[]).slice(-1)[0]; const days=last?Math.floor((now-new Date(last.created_at).getTime())/DAYMS):null; return {name:r.a.name, days}; }).sort((a,b)=>(a.days??9999)-(b.days??9999));

    // briefing triage — ranked "who needs you today" (injury > quiet > adherence drop).
    // Quiet is days-since-last-session (window-independent — a fixed Mon–Sun week
    // would flag every weekend trainer on Monday morning otherwise); adherence
    // waits until Thursday so pro-rated early-week scores don't cry wolf.
    const triage=[];
    rows.forEach(r=>{
      const inj=r.injuries;
      if(inj&&((inj.recurring&&inj.recurring.length)||(inj.active&&inj.active.length))){
        const rec=inj.recurring&&inj.recurring[0]; const area=rec?rec.area:inj.active[0];
        triage.push({id:r.a.id,sev:"crit",kind:"Injury",name:r.a.name,what:`${area} flagged${rec?` ${rec.count} sessions running`:" this week"}`});
      } else if(r.daysSince!=null && r.daysSince>=5 && r.daysSince<=21){
        triage.push({id:r.a.id,sev:"warn",kind:"Quiet",name:r.a.name,what:`no session in ${r.daysSince} days`});
      } else if(todayIdx>=3 && r.score!=null && r.score<55){
        const b=r.adhB;
        let why="";
        if(b){ const parts=[["skipping prescribed lifts",b.E],["cutting sets short",b.V],...(b.W!=null?[["working lighter than prescribed",b.W]]:[])].sort((x,y)=>x[1]-y[1]); why=` — ${parts[0][0]}`; }
        triage.push({id:r.a.id,sev:"warn",kind:"Adherence",name:r.a.name,what:`adherence slipping (${r.score}%)${why}`});
      }
    });
    triage.sort((a,b)=>(a.sev==="crit"?0:1)-(b.sev==="crit"?0:1));

    return {rows,dayCounts,dayLabels,todayIdx,trendKnown,firstHalf,lastHalf,activeCount,activePct,teamAdh,noProgram,volWeeks,prWeeks,prThisWk,strengths,weaknesses,wins,notablePRs,movers,bySport,weekPain,inactive,triage};
  },[athletes,workouts,prs,manualRMs,prescriptions]);

  // count-up KPI figures (jump to final under reduced-motion) — declared before the
  // early return so hook order stays stable across renders.
  const adhCU = useCountUp(D.teamAdh==null?0:D.teamAdh);
  const activeCU = useCountUp(D.activePct||0);

  if(!athletes.length) return <div style={{textAlign:"center",padding:60,color:CA.muted}}>No athletes on your roster yet.</div>;

  const volMax = Math.max(1,...D.volWeeks), prMax = Math.max(1,...D.prWeeks), sMax = Math.max(1,...D.dayCounts.slice(0,D.todayIdx+1));
  const cell = (v)=>v?CA.green:CA.navy3;
  // red → green gradient across the 0–100 adherence blend (hue 0 → 120) — health
  // semantic, so it stays a true red→green scale (hsl, palette-independent).
  const adhColor = (s)=>s==null?CA.muted:`hsl(${Math.round(1.2*Math.max(0,Math.min(100,s)))},62%,48%)`;
  const adhTip = (r)=>{
    if(r.score==null) return "No program to grade against";
    const b=r.adhB;
    if(!b) return `${r.score}% — sessions vs prescribed days (program not parsed yet)`;
    return `${r.score}% · Exercises ${b.E}% · Volume ${b.V}%${b.W!=null?` · Weights ${b.W}%`:""} — weighted 50/30/20, pro-rated for mid-week`;
  };
  // Hover tooltip shared across every chart data point.
  const tipOn = (text)=>({onMouseEnter:(e)=>setTip({x:e.clientX,y:e.clientY,text}),onMouseMove:(e)=>setTip({x:e.clientX,y:e.clientY,text}),onMouseLeave:()=>setTip(null)});
  const wkLabel = (i)=>i===D.prWeeks.length-1?"This week":`${D.prWeeks.length-1-i} wk ago`;
  const span = (n)=>isMobile?{}:{gridColumn:`span ${n}`};
  // adherence heatmap rows: worst adherence first (needs attention); truncation is
  // labeled + expandable so the coach knows it's a sample, not the roster
  const heatEligible = [...D.rows].filter(r=>r.hasProgram||r.thisWk.length>0)
    .sort((a,b)=>((a.score??999)-(b.score??999)));
  const heatRows = showAllHeat?heatEligible:heatEligible.slice(0,6);

  const secLabel = (t)=>(
    <div style={{display:"flex",alignItems:"center",gap:12,margin:"24px 2px 12px"}}>
      <span style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:CA.faint}}>{t}</span>
      <span style={{height:1,background:CA.line2,flex:1}}/>
    </div>
  );

  return (
    <div>
      {/* ── The Morning Brief — proof-feed-style daily conversation ── */}
      <MorningBrief D={D} athletes={athletes} changeRequests={changeRequests||[]} coach={coach} briefContext={briefContext||[]}
        onOpenAthlete={onOpenAthlete} onPrefillProgram={onPrefillProgram} onResolveRequest={onResolveRequest} onContextWritten={onContextWritten}/>

      {secLabel("Team Health")}
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(6,minmax(0,1fr))",gap:14}}>

        {/* Program adherence + heatmap — widest tile */}
        <OverviewCard style={span(4)} title="Program adherence · this week"
          readout={D.teamAdh==null?`No parsed programs yet — assign & lock programs to track adherence.`:`Team average. ${D.noProgram>0?`${D.noProgram} without a program (excluded).`:"Everyone has a program."}`}
          tone={D.teamAdh==null?null:(D.teamAdh>=80?{k:"good",t:"Healthy"}:D.teamAdh>=60?{k:"warn",t:"Slipping"}:{k:"crit",t:"At risk"})}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:46,color:adhColor(D.teamAdh),lineHeight:.9}}>{D.teamAdh==null?"—":Math.round(adhCU)}<span style={{fontSize:18,color:CA.muted}}> {D.teamAdh==null?"":"% team avg"}</span></div>
          <div style={{fontSize:10.5,color:CA.muted,marginTop:4}}>Exercise choice 50 · volume 30 · weight 20 — graded red → green</div>
          <div style={{maxHeight:showAllHeat?340:"none",overflowY:showAllHeat?"auto":"visible"}}>
          <div style={{display:"grid",gridTemplateColumns:"92px repeat(7,minmax(0,1fr)) 42px",gap:5,alignItems:"center",marginTop:14}}>
            <span/>{D.dayLabels.map((l,i)=><span key={i} style={{fontSize:10,color:i===D.todayIdx?CA.cyan:CA.muted,textAlign:"center",fontWeight:i===D.todayIdx?800:400}}>{l.l}<div style={{fontSize:8,opacity:.75}}>{l.d}</div></span>)}
            <span style={{fontSize:9,color:CA.muted,textAlign:"right",letterSpacing:.5}}>ADH</span>
            {heatRows.flatMap((r,ri)=>[
              <span key={`n${ri}`} style={{fontSize:11.5,color:CA.muted2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.a.name}</span>,
              ...r.days.map((d,di)=>{
                const picked = dayPick&&dayPick.athleteId===r.a.id&&dayPick.di===di;
                return <i key={`c${ri}-${di}`} className="c-fade"
                  onClick={()=>{ if(d===1) setDayPick(picked?null:{athleteId:r.a.id,di}); }}
                  style={{aspectRatio:"1",borderRadius:3,background:d==null?"transparent":r.hasProgram?cell(d):(d?CA.accent:CA.navy3),opacity:d==null?1:r.hasProgram?1:.55,border:picked?`2px solid ${CA.cyan}`:d==null?`1px dashed ${CA.border}`:`1px solid ${CA.line2}22`,boxShadow:picked?`0 0 8px ${CA.cyan}66`:"none",cursor:d===1?"pointer":"default",["--d"]:`${Math.min(780,(ri*7+di)*16)}ms`}}
                  {...tipOn(`${r.a.name.split(" ")[0]} · ${D.dayLabels[di].full} ${D.dayLabels[di].d}: ${d==null?"upcoming":d?"logged a session — tap to inspect":"no session"}${r.hasProgram?"":" (no program)"}`)}/>;
              }),
              <span key={`s${ri}`} style={{fontSize:11,fontWeight:800,textAlign:"right",color:adhColor(r.score),cursor:"pointer"}} {...tipOn(adhTip(r))}>{r.score==null?"—":`${r.score}`}</span>
            ])}
          </div>
          </div>
          {heatEligible.length>6&&(
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:10,gap:8}}>
              <span style={{fontSize:11,color:CA.muted}}>Showing {heatRows.length} of {heatEligible.length} · worst adherence first</span>
              <button onClick={()=>setShowAllHeat(s=>!s)} style={{border:`1px solid ${CA.border}`,background:"transparent",color:CA.muted2,borderRadius:7,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>{showAllHeat?"Show less":"Show all"}</button>
            </div>
          )}
        </OverviewCard>

        {/* Active this week gauge */}
        <OverviewCard style={span(2)} title="Active this week"
          readout={`${D.activeCount} of ${athletes.length} logged at least once.`}
          tone={D.activePct>=70?{k:"good",t:"Healthy"}:D.activePct>=50?{k:"warn",t:"Watch"}:{k:"crit",t:"Low"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",paddingTop:6}}>
            <svg viewBox="0 0 120 120" style={{width:"100%",maxWidth:150}} {...tipOn(`${D.activeCount} of ${athletes.length} active — ${D.activePct}%`)}>
              <circle cx="60" cy="60" r="50" fill="none" stroke={CA.navy3} strokeWidth="12"/>
              <circle cx="60" cy="60" r="50" fill="none" stroke={CA.cyan} strokeWidth="12" strokeLinecap="round"
                strokeDasharray={2*Math.PI*50} strokeDashoffset={2*Math.PI*50*(1-(mounted?D.activePct:0)/100)} transform="rotate(-90 60 60)"
                style={{transition:"stroke-dashoffset 900ms cubic-bezier(.2,.7,.2,1)",filter:`drop-shadow(0 0 6px ${CA.cyan}80)`}}/>
              <text x="60" y="58" textAnchor="middle" fill={CA.led} fontFamily="'Bebas Neue'" fontSize="30">{Math.round(activeCU)}%</text>
              <text x="60" y="76" textAnchor="middle" fill={CA.muted} fontSize="11">{D.activeCount} / {athletes.length}</text>
            </svg>
          </div>
          {/* Day inspector — tap a logged heatmap cell and this space fills with the
              session that was logged + why the athlete's week scores what it does */}
          {(()=>{
            if(!dayPick) return <div style={{marginTop:10,fontSize:11,color:CA.faint,textAlign:"center"}}>Tap a green day on the heatmap to see what was logged.</div>;
            const r = D.rows.find(x=>x.a.id===dayPick.athleteId);
            const day = D.dayLabels[dayPick.di];
            if(!r||!day) return null;
            const first = r.a.name.split(" ")[0];
            // entries logged inside that calendar day, across the week's sessions
            const entries = r.thisWk.flat().filter(w=>{const t=new Date(w.created_at).getTime();return t>=day.t&&t<day.t+DAYMS;});
            const exs = entries.flatMap(w=>w.parsed_data?.exercises||[]);
            const runs = entries.map(w=>w.parsed_data?.run_data).filter(Boolean);
            const feel = entries.map(w=>w.parsed_data?.session_feel).find(Boolean);
            const pains = entries.flatMap(w=>w.parsed_data?.pain_flags||[]);
            const exLine = (ex)=>{
              const sets = getExerciseSets(ex); const working = sets.some(s=>!s.warmup)?sets.filter(s=>!s.warmup):sets;
              const reps = working.reduce((m,s)=>Math.max(m,s.reps||0),0)||ex.reps||0;
              const top = working.reduce((m,s)=>Math.max(m,toLbs(s.weight||0,ex.unit||"lbs")),0)||toLbs(ex.weight||0,ex.unit||"lbs");
              return `${working.length||ex.sets||1}×${reps||"?"}${top?` @ ${Math.round(top)}lbs`:""}`;
            };
            const b = r.adhB;
            const byLift = (r.adherence?.byLift||[]).slice(0,5);
            return (
              <div className="proof-drop" style={{marginTop:10,borderTop:`1px solid ${CA.border}`,paddingTop:10}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:6}}>
                  <span style={{fontSize:11,fontWeight:800,letterSpacing:.8,textTransform:"uppercase",color:CA.cyan}}>{first} · {day.full} {day.d}</span>
                  <button onClick={()=>setDayPick(null)} style={{border:"none",background:"transparent",color:CA.muted,fontSize:14,cursor:"pointer",lineHeight:1}}>✕</button>
                </div>
                {exs.length===0&&runs.length===0&&<div style={{fontSize:12,color:CA.muted}}>Logged, but no parsed exercises on this one.</div>}
                {exs.slice(0,7).map((ex,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:12,padding:"3px 0"}}>
                    <span style={{color:CA.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{ex.name}</span>
                    <span style={{color:CA.muted2,flexShrink:0,fontVariantNumeric:"tabular-nums"}}>{exLine(ex)}</span>
                  </div>
                ))}
                {exs.length>7&&<div style={{fontSize:11,color:CA.faint}}>+{exs.length-7} more</div>}
                {runs.length>0&&<div style={{fontSize:12,color:CA.muted2,padding:"3px 0"}}>🏃 Run logged</div>}
                {(feel||pains.length>0)&&(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:6}}>
                    {feel&&<span style={{fontSize:10,fontWeight:700,color:CA.muted2,background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:999,padding:"2px 8px"}}>felt: {feel}</span>}
                    {pains.slice(0,3).map((p,i)=><span key={i} style={{fontSize:10,fontWeight:700,color:CA.red,background:`${CA.red}18`,border:`1px solid ${CA.red}55`,borderRadius:999,padding:"2px 8px"}}>⚠ {p.area}</span>)}
                  </div>
                )}
                <div style={{fontSize:10.5,fontWeight:800,letterSpacing:.8,textTransform:"uppercase",color:CA.muted,margin:"12px 0 6px"}}>Why {first}'s week = <span style={{color:adhColor(r.score)}}>{r.score==null?"—":`${r.score}%`}</span></div>
                {!b&&<div style={{fontSize:11.5,color:CA.muted}}>{
                  parsingIds&&parsingIds.has(r.a.id) ? "Parsing this program now — tap the cell again in a moment."
                  : !r.hasProgram ? "No program assigned — nothing to grade against."
                  : r.adherence ? "This program has no gradeable lifts — it reads as a note, not a prescription. Score is sessions vs prescribed days."
                  : "Program isn't parsed yet — it parses automatically on the next dashboard load. Score is sessions vs prescribed days."
                }</div>}
                {b&&[["Exercise choice",b.E,.5],["Volume (sets×reps)",b.V,.3],["Working weight",b.W,.2]].map(([lab,v,wt],i)=>v==null?null:(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"2px 0"}}>
                    <span style={{width:118,fontSize:11,color:CA.muted2,flexShrink:0}}>{lab}</span>
                    <span style={{flex:1,height:5,borderRadius:3,background:CA.navy3,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${v}%`,background:adhColor(v)}}/></span>
                    <span style={{width:32,fontSize:11,fontWeight:800,textAlign:"right",color:adhColor(v),fontVariantNumeric:"tabular-nums"}}>{v}</span>
                  </div>
                ))}
                {b&&byLift.length>0&&(
                  <div style={{marginTop:8}}>
                    {byLift.map((l,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:11,padding:"2px 0"}}>
                        <span style={{color:l.matched?CA.muted2:CA.red,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.matched?"✓":"✗"} {l.lift}</span>
                        <span style={{color:CA.faint,flexShrink:0,fontVariantNumeric:"tabular-nums"}}>
                          {l.matched?`${l.actualSets||0}×${l.actualReps||0} of ${l.prescribedSets}×${l.prescribedReps}${l.prescribedLoad?` · ${l.actualLoad??"?"} vs ${l.prescribedLoad}lbs`:""}`:"skipped this week"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </OverviewCard>

        {/* Sessions/day — fixed Mon–Sun; today plotted hollow, excluded from line + slope */}
        <OverviewCard style={span(3)} title="Sessions / day · this week"
          trend={{dir:!D.trendKnown||D.lastHalf>=D.firstHalf?"up":"down",txt:`${D.dayCounts.slice(0,D.todayIdx+1).reduce((a,b)=>a+b,0)} so far`}}
          readout={!D.trendKnown?"Week just started — trend fills in as sessions come in.":D.lastHalf>=D.firstHalf?"Holding or climbing into the week.":"Sliding off through the week — worth a nudge."}
          tone={!D.trendKnown?null:D.lastHalf>=D.firstHalf?{k:"good",t:"Healthy"}:{k:"warn",t:"Watch"}}>
          <ChartBox h={96}>{w=>{
            const px=i=>5+(w-10)*(i/6), py=v=>84-72*(v/sMax);
            // line covers only the days strictly before today (today is in-progress)
            const linePts=D.dayCounts.slice(0,D.todayIdx).map((v,i)=>`${px(i)},${py(v)}`).join(" ");
            return <>
              <line x1="0" y1="86" x2={w} y2="86" stroke={CA.border}/>
              {D.todayIdx>=2&&<polyline className="c-draw" fill="none" stroke={CA.cyan} strokeWidth="2.5" points={linePts} style={{filter:`drop-shadow(0 0 5px ${CA.cyan}99)`}}/>}
              {D.dayCounts.map((v,i)=>{
                if(i>D.todayIdx) return null;
                const cx=px(i), cy=py(v);
                return i===D.todayIdx
                  ? <circle key={i} className="c-fade" style={{cursor:"pointer",["--d"]:`${900+i*60}ms`}} cx={cx} cy={cy} r="5.5" fill={CA.navy2} stroke={CA.cyan} strokeWidth="2" strokeDasharray="3 2" {...tipOn(`${D.dayLabels[i].full} ${D.dayLabels[i].d} (today, in progress): ${v} session${v!==1?"s":""}`)}/>
                  : <circle key={i} className="c-fade" style={{cursor:"pointer",["--d"]:`${900+i*60}ms`}} cx={cx} cy={cy} r="4.5" fill={CA.cyan} {...tipOn(`${D.dayLabels[i].full} ${D.dayLabels[i].d}: ${v} session${v!==1?"s":""}`)}/>;
              })}
            </>;
          }}</ChartBox>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:9.5,color:CA.dim||CA.muted,marginTop:2}}>{D.dayLabels.map((l,i)=><span key={i} style={{opacity:i>D.todayIdx?.35:1,fontWeight:i===D.todayIdx?800:400,color:i===D.todayIdx?CA.cyan:undefined}}>{l.l}</span>)}</div>
        </OverviewCard>

        {/* True PRs bars */}
        <OverviewCard style={span(3)} title="True PRs · 6 wk"
          trend={{dir:"up",txt:`${D.prThisWk} this wk`}}
          readout={D.prThisWk>0?`Real improvements over prior bests — baselines excluded.`:`No new bests logged this week yet.`}
          tone={D.prThisWk>0?{k:"good",t:"Momentum"}:null}>
          <ChartBox h={96}>{w=>{
            const n=D.prWeeks.length, slot=w/n, barW=Math.min(30,slot*0.5);
            return <>
              <defs><linearGradient id="prBar" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor={CA.accent}/><stop offset="0.8" stopColor={CA.accent}/><stop offset="1" stopColor={CA.cyan}/></linearGradient></defs>
              <line x1="0" y1="88" x2={w} y2="88" stroke={CA.border}/>
              {D.prWeeks.map((v,i)=>{const x=slot*i+(slot-barW)/2;const h=Math.max(3,72*(v/prMax));const last=i===n-1;return <rect key={i} className="c-rise" x={x} y={88-h} width={barW} height={h} rx="3" fill="url(#prBar)" style={{transformBox:"fill-box",transformOrigin:"bottom",["--d"]:`${i*40}ms`,cursor:"pointer",filter:last?`drop-shadow(0 0 6px ${CA.cyan}88)`:"none"}} {...tipOn(`${wkLabel(i)}: ${v} PR${v!==1?"s":""}`)}/>;})}
            </>;
          }}</ChartBox>
        </OverviewCard>

        {/* Team volume — full-width band */}
        <OverviewCard style={span(6)} title="Team volume · 4 wk"
          trend={{dir:D.volWeeks[3]>=D.volWeeks[0]?"up":"down",txt:"working sets"}}
          readout={D.volWeeks[3]>D.volWeeks[0]*1.5?"Sharp jump vs 4 weeks ago — watch load spikes.":"Gradual, inside a safe band."}
          tone={D.volWeeks[3]>D.volWeeks[0]*1.5?{k:"warn",t:"Watch"}:{k:"good",t:"Healthy"}}>
          <ChartBox h={80}>{w=>{
            const px=i=>6+(w-12)*(i/(D.volWeeks.length-1)), py=v=>70-60*(v/volMax);
            const pts=D.volWeeks.map((v,i)=>`${px(i)},${py(v)}`).join(" ");
            return <>
              <line x1="0" y1="78" x2={w} y2="78" stroke={CA.border}/>
              <polygon className="c-fade" style={{["--d"]:"280ms"}} fill={`${CA.cyan}12`} stroke="none" points={`${px(0)},78 ${pts} ${px(D.volWeeks.length-1)},78`}/>
              <polyline className="c-draw" fill="none" stroke={CA.cyan} strokeWidth="2.5" points={pts} style={{filter:`drop-shadow(0 0 5px ${CA.cyan}99)`}}/>
              {D.volWeeks.map((v,i)=><circle key={i} className="c-fade" style={{cursor:"pointer",["--d"]:`${1000+i*80}ms`}} cx={px(i)} cy={py(v)} r="4.5" fill={CA.cyan} {...tipOn(`${i===3?"This week":`${3-i} wk ago`}: ${v} sets`)}/>)}
            </>;
          }}</ChartBox>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:CA.muted,marginTop:2}}>{D.volWeeks.map((v,i)=><span key={i}>{i===3?"This wk":`${3-i}w ago`}</span>)}</div>
        </OverviewCard>

      </div>

      {secLabel("Program & Wins")}
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:14}}>
        {/* Strengths & weaknesses */}
        <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:16}}>
          <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:CA.muted2,fontWeight:700}}>Where the program is strong &amp; weak</div>
          <div style={{fontSize:12,color:CA.muted2,margin:"8px 0 14px",lineHeight:1.4}}>Team Grit tiers by benchmark lift. Where the roster skews high, the program builds well; low tiers flag a gap.</div>
          {D.strengths.length===0&&D.weaknesses.length===0&&<div style={{fontSize:12,color:CA.muted}}>Not enough ranked lifts logged yet.</div>}
          {D.strengths.length>0&&<div style={{fontSize:9.5,letterSpacing:1,textTransform:"uppercase",color:CA.green,fontWeight:800,marginBottom:4}}>Strengths</div>}
          {D.strengths.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",cursor:"pointer"}} {...tipOn(`${s.name}: ${s.tierName} team avg · ${s.n} athlete${s.n!==1?"s":""} ranked`)}>
              <span style={{width:120,fontSize:12.5,color:CA.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
              <span style={{flex:1,height:7,borderRadius:4,background:CA.navy3,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*(s.avgTier+1)/8)}%`,background:CA.green}}/></span>
              <span style={{fontSize:10,fontWeight:800,width:74,textAlign:"right",color:CA.green}}>{s.tierName}</span>
            </div>
          ))}
          {D.weaknesses.length>0&&<div style={{fontSize:9.5,letterSpacing:1,textTransform:"uppercase",color:CA.red,fontWeight:800,margin:"14px 0 4px"}}>Weaknesses</div>}
          {D.weaknesses.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",cursor:"pointer"}} {...tipOn(`${s.name}: ${s.tierName} team avg · ${s.n} athlete${s.n!==1?"s":""} ranked`)}>
              <span style={{width:120,fontSize:12.5,color:CA.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
              <span style={{flex:1,height:7,borderRadius:4,background:CA.navy3,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*(s.avgTier+1)/8)}%`,background:CA.red}}/></span>
              <span style={{fontSize:10,fontWeight:800,width:74,textAlign:"right",color:CA.red}}>{s.tierName}</span>
            </div>
          ))}
          {/* Grit ladder legend — decodes the tier names on the rows above */}
          <div style={{marginTop:14,paddingTop:12,borderTop:`1px solid ${CA.border}80`}}>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {TIER_NAMES.map((t,i)=>(
                <span key={t} style={{fontSize:9,fontWeight:800,letterSpacing:.6,textTransform:"uppercase",padding:"2px 7px",borderRadius:5,background:CA.navy3,border:`1px solid ${CA.border}`,color:`hsl(${140*(i/(TIER_NAMES.length-1))},60%,${45+20*(i/(TIER_NAMES.length-1))}%)`}} {...tipOn(`Grit tier ${i+1} of ${TIER_NAMES.length}`)}>{t}</span>
              ))}
            </div>
            <div style={{fontSize:10.5,color:CA.muted,marginTop:6}}>The Grit ladder, low → high. Bar = roster's average tier for that lift.</div>
          </div>
        </div>

        {/* Wins — mixed notable stats + deduped personal bests */}
        <div style={{background:`linear-gradient(180deg,${CA.navy3},${CA.navy2})`,border:`1px solid ${CA.accent}44`,borderRadius:14,padding:16}}>
          <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:CA.accent,fontWeight:700}}>Wins this week</div>
          {D.wins.length===0
            ? <div style={{fontSize:12,color:CA.muted2,marginTop:12}}>No wins logged yet this week — check back as sessions come in.</div>
            : <div style={{marginTop:12}}>
                {D.wins.map((w,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<D.wins.length-1?`1px solid ${CA.border}80`:"none"}}>
                    <span style={{width:30,height:30,borderRadius:8,background:`${CA.accent}22`,border:`1px solid ${CA.accent}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>{w.icon}</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:13,color:CA.text}}>{w.title}</div>
                      <div style={{color:CA.muted2,fontSize:12}}>{w.detail}</div>
                    </div>
                  </div>
                ))}
              </div>}
          {(D.prThisWk>0||D.notablePRs.length>0)&&(
            <button onClick={()=>exportWins({newPRs:D.prThisWk,notablePRs:D.notablePRs,activePct:D.activePct,adherenceAvg:D.teamAdh},coach)}
              style={{marginTop:12,width:"100%",background:CA_BTN,color:"#fff",border:"none",borderRadius:9,padding:10,fontWeight:800,letterSpacing:1,textTransform:"uppercase",fontSize:12,cursor:"pointer",boxShadow:`0 0 14px ${CA_GLOW}`,fontFamily:"'DM Sans'"}}>⤓ Share as image</button>
          )}
        </div>
      </div>

      {/* Roster — folded in from the old Group Stats tab */}
      {(Object.keys(D.bySport).length>0||D.weekPain.length>0||D.inactive.length>0)&&secLabel("Roster")}
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"repeat(auto-fit,minmax(240px,1fr))",gap:14}}>
        {D.inactive.length>0&&(
          <div style={{background:CA.navy2,border:`1px solid ${CA.amber}40`,borderRadius:14,padding:16}}>
            <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:CA.amber,fontWeight:700,marginBottom:10}}>No sessions this week ({D.inactive.length})</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {D.inactive.map((a,i)=>(
                <div key={i} style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:8,padding:"6px 11px"}}>
                  <div style={{color:CA.text,fontSize:12.5,fontWeight:600}}>{a.name}</div>
                  <div style={{color:CA.muted,fontSize:10.5}}>{a.days==null?"never logged":`${a.days}d ago`}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {D.weekPain.length>0&&(
          <div style={{background:CA.navy2,border:`1px solid ${CA.red}40`,borderRadius:14,padding:16}}>
            <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:CA.red,fontWeight:700,marginBottom:10}}>Pain flags this week</div>
            {D.weekPain.slice(0,8).map((p,i)=>(
              <div key={i} style={{padding:"5px 0",borderBottom:`1px solid ${CA.border}40`,fontSize:12}}>
                <span style={{color:CA.text,fontWeight:600}}>{p.name}</span><span style={{color:CA.muted}}> — {p.areas}</span>
              </div>
            ))}
          </div>
        )}
        {Object.keys(D.bySport).length>0&&(
          <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:16}}>
            <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:CA.muted2,fontWeight:700,marginBottom:10}}>Active by sport</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {Object.entries(D.bySport).sort((a,b)=>b[1]-a[1]).map(([sport,count])=>(
                <div key={sport} style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:8,padding:"8px 13px"}}>
                  <div style={{color:CA.text,fontWeight:600,fontSize:13}}>{sport}</div>
                  <div style={{color:CA.muted,fontSize:11}}>{count} active</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* floating hover tooltip */}
      {tip&&<div style={{position:"fixed",left:Math.min(tip.x+14,(typeof window!=="undefined"?window.innerWidth:9999)-220),top:tip.y+14,background:CA.navy,border:`1px solid ${CA.accent}`,borderRadius:8,padding:"6px 10px",fontSize:12,color:CA.text,pointerEvents:"none",zIndex:200,boxShadow:"0 6px 20px rgba(0,0,0,0.5)",maxWidth:220}}>{tip.text}</div>}
    </div>
  );
}

// ─── THE MORNING BRIEF — daily conversation over the triage (see spec §C) ──────
// The proof-feed pattern turned toward the coach: a collapsed headline that opens
// into a beat-by-beat walkthrough of highs, lows and trends, with suggestions the
// coach decides on (Apply/Edit/Skip · handled/watching/dismiss) and 1–2 questions.
// Beats are deterministic templates (coachBrief.js — zero tokens); Haiku reacts
// only when the coach free-types. Every action writes a coach_context row, which
// (a) suppresses that flag for the rest of the ISO week and (b) flows into next
// week's Coach's Edition prompt via generateCoach — the follow-through loop.
function MorningBrief({D,athletes,changeRequests,coach,briefContext,onOpenAthlete,onPrefillProgram,onResolveRequest,onContextWritten}){
  const isMobile = useIsMobile();
  const [open,setOpen] = useState(false);
  const [brief,setBrief] = useState(null);      // snapshot while open — beats don't vanish mid-conversation
  const [outcomes,setOutcomes] = useState({});  // beatId -> outcome chip label
  const [qMsgs,setQMsgs] = useState({});        // beatId -> [{role,text}] reply thread
  const [qDone,setQDone] = useState({});        // beatId -> answered
  const [inputs,setInputs] = useState({});      // beatId -> draft text (every open question has its own box)
  const [busy,setBusy] = useState(false);

  const week = briefWeekKey();
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const cleared = useMemo(()=>{
    const s=new Set();
    (briefContext||[]).forEach(r=>{const m=r.meta||{}; if(m.source==="morning_brief"&&m.kind==="decision"&&m.week===week&&m.athlete_id&&m.flag) s.add(`${m.athlete_id}:${m.flag}`);});
    return s;
  },[briefContext,week]);
  // Cheap + pure — recomputes for the collapsed headline as decisions land.
  const preview = useMemo(()=>buildMorningBrief({D,athletes,changeRequests,cleared,dateKey}),[D,athletes,changeRequests,cleared,dateKey]);
  const concernsLeft = preview.beats.filter(b=>b.kind==="concern").length;

  const openBrief = ()=>{ setBrief(preview); setOutcomes({}); setQMsgs({}); setQDone({}); setOpen(true); try{track("brief_open","coach_dashboard");}catch(e){} };

  const writeContext = async (note,meta)=>{
    const row={coach_id:coach.id, note, meta, is_long_term:false};
    await sbInsert("coach_context",row);
    onContextWritten&&onContextWritten({...row,created_at:new Date().toISOString()});
  };

  const act = async (beat,action)=>{
    if(busy) return;
    if(action.kind==="open_athlete"){ onOpenAthlete&&onOpenAthlete(beat.athleteId); return; }
    if(action.kind==="share_wins"){ exportWins({newPRs:D.prThisWk,notablePRs:D.notablePRs},coach); setOutcomes(o=>({...o,[beat.id]:"Shared ✓"})); return; }
    if(action.kind==="done"){ setOutcomes(o=>({...o,[beat.id]:"Done ✓"})); return; }
    setBusy(true);
    try{
      if(action.kind==="resolve_request"&&action.payload?.resolution!=="edit"){
        await onResolveRequest(action.payload.requestId, action.payload.resolution);
      }
      // "Edit" on a request and "Draft the change" both hand off to the program
      // editor with the suggestion prefilled — the coach stays the author.
      const handsOff = action.kind==="prefill_program"||(action.kind==="resolve_request"&&action.payload?.resolution==="edit");
      await writeContext(decisionNote(beat,action.id), {kind:"decision",source:"morning_brief",athlete_id:beat.athleteId||null,flag:beat.meta?.baseFlag||beat.flag||null,action:action.id,week});
      setOutcomes(o=>({...o,[beat.id]:`${action.label} ✓`}));
      try{track("brief_decision","coach_dashboard");}catch(e){}
      if(handsOff) onPrefillProgram&&onPrefillProgram(beat.athleteId, action.payload?.suggestion||beat.meta?.reason||beat.prose);
    }catch(e){ console.error("brief action",e); }
    setBusy(false);
  };

  const answerQuestion = async (beat,text,viaChip)=>{
    const t=String(text||"").trim(); if(!t||busy) return;
    setInputs(v=>({...v,[beat.id]:""}));
    setQMsgs(m=>({...m,[beat.id]:[...(m[beat.id]||[]),{role:"coach",text:t}]}));
    setBusy(true);
    try{
      if(!viaChip&&isAskingBack(t)){
        // Coach asked back — answer briefly, stay on the question. (Haiku, ~250 tok)
        const sys=`You are WILCO, a strength coach's AI assistant, mid morning-brief. Answer the coach's question directly in 1-2 sentences, grounded in the team read, then stop. Team read: ${D.activeCount}/${athletes.length} trained this week, ${D.prThisWk} true PRs, team adherence ${D.teamAdh??"n/a"}%.`;
        const reply=await askClaude(sys,`You asked them: "${beat.question.text}"\nThe coach replied: "${t}"`,250,[],"claude-haiku-4-5","coach_brief");
        setQMsgs(m=>({...m,[beat.id]:[...(m[beat.id]||[]),{role:"wilco",text:reply||"Your call either way."}]}));
        setBusy(false); return;
      }
      if(!viaChip){
        // One-sentence reaction before moving on (Haiku, ~160 tok) — chips skip AI entirely.
        const sys=`You are WILCO, a strength coach's AI assistant. React to the coach's answer in ONE short, direct sentence — acknowledge it and note one concrete implication if there is one. No follow-up question. Team: ${D.activeCount}/${athletes.length} trained this week, adherence ${D.teamAdh??"n/a"}%.`;
        const reply=await askClaude(sys,`Q: "${beat.question.text}"\nCoach: "${t}"`,160,[],"claude-haiku-4-5","coach_brief");
        if(reply) setQMsgs(m=>({...m,[beat.id]:[...(m[beat.id]||[]),{role:"wilco",text:reply}]}));
      }
      await writeContext(`${beat.question.text} → ${t}`.slice(0,280), {kind:"notes",source:"morning_brief",week,...(beat.athleteId?{athlete_id:beat.athleteId}:{})});
      setQDone(d=>({...d,[beat.id]:true}));
    }catch(e){ console.error("brief answer",e); setQDone(d=>({...d,[beat.id]:true})); }
    setBusy(false);
  };

  // ONE primary-styled action max (CA_BTN + white); the rest are calm ghost buttons.
  const btnS=(primary)=>({border:primary?"none":`1px solid ${CA.border}`,background:primary?CA_BTN:"transparent",color:primary?"#fff":CA.muted2,borderRadius:8,padding:"6px 12px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'",boxShadow:primary?`0 0 12px ${CA_GLOW}`:"none",opacity:busy?.6:1});
  // injury/request = attention semantics (red for hard flags, amber for the rest).
  const flagColor=(b)=>b.flag==="injury"||b.flag==="request"?CA.red:CA.amber;

  // ── collapsed headline card ──
  if(!open) return (
    <div style={{background:`linear-gradient(180deg,${CA.navy3},${CA.navy2})`,border:`1px solid ${CA.border}`,borderRadius:16,marginTop:4,padding:"16px 18px",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:220}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:CA.text,letterSpacing:1}}>{preview.headline}</div>
        <div style={{color:CA.muted,fontSize:12,marginTop:2}}>
          {concernsLeft>0?`${concernsLeft} to handle · `:""}{D.prThisWk} true PR{D.prThisWk!==1?"s":""} this week{D.teamAdh!=null?` · ${D.teamAdh}% adherence`:""} · updates as sessions come in
        </div>
      </div>
      <button onClick={openBrief} style={{background:CA_BTN,border:"none",color:"#fff",borderRadius:10,padding:"11px 20px",fontWeight:800,letterSpacing:1,textTransform:"uppercase",fontSize:12,cursor:"pointer",boxShadow:`0 0 14px ${CA_GLOW}`,fontFamily:"'DM Sans'",flexShrink:0}}>Open brief →</button>
    </div>
  );

  // ── open conversation ──
  const beats=brief.beats;
  const myCalls=[...Object.values(outcomes)];
  const convo=(
    <div>
      {beats.map((b,i)=>{
        const isNarration=b.kind==="opening"||b.kind==="trend"||b.kind==="allclear";
        const out=outcomes[b.id];
        return (
          <div key={b.id} className="proof-drop" style={{animationDelay:`${Math.min(i*110,660)}ms`,display:"flex",gap:10,marginBottom:12}}>
            <span style={{width:3,alignSelf:"stretch",borderRadius:3,flexShrink:0,background:isNarration?`${CA.accent}66`:b.kind==="wins"?CA.accent:b.kind==="question"?CA.blue:flagColor(b)}}/>
            <div style={{flex:1,minWidth:0,background:isNarration?"transparent":CA.navy2,border:isNarration?"none":`1px solid ${CA.border}`,borderRadius:12,padding:isNarration?"2px 0":"12px 14px"}}>
              {b.athleteName&&<div style={{fontSize:9.5,fontWeight:800,letterSpacing:1,textTransform:"uppercase",color:flagColor(b),marginBottom:4}}>{b.flag==="request"?"Change request":b.flag} · {b.athleteName}</div>}
              <div style={{color:CA.text,fontSize:13.5,lineHeight:1.55}}>{b.prose}</div>
              {b.question&&<div style={{color:CA.muted2,fontSize:13,marginTop:6,fontStyle:"italic"}}>{b.question.text}</div>}
              {(qMsgs[b.id]||[]).map((m,mi)=>(
                <div key={mi} style={{marginTop:8,display:"flex",justifyContent:m.role==="coach"?"flex-end":"flex-start"}}>
                  <div style={{maxWidth:"85%",background:m.role==="coach"?`${CA.accent}22`:CA.navy3,border:`1px solid ${m.role==="coach"?`${CA.accent}55`:CA.border}`,borderRadius:10,padding:"7px 11px",fontSize:12.5,color:CA.text}}>{m.text}</div>
                </div>
              ))}
              {out
                ? <div style={{marginTop:10}}><span style={{fontSize:11,fontWeight:800,color:CA.green,background:`${CA.green}18`,border:`1px solid ${CA.green}55`,borderRadius:6,padding:"3px 9px"}}>{out}</span></div>
                : b.actions&&b.actions.length>0&&(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
                    {b.actions.map(a=><button key={a.id} disabled={busy} onClick={()=>act(b,a)} style={btnS(a.id!=="open"&&a.kind!=="done"&&b.actions[0]===a)}>{a.label}</button>)}
                  </div>
                )}
              {/* Every open question keeps its own chips + text box — answer in any
                  order, not forced first-to-last. */}
              {b.kind==="question"&&!qDone[b.id]&&(
                <div style={{marginTop:10}}>
                  {b.question.chips&&b.question.chips.length>0&&(
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                      {b.question.chips.map(ch=><button key={ch} disabled={busy} onClick={()=>answerQuestion(b,ch,true)} style={btnS(false)}>{ch}</button>)}
                    </div>
                  )}
                  <div style={{display:"flex",gap:8}}>
                    <input value={inputs[b.id]||""} onChange={e=>setInputs(v=>({...v,[b.id]:e.target.value}))} onKeyDown={e=>{if(e.key==="Enter")answerQuestion(b,inputs[b.id],false);}} placeholder="Type a reply — or tap a chip" disabled={busy}
                      style={{flex:1,background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:9,padding:"9px 12px",color:CA.text,fontSize:13,outline:"none",fontFamily:"'DM Sans'"}}/>
                    <button disabled={busy||!(inputs[b.id]||"").trim()} onClick={()=>answerQuestion(b,inputs[b.id],false)} style={btnS(true)}>{busy?"…":"Send"}</button>
                  </div>
                </div>
              )}
              {b.kind==="question"&&qDone[b.id]&&!qMsgs[b.id]?.length&&<div style={{marginTop:8,fontSize:11,color:CA.green}}>✓ noted</div>}
            </div>
          </div>
        );
      })}
      <div style={{padding:"8px 0 2px",color:CA.muted,fontSize:11.5}}>Everything you decide here is remembered — it shapes next week's Coach's Edition.</div>
    </div>
  );

  const header=(
    <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:10,marginBottom:14,flexWrap:"wrap"}}>
      <div>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:CA.cyan,letterSpacing:1.5}}>THE MORNING BRIEF</div>
        <div style={{color:CA.muted,fontSize:11.5}}>{now.toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})} · from this week's logs</div>
      </div>
      <button onClick={()=>setOpen(false)} style={{border:`1px solid ${CA.border}`,background:"transparent",color:CA.muted2,borderRadius:8,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Close</button>
    </div>
  );

  if(isMobile) return (
    <div style={{position:"fixed",inset:0,background:CA.navy,zIndex:400,overflowY:"auto",padding:"calc(14px + env(safe-area-inset-top, 0px)) 14px 40px"}}>
      {header}{convo}
    </div>
  );
  return (
    <div style={{background:`linear-gradient(180deg,${CA.navy3},${CA.navy2})`,border:`1px solid ${CA.border}`,borderRadius:16,marginTop:4,padding:"16px 18px"}}>
      {header}
      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 230px",gap:18,alignItems:"start"}}>
        {convo}
        <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:14,position:"sticky",top:100}}>
          <div style={{fontSize:10.5,letterSpacing:1.2,textTransform:"uppercase",color:CA.cyan,fontWeight:700,marginBottom:8}}>Your calls today</div>
          {myCalls.length===0
            ? <div style={{fontSize:12,color:CA.muted}}>Decisions you make land here — and in next week's Edition.</div>
            : myCalls.map((c,i)=><div key={i} style={{fontSize:12,color:CA.muted2,padding:"4px 0",borderBottom:i<myCalls.length-1?`1px solid ${CA.border}60`:"none"}}>{c}</div>)}
        </div>
      </div>
    </div>
  );
}

// ─── THE COACH'S EDITION — Reports render + conversational check-in ───────────
// The team-level mirror of the athlete Proof Feed: a newspaper the coach reads,
// then a real back-and-forth check-in that gathers their calls + team context and
// remembers it (coach_context) for next week's edition. See coach-experience-vision.
const EDITION_SERIF = "Georgia,'Times New Roman',serif";
// Masthead register — Playfair Display (loaded in index.html), mirroring the athlete
// "The Proof" newspaper so the two editions read as one franchise.
const EDITION_MAST = "'Playfair Display',Georgia,serif";
// Cool LED ink for the edition (replaces navy-era text colors).
const EDITION_HEAD = "#eaf1ff", EDITION_BODY = "#aebfd8";

// Did the coach ask a question back (vs. answer)? Mirrors the athlete check-in's
// clarifying-question detection so WILCO answers once, then re-asks.
const isAskingBack = (t)=>{
  const s=String(t||"").trim();
  return /\?\s*$/.test(s) || /^(what|why|how|when|which|who|should|can|could|would|do you|is it|are they|will it|any )\b/i.test(s);
};
// Quick-tap chips per question — the coach can always free-type instead.
const chipsFor = (q)=>{
  if(Array.isArray(q.options)&&q.options.length) return q.options;
  if(q.kind==="program_focus") return ["Prioritize it next block","Not now"];
  if(q.kind==="injury_apply") return ["Deload them this week","Leave it as is"];
  if(q.kind==="reach_out") return ["Got it","Already on it"];
  return null; // free-text only
};

function TierBar({name,tier,avgTier,color}){
  return (
    <div style={{display:"flex",alignItems:"center",gap:9,padding:"4px 0"}}>
      <span style={{width:120,fontSize:12.5,color:CA.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{name}</span>
      <span style={{flex:1,height:6,borderRadius:4,background:CA.navy2,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*((avgTier||0)+1)/8)}%`,background:color}}/></span>
      <span style={{fontFamily:"'Bebas Neue'",fontSize:11,color,width:78,textAlign:"right"}}>{tier}</span>
    </div>
  );
}

// Client-side canvas export of the Wins block — no dependency, no server function.
// A standalone "night gym" report card (1080x1350, 4:5): near-black ground, blue-to-
// cyan LED strips, huge Bebas figures with plain-English labels so a parent/AD reading
// it on a white phone background gets it instantly. ASCII only, no emoji.
async function exportWins(team, coach, school){
  try{
    const W=1080,H=1350,M=84;
    const MONO="600 24px ui-monospace,Menlo,monospace";
    // fonts must be resident before we paint to the bitmap
    try{ await Promise.all([
      document.fonts.load('700 120px "Bebas Neue"'),
      document.fonts.load('700 46px "DM Sans"'),
      document.fonts.load('400 28px "DM Sans"'),
    ]); }catch(_){}
    const cv=document.createElement("canvas"); cv.width=W; cv.height=H;
    const x=cv.getContext("2d");
    const setLS=(v)=>{ try{ x.letterSpacing=v; }catch(_){} };
    // ground
    x.fillStyle=CA.navy; x.fillRect(0,0,W,H);
    // radial blue glow, top-center
    const glow=x.createRadialGradient(W/2,-120,60,W/2,-120,780);
    glow.addColorStop(0,"rgba(58,123,255,0.22)"); glow.addColorStop(1,"rgba(58,123,255,0)");
    x.fillStyle=glow; x.fillRect(0,0,W,560);
    // faint grid
    x.strokeStyle="rgba(58,123,255,0.05)"; x.lineWidth=1;
    for(let gx=0;gx<=W;gx+=44){ x.beginPath(); x.moveTo(gx+0.5,0); x.lineTo(gx+0.5,H); x.stroke(); }
    for(let gy=0;gy<=H;gy+=44){ x.beginPath(); x.moveTo(0,gy+0.5); x.lineTo(W,gy+0.5); x.stroke(); }
    // signature LED strip (blue -> cyan, soft glow)
    const led=(yy,h=3)=>{ const g=x.createLinearGradient(M,0,W-M,0); g.addColorStop(0,CA.accent); g.addColorStop(1,CA.cyan); x.save(); x.shadowColor=CA.cyan; x.shadowBlur=18; x.fillStyle=g; x.fillRect(M,yy,W-2*M,h); x.restore(); };
    led(176);
    // wordmark + mono kicker
    x.textBaseline="alphabetic";
    x.fillStyle=CA.led; x.font='700 90px "Bebas Neue"'; setLS("4px"); x.fillText("WILCO",M,270); setLS("0px");
    x.fillStyle=CA.cyan; x.font=MONO; setLS("3px"); x.fillText("WEEKLY TEAM REPORT",M+4,306); setLS("0px");
    // plain-English title + date range
    const teamName=String(school?.name||coach?.name||"THE TEAM").toUpperCase();
    const title=`${teamName} - WINS THIS WEEK`;
    let ts=46; x.font=`700 ${ts}px "DM Sans"`; while(x.measureText(title).width>W-2*M && ts>26){ ts-=2; x.font=`700 ${ts}px "DM Sans"`; }
    x.fillStyle=CA.led; x.fillText(title,M,398);
    const now=new Date(), start=new Date(now); start.setDate(now.getDate()-6);
    const md=(d)=>d.toLocaleDateString("en-US",{month:"short",day:"numeric"}).toUpperCase();
    x.fillStyle=CA.muted; x.font='400 28px "DM Sans"'; x.fillText(`${md(start)} - ${md(now)}, ${now.getFullYear()}`,M,440);
    // hero stats (whatever the export already receives; no new plumbing)
    const stats=[{n:String(team.newPRs||0),l:"PERSONAL RECORDS SET"}];
    if(team.activePct!=null) stats.push({n:`${team.activePct}%`,l:"OF THE SQUAD TRAINED"});
    if(team.adherenceAvg!=null) stats.push({n:`${team.adherenceAvg}%`,l:"PROGRAM ADHERENCE"});
    const hero=stats.slice(0,3);
    let y=572;
    hero.forEach(s=>{
      x.save(); x.shadowColor=CA.cyan; x.shadowBlur=22; x.fillStyle=CA.led; x.font='700 112px "Bebas Neue"'; x.fillText(s.n,M,y); x.restore();
      x.fillStyle=CA.cyan; x.font=MONO; setLS("2px"); x.fillText(s.l,M+6,y+40); setLS("0px");
      y+=150;
    });
    // shout-outs (Bebas name + DM Sans line) — only as many as fit above the footer
    const foot=1244;
    const shoutTop=y+18;
    const maxLines=Math.max(0,Math.floor((foot-60-(shoutTop+30))/56));
    const shouts=(team.notablePRs||[]).slice(0,Math.min(3,maxLines));
    if(shouts.length){
      x.fillStyle=CA.faint; x.font=MONO; setLS("2px"); x.fillText("SHOUT-OUTS",M,shoutTop); setLS("0px");
      const shortName=(full)=>{ const p=String(full||"").trim().split(/\s+/); return (p.length<2?(p[0]||""):`${p[0]} ${p[p.length-1][0]}.`).toUpperCase(); };
      let sy=shoutTop+52;
      shouts.forEach(p=>{
        const nm=shortName(p.athlete);
        x.fillStyle=CA.led; x.font='700 40px "Bebas Neue"'; x.fillText(nm,M,sy);
        const nw=x.measureText(nm).width;
        const detail=` - ${String(p.exercise||"").toUpperCase()} PR${p.gain?`  +${p.gain} LB`:(p.weight?`  ${p.weight}`:"")}`;
        x.fillStyle=CA.muted2; x.font='400 28px "DM Sans"'; x.fillText(detail,M+nw+2,sy);
        sy+=56;
      });
    }
    // footer
    led(foot,2);
    x.fillStyle=CA.steel; x.font='400 28px "DM Sans"'; x.fillText("trainwilco.com",M,foot+52);
    x.fillStyle=CA.faint; x.font=MONO; setLS("2px"); x.textAlign="right"; x.fillText("POWERED BY WILCO",W-M,foot+50); x.textAlign="left"; setLS("0px");
    const a=document.createElement("a"); a.href=cv.toDataURL("image/png"); a.download="wilco-wins.png"; a.click();
  }catch(e){ console.error("wins export failed",e); }
}

function CoachCheckin({digest, team, coach, onRead}){
  const c = digest.content_json||{};
  const questions = c.questions||[];
  const [msgs,setMsgs] = useState(()=>questions.length?[{role:"wilco",text:questions[0].text}]:[]);
  const [qi,setQi] = useState(0);
  const [answers,setAnswers] = useState({});
  const [input,setInput] = useState("");
  const [busy,setBusy] = useState(false);
  const [done,setDone] = useState(!!c.checkin_done);
  const endRef = useRef(null);
  // Scroll only on NEW messages — the mount-time scroll dragged the page straight
  // down past the Edition to this check-in (report opened at the bottom, not the top).
  const didMount = useRef(false);
  useEffect(()=>{ if(!didMount.current){didMount.current=true;return;} endRef.current?.scrollIntoView({behavior:"smooth",block:"nearest"}); },[msgs]);

  const q = questions[qi];
  const teamCtx = ()=> team? `Team read: ${team.n} athletes, ${team.activePct}% active, adherence ${team.adherenceAvg??"n/a"}%. Strengths: ${(team.strengths||[]).map(s=>s.name).join(", ")||"—"}. Weak spots: ${(team.weaknesses||[]).map(s=>s.name).join(", ")||"—"}. Slipping: ${(team.quiet||[]).map(v=>v.athlete).join(", ")||"none"}.` : "";

  const finish = async (finalAnswers)=>{
    setBusy(true);
    setMsgs(m=>[...m,{role:"sys",text:"Saving to your team context…"}]);
    try{
      const sys = 'You are WILCO, distilling a strength coach\'s check-in into concise context notes for future team reports. From the Q&A, output ONLY JSON: {"season":str|null,"block_goal":str|null,"team_response":str|null,"athlete_notes":str|null,"decisions":[str]}. Each a short phrase in the coach\'s own words. decisions = the calls they made (e.g. "wants a pressing emphasis next block", "deloading Marcus\' knee"). null when a field wasn\'t covered.';
      const transcript = questions.map(qq=>`Q(${qq.kind}): ${qq.text}\nA: ${finalAnswers[qq.id]||"(skipped)"}`).join("\n\n");
      const raw = await askClaude(sys, transcript, 500, [], "claude-haiku-4-5", "coach_checkin");
      let ext={}; try{ ext=JSON.parse(String(raw).replace(/```json|```/g,"").trim()); }catch{}
      const rows=[];
      const add=(kind,note,lt=false)=>{ if(note&&String(note).trim()) rows.push({coach_id:coach.id, note:`${kind}: ${String(note).trim()}`, meta:{kind}, is_long_term:lt}); };
      add("season",ext.season); add("goal",ext.block_goal,true); add("response",ext.team_response); add("notes",ext.athlete_notes,true);
      (Array.isArray(ext.decisions)?ext.decisions:[]).forEach(d=>add("decision",d));
      for(const r of rows){ try{ await sbInsert("coach_context",r); }catch(e){ console.error("coach_context write",e); } }
      try{ await sbUpdate("proof_digests", digest.id, {is_read:true, content_json:{...c, checkin_done:true}}); onRead&&onRead(); }catch(e){ console.error(e); }
      setMsgs(m=>[...m.filter(x=>x.text!=="Saving to your team context…"),{role:"sys",text:"✓ Saved — I'll build next week's edition around this."}]);
      setDone(true);
    }catch(e){ setMsgs(m=>[...m,{role:"wilco",text:"Couldn't save that just now — try again in a moment."}]); }
    setBusy(false);
  };

  const advance = (nextAnswers)=>{
    const ni=qi+1;
    if(ni>=questions.length){ finish(nextAnswers); return; }
    setQi(ni);
    setMsgs(m=>[...m,{role:"wilco",text:questions[ni].text}]);
  };

  const submit = async (text)=>{
    const t=String(text||"").trim(); if(!t||busy||done||!q) return;
    setInput("");
    setMsgs(m=>[...m,{role:"coach",text:t}]);
    if(isAskingBack(t)){
      setBusy(true);
      try{
        const sys=`You are WILCO, a strength coach's AI assistant. The coach asked a question mid-check-in. Answer it directly and briefly (1-3 sentences), grounded in the team read, then stop — don't move on. ${teamCtx()}`;
        const reply=await askClaude(sys, `They were asked: "${q.text}"\nThey replied: "${t}"`, 300, [], "claude-sonnet-5", "coach_checkin");
        setMsgs(m=>[...m,{role:"wilco",text:reply||"Your call either way."},{role:"wilco",text:q.text}]);
      }catch(e){ setMsgs(m=>[...m,{role:"wilco",text:q.text}]); }
      setBusy(false);
      return;
    }
    const na={...answers,[q.id]:t}; setAnswers(na);
    // WILCO reacts to the answer before asking the next question — a real
    // conversation, mirroring the athlete check-in (thin/dismissive answers get
    // no forced reaction).
    const thin = t.length<3 || /^(idk|no|nope|nothing|none|fine|na|n\/a|skip|dunno|meh|ok|okay|yes|yeah|yep|sure)\.?$/i.test(t);
    if(!thin){
      setBusy(true);
      try{
        const sys=`You are WILCO, a strength coach's AI assistant, mid-check-in with the coach. React to their answer in ONE short, natural sentence — acknowledge or reflect it like a real conversation. Do NOT ask a question, no lists, no emoji. ${teamCtx()}`;
        const reply=await askClaude(sys, `You asked: "${q.text}"\nThey answered: "${t}"`, 160, [], "claude-haiku-4-5", "coach_checkin");
        if(reply&&reply.trim()) setMsgs(m=>[...m,{role:"wilco",text:reply.trim()}]);
      }catch{}
      setBusy(false);
    }
    advance(na);
  };

  if(!questions.length) return null;
  const chips = q?chipsFor(q):null;

  return (
    <div style={{marginTop:18,background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:16}}>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:CA.accent,letterSpacing:1.5}}>YOUR CALLS &amp; CONTEXT</div>
      <div style={{color:CA.muted,fontSize:12.5,margin:"3px 0 14px"}}>Talk it through — tap an option or type your own, ask me anything, push back. I'll remember it for next week.</div>
      <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:400,overflowY:"auto",paddingRight:4}}>
        {msgs.map((m,i)=>(
          m.role==="sys"
            ? <div key={i} style={{alignSelf:"center",color:CA.green,fontSize:12,fontFamily:"'Bebas Neue'",letterSpacing:0.5}}>{m.text}</div>
            : <div key={i} style={{alignSelf:m.role==="coach"?"flex-end":"flex-start",maxWidth:"85%",background:m.role==="coach"?"linear-gradient(135deg,#3f7bff,#2258e0)":CA.navy3,border:m.role==="coach"?"none":`1px solid ${CA.border}`,color:m.role==="coach"?"#fff":CA.text,padding:"9px 12px",borderRadius:12,fontSize:13.5,lineHeight:1.5,fontWeight:m.role==="coach"?500:400}}>{m.text}</div>
        ))}
        <div ref={endRef}/>
      </div>
      {!done&&q&&(
        <div style={{marginTop:12}}>
          {chips&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:9}}>
              {chips.map((opt,i)=>(
                <button key={i} disabled={busy} onClick={()=>submit(opt)} style={{fontSize:12.5,color:CA.muted,background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:999,padding:"6px 13px",cursor:"pointer",fontFamily:"'DM Sans'"}}>{opt}</button>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"center",background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:"6px 6px 6px 13px"}}>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit(input);}} placeholder="Answer, or ask me anything…" disabled={busy} style={{flex:1,background:"none",border:"none",color:CA.text,fontSize:13.5,outline:"none",fontFamily:"'DM Sans'"}}/>
            <button onClick={()=>submit(input)} disabled={busy||!input.trim()} style={{background:CA_BTN,color:"#fff",border:"none",borderRadius:9,padding:"8px 16px",fontWeight:700,fontSize:12,cursor:"pointer",opacity:busy||!input.trim()?0.5:1,boxShadow:`0 0 12px ${CA_GLOW}`,fontFamily:"'DM Sans'"}}>{busy?"…":"Send"}</button>
          </div>
        </div>
      )}
      {done&&<div style={{marginTop:12,color:CA.muted,fontSize:13,fontStyle:"italic",fontFamily:EDITION_SERIF}}>That's the edition. I've got the context now — I'll build next week around it.</div>}
    </div>
  );
}

function CoachEdition({digest, athletes, coach, school, onBack, onRead}){
  const c = digest.content_json||{};
  // Always open the Edition at the masthead, not wherever Reports was scrolled.
  useEffect(()=>{ window.scrollTo(0,0); },[digest.id]);
  // Edition number = this coach's Nth team edition (weekly+monthly, oldest = No. 1).
  // The gateway scopes coach-digest reads to this coach, so no coach filter needed.
  const [edNo,setEdNo] = useState(null);
  useEffect(()=>{
    let on=true;
    const at=digest?.generated_at||digest?.created_at;
    if(!at){ setEdNo(null); return; }
    sbRead("proof_digests",`?digest_type=in.(weekly_coach,monthly_coach)&generated_at=lte.${encodeURIComponent(at)}&select=id`)
      .then(r=>{ if(on) setEdNo(Array.isArray(r)&&r.length?r.length:null); })
      .catch(()=>{ if(on) setEdNo(null); });
    return ()=>{ on=false; };
  },[digest?.id]);
  const team = c.team||null;
  const sections = Array.isArray(c.sections)?c.sections:[];
  const isMonthly = digest.digest_type==="monthly_coach";
  const railCells = team?[["Roster",team.n],["Active",`${team.activePct}%`],["Adherence",team.adherenceAvg!=null?`${team.adherenceAvg}%`:"—"],["True PRs",team.newPRs]]:[];
  const toneOf = (s)=> /FOCUS/i.test(s.label)?"focus": s.flag==="warn"?"warn":"plain";
  return (
    <div style={{maxWidth:720}}>
      <button onClick={onBack} style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,marginBottom:14}}>← Back to Reports</button>
      <div className="coach-scan" style={{position:"relative",overflow:"hidden",background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:16,padding:"18px 20px"}}>
        <div style={{borderBottom:`2px solid ${CA.line2}`,paddingBottom:12,marginBottom:14,textAlign:"center"}}>
          <div style={{fontFamily:EDITION_MAST,fontWeight:700,fontSize:30,color:EDITION_HEAD,letterSpacing:-0.5,lineHeight:1}}>
            {`The Coach's Edition${isMonthly?" · Monthly":""}`.split(" ").map((w,i)=><span key={i} className="c-flap" style={{animationDelay:`${i*60}ms`,marginRight:7}}>{w}</span>)}
          </div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:12,letterSpacing:2,color:CA.muted,marginTop:6,display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
            <span className="c-live" style={{width:6,height:6,borderRadius:"50%",background:CA.cyan,display:"inline-block",flexShrink:0}}/>
            <span>{coach?.name||"Coach"} · {new Date(digest.generated_at||Date.now()).toLocaleDateString("en-US",{month:"long",day:"numeric"})}{team?` · ${team.n} Athletes`:""}{edNo?` · No. ${edNo}`:""}</span>
          </div>
        </div>
        {c.intro&&<div style={{fontFamily:EDITION_SERIF,fontSize:16,color:EDITION_BODY,fontStyle:"italic",marginBottom:14,textAlign:"center"}}>{c.intro}</div>}
        {team&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:1,background:CA.line2,border:`1px solid ${CA.line2}`,borderRadius:10,overflow:"hidden",marginBottom:16}}>
            {railCells.map(([k,v],i)=>(
              <div key={i} style={{background:CA.navy3,padding:"10px 12px"}}>
                <div style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:9.5,letterSpacing:1.5,textTransform:"uppercase",color:CA.faint}}>{k}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:CA.led,fontVariantNumeric:"tabular-nums"}}>{v}</div>
              </div>
            ))}
          </div>
        )}
        {sections.map((s,i)=>{
          const tone=toneOf(s);
          const isFocus=tone==="focus";
          const labelColor = tone==="warn"?CA.red: isFocus?CA.cyan:CA.faint;
          const box = isFocus
            ? {background:`${CA.accent}0e`,borderLeft:`2px solid ${CA.accent}`,borderRadius:"0 10px 10px 0"}
            : {background:CA.navy3,border:`1px solid ${tone==="warn"?`${CA.red}40`:CA.line2}`,borderRadius:10};
          const labelStyle = isFocus
            ? {fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:10,letterSpacing:1.5,textTransform:"uppercase",color:labelColor,marginBottom:6}
            : {fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:labelColor,marginBottom:6};
          return (
            <div key={i} style={{...box,padding:"12px 14px",marginBottom:9}}>
              <div style={labelStyle}>{s.label}</div>
              <div style={{color:EDITION_BODY,fontSize:13.5,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{s.body}</div>
            </div>
          );
        })}
        {team&&((team.strengths&&team.strengths.length)||(team.weaknesses&&team.weaknesses.length))&&(
          <div style={{background:CA.navy3,border:`1px solid ${CA.line2}`,borderRadius:10,padding:14,marginTop:6}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:CA.muted2,marginBottom:8}}>PROGRAM STRENGTHS &amp; WEAKNESSES</div>
            {(team.strengths||[]).map((s,i)=><TierBar key={"s"+i} name={s.name} tier={s.tierName} avgTier={s.avgTier} color={CA.green}/>)}
            {(team.weaknesses||[]).map((s,i)=><TierBar key={"w"+i} name={s.name} tier={s.tierName} avgTier={s.avgTier} color={CA.red}/>)}
          </div>
        )}
        {team&&team.notablePRs&&team.notablePRs.length>0&&(
          <div style={{background:`${CA.accent}14`,border:`1px solid ${CA.accent}44`,borderRadius:10,padding:14,marginTop:12}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:CA.accent,marginBottom:8}}>WINS TO SHARE</div>
            {team.notablePRs.slice(0,5).map((p,i,arr)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:i<arr.length-1?`1px solid ${CA.border}80`:"none"}}>
                <span style={{width:24,height:24,borderRadius:6,background:`${CA.accent}22`,border:`1px solid ${CA.accent}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>🏆</span>
                <div style={{flex:1,minWidth:0}}><span style={{color:CA.text,fontWeight:650,fontSize:13}}>{p.athlete}</span> <span style={{color:CA.muted,fontSize:12.5}}>{p.exercise} {fmtWeight(p.weight,p.unit)}{p.gain?` — +${p.gain} lbs e1RM`:""}</span></div>
              </div>
            ))}
            <button onClick={()=>exportWins(team,coach,school)} style={{marginTop:12,width:"100%",background:CA_BTN,color:"#fff",border:"none",borderRadius:9,padding:10,fontWeight:800,letterSpacing:1,textTransform:"uppercase",fontSize:12,cursor:"pointer",boxShadow:`0 0 14px ${CA_GLOW}`,fontFamily:"'DM Sans'"}}>⤓ Share as image</button>
          </div>
        )}
        <CoachCheckin digest={digest} team={team} coach={coach} onRead={onRead}/>
      </div>
    </div>
  );
}

// ─── GROUP PROGRESS (Coach Dashboard) ────────────────────────────────────────
// The team-level mirror of the athlete Progress screen: all athletes' dated data
// combined into GROUP trends. Same Benchmarks / Strength / Running tabs (no PRs —
// there's no such thing as a group PR). Reuses the Grit engine + LineChart.

// ── ACCOUNT TAB (admin only) — extracted from a conditional IIFE inside the
// dashboard render: hooks in a conditional block violate the Rules of Hooks and
// crashed the tab when the condition flipped (the sales demo carried this fix).
function AccountTab({coach,allCoaches,school,athletes,loadAll}){
              const schoolCoachesList = allCoaches.filter(c=>c.school_id===coach.school_id&&c.role!=="admin");
              const atLimit = schoolCoachesList.length>=(school?.max_coaches||3);
              const [acName,setAcName] = useState("");
              const [acEmail,setAcEmail] = useState("");
              const [acErr,setAcErr] = useState("");
              const [acOk,setAcOk] = useState("");
              const [acCode,setAcCode] = useState("");          // freshly-created coach code (for its copy button)
              const [codeCopied,setCodeCopied] = useState(null); // which code is showing "Copied!"
              const [acSaving,setAcSaving] = useState(false);
              const [removeId,setRemoveId] = useState(null);      // coach id pending remove-confirm (inline)
              const [removing,setRemoving] = useState(false);

              const copyCoachCode = (code) => {
                if(!code || codeCopied===code) return;
                try{ navigator.clipboard.writeText(code); }catch(_){}
                haptic(10);
                setCodeCopied(code);
                setTimeout(()=>setCodeCopied(c=>c===code?null:c), 2000);
              };
              const codeBtn = (code) => {
                const done = codeCopied===code;
                return <button onClick={()=>copyCoachCode(code)} style={{background:done?CA.accent:"none",border:`1px solid ${done?CA.accent:CA.border}`,color:done?"#fff":CA.muted2,borderRadius:6,padding:"2px 9px",cursor:done?"default":"pointer",fontSize:10,fontWeight:700,marginLeft:8,verticalAlign:"middle"}}>{done?"Copied!":"Copy"}</button>;
              };

              const doAddCoach = async () => {
                if(!acName.trim()||!acEmail.trim()||!acEmail.includes("@")){setAcErr("Enter a name and valid email.");return;}
                if(atLimit){setAcErr("Coach limit reached for your plan.");return;}
                setAcSaving(true);setAcErr("");setAcOk("");setAcCode("");
                try {
                  const nextNum=(schoolCoachesList.reduce((m,c)=>Math.max(m,c.coach_number||0),0))+1;
                  const newCode=(school?.code||"???").toUpperCase()+String(nextNum).padStart(2,"0");
                  const row=await sbInsert("coaches",{name:acName.trim(),email:acEmail.trim().toLowerCase(),school_id:coach.school_id,coach_number:nextNum,access_code:newCode,role:"coach"});
                  if(row?.length){
                    fetch("/api/send-coach-invite",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({auth:getAuth(),coachName:acName.trim(),coachEmail:acEmail.trim().toLowerCase(),accessCode:newCode,schoolName:school?.name||""})}).catch(()=>{});
                    setAcOk(`✓ ${acName.trim()} added — invite sent.`); setAcCode(newCode);
                    setAcName("");setAcEmail("");
                    loadAll();
                  }else{setAcErr("Could not create coach. Try again.");}
                }catch(e){setAcErr("Error: "+e.message);}
                setAcSaving(false);
              };

              const doRemoveCoach = async (c) => {
                setAcErr("");setAcOk("");setRemoving(true);
                try {
                  await sbUpdate("coaches",c.id,{pin:null,access_code:`REMOVED_${c.access_code}`});
                  await sbUpdateWhere("athletes",`?coach_id=eq.${c.id}`,{coach_id:null});
                  setRemoveId(null);
                  loadAll();
                }catch(e){setAcErr("Could not remove "+c.name+": "+(e?.message||"try again."));}
                setRemoving(false);
              };

              return (
                <div style={{maxWidth:600}}>
                  <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:20,marginBottom:16}}>
                    <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:14}}>SCHOOL ACCOUNT</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:4}}>
                      <div><div style={{color:CA.muted,fontSize:10,letterSpacing:1}}>SCHOOL</div><div style={{color:CA.text,fontWeight:600,fontSize:14,marginTop:2}}>{school?.name||"—"}</div></div>
                      <div><div style={{color:CA.muted,fontSize:10,letterSpacing:1}}>CODE</div><div style={{display:"flex",alignItems:"center",marginTop:2}}><span style={{color:CA.accent,fontWeight:700,fontSize:18,fontFamily:"'Bebas Neue'",letterSpacing:2}}>{school?.code||"—"}</span>{school?.code&&codeBtn(school.code)}</div></div>
                      <div><div style={{color:CA.muted,fontSize:10,letterSpacing:1}}>TIER</div><div style={{color:CA.text,fontSize:13,marginTop:2}}>{school?.tier||"—"}</div></div>
                      <div><div style={{color:CA.muted,fontSize:10,letterSpacing:1}}>COACHES</div><div style={{color:CA.text,fontSize:13,marginTop:2}}>{schoolCoachesList.length} / {school?.max_coaches||3}</div></div>
                    </div>
                  </div>

                  <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,padding:20,marginBottom:16}}>
                    <div style={{color:CA.accent,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:14}}>COACHES</div>
                    {schoolCoachesList.length===0?<div style={{color:CA.muted,fontSize:13,marginBottom:12}}>No coaches added yet.</div>:schoolCoachesList.map(c=>{
                      const athCount=athletes.filter(a=>a.coach_id===c.id).length;
                      return(
                        <div key={c.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${CA.border}`,gap:10}}>
                          <div>
                            <div style={{color:CA.text,fontWeight:600,fontSize:13}}>{c.name}</div>
                            <div style={{color:CA.muted,fontSize:11}}>{c.email} · Code: {c.access_code} · {athCount} athlete{athCount!==1?"s":""}</div>
                          </div>
                          {removeId===c.id ? (
                            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                              <span style={{color:CA.muted,fontSize:11,textAlign:"right"}}>Remove? Athletes stay unassigned.</span>
                              <button onClick={()=>doRemoveCoach(c)} disabled={removing}
                                style={{background:CA.red,border:"none",color:"#fff",borderRadius:6,padding:"4px 10px",cursor:removing?"default":"pointer",fontSize:11,fontWeight:700}}>
                                {removing?"...":"Confirm"}
                              </button>
                              <button onClick={()=>{setRemoveId(null);setAcErr("");}}
                                style={{background:"none",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11}}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button onClick={()=>{setRemoveId(c.id);setAcErr("");setAcOk("");}}
                              style={{background:"none",border:`1px solid ${CA.border}`,color:CA.red,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11,flexShrink:0}}>Remove</button>
                          )}
                        </div>
                      );
                    })}

                    <div style={{marginTop:16}}>
                      <div style={{color:CA.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>ADD COACH</div>
                      {atLimit?<div style={{color:CA.muted,fontSize:12,fontStyle:"italic"}}>Coach limit reached for your plan ({school?.max_coaches||3} max).</div>:(
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"center"}}>
                          <input value={acName} onChange={e=>setAcName(e.target.value)} placeholder="Coach name" style={inpA({padding:"9px 12px",fontSize:13})}/>
                          <input type="email" value={acEmail} onChange={e=>setAcEmail(e.target.value)} placeholder="email@school.edu" style={inpA({padding:"9px 12px",fontSize:13})}/>
                          <button onClick={doAddCoach} disabled={acSaving} style={{background:CA_BTN,boxShadow:"0 4px 16px "+CA_GLOW,border:"none",color:"#fff",borderRadius:8,padding:"9px 14px",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap",opacity:acSaving?0.7:1}}>
                            {acSaving?"Adding...":"Add Coach →"}
                          </button>
                        </div>
                      )}
                      {acErr&&<div style={{color:CA.red,fontSize:12,marginTop:8}}>{acErr}</div>}
                      {acOk&&<div style={{color:CA.green,fontSize:12,marginTop:8,fontWeight:600}}>{acOk}{acCode&&<> Code: <span style={{fontFamily:"'Bebas Neue'",letterSpacing:1,color:CA.accent,fontSize:14}}>{acCode}</span>{codeBtn(acCode)}</>}</div>}
                    </div>
                  </div>
                </div>
              );
}

function GroupProgress({athletes,workouts,manualRMs}){
  const [tab,setTab] = useState("benchmarks");
  // charge the power cells shortly after the Benchmarks tab shows (mirrors the
  // athlete benchGo gate so the fill animates in its final tier colour)
  const [cellGo,setCellGo] = useState(false);
  useEffect(()=>{
    if(tab!=="benchmarks"){ setCellGo(false); return; }
    // Double-rAF instead of a 120ms timer: the roster-wide Grit compute can still
    // be laying out when a timer fires, so the charge transition started from a
    // half-painted frame and visibly jumped into place. Two frames guarantees the
    // empty tubes have painted before the fill animates.
    let r2; const r1=requestAnimationFrame(()=>{ r2=requestAnimationFrame(()=>setCellGo(true)); });
    return ()=>{ cancelAnimationFrame(r1); if(r2)cancelAnimationFrame(r2); };
  },[tab]);
  const D = useMemo(()=>{
    const now=Date.now(), WK=7*864e5, WEEKS=12, weekStart=now-WEEKS*WK;
    const wl=(wi)=>new Date(weekStart+wi*WK).toLocaleDateString("en-US",{month:"short",day:"numeric"});
    const pd=(w)=>typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return{};}})():(w.parsed_data||{});
    const woByAth={}, manByAth={};
    workouts.forEach(w=>{(woByAth[w.athlete_id]=woByAth[w.athlete_id]||[]).push(w);});
    manualRMs.forEach(m=>{(manByAth[m.athlete_id]=manByAth[m.athlete_id]||[]).push(m);});

    // ── BENCHMARKS: aggregate each athlete's Grit snapshot by benchmark lift ──
    const byBench={}; let scoreSum=0, scoreN=0, topTier=-1, rankedAthletes=0;
    athletes.forEach(a=>{
      let snap; try{ snap=computeGritSnapshot(woByAth[a.id]||[], manByAth[a.id]||[], {bodyweightLbs:a.weight_lbs||a.weight||0, gender:a.gender, age:a.age}); }catch{ snap={rankedLifts:[],strengthScore:0,topTierIdx:-1}; }
      if(snap.rankedLifts.length){ rankedAthletes++; scoreSum+=snap.strengthScore; scoreN++; if(snap.topTierIdx>topTier)topTier=snap.topTierIdx; }
      snap.rankedLifts.forEach(l=>{ const bk=getBenchKey(l.key)||l.benchKey; if(!bk)return; const e=(byBench[bk]=byBench[bk]||{name:l.name,tiers:[],e1rms:[]}); e.tiers.push(l.tierIdx); e.e1rms.push(l.e1rm); });
    });
    const benchmarks=Object.entries(byBench).map(([bk,v])=>{
      const avgTier=v.tiers.reduce((a,b)=>a+b,0)/v.tiers.length;
      const dist=Array(8).fill(0); v.tiers.forEach(t=>dist[t]++);
      return {benchKey:bk,name:v.name,avgTier,n:v.tiers.length,dist,avgE1rm:Math.round(v.e1rms.reduce((a,b)=>a+b,0)/v.e1rms.length)};
    }).sort((a,b)=>b.avgTier-a.avgTier);
    const avgScore=scoreN?Math.round(scoreSum/scoreN):0;

    // ── STRENGTH: weekly team-average e1RM per lift ──
    const liftData={};
    athletes.forEach(a=>{ const bw=a.weight_lbs||a.weight||0;
      (woByAth[a.id]||[]).forEach(w=>{ const t=new Date(w.created_at).getTime(); if(t<weekStart)return; const wi=Math.floor((t-weekStart)/WK);
        (pd(w).exercises||[]).forEach(ex=>{ if(!ex.name)return; const lift=resolveLift(ex.name); if(!lift.tracked)return; const e=bestE1RMForExercise(ex,bw); if(!e)return;
          const L=(liftData[lift.id]=liftData[lift.id]||{name:lift.name,key:lift.id,weeks:{}}); const wk=(L.weeks[wi]=L.weeks[wi]||{}); if(!wk[a.id]||e>wk[a.id])wk[a.id]=e; });
      });
    });
    const strength=Object.values(liftData).map(L=>{
      const points=[]; for(let wi=0;wi<WEEKS;wi++){ const wk=L.weeks[wi]; if(wk){ const vals=Object.values(wk); points.push({label:wl(wi),y:Math.round(vals.reduce((a,b)=>a+b,0)/vals.length),n:vals.length}); } }
      const best=points.length?Math.max(...points.map(p=>p.y)):0;
      return {name:L.name,key:L.key,points,best};
    }).filter(L=>L.points.length>=2).sort((a,b)=>liftTier(a.key)-liftTier(b.key)||b.best-a.best);

    // ── RUNNING: weekly team totals / averages ──
    const paceToMin=(p)=>{ if(!p)return null; const pts=String(p).split(":"); if(pts.length<2)return null; const m=parseFloat(pts[0]),s=parseFloat(pts[1]); return isNaN(m)||isNaN(s)?null:Math.round((m+s/60)*100)/100; };
    const runWeeks={};
    athletes.forEach(a=>{ (woByAth[a.id]||[]).forEach(w=>{ const t=new Date(w.created_at).getTime(); if(t<weekStart)return; const wi=Math.floor((t-weekStart)/WK); const rd=pd(w).run_data; if(!rd)return; const R=(runWeeks[wi]=runWeeks[wi]||{dist:0,pace:[],hr:[]}); const d=rd.distance_miles||rd.distance_km; if(d)R.dist+=d; const pc=paceToMin(rd.pace_per_mile||rd.pace_per_km); if(pc!=null)R.pace.push(pc); if(rd.heart_rate_avg)R.hr.push(rd.heart_rate_avg); }); });
    const distSeries=[],paceSeries=[],hrSeries=[];
    for(let wi=0;wi<WEEKS;wi++){ const R=runWeeks[wi]; if(!R)continue; const label=wl(wi); if(R.dist)distSeries.push({label,y:Math.round(R.dist*10)/10}); if(R.pace.length)paceSeries.push({label,y:Math.round(R.pace.reduce((a,b)=>a+b,0)/R.pace.length*100)/100}); if(R.hr.length)hrSeries.push({label,y:Math.round(R.hr.reduce((a,b)=>a+b,0)/R.hr.length)}); }

    return {benchmarks,avgScore,rankedAthletes,topTier,strength,distSeries,paceSeries,hrSeries};
  },[athletes,workouts,manualRMs]);

  const subTab=(t,label)=>(
    <button key={t} onClick={()=>setTab(t)} style={{padding:"10px 16px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?CA.accent:"transparent"}`,color:tab===t?CA.accent:CA.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'"}}>{label}</button>
  );

  return (
    <div style={{maxWidth:760}}>
      <div style={{color:CA.muted2,fontSize:12.5,marginBottom:12}}>Every athlete's dated data, combined into team trends.</div>
      <div style={{display:"flex",borderBottom:`1px solid ${CA.border}`,marginBottom:16}}>
        {subTab("benchmarks","Benchmarks")}{subTab("strength","Strength")}{subTab("running","Running")}
      </div>

      {tab==="benchmarks"&&(
        <div>
          <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:16,display:"flex",justifyContent:"space-around",textAlign:"center",alignItems:"center"}}>
            <div style={{flex:1}}><div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:CA.accent,lineHeight:1}}>{D.rankedAthletes}</div><div style={{color:CA.muted,fontSize:10,letterSpacing:1,marginTop:2}}>ATHLETES RANKED</div></div>
            <div style={{width:1,alignSelf:"stretch",background:CA.border}}/>
            <div style={{flex:1}}><div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:D.topTier>=0?TIER_COLORS[D.topTier]:CA.muted,lineHeight:1}}>{D.topTier>=0?TIER_NAMES[D.topTier]:"—"}</div><div style={{color:CA.muted,fontSize:10,letterSpacing:1,marginTop:5}}>TEAM TOP TIER</div></div>
            <div style={{width:1,alignSelf:"stretch",background:CA.border}}/>
            <div style={{flex:1}}><div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:CA.accent,lineHeight:1}}>{D.avgScore.toLocaleString()}</div><div style={{color:CA.muted,fontSize:10,letterSpacing:1,marginTop:2}}>AVG STRENGTH SCORE</div></div>
          </div>
          {D.benchmarks.length===0
            ? <div style={{color:CA.muted,textAlign:"center",padding:40,fontSize:13}}>No benchmarked lifts logged across the roster yet.</div>
            : D.benchmarks.map((b,i)=>{
                // athlete power-cell semantics: the tube lives in the CURRENT tier
                // (floor) and fills with progress toward the next rank
                const tf=Math.min(7,Math.floor(b.avgTier));
                const frac=tf>=7?1:Math.max(0.06,b.avgTier-tf);
                const next=tf<7?TIER_NAMES[tf+1]:null;
                return (
                  <div key={i} className={`hcell proof-drop${cellGo?" go":""}`} style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:12,animationDelay:`${Math.min(i*70,420)}ms`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                      <div>
                        <div style={{color:CA.text,fontWeight:700,fontSize:14}}>{b.name}</div>
                        <div style={{color:TIER_COLORS[tf],fontSize:13,fontWeight:700,marginTop:2,letterSpacing:.5}}>{TIER_NAMES[tf]} <span style={{color:CA.muted,fontWeight:400}}>team avg</span></div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:TIER_COLORS[tf],lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{b.avgE1rm}<span style={{fontSize:11,color:CA.muted,fontFamily:"'DM Sans'",marginLeft:2}}>lbs</span></div>
                        <div style={{color:CA.muted,fontSize:10}}>avg e1RM · {b.n} athlete{b.n!==1?"s":""}</div>
                      </div>
                    </div>
                    <div className="htube"><div className="hfill" style={{"--tc":TIER_COLORS[tf],"--tb":tf/7,"--pct":frac,transitionDelay:`${Math.min(i*70,420)}ms`}}/></div>
                    <div style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontSize:9.5,letterSpacing:1.2,textTransform:"uppercase",color:CA.faint,marginTop:7}}>
                      {next?`${Math.round(frac*100)}% of the way to ${next}`:"Top of the ladder"}
                    </div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10,justifyContent:"center"}}>
                      {b.dist.map((cnt,ti2)=>cnt>0&&<span key={ti2} style={{fontSize:10,color:TIER_COLORS[ti2],background:`${TIER_COLORS[ti2]}18`,border:`1px solid ${TIER_COLORS[ti2]}44`,borderRadius:999,padding:"2px 8px",fontWeight:700}}>{TIER_NAMES[ti2]} {cnt}</span>)}
                    </div>
                  </div>
                );
              })}
        </div>
      )}

      {tab==="strength"&&(
        <div>
          <div style={{color:CA.accent,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:12}}>TEAM STRENGTH — AVG EST. 1RM BY WEEK</div>
          {D.strength.length===0
            ? <div style={{color:CA.muted,textAlign:"center",padding:40,fontSize:13}}>Not enough weighted training logged across weeks yet.</div>
            : D.strength.map((ex,i)=>(
                <div key={i} style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div><div style={{color:CA.text,fontWeight:700,fontSize:14}}>{ex.name}</div><div style={{color:CA.muted,fontSize:11,marginTop:2}}>{ex.points.length} week{ex.points.length!==1?"s":""} of data</div></div>
                    <div style={{textAlign:"right"}}><div style={{color:CA.muted,fontSize:10,letterSpacing:1,marginBottom:2}}>PEAK TEAM AVG</div><div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:CA.accent,lineHeight:1}}>{ex.best}<span style={{fontSize:11,color:CA.muted,fontFamily:"'DM Sans'",marginLeft:2}}>lbs</span></div></div>
                  </div>
                  <LineChart data={ex.points} color={CA.cyan} unit=" lbs" palette={CA}/>
                </div>
              ))}
        </div>
      )}

      {tab==="running"&&(
        <div>
          <div style={{color:CA.blue,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:12}}>TEAM RUNNING — BY WEEK</div>
          {D.distSeries.length>=2&&<div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:14}}><div style={{color:CA.text,fontWeight:700,fontSize:14,marginBottom:12}}>Total distance / week</div><LineChart data={D.distSeries} color={CA.blue} unit=" mi" palette={CA}/></div>}
          {D.paceSeries.length>=2&&<div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:14}}><div style={{color:CA.text,fontWeight:700,fontSize:14,marginBottom:4}}>Avg pace (min/mi) — lower is faster</div><LineChart data={D.paceSeries} color={CA.cyan} unit="" palette={CA}/></div>}
          {D.hrSeries.length>=2&&<div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:14}}><div style={{color:CA.text,fontWeight:700,fontSize:14,marginBottom:12}}>Avg heart rate (bpm)</div><LineChart data={D.hrSeries} color={CA.blue} unit=" bpm" palette={CA}/></div>}
          {D.distSeries.length<2&&D.paceSeries.length<2&&D.hrSeries.length<2&&<div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:10,padding:16,color:CA.muted2,fontSize:12}}>Not enough runs logged across the roster to trend yet.</div>}
        </div>
      )}
    </div>
  );
}

// ─── ATHLETE DETAIL (Coach Dashboard) ────────────────────────────────────────
function AthleteDetail({athlete,workouts,prs,requests=[],onResolveRequest,onProgramSave,onAthleteDelete,prefill,onPrefillConsumed}) {
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
  // Morning Brief "Draft the change" deep-link: open the Program tab with the
  // suggestion appended to the DRAFT (nothing saves until the coach hits save).
  useEffect(()=>{
    if(!prefill||prefill.athleteId!==athlete.id) return;
    setTab("program");
    setProgramText(t=>`${(t||athlete.program_text||"").trimEnd()}\n\n# From today's brief — edit into the program, then delete this note:\n# ${prefill.note}`);
    onPrefillConsumed&&onPrefillConsumed();
  },[prefill,athlete.id]);

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
        "Extract the training program from this image.",600,[b64],"claude-sonnet-5","program_extract"
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
    <div style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:14,overflow:"hidden"}}>
      {/* Athlete header */}
      {/* flexWrap: on narrow screens the status chips drop to their own row instead
          of crushing into the name (the ⚠ Pain smush) */}
      <div style={{padding:"16px 20px",borderBottom:`1px solid ${CA.border}`,background:CA.navy3,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap"}}>
        <div style={{width:48,height:48,borderRadius:"50%",background:`linear-gradient(135deg,#57a0ff,#2a63e6)`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:22,color:"#fff",flexShrink:0}}>
          {athlete.name[0].toUpperCase()}
        </div>
        <div style={{flex:"1 1 180px",minWidth:0}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:CA.text,letterSpacing:1}}>{athlete.name}</div>
          <div style={{color:CA.muted,fontSize:12}}>{athlete.sport} · {groupIntoSessions(workouts).length} sessions</div>
          {athlete.season_date&&<div style={{color:CA.accent,fontSize:11}}>Season: {fmtDate(athlete.season_date)}</div>}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          {hasPain&&<div style={{background:`${CA.red}20`,border:`1px solid ${CA.red}`,borderRadius:8,padding:"4px 10px",color:CA.red,fontSize:11}}>⚠ Pain</div>}
          {athlete.temp_program_text&&<div style={{background:`${CA.amber}15`,border:`1px solid ${CA.amber}`,borderRadius:8,padding:"4px 10px",color:CA.amber,fontSize:11}}>✈️ Temp program</div>}
          {!athlete.temp_program_text&&athlete.program_text&&<div style={{background:CA.navy3,border:`1px solid ${CA.blue}`,borderRadius:8,padding:"4px 10px",color:CA.blue,fontSize:11}}>Program set</div>}
          {confirmDelete?(
            <div style={{display:"flex",gap:6,alignItems:"center",background:`${CA.red}15`,border:`1px solid ${CA.red}40`,borderRadius:10,padding:"4px 10px"}}>
              <span style={{color:CA.muted2,fontSize:11}}>Delete athlete?</span>
              <button onClick={handleDelete} style={{background:CA.red,border:"none",color:"#fff",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontSize:11,fontWeight:700}}>Delete</button>
              <button onClick={()=>setConfirmDelete(false)} style={{background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:6,padding:"3px 8px",cursor:"pointer",fontSize:11}}>Cancel</button>
            </div>
          ):(
            <button onClick={()=>setConfirmDelete(true)} style={{background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"4px 10px",cursor:"pointer",fontSize:11}}>Delete</button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:`1px solid ${CA.border}`}}>
        {tabs.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"10px 16px",background:"none",border:"none",borderBottom:`2px solid ${tab===t?CA.accent:"transparent"}`,color:tab===t?CA.accent:CA.muted,cursor:"pointer",fontSize:12,fontWeight:600,textTransform:"uppercase",letterSpacing:1,fontFamily:"'DM Sans'",transition:"color 0.15s"}}>
            {t==="progress"?"Progress":t}
          </button>
        ))}
      </div>

      <div style={{padding:20,maxHeight:"calc(100vh - 320px)",overflowY:"auto"}}>

        {/* ── Program change requests (locked-program collaboration) ── */}
        {requests.length>0&&(
          <div style={{background:`${CA.accent}0d`,border:`1px solid ${CA.accent}40`,borderRadius:12,padding:14,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:15,color:CA.accent,letterSpacing:1}}>PROGRAM CHANGE REQUESTS</span>
              <span style={{fontSize:10,fontWeight:800,color:CA.accent,background:`${CA.accent}22`,border:`1px solid ${CA.accent}55`,borderRadius:999,padding:"1px 7px"}}>{requests.length}</span>
              <span style={{marginLeft:"auto",fontSize:10.5,color:CA.muted,textTransform:"uppercase",letterSpacing:.5}}>🔒 Locked</span>
            </div>
            {requests.map((r)=>(
              <div key={r.id} style={{border:`1px solid ${CA.border}`,background:CA.navy2,borderRadius:10,padding:"11px 12px",marginBottom:8}}>
                <div style={{color:CA.text,fontSize:13,lineHeight:1.5}}>{r.reason || (Array.isArray(r.items)&&r.items[0]?.suggested_change) || "Requested a program change"}</div>
                <div style={{color:CA.dim||CA.muted,fontSize:11,margin:"5px 0 10px"}}>Filed {fmtDateRelative?fmtDateRelative(r.created_at):new Date(r.created_at).toLocaleDateString()} · {r.source}</div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>onResolveRequest&&onResolveRequest(r,"applied")} style={{background:CA.accent,color:"#fff",border:"none",borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Mark applied</button>
                  <button onClick={()=>{setTab("program");}} style={{background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Edit program</button>
                  <button onClick={()=>onResolveRequest&&onResolveRequest(r,"skipped")} style={{background:"transparent",border:`1px solid ${CA.border}`,color:CA.muted,borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Skip</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── OVERVIEW TAB ── */}
        {tab==="overview"&&(
          <div>
            {lastWorkout?(
              <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:16}}>
                <div style={{color:CA.accent,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:8}}>LAST SESSION — {fmtDateShort(lastWorkout.created_at)}</div>
                {lastWorkout.parsed_data?.run_data?(
                  <RunCard runData={lastWorkout.parsed_data.run_data} feel={lastWorkout.parsed_data.session_feel}/>
                ):lastWorkout.parsed_data?.exercises?.length>0?(
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {lastWorkout.parsed_data.exercises.map((e,i)=>(
                      <div key={i} style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:8,padding:"6px 10px"}}>
                        <div style={{color:CA.text,fontSize:12,fontWeight:600}}>{e.name}</div>
                        <div style={{color:CA.muted,fontSize:11}}>
                          {formatSetDetails(e)}
                        </div>
                      </div>
                    ))}
                  </div>
                ):(
                  <div style={{color:CA.muted2,fontSize:13}}>{lastWorkout.raw_message?.slice(0,200)}</div>
                )}
                {lastWorkout.parsed_data?.session_feel&&(
                  <div style={{marginTop:8,color:CA.muted,fontSize:11}}>
                    Feel: <span style={{color:lastWorkout.parsed_data.session_feel==="great"||lastWorkout.parsed_data.session_feel==="good"?CA.green:lastWorkout.parsed_data.session_feel==="rough"?CA.red:CA.accent}}>
                      {lastWorkout.parsed_data.session_feel}
                    </span>
                  </div>
                )}
              </div>
            ):(
              <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:16,color:CA.muted,fontSize:13}}>No sessions logged yet.</div>
            )}

            {(()=>{
              const painLogs = workouts.filter(w=>w.parsed_data?.pain_flags?.some(p=>!resolvedPainAreas.includes(p.area.toLowerCase())));
              if(!painLogs.length) return null;
              const areaCounts = {};
              painLogs.flatMap(w=>w.parsed_data.pain_flags.filter(p=>!resolvedPainAreas.includes(p.area.toLowerCase())).map(p=>p.area)).forEach(a=>areaCounts[a]=(areaCounts[a]||0)+1);
              return (
                <div style={{background:`${CA.red}10`,border:`1px solid ${CA.red}40`,borderRadius:12,padding:16,marginBottom:16}}>
                  <div style={{color:CA.red,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:8}}>ACTIVE PAIN FLAGS ({painLogs.length} sessions flagged)</div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                    {Object.entries(areaCounts).map(([area,count])=>(
                      <div key={area} style={{background:`${CA.red}20`,border:`1px solid ${CA.red}40`,borderRadius:8,padding:"4px 10px",fontSize:12,color:CA.red}}>
                        {area} ×{count}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {prs.length>0&&(
              <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:16}}>
                <div style={{color:CA.blue,fontSize:11,letterSpacing:1,fontWeight:700,marginBottom:10}}>TOP PRs</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[...prs].sort((a,b)=>liftTier(normalizeExName(a.exercise))-liftTier(normalizeExName(b.exercise)) || (b.estimated_1rm||b.weight||0)-(a.estimated_1rm||a.weight||0)).slice(0,6).map((p,i)=>(
                    <div key={i} style={{background:CA.navy2,border:`1px solid ${CA.border}`,borderRadius:8,padding:"8px 12px"}}>
                      <div style={{color:CA.text,fontSize:12,fontWeight:600}}>{p.exercise}</div>
                      <div style={{color:CA.blue,fontSize:13,fontWeight:700}}>{fmtWeight(p.weight,p.unit)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── WORKOUTS TAB ── */}
        {tab==="workouts"&&(()=>{
          // Group entries into sessions (entries within 3hrs = same session) — mirrors athlete-facing log view
          const sessions = groupIntoSessions(workouts)
            .sort((a,b)=>new Date(b.entries[0].created_at)-new Date(a.entries[0].created_at));
          const formChecks = workouts.filter(w=>w.raw_message?.startsWith("[Form review:"));
          const qaEntries = workouts.filter(w=>!isRealSession(w)&&!w.raw_message?.startsWith("[Form review:"));

          const timeline = [
            ...sessions.map(s=>({type:"session",data:s,date:new Date(s.entries[s.entries.length-1].created_at)})),
            ...formChecks.map(w=>({type:"formcheck",data:w,date:new Date(w.created_at)})),
            ...qaEntries.map(w=>({type:"qa",data:w,date:new Date(w.created_at)})),
          ].sort((a,b)=>b.date-a.date);

          if(timeline.length===0) return (
            <div style={{color:CA.muted,textAlign:"center",padding:40,fontSize:13}}>No activity logged yet.</div>
          );

          return (
            <div>
              {timeline.slice(0,60).map((item,i)=>{
                // ── Workout / run session (merged across entries within the 3hr window) ──
                if(item.type==="session"){
                  const session = item.data;
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

                  const allRunData = session.entries.map(e=>{
                    const pd = typeof e.parsed_data==="string"?(()=>{try{return JSON.parse(e.parsed_data);}catch{return {};}})():(e.parsed_data||{});
                    return pd.run_data;
                  }).filter(Boolean);
                  const isRunSession = allRunData.length>0 && allExercises.length===0;
                  const runDotColor = isRunSession ? CA.blue : CA.green;

                  return (
                    <div key={i} style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:6,height:6,borderRadius:"50%",background:runDotColor,flexShrink:0}}/>
                          <div style={{color:CA.accent,fontSize:11,fontWeight:700,letterSpacing:1}}>{isRunSession?"RUN":"WORKOUT"} — {fmtDateRelative(sessionDate)}</div>
                        </div>
                        {!isRunSession&&feelVal&&<div style={{fontSize:11,color:feelVal==="great"||feelVal==="good"?CA.green:feelVal==="rough"?CA.red:CA.accent,fontWeight:600}}>{feelVal}</div>}
                      </div>
                      {isRunSession?(
                        <RunCard runData={allRunData[0]} feel={feelVal}/>
                      ):(
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:allPainFlags.length>0?8:0}}>
                          <thead>
                            <tr>
                              {["Exercise","Sets","Feel"].map(h=>(
                                <th key={h} style={{color:CA.muted,fontWeight:600,fontSize:10,letterSpacing:1,textAlign:"left",paddingBottom:4,borderBottom:`1px solid ${CA.border}`}}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {allExercises.map((e,j)=>(
                              <tr key={j}>
                                <td style={{color:CA.text,fontWeight:600,padding:"5px 8px 5px 0",verticalAlign:"top"}}>{e.name}</td>
                                <td style={{color:CA.muted2,padding:"5px 8px 5px 0",verticalAlign:"top"}}>{formatSetDetails(e)}</td>
                                <td style={{color:e.feel==="easy"?CA.blue:e.feel==="hard"?CA.red:CA.muted,padding:"5px 0",verticalAlign:"top"}}>{e.feel||"—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {allPainFlags.length>0&&<div style={{color:CA.red,fontSize:11,marginTop:4}}>⚠ {allPainFlags.map(p=>p.area).join(", ")}</div>}
                      {lastReply&&<div style={{marginTop:8,borderTop:`1px solid ${CA.border}`,paddingTop:8,color:CA.muted2,fontSize:12,fontStyle:"italic"}}>Coach Joe: "{lastReply.slice(0,200)}{lastReply.length>200?"...":""}"</div>}
                    </div>
                  );
                }
                // ── Form check ──
                if(item.type==="formcheck"){
                  const w = item.data;
                  return (
                    <div key={i} style={{background:CA.navy3,border:`1px solid ${CA.blue}30`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:CA.blue,flexShrink:0}}/>
                        <div style={{color:CA.blue,fontSize:11,fontWeight:700,letterSpacing:1}}>FORM CHECK — {fmtDateRelative(w.created_at)}</div>
                      </div>
                      <div style={{color:CA.muted2,fontSize:12,marginBottom:6}}>{w.raw_message}</div>
                      {w.bot_reply&&<div style={{color:CA.text,fontSize:12,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.bot_reply}</div>}
                    </div>
                  );
                }
                // ── Q&A / Chat ──
                const w = item.data;
                return (
                  <div key={i} style={{marginBottom:10}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:CA.muted,flexShrink:0}}/>
                      <div style={{color:CA.muted,fontSize:10,letterSpacing:1}}>Q&A — {fmtDate(w.created_at)}</div>
                    </div>
                    <div style={{display:"flex",justifyContent:"flex-end",marginBottom:4}}>
                      <div style={{background:"linear-gradient(135deg,#3f7bff,#2258e0)",color:"#fff",borderRadius:"14px 14px 4px 14px",padding:"8px 12px",fontSize:12,maxWidth:"85%"}}>{w.raw_message}</div>
                    </div>
                    {w.bot_reply&&(
                      <div style={{display:"flex",gap:6,alignItems:"flex-start"}}>
                        <div style={{width:22,height:22,borderRadius:"50%",background:`linear-gradient(135deg,#57a0ff,#2a63e6)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"#fff",flexShrink:0,marginTop:2}}>J</div>
                        <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:"14px 14px 14px 4px",padding:"8px 12px",fontSize:12,color:CA.text,maxWidth:"85%",lineHeight:1.5}}>{w.bot_reply}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* ── PROGRESS TAB ── */}
        {tab==="progress"&&(
          <div>
            {(()=>{
              // Build per-exercise progression from full workout history
              const bodyweight = athlete.weight_lbs;
              const byEx = {};
              workouts.forEach(w=>{
                const pd = typeof w.parsed_data==="string"?(()=>{try{return JSON.parse(w.parsed_data);}catch{return {};}})():(w.parsed_data||{});
                (pd.exercises||[]).forEach(ex=>{
                  if(!ex.name) return;
                  // Pass bodyweight so load-bearing bodyweight lifts (dips, pull-ups) score.
                  const e1rm = bestE1RMForExercise(ex, bodyweight);
                  if(!e1rm) return;
                  const k = normalizeExName(ex.name);
                  const isBW = ex.unit==="bodyweight";
                  const unit = isBW ? "lbs" : (ex.unit||"lbs");
                  if(!byEx[k]) byEx[k]={key:k,name:displayForKey(k,ex.name),unit,entries:[]};
                  else byEx[k].name=displayForKey(k,cleanerName(byEx[k].name,ex.name));
                  let topSet;
                  if(isBW){
                    // Effective load = bodyweight (+added/−assist); best set = most reps.
                    const bwLoad = (bodyweight||0)+(ex.added_weight||0)-(ex.assist_weight||0);
                    const sets = getExerciseSets(ex);
                    const working = sets.some(s=>!s.warmup) ? sets.filter(s=>!s.warmup) : sets;
                    const reps = working.reduce((m,s)=>Math.max(m,s.reps||0),0) || (ex.reps||1);
                    topSet = {weight:bwLoad, reps};
                  } else {
                    topSet = getExerciseSets(ex).reduce((b,s)=>epley1RM(toLbs(s.weight,unit),s.reps)>epley1RM(toLbs(b.weight,unit),b.reps)?s:b, {weight:ex.weight??0, reps:ex.reps||1});
                  }
                  byEx[k].entries.push({date:new Date(w.created_at),weight:topSet.weight,unit,reps:topSet.reps||1,e1rm});
                });
              });
              const exercises = Object.values(byEx)
                .map(ex=>{
                  const sorted=[...ex.entries].sort((a,b)=>a.date-b.date);
                  const best=Math.max(...sorted.map(e=>e.e1rm));
                  const bestEntry=sorted.reduce((a,b)=>b.e1rm>a.e1rm?b:a);
                  return {...ex,entries:sorted,best,bestEntry};
                })
                .sort((a,b)=>liftTier(a.key)-liftTier(b.key) || b.best-a.best);

              if(exercises.length===0) return (
                <div style={{color:CA.muted,textAlign:"center",padding:40,fontSize:13}}>No weighted exercises logged yet.</div>
              );

              return exercises.map((ex,i)=>(
                <div key={i} style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:16,marginBottom:14}}>
                  {/* Header row */}
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                    <div>
                      <div style={{color:CA.text,fontWeight:700,fontSize:14}}>{ex.name}</div>
                      <div style={{color:CA.muted,fontSize:11,marginTop:2}}>{ex.entries.length} logged set{ex.entries.length!==1?"s":""}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{color:CA.muted,fontSize:10,letterSpacing:1,marginBottom:2}}>LIFETIME BEST EST. 1RM</div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:CA.accent,lineHeight:1}}>
                        {ex.best}<span style={{fontSize:13,color:CA.muted,fontFamily:"'DM Sans'",marginLeft:2}}>{ex.unit==="kg"?"kg":"lbs"}</span>
                      </div>
                      <div style={{color:CA.muted,fontSize:10,marginTop:2}}>{fmtWeight(ex.bestEntry.weight,ex.unit)} × {ex.bestEntry.reps} rep{ex.bestEntry.reps!==1?"s":""}</div>
                    </div>
                  </div>
                  {/* Chart or single-entry note */}
                  {ex.entries.length>=2?(
                    <LineChart data={ex.entries.map(e=>({label:fmtDateShort(e.date),y:e.e1rm}))} color={CA.cyan} unit={ex.unit==="kg"?"kg":"lbs"} palette={CA}/>
                  ):(
                    <div style={{background:CA.navy2,borderRadius:8,padding:"8px 12px",fontSize:12,color:CA.muted2}}>
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
              <div style={{background:`${CA.accent}12`,border:`1px solid ${CA.accent}50`,borderRadius:12,padding:14,marginBottom:16}}>
                <div style={{color:CA.accent,fontSize:11,fontWeight:700,letterSpacing:1,marginBottom:6}}>✈️ TEMPORARY PROGRAM ACTIVE</div>
                <div style={{color:CA.muted2,fontSize:12,lineHeight:1.6,marginBottom:10,whiteSpace:"pre-wrap"}}>{athlete.temp_program_text}</div>
                <div style={{color:CA.muted,fontSize:11}}>Joe-bot is using this instead of the regular program. It will revert automatically when {athlete.name} tells Joe-bot they're back to normal.</div>
              </div>
            )}

            <div style={{background:CA.navy3,border:`1px solid ${CA.border}`,borderRadius:12,padding:14,marginBottom:16,color:CA.muted2,fontSize:13,lineHeight:1.65}}>
              {athlete.temp_program_text
                ? <><span style={{color:CA.muted,fontWeight:600}}>Regular program (on hold).</span> Joe-bot is currently using the temporary program above. This will resume when the athlete returns to normal training.</>
                : athlete.program_text
                  ? <><span style={{color:CA.blue,fontWeight:600}}>Program active.</span> This was set via the Joe-bot conversation or submitted by a coach. Joe-bot references it whenever making recommendations or logging workouts. You can edit or replace it below.</>
                  : <>No program set yet. You can paste or write a program here and Joe-bot will reference it going forward. Alternatively, the athlete can describe their program to Joe-bot ("my program is...") and it will be saved automatically.</>
              }
            </div>

            {athlete.program_text&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:athlete.temp_program_text?CA.muted:CA.blue,flexShrink:0}}/>
                <div style={{color:athlete.temp_program_text?CA.muted:CA.blue,fontSize:12}}>{athlete.temp_program_text?"On hold — resumes when temporary program clears":"Joe-bot references this in every conversation with "+athlete.name}</div>
                {!athlete.program_locked&&!athlete.temp_program_text&&<div style={{background:`${CA.blue}15`,border:`1px solid ${CA.blue}30`,borderRadius:6,padding:"2px 8px",color:CA.blue,fontSize:11}}>🔄 Live — updates when {athlete.name} describes their program to Joe-bot</div>}
              </div>
            )}

            <textarea
              value={programText}
              onChange={e=>setProgramText(e.target.value)}
              placeholder={"Paste or write the athlete's training program here...\n\nExamples:\n  Week 1: Squat 3×5, Bench 3×5, Deadlift 1×5\n  Week 2: Squat 3×5 +5lbs, Bench 3×5 +5lbs\n\nOr paste a full multi-week periodization plan — Joe-bot will read the whole thing."}
              rows={14}
              style={{width:"100%",background:CA.navy3,border:`1px solid ${programText!==(athlete.program_text||"")?CA.accent:CA.border}`,borderRadius:12,padding:"12px 14px",color:CA.text,fontSize:13,outline:"none",resize:"vertical",lineHeight:1.6,fontFamily:"'DM Sans'",transition:"border-color 0.15s"}}
            />

            <input ref={programPhotoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhotoProgram}/>
            <div style={{display:"flex",gap:8,marginTop:12,alignItems:"center",flexWrap:"wrap"}}>
              <button onClick={handleProgramSave} disabled={programSaving||programText===(athlete.program_text||"")}
                style={{background:programSaving||programText===(athlete.program_text||"")?CA.navy3:CA_BTN,color:programSaving||programText===(athlete.program_text||"")?CA.muted:"#fff",border:`1px solid ${programSaving||programText===(athlete.program_text||"")?CA.border:CA.accent}`,boxShadow:programSaving||programText===(athlete.program_text||"")?"none":`0 4px 16px ${CA_GLOW}`,borderRadius:10,padding:"10px 20px",cursor:programSaving||programText===(athlete.program_text||"")?"not-allowed":"pointer",fontSize:13,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1}}>
                {programSaving?"Saving...":"Save Program"}
              </button>
              <button onClick={()=>programPhotoRef.current?.click()} disabled={photoProcessing}
                style={{background:CA.navy3,border:`1px solid ${CA.border}`,color:CA.muted2,borderRadius:10,padding:"10px 14px",cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",gap:6,opacity:photoProcessing?0.6:1}}>
                {photoProcessing?"Reading photo...":"📷 Photo upload"}
              </button>
              <button onClick={toggleLock}
                style={{background:programLocked?`${CA.accent}20`:"transparent",border:`1px solid ${programLocked?CA.accent:CA.border}`,color:programLocked?CA.accent:CA.muted,borderRadius:10,padding:"10px 14px",cursor:"pointer",fontSize:13}}>
                {programLocked?"🔒 Program locked":"🔓 Unlocked"}
              </button>
              {programSaved&&<div style={{color:CA.green,fontSize:13,fontWeight:600}}>✓ Saved</div>}
              {!programSaved&&programText!==(athlete.program_text||"")&&!programSaving&&!programError&&<div style={{color:CA.muted,fontSize:12}}>Unsaved changes</div>}
              {programError&&<div style={{color:CA.red,fontSize:12,fontWeight:600}}>⚠ {programError}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default CoachDashboard;
