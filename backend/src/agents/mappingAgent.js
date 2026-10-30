import { chatCompletion } from '../services/nebiusService.js';
import { extractJson } from '../utils/parseJson.js';

// Agent 4 — terminology mapping + WHO-UMC evidence organisation.
//
// IMPORTANT: Pharmaco does not bundle the licensed MedDRA dictionary, so this
// agent never emits MedDRA numeric codes. It proposes a candidate Preferred
// Term from a small local reference list of common PT names, and every mapping
// is marked `requires_verification`. Causality is a *suggested* WHO-UMC
// category with its evidence — a human reviewer decides.

const CANDIDATE_PREFERRED_TERMS = [
  'Dizziness', 'Nausea', 'Vomiting', 'Headache', 'Rash', 'Fatigue', 'Chest pain', 'Tremor', 'Dyspnoea', 'Abdominal pain',
  'Insomnia', 'Palpitations', 'Oedema', 'Pruritus', 'Dry mouth', 'Diarrhoea', 'Constipation', 'Vision blurred', 'Hypertension',
  'Hypotension', 'Tachycardia', 'Bradycardia', 'Urticaria', 'Alopecia', 'Jaundice', 'Confusional state', 'Anxiety', 'Depression',
  'Weight increased', 'Weight decreased', 'Myalgia', 'Arthralgia', 'Pyrexia', 'Chills', 'Hyperhidrosis', 'Flushing',
  'Decreased appetite', 'Flatulence', 'Dyspepsia', 'Gastritis', 'Hepatotoxicity', 'Nephrotoxicity', 'Peripheral neuropathy',
  'Paraesthesia', 'Amnesia', 'Somnolence', 'Hallucination', 'Agitation', 'Syncope', 'Vertigo', 'Tinnitus', 'Angioedema',
  'Anaphylactic reaction', 'Stevens-Johnson syndrome', 'Drug reaction with eosinophilia and systemic symptoms',
  'Thrombocytopenia', 'Leukopenia', 'Anaemia', 'Hyperglycaemia', 'Hypoglycaemia', 'Hyponatraemia', 'Hypokalaemia',
  'Electrocardiogram QT prolonged', 'Pulmonary embolism', 'Deep vein thrombosis', 'Cerebrovascular accident',
  'Myocardial infarction', 'Renal failure', 'Hepatic failure', 'Pancreatitis', 'Colitis', 'Photosensitivity reaction', 'Acne',
  'Dry skin', 'Muscular weakness', 'Back pain', 'Joint swelling', 'Cough', 'Rhinitis', 'Conjunctivitis', 'Swelling face',
];

const SYSTEM_PROMPT = `You are a pharmacovigilance terminology and causality-evidence assistant supporting a human reviewer. You never make a final causality decision.

TASK 1 — terminology: for each reported reaction, suggest a MedDRA-style Preferred Term ONLY if one from this candidate list is a clear match:
${CANDIDATE_PREFERRED_TERMS.join(' | ')}
If no listed term clearly matches, set "candidate_term" to null. Always give "provisional_description": a short neutral clinical description of what the patient reported. Do NOT output any numeric codes. Do not invent terms.

TASK 2 — WHO-UMC evidence: using ONLY the supplied data, list evidence for and against a causal link (temporal relationship, dechallenge, rechallenge, alternative explanations such as other medicines or disease, pharmacological plausibility only if well known), list information missing that would matter for causality, and suggest a WHO-UMC category from: "Certain", "Probable/Likely", "Possible", "Unlikely", "Conditional/Unclassified", "Unassessable/Unclassifiable". Be conservative; if the data is thin choose "Possible" or "Unassessable/Unclassifiable". Write a 2-4 sentence neutral evidence summary that states what is unknown.

Respond ONLY with JSON:
{
  "meddra_mappings": [ { "original_text": "string", "candidate_term": "string|null", "provisional_description": "string", "mapping_confidence": 0.0, "mapping_notes": "string|null" } ],
  "causality_assessment": {
    "category": "Certain|Probable/Likely|Possible|Unlikely|Conditional/Unclassified|Unassessable/Unclassifiable",
    "evidence_for": ["string"], "evidence_against": ["string"], "missing_information": ["string"],
    "who_umc_basis": "string (evidence summary)", "confidence": 0.0
  }
}`;

const WHO_UMC = ['Certain', 'Probable/Likely', 'Possible', 'Unlikely', 'Conditional/Unclassified', 'Unassessable/Unclassifiable'];
const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/**
 * Code-level guard rails: the model's suggested category can never exceed what
 * the recorded evidence supports.
 */
