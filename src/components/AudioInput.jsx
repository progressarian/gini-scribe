import { useState, useRef, useEffect } from "react";
import {
  transcribeDeepgram,
  transcribeWhisper,
  cleanupTranscript,
  getDeepgramKey,
} from "../services/transcription.js";
import "./AudioInput.css";

export default function AudioInput({ onTranscript, dgKey, whisperKey, label, color, compact }) {
  const [mode, setMode] = useState(null); // null, recording, cleaning, recorded, transcribing, done
  const [transcript, setTranscript] = useState("");
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [lang, setLang] = useState("en");
  const [engine, setEngine] = useState(dgKey ? "deepgram" : "whisper");
  const [useCleanup, setUseCleanup] = useState(true);
  const [using, setUsing] = useState(false);
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
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const doTranscribe = async (blob) => {
    if (engine === "whisper" && whisperKey) {
      return await transcribeWhisper(blob, whisperKey, lang);
    }
    return await transcribeDeepgram(blob, dgKey, lang);
  };

  // Streaming recording with Deepgram WebSocket + raw PCM via AudioContext
  const startStreamingRec = async () => {
    setError("");
    setLiveText("");
    setTranscript("");
    finalsRef.current = [];
    interimRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000 },
      });
      streamRef.current = stream;

      // Also start MediaRecorder to save audio for playback
      const mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      mediaRec.current = rec;
      rec.start(1000);

      // AudioContext to get raw PCM for WebSocket
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Open Deepgram WebSocket — fetch key from server
      const wsLang = lang === "hi" ? "hi" : "en";
      const serverDgKey = await getDeepgramKey();
      if (!serverDgKey) {
        setError("Deepgram key not available");
        cleanupStreaming();
        setMode(null);
        return;
      }
      const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${wsLang}&smart_format=true&punctuate=true&interim_results=true&encoding=linear16&sample_rate=16000&channels=1`;
      const ws = new WebSocket(wsUrl, ["token", serverDgKey]);
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
        } catch (err) {}
      };

      ws.onerror = () => {
        setError("Streaming failed \u2014 try Upload instead");
        cleanupStreaming();
        setMode("recorded");
      };

      ws.onclose = async () => {
        const finalText = finalsRef.current.filter(Boolean).join(" ");
        if (finalText) {
          // Save recording blob for playback
          if (mediaRec.current?.state !== "inactive") mediaRec.current?.stop();
          await new Promise((r) => setTimeout(r, 200)); // Wait for MediaRecorder to flush
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
          setError("No speech detected \u2014 try again or speak louder");
          setMode(null);
        }
      };

      setMode("recording");
      setDuration(0);
      tmr.current = setInterval(() => setDuration((d) => d + 1), 1000);
    } catch (err) {
      setError("Mic access denied. Use Upload or paste text.");
    }
  };

  const cleanupStreaming = () => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (err) {}
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch (err) {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
  };

  // Non-streaming fallback (also used for Whisper engine and file uploads)
  const startNonStreamingRec = async (existingStream, mt) => {
    try {
      const stream =
        existingStream ||
        (await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, sampleRate: 16000 },
        }));
      if (!mt)
        mt = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mt, audioBitsPerSecond: 32000 });
      chunks.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data);
      };
      rec.onstop = async () => {
        const blob = new Blob(chunks.current, { type: mt });
        audioBlob.current = blob;
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
        setMode("transcribing");
        try {
          let text = await doTranscribe(blob);
          if (!text) throw new Error("Empty \u2014 try again or speak louder");
          if (useCleanup) {
            setMode("cleaning");
            text = await cleanupTranscript(text);
          }
          setTranscript(text);
          setMode("done");
        } catch (err) {
          setError(err.message);
          setMode("recorded");
        }
      };
      mediaRec.current = rec;
      rec.start(1000);
      if (!existingStream) {
        setMode("recording");
        setDuration(0);
        tmr.current = setInterval(() => setDuration((d) => d + 1), 1000);
      }
    } catch (err) {
      setError("Mic access denied. Use Upload or paste text.");
    }
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
      setTimeout(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
      }, 500);
    }
  };

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    audioBlob.current = f;
    setAudioUrl(URL.createObjectURL(f));
    setMode("recorded");
    setError("");
  };
  const transcribe = async () => {
    if (!audioBlob.current) return;
    setMode("transcribing");
    setError("");
    try {
      let text = await doTranscribe(audioBlob.current);
      if (!text) throw new Error("Empty \u2014 try again or paste manually");
      if (useCleanup) {
        setMode("cleaning");
        text = await cleanupTranscript(text);
      }
      setTranscript(text);
      setMode("done");
    } catch (err) {
      setError(err.message);
      setMode("recorded");
    }
  };
  const reset = () => {
    setMode(null);
    setTranscript("");
    setLiveText("");
    setAudioUrl(null);
    audioBlob.current = null;
    setError("");
    setDuration(0);
    finalsRef.current = [];
    interimRef.current = "";
    cleanupStreaming();
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.close();
  };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const containerClass = `audio-input ${mode === "recording" ? "audio-input--recording" : mode === "cleaning" ? "audio-input--cleaning" : "audio-input--default"} ${compact ? "audio-input--compact" : "audio-input--full"}`;

  return (
    <div className={containerClass}>
      <div className="audio-input__header">
        <div
          className={`audio-input__label ${compact ? "audio-input__label--compact" : "audio-input__label--full"}`}
        >
          🎤 {label}
        </div>
        <div className="audio-input__controls">
          {whisperKey && dgKey && (
            <div className="audio-input__engine-toggle">
              {[
                { v: "deepgram", l: "DG" },
                { v: "whisper", l: "W" },
              ].map((x) => (
                <button
                  key={x.v}
                  onClick={() => setEngine(x.v)}
                  className={`audio-input__engine-btn ${engine === x.v ? "audio-input__engine-btn--active" : "audio-input__engine-btn--inactive"}`}
                >
                  {x.l}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setUseCleanup((c) => !c)}
            className={`audio-input__cleanup-btn ${useCleanup ? "audio-input__cleanup-btn--on" : "audio-input__cleanup-btn--off"}`}
            title="AI cleanup of medical terms"
          >
            AI{"\u2713"}
          </button>
          <div className="audio-input__lang-group">
            {[
              { v: "en", l: "EN" },
              { v: "hi", l: "HI" },
            ].map((x) => (
              <button
                key={x.v}
                onClick={() => setLang(x.v)}
                className="audio-input__lang-btn"
                style={{
                  background: lang === x.v ? color : "white",
                  color: lang === x.v ? "white" : "#94a3b8",
                  border: `1px solid ${lang === x.v ? color : "#e2e8f0"}`,
                }}
              >
                {x.l}
              </button>
            ))}
          </div>
        </div>
      </div>
      {!mode && (
        <>
          <div className="audio-input__actions">
            <button
              onClick={startRec}
              className={`audio-input__record-btn ${compact ? "audio-input__record-btn--compact" : "audio-input__record-btn--full"}`}
            >
              🔴 Record
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className={`audio-input__upload-btn ${compact ? "audio-input__upload-btn--compact" : "audio-input__upload-btn--full"}`}
              style={{ background: color }}
            >
              📁 Upload
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.ogg,.mp3,.wav,.m4a,.webm"
              onChange={handleFile}
              className="audio-input__file-input"
            />
          </div>
          <textarea
            placeholder="Or paste transcript here and click outside..."
            onBlur={(e) => {
              if (e.target.value.trim()) {
                setTranscript(e.target.value.trim());
                setMode("done");
              }
            }}
            className={`audio-input__paste-area ${compact ? "audio-input__paste-area--compact" : "audio-input__paste-area--full"}`}
          />
        </>
      )}
      {mode === "recording" && (
        <div>
          <div className="audio-input__recording-bar">
            <div className="audio-input__timer">
              <span className="audio-input__pulse-dot" />
              {fmt(duration)}
            </div>
            <button onClick={stopRec} className="audio-input__stop-btn">
              {"\u23F9"} Stop
            </button>
          </div>
          {liveText && (
            <div className="audio-input__live-text">
              {liveText}
              <span className="audio-input__cursor" />
            </div>
          )}
          {!liveText && <div className="audio-input__listening">🎙️ Listening... speak now</div>}
        </div>
      )}
      {mode === "cleaning" && (
        <div className="audio-input__cleaning">
          <div className="audio-input__cleaning-icon">{"\u2728"}</div>
          <div className="audio-input__cleaning-text">Fixing medical terms...</div>
        </div>
      )}
      {mode === "recorded" && (
        <div>
          <div className="audio-input__recorded-controls">
            <audio src={audioUrl} controls className="audio-input__audio-player" />
            <button onClick={reset} className="audio-input__clear-btn">
              {"\u2715"}
            </button>
          </div>
          <button
            onClick={transcribe}
            className="audio-input__transcribe-btn"
            style={{ background: color }}
          >
            🔊 Transcribe
          </button>
        </div>
      )}
      {mode === "transcribing" && (
        <div className="audio-input__transcribing">
          <div className="audio-input__transcribing-icon">🔊</div>
          <div className="audio-input__transcribing-text">Transcribing...</div>
        </div>
      )}
      {mode === "done" && (
        <div>
          <div className="audio-input__done-header">
            <span className="audio-input__done-label">{"\u2705"} Ready</span>
            <button onClick={reset} className="audio-input__redo-btn">
              Redo
            </button>
          </div>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            ref={(el) => {
              if (el) {
                el.style.height = "auto";
                el.style.height = Math.max(100, el.scrollHeight) + "px";
              }
            }}
            className="audio-input__transcript-area"
          />
          <button
            onClick={async () => {
              if (transcript && !using) {
                setUsing(true);
                try {
                  await onTranscript(transcript);
                } catch {}
                setUsing(false);
              }
            }}
            disabled={using}
            className="audio-input__use-btn"
          >
            {using ? "\u23F3 Processing..." : "\u2705 Use This"}
          </button>
        </div>
      )}
      {error && (
        <div className="audio-input__error">
          {"\u26A0\uFE0F"} {error}
        </div>
      )}
    </div>
  );
}
