// Tool (function-calling) definitions the LLM uses to write structured data
// into the record as the conversation happens, instead of us trying to parse
// free text out of a transcript after the fact.
const db = require("./db");
const questionBank = require("./data/questionBank.json");

const CATEGORIES = questionBank.categories;

// Some providers (Groq's structured tool calling among them) validate tool
// call arguments against the JSON schema strictly, and the model sometimes
// emits an explicit `null` for an optional field instead of omitting the key
// -- which a plain `{type: "string"}` rejects outright and fails the whole
// turn. Every genuinely optional property below is typed to allow null too.
function nullable(type) {
  return { type: [type, "null"] };
}
function nullableEnum(values) {
  return { type: ["string", "null"], enum: [...values, null] };
}

const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_person",
      description:
        "Record or update a person who matters to the handover: someone the family would need to contact, who holds knowledge or access, or who has a role (executor, financial advisor, etc). Call this as soon as a person is mentioned with enough detail to be useful -- do not wait until the end of the conversation. Matched by name (case-insensitive) per record, so calling this again for someone already saved updates them rather than duplicating -- but only do that when you actually have something new or corrected to add, not to re-confirm what's already saved. Use the same form of their name each time (e.g. always 'Elena Chen', not 'Elena' once and 'Elena Chen' another time) so they're recognised as the same person.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The person's name." },
          relationship: {
            ...nullable("string"),
            description: "Their relationship to the subject, e.g. 'daughter', 'financial advisor', 'neighbour'.",
          },
          roles: {
            type: ["array", "null"],
            items: { type: "string" },
            description:
              "Any functional roles this person holds, e.g. 'executor', 'backup executor', 'holds spare key', 'financial advisor', 'first call'. Use an empty array if none yet.",
          },
          scope_of_authority: {
            ...nullable("string"),
            description: "What this person is actually authorised or able to do, if relevant (e.g. 'joint signatory on bank account', 'has power of attorney').",
          },
          what_they_hold_or_oversee: {
            ...nullable("string"),
            description: "What knowledge, documents, access or responsibility this person holds or oversees.",
          },
          contact_phone: nullable("string"),
          contact_email: nullable("string"),
          contact_other: { ...nullable("string"), description: "Any other way to reach them, or notes on reachability." },
          is_reachable: {
            ...nullable("boolean"),
            description: "Whether the subject is confident this contact info is current and this person is reachable.",
          },
          notes: { ...nullable("string"), description: "Anything else worth keeping about this person." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_fact",
      description:
        "Record one discrete piece of handover information: a fact, instruction, location, or answer the subject has given. Call this every time a concrete, useful answer is given -- one fact per call. Use a short, stable 'label' so the same fact can be updated later rather than duplicated (e.g. label 'safe deposit box location', not a full sentence). Remember who this is ultimately for: a spouse, child, or other family member who may not know how to manage this at all -- so alongside the raw fact, capture what they'd actually need to do about it.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: CATEGORIES,
            description: "Which part of the handover this belongs to.",
          },
          label: {
            type: "string",
            description: "A short, stable name for this specific fact, e.g. 'mortgage lender', 'gas provider', 'safe combination location'.",
          },
          value: { type: "string", description: "The answer or information itself." },
          family_action: {
            ...nullable("string"),
            description:
              "What the family will need to actually DO about this, in plain terms a non-expert could follow -- e.g. 'call to close the account and provide a death certificate', 'this bill is on autopay from the joint account so it doesn't need immediate action', 'contact the advisor directly, don't try to access this yourself'. Leave null only if there's genuinely nothing to act on (pure background/context).",
          },
          notes: { ...nullable("string"), description: "Extra context, caveats, or texture that doesn't fit in value or family_action." },
          confidence: {
            ...nullableEnum(["stated", "uncertain", "inferred"]),
            description: "'stated' if the subject said it plainly, 'uncertain' if they hedged, 'inferred' if you deduced it.",
          },
          source: {
            ...nullableEnum(["self", "parent", "other"]),
            description: "Who this information came from in this conversation.",
          },
        },
        required: ["category", "label", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "flag_gap",
      description:
        "Record a gap: something important the subject does NOT currently know or have, ideally with who might know instead. Use this for every 'I don't know' rather than letting it disappear -- a routed gap is valuable output even without an answer.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: CATEGORIES },
          description: { type: "string", description: "What is missing or unknown." },
          who_would_know: {
            ...nullable("string"),
            description: "Who might know this instead, if the subject has any idea (a person, institution, or 'no one knows').",
          },
          priority: {
            ...nullableEnum(["high", "medium", "low"]),
            description: "How much worse this gap gets if it's not resolved before something happens (e.g. a safe deposit box access issue is high).",
          },
        },
        required: ["category", "description"],
      },
    },
  },
];

async function executeToolCall(recordId, name, args) {
  switch (name) {
    case "save_person": {
      const person = await db.upsertPerson({
        recordId,
        name: args.name,
        relationship: args.relationship,
        roles: args.roles,
        scopeOfAuthority: args.scope_of_authority,
        whatTheyHoldOrOversee: args.what_they_hold_or_oversee,
        contactDetails: {
          phone: args.contact_phone,
          email: args.contact_email,
          other: args.contact_other,
        },
        isReachable: args.is_reachable,
        notes: args.notes,
      });
      return { ok: true, saved: "person", id: person.id };
    }
    case "save_fact": {
      const fact = await db.upsertFact({
        recordId,
        category: args.category,
        label: args.label,
        value: args.value,
        notes: args.notes,
        familyAction: args.family_action,
        confidence: args.confidence,
        source: args.source,
      });
      return { ok: true, saved: "fact", id: fact.id };
    }
    case "flag_gap": {
      const gap = await db.addGap({
        recordId,
        category: args.category,
        description: args.description,
        whoWouldKnow: args.who_would_know,
        priority: args.priority,
      });
      return { ok: true, saved: "gap", id: gap.id };
    }
    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

module.exports = { TOOLS, executeToolCall };
