// ─── COACH DASHBOARD (lazy-loaded chunk) ─────────────────────────────────────
// Split out of App.jsx so athletes (95% of users) never download the coach UI.
// Loaded via React.lazy from WilcoRoot; shares App.jsx helpers (incl. the module-
// level CURRENT_AUTH session inside the sb*/idApi/askClaude helpers) by import —
// the dynamic import means the cycle App→coach→App is resolved at load time.
import { useState, useEffect, useRef, useMemo } from "react";
import {
  C, GS, LineChart, MASTER_CODE, RunCard, SUPABASE_KEY, SUPABASE_URL, askClaude, bestE1RMForExercise, btn, cleanerName, daysBetween, displayForKey, epley1RM, fmtDate, fmtDateRelative, fmtDateShort, fmtWeight, formatSetDetails, getAuth, getExerciseSets, groupIntoSessions, haptic, idApi, inp, isRealSession, liftTier, normalizeExName, sbDelete, sbInsert, sbRead, sbUpdate, sbUpdateWhere, toLbs, track, useIsMobile
} from "./App.jsx";
// Shared deterministic engine (Phase 0 extraction) — per-athlete session/adherence
// math, computed live client-side for the Overview. Aliased to avoid colliding with
// App.jsx's multi-athlete groupIntoSessions already imported above.
import {
  groupIntoSessions as pcGroup, compareProgramVsActual, buildOneRMs, aggregateInjuries, totalSetVolume,
  trueImprovementPRs, classifyTiers, blendAdherenceScore,
} from "./proofcore.js";
import { computeGritSnapshot, TIER_NAMES, getBenchKey } from "./grit.js";
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
  const [reportFilter,setReportFilter] = useState("all"); // "all" | "weekly" | "monthly"
  const [reportSearch,setReportSearch] = useState("");
  const [reportFlagFilter,setReportFlagFilter] = useState(false);
  const [selectedDigest,setSelectedDigest] = useState(null);
  useEffect(()=>{ track("coach_dashboard_view","coach_dashboard"); },[]);
  const isMobile = useIsMobile();
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

  const tabs = ["overview","athletes","stats","reports",...(isMaster?["coaches"]:[]),...(!isMaster&&isAdmin?["account"]:[])];

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
            {/* ── OVERVIEW TAB ── */}
            {activeTab==="overview"&&(
              <CoachOverview athletes={athletes} workouts={workouts} prs={prs} manualRMs={manualRMs} prescriptions={prescriptions}
                onOpenAthlete={(id)=>{const at=athletes.find(a=>a.id===id); if(at){setSelected(at);setActiveTab("athletes");}}}/>
            )}

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
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>setShowBulkModal(true)}
                          style={{background:C.gold,border:"none",color:"#000",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap"}}>
                          Program ({selectedIds.size})
                        </button>
                        {isMaster&&(
                          <button onClick={()=>setShowAssignCoachModal(true)}
                            style={{background:C.blue,border:"none",color:"#000",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap"}}>
                            Coach ({selectedIds.size})
                          </button>
                        )}
                      </div>
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
                            <div style={{color:C.text,fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}>{a.name}{a.certified_badge_earned_at&&<span title="WILCO Certified" style={{color:C.gold,fontSize:10,flexShrink:0}}>✦</span>}</div>
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
                      requests={changeRequests.filter(r=>r.athlete_id===selected.id)}
                      onResolveRequest={async (req,status)=>{
                        await sbUpdate("program_change_requests",req.id,{status,resolved_at:new Date().toISOString()});
                        setChangeRequests(prev=>prev.filter(r=>r.id!==req.id));
                      }}
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
                  <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:24,width:"100%",maxWidth:460}}
                    onClick={e=>e.stopPropagation()}>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:C.gold,letterSpacing:2,marginBottom:4}}>ASSIGN TO COACH</div>
                    <div style={{color:C.muted,fontSize:12,marginBottom:14}}>
                      Moving {selectedIds.size} athlete{selectedIds.size!==1?"s":""} to a coach/school. This overwrites their current assignment.
                    </div>
                    <select value={assignCoachId} onChange={e=>setAssignCoachId(e.target.value)}
                      style={{width:"100%",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"11px 12px",color:C.text,fontSize:13,outline:"none",marginBottom:14}}>
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
                    {assignError&&<div style={{color:C.red,fontSize:12,marginBottom:10}}>{assignError}</div>}
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>{setShowAssignCoachModal(false);setAssignCoachId("");setAssignError("");}}
                        style={{flex:1,background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14}}>Cancel</button>
                      <button onClick={handleBulkAssignCoach} disabled={assignSaving}
                        style={{flex:2,background:C.blue,border:"none",color:"#000",borderRadius:10,padding:"11px",cursor:"pointer",fontSize:14,fontWeight:700,fontFamily:"'Bebas Neue'",letterSpacing:1,opacity:assignSaving?0.6:1}}>
                        {assignSaving?"Saving...":(assignCoachId?`Assign ${selectedIds.size} Athlete${selectedIds.size!==1?"s":""} →`:`Unassign ${selectedIds.size} Athlete${selectedIds.size!==1?"s":""} →`)}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* ── GROUP STATS TAB ── */}
            {activeTab==="stats"&&(
              <GroupStats athletes={athletes} workouts={workouts} prs={prs}/>
            )}

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
                  return <CoachEdition digest={selectedDigest} athletes={athletes} coach={coach} onBack={()=>setSelectedDigest(null)} onRead={loadAll}/>;
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
                    <button onClick={()=>setSelectedDigest(null)} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,marginBottom:14}}>← Back to Reports</button>
                    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:18}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                        <div>
                          <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>{selectedDigest.label}</div>
                          <div style={{color:C.muted,fontSize:12}}>{isTeam?"Team report":`${a?.name||"Unknown"} · ${a?.sport||""}`}</div>
                        </div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"flex-end"}}>
                          {selectedDigest.has_plateau&&<div style={{background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:4,padding:"2px 7px",color:"#ef4444",fontSize:10,fontWeight:700}}>PLATEAU</div>}
                          {selectedDigest.has_pain&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:4,padding:"2px 7px",color:"#ef4444",fontSize:10}}>{isTeam?"INJURIES":"PAIN FLAG"}</div>}
                          {selectedDigest.has_missed&&<div style={{background:"rgba(100,116,139,0.2)",border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 7px",color:C.muted,fontSize:10}}>{isTeam?"AT-RISK":"MISSED SESSIONS"}</div>}
                        </div>
                      </div>
                      {c.intro&&<div style={{color:C.text,fontSize:13,lineHeight:1.65,marginBottom:12,fontStyle:"italic"}}>{c.intro}</div>}
                      {sections.map((s,i)=>(
                        <div key={i} style={{background:C.navy3,border:`1px solid ${s.flag==="warn"?"rgba(239,68,68,0.3)":C.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                          <div style={{color:s.flag==="warn"?"#ef4444":C.muted,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:6}}>{s.label}</div>
                          <div style={{color:C.text,fontSize:13,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{s.body}</div>
                        </div>
                      ))}
                      {/* Team report: outliers + coach actions */}
                      {isTeam&&(ol.mostImproved?.length>0||ol.atRisk?.length>0||ol.volumeCratered?.length>0)&&(
                        <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 14px",marginBottom:8}}>
                          <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:8}}>FLAGGED OUTLIERS</div>
                          {ol.mostImproved?.length>0&&<div style={{color:C.text,fontSize:13,marginBottom:4}}><span style={{color:C.green}}>↑ Most improved:</span> {ol.mostImproved.map(o=>`${o.name} (+${o.delta})`).join(", ")}</div>}
                          {ol.atRisk?.length>0&&<div style={{color:C.text,fontSize:13,marginBottom:4}}><span style={{color:"#ef4444"}}>⚠ At risk:</span> {ol.atRisk.join(", ")}</div>}
                          {ol.volumeCratered?.length>0&&<div style={{color:C.text,fontSize:13}}><span style={{color:C.gold}}>↓ Volume cratered:</span> {ol.volumeCratered.map(o=>`${o.name} (${o.gap}%)`).join(", ")}</div>}
                        </div>
                      )}
                      {isTeam&&Array.isArray(c.actions)&&c.actions.length>0&&(
                        <div style={{background:"rgba(16,185,129,0.1)",border:"1px solid rgba(16,185,129,0.3)",borderRadius:10,padding:"12px 14px"}}>
                          <div style={{color:C.green,fontSize:10,fontWeight:700,letterSpacing:1.5,marginBottom:6}}>COACH ACTIONS</div>
                          <ul style={{margin:0,paddingLeft:16,color:C.text,fontSize:13,lineHeight:1.7}}>{c.actions.map((act,i)=><li key={i}>{act}</li>)}</ul>
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
                    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16,marginBottom:20}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>TEAM LEADERBOARD</div>
                        <div style={{color:C.muted,fontSize:10}}>As of {leaderboard.asOf}</div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                        {[{label:"Most Improved",data:leaderboard.improved},{label:"Most Impressive Lift",data:leaderboard.impressive},{label:"Most Consistent",data:leaderboard.consistent}].map(({label,data})=>(
                          <div key={label}>
                            <div style={{color:C.muted,fontSize:10,fontWeight:700,letterSpacing:1,marginBottom:8,textTransform:"uppercase"}}>{label}</div>
                            {data.length===0?<div style={{color:C.muted,fontSize:11,fontStyle:"italic"}}>Not enough data</div>:data.map((entry,i)=>(
                              <div key={i} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                                <span style={{color:i===0?C.gold:C.muted,fontSize:i===0?14:11,flexShrink:0}}>{i===0?"🥇":i===1?"2.":"3."}</span>
                                <div style={{minWidth:0}}>
                                  <div style={{color:C.text,fontSize:12,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.athlete.name}</div>
                                  <div style={{color:C.muted,fontSize:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{entry.metric}</div>
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
                    <button onClick={()=>setSelectedDigest(latestTeamReport)} style={{width:"100%",background:C.navy2,border:`1px solid ${C.gold}40`,borderRadius:14,padding:16,textAlign:"left",cursor:"pointer",display:"block",marginBottom:16}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>TEAM REPORT</div>
                        <div style={{display:"flex",gap:6}}>
                          {latestTeamReport.has_pain&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:4,padding:"2px 6px",color:"#ef4444",fontSize:10}}>INJURIES</div>}
                          {latestTeamReport.has_missed&&<div style={{background:`${C.navy3}`,border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 6px",color:C.muted,fontSize:10}}>AT-RISK</div>}
                        </div>
                      </div>
                      {latestTeamReport.content_json?.intro&&<div style={{color:C.text,fontSize:13,lineHeight:1.6,marginBottom:8}}>{latestTeamReport.content_json.intro}</div>}
                      <div style={{color:C.gold,fontSize:12,fontWeight:700,letterSpacing:1}}>OPEN REPORT →</div>
                    </button>
                  )}
                  {/* Filters */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
                    <input value={reportSearch} onChange={e=>setReportSearch(e.target.value)} placeholder="Search athlete..."
                      style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",color:C.text,fontSize:13,outline:"none",flex:1,minWidth:120}}/>
                    {["all","weekly","monthly"].map(f=>(
                      <button key={f} onClick={()=>setReportFilter(f)}
                        style={{background:reportFilter===f?`${C.gold}20`:"transparent",border:`1px solid ${reportFilter===f?C.gold:C.border}`,color:reportFilter===f?C.gold:C.muted,borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans'",fontWeight:reportFilter===f?700:400}}>
                        {f.charAt(0).toUpperCase()+f.slice(1)}
                      </button>
                    ))}
                    <button onClick={()=>setReportFlagFilter(p=>!p)}
                      style={{background:reportFlagFilter?`${C.red}20`:"transparent",border:`1px solid ${reportFlagFilter?"#ef4444":C.border}`,color:reportFlagFilter?"#ef4444":C.muted,borderRadius:6,padding:"6px 12px",cursor:"pointer",fontSize:12}}>
                      Flags only
                    </button>
                  </div>

                  {filtered.length===0?(
                    <div style={{textAlign:"center",padding:40,color:C.muted,fontSize:13}}>No reports found.</div>
                  ):(
                    <div style={{display:"flex",flexDirection:"column",gap:8}}>
                      {filtered.map((d,i)=>{
                        const a = athleteById[d.athlete_id];
                        const isMonthly = d.digest_type==="monthly";
                        return (
                          <button key={i} onClick={()=>setSelectedDigest(d)}
                            style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 16px",cursor:"pointer",textAlign:"left",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,transition:"border-color 0.15s"}}>
                            <div style={{minWidth:0}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                                <div style={{color:isMonthly?C.blue:C.gold,fontSize:10,fontWeight:700,letterSpacing:1.5}}>
                                  {isMonthly?"MONTHLY":"WEEKLY"}
                                </div>
                                <div style={{color:C.text,fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a?.name||"Unknown"}</div>
                              </div>
                              <div style={{color:C.muted,fontSize:11,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.label}</div>
                            </div>
                            <div style={{display:"flex",gap:5,flexShrink:0,alignItems:"center"}}>
                              {d.has_plateau&&<div style={{background:"rgba(239,68,68,0.15)",border:"1px solid rgba(239,68,68,0.4)",borderRadius:4,padding:"2px 6px",color:"#ef4444",fontSize:9,fontWeight:700}}>PLT</div>}
                              {d.has_pain&&<div style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:4,padding:"2px 6px",color:"#ef4444",fontSize:9}}>PAIN</div>}
                              {d.has_missed&&<div style={{background:`${C.navy3}`,border:`1px solid ${C.border}`,borderRadius:4,padding:"2px 6px",color:C.muted,fontSize:9}}>MISSED</div>}
                              <div style={{color:C.muted,fontSize:18}}>›</div>
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
            {activeTab==="account"&&isAdmin&&!isMaster&&(()=>{
              const schoolCoachesList = allCoaches.filter(c=>c.school_id===coach.school_id&&c.role!=="admin");
              const atLimit = schoolCoachesList.length>=(school?.max_coaches||3);
              const [acName,setAcName] = useState("");
              const [acEmail,setAcEmail] = useState("");
              const [acErr,setAcErr] = useState("");
              const [acOk,setAcOk] = useState("");
              const [acCode,setAcCode] = useState("");          // freshly-created coach code (for its copy button)
              const [codeCopied,setCodeCopied] = useState(null); // which code is showing "Copied!"
              const [acSaving,setAcSaving] = useState(false);

              const copyCoachCode = (code) => {
                if(!code || codeCopied===code) return;
                try{ navigator.clipboard.writeText(code); }catch(_){}
                haptic(10);
                setCodeCopied(code);
                setTimeout(()=>setCodeCopied(c=>c===code?null:c), 2000);
              };
              const codeBtn = (code) => {
                const done = codeCopied===code;
                return <button onClick={()=>copyCoachCode(code)} style={{background:done?C.gold:"none",border:`1px solid ${done?C.gold:C.border}`,color:done?"#000":C.muted2,borderRadius:6,padding:"2px 9px",cursor:done?"default":"pointer",fontSize:10,fontWeight:700,marginLeft:8,verticalAlign:"middle"}}>{done?"Copied!":"Copy"}</button>;
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
                if(!window.confirm(`Remove ${c.name}? Their athletes will remain unassigned.`)) return;
                try {
                  await sbUpdate("coaches",c.id,{pin:null,access_code:`REMOVED_${c.access_code}`});
                  await sbUpdateWhere("athletes",`?coach_id=eq.${c.id}`,{coach_id:null});
                  loadAll();
                }catch(e){}
              };

              return (
                <div style={{maxWidth:600}}>
                  <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:20,marginBottom:16}}>
                    <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:14}}>SCHOOL ACCOUNT</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:4}}>
                      <div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>SCHOOL</div><div style={{color:C.text,fontWeight:600,fontSize:14,marginTop:2}}>{school?.name||"—"}</div></div>
                      <div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>CODE</div><div style={{display:"flex",alignItems:"center",marginTop:2}}><span style={{color:C.gold,fontWeight:700,fontSize:18,fontFamily:"'Bebas Neue'",letterSpacing:2}}>{school?.code||"—"}</span>{school?.code&&codeBtn(school.code)}</div></div>
                      <div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>TIER</div><div style={{color:C.text,fontSize:13,marginTop:2}}>{school?.tier||"—"}</div></div>
                      <div><div style={{color:C.muted,fontSize:10,letterSpacing:1}}>COACHES</div><div style={{color:C.text,fontSize:13,marginTop:2}}>{schoolCoachesList.length} / {school?.max_coaches||3}</div></div>
                    </div>
                  </div>

                  <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:20,marginBottom:16}}>
                    <div style={{color:C.gold,fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:14}}>COACHES</div>
                    {schoolCoachesList.length===0?<div style={{color:C.muted,fontSize:13,marginBottom:12}}>No coaches added yet.</div>:schoolCoachesList.map(c=>{
                      const athCount=athletes.filter(a=>a.coach_id===c.id).length;
                      return(
                        <div key={c.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${C.border}`}}>
                          <div>
                            <div style={{color:C.text,fontWeight:600,fontSize:13}}>{c.name}</div>
                            <div style={{color:C.muted,fontSize:11}}>{c.email} · Code: {c.access_code} · {athCount} athlete{athCount!==1?"s":""}</div>
                          </div>
                          <button onClick={()=>doRemoveCoach(c)} style={{background:"none",border:`1px solid ${C.border}`,color:C.red,borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:11}}>Remove</button>
                        </div>
                      );
                    })}

                    <div style={{marginTop:16}}>
                      <div style={{color:C.muted,fontSize:11,letterSpacing:1,marginBottom:10}}>ADD COACH</div>
                      {atLimit?<div style={{color:C.muted,fontSize:12,fontStyle:"italic"}}>Coach limit reached for your plan ({school?.max_coaches||3} max).</div>:(
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr auto",gap:8,alignItems:"center"}}>
                          <input value={acName} onChange={e=>setAcName(e.target.value)} placeholder="Coach name" style={inp({padding:"9px 12px",fontSize:13})}/>
                          <input type="email" value={acEmail} onChange={e=>setAcEmail(e.target.value)} placeholder="email@school.edu" style={inp({padding:"9px 12px",fontSize:13})}/>
                          <button onClick={doAddCoach} disabled={acSaving} style={{background:C.gold,border:"none",color:"#000",borderRadius:8,padding:"9px 14px",cursor:"pointer",fontWeight:700,fontSize:13,fontFamily:"'Bebas Neue'",letterSpacing:1,whiteSpace:"nowrap",opacity:acSaving?0.7:1}}>
                            {acSaving?"Adding...":"Add Coach →"}
                          </button>
                        </div>
                      )}
                      {acErr&&<div style={{color:C.red,fontSize:12,marginTop:8}}>{acErr}</div>}
                      {acOk&&<div style={{color:C.green,fontSize:12,marginTop:8,fontWeight:600}}>{acOk}{acCode&&<> Code: <span style={{fontFamily:"'Bebas Neue'",letterSpacing:1,color:C.gold,fontSize:14}}>{acCode}</span>{codeBtn(acCode)}</>}</div>}
                    </div>
                  </div>
                </div>
              );
            })()}

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
// ─── OVERVIEW (Coach Dashboard home) ─────────────────────────────────────────
// Graphs-first team-health home. Every number here is computed LIVE, client-side,
// from the shared proofcore engine (Phase 0) over the roster data already loaded —
// zero tokens, no new round-trip. See docs/coach-experience-vision.md §1.
const DAYMS = 86400000;
const FEEL_ORDER = [["great","Great",C.green],["good","Good",C.blue],["average","OK",C.gold],["rough","Rough",C.red]];
// prE1RM, trueImprovementPRs, classifyTiers, blendAdherenceScore now live in
// proofcore (shared with the server Coach's Edition so the two never disagree).

