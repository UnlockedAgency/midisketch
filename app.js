'use strict';
/* MIDI Sketch — offline phone sketchpad. No deps, no build. */

/* ================= music data ================= */
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const DEGREE = ['1','b2','2','b3','3','4','b5','5','b6','6','b7','7'];
const CHORD_TYPES = {
  maj:  {label:'',     tones:[0,4,7],    spice:[2,5,9,11]},
  min:  {label:'m',    tones:[0,3,7],    spice:[2,5,8,10]},
  '7':  {label:'7',    tones:[0,4,7,10], spice:[2,5,9]},
  min7: {label:'m7',   tones:[0,3,7,10], spice:[2,5,8]},
  maj7: {label:'maj7', tones:[0,4,7,11], spice:[2,5,9]},
  sus2: {label:'sus2', tones:[0,2,7],    spice:[4,5,9]},
  sus4: {label:'sus4', tones:[0,5,7],    spice:[2,4,9]},
  dim:  {label:'dim',  tones:[0,3,6],    spice:[2,5,8,10]},
};
const chordName = c => NOTE_NAMES[c.root] + CHORD_TYPES[c.type].label;

/* drum lanes: fixed GM pitches so exports land on any GM-mapped drum instrument */
const DRUM_ROWS = [56,45,51,46,42,39,38,36]; // top-to-bottom display order
const DRUM_LABEL = {36:'Kick',38:'Snare',39:'Clap',42:'CH Hat',46:'OH Hat',51:'Ride',45:'Tom',56:'Cow'};
const KITS = {'909':{label:'909 House'},'808':{label:'808 HipHop'}};
const SYNTH_LABELS = {lead:'Buzz Lead',acid:'Acid Bass',pluck:'House Pluck',sub:'808 Sub',pad:'BoC Pad',keys:'Lo-fi Keys'};
const isDrum = () => clip && clip.type==='drums';
const pitchName = p => NOTE_NAMES[p%12] + (Math.floor(p/12)-1);
const freqOf = p => 440*Math.pow(2,(p-69)/12);

/* ================= state / persistence ================= */
const LS_KEY = 'midisketch_v1';
let store = {clips:[], cur:null};
let clip = null;

const ui = {
  viewBar:0, viewHalf:0, fine:false, playBar:-1, follow:false, pulse:'off',
  drag:null, playing:false, loopBar:false,
};
/* internal resolution: 32nd-note units. 32 units per bar; coarse view snaps to 2-unit (16th) grain. */
const UPB = 32;
const grain = () => ui.fine ? 1 : 2;
const viewSpanU = () => ui.fine ? 16 : 32;
const viewStartU = () => ui.viewBar*UPB + (ui.fine ? ui.viewHalf*16 : 0);
const pxPerUnit = () => (gridMetrics.stepW*16)/viewSpanU();

/* ---- undo ---- */
let undoStack = [];
function pushUndo(){
  const snap = JSON.stringify({notes:clip.notes, progression:clip.progression, bars:clip.bars});
  if(undoStack[undoStack.length-1]===snap) return;
  undoStack.push(snap);
  if(undoStack.length>60) undoStack.shift();
  el('undoBtn').disabled = false;
}
function undo(){
  const s = undoStack.pop(); if(!s) return;
  const o = JSON.parse(s);
  clip.notes=o.notes; clip.progression=o.progression; clip.bars=o.bars;
  if(ui.viewBar>=clip.bars) ui.viewBar=clip.bars-1;
  if(!undoStack.length) el('undoBtn').disabled = true;
  save(); renderAll();
}
function clearUndo(){ undoStack.length=0; el('undoBtn').disabled=true; }

function uid(){ return 'c'+Math.floor(performance.now()*1000).toString(36)+Math.floor(Math.random()*1e6).toString(36); }

function newClip(type){
  const n = store.clips.length+1;
  const base = {
    id:uid(), type:type||'synth', bpm:122, bars:4, synth:'lead', kit:'909', swing:0,
    octLow:2, octHigh:4, spice:false, backingId:null,
    progression:[{root:9,type:'min'},{root:5,type:'maj'},{root:0,type:'maj'},{root:7,type:'maj'}], // Am F C G
    notes:[], // {pitch, start, len, accent, roll} — start/len in 16th steps
  };
  if(type==='drums'){
    base.name = 'Groove '+n; base.bars = 2;
    base.progression = base.progression.slice(0,2);
  } else base.name = 'Sketch '+n;
  return base;
}
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(store)); }catch(e){ console.warn('save failed', e); } }
function load(){
  try{ const s = JSON.parse(localStorage.getItem(LS_KEY)); if(s && s.clips && s.clips.length) store = s; }catch(e){}
  store.clips.forEach(c=>{ if(!c.type) c.type='synth'; if(!c.kit) c.kit='909'; if(c.backingId===undefined) c.backingId=null; });
  if(!store.u32){ // one-time migration: 16th-note units -> 32nd-note units
    store.clips.forEach(c=>c.notes.forEach(n=>{ n.start*=2; n.len*=2; }));
    store.u32 = true;
  }
  if(!store.clips.length){ const c = newClip(); store.clips=[c]; store.cur=c.id; }
  clip = store.clips.find(c=>c.id===store.cur) || store.clips[0];
  store.cur = clip.id;
  save();
}
function totalSteps(){ return clip.bars*UPB; } // in 32nd units

function syncProgression(){
  const old = clip.progression;
  const next = [];
  for(let i=0;i<clip.bars;i++) next.push(old[i] ? old[i] : {...old[i % old.length]});
  clip.progression = next;
  // trim notes that fall off the end
  clip.notes = clip.notes.filter(n=>n.start < totalSteps());
  clip.notes.forEach(n=>{ n.len = Math.min(n.len, totalSteps()-n.start); });
  if(ui.viewBar >= clip.bars) ui.viewBar = clip.bars-1;
}

/* ================= chord helpers ================= */
function chordSets(bar){
  const c = clip.progression[Math.min(bar, clip.progression.length-1)];
  const t = CHORD_TYPES[c.type];
  return {
    root:c.root,
    tones:new Set(t.tones.map(i=>(c.root+i)%12)),
    spice:new Set(t.spice.map(i=>(c.root+i)%12)),
  };
}
function computeRows(){ // descending MIDI pitches shown as rows
  if(isDrum()) return [...DRUM_ROWS];
  const lo = 12*(clip.octLow+1), hi = 12*(clip.octHigh+2)-1;
  const pcs = new Set();
  for(let b=0;b<clip.bars;b++){
    const s = chordSets(b);
    s.tones.forEach(pc=>pcs.add(pc));
    if(clip.spice) s.spice.forEach(pc=>pcs.add(pc));
  }
  const set = new Set();
  for(let p=lo;p<=hi;p++) if(pcs.has(p%12)) set.add(p);
  clip.notes.forEach(n=>set.add(n.pitch)); // strays stay visible
  return [...set].sort((a,b)=>b-a);
}
function barOfStep(step){ return Math.min(Math.floor(step/UPB), clip.bars-1); }
function isStray(n){
  if(isDrum()) return false;
  const s = chordSets(barOfStep(n.start));
  const pc = n.pitch%12;
  return !s.tones.has(pc) && !(clip.spice && s.spice.has(pc));
}
function snapStrays(){
  pushUndo();
  for(const n of clip.notes){
    if(!isStray(n)) continue;
    const tones = chordSets(barOfStep(n.start)).tones;
    for(let d=1; d<=6; d++){
      if(tones.has((n.pitch-d+120)%12)){ n.pitch -= d; break; }
      if(tones.has((n.pitch+d)%12)){ n.pitch += d; break; }
    }
  }
  save(); renderAll();
}

