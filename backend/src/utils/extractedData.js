function createBaseExtractedData() {
  return {
    suspected_medicines: [],
    adverse_reactions: [],
    patient: {},
    causality_signals: { dechallenge: 'unknown', rechallenge: 'not_applicable', temporal_relationship: null, alternative_explanation: null },
    clinical_context: { reason_for_taking: null, medical_history: null, concomitant_medications: [], hospitalization: null, outcome: null },
    metadata: { language_detected: 'en-IN', reporter_type: 'anonymous', report_type: 'adr' },
    explicit_negatives: [],
    uncertainty: [],
    supporting_excerpts: [],
  };
}

function cloneData(data) {
  return data ? JSON.parse(JSON.stringify(data)) : null;
}

// Drop null/undefined/empty-string values so a later extraction that simply
// didn't mention a field can't erase something already collected.
function definedOnly(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

const PLACEHOLDER_SIGNALS = new Set(['unknown', 'not_applicable']);

function normalizeExtractedData(data) {
  const base = createBaseExtractedData();
  const source = cloneData(data) || {};
  base.suspected_medicines = Array.isArray(source.suspected_medicines) ? source.suspected_medicines : [];
  base.adverse_reactions = Array.isArray(source.adverse_reactions) ? source.adverse_reactions : [];
  base.patient = source.patient || {};
  base.causality_signals = { ...base.causality_signals, ...(source.causality_signals || {}) };
  base.clinical_context = { ...base.clinical_context, ...(source.clinical_context || {}) };
  base.metadata = { ...base.metadata, ...(source.metadata || {}) };
  base.explicit_negatives = Array.isArray(source.explicit_negatives) ? source.explicit_negatives : [];
  base.uncertainty = Array.isArray(source.uncertainty) ? source.uncertainty : [];
  base.supporting_excerpts = Array.isArray(source.supporting_excerpts) ? source.supporting_excerpts : [];
  return base;
}

export function mergeExtractedData(existing, incoming) {
  const base = normalizeExtractedData(existing);
  const incomingData = normalizeExtractedData(incoming);

  if (incomingData.suspected_medicines.length > 0) {
    const mergedMedicines = [...base.suspected_medicines];
    incomingData.suspected_medicines.forEach((med, index) => {
      if (!med || !Object.keys(med).some((key) => med[key] != null && med[key] !== '')) return;
      if (mergedMedicines[index]) {
        mergedMedicines[index] = { ...mergedMedicines[index], ...definedOnly(med) };
      } else {
        mergedMedicines.push(med);
      }
    });
    base.suspected_medicines = mergedMedicines;
  }

  if (incomingData.adverse_reactions.length > 0) {
    const mergedReactions = [...base.adverse_reactions];
    incomingData.adverse_reactions.forEach((reaction, index) => {
      if (!reaction || !Object.keys(reaction).some((key) => reaction[key] != null && reaction[key] !== '')) return;
      if (mergedReactions[index]) {
        mergedReactions[index] = { ...mergedReactions[index], ...definedOnly(reaction) };
      } else {
        mergedReactions.push(reaction);
      }
    });
    base.adverse_reactions = mergedReactions;
  }

  base.patient = { ...base.patient, ...definedOnly(incomingData.patient) };
  const incomingSignals = Object.fromEntries(
    Object.entries(incomingData.causality_signals).filter(([, v]) => v != null && !PLACEHOLDER_SIGNALS.has(v))
  );
  base.causality_signals = { ...base.causality_signals, ...incomingSignals };
  const priorConcomitant = base.clinical_context.concomitant_medications || [];
  base.clinical_context = { ...base.clinical_context, ...definedOnly(incomingData.clinical_context) };
  base.clinical_context.concomitant_medications = priorConcomitant;
  base.metadata = { ...base.metadata, ...incomingData.metadata };
  base.explicit_negatives = [...new Set([...base.explicit_negatives, ...incomingData.explicit_negatives])];
  if (incomingData.uncertainty.length > 0) base.uncertainty = incomingData.uncertainty;
  if (incomingData.supporting_excerpts.length > 0) base.supporting_excerpts = incomingData.supporting_excerpts;

  if (Array.isArray(incomingData.clinical_context?.concomitant_medications) && incomingData.clinical_context.concomitant_medications.length > 0) {
    const mergedConcomitant = [...new Set([...priorConcomitant, ...(incomingData.clinical_context.concomitant_medications || [])])];
    base.clinical_context.concomitant_medications = mergedConcomitant;
  }

  return base;
}

export function mergeNewFields(existing, newFields) {
  if (!newFields || typeof newFields !== 'object') return mergeExtractedData(existing, null);

  const base = mergeExtractedData(existing, null);
  const med = base.suspected_medicines[0] || {};
  const rxn = base.adverse_reactions[0] || {};

  if (newFields.suspected_medicine != null && newFields.suspected_medicine !== '') {
    med.name = newFields.suspected_medicine;
  }
  if (newFields.dosage != null && newFields.dosage !== '') {
    med.dosage = newFields.dosage;
  }
  if (newFields.frequency != null && newFields.frequency !== '') {
    med.frequency = newFields.frequency;
  }
  if (newFields.route != null && newFields.route !== '') {
    med.route = newFields.route;
  }

  if (Object.keys(med).length > 0 && base.suspected_medicines.length === 0) {
    base.suspected_medicines.push(med);
  } else if (Object.keys(med).length > 0) {
    base.suspected_medicines[0] = { ...base.suspected_medicines[0], ...med };
  }

  if (newFields.adverse_reaction != null && newFields.adverse_reaction !== '') {
    rxn.original_text = newFields.adverse_reaction;
    rxn.english_translation = newFields.adverse_reaction;
  }
  if (newFields.onset_date != null && newFields.onset_date !== '') {
    rxn.onset_date = newFields.onset_date;
  }

  if (Object.keys(rxn).length > 0 && base.adverse_reactions.length === 0) {
    base.adverse_reactions.push(rxn);
  } else if (Object.keys(rxn).length > 0) {
    base.adverse_reactions[0] = { ...base.adverse_reactions[0], ...rxn };
  }

  if (newFields.patient_initials != null && newFields.patient_initials !== '') {
    base.patient.initials = newFields.patient_initials;
  }
  if (newFields.age_group != null && newFields.age_group !== '') {
    base.patient.age_group = newFields.age_group;
  }
  if (newFields.gender != null && newFields.gender !== '') {
    base.patient.gender = newFields.gender;
  }

  if (newFields.reason_for_taking != null && newFields.reason_for_taking !== '') {
    base.clinical_context.reason_for_taking = newFields.reason_for_taking;
  }
  if (newFields.medical_history != null && newFields.medical_history !== '') {
    base.clinical_context.medical_history = newFields.medical_history;
  }
  if (newFields.outcome != null && newFields.outcome !== '') {
    base.clinical_context.outcome = newFields.outcome;
  }
  if (newFields.hospitalization != null) {
    base.clinical_context.hospitalization = newFields.hospitalization;
  }
  if (Array.isArray(newFields.concomitant_medications) && newFields.concomitant_medications.length > 0) {
    base.clinical_context.concomitant_medications = [
      ...new Set([...(base.clinical_context.concomitant_medications || []), ...newFields.concomitant_medications]),
    ];
  }

  if (newFields.dechallenge != null && newFields.dechallenge !== '') {
    base.causality_signals.dechallenge = newFields.dechallenge;
  }
  if (newFields.rechallenge != null && newFields.rechallenge !== '') {
    base.causality_signals.rechallenge = newFields.rechallenge;
  }

  if (newFields.reporter_type != null && newFields.reporter_type !== '') {
    base.metadata.reporter_type = newFields.reporter_type;
  }

  return base;
}
