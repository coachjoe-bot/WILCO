import { useState, useEffect } from "react";

// ─── iOS KEYBOARD GEOMETRY (T62) ─────────────────────────────────────────────
// On iOS — Safari AND the WKWebView shell — the layout viewport NEVER shrinks
// for the on-screen keyboard. The OS instead PANS the page to reveal the focused
// input, and for viewport-height surfaces (the 100dvh chat shell, the fixed
// full-screen Program modal) that pan is pure breakage: bottom composers wedge
// mid-screen over grey dead space, the header scrolls off, and on WKWebView the
// pan can REST after the keyboard closes (the leftover grey band). visualViewport
// is the honest source of keyboard geometry: inset = the strip of layout
// viewport the keyboard covers.
//
// Contract:
//  - engage only while an editable element has focus in the tree this hook is
//    mounted in (signup never mounts it and keeps its legitimate document
//    scroll; a pinch-zoomed viewport must not read as a keyboard);
//  - consumers pad their bottom by the inset so composers sit above the
//    keyboard — flex geometry, never an html/body overflow lock (that clipped
//    signup once) and never env(safe-area-inset-bottom) (47941e6);
//  - while engaged, document scroll is clamped back to 0 so the OS pan can't
//    dislodge the layout — inner overflow containers still scroll free;
//  - when the keyboard closes the inset returns to 0 and one last clamp clears
//    any leftover pan, so no phantom padding survives dismissal;
//  - the clamp CANCELS the OS's own reveal-the-input pan, so the hook owes the
//    athlete that reveal (revealCaret below). Without it a field anywhere but
//    the very bottom — a line deep in the log sheet, a lower form field —
//    ends up under the shrunken container's fold while the view sits at the
//    top of the list: "I tap to type and it flies away" (Will, 09-20).

// Where the caret sits, in viewport coordinates. Single-line inputs are their
// own rect. A textarea can be far taller than the strip left above the
// keyboard, so its rect is useless — measure the caret line with a mirror div
// (same box + font metrics, text up to the caret, marker span at the end).
function caretBand(el){
  const r = el.getBoundingClientRect();
  if(el.tagName!=="TEXTAREA" || typeof el.selectionStart!=="number") return {top:r.top,bottom:r.bottom};
  const cs = getComputedStyle(el);
  const m = document.createElement("div");
  for(const k of ["boxSizing","width","paddingTop","paddingRight","paddingBottom","paddingLeft","borderTopWidth","borderRightWidth","borderBottomWidth","borderLeftWidth","fontFamily","fontSize","fontWeight","fontStyle","letterSpacing","lineHeight","textTransform","wordSpacing","tabSize"]) m.style[k]=cs[k];
  Object.assign(m.style,{position:"absolute",visibility:"hidden",top:"0",left:"-9999px",height:"auto",whiteSpace:"pre-wrap",overflowWrap:"break-word",overflow:"hidden"});
  m.textContent = el.value.slice(0, el.selectionStart);
  const mark = document.createElement("span"); mark.textContent = "\u200b"; m.appendChild(mark);
  document.body.appendChild(m);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize)*1.3 || 18;
  const y = r.top + (parseFloat(cs.borderTopWidth)||0) + mark.offsetTop - el.scrollTop;
  m.remove();
  // A caret scrolled out of the textarea's own box is the textarea's job (the
  // browser keeps it visible inside); never chase it past the element.
  const top = Math.min(Math.max(y, r.top), Math.max(r.top, r.bottom-line));
  return {top, bottom:top+line};
}

