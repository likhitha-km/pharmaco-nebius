// Client-side mirror of backend/src/utils/adrSchema.js computeFieldStatus(), used
// when a conversation is restored from history. Statuses:
//   provided | negative (user said it does not apply / real "no" answer) | missing
export const ADR_FIELD_CATALOG = [
  { key: 'suspected_medicine', label: 'Suspected medicine', required: true },
  { key: 'reaction', label: 'Reaction / symptoms', required: true },
  { key: 'reaction_date', label: 'Date/time reaction started', required: true },
  { key: 'patient_age', label: 'Patient age', required: false },
  { key: 'patient_sex', label: 'Patient sex', required: false },
  { key: 'dose', label: 'Dose', required: false },
  { key: 'frequency', label: 'Frequency', required: false },
  { key: 'indication', label: 'Reason for taking', required: false },
  { key: 'medicine_start_date', label: 'Date medicine started', required: false },
  { key: 'medicine_stopped', label: 'Medicine stopped?', required: false },
  { key: 'dechallenge', label: 'Improved after stopping?', required: false },
  { key: 'concomitant_medications', label: 'Other medicines', required: false },
  { key: 'medical_history', label: 'Medical history', required: false },
];

export function computeFieldStatusClient(data) {
  const d = data || {};
  const med = d.suspected_medicines?.[0] || {};
  const rxn = d.adverse_reactions?.[0] || {};
  const patient = d.patient || {};
  const clin = d.clinical_context || {};
  const neg = new Set(d.explicit_negatives || []);
  const st = (present, negKey) => (present ? 'provided' : negKey && neg.has(negKey) ? 'negative' : 'missing');
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
    medicine_stopped: st(med.stopped != null || !!med.stop_date, 'medicine_stopped'),
    dechallenge: dech === 'positive' ? 'provided' : dech === 'negative' ? 'negative' : 'missing',
    concomitant_medications: st((clin.concomitant_medications || []).length > 0, 'concomitant_medications'),
    medical_history: st(!!clin.medical_history, 'medical_history'),
  };
  return ADR_FIELD_CATALOG.map((f) => ({ ...f, status: status[f.key] }));
}
