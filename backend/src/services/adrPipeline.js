import { extractFromConversation } from '../agents/extractionAgent.js';
import { assessSafety } from '../agents/safetyAgent.js';
import { mapToMedDRA } from '../agents/mappingAgent.js';
import { assessCompleteness } from '../agents/completenessAgent.js';
import { chatCompletion, getModelInfo } from './nebiusService.js';
import { extractJson } from '../utils/parseJson.js';
import { mergeExtractedData } from '../utils/extractedData.js';
import { computeFieldStatus } from '../utils/adrSchema.js';
import {
  getConversation, updateConversation, saveReport, getReport, getReportsByConversationId,
} from './firebaseService.js';

// Orchestrates the multi-step ADR agent workflow for a conversation:
//   Agent 2 extraction -> Agent 3 safety triage + Agent 4 PV assessment (parallel)
//   -> Agent 5 report generation -> persisted draft awaiting human review.

const inflight = new Map(); // conversationId -> Promise (prevents duplicate concurrent runs)

export function reportIdFor(conversationId) {
  return `ADR-${String(conversationId).replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

async function timed(name, fn) {
  const started = Date.now();
  try {
    const value = await fn();
    return { value, step: { name, status: 'done', ms: Date.now() - started } };
  } catch (err) {
    return { error: err, step: { name, status: 'error', ms: Date.now() - started, error: err.message } };
  }
}

function buildTimeline(data) {
  const med = data.suspected_medicines?.[0] || {};
  const rxn = data.adverse_reactions?.[0] || {};
  const t = [];
  if (med.start_date) t.push({ event: `${med.name || 'Medicine'} started`, when: med.start_date });
  if (rxn.onset_date) t.push({ event: 'Reaction began', when: rxn.onset_date });
  if (med.stop_date) t.push({ event: `${med.name || 'Medicine'} stopped`, when: med.stop_date });
  else if (med.stopped === true) t.push({ event: `${med.name || 'Medicine'} stopped`, when: 'date not stated' });
  if (rxn.resolution_date) t.push({ event: 'Reaction resolved', when: rxn.resolution_date });
  else if (data.clinical_context?.outcome) t.push({ event: `Outcome: ${data.clinical_context.outcome}`, when: 'date not stated' });
  return t;
}

function deterministicSummary(data, safety, mapping, missing) {
  const med = data.suspected_medicines?.[0];
  const rxn = data.adverse_reactions?.[0];
  const parts = [];
  parts.push(`${med?.name || 'An unspecified medicine'} was reported as the suspected medicine${rxn ? `, with the reported reaction "${rxn.english_translation || rxn.original_text}"` : ''}.`);
  parts.push(`Seriousness: ${safety.overall_label}.`);
  if (missing.length) parts.push(`Information still missing: ${missing.map((m) => m.label.toLowerCase()).join(', ')}.`);
  parts.push('This summary was assembled by rules, not by the AI model, and requires human review.');
  return parts.join(' ');
}

async function generateEvidenceSummary(structured, fallbackText, meta) {
  const system = `You write a short neutral evidence summary of a suspected adverse drug reaction case for a pharmacovigilance reviewer. Use ONLY the facts in the JSON. Do not diagnose, do not state a definitive causality conclusion, do not invent doses, dates or history. Explicitly mention the most important missing information. 3-5 sentences, plain English. Respond ONLY with JSON: {"evidence_summary": "string"}`;
  try {
    const { content, model, usage, latencyMs } = await chatCompletion({
      systemPrompt: system,
      messages: [{ role: 'user', content: JSON.stringify(structured) }],
      maxTokens: 700,
      temperature: 0.2,
      label: 'report-summary',
    });
    Object.assign(meta, { model, usage, latencyMs });
    const parsed = extractJson(content);
    if (parsed && typeof parsed.evidence_summary === 'string' && parsed.evidence_summary.trim()) {
      return { text: parsed.evidence_summary.trim(), ai_generated: true };
    }
    throw new Error('Summary model returned invalid JSON');
  } catch (err) {
    meta.error = err.message;
    return { text: fallbackText, ai_generated: false, note: `AI summary unavailable (${err.message})` };
  }
}

async function run(conversationId) {
  const conversation = await getConversation(conversationId);
  if (!conversation) {
    const e = new Error('Conversation not found'); e.statusCode = 404; throw e;
  }
  const history = (conversation.messages || []).map((m) => ({ role: m.role, content: m.content }));
  if (!history.some((m) => m.role === 'user')) {
    const e = new Error('Nothing to assess yet — the patient has not described a reaction.'); e.statusCode = 400; throw e;
  }

  const steps = [];
  const modelCalls = {};

  // Agent 2 — extraction (strict: a failure must surface, not produce an empty report)
  const exMeta = {};
  const ex = await timed('extraction', () => extractFromConversation(history, { strict: true, meta: exMeta }));
  steps.push(ex.step);
  if (ex.error) {
    const e = new Error(`Clinical extraction failed: ${ex.error.message}`); e.statusCode = 502; e.steps = steps; throw e;
  }
  modelCalls.extraction = exMeta;
  const extractedData = mergeExtractedData(conversation.extractedData || null, ex.value);
  // Evidence/uncertainty always come from the fresh full-conversation pass.
  extractedData.supporting_excerpts = ex.value.supporting_excerpts;
  extractedData.uncertainty = ex.value.uncertainty;

  // Agents 3 & 4 in parallel
  const safetyMeta = {}; const mapMeta = {};
  const [sf, mp] = await Promise.all([
    timed('safety_triage', () => assessSafety(extractedData, history, { meta: safetyMeta })),
    timed('pv_assessment', () => mapToMedDRA(extractedData, { strict: false, meta: mapMeta })),
  ]);
  steps.push(sf.step, mp.step);
  if (sf.error) {
    const e = new Error(`Safety triage failed: ${sf.error.message}`); e.statusCode = 502; e.steps = steps; throw e;
  }
  const safety = sf.value;
  const mapping = mp.value; // never throws in non-strict; ai_error set on degradation
  if (mapping.ai_error) steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'degraded', error: mapping.ai_error };
  modelCalls.safety_triage = safetyMeta;
  modelCalls.pv_assessment = mapMeta;

  const fieldStatus = computeFieldStatus(extractedData);
  const missing = fieldStatus.filter((f) => f.status === 'missing');
  const negatives = fieldStatus.filter((f) => f.status === 'negative');
  const completeness = await assessCompleteness(extractedData);

  const med = extractedData.suspected_medicines?.[0] || {};
  const rxn = extractedData.adverse_reactions?.[0] || {};
  const patient = extractedData.patient || {};
  const clin = extractedData.clinical_context || {};

  const structured = {
    patient: { age: patient.age_group || null, sex: patient.gender || null, initials: patient.initials || null, weight: patient.weight || null, pregnant: patient.is_pregnant ?? null },
    suspected_drug: {
      name: med.name || null, brand_name: med.brand_name || null, dose: med.dosage || null, frequency: med.frequency || null, route: med.route || null,
      indication: clin.reason_for_taking || null, start_date: med.start_date || null, stop_date: med.stop_date || null, stopped: med.stopped ?? null,
    },
    reaction: {
      description: rxn.original_text || null, english_description: rxn.english_translation || null, onset: rxn.onset_date || null,
      severity_reported: rxn.severity || null, ongoing: rxn.still_ongoing ?? null, outcome: clin.outcome || null,
      improved_after_stopping: extractedData.causality_signals?.dechallenge || 'unknown',
    },
    timeline: buildTimeline(extractedData),
    seriousness: { overall: safety.overall, label: safety.overall_label, emergency: safety.emergency, criteria: safety.criteria.map(({ key, label, status, evidence }) => ({ key, label, status, evidence })), rationale: safety.rationale },
    medical_history: { history: clin.medical_history || null, other_medicines: clin.concomitant_medications || [] },
    assessment: {
      terminology: mapping.meddra_mappings,
      causality: { ...mapping.causality_assessment, disclaimer: 'AI-suggested WHO-UMC category from the evidence above. Not a causality determination; reviewer must confirm.' },
    },
    missing_information: missing.map((m) => ({ key: m.key, label: m.label, required: m.required })),
    reported_as_not_applicable: negatives.map((m) => ({ key: m.key, label: m.label })),
  };

  // Agent 5 — AI evidence summary (assembled report fields above are deterministic)
  const sumMeta = {};
  const t0 = Date.now();
  const evidence_summary = await generateEvidenceSummary(structured, deterministicSummary(extractedData, safety, mapping, missing), sumMeta);
  steps.push({ name: 'report_generation', status: evidence_summary.ai_generated ? 'done' : 'degraded', ms: Date.now() - t0, ...(sumMeta.error ? { error: sumMeta.error } : {}) });
  modelCalls.report_generation = sumMeta;

  const info = getModelInfo();
  const now = new Date().toISOString();

  // Reuse any existing report for this conversation so re-runs update, never duplicate.
  const existing = (await getReportsByConversationId(conversationId, 20)).find((r) => r.status !== 'withdrawn');
  const reportId = existing?.id || reportIdFor(conversationId);

  const adrReport = {
    schema_version: '1.0',
    report_id: reportId,
    conversation_id: conversationId,
    status: 'draft',
    generated_at: now,
    synthetic_data: Boolean(conversation.synthetic),
    ...structured,
    evidence_summary,
    completeness_score: completeness.completeness_score,
    provenance: {
      supporting_excerpts: extractedData.supporting_excerpts || [],
      uncertainty: extractedData.uncertainty || [],
      statement: 'Fields are AI-extracted from the patient conversation. Items marked unverified excerpts could not be matched to the conversation text.',
    },
    human_review: { status: 'pending_review', reviewer: null, decision_at: null, note: null },
    ai: {
      provider: info.provider,
      model: info.model,
      endpoint: info.endpoint,
      calls: Object.fromEntries(Object.entries(modelCalls).map(([k, v]) => [k, { model: v.model || null, latency_ms: v.latencyMs ?? null, total_tokens: v.usage?.total_tokens ?? null }])),
    },
    disclaimer: 'DRAFT generated by AI to assist pharmacovigilance professionals. It is not a diagnosis, does not establish causality, and must be reviewed and approved by an authorised human before use.',
  };

  const assessment = { generatedAt: now, steps, model: info.model, provider: info.provider, report: adrReport, safety, extractionIssues: exMeta.issues || [] };

  const meddraData = {
    ...mapping,
    seriousness: {
      is_serious: safety.overall === 'serious' ? true : null,
      overall: safety.overall,
      criteria: safety.criteria.filter((c) => ['present', 'possible'].includes(c.status)).map((c) => c.label),
      requires_expedited_reporting: null,
    },
  };

  await updateConversation(conversationId, {
    extractedData, meddraData, completenessScore: completeness.completeness_score, adrAssessment: assessment,
    status: conversation.status === 'completed' ? 'completed' : 'report_ready',
  });

  await saveReport({
    ...(existing || {}),
    id: reportId,
    conversationId,
    userId: existing?.userId || conversation.userId,
    status: existing?.status || 'draft',
    extractedData,
    meddraMapping: meddraData,
    causality: meddraData.causality_assessment,
    completenessScore: completeness.completeness_score,
    isAnonymous: conversation.isAnonymous,
    language: conversation.language,
    title: med.name || 'ADR Draft',
    reaction: rxn.original_text || null,
    adrReport,
    humanReview: adrReport.human_review,
    createdAt: existing?.createdAt,
    updatedAt: now,
  });

  return { assessment, extractedData, meddraData, completenessScore: completeness.completeness_score, reportId };
}

/** Run (or join an already-running) assessment for a conversation. */
export function runAdrAssessment(conversationId) {
  if (inflight.has(conversationId)) return inflight.get(conversationId);
  const p = run(conversationId).finally(() => inflight.delete(conversationId));
  inflight.set(conversationId, p);
  return p;
}

export async function reviewAdrReport(conversationId, { decision, reviewerName, reviewerId, note, confirmed }) {
  const conversation = await getConversation(conversationId);
  const assessment = conversation?.adrAssessment;
  if (!assessment) { const e = new Error('No generated report to review.'); e.statusCode = 404; throw e; }
  if (!['approve', 'reject', 'needs_info'].includes(decision)) { const e = new Error('decision must be approve, reject or needs_info'); e.statusCode = 400; throw e; }
  if (!reviewerName || !String(reviewerName).trim()) { const e = new Error('Reviewer name is required'); e.statusCode = 400; throw e; }
  if (decision === 'approve' && confirmed !== true) { const e = new Error('Approval requires the reviewer to confirm they have inspected the report'); e.statusCode = 400; throw e; }

  const statusMap = { approve: 'approved', reject: 'rejected', needs_info: 'needs_more_information' };
  const human_review = {
    status: statusMap[decision],
    reviewer: { name: String(reviewerName).trim(), id: reviewerId || null },
    decision_at: new Date().toISOString(),
    note: note ? String(note).trim() : null,
  };
  const report = { ...assessment.report, status: decision === 'approve' ? 'approved' : 'draft', human_review };
  await updateConversation(conversationId, { adrAssessment: { ...assessment, report } });

  const stored = await getReport(assessment.report.report_id);
  if (stored) await saveReport({ ...stored, adrReport: report, humanReview: human_review });
  return report;
}
