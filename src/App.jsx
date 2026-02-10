import { useState, useRef, useEffect } from "react";

// ============ DEEPGRAM ============
async function transcribeDeepgram(audioBlob, apiKey, language) {
  const lang = language === "multi" ? "en" : language;
  const keywords = "HbA1c:2,eGFR:2,creatinine:2,TSH:2,LDL:2,HDL:2,triglycerides:2,metformin:2,insulin:2,dianorm:1,thyronorm:1,glimepiride:1,telmisartan:1,amlodipine:1,rosuvastatin:1,atorvastatin:1,dapagliflozin:1,empagliflozin:1,canagliflozin:1,sitagliptin:1,vildagliptin:1,proteinuria:1,nephropathy:1,retinopathy:1,neuropathy:1,CABG:1,dyslipidemia:1,hypothyroidism:1";
  const kw = keywords.split(",").map(k => `keywords=${encodeURIComponent(k)}`).join("&");
  const url = `https://api.deepgram.com/v1/listen?model=nova-2&language=${lang}&smart_format=true&punctuate=true&paragraphs=true&${kw}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Token ${apiKey}`, "Content-Type": audioBlob.type || "audio/webm" },
    body: audioBlob
  });
  if (!r.ok) throw new Error(`Transcription error ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}`);
  const d = await r.json();
  return d.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
}

// ============ WHISPER ============
async function transcribeWhisper(audioBlob, apiKey, language) {
  const lang = language === "hi" ? "hi" : "en";
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.webm");
  formData.append("model", "whisper-1");
  formData.append("language", lang);
  formData.append("prompt", "Medical consultation in India. Terms: HbA1c, eGFR, creatinine, TSH, LDL, HDL, metformin, insulin, telmisartan, amlodipine, rosuvastatin, dapagliflozin, empagliflozin, thyronorm, dianorm, glimepiride, canagliflozin, proteinuria, nephropathy, retinopathy, CABG, dyslipidemia, hypothyroidism. Patient names in Hindi may be spoken.");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData
  });
  if (!r.ok) throw new Error(`Whisper error ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}`);
  const d = await r.json();
  return d.text || "";
}

// ============ PROMPTS ============
const MO_PROMPT = `You are a clinical documentation assistant for Gini Advanced Care Hospital, Mohali.
Structure the MO's verbal summary into JSON. Output ONLY valid JSON. No backticks.

{"diagnoses":[{"id":"hypo","label":"Hypothyroidism (Since 2000)","status":"Controlled"}],"complications":[{"name":"Nephropathy","status":"+","detail":"eGFR 29, CKD Stage 4","severity":"high"}],"history":{"family":"Father CAD post-CABG, Mother DM","past_medical_surgical":"NIL","personal":"Non-smoker, no alcohol","covid":"No exposure","vaccination":"Completed"},"previous_medications":[{"name":"THYRONORM 88","composition":"Levothyroxine 88mcg","dose":"88mcg","frequency":"OD","timing":"Empty stomach morning"}],"investigations":[{"test":"TSH","value":7.2,"unit":"mIU/L","flag":"HIGH","critical":false,"ref":"0.4-4.0"},{"test":"HbA1c","value":6.0,"unit":"%","flag":null,"critical":false,"ref":"<6.5"}],"missing_investigations":["HDL","Total Cholesterol"]}

RULES:
- IDs: dm2,htn,cad,ckd,hypo,obesity,dyslipidemia
- Status MUST be exactly one of: "Controlled", "Uncontrolled", "New". NO other values like "Active", "Present", "Suboptimal". If newly diagnosed use "New". If on treatment but not at target use "Uncontrolled". If stable/at target use "Controlled".
- If BMI>=25 or weight concern mentioned, ALWAYS add obesity diagnosis with id:"obesity"
- flag: "HIGH"/"LOW"/null. critical:true ONLY if dangerous (HbA1c>10, eGFR<30, Cr>2)
- Include ALL investigations mentioned with values, units, flags
- Include vital signs as investigations if mentioned (BP, Pulse, Weight, BMI)
- Indian brand names: identify composition
- Keep label SHORT (max 8 words)
- complications severity: "high" if active/dangerous, "low" if stable`;

const CONSULTANT_PROMPT = `Extract clinical decisions from consultant's verbal notes. Output ONLY valid JSON. No backticks.
Hindi: "uss ke baad"=after that, "phor hum"=then we, "karenge"=will do, "dena hai"=give, "band karo"=stop, "badhao"=increase, "pe focus karenge"=will focus on

{"assessment_summary":"Patient-friendly 1-2 line summary of what's happening and what we're doing","key_issues":["Poor glycemic control - HbA1c 7.5","Blood pressure control needed","Weight management"],"diet_lifestyle":[{"advice":"Calorie-restricted diet","detail":"Focus on complex carbs, avoid sugar","category":"Diet","helps":["dm2","obesity"]},{"advice":"Walking 10,000 steps daily","detail":"Start gradual, increase weekly","category":"Exercise","helps":["dm2","htn"]}],"medications_confirmed":[{"name":"TAB METFORMIN 500","composition":"Metformin 500mg","dose":"500mg","frequency":"OD to BD (titrate)","timing":"After meals","route":"Oral","forDiagnosis":["dm2"],"isNew":true}],"medications_needs_clarification":[{"what_consultant_said":"SGLT2 inhibitor","drug_class":"SGLT2 inhibitor","missing":["brand_name"],"suggested_options":["Dapagliflozin 10mg","Empagliflozin 25mg"],"forDiagnosis":["dm2"],"default_timing":"Before breakfast","default_dose":"10mg"}],"monitoring":["SMBG daily fasting"],"investigations_to_order":["TFT","UACR"],"follow_up":{"duration":"6 weeks","tests_to_bring":["HbA1c","RFT","Lipid profile"]},"future_plan":[{"condition":"If weight not reducing in 6 weeks","action":"Consider GLP-1 RA"}],"goals":[{"marker":"HbA1c","current":"7.5%","target":"<6.5%","timeline":"3 months","priority":"critical"},{"marker":"BP","current":"149/85","target":"<130/80","timeline":"4 weeks","priority":"high"},{"marker":"Weight","current":"85kg","target":"80kg","timeline":"6 weeks","priority":"high"}],"self_monitoring":[{"title":"Blood Sugar Monitoring","instructions":["Check fasting sugar daily morning","Check post-meal sugar 2hrs after lunch twice a week","Maintain diary with date, time, value"],"targets":"Fasting 90-130 mg/dL, Post-meal <180 mg/dL","alert":"If sugar <70: eat 3 glucose tablets IMMEDIATELY, recheck in 15 min"}]}

CRITICAL MEDICATION RULES:
1. For EVERY medication, ALWAYS fill timing:
   - SGLT2i (dapagliflozin/empagliflozin): "Before breakfast"
   - Metformin: "After meals" 
   - Sulfonylureas (glimepiride/gliclazide): "Before breakfast"
   - Statins (atorvastatin/rosuvastatin): "At bedtime"
   - Thyroid (levothyroxine): "Empty stomach, 30min before breakfast"
   - ACE/ARB (telmisartan/losartan): "Morning" or "Morning + Evening"
   - Insulin: "Before meals" or "At bedtime" (specify which)
   - Aspirin: "After lunch"
2. If timing not mentioned explicitly, INFER from drug class. NEVER leave timing empty.
3. If dose range given ("500mg to 1g"), put full range in dose field
4. For needs_clarification items, ALWAYS include default_timing and default_dose based on drug class
5. Extract ALL medications including those to continue from previous
6. If INSULIN is prescribed, ALWAYS add an "insulin_education" section:
   {"insulin_education":{"type":"Basal/Premix/Bolus","device":"Pen/Syringe","injection_sites":["Abdomen","Thigh"],"storage":"Keep in fridge, room temp vial valid 28 days","titration":"Increase by 2 units every 3 days if fasting >130","hypo_management":"If sugar <70: 3 glucose tablets, recheck 15 min","needle_disposal":"Use sharps container, never reuse needles"}}
   Fill titration based on consultant's instructions. If not specified, use standard protocols.`;

const LAB_PROMPT = `Extract ALL test results. Return ONLY valid JSON, no backticks.
{"patient_on_report":{"name":"","age":"","sex":""},"panels":[{"panel_name":"Panel","tests":[{"test_name":"","result":0.0,"result_text":null,"unit":"","flag":null}]}]}
flag: "H" high, "L" low, null normal.`;

const PATIENT_VOICE_PROMPT = `Extract patient info. ONLY valid JSON, no backticks.
{"name":"string or null","age":"number or null","sex":"Male/Female or null","phone":"string or null","fileNo":"string or null","dob":"YYYY-MM-DD or null"}
IMPORTANT: Always return name in ENGLISH/ROMAN script, never Hindi/Devanagari. Transliterate if needed: "हिम्मत सिंह"→"Himmat Singh", "कमला देवी"→"Kamla Devi".
Parse dates: "1949 august 1"="1949-08-01". "file p_100"→fileNo:"P_100". Calculate age from DOB.`;

const VITALS_VOICE_PROMPT = `Extract vitals. ONLY valid JSON, no backticks.
{"bp_sys":"number or null","bp_dia":"number or null","pulse":"number or null","temp":"number or null","spo2":"number or null","weight":"number or null","height":"number or null"}
"BP 140 over 90"->bp_sys:140,bp_dia:90`;

