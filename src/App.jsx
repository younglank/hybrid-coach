import { useState, useEffect, useRef } from "react";

const MODEL = "claude-sonnet-4-20250514";

// ── date helpers (LOCAL, avoids UTC off-by-one) ──────────────────────────────
const fmtLocal = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const todayStr = () => fmtLocal(new Date());
const fmtDate = (s) => { const [y,m,d] = s.split("-"); return new Date(+y,+m-1,+d).toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}); };

// display helpers for durations stored as decimals
const fmtHM = (dec) => { if(dec===""||dec==null||isNaN(parseFloat(dec))) return "—"; const d=parseFloat(dec); const h=Math.floor(d), m=Math.round((d-h)*60); return m?`${h}h ${m}m`:`${h}h`; };
const fmtMS = (dec) => { if(dec===""||dec==null||isNaN(parseFloat(dec))) return ""; const d=parseFloat(dec); const m=Math.floor(d), s=Math.round((d-m)*60); return `${m}:${String(s).padStart(2,"0")}`; };

// ── storage (deploy-anywhere: uses Claude's window.storage here, localStorage when hosted) ──
const HAS_WS = typeof window !== "undefined" && !!window.storage;
const _mem = {};
const store = {
  async get(k){
    if (HAS_WS) { try { const r = await window.storage.get(k); return r ? r.value : null; } catch(e){ return null; } }
    try { if (typeof localStorage !== "undefined") { const v = localStorage.getItem(k); return v==null?null:v; } } catch(e){}
    return (k in _mem) ? _mem[k] : null;
  },
  async set(k,v){
    if (HAS_WS) { try { await window.storage.set(k,v); } catch(e){} return; }
    try { if (typeof localStorage !== "undefined") { localStorage.setItem(k,v); return; } } catch(e){}
    _mem[k]=v;
  },
};
async function sGet(k) { const v = await store.get(k); try { return v ? JSON.parse(v) : null; } catch { return null; } }
async function sSet(k, v) { await store.set(k, JSON.stringify(v)); }
async function loadDay(d) { return await sGet(`day:${d}`); }
async function saveDay(d, data) { await sSet(`day:${d}`, data); const idx = (await sGet("day-index")) || []; if (!idx.includes(d)) { idx.push(d); idx.sort(); await sSet("day-index", idx); } }
async function getIndex() { return (await sGet("day-index")) || []; }

const DEFAULT_PRESETS = [
  { label:"Premier Shake", protein:30, carbs:5, fats:3 },
  { label:"VA Lunch", protein:50, carbs:40, fats:20 },
  { label:"Greek Yogurt", protein:18, carbs:8, fats:0 },
  { label:"Cava / Sweetgreen", protein:45, carbs:50, fats:25 },
  { label:"2 Eggs", protein:12, carbs:0, fats:10 },
  { label:"Chicken 6oz", protein:35, carbs:0, fats:4 },
];

// daily targets + bar weight — user-adjustable in Settings
const DEFAULT_SETTINGS = { barWeight:45, proteinTarget:160, carbTarget:230, fatTarget:70, waterTarget:120, sleepNeed:9.5, wakeTime:"07:00" };
async function loadSettings() { const s = await sGet("settings"); return { ...DEFAULT_SETTINGS, ...(s||{}) }; }
async function saveSettings(s) { await sSet("settings", s); }
const calTarget = (S) => Math.round(S.proteinTarget*4 + S.carbTarget*4 + S.fatTarget*9);

function macroTotals(day) {
  let p=0,c=0,f=0;
  for (const n of (day?.nutritionLog||[])) { p += (n.protein ?? n.grams ?? 0); c += (n.carbs||0); f += (n.fats||0); }
  return { p, c, f, cal: Math.round(p*4 + c*4 + f*9) };
}

function toBase64(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("read failed")); r.readAsDataURL(file); }); }

// ── recovery (calibrated to your 797 days: median 62, 75th 76) ───────────────
function recStatus(s) { if (s==null||s==="") return "UNKNOWN"; if (s>=76) return "PEAK"; if (s>=62) return "GOOD"; if (s>=48) return "NORMAL"; if (s>=35) return "LOW"; return "REST"; }
function recColor(s) { return { PEAK:"#4ade80", GOOD:"#a3e635", NORMAL:"#facc15", LOW:"#fb923c", REST:"#f87171", UNKNOWN:"#888" }[recStatus(s)]; }

// ── exercise DB ──────────────────────────────────────────────────────────────
const WORKOUTS = {
  push: { label:"Push", sub:"Chest · Shoulders · Triceps", warmup:"10 min stairmaster + 2 light bench sets", exercises:[
    { name:"Barbell Bench Press", sets:"4", reps:"5-7", rir:"1-2", muscle:"Chest", barbell:true, note:"Primary lift. +2.5-5lb when you clear 7 on all sets." },
    { name:"Incline DB Press", sets:"3", reps:"10-12", rir:"1-2", muscle:"Chest", note:"Drop DBs below chest — full stretch." },
    { name:"Cable Fly (low-to-high)", sets:"3", reps:"15-20", rir:"0-1", muscle:"Chest", note:"Constant tension, stretch at bottom." },
    { name:"Seated DB Shoulder Press", sets:"3", reps:"10-12", rir:"1-2", muscle:"Shoulders", note:"Full ROM." },
    { name:"Cable Lateral Raise", sets:"4", reps:"15-20", rir:"0-1", muscle:"Shoulders", note:"Lean away from cable. Width = medial delt." },
    { name:"Overhead Cable Tricep Ext", sets:"3", reps:"12-15", rir:"1", muscle:"Triceps", note:"Long head stretched = most growth." },
    { name:"Tricep Rope Pushdown", sets:"3", reps:"15-20", rir:"0-1", muscle:"Triceps", note:"Flare at bottom, squeeze." },
  ]},
  pull: { label:"Pull", sub:"Back · Biceps · Rear Delts", warmup:"10 min stairmaster + band pull-aparts", exercises:[
    { name:"Weighted Pull-Up", sets:"4", reps:"5-7", rir:"1-2", muscle:"Back", note:"Add a plate at 7 clean reps. Dead hang each rep." },
    { name:"Barbell Row", sets:"4", reps:"8-10", rir:"1-2", muscle:"Back", barbell:true, note:"Stretch at bottom, drive elbow back." },
    { name:"Lat Pulldown (wide)", sets:"3", reps:"10-12", rir:"1-2", muscle:"Back", note:"Drive elbows to sides." },
    { name:"Seated Cable Row", sets:"3", reps:"12-15", rir:"1", muscle:"Back", note:"Let torso travel forward for stretch." },
    { name:"Face Pull", sets:"3", reps:"15-20", rir:"0-1", muscle:"Rear Delts", note:"Shoulder health — non-negotiable." },
    { name:"Incline DB Curl", sets:"3", reps:"10-12", rir:"1", muscle:"Biceps", note:"Arm behind body = lengthened. Slow negative." },
    { name:"Cable Curl", sets:"3", reps:"15-20", rir:"0", muscle:"Biceps", note:"Constant tension, go to failure." },
  ]},
  legs: { label:"Legs", sub:"Quads · Hams · Glutes · Calves", warmup:"5 min bike + goblet squats", exercises:[
    { name:"Barbell Back Squat", sets:"4", reps:"5-7", rir:"1-2", muscle:"Quads", barbell:true, note:"Full depth. Brace hard. +5lb at 7 reps." },
    { name:"Romanian Deadlift", sets:"3", reps:"10-12", rir:"1-2", muscle:"Hamstrings", barbell:true, note:"Push hips back, feel the stretch." },
    { name:"Leg Press (feet high)", sets:"3", reps:"12-15", rir:"1", muscle:"Quads", note:"Deep ROM, don't lock out." },
    { name:"Walking Lunge", sets:"3", reps:"12 ea", rir:"1", muscle:"Quads", note:"Long stride, DBs in hand." },
    { name:"Seated Leg Curl", sets:"3", reps:"12-15", rir:"0-1", muscle:"Hamstrings", note:"Seated = lengthened. Squeeze." },
    { name:"Standing Calf Raise", sets:"4", reps:"15-20", rir:"0", muscle:"Calves", note:"3s down, pause at stretch." },
  ]},
};
const MUSCLE_MAP = {}; Object.values(WORKOUTS).forEach(w => w.exercises.forEach(e => { MUSCLE_MAP[e.name] = e.muscle; }));

const CARDIO_META = { Run: { icon:"🏃", z2:"30-40 min Zone 2 (HR 130-148), conversational pace" }, Ride: { icon:"🚴", z2:"45-60 min, Zone 2 endurance or a Zwift Sweetspot workout" }, Swim: { icon:"🏊", z2:"20-30 min steady, focus on form" } };

// ── daily motivational quotes (public-domain / classical figures) ────────────
const QUOTES = [
  { q:"You have power over your mind — not outside events. Realize this, and you will find strength.", a:"Marcus Aurelius" },
  { q:"The impediment to action advances action. What stands in the way becomes the way.", a:"Marcus Aurelius" },
  { q:"Waste no more time arguing what a good man should be. Be one.", a:"Marcus Aurelius" },
  { q:"Concentrate every minute on doing what's in front of you with precision.", a:"Marcus Aurelius" },
  { q:"Confine yourself to the present.", a:"Marcus Aurelius" },
  { q:"We are what we repeatedly do. Excellence, then, is not an act but a habit.", a:"Aristotle" },
  { q:"It is not that we have a short time to live, but that we waste much of it.", a:"Seneca" },
  { q:"Difficulties strengthen the mind, as labor does the body.", a:"Seneca" },
  { q:"We suffer more often in imagination than in reality.", a:"Seneca" },
  { q:"Luck is what happens when preparation meets opportunity.", a:"Seneca" },
  { q:"No man is free who is not master of himself.", a:"Epictetus" },
  { q:"First say to yourself what you would be; then do what you have to do.", a:"Epictetus" },
  { q:"Make the best use of what is in your power, and take the rest as it happens.", a:"Epictetus" },
  { q:"It's not what happens to you, but how you react that matters.", a:"Epictetus" },
  { q:"It does not matter how slowly you go, so long as you do not stop.", a:"Confucius" },
  { q:"The journey of a thousand miles begins with a single step.", a:"Lao Tzu" },
  { q:"In the midst of chaos, there is also opportunity.", a:"Sun Tzu" },
  { q:"Energy and persistence conquer all things.", a:"Benjamin Franklin" },
  { q:"By failing to prepare, you are preparing to fail.", a:"Benjamin Franklin" },
  { q:"With self-discipline most anything is possible.", a:"Theodore Roosevelt" },
  { q:"Do what you can, with what you have, where you are.", a:"Theodore Roosevelt" },
  { q:"Nothing worth having or doing comes without effort, pain, and difficulty.", a:"Theodore Roosevelt" },
  { q:"The first and best victory is to conquer self.", a:"Plato" },
  { q:"He who has a why to live can bear almost any how.", a:"Nietzsche" },
  { q:"Quality is not an act, it is a habit.", a:"Aristotle" },
  { q:"The man who moves a mountain begins by carrying away small stones.", a:"Confucius" },
  { q:"Fall seven times, stand up eight.", a:"Japanese Proverb" },
  { q:"What we fear doing most is usually what we most need to do.", a:"Seneca" },
  { q:"Begin at once to live, and count each separate day as a separate life.", a:"Seneca" },
];
function quoteOfDay() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const day = Math.floor((new Date() - start) / 86400000);
  return QUOTES[day % QUOTES.length];
}


