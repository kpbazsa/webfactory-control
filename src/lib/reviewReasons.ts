// needs_review — the builder's "a person must look at this ship" mark on
// leads.approval_status (builder src/engine/shipCompleteness.js,
// INCOMPLETE_APPROVAL_STATUS). The builder writes it only over NULL, never over
// an operator verdict; Approve / Disapprove here overwrite it like NULL.
//
// The REASONS live in leads.subpage_failures (jsonb array of {route, error,
// kind?}). This mirrors shipCompleteness's reading of that array — the two repos
// share no package, so keep in sync by hand:
//   - no kind, real route   → a planned page that did not build
//   - kind "render_crash"   → a shipped page showing Next's error screen
//   - kind "broken_image"   → a shipped page with an image that never decodes
//   - kind "blank_prop"     → a shipped page with a template blank the builder
//                             could not fill (error "<Component>.<prop>: <text>")
//   - kind "thin_read"      → route "(profile)": the business's site read too
//                             thin to build from (error "<fields> missing; …")
//   - kind "held"           → route "(build)": a rebuild was HELD; the row sits on
//                             the LIVE build's record (error = the hold reason)
//   - kind "subpages_not_deployed" → route "(subpages)" (or "(service-grouping)"'s
//                             sibling): the service pages did not go live (error
//                             "<cause>: <detail>")
//   - kind "phone_conflict" → route "(refresh)": refreshPreview held a site's link
//                             fixes over a phone number conflict (error "lead … vs
//                             built-in … — N link(s) not fixed (--flag)")
//   - route starting "("    → a pseudo-row ((planner), (service-grouping), …):
//                             not a page, never a reason here (the kinds above
//                             aside — they are read by kind, on any route)
// Any other kind is shown by its own name, so a later builder rule that adds a
// kind reads as something rather than nothing.

export const NEEDS_REVIEW = "needs_review";

type FailureRow = { route?: unknown; kind?: unknown; error?: unknown };

// Kinds with their own wording below; anything else is shown by its name.
const LABELLED_KINDS = ["render_crash", "broken_image", "blank_prop", "thin_read", "held", "subpages_not_deployed", "phone_conflict"];

// A row's error, flattened and cut to its first 80 characters (an ellipsis marks
// a cut) — enough to say why a page did not build without flooding the queue.
const ERROR_CLIP = 80;
function clip(error: unknown): string {
  if (typeof error !== "string") return "";
  const flat = error.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_CLIP ? `${flat.slice(0, ERROR_CLIP)}…` : flat;
}

// The first error recorded for a route among rows of no kind (a missing page).
function missingError(rows: FailureRow[], route: string): string {
  const r = rows.find((x) => x && x.route === route && typeof x.kind !== "string" && typeof x.error === "string" && x.error.trim());
  return r ? clip(r.error) : "";
}

// subpages_not_deployed causes after which NO service page was planned (builder
// subpageBuilder S2 / S3); every other cause means only the homepage went live.
const NO_SERVICE_PAGE_CAUSES = ["service grouping failed", "service planning failed"];

// "<cause>: <detail>" → "<cause>" (the whole text when there is no ": ").
function causeOf(error: unknown): string {
  if (typeof error !== "string") return "";
  const i = error.indexOf(": ");
  return (i >= 0 ? error.slice(0, i) : error).trim();
}

const PSEUDO_ROUTE_RE = /^\(/;

function pageName(route: string): string {
  return route === "/" ? "homepage" : route;
}

function routesOf(rows: FailureRow[], match: (kind: string | null) => boolean): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r || typeof r.route !== "string" || !r.route || PSEUDO_ROUTE_RE.test(r.route)) continue;
    const kind = typeof r.kind === "string" ? r.kind : null;
    if (match(kind) && !out.includes(r.route)) out.push(r.route);
  }
  return out;
}

/** Plain-language reasons, one per problem class; [] when none are recorded. */
export function reviewReasons(failures: unknown): string[] {
  if (!Array.isArray(failures)) return [];
  const rows = failures as FailureRow[];
  const reasons: string[] = [];
  const missing = routesOf(rows, (k) => k === null);
  const crashed = routesOf(rows, (k) => k === "render_crash");
  const broken = routesOf(rows, (k) => k === "broken_image");
  if (missing.length) {
    const withWhy = missing.some((r) => missingError(rows, r));
    reasons.push(`Missing page — did not build: ${withWhy
      ? missing.map((r) => { const why = missingError(rows, r); return why ? `${pageName(r)} — ${why}` : pageName(r); }).join("; ")
      : missing.map(pageName).join(", ")}`);
  }
  if (crashed.length) reasons.push(`Render crash — shows an error screen: ${crashed.map(pageName).join(", ")}`);
  if (broken.length) reasons.push(`Broken image — an image never loads on: ${broken.map(pageName).join(", ")}`);
  // One line per unfilled blank: the page and the Component.prop it sits in.
  for (const r of rows) {
    if (r?.kind !== "blank_prop" || typeof r.route !== "string" || !r.route || PSEUDO_ROUTE_RE.test(r.route)) continue;
    const where = typeof r.error === "string" ? r.error.split(": ")[0] : "";
    const line = `Unfilled blank: ${pageName(r.route)}${where ? ` — ${where}` : ""}`;
    if (!reasons.includes(line)) reasons.push(line);
  }
  // The (profile) pseudo-row: the fields the profile lacked.
  const thin = rows.find((r) => r?.kind === "thin_read");
  if (thin) {
    const fields = typeof thin.error === "string" ? thin.error.split(" missing")[0].trim() : "";
    reasons.push(`Thin site read — the business's site gave too little to build from${fields ? `: ${fields}` : ""}`);
  }
  // The (build) pseudo-row: a rebuild was held, the live site was kept.
  for (const r of rows) {
    if (r?.kind !== "held") continue;
    const why = typeof r.error === "string" ? r.error.trim() : "";
    const line = `Held — the new build was not published; the live site is unchanged${why ? `: ${why}` : ""}`;
    if (!reasons.includes(line)) reasons.push(line);
  }
  // The (subpages) pseudo-row: one line per distinct cause.
  for (const r of rows) {
    if (r?.kind !== "subpages_not_deployed") continue;
    const cause = causeOf(r.error);
    // Grouping or planning failed: no service page was planned at all (after a
    // grouping failure about / contact / gallery may still ship; after a planner
    // failure only the homepage and the fixed pages that rode its commit do).
    const tail = NO_SERVICE_PAGE_CAUSES.includes(cause) ? "the site has no service pages" : "only the homepage is live";
    const line = `Service pages not published — ${cause || "cause not recorded"}; ${tail}`;
    if (!reasons.includes(line)) reasons.push(line);
  }
  // The (refresh) pseudo-row: refreshPreview held a site's link fixes.
  for (const r of rows) {
    if (r?.kind !== "phone_conflict") continue;
    const what = typeof r.error === "string" ? r.error.trim() : "";
    const line = `Phone conflict — the lead's number and the number built into the site differ; link fixes held${what ? `: ${what}` : ""}`;
    if (!reasons.includes(line)) reasons.push(line);
  }
  const otherKinds = new Set<string>();
  for (const r of rows) {
    if (typeof r?.kind === "string" && !LABELLED_KINDS.includes(r.kind)) otherKinds.add(r.kind);
  }
  for (const kind of Array.from(otherKinds)) {
    const routes = routesOf(rows, (k) => k === kind);
    reasons.push(`${kind.replace(/_/g, " ")}${routes.length ? `: ${routes.map(pageName).join(", ")}` : ""}`);
  }
  return reasons;
}
