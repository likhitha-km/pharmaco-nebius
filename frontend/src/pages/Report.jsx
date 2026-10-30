import { useState, useEffect } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Shield, CheckCircle, Phone } from 'lucide-react';
import { ConversationWindow } from '../components/conversation/ConversationWindow.jsx';
import { CompletenessScore } from '../components/report/CompletenessScore.jsx';
import { useConversation, ACTIVE_CONVERSATION_KEY } from '../hooks/useConversation.js';
import { useLanguageContext } from '../context/LanguageContext.jsx';
import { useReportProgress } from '../hooks/useReportProgress.js';
import { LANGUAGES } from '../utils/i18n.js';
import { adrApi } from '../utils/api.js';
import { Cpu, FileText as FileTextIcon, FlaskConical } from 'lucide-react';

export default function Report() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { language, setLanguage } = useLanguageContext();
  const [userType, setUserType] = useState('patient');
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [started, setStarted] = useState(false);

  const {
    startConversation,
    hydrateConversation,
    conversationId,
    extractedData,
    completenessScore,
    isReportReady,
    changeLanguage,
    changeUserType,
    changeAnonymous,
    fieldStatus,
    sendMessage,
    isLoading,
  } = useConversation();
  const [modelInfo, setModelInfo] = useState(null);
  const [demo, setDemo] = useState({ active: false, turns: [], index: 0 });

  useEffect(() => {
    adrApi.status().then(({ data }) => setModelInfo(data)).catch(() => setModelInfo(null));
  }, []);

  const startSyntheticDemo = async () => {
    const { data } = await adrApi.demoScenario();
    setLanguage('en-IN');
    await startConversation('patient', 'en-IN', true, true);
    setDemo({ active: true, turns: data.turns, index: 0 });
  };

  const sendNextDemoTurn = async () => {
    if (!demo.active || demo.index >= demo.turns.length || isLoading) return;
    const turn = demo.turns[demo.index];
    setDemo((d) => ({ ...d, index: d.index + 1 }));
    await sendMessage(turn);
  };

  const canGenerate = !!(extractedData?.suspected_medicines?.length && extractedData?.adverse_reactions?.length);
  const progress = useReportProgress(extractedData);

  useEffect(() => {
    const initConversation = async () => {
      if (started || conversationId) return;
      setStarted(true);

      // Resume an in-progress conversation after a refresh instead of
      // silently starting a new one and orphaning the old chat history.
      // "?new=true" (used by "New Report" in My Reports) skips this.
      const forceNew = searchParams.get('new') === 'true';
      let storedId = null;
      if (!forceNew) {
        try { storedId = localStorage.getItem(ACTIVE_CONVERSATION_KEY); } catch { /* ignore */ }
      }

      if (storedId) {
        const restored = await hydrateConversation(storedId);
        // Stale, deleted, or already-submitted — don't resurrect it.
        if (!restored || restored.status === 'completed') {
          try { localStorage.removeItem(ACTIVE_CONVERSATION_KEY); } catch { /* ignore */ }
          await startConversation(userType, language, isAnonymous);
        }
        return;
      }

      await startConversation(userType, language, isAnonymous);
    };
    initConversation();
  }, [started, conversationId]);

  const handleReportReady = () => {
    if (conversationId) navigate(`/report/review/${conversationId}`);
  };

  return (
    <ErrorBoundary>
    <main className="page-content" style={{ height: 'calc(100vh - 72px)', display: 'flex', overflow: 'hidden' }}>
      {/* Left sidebar */}
      <aside style={{
        width: 300, flexShrink: 0, borderRight: '1px solid var(--color-border)',
        overflowY: 'auto', padding: '24px 20px', display: 'flex', flexDirection: 'column', gap: 24,
        background: 'var(--color-surface)',
      }}
        aria-label="Report settings sidebar"
      >
        {/* Language selector */}
        <div>
          <label htmlFor="lang-select" style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>
            Language
          </label>
          <select
            id="lang-select"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              changeLanguage(e.target.value);
            }}
            className="input"
            style={{ height: 44 }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.native} — {l.label}</option>
            ))}
          </select>
        </div>

        {/* User type toggle */}
        <div>
          <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>I am a</p>
          <div style={{ display: 'flex', gap: 8 }}>
            {[{ value: 'patient', label: 'Patient' }, { value: 'healthcare_professional', label: 'Healthcare Professional' }].map(({ value, label }) => (
              <button
                key={value}
                onClick={() => {
                  setUserType(value);
                  changeUserType(value);
                }}
                style={{
                  flex: 1, padding: '10px 8px', borderRadius: 'var(--radius-md)', fontSize: 13, fontWeight: 500,
                  background: userType === value ? 'var(--color-primary)' : 'var(--color-surface-secondary)',
                  color: userType === value ? '#fff' : 'var(--color-text-secondary)',
                  border: `1px solid ${userType === value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                  cursor: 'pointer', transition: 'all 0.2s',
                }}
                aria-pressed={userType === value}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Anonymous toggle */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(e) => {
              setIsAnonymous(e.target.checked);
              changeAnonymous(e.target.checked);
            }}
            style={{ width: 16, height: 16, accentColor: 'var(--color-primary)', cursor: 'pointer' }}
            aria-label="Report anonymously"
          />
          <span style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>Report anonymously</span>
        </label>

        {/* Report progress */}
        <div>
          <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
            Report Progress
          </p>
          {extractedData ? (
            <CompletenessScore score={completenessScore || progress.percentage} fields={progress.fields} />
          ) : (
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Start the conversation to track progress</p>
          )}
          {progress.fields.length > 0 && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {progress.fields.map((f) => (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CheckCircle
                    size={14}
                    color={f.filled ? '#10B981' : '#E5E7EB'}
                    aria-hidden="true"
                  />
                  <span style={{ fontSize: 12, color: f.filled ? 'var(--color-text-primary)' : 'var(--color-text-muted)', fontWeight: f.required ? 500 : 400 }}>
                    {f.label}{f.required ? ' *' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ADR agent: what has been collected, what is missing, and next step */}
        <div id="adr-agent-panel">
          <p style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Cpu size={13} aria-hidden="true" /> ADR agent
          </p>
          <p style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
            {modelInfo?.configured === false
              ? 'AI model not configured on the server.'
              : <>Powered by <strong>NVIDIA Nemotron</strong> on <strong>Nebius Token Factory</strong>.</>}
          </p>
          {fieldStatus ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {fieldStatus.map((f) => {
                const color = f.status === 'provided' ? '#047857' : f.status === 'negative' ? '#4B5563' : f.required ? '#B91C1C' : '#B45309';
                const mark = f.status === 'provided' ? '✓' : f.status === 'negative' ? '✕' : '?';
                const text = f.status === 'provided' ? 'provided' : f.status === 'negative' ? 'stated: no / not applicable' : 'not yet provided';
                return (
                  <div key={f.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }} title={text}>
                    <span style={{ width: 14, color, fontWeight: 700 }} aria-hidden="true">{mark}</span>
                    <span style={{ color: f.status === 'missing' ? 'var(--color-text-secondary)' : 'var(--color-text-primary)' }}>{f.label}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10, color }}>{text}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Details appear here as you describe the reaction.</p>
          )}
          <button
            className="btn btn-primary"
            id="adr-generate-report"
            style={{ width: '100%', marginTop: 14 }}
            disabled={!canGenerate || !conversationId}
            onClick={handleReportReady}
            aria-label="Generate ADR report"
          >
            <FileTextIcon size={16} aria-hidden="true" /> Generate ADR report
          </button>
          {!canGenerate && <p style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 6 }}>Needs at least a medicine and a reaction.</p>}
        </div>

        {/* Synthetic demo helper */}
        <div style={{ padding: 12, border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-md)' }}>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            <FlaskConical size={12} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Try it with a <strong>synthetic (fictional) patient</strong>. Only the patient's messages are scripted; the agent's questions and analysis are generated live.
          </p>
          {!demo.active ? (
            <button className="btn btn-outline btn-sm" id="adr-demo-start" style={{ width: '100%' }} onClick={startSyntheticDemo}>Start synthetic patient</button>
          ) : demo.index < demo.turns.length ? (
            <button className="btn btn-outline btn-sm" id="adr-demo-next" style={{ width: '100%' }} onClick={sendNextDemoTurn} disabled={isLoading}>
              Send synthetic patient message {demo.index + 1} of {demo.turns.length}
            </button>
          ) : (
            <p style={{ fontSize: 11, color: 'var(--color-text-secondary)', margin: 0 }}>All synthetic messages sent. Generate the report above.</p>
          )}
        </div>

        {/* Emergency contacts */}
        <div style={{ padding: 16, background: '#FEF2F2', borderRadius: 'var(--radius-md)', border: '1px solid #FCA5A5' }}>
          <p style={{ fontWeight: 600, fontSize: 13, color: '#DC2626', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Phone size={14} aria-hidden="true" /> Emergency Contacts
          </p>
          <p style={{ fontSize: 12, color: '#7F1D1D' }}>National Helpline: <strong>1800-180-3024</strong></p>
          <p style={{ fontSize: 11, color: '#B91C1C', marginTop: 4 }}>Toll free, 9AM-5:30PM weekdays</p>
          <a href="tel:112" style={{ display: 'block', marginTop: 8, fontSize: 14, fontWeight: 700, color: '#DC2626' }}>
            Emergency: 112
          </a>
        </div>
      </aside>

      {/* Main chat window */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Top bar */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 12, background: 'var(--color-surface)' }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={18} color="#fff" aria-hidden="true" />
          </div>
          <div>
            <p style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>Pharmaco Assistant</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} aria-hidden="true" />
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Online</span>
              <span style={{ padding: '1px 8px', background: 'var(--color-primary-light)', color: 'var(--color-primary)', borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 500, marginLeft: 8 }}>
                {LANGUAGES.find((l) => l.code === language)?.native || language}
              </span>
            </div>
          </div>
        </div>

        <ConversationWindow
          language={language}
          userType={userType}
          onReportReady={handleReportReady}
        />
      </div>
    </main>
    </ErrorBoundary>
  );
}
