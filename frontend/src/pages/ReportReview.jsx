import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CheckCircle, Download, FileText, ArrowLeft, AlertTriangle, Pencil, Save, X, Sparkles, Loader } from 'lucide-react';
import { TimelineViz } from '../components/report/TimelineViz.jsx';
import { CompletenessScore } from '../components/report/CompletenessScore.jsx';
import { ICSRReport } from '../components/report/ICSRReport.jsx';
import { ConfidenceScore } from '../components/report/ConfidenceScore.jsx';
import { AdrAgentReport } from '../components/report/AdrAgentReport.jsx';
import { conversationApi, reportApi } from '../utils/api.js';
import { useConversation } from '../hooks/useConversation.js';
import { useReportProgress } from '../hooks/useReportProgress.js';
import { exportReportPdf } from '../utils/pdfExport.js';
import { showToast } from '../components/common/Toast.jsx';

const DECHALLENGE_OPTIONS = [
  { value: '', label: 'Not noted' },
  { value: 'positive', label: 'Yes — improved after stopping' },
  { value: 'negative', label: 'No — did not improve' },
  { value: 'unknown', label: 'Unknown / not applicable' },
];

function inputStyle() {
  return {
    width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm, 6px)',
    border: '1px solid var(--color-border)', fontSize: 14, fontFamily: 'var(--font-body)',
    background: 'var(--color-surface)', color: 'var(--color-text-primary)',
  };
}

