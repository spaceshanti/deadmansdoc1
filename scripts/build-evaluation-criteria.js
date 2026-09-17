// Parses docs/Artifact Template.md's field tables into structured criteria
// the evaluation pass checks collected data against. Re-run whenever the
// template changes:
//   node scripts/build-evaluation-criteria.js
const fs = require("fs");
const path = require("path");
const questionBank = require("../src/data/questionBank.json");

const ROOT = path.join(__dirname, "..");
const TEMPLATE_FILE = path.join(ROOT, "docs", "Artifact Template.md");
const OUT_FILE = path.join(ROOT, "src", "data", "evaluationCriteria.json");

// Only rows whose third column is one of these count as a field row -- the
// template has other three-and-more-column tables (disclosure levels, how
// sealing behaves) that aren't criteria and must not be picked up.
const KNOWN_DOMAINS = new Set(questionBank.categories);

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function parseTemplate(raw) {
  const lines = raw.split(/\r?\n/);
  const criteria = [];

  let section = null; // { number, title, v1 }
  let subsection = null;
  const seenIds = new Map();

  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+Section\s+(\d+)\s+—\s+(.+?)\s*$/);
    if (sectionMatch) {
      const title = sectionMatch[2].replace(/_\(v1\)_/, "").trim();
      section = {
        number: sectionMatch[1],
        title,
        v1: /\(v1\)/.test(sectionMatch[2]),
      };
      subsection = null;
      continue;
    }

    const subsectionMatch = line.match(/^###\s+(.+?)\s*$/);
    if (subsectionMatch) {
      subsection = subsectionMatch[1].trim();
      continue;
    }

    const rowMatch = line.match(/^\|\s*(.+?)\s*\|\s*(Open|Sealed|Pointer)\s*\|\s*([a-z-]+)\s*\|\s*$/);
    if (!rowMatch || !section) continue;
    const [, field, level, domain] = rowMatch;
    if (!KNOWN_DOMAINS.has(domain)) continue;

    const baseId = `s${section.number}-${slugify(field)}`;
    const count = (seenIds.get(baseId) || 0) + 1;
    seenIds.set(baseId, count);
    const id = count > 1 ? `${baseId}-${count}` : baseId;

    criteria.push({
      id,
      section: section.number,
      sectionTitle: section.title,
      subsection,
      v1: section.v1,
      field,
      level,
      domain,
    });
  }

  return criteria;
}

function main() {
  const raw = fs.readFileSync(TEMPLATE_FILE, "utf8");
  const criteria = parseTemplate(raw);
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(criteria, null, 2));

  const sections = new Set(criteria.map((c) => c.section));
  console.log(`Wrote ${criteria.length} evaluation criteria across ${sections.size} sections to ${OUT_FILE}`);
}

main();