/* ================= audio engine ================= */
let actx=null, master=null, brightLP=null, comp=null, cutGain=null, pulseGain=null, noiseBuf=null;
let delayBus=null, dlL=null, dlR=null, delayOut=null, verbBus=null, verbOut=null, chorusIn=null;

/* per-voice FX send amounts (d=delay, v=reverb, chorus=routes through chorus bus) */
const SENDS = {
  lead: {d:0.35, v:0.18},
  acid: {d:0.22, v:0.08},
  pluck:{d:0.45, v:0.22},
  sub:  {d:0,    v:0},      // keep low end clean
  pad:  {d:0.10, v:0.50, chorus:true},
  keys: {d:0.25, v:0.30, chorus:true},
};
function route(out, synth){
  const s = SENDS[synth] || {d:0, v:0};
  out.connect(s.chorus ? chorusIn : master);
  if(s.d && delayBus){ const sg=g(s.d); out.connect(sg); sg.connect(delayBus); }
  if(s.v && verbBus){ const sg=g(s.v); out.connect(sg); sg.connect(verbBus); }
}
function makeIR(){ // dark plate-ish impulse response, ~2s T60
  const len = Math.floor(actx.sampleRate*2.4);
  const buf = actx.createBuffer(2, len, actx.sampleRate);
  for(let ch=0; ch<2; ch++){
    const d = buf.getChannelData(ch); let lp=0;
    for(let i=0;i<len;i++){
      const t = i/actx.sampleRate;
      const w = (Math.random()*2-1)*Math.exp(-3.4*t);
      lp += 0.22*(w-lp); // one-pole darkening, tail gets duller
      d[i] = lp*0.6;
    }
  }
  return buf;
}
function setDelayTimes(immediate){
  if(!dlL) return;
  const t = Math.min(2.4, 0.75*60/clip.bpm); // dotted eighth
  if(immediate){ dlL.delayTime.value=t; dlR.delayTime.value=t; }
  else {
    dlL.delayTime.setTargetAtTime(t, actx.currentTime, 0.05);
    dlR.delayTime.setTargetAtTime(t, actx.currentTime, 0.05);
  }
}
function setFxLevels(){
  if(delayOut) delayOut.gain.value = (+el('delayVol').value/100)*0.9;
  if(verbOut) verbOut.gain.value = (+el('verbVol').value/100)*1.0;
}

