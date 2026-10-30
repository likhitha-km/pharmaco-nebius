// Integration test: real calls to Nebius Token Factory (NVIDIA Nemotron).
// Skipped automatically when NEBIUS_API_KEY is not configured.
// Persistence is forced to the in-memory store so no Firestore data is touched.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FIREBASE_SERVICE_ACCOUNT_PATH = '/nonexistent/serviceAccount.json';
process.env.NEBIUS_MAX_RETRIES = '1';

const { isConfigured, NEMOTRON_MODEL, chatCompletion } = await import('../src/services/nebiusService.js');
const { saveConversation, getReportsByConversationId, getConversation } = await import('../src/services/firebaseService.js');
const { runAdrAssessment, reviewAdrReport } = await import('../src/services/adrPipeline.js');

const skip = !isConfigured() && 'NEBIUS_API_KEY not configured';

// Fictional patient — synthetic data only.
const SYNTHETIC_MESSAGES = [
  'I am a 54 year old woman. I took Augmentin 625 mg twice a day for a throat infection and I got an itchy red rash on my chest and arms.',
  'I started it on 12 October and the rash began on 14 October in the evening. My lips also felt swollen, so my husband took me to the emergency room. They gave me an injection and kept me overnight for observation.',
  'I stopped Augmentin on 15 October and the rash got much better within two days. I also take amlodipine 5 mg for blood pressure, and nothing else. I have no other medical problems.',
];

test('Nebius Token Factory serves the NVIDIA Nemotron model', { skip, timeout: 90000 }, async () => {
  const res = await chatCompletion({ systemPrompt: 'Reply with the single word: ok', messages: [{ role: 'user', content: 'ping' }], maxTokens: 20, label: 'test-ping' });
  assert.ok(res.content.length > 0);
  assert.match(res.model, /nemotron/i);
  assert.match(NEMOTRON_MODEL, /^nvidia\//);
  assert.ok(res.usage?.total_tokens > 0);
});

test('end-to-end ADR workflow on a synthetic patient', { skip, timeout: 300000 }, async () => {
  const conversationId = 'test-conv-' + Date.now();
  const now = new Date().toISOString();
  await saveConversation({
    id: conversationId, userId: 'test-user', language: 'en-IN', userType: 'patient', isAnonymous: true, status: 'active', synthetic: true, extractedData: null,
    messages: [
      { role: 'assistant', content: 'Hello, which medicine did you take?', timestamp: now },
      ...SYNTHETIC_MESSAGES.flatMap((m) => [{ role: 'user', content: m, timestamp: now }]),
    ],
  });

  const result = await runAdrAssessment(conversationId);
  const { report } = result.assessment;

  // Extraction (Agent 2)
  assert.match(report.suspected_drug.name || '', /augmentin/i);
  assert.ok(report.reaction.description);
  assert.ok(report.reaction.onset, 'onset date should be extracted');
  assert.equal(report.suspected_drug.stopped, true);
  assert.equal(report.reaction.improved_after_stopping, 'positive');
  assert.ok(report.medical_history.other_medicines.some((m) => /amlodipine/i.test(m)));

  // Safety triage (Agent 3): hospital observation + lip swelling must never be non-serious
  assert.ok(['serious', 'potentially_serious'].includes(report.seriousness.overall), `got ${report.seriousness.overall}`);
  assert.equal(report.seriousness.criteria.find((c) => c.key === 'hospitalisation').status !== 'unknown', true);

  // PV assessment (Agent 4): no fabricated MedDRA codes, mapping flagged for verification
  for (const t of report.assessment.terminology) {
    assert.equal(t.meddra_code, null);
    assert.equal(t.requires_verification, true);
  }
  assert.ok(report.assessment.causality.category);
  assert.equal(report.assessment.causality.suggested_by_ai, true);

  // Report (Agent 5): draft + human review pending + model provenance recorded
  assert.equal(report.status, 'draft');
  assert.equal(report.human_review.status, 'pending_review');
  assert.equal(report.synthetic_data, true);
  assert.match(report.ai.model, /nemotron/i);
  assert.ok(report.evidence_summary.text.length > 20);

  // Idempotent: re-running updates the same report, never creates a duplicate
  const again = await runAdrAssessment(conversationId);
  assert.equal(again.reportId, result.reportId);
  const stored = await getReportsByConversationId(conversationId);
  assert.equal(stored.length, 1);

  // Concurrent runs share one execution
  const [a, b] = await Promise.all([runAdrAssessment(conversationId), runAdrAssessment(conversationId)]);
  assert.equal(a, b);

  // Human review gate
  await assert.rejects(() => reviewAdrReport(conversationId, { decision: 'approve', reviewerName: 'Dr Test' }), /confirm/i);
  const approved = await reviewAdrReport(conversationId, { decision: 'approve', reviewerName: 'Dr Test', confirmed: true, note: 'ok' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.human_review.reviewer.name, 'Dr Test');
  const conv = await getConversation(conversationId);
  assert.equal(conv.adrAssessment.report.human_review.status, 'approved');
});

test('assessment of an empty conversation fails cleanly', { skip, timeout: 30000 }, async () => {
  const id = 'test-empty-' + Date.now();
  await saveConversation({ id, userId: 'u', messages: [{ role: 'assistant', content: 'hi' }], status: 'active' });
  await assert.rejects(() => runAdrAssessment(id), /not described|Nothing to assess/i);
});

test('model failure surfaces as an error, not a fabricated report', { timeout: 60000 }, async () => {
  const saved = process.env.NEBIUS_API_KEY;
  process.env.NEBIUS_API_KEY = 'invalid-key-for-test';
  try {
    const id = 'test-fail-' + Date.now();
    await saveConversation({ id, userId: 'u', status: 'active', messages: [{ role: 'user', content: 'I took X and got a rash' }] });
    await assert.rejects(() => runAdrAssessment(id), /extraction failed/i);
    const conv = await getConversation(id);
    assert.equal(conv.adrAssessment, undefined);
  } finally {
    process.env.NEBIUS_API_KEY = saved;
  }
});