// ============ API ============
async function callClaude(prompt, content) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 6000, messages: [{ role: "user", content: `${prompt}\n\nINPUT:\n${content}` }] })
    });
    if (!r.ok) return { data: null, error: `API ${r.status}: ${(await r.text().catch(()=>"")).slice(0,120)}` };
    const d = await r.json();
    if (d.error) return { data: null, error: d.error.message };
    const t = (d.content || []).map(c => c.text || "").join("");
    if (!t) return { data: null, error: "Empty response" };
    let clean = t.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    // Try direct parse
    try { return { data: JSON.parse(clean), error: null }; }
    catch {
      // Fix common issues
      clean = clean.replace(/,\s*([}\]])/g, "$1").replace(/\n/g, " ");
      // Balance brackets
      const balance = (s) => {
        const ob=(s.match(/{/g)||[]).length, cb=(s.match(/}/g)||[]).length;
        const oB=(s.match(/\[/g)||[]).length, cB=(s.match(/\]/g)||[]).length;
        for(let i=0;i<oB-cB;i++) s+="]";
        for(let i=0;i<ob-cb;i++) s+="}";
        return s;
      };
      try { return { data: JSON.parse(balance(clean)), error: null }; }
      catch {
        // Last resort: truncate backwards to find valid JSON
        for (let end = clean.length; end > 50; end -= 10) {
          try {
            const attempt = balance(clean.slice(0, end).replace(/,\s*$/,""));
            return { data: JSON.parse(attempt), error: null };
          } catch {}
        }
        return { data: null, error: `Parse failed. Try shorter input.` };
      }
    }
  } catch (e) { return { data: null, error: e.message }; }
}

async function extractLab(base64, mediaType) {
  try {
    const block = mediaType==="application/pdf"
      ? { type:"document", source:{type:"base64",media_type:"application/pdf",data:base64} }
      : { type:"image", source:{type:"base64",media_type:mediaType,data:base64} };
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
      body: JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:8000,messages:[{role:"user",content:[block,{type:"text",text:LAB_PROMPT}]}]})
    });
    if (!r.ok) return { data:null, error:`API ${r.status}` };
    const d = await r.json();
    if (d.error) return { data:null, error:d.error.message };
    const t = (d.content||[]).map(c=>c.text||"").join("");
    let clean = t.replace(/```json\s*/g,"").replace(/```\s*/g,"").trim();
    try { return { data:JSON.parse(clean), error:null }; }
    catch {
      clean = clean.replace(/,\s*([}\]])/g,"$1");
      const ob=(clean.match(/{/g)||[]).length, cb=(clean.match(/}/g)||[]).length;
      for(let i=0;i<ob-cb;i++) clean+="}";
      try { return { data:JSON.parse(clean), error:null }; }
      catch { return { data:null, error:"Parse failed" }; }
    }
  } catch(e) { return { data:null, error:e.message }; }
}

// ============ AUDIO INPUT ============
const CLEANUP_PROMPT = `Fix medical transcription errors in this text. Return ONLY the corrected text, nothing else.
Common fixes needed:
- Drug names: "thyro norm"→"Thyronorm", "die a norm"→"Dianorm", "gluco"→"Gluco", "telma"→"Telma", "rosuvastatin"/"rosu"→"Rosuvastatin"
- Lab tests: "H B A one C"/"hba1c"→"HbA1c", "e GFR"→"eGFR", "T S H"→"TSH", "LDL"/"HDL" keep as-is
- Medical: "die a betis"→"diabetes", "hyper tension"→"hypertension", "thyroid ism"→"thyroidism"
- Numbers: Keep all numbers exactly as spoken
- Hindi words: Keep as-is (don't translate)
- Names: Convert Hindi script to English/Roman: "हिम्मत सिंह"→"Himmat Singh"
Do NOT add, remove, or rearrange content. Only fix spelling of medical terms.`;

async function cleanupTranscript(text) {
  if (!text || text.length < 10) return text;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: `${CLEANUP_PROMPT}\n\nTEXT:\n${text}` }] })
    });
    if (!r.ok) return text; // Fail silently, return original
    const d = await r.json();
    const cleaned = (d.content || []).map(c => c.text || "").join("").trim();
    return cleaned || text;
  } catch { return text; }
}

