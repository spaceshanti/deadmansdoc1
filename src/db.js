// Thin data-access layer over Neon Postgres, used by the Netlify functions.
// Uses the Neon HTTP driver (one request per query, no pooled connection) --
// the right shape for short-lived serverless function invocations.
const { neon } = require("@neondatabase/serverless");

function getSql() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return neon(process.env.DATABASE_URL);
}

function generateResumeCode() {
  // Short, easy to write down / read aloud. Not a security boundary --
  // see SECURITY_NOTES.md.
  const words = ["harbor", "willow", "ember", "quartz", "meadow", "tide", "finch", "cedar"];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(100 + Math.random() * 900);
  return `${pick()}-${pick()}-${num}`;
}

async function createRecord({ mode, subjectName, initiatorRelationship }) {
  const sql = getSql();
  const resumeCode = generateResumeCode();
  const rows = await sql(
    `insert into records (mode, subject_name, initiator_relationship, resume_code)
     values ($1, $2, $3, $4)
     returning id, mode, subject_name, initiator_relationship, resume_code, status, created_at`,
    [mode, subjectName || null, initiatorRelationship || null, resumeCode]
  );
  return rows[0];
}

async function getRecordByResumeCode(resumeCode) {
  const sql = getSql();
  const rows = await sql(`select * from records where resume_code = $1`, [resumeCode]);
  return rows[0] || null;
}

async function getRecordById(recordId) {
  const sql = getSql();
  const rows = await sql(`select * from records where id = $1`, [recordId]);
  return rows[0] || null;
}

async function createSession({ recordId, whoIsPresent, consentGiven }) {
  const sql = getSql();
  const rows = await sql(
    `insert into sessions (record_id, who_is_present, consent_given)
     values ($1, $2, $3)
     returning *`,
    [recordId, whoIsPresent || null, !!consentGiven]
  );
  return rows[0];
}

async function touchSession(sessionId) {
  const sql = getSql();
  await sql(`update sessions set last_active_at = now() where id = $1`, [sessionId]);
}

async function getSession(sessionId) {
  const sql = getSql();
  const rows = await sql(`select * from sessions where id = $1`, [sessionId]);
  return rows[0] || null;
}

async function getLatestSessionForRecord(recordId) {
  const sql = getSql();
  const rows = await sql(
    `select * from sessions where record_id = $1 order by started_at desc limit 1`,
    [recordId]
  );
  return rows[0] || null;
}