// Scroll the focused field's caret into the strip that is actually visible:
// inside each scrollable ancestor AND above the keyboard. Minimal movement — a
// caret already in view is left exactly where the athlete tapped it. Only inner
// overflow containers move; the document stays clamped at 0.
export function revealCaret(el){
  if(!el || !el.isConnected || !(el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.isContentEditable)) return;
  const vv = window.visualViewport;
  const floor = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const PAD = 14;
  for(let sc = el.parentElement; sc && sc!==document.body; sc = sc.parentElement){
    const oy = getComputedStyle(sc).overflowY;
    if((oy!=="auto" && oy!=="scroll") || sc.scrollHeight <= sc.clientHeight+1) continue;
    const band = caretBand(el), box = sc.getBoundingClientRect();
    const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, floor);
    const room = bottom - top, need = band.bottom - band.top;
    // A strip too short for caret + breathing room centres the caret line.
    const pad = room >= need + PAD*2 ? PAD : Math.max(0, (room-need)/2);
    let d = 0;
    if(band.bottom > bottom - pad) d = band.bottom - (bottom - pad);
    else if(band.top < top + pad) d = band.top - (top + pad);
    if(d) sc.scrollTop += d;
  }
}
export function useKeyboardInset(){
  const [inset,setInset] = useState(0);
  useEffect(()=>{
    const vv = typeof window!=="undefined" ? window.visualViewport : null;
    if(!vv) return;
    const editable = (el) => !!el && (el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.isContentEditable);
    let engaged = editable(document.activeElement);
    let kbUp = false;
    const read = () => {
      const kb = engaged ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      setInset(prev => Math.abs(prev-kb)<2 ? prev : kb);
      kbUp = kb > 40; // past the accessory-bar sliver a hardware keyboard leaves
      // The clamp: while the keyboard owns layout (and once more as it leaves),
      // the document stays at 0 — the pan is the bug, not the fix.
      if((engaged||kb===0) && (window.scrollX||window.scrollY)) window.scrollTo(0,0);
    };
    // Reveal on the next frame: the padding this hook drives must be laid out
    // first, and a tap's selection lands after its focus event.
    let raf = 0;
    const reveal = ()=>{ cancelAnimationFrame(raf); raf = requestAnimationFrame(()=>{ if(engaged && kbUp) revealCaret(document.activeElement); }); };
    const onFocusIn  = (e)=>{ engaged = editable(e.target); read(); reveal(); };
    // Typing can walk the caret under the fold (new lines at the end of the
    // sheet); selectionchange covers a tap that moves the caret mid-field.
    const onInput = (e)=>{ if(editable(e.target)) reveal(); };
    const onSelection = ()=>{ if(editable(document.activeElement)) reveal(); };
    // Focus hopping between inputs fires focusout→focusin in the same tick;
    // deferring the disengage read keeps the padding from flapping to 0 between.
    const onFocusOut = ()=>{ engaged = false; setTimeout(read, 80); };
    // Mount clamp: the login screen legitimately document-scrolls under the
    // keyboard, and on WKWebView that offset SURVIVES the switch into the
    // shell — the clipped header + resting grey band right after login. The
    // shell's layout owns the viewport, so entering it resets the document.
    if(window.scrollX||window.scrollY) window.scrollTo(0,0);
    // Resting-band clamp (native): Capacitor's contentInset "always" makes
    // safe-area offsets LEGAL RESTING positions for the WKWebView scroll view,
    // so a plain finger drag can leave the shell displaced with a grey band at
    // either end — no keyboard involved. While this hook is mounted the
    // document must never scroll (everything scrolls in inner containers), so
    // any offset that SETTLES gets snapped back. Debounced past the gesture:
    // fighting the rubber band mid-drag stutters, correcting the rest doesn't.
    let settle = 0;
    const onWinScroll = ()=>{
      clearTimeout(settle);
      settle = setTimeout(()=>{ if(window.scrollX||window.scrollY) window.scrollTo(0,0); }, 160);
    };
    window.addEventListener("scroll", onWinScroll);
    vv.addEventListener("resize", read);
    vv.addEventListener("scroll", read);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("input", onInput);
    document.addEventListener("selectionchange", onSelection);
    read();
    return ()=>{
      vv.removeEventListener("resize", read); vv.removeEventListener("scroll", read);
      document.removeEventListener("focusin", onFocusIn); document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("input", onInput); document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("scroll", onWinScroll); clearTimeout(settle); cancelAnimationFrame(raf);
    };
  },[]);
  // The inset just changed → consumers re-laid-out (this effect runs after that
  // commit): the keyboard finished arriving or resizing, so place the caret.
  useEffect(()=>{
    if(inset<=40) return;
    const id = requestAnimationFrame(()=>revealCaret(document.activeElement));
    return ()=>cancelAnimationFrame(id);
  },[inset]);
  return inset;
}