// ── local food parser (so coach logging works with NO network) ───────────────
const FOOD_DB = [
  { keys:["premier","protein shake","protein powder","whey shake","shake"], p:30, c:5, f:3, name:"protein shake" },
  { keys:["greek yogurt"], p:18, c:8, f:0, name:"Greek yogurt" },
  { keys:["cottage cheese"], p:14, c:5, f:4, name:"cottage cheese" },
  { keys:["subway","sub sandwich","sandwich","sub"], p:25, c:46, f:10, name:"sandwich" },
  { keys:["chicken breast","chicken"], p:35, c:0, f:4, name:"chicken" },
  { keys:["ground beef","steak","beef","burger"], p:30, c:0, f:15, name:"beef" },
  { keys:["protein bar","quest bar"], p:20, c:22, f:8, name:"protein bar" },
  { keys:["peanut butter"], p:8, c:6, f:16, name:"peanut butter" },
  { keys:["beef jerky","jerky"], p:30, c:6, f:2, name:"jerky" },
  { keys:["salmon"], p:30, c:0, f:13, name:"salmon" },
  { keys:["tuna"], p:25, c:0, f:1, name:"tuna" },
  { keys:["turkey"], p:25, c:0, f:3, name:"turkey" },
  { keys:["shrimp"], p:24, c:0, f:1, name:"shrimp" },
  { keys:["tofu"], p:20, c:3, f:11, name:"tofu" },
  { keys:["sweet potato"], p:2, c:26, f:0, name:"sweet potato" },
  { keys:["oatmeal","oats"], p:5, c:27, f:3, name:"oatmeal" },
  { keys:["egg"], p:6, c:0, f:5, name:"egg", perUnit:true },
  { keys:["banana"], p:1, c:27, f:0, name:"banana", perUnit:true },
  { keys:["apple"], p:0, c:25, f:0, name:"apple", perUnit:true },
  { keys:["yogurt"], p:10, c:17, f:2, name:"yogurt" },
  { keys:["milk"], p:8, c:12, f:5, name:"milk" },
  { keys:["rice"], p:5, c:45, f:0, name:"rice" },
  { keys:["pasta"], p:8, c:43, f:1, name:"pasta" },
  { keys:["bread","toast","bagel"], p:5, c:25, f:1, name:"bread" },
  { keys:["almonds","nuts"], p:6, c:6, f:14, name:"nuts" },
  { keys:["cava","sweetgreen"], p:45, c:50, f:25, name:"Cava/Sweetgreen bowl" },
  { keys:["cheese"], p:7, c:1, f:9, name:"cheese" },
  { keys:["bacon"], p:12, c:0, f:12, name:"bacon" },
  { keys:["sausage"], p:14, c:2, f:18, name:"sausage" },
];
const NUM_WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, a:1, an:1, couple:2 };
function wordToNum(w) { return NUM_WORDS[w] ?? (parseFloat(w) || 1); }
function parseFood(msg) {
  let work = " " + msg.toLowerCase() + " ";
  const found = [];
  for (const fd of FOOD_DB) {
    for (const k of fd.keys) {
      const idx = work.indexOf(k);
      if (idx >= 0) {
        const before = work.slice(Math.max(0, idx-14), idx);
        let qty = 1;
        const nm = before.match(/(\d+(?:\.\d+)?)\s*$/) || before.match(/(one|two|three|four|five|six|seven|eight|a|an|couple)\s+$/);
        if (nm) qty = wordToNum(nm[1]);
        const mult = fd.perUnit ? qty : (qty > 1 ? qty : 1);
        const label = qty > 1 ? `${qty} ${fd.name}${fd.perUnit ? "s" : ""}` : fd.name;
        found.push({ name: label, protein: Math.round(fd.p*mult), carbs: Math.round(fd.c*mult), fats: Math.round(fd.f*mult) });
        work = work.slice(0, idx) + " ".repeat(k.length) + work.slice(idx + k.length);
        break;
      }
    }
  }
  return found;
}
function parseWater(msg) {
  const m = msg.toLowerCase();
  const hasWater = /\bwater\b|hydrate|hydration/.test(m);
  const om = m.match(/(\d+)\s*oz/);
  if (om && (hasWater || /drank|drink|had|chugged/.test(m))) return parseInt(om[1]);
  if (hasWater) { if (/gallon/.test(m)) return 128; if (/big bottle|large bottle/.test(m)) return 32; if (/bottle/.test(m)) return 16; if (/glass|cup/.test(m)) return 8; return 8; }
  return 0;
}
function parseCardio(msg) {
  const m = msg.toLowerCase();
  let activity = null;
  if (/\b(ran|run|running|jog|jogged)\b/.test(m)) activity = "Run";
  else if (/\b(bike|biked|cycled|cycling|rode|riding|zwift|spin|ride)\b/.test(m)) activity = "Ride";
  else if (/\b(swam|swim|swimming)\b/.test(m)) activity = "Swim";
  if (!activity) return null;
  const dm = m.match(/(\d+(?:\.\d+)?)\s*(miles|mile|mi|km|k)\b/);
  let dist = "", unit = "mi";
  if (dm) { dist = dm[1]; unit = /km|k/.test(dm[2]) ? "km" : "mi"; }
  const tm = m.match(/(\d+(?:\.\d+)?)\s*(minutes|minute|min|mins)\b/);
  return { activity, dist, unit, time: tm ? tm[1] : "" };
}

// ── plan engine (LOCAL, never fails) ─────────────────────────────────────────
function bumpRir(r) { return ({ "0":"1", "0-1":"1-2", "1":"2", "1-2":"2-3" })[r] || r; }
function nextSession(history) { for (let i=history.length-1;i>=0;i--){ const t=history[i].checkin?.sessionType; if(t==="push")return"pull"; if(t==="pull")return"legs"; if(t==="legs")return"push"; } return "push"; }
function downTier(s) { return ({ PEAK:"GOOD", GOOD:"NORMAL", NORMAL:"LOW", LOW:"LOW" })[s] || s; }
function e1rm(w, reps) { const r = parseInt(reps)||1; return w * (1 + r/30); }

function sleepTargetFor(c, S) {
  const wake = (S.wakeTime||"07:00").split(":").map(Number);
  const need = parseFloat(S.sleepNeed)||9.5;
  const debt = parseFloat(c?.sleepDebt);
  let buffer = 0.25;
  if (!isNaN(debt) && debt>=2) buffer += Math.min(1, debt*0.25);
  let mins = (wake[0]*60 + (wake[1]||0)) - Math.round((need+buffer)*60);
  mins = ((mins % 1440) + 1440) % 1440;
  let h = Math.floor(mins/60); const mm = mins%60; const ap = h>=12?"PM":"AM"; h = h%12||12;
  return `${h}:${String(mm).padStart(2,"0")} ${ap}`;
}

function suggestMeal(remaining, pantry) {
  const p = (pantry||"").toLowerCase(); const has = (...w) => w.some(x => p.includes(x));
  if (has("chicken")&&has("rice")) return { meal:"Chicken & rice bowl — load the chicken, add veggies + hot sauce", macros:"~45g P / 60g C" };
  if (has("chicken")) return { meal:"Chicken + whatever carb & greens you've got. Big portion.", macros:"~40g P" };
  if (has("beef","steak","ground")) return { meal:"Beef + a carb + greens", macros:"~40g P" };
  if (has("salmon","fish","tuna")) return { meal:"Fish + rice/potato + greens", macros:"~40g P" };
  if (has("egg")) return { meal:"4-egg scramble + whatever's in the fridge + toast", macros:"~28g P" };
  if (has("yogurt","greek")) return { meal:"Greek yogurt bowl + granola + scoop of protein powder", macros:"~40g P" };
  if (remaining>80) return { meal:"Cava or Sweetgreen — DOUBLE protein + hummus/feta. You're behind, make it big.", macros:"~55g P" };
  if (remaining>40) return { meal:"Cava bowl, double chicken", macros:"~50g P" };
  return { meal:"Protein shake + Greek yogurt to top off", macros:"~50g P" };
}
function topPriority(c, hasCardio, currentProtein, S) {
  const debt=parseFloat(c.sleepDebt), rec=parseInt(c.recovery), sleep=parseFloat(c.sleepHours);
  if ((!isNaN(debt)&&debt>=2)||(!isNaN(sleep)&&sleep<6)) return `Sleep tonight — bed by ${sleepTargetFor(c,S)}. Real debt is stacking; no screens in bed.`;
  if (!isNaN(rec)&&rec<48) return "Recovery's low — train smart, stop 2-3 reps short of failure, protect sleep tonight.";
  const rem = S.proteinTarget-(currentProtein||0);
  if (rem>100) return `Protein: ${rem}g to go. Front-load it so you're not cramming at 10pm.`;
  if (hasCardio) return "Lift first, then your cardio. Log both — every mile and every set counts toward the week.";
  return "Hit your main lift hard, log every set, beat last week where you can.";
}

function buildPlan(c, history, currentProtein=0, S=DEFAULT_SETTINGS) {
  const rec = c.recovery==null||c.recovery==="" ? null : parseInt(c.recovery);
  const status = recStatus(rec);
  const subj = parseInt(c.subjective)||3;

  let effStatus = status, subjNote = "";
  if (status!=="UNKNOWN") {
    if (subj<=2 && (status==="PEAK"||status==="GOOD"||status==="NORMAL")) {
      effStatus = downTier(status);
      subjNote = (effStatus==="LOW"||effStatus==="REST")
        ? `You rated yourself ${subj}/5 — trimmed a set and backed off intensity despite ${rec}%.`
        : `You rated yourself ${subj}/5 — keep it a full but honest session; don't chase PRs today.`;
    } else if (subj>=4 && status==="LOW") {
      effStatus = "NORMAL";
      subjNote = `You feel ${subj}/5 despite ${rec}% — training normally; the score lags how you actually feel.`;
    }
  }

  let liftType = c.sessionType || "auto";
  if (liftType === "auto") liftType = nextSession(history);
  const doLift = liftType !== "rest";
  const W = doLift ? (WORKOUTS[liftType] || WORKOUTS.push) : null;
  const t = parseInt(c.timeAvailable) || 60;
  const rem = Math.max(0, S.proteinTarget - (currentProtein||0));
  const meal = suggestMeal(rem, c.pantry);
  const cardioOn = c.cardioActivity && c.cardioActivity !== "none";

  let exercises = doLift ? W.exercises.map(e => ({ ...e })) : [];
  let workoutType = "FULL SESSION", rationale = "";

  if (doLift) {
    if (status==="REST") rationale = `Recovery ${rec}% is bottom-range for you. Skip the lift — active recovery, mobility, early night. Lifting hard now just digs the hole deeper.`;
    else if (status==="LOW") rationale = `Recovery ${rec}% is a genuine low. Same ${W.label.toLowerCase()} movements, a set lighter, stopping further from failure.`;
    else if (status==="NORMAL") rationale = `Recovery ${rec}% is your normal range — most of your best training happens here. Full ${W.label.toLowerCase()} session.`;
    else if (status==="GOOD") rationale = `Recovery ${rec}% is a good day. Full ${W.label.toLowerCase()} session — push your top sets.`;
    else if (status==="PEAK") rationale = `Recovery ${rec}% is top-tier for you. Chase PRs on your main lift, add weight where you can.`;
    else rationale = `Full ${W.label.toLowerCase()} session. Log every set.`;

    if (effStatus==="REST") { workoutType="REST / RECOVERY"; exercises=[]; }
    else if (effStatus==="LOW") { workoutType="REDUCED"; exercises=exercises.map(e=>({...e,sets:String(Math.max(2,parseInt(e.sets)-1)),rir:bumpRir(e.rir)})); }
    else if (effStatus==="PEAK") { workoutType="PUSH HARD"; }

    if (subjNote) rationale += " " + subjNote;
    if (exercises.length) { if (t<30) exercises=exercises.slice(0,4); else if (t<45) exercises=exercises.slice(0,5); else if (t<55) exercises=exercises.slice(0,6); }
  } else if (cardioOn) {
    workoutType = "CARDIO DAY"; rationale = `No lift today — ${c.cardioActivity.toLowerCase()} is the session. ${(status==="LOW"||status==="REST")?"Keep it easy given your recovery.":"Get the quality work in and log it."}`;
  } else {
    workoutType = "REST"; rationale = "Full rest day. Walk, stretch, eat, sleep. Adaptation happens now.";
  }

  let cardioPlan = null;
  if (cardioOn) {
    const meta = CARDIO_META[c.cardioActivity] || {};
    let guide = c.cardioTarget ? "" : meta.z2;
    if (status==="LOW"||status==="REST") guide = "Keep it easy — Zone 2 only, no surges. Let your body recover.";
    cardioPlan = { activity: c.cardioActivity, targetDist: c.cardioDist || "", targetTime: c.cardioTime || "", unit: c.cardioUnit || "mi", guide };
  }

  const liftTitle = doLift && exercises.length ? `${W.label.toUpperCase()} DAY` : (doLift && (status==="REST"||effStatus==="REST") ? "RECOVERY" : "");
  const cardioTitle = cardioOn ? `${(c.cardioDist?c.cardioDist+(c.cardioUnit||"mi")+" ":"")}${c.cardioActivity.toUpperCase()}` : "";
  let title = [liftTitle, cardioTitle].filter(Boolean).join(" + ") || "REST DAY";

  return {
    liftType, recoveryStatus: status, workoutType, workoutTitle: title,
    workoutSub: doLift && W ? W.sub : (cardioOn ? "Cardio session" : "Recovery"),
    workoutRationale: rationale, exercises,
    warmup: doLift && exercises.length ? W.warmup : null,
    cardioPlan,
    proteinRemaining: rem, mealSuggestion: meal.meal, mealMacros: meal.macros,
    topPriority: topPriority(c, cardioOn, currentProtein, S), sleepTarget: sleepTargetFor(c, S),
  };
}

// ── weekly hybrid totals + volume + streak ───────────────────────────────────
function withinWeek(dateStr) { const [y,m,d]=dateStr.split("-"); const cut=new Date(); cut.setDate(cut.getDate()-7); return new Date(+y,+m-1,+d) >= cut; }
function toMiles(d, unit) { const n=parseFloat(d)||0; return unit==="km" ? n*0.621371 : n; }