async function addMessage({ sessionId, recordId, role, content, toolName }) {
  const sql = getSql();
  const rows = await sql(
    `insert into messages (session_id, record_id, role, content, tool_name)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [sessionId, recordId, role, content, toolName || null]
  );
  return rows[0];
}

async function getMessagesForSession(sessionId, limit = 200) {
  const sql = getSql();
  const rows = await sql(
    `select * from messages where session_id = $1 order by created_at asc limit $2`,
    [sessionId, limit]
  );
  return rows;
}

// Full conversation across every session for a record, so a resumed
// conversation keeps its context even though a new session row was started.
async function getMessagesForRecord(recordId, limit = 400) {
  const sql = getSql();
  const rows = await sql(
    `select * from messages where record_id = $1 order by created_at asc limit $2`,
    [recordId, limit]
  );
  return rows;
}

async function upsertPerson({
  recordId,
  name,
  relationship,
  roles,
  scopeOfAuthority,
  whatTheyHoldOrOversee,
  contactDetails,
  isReachable,
  notes,
}) {
  const sql = getSql();
  // Matched case-insensitively per record (idx_people_record_name_unique):
  // the interviewer routinely re-confirms the same person across turns, so
  // this merges into the existing row instead of creating a duplicate.
  // Scalar fields prefer the new call's value but fall back to what's
  // already there if this call didn't mention it (a sparser follow-up
  // shouldn't erase previously-known detail); roles replace only when the
  // new call actually provided some; contact_details merges key-by-key via
  // jsonb `||`, so a call that only gives a phone number doesn't blank out
  // an email learned earlier.
  const rows = await sql(
    `insert into people (record_id, name, relationship, roles, scope_of_authority, what_they_hold_or_oversee, contact_details, is_reachable, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (record_id, lower(name))
     do update set
       relationship = coalesce(excluded.relationship, people.relationship),
       roles = case when array_length(excluded.roles, 1) > 0 then excluded.roles else people.roles end,
       scope_of_authority = coalesce(excluded.scope_of_authority, people.scope_of_authority),
       what_they_hold_or_oversee = coalesce(excluded.what_they_hold_or_oversee, people.what_they_hold_or_oversee),
       contact_details = people.contact_details || excluded.contact_details,
       is_reachable = coalesce(excluded.is_reachable, people.is_reachable),
       notes = coalesce(excluded.notes, people.notes),
       updated_at = now()
     returning *`,
    [
      recordId,
      name,
      relationship || null,
      roles && roles.length ? roles : [],
      scopeOfAuthority || null,
      whatTheyHoldOrOversee || null,
      contactDetails || {},
      typeof isReachable === "boolean" ? isReachable : null,
      notes || null,
    ]
  );
  return rows[0];
}

async function upsertFact({ recordId, category, label, value, notes, familyAction, confidence, source, visibility }) {
  const sql = getSql();
  const rows = await sql(
    `insert into facts (record_id, category, label, value, notes, family_action, confidence, source, visibility)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (record_id, category, label)
     do update set value = excluded.value,
                   notes = excluded.notes,
                   family_action = excluded.family_action,
                   confidence = excluded.confidence,
                   source = excluded.source,
                   visibility = excluded.visibility,
                   updated_at = now()
     returning *`,
    [
      recordId,
      category,
      label,
      value,
      notes || null,
      familyAction || null,
      confidence || "stated",
      source || "self",
      visibility || "family",
    ]
  );
  return rows[0];
}

async function addGap({ recordId, category, description, whoWouldKnow, priority }) {
  const sql = getSql();
  const rows = await sql(
    `insert into gaps (record_id, category, description, who_would_know, priority)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [recordId, category, description, whoWouldKnow || null, priority || "medium"]
  );
  return rows[0];
}

async function getRecordSnapshot(recordId) {
  const sql = getSql();
  const [people, facts, gaps] = await Promise.all([
    sql(`select * from people where record_id = $1 order by created_at asc`, [recordId]),
    sql(`select * from facts where record_id = $1 order by category asc, created_at asc`, [recordId]),
    sql(`select * from gaps where record_id = $1 order by priority asc, created_at asc`, [recordId]),
  ]);
  return { people, facts, gaps };
}

async function listRecordsWithCounts(limit = 200) {
  const sql = getSql();
  return sql(
    `select r.*,
       (select count(*) from people p where p.record_id = r.id) as people_count,
       (select count(*) from facts f where f.record_id = r.id) as facts_count,
       (select count(*) from gaps g where g.record_id = r.id) as gaps_count,
       (select count(*) from sessions s where s.record_id = r.id) as sessions_count
     from records r
     order by r.updated_at desc
     limit $1`,
    [limit]
  );
}

async function deleteRecord(recordId) {
  const sql = getSql();
  await sql(`delete from records where id = $1`, [recordId]);
}

async function logError({
  recordId,
  sessionId,
  context,
  errorType,
  statusCode,
  provider,
  model,
  durationMs,
  message,
}) {
  const sql = getSql();
  await sql(
    `insert into error_logs (record_id, session_id, context, error_type, status_code, provider, model, duration_ms, message)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      recordId || null,
      sessionId || null,
      context,
      errorType || "unknown",
      statusCode ?? null,
      provider || null,
      model || null,
      durationMs ?? null,
      String(message).slice(0, 4000),
    ]
  );
}

async function listRecentErrors(limit = 100) {
  const sql = getSql();
  return sql(
    `select e.*, r.resume_code
     from error_logs e
     left join records r on r.id = e.record_id
     order by e.created_at desc
     limit $1`,
    [limit]
  );
}

module.exports = {
  createRecord,
  getRecordByResumeCode,
  getRecordById,
  createSession,
  touchSession,
  getSession,
  getLatestSessionForRecord,
  addMessage,
  getMessagesForSession,
  getMessagesForRecord,
  upsertPerson,
  upsertFact,
  addGap,
  getRecordSnapshot,
  listRecordsWithCounts,
  deleteRecord,
  logError,
  listRecentErrors,
};
