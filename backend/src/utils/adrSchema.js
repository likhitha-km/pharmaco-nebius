// Schema, validation and missing-field logic for the ADR agent workflow.
// Hand-written (no extra dependency). Everything the model returns is passed
// through validateExtraction() before it is trusted or stored.

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const num01 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const oneOf = (v, allowed, fallback) => (typeof v === 'string' && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);

export const EXTRACTION_SCHEMA_DESCRIPTION = `{
  "suspected_medicines": [
    { "name": "string", "brand_name": "string|null", "dosage": "string|null", "frequency": "string|null", "route": "string|null",
      "start_date": "string|null", "stop_date": "string|null", "stopped": "true|false|null (true only if user said it was stopped/paused/reduced, false only if user said they are still taking it)", "confidence": 0.0 }
  ],
  "adverse_reactions": [
    { "original_text": "string (user's own words)", "english_translation": "string", "onset_date": "string|null (date/time or interval after starting, as stated)",
      "resolution_date": "string|null", "duration": "string|null", "severity": "mild|moderate|severe|null", "still_ongoing": "true|false|null", "confidence": 0.0 }
  ],
  "patient": { "initials": "string|null", "age_group": "string|null (age or age band as stated)", "gender": "string|null", "weight": "string|null",
               "is_pregnant": "true|false|null", "is_breastfeeding": "true|false|null", "special_populations": [] },
  "causality_signals": { "dechallenge": "positive|negative|unknown", "rechallenge": "positive|negative|not_applicable",
                         "temporal_relationship": "string|null", "alternative_explanation": "string|null" },
  "clinical_context": { "reason_for_taking": "string|null", "medical_history": "string|null", "concomitant_medications": [],
                        "hospitalization": "true|false|null", "outcome": "string|null" },
  "metadata": { "language_detected": "string", "reporter_type": "patient|healthcare_professional|caregiver|anonymous",
                "report_type": "adr|medication_error|product_quality|drug_interaction" },
  "explicit_negatives": ["subset of: concomitant_medications, medical_history, medicine_stopped, hospitalization, allergies — ONLY fields the user explicitly said do not apply (e.g. 'no other medicines')"],
  "uncertainty": [ { "field": "string", "note": "why the value is uncertain, vague or contradictory" } ],
  "supporting_excerpts": [ { "field": "string", "excerpt": "verbatim quote from the Patient messages that supports the value" } ]
}`;

/**
 * Validate + normalise a parsed model extraction.
 * @returns {{ ok: boolean, data: object|null, issues: string[] }}
 */
export function validateExtraction(raw) {
  const issues = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, data: null, issues: ['Model output is not a JSON object'] };
  }

  const medicines = arr(raw.suspected_medicines).filter((m) => m && typeof m === 'object').map((m) => ({
    name: str(m.name),
    brand_name: str(m.brand_name),
    dosage: str(m.dosage),
    frequency: str(m.frequency),
    route: str(m.route),
    start_date: str(m.start_date),
    stop_date: str(m.stop_date),
    stopped: bool(m.stopped),
    confidence: num01(m.confidence),
  })).filter((m) => m.name);

  const reactions = arr(raw.adverse_reactions).filter((r) => r && typeof r === 'object').map((r) => ({
    original_text: str(r.original_text) || str(r.english_translation),
    english_translation: str(r.english_translation) || str(r.original_text),
    onset_date: str(r.onset_date),
    resolution_date: str(r.resolution_date),
    duration: str(r.duration),
    severity: oneOf(r.severity, ['mild', 'moderate', 'severe'], null),
    still_ongoing: bool(r.still_ongoing),
    confidence: num01(r.confidence),
  })).filter((r) => r.original_text);

  const p = raw.patient && typeof raw.patient === 'object' ? raw.patient : {};
  const patient = {
    initials: str(p.initials),
    age_group: str(p.age_group),
    gender: str(p.gender),
    weight: str(p.weight),
    is_pregnant: bool(p.is_pregnant),
    is_breastfeeding: bool(p.is_breastfeeding),
    special_populations: arr(p.special_populations).filter((x) => typeof x === 'string'),
  };

  const c = raw.causality_signals && typeof raw.causality_signals === 'object' ? raw.causality_signals : {};
  const causality_signals = {
    dechallenge: oneOf(c.dechallenge, ['positive', 'negative', 'unknown'], 'unknown'),
    rechallenge: oneOf(c.rechallenge, ['positive', 'negative', 'not_applicable'], 'not_applicable'),
    temporal_relationship: str(c.temporal_relationship),
    alternative_explanation: str(c.alternative_explanation),
  };
  if (c.dechallenge && causality_signals.dechallenge === 'unknown' && String(c.dechallenge).toLowerCase() !== 'unknown') {
    issues.push(`Invalid dechallenge value "${c.dechallenge}" coerced to unknown`);
  }

  const k = raw.clinical_context && typeof raw.clinical_context === 'object' ? raw.clinical_context : {};
  const clinical_context = {
    reason_for_taking: str(k.reason_for_taking),
    medical_history: str(k.medical_history),
    concomitant_medications: arr(k.concomitant_medications).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
    hospitalization: bool(k.hospitalization),
    outcome: str(k.outcome),
  };

  const m = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
  const metadata = {
    language_detected: str(m.language_detected) || 'en-IN',
    reporter_type: oneOf(m.reporter_type, ['patient', 'healthcare_professional', 'caregiver', 'anonymous'], 'anonymous'),
    report_type: oneOf(m.report_type, ['adr', 'medication_error', 'product_quality', 'drug_interaction'], 'adr'),
  };

  const NEG_ALLOWED = ['concomitant_medications', 'medical_history', 'medicine_stopped', 'hospitalization', 'allergies'];
  const explicit_negatives = arr(raw.explicit_negatives).filter((x) => NEG_ALLOWED.includes(x));

  const uncertainty = arr(raw.uncertainty)
    .filter((u) => u && str(u.field) && str(u.note))
    .map((u) => ({ field: u.field.trim(), note: u.note.trim() }));

  const supporting_excerpts = arr(raw.supporting_excerpts)
    .filter((e) => e && str(e.field) && str(e.excerpt))
    .map((e) => ({ field: e.field.trim(), excerpt: e.excerpt.trim() }));

  if (medicines.length === 0 && reactions.length === 0) issues.push('No suspected medicine or reaction could be extracted');

  return {
    ok: true,
    data: {
      suspected_medicines: medicines,
      adverse_reactions: reactions,
      patient,
      causality_signals,
      clinical_context,
      metadata,
      explicit_negatives,
      uncertainty,
      supporting_excerpts,
    },
    issues,
  };
}

