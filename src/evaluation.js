// Checks a record's collected data against the criteria derived from the
// Artifact Template (docs/Artifact Template.md -> scripts/build-evaluation-
// criteria.js -> src/data/evaluationCriteria.json). Deliberately separate
// from the live interview turn: this is an on-demand analysis pass, not
// something that runs on every chat message, so the interview prompt stays
// small and this can afford to look at the whole transcript.
//
// It's an LLM judgment, not a keyword match, because a lot of the signal
// this needs to work from -- "no, we don't have any pets" -- only exists in
// what was said, not in any saved fact. There's no tool yet for the
// interviewer to explicitly record "this doesn't apply", so the transcript
// itself is often the only evidence of that.
const criteria = require("./data/evaluationCriteria.json");
const { runPlainCompletion } = require("./llm");

const VALID_STATUSES = new Set(["satisfied", "not_applicable", "missing"]);

function formatCriteriaList() {
  return criteria
    .map((c) => `${c.id} | [${c.domain}] ${c.field}${c.v1 ? " (v1 priority)" : ""}`)
    .join("\n");
}

function formatPeople(people) {
  if (!people.length) return "(none recorded)";
  return people
    .map((p) => {
      const roles = (p.roles || []).join(", ");
      const contact = Object.entries(p.contact_details || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return `- ${p.name}${p.relationship ? ` (${p.relationship})` : ""}${roles ? ` [${roles}]` : ""}${contact ? ` -- ${contact}` : ""}`;
    })
    .join("\n");
}

function formatFacts(facts) {
  if (!facts.length) return "(none recorded)";
  return facts
    .map((f) => `- [${f.category}] ${f.label}: ${f.value}${f.family_action ? ` (action: ${f.family_action})` : ""}`)
    .join("\n");
}

function formatGaps(gaps) {
  if (!gaps.length) return "(none recorded)";
  return gaps.map((g) => `- [${g.category}] ${g.description}${g.who_would_know ? ` (who might know: ${g.who_would_know})` : ""}`).join("\n");
}

function formatTranscript(messages) {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  if (!turns.length) return "(no conversation yet)";
  return turns.map((m) => `${m.role === "user" ? "Subject" : "Interviewer"}: ${m.content}`).join("\n");
}

function buildPrompt({ people, facts, gaps, messages }) {
  return `You are auditing one person's handover record against a checklist of information the final document will need. You are not writing the document -- only judging what's covered so far.

For each checklist item, decide exactly one status:
- "satisfied": the record (data below, or something said in the conversation) clearly covers this.
- "not_applicable": the conversation gives real evidence this doesn't apply to this person's situation (e.g. they said they have no pets, no business, no dependents). Only use this when there is actual evidence -- never assume something doesn't apply just because it hasn't come up.
- "missing": not yet covered, and not shown to be inapplicable.

Respond with ONLY a JSON array, one object per checklist item, in this exact shape, no other text:
[{"id": "s1-example-id", "status": "satisfied", "reason": "one short sentence"}]

Every id in the checklist below must appear exactly once in your response.

## Checklist
${formatCriteriaList()}

## Collected people
${formatPeople(people)}

## Collected facts
${formatFacts(facts)}

## Collected gaps (things the subject doesn't know)
${formatGaps(gaps)}

## Conversation transcript
${formatTranscript(messages)}`;
}

function extractJsonArray(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Evaluation response did not contain a JSON array");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function summarize(results) {
  const byStatus = { satisfied: 0, not_applicable: 0, missing: 0 };
  const byStatusV1 = { satisfied: 0, not_applicable: 0, missing: 0 };
  let v1Total = 0;
  for (const r of results) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.v1) {
      v1Total++;
      byStatusV1[r.status] = (byStatusV1[r.status] || 0) + 1;
    }
  }
  const total = results.length;
  const covered = byStatus.satisfied + byStatus.not_applicable;
  const coveredV1 = byStatusV1.satisfied + byStatusV1.not_applicable;
  return {
    total,
    covered,
    completionPct: total ? Math.round((covered / total) * 100) : 0,
    byStatus,
    v1Total,
    coveredV1,
    v1CompletionPct: v1Total ? Math.round((coveredV1 / v1Total) * 100) : 0,
    byStatusV1,
    isComplete: covered === total,
  };
}

async function evaluateRecord({ people, facts, gaps, messages }) {
  const prompt = buildPrompt({ people, facts, gaps, messages });
  const text = await runPlainCompletion({
    systemPrompt: prompt,
    userMessage: "Perform the evaluation now and return only the JSON array.",
  });

  const parsed = extractJsonArray(text);
  const byId = new Map(parsed.map((p) => [p.id, p]));

  const results = criteria.map((c) => {
    const judged = byId.get(c.id);
    const status = judged && VALID_STATUSES.has(judged.status) ? judged.status : "missing";
    return {
      id: c.id,
      section: c.section,
      sectionTitle: c.sectionTitle,
      subsection: c.subsection,
      v1: c.v1,
      field: c.field,
      level: c.level,
      domain: c.domain,
      status,
      reason: judged && judged.reason ? String(judged.reason).slice(0, 300) : null,
    };
  });

  return { results, summary: summarize(results) };
}

module.exports = { evaluateRecord };
