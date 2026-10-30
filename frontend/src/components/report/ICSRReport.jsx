import { useState } from 'react';
import { ChevronDown, ChevronUp, Download, Copy, CheckCheck } from 'lucide-react';
import { ConfidenceScore } from './ConfidenceScore.jsx';
import { exportReportPdf } from '../../utils/pdfExport.js';

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: '1px solid var(--color-border)' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 0', fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16,
          color: 'var(--color-text-primary)', background: 'none', border: 'none', cursor: 'pointer',
        }}
        aria-expanded={open}
      >
        {title}
        {open ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {open && <div style={{ paddingBottom: 16 }}>{children}</div>}
    </div>
  );
}

function Field({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '8px 0', borderBottom: '1px solid #F3F4F6' }}>
      <span style={{ fontSize: 13, color: 'var(--color-text-muted)', minWidth: 160, fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>{value}</span>
    </div>
  );
}

export function ICSRReport({ report }) {
  const [copied, setCopied] = useState(false);
  if (!report) return null;

  const copyId = () => {
    navigator.clipboard.writeText(report.report_id || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const med = report.suspect_drugs?.[0] || {};
  const patient = report.patient || {};

  return (
    <div style={{ fontFamily: 'var(--font-body)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-primary)' }}>{report.report_id}</span>
            <button onClick={copyId} aria-label="Copy report ID" style={{ color: 'var(--color-text-muted)', display: 'flex' }}>
              {copied ? <CheckCheck size={14} color="#10B981" /> : <Copy size={14} />}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-full)', background: report.seriousness === 'Serious' ? '#FEF2F2' : '#F3F4F6', color: report.seriousness === 'Serious' ? '#DC2626' : '#374151', fontSize: 12, fontWeight: 500 }}>
              {report.seriousness || 'Undetermined'}
            </span>
            <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-full)', background: '#EFF6FF', color: '#2563EB', fontSize: 12, fontWeight: 500 }}>
              {report.report_type || 'Initial'}
            </span>
            {report.pvpi_submission_ready && (
              <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-full)', background: '#ECFDF5', color: '#059669', fontSize: 12, fontWeight: 500 }}>
                PvPI Ready
              </span>
            )}
          </div>
        </div>
        <button
          className="btn btn-outline btn-sm no-print"
          onClick={() => exportReportPdf(report, 'Pharmaco ADR Report')}
          aria-label="Download PDF"
        >
          <Download size={16} aria-hidden="true" /> Download PDF
        </button>
      </div>

      {/* Sections */}
      <Section title="Narrative Summary">
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--color-text-secondary)', fontStyle: 'italic', padding: '8px 0' }}>
          {report.narrative || 'No narrative generated.'}
        </p>
      </Section>

      <Section title="Patient Information">
        <Field label="Initials" value={patient.initials || 'Anonymous'} />
        <Field label="Age Group" value={patient.age_group} />
        <Field label="Gender" value={patient.gender} />
        <Field label="Weight" value={patient.weight} />
        <Field label="Special Populations" value={patient.special_populations?.join(', ')} />
      </Section>

      <Section title="Suspect Drug(s)">
        {report.suspect_drugs?.map((d, i) => (
          <div key={i} style={{ marginBottom: 16 }}>
            <p style={{ fontWeight: 600, marginBottom: 4 }}>{d.name}</p>
            <Field label="Dosage" value={d.dosage} />
            <Field label="Frequency" value={d.frequency} />
            <Field label="Route" value={d.route} />
            <Field label="Start Date" value={d.start_date} />
            <Field label="Stop Date" value={d.stop_date} />
            <Field label="Indication" value={d.indication} />
          </div>
        ))}
      </Section>

      <Section title="Adverse Events">
        {report.adverse_events?.map((ae, i) => (
          <div key={i} style={{ marginBottom: 16, padding: '12px', background: 'var(--color-surface-secondary)', borderRadius: 'var(--radius-md)' }}>
            <p style={{ fontStyle: 'italic', fontSize: 14, color: 'var(--color-text-secondary)', marginBottom: 6 }}>"{ae.original_text}"</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--color-primary-light)', color: 'var(--color-primary)', padding: '2px 8px', borderRadius: 4 }}>
                {ae.meddra_preferred_term}{ae.meddra_code ? ` [${ae.meddra_code}]` : ' (provisional — verify against MedDRA)'}
              </span>
            </div>
            <Field label="Onset" value={ae.onset_date} />
            <Field label="Severity" value={ae.severity} />
            <Field label="Outcome" value={ae.outcome} />
          </div>
        ))}
      </Section>

      <Section title="Causality Assessment">
        <div style={{ padding: '12px', background: '#F0FDF4', borderRadius: 'var(--radius-md)', marginBottom: 8 }}>
          <p style={{ fontWeight: 600, color: '#059669', marginBottom: 4 }}>WHO-UMC: {report.causality?.who_umc_category}</p>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>{report.causality?.basis}</p>
        </div>
      </Section>

      {report.missing_information_checklist?.length > 0 && (
        <Section title="Missing Information" defaultOpen={false}>
          <ul style={{ paddingLeft: 20 }}>
            {report.missing_information_checklist.map((item, i) => (
              <li key={i} style={{ fontSize: 13, color: 'var(--color-text-secondary)', padding: '4px 0' }}>{item}</li>
            ))}
          </ul>
        </Section>
      )}

      <div style={{ marginTop: 16, padding: 16, background: 'var(--color-surface-secondary)', borderRadius: 'var(--radius-md)' }}>
        <Field label="Generated" value={report.generated_timestamp ? new Date(report.generated_timestamp).toLocaleString('en-IN') : ''} />
        <Field label="Recommended Action" value={report.recommended_action} />
      </div>
    </div>
  );
}