function AudioInput({ onTranscript, dgKey, whisperKey, label, color, compact }) {
  const [mode, setMode] = useState(null); // null, recording, cleaning, recorded, transcribing, done
  const [transcript, setTranscript] = useState("");
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [lang, setLang] = useState("hi");
  const [engine, setEngine] = useState(whisperKey ? "whisper" : "deepgram");
  const [useCleanup, setUseCleanup] = useState(true);
  const mediaRec = useRef(null);
  const chunks = useRef([]);
  const audioBlob = useRef(null);
  const tmr = useRef(null);
  const fileRef = useRef(null);
  const wsRef = useRef(null);
  const finalsRef = useRef([]);
  const interimRef = useRef("");
  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const modeRef = useRef(null); // track mode without stale closures
  const processorRef = useRef(null);

  // Keep modeRef in sync
  useEffect(() => { modeRef.current = mode; }, [mode]);

  const doTranscribe = async (blob) => {
    if (engine === "whisper" && whisperKey) {
      return await transcribeWhisper(blob, whisperKey, lang);
    }
    return await transcribeDeepgram(blob, dgKey, lang);
  };

  // Streaming recording with Deepgram WebSocket + raw PCM via AudioContext
  const startStreamingRec = async () => {
    setError(""); setLiveText(""); setTranscript("");
    finalsRef.current = []; interimRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      streamRef.current = stream;

      // Also start MediaRecorder to save audio for playback
      const mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      mediaRec.current = rec;
      rec.start(1000);

      // AudioContext to get raw PCM for WebSocket
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Open Deepgram WebSocket
      const wsLang = lang === "hi" ? "hi" : "en";
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${wsLang}&smart_format=true&punctuate=true&interim_results=true&encoding=linear16&sample_rate=16000&channels=1`;
      const ws = new WebSocket(wsUrl, ["token", dgKey]);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send raw PCM via processor
        processor.onaudioprocess = (e) => {
          if (ws.readyState === WebSocket.OPEN) {
            const float32 = e.inputBuffer.getChannelData(0);
            const int16 = new Int16Array(float32.length);
            for (let i = 0; i < float32.length; i++) {
              int16[i] = Math.max(-32768, Math.min(32767, Math.floor(float32[i] * 32768)));
            }
            ws.send(int16.buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
            const alt = msg.channel.alternatives[0];
            const text = alt.transcript || "";
            if (msg.is_final) {
              if (text) finalsRef.current.push(text);
              interimRef.current = "";
            } else {
              interimRef.current = text;
            }
            const fullText = [...finalsRef.current, interimRef.current].filter(Boolean).join(" ");
            setLiveText(fullText);
          }
        } catch {}
      };

      ws.onerror = () => {
        setError("Streaming failed — try Upload instead");
        cleanupStreaming();
        setMode("recorded");
      };

      ws.onclose = async () => {
        const finalText = finalsRef.current.filter(Boolean).join(" ");
        if (finalText) {
          // Save recording blob for playback
          if (mediaRec.current?.state !== "inactive") mediaRec.current?.stop();
          await new Promise(r => setTimeout(r, 200)); // Wait for MediaRecorder to flush
          const blob = new Blob(chunks.current, { type: mt });
          audioBlob.current = blob;
          setAudioUrl(URL.createObjectURL(blob));
          // Run AI cleanup
          if (useCleanup) {
            setMode("cleaning");
            const cleaned = await cleanupTranscript(finalText);
            setTranscript(cleaned);
          } else {
            setTranscript(finalText);
          }
          setMode("done");
        } else if (modeRef.current === "recording") {
          setError("No speech detected — try again or speak louder");
          setMode(null);
        }
      };

      setMode("recording"); setDuration(0);
      tmr.current = setInterval(() => setDuration(d => d + 1), 1000);

    } catch (err) {
      setError("Mic access denied. Use Upload or paste text.");
    }
  };

  const cleanupStreaming = () => {
    if (processorRef.current) { try { processorRef.current.disconnect(); } catch {} }
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); }
  };

  // Non-streaming fallback (also used for Whisper engine and file uploads)
  const startNonStreamingRec = async (existingStream, mt) => {
    try {
      const stream = existingStream || await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000 } });
      if (!mt) mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: mt });
        audioBlob.current = blob;
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach(t => t.stop());
        setMode("transcribing");
        try {
          let text = await doTranscribe(blob);
          if (!text) throw new Error("Empty — try again or speak louder");
          if (useCleanup) { setMode("cleaning"); text = await cleanupTranscript(text); }
          setTranscript(text); setMode("done");
        } catch (err) { setError(err.message); setMode("recorded"); }
      };
      mediaRec.current = rec; rec.start(1000);
      if (!existingStream) {
        setMode("recording"); setDuration(0);
        tmr.current = setInterval(() => setDuration(d => d + 1), 1000);
      }
    } catch { setError("Mic access denied. Use Upload or paste text."); }
  };

  const startRec = () => {
    // Use streaming for Deepgram, non-streaming for Whisper
    if (engine === "deepgram" || (!whisperKey && dgKey)) {
      startStreamingRec();
    } else {
      startNonStreamingRec();
    }
  };

  const stopRec = () => {
    clearInterval(tmr.current);
    // Stop processor and close AudioContext
    cleanupStreaming();
    // Stop MediaRecorder
    if (mediaRec.current?.state !== "inactive") mediaRec.current?.stop();
    // Close WebSocket (triggers onclose which processes the transcript)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "CloseStream" }));
      // Give Deepgram a moment to send final results before closing
      setTimeout(() => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close(); }, 500);
    }
  };

  const handleFile = e => { const f=e.target.files[0]; if(!f) return; audioBlob.current=f; setAudioUrl(URL.createObjectURL(f)); setMode("recorded"); setError(""); };
  const transcribe = async () => {
    if (!audioBlob.current) return;
    setMode("transcribing"); setError("");
    try {
      let text = await doTranscribe(audioBlob.current);
      if (!text) throw new Error("Empty — try again or paste manually");
      if (useCleanup) { setMode("cleaning"); text = await cleanupTranscript(text); }
      setTranscript(text); setMode("done");
    } catch (err) { setError(err.message); setMode("recorded"); }
  };
  const reset = () => {
    setMode(null); setTranscript(""); setLiveText(""); setAudioUrl(null);
    audioBlob.current=null; setError(""); setDuration(0);
    finalsRef.current=[]; interimRef.current="";
    cleanupStreaming();
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
  };
  const fmt = s => `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`;

  return (
    <div style={{ border:`2px solid ${mode==="recording"?"#ef4444":mode==="cleaning"?"#f59e0b":"#e2e8f0"}`, borderRadius:8, padding:compact?8:12, background:mode==="recording"?"#fef2f2":mode==="cleaning"?"#fffbeb":"white", marginBottom:8 }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <div style={{ fontSize:compact?11:13, fontWeight:700, color:"#1e293b" }}>🎤 {label}</div>
        <div style={{ display:"flex", gap:4, alignItems:"center" }}>
          {whisperKey && dgKey && <div style={{ display:"flex", gap:1, background:"#f1f5f9", borderRadius:4, padding:1 }}>
            {[{v:"deepgram",l:"DG"},{v:"whisper",l:"W"}].map(x => (
              <button key={x.v} onClick={()=>setEngine(x.v)} style={{ padding:"1px 5px", fontSize:8, fontWeight:700, borderRadius:3, cursor:"pointer", background:engine===x.v?"#1e293b":"transparent", color:engine===x.v?"white":"#94a3b8", border:"none" }}>{x.l}</button>
            ))}
          </div>}
          <button onClick={()=>setUseCleanup(c=>!c)} style={{ padding:"1px 5px", fontSize:8, fontWeight:700, borderRadius:3, cursor:"pointer", background:useCleanup?"#059669":"#f1f5f9", color:useCleanup?"white":"#94a3b8", border:"none" }} title="AI cleanup of medical terms">AI✓</button>
          <div style={{ display:"flex", gap:1 }}>
            {[{v:"en",l:"EN"},{v:"hi",l:"HI"}].map(x => (
              <button key={x.v} onClick={()=>setLang(x.v)} style={{ padding:"1px 5px", fontSize:9, fontWeight:700, borderRadius:3, cursor:"pointer", background:lang===x.v?color:"white", color:lang===x.v?"white":"#94a3b8", border:`1px solid ${lang===x.v?color:"#e2e8f0"}` }}>{x.l}</button>
            ))}
          </div>
        </div>
      </div>
      {!mode && (
        <>
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={startRec} style={{ flex:1, background:"#dc2626", color:"white", border:"none", padding:compact?"6px":"10px", borderRadius:6, fontSize:compact?11:13, fontWeight:700, cursor:"pointer" }}>🔴 Record</button>
            <button onClick={()=>fileRef.current?.click()} style={{ flex:1, background:color, color:"white", border:"none", padding:compact?"6px":"10px", borderRadius:6, fontSize:compact?11:13, fontWeight:700, cursor:"pointer" }}>📁 Upload</button>
            <input ref={fileRef} type="file" accept="audio/*,.ogg,.mp3,.wav,.m4a,.webm" onChange={handleFile} style={{ display:"none" }} />
          </div>
          <textarea placeholder="Or paste transcript here and click outside..." onBlur={e => { if (e.target.value.trim()) { setTranscript(e.target.value.trim()); setMode("done"); } }}
            style={{ width:"100%", minHeight:compact?30:44, marginTop:6, padding:6, border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontFamily:"inherit", resize:"vertical", boxSizing:"border-box", color:"#64748b" }} />
        </>
      )}
      {mode==="recording" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
            <div style={{ fontSize:18, fontWeight:800, color:"#dc2626" }}><span style={{ display:"inline-block", width:8, height:8, borderRadius:"50%", background:"#dc2626", marginRight:6, animation:"pulse 1s infinite" }} />{fmt(duration)}</div>
            <button onClick={stopRec} style={{ background:"#1e293b", color:"white", border:"none", padding:"6px 20px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>⏹ Stop</button>
          </div>
          {/* Live transcript */}
          {liveText && <div style={{ background:"#fff", border:"1px solid #fecaca", borderRadius:4, padding:8, fontSize:13, lineHeight:1.6, color:"#374151", minHeight:40, maxHeight:150, overflow:"auto" }}>
            {liveText}<span style={{ display:"inline-block", width:2, height:14, background:"#dc2626", marginLeft:2, animation:"pulse 0.5s infinite" }} />
          </div>}
          {!liveText && <div style={{ fontSize:11, color:"#94a3b8", textAlign:"center", padding:6 }}>🎙️ Listening... speak now</div>}
        </div>
      )}
      {mode==="cleaning" && (
        <div style={{ textAlign:"center", padding:10 }}>
          <div style={{ fontSize:14, animation:"pulse 1s infinite" }}>✨</div>
          <div style={{ fontSize:11, color:"#92400e", fontWeight:600 }}>Fixing medical terms...</div>
        </div>
      )}
      {mode==="recorded" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:4 }}>
            <audio src={audioUrl} controls style={{ flex:1, height:30 }} />
            <button onClick={reset} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"3px 6px", borderRadius:3, fontSize:10, cursor:"pointer" }}>✕</button>
          </div>
          <button onClick={transcribe} style={{ width:"100%", background:color, color:"white", border:"none", padding:"8px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>🔊 Transcribe</button>
        </div>
      )}
      {mode==="transcribing" && <div style={{ textAlign:"center", padding:10 }}><div style={{ fontSize:18, animation:"pulse 1s infinite" }}>🔊</div><div style={{ fontSize:11, color:"#475569" }}>Transcribing...</div></div>}
      {mode==="done" && (
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:4, marginBottom:3 }}>
            <span style={{ color:"#059669", fontWeight:700, fontSize:11 }}>✅ Ready</span>
            <button onClick={reset} style={{ marginLeft:"auto", background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"1px 5px", borderRadius:3, fontSize:9, cursor:"pointer" }}>Redo</button>
          </div>
          <textarea value={transcript} onChange={e => setTranscript(e.target.value)} ref={el => { if (el) { el.style.height = "auto"; el.style.height = Math.max(100, el.scrollHeight) + "px"; }}}
            style={{ width:"100%", minHeight:100, padding:8, border:"1px solid #e2e8f0", borderRadius:4, fontSize:13, fontFamily:"inherit", resize:"vertical", lineHeight:1.6, boxSizing:"border-box", overflow:"hidden" }} />
          <button onClick={() => { if (transcript) onTranscript(transcript); }} style={{ marginTop:3, width:"100%", background:"#059669", color:"white", border:"none", padding:"7px", borderRadius:6, fontSize:12, fontWeight:700, cursor:"pointer" }}>✅ Use This</button>
        </div>
      )}
      {error && <div style={{ marginTop:4, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:4, padding:"3px 8px", fontSize:11, color:"#dc2626" }}>⚠️ {error}</div>}
    </div>
  );
}

// ============ HELPERS ============
const DC = { dm2:"#dc2626", htn:"#ea580c", cad:"#d97706", ckd:"#7c3aed", hypo:"#2563eb", obesity:"#92400e", dyslipidemia:"#0891b2" };
const FRIENDLY = { dm2:"Type 2 Diabetes", htn:"High Blood Pressure", cad:"Heart Disease", ckd:"Kidney Disease", hypo:"Thyroid (Low)", obesity:"Weight Management", dyslipidemia:"High Cholesterol" };
const Badge = ({ id, friendly }) => <span style={{ display:"inline-block", fontSize:9, fontWeight:700, background:(DC[id]||"#64748b")+"18", color:DC[id]||"#64748b", border:`1px solid ${(DC[id]||"#64748b")}35`, borderRadius:10, padding:"1px 5px", marginRight:2 }}>{friendly?(FRIENDLY[id]||id):id?.toUpperCase()}</span>;
const Err = ({ msg, onDismiss }) => msg ? <div style={{ marginTop:4, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:6, padding:"6px 10px", fontSize:12, color:"#dc2626" }}>❌ {msg} <button onClick={onDismiss} style={{ marginLeft:6, background:"#dc2626", color:"white", border:"none", padding:"2px 8px", borderRadius:4, fontSize:11, cursor:"pointer" }}>Dismiss</button></div> : null;
const Section = ({ title, color, children }) => <div style={{ marginBottom:14 }}><div style={{ fontSize:12, fontWeight:800, color, borderBottom:`2px solid ${color}`, paddingBottom:3, marginBottom:6 }}>{title}</div>{children}</div>;
// Safe array accessor
const sa = (obj, key) => (obj && Array.isArray(obj[key])) ? obj[key] : [];

// ============ MAIN ============
export default function GiniScribe() {
  const [tab, setTab] = useState("setup");
  const [dgKey, setDgKey] = useState("");
  const [whisperKey, setWhisperKey] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [moName, setMoName] = useState("Dr. Beant");
  const [conName, setConName] = useState("Dr. Bhansali");
  const [patient, setPatient] = useState({ name:"", phone:"", dob:"", fileNo:"", age:"", sex:"Male" });
  const [vitals, setVitals] = useState({ bp_sys:"", bp_dia:"", pulse:"", temp:"", spo2:"", weight:"", height:"", bmi:"" });
  const [labData, setLabData] = useState(null);
  const [labImageData, setLabImageData] = useState(null);
  const [labMismatch, setLabMismatch] = useState(null);
  const [moTranscript, setMoTranscript] = useState("");
  const [conTranscript, setConTranscript] = useState("");
  const [moData, setMoData] = useState(null);
  const [conData, setConData] = useState(null);
  const [clarifications, setClarifications] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const labRef = useRef(null);
  const clearErr = id => setErrors(p => ({ ...p, [id]: null }));
  
  const newPatient = () => {
    setPatient({ name:"", phone:"", dob:"", fileNo:"", age:"", sex:"Male" });
    setVitals({ bp_sys:"", bp_dia:"", pulse:"", temp:"", spo2:"", weight:"", height:"", bmi:"" });
    setLabData(null); setLabImageData(null); setLabMismatch(null);
    setMoTranscript(""); setConTranscript("");
    setMoData(null); setConData(null);
    setClarifications({}); setErrors({});
    setTab("patient");
  };

  // Auto-detect keys from env vars
  useEffect(() => {
    try {
      const dg = import.meta.env?.VITE_DEEPGRAM_KEY;
      const wh = import.meta.env?.VITE_OPENAI_KEY;
      if (dg && dg.length > 10) setDgKey(dg);
      if (wh && wh.length > 10) setWhisperKey(wh);
      if ((dg && dg.length > 10) || (wh && wh.length > 10)) { setKeySet(true); setTab("patient"); }
    } catch {}
  }, []);

  const updatePatient = (k, v) => {
    setPatient(p => { const u = { ...p, [k]: v }; if (k==="dob"&&v) { const a=Math.floor((Date.now()-new Date(v).getTime())/31557600000); u.age=a>0?String(a):""; } return u; });
  };

  const voiceFillPatient = async (t) => {
    setLoading(p=>({...p,pv:true})); clearErr("pv");
    const {data,error} = await callClaude(PATIENT_VOICE_PROMPT, t);
    if (error) setErrors(p=>({...p,pv:error}));
    else if (data) setPatient(prev => ({ name:data.name||prev.name, phone:data.phone||prev.phone, dob:data.dob||prev.dob, fileNo:data.fileNo||prev.fileNo, age:data.age?String(data.age):prev.age, sex:data.sex||prev.sex }));
    setLoading(p=>({...p,pv:false}));
  };

  const updateVital = (k, v) => {
    setVitals(prev => { const u={...prev,[k]:v}; if ((k==="weight"||k==="height")&&u.weight&&u.height) { const h=parseFloat(u.height)/100; u.bmi=h>0?(parseFloat(u.weight)/(h*h)).toFixed(1):""; } return u; });
  };

  const voiceFillVitals = async (t) => {
    setLoading(p=>({...p,vv:true})); clearErr("vv");
    const {data,error} = await callClaude(VITALS_VOICE_PROMPT, t);
    if (error) setErrors(p=>({...p,vv:error}));
    else if (data) {
      setVitals(prev => {
        const u={...prev};
        if(data.bp_sys)u.bp_sys=String(data.bp_sys); if(data.bp_dia)u.bp_dia=String(data.bp_dia);
        if(data.pulse)u.pulse=String(data.pulse); if(data.temp)u.temp=String(data.temp);
        if(data.spo2)u.spo2=String(data.spo2); if(data.weight)u.weight=String(data.weight);
        if(data.height)u.height=String(data.height);
        if(u.weight&&u.height){const h=parseFloat(u.height)/100; u.bmi=h>0?(parseFloat(u.weight)/(h*h)).toFixed(1):"";}
        return u;
      });
    }
    setLoading(p=>({...p,vv:false}));
  };

  const handleLabUpload = e => {
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev => setLabImageData({ base64:ev.target.result.split(",")[1], mediaType:f.type.startsWith("image/")?f.type:"application/pdf", fileName:f.name });
    reader.readAsDataURL(f);
  };

  const processLab = async () => {
    if(!labImageData) return;
    setLoading(p=>({...p,lab:true})); clearErr("lab");
    const {data,error} = await extractLab(labImageData.base64, labImageData.mediaType);
    if(error) setErrors(p=>({...p,lab:error}));
    else {
      setLabData(data);
      if(data?.patient_on_report?.name && patient.name) {
        const rn=data.patient_on_report.name.toLowerCase(), pn=patient.name.toLowerCase();
        if(rn&&pn&&!rn.includes(pn.split(" ")[0])&&!pn.includes(rn.split(" ")[0]))
          setLabMismatch(`Report: "${data.patient_on_report.name}" ≠ "${patient.name}"`);
        else setLabMismatch(null);
      }
    }
    setLoading(p=>({...p,lab:false}));
  };

  const processMO = async () => {
    if(!moTranscript) return;
    setLoading(p=>({...p,mo:true})); clearErr("mo");
    let extra="";
    if(labData?.panels) {
      const tests=labData.panels.flatMap(p=>p.tests.map(t=>`${t.test_name}: ${t.result_text||t.result} ${t.unit||""} ${t.flag==="H"?"[HIGH]":t.flag==="L"?"[LOW]":""}`));
      extra=`\n\nLAB RESULTS:\n${tests.join("\n")}`;
    }
    if(vitals.bp_sys) extra+=`\nVITALS: BP ${vitals.bp_sys}/${vitals.bp_dia}, Pulse ${vitals.pulse}, SpO2 ${vitals.spo2}%, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
    const {data,error} = await callClaude(MO_PROMPT, moTranscript+extra);
    if(error) setErrors(p=>({...p,mo:error}));
    else if(data) setMoData(data);
    else setErrors(p=>({...p,mo:"No data returned"}));
    setLoading(p=>({...p,mo:false}));
  };

  const processConsultant = async () => {
    if(!conTranscript) return;
    setLoading(p=>({...p,con:true})); clearErr("con");
    // Include MO context so consultant can reference existing data
    let context = conTranscript;
    if (moData) {
      const diagList = sa(moData,"diagnoses").map(d=>d.label).join(", ");
      const medList = sa(moData,"previous_medications").map(m=>`${m.name} ${m.dose}`).join(", ");
      const invList = sa(moData,"investigations").map(i=>`${i.test}: ${i.value}${i.unit}`).join(", ");
      context += `\n\nPATIENT CONTEXT FROM MO:\nDiagnoses: ${diagList}\nPrevious Meds: ${medList}\nInvestigations: ${invList}`;
      if(vitals.bp_sys) context += `\nVitals: BP ${vitals.bp_sys}/${vitals.bp_dia}, Wt ${vitals.weight}kg, BMI ${vitals.bmi}`;
    }
    const {data,error} = await callClaude(CONSULTANT_PROMPT, context);
    if(error) setErrors(p=>({...p,con:error}));
    else if(data) setConData(data);
    else setErrors(p=>({...p,con:"No data returned"}));
    setLoading(p=>({...p,con:false}));
  };

  const handleClarification = (i,k,v) => setClarifications(p=>({...p,[i]:{...(p[i]||{}),[k]:v}}));

  const allMeds = [
    ...sa(conData,"medications_confirmed"),
    ...sa(conData,"medications_needs_clarification").map((m,i) => {
      const c=clarifications[i]||{};
      return c.resolved_name ? {...m, name:c.resolved_name, dose:c.resolved_dose||m.default_dose||"", frequency:c.resolved_freq||"OD", timing:c.resolved_timing||m.default_timing||"", resolved:true, isNew:true} : null;
    }).filter(Boolean)
  ];

  const TABS = [
    { id:"setup", label:"⚙️", show:!keySet },
    { id:"patient", label:"👤 Patient", show:keySet },
    { id:"vitals", label:"📋 Vitals", show:keySet },
    { id:"mo", label:"🎤 MO", show:keySet },
    { id:"consultant", label:"👨‍⚕️ Consultant", show:keySet },
    { id:"plan", label:"📄 Plan", show:keySet }
  ];

  return (
    <div style={{ fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", maxWidth:1100, margin:"0 auto", padding:"8px 12px", background:"#fff", minHeight:"100vh" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, paddingBottom:6, borderBottom:"2px solid #1e293b" }}>
        <div style={{ width:28, height:28, background:"#1e293b", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center", color:"white", fontWeight:800, fontSize:12 }}>G</div>
        <div style={{ flex:1, fontSize:14, fontWeight:800, color:"#1e293b" }}>Gini Clinical Scribe</div>
        {patient.name && <button onClick={newPatient} style={{ background:"#059669", color:"white", border:"none", padding:"4px 10px", borderRadius:5, fontSize:10, fontWeight:700, cursor:"pointer" }}>+ New Patient</button>}
        {patient.name && <div style={{ fontSize:10, fontWeight:600, background:"#f1f5f9", padding:"2px 6px", borderRadius:4 }}>👤 {patient.name} {patient.age&&`(${patient.age}Y/${patient.sex?.charAt(0)})`}</div>}
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", gap:0, marginBottom:10, borderRadius:8, overflow:"hidden", border:"1px solid #e2e8f0" }}>
        {TABS.filter(t=>t.show!==false).map(t => (
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ flex:1, padding:"7px 4px", fontSize:11, fontWeight:600, cursor:"pointer", border:"none", background:tab===t.id?"#1e293b":"white", color:tab===t.id?"white":"#64748b" }}>{t.label}</button>
        ))}
      </div>

      {/* ===== SETUP ===== */}
      {tab==="setup" && (
        <div style={{ maxWidth:420, margin:"0 auto", padding:"14px 0" }}>
          <div style={{ textAlign:"center", marginBottom:14 }}>
            <div style={{ fontSize:32 }}>🔑</div>
            <div style={{ fontSize:15, fontWeight:800 }}>Voice Transcription Setup</div>
            <div style={{ fontSize:11, color:"#94a3b8" }}>Enter at least one key. Both enables A/B testing.</div>
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:600, color:"#475569" }}>Deepgram Key <span style={{ color:"#94a3b8", fontWeight:400 }}>(faster, ₹0.35/min)</span></label>
            <input type="password" value={dgKey} onChange={e=>setDgKey(e.target.value)} placeholder="Paste Deepgram API key..."
              style={{ width:"100%", padding:"8px 12px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:13, fontFamily:"monospace", boxSizing:"border-box", marginTop:3 }} />
          </div>
          <div style={{ marginBottom:10 }}>
            <label style={{ fontSize:11, fontWeight:600, color:"#475569" }}>OpenAI Key <span style={{ color:"#94a3b8", fontWeight:400 }}>(Whisper — better Hindi, ₹0.50/min)</span></label>
            <input type="password" value={whisperKey} onChange={e=>setWhisperKey(e.target.value)} placeholder="Paste OpenAI API key..."
              style={{ width:"100%", padding:"8px 12px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:13, fontFamily:"monospace", boxSizing:"border-box", marginTop:3 }} />
          </div>
          <button onClick={()=>{if(dgKey.length>10||whisperKey.length>10){setKeySet(true);setTab("patient");}}} style={{ width:"100%", background:(dgKey.length>10||whisperKey.length>10)?"#059669":"#94a3b8", color:"white", border:"none", padding:"12px", borderRadius:8, fontSize:14, fontWeight:700, cursor:(dgKey.length>10||whisperKey.length>10)?"pointer":"not-allowed" }}>
            {dgKey.length>10||whisperKey.length>10?"✅ Start":"Enter at least one key"}
          </button>
        </div>
      )}

      {/* ===== PATIENT ===== */}
      {tab==="patient" && (
        <div style={{ maxWidth:560, margin:"0 auto" }}>
          <AudioInput label="Say patient details" dgKey={dgKey} whisperKey={whisperKey} color="#1e40af" compact onTranscript={voiceFillPatient} />
          {loading.pv && <div style={{ textAlign:"center", padding:4, fontSize:11, color:"#1e40af", fontWeight:600 }}>🔬 Filling fields...</div>}
          <Err msg={errors.pv} onDismiss={()=>clearErr("pv")} />
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:6 }}>
            {[
              { k:"name", l:"Full Name *", ph:"Rajinder Singh", span:2 },
              { k:"phone", l:"Phone", ph:"+91 98765 43210" },
              { k:"fileNo", l:"File No.", ph:"GINI-2025-04821" },
              { k:"dob", l:"DOB", type:"date" },
              { k:"age", l:"Age", ph:"77", disabled:!!patient.dob },
            ].map(f => (
              <div key={f.k} style={{ gridColumn:f.span?"span 2":"span 1" }}>
                <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>{f.l}</label>
                <input type={f.type||"text"} value={patient[f.k]} onChange={e=>updatePatient(f.k,e.target.value)} disabled={f.disabled} placeholder={f.ph}
                  style={{ width:"100%", padding:"6px 8px", border:"1px solid #e2e8f0", borderRadius:6, fontSize:14, boxSizing:"border-box", background:f.disabled?"#f8fafc":"white" }} />
              </div>
            ))}
            <div>
              <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Sex</label>
              <div style={{ display:"flex", gap:4 }}>
                {["Male","Female"].map(s => (
                  <button key={s} onClick={()=>updatePatient("sex",s)} style={{ flex:1, padding:"6px", border:`1px solid ${patient.sex===s?"#1e293b":"#e2e8f0"}`, borderRadius:6, background:patient.sex===s?"#1e293b":"white", color:patient.sex===s?"white":"#64748b", fontWeight:600, fontSize:12, cursor:"pointer" }}>{s}</button>
                ))}
              </div>
            </div>
          </div>
          <button onClick={()=>{if(patient.name) setTab("vitals");}} style={{ marginTop:10, width:"100%", background:patient.name?"#1e293b":"#94a3b8", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:patient.name?"pointer":"not-allowed" }}>
            {patient.name?"Next: Vitals →":"Enter name first"}
          </button>
        </div>
      )}

      {/* ===== VITALS ===== */}
      {tab==="vitals" && (
        <div>
          <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:800, marginBottom:6 }}>📊 Vitals</div>
              <AudioInput label="Say vitals: BP 140 over 90, weight 80kg" dgKey={dgKey} whisperKey={whisperKey} color="#ea580c" compact onTranscript={voiceFillVitals} />
              {loading.vv && <div style={{ textAlign:"center", padding:3, fontSize:10, color:"#ea580c" }}>🔬 Filling...</div>}
              <Err msg={errors.vv} onDismiss={()=>clearErr("vv")} />
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:5, marginTop:6 }}>
                {[{k:"bp_sys",l:"BP Sys"},{k:"bp_dia",l:"BP Dia"},{k:"pulse",l:"Pulse"},{k:"temp",l:"Temp °F"},{k:"spo2",l:"SpO2 %"},{k:"weight",l:"Wt kg"},{k:"height",l:"Ht cm"},{k:"bmi",l:"BMI",disabled:true}].map(v => (
                  <div key={v.k}>
                    <label style={{ fontSize:9, fontWeight:600, color:"#64748b" }}>{v.l}</label>
                    <input type="number" value={vitals[v.k]} onChange={e=>updateVital(v.k,e.target.value)} disabled={v.disabled}
                      style={{ width:"100%", padding:"4px 6px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:14, fontWeight:600, boxSizing:"border-box", background:v.disabled?"#f0fdf4":"white" }} />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:800, color:"#7c3aed", marginBottom:6 }}>🔬 Lab Reports</div>
              <div onClick={()=>labRef.current?.click()} style={{ border:"2px dashed #c4b5fd", borderRadius:8, padding:14, textAlign:"center", cursor:"pointer", background:"#faf5ff" }}>
                <input ref={labRef} type="file" accept="image/*,.pdf" onChange={handleLabUpload} style={{ display:"none" }} />
                {labImageData ? <div style={{ color:"#7c3aed", fontWeight:600, fontSize:12 }}>📋 {labImageData.fileName}</div> : <div><div style={{ fontSize:22 }}>📋</div><div style={{ fontWeight:600, color:"#7c3aed", fontSize:12 }}>Upload Report</div></div>}
              </div>
              {labImageData && !labData && <button onClick={processLab} disabled={loading.lab} style={{ marginTop:4, width:"100%", background:loading.lab?"#94a3b8":"#7c3aed", color:"white", border:"none", padding:"7px", borderRadius:6, fontSize:12, fontWeight:700, cursor:loading.lab?"wait":"pointer" }}>{loading.lab?"🔬 Extracting...":"🔬 Extract Labs"}</button>}
              <Err msg={errors.lab} onDismiss={()=>clearErr("lab")} />
              {labMismatch && <div style={{ marginTop:3, background:"#fef2f2", border:"1px solid #fecaca", borderRadius:4, padding:"3px 6px", fontSize:10, color:"#dc2626" }}>⚠️ {labMismatch}</div>}
              {labData && <div style={{ marginTop:3, color:"#059669", fontWeight:600, fontSize:11 }}>✅ {labData.panels?.reduce((a,p)=>a+p.tests.length,0)} tests extracted</div>}
            </div>
          </div>
          {labData && (labData.panels||[]).map((panel,pi) => (
            <div key={pi} style={{ marginTop:6, border:"1px solid #e2e8f0", borderRadius:6, overflow:"hidden" }}>
              <div style={{ background:"#7c3aed", color:"white", padding:"4px 8px", fontSize:11, fontWeight:700 }}>{panel.panel_name}</div>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}><tbody>
                {panel.tests.map((t,ti) => (
                  <tr key={ti} style={{ background:t.flag==="H"?"#fef2f2":t.flag==="L"?"#eff6ff":ti%2?"#fafafa":"white" }}>
                    <td style={{ padding:"2px 8px" }}>{t.test_name}</td>
                    <td style={{ padding:"2px 8px", textAlign:"right", fontWeight:700, color:t.flag==="H"?"#dc2626":t.flag==="L"?"#2563eb":"#1e293b" }}>{t.result_text||t.result} {t.unit}</td>
                    <td style={{ padding:"2px 8px", textAlign:"center", fontSize:9 }}>{t.flag==="H"?"↑ HIGH":t.flag==="L"?"↓ LOW":"✓"}</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ))}
          <button onClick={()=>setTab("mo")} style={{ marginTop:8, width:"100%", background:"#1e293b", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:"pointer" }}>Next: MO Recording →</button>
        </div>
      )}

      {/* ===== MO SUMMARY — RICH DISPLAY ===== */}
      {tab==="mo" && (
        <div>
          <div style={{ display:"flex", gap:6, marginBottom:6, alignItems:"center" }}>
            <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>MO:</label>
            <input value={moName} onChange={e=>setMoName(e.target.value)} placeholder="Dr. Name"
              style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:160 }} />
          </div>
          <AudioInput label="MO — Patient History" dgKey={dgKey} whisperKey={whisperKey} color="#1e40af" onTranscript={t=>{setMoTranscript(t);setMoData(null);clearErr("mo");}} />
          {moTranscript && <button onClick={processMO} disabled={loading.mo} style={{ marginTop:6, width:"100%", background:loading.mo?"#6b7280":moData?"#059669":"#1e40af", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:loading.mo?"wait":"pointer" }}>
            {loading.mo?"🔬 Structuring...":moData?"✅ Done — Re-process":"🔬 Structure MO Summary"}
          </button>}
          <Err msg={errors.mo} onDismiss={()=>clearErr("mo")} />

          {moData && (
            <div style={{ marginTop:8 }}>
              {/* Header */}
              <div style={{ background:"#1e40af", color:"white", padding:"8px 12px", borderRadius:"8px 8px 0 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontWeight:700, fontSize:13 }}>📋 MO Summary — {patient.name||"Patient"} <span style={{ fontSize:10, opacity:.7 }}>by {moName}</span></span>
                <button onClick={()=>setTab("consultant")} style={{ background:"rgba(255,255,255,0.2)", border:"none", color:"white", padding:"3px 10px", borderRadius:4, fontSize:11, fontWeight:700, cursor:"pointer" }}>Next: Consultant →</button>
              </div>
              <div style={{ border:"1px solid #bfdbfe", borderTop:"none", borderRadius:"0 0 8px 8px", padding:12 }}>

                {/* Diagnoses */}
                <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginBottom:10 }}>
                  {sa(moData,"diagnoses").map((d,i) => (
                    <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 10px", borderRadius:6, background:(DC[d.id]||"#64748b")+"12", border:`1px solid ${(DC[d.id]||"#64748b")}30` }}>
                      <div style={{ width:8, height:8, borderRadius:"50%", background:DC[d.id]||"#64748b" }} />
                      <span style={{ fontSize:12, fontWeight:600, color:DC[d.id]||"#64748b" }}>{d.label}</span>
                      <span style={{ fontSize:9, fontWeight:700, padding:"1px 5px", borderRadius:8, background:d.status==="Uncontrolled"||d.status==="Suboptimal"?"#fef2f2":d.status==="Active"?"#fef3c7":"#f0fdf4", color:d.status==="Uncontrolled"||d.status==="Suboptimal"?"#dc2626":d.status==="Active"?"#92400e":"#059669" }}>{d.status}</span>
                    </div>
                  ))}
                </div>

                {/* Complications */}
                {sa(moData,"complications").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#dc2626", marginBottom:3 }}>⚠️ COMPLICATIONS</div>
                    <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                      {sa(moData,"complications").map((c,i) => (
                        <span key={i} style={{ fontSize:11, padding:"2px 8px", borderRadius:6, background:c.severity==="high"?"#fef2f2":"#fef3c7", border:`1px solid ${c.severity==="high"?"#fecaca":"#fde68a"}`, color:c.severity==="high"?"#dc2626":"#92400e" }}>
                          {c.name} ({c.status}) {c.detail && `— ${c.detail}`}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* History */}
                {moData.history && (
                  <div style={{ marginBottom:10, background:"#f8fafc", borderRadius:6, padding:8, border:"1px solid #e2e8f0" }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#1e293b", marginBottom:4 }}>📖 HISTORY</div>
                    <div style={{ fontSize:11, lineHeight:1.8, color:"#475569" }}>
                      {moData.history.family && moData.history.family !== "NIL" && <div>👨‍👩‍👧 <strong>Family:</strong> {moData.history.family}</div>}
                      {moData.history.past_medical_surgical && moData.history.past_medical_surgical !== "NIL" && <div>🏥 <strong>Past:</strong> {moData.history.past_medical_surgical}</div>}
                      {moData.history.personal && moData.history.personal !== "NIL" && <div>🚬 <strong>Personal:</strong> {moData.history.personal}</div>}
                      {moData.history.covid && <div>🦠 <strong>COVID:</strong> {moData.history.covid}</div>}
                      {moData.history.vaccination && <div>💉 <strong>Vaccination:</strong> {moData.history.vaccination}</div>}
                    </div>
                  </div>
                )}

                {/* Previous Medications */}
                {sa(moData,"previous_medications").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#1e40af", marginBottom:4 }}>💊 PREVIOUS MEDICATIONS</div>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #bfdbfe", borderRadius:4, overflow:"hidden" }}>
                      <thead><tr style={{ background:"#1e40af", color:"white" }}><th style={{ padding:"3px 8px", textAlign:"left" }}>Medicine</th><th style={{ padding:"3px 8px" }}>Dose</th><th style={{ padding:"3px 8px" }}>Freq</th><th style={{ padding:"3px 8px" }}>When</th></tr></thead>
                      <tbody>{sa(moData,"previous_medications").map((m,i) => (
                        <tr key={i} style={{ background:i%2?"#eff6ff":"white" }}>
                          <td style={{ padding:"3px 8px" }}><strong>{m.name}</strong>{m.composition && <div style={{ fontSize:9, color:"#94a3b8" }}>{m.composition}</div>}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.dose}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.frequency}</td>
                          <td style={{ padding:"3px 8px", textAlign:"center" }}>{m.timing}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}

                {/* Investigations */}
                {sa(moData,"investigations").length>0 && (
                  <div style={{ marginBottom:10 }}>
                    <div style={{ fontSize:11, fontWeight:700, color:"#7c3aed", marginBottom:4 }}>🔬 INVESTIGATIONS</div>
                    {sa(moData,"investigations").map((inv,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"4px 8px", marginBottom:2, borderRadius:4, background:inv.critical?"#fef2f2":inv.flag==="HIGH"?"#fff7ed":inv.flag==="LOW"?"#eff6ff":"#f0fdf4", border:`1px solid ${inv.critical?"#fecaca":inv.flag==="HIGH"?"#fed7aa":inv.flag==="LOW"?"#bfdbfe":"#bbf7d0"}` }}>
                        <span style={{ fontSize:12, fontWeight:600 }}>{inv.test}</span>
                        <span style={{ display:"flex", alignItems:"center", gap:4 }}>
                          <span style={{ fontSize:13, fontWeight:800, color:inv.critical?"#dc2626":inv.flag==="HIGH"?"#ea580c":inv.flag==="LOW"?"#2563eb":"#059669" }}>{inv.value} {inv.unit}</span>
                          {inv.critical && <span style={{ background:"#dc2626", color:"white", padding:"0 4px", borderRadius:4, fontSize:9, fontWeight:700 }}>CRITICAL</span>}
                          {inv.flag==="HIGH" && !inv.critical && <span style={{ color:"#ea580c", fontSize:10 }}>⚠️ HIGH</span>}
                          {inv.flag==="LOW" && <span style={{ color:"#2563eb", fontSize:10 }}>⚠️ LOW</span>}
                          {!inv.flag && <span style={{ color:"#059669", fontSize:10 }}>✅</span>}
                          {inv.ref && <span style={{ fontSize:9, color:"#94a3b8" }}>({inv.ref})</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Missing */}
                {sa(moData,"missing_investigations").length>0 && (
                  <div style={{ background:"#eff6ff", border:"1px solid #bfdbfe", borderRadius:6, padding:"6px 10px", fontSize:11, color:"#1e40af" }}>
                    ❓ <strong>Missing investigations:</strong> {sa(moData,"missing_investigations").join(", ")}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== CONSULTANT ===== */}
      {tab==="consultant" && (
        <div>
          <div style={{ display:"flex", gap:6, marginBottom:6, alignItems:"center" }}>
            <label style={{ fontSize:10, fontWeight:600, color:"#475569" }}>Consultant:</label>
            <input value={conName} onChange={e=>setConName(e.target.value)} placeholder="Dr. Name"
              style={{ padding:"4px 8px", border:"1px solid #e2e8f0", borderRadius:4, fontSize:12, fontWeight:600, width:160 }} />
          </div>
          <AudioInput label="Consultant — Treatment Decisions" dgKey={dgKey} whisperKey={whisperKey} color="#7c2d12" onTranscript={t=>{setConTranscript(t);setConData(null);clearErr("con");}} />
          {conTranscript && <button onClick={processConsultant} disabled={loading.con} style={{ marginTop:6, width:"100%", background:loading.con?"#6b7280":conData?"#059669":"#7c2d12", color:"white", border:"none", padding:"10px", borderRadius:8, fontSize:13, fontWeight:700, cursor:loading.con?"wait":"pointer" }}>
            {loading.con?"🔬 Extracting...":conData?"✅ Done — Re-process":"🔬 Extract Treatment Plan"}
          </button>}
          <Err msg={errors.con} onDismiss={()=>clearErr("con")} />
          {conData && (
            <div style={{ marginTop:8, display:"flex", gap:8 }}>
              <div style={{ flex:1, border:"1px solid #fed7aa", borderRadius:6, overflow:"hidden" }}>
                <div style={{ background:"#7c2d12", color:"white", padding:"6px 8px", fontSize:12, fontWeight:700 }}>Assessment</div>
                <div style={{ padding:8, fontSize:12, lineHeight:1.5 }}>
                  <div style={{ fontWeight:600, marginBottom:3 }}>{conData.assessment_summary}</div>
                  {sa(conData,"key_issues").map((x,i) => <div key={i}>• {x}</div>)}
                  {sa(conData,"goals").length>0 && <table style={{ width:"100%", borderCollapse:"collapse", fontSize:10, marginTop:6, border:"1px solid #bbf7d0" }}>
                    <thead><tr style={{ background:"#059669", color:"white" }}><th style={{padding:"3px 5px"}}>Marker</th><th style={{padding:"3px 5px"}}>Now</th><th style={{padding:"3px 5px"}}>Target</th></tr></thead>
                    <tbody>{sa(conData,"goals").map((g,i) => <tr key={i}><td style={{padding:"2px 5px"}}>{g.marker}</td><td style={{padding:"2px 5px",color:"#dc2626",fontWeight:700}}>{g.current}</td><td style={{padding:"2px 5px",color:"#059669",fontWeight:700}}>{g.target}</td></tr>)}</tbody>
                  </table>}
                </div>
              </div>
              <div style={{ flex:1, border:"1px solid #e2e8f0", borderRadius:6, overflow:"hidden" }}>
                <div style={{ background:"#1e293b", color:"white", padding:"6px 8px", fontSize:12, fontWeight:700, display:"flex", justifyContent:"space-between" }}>
                  <span>Medications</span>
                  <button onClick={()=>setTab("plan")} style={{ background:"rgba(255,255,255,0.2)", border:"none", color:"white", padding:"1px 6px", borderRadius:3, fontSize:10, cursor:"pointer" }}>Plan →</button>
                </div>
                <div style={{ padding:8, fontSize:11, maxHeight:280, overflow:"auto" }}>
                  {sa(conData,"medications_confirmed").map((m,i) => (
                    <div key={i} style={{ background:"#f0fdf4", border:"1px solid #bbf7d0", borderRadius:4, padding:"4px 8px", marginBottom:3 }}>
                      <div>✅ <strong>{m.name}</strong></div>
                      <div style={{ fontSize:10, color:"#475569" }}>{m.dose} • {m.frequency} • <strong>{m.timing}</strong></div>
                    </div>
                  ))}
                  {sa(conData,"medications_needs_clarification").map((m,i) => (
                    <div key={i} style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:4, padding:6, marginBottom:3, marginTop:i===0?4:0 }}>
                      <div style={{ fontSize:10, color:"#92400e", marginBottom:3 }}>⚠️ "{m.what_consultant_said}" ({m.drug_class})</div>
                      {m.default_dose && <div style={{ fontSize:9, color:"#64748b", marginBottom:2 }}>Suggested: {m.default_dose}, {m.default_timing}</div>}
                      <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                        <input placeholder="Brand name" onChange={e=>handleClarification(i,"resolved_name",e.target.value)} style={{ flex:2, minWidth:70, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                        <input placeholder={m.default_dose||"Dose"} onChange={e=>handleClarification(i,"resolved_dose",e.target.value)} style={{ flex:1, minWidth:40, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                        <input placeholder={m.default_timing||"Timing"} onChange={e=>handleClarification(i,"resolved_timing",e.target.value)} style={{ flex:1, minWidth:50, padding:"3px 5px", border:"1px solid #fde68a", borderRadius:3, fontSize:10 }} />
                      </div>
                      {m.suggested_options?.length>0 && <div style={{ fontSize:9, color:"#94a3b8", marginTop:2 }}>Options: {m.suggested_options.join(" • ")}</div>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== TREATMENT PLAN — NULL-SAFE ===== */}
      {tab==="plan" && (
        <div>
          <div style={{ display:"flex", gap:4, marginBottom:8 }}>
            <button onClick={()=>setTab("vitals")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>+ Reports</button>
            <button onClick={()=>setTab("mo")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>✏️ MO</button>
            <button onClick={()=>setTab("consultant")} style={{ background:"#f1f5f9", border:"1px solid #e2e8f0", padding:"4px 8px", borderRadius:4, fontSize:10, cursor:"pointer", fontWeight:600 }}>✏️ Consultant</button>
            <div style={{ flex:1 }} />
            <button onClick={()=>window.print()} style={{ background:"#1e293b", color:"white", border:"none", padding:"4px 12px", borderRadius:4, fontSize:10, fontWeight:700, cursor:"pointer" }}>🖨️ Print</button>
          </div>

          {!moData && !conData ? <div style={{ textAlign:"center", padding:24, color:"#94a3b8" }}>Complete MO & Consultant first</div> : (
            <div>
              {/* Plan Header */}
              <div style={{ background:"linear-gradient(135deg,#1e293b,#334155)", color:"white", padding:"12px 16px", borderRadius:"10px 10px 0 0" }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ width:26, height:26, background:"white", borderRadius:5, display:"flex", alignItems:"center", justifyContent:"center", color:"#1e293b", fontWeight:900, fontSize:11 }}>G</div>
                    <div><div style={{ fontSize:13, fontWeight:800 }}>GINI ADVANCED CARE HOSPITAL</div><div style={{ fontSize:9, opacity:.7 }}>Sector 69, Mohali | 0172-4120100</div></div>
                  </div>
                  <div style={{ textAlign:"right", fontSize:10 }}><div style={{ fontWeight:700 }}>{conName}</div><div style={{ opacity:.8 }}>Consultant</div></div>
                </div>
                <div style={{ borderTop:"1px solid rgba(255,255,255,.12)", marginTop:6, paddingTop:5, fontSize:12 }}>
                  <strong>{patient.name}</strong> | {patient.age}Y / {patient.sex} {patient.phone&&`| ${patient.phone}`} {patient.fileNo&&`| ${patient.fileNo}`}
                  <span style={{ float:"right", fontSize:10, opacity:.6 }}>{new Date().toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}</span>
                </div>
              </div>

              <div style={{ border:"1px solid #e2e8f0", borderTop:"none", borderRadius:"0 0 10px 10px", padding:14 }}>
                {/* Summary */}
                {conData?.assessment_summary && <div style={{ background:"linear-gradient(135deg,#eff6ff,#f0fdf4)", border:"1px solid #bfdbfe", borderRadius:8, padding:10, marginBottom:12, fontSize:12, color:"#334155", lineHeight:1.6 }}>
                  <strong style={{ color:"#1e40af" }}>📋 Dear {patient.name?patient.name.split(" ")[0]:"Patient"}:</strong> {conData.assessment_summary}
                </div>}

                {/* Diagnoses */}
                {sa(moData,"diagnoses").length>0 && <Section title="🏥 Your Conditions" color="#1e293b">
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:3 }}>
                    {sa(moData,"diagnoses").map((d,i) => (
                      <div key={i} style={{ display:"flex", alignItems:"center", gap:4, padding:"4px 8px", background:(DC[d.id]||"#64748b")+"08", border:`1px solid ${(DC[d.id]||"#64748b")}22`, borderRadius:5, fontSize:11 }}>
                        <div style={{ width:6, height:6, borderRadius:"50%", background:DC[d.id]||"#64748b" }} />
                        <strong style={{ flex:1 }}>{FRIENDLY[d.id]||d.label}</strong>
                        <span style={{ fontSize:9, fontWeight:600, padding:"0 4px", borderRadius:6, background:d.status==="Uncontrolled"||d.status==="Active"||d.status==="Suboptimal"?"#fef2f2":"#f0fdf4", color:d.status==="Uncontrolled"||d.status==="Active"||d.status==="Suboptimal"?"#dc2626":"#059669" }}>{d.status}</span>
                      </div>
                    ))}
                  </div>
                </Section>}

                {/* Vitals */}
                {vitals.bp_sys && <Section title="📊 Vitals" color="#ea580c"><div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                  {[{l:"BP",v:`${vitals.bp_sys}/${vitals.bp_dia}`},{l:"Pulse",v:vitals.pulse},{l:"SpO2",v:vitals.spo2&&`${vitals.spo2}%`},{l:"Weight",v:vitals.weight&&`${vitals.weight}kg`},{l:"BMI",v:vitals.bmi}].filter(x=>x.v&&x.v!=="/").map((x,i) => <span key={i} style={{ background:"#fff7ed", border:"1px solid #fed7aa", borderRadius:4, padding:"2px 6px", fontSize:11 }}><strong style={{ color:"#9a3412" }}>{x.l}:</strong> {x.v}</span>)}
                </div></Section>}

                {/* Goals */}
                {sa(conData,"goals").length>0 && <Section title="🎯 Your Health Goals" color="#059669"><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #bbf7d0" }}>
                  <thead><tr style={{ background:"#059669", color:"white" }}><th style={{padding:"4px 8px",textAlign:"left"}}>Marker</th><th style={{padding:"4px 8px"}}>Current</th><th style={{padding:"4px 8px"}}>Target</th><th style={{padding:"4px 8px"}}>By</th></tr></thead>
                  <tbody>{sa(conData,"goals").map((g,i) => <tr key={i} style={{ background:g.priority==="critical"?"#fef2f2":i%2?"#f0fdf4":"white" }}><td style={{padding:"3px 8px",fontWeight:600}}>{g.marker}</td><td style={{padding:"3px 8px",textAlign:"center",fontWeight:700,color:"#dc2626"}}>{g.current}</td><td style={{padding:"3px 8px",textAlign:"center",fontWeight:700,color:"#059669"}}>{g.target}</td><td style={{padding:"3px 8px",textAlign:"center",color:"#64748b"}}>{g.timeline}</td></tr>)}</tbody>
                </table></Section>}

                {/* Medications */}
                {allMeds.length>0 && <Section title="💊 Your Medications" color="#dc2626"><table style={{ width:"100%", borderCollapse:"collapse", fontSize:11, border:"1px solid #e2e8f0" }}>
                  <thead><tr style={{ background:"#1e293b", color:"white" }}><th style={{padding:"5px 8px",textAlign:"left"}}>Medicine</th><th style={{padding:"5px 8px"}}>Dose</th><th style={{padding:"5px 8px"}}>When to Take</th><th style={{padding:"5px 8px",textAlign:"left"}}>For</th></tr></thead>
                  <tbody>{allMeds.map((m,i) => <tr key={i} style={{ background:(m.isNew||m.resolved)?"#eff6ff":i%2?"#fafafa":"white" }}>
                    <td style={{padding:"4px 8px"}}><strong>{m.name}</strong>{(m.isNew||m.resolved)&&<span style={{background:"#1e40af",color:"white",padding:"0 3px",borderRadius:3,fontSize:8,marginLeft:3}}>NEW</span>}{m.composition&&<div style={{fontSize:9,color:"#94a3b8"}}>{m.composition}</div>}</td>
                    <td style={{padding:"4px 8px",textAlign:"center",fontWeight:600}}>{m.dose}</td>
                    <td style={{padding:"4px 8px",textAlign:"center",fontSize:10,fontWeight:600,color:"#1e40af"}}>{m.timing || m.frequency}</td>
                    <td style={{padding:"4px 8px"}}>{(m.forDiagnosis||[]).map(d=><Badge key={d} id={d} friendly />)}</td>
                  </tr>)}</tbody>
                </table></Section>}

                {/* Lifestyle */}
                {sa(conData,"diet_lifestyle").length>0 && <Section title="🥗 Lifestyle Changes" color="#059669">
                  {sa(conData,"diet_lifestyle").map((l,i) => (
                    <div key={i} style={{ display:"flex", gap:5, padding:"3px 0", borderBottom:"1px solid #f1f5f9", fontSize:11 }}>
                      <span style={{ fontSize:8, fontWeight:700, padding:"1px 4px", borderRadius:4, color:"white", background:l.category==="Critical"?"#dc2626":l.category==="Diet"?"#059669":"#2563eb", alignSelf:"flex-start", marginTop:2 }}>{l.category}</span>
                      <div><strong>{l.advice}</strong> — {l.detail} {(l.helps||[]).map(d=><Badge key={d} id={d} friendly />)}</div>
                    </div>
                  ))}
                </Section>}

                {/* Self Monitoring */}
                {sa(conData,"self_monitoring").length>0 && <Section title="📊 What to Monitor at Home" color="#2563eb">
                  {sa(conData,"self_monitoring").map((sm,i) => (
                    <div key={i} style={{ border:"1px solid #bfdbfe", borderRadius:6, padding:8, marginBottom:4, background:"#f8fafc" }}>
                      <div style={{ fontWeight:700, color:"#1e40af", fontSize:11 }}>{sm.title}</div>
                      {(sm.instructions||[]).map((x,j) => <div key={j} style={{ fontSize:11 }}>• {x}</div>)}
                      {sm.targets && <div style={{ marginTop:2, background:"#f0fdf4", borderRadius:3, padding:"2px 6px", fontSize:10, color:"#059669", fontWeight:600, display:"inline-block" }}>🎯 {sm.targets}</div>}
                      {sm.alert && <div style={{ marginTop:2, background:"#fef2f2", borderRadius:3, padding:"2px 6px", fontSize:10, color:"#dc2626", fontWeight:700 }}>🚨 {sm.alert}</div>}
                    </div>
                  ))}
                </Section>}

                {/* Insulin Education */}
                {conData?.insulin_education && <Section title="💉 Insulin Guide" color="#dc2626">
                  <div style={{ border:"1px solid #fecaca", borderRadius:8, overflow:"hidden" }}>
                    <div style={{ background:"#dc2626", color:"white", padding:"6px 10px", fontSize:12, fontWeight:700 }}>
                      {conData.insulin_education.type} Insulin — {conData.insulin_education.device}
                    </div>
                    <div style={{ padding:10 }}>
                      {/* How to Inject */}
                      <div style={{ marginBottom:8, background:"#f8fafc", borderRadius:6, padding:8, border:"1px solid #e2e8f0" }}>
                        <div style={{ fontSize:11, fontWeight:700, color:"#1e293b", marginBottom:4 }}>📋 How to Inject</div>
                        <div style={{ fontSize:11, lineHeight:1.8 }}>
                          {["Wash hands with soap", "Choose injection site: " + (conData.insulin_education.injection_sites||["Abdomen","Thigh"]).join(" or "), "Clean area with alcohol swab", "Pinch skin gently, insert needle at 90°", "Push plunger slowly, hold 10 seconds", "Release skin, remove needle", "Rotate injection site each time"].map((step,i) => (
                            <div key={i} style={{ display:"flex", gap:6, alignItems:"flex-start" }}>
                              <span style={{ background:"#dc2626", color:"white", borderRadius:"50%", width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, fontWeight:800, flexShrink:0 }}>{i+1}</span>
                              <span>{step}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Dose Titration */}
                      {conData.insulin_education.titration && (
                        <div style={{ marginBottom:8, background:"#fff7ed", borderRadius:6, padding:8, border:"1px solid #fed7aa" }}>
                          <div style={{ fontSize:11, fontWeight:700, color:"#9a3412", marginBottom:3 }}>📈 Dose Adjustment (Titration)</div>
                          <div style={{ fontSize:12, fontWeight:600 }}>{conData.insulin_education.titration}</div>
                          <table style={{ width:"100%", marginTop:6, borderCollapse:"collapse", fontSize:10, border:"1px solid #fed7aa" }}>
                            <thead><tr style={{ background:"#ea580c", color:"white" }}><th style={{ padding:"3px 6px" }}>Fasting Sugar</th><th style={{ padding:"3px 6px" }}>Action</th></tr></thead>
                            <tbody>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Above 130 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#ea580c" }}>↑ Increase by 2 units</td></tr>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>90-130 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#059669" }}>✅ No change (at target)</td></tr>
                              <tr><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Below 90 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:600, color:"#dc2626" }}>↓ Decrease by 2 units</td></tr>
                              <tr style={{ background:"#fef2f2" }}><td style={{ padding:"2px 6px", border:"1px solid #fed7aa" }}>Below 70 mg/dL</td><td style={{ padding:"2px 6px", border:"1px solid #fed7aa", fontWeight:700, color:"#dc2626" }}>🚨 STOP — call doctor</td></tr>
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Emergency */}
                      <div style={{ background:"#fef2f2", borderRadius:6, padding:8, border:"2px solid #dc2626", marginBottom:6 }}>
                        <div style={{ fontSize:11, fontWeight:800, color:"#dc2626", marginBottom:3 }}>🚨 LOW SUGAR EMERGENCY (Below 70 mg/dL)</div>
                        <div style={{ fontSize:11, lineHeight:1.8 }}>
                          <div>1️⃣ <strong>Eat 3 glucose tablets</strong> or 1 tablespoon sugar in water</div>
                          <div>2️⃣ <strong>Wait 15 minutes</strong>, recheck sugar</div>
                          <div>3️⃣ If still below 70 → <strong>repeat step 1</strong></div>
                          <div>4️⃣ Once above 70 → <strong>eat a snack</strong> (biscuits + milk)</div>
                          <div style={{ marginTop:4, fontWeight:700, color:"#dc2626" }}>⚠️ Always carry glucose tablets with you!</div>
                        </div>
                      </div>

                      {/* Storage */}
                      <div style={{ display:"flex", gap:8, fontSize:10, color:"#64748b" }}>
                        <span>🧊 <strong>Storage:</strong> {conData.insulin_education.storage || "Keep in fridge, room temp vial valid 28 days"}</span>
                        <span>🗑️ <strong>Needles:</strong> {conData.insulin_education.needle_disposal || "Use sharps container, never reuse"}</span>
                      </div>
                    </div>
                  </div>
                </Section>}

                {/* Follow Up */}
                {conData?.follow_up && <div style={{ marginBottom:12, display:"flex", gap:10, alignItems:"center" }}>
                  <div style={{ background:"#f8fafc", border:"2px solid #1e293b", borderRadius:6, padding:"6px 14px", textAlign:"center" }}>
                    <div style={{ fontSize:8, color:"#64748b" }}>NEXT VISIT</div>
                    <div style={{ fontSize:18, fontWeight:800 }}>{conData.follow_up.duration?.toUpperCase()}</div>
                  </div>
                  <div><div style={{ fontSize:11, fontWeight:600, marginBottom:2 }}>Please bring these reports:</div><div style={{ display:"flex", flexWrap:"wrap", gap:2 }}>{(conData.follow_up.tests_to_bring||[]).map((t,i) => <span key={i} style={{ background:"white", border:"1px solid #e2e8f0", borderRadius:3, padding:"1px 5px", fontSize:10, fontWeight:600 }}>{t}</span>)}</div></div>
                </div>}

                {/* Future Plan */}
                {sa(conData,"future_plan").length>0 && <Section title="📋 Future Plan" color="#7c3aed">
                  {sa(conData,"future_plan").map((fp,i) => <div key={i} style={{ fontSize:11, padding:"2px 0" }}><strong>If</strong> {fp.condition} → {fp.action}</div>)}
                </Section>}

                {/* Footer */}
                <div style={{ borderTop:"2px solid #1e293b", paddingTop:6, display:"flex", justifyContent:"space-between", fontSize:10, color:"#94a3b8" }}>
                  <div>{conName} | MO: {moName} | 📞 0172-4120100</div>
                  <div>Gini Clinical Scribe v1</div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}} @media print{button{display:none!important}}`}</style>
    </div>
  );
}
