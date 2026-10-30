import { chatCompletion } from '../services/nebiusService.js';
import { extractJson } from '../utils/parseJson.js';
import { EXTRACTION_SCHEMA_DESCRIPTION, validateExtraction, verifyExcerpts } from '../utils/adrSchema.js';

const SYSTEM_PROMPT = `You are a pharmacovigilance data extraction specialist. Extract structured ADR information from the conversation provided. Respond ONLY with valid JSON. No explanation, no markdown. For any field not present in the conversation, use null. For confidence, score 0.0 to 1.0 based on how explicitly the field was mentioned.

Never invent or guess a value that was not actually stated — leave it null/unknown instead. But do not under-extract either: read the WHOLE conversation carefully, including casual or indirect phrasing, and capture every fact the user actually gave, even if the answer to a specific field wasn't asked as a direct question. In particular:
- dechallenge: set to "positive" if the user says or implies the reaction got better/resolved/improved after the medicine was stopped or reduced (e.g. "she stopped it and the rash cleared up", "doctor took me off it and I felt better"). Set to "negative" if they say it did NOT improve after stopping. Otherwise "unknown".
- rechallenge: set to "positive" if symptoms returned after restarting the same medicine, "negative" if they did not return after restarting, "not_applicable" if the medicine was never restarted or this was never discussed.
- clinical_context.outcome: capture the patient's stated current status in their own words, normalized briefly (e.g. "fully recovered", "recovering", "still ongoing", "hospitalized then discharged") whenever they say anything about how they are now or how it ended — not just if asked "what is the outcome".
- clinical_context.hospitalization: true/false only if explicitly stated (e.g. "admitted to hospital" = true, "treated at home" = false); otherwise null.
- clinical_context.concomitant_medications: every OTHER medicine the patient says they take (e.g. "I also take amlodipine 5 mg for blood pressure" -> ["amlodipine 5 mg"]). Do not include the suspected medicine. Add "concomitant_medications" to explicit_negatives only if they say they take no other medicines.
- adverse_reactions[].still_ongoing: true/false only if the patient clearly says the reaction is continuing or has fully gone; "much better" or "improving" is NOT resolved — leave null. Only list "allergies" in explicit_negatives if the patient explicitly said they have none.
Only set these when the conversation genuinely supports the value — this is about not missing what was actually said, not about guessing what probably happened.

Missing vs negative: null means the user never said. Use explicit_negatives ONLY when the user explicitly said something does not apply (e.g. "no other medicines", "no medical history"). Never treat silence as a negative answer. For every key fact you extract, add a supporting_excerpts entry with a short VERBATIM quote from the Patient's messages. List vague, contradictory or inferred values in uncertainty. The age/sex/medicine may only come from what the patient said.`;

/**
 * Extract structured pharmacovigilance data from conversation.
 * The model output is parsed and validated against the ADR extraction schema.
 * @param {Array} conversationHistory - [{role, content}]
 * @param {{strict?: boolean}} options - strict: throw on failure instead of returning empty data
 * @returns {Object} extracted structured data
 */
export async function extractFromConversation(conversationHistory, { strict = false, meta = null } = {}) {
  const systemWithSchema = `${SYSTEM_PROMPT}\n\nOutput EXACTLY this JSON structure:\n${EXTRACTION_SCHEMA_DESCRIPTION}`;

  // Flatten conversation to text for extraction
  const conversationText = conversationHistory
    .map((m) => `${m.role === 'user' ? 'Patient' : 'Assistant'}: ${m.content}`)
    .join('\n');
  const userText = conversationHistory.filter((m) => m.role === 'user').map((m) => m.content).join('\n');

  try {
    let lastIssues = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, model, usage, latencyMs } = await chatCompletion({
        systemPrompt: systemWithSchema,
        messages: [{ role: 'user', content: `Extract from this conversation:\n\n${conversationText}` }],
        maxTokens: 2000,
        temperature: attempt === 0 ? 0.1 : 0,
        label: 'extraction',
      });
      if (meta) Object.assign(meta, { model, usage, latencyMs });

      const parsed = extractJson(content);
      if (!parsed) { lastIssues = ['Extraction model returned no parseable JSON']; continue; }
      const { ok, data, issues } = validateExtraction(parsed);
      if (!ok) { lastIssues = issues; continue; }
      if (meta) meta.issues = issues;
      return verifyExcerpts(data, userText);
    }
    throw new Error(lastIssues.join('; ') || 'Extraction failed validation');
  } catch (error) {
    console.error('[ExtractionAgent] error:', error.message);
    if (strict) throw error;
    // Non-strict (live chat turns): return a minimal valid structure so the conversation continues.
    return {
      suspected_medicines: [],
      adverse_reactions: [],
      patient: { initials: null, age_group: null, gender: null, weight: null, is_pregnant: null, is_breastfeeding: null, special_populations: [] },
      causality_signals: { dechallenge: 'unknown', rechallenge: 'not_applicable', temporal_relationship: null, alternative_explanation: null },
      clinical_context: { reason_for_taking: null, medical_history: null, concomitant_medications: [], hospitalization: null, outcome: null },
      metadata: { language_detected: 'en-IN', reporter_type: 'anonymous', report_type: 'adr' },
      explicit_negatives: [],
      uncertainty: [],
      supporting_excerpts: [],
    };
  }
}
