import useAuthStore from "../stores/authStore.js";
import useUiStore from "../stores/uiStore.js";
import useClinicalStore from "../stores/clinicalStore.js";
import AudioInput from "../components/AudioInput.jsx";
import "./QuickPage.css";

export default function QuickPage() {
  const { dgKey, whisperKey } = useAuthStore();
  const { loading, errors } = useUiStore();
  const { quickTranscript, quickProgress, processQuickMode } = useClinicalStore();

  return (
    <div>
      <div className="quick__header">
        <div className="quick__title">⚡ Quick Dictation</div>
        <div className="quick__desc">
          Dictate everything in one go — patient, history, vitals, meds, plan. AI splits it into all
          sections automatically.
        </div>
      </div>

      <AudioInput
        onTranscript={processQuickMode}
        dgKey={dgKey}
        whisperKey={whisperKey}
        label="🎙️ Full Consultation — dictate everything at once"
        color="#dc2626"
      />

      {loading.quick && (
        <div className="quick__loading">
          <div className="quick__loading-icon">⚡</div>
          <div className="quick__loading-text">{quickProgress || "Processing..."}</div>
          <div className="quick__loading-hint">
            Running 2 parallel AI calls (Haiku = 3-5x faster)
          </div>
          <div className="quick__loading-badges">
            <div className="quick__loading-badge quick__loading-badge--extract">📋 Extract</div>
            <div className="quick__loading-badge quick__loading-badge--plan">📝 Plan</div>
          </div>
        </div>
      )}

      {errors.quick && (
        <div className="quick__error">
          <div className="quick__error-text">⚠️ {errors.quick}</div>
        </div>
      )}

      {quickTranscript && !loading.quick && (
        <div className="quick__transcript">
          <div className="quick__transcript-label">RAW TRANSCRIPT</div>
          <div className="quick__transcript-text">{quickTranscript}</div>
        </div>
      )}

      <div className="quick__tips">
        <div className="quick__tips-title">💡 Tips for best results:</div>
        <div className="quick__tips-text">
          Start with patient name and demographics, then history and current medications, then
          today's vitals and lab results, then the plan — new medicines, lifestyle advice,
          follow-up.
        </div>
      </div>

      <div className="quick__footer">Or use individual tabs → for step-by-step entry</div>
    </div>
  );
}