/** Drop excerpts that are not actually present in the user's messages (anti-hallucination). */
export function verifyExcerpts(data, userText) {
  if (!data?.supporting_excerpts) return data;
  const hay = (userText || '').toLowerCase().replace(/\s+/g, ' ');
  const verified = data.supporting_excerpts.map((e) => ({
    ...e,
    verified: hay.includes(e.excerpt.toLowerCase().replace(/\s+/g, ' ')),
  }));
  return { ...data, supporting_excerpts: verified };
}

// ─────────────────────────────────────────────────────────────────────────────
// Field catalogue — drives follow-up questions and the missing-info indicators.
// Status is one of: 'provided' | 'negative' (user said it does not apply) | 'missing'.
// ─────────────────────────────────────────────────────────────────────────────
export const ADR_FIELD_CATALOG = [
  { key: 'suspected_medicine', label: 'Suspected medicine', required: true },
  { key: 'reaction', label: 'Reaction / symptoms', required: true },
  { key: 'reaction_date', label: 'Date/time reaction started', required: true },
  { key: 'patient_age', label: 'Patient age', required: false },
  { key: 'patient_sex', label: 'Patient sex', required: false },
  { key: 'dose', label: 'Dose', required: false },
  { key: 'frequency', label: 'Frequency', required: false },
  { key: 'indication', label: 'Reason for taking the medicine', required: false },
  { key: 'medicine_start_date', label: 'Date medicine was started', required: false },
  { key: 'medicine_stopped', label: 'Whether the medicine was stopped', required: false },
  { key: 'dechallenge', label: 'Whether symptoms improved after stopping', required: false },
  { key: 'concomitant_medications', label: 'Other medicines being taken', required: false },
  { key: 'medical_history', label: 'Relevant medical history', required: false },
];

export function computeFieldStatus(data) {
  const d = data || {};
  const med = d.suspected_medicines?.[0] || {};
  const rxn = d.adverse_reactions?.[0] || {};
  const patient = d.patient || {};
  const clin = d.clinical_context || {};
  const neg = new Set(d.explicit_negatives || []);

  const st = (present, negKey) => (present ? 'provided' : negKey && neg.has(negKey) ? 'negative' : 'missing');
  const stoppedKnown = med.stopped != null || !!med.stop_date;
  const dech = d.causality_signals?.dechallenge;

  const status = {
    suspected_medicine: st(!!med.name),
    reaction: st(!!rxn.original_text),
    reaction_date: st(!!rxn.onset_date),
    patient_age: st(!!patient.age_group),
    patient_sex: st(!!patient.gender),
    dose: st(!!med.dosage),
    frequency: st(!!med.frequency),
    indication: st(!!clin.reason_for_taking),
    medicine_start_date: st(!!med.start_date),
    medicine_stopped: st(stoppedKnown, 'medicine_stopped'),
    // 'negative' here is a real answer: it did NOT improve after stopping.
    dechallenge: dech === 'positive' ? 'provided' : dech === 'negative' ? 'negative' : 'missing',
    concomitant_medications: st((clin.concomitant_medications || []).length > 0, 'concomitant_medications'),
    medical_history: st(!!clin.medical_history, 'medical_history'),
  };

  return ADR_FIELD_CATALOG.map((f) => ({ ...f, status: status[f.key] }));
}

export function computeMissingFields(data) {
  return computeFieldStatus(data).filter((f) => f.status === 'missing');
}