function EditField({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, color: 'var(--color-text-muted)', fontWeight: 500, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

/** Builds a fresh, deep-cloned extractedData object with only the edited
 * leaf fields overwritten — everything else the conversation collected
 * (other reactions, metadata, etc.) is preserved untouched. */
function applyEditsToExtractedData(extractedData, form) {
  const next = extractedData ? JSON.parse(JSON.stringify(extractedData)) : {};
  next.suspected_medicines = Array.isArray(next.suspected_medicines) ? next.suspected_medicines : [];
  next.adverse_reactions = Array.isArray(next.adverse_reactions) ? next.adverse_reactions : [];
  next.patient = next.patient || {};
  next.clinical_context = next.clinical_context || {};
  next.causality_signals = next.causality_signals || {};

  next.suspected_medicines[0] = { ...(next.suspected_medicines[0] || {}), name: form.medicine, dosage: form.dosage, frequency: form.frequency };
  next.adverse_reactions[0] = {
    ...(next.adverse_reactions[0] || {}),
    original_text: form.reaction,
    english_translation: form.reaction,
    onset_date: form.onset,
  };
  next.patient = { ...next.patient, initials: form.initials || null, age_group: form.ageGroup || null, gender: form.gender || null };
  next.clinical_context = {
    ...next.clinical_context,
    reason_for_taking: form.indication || null,
    outcome: form.outcome || null,
    concomitant_medications: form.concomitantMedications
      ? form.concomitantMedications.split(',').map((m) => m.trim()).filter(Boolean)
      : [],
  };
  next.causality_signals = { ...next.causality_signals, dechallenge: form.dechallenge || 'unknown' };

  return next;
}

function extractedDataToForm(extractedData) {
  const med = extractedData?.suspected_medicines?.[0] || {};
  const reaction = extractedData?.adverse_reactions?.[0] || {};
  const patient = extractedData?.patient || {};
  const clinical = extractedData?.clinical_context || {};
  const causality = extractedData?.causality_signals || {};
  return {
    medicine: med.name || '',
    dosage: med.dosage || '',
    frequency: med.frequency || '',
    reaction: reaction.original_text || reaction.english_translation || '',
    onset: reaction.onset_date || '',
    indication: clinical.reason_for_taking || '',
    outcome: clinical.outcome || '',
    dechallenge: causality.dechallenge && causality.dechallenge !== 'unknown' ? causality.dechallenge : '',
    concomitantMedications: (clinical.concomitant_medications || []).join(', '),
    initials: patient.initials || '',
    ageGroup: patient.age_group || '',
    gender: patient.gender || '',
  };
}

export default function ReportReview() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const {
    extractedData, meddraData, completenessScore, endConversation, hydrateConversation,
    resetConversation, saveFieldEdits, generateDraftReport, language, isAnonymous,
  } = useConversation();
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [reportId, setReportId] = useState(null);
  const [draftMessage, setDraftMessage] = useState('');
  const [icsr, setIcsr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [savingEdits, setSavingEdits] = useState(false);
  const [generatingDraft, setGeneratingDraft] = useState(false);
  const progress = useReportProgress(extractedData);

  useEffect(() => {
    if (!conversationId) return;
    if (!extractedData) {
      setLoading(true);
      hydrateConversation(conversationId).finally(() => setLoading(false));
    }
  }, [conversationId, extractedData, hydrateConversation]);

  const startEditing = () => {
    setEditForm(extractedDataToForm(extractedData));
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditForm(null);
  };

  const updateField = (key, value) => setEditForm((prev) => ({ ...prev, [key]: value }));

  const handleSaveEdits = async () => {
    if (!editForm) return;
    setSavingEdits(true);
    try {
      const next = applyEditsToExtractedData(extractedData, editForm);
      await saveFieldEdits(next);
      setEditing(false);
      setEditForm(null);
      showToast('Your corrections have been saved.', 'success');
    } catch (err) {
      console.error('Save edits error:', err);
      showToast('Could not save your changes. Please try again.', 'error');
    } finally {
      setSavingEdits(false);
    }
  };

  const handleGenerateDraft = async () => {
    setGeneratingDraft(true);
    try {
      const data = await generateDraftReport();
      if (data?.icsr) {
        setIcsr(data.icsr);
        showToast('Draft report generated.', 'success');
      }
    } catch (err) {
      console.error('Generate draft error:', err);
      showToast('Could not generate the draft report right now.', 'error');
    } finally {
      setGeneratingDraft(false);
    }
  };

  const handleSaveDraft = async () => {
    setSavingDraft(true);
    setDraftMessage('');
    try {
      const result = await reportApi.saveDraft({
        conversationId,
        extractedData,
        icsr,
        completenessScore: completenessScore || progress.percentage,
        isAnonymous,
        language,
      });

      if (result.data?.reportId) {
        setReportId(result.data.reportId);
        setDraftMessage(result.data.message || `Draft saved as ${result.data.reportId}`);
      }
    } catch (err) {
      console.error('Draft save error:', err);
      setDraftMessage('Could not save draft right now.');
    } finally {
      setSavingDraft(false);
    }
  };

  const handleSubmit = async () => {
    if (!consent) return;
    setSubmitting(true);
    try {
      const result = await endConversation();
      if (result) {
        setReportId(result.reportId);
        setIcsr(result.report);
        setSubmitted(true);
        resetConversation();
      }
    } catch (err) {
      console.error('Submit error:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <main className="page-content">
        <div className="container" style={{ maxWidth: 600, margin: '80px auto', textAlign: 'center' }}>
          <div style={{ width: 80, height: 80, borderRadius: '50%', background: '#ECFDF5', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px' }}>
            <CheckCircle size={40} color="#10B981" aria-hidden="true" />
          </div>
          <h1 className="text-h1" style={{ marginBottom: 16, color: '#059669' }}>Report Submitted!</h1>
          <p className="text-body-lg" style={{ marginBottom: 8 }}>Thank you for contributing to India's medicine safety.</p>
          <div style={{ padding: 16, background: 'var(--color-surface-secondary)', borderRadius: 'var(--radius-md)', marginBottom: 32 }}>
            <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 4 }}>Your Report ID</p>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--color-primary)', fontWeight: 600 }}>{reportId || icsr?.report_id}</p>
          </div>
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => navigate('/')} aria-label="Return to home">Return Home</button>
            <button className="btn btn-outline" onClick={() => navigate('/my-reports')} aria-label="Track my report">Track My Report</button>
          </div>
        </div>
      </main>
    );
  }

  const med = extractedData?.suspected_medicines?.[0];
  const reactions = extractedData?.adverse_reactions || [];
  const causality = meddraData?.causality_assessment;
  const causalityColors = { Certain: '#059669', 'Probable/Likely': '#0EA5E9', Probable: '#0EA5E9', Possible: '#D97706', Unlikely: '#EF4444' };
  const clinical = extractedData?.clinical_context || {};
  const patient = extractedData?.patient || {};
  const hasAdditionalInfo = clinical.reason_for_taking || clinical.outcome || (clinical.concomitant_medications || []).length > 0
    || (extractedData?.causality_signals?.dechallenge && extractedData.causality_signals.dechallenge !== 'unknown')
    || patient.initials || patient.age_group || patient.gender;

  // Build timeline events
  const timelineEvents = [];
  if (med?.start_date) timelineEvents.push({ date: med.start_date, label: `${med.name} started`, type: 'medicine' });
  reactions.forEach((r) => {
    if (r.onset_date) timelineEvents.push({ date: r.onset_date, label: 'Reaction began', type: 'reaction', severity: r.severity });
  });
  if (extractedData?.clinical_context?.outcome) timelineEvents.push({ date: 'Recent', label: extractedData.clinical_context.outcome, type: 'recovery' });

  return (
    <main className="page-content">
      <div className="container" style={{ maxWidth: 1200, padding: '40px 24px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32, flexWrap: 'wrap', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="btn btn-ghost btn-icon" onClick={() => navigate(-1)} aria-label="Go back">
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="text-h2">Review Your Report</h1>
              <p className="text-body">Verify information before submitting to PvPI</p>
            </div>
          </div>
          {!editing ? (
            <button className="btn btn-outline" onClick={startEditing} disabled={!extractedData} aria-label="Edit report fields">
              <Pencil size={16} aria-hidden="true" /> Edit Fields
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={cancelEditing} disabled={savingEdits} aria-label="Cancel editing">
                <X size={16} aria-hidden="true" /> Cancel
              </button>
              <button className="btn btn-primary" onClick={handleSaveEdits} disabled={savingEdits} aria-label="Save edited fields">
                <Save size={16} aria-hidden="true" /> {savingEdits ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 32, alignItems: 'flex-start' }}>
          {/* Left — Report content */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Agent-generated structured ADR report (Nemotron via Nebius Token Factory) */}
            {conversationId && (
              <AdrAgentReport conversationId={conversationId} onReport={() => hydrateConversation(conversationId)} />
            )}

            {/* AI-generated draft, once requested */}
            {icsr && (
              <div className="card" style={{ padding: 24, borderColor: 'var(--color-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Sparkles size={18} color="var(--color-primary)" aria-hidden="true" />
                  <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, margin: 0 }}>AI-Generated Draft Report</h2>
                </div>
                <p style={{ fontSize: 13, color: 'var(--color-text-muted)', marginBottom: 16 }}>
                  Generated from the information collected so far. Nothing here has been submitted yet — review it, edit fields above if anything is wrong, then save or submit when ready.
                </p>
                <ICSRReport report={icsr} />
              </div>
            )}

            {/* Medicine */}
            {editing ? (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Medicine</h2>
                <EditField label="Medicine">
                  <input style={inputStyle()} value={editForm.medicine} onChange={(e) => updateField('medicine', e.target.value)} placeholder="e.g. Augmentin" />
                </EditField>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <EditField label="Strength / Dose">
                    <input style={inputStyle()} value={editForm.dosage} onChange={(e) => updateField('dosage', e.target.value)} placeholder="e.g. 625mg" />
                  </EditField>
                  <EditField label="Frequency">
                    <input style={inputStyle()} value={editForm.frequency} onChange={(e) => updateField('frequency', e.target.value)} placeholder="e.g. once a day" />
                  </EditField>
                </div>
                <EditField label="Indication (reason for taking)">
                  <input style={inputStyle()} value={editForm.indication} onChange={(e) => updateField('indication', e.target.value)} placeholder="e.g. throat infection" />
                </EditField>
              </div>
            ) : med && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Medicine</h2>
                {[
                  ['Drug Name', med.name],
                  ['Dosage', med.dosage],
                  ['Frequency', med.frequency],
                  ['Route', med.route],
                  ['Start Date', med.start_date],
                  ['Indication', clinical.reason_for_taking],
                ].map(([label, value]) => value && (
                  <div key={label} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #F3F4F6' }}>
                    <span style={{ width: 140, fontSize: 13, color: 'var(--color-text-muted)', fontWeight: 500 }}>{label}</span>
                    <span style={{ fontSize: 14 }}>{value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Adverse Reactions with MedDRA */}
            {editing ? (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Adverse Reaction</h2>
                <EditField label="Reaction">
                  <textarea style={{ ...inputStyle(), resize: 'vertical' }} rows={2} value={editForm.reaction} onChange={(e) => updateField('reaction', e.target.value)} placeholder="Describe what happened" />
                </EditField>
                <EditField label="Onset (when it started)">
                  <input style={inputStyle()} value={editForm.onset} onChange={(e) => updateField('onset', e.target.value)} placeholder="e.g. 2 days after starting" />
                </EditField>
                <EditField label="Outcome">
                  <input style={inputStyle()} value={editForm.outcome} onChange={(e) => updateField('outcome', e.target.value)} placeholder="e.g. fully recovered" />
                </EditField>
                <EditField label="Action taken — did stopping the medicine help?">
                  <select style={inputStyle()} value={editForm.dechallenge} onChange={(e) => updateField('dechallenge', e.target.value)}>
                    {DECHALLENGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </EditField>
              </div>
            ) : reactions.length > 0 && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Adverse Reactions</h2>
                {reactions.map((r, i) => {
                  const mapping = meddraData?.meddra_mappings?.[i];
                  return (
                    <div key={i} style={{ marginBottom: 16, padding: 16, background: 'var(--color-surface-secondary)', borderRadius: 'var(--radius-md)' }}>
                      <p style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--color-text-secondary)', marginBottom: 8 }}>"{r.original_text}"</p>
                      {mapping && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13 }}>{mapping.preferred_term}</span>
                          {mapping.meddra_code ? (
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-primary)', background: 'var(--color-primary-light)', padding: '2px 6px', borderRadius: 4 }}>
                              [{mapping.meddra_code}]
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: '#B45309', background: '#FEF3C7', padding: '2px 6px', borderRadius: 4 }}>provisional — verify</span>
                          )}
                          {mapping.mapping_confidence != null && <ConfidenceScore confidence={mapping.mapping_confidence} />}
                          {mapping.mapping_confidence != null && mapping.mapping_confidence < 0.7 && (
                            <AlertTriangle size={14} color="#D97706" aria-label="Low confidence mapping — please verify" />
                          )}
                        </div>
                      )}
                      {r.onset_date && <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>Onset: {r.onset_date}</p>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Additional information — patient, concomitant meds, action taken */}
            {editing ? (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Additional Information</h2>
                <EditField label="Concomitant medicines (comma-separated)">
                  <input style={inputStyle()} value={editForm.concomitantMedications} onChange={(e) => updateField('concomitantMedications', e.target.value)} placeholder="e.g. Metformin, Aspirin" />
                </EditField>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <EditField label="Patient initials">
                    <input style={inputStyle()} value={editForm.initials} onChange={(e) => updateField('initials', e.target.value)} placeholder="e.g. R.K." />
                  </EditField>
                  <EditField label="Age group">
                    <input style={inputStyle()} value={editForm.ageGroup} onChange={(e) => updateField('ageGroup', e.target.value)} placeholder="e.g. 45-54" />
                  </EditField>
                  <EditField label="Gender">
                    <select style={inputStyle()} value={editForm.gender} onChange={(e) => updateField('gender', e.target.value)}>
                      <option value="">Not specified</option>
                      <option value="male">Male</option>
                      <option value="female">Female</option>
                      <option value="other">Other</option>
                    </select>
                  </EditField>
                </div>
              </div>
            ) : hasAdditionalInfo && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Additional Information</h2>
                {[
                  ['Outcome', clinical.outcome],
                  ['Action taken (stopping helped?)', extractedData?.causality_signals?.dechallenge && extractedData.causality_signals.dechallenge !== 'unknown' ? extractedData.causality_signals.dechallenge : null],
                  ['Concomitant Medicines', (clinical.concomitant_medications || []).join(', ') || null],
                  ['Patient Initials', patient.initials],
                  ['Age Group', patient.age_group],
                  ['Gender', patient.gender],
                ].map(([label, value]) => value && (
                  <div key={label} style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #F3F4F6' }}>
                    <span style={{ width: 200, fontSize: 13, color: 'var(--color-text-muted)', fontWeight: 500 }}>{label}</span>
                    <span style={{ fontSize: 14 }}>{value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Timeline */}
            {!editing && timelineEvents.length > 0 && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 8 }}>Timeline</h2>
                <TimelineViz events={timelineEvents} />
              </div>
            )}

            {/* Causality */}
            {!editing && causality && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Causality Assessment</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <span style={{
                    padding: '6px 20px', borderRadius: 'var(--radius-full)', fontSize: 15, fontWeight: 700,
                    background: (causalityColors[causality.category] || '#6B7280') + '20',
                    color: causalityColors[causality.category] || '#6B7280',
                  }}>
                    WHO-UMC: {causality.category}
                  </span>
                  <ConfidenceScore confidence={causality.confidence} />
                </div>
                <p style={{ fontSize: 14, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{causality.who_umc_basis}</p>
              </div>
            )}

            {/* Completeness */}
            {!editing && (
              <div className="card" style={{ padding: 24 }}>
                <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Completeness</h2>
                <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
                  <CompletenessScore score={completenessScore || progress.percentage} fields={progress.fields} />
                  <div style={{ flex: 1 }}>
                    {progress.fields.filter((f) => !f.filled).length > 0 && (
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Missing optional fields:</p>
                        {progress.fields.filter((f) => !f.filled).map((f) => (
                          <p key={f.key} style={{ fontSize: 12, color: 'var(--color-text-muted)', padding: '2px 0' }}>- {f.label}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right — Actions panel */}
          <div style={{ position: 'sticky', top: 90 }}>
            <div className="card" style={{ padding: 24 }}>
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Report ID</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--color-primary)', marginBottom: 24 }}>
                {icsr?.report_id || reportId || 'Pending generation'}
              </p>

              <div style={{ textAlign: 'center', marginBottom: 24 }}>
                <CompletenessScore score={completenessScore || progress.percentage} fields={progress.fields} />
              </div>

              {/* Seriousness */}
              {meddraData?.seriousness?.is_serious && (
                <div style={{ padding: '10px 14px', background: '#FEF2F2', borderRadius: 'var(--radius-md)', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <AlertTriangle size={16} color="#DC2626" aria-hidden="true" />
                  <span style={{ fontSize: 13, color: '#DC2626', fontWeight: 500 }}>Serious ADR — Expedited review</span>
                </div>
              )}

              <button
                className="btn btn-outline"
                onClick={handleGenerateDraft}
                disabled={generatingDraft || !extractedData || editing}
                style={{ width: '100%', marginBottom: 16 }}
                aria-label="Generate AI draft report"
              >
                {generatingDraft ? <Loader size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
                {' '}{generatingDraft ? 'Generating...' : icsr ? 'Regenerate Draft Report' : 'Generate Draft Report'}
              </button>

              {/* Consent */}
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 20, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--color-primary)', cursor: 'pointer', flexShrink: 0 }}
                  aria-label="Consent to report processing"
                />
                <span style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  I confirm this is my voluntary experience and consent to this report being processed anonymously for India's pharmacovigilance programme.
                </span>
              </label>

              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={!consent || submitting || editing}
                style={{ width: '100%', minHeight: 52, fontSize: 16 }}
                aria-label="Submit to PvPI network"
              >
                {submitting ? 'Submitting...' : 'Submit to PvPI Network'}
              </button>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                {draftMessage ? <p style={{ fontSize: 12, color: 'var(--color-primary)', margin: 0 }}>{draftMessage}</p> : null}
                <button className="btn btn-ghost" style={{ width: '100%' }} onClick={handleSaveDraft} disabled={savingDraft || editing} aria-label="Save as draft">
                  <FileText size={16} aria-hidden="true" /> {savingDraft ? 'Saving...' : 'Save Draft'}
                </button>
                <button
                  className="btn btn-ghost"
                  style={{ width: '100%' }}
                  onClick={() => exportReportPdf({
                    id: reportId || conversationId,
                    status: 'draft',
                    createdAt: new Date().toISOString(),
                    extractedData,
                    icsr,
                  }, 'Pharmaco ADR Report')}
                  aria-label="Download PDF report"
                >
                  <Download size={16} aria-hidden="true" /> Download PDF
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
