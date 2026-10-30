import express from 'express';
import { getConversation } from '../services/firebaseService.js';
import { getModelInfo } from '../services/nebiusService.js';
import { runAdrAssessment, reviewAdrReport } from '../services/adrPipeline.js';

const router = express.Router();

// GET /api/adr/status — which model serves the agents (never returns secrets)
router.get('/status', (req, res) => {
  const info = getModelInfo();
  res.json({
    provider: info.provider,
    vendor: info.vendor,
    model: info.model,
    endpoint: info.endpoint,
    configured: info.configured,
    stats: info.stats,
  });
});

// GET /api/adr/demo-scenario — a clearly fictional patient. These are the
// *patient's* messages only; every agent reply and analysis is produced live
// by the model when the messages are sent through the normal chat flow.
router.get('/demo-scenario', (req, res) => {
  res.json({
    synthetic: true,
    label: 'Synthetic patient — fictional data for demonstration only',
    turns: [
      'I am a 54 year old woman. I took Augmentin 625 mg twice a day for a throat infection and I got an itchy red rash on my chest and arms.',
      'I started it on 12 October and the rash began on 14 October in the evening. My lips also felt swollen, so my husband took me to the emergency room. They gave me an injection and kept me overnight for observation.',
      'I stopped Augmentin on 15 October and the rash got much better within two days. I also take amlodipine 5 mg for blood pressure, and nothing else. I have no other medical problems.',
    ],
  });
});

// POST /api/adr/:conversationId/assess — run the agent workflow (real model calls)
router.post('/:conversationId/assess', async (req, res) => {
  try {
    const result = await runAdrAssessment(req.params.conversationId);
    res.json(result);
  } catch (error) {
    console.error('[POST /adr/assess]', error.message);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Assessment failed',
      steps: error.steps || [],
      retryable: (error.statusCode || 500) >= 500,
    });
  }
});

// GET /api/adr/:conversationId — latest stored assessment
router.get('/:conversationId', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json({
      assessment: conversation.adrAssessment || null,
      extractedData: conversation.extractedData || null,
      meddraData: conversation.meddraData || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/adr/:conversationId/review — human review decision
router.post('/:conversationId/review', async (req, res) => {
  try {
    const { decision, reviewerName, note, confirmed } = req.body || {};
    const report = await reviewAdrReport(req.params.conversationId, {
      decision, reviewerName, note, confirmed, reviewerId: req.user?.uid,
    });
    res.json({ report });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// GET /api/adr/:conversationId/report.json — downloadable JSON
router.get('/:conversationId/report.json', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.conversationId);
    const report = conversation?.adrAssessment?.report;
    if (!report) return res.status(404).json({ error: 'No generated report for this conversation' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${report.report_id}.json"`);
    res.send(JSON.stringify(report, null, 2));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
