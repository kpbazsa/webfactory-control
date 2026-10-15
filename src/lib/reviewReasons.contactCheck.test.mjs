// Step L-21 — control's reading of the builder's contact_check row.
// Run: node --test src/lib/*.test.mjs   (Node ≥ 22.18 strips the .ts types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { contactChecks, reviewReasons } from "./reviewReasons.ts";

// Exactly what builder 73f3f72 leadReasonRows.recordContactCheck writes
// (pageRoute "/contact", 3 attempts, 3 findings) — keep in step by hand.
const ROW = {
  route: "(contact-check)", kind: "contact_check", page: "/contact", component: "ActionDrainAndPlumbingCta2", attempts: 3,
  error: "3 finding(s): Editing sideContent.contactInfo.0.value (set to \"(555) 010-9999\") does not reach the page: the link's href stays tel:5094671717; the link around the shown value stays tel:5094671717.",
  findings: [
    "Editing sideContent.contactInfo.0.value (set to \"(555) 010-9999\") does not reach the page: the link's href stays tel:5094671717; the link around the shown value stays tel:5094671717.",
    "Editing sideContent.contactInfo.1.value (set to \"sentinel@example.test\") does not reach the page: the link's href stays mailto:admin@actiondrain.net; the link around the shown value stays mailto:admin@actiondrain.net.",
    "third",
  ],
};

test("label: one plain line per contact_check row, no fallback 'contact check' line", () => {
  assert.deepEqual(reviewReasons([ROW]), [
    "Contact details incomplete — /contact ActionDrainAndPlumbingCta2: Editing sideContent.contactInfo.0.value (set to \"(555) 010-9999\") does not reach…",   // the 80-char clip
  ]);
});

test("label: two sections → two lines; homepage named; the same row twice → one line", () => {
  const home = { ...ROW, page: "/", component: "HeroX", findings: ["C1: phone not rendered"] };
  assert.deepEqual(reviewReasons([ROW, home, ROW]).map((l) => l.split(":")[0]), [
    "Contact details incomplete — /contact ActionDrainAndPlumbingCta2",
    "Contact details incomplete — homepage HeroX",
  ]);
});

test("label sits after the other kinds and does not hide them", () => {
  const out = reviewReasons([{ route: "/services/x", error: "boom" }, ROW, { route: "(refresh)", kind: "phone_conflict", error: "lead a vs built-in b" }]);
  assert.equal(out.length, 3);
  assert.match(out[0], /^Missing page/);
  assert.match(out[1], /^Phone conflict/);
  assert.match(out[2], /^Contact details incomplete/);
});

test("contactChecks: page, component, attempts and the first 2 findings, clipped at 160", () => {
  const [c, ...rest] = contactChecks([{ route: "/about", error: "x" }, ROW]);
  assert.equal(rest.length, 0);
  assert.equal(c.page, "/contact");
  assert.equal(c.component, "ActionDrainAndPlumbingCta2");
  assert.equal(c.attempts, 3);
  assert.equal(c.findings.length, 2);
  assert.equal(c.findings[0].length, 161);   // 160 + "…"
  assert.ok(c.findings[0].endsWith("…"));
  assert.ok(c.findings[1].startsWith("Editing sideContent.contactInfo.1.value"));
});

test("contactChecks: a row without findings falls back to its error; missing fields read '?' / null", () => {
  assert.deepEqual(contactChecks([{ kind: "contact_check", error: "1 finding(s): C1 email not rendered" }]), [
    { page: "?", component: "?", attempts: null, findings: ["1 finding(s): C1 email not rendered"] },
  ]);
  assert.deepEqual(contactChecks([{ kind: "contact_check" }]), [{ page: "?", component: "?", attempts: null, findings: [] }]);
});

test("contactChecks / reviewReasons: not an array, or no contact_check row → []", () => {
  for (const v of [null, undefined, "x", {}, [], [{ route: "/", kind: "render_crash" }]]) {
    assert.deepEqual(contactChecks(v), []);
  }
  assert.deepEqual(reviewReasons([{ route: "(contact-check)" }]), []);   // no kind → a pseudo-row, never a reason
});
