import { callGroq, MODEL_SMART } from '../services/nebiusService.js';
import { v4 as uuidv4 } from 'uuid';
import { extractJson } from '../utils/parseJson.js';

const SYSTEM_PROMPT = `You are a CDSCO pharmacovigilance officer generating Individual Case Safety Reports (ICSR) for India's Pharmacovigilance Programme of India (PvPI). Generate reports in compliance with ICSR reporting standards. Produce a professional, clinically appropriate narrative summary and all structured ICSR fields. Never invent facts or terminology codes: use null for anything not in the input data, set meddra_code to null, and set seriousness to "Undetermined" unless the input explicitly establishes it. Respond ONLY with valid JSON.`;

/**
 * Generate a complete ICSR report from extracted and mapped data.
 * @param {Object} extractedData - from extractionAgent
 * @param {Object} meddraData - from mappingAgent
 * @param {Object} completenessData - from completenessAgent
 * @returns {Object} complete ICSR report
 */
export async function generateICSR(extractedData, meddraData, completenessData) {
  const reportId = 'PVP-' + uuidv4().slice(0, 8).toUpperCase();

  const inputData = JSON.stringify({
    extracted: extractedData,
    meddra: meddraData,
    completeness: completenessData,
  });

  const outputSchema = `{
    "report_id": "${reportId}",
    "report_type": "Initial|Follow-up",
    "seriousness": "Serious|Non-serious|Undetermined",
    "patient": {
      "initials": "string|null",
      "age_group": "string|null",
      "gender": "string|null",
      "weight": "string|null",
      "is_pregnant": null,
      "is_breastfeeding": null,
      "special_populations": []
    },
    "adverse_events": [
      {
        "original_text": "string",
        "meddra_preferred_term": "string",
        "meddra_code": "null",
        "onset_date": "string|null",
        "resolution_date": "string|null",
        "severity": "mild|moderate|severe|null",
        "outcome": "string|null"
      }
    ],
    "suspect_drugs": [
      {
        "name": "string",
        "dosage": "string|null",
        "frequency": "string|null",
        "route": "string|null",
        "start_date": "string|null",
        "stop_date": "string|null",
        "indication": "string|null"
      }
    ],
    "causality": {
      "who_umc_category": "Certain|Probable|Possible|Unlikely",
      "basis": "string"
    },
    "narrative": "string (2-4 sentences professional clinical narrative)",
    "missing_information_checklist": [],
    "completeness_score": 0,
    "recommended_action": "string",
    "generated_timestamp": "${new Date().toISOString()}",
    "pvpi_submission_ready": false
  }`;

  try {
    const raw = await callGroq(
      `${SYSTEM_PROMPT}\n\nGenerate ICSR following this EXACT JSON structure:\n${outputSchema}`,
      [{ role: 'user', content: `Generate ICSR from this data:\n${inputData}` }],
      MODEL_SMART,
      2000,
      0.1
    );

    const report = extractJson(raw);
    if (!report) throw new Error('Report generation model returned no parseable JSON');

    // Ensure report_id and timestamp are set
    report.report_id = reportId;
    report.generated_timestamp = new Date().toISOString();
    report.completeness_score = completenessData?.completeness_score || 0;
    report.pvpi_submission_ready = (completenessData?.completeness_score || 0) >= 60;

    return report;
  } catch (error) {
    console.error('[ReportAgent] error:', error.message);
    // Generate minimal ICSR from raw data
    return buildFallbackICSR(reportId, extractedData, meddraData, completenessData);
  }
}

function buildFallbackICSR(reportId, extracted, meddra, completeness) {
  const medicine = extracted?.suspected_medicines?.[0];
  const reaction = extracted?.adverse_reactions?.[0];

  return {
    report_id: reportId,
    report_type: 'Initial',
    seriousness: meddra?.seriousness?.is_serious ? 'Serious' : 'Undetermined',
    patient: extracted?.patient || {},
    adverse_events: (extracted?.adverse_reactions || []).map((r, i) => ({
      original_text: r.original_text,
      meddra_preferred_term: meddra?.meddra_mappings?.[i]?.preferred_term || r.english_translation || r.original_text,
      meddra_code: meddra?.meddra_mappings?.[i]?.meddra_code || null,
      onset_date: r.onset_date,
      resolution_date: r.resolution_date,
      severity: r.severity,
      outcome: extracted?.clinical_context?.outcome,
    })),
    suspect_drugs: extracted?.suspected_medicines || [],
    causality: {
      who_umc_category: meddra?.causality_assessment?.category || 'Unassessable/Unclassifiable',
      basis: meddra?.causality_assessment?.who_umc_basis || 'Insufficient data',
    },
    narrative: `Patient reported ${reaction?.original_text || 'adverse reaction'} after taking ${medicine?.name || 'suspected medicine'}. ${reaction?.onset_date ? `Onset: ${reaction.onset_date}.` : ''} ${extracted?.clinical_context?.outcome ? `Outcome: ${extracted.clinical_context.outcome}.` : ''}`,
    missing_information_checklist: completeness?.missing_fields || [],
    completeness_score: completeness?.completeness_score || 0,
    recommended_action: 'Manual review required before PvPI submission',
    generated_timestamp: new Date().toISOString(),
    pvpi_submission_ready: false,
  };
}
