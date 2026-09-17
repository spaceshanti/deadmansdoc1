// On-demand: checks one record's collected data against the criteria
// derived from the Artifact Template. Calls the LLM (unlike view.js, which
// is a plain DB read), so this runs only when asked, not on every page load.
const db = require("../../src/db");
const { evaluateRecord } = require("../../src/evaluation");

function json(status, body) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { resumeCode } = payload;
  if (!resumeCode) return json(400, { error: "resumeCode is required" });

  let record;
  try {
    record = await db.getRecordByResumeCode(resumeCode.trim().toLowerCase());
    if (!record) return json(404, { error: "No record found for that code" });

    const [{ people, facts, gaps }, rawMessages] = await Promise.all([
      db.getRecordSnapshot(record.id),
      db.getMessagesForRecord(record.id, 1000),
    ]);
    const messages = rawMessages.map((m) => ({ role: m.role, content: m.content }));

    const evaluation = await evaluateRecord({ people, facts, gaps, messages });
    return json(200, evaluation);
  } catch (err) {
    console.error(err);
    const errorType = err && err.errorType ? err.errorType : "app_error";
    try {
      await db.logError({
        recordId: record ? record.id : null,
        sessionId: null,
        context: "evaluate",
        errorType,
        statusCode: err && err.statusCode,
        provider: err && err.provider,
        model: err && err.model,
        message: String((err && err.message) || err),
      });
    } catch (logErr) {
      console.error("Failed to write error_logs row:", logErr);
    }
    return json(500, { error: "Something went wrong running the evaluation. Please try again." });
  }
};