function weeklyTotals(allDays, cur) {
  const days = [...allDays]; if (cur) days.push(cur);
  let runMi=0, rideMi=0, sets=0;
  for (const day of days) { if (!withinWeek(day.date)) continue;
    for (const cd of (day.cardio||[])) { if (!cd.done) continue; const mi=toMiles(cd.dist, cd.unit); if (cd.activity==="Run") runMi+=mi; else if (cd.activity==="Ride") rideMi+=mi; }
    for (const ex of (day.loggedExercises||[])) sets += (ex.sets||[]).filter(s=>s.done).length;
  }
  return { runMi: Math.round(runMi*10)/10, rideMi: Math.round(rideMi*10)/10, sets };
}
function weeklyVolume(allDays, cur) {
  const days=[...allDays]; if(cur) days.push(cur); const vol={};
  for (const day of days){ if(!withinWeek(day.date)) continue; for(const ex of (day.loggedExercises||[])){ const done=(ex.sets||[]).filter(s=>s.done).length; if(!done)continue; const m=MUSCLE_MAP[ex.name]||"Other"; vol[m]=(vol[m]||0)+done; } }
  return vol;
}
function calcStreak(allDays, cur) {
  const dates=new Set(allDays.filter(d=>d.plan).map(d=>d.date)); if(cur?.plan) dates.add(cur.date);
  let s=0, d=new Date(); if(!dates.has(fmtLocal(d))) d.setDate(d.getDate()-1);
  while(dates.has(fmtLocal(d))){ s++; d.setDate(d.getDate()-1); } return s;
}
function paceStr(dist, time, unit) {
  const d=parseFloat(dist), t=parseFloat(time); if(!d||!t) return null;
  const per=t/d; const mm=Math.floor(per), ss=Math.round((per-mm)*60);
  return `${mm}:${String(ss).padStart(2,"0")}/${unit==="km"?"km":"mi"}`;
}

function weeklyBuckets(allDays, cur, nWeeks=6) {
  const days=[...allDays]; if(cur) days.push(cur);
  const now=new Date();
  const buckets=[];
  for (let w=nWeeks-1; w>=0; w--) {
    const end=new Date(now); end.setDate(now.getDate()-w*7); end.setHours(23,59,59,999);
    const start=new Date(end); start.setDate(end.getDate()-6); start.setHours(0,0,0,0);
    buckets.push({ start, end, label:`${start.getMonth()+1}/${start.getDate()}`, runMi:0, rideMi:0, sets:0, recSum:0, recCount:0, bwSum:0, bwCount:0 });
  }
  for (const day of days) {
    const [y,m,dd]=day.date.split("-"); const dt=new Date(+y,+m-1,+dd);
    for (const b of buckets) {
      if (dt>=b.start && dt<=b.end) {
        for (const c of (day.cardio||[])) { if(!c.done)continue; const mi=toMiles(c.dist,c.unit); if(c.activity==="Run")b.runMi+=mi; else if(c.activity==="Ride")b.rideMi+=mi; }
        for (const ex of (day.loggedExercises||[])) b.sets += (ex.sets||[]).filter(s=>s.done).length;
        if (day.checkin?.recovery) { b.recSum+=parseInt(day.checkin.recovery); b.recCount++; }
        const bw=parseFloat(day.checkin?.bodyWeight); if(bw){ b.bwSum+=bw; b.bwCount++; }
        break;
      }
    }
  }
  return buckets.map(b=>({ label:b.label, runMi:Math.round(b.runMi*10)/10, rideMi:Math.round(b.rideMi*10)/10, sets:b.sets, rec:b.recCount?Math.round(b.recSum/b.recCount):0, bw:b.bwCount?Math.round(b.bwSum/b.bwCount*10)/10:0 }));
}
function liftPRs(allDays, cur) {
  const days=[...allDays]; if(cur) days.push(cur);
  const prs={};
  for (const day of days) for (const ex of (day.loggedExercises||[])) for (const s of (ex.sets||[])) {
    const w=parseFloat(s.weight); if(!w) continue; const est=e1rm(w, s.reps);
    if(!prs[ex.name] || est>prs[ex.name].est) prs[ex.name]={ weight:w, reps:s.reps||"", est, date:day.date };
  }
  return prs;
}