function StatBand({tone,label}){
  const c = tone==="good"?C.green:tone==="warn"?C.gold:tone==="crit"?C.red:C.blue;
  return <span style={{fontSize:9,fontWeight:800,letterSpacing:.5,textTransform:"uppercase",padding:"2px 8px",borderRadius:999,whiteSpace:"nowrap",color:c,background:`${c}22`,border:`1px solid ${c}55`}}>{label}</span>;
}
function OverviewCard({title,trend,children,readout,tone}){
  return (
    <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:10}}>
        <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:C.muted2,fontWeight:700}}>{title}</div>
        {trend&&<div style={{fontSize:11.5,fontWeight:700,color:trend.dir==="up"?C.green:trend.dir==="down"?C.red:C.muted,whiteSpace:"nowrap"}}>{trend.dir==="up"?"▲":trend.dir==="down"?"▼":"—"} {trend.txt}</div>}
      </div>
      {children}
      {readout&&<div style={{marginTop:11,display:"flex",alignItems:"center",gap:8,fontSize:12,color:C.muted2,lineHeight:1.4}}><span style={{flex:1}}>{readout}</span>{tone&&<StatBand tone={tone.k} label={tone.t}/>}</div>}
    </div>
  );
}

function CoachOverview({athletes,workouts,prs,manualRMs,prescriptions,onOpenAthlete}){
  const [resolved,setResolved] = useState(()=>new Set());
  const D = useMemo(()=>{
    const now = Date.now();
    const dstart = (t)=>{const x=new Date(t);x.setHours(0,0,0,0);return x.getTime();};
    const inWin = (w,from,to=now)=>{const t=new Date(w.created_at).getTime();return t>=from&&t<to;};
    const woByAth={}, prByAth={}, manByAth={}, prescByAth={};
    workouts.forEach(w=>{(woByAth[w.athlete_id]=woByAth[w.athlete_id]||[]).push(w);});
    prs.forEach(p=>{(prByAth[p.athlete_id]=prByAth[p.athlete_id]||[]).push(p);});
    manualRMs.forEach(m=>{(manByAth[m.athlete_id]=manByAth[m.athlete_id]||[]).push(m);});
    prescriptions.forEach(pp=>{prescByAth[pp.athlete_id]=pp;});
    const weekAgo=now-7*DAYMS, twoWk=now-14*DAYMS;

    const rows = athletes.map(a=>{
      const wo = woByAth[a.id]||[];
      const thisWk = pcGroup(wo.filter(w=>inWin(w,weekAgo)));
      const lastWk = pcGroup(wo.filter(w=>inWin(w,twoWk,weekAgo)));
      const parsed = prescByAth[a.id]?.parsed_json || null;
      const oneRMs = buildOneRMs(prByAth[a.id]||[], manByAth[a.id]||[]);
      const adherence = parsed ? compareProgramVsActual(parsed, thisWk, oneRMs) : null;
      const injuries = aggregateInjuries([...lastWk,...thisWk]);
      const hasProgram = !!(a.program_text && a.program_text.trim().length>10);
      const presDays = a.training_days_per_week || parsed?.blocks?.[0]?.days?.length || null;
      const score = blendAdherenceScore(thisWk.length, adherence, hasProgram, presDays);
      // per-day logged flags for the heatmap (Mon..Sun of the last 7 days)
      const days = [];
      for(let i=6;i>=0;i--){ const ds=dstart(now-i*DAYMS), de=ds+DAYMS; days.push((wo.some(w=>{const t=new Date(w.created_at).getTime();return t>=ds&&t<de&&(w.parsed_data?.exercises?.length>0||w.parsed_data?.run_data);}))?1:0); }
      const snap = computeGritSnapshot(wo, manByAth[a.id]||[], {bodyweightLbs:a.weight_lbs||a.weight||0, gender:a.gender, age:a.age});
      return {a, thisWk, lastWk, adherence, injuries, hasProgram, score, days, snap};
    });

    // sessions/day last 7d (across roster)
    const dayCounts=[], dayLabels=[];
    for(let i=6;i>=0;i--){ const ds=dstart(now-i*DAYMS), de=ds+DAYMS;
      dayLabels.push(new Date(ds).toLocaleDateString("en-US",{weekday:"short"}));
      dayCounts.push(athletes.reduce((s,a)=>s+pcGroup((woByAth[a.id]||[]).filter(w=>{const t=new Date(w.created_at).getTime();return t>=ds&&t<de;})).length,0));
    }
    const firstHalf = dayCounts.slice(0,3).reduce((a,b)=>a+b,0)||0, lastHalf = dayCounts.slice(4).reduce((a,b)=>a+b,0)||0;

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

    // volume-load: total working sets across roster, last 4 weeks
    const volWeeks=[];
    for(let i=3;i>=0;i--){ const from=now-(i+1)*7*DAYMS, to=now-i*7*DAYMS;
      volWeeks.push(athletes.reduce((s,a)=>s+totalSetVolume(pcGroup((woByAth[a.id]||[]).filter(w=>inWin(w,from,to)))),0));
    }

    // true PRs — this week + last 6 weeks (weekly bars)
    const truePRs = trueImprovementPRs(prs);
    const prWeeks=[];
    for(let i=5;i>=0;i--){ const from=now-(i+1)*7*DAYMS, to=now-i*7*DAYMS;
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

    // wins — top true-PR shout-outs this week
    const shoutouts = truePRs.filter(p=>{const t=new Date(p.created_at||p.date||0).getTime();return t>=weekAgo;})
      .sort((a,b)=>b.gain-a.gain).slice(0,3)
      .map(p=>({name:(athletes.find(a=>a.id===p.athlete_id)||{}).name||"Athlete", ex:p.exercise, weight:p.weight, unit:p.unit, gain:Math.round(p.gain)}));

    // briefing triage — ranked "who needs you today" (injury > quiet > adherence drop)
    const triage=[];
    rows.forEach(r=>{
      const inj=r.injuries;
      if(inj&&((inj.recurring&&inj.recurring.length)||(inj.active&&inj.active.length))){
        const rec=inj.recurring&&inj.recurring[0]; const area=rec?rec.area:inj.active[0];
        triage.push({id:r.a.id,sev:"crit",kind:"Injury",name:r.a.name,what:`${area} flagged${rec?` ${rec.count} sessions running`:" this week"}`});
      } else if(r.thisWk.length===0 && r.lastWk.length>0){
        triage.push({id:r.a.id,sev:"warn",kind:"Quiet",name:r.a.name,what:`no session this week — trained last week`});
      } else if(r.score!=null && r.score<55){
        triage.push({id:r.a.id,sev:"warn",kind:"Adherence",name:r.a.name,what:`adherence slipping (${r.score}%)`});
      }
    });
    triage.sort((a,b)=>(a.sev==="crit"?0:1)-(b.sev==="crit"?0:1));

    return {rows,dayCounts,dayLabels,firstHalf,lastHalf,activeCount,activePct,teamAdh,noProgram,feelCounts,feelTotal,volWeeks,prWeeks,prThisWk,strengths,weaknesses,shoutouts,triage};
  },[athletes,workouts,prs,manualRMs,prescriptions]);

  if(!athletes.length) return <div style={{textAlign:"center",padding:60,color:C.muted}}>No athletes on your roster yet.</div>;

  const triage = D.triage.filter(t=>!resolved.has(t.id));

  const feelPct = (k)=>D.feelTotal?Math.round(100*D.feelCounts[k]/D.feelTotal):0;
  const volMax = Math.max(1,...D.volWeeks), prMax = Math.max(1,...D.prWeeks);
  const cell = (v)=>v?C.green:C.navy3;
  // top rows to show in the adherence heatmap: worst adherence first (needs attention)
  const heatRows = [...D.rows].filter(r=>r.hasProgram||r.thisWk.length>0)
    .sort((a,b)=>((a.score??999)-(b.score??999))).slice(0,6);

  const secLabel = (t)=>(
    <div style={{display:"flex",alignItems:"center",gap:12,margin:"24px 2px 12px"}}>
      <span style={{fontSize:10.5,letterSpacing:1.4,textTransform:"uppercase",color:C.gold,fontWeight:700}}>{t}</span>
      <span style={{height:1,background:C.border,flex:1}}/>
    </div>
  );

  return (
    <div style={{maxWidth:1220}}>
      {/* ── Briefing triage — who needs you today ── */}
      <div style={{background:`linear-gradient(180deg,${C.navy3},${C.navy2})`,border:`1px solid ${C.border}`,borderRadius:16,overflow:"hidden",marginTop:4}}>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:12,padding:"15px 18px",borderBottom:`1px solid ${C.border}`,flexWrap:"wrap"}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:C.text,letterSpacing:1}}>{triage.length>0?`${triage.length} athlete${triage.length!==1?"s":""} need you today`:"You're all caught up"}</div>
          <div style={{color:C.muted,fontSize:12}}>Today's briefing · auto-updated from this week's logs</div>
        </div>
        {triage.length===0
          ? <div style={{padding:"26px 18px",textAlign:"center"}}><div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:C.green,letterSpacing:1}}>✓ Everything looks healthy</div><div style={{color:C.muted,fontSize:13,marginTop:4}}>Nothing needs you right now. The briefing refreshes as sessions come in.</div></div>
          : triage.slice(0,6).map((t)=>(
              <div key={t.id} style={{display:"flex",gap:12,padding:"12px 18px",borderBottom:`1px solid ${C.border}80`,alignItems:"center"}}>
                <span style={{width:3,alignSelf:"stretch",borderRadius:3,background:t.sev==="crit"?C.red:C.gold,flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:9.5,fontWeight:800,letterSpacing:1,textTransform:"uppercase",padding:"2px 7px",borderRadius:5,color:t.sev==="crit"?C.red:C.gold,background:t.sev==="crit"?`${C.red}22`:`${C.gold}22`,border:`1px solid ${t.sev==="crit"?C.red:C.gold}55`}}>{t.kind}</span>
                    <span style={{fontWeight:700,color:C.text,fontSize:14}}>{t.name}</span>
                    <span style={{color:C.muted,fontSize:13}}>— {t.what}</span>
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexShrink:0}}>
                  {onOpenAthlete&&<button onClick={()=>onOpenAthlete(t.id)} style={{border:`1px solid ${C.border}`,background:"transparent",color:C.muted,borderRadius:8,padding:"5px 11px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Open</button>}
                  <button onClick={()=>setResolved(s=>new Set(s).add(t.id))} style={{border:`1px solid ${C.border}`,background:"transparent",color:C.muted,borderRadius:8,padding:"5px 11px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Clear</button>
                </div>
              </div>
            ))}
        {triage.length>0&&<div style={{padding:"10px 18px",color:C.muted,fontSize:12,background:`${C.green}0d`}}>✓ {D.rows.length-triage.length} of {D.rows.length} on track · {D.prThisWk} true PR{D.prThisWk!==1?"s":""} this week</div>}
      </div>

      {secLabel("Team Health")}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:14}}>

        {/* Sessions/day */}
        <OverviewCard title="Sessions / day · last 7d"
          trend={{dir:D.lastHalf>=D.firstHalf?"up":"down",txt:`${D.dayCounts.reduce((a,b)=>a+b,0)} total`}}
          readout={D.lastHalf>=D.firstHalf?"Holding or climbing into the week.":"Sliding off through the week — worth a nudge."}
          tone={D.lastHalf>=D.firstHalf?{k:"good",t:"Healthy"}:{k:"warn",t:"Watch"}}>
          <LineChart data={D.dayLabels.map((l,i)=>({label:l,y:D.dayCounts[i]}))} color={C.green} unit=""/>
        </OverviewCard>

        {/* Program adherence + heatmap */}
        <OverviewCard title="Program adherence · this week"
          readout={D.teamAdh==null?`No parsed programs yet — assign & lock programs to track adherence.`:`Team average. ${D.noProgram>0?`${D.noProgram} without a program (excluded).`:"Everyone has a program."}`}
          tone={D.teamAdh==null?null:(D.teamAdh>=80?{k:"good",t:"Healthy"}:D.teamAdh>=60?{k:"warn",t:"Slipping"}:{k:"crit",t:"At risk"})}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:34,color:C.text,lineHeight:.9}}>{D.teamAdh==null?"—":D.teamAdh}<span style={{fontSize:15,color:C.muted}}> {D.teamAdh==null?"":"% team avg"}</span></div>
          <div style={{display:"grid",gridTemplateColumns:"78px repeat(7,1fr)",gap:4,alignItems:"center",marginTop:12}}>
            <span/>{D.dayLabels.map((l,i)=><span key={i} style={{fontSize:9,color:C.muted,textAlign:"center"}}>{l[0]}</span>)}
            {heatRows.flatMap((r,ri)=>[
              <span key={`n${ri}`} style={{fontSize:10.5,color:C.muted2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{r.a.name}</span>,
              ...r.days.map((d,di)=><i key={`c${ri}-${di}`} title={r.hasProgram?"":"no program"} style={{aspectRatio:"1",borderRadius:3,background:r.hasProgram?cell(d):(d?C.blue:C.navy3),opacity:r.hasProgram?1:.55,border:`1px solid #ffffff08`}}/>)
            ])}
          </div>
        </OverviewCard>

        {/* Active this week gauge */}
        <OverviewCard title="Active this week"
          readout={`${D.activeCount} of ${athletes.length} logged at least once.`}
          tone={D.activePct>=70?{k:"good",t:"Healthy"}:D.activePct>=50?{k:"warn",t:"Watch"}:{k:"crit",t:"Low"}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <svg viewBox="0 0 92 92" width="92" height="92" style={{width:92,flexShrink:0}}>
              <circle cx="46" cy="46" r="38" fill="none" stroke={C.border} strokeWidth="10"/>
              <circle cx="46" cy="46" r="38" fill="none" stroke={C.green} strokeWidth="10" strokeLinecap="round"
                strokeDasharray={2*Math.PI*38} strokeDashoffset={2*Math.PI*38*(1-D.activePct/100)} transform="rotate(-90 46 46)"/>
              <text x="46" y="44" textAnchor="middle" fill={C.text} fontFamily="'Bebas Neue'" fontSize="22">{D.activePct}%</text>
              <text x="46" y="59" textAnchor="middle" fill={C.muted} fontSize="8.5">{D.activeCount} / {athletes.length}</text>
            </svg>
            <div style={{fontSize:12,color:C.muted2}}>Share of the roster training this week.</div>
          </div>
        </OverviewCard>

        {/* Session feel */}
        <OverviewCard title="Session feel · this week"
          readout={D.feelTotal?`${feelPct("rough")}% logged "rough" — ${feelPct("rough")>=20?"watch for overreaching.":"in a healthy range."}`:"No session-feel logged yet this week."}
          tone={D.feelTotal?(feelPct("rough")>=20?{k:"warn",t:"Watch"}:{k:"good",t:"Healthy"}):null}>
          <div style={{display:"flex",height:20,borderRadius:6,overflow:"hidden",background:C.navy3}}>
            {FEEL_ORDER.map(([k,,c])=>feelPct(k)>0&&<div key={k} style={{width:`${feelPct(k)}%`,background:c}}/>)}
          </div>
          <div style={{display:"flex",gap:12,marginTop:9,fontSize:10.5,color:C.muted2,flexWrap:"wrap"}}>
            {FEEL_ORDER.map(([k,lbl,c])=><span key={k}><i style={{display:"inline-block",width:8,height:8,borderRadius:2,background:c,marginRight:5}}/>{lbl} {feelPct(k)}%</span>)}
          </div>
        </OverviewCard>

        {/* Team volume-load */}
        <OverviewCard title="Team volume · 4 wk"
          trend={{dir:D.volWeeks[3]>=D.volWeeks[0]?"up":"down",txt:"working sets"}}
          readout={D.volWeeks[3]>D.volWeeks[0]*1.5?"Sharp jump vs 4 weeks ago — watch load spikes.":"Gradual, inside a safe band."}
          tone={D.volWeeks[3]>D.volWeeks[0]*1.5?{k:"warn",t:"Watch"}:{k:"good",t:"Healthy"}}>
          <svg viewBox="0 0 260 60" preserveAspectRatio="none" style={{width:"100%"}}>
            <polyline fill="none" stroke={C.blue} strokeWidth="2" points={D.volWeeks.map((v,i)=>`${i*(260/3)},${54-48*(v/volMax)}`).join(" ")}/>
            {D.volWeeks.map((v,i)=><circle key={i} cx={i*(260/3)} cy={54-48*(v/volMax)} r="3" fill={C.blue}/>)}
          </svg>
          <div style={{fontSize:10.5,color:C.muted,marginTop:4}}>{D.volWeeks.map(v=>v).join(" → ")} sets/wk</div>
        </OverviewCard>

        {/* True PRs & tier-ups */}
        <OverviewCard title="True PRs · 6 wk"
          trend={{dir:"up",txt:`${D.prThisWk} this wk`}}
          readout={D.prThisWk>0?`Real improvements over prior bests — baselines excluded.`:`No new bests logged this week yet.`}
          tone={D.prThisWk>0?{k:"good",t:"Momentum"}:null}>
          <svg viewBox="0 0 260 64" preserveAspectRatio="none" style={{width:"100%"}}>
            {D.prWeeks.map((v,i)=>{const w=30,gap=(260-w*6)/6;const x=gap/2+i*(w+gap);const h=Math.max(3,54*(v/prMax));return <rect key={i} x={x} y={60-h} width={w} height={h} rx="2" fill={i===5?C.green:C.gold}/>;})}
          </svg>
        </OverviewCard>

      </div>

      {secLabel("Program & Wins")}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        {/* Strengths & weaknesses */}
        <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16}}>
          <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:C.muted2,fontWeight:700}}>Where the program is strong &amp; weak</div>
          <div style={{fontSize:12,color:C.muted2,margin:"8px 0 14px",lineHeight:1.4}}>Team Grit tiers by benchmark lift. Where the roster skews high, the program builds well; low tiers flag a gap.</div>
          {D.strengths.length===0&&D.weaknesses.length===0&&<div style={{fontSize:12,color:C.muted}}>Not enough ranked lifts logged yet.</div>}
          {D.strengths.length>0&&<div style={{fontSize:9.5,letterSpacing:1,textTransform:"uppercase",color:C.green,fontWeight:800,marginBottom:4}}>Strengths</div>}
          {D.strengths.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0"}}>
              <span style={{width:120,fontSize:12.5,color:C.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
              <span style={{flex:1,height:7,borderRadius:4,background:C.navy3,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*(s.avgTier+1)/8)}%`,background:C.green}}/></span>
              <span style={{fontSize:10,fontWeight:800,width:74,textAlign:"right",color:C.green}}>{s.tierName}</span>
            </div>
          ))}
          {D.weaknesses.length>0&&<div style={{fontSize:9.5,letterSpacing:1,textTransform:"uppercase",color:C.red,fontWeight:800,margin:"14px 0 4px"}}>Weaknesses</div>}
          {D.weaknesses.map((s,i)=>(
            <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0"}}>
              <span style={{width:120,fontSize:12.5,color:C.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
              <span style={{flex:1,height:7,borderRadius:4,background:C.navy3,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*(s.avgTier+1)/8)}%`,background:C.red}}/></span>
              <span style={{fontSize:10,fontWeight:800,width:74,textAlign:"right",color:C.red}}>{s.tierName}</span>
            </div>
          ))}
        </div>

        {/* Win of the week */}
        <div style={{background:`linear-gradient(180deg,${C.navy3},${C.navy2})`,border:`1px solid ${C.gold}44`,borderRadius:14,padding:16}}>
          <div style={{fontSize:11,letterSpacing:1.1,textTransform:"uppercase",color:C.gold,fontWeight:700}}>Wins this week</div>
          {D.shoutouts.length===0
            ? <div style={{fontSize:12,color:C.muted2,marginTop:12}}>No new personal bests logged yet this week — check back as sessions come in.</div>
            : <div style={{marginTop:12}}>
                {D.shoutouts.map((s,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderBottom:i<D.shoutouts.length-1?`1px solid ${C.border}80`:"none"}}>
                    <span style={{width:30,height:30,borderRadius:8,background:`${C.gold}22`,border:`1px solid ${C.gold}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,flexShrink:0}}>🏆</span>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:13,color:C.text}}>{s.name}</div>
                      <div style={{color:C.muted2,fontSize:12}}>{s.ex} {fmtWeight(s.weight,s.unit)} — up {s.gain} lbs e1RM</div>
                    </div>
                  </div>
                ))}
              </div>}
          <div style={{fontSize:11,color:C.muted,marginTop:12,fontStyle:"italic"}}>Shareable image export coming with the monthly recap.</div>
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
      <span style={{width:120,fontSize:12.5,color:C.text,flexShrink:0,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{name}</span>
      <span style={{flex:1,height:6,borderRadius:4,background:C.navy2,overflow:"hidden"}}><span style={{display:"block",height:"100%",width:`${Math.round(100*((avgTier||0)+1)/8)}%`,background:color}}/></span>
      <span style={{fontFamily:"'Bebas Neue'",fontSize:11,color,width:78,textAlign:"right"}}>{tier}</span>
    </div>
  );
}

// Client-side canvas export of the Wins block — no dependency, no server function.
function exportWins(team, coach){
  try{
    const W=1080,H=1350, cv=document.createElement("canvas"); cv.width=W; cv.height=H;
    const x=cv.getContext("2d");
    x.fillStyle="#060d1e"; x.fillRect(0,0,W,H);
    x.fillStyle="#d4a017"; x.font="700 40px Georgia"; x.fillText("THE COACH'S EDITION",70,110);
    x.fillStyle="#94a3b8"; x.font="26px Georgia"; x.fillText(`${coach?.name||"Team"} · Wins of the week`,70,152);
    x.fillStyle="#10b981"; x.font="700 130px Arial"; x.fillText(String(team.newPRs||0),70,320);
    x.fillStyle="#e2e8f0"; x.font="34px Arial"; x.fillText("true PRs across the roster this week",70,372);
    let y=490; x.fillStyle="#d4a017"; x.font="700 30px Arial"; x.fillText("STANDOUTS",70,y); y+=58;
    (team.notablePRs||[]).slice(0,6).forEach(p=>{
      x.fillStyle="#e2e8f0"; x.font="700 34px Arial"; x.fillText(String(p.athlete||""),70,y);
      x.fillStyle="#94a3b8"; x.font="30px Arial"; x.fillText(`${p.exercise||""} ${p.weight||""}${p.gain?`   +${p.gain} lbs e1RM`:""}`,70,y+40); y+=104;
    });
    x.fillStyle="#64748b"; x.font="700 26px Arial"; x.fillText("WILCO",70,H-56);
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
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:"smooth",block:"nearest"}); },[msgs]);

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
    advance(na);
  };

  if(!questions.length) return null;
  const chips = q?chipsFor(q):null;

  return (
    <div style={{marginTop:18,background:C.navy2,border:`1px solid ${C.border}`,borderRadius:14,padding:16}}>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:C.gold,letterSpacing:1.5}}>YOUR CALLS &amp; CONTEXT</div>
      <div style={{color:C.muted,fontSize:12.5,margin:"3px 0 14px"}}>Talk it through — tap an option or type your own, ask me anything, push back. I'll remember it for next week.</div>
      <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:400,overflowY:"auto",paddingRight:4}}>
        {msgs.map((m,i)=>(
          m.role==="sys"
            ? <div key={i} style={{alignSelf:"center",color:C.green,fontSize:12,fontFamily:"'Bebas Neue'",letterSpacing:0.5}}>{m.text}</div>
            : <div key={i} style={{alignSelf:m.role==="coach"?"flex-end":"flex-start",maxWidth:"85%",background:m.role==="coach"?C.gold:C.navy3,color:m.role==="coach"?"#0a0a0a":C.text,padding:"9px 12px",borderRadius:12,fontSize:13.5,lineHeight:1.5,fontWeight:m.role==="coach"?500:400}}>{m.text}</div>
        ))}
        <div ref={endRef}/>
      </div>
      {!done&&q&&(
        <div style={{marginTop:12}}>
          {chips&&(
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:9}}>
              {chips.map((opt,i)=>(
                <button key={i} disabled={busy} onClick={()=>submit(opt)} style={{fontSize:12.5,color:C.muted,background:C.navy3,border:`1px solid ${C.border}`,borderRadius:999,padding:"6px 13px",cursor:"pointer",fontFamily:"'DM Sans'"}}>{opt}</button>
              ))}
            </div>
          )}
          <div style={{display:"flex",gap:8,alignItems:"center",background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:"6px 6px 6px 13px"}}>
            <input value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")submit(input);}} placeholder="Answer, or ask me anything…" disabled={busy} style={{flex:1,background:"none",border:"none",color:C.text,fontSize:13.5,outline:"none",fontFamily:"'DM Sans'"}}/>
            <button onClick={()=>submit(input)} disabled={busy||!input.trim()} style={{background:C.gold,color:"#0a0a0a",border:"none",borderRadius:9,padding:"8px 16px",fontWeight:700,fontSize:12,cursor:"pointer",opacity:busy||!input.trim()?0.5:1,fontFamily:"'DM Sans'"}}>{busy?"…":"Send"}</button>
          </div>
        </div>
      )}
      {done&&<div style={{marginTop:12,color:C.muted,fontSize:13,fontStyle:"italic",fontFamily:EDITION_SERIF}}>That's the edition. I've got the context now — I'll build next week around it.</div>}
    </div>
  );
}

function CoachEdition({digest, athletes, coach, onBack, onRead}){
  const c = digest.content_json||{};
  const team = c.team||null;
  const sections = Array.isArray(c.sections)?c.sections:[];
  const isMonthly = digest.digest_type==="monthly_coach";
  const railCells = team?[["Roster",team.n],["Active",`${team.activePct}%`],["Adherence",team.adherenceAvg!=null?`${team.adherenceAvg}%`:"—"],["True PRs",team.newPRs]]:[];
  const toneOf = (s)=> /FOCUS/i.test(s.label)?"focus": s.flag==="warn"?"warn":"plain";
  return (
    <div style={{maxWidth:720}}>
      <button onClick={onBack} style={{background:"none",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,marginBottom:14}}>← Back to Reports</button>
      <div style={{background:C.navy2,border:`1px solid ${C.border}`,borderRadius:16,padding:"18px 20px"}}>
        <div style={{borderBottom:`2px solid ${C.border}`,paddingBottom:12,marginBottom:14,textAlign:"center"}}>
          <div style={{fontFamily:EDITION_SERIF,fontWeight:700,fontSize:30,color:C.text,letterSpacing:-0.5,lineHeight:1}}>The Coach's Edition{isMonthly?" · Monthly":""}</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:12,letterSpacing:2,color:C.muted,marginTop:6}}>{coach?.name||"Coach"} · {new Date(digest.generated_at||Date.now()).toLocaleDateString("en-US",{month:"long",day:"numeric"})}{team?` · ${team.n} Athletes`:""}</div>
        </div>
        {c.intro&&<div style={{fontFamily:EDITION_SERIF,fontSize:16,color:C.text,fontStyle:"italic",marginBottom:14,textAlign:"center"}}>{c.intro}</div>}
        {team&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:1,background:C.border,border:`1px solid ${C.border}`,borderRadius:10,overflow:"hidden",marginBottom:16}}>
            {railCells.map(([k,v],i)=>(
              <div key={i} style={{background:C.navy3,padding:"10px 12px"}}>
                <div style={{fontSize:9.5,letterSpacing:1,textTransform:"uppercase",color:C.muted}}>{k}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:C.text,fontVariantNumeric:"tabular-nums"}}>{v}</div>
              </div>
            ))}
          </div>
        )}
        {sections.map((s,i)=>{
          const tone=toneOf(s);
          const labelColor = tone==="warn"?C.red: tone==="focus"?C.gold:C.muted;
          const box = tone==="focus"
            ? {background:`${C.gold}0e`,borderLeft:`3px solid ${C.gold}`,borderRadius:"0 10px 10px 0"}
            : {background:C.navy3,border:`1px solid ${tone==="warn"?`${C.red}40`:C.border}`,borderRadius:10};
          return (
            <div key={i} style={{...box,padding:"12px 14px",marginBottom:9}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:labelColor,marginBottom:6}}>{s.label}</div>
              <div style={{color:C.text,fontSize:13.5,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{s.body}</div>
            </div>
          );
        })}
        {team&&((team.strengths&&team.strengths.length)||(team.weaknesses&&team.weaknesses.length))&&(
          <div style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:10,padding:14,marginTop:6}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:C.muted,marginBottom:8}}>PROGRAM STRENGTHS &amp; WEAKNESSES</div>
            {(team.strengths||[]).map((s,i)=><TierBar key={"s"+i} name={s.name} tier={s.tierName} avgTier={s.avgTier} color={C.green}/>)}
            {(team.weaknesses||[]).map((s,i)=><TierBar key={"w"+i} name={s.name} tier={s.tierName} avgTier={s.avgTier} color={C.red}/>)}
          </div>
        )}
        {team&&team.notablePRs&&team.notablePRs.length>0&&(
          <div style={{background:`linear-gradient(180deg,${C.navy3},${C.navy2})`,border:`1px solid ${C.gold}44`,borderRadius:10,padding:14,marginTop:12}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,color:C.gold,marginBottom:8}}>WINS TO SHARE</div>
            {team.notablePRs.slice(0,5).map((p,i,arr)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:9,padding:"6px 0",borderBottom:i<arr.length-1?`1px solid ${C.border}80`:"none"}}>
                <span style={{width:24,height:24,borderRadius:6,background:`${C.gold}22`,border:`1px solid ${C.gold}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>🏆</span>
                <div style={{flex:1,minWidth:0}}><span style={{color:C.text,fontWeight:650,fontSize:13}}>{p.athlete}</span> <span style={{color:C.muted,fontSize:12.5}}>{p.exercise} {fmtWeight(p.weight,p.unit)}{p.gain?` — +${p.gain} lbs e1RM`:""}</span></div>
              </div>
            ))}
            <button onClick={()=>exportWins(team,coach)} style={{marginTop:12,width:"100%",background:C.gold,color:"#0a0a0a",border:"none",borderRadius:9,padding:10,fontWeight:800,letterSpacing:1,textTransform:"uppercase",fontSize:12,cursor:"pointer",fontFamily:"'DM Sans'"}}>⤓ Share as image</button>
          </div>
        )}
        <CoachCheckin digest={digest} team={team} coach={coach} onRead={onRead}/>
      </div>
    </div>
  );
}

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
function AthleteDetail({athlete,workouts,prs,requests=[],onResolveRequest,onProgramSave,onAthleteDelete}) {
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

        {/* ── Program change requests (locked-program collaboration) ── */}
        {requests.length>0&&(
          <div style={{background:`${C.gold}0d`,border:`1px solid ${C.gold}40`,borderRadius:12,padding:14,marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:15,color:C.gold,letterSpacing:1}}>PROGRAM CHANGE REQUESTS</span>
              <span style={{fontSize:10,fontWeight:800,color:C.gold,background:`${C.gold}22`,border:`1px solid ${C.gold}55`,borderRadius:999,padding:"1px 7px"}}>{requests.length}</span>
              <span style={{marginLeft:"auto",fontSize:10.5,color:C.muted,textTransform:"uppercase",letterSpacing:.5}}>🔒 Locked</span>
            </div>
            {requests.map((r)=>(
              <div key={r.id} style={{border:`1px solid ${C.border}`,background:C.navy2,borderRadius:10,padding:"11px 12px",marginBottom:8}}>
                <div style={{color:C.text,fontSize:13,lineHeight:1.5}}>{r.reason || (Array.isArray(r.items)&&r.items[0]?.suggested_change) || "Requested a program change"}</div>
                <div style={{color:C.dim||C.muted,fontSize:11,margin:"5px 0 10px"}}>Filed {fmtDateRelative?fmtDateRelative(r.created_at):new Date(r.created_at).toLocaleDateString()} · {r.source}</div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>onResolveRequest&&onResolveRequest(r,"applied")} style={{background:C.gold,color:"#000",border:"none",borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Mark applied</button>
                  <button onClick={()=>{setTab("program");}} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Edit program</button>
                  <button onClick={()=>onResolveRequest&&onResolveRequest(r,"skipped")} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:8,padding:"6px 13px",fontSize:11.5,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>Skip</button>
                </div>
              </div>
            ))}
          </div>
        )}

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
                          {formatSetDetails(e)}
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
                  {[...prs].sort((a,b)=>liftTier(normalizeExName(a.exercise))-liftTier(normalizeExName(b.exercise)) || (b.estimated_1rm||b.weight||0)-(a.estimated_1rm||a.weight||0)).slice(0,6).map((p,i)=>(
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
            <div style={{color:C.muted,textAlign:"center",padding:40,fontSize:13}}>No activity logged yet.</div>
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
                  const runDotColor = isRunSession ? C.blue : C.green;

                  return (
                    <div key={i} style={{background:C.navy3,border:`1px solid ${C.border}`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:6,height:6,borderRadius:"50%",background:runDotColor,flexShrink:0}}/>
                          <div style={{color:C.gold,fontSize:11,fontWeight:700,letterSpacing:1}}>{isRunSession?"RUN":"WORKOUT"} — {fmtDateRelative(sessionDate)}</div>
                        </div>
                        {!isRunSession&&feelVal&&<div style={{fontSize:11,color:feelVal==="great"||feelVal==="good"?C.green:feelVal==="rough"?C.red:C.gold,fontWeight:600}}>{feelVal}</div>}
                      </div>
                      {isRunSession?(
                        <RunCard runData={allRunData[0]} feel={feelVal}/>
                      ):(
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,marginBottom:allPainFlags.length>0?8:0}}>
                          <thead>
                            <tr>
                              {["Exercise","Sets","Feel"].map(h=>(
                                <th key={h} style={{color:C.muted,fontWeight:600,fontSize:10,letterSpacing:1,textAlign:"left",paddingBottom:4,borderBottom:`1px solid ${C.border}`}}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {allExercises.map((e,j)=>(
                              <tr key={j}>
                                <td style={{color:C.text,fontWeight:600,padding:"5px 8px 5px 0",verticalAlign:"top"}}>{e.name}</td>
                                <td style={{color:C.muted2,padding:"5px 8px 5px 0",verticalAlign:"top"}}>{formatSetDetails(e)}</td>
                                <td style={{color:e.feel==="easy"?C.blue:e.feel==="hard"?C.red:C.muted,padding:"5px 0",verticalAlign:"top"}}>{e.feel||"—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {allPainFlags.length>0&&<div style={{color:C.red,fontSize:11,marginTop:4}}>⚠ {allPainFlags.map(p=>p.area).join(", ")}</div>}
                      {lastReply&&<div style={{marginTop:8,borderTop:`1px solid ${C.border}`,paddingTop:8,color:C.muted2,fontSize:12,fontStyle:"italic"}}>Coach Joe: "{lastReply.slice(0,200)}{lastReply.length>200?"...":""}"</div>}
                    </div>
                  );
                }
                // ── Form check ──
                if(item.type==="formcheck"){
                  const w = item.data;
                  return (
                    <div key={i} style={{background:C.navy3,border:`1px solid ${C.blue}30`,borderRadius:12,padding:14,marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:C.blue,flexShrink:0}}/>
                        <div style={{color:C.blue,fontSize:11,fontWeight:700,letterSpacing:1}}>FORM CHECK — {fmtDateRelative(w.created_at)}</div>
                      </div>
                      <div style={{color:C.muted2,fontSize:12,marginBottom:6}}>{w.raw_message}</div>
                      {w.bot_reply&&<div style={{color:C.text,fontSize:12,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{w.bot_reply}</div>}
                    </div>
                  );
                }
                // ── Q&A / Chat ──
                const w = item.data;
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

export default CoachDashboard;
