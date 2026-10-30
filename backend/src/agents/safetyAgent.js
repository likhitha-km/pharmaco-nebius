import { chatCompletion } from '../services/nebiusService.js';
import { extractJson } from '../utils/parseJson.js';

// Agent 3 — seriousness triage (ICH E2A criteria).
// Decision support only. Rules enforced in code, not left to the model:
//   * missing information NEVER yields "non-serious"
//   * a case is only ever "not determined" / "potentially serious" / "serious"
//   * every case requires human review

export const SERIOUSNESS_CRITERIA = [
  { key: 'death', label: 'Death' },
  { key: 'life_threatening', label: 'Life-threatening event' },
  { key: 'hospitalisation', label: 'Hospitalisation / prolonged hospitalisation' },
  { key: 'disability', label: 'Persistent or significant disability / incapacity' },
  { key: 'congenital_anomaly', label: 'Congenital anomaly / birth defect' },
  { key: 'medically_important', label: 'Other medically important condition' },
];

const STATUSES = ['present', 'possible', 'ruled_out', 'unknown'];

// Deterministic safety net: surfaces obvious phrases even if the model is down.
const KEYWORD_RULES = [
  { key: 'death', re: /\b(died|death|passed away|deceased|expired)\b/i },
  { key: 'life_threatening', re: /(can'?t breathe|cannot breathe|difficulty breathing|trouble breathing|breathless|throat (is )?(closing|swelling|swollen)|swelling of (the )?(face|lips|tongue|throat)|anaphyla|unconscious|passed out|lost consciousness|seizure|convulsion|chest pain|blood in (vomit|stool)|severe bleeding|skin (is )?peeling|blisters)/i },
  { key: 'hospitalisation', re: /\b(hospitali[sz]ed|admitted|admission|icu|intensive care|emergency room|casualty|er visit|ward)\b/i },
  { key: 'disability', re: /\b(disabled|disability|paraly[sz]ed|can'?t walk|unable to walk|cannot work|permanent damage|vision loss|lost (my |his |her )?(sight|hearing))\b/i },
  { key: 'congenital_anomaly', re: /\b(birth defect|congenital|malformation|deformity at birth)\b/i },
];

const NEGATION_NEAR = /(no|not|never|without|didn'?t|did not|wasn'?t|was not|haven'?t|denies)\W+(\w+\W+){0,3}$/i;

function keywordHits(userText) {
  const hits = {};
  for (const rule of KEYWORD_RULES) {
    const m = userText.match(rule.re);
    if (!m) continue;
    const before = userText.slice(Math.max(0, m.index - 30), m.index);
    if (NEGATION_NEAR.test(before)) continue; // "not hospitalised" must not trigger
    const s = Math.max(0, m.index - 40);
    hits[rule.key] = userText.slice(s, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
  }
  return hits;
}

const SYSTEM_PROMPT = `You are a pharmacovigilance safety triage assistant supporting human reviewers. You do NOT diagnose and do NOT decide causality. Read the patient's messages and the extracted data, then judge each ICH E2A seriousness criterion.

Status values per criterion:
- "present": the patient clearly describes it (e.g. "admitted to hospital", "she stopped breathing").
- "possible": symptoms or wording suggest it could apply but it is not confirmed (e.g. severe symptoms, throat tightness, "very weak", "went to the emergency room" without admission details).
- "ruled_out": the patient explicitly said it did NOT happen (e.g. "treated at home, no hospital").
- "unknown": not mentioned. Missing information is "unknown" — NEVER "ruled_out".

Also set "emergency": true if the described symptoms could need immediate medical attention now (breathing difficulty, facial/throat swelling, widespread blistering/peeling skin, loss of consciousness, seizure, severe chest pain, severe bleeding, blood in vomit/stool). If emergency, "emergency_advice" must tell the patient to seek immediate medical help (call 112 or go to the nearest emergency department) and not wait for this report.

For each non-"unknown" criterion give "evidence": a short VERBATIM quote from the patient's messages (or null if none). Respond ONLY with JSON:
{
  "criteria": { "death": {"status":"unknown","evidence":null}, "life_threatening": {...}, "hospitalisation": {...}, "disability": {...}, "congenital_anomaly": {...}, "medically_important": {...} },
  "emergency": false,
  "emergency_advice": null,
  "rationale": "1-3 sentences explaining the flags, referencing only what the patient said"
}`;

function normaliseModelOutput(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed.criteria && typeof parsed.criteria === 'object' ? parsed.criteria : null;
  if (!c) return null;
  const out = {};
  for (const { key } of SERIOUSNESS_CRITERIA) {
    const entry = c[key] || {};
    const status = typeof entry.status === 'string' && STATUSES.includes(entry.status.toLowerCase()) ? entry.status.toLowerCase() : 'unknown';
    out[key] = { status, evidence: typeof entry.evidence === 'string' && entry.evidence.trim() ? entry.evidence.trim() : null };
  }
  return {
    criteria: out,
    emergency: parsed.emergency === true,
    emergency_advice: typeof parsed.emergency_advice === 'string' ? parsed.emergency_advice : null,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
  };
}

const DEFAULT_ADVICE = 'These symptoms may need urgent medical attention. Please call 112 or go to the nearest emergency department now — do not wait for this report to be reviewed.';

/**
 * Combine per-criterion statuses into a conservative overall classification.
 * Exported for unit tests.
 */
export function combineSeriousness(criteria, { emergency = false, severity = null } = {}) {
  const statuses = Object.values(criteria).map((c) => c.status);
  if (statuses.includes('present')) return 'serious';
  if (statuses.includes('possible') || emergency || severity === 'severe') return 'potentially_serious';
  // Even when nothing is flagged we never claim "non-serious": absence of
  // information is not evidence of absence, so a human must decide.
  return 'undetermined';
}

export async function assessSafety(extractedData, conversationHistory, { meta = null } = {}) {
  const userText = conversationHistory.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const rules = keywordHits(userText);
  const severity = extractedData?.adverse_reactions?.find((r) => r.severity)?.severity || null;

  let model = null;
  let modelError = null;
  try {
    const { content, model: modelId, usage, latencyMs } = await chatCompletion({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Patient messages:\n${userText}\n\nExtracted data (may be incomplete):\n${JSON.stringify({
          reactions: extractedData?.adverse_reactions, hospitalization: extractedData?.clinical_context?.hospitalization,
          outcome: extractedData?.clinical_context?.outcome, patient: extractedData?.patient,
        })}`,
      }],
      maxTokens: 900,
      temperature: 0.1,
      label: 'safety-triage',
    });
    if (meta) Object.assign(meta, { model: modelId, usage, latencyMs });
    model = normaliseModelOutput(extractJson(content));
    if (!model) modelError = 'Safety model returned invalid JSON';
  } catch (err) {
    modelError = err.message;
  }

  // Merge: the stricter of model vs. rules wins; model "ruled_out" is only
  // honoured if no rule hit contradicts it.
  const criteria = {};
  for (const { key, label } of SERIOUSNESS_CRITERIA) {
    const m = model?.criteria?.[key] || { status: 'unknown', evidence: null };
    let status = m.status;
    let evidence = m.evidence;
    let source = model ? 'nemotron' : 'rules';
    if (rules[key] && (status === 'unknown' || status === 'ruled_out')) {
      status = 'possible';
      evidence = rules[key];
      source = 'rules';
    }
    criteria[key] = { key, label, status, evidence, source };
  }

  const emergency = Boolean(model?.emergency) || Boolean(rules.life_threatening) || criteria.life_threatening.status === 'present';
  const overall = combineSeriousness(criteria, { emergency, severity });

  return {
    overall,
    overall_label: {
      serious: 'Serious indicators reported',
      potentially_serious: 'Potentially serious — needs urgent human review',
      undetermined: 'Seriousness not determined — human review required',
    }[overall],
    emergency: { flag: emergency, advice: emergency ? (model?.emergency_advice || DEFAULT_ADVICE) : null },
    criteria: SERIOUSNESS_CRITERIA.map(({ key }) => criteria[key]),
    rationale: model?.rationale || (modelError ? 'AI safety model unavailable; only rule-based keyword checks were applied.' : ''),
    requires_human_review: true,
    ai_generated: true,
    source: model ? 'nvidia-nemotron via Nebius Token Factory + rule-based safety net' : 'rule-based safety net only',
    model_error: modelError,
    disclaimer: 'Decision support only. Not a diagnosis. A qualified reviewer must confirm seriousness.',
  };
}
