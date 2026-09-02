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
  // What the PERSON asked for, as opposed to what the recogniser is doing.
  // Chrome ends a `continuous` session by itself after a pause, and without
  // this the button silently flipped back to "start" while the user thought
  // they were still dictating — so their next click restarted it instead of
  // stopping it, and it took two clicks to stop.
  const wantRef = useRef(false);
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
    // Never two recognisers at once: the second would overwrite the first's ref
    // and leave it running with nothing able to stop it.
    if (recognitionRef.current) return;
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
      // A pause in dictation is not a failure. Chrome raises `no-speech` when
      // somebody stops to think, and reporting that as an error — then dropping
      // out of listening — is what made the control feel broken.
      if (e.error === "no-speech" || e.error === "aborted") return;
      wantRef.current = false;
      setError(
        e.error === "not-allowed"
          ? "Microphone permission was refused."
          : "Speech recognition failed — type it instead.",
      );
    };
    recognition.onend = () => {
      // Still wanted: Chrome ended the session on its own, so start another and
      // keep the transcript accumulating. The person has not pressed Stop.
      if (wantRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* fall through and end honestly rather than pretend to listen */
        }
      }
      recognitionRef.current = null;
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
    wantRef.current = true;
    return SpeechRecognition ? startLive() : startBatch();
  }, [startLive, startBatch]);

  const stop = useCallback(() => {
    // Recorded first, so `onend` knows this was deliberate and does not restart.
    wantRef.current = false;
    if (recognitionRef.current) {
      // `onend` clears the ref and publishes; the state is set here too so the
      // button responds to the click rather than to the recogniser's callback.
      setListening(false);
      recognitionRef.current.stop();
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
      wantRef.current = false;
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
