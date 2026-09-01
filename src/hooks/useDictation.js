import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeDeepgram } from "../services/transcription";

// Dictation for the station screens, in two modes.
//
// Live (preferred): the browser's SpeechRecognition streams interim words as
// they are spoken, so the person watches a caption build and sees a mishearing
// immediately rather than after pressing Stop. Chrome and Edge have it.
//
// Batch (fallback): record, then transcribe through the server's existing
// /api/ai/transcribe (Deepgram) on stop. No caption — the browser gives nothing
// to caption with — so the interface says so rather than looking broken.
//
// Note on processors: live mode uses the browser's own recogniser, which in
// Chrome means Google. Batch mode uses Deepgram, already this app's engine for
// consultations. A second processor is worth a deliberate decision before this
// reaches the floor.

const SpeechRecognition =
  typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

export const hasLiveCaptions = !!SpeechRecognition;

export function useDictation({ onTranscript } = {}) {
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");

  const recognitionRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const finalRef = useRef("");
  const captionRef = useRef("");
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const publish = useCallback((text) => {
    const spoken = text.trim();
    if (spoken) onTranscriptRef.current?.(spoken);
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startLive = useCallback(() => {
    const recognition = new SpeechRecognition();
    recognition.lang = "en-IN";
    recognition.continuous = true;
    recognition.interimResults = true;

    finalRef.current = "";
    captionRef.current = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const chunk = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalRef.current += chunk + " ";
        else interim += chunk;
      }
      captionRef.current = (finalRef.current + interim).trim();
      setCaption(captionRef.current);
    };
    recognition.onerror = (e) => {
      setError(
        e.error === "not-allowed"
          ? "Microphone permission was refused."
          : e.error === "no-speech"
            ? "Nothing was heard."
            : "Speech recognition failed — type it instead.",
      );
      setListening(false);
    };
    recognition.onend = () => {
      setListening(false);
      publish(finalRef.current || captionRef.current);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [publish]);

  const startBatch = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio — type it instead.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stopTracks();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (!blob.size) return setError("Nothing was recorded.");
        setBusy(true);
        try {
          const transcript = await transcribeDeepgram(blob, null, "en");
          setCaption(transcript);
          publish(transcript);
        } catch (e) {
          setError(e?.response?.data?.error || e.message || "Could not transcribe that.");
        } finally {
          setBusy(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setListening(true);
    } catch {
      setError("Microphone permission was refused.");
      stopTracks();
    }
  }, [publish]);

  const start = useCallback(() => {
    setError("");
    setCaption("");
    captionRef.current = "";
    return SpeechRecognition ? startLive() : startBatch();
  }, [startLive, startBatch]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
      return;
    }
    setListening(false);
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else stopTracks();
  }, []);

  const toggle = useCallback(() => (listening ? stop() : start()), [listening, start, stop]);

  // A station screen is left open all day; never leave the microphone live.
  useEffect(
    () => () => {
      recognitionRef.current?.abort?.();
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      stopTracks();
    },
    [],
  );

  const clear = useCallback(() => {
    setCaption("");
    setError("");
  }, []);

  return { listening, busy, caption, error, start, stop, toggle, clear, live: hasLiveCaptions };
}
