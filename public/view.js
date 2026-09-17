(() => {
  const form = document.getElementById("lookup-form");
  const errorEl = document.getElementById("lookup-error");
  const results = document.getElementById("results");

  function esc(s) {
    return (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  function badge(text, kind) {
    return `<span class="badge ${kind || ""}">${esc(text)}</span>`;
  }

  let lastMessages = [];
  let lastViewData = null;
  const downloadBtn = document.getElementById("download-btn");

  // A short, human-readable line for a tool-call message instead of dumping
  // its raw {args, result} JSON -- e.g. "save_person -> Elena Chen (wife)"
  // rather than a wall of braces. Falls back to the tool name alone if the
  // shape is anything unexpected.
  function summarizeToolCall(toolName, contentJson) {
    let parsed;
    try {
      parsed = JSON.parse(contentJson);
    } catch {
      return toolName || "tool call";
    }
    const args = parsed.args || {};
    const failed = !(parsed.result && parsed.result.ok);
    const suffix = failed ? " (failed)" : "";

    if (toolName === "save_person") {
      const bits = [args.relationship, (args.roles || []).join(", ")].filter(Boolean).join(", ");
      return `save_person → ${args.name || "?"}${bits ? ` (${bits})` : ""}${suffix}`;
    }
    if (toolName === "save_fact") {
      return `save_fact → [${args.category}] ${args.label}: ${args.value}${suffix}`;
    }
    if (toolName === "flag_gap") {
      return `flag_gap → [${args.category}] ${args.description}${suffix}`;
    }
    return `${toolName}${suffix}`;
  }

  function renderMessages(messages) {
    lastMessages = messages || [];
    applyMessagesFilter();
  }

  function applyMessagesFilter() {
    const showTools = document.getElementById("show-tool-calls").checked;
    const container = document.getElementById("conversation");
    document.getElementById("messages-count").textContent = lastMessages.length ? `(${lastMessages.length})` : "";
    const visible = lastMessages.filter((m) => showTools || m.role !== "tool");
    document.getElementById("messages-empty").hidden = visible.length > 0;
    container.innerHTML = visible
      .map((m) => {
        if (m.role === "tool") {
          return `<div class="bubble system-note tool-note">${esc(summarizeToolCall(m.toolName, m.content))}</div>`;
        }
        return `<div class="bubble ${esc(m.role)}">${esc(m.content)}</div>`;
      })
      .join("");
  }

  document.getElementById("show-tool-calls").addEventListener("change", applyMessagesFilter);

  function renderRecord(record) {
    const el = document.getElementById("record-summary");
    const modeLabel = record.mode === "parent" ? "A parent / relative" : "Themself";
    el.innerHTML = `
      <dt>Who this is for</dt><dd>${esc(modeLabel)}${record.subjectName ? ` &mdash; ${esc(record.subjectName)}` : ""}</dd>
      ${record.initiatorRelationship ? `<dt>Initiator's relationship</dt><dd>${esc(record.initiatorRelationship)}</dd>` : ""}
      <dt>Status</dt><dd>${esc(record.status)}</dd>
      <dt>Resume code</dt><dd><code>${esc(record.resumeCode)}</code></dd>
      <dt>Started</dt><dd>${esc(fmtDate(record.createdAt))}</dd>
      <dt>Last updated</dt><dd>${esc(fmtDate(record.updatedAt))}</dd>
    `;
  }

  function renderPeople(people) {
    document.getElementById("people-count").textContent = people.length ? `(${people.length})` : "";
    document.getElementById("people-empty").hidden = people.length > 0;
    document.getElementById("people-list").innerHTML = people
      .map((p) => {
        const contact = p.contact_details || {};
        const contactBits = [contact.phone, contact.email, contact.other].filter(Boolean);
        const roles = (p.roles || []).map((r) => badge(r, "role")).join(" ");
        return `
          <article class="data-card">
            <h3>${esc(p.name)}${p.relationship ? ` <span class="muted">(${esc(p.relationship)})</span>` : ""}</h3>
            ${roles ? `<p>${roles}</p>` : ""}
            ${p.scope_of_authority ? `<p><strong>Authority:</strong> ${esc(p.scope_of_authority)}</p>` : ""}
            ${p.what_they_hold_or_oversee ? `<p><strong>Holds/oversees:</strong> ${esc(p.what_they_hold_or_oversee)}</p>` : ""}
            ${contactBits.length ? `<p><strong>Contact:</strong> ${esc(contactBits.join(" · "))}</p>` : ""}
            ${p.is_reachable === false ? badge("contact info may be stale", "warn") : ""}
            ${p.notes ? `<p class="muted">${esc(p.notes)}</p>` : ""}
          </article>
        `;
      })
      .join("");
  }

  function renderFacts(facts) {
    document.getElementById("facts-count").textContent = facts.length ? `(${facts.length})` : "";
    document.getElementById("facts-empty").hidden = facts.length > 0;

    const byCategory = {};
    for (const f of facts) {
      byCategory[f.category] = byCategory[f.category] || [];
      byCategory[f.category].push(f);
    }

    document.getElementById("facts-list").innerHTML = Object.entries(byCategory)
      .map(([category, items]) => {
        const rows = items
          .map(
            (f) => `
              <div class="fact-row">
                <div class="fact-label">${esc(f.label)}</div>
                <div class="fact-value">
                  ${esc(f.value)}
                  ${f.confidence && f.confidence !== "stated" ? badge(f.confidence, "warn") : ""}
                  ${badge(f.source, "muted-badge")}
                </div>
                ${f.family_action ? `<div class="fact-action"><strong>Family needs to:</strong> ${esc(f.family_action)}</div>` : ""}
                ${f.notes ? `<div class="fact-notes">${esc(f.notes)}</div>` : ""}
              </div>
            `
          )
          .join("");
        return `
          <section class="category-block">
            <h3>${esc(category)}</h3>
            ${rows}
          </section>
        `;
      })
      .join("");
  }

  function renderGaps(gaps) {
    document.getElementById("gaps-count").textContent = gaps.length ? `(${gaps.length})` : "";
    document.getElementById("gaps-empty").hidden = gaps.length > 0;
    document.getElementById("gaps-list").innerHTML = gaps
      .map(
        (g) => `
          <article class="data-card">
            <h3>${esc(g.category)} ${badge(g.priority, g.priority === "high" ? "warn" : "muted-badge")}</h3>
            <p>${esc(g.description)}</p>
            ${g.who_would_know ? `<p><strong>Who might know:</strong> ${esc(g.who_would_know)}</p>` : ""}
            <p class="muted">${esc(g.status)}</p>
          </article>
        `
      )
      .join("");
  }

  // Evaluation
  let lastEvaluation = null;
  const evaluateBtn = document.getElementById("evaluate-btn");
  const evaluateStatus = document.getElementById("evaluate-status");
  const evaluateError = document.getElementById("evaluate-error");
  const evaluationResults = document.getElementById("evaluation-results");
  const hideCoveredCheckbox = document.getElementById("hide-covered");

  const STATUS_BADGE_CLASS = { satisfied: "role", not_applicable: "muted-badge", missing: "warn" };
  const STATUS_LABEL = { satisfied: "satisfied", not_applicable: "not applicable", missing: "missing" };

  function renderEvaluationSummary(summary) {
    document.getElementById("evaluation-summary").innerHTML = `
      <dt>Overall</dt><dd>${summary.covered} / ${summary.total} covered (${summary.completionPct}%)</dd>
      <dt>v1 priority sections</dt><dd>${summary.coveredV1} / ${summary.v1Total} covered (${summary.v1CompletionPct}%)</dd>
      <dt>Satisfied</dt><dd>${summary.byStatus.satisfied}</dd>
      <dt>Not applicable</dt><dd>${summary.byStatus.not_applicable}</dd>
      <dt>Missing</dt><dd>${summary.byStatus.missing}</dd>
    `;
  }

  function applyEvaluationFilter() {
    if (!lastEvaluation) return;
    const hideCovered = hideCoveredCheckbox.checked;

    const bySection = {};
    for (const r of lastEvaluation.results) {
      if (hideCovered && r.status !== "missing") continue;
      const key = r.section;
      bySection[key] = bySection[key] || { title: r.sectionTitle, items: [] };
      bySection[key].items.push(r);
    }

    const sectionKeys = Object.keys(bySection).sort((a, b) => Number(a) - Number(b));
    document.getElementById("evaluation-sections").innerHTML = sectionKeys.length
      ? sectionKeys
          .map((key) => {
            const { title, items } = bySection[key];
            const bySub = {};
            for (const item of items) {
              const subKey = item.subsection || "";
              bySub[subKey] = bySub[subKey] || [];
              bySub[subKey].push(item);
            }
            const subBlocks = Object.entries(bySub)
              .map(
                ([subKey, subItems]) => `
                  ${subKey ? `<p class="muted" style="margin: 0.5rem 0 0.25rem;">${esc(subKey)}</p>` : ""}
                  <div class="data-list">
                    ${subItems
                      .map(
                        (item) => `
                        <article class="data-card">
                          <h3 style="font-size: 0.92rem;">
                            ${esc(item.field)}
                            ${badge(STATUS_LABEL[item.status], STATUS_BADGE_CLASS[item.status])}
                            ${badge(item.level, "muted-badge")}
                            ${item.v1 ? badge("v1", "role") : ""}
                          </h3>
                          ${item.reason ? `<p class="muted">${esc(item.reason)}</p>` : ""}
                        </article>
                      `
                      )
                      .join("")}
                  </div>
                `
              )
              .join("");
            return `
              <section class="category-block">
                <h3>Section ${esc(key)} — ${esc(title)}</h3>
                ${subBlocks}
              </section>
            `;
          })
          .join("")
      : `<p class="empty-note">${hideCovered ? "Nothing missing -- everything is satisfied or marked not applicable." : "No results."}</p>`;
  }

  hideCoveredCheckbox.addEventListener("change", applyEvaluationFilter);

  evaluateBtn.addEventListener("click", async () => {
    if (!lastViewData) return;
    evaluateError.hidden = true;
    evaluateBtn.disabled = true;
    evaluateStatus.textContent = "Running (this reads the whole record and conversation -- can take 15-30s)...";

    try {
      const res = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeCode: lastViewData.record.resumeCode }),
      });
      const body = await res.json();
      if (!res.ok) {
        evaluateError.textContent = body.error || "Couldn't run the evaluation.";
        evaluateError.hidden = false;
        evaluationResults.hidden = true;
        return;
      }
      lastEvaluation = body;
      renderEvaluationSummary(body.summary);
      applyEvaluationFilter();
      evaluationResults.hidden = false;
      evaluateStatus.textContent = "";
    } catch {
      evaluateError.textContent = "Couldn't reach the server. Please try again.";
      evaluateError.hidden = false;
    } finally {
      evaluateBtn.disabled = false;
    }
  });

  async function load(resumeCode) {
    errorEl.hidden = true;
    results.hidden = true;
    lastEvaluation = null;
    evaluationResults.hidden = true;
    evaluateStatus.textContent = "";
    evaluateError.hidden = true;
    try {
      const res = await fetch("/api/view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeCode }),
      });
      const body = await res.json();
      if (!res.ok) {
        errorEl.textContent = body.error || "Couldn't load that record.";
        errorEl.hidden = false;
        return;
      }
      lastViewData = body;
      renderRecord(body.record);
      renderMessages(body.messages);
      renderPeople(body.people);
      renderFacts(body.facts);
      renderGaps(body.gaps);
      results.hidden = false;

      try {
        const url = new URL(window.location);
        url.searchParams.set("code", resumeCode);
        window.history.replaceState({}, "", url);
      } catch {
        /* non-fatal */
      }
    } catch {
      errorEl.textContent = "Couldn't reach the server. Please try again.";
      errorEl.hidden = false;
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = new FormData(form).get("resumeCode");
    if (code) load(code.trim());
  });

  downloadBtn.addEventListener("click", () => {
    if (!lastViewData) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      ...lastViewData,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handover-${lastViewData.record.resumeCode}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = params.get("code");
  if (codeFromUrl) {
    form.querySelector('[name="resumeCode"]').value = codeFromUrl;
    load(codeFromUrl);
  }
})();
