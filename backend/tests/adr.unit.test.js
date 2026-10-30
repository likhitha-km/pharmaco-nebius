import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExtraction, verifyExcerpts, computeFieldStatus, computeMissingFields } from '../src/utils/adrSchema.js';
import { combineSeriousness } from '../src/agents/safetyAgent.js';
import { constrainCausality } from '../src/agents/mappingAgent.js';
import { mergeExtractedData } from '../src/utils/extractedData.js';
import { extractJson } from '../src/utils/parseJson.js';

test('validateExtraction rejects non-objects', () => {
  assert.equal(validateExtraction(null).ok, false);
  assert.equal(validateExtraction('text').ok, false);
  assert.equal(validateExtraction([]).ok, false);
});

test('validateExtraction coerces invalid enums/types safely', () => {
  const { ok, data, issues } = validateExtraction({
    suspected_medicines: [{ name: ' Augmentin ', dosage: 5, confidence: 7 }, { name: '' }, 'junk'],
    adverse_reactions: [{ original_text: 'rash', severity: 'catastrophic', still_ongoing: 'yes' }],
    causality_signals: { dechallenge: 'maybe' },
    metadata: { reporter_type: 'alien' },
    explicit_negatives: ['concomitant_medications', 'bogus'],
  });
  assert.equal(ok, true);
  assert.equal(data.suspected_medicines.length, 1);
  assert.equal(data.suspected_medicines[0].name, 'Augmentin');
  assert.equal(data.suspected_medicines[0].dosage, null); // non-string rejected
  assert.equal(data.suspected_medicines[0].confidence, 1); // clamped
  assert.equal(data.adverse_reactions[0].severity, null);
  assert.equal(data.adverse_reactions[0].still_ongoing, null);
  assert.equal(data.causality_signals.dechallenge, 'unknown');
  assert.equal(data.metadata.reporter_type, 'anonymous');
  assert.deepEqual(data.explicit_negatives, ['concomitant_medications']);
  assert.ok(issues.some((i) => /dechallenge/i.test(i)));
});

test('empty extraction is valid but flagged', () => {
  const { ok, issues } = validateExtraction({});
  assert.equal(ok, true);
  assert.ok(issues.length > 0);
});

test('verifyExcerpts marks excerpts not present in the conversation as unverified', () => {
  const data = { supporting_excerpts: [{ field: 'reaction', excerpt: 'itchy red rash' }, { field: 'x', excerpt: 'invented quote' }] };
  const out = verifyExcerpts(data, 'I got an Itchy   red rash on my arms');
  assert.equal(out.supporting_excerpts[0].verified, true);
  assert.equal(out.supporting_excerpts[1].verified, false);
});

test('missing information is distinct from explicit negatives', () => {
  const base = validateExtraction({
    suspected_medicines: [{ name: 'Augmentin' }],
    adverse_reactions: [{ original_text: 'rash' }],
    explicit_negatives: ['concomitant_medications'],
    causality_signals: { dechallenge: 'negative' },
  }).data;
  const status = Object.fromEntries(computeFieldStatus(base).map((f) => [f.key, f.status]));
  assert.equal(status.concomitant_medications, 'negative'); // user said "no other medicines"
  assert.equal(status.medical_history, 'missing'); // never mentioned
  assert.equal(status.dechallenge, 'negative'); // "did not improve" is a real answer
  assert.equal(status.reaction_date, 'missing');
  assert.ok(computeMissingFields(base).some((f) => f.key === 'dose'));
});

test('seriousness is never declared non-serious from missing information', () => {
  const unknown = Object.fromEntries(['death', 'hospitalisation', 'disability'].map((k) => [k, { status: 'unknown' }]));
  assert.equal(combineSeriousness(unknown), 'undetermined');
  assert.notEqual(combineSeriousness(unknown), 'non_serious');
  // Even when every criterion is explicitly ruled out we still defer to a human.
  const ruledOut = Object.fromEntries(['death', 'hospitalisation'].map((k) => [k, { status: 'ruled_out' }]));
  assert.equal(combineSeriousness(ruledOut), 'undetermined');
});

test('seriousness escalates on present/possible/emergency/severe', () => {
  assert.equal(combineSeriousness({ a: { status: 'present' } }), 'serious');
  assert.equal(combineSeriousness({ a: { status: 'possible' } }), 'potentially_serious');
  assert.equal(combineSeriousness({ a: { status: 'unknown' } }, { emergency: true }), 'potentially_serious');
  assert.equal(combineSeriousness({ a: { status: 'unknown' } }, { severity: 'severe' }), 'potentially_serious');
});

test('causality guard rails cap the AI-suggested category', () => {
  assert.equal(constrainCausality('Certain', { dechallenge: 'positive', rechallenge: 'not_applicable' }, true).category, 'Probable/Likely');
  assert.equal(constrainCausality('Probable/Likely', { dechallenge: 'unknown' }, true).category, 'Possible');
  assert.equal(constrainCausality('Possible', { dechallenge: 'positive' }, false).category, 'Unassessable/Unclassifiable');
  assert.equal(constrainCausality('nonsense', {}, true).category, 'Unassessable/Unclassifiable');
  assert.equal(constrainCausality('Probable/Likely', { dechallenge: 'positive' }, true).category, 'Probable/Likely');
});

test('merge does not erase known values with later nulls', () => {
  const first = { suspected_medicines: [{ name: 'Augmentin', dosage: '625 mg' }], adverse_reactions: [{ original_text: 'rash', onset_date: '14 Oct' }], clinical_context: { concomitant_medications: ['amlodipine'] }, causality_signals: { dechallenge: 'positive' } };
  const later = { suspected_medicines: [{ name: 'Augmentin', dosage: null }], adverse_reactions: [{ original_text: 'rash', onset_date: null }], clinical_context: { concomitant_medications: [] }, causality_signals: { dechallenge: 'unknown' } };
  const merged = mergeExtractedData(first, later);
  assert.equal(merged.suspected_medicines[0].dosage, '625 mg');
  assert.equal(merged.adverse_reactions[0].onset_date, '14 Oct');
  assert.deepEqual(merged.clinical_context.concomitant_medications, ['amlodipine']);
  assert.equal(merged.causality_signals.dechallenge, 'positive');
  // ...but a real correction still wins.
  const corrected = mergeExtractedData(merged, { suspected_medicines: [{ name: 'Augmentin', dosage: '1 g' }] });
  assert.equal(corrected.suspected_medicines[0].dosage, '1 g');
});

test('extractJson recovers JSON wrapped in prose / fences and rejects garbage', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"a": '), null);
});