function ensureAudio(){
  if(!actx){
    const AC = window.AudioContext || window.webkitAudioContext;
    actx = new AC();
    master = actx.createGain(); master.gain.value = 0.85;
    brightLP = actx.createBiquadFilter(); brightLP.type='lowpass'; brightLP.Q.value=0.4;
    comp = actx.createDynamicsCompressor();
    comp.threshold.value=-14; comp.knee.value=18; comp.ratio.value=5; comp.attack.value=0.004; comp.release.value=0.18;
    cutGain = actx.createGain(); cutGain.gain.value=1;
    pulseGain = actx.createGain();
    master.connect(brightLP); brightLP.connect(comp); comp.connect(cutGain); cutGain.connect(actx.destination);
    pulseGain.connect(master);
    // --- FX: ping-pong delay (dotted eighth, dark feedback) ---
    delayBus = g(1);
    dlL = actx.createDelay(2.5); dlR = actx.createDelay(2.5);
    const fbLP = actx.createBiquadFilter(); fbLP.type='lowpass'; fbLP.frequency.value=3600;
    const fb = g(0.42);
    const dpL = actx.createStereoPanner(); dpL.pan.value=-0.65;
    const dpR = actx.createStereoPanner(); dpR.pan.value=0.65;
    delayOut = g(0.55);
    delayBus.connect(dlL); dlL.connect(dlR);
    dlR.connect(fbLP); fbLP.connect(fb); fb.connect(dlL);
    dlL.connect(dpL); dpL.connect(delayOut);
    dlR.connect(dpR); dpR.connect(delayOut);
    delayOut.connect(master);
    // --- FX: reverb (generated dark IR through convolver) ---
    verbBus = g(1);
    const preDly = actx.createDelay(0.1); preDly.delayTime.value=0.02;
    const conv = actx.createConvolver(); conv.buffer = makeIR();
    verbOut = g(0.55);
    verbBus.connect(preDly); preDly.connect(conv); conv.connect(verbOut); verbOut.connect(master);
    // --- FX: stereo chorus bus for pad/keys ---
    chorusIn = g(1);
    const cDry = g(0.75); chorusIn.connect(cDry); cDry.connect(master);
    [[0.014,0.35,-0.55],[0.019,0.47,0.55]].forEach(([base,rate,pan])=>{
      const cd = actx.createDelay(0.06); cd.delayTime.value=base;
      const lfo = mkOsc('sine',rate), lg = g(0.004);
      lfo.connect(lg); lg.connect(cd.delayTime); lfo.start();
      const cg = g(0.55), pn = actx.createStereoPanner(); pn.pan.value=pan;
      chorusIn.connect(cd); cd.connect(cg); cg.connect(pn); pn.connect(master);
    });
    setDelayTimes(true);
    setFxLevels();
    setBrightness(+el('bright').value);
    setPulseVol(+el('pulseVol').value);
    actx.onstatechange = updateAudioBadge;
    noiseBuf = actx.createBuffer(1, actx.sampleRate*0.5, actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
  }
  if(actx.state!=='running') actx.resume(); // iOS reports 'interrupted' as well as 'suspended'
  updateAudioBadge();
}
function setBrightness(v){ if(brightLP) brightLP.frequency.value = 1500*Math.pow(16000/1500, v/100); }
function setPulseVol(v){ if(pulseGain) pulseGain.gain.value = (v/100)*0.9; }

function g(v){ const n=actx.createGain(); n.gain.value=v; return n; }
function mkOsc(type,freq,det){ const o=actx.createOscillator(); o.type=type; o.frequency.value=freq; if(det)o.detune.value=det; return o; }
function driveCurve(k){
  const c = new Float32Array(257);
  for(let i=0;i<257;i++){ const x=i/128-1; c[i]=Math.tanh(k*x)/Math.tanh(k); }
  return c;
}
const DRIVES = {};
function drive(k){ const ws=actx.createWaveShaper(); if(!DRIVES[k])DRIVES[k]=driveCurve(k); ws.curve=DRIVES[k]; return ws; }

/* envelope on a gain node; returns end-of-sound time */
function env(node, t, dur, {a=0.005, d=0, s=1, r=0.15, peak=1}){
  const p = node.gain;
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(Math.max(peak,0.001), t+a);
  if(d>0) p.setTargetAtTime(peak*s, t+a, d/3);
  const rel = Math.max(t+dur, t+a+0.01);
  p.setTargetAtTime(0.0001, rel, r/4);
  return rel + r*2 + 0.05;
}

const VOICES = {
  lead(p, t, dur, vel, tight){ // 7-voice stereo supersaw through drive
    const f=freqOf(p), out=g(0.22*vel);
    const ws=drive(2.6), lp=actx.createBiquadFilter();
    lp.type='lowpass'; lp.frequency.value=2600; lp.Q.value=0.9;
    ws.connect(lp); lp.connect(out); route(out,'lead');
    const stop = env(out, t, dur, {a:0.007, d:0.12, s:0.8, r:tight?0.045:0.28, peak:0.22*vel});
    const DET=[-38,-24,-11,0,11,24,38], PAN=[-0.8,-0.45,-0.2,0,0.2,0.45,0.8];
    DET.forEach((det,i)=>{
      const o=mkOsc('sawtooth', f, det), og=g(i===3?0.34:0.17);
      const pn=actx.createStereoPanner(); pn.pan.value=PAN[i];
      o.connect(og); og.connect(pn); pn.connect(ws);
      o.start(t+(i%3)*0.004); o.stop(stop); // staggered starts decohere phases
    });
  },
  acid(p, t, dur, vel, tight){ // 24dB cascaded filters with drive inside the ladder
    const f=freqOf(p), out=g(0.3*vel);
    const ws1=drive(2.2), ws2=drive(3);
    const lp1=actx.createBiquadFilter(); lp1.type='lowpass'; lp1.Q.value=1.2;
    const lp2=actx.createBiquadFilter(); lp2.type='lowpass'; lp2.Q.value=6;
    for(const lp of [lp1,lp2]){
      lp.frequency.setValueAtTime(220+f, t);
      lp.frequency.exponentialRampToValueAtTime(900+vel*900+f, t+0.02);
      lp.frequency.setTargetAtTime(170+f, t+0.02, 0.12);
    }
    const o1=mkOsc('sawtooth', f), o2=mkOsc('square', f, -6), m=g(0.5);
    o1.connect(m); o2.connect(m);
    m.connect(ws1); ws1.connect(lp1); lp1.connect(ws2); ws2.connect(lp2); lp2.connect(out);
    route(out,'acid');
    const stop = env(out, t, dur, {a:0.003, d:0.0, s:1, r:tight?0.04:0.09, peak:0.3*vel});
    o1.start(t); o2.start(t); o1.stop(stop); o2.stop(stop);
  },
  pluck(p, t, dur, vel, tight){ // house pluck/stab
    const f=freqOf(p), out=g(0.3*vel);
    const lp=actx.createBiquadFilter(); lp.type='lowpass'; lp.Q.value=2;
    lp.frequency.setValueAtTime(3800, t);
    lp.frequency.setTargetAtTime(420, t, 0.06);
    const o=mkOsc('sawtooth', f), o2=mkOsc('sawtooth', f, 9), m=g(0.5);
    o.connect(m); o2.connect(m); m.connect(lp); lp.connect(out); route(out,'pluck');
    const stop = env(out, t, dur, {a:0.002, d:0.14, s:0.3, r:tight?0.04:0.13, peak:0.3*vel});
    o.start(t); o2.start(t); o.stop(stop); o2.stop(stop);
  },
  sub(p, t, dur, vel, tight){ // 808 sub with pitch drop
    const f=freqOf(p), out=g(0.55*vel);
    const o=mkOsc('sine', f*2.4), ws=drive(1.8);
    o.frequency.setValueAtTime(f*2.4, t);
    o.frequency.exponentialRampToValueAtTime(f, t+0.055);
    o.connect(ws); ws.connect(out); route(out,'sub');
    const stop = env(out, t, tight?dur:Math.max(dur,0.45), {a:0.004, d:0.0, s:1, r:tight?0.06:0.28, peak:0.55*vel});
    o.start(t); o.stop(stop);
  },
  pad(p, t, dur, vel, tight){ // BoC tape-wobble pad
    const f=freqOf(p), out=g(0.2*vel);
    const lp=actx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=1800; lp.Q.value=0.5;
    const wob=g(0.86); // amp wobble carrier
    lp.connect(wob); wob.connect(out); route(out,'pad');
    const a = tight ? 0.006 : Math.min(0.55, Math.max(0.08, dur*0.4));
    const stop = env(out, t, dur, {a, d:0, s:1, r:tight?0.07:3.2, peak:0.2*vel});
    const lfoA=mkOsc('sine',0.31), lfoAG=g(0.1);
    lfoA.connect(lfoAG); lfoAG.connect(wob.gain); lfoA.start(t); lfoA.stop(stop);
    [['triangle',-8,0.4,0.11],['triangle',8,0.4,0.17],['sine',0,0.5,0.13]].forEach(([ty,det,amp,drift])=>{
      const o=mkOsc(ty,f,det), og=g(amp);
      const lfo=mkOsc('sine',drift), lg=g(6); // slow pitch drift, cents
      lfo.connect(lg); lg.connect(o.detune);
      o.connect(og); og.connect(lp);
      o.start(t); o.stop(stop); lfo.start(t); lfo.stop(stop);
    });
  },
  keys(p, t, dur, vel, tight){ // lo-fi keys
    const f=freqOf(p), out=g(0.27*vel);
    const lp=actx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=3200; lp.Q.value=0.6;
    lp.connect(out); route(out,'keys');
    const stop = env(out, t, dur, {a:0.004, d:0.35, s:0.45, r:tight?0.05:0.5, peak:0.27*vel});
    const vib=mkOsc('sine',5.2), vg=g(3.5); vib.connect(vg);
    [['triangle',f,-5,0.5],['triangle',f,5,0.5],['sine',f*2,0,0.14]].forEach(([ty,fr,det,amp])=>{
      const o=mkOsc(ty,fr,det), og=g(amp);
      vg.connect(o.detune);
      o.connect(og); og.connect(lp); o.start(t); o.stop(stop);
    });
    vib.start(t); vib.stop(stop);
  },
};
function voicePlay(synth, pitch, t, dur, accent, tight){
  VOICES[synth] && VOICES[synth](pitch, t, dur, accent?1:0.68, tight);
}

/* ---- drum kit voices (909 / 808 flavors, dark-tuned) ---- */
let lastOpenHat = null;
function drumRoute(out, gm){
  out.connect(master);
  if((gm===38||gm===39||gm===51) && verbBus){ const sg=g(0.14); out.connect(sg); sg.connect(verbBus); }
}
function drumPlay(kit, gm, t, dur, accent){
  if(!actx) return;
  const vel = accent?1:0.68, is9 = kit==='909';
  const N = (hp, lp, peak, dec, t0)=>{ // filtered noise burst
    t0 = t0||t;
    const s=actx.createBufferSource(); s.buffer=noiseBuf; s.loop=true;
    const f1=actx.createBiquadFilter(); f1.type='highpass'; f1.frequency.value=hp;
    const f2=actx.createBiquadFilter(); f2.type='lowpass'; f2.frequency.value=lp;
    const o=g(0.0001);
    s.connect(f1); f1.connect(f2); f2.connect(o);
    o.gain.setValueAtTime(peak, t0); o.gain.setTargetAtTime(0.0001, t0, dec);
    s.start(t0); s.stop(t0+dec*7+0.05);
    drumRoute(o, gm); return o;
  };
  const T = (type, f0, fTo, slide, dec, peak, drv)=>{ // pitched hit
    const o=mkOsc(type, f0), out=g(0.0001);
    if(fTo){ o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(fTo, t+slide); }
    let last=o;
    if(drv){ const w=drive(drv); o.connect(w); last=w; }
    last.connect(out);
    out.gain.setValueAtTime(peak, t); out.gain.setTargetAtTime(0.0001, t+0.004, dec);
    o.start(t); o.stop(t+dec*7+0.1);
    drumRoute(out, gm); return out;
  };
  switch(gm){
    case 36: // kick
      if(is9){ T('sine',155,47,0.045,0.09,0.95*vel,2.4); N(900,4000,0.22*vel,0.008); }
      else T('sine',165,41,0.06,0.16,1.0*vel,1.8);
      break;
    case 38: // snare
      T('triangle',186,160,0.03,0.045,0.5*vel,0);
      N(700, is9?6800:5200, 0.45*vel, is9?0.055:0.042);
      break;
    case 39: // clap: three micro-bursts + tail
      for(let i=0;i<3;i++) N(600,4800,0.4*vel,0.008, t+i*0.011);
      N(600,4200,0.28*vel,0.05, t+0.03);
      break;
    case 42: // closed hat — chokes open hat
      if(lastOpenHat){ try{ lastOpenHat.gain.cancelScheduledValues(t); lastOpenHat.gain.setTargetAtTime(0.0001, t, 0.008); }catch(e){} lastOpenHat=null; }
      N(is9?6500:7200, 9800, 0.3*vel, 0.013);
      break;
    case 46: // open hat
      if(lastOpenHat){ try{ lastOpenHat.gain.setTargetAtTime(0.0001, t, 0.008); }catch(e){} }
      lastOpenHat = N(6200, 9500, 0.3*vel, 0.09);
      break;
    case 51: // ride — dark
      N(4800, 8800, 0.16*vel, 0.14);
      T('square',523,0,0,0.1,0.03*vel,0);
      break;
    case 45: // tom
      T('sine',128,88,0.08,0.1,0.55*vel,1.6);
      break;
    case 56: { // cowbell: two squares through bandpass
      const bp=actx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=720; bp.Q.value=1.6;
      const out=g(0.0001);
      [555,845].forEach(fr=>{ const o=mkOsc('square',fr); o.connect(bp); o.start(t); o.stop(t+0.4); });
      bp.connect(out);
      out.gain.setValueAtTime(0.33*vel, t); out.gain.setTargetAtTime(0.0001, t+0.01, 0.045);
      drumRoute(out, 56);
      break; }
  }
}
function previewNote(pitch){
  if(!actx) return;
  if(isDrum()) drumPlay(clip.kit, pitch, actx.currentTime, 0.3, false);
  else voicePlay(clip.synth, pitch, actx.currentTime, 0.3, false);
}

/* ---- backing pulse (not exported) ---- */
const PULSES = {
  house: {bpm:124, swing:8,  kick:[0,4,8,12], hat:[2,6,10,14], snap:[4,12], hatVel:()=>0.8},
  hiphop:{bpm:90,  swing:54, kick:[0,7,10],   hat:[0,2,4,6,8,10,12,14], snap:[4,12], hatVel:()=>0.6},
  techno:{bpm:126, swing:0,  kick:[0,4,8,12], hat:[...Array(16).keys()], snap:[], hatVel:s=>(s%4===2?0.8:0.35)},
};
function pKick(t){
  const o=mkOsc('sine',160), out=g(0.9), ws=drive(2);
  o.frequency.setValueAtTime(160, t);
  o.frequency.exponentialRampToValueAtTime(46, t+0.05);
  o.connect(ws); ws.connect(out); out.connect(pulseGain);
  out.gain.setValueAtTime(0.9,t); out.gain.setTargetAtTime(0.0001, t+0.005, 0.045);
  o.start(t); o.stop(t+0.35);
}
function pNoise(t, hp, lp, peak, decay){
  const src=actx.createBufferSource(); src.buffer=noiseBuf;
  const f1=actx.createBiquadFilter(); f1.type='highpass'; f1.frequency.value=hp;
  const f2=actx.createBiquadFilter(); f2.type='lowpass'; f2.frequency.value=lp;
  const out=g(peak);
  src.connect(f1); f1.connect(f2); f2.connect(out); out.connect(pulseGain);
  out.gain.setValueAtTime(peak,t); out.gain.setTargetAtTime(0.0001, t, decay);
  src.start(t); src.stop(t+decay*6+0.02);
}
function pulseStep(s16, t){
  const pr = PULSES[ui.pulse]; if(!pr) return;
  if(pr.kick.includes(s16)) pKick(t);
  if(pr.hat.includes(s16)) pNoise(t, 5500, 8800, 0.22*pr.hatVel(s16), 0.022);
  if(pr.snap.includes(s16)) pNoise(t, 900, 3200, 0.17, 0.045);
}

/* ---- transport / lookahead scheduler ---- */
let schedTimer=null, curStep=0, nextTime=0;
const stepQueue=[];
const stepDur = () => 60/clip.bpm/8;        // one 32nd unit
const sixteenthDur = () => 60/clip.bpm/4;

function schedule(){
  while(nextTime < actx.currentTime + 0.12){
    const swingOff = (Math.floor(curStep/2)%2===1) ? clip.swing/100*sixteenthDur()*0.66 : 0;
    const t = nextTime + swingOff;
    const fire = (c, n)=>{
      const drum = c.type==='drums';
      const r = n.roll||0;
      const one = (tt, d, tight)=> drum ? drumPlay(c.kit, n.pitch, tt, d, n.accent)
                                        : voicePlay(c.synth, n.pitch, tt, d, n.accent, tight);
      if(r){ // roll subdivides 16ths; 50% gate + clamped release = actual gaps
        const hd = sixteenthDur()/r, hits = Math.max(1, Math.round(n.len*r/2));
        for(let i=0;i<hits;i++) one(t+i*hd, hd*0.5, true);
      }
      else one(t, Math.max(n.len*stepDur()*0.92, 0.05));
    };
    for(const n of clip.notes) if(n.start===curStep) fire(clip, n);
    if(!isDrum()){
      const bg = clip.backingId && store.clips.find(x=>x.id===clip.backingId && x.type==='drums');
      if(bg){
        const bs = curStep % (bg.bars*UPB);
        for(const n of bg.notes) if(n.start===bs) fire(bg, n);
      } else if(curStep%2===0) pulseStep((curStep/2)%16, t);
    }
    stepQueue.push({step:curStep, time:nextTime});
    let next = curStep+1;
    if(ui.loopBar){
      const s0 = ui.viewBar*UPB;
      if(next < s0 || next >= s0+UPB) next = s0;
    } else if(next >= totalSteps()) next = 0;
    curStep = next;
    nextTime += stepDur();
  }
}
function play(){
  ensureAudio();
  setDelayTimes();
  cutGain.gain.cancelScheduledValues(actx.currentTime);
  cutGain.gain.setValueAtTime(1, actx.currentTime);
  curStep=ui.viewBar*UPB; nextTime=actx.currentTime+0.06; stepQueue.length=0;
  schedTimer=setInterval(schedule, 25); schedule();
  ui.playing=true; el('playBtn').textContent='■'; el('playBtn').classList.add('playing');
  requestAnimationFrame(tickUI);
}
function stop(){
  clearInterval(schedTimer); schedTimer=null; ui.playing=false; ui.playBar=-1;
  if(actx){
    const t=actx.currentTime;
    cutGain.gain.cancelScheduledValues(t);
    cutGain.gain.setValueAtTime(cutGain.gain.value, t);
    cutGain.gain.linearRampToValueAtTime(0.0001, t+0.08);
    cutGain.gain.setValueAtTime(1, t+0.3);
  }
  el('playBtn').textContent='▶'; el('playBtn').classList.remove('playing');
  el('playhead').style.display='none';
  renderBarChips();
}
function tickUI(){
  if(!ui.playing) return;
  while(stepQueue.length>1 && stepQueue[1].time<=actx.currentTime) stepQueue.shift();
  if(stepQueue.length){
    const s = stepQueue[0].step;
    const bar = Math.floor(s/UPB);
    const half = Math.floor((s%UPB)/16);
    if(bar!==ui.playBar){
      ui.playBar=bar;
      if(ui.follow && ui.viewBar!==bar){ ui.viewBar=bar; ui.viewHalf=half; renderAll(); }
      else renderBarChips();
    } else if(ui.follow && ui.fine && half!==ui.viewHalf){ ui.viewHalf=half; renderAll(); }
    const ph = el('playhead');
    const vs = viewStartU();
    if(s>=vs && s<vs+viewSpanU()){
      ph.style.display='block';
      ph.style.left = ((s-vs)*pxPerUnit())+'px';
    } else ph.style.display='none';
  }
  requestAnimationFrame(tickUI);
}

function updateAudioBadge(){
  const b = el('audioBadge');
  if(actx && actx.state==='running'){ b.textContent='🔊'; b.title='audio on — silent? check ringer switch'; }
  else { b.textContent='🔇'; b.title='tap to enable audio'; }
}

/* ================= grid rendering ================= */
const el = id => document.getElementById(id);
let rows=[]; // descending pitches
const gridMetrics = {stepW:22, rowH:34};

function renderAll(){ syncUIFields(); renderBarChips(); renderGrid(); }

function syncUIFields(){
  const d = isDrum();
  el('clipName').value = clip.name;
  el('bpmVal').textContent = clip.bpm;
  el('barsSel').value = String(clip.bars);
  el('synthSel').value = clip.synth;
  el('swing').value = clip.swing; el('swingVal').textContent = clip.swing+'%';
  el('spiceBtn').textContent = '✦ Spice: '+(clip.spice?'on':'off');
  el('spiceBtn').classList.toggle('on', clip.spice);
  el('followBtn').textContent = 'Follow: '+(ui.follow?'on':'off');
  el('followBtn').classList.toggle('on', ui.follow);
  el('octVal').textContent = 'C'+clip.octLow+'–B'+clip.octHigh;
  // per-clip-type visibility
  el('synthStack').hidden = d; el('kitStack').hidden = !d;
  if(d) el('kitSel').value = clip.kit;
  el('spiceBtn').style.display = d?'none':'';
  el('grooveRow').style.display = d?'none':'';
  el('pulseRow1').style.display = d?'none':'';
  el('pulseRow2').style.display = d?'none':'';
  if(!d){ // populate groove choices from saved drum clips
    const sel = el('grooveSel');
    sel.innerHTML = '<option value="">none — use pulse below</option>';
    store.clips.filter(c=>c.type==='drums').forEach(c=>{
      const o = document.createElement('option');
      o.value = c.id; o.textContent = '🥁 '+c.name+' ('+KITS[c.kit].label+')';
      sel.appendChild(o);
    });
    sel.value = (clip.backingId && store.clips.some(c=>c.id===clip.backingId)) ? clip.backingId : '';
  }
}

function renderBarChips(){
  el('barPos').textContent = (ui.viewBar+1)+(ui.fine?(ui.viewHalf?'b':'a'):'')+'/'+clip.bars;
  el('fineBtn').textContent = 'Grid: '+(ui.fine?'1/32':'1/16');
  el('fineBtn').classList.toggle('on', ui.fine);
  const host = el('barRow'); host.innerHTML='';
  clip.progression.forEach((c,b)=>{
    const btn = document.createElement('button');
    btn.className = 'barChip'+(b===ui.viewBar?' cur':'')+(b===ui.playBar?' playing':'');
    btn.innerHTML = `<small>bar ${b+1}</small><span class="ch">${isDrum()?'●':chordName(c)}</span>`;
    btn.addEventListener('click', ()=>{
      if(ui.viewBar===b) openChordModal(b);
      else { ui.viewBar=b; ui.viewHalf=0; renderAll(); }
    });
    host.appendChild(btn);
  });
  el('snapBtn').classList.toggle('show', clip.notes.some(isStray));
}

function renderGrid(){
  rows = computeRows();
  const wrap = el('gridWrap');
  const avail = wrap.clientHeight || 400;
  gridMetrics.rowH = Math.max(26, Math.min(44, Math.floor(avail/Math.max(rows.length,1))));
  document.documentElement.style.setProperty('--rowh', gridMetrics.rowH+'px');
  const gw = el('grid').clientWidth;
  gridMetrics.stepW = gw/16;
  document.documentElement.style.setProperty('--stepw', gridMetrics.stepW+'px');

  const labHost = el('labels'), rowHost = el('rows');
  labHost.innerHTML=''; rowHost.innerHTML='';
  if(isDrum()){
    for(const gm of rows){
      const lab = document.createElement('div');
      lab.className = 'lab'+(gm===36?' root':'');
      lab.innerHTML = `<b>${DRUM_LABEL[gm]}</b>`;
      labHost.appendChild(lab);
      const row = document.createElement('div');
      row.className = 'gridRow '+(gm===36?'root':'tone');
      rowHost.appendChild(row);
    }
    renderNotes();
    return;
  }
  const s = chordSets(ui.viewBar);
  for(const p of rows){
    const pc = p%12;
    const isTone = s.tones.has(pc), isSpice = clip.spice && s.spice.has(pc);
    const isRoot = pc===s.root;
    const deg = (isTone||isSpice) ? DEGREE[(pc-s.root+12)%12] : '·';
    const lab = document.createElement('div');
    lab.className = 'lab'+(isRoot?' root':'')+(isSpice?' spiceRow':'')+(!isTone&&!isSpice?' off':'');
    lab.innerHTML = `<b>${pitchName(p)}</b><span class="deg">${deg}</span>`;
    labHost.appendChild(lab);
    const row = document.createElement('div');
    row.className = 'gridRow '+(isRoot?'root':isTone?'tone':isSpice?'spiceRow':'off');
    rowHost.appendChild(row);
  }
  renderNotes();
}

function renderNotes(){
  const host = el('notes'); host.innerHTML='';
  const vs0 = viewStartU(), vEnd = vs0+viewSpanU(), ppu = pxPerUnit();
  for(const n of clip.notes){
    const nEnd = n.start+n.len;
    if(nEnd<=vs0 || n.start>=vEnd) continue;
    const vs = Math.max(n.start, vs0), ve = Math.min(nEnd, vEnd);
    const ri = rows.indexOf(n.pitch);
    if(ri<0) continue;
    const d = document.createElement('div');
    d.className = 'note'+(n.accent?' accent':'')+(isStray(n)?' stray':'')
      +(n.start<vs0?' contL':'')+(nEnd>vEnd?' contR':'');
    d.style.left = ((vs-vs0)*ppu+1)+'px';
    d.style.width = ((ve-vs)*ppu-3)+'px';
    d.style.top = (ri*gridMetrics.rowH)+'px';
    if(n.roll){
      const seg = ppu*2/n.roll; // roll subdivides 16ths (2 units)
      d.style.backgroundImage = `repeating-linear-gradient(90deg, transparent 0 ${seg-2}px, rgba(8,12,16,.6) ${seg-2}px ${seg}px)`;
      d.textContent = '×'+n.roll;
    }
    host.appendChild(d);
  }
}

/* ================= grid interaction ================= */
function cellAt(ev){
  const gw = el('grid').clientWidth/16;
  if(Math.abs(gw-gridMetrics.stepW)>0.5){
    gridMetrics.stepW = gw;
    document.documentElement.style.setProperty('--stepw', gw+'px');
    renderNotes();
  }
  const r = el('grid').getBoundingClientRect();
  const x = ev.clientX-r.left, y = ev.clientY-r.top;
  const col = Math.max(0, Math.min(15, Math.floor(x/gridMetrics.stepW)));
  const ri = Math.floor(y/gridMetrics.rowH);
  if(ri<0 || ri>=rows.length) return null;
  return {step: viewStartU()+col*grain(), pitch: rows[ri]};
}
function noteAt(pitch, step){
  return clip.notes.find(n=>n.pitch===pitch && step>=n.start && step<n.start+n.len);
}
function cleanOverlaps(note){
  clip.notes = clip.notes.filter(n=>{
    if(n===note || n.pitch!==note.pitch) return true;
    const overlap = n.start < note.start+note.len && note.start < n.start+n.len;
    if(!overlap) return true;
    if(n.start < note.start){ n.len = note.start-n.start; return n.len>0; }
    return false;
  });
}

function initGridInput(){
  const grid = el('grid');
  grid.addEventListener('pointerdown', ev=>{
    ensureAudio(); hideOverlay();
    const c = cellAt(ev); if(!c) return;
    try{ grid.setPointerCapture(ev.pointerId); }catch(e){}
    const hit = noteAt(c.pitch, c.step);
    if(hit){
      pushUndo();
      ui.drag = {mode:'maybe', note:hit, x0:ev.clientX, y0:ev.clientY, lp:setTimeout(()=>{
        if(ui.drag && ui.drag.mode==='maybe'){
          hit.accent = !hit.accent; ui.drag.mode='done';
          if(navigator.vibrate) navigator.vibrate(12);
          save(); renderNotes();
        }
      }, 450)};
    } else {
      if(!isDrum()){
        const s = chordSets(ui.viewBar); const pc = c.pitch%12;
        if(!(s.tones.has(pc) || (clip.spice && s.spice.has(pc)))) return;
      }
      pushUndo();
      const note = {pitch:c.pitch, start:c.step, len:grain(), accent:false};
      clip.notes.push(note);
      previewNote(c.pitch);
      ui.drag = {mode:'stretch', note, x0:ev.clientX, y0:ev.clientY};
      renderNotes();
    }
  });
  grid.addEventListener('pointermove', ev=>{
    if(!ui.drag) return;
    const d = ui.drag;
    if(d.mode==='maybe'){
      const dx = ev.clientX-d.x0, dy = ev.clientY-d.y0;
      if(Math.hypot(dx,dy)>6) clearTimeout(d.lp); // any movement cancels hold-for-accent
      if(Math.abs(dx)>9 && Math.abs(dx)>=Math.abs(dy)){ d.mode='stretch'; }
      else if(Math.abs(dy)>14 && Math.abs(dy)>Math.abs(dx)){
        d.mode='roll';
        d.rollIdx0 = [0,2,3,4].indexOf(d.note.roll||0); d.y0r = d.y0;
      }
    }
    if(d.mode==='stretch'){
      const c = cellAt(ev); if(!c) return;
      const newLen = Math.max(grain(), Math.min(totalSteps()-d.note.start, c.step-d.note.start+grain()));
      if(newLen!==d.note.len){ d.note.len=newLen; renderNotes(); }
    }
    if(d.mode==='roll'){
      const seq = [0,2,3,4];
      const idx = Math.max(0, Math.min(3, d.rollIdx0 + Math.round((d.y0r-ev.clientY)/26)));
      const nv = seq[idx];
      if(nv!==(d.note.roll||0)){
        d.note.roll = nv;
        renderNotes();
        if(actx){
          const r = nv||1, hd = sixteenthDur()/r;
          for(let i=0;i<r;i++){
            if(isDrum()) drumPlay(clip.kit, d.note.pitch, actx.currentTime+i*hd, hd*0.5, d.note.accent);
            else voicePlay(clip.synth, d.note.pitch, actx.currentTime+i*hd, hd*0.5, d.note.accent, true);
          }
        }
      }
    }
  });
  const finish = ev=>{
    if(!ui.drag) return;
    const d = ui.drag; ui.drag=null;
    clearTimeout(d.lp);
    if(d.mode==='maybe'){ // plain tap on a note: delete (always — rolls are a vertical drag)
      clip.notes = clip.notes.filter(n=>n!==d.note);
    } else if(d.mode==='stretch'){
      cleanOverlaps(d.note);
    }
    save(); renderNotes(); renderBarChips();
  };
  grid.addEventListener('pointerup', finish);
  grid.addEventListener('pointercancel', finish);
}

/* ================= chord modal ================= */
let editingBar = 0;
function openChordModal(b){
  editingBar = b;
  el('chordTitle').textContent = 'Bar '+(b+1)+(isDrum()?' tools':' chord');
  el('chordEditWrap').style.display = isDrum()?'none':'';
  el('applyAllBtn').style.display = isDrum()?'none':'';
  if(!isDrum()) buildChordChips();
  buildBarTools();
  el('chordModal').classList.add('open');
}

/* ---- copy/paste bar ---- */
let copiedBar = null; // {from, notes:[{pitch,rel,len,accent,roll}]}
function copyBar(b){
  copiedBar = {from:b, notes: clip.notes
    .filter(n=>n.start>=b*UPB && n.start<b*UPB+UPB)
    .map(n=>({pitch:n.pitch, rel:n.start-b*UPB, len:Math.min(n.len, UPB-(n.start-b*UPB)), accent:n.accent, roll:n.roll||0}))};
  buildBarTools();
  el('copyBarBtn').textContent = `⧉ Copied ${copiedBar.notes.length} notes ✓`;
}
function pasteBar(b){
  if(!copiedBar) return;
  pushUndo();
  clip.notes = clip.notes.filter(n=>!(n.start>=b*UPB && n.start<b*UPB+UPB));
  for(const sn of copiedBar.notes){
    const start = b*UPB+sn.rel;
    clip.notes.push({pitch:sn.pitch, start, len:Math.min(sn.len, totalSteps()-start), accent:sn.accent, roll:sn.roll});
  }
  save(); renderAll();
}
function buildBarTools(){
  el('copyBarBtn').textContent = '⧉ Copy this bar’s notes';
  const host = el('pasteChips'); host.innerHTML='';
  if(!copiedBar){
    host.innerHTML = '<span style="color:var(--dim);font-size:12px">copy a bar, then paste targets appear here</span>';
    return;
  }
  const lbl = document.createElement('span');
  lbl.textContent = `bar ${copiedBar.from+1} ➜ paste into:`;
  lbl.style.cssText = 'color:var(--dim);font-size:12px;align-self:center';
  host.appendChild(lbl);
  for(let b=0;b<clip.bars;b++){
    if(b===copiedBar.from) continue;
    const btn = document.createElement('button');
    btn.textContent = 'bar '+(b+1);
    btn.addEventListener('click', ()=>pasteBar(b));
    host.appendChild(btn);
  }
}
function buildChordChips(){
  const c = clip.progression[editingBar];
  const rc = el('rootChips'); rc.innerHTML='';
  NOTE_NAMES.forEach((nm,i)=>{
    const b = document.createElement('button');
    b.textContent = nm; b.classList.toggle('on', i===c.root);
    b.addEventListener('click', ()=>{ pushUndo(); c.root=i; afterChordEdit(); });
    rc.appendChild(b);
  });
  const tc = el('typeChips'); tc.innerHTML='';
  Object.keys(CHORD_TYPES).forEach(k=>{
    const b = document.createElement('button');
    b.textContent = CHORD_TYPES[k].label || 'maj'; b.classList.toggle('on', k===c.type);
    b.addEventListener('click', ()=>{ pushUndo(); c.type=k; afterChordEdit(); });
    tc.appendChild(b);
  });
}
function afterChordEdit(){
  buildChordChips(); save(); renderAll();
  // audition the chord quietly
  ensureAudio();
  const c = clip.progression[editingBar];
  const base = 12*(clip.octLow+2) + c.root;
  CHORD_TYPES[c.type].tones.forEach(iv=>voicePlay('keys', base+iv, actx.currentTime, 0.5, false));
}

/* ================= clips modal ================= */
let bundleMode = false;
const bundleSel = new Set();
function updateBundleBtn(){
  el('bundleBtn').textContent = bundleMode ? `Export ${bundleSel.size} as .mid` : 'Bundle .mid';
  el('bundleBtn').classList.toggle('on', bundleMode);
}
function renderClipList(){
  const host = el('clipList'); host.innerHTML='';
  store.clips.forEach(c=>{
    const row = document.createElement('div'); row.className='clipItem';
    const icon = c.type==='drums' ? '🥁' : '🎹';
    const meta = c.type==='drums'
      ? `${KITS[c.kit].label} · ${c.bpm} bpm · ${c.bars} bars · ${c.notes.length} hits`
      : `${SYNTH_LABELS[c.synth]||c.synth} · ${c.bpm} bpm · ${c.bars} bars · ${c.notes.length} notes · ${escapeHtml(c.progression.map(chordName).join(' '))}`;
    const check = bundleMode ? (bundleSel.has(c.id)?'☑ ':'☐ ') : '';
    row.innerHTML = `<div class="nm"><b>${check}${icon} ${escapeHtml(c.name)}${c.id===clip.id?' ·▸':''}</b>
      <small>${meta}</small></div>`;
    if(bundleMode){
      row.addEventListener('click', ()=>{
        bundleSel.has(c.id) ? bundleSel.delete(c.id) : bundleSel.add(c.id);
        updateBundleBtn(); renderClipList();
      });
      host.appendChild(row);
      return;
    }
    const mk = (label, fn)=>{ const b=document.createElement('button'); b.textContent=label; b.addEventListener('click', fn); row.appendChild(b); return b; };
    mk('Load', ()=>{ switchClip(c.id); el('clipsModal').classList.remove('open'); });
    mk('⧉', ()=>{ const d = JSON.parse(JSON.stringify(c)); d.id=uid(); d.name=c.name+' copy'; store.clips.push(d); save(); renderClipList(); });
    mk('.mid', ()=>exportClip(c));
    const del = mk('✕', ()=>{
      if(del.dataset.armed){
        store.clips = store.clips.filter(x=>x.id!==c.id);
        if(!store.clips.length){ const nc=newClip(); store.clips=[nc]; }
        if(clip.id===c.id) switchClip(store.clips[0].id);
        save(); renderClipList();
      } else { del.dataset.armed='1'; del.textContent='sure?'; del.style.borderColor='var(--red)'; }
    });
    host.appendChild(row);
  });
}
function switchClip(id){
  if(ui.playing) stop();
  store.cur=id; clip = store.clips.find(c=>c.id===id);
  ui.viewBar=0; copiedBar=null; clearUndo(); save(); renderAll();
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

/* ================= MIDI export (SMF type 0) ================= */
function vlq(n){
  const out=[n&0x7f];
  while(n>>=7) out.unshift((n&0x7f)|0x80);
  return out;
}
const SPT = 120; // ticks per 16th at PPQ 480
const UT = 60;   // ticks per 32nd unit
function textBytes(s, max){ return Array.from(new TextEncoder().encode(s)).slice(0, max||60); }
function metaEvt(tick, type, bytes){ return {tick, ord:0, b:[0xFF, type, bytes.length, ...bytes]}; }
function tempoEvt(bpm){
  const uspq = Math.round(60000000/bpm);
  return {tick:0, ord:0, b:[0xFF,0x51,0x03,(uspq>>16)&0xff,(uspq>>8)&0xff,uspq&0xff]};
}
function clipEvents(c, ch){ // track-name meta + note events on channel ch
  const label = c.type==='drums' ? KITS[c.kit].label : (SYNTH_LABELS[c.synth]||c.synth);
  const evs = [metaEvt(0, 0x03, textBytes(c.name+' - '+label))];
  const on = 0x90|ch, off = 0x80|ch;
  for(const n of c.notes){
    const vel = n.accent?108:78;
    const r = n.roll||0;
    if(r){ // expand roll into real subdivided notes (60/40/30 ticks per hit)
      const seg = Math.round(SPT/r), gate = Math.max(Math.round(seg*0.8), 10);
      const hits = Math.max(1, Math.round(n.len*r/2));
      for(let i=0;i<hits;i++){
        const t0 = n.start*UT + i*seg;
        evs.push({tick:t0, ord:1, b:[on, n.pitch, vel]});
        evs.push({tick:t0+gate, ord:0, b:[off, n.pitch, 0]});
      }
    } else {
      evs.push({tick:n.start*UT, ord:1, b:[on, n.pitch, vel]});
      evs.push({tick:(n.start+n.len)*UT, ord:0, b:[off, n.pitch, 0]});
    }
  }
  return evs;
}
function serializeTrack(evs){
  evs.sort((a,b)=>a.tick-b.tick || a.ord-b.ord);
  const bytes=[]; let last=0;
  for(const e of evs){ bytes.push(...vlq(e.tick-last), ...e.b); last=e.tick; }
  bytes.push(...vlq(0), 0xFF,0x2F,0x00);
  const len=bytes.length;
  return [0x4D,0x54,0x72,0x6B,(len>>24)&0xff,(len>>16)&0xff,(len>>8)&0xff,len&0xff, ...bytes];
}
function smfHeader(fmt, ntrks){
  return [0x4D,0x54,0x68,0x64, 0,0,0,6, 0,fmt, (ntrks>>8)&0xff,ntrks&0xff, (480>>8)&0xff,480&0xff];
}
function buildSMF(c){ // single clip, format 0 (drums ride channel 10)
  const evs = [tempoEvt(c.bpm), ...clipEvents(c, c.type==='drums'?9:0)];
  return new Uint8Array([...smfHeader(0,1), ...serializeTrack(evs)]);
}
function buildSMF1(clipsArr){ // bundle: format 1, one named track per clip (+ chords ref)
  const synthRef = clipsArr.find(c=>c.type!=='drums');
  const t0 = [tempoEvt(clipsArr[0].bpm)];
  if(synthRef) synthRef.progression.forEach((cc,b)=>t0.push(metaEvt(b*16*SPT, 0x06, textBytes(chordName(cc),16))));
  const tracks = [serializeTrack(t0)];
  if(synthRef){ // held-chord reference track from the progression
    const evs = [metaEvt(0, 0x03, textBytes('Chords (ref)'))];
    synthRef.progression.forEach((cc,b)=>{
      CHORD_TYPES[cc.type].tones.forEach(iv=>{
        evs.push({tick:b*16*SPT, ord:1, b:[0x90|1, 48+cc.root+iv, 64]});
        evs.push({tick:(b+1)*16*SPT, ord:0, b:[0x80|1, 48+cc.root+iv, 0]});
      });
    });
    tracks.push(serializeTrack(evs));
  }
  let mel = 2; // melodic channels 2,3,... skipping 10 (drums)
  for(const c of clipsArr){
    let ch;
    if(c.type==='drums') ch = 9;
    else { if(mel===9) mel++; ch = Math.min(mel, 15); mel++; }
    tracks.push(serializeTrack(clipEvents(c, ch)));
  }
  return new Uint8Array([...smfHeader(1, tracks.length), ...tracks.flat()]);
}
async function shareOrDownload(bytes, filename, mime){
  const file = new File([bytes], filename, {type:mime});
  const isTouch = matchMedia('(pointer:coarse)').matches;
  if(isTouch && navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file]}); return; }
    catch(e){ if(e.name==='AbortError') return; }
  }
  const url = URL.createObjectURL(new Blob([bytes], {type:mime}));
  const a = document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
}
function exportClip(c){
  if(!c.notes.length){ alert('No notes in this clip yet.'); return; }
  const safe = c.name.replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'_') || 'sketch';
  const tag = c.type==='drums' ? c.kit+'kit' : chordName(c.progression[0]);
  const fn = `${safe}_${c.bpm}bpm_${tag}.mid`;
  shareOrDownload(buildSMF(c), fn, 'audio/midi');
}
function exportBundle(){
  const sel = store.clips.filter(c=>bundleSel.has(c.id) && c.notes.length);
  if(!sel.length) return false;
  const fn = `loop_${sel.length}trk_${sel[0].bpm}bpm.mid`;
  shareOrDownload(buildSMF1(sel), fn, 'audio/midi');
  return true;
}
function backupAll(){
  const bytes = new TextEncoder().encode(JSON.stringify(store, null, 1));
  shareOrDownload(bytes, 'midisketch_backup.json', 'application/json');
}