export function constrainCausality(category, signals = {}, hasTemporalInfo = false) {
  let cat = WHO_UMC.includes(category) ? category : 'Unassessable/Unclassifiable';
  const notes = [];
  const dech = signals.dechallenge;
  const rech = signals.rechallenge;
  if (cat === 'Certain' && rech !== 'positive') { cat = 'Probable/Likely'; notes.push('Downgraded from Certain: no positive rechallenge recorded.'); }
  if (['Certain', 'Probable/Likely'].includes(cat) && dech !== 'positive' && dech !== 'negative') {
    cat = 'Possible';
    notes.push('Downgraded to Possible: dechallenge information is missing.');
  }
  if (['Certain', 'Probable/Likely', 'Possible'].includes(cat) && !hasTemporalInfo) {
    cat = 'Unassessable/Unclassifiable';
    notes.push('Set to Unassessable: no timing information linking the medicine and the reaction.');
  }
  return { category: cat, notes };
}

/**
 * Map reactions to candidate terms and organise WHO-UMC evidence.
 * @param {Object} extractedData
 * @param {{strict?: boolean, meta?: object}} options
 */
export async function mapToMedDRA(extractedData, { strict = false, meta = null } = {}) {
  const reactions = extractedData.adverse_reactions || [];
  const signals = extractedData.causality_signals || {};
  const med = extractedData.suspected_medicines?.[0] || {};
  const hasTemporalInfo = Boolean(
    reactions[0]?.onset_date || med.start_date || signals.temporal_relationship
  );

  const inputText = JSON.stringify({
    suspected_medicine: { name: med.name, start_date: med.start_date, stop_date: med.stop_date, stopped: med.stopped },
    adverse_reactions: reactions,
    causality_signals: signals,
    clinical_context: extractedData.clinical_context || {},
  });

  const fallback = (reason) => ({
    meddra_mappings: reactions.map((r) => ({
      original_text: r.original_text || '',
      candidate_term: null,
      preferred_term: r.english_translation || r.original_text || null,
      meddra_code: null,
      soc: null,
      provisional_description: r.english_translation || r.original_text || '',
      mapping_confidence: null,
      mapping_status: 'provisional',
      requires_verification: true,
      mapping_notes: `Terminology mapping unavailable (${reason}) — provisional description only; requires verification.`,
    })),
    causality_assessment: {
      category: 'Unassessable/Unclassifiable',
      evidence_for: [], evidence_against: [], missing_information: [],
      who_umc_basis: `Causality could not be organised automatically (${reason}). Manual assessment required.`,
      confidence: null, flags_for_review: ['AI assessment unavailable'], guard_notes: [],
      suggested_by_ai: false,
    },
    seriousness: { is_serious: null, criteria: [], requires_expedited_reporting: null },
    ai_error: reason,
  });

  try {
    const { content, model, usage, latencyMs } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `Map these reactions and organise causality evidence:\n${inputText}` }],
      maxTokens: 1800,
      temperature: 0.1,
      label: 'assessment',
    });
    if (meta) Object.assign(meta, { model, usage, latencyMs });

    const parsed = extractJson(content);
    if (!parsed || !Array.isArray(parsed.meddra_mappings) || !parsed.causality_assessment) {
      throw new Error('Assessment model returned invalid JSON');
    }

    const allowed = new Set(CANDIDATE_PREFERRED_TERMS.map((t) => t.toLowerCase()));
    const mappings = parsed.meddra_mappings.map((m, i) => {
      const cand = typeof m.candidate_term === 'string' && allowed.has(m.candidate_term.toLowerCase())
        ? CANDIDATE_PREFERRED_TERMS.find((t) => t.toLowerCase() === m.candidate_term.toLowerCase())
        : null;
      const description = m.provisional_description || reactions[i]?.english_translation || m.original_text || '';
      return {
        original_text: m.original_text || reactions[i]?.original_text || '',
        candidate_term: cand,
        preferred_term: cand || description || null, // kept for existing UI consumers
        meddra_code: null, // never fabricated — licensed MedDRA dictionary not bundled
        soc: null,
        provisional_description: description,
        mapping_confidence: typeof m.mapping_confidence === 'number' ? Math.min(1, Math.max(0, m.mapping_confidence)) : null,
        mapping_status: 'provisional',
        requires_verification: true,
        mapping_notes: m.mapping_notes || (cand ? 'Candidate term from a local reference list; verify against MedDRA.' : 'No clear candidate term — verify terminology manually.'),
      };
    });

    const c = parsed.causality_assessment;
    const { category, notes } = constrainCausality(c.category, signals, hasTemporalInfo);
    return {
      meddra_mappings: mappings,
      causality_assessment: {
        category,
        evidence_for: strArr(c.evidence_for),
        evidence_against: strArr(c.evidence_against),
        missing_information: strArr(c.missing_information),
        who_umc_basis: typeof c.who_umc_basis === 'string' ? c.who_umc_basis : '',
        confidence: typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : null,
        flags_for_review: ['AI-suggested category — reviewer must confirm'],
        guard_notes: notes,
        suggested_by_ai: true,
      },
      seriousness: { is_serious: null, criteria: [], requires_expedited_reporting: null },
    };
  } catch (error) {
    console.error('[MappingAgent] error:', error.message);
    if (strict) throw error;
    return fallback(error.message);
  }
}
