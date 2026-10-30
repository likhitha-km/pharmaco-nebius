import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle, Download, Loader, RefreshCw, ShieldAlert, Sparkles, UserCheck, XCircle, HelpCircle, Cpu,
} from 'lucide-react';
import { adrApi } from '../../utils/api.js';
import { useAuth } from '../../auth/AuthProvider.jsx';
import { showToast } from '../common/Toast.jsx';

const REVIEWER_ROLES = ['healthcare_professional', 'admin'];

const SERIOUSNESS_STYLE = {
  serious: { bg: '#FEF2F2', border: '#FCA5A5', color: '#B91C1C' },
  potentially_serious: { bg: '#FFFBEB', border: '#FCD34D', color: '#B45309' },
  undetermined: { bg: '#F3F4F6', border: '#D1D5DB', color: '#374151' },
};

const CRITERION_STYLE = {
  present: { label: 'Reported', bg: '#FEE2E2', color: '#B91C1C' },
  possible: { label: 'Possible', bg: '#FEF3C7', color: '#B45309' },
  ruled_out: { label: 'Stated not applicable', bg: '#D1FAE5', color: '#047857' },
  unknown: { label: 'Not stated', bg: '#F3F4F6', color: '#6B7280' },
};

const REVIEW_STYLE = {
  pending_review: { label: 'Draft — pending human review', bg: '#FFFBEB', color: '#B45309' },
  approved: { label: 'Approved by human reviewer', bg: '#D1FAE5', color: '#047857' },
  rejected: { label: 'Rejected by reviewer', bg: '#FEE2E2', color: '#B91C1C' },
  needs_more_information: { label: 'More information requested', bg: '#E0F2FE', color: '#0369A1' },
};

function Card({ title, children, tag, id }) {
  return (
    <section id={id} className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 18, margin: 0 }}>{title}</h2>
        {tag}
      </div>
      {children}
    </section>
  );
}

function AiTag({ children = 'AI-extracted — unverified' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'var(--color-primary-light)', color: 'var(--color-primary-dark)' }}>
      <Sparkles size={11} aria-hidden="true" /> {children}
    </span>
  );
}

function Row({ label, value }) {
  const missing = value === null || value === undefined || value === '';
  return (
    <div style={{ display: 'flex', gap: 12, padding: '7px 0', borderBottom: '1px solid #F3F4F6' }}>
      <span style={{ width: 150, flexShrink: 0, fontSize: 13, color: 'var(--color-text-muted)', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 14, color: missing ? '#B45309' : 'var(--color-text-primary)', fontStyle: missing ? 'italic' : 'normal' }}>
        {missing ? 'Not provided' : String(value)}
      </span>
    </div>
  );
}

function Chip({ children, bg, color }) {
  return <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-full)', fontSize: 12, fontWeight: 500, background: bg, color }}>{children}</span>;
}

function BulletList({ title, items, empty }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{title}</p>
      {items?.length ? (
        <ul style={{ margin: 0, paddingLeft: 18 }}>{items.map((x, i) => <li key={i} style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>{x}</li>)}</ul>
      ) : <p style={{ fontSize: 13, color: 'var(--color-text-muted)', margin: 0 }}>{empty}</p>}
    </div>
  );
}

