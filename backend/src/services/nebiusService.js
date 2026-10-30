import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Nebius Token Factory model service.
 *
 * Every LLM call in Pharmaco goes through this module. Inference is served by
 * Nebius Token Factory (OpenAI-compatible API) using an NVIDIA Nemotron model.
 * Secrets are read from the server environment only.
 */

// OpenAI-compatible Token Factory endpoint.
export const NEBIUS_BASE_URL = (process.env.NEBIUS_TOKEN_FACTORY_URL || 'https://api.tokenfactory.nebius.com/v1').replace(/\/+$/, '');

// NVIDIA Nemotron model id as listed by GET {base}/models on Token Factory.
export const NEMOTRON_MODEL = process.env.NEBIUS_NEMOTRON_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

// Back-compat names used by the existing agents: all agents run on Nemotron.
export const MODEL_FAST = NEMOTRON_MODEL;
export const MODEL_SMART = NEMOTRON_MODEL;

const REQUEST_TIMEOUT_MS = Number(process.env.NEBIUS_TIMEOUT_MS || 60000);
const MAX_RETRIES = Number(process.env.NEBIUS_MAX_RETRIES || 2);
const ENABLE_THINKING = process.env.NEBIUS_ENABLE_THINKING === 'true';

// Lightweight in-process call stats (surfaced by /api/adr/status).
export const modelStats = { calls: 0, failures: 0, lastCallAt: null, lastLatencyMs: null, lastError: null, totalTokens: 0 };

export class ModelServiceError extends Error {
  constructor(message, { status, retryable = false, cause } = {}) {
    super(message);
    this.name = 'ModelServiceError';
    this.status = status;
    this.retryable = retryable;
    this.cause = cause;
  }
}

export function isConfigured() {
  const apiKey = process.env.NEBIUS_API_KEY;
  return Boolean(apiKey && !apiKey.startsWith('your_'));
}

export function getModelInfo() {
  return {
    provider: 'Nebius Token Factory',
    model: NEMOTRON_MODEL,
    vendor: 'NVIDIA',
    family: 'Nemotron',
    endpoint: `${NEBIUS_BASE_URL}/chat/completions`,
    configured: isConfigured(),
    stats: { ...modelStats },
  };
}

function getAuthHeaders() {
  if (!isConfigured()) {
    throw new ModelServiceError('Nebius API key is missing. Set NEBIUS_API_KEY in backend/.env');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`,
  };
}

function stripReasoning(text) {
  return (text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Chat completion against Nemotron on Token Factory.
 * Returns { content, model, usage, latencyMs, finishReason }.
 */
export async function chatCompletion({ systemPrompt, messages = [], maxTokens = 1000, temperature = 0.1, label = 'llm' }) {
  const payload = {
    model: NEMOTRON_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };
  if (!ENABLE_THINKING) payload.chat_template_kwargs = { enable_thinking: false };

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    try {
      const response = await axios.post(`${NEBIUS_BASE_URL}/chat/completions`, payload, {
        headers: getAuthHeaders(),
        timeout: REQUEST_TIMEOUT_MS,
      });
      const latencyMs = Date.now() - started;
      const choice = response.data?.choices?.[0];
      const content = stripReasoning(choice?.message?.content);
      const usage = response.data?.usage || null;

      modelStats.calls += 1;
      modelStats.lastCallAt = new Date().toISOString();
      modelStats.lastLatencyMs = latencyMs;
      modelStats.totalTokens += usage?.total_tokens || 0;
      console.log(`[Nebius] ${label} model=${response.data?.model || NEMOTRON_MODEL} ${latencyMs}ms tokens=${usage?.total_tokens ?? '?'} finish=${choice?.finish_reason}`);

      if (!content) throw new ModelServiceError('Model returned an empty response', { retryable: true });
      return { content, model: response.data?.model || NEMOTRON_MODEL, usage, latencyMs, finishReason: choice?.finish_reason };
    } catch (err) {
      const status = err.response?.status;
      const retryable = err instanceof ModelServiceError ? err.retryable : (!status || status === 429 || status >= 500);
      lastErr = err instanceof ModelServiceError ? err : new ModelServiceError(
        `Nebius request failed${status ? ` (HTTP ${status})` : ''}: ${err.response?.data?.error?.message || err.message}`,
        { status, retryable, cause: err }
      );
      modelStats.failures += 1;
      modelStats.lastError = lastErr.message;
      console.error(`[Nebius] ${label} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${lastErr.message}`);
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * Existing agents' entry point (name kept for compatibility). Returns text.
 * The `model` argument is ignored: all agents use the Nemotron model.
 */
export async function callGroq(systemPrompt, messages, _model, maxTokens = 1000, temperature = 0.1) {
  const { content } = await chatCompletion({ systemPrompt, messages, maxTokens, temperature, label: 'agent' });
  return content;
}

/**
 * Streaming call — calls onChunk(text) for each delta.
 */
export async function streamGroq(systemPrompt, messages, onChunk) {
  const payload = {
    model: NEMOTRON_MODEL,
    max_tokens: 500,
    temperature: 0.4,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };
  if (!ENABLE_THINKING) payload.chat_template_kwargs = { enable_thinking: false };

  try {
    const response = await axios.post(`${NEBIUS_BASE_URL}/chat/completions`, payload, {
      headers: getAuthHeaders(),
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'stream',
    });

    let buffer = '';
    for await (const chunk of response.data) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.replace(/^data: /, '').trim();
        if (data === '[DONE]') continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content || '';
          if (delta) onChunk(delta);
        } catch (_) {
          // ignore malformed stream chunks
        }
      }
    }
  } catch (error) {
    console.error('[Nebius] stream error:', error.response?.data || error.message);
    throw error;
  }
}