/* ================= wiring ================= */
function hideOverlay(){
  const o = el('audioOverlay');
  if(o) o.remove();
}
function bpmSet(v){ clip.bpm = Math.max(50, Math.min(200, v)); el('bpmVal').textContent=clip.bpm; setDelayTimes(); save(); }
function holdable(btn, fn){ // tap = once, hold = repeat
  let iv=null, to=null;
  btn.addEventListener('pointerdown', ()=>{ fn(); to=setTimeout(()=>{ iv=setInterval(fn, 70); }, 420); });
  const end = ()=>{ clearTimeout(to); clearInterval(iv); iv=to=null; };
  btn.addEventListener('pointerup', end); btn.addEventListener('pointercancel', end); btn.addEventListener('pointerleave', end);
}

function init(){
  load();
  initGridInput();
  renderAll();

  document.body.addEventListener('pointerdown', ()=>{ ensureAudio(); hideOverlay(); }, {once:true, capture:true});

  el('playBtn').addEventListener('click', ()=>{ ui.playing ? stop() : play(); });
  holdable(el('bpmDn'), ()=>bpmSet(clip.bpm-1));
  holdable(el('bpmUp'), ()=>bpmSet(clip.bpm+1));
  el('barsSel').addEventListener('change', e=>{ pushUndo(); clip.bars=+e.target.value; syncProgression(); save(); renderAll(); });
  el('undoBtn').addEventListener('click', undo);
  const barStep = d => {
    if(ui.fine){
      const max = clip.bars*2;
      const pos = ((ui.viewBar*2 + ui.viewHalf + d) + max) % max;
      ui.viewBar = Math.floor(pos/2); ui.viewHalf = pos%2;
    } else ui.viewBar = (ui.viewBar + d + clip.bars) % clip.bars;
    renderAll();
  };
  el('barPrev').addEventListener('click', ()=>barStep(-1));
  el('barNext').addEventListener('click', ()=>barStep(1));
  el('fineBtn').addEventListener('click', ()=>{
    ui.fine = !ui.fine; ui.viewHalf = 0;
    renderAll();
  });
  el('loopBtn').addEventListener('click', ()=>{
    ui.loopBar=!ui.loopBar;
    el('loopBtn').textContent='Loop: '+(ui.loopBar?'bar':'clip');
    el('loopBtn').classList.toggle('on', ui.loopBar);
  });
  el('copyBarBtn').addEventListener('click', ()=>copyBar(editingBar));
  el('synthSel').addEventListener('change', e=>{ clip.synth=e.target.value; save();
    ensureAudio(); voicePlay(clip.synth, 57, actx.currentTime, 0.4, false); });
  el('soundBtn').addEventListener('click', ()=>{
    const p=el('soundPanel'); p.classList.toggle('open');
    el('soundBtn').textContent = p.classList.contains('open')?'Sound ▴':'Sound ▾';
    renderGrid();
  });
  el('swing').addEventListener('input', e=>{ clip.swing=+e.target.value; el('swingVal').textContent=clip.swing+'%'; save(); });
  el('bright').addEventListener('input', e=>{ ensureAudio(); setBrightness(+e.target.value); });
  el('pulseVol').addEventListener('input', e=>{ if(pulseGain) setPulseVol(+e.target.value); });
  el('delayVol').addEventListener('input', setFxLevels);
  el('verbVol').addEventListener('input', setFxLevels);
  document.querySelectorAll('[data-pulse]').forEach(b=>{
    b.addEventListener('click', ()=>{
      ui.pulse = b.dataset.pulse;
      document.querySelectorAll('[data-pulse]').forEach(x=>x.classList.toggle('on', x===b));
      if(ui.pulse!=='off' && clip.backingId){ clip.backingId=null; el('grooveSel').value=''; save(); }
      const pr = PULSES[ui.pulse];
      if(pr){ bpmSet(pr.bpm); clip.swing=pr.swing; el('swing').value=pr.swing; el('swingVal').textContent=pr.swing+'%'; save(); }
    });
  });
  holdable(el('octDn'), ()=>{ if(clip.octLow>0){ clip.octLow--; clip.octHigh--; save(); renderAll(); } });
  holdable(el('octUp'), ()=>{ if(clip.octHigh<7){ clip.octLow++; clip.octHigh++; save(); renderAll(); } });
  el('spiceBtn').addEventListener('click', ()=>{ clip.spice=!clip.spice; save(); renderAll(); });
  el('followBtn').addEventListener('click', ()=>{ ui.follow=!ui.follow; syncUIFields(); });
  el('snapBtn').addEventListener('click', snapStrays);
  el('clipName').addEventListener('input', e=>{ clip.name=e.target.value; save(); });
  el('audioBadge').addEventListener('click', ()=>{ ensureAudio(); voicePlay('keys', 69, actx.currentTime, 0.3, false); });
  el('exportBtn').addEventListener('click', ()=>exportClip(clip));
  el('applyAllBtn').addEventListener('click', ()=>{
    pushUndo();
    const c = clip.progression[editingBar];
    clip.progression = clip.progression.map(()=>({...c}));
    save(); renderAll(); el('chordModal').classList.remove('open');
  });
  el('chordDone').addEventListener('click', ()=>el('chordModal').classList.remove('open'));
  el('clipsBtn').addEventListener('click', ()=>{ bundleMode=false; bundleSel.clear(); updateBundleBtn(); renderClipList(); el('clipsModal').classList.add('open'); });
  const addClip = type => { const c=newClip(type); store.clips.push(c); switchClip(c.id); el('clipsModal').classList.remove('open'); };
  el('newSynthBtn').addEventListener('click', ()=>addClip('synth'));
  el('newDrumBtn').addEventListener('click', ()=>addClip('drums'));
  el('bundleBtn').addEventListener('click', ()=>{
    if(!bundleMode){ bundleMode=true; bundleSel.clear(); }
    else { if(bundleSel.size) exportBundle(); bundleMode=false; bundleSel.clear(); }
    updateBundleBtn(); renderClipList();
  });
  el('kitSel').addEventListener('change', e=>{
    clip.kit = e.target.value; save();
    ensureAudio();
    drumPlay(clip.kit, 36, actx.currentTime, 0.3, false);
    drumPlay(clip.kit, 42, actx.currentTime+0.17, 0.1, false);
    drumPlay(clip.kit, 38, actx.currentTime+0.34, 0.2, false);
  });
  el('grooveSel').addEventListener('change', e=>{
    clip.backingId = e.target.value || null;
    if(clip.backingId){
      ui.pulse='off';
      document.querySelectorAll('[data-pulse]').forEach(x=>x.classList.toggle('on', x.dataset.pulse==='off'));
    }
    save();
  });
  el('backupBtn').addEventListener('click', backupAll);
  el('clipsDone').addEventListener('click', ()=>{ bundleMode=false; bundleSel.clear(); el('clipsModal').classList.remove('open'); });
  document.querySelectorAll('.modal').forEach(m=>m.addEventListener('click', e=>{ if(e.target===m) m.classList.remove('open'); }));

  window.addEventListener('resize', renderGrid);
  document.addEventListener('visibilitychange', ()=>{ if(document.hidden && ui.playing) stop(); });

  if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
}
init();