export function AdrAgentReport({ conversationId, onReport }) {
  const { userProfile, user } = useAuth();
  const canReview = REVIEWER_ROLES.includes(userProfile?.role);
  const [assessment, setAssessment] = useState(null);
  const [phase, setPhase] = useState('loading'); // loading | running | ready | error | empty
  const [error, setError] = useState(null);
  const [reviewerName, setReviewerName] = useState(user?.displayName || '');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const startedRef = useRef(false);

  const run = useCallback(async () => {
    setPhase('running');
    setError(null);
    try {
      const { data } = await adrApi.assess(conversationId);
      setAssessment(data.assessment);
      setPhase('ready');
      onReport?.(data);
    } catch (err) {
      setError({
        message: err.response?.data?.error || err.message || 'The assessment failed.',
        steps: err.response?.data?.steps || [],
      });
      setPhase('error');
    }
  }, [conversationId, onReport]);

  useEffect(() => {
    if (!conversationId || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const { data } = await adrApi.get(conversationId);
        if (data.assessment) {
          setAssessment(data.assessment);
          setPhase('ready');
        } else if (data.extractedData) {
          run(); // first visit: run the agent workflow automatically
        } else {
          setPhase('empty');
        }
      } catch (err) {
        setError({ message: err.response?.data?.error || err.message, steps: [] });
        setPhase('error');
      }
    })();
  }, [conversationId, run]);

  const submitReview = async (decision) => {
    setReviewing(true);
    try {
      const { data } = await adrApi.review(conversationId, { decision, reviewerName, note, confirmed });
      setAssessment((prev) => ({ ...prev, report: data.report }));
      showToast(decision === 'approve' ? 'Report approved.' : 'Review recorded.', 'success');
      setConfirmed(false);
    } catch (err) {
      showToast(err.response?.data?.error || 'Could not record the review.', 'error');
    } finally {
      setReviewing(false);
    }
  };

  if (phase === 'loading' || phase === 'running') {
    return (
      <Card title="AI-assisted ADR report">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }} role="status" aria-live="polite">
          <Loader size={20} className="animate-spin" color="var(--color-primary)" aria-hidden="true" />
          <div>
            <p style={{ fontSize: 14, fontWeight: 500, margin: 0 }}>
              {phase === 'running' ? 'Analysing the conversation with NVIDIA Nemotron…' : 'Loading report…'}
            </p>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '2px 0 0' }}>
              Extracting clinical details → safety triage → pharmacovigilance assessment → drafting the report (usually 15–30 s)
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (phase === 'empty') {
    return <Card title="AI-assisted ADR report"><p style={{ fontSize: 14, color: 'var(--color-text-secondary)' }}>Describe the suspected reaction in the chat first, then come back to generate the report.</p></Card>;
  }

  if (phase === 'error') {
    return (
      <Card title="AI-assisted ADR report">
        <div role="alert" style={{ padding: 14, background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 'var(--radius-md)', marginBottom: 12 }}>
          <p style={{ margin: 0, fontSize: 14, color: '#B91C1C', fontWeight: 500 }}>The report could not be generated.</p>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#7F1D1D' }}>{error?.message}</p>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: '#7F1D1D' }}>Nothing was saved or invented. Your conversation is intact — you can retry.</p>
        </div>
        <button className="btn btn-outline" onClick={run} id="adr-retry"><RefreshCw size={16} aria-hidden="true" /> Try again</button>
      </Card>
    );
  }

  const report = assessment?.report;
  if (!report) return null;
  const safety = assessment.safety;
  const sStyle = SERIOUSNESS_STYLE[report.seriousness.overall] || SERIOUSNESS_STYLE.undetermined;
  const review = report.human_review;
  const rStyle = REVIEW_STYLE[review.status] || REVIEW_STYLE.pending_review;
  const drug = report.suspected_drug;
  const rxn = report.reaction;
  const degraded = (assessment.steps || []).filter((s) => s.status === 'degraded');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} id="adr-agent-report">
      {/* Header */}
      <div className="card" style={{ padding: 20, borderColor: 'var(--color-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, margin: 0 }}>AI-assisted ADR report</h2>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0', fontFamily: 'var(--font-mono)' }}>{report.report_id}</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip bg={rStyle.bg} color={rStyle.color}>{rStyle.label}</Chip>
            {report.synthetic_data && <Chip bg="#EDE9FE" color="#5B21B6">Synthetic patient data</Chip>}
          </div>
        </div>
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '12px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Cpu size={14} aria-hidden="true" />
          Generated by <strong>NVIDIA Nemotron</strong> ({report.ai.model}) on <strong>Nebius Token Factory</strong>
        </p>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '6px 0 0' }}>{report.disclaimer}</p>
        {degraded.length > 0 && (
          <p role="alert" style={{ fontSize: 12, color: '#B45309', margin: '8px 0 0' }}>
            Some AI steps degraded ({degraded.map((d) => d.name.replace('_', ' ')).join(', ')}) — fallback content is marked and needs manual review.
          </p>
        )}
      </div>

      {/* Emergency */}
      {safety.emergency?.flag && (
        <div role="alert" id="adr-emergency" style={{ padding: 16, background: '#FEF2F2', border: '2px solid #DC2626', borderRadius: 'var(--radius-lg)', display: 'flex', gap: 12 }}>
          <ShieldAlert size={24} color="#DC2626" aria-hidden="true" style={{ flexShrink: 0 }} />
          <div>
            <p style={{ margin: 0, fontWeight: 700, color: '#B91C1C', fontSize: 15 }}>Possible emergency — seek medical help now</p>
            <p style={{ margin: '4px 0 0', fontSize: 14, color: '#7F1D1D' }}>{safety.emergency.advice}</p>
            <a href="tel:112" style={{ display: 'inline-block', marginTop: 8, fontWeight: 700, color: '#DC2626' }}>Call 112</a>
          </div>
        </div>
      )}

      {/* Seriousness */}
      <Card title="Safety triage — seriousness indicators" tag={<AiTag>AI-suggested — needs human confirmation</AiTag>} id="adr-seriousness">
        <div style={{ padding: '10px 14px', background: sStyle.bg, border: `1px solid ${sStyle.border}`, borderRadius: 'var(--radius-md)', marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center' }}>
          <AlertTriangle size={16} color={sStyle.color} aria-hidden="true" />
          <span style={{ fontSize: 14, fontWeight: 600, color: sStyle.color }}>{report.seriousness.label}</span>
        </div>
        {report.seriousness.criteria.map((c) => {
          const cs = CRITERION_STYLE[c.status] || CRITERION_STYLE.unknown;
          return (
            <div key={c.key} style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid #F3F4F6', alignItems: 'flex-start' }}>
              <span style={{ flex: 1, fontSize: 13 }}>
                {c.label}
                {c.evidence && <em style={{ display: 'block', color: 'var(--color-text-muted)', fontSize: 12, marginTop: 2 }}>“{c.evidence}”</em>}
              </span>
              <Chip bg={cs.bg} color={cs.color}>{cs.label}</Chip>
            </div>
          );
        })}
        {report.seriousness.rationale && <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 12, lineHeight: 1.6 }}>{report.seriousness.rationale}</p>}
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
          “Not stated” means the information is missing — it does not mean the event did not happen.
        </p>
      </Card>

      {/* Extracted info */}
      <Card title="Extracted information" tag={<AiTag />} id="adr-extracted">
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 2px' }}>Patient</p>
        <Row label="Age" value={report.patient.age} />
        <Row label="Sex" value={report.patient.sex} />
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 2px' }}>Suspected medicine</p>
        <Row label="Name" value={drug.name} />
        <Row label="Dose" value={drug.dose} />
        <Row label="Frequency" value={drug.frequency} />
        <Row label="Reason for taking" value={drug.indication} />
        <Row label="Started" value={drug.start_date} />
        <Row label="Stopped" value={drug.stopped === true ? (drug.stop_date || 'Yes (date not stated)') : drug.stopped === false ? 'No — still taking' : null} />
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 2px' }}>Reaction</p>
        <Row label="Description" value={rxn.english_description || rxn.description} />
        <Row label="Onset" value={rxn.onset} />
        <Row label="Improved after stopping" value={{ positive: 'Yes', negative: 'No', unknown: null }[rxn.improved_after_stopping]} />
        <Row label="Outcome" value={rxn.outcome} />
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 2px' }}>Medical context</p>
        <Row label="Other medicines" value={report.medical_history.other_medicines.join(', ') || null} />
        <Row label="Medical history" value={report.medical_history.history} />

        {report.timeline.length > 0 && (
          <>
            <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 6px' }}>Timeline (as stated by the patient)</p>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {report.timeline.map((t, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.7 }}><strong>{t.when}</strong> — {t.event}</li>)}
            </ol>
          </>
        )}

        {report.provenance.supporting_excerpts.length > 0 && (
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'var(--color-primary-dark)' }}>
              Supporting excerpts from the conversation ({report.provenance.supporting_excerpts.length})
            </summary>
            <div style={{ marginTop: 8 }}>
              {report.provenance.supporting_excerpts.map((e, i) => (
                <p key={i} style={{ fontSize: 12, margin: '4px 0', color: 'var(--color-text-secondary)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-muted)' }}>{e.field}</span> — “{e.excerpt}”{' '}
                  {e.verified ? <span style={{ color: '#047857' }}>✓ found in conversation</span> : <span style={{ color: '#B45309' }}>⚠ not found verbatim</span>}
                </p>
              ))}
            </div>
          </details>
        )}
        {report.provenance.uncertainty.length > 0 && (
          <BulletList title="Uncertainty flagged by the model" items={report.provenance.uncertainty.map((u) => `${u.field}: ${u.note}`)} />
        )}
      </Card>

      {/* Missing info */}
      <Card title="Missing information" id="adr-missing">
        {report.missing_information.length === 0 ? (
          <p style={{ fontSize: 13, color: '#047857', margin: 0 }}>All tracked fields were provided or stated as not applicable.</p>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {report.missing_information.map((m) => (
              <Chip key={m.key} bg={m.required ? '#FEE2E2' : '#FEF3C7'} color={m.required ? '#B91C1C' : '#B45309'}>{m.label}{m.required ? ' *' : ''}</Chip>
            ))}
          </div>
        )}
        {report.reported_as_not_applicable.length > 0 && (
          <>
            <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '14px 0 6px' }}>Patient stated these do not apply (a real answer, not missing):</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {report.reported_as_not_applicable.map((m) => <Chip key={m.key} bg="#E5E7EB" color="#374151">{m.label}</Chip>)}
            </div>
          </>
        )}
      </Card>

      {/* Assessment */}
      <Card title="Pharmacovigilance assessment" tag={<AiTag>AI-suggested — reviewer must verify</AiTag>} id="adr-assessment">
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Symptom terminology (MedDRA)</p>
        {report.assessment.terminology.map((t, i) => (
          <div key={i} style={{ padding: 12, background: 'var(--color-surface-secondary)', borderRadius: 'var(--radius-md)', marginBottom: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontStyle: 'italic', color: 'var(--color-text-secondary)' }}>“{t.original_text}”</p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>{t.candidate_term ? `Candidate term: ${t.candidate_term}` : `Provisional description: ${t.provisional_description || 'n/a'}`}</span>
              <Chip bg="#FEF3C7" color="#B45309">Requires verification · no MedDRA code assigned</Chip>
            </div>
            {t.mapping_notes && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--color-text-muted)' }}>{t.mapping_notes}</p>}
          </div>
        ))}
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 16px' }}>
          Codes are not assigned because the licensed MedDRA dictionary is not bundled with this prototype.
        </p>

        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>WHO-UMC causality evidence</p>
        <div style={{ marginBottom: 12 }}>
          <Chip bg="#E0F2FE" color="#0369A1">Suggested: {report.assessment.causality.category}</Chip>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', marginLeft: 8 }}>not a causality determination</span>
        </div>
        <BulletList title="Evidence supporting a link" items={report.assessment.causality.evidence_for} empty="None recorded" />
        <BulletList title="Evidence against / alternative explanations" items={report.assessment.causality.evidence_against} empty="None recorded" />
        <BulletList title="Information that would clarify causality" items={report.assessment.causality.missing_information} empty="None listed" />
        {report.assessment.causality.guard_notes?.length > 0 && (
          <BulletList title="Automatic safeguards applied" items={report.assessment.causality.guard_notes} />
        )}
      </Card>

      {/* Summary */}
      <Card title="Evidence summary" tag={report.evidence_summary.ai_generated ? <AiTag>AI-generated</AiTag> : <Chip bg="#F3F4F6" color="#374151">Rule-based fallback</Chip>} id="adr-summary">
        <p style={{ fontSize: 14, lineHeight: 1.7, color: 'var(--color-text-secondary)', margin: 0 }}>{report.evidence_summary.text}</p>
        {report.evidence_summary.note && <p style={{ fontSize: 12, color: '#B45309', marginTop: 8 }}>{report.evidence_summary.note}</p>}
      </Card>

      {/* Human review */}
      <Card title="Human review" id="adr-review" tag={<Chip bg={rStyle.bg} color={rStyle.color}>{rStyle.label}</Chip>}>
        {review.status === 'approved' || review.status === 'rejected' || review.status === 'needs_more_information' ? (
          <p style={{ fontSize: 13, margin: '0 0 12px', color: 'var(--color-text-secondary)' }}>
            Reviewed by <strong>{review.reviewer?.name}</strong> on {new Date(review.decision_at).toLocaleString()}.
            {review.note && <> Note: “{review.note}”</>}
          </p>
        ) : (
          <p style={{ fontSize: 13, margin: '0 0 12px', color: 'var(--color-text-secondary)' }}>
            This report is a draft. It is not final until an authorised reviewer has inspected and approved it.
          </p>
        )}
        {canReview ? (
          <div>
            <input className="input" style={{ marginBottom: 8 }} placeholder="Reviewer name" value={reviewerName} onChange={(e) => setReviewerName(e.target.value)} id="adr-reviewer-name" aria-label="Reviewer name" />
            <textarea className="input" style={{ marginBottom: 8, resize: 'vertical' }} rows={2} placeholder="Review note (optional)" value={note} onChange={(e) => setNote(e.target.value)} id="adr-reviewer-note" aria-label="Review note" />
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} id="adr-confirm" style={{ marginTop: 3, accentColor: 'var(--color-primary)' }} />
              I have inspected the extracted data, seriousness flags and assessment and take responsibility for this decision.
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" id="adr-approve" disabled={reviewing || !confirmed || !reviewerName.trim()} onClick={() => submitReview('approve')}><UserCheck size={16} aria-hidden="true" /> Approve</button>
              <button className="btn btn-outline" id="adr-needs-info" disabled={reviewing || !reviewerName.trim()} onClick={() => submitReview('needs_info')}><HelpCircle size={16} aria-hidden="true" /> Request more info</button>
              <button className="btn btn-ghost" id="adr-reject" disabled={reviewing || !reviewerName.trim()} onClick={() => submitReview('reject')}><XCircle size={16} aria-hidden="true" /> Reject</button>
            </div>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: 0 }}>
            Approval controls are available to signed-in healthcare professionals. Sign in with a reviewer account to approve this report.
          </p>
        )}
      </Card>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn btn-outline" href={adrApi.reportJsonUrl(conversationId)} download id="adr-download-json"><Download size={16} aria-hidden="true" /> Download report JSON</a>
        <button className="btn btn-ghost" onClick={run} id="adr-regenerate"><RefreshCw size={16} aria-hidden="true" /> Re-run analysis</button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--color-text-muted)', margin: 0 }}>
        Re-running the analysis updates this same report and resets the review status to pending.
      </p>
      {review.status === 'approved' && <p style={{ fontSize: 12, color: '#047857', display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}><CheckCircle size={14} aria-hidden="true" /> Approved</p>}
    </div>
  );
}
