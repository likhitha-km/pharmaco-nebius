import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { getNextMessage } from '../agents/conversationAgent.js';
import { extractFromConversation } from '../agents/extractionAgent.js';
import { mapToMedDRA } from '../agents/mappingAgent.js';
import { assessCompleteness } from '../agents/completenessAgent.js';
import { triageMessage } from '../agents/triageAgent.js';
import { generateICSR } from '../agents/reportAgent.js';
import { saveConversation, updateConversation, getConversation, saveReport, updateDrugSignals, getReportsByConversationId } from '../services/firebaseService.js';
import { transcribeAudio } from '../services/sarvamService.js';
import { WELCOME_MESSAGES } from '../prompts/conversationPrompts.js';
import { mergeExtractedData, mergeNewFields } from '../utils/extractedData.js';
import { computeFieldStatus } from '../utils/adrSchema.js';
import { getModelInfo } from '../services/nebiusService.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────────────────────
// Merge newly extracted values into the existing structured report state so
// earlier details are preserved and later corrections overwrite earlier ones.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversation/start
// ─────────────────────────────────────────────────────────────────────────────
router.post('/start', async (req, res) => {
  try {
    const { userType = 'patient', language = 'hi-IN', isAnonymous = true, synthetic = false } = req.body;

    const welcomeMessage = WELCOME_MESSAGES[language] || WELCOME_MESSAGES['en-IN'];
    const conversationId = uuidv4();

    const conversationData = {
      id: conversationId,
      userId: req.user?.uid || 'anonymous',
      messages: [{ role: 'assistant', content: welcomeMessage, timestamp: new Date().toISOString() }],
      extractedData: null,
      language,
      userType,
      isAnonymous,
      status: 'active',
      synthetic: Boolean(synthetic),
    };

    await saveConversation(conversationData);
    res.json({ conversationId, welcomeMessage, language, userType });
  } catch (error) {
    console.error('[POST /start]', error);
    res.status(500).json({ error: 'Failed to start conversation', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversation/message
// ─────────────────────────────────────────────────────────────────────────────
router.post('/message', async (req, res) => {
  try {
    const { conversationId, message, userType = 'patient', language } = req.body;

    if (!conversationId || !message) {
      return res.status(400).json({ error: 'conversationId and message are required' });
    }

    // 1. Load conversation
    const conversation = await getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    let currentLanguage = conversation.language;
    if (language && language !== conversation.language) {
      currentLanguage = language;
      await updateConversation(conversationId, { language });
    }

    const history = conversation.messages || [];

    // 2. Append user message
    const userMsg = { role: 'user', content: message, timestamp: new Date().toISOString() };
    const updatedMessages = [...history, userMsg];

    // 3. Emergency triage — fast path on every message
    const triage = await triageMessage(message);
    if (triage.is_emergency) {
      const emergencyMsg = {
        role: 'assistant',
        content: triage.emergency_message || 'This sounds like a medical emergency. Please call 112 immediately.',
        timestamp: new Date().toISOString(),
        isEmergency: true,
      };
      await updateConversation(conversationId, { messages: [...updatedMessages, emergencyMsg] });
      return res.json({
        message: triage.emergency_message,
        isEmergency: true,
        isReportReady: false,
        triage,
      });
    }

    // 4. Run extraction on EVERY user message for fresh context.
    //    We run it in parallel with the conversation agent call to minimise latency.
    let extractedData = conversation.extractedData || null;
    const historyForExtraction = updatedMessages.map(m => ({ role: m.role, content: m.content }));

    let freshExtraction = null;
    try {
      freshExtraction = await extractFromConversation(historyForExtraction);
      extractedData = mergeExtractedData(extractedData, freshExtraction);
    } catch (err) {
      console.error('[Extraction] error:', err.message);
      // Keep using previously extracted data — do not abort the conversation
    }

    // 5. Get next conversational reply from the LLM
    const groqHistory = updatedMessages.map(m => ({ role: m.role, content: m.content }));
    const agentResponse = await getNextMessage(groqHistory, userType, currentLanguage, extractedData);

    // 6. Merge any new fields the LLM extracted into our structured data
    if (agentResponse.newFields && Object.keys(agentResponse.newFields).length > 0) {
      extractedData = mergeNewFields(extractedData, agentResponse.newFields);
    }

    // 7. Append bot reply to history
    const botMsg = {
      role: 'assistant',
      content: agentResponse.message,
      timestamp: new Date().toISOString(),
    };
    const finalMessages = [...updatedMessages, botMsg];

    let completenessScore = null;
    let meddraData = null;

    // 8. Full pipeline when report is ready.
    //    Once a conversation has reached "report_ready" at least once, keep
    //    re-running this on every later turn too — otherwise a correction
    //    made after that point (e.g. "actually it's once a day, not twice")
    //    would update extractedData but leave the stale MedDRA mapping /
    //    completeness score behind, breaking canonical-state sync.
    const alreadyReady = conversation.status === 'report_ready';
    if (agentResponse.isReportReady || alreadyReady) {
      try {
        const fullHistory = finalMessages.map(m => ({ role: m.role, content: m.content }));
        const fullExtraction = await extractFromConversation(fullHistory);
        extractedData = mergeExtractedData(extractedData, fullExtraction);
        meddraData = await mapToMedDRA(extractedData);
        const completeness = await assessCompleteness(extractedData);
        completenessScore = completeness.completeness_score;

        await updateConversation(conversationId, {
          messages: finalMessages,
          extractedData,
          meddraData,
          completenessScore,
          status: 'report_ready',
        });
      } catch (err) {
        console.error('[Report pipeline] error:', err.message);
        await updateConversation(conversationId, { messages: finalMessages, extractedData });
      }
    } else {
      await updateConversation(conversationId, { messages: finalMessages, extractedData });
    }

    // 9. Respond
    res.json({
      message: agentResponse.message,
      isEmergency: false,
      isReportReady: agentResponse.isReportReady || alreadyReady,
      extractedData,
      meddraData,
      completenessScore,
      fieldStatus: computeFieldStatus(extractedData),
      model: getModelInfo().model,
    });
  } catch (error) {
    console.error('[POST /message]', error);
    // Friendly error — do NOT restart conversation
    res.status(500).json({
      message: "I'm having a brief technical issue. Please try again in a moment — your conversation is still saved.",
      isEmergency: false,
      isReportReady: false,
      error: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversation/voice
// ─────────────────────────────────────────────────────────────────────────────
router.post('/voice', upload.single('audio'), async (req, res) => {
  try {
    const { conversationId, language = 'hi-IN' } = req.body;
    const audioBuffer = req.file?.buffer;

    if (!audioBuffer) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const transcription = await transcribeAudio(audioBuffer, language);
    const transcript = transcription.transcript;

    if (!transcript) {
      return res.status(422).json({ error: 'Could not transcribe audio. Please try speaking more clearly.' });
    }

    const conversation = await getConversation(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    let currentLanguage = conversation.language;
    if (language && language !== conversation.language) {
      currentLanguage = language;
      await updateConversation(conversationId, { language });
    }

    const history = conversation.messages || [];
    const triage = await triageMessage(transcript);

    const userMsg = { role: 'user', content: transcript, timestamp: new Date().toISOString(), isVoice: true };
    const updatedMessages = [...history, userMsg];

    if (triage.is_emergency) {
      const emergencyMsg = {
        role: 'assistant',
        content: triage.emergency_message || 'Please call 112 immediately.',
        timestamp: new Date().toISOString(),
        isEmergency: true,
      };
      await updateConversation(conversationId, { messages: [...updatedMessages, emergencyMsg] });
      return res.json({
        transcript,
        message: triage.emergency_message,
        isEmergency: true,
        isReportReady: false,
        languageDetected: transcription.language_detected,
      });
    }

    // Extract fresh data on every voice message
    let extractedData = conversation.extractedData || null;
    try {
      const freshExtraction = await extractFromConversation(updatedMessages.map(m => ({ role: m.role, content: m.content })));
      extractedData = mergeExtractedData(extractedData, freshExtraction);
    } catch (err) {
      console.error('[Voice Extraction] error:', err.message);
    }

    const groqHistory = updatedMessages.map(m => ({ role: m.role, content: m.content }));
    const agentResponse = await getNextMessage(groqHistory, conversation.userType, currentLanguage, extractedData);

    if (agentResponse.newFields && Object.keys(agentResponse.newFields).length > 0) {
      extractedData = mergeNewFields(extractedData, agentResponse.newFields);
    }

    const finalMessages = [
      ...updatedMessages,
      { role: 'assistant', content: agentResponse.message, timestamp: new Date().toISOString() },
    ];

    await updateConversation(conversationId, { messages: finalMessages, extractedData });

    res.json({
      transcript,
      message: agentResponse.message,
      isEmergency: false,
      isReportReady: agentResponse.isReportReady,
      languageDetected: transcription.language_detected,
    });
  } catch (error) {
    console.error('[POST /voice]', error);
    res.status(500).json({ error: 'Voice processing failed', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversation/end
// ─────────────────────────────────────────────────────────────────────────────
router.post('/end', async (req, res) => {
  try {
    const { conversationId } = req.body;
    const conversation = await getConversation(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const history = conversation.messages.map(m => ({ role: m.role, content: m.content }));

    const extractedData = mergeExtractedData(conversation.extractedData || null, await extractFromConversation(history));
    const meddraData = await mapToMedDRA(extractedData);
    const completeness = await assessCompleteness(extractedData);
    const icsr = await generateICSR(extractedData, meddraData, completeness);

    // Reuse the existing draft's report id (if one exists for this
    // conversation) instead of always minting a new one — otherwise
    // submitting leaves an orphaned duplicate "draft" document behind
    // for the same report, and My Reports shows it twice.
    const existingReports = await getReportsByConversationId(conversationId, 20);
    const existingDraft = existingReports.find((r) => r.status === 'draft');
    if (existingDraft) icsr.report_id = existingDraft.id;

    const reportId = await saveReport({
      id: icsr.report_id,
      conversationId,
      userId: conversation.userId,
      extractedData,
      meddraMapping: meddraData,
      causality: meddraData?.causality_assessment,
      icsr,
      completenessScore: completeness.completeness_score,
      status: 'submitted',
      isAnonymous: conversation.isAnonymous,
      createdAt: existingDraft?.createdAt,
      adrReport: existingDraft?.adrReport,
      humanReview: existingDraft?.humanReview,
    });

    const drugNames = extractedData.suspected_medicines?.map(m => m.name) || [];
    const adrTerms = meddraData?.meddra_mappings?.map(m => m.preferred_term) || [];
    for (const drug of drugNames) {
      await updateDrugSignals(drug, adrTerms);
    }

    await updateConversation(conversationId, { status: 'completed', reportId });
    res.json({ reportId, report: icsr, completenessScore: completeness.completeness_score });
  } catch (error) {
    console.error('[POST /end]', error);
    res.status(500).json({ error: 'Failed to generate report', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/conversation/:conversationId/fields
// Inline correction — the user directly edits a field on the Review screen
// instead of re-chatting. This is the single write path for manual edits so
// the conversation doc (source of truth), its MedDRA mapping/completeness,
// and any existing draft report snapshot all stay in sync.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:conversationId/fields', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { extractedData } = req.body;

    if (!extractedData) {
      return res.status(400).json({ error: 'extractedData is required' });
    }

    const conversation = await getConversation(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    // Normalize through the same merge helper used elsewhere so the shape
    // is always consistent — merge onto an empty base rather than trusting
    // the client's shape directly.
    const normalized = mergeExtractedData(null, extractedData);
    const meddraData = await mapToMedDRA(normalized);
    const completeness = await assessCompleteness(normalized);

    await updateConversation(conversationId, {
      extractedData: normalized,
      meddraData,
      completenessScore: completeness.completeness_score,
    });

    // Keep an existing draft report snapshot canonical too.
    const existingReports = await getReportsByConversationId(conversationId, 20);
    const existingDraft = existingReports.find((r) => r.status === 'draft');
    if (existingDraft) {
      await saveReport({
        ...existingDraft,
        extractedData: normalized,
        completenessScore: completeness.completeness_score,
        title: normalized.suspected_medicines?.[0]?.name || existingDraft.title,
        reaction: normalized.adverse_reactions?.[0]?.original_text || existingDraft.reaction,
      });
    }

    res.json({ extractedData: normalized, meddraData, completenessScore: completeness.completeness_score });
  } catch (error) {
    console.error('[PUT /:conversationId/fields]', error);
    res.status(500).json({ error: 'Failed to save your edits', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/conversation/:conversationId/generate-draft
// Generates a professional ICSR draft from the canonical structured state
// WITHOUT submitting — the user stays in control and can still edit or
// discard it. Never fabricates values for fields that are still unknown;
// generateICSR only fills what's in extractedData/meddraData already.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:conversationId/generate-draft', async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await getConversation(conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const extractedData = conversation.extractedData;
    if (!extractedData) {
      return res.status(400).json({ error: 'No information has been collected yet for this report.' });
    }

    const meddraData = conversation.meddraData || (await mapToMedDRA(extractedData));
    const completeness =
      conversation.completenessScore != null
        ? { completeness_score: conversation.completenessScore }
        : await assessCompleteness(extractedData);

    const icsr = await generateICSR(extractedData, meddraData, completeness);

    res.json({ icsr, extractedData, meddraData, completenessScore: completeness.completeness_score });
  } catch (error) {
    console.error('[POST /:conversationId/generate-draft]', error);
    res.status(500).json({ error: 'Failed to generate draft report', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conversation/history/:conversationId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history/:conversationId', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
