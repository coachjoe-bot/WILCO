// Dev-only geometry harness for useKeyboardInset — mirrors the athlete shell
// (100dvh flex column, absolute log sheet, fixed full-screen modal) so the REAL
// iOS soft keyboard can be driven in sim Safari with no login. Never built.
import { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardInset } from "../../src/useKeyboardInset.js";

const LONG = Array.from({length:30},(_,i)=>`Line ${i+1}: Back Squat 5x5 @ ${200+i*5} lbs`).join("\n");

function Hud({inset}){
  const [t,setT]=useState(0);
  useEffect(()=>{ const id=setInterval(()=>setT(x=>x+1),150); return ()=>clearInterval(id); },[]);
  const vv=window.visualViewport, a=document.activeElement;
  const sc=document.querySelector("[data-sc]:not([hidden])");
  return <div style={{position:"fixed",top:60,right:4,zIndex:999,background:"rgba(0,0,0,.75)",color:"#0f0",font:"10px monospace",padding:4,pointerEvents:"none"}}>
    inset {inset} · sY {Math.round(window.scrollY)} · vvH {Math.round(vv.height)} · vvTop {Math.round(vv.offsetTop)}<br/>
    focus {a?.tagName}{a?.id?"#"+a.id:""} · rectTop {a?Math.round(a.getBoundingClientRect().top):""} · scTop {document.querySelectorAll("[data-sc]").length?[...document.querySelectorAll("[data-sc]")].map(e=>Math.round(e.scrollTop)).join("/"):""}
  </div>;
}

function App(){
  const kbInset = useKeyboardInset();
  const [sheet,setSheet]=useState(location.hash==="#sheet");
  const [modal,setModal]=useState(location.hash==="#modal");
  const [text,setText]=useState(LONG);
  return (
    <div style={{height:"100dvh",display:"flex",flexDirection:"column",background:"#eef1f5",maxWidth:600,margin:"0 auto",position:"relative",paddingBottom:kbInset}}>
      <Hud inset={kbInset}/>
      <div style={{paddingTop:"calc(14px + env(safe-area-inset-top,0px))",padding:"50px 14px 14px",background:"#28508B",color:"#fff",flexShrink:0,height:96}}>
        HEADER <button id="bsheet" onClick={()=>setSheet(s=>!s)}>sheet</button> <button id="bmodal" onClick={()=>setModal(true)}>modal</button>
      </div>
      <div data-sc style={{flex:1,minHeight:0,overflowY:"auto",padding:14}}>
        {Array.from({length:40},(_,i)=><p key={i}>chat message {i+1}</p>)}
      </div>
      <div style={{flexShrink:0,height:86,padding:14,background:"#fff",borderTop:"1px solid #ccc"}}>
        <textarea id="composer" rows={1} placeholder="Message Joe" style={{width:"100%",fontSize:16}}/>
      </div>
      {sheet&&<div style={{position:"absolute",left:0,right:0,zIndex:40,top:96,bottom:86+kbInset,background:"#eef1f5",display:"flex",flexDirection:"column"}}>
        <div style={{background:"#28508B",color:"#fff",padding:"12px 14px",flexShrink:0}}>TODAY'S WORKOUT</div>
        <div data-sc style={{flex:1,overflowY:"auto",padding:"12px 14px"}}>
          <div style={{background:"#dde3ec",borderRadius:10,padding:10,marginBottom:10,fontSize:12}}>Notes card. Notes card. Notes card. Notes card.</div>
          <textarea id="sheetta" value={text} onChange={e=>setText(e.target.value)} spellCheck={false}
            style={{width:"100%",minHeight:280,border:"1px solid #aaa",borderRadius:10,padding:12,fontSize:13.5,lineHeight:1.7,resize:"vertical",fontFamily:"inherit"}}/>
        </div>
        <div style={{flexShrink:0,borderTop:"1px solid #ccc",background:"#fff",padding:"9px 14px"}}>footer · FINISH</div>
      </div>}
      {modal&&<div style={{position:"fixed",inset:0,zIndex:400,display:"flex",flexDirection:"column",background:"#eef1f5",maxWidth:600,margin:"0 auto",paddingBottom:kbInset}}>
        <div style={{padding:"60px 20px 12px",background:"#fff",flexShrink:0}}>MODAL <button onClick={()=>setModal(false)}>close</button></div>
        <div data-sc style={{flex:1,minHeight:0,overflowY:"auto",padding:20}}>
          {Array.from({length:14},(_,i)=><div key={i} style={{marginBottom:16}}><div style={{fontSize:11}}>FIELD {i+1}</div>
            <input id={"f"+(i+1)} placeholder={"field "+(i+1)} style={{width:"100%",fontSize:16,padding:10}}/></div>)}
        </div>
      </div>}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App/>);