// ── UI primitives ────────────────────────────────────────────────────────────
function Card({ children, accent, style={}, onClick }) { return <div onClick={onClick} style={{ background:"#161616", border:"1px solid #2a2a2a", borderLeft:accent?`3px solid ${accent}`:"1px solid #2a2a2a", borderRadius:"4px", padding:"16px 18px", cursor:onClick?"pointer":"default", animation:"rise .3s ease both", ...style }}>{children}</div>; }
function Label({ children, color="#b8b8b8" }) { return <div style={{ fontSize:"10px", letterSpacing:"3px", color, marginBottom:"6px", fontWeight:"600" }}>{children}</div>; }
function Spinner({ msg="Working…" }) { return <div style={{ display:"flex", alignItems:"center", gap:"10px", color:"#d4d4d4", fontSize:"13px" }}><div style={{ width:18, height:18, border:"2px solid #333", borderTop:"2px solid #E8FF47", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />{msg}</div>; }
function Btn({ children, onClick, primary, style={}, small }) { return <button onClick={onClick} style={{ padding:small?"9px 16px":"14px 20px", background:primary?"#E8FF47":"transparent", border:primary?"none":"1px solid #3a3a3a", borderRadius:"4px", color:primary?"#0a0a0a":"#e4e4e4", fontSize:small?"11px":"12px", letterSpacing:"2px", fontWeight:primary?"700":"500", cursor:"pointer", fontFamily:"inherit", ...style }}>{children}</button>; }
const inp = { width:"100%", background:"#0d0d0d", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#fafafa", padding:"12px 12px", fontSize:"16px", fontFamily:"inherit", boxSizing:"border-box" };
const subLabel = { fontSize:"9px", color:"#9a9a9a", letterSpacing:"2px", marginBottom:"5px", fontWeight:"600" };

// Two-box duration input — "[7] h : [34] m". value is a DECIMAL of the big unit; emits decimal.
function DualTime({ value, onChange, bigUnit="h", smallUnit="m", accent="#E8FF47" }) {
  const dec = value===""||value==null||isNaN(parseFloat(value)) ? null : parseFloat(value);
  const [big, setBig] = useState(dec==null?"":String(Math.floor(dec)));
  const [small, setSmall] = useState(dec==null?"":String(Math.round((dec-Math.floor(dec))*60)));
  useEffect(()=>{
    const cur = (big===""&&small==="") ? null : ((parseInt(big)||0)+(parseInt(small)||0)/60);
    const inc = value===""||value==null||isNaN(parseFloat(value)) ? null : parseFloat(value);
    const same = (cur==null&&inc==null) || (cur!=null&&inc!=null&&Math.abs(cur-inc)<0.009);
    if(!same){ if(inc==null){ setBig(""); setSmall(""); } else { setBig(String(Math.floor(inc))); setSmall(String(Math.round((inc-Math.floor(inc))*60))); } }
  // eslint-disable-next-line
  }, [value]);
  const emit=(b,s)=>{ if(b===""&&s==="") onChange(""); else onChange(Math.round(((parseInt(b)||0)+(parseInt(s)||0)/60)*100)/100); };
  const box = { flex:1, width:"100%", background:"#0d0d0d", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#fafafa", padding:"12px 22px 12px 10px", fontSize:"18px", fontWeight:"700", fontFamily:"inherit", boxSizing:"border-box", textAlign:"center" };
  const unitS = { position:"absolute", right:"9px", top:"50%", transform:"translateY(-50%)", fontSize:"11px", color:"#888", fontWeight:"600", pointerEvents:"none" };
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"6px" }}>
      <div style={{ position:"relative", flex:1 }}><input value={big} onChange={e=>{ const v=e.target.value.replace(/[^0-9]/g,"").slice(0,2); setBig(v); emit(v,small); }} inputMode="numeric" placeholder="0" style={box} /><span style={unitS}>{bigUnit}</span></div>
      <span style={{ color:accent, fontWeight:"700", fontSize:"18px" }}>:</span>
      <div style={{ position:"relative", flex:1 }}><input value={small} onChange={e=>{ let v=e.target.value.replace(/[^0-9]/g,"").slice(0,2); if(v!==""&&parseInt(v)>59)v="59"; setSmall(v); emit(big,v); }} inputMode="numeric" placeholder="00" style={box} /><span style={unitS}>{smallUnit}</span></div>
    </div>
  );
}

function MacroBar({ label, current, target, color, unit="g" }) {
  const pct = target > 0 ? Math.min(100, (current/target)*100) : 0;
  const over = current > target;
  return (
    <div style={{ marginBottom:"11px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"4px" }}>
        <span style={{ fontSize:"11px", color, fontWeight:"700", letterSpacing:"1px" }}>{label}</span>
        <span style={{ fontSize:"11px", color:"#c4c4c4" }}><span style={{ color:over?"#4ade80":"#fafafa", fontWeight:"700" }}>{Math.round(current)}</span> / {target}{unit}</span>
      </div>
      <div style={{ background:"#0a0a0a", borderRadius:"3px", height:"8px", overflow:"hidden" }}>
        <div style={{ height:"100%", background:color, width:`${pct}%`, transition:"width 0.5s cubic-bezier(.2,.8,.2,1)", opacity:0.9 }} />
      </div>
    </div>
  );
}

function MiniBars({ data, color, valueKey, suffix="", baseline=0, decimals=0 }) {
  const max = Math.max(1, ...data.map(d => d[valueKey]));
  const base = baseline || 0;
  const span = (max - base) || 1;
  return (
    <div style={{ display:"flex", alignItems:"flex-end", gap:"6px", height:"96px", marginTop:"4px" }}>
      {data.map((d,i) => {
        const v = d[valueKey];
        const h = v>0 ? Math.max(2, ((v-base)/span)*64) : 0;
        const isLast = i === data.length-1;
        return (
          <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-end", height:"100%" }}>
            <div style={{ fontSize:"9px", color:isLast?color:"#9a9a9a", fontWeight:isLast?"700":"500", marginBottom:"3px" }}>{v?(decimals?v.toFixed(decimals):v):""}{v?suffix:""}</div>
            <div style={{ width:"100%", maxWidth:"30px", height:`${h}px`, background:isLast?color:`${color}66`, borderRadius:"2px 2px 0 0", transition:"height 0.5s cubic-bezier(.2,.8,.2,1)" }} />
            <div style={{ fontSize:"8px", color:"#777", marginTop:"4px" }}>{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// ── CHECK-IN ─────────────────────────────────────────────────────────────────
function CheckinFlow({ existingDay, onSave, onClose }) {
  const ex = existingDay?.checkin || {};
  const [f, setF] = useState({
    recovery:ex.recovery??"", hrv:ex.hrv??"", sleepHours:ex.sleepHours??"", sleepDebt:ex.sleepDebt??"",
    bodyWeight:ex.bodyWeight??"", rhr:ex.rhr??"",
    timeAvailable:ex.timeAvailable??"", location:ex.location??"full_gym", subjective:ex.subjective??"3",
    sessionType:ex.sessionType??"auto",
    cardioActivity:ex.cardioActivity??"none", cardioDist:ex.cardioDist??"", cardioTime:ex.cardioTime??"", cardioUnit:ex.cardioUnit??"mi",
    pantry:ex.pantry??"", notes:ex.notes??"",
  });
  const [parsing, setParsing] = useState(false); const [parseMsg, setParseMsg] = useState("");
  const inputRef = useRef(); const set = (k,v) => setF(p=>({ ...p, [k]:v }));
  const rc = recColor(f.recovery===""?null:parseInt(f.recovery));

  async function handleFiles(files) {
    const imgs=Array.from(files); if(!imgs.length) return; setParsing(true); setParseMsg("");
    try {
      const blocks=[]; for(const file of imgs){ const b64=await toBase64(file); const mime=file.type==="image/jpg"?"image/jpeg":(file.type||"image/jpeg"); blocks.push({ type:"image", source:{ type:"base64", media_type:mime, data:b64 } }); }
      blocks.push({ type:"text", text:`WHOOP/Garmin screenshots. Return ONLY JSON: {"recovery":null,"hrv":null,"rhr":null,"sleepHours":null,"sleepDebt":null}. Numbers only; sleepHours and sleepDebt as DECIMAL hours (a 7h 34m sleep = 7.57). null if absent.` });
      const res=await fetch("https://api.anthropic.com/v1/messages",{ method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ model:MODEL, max_tokens:500, messages:[{role:"user",content:blocks}] }) });
      if(!res.ok) throw new Error(`API ${res.status}`); const data=await res.json();
      const raw=(data.content||[]).find(b=>b.type==="text")?.text||""; const mt=raw.match(/\{[\s\S]*\}/); if(!mt) throw new Error("no data");
      const p=JSON.parse(mt[0]); setF(prev=>({ ...prev, recovery:p.recovery??prev.recovery, hrv:p.hrv??prev.hrv, rhr:p.rhr??prev.rhr, sleepHours:p.sleepHours??prev.sleepHours, sleepDebt:p.sleepDebt??prev.sleepDebt }));
      setParseMsg("✓ Filled from screenshot — check the numbers");
    } catch(e){ setParseMsg(`Couldn't auto-read (${e.message}). Just tap them in below — 10 seconds.`); }
    setParsing(false);
  }

  const liftOpts=[["auto","Auto"],["push","Push"],["pull","Pull"],["legs","Legs"],["rest","Rest/None"]];
  const cardioOpts=[["none","None"],["Run","🏃 Run"],["Ride","🚴 Ride"],["Swim","🏊 Swim"]];
  const cardioOn = f.cardioActivity!=="none";

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:100, overflowY:"auto" }}>
      <div style={{ maxWidth:"480px", margin:"0 auto", background:"#0a0a0a", minHeight:"100vh" }}>
        <div style={{ padding:"16px 20px", borderBottom:"1px solid #2a2a2a", display:"flex", justifyContent:"space-between", alignItems:"center", position:"sticky", top:0, background:"#0a0a0a", zIndex:2 }}>
          <Label>MORNING CHECK-IN</Label>
          <button onClick={onClose} style={{ background:"none", border:"none", color:"#bbb", fontSize:"22px", cursor:"pointer" }}>×</button>
        </div>
        <div style={{ padding:"20px" }}>
          <div style={{ fontSize:"22px", fontWeight:"700", marginBottom:"16px", color:"#fafafa" }}>HOW ARE YOU<br/><span style={{ color:"#E8FF47" }}>TODAY?</span></div>

          <div style={{ marginBottom:"16px" }}>
            <button onClick={()=>inputRef.current?.click()} style={{ width:"100%", padding:"13px", background:"#0d1420", border:"1px solid #2a4a6a", borderRadius:"4px", color:"#7cc8e8", fontSize:"12px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit" }}>📷 Upload WHOOP/Garmin screenshot to auto-fill</button>
            <input ref={inputRef} type="file" accept="image/*" multiple style={{ display:"none" }} onChange={e=>handleFiles(e.target.files)} />
            {parsing && <div style={{ marginTop:"8px" }}><Spinner msg="Reading…" /></div>}
            {parseMsg && <div style={{ marginTop:"8px", fontSize:"11px", color:parseMsg.startsWith("✓")?"#4ade80":"#fb923c", lineHeight:1.5 }}>{parseMsg}</div>}
          </div>

          <Card accent={rc} style={{ marginBottom:"14px" }}>
            <Label color={rc}>BIOMETRICS</Label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px", marginBottom:"14px" }}>
              {[["Recovery %","recovery"],["HRV (ms)","hrv"]].map(([l,k])=>(
                <div key={k}><div style={subLabel}>{l.toUpperCase()}</div><input value={f[k]} onChange={e=>set(k,e.target.value)} inputMode="numeric" placeholder="—" style={inp} /></div>
              ))}
            </div>
            <div style={{ marginBottom:"12px" }}>
              <div style={subLabel}>SLEEP LAST NIGHT</div>
              <DualTime value={f.sleepHours} onChange={v=>set("sleepHours",v)} bigUnit="h" smallUnit="m" accent={rc} />
              <div style={{ fontSize:"10px", color:"#777", marginTop:"5px" }}>Hours : minutes — e.g. <span style={{ color:"#9a9a9a" }}>7 : 34</span> (not 7.34)</div>
            </div>
            <div style={{ marginBottom:"14px" }}>
              <div style={subLabel}>SLEEP DEBT</div>
              <DualTime value={f.sleepDebt} onChange={v=>set("sleepDebt",v)} bigUnit="h" smallUnit="m" accent="#fb923c" />
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px" }}>
              {[["Body Weight (lb)","bodyWeight"],["Resting HR (bpm)","rhr"]].map(([l,k])=>(
                <div key={k}><div style={subLabel}>{l.toUpperCase()}</div><input value={f[k]} onChange={e=>set(k,e.target.value)} inputMode="decimal" placeholder="—" style={inp} /></div>
              ))}
            </div>
            <div style={{ fontSize:"10px", color:"#777", marginTop:"8px", lineHeight:1.5 }}>Body weight feeds your recomp trend in Progress — log it most mornings.</div>
          </Card>

          <Card style={{ marginBottom:"14px" }}>
            <Label color="#E8FF47">LIFT FOCUS</Label>
            <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:"14px" }}>
              {liftOpts.map(([v,l])=>(<button key={v} onClick={()=>set("sessionType",v)} style={{ padding:"9px 15px", borderRadius:"3px", fontSize:"11px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit", border:f.sessionType===v?"1.5px solid #E8FF47":"1.5px solid #3a3a3a", background:f.sessionType===v?"#E8FF47":"#111", color:f.sessionType===v?"#0a0a0a":"#bbb", fontWeight:f.sessionType===v?"700":"500" }}>{l}</button>))}
            </div>
            <div style={{ marginBottom:"14px" }}><div style={subLabel}>TIME FOR LIFTING (MIN)</div><input value={f.timeAvailable} onChange={e=>set("timeAvailable",e.target.value)} placeholder="e.g. 45" inputMode="numeric" style={inp} /></div>
            <div style={{ marginBottom:"14px" }}><div style={subLabel}>EQUIPMENT</div><div style={{ display:"flex", gap:"8px" }}>{[["full_gym","Full Gym"],["home","Home"],["none","None"]].map(([v,l])=>(<button key={v} onClick={()=>set("location",v)} style={{ padding:"9px 15px", borderRadius:"3px", fontSize:"11px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit", border:f.location===v?"1.5px solid #E8FF47":"1.5px solid #3a3a3a", background:f.location===v?"#E8FF47":"#111", color:f.location===v?"#0a0a0a":"#bbb" }}>{l}</button>))}</div></div>
            <div><div style={subLabel}>FEEL (1=DEAD · 5=GREAT)</div><div style={{ display:"flex", gap:"8px" }}>{["1","2","3","4","5"].map(v=>(<button key={v} onClick={()=>set("subjective",v)} style={{ flex:1, height:"46px", borderRadius:"3px", fontSize:"16px", cursor:"pointer", fontFamily:"inherit", fontWeight:"700", border:f.subjective===v?"1.5px solid #E8FF47":"1.5px solid #3a3a3a", background:f.subjective===v?"#E8FF47":"#111", color:f.subjective===v?"#0a0a0a":"#bbb" }}>{v}</button>))}</div><div style={{ fontSize:"10px", color:"#777", marginTop:"8px", lineHeight:1.5 }}>Feel overrides the score: a 4/5 on a low number still trains; a 2/5 on a high number gets trimmed.</div></div>
          </Card>

          <Card accent="#47C4FF" style={{ marginBottom:"14px" }}>
            <Label color="#47C4FF">CARDIO TODAY</Label>
            <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:cardioOn?"14px":0 }}>
              {cardioOpts.map(([v,l])=>(<button key={v} onClick={()=>set("cardioActivity",v)} style={{ padding:"9px 15px", borderRadius:"3px", fontSize:"11px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit", border:f.cardioActivity===v?"1.5px solid #47C4FF":"1.5px solid #3a3a3a", background:f.cardioActivity===v?"#47C4FF":"#111", color:f.cardioActivity===v?"#0a0a0a":"#bbb", fontWeight:f.cardioActivity===v?"700":"500" }}>{l}</button>))}
            </div>
            {cardioOn && (
              <div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"10px", marginBottom:"10px" }}>
                  <div><div style={subLabel}>TARGET DISTANCE</div><div style={{ display:"flex", gap:"6px" }}>
                    <input value={f.cardioDist} onChange={e=>set("cardioDist",e.target.value)} placeholder="5" inputMode="decimal" style={{ ...inp, flex:1 }} />
                    <button onClick={()=>set("cardioUnit", f.cardioUnit==="mi"?"km":"mi")} style={{ width:"54px", background:"#111", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#47C4FF", fontFamily:"inherit", fontSize:"13px", fontWeight:"700", cursor:"pointer" }}>{f.cardioUnit}</button>
                  </div></div>
                  <div><div style={subLabel}>TARGET TIME</div><DualTime value={f.cardioTime} onChange={v=>set("cardioTime",v)} bigUnit="m" smallUnit="s" accent="#47C4FF" /></div>
                </div>
                <div style={{ fontSize:"11px", color:"#9a9a9a", lineHeight:1.5 }}>You'll log your actual distance & time after — it tracks toward your weekly mileage.</div>
              </div>
            )}
          </Card>

          <Card style={{ marginBottom:"20px" }}>
            <Label color="#a3e635">NUTRITION & NOTES</Label>
            <div style={{ marginBottom:"12px" }}><div style={subLabel}>FRIDGE / PANTRY (FOR MEAL IDEAS)</div><textarea value={f.pantry} onChange={e=>set("pantry",e.target.value)} placeholder="chicken, eggs, rice, greek yogurt…" style={{ ...inp, minHeight:"56px", resize:"vertical" }} /></div>
            <div><div style={subLabel}>ANYTHING ELSE? (SORENESS, FOCUS…)</div><textarea value={f.notes} onChange={e=>set("notes",e.target.value)} placeholder="shoulders tweaky, big day at hospital…" style={{ ...inp, minHeight:"46px", resize:"vertical" }} /></div>
            <div style={{ fontSize:"11px", color:"#9a9a9a", marginTop:"10px", lineHeight:1.5 }}>Log food & water in the Fuel tab through the day — macros track live.</div>
          </Card>

          <Btn primary onClick={()=>onSave(f)} style={{ width:"100%", padding:"16px", letterSpacing:"3px" }}>BUILD MY DAY →</Btn>
          <div style={{ height:"30px" }} />
        </div>
      </div>
    </div>
  );
}

// ── EXERCISE LOG ─────────────────────────────────────────────────────────────
function ExerciseLog({ exercise, logged, onUpdate, prevLog, barWeight=45 }) {
  const [exp, setExp] = useState(false);
  const total = parseInt(exercise.sets)||3;
  const sets = logged?.sets || Array.from({length:total},()=>({weight:"",reps:"",done:false}));
  const done = sets.filter(s=>s.done).length;
  const upd=(i,fl,v)=>onUpdate({ name:exercise.name, sets:sets.map((s,x)=>x===i?{...s,[fl]:v}:s) });
  const tog=(i)=>onUpdate({ name:exercise.name, sets:sets.map((s,x)=>x===i?{...s,done:!s.done}:s) });
  const add=()=>onUpdate({ name:exercise.name, sets:[...sets,{weight:sets[sets.length-1]?.weight||"",reps:"",done:false}] });
  const rm=()=>{ if(sets.length>1) onUpdate({ name:exercise.name, sets:sets.slice(0,-1) }); };
  const prevSetsW = (prevLog?.sets||[]).filter(s=>s.weight);
  const prevBest = prevSetsW.map(s=>`${s.weight}×${s.reps}`).join(", ");
  const topRep = parseInt((exercise.reps.match(/(\d+)\s*$/)||[])[1]) || parseInt(exercise.reps) || 0;
  const clearedTop = prevSetsW.length>0 && topRep>0 && prevSetsW.every(s=>(parseInt(s.reps)||0) >= topRep);
  return (
    <div style={{ background:"#161616", border:done===sets.length&&sets.length>0?"1px solid #4ade80":"1px solid #2a2a2a", borderRadius:"4px", overflow:"hidden", animation:"rise .3s ease both" }}>
      <div onClick={()=>setExp(!exp)} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div style={{ flex:1 }}><div style={{ fontSize:"14px", fontWeight:"600", marginBottom:"4px", color:"#fafafa" }}>{exercise.name}</div><div style={{ fontSize:"11px", color:"#a8a8a8", lineHeight:1.5 }}>{exercise.note}</div>{prevBest && (clearedTop ? <div style={{ fontSize:"11px", color:"#4ade80", marginTop:"6px", fontWeight:"600" }}>✓ Cleared all {topRep}+ last time ({prevBest}) — add weight today</div> : <div style={{ fontSize:"11px", color:"#7cb87c", marginTop:"6px" }}>↑ Last: {prevBest} — beat it</div>)}</div>
        <div style={{ textAlign:"right", flexShrink:0, marginLeft:"12px" }}><div style={{ fontSize:"14px", color:"#E8FF47", fontWeight:"700" }}>{exercise.sets}×{exercise.reps}</div><div style={{ fontSize:"11px", color:"#a8a8a8" }}>RIR {exercise.rir}</div>{done>0&&<div style={{ fontSize:"11px", color:done===sets.length?"#4ade80":"#facc15", marginTop:"4px", fontWeight:"700" }}>{done}/{sets.length} ✓</div>}</div>
      </div>
      {exp && (
        <div style={{ padding:"0 16px 16px", borderTop:"1px solid #2a2a2a" }}>
          {exercise.barbell && (
            <div style={{ paddingTop:"12px" }}>
              <div style={{ ...subLabel, marginBottom:"6px" }}>QUICK LOAD · BAR {barWeight}LB + PLATES/SIDE</div>
              <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:"12px" }}>
                <button onClick={()=>onUpdate({ name:exercise.name, sets:sets.map(s=>s.done?s:({...s,weight:String(barWeight)})) })} style={{ padding:"9px 13px", background:"#1a1a1a", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#e4e4e4", fontSize:"12px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit" }}>BAR {barWeight}</button>
                {[45,25,10,5].map(pl => (
                  <button key={pl} onClick={()=>onUpdate({ name:exercise.name, sets:sets.map(s=>s.done?s:({...s,weight:String((parseFloat(s.weight)||0)+pl*2)})) })} style={{ padding:"9px 13px", background:"#0d1a0d", border:"1px solid #2a4a1a", borderRadius:"3px", color:"#a3e635", fontSize:"12px", fontWeight:"700", cursor:"pointer", fontFamily:"inherit" }}>+{pl}</button>
                ))}
                <button onClick={()=>onUpdate({ name:exercise.name, sets:sets.map(s=>s.done?s:({...s,weight:""})) })} style={{ padding:"9px 11px", background:"transparent", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#888", fontSize:"12px", cursor:"pointer", fontFamily:"inherit" }}>↺</button>
              </div>
            </div>
          )}
          <div style={{ display:"flex", fontSize:"10px", letterSpacing:"2px", color:"#9a9a9a", padding:exercise.barbell?"0 0 8px":"12px 0 8px", gap:"8px", fontWeight:"600" }}><div style={{ width:"30px", textAlign:"center" }}>SET</div><div style={{ flex:1 }}>WEIGHT</div><div style={{ flex:1 }}>REPS</div><div style={{ width:"44px", textAlign:"center" }}>✓</div></div>
          {sets.map((s,i)=>(<div key={i} style={{ display:"flex", gap:"8px", marginBottom:"8px", alignItems:"center" }}><div style={{ width:"30px", textAlign:"center", fontSize:"13px", color:"#fafafa", fontWeight:"700" }}>{i+1}</div><input value={s.weight} onChange={e=>upd(i,"weight",e.target.value)} placeholder={prevLog?.sets?.[i]?.weight?`${prevLog.sets[i].weight}`:"lbs"} inputMode="decimal" style={{ ...inp, padding:"11px 12px" }} /><input value={s.reps} onChange={e=>upd(i,"reps",e.target.value)} placeholder={exercise.reps.split("-")[0]} inputMode="numeric" style={{ ...inp, padding:"11px 12px" }} /><button onClick={()=>tog(i)} style={{ width:"44px", height:"44px", borderRadius:"3px", border:s.done?"1.5px solid #4ade80":"1.5px solid #3a3a3a", background:s.done?"#4ade80":"transparent", color:s.done?"#0a0a0a":"#888", cursor:"pointer", fontSize:"18px", flexShrink:0 }}>✓</button></div>))}
          <div style={{ display:"flex", gap:"8px", marginTop:"6px" }}><button onClick={add} style={{ flex:1, padding:"11px", background:"transparent", border:"1px dashed #47C4FF", borderRadius:"3px", color:"#47C4FF", fontSize:"11px", letterSpacing:"2px", cursor:"pointer", fontFamily:"inherit", fontWeight:"600" }}>+ ADD SET</button>{sets.length>1&&<button onClick={rm} style={{ padding:"11px 14px", background:"transparent", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#a8a8a8", fontSize:"11px", letterSpacing:"2px", cursor:"pointer", fontFamily:"inherit" }}>− REMOVE</button>}</div>
        </div>
      )}
    </div>
  );
}

// ── CARDIO LOG (first-class, tracked) ────────────────────────────────────────
function CardioLog({ entry, onUpdate, onDelete }) {
  const [exp, setExp] = useState(!entry.done);
  const meta = CARDIO_META[entry.activity] || { icon:"🏃" };
  const p = paceStr(entry.dist, entry.time, entry.unit);
  const upd=(fl,v)=>onUpdate({ ...entry, [fl]:v });
  return (
    <div style={{ background:"#161616", border:entry.done?"1px solid #47C4FF":"1px solid #2a2a2a", borderRadius:"4px", overflow:"hidden", animation:"rise .3s ease both" }}>
      <div onClick={()=>setExp(!exp)} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:"14px", fontWeight:"600", color:"#fafafa" }}>{meta.icon} {entry.activity}{entry.fromPlan?"":" (added)"}</div>
          {(entry.targetDist||entry.targetTime) && <div style={{ fontSize:"11px", color:"#7cc8e8", marginTop:"4px" }}>Target: {entry.targetDist?`${entry.targetDist}${entry.unit}`:""}{entry.targetTime?` in ${fmtMS(entry.targetTime)}`:""}</div>}
          {entry.guide && !entry.dist && <div style={{ fontSize:"11px", color:"#9a9a9a", marginTop:"4px", lineHeight:1.5 }}>{entry.guide}</div>}
          {entry.dist && <div style={{ fontSize:"12px", color:"#d4d4d4", marginTop:"4px" }}>Logged: {entry.dist}{entry.unit}{entry.time?` · ${fmtMS(entry.time)}`:""}{p?` · ${p}`:""}</div>}
        </div>
        <div style={{ textAlign:"right", flexShrink:0, marginLeft:"12px" }}>{entry.done&&<div style={{ fontSize:"11px", color:"#47C4FF", fontWeight:"700" }}>✓ DONE</div>}</div>
      </div>
      {exp && (
        <div style={{ padding:"0 16px 16px", borderTop:"1px solid #2a2a2a" }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px", paddingTop:"12px", marginBottom:"10px" }}>
            <div><div style={subLabel}>DISTANCE ({entry.unit})</div><input value={entry.dist||""} onChange={e=>upd("dist",e.target.value)} placeholder={entry.targetDist||"0"} inputMode="decimal" style={{ ...inp, padding:"11px 12px" }} /></div>
            <div><div style={subLabel}>TIME (MIN : SEC)</div><DualTime value={entry.time} onChange={v=>upd("time",v)} bigUnit="m" smallUnit="s" accent="#47C4FF" /></div>
          </div>
          <div style={{ marginBottom:"10px" }}><div style={subLabel}>WHERE / NOTES</div><input value={entry.location||""} onChange={e=>upd("location",e.target.value)} placeholder="beach, treadmill, Zwift…" style={{ ...inp, padding:"11px 12px" }} /></div>
          {p && <div style={{ fontSize:"13px", color:"#47C4FF", fontWeight:"700", marginBottom:"10px" }}>Pace: {p}</div>}
          <div style={{ display:"flex", gap:"8px" }}>
            <button onClick={()=>upd("done",!entry.done)} style={{ flex:1, padding:"12px", background:entry.done?"#47C4FF":"transparent", border:"1.5px solid #47C4FF", borderRadius:"3px", color:entry.done?"#0a0a0a":"#47C4FF", fontSize:"11px", letterSpacing:"2px", cursor:"pointer", fontFamily:"inherit", fontWeight:"700" }}>{entry.done?"✓ COMPLETED":"MARK DONE"}</button>
            <button onClick={onDelete} style={{ padding:"12px 14px", background:"transparent", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#f87171", fontSize:"11px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit" }}>DELETE</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── NUTRITION PRESET EDITOR ──────────────────────────────────────────────────
function PresetEditor({ presets, onSave, onClose }) {
  const [list, setList] = useState(presets.map(p=>({ label:p.label, protein:p.protein ?? p.grams ?? "", carbs:p.carbs ?? "", fats:p.fats ?? "" })));
  const upd=(i,fl,v)=>setList(l=>l.map((x,idx)=>idx===i?{...x,[fl]:v}:x));
  const rm=(i)=>setList(l=>l.filter((_,idx)=>idx!==i));
  const add=()=>setList(l=>[...l,{label:"",protein:"",carbs:"",fats:""}]);
  const miniInp = { background:"#0d0d0d", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#fafafa", padding:"11px 4px", fontSize:"16px", fontFamily:"inherit", textAlign:"center", width:"46px" };
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div style={{ maxWidth:"480px", width:"100%", background:"#0a0a0a", borderTop:"1px solid #333", borderRadius:"12px 12px 0 0", padding:"20px", maxHeight:"85vh", overflowY:"auto", animation:"sheet .25s ease both" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}><div style={{ fontSize:"16px", fontWeight:"700", color:"#fafafa" }}>Edit your foods</div><button onClick={onClose} style={{ background:"none", border:"none", color:"#bbb", fontSize:"22px", cursor:"pointer" }}>×</button></div>
        <div style={{ display:"flex", gap:"8px", marginBottom:"8px", paddingRight:"50px" }}><div style={{ flex:1 }} /><div style={{ width:"46px", textAlign:"center", fontSize:"9px", color:"#4ade80", letterSpacing:"1px" }}>P</div><div style={{ width:"46px", textAlign:"center", fontSize:"9px", color:"#E8FF47", letterSpacing:"1px" }}>C</div><div style={{ width:"46px", textAlign:"center", fontSize:"9px", color:"#fb923c", letterSpacing:"1px" }}>F</div></div>
        <div style={{ display:"flex", flexDirection:"column", gap:"8px", marginBottom:"14px" }}>
          {list.map((p,i)=>(
            <div key={i} style={{ display:"flex", gap:"6px", alignItems:"center" }}>
              <input value={p.label} onChange={e=>upd(i,"label",e.target.value)} placeholder="Food name" style={{ ...inp, flex:1, padding:"11px 12px" }} />
              <input value={p.protein} onChange={e=>upd(i,"protein",e.target.value)} placeholder="0" inputMode="numeric" style={miniInp} />
              <input value={p.carbs} onChange={e=>upd(i,"carbs",e.target.value)} placeholder="0" inputMode="numeric" style={miniInp} />
              <input value={p.fats} onChange={e=>upd(i,"fats",e.target.value)} placeholder="0" inputMode="numeric" style={miniInp} />
              <button onClick={()=>rm(i)} style={{ width:"38px", height:"44px", background:"transparent", border:"1px solid #3a3a3a", borderRadius:"3px", color:"#f87171", cursor:"pointer", fontSize:"16px", flexShrink:0 }}>×</button>
            </div>
          ))}
        </div>
        <button onClick={add} style={{ width:"100%", padding:"12px", background:"transparent", border:"1px dashed #4ade80", borderRadius:"3px", color:"#4ade80", fontSize:"11px", letterSpacing:"2px", cursor:"pointer", fontFamily:"inherit", fontWeight:"600", marginBottom:"14px" }}>+ ADD FOOD</button>
        <Btn primary onClick={()=>{ onSave(list.filter(p=>p.label.trim()).map(p=>({ label:p.label.trim(), protein:parseInt(p.protein)||0, carbs:parseInt(p.carbs)||0, fats:parseInt(p.fats)||0 }))); onClose(); }} style={{ width:"100%" }}>SAVE FOODS</Btn>
      </div>
    </div>
  );
}

// ── SETTINGS ─────────────────────────────────────────────────────────────────
function SettingsSheet({ settings, onSave, onClose }) {
  const [s, setS] = useState({ ...settings });
  const set=(k,v)=>setS(p=>({...p,[k]:v}));
  const numFields = [
    ["BAR WEIGHT (LB)","barWeight"],["PROTEIN TARGET (G)","proteinTarget"],
    ["CARB TARGET (G)","carbTarget"],["FAT TARGET (G)","fatTarget"],
    ["WATER TARGET (OZ)","waterTarget"],["SLEEP NEED (HRS)","sleepNeed"],
  ];
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:300, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div style={{ maxWidth:"480px", width:"100%", background:"#0a0a0a", borderTop:"1px solid #333", borderRadius:"12px 12px 0 0", padding:"20px", maxHeight:"88vh", overflowY:"auto", animation:"sheet .25s ease both" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"6px" }}><div style={{ fontSize:"16px", fontWeight:"700", color:"#fafafa" }}>Settings</div><button onClick={onClose} style={{ background:"none", border:"none", color:"#bbb", fontSize:"22px", cursor:"pointer" }}>×</button></div>
        <div style={{ fontSize:"11px", color:"#9a9a9a", marginBottom:"16px", lineHeight:1.5 }}>Tuned to you — change anytime. These drive your macro bars, plate math, and sleep target.</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"12px", marginBottom:"14px" }}>
          {numFields.map(([l,k])=>(<div key={k}><div style={subLabel}>{l}</div><input value={s[k]} onChange={e=>set(k, e.target.value)} inputMode="decimal" style={inp} /></div>))}
        </div>
        <div style={{ marginBottom:"18px" }}><div style={subLabel}>WAKE TIME (DRIVES SLEEP TARGET)</div><input type="time" value={s.wakeTime} onChange={e=>set("wakeTime", e.target.value)} style={{ ...inp, colorScheme:"dark" }} /></div>
        <Btn primary onClick={()=>{ onSave({ barWeight:parseFloat(s.barWeight)||45, proteinTarget:parseInt(s.proteinTarget)||160, carbTarget:parseInt(s.carbTarget)||230, fatTarget:parseInt(s.fatTarget)||70, waterTarget:parseInt(s.waterTarget)||120, sleepNeed:parseFloat(s.sleepNeed)||9.5, wakeTime:s.wakeTime||"07:00" }); onClose(); }} style={{ width:"100%" }}>SAVE SETTINGS</Btn>
        <div style={{ height:"10px" }} />
      </div>
    </div>
  );
}

// ── DAY VIEW ─────────────────────────────────────────────────────────────────
function DayView({ day, isToday, onCheckin, onUpdate, prevDays, streak, totals, volume, presets, onSavePresets, bumpFreq, buckets, prs, settings }) {
  const [tab, setTab] = useState("workout");
  const [range, setRange] = useState(6);
  const [showCoach, setShowCoach] = useState(false);
  const [editPresets, setEditPresets] = useState(false);
  const [chat, setChat] = useState([]); const [chatIn, setChatIn] = useState(""); const [chatBusy, setChatBusy] = useState(false);

  if (!day || !day.plan) {
    return (
      <div style={{ padding:"50px 24px", textAlign:"center" }}>
        <div style={{ fontSize:"42px", marginBottom:"14px" }}>{isToday?"🏋️":"📅"}</div>
        <div style={{ fontSize:"15px", color:"#e4e4e4", marginBottom:"6px" }}>{isToday?"No plan for today yet":"No data for this day"}</div>
        <div style={{ fontSize:"12px", color:"#9a9a9a", marginBottom:"22px", lineHeight:1.6 }}>{isToday?"Do your morning check-in — builds instantly.":"You didn't check in this day."}</div>
        {isToday && <Btn primary onClick={onCheckin}>START CHECK-IN →</Btn>}
      </div>
    );
  }

  const { checkin, plan, loggedExercises=[], cardio=[] } = day;
  const rec = checkin?.recovery===""||checkin?.recovery==null ? null : parseInt(checkin.recovery);
  const rc = recColor(rec);
  const wc = { "FULL SESSION":"#4ade80", "PUSH HARD":"#4ade80", "CARDIO DAY":"#47C4FF", "REDUCED":"#fb923c", "REST":"#f87171", "REST / RECOVERY":"#f87171" }[plan.workoutType] || "#a3e635";

  function updateExercise(u){ const a=[...loggedExercises]; const i=a.findIndex(e=>e.name===u.name); if(i>=0)a[i]=u; else a.push(u); onUpdate({ ...day, loggedExercises:a }); }
  function getPrev(name){ for(let i=prevDays.length-1;i>=0;i--){ const f=prevDays[i].loggedExercises?.find(e=>e.name===name&&e.sets?.some(s=>s.weight)); if(f)return f; } return null; }
  function updateCardio(u){ onUpdate({ ...day, cardio:cardio.map(c=>c.id===u.id?u:c) }); }
  function deleteCardio(id){ onUpdate({ ...day, cardio:cardio.filter(c=>c.id!==id) }); }
  function nowTime() { return new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit"}); }
  function addFood(item){ bumpFreq(item.label); onUpdate({ ...day, nutritionLog:[...(day.nutritionLog||[]), { id:Date.now()+Math.random(), label:item.label, protein:item.protein||0, carbs:item.carbs||0, fats:item.fats||0, time:nowTime() }] }); }
  function deleteFood(id){ onUpdate({ ...day, nutritionLog:(day.nutritionLog||[]).filter(n=>n.id!==id) }); }
  function addWater(oz){ onUpdate({ ...day, water:Math.max(0,(day.water||0)+oz) }); }

  function handleLocally(msg) {
    const lower = msg.toLowerCase();
    let upd = { ...day };
    const acts = [];

    const foods = parseFood(msg);
    if (foods.length) {
      let tp=0, tc=0, tf=0; const newLog = [];
      for (const f of foods) { tp+=f.protein; tc+=f.carbs; tf+=f.fats; bumpFreq(f.name); newLog.push({ id:Date.now()+Math.random(), label:f.name, protein:f.protein, carbs:f.carbs, fats:f.fats, time:nowTime() }); }
      upd = { ...upd, nutritionLog:[...(upd.nutritionLog||[]), ...newLog] };
      const newP = macroTotals(upd).p;
      acts.push(`Logged ${foods.map(f=>f.name).join(", ")} — ${tp}g protein, ${tc}g carbs, ${tf}g fat. You're at ${newP}/${settings.proteinTarget}g protein, ${Math.max(0,settings.proteinTarget-newP)}g to go.`);
    }

    const water = parseWater(msg);
    if (water) { upd = { ...upd, water:Math.max(0,(upd.water||0)+water) }; acts.push(`Logged ${water} oz water. You're at ${(upd.water||0)}/${settings.waterTarget} oz today.`); }

    const cardioParsed = parseCardio(msg);
    if (cardioParsed) {
      const tdec = cardioParsed.time ? (Math.round(parseFloat(cardioParsed.time)*100)/100) : "";
      const hasData = !!cardioParsed.dist;
      upd = { ...upd, cardio:[...(upd.cardio||[]), { id:Date.now()+Math.random(), activity:cardioParsed.activity, targetDist:"", targetTime:"", unit:cardioParsed.unit, dist:cardioParsed.dist, time:tdec, location:"", done:hasData, fromPlan:false }] };
      acts.push(`Added your ${cardioParsed.activity.toLowerCase()}${cardioParsed.dist?` — ${cardioParsed.dist}${cardioParsed.unit}`:""}${cardioParsed.time?` in ${cardioParsed.time} min`:""}. ${hasData?"Logged toward your weekly mileage.":"Open it in the Train tab to add distance & time."}`);
    }

    if (upd.plan?.exercises?.length) {
      if (/(lighter|easier|too tired|dial.*back|go easy|back off)/.test(lower)) {
        upd = { ...upd, plan:{...upd.plan, exercises:upd.plan.exercises.map(e=>({...e,sets:String(Math.max(2,parseInt(e.sets)-1)),rir:bumpRir(e.rir)})), workoutType:"REDUCED", adjustmentNote:"Dialed back per your request — lighter, further from failure."} };
        acts.push("Made today lighter — dropped a set per lift and backed off intensity.");
      } else if (/(cut|short on time|shorten|less time|quick|trim|in a hurry)/.test(lower)) {
        upd = { ...upd, plan:{...upd.plan, exercises:upd.plan.exercises.slice(0,Math.max(3,Math.floor(upd.plan.exercises.length/2))), adjustmentNote:"Trimmed to your top lifts for time."} };
        acts.push("Trimmed today to your highest-value lifts so it fits a shorter window.");
      }
    }

    if (!acts.length && /(what.*(eat|meal|cook|order)|meal idea|i'?m hungry|suggest.*food|protein idea|hit.*protein)/.test(lower)) {
      const remNow = Math.max(0, settings.proteinTarget - macroTotals(day).p);
      const m = suggestMeal(remNow, day.checkin?.pantry);
      return `You've got ${remNow}g protein left today. ${m.meal} (${m.macros}).`;
    }

    if (acts.length) { onUpdate(upd); return "✓ " + acts.join("\n\n✓ "); }
    return null;
  }

  async function sendChat(msg) {
    if(!msg.trim()) return; setChatBusy(true);
    const h=[...chat,{role:"user",text:msg}]; setChat(h); setChatIn("");
    const localReply = handleLocally(msg);
    if (localReply) { setChat([...h,{role:"coach",text:localReply}]); setChatBusy(false); return; }
    try {
      const sys=`You are this athlete's hybrid-training coach (gym + running + cycling). Athlete: 5'9", 170lb, advanced lifter, on a busy medical rotation, protein target ${settings.proteinTarget}g/day, chronically under-slept (needs ~${settings.sleepNeed}h, averages 6.4h). Today's plan: ${JSON.stringify(plan)}. Recovery ${checkin?.recovery}%. Logged so far: lifts ${JSON.stringify(loggedExercises)}, cardio ${JSON.stringify(cardio)}. Answer their question with concise, practical, evidence-based coaching. Plain text, 2-4 sentences max. No JSON, no markdown headers.`;
      const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,max_tokens:600,system:sys,messages:[{role:"user",content:h.map(m=>`${m.role}: ${m.text}`).join("\n")}]})});
      if(!res.ok){ throw new Error(`server ${res.status}`); }
      const data=await res.json();
      const txt=(data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim();
      setChat([...h,{role:"coach",text: txt || "I didn't catch that — try rephrasing?"}]);
    } catch (e) {
      setChat([...h,{role:"coach",text:`Couldn't reach the advice server (${e.message}). But logging still works — tell me what you ate ("2 eggs and a shake") or did ("ran 5 miles") and I'll track it instantly.`}]);
    }
    setChatBusy(false);
  }

  const sortedPresets = [...presets].sort((a,b)=>(bumpFreq.freq?.[b.label]||0)-(bumpFreq.freq?.[a.label]||0));
  const mt = macroTotals(day);
  const water = day.water || 0;
  const calT = calTarget(settings);

  return (
    <>
      <div style={{ padding:"16px 20px 0", borderBottom:"1px solid #2a2a2a" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"14px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"6px", fontSize:"13px", color:streak>0?"#fb923c":"#666", fontWeight:"700" }}>🔥 {streak} day{streak===1?"":"s"}</div>
          <div style={{ background:rc, color:"#0a0a0a", padding:"6px 12px", borderRadius:"3px", fontSize:"11px", letterSpacing:"2px", fontWeight:"700", boxShadow:`0 0 14px ${rc}40` }}>{plan.recoveryStatus} · {rec??"?"}%</div>
        </div>

        <div style={{ display:"flex", gap:"8px", marginBottom:"16px" }}>
          {[["🏃", totals.runMi, "RUN MI"],["🚴", totals.rideMi, "RIDE MI"],["🏋️", totals.sets, "SETS"]].map(([ic,val,lab])=>(
            <div key={lab} style={{ flex:1, background:"#141414", border:"1px solid #2a2a2a", borderRadius:"4px", padding:"10px", textAlign:"center" }}>
              <div style={{ fontSize:"15px" }}>{ic}</div>
              <div style={{ fontSize:"18px", fontWeight:"700", color:"#fafafa", marginTop:"2px" }}>{val}</div>
              <div style={{ fontSize:"8px", letterSpacing:"1px", color:"#888", marginTop:"1px" }}>{lab} / WK</div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom:"14px" }}>
          <Label>TODAY · {fmtDate(day.date).toUpperCase()}</Label>
          <div style={{ fontSize:"23px", fontWeight:"700", lineHeight:1.15, color:"#fafafa" }}>{plan.workoutTitle}</div>
          <div style={{ fontSize:"12px", color:"#9a9a9a", marginTop:"3px" }}>{plan.workoutSub}</div>
        </div>

        <Card accent={wc} style={{ marginBottom:"12px" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" }}><Label color={wc}>{plan.workoutType}</Label><div style={{ fontSize:"10px", letterSpacing:"1px", color:wc, border:`1px solid ${wc}44`, padding:"4px 10px", borderRadius:"2px", fontWeight:"600" }}>{checkin?.timeAvailable||"?"} MIN</div></div>
          <div style={{ fontSize:"13px", color:"#e0e0e0", lineHeight:1.6 }}>{plan.workoutRationale}</div>
          {plan.adjustmentNote && <div style={{ marginTop:"10px", padding:"10px 12px", background:"#0a1a2a", border:"1px solid #2a4a6a", borderRadius:"3px", fontSize:"12px", color:"#9cd8f0" }}>⚡ {plan.adjustmentNote}</div>}
        </Card>

        <div style={{ background:"#0f1a00", border:"1px solid #3a5a1a", borderRadius:"3px", padding:"12px 14px", marginBottom:"16px" }}><Label color="#a3e635">TOP PRIORITY</Label><div style={{ fontSize:"14px", color:"#e8f4d0", lineHeight:1.5 }}>{plan.topPriority}</div></div>

        <div style={{ display:"flex" }}>
          {[["workout","TRAIN"],["nutrition","FUEL"],["progress","PROGRESS"]].map(([k,l])=>(<button key={k} onClick={()=>setTab(k)} style={{ flex:1, padding:"13px 0", background:"none", border:"none", borderBottom:tab===k?"2px solid #E8FF47":"2px solid transparent", color:tab===k?"#E8FF47":"#c4c4c4", fontSize:"11px", letterSpacing:"2px", cursor:"pointer", fontFamily:"inherit", fontWeight:tab===k?"700":"500", transition:"color .2s" }}>{l}</button>))}
        </div>
      </div>

      <div style={{ padding:"20px", paddingBottom:"100px" }}>
        {tab==="workout" && (
          <div>
            {cardio.length>0 && (
              <div style={{ marginBottom:"12px" }}>
                <Label color="#47C4FF">CARDIO</Label>
                <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
                  {cardio.map(c=>(<CardioLog key={c.id} entry={c} onUpdate={updateCardio} onDelete={()=>deleteCardio(c.id)} />))}
                </div>
              </div>
            )}

            {plan.warmup && <Card accent="#47C4FF" style={{ marginBottom:"12px" }}><Label color="#47C4FF">WARMUP</Label><div style={{ fontSize:"13px", color:"#e0e0e0" }}>{plan.warmup}</div></Card>}

            {plan.exercises?.length>0 ? (
              <div style={{ display:"flex", flexDirection:"column", gap:"8px" }}>
                <Label color="#E8FF47">LIFTS</Label>
                {plan.exercises.map((ex,i)=><ExerciseLog key={i} exercise={ex} logged={loggedExercises.find(l=>l.name===ex.name)} prevLog={getPrev(ex.name)} onUpdate={updateExercise} barWeight={settings.barWeight} />)}
              </div>
            ) : (cardio.length===0) && (
              <Card style={{ textAlign:"center", padding:"30px 16px" }}><div style={{ fontSize:"30px", marginBottom:"10px" }}>🔋</div><div style={{ fontSize:"13px", color:"#c4c4c4", lineHeight:1.6 }}>Rest day. Walk, stretch, eat, sleep. This is where you grow.</div></Card>
            )}

            {volume && Object.keys(volume).length>0 && (
              <Card accent="#a3e635" style={{ marginTop:"12px" }}><Label color="#a3e635">THIS WEEK'S VOLUME (sets)</Label><div style={{ display:"flex", flexWrap:"wrap", gap:"6px" }}>{Object.entries(volume).sort((a,b)=>b[1]-a[1]).map(([m,s])=>(<div key={m} style={{ fontSize:"11px", color:"#d4d4d4", border:"1px solid #2a2a2a", padding:"4px 9px", borderRadius:"2px" }}><span style={{ color:"#a3e635", fontWeight:"700" }}>{s}</span> {m}</div>))}</div></Card>
            )}

            <Card accent="#666" style={{ marginTop:"12px" }}><Label color="#47C4FF">SLEEP TARGET TONIGHT</Label><div style={{ fontSize:"17px", fontWeight:"700", color:"#47C4FF" }}>{sleepTargetFor(checkin, settings)}</div><div style={{ fontSize:"12px", color:"#c4c4c4", marginTop:"3px" }}>Debt: {fmtHM(checkin?.sleepDebt)} · you need ~{settings.sleepNeed}h · {settings.wakeTime} wake</div></Card>
          </div>
        )}

        {tab==="nutrition" && (
          <div style={{ display:"flex", flexDirection:"column", gap:"12px" }}>
            <Card accent="#47C4FF">
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:"8px" }}>
                <Label color="#47C4FF">💧 HYDRATION</Label>
                <div style={{ fontSize:"13px", color:"#c4c4c4" }}><span style={{ color:water>=settings.waterTarget?"#4ade80":"#fafafa", fontWeight:"700", fontSize:"16px" }}>{water}</span> / {settings.waterTarget} oz</div>
              </div>
              <div style={{ background:"#0a0a0a", borderRadius:"3px", height:"10px", overflow:"hidden", marginBottom:"10px" }}><div style={{ height:"100%", background:"linear-gradient(90deg,#2a6a9a,#47C4FF)", width:`${Math.min(100,(water/settings.waterTarget)*100)}%`, transition:"width 0.5s cubic-bezier(.2,.8,.2,1)" }} /></div>
              <div style={{ display:"flex", gap:"8px" }}>
                {[["+ Glass",8],["+ Bottle",16],["+ Big",32]].map(([l,oz])=>(<button key={l} onClick={()=>addWater(oz)} style={{ flex:1, padding:"11px", background:"#0d1622", border:"1px solid #2a4a6a", borderRadius:"4px", color:"#9cd8f0", fontSize:"12px", cursor:"pointer", fontFamily:"inherit", fontWeight:"600" }}>{l}</button>))}
                <button onClick={()=>addWater(-8)} style={{ padding:"11px 13px", background:"transparent", border:"1px solid #3a3a3a", borderRadius:"4px", color:"#888", fontSize:"13px", cursor:"pointer", fontFamily:"inherit" }}>−</button>
              </div>
            </Card>

            <Card accent="#4ade80">
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:"12px" }}>
                <Label color="#4ade80">MACROS</Label>
                <div style={{ fontSize:"12px", color:"#c4c4c4" }}><span style={{ color:"#fafafa", fontWeight:"700", fontSize:"18px" }}>{mt.cal.toLocaleString()}</span> / {calT.toLocaleString()} kcal</div>
              </div>
              <MacroBar label="PROTEIN" current={mt.p} target={settings.proteinTarget} color="#4ade80" />
              <MacroBar label="CARBS" current={mt.c} target={settings.carbTarget} color="#E8FF47" />
              <MacroBar label="FAT" current={mt.f} target={settings.fatTarget} color="#fb923c" />
              <div style={{ fontSize:"11px", color:"#9a9a9a", marginTop:"4px", lineHeight:1.5 }}>Protein {Math.max(0,settings.proteinTarget-mt.p)}g to go · fuels recovery. Carbs power your runs & rides.</div>
            </Card>

            <Card accent="#a3e635">
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"6px" }}><Label color="#a3e635">QUICK ADD</Label><button onClick={()=>setEditPresets(true)} style={{ background:"none", border:"none", color:"#a3e635", fontSize:"11px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit" }}>✎ EDIT</button></div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"8px" }}>
                {sortedPresets.map(p=>(<button key={p.label} onClick={()=>addFood(p)} style={{ padding:"12px 10px", background:"#0d1a0d", border:"1px solid #2a4a1a", borderRadius:"4px", color:"#d4f0c4", fontSize:"12px", cursor:"pointer", fontFamily:"inherit", textAlign:"left", lineHeight:1.3 }}><div style={{ fontWeight:"600", marginBottom:"2px" }}>{p.label}</div><div style={{ color:"#7cb87c", fontSize:"10px" }}>{p.protein}p · {p.carbs||0}c · {p.fats||0}f</div></button>))}
              </div>
              <div style={{ fontSize:"11px", color:"#9a9a9a", marginTop:"10px", lineHeight:1.5 }}>Sorted by what you eat most. Tap ✎ to edit. Or tell the Coach "I had a Subway sandwich."</div>
            </Card>

            {day.nutritionLog?.length>0 && (
              <Card accent="#7cb87c"><Label color="#7cb87c">TODAY'S LOG</Label>{day.nutritionLog.map((n,i)=>(<div key={n.id||i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:"13px", padding:"8px 0", borderBottom:i<day.nutritionLog.length-1?"1px solid #2a2a2a":"none" }}><div style={{ flex:1 }}><div style={{ color:"#fafafa" }}>{n.label} <span style={{ color:"#888", fontSize:"11px", marginLeft:"4px" }}>{n.time}</span></div><div style={{ fontSize:"10px", color:"#7cb87c", marginTop:"2px" }}>{n.protein ?? n.grams ?? 0}p · {n.carbs||0}c · {n.fats||0}f</div></div><button onClick={()=>deleteFood(n.id)} style={{ background:"none", border:"none", color:"#f87171", fontSize:"16px", cursor:"pointer", padding:"0 4px" }}>×</button></div>))}</Card>
            )}

            <Card accent="#47C4FF"><Label color="#47C4FF">MEAL IDEA</Label>{(() => { const remNow=Math.max(0,settings.proteinTarget-mt.p); const live=suggestMeal(remNow, checkin?.pantry); return (<><div style={{ fontSize:"15px", color:"#fafafa", fontWeight:"600", marginBottom:"6px" }}>{live.meal}</div><div style={{ fontSize:"12px", color:"#c4c4c4" }}>{live.macros} · {remNow}g protein left today</div></>); })()}</Card>
          </div>
        )}

        {tab==="progress" && (() => {
          const bShow = buckets.slice(-range);
          const bwSeries = buckets.filter(b=>b.bw>0);
          const curBw = bwSeries.length ? bwSeries[bwSeries.length-1].bw : null;
          const firstBw = bwSeries.length ? bwSeries[0].bw : null;
          const bwDelta = (curBw!=null && firstBw!=null) ? Math.round((curBw-firstBw)*10)/10 : null;
          const bwMin = bwSeries.length ? Math.min(...bwSeries.map(b=>b.bw)) : 0;
          return (
          <div style={{ display:"flex", flexDirection:"column", gap:"12px" }}>
            <div style={{ display:"flex", gap:"6px", justifyContent:"flex-end" }}>
              {[6,12].map(n=>(<button key={n} onClick={()=>setRange(n)} style={{ padding:"6px 14px", borderRadius:"3px", fontSize:"10px", letterSpacing:"1px", cursor:"pointer", fontFamily:"inherit", border:range===n?"1px solid #E8FF47":"1px solid #3a3a3a", background:range===n?"#E8FF47":"#111", color:range===n?"#0a0a0a":"#bbb", fontWeight:range===n?"700":"500" }}>{n}W</button>))}
            </div>

            {buckets.length>=2 && (() => {
              const cur=buckets[buckets.length-1], prev=buckets[buckets.length-2];
              const delta=(a,b)=> b===0? (a>0?"+"+a:"0") : (a-b>=0?"+":"")+(Math.round((a-b)*10)/10);
              const stat=(label,c,p,unit)=>(
                <div style={{ flex:1, background:"#141414", border:"1px solid #2a2a2a", borderRadius:"4px", padding:"10px", textAlign:"center" }}>
                  <div style={{ fontSize:"8px", letterSpacing:"1px", color:"#888" }}>{label}</div>
                  <div style={{ fontSize:"17px", fontWeight:"700", color:"#fafafa", marginTop:"2px" }}>{c}{unit}</div>
                  <div style={{ fontSize:"9px", color:(c-p)>=0?"#4ade80":"#fb923c", marginTop:"1px" }}>{delta(c,p)} vs last</div>
                </div>
              );
              return (<div><Label>THIS WEEK VS LAST</Label><div style={{ display:"flex", gap:"8px" }}>{stat("RUN",cur.runMi,prev.runMi,"mi")}{stat("RIDE",cur.rideMi,prev.rideMi,"mi")}{stat("SETS",cur.sets,prev.sets,"")}{stat("REC",cur.rec,prev.rec,"%")}</div></div>);
            })()}

            {curBw!=null && (
              <Card accent="#E8FF47">
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:"4px" }}>
                  <Label color="#E8FF47">⚖️ BODY WEIGHT</Label>
                  <div style={{ fontSize:"13px", color:"#c4c4c4" }}><span style={{ color:"#fafafa", fontWeight:"700", fontSize:"18px" }}>{curBw}</span> lb{bwDelta!=null && <span style={{ color:Math.abs(bwDelta)<0.2?"#888":(bwDelta>0?"#fb923c":"#47C4FF"), marginLeft:"8px", fontSize:"11px" }}>{bwDelta>0?"+":""}{bwDelta} over {bwSeries.length}w</span>}</div>
                </div>
                <MiniBars data={bShow} color="#E8FF47" valueKey="bw" baseline={Math.max(0,bwMin-3)} decimals={1} />
                <div style={{ fontSize:"11px", color:"#9a9a9a", marginTop:"6px", lineHeight:1.5 }}>Recomp: weight can stay flat while composition shifts — read it next to your lifts & recovery.</div>
              </Card>
            )}

            <Card accent="#47C4FF"><Label color="#47C4FF">🏃 WEEKLY RUN MILES</Label><MiniBars data={bShow} color="#47C4FF" valueKey="runMi" decimals={1} /></Card>
            <Card accent="#7cc8e8"><Label color="#7cc8e8">🚴 WEEKLY RIDE MILES</Label><MiniBars data={bShow} color="#7cc8e8" valueKey="rideMi" decimals={1} /></Card>
            <Card accent="#E8FF47"><Label color="#E8FF47">🏋️ WEEKLY LIFT SETS</Label><MiniBars data={bShow} color="#E8FF47" valueKey="sets" /></Card>
            <Card accent="#a3e635"><Label color="#a3e635">💪 RECOVERY TREND (avg %)</Label><MiniBars data={bShow} color="#a3e635" valueKey="rec" baseline={30} /></Card>

            {Object.keys(prs).length>0 && (
              <Card accent="#fb923c">
                <Label color="#fb923c">🏆 BEST SETS (by est. 1RM)</Label>
                <div style={{ display:"flex", flexDirection:"column", gap:"7px" }}>
                  {Object.entries(prs).sort((a,b)=>b[1].est-a[1].est).slice(0,8).map(([name,pr])=>(
                    <div key={name} style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", fontSize:"13px" }}>
                      <span style={{ color:"#e0e0e0" }}>{name}</span>
                      <span style={{ color:"#fb923c", fontWeight:"700" }}>{pr.weight} lb × {pr.reps} <span style={{ color:"#9a6a3a", fontSize:"10px", fontWeight:"500" }}>· e1RM {Math.round(pr.est)}</span></span>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {Object.keys(prs).length===0 && buckets.every(b=>!b.sets&&!b.runMi&&!b.rideMi) && (
              <Card style={{ textAlign:"center", padding:"30px 16px" }}><div style={{ fontSize:"28px", marginBottom:"10px" }}>📈</div><div style={{ fontSize:"13px", color:"#c4c4c4", lineHeight:1.6 }}>Log a few sessions and your trends fill in here — weekly mileage, lift PRs, body weight, and recovery over time.</div></Card>
            )}
          </div>
          );
        })()}
      </div>

      <div style={{ position:"fixed", bottom:0, left:0, right:0, maxWidth:"480px", margin:"0 auto", padding:"12px 16px", background:"linear-gradient(transparent, #0a0a0a 30%)", zIndex:50 }}>
        <button onClick={()=>setShowCoach(true)} style={{ width:"100%", padding:"14px 16px", background:"#161616", border:"1px solid #3a3a3a", borderRadius:"30px", color:"#9a9a9a", fontSize:"13px", textAlign:"left", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:"8px", boxShadow:"0 4px 18px rgba(0,0,0,0.6)" }}>
          <span style={{ fontSize:"15px" }}>💬</span> Ask coach or log anything…
        </button>
      </div>

      {showCoach && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
          <div style={{ maxWidth:"480px", width:"100%", background:"#0a0a0a", borderTop:"1px solid #333", borderRadius:"12px 12px 0 0", padding:"18px 18px 22px", maxHeight:"82vh", display:"flex", flexDirection:"column", animation:"sheet .25s ease both" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"12px" }}>
              <div style={{ fontSize:"15px", fontWeight:"700", color:"#E8FF47" }}>Coach</div>
              <button onClick={()=>setShowCoach(false)} style={{ background:"none", border:"none", color:"#bbb", fontSize:"22px", cursor:"pointer" }}>×</button>
            </div>
            <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", marginBottom:"12px" }}>
              {(plan.exercises?.length>0 ? [["Make it lighter","make it lighter"],["Cut for time","cut for time"]] : []).concat([["+ Run","add a run"],["+ Ride","add a ride"],["+ Water","had a bottle of water"],["What to eat?","what should I eat"]]).map(([l,msg])=>(
                <button key={l} onClick={()=>sendChat(msg)} style={{ padding:"8px 13px", background:"#161616", border:"1px solid #2a2a2a", borderRadius:"20px", color:"#d4d4d4", fontSize:"11px", cursor:"pointer", fontFamily:"inherit" }}>{l}</button>
              ))}
            </div>
            <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:"10px", marginBottom:"12px", minHeight:"80px", maxHeight:"45vh" }}>
              {chat.length===0 && <div style={{ fontSize:"12px", color:"#888", lineHeight:1.6 }}>Log food/water ("had a Subway sandwich and a bottle of water"), add training ("ran 5 miles"), tweak your plan, or ask anything ("how do I fix squat depth?").</div>}
              {chat.map((m,i)=>(<div key={i} style={{ padding:"12px 14px", borderRadius:"4px", background:m.role==="user"?"#0f1500":"#161616", border:"1px solid "+(m.role==="user"?"#2a4a1a":"#2a2a2a"), fontSize:"13px", color:m.role==="user"?"#d4f0a8":"#e8e8e8", lineHeight:1.6, whiteSpace:"pre-wrap" }}><div style={{ fontSize:"10px", letterSpacing:"2px", color:"#9a9a9a", marginBottom:"6px", fontWeight:"700" }}>{m.role==="user"?"YOU":"COACH"}</div>{m.text}</div>))}
              {chatBusy && <Card><Spinner msg="Coach thinking…" /></Card>}
            </div>
            <div style={{ display:"flex", gap:"8px" }}><input autoFocus value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat(chatIn)} placeholder="Ask or log…" style={{ ...inp }} /><Btn primary small onClick={()=>sendChat(chatIn)}>SEND</Btn></div>
          </div>
        </div>
      )}
      {editPresets && <PresetEditor presets={presets} onSave={onSavePresets} onClose={()=>setEditPresets(false)} />}
    </>
  );
}

// ── CALENDAR ─────────────────────────────────────────────────────────────────
function Calendar({ index, selected, onPick, onClose }) {
  const [month, setMonth] = useState(()=>{ const [y,m]=selected.split("-"); return new Date(+y,+m-1,1); });
  const daysIn=new Date(month.getFullYear(),month.getMonth()+1,0).getDate(); const first=month.getDay(); const today=todayStr();
  const cells=[]; for(let i=0;i<first;i++)cells.push(null);
  for(let d=1;d<=daysIn;d++){ const ds=`${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; cells.push({ d, ds, has:index.includes(ds), today:ds===today, sel:ds===selected }); }
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:"20px" }}>
      <div style={{ maxWidth:"400px", width:"100%", background:"#0a0a0a", border:"1px solid #333", borderRadius:"8px", padding:"20px", animation:"rise .25s ease both" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"16px" }}><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()-1,1))} style={{ background:"none", border:"none", color:"#ccc", fontSize:"22px", cursor:"pointer" }}>‹</button><div style={{ fontSize:"14px", fontWeight:"700", color:"#fff", letterSpacing:"2px" }}>{month.toLocaleDateString("en-US",{month:"long",year:"numeric"}).toUpperCase()}</div><button onClick={()=>setMonth(new Date(month.getFullYear(),month.getMonth()+1,1))} style={{ background:"none", border:"none", color:"#ccc", fontSize:"22px", cursor:"pointer" }}>›</button></div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:"4px", marginBottom:"8px" }}>{["S","M","T","W","T","F","S"].map((d,i)=><div key={i} style={{ textAlign:"center", fontSize:"9px", letterSpacing:"1px", color:"#888", padding:"4px 0" }}>{d}</div>)}</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:"4px" }}>{cells.map((c,i)=>(<button key={i} disabled={!c} onClick={()=>c&&onPick(c.ds)} style={{ aspectRatio:"1", border:c?.sel?"1.5px solid #E8FF47":"1px solid "+(c?.today?"#666":"#1f1f1f"), background:c?.sel?"#E8FF47":c?.today?"#1a1a1a":"#0d0d0d", color:c?.sel?"#0a0a0a":c?"#ccc":"transparent", borderRadius:"3px", fontSize:"12px", cursor:c?"pointer":"default", fontFamily:"inherit", fontWeight:c?.today||c?.sel?"700":"400", position:"relative", padding:0 }}>{c?.d}{c?.has&&<div style={{ position:"absolute", bottom:"3px", left:"50%", transform:"translateX(-50%)", width:"4px", height:"4px", borderRadius:"50%", background:c.sel?"#0a0a0a":"#E8FF47" }} />}</button>))}</div>
        <div style={{ display:"flex", gap:"8px", marginTop:"16px" }}><Btn onClick={onClose} style={{ flex:1 }}>CLOSE</Btn><Btn primary onClick={()=>onPick(todayStr())} style={{ flex:1 }}>TODAY</Btn></div>
      </div>
    </div>
  );
}

// ── global animations + interaction polish (keyframes are required by Spinner/Card/sheets) ──
const GLOBAL_CSS = `
@keyframes rise { from { opacity:0; transform: translateY(8px); } to { opacity:1; transform: none; } }
@keyframes sheet { from { transform: translateY(100%); } to { transform: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
* { -webkit-tap-highlight-color: transparent; }
button { transition: transform .06s ease, filter .15s ease; }
button:active { transform: translateY(1px) scale(0.99); }
input, textarea, select { font-size: 16px; }
input:focus, textarea:focus { outline: none; border-color: #E8FF47 !important; box-shadow: 0 0 0 3px rgba(232,255,71,0.12); }
::placeholder { color: #5a5a5a; }
::-webkit-scrollbar { width: 0; height: 0; }
`;

// ── ROOT ─────────────────────────────────────────────────────────────────────
const FONT = "'DM Mono', ui-monospace, 'SF Mono', 'Courier New', monospace";
export default function DailyCoach() {
  const [currentDate, setCurrentDate] = useState(todayStr());
  const [day, setDay] = useState(null);
  const [index, setIndex] = useState([]);
  const [allDays, setAllDays] = useState([]);
  const [presets, setPresets] = useState(DEFAULT_PRESETS);
  const [freq, setFreq] = useState({});
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [showCheckin, setShowCheckin] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [building, setBuilding] = useState(false);
  const quote = quoteOfDay();

  useEffect(()=>{ const id="dm-mono-font"; if(typeof document!=="undefined" && !document.getElementById(id)){ const l=document.createElement("link"); l.id=id; l.rel="stylesheet"; l.href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&display=swap"; document.head.appendChild(l); } }, []);

  useEffect(()=>{ (async()=>{ const p=await sGet("nutrition-presets"); if(p&&p.length) setPresets(p.map(x=>({ label:x.label, protein:x.protein ?? x.grams ?? 0, carbs:x.carbs||0, fats:x.fats||0 }))); const fq=await sGet("food-frequency"); if(fq) setFreq(fq); const st=await loadSettings(); setSettings(st); })(); }, []);
  useEffect(()=>{ (async()=>{ setLoaded(false); const d=await loadDay(currentDate); setDay(d); setLoaded(true); })(); }, [currentDate]);
  useEffect(()=>{ (async()=>{ const idx=await getIndex(); setIndex(idx); const all=await Promise.all(idx.map(d=>loadDay(d))); setAllDays(all.filter(Boolean).filter(d=>d.date<currentDate)); })(); }, [currentDate, day]);

  async function handleSave(checkin) {
    setShowCheckin(false);
    setBuilding(true);
    const existing = day || {};
    const curProtein = macroTotals(existing).p;
    const plan = buildPlan(checkin, allDays, curProtein, settings);
    let cardioArr = (existing.cardio || []).filter(c => !c.fromPlan);
    if (plan.cardioPlan) {
      cardioArr = [{ id:"plan-"+Date.now(), activity:plan.cardioPlan.activity, targetDist:plan.cardioPlan.targetDist, targetTime:plan.cardioPlan.targetTime, unit:plan.cardioPlan.unit, guide:plan.cardioPlan.guide, dist:"", time:"", location:"", done:false, fromPlan:true }, ...cardioArr];
    }
    const newDay = { date:currentDate, checkin, plan, loggedExercises:existing.loggedExercises||[], cardio:cardioArr, nutritionLog:existing.nutritionLog||[], water:existing.water||0 };
    await saveDay(currentDate, newDay);
    await new Promise(r=>setTimeout(r, 2900));
    setDay(newDay); setIndex(await getIndex()); setBuilding(false);
  }
  async function updateDay(nd){ setDay(nd); await saveDay(nd.date, nd); }
  async function savePresets(list){ setPresets(list); await sSet("nutrition-presets", list); }
  function bumpFreq(label){ setFreq(prev=>{ const nx={...prev,[label]:(prev[label]||0)+1}; sSet("food-frequency", nx); return nx; }); }
  bumpFreq.freq = freq;

  const isToday = currentDate===todayStr();
  const streak = calcStreak(allDays, day);
  const totals = weeklyTotals(allDays, day);
  const volume = weeklyVolume(allDays, day);
  const buckets = weeklyBuckets(allDays, day, 12);
  const prs = liftPRs(allDays, day);

  if (building) {
    return (
      <div style={{ background:"#0a0a0a", minHeight:"100vh", fontFamily:FONT, color:"#fff", maxWidth:"480px", margin:"0 auto", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 32px", textAlign:"center" }}>
        <style>{GLOBAL_CSS}</style>
        <div style={{ fontSize:"9px", letterSpacing:"4px", color:"#666", marginBottom:"32px" }}>BUILDING YOUR DAY</div>
        <div style={{ fontSize:"22px", fontWeight:"700", color:"#fafafa", lineHeight:1.4, marginBottom:"16px" }}>"{quote.q}"</div>
        <div style={{ fontSize:"13px", color:"#E8FF47", letterSpacing:"1px", marginBottom:"40px" }}>— {quote.a}</div>
        <Spinner msg="Adapting to your recovery…" />
      </div>
    );
  }

  return (
    <div style={{ background:"#0a0a0a", minHeight:"100vh", fontFamily:FONT, color:"#fff", maxWidth:"480px", margin:"0 auto", position:"relative" }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ padding:"16px 20px 12px", borderBottom:"1px solid #2a2a2a", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <button onClick={()=>setShowCalendar(true)} style={{ background:"none", border:"none", cursor:"pointer", padding:0, textAlign:"left" }}><Label>HYBRID COACH</Label><div style={{ fontSize:"16px", fontWeight:"700", color:"#E8FF47", display:"flex", alignItems:"center", gap:"8px" }}>{isToday?"TODAY":fmtDate(currentDate).toUpperCase()} <span style={{ fontSize:"12px", color:"#c4c4c4" }}>▾</span></div></button>
        <div style={{ display:"flex", gap:"8px", alignItems:"center" }}>
          {isToday && day?.plan && <Btn small onClick={()=>setConfirmReset(true)}>↺ REDO</Btn>}
          <button onClick={()=>setShowSettings(true)} title="Settings" style={{ background:"none", border:"1px solid #3a3a3a", borderRadius:"4px", color:"#bbb", width:"38px", height:"34px", cursor:"pointer", fontFamily:"inherit", fontSize:"15px" }}>⚙</button>
        </div>
      </div>
      <div style={{ padding:"8px 20px", borderBottom:"1px solid #1a1a1a", background:"#0d0d0d", display:"flex", alignItems:"center", gap:"8px" }}>
        <span style={{ fontSize:"12px", flexShrink:0 }}>💭</span>
        <div style={{ fontSize:"11px", color:"#b8b8b8", fontStyle:"italic", lineHeight:1.4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>"{quote.q}" <span style={{ color:"#888", fontStyle:"normal" }}>— {quote.a}</span></div>
      </div>

      {!loaded ? <div style={{ padding:"60px 24px", display:"flex", justifyContent:"center" }}><Spinner msg="Loading…" /></div>
      : <DayView day={day} isToday={isToday} onCheckin={()=>setShowCheckin(true)} onUpdate={updateDay} prevDays={allDays} streak={streak} totals={totals} volume={volume} presets={presets} onSavePresets={savePresets} bumpFreq={bumpFreq} buckets={buckets} prs={prs} settings={settings} />}

      {showCheckin && <CheckinFlow existingDay={day} onSave={handleSave} onClose={()=>setShowCheckin(false)} />}
      {showCalendar && <Calendar index={index} selected={currentDate} onPick={d=>{ setCurrentDate(d); setShowCalendar(false); }} onClose={()=>setShowCalendar(false)} />}
      {showSettings && <SettingsSheet settings={settings} onSave={async (s)=>{ setSettings(s); await saveSettings(s); }} onClose={()=>setShowSettings(false)} />}
      {confirmReset && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:"20px" }}>
          <div style={{ maxWidth:"360px", width:"100%", background:"#0a0a0a", border:"1px solid #333", borderRadius:"8px", padding:"20px", animation:"rise .25s ease both" }}>
            <div style={{ fontSize:"16px", fontWeight:"700", color:"#fff", marginBottom:"8px" }}>Redo today's check-in?</div>
            <div style={{ fontSize:"12px", color:"#bbb", marginBottom:"20px", lineHeight:1.6 }}>Rebuilds today's plan. Your logged sets, cardio, and nutrition stay. Past days untouched.</div>
            <div style={{ display:"flex", gap:"8px" }}><Btn onClick={()=>setConfirmReset(false)} style={{ flex:1 }}>CANCEL</Btn><Btn primary onClick={()=>{ setConfirmReset(false); setShowCheckin(true); }} style={{ flex:1 }}>REDO</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}
