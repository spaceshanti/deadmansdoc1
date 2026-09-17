// Thin adapter over an OpenAI-compatible chat completions API (tool calling
// included). Defaults to Groq serving an open-weight model for prototyping;
// swap providers by changing LLM_BASE_URL / LLM_API_KEY / LLM_MODEL only --
// nothing else in this file is provider-specific. This also covers a local
// Ollama install (LLM_BASE_URL=http://localhost:11434/v1, no key needed) --
// see README for the local-testing setup, including why that only works
// when running the app locally (`npm run dev`), not against the deployed
// site, which can't reach your machine's localhost.
const { TOOLS, executeToolCall } = require("./tools");

const MAX_TOOL_ROUNDS = 6;

// Node's built-in global fetch (backed by its own internal, bundled undici)
// aborts with a HeadersTimeoutError after ~300s by default. Fine for a
// hosted provider, but a local model on a slow/CPU-only machine can take
// longer than that just to load into memory on its first request -- seen in
// practice: an opening turn against a 7B Ollama model timed out at 308s,
// while the very next turn (model already warm) took 124s.
//
// Raising that ceiling means passing a custom Agent as `dispatcher` -- but
// that Agent has to come from the SAME undici instance as the fetch call
// actually using it, or the two versions' internal request-handler
// protocols don't line up (a real error hit here: "invalid onRequestStart
// method"). Node's global fetch is its own internal undici, not the
// standalone `undici` package, so mixing an Agent from the npm package into
// a call to global fetch breaks. Fix: use the npm package's own fetch
// together with its own Agent, so they're always version-matched. Falls
// back to Node's global fetch (default timeout) if `undici` can't be
// resolved at all.
let fetchImpl = fetch;
let dispatcher;
try {
  const undici = require("undici");
  dispatcher = new undici.Agent({ headersTimeout: 900000, bodyTimeout: 900000 });
  fetchImpl = undici.fetch;
} catch {
  dispatcher = undefined;
}

function getConfig() {
  // Strip any trailing slash -- some providers (Gemini's OpenAI-compat
  // endpoint among them) publish their base URL with one, which would
  // otherwise double up against the leading slash below and 404.
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY || null;
  const model = process.env.LLM_MODEL || "openai/gpt-oss-120b";
  return { baseUrl, apiKey, model };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Classifies a failure so error_logs (and anyone reading it) can tell at a
// glance what kind of problem this was, without re-reading the raw message
// every time. `status` is null for failures that never got an HTTP response
// at all (DNS, connection refused, the undici dispatcher mismatch we hit
// earlier, etc) -- those are real, distinct failure modes from "the server
// answered and said no".
function classifyError(status, bodyText) {
  if (status == null) return "network_error";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 503) return "service_unavailable";
  if (status === 400 && /tool.*(schema|validation)/i.test(bodyText || "")) return "tool_schema_error";
  if (status === 400) return "bad_request";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unknown";
}

// Attaches structured fields (not just a message) to a thrown error, so the
// caller (chat.js) can log something more useful than a flattened string:
// what kind of failure this was, the HTTP status if any, and which
// provider/model was in use when it happened.
function llmError({ status, bodyText, provider, model, errorType }) {
  const err = new Error(
    status != null ? `LLM request failed (${status}): ${bodyText}` : `LLM request failed: ${bodyText}`
  );
  err.errorType = errorType || classifyError(status, bodyText);
  err.statusCode = status ?? null;
  err.provider = provider;
  err.model = model;
  return err;
}

// Small providers on free tiers (e.g. Groq's default per-minute token cap)
// return 429s under completely normal use, not just abuse -- worth one
// short retry so it doesn't surface to the user as a broken app.
async function callChatCompletions(messages, { attempt = 0, useTools = true } = {}) {
  const { baseUrl, apiKey, model } = getConfig();
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Not every provider accepts this the same way -- Claude Sonnet 5 rejects
  // it outright as deprecated. Omit by default; set LLM_TEMPERATURE to opt
  // back in for a provider/model that wants it.
  const temperature = process.env.LLM_TEMPERATURE;

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        ...(useTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
        ...(temperature !== undefined ? { temperature: Number(temperature) } : {}),
      }),
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (networkErr) {
    throw llmError({ status: null, bodyText: String(networkErr.message || networkErr), provider: baseUrl, model });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429 && attempt < 1) {
      let waitMs = 3000;
      try {
        const parsed = JSON.parse(text);
        const match = /try again in ([\d.]+)s/i.exec(parsed.error && parsed.error.message);
        if (match) waitMs = Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 250, 15000);
      } catch {
        /* fall back to default wait */
      }
      await sleep(waitMs);
      return callChatCompletions(messages, { attempt: attempt + 1, useTools });
    }
    throw llmError({ status: res.status, bodyText: text, provider: baseUrl, model });
  }
  return res.json();
}

/**
 * Runs one user turn to completion, including any tool-call rounds, against
 * the given recordId. Returns the final assistant reply plus a log of every
 * tool call made, so the caller can persist them.
 */
async function runInterviewTurn({ recordId, systemPrompt, history, userMessage }) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userMessage },
  ];

  const toolLog = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await callChatCompletions(messages);
    const choice = completion.choices && completion.choices[0];
    if (!choice) {
      const { baseUrl, model } = getConfig();
      throw llmError({
        status: null,
        bodyText: "LLM returned no choices",
        provider: baseUrl,
        model,
        errorType: "unexpected_response",
      });
    }
    const message = choice.message;

    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      return { reply: message.content || "", toolLog };
    }

    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      let result;
      try {
        result = await executeToolCall(recordId, call.function.name, args);
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }
      toolLog.push({ name: call.function.name, args, result });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply:
      "I've saved what we've covered so far -- let's pick this back up in a moment, I got a bit tangled there.",
    toolLog,
  };
}

/**
 * A single plain completion with no tool calling -- for tasks like the
 * completeness evaluation, which just needs the model to read data and
 * return text (JSON, by convention of the caller's prompt), not act on
 * anything. Reuses the same retry/error-classification/timeout handling as
 * the interview path.
 */
async function runPlainCompletion({ systemPrompt, userMessage }) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  const completion = await callChatCompletions(messages, { useTools: false });
  const choice = completion.choices && completion.choices[0];
  if (!choice) {
    const { baseUrl, model } = getConfig();
    throw llmError({
      status: null,
      bodyText: "LLM returned no choices",
      provider: baseUrl,
      model,
      errorType: "unexpected_response",
    });
  }
  return choice.message.content || "";
}

module.exports = { runInterviewTurn, runPlainCompletion };
