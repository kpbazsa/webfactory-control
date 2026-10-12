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
//   - route starting "("    → a pseudo-row ((planner), (service-grouping), …):
//                             not a page, never a reason here
// Any other kind is shown by its own name, so a later builder rule that adds a
// kind reads as something rather than nothing.

export const NEEDS_REVIEW = "needs_review";

type FailureRow = { route?: unknown; kind?: unknown };

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
  if (missing.length) reasons.push(`Missing page — did not build: ${missing.map(pageName).join(", ")}`);
  if (crashed.length) reasons.push(`Render crash — shows an error screen: ${crashed.map(pageName).join(", ")}`);
  if (broken.length) reasons.push(`Broken image — an image never loads on: ${broken.map(pageName).join(", ")}`);
  const otherKinds = new Set<string>();
  for (const r of rows) {
    if (typeof r?.kind === "string" && r.kind !== "render_crash" && r.kind !== "broken_image") otherKinds.add(r.kind);
  }
  for (const kind of Array.from(otherKinds)) {
    const routes = routesOf(rows, (k) => k === kind);
    reasons.push(`${kind.replace(/_/g, " ")}${routes.length ? `: ${routes.map(pageName).join(", ")}` : ""}`);
  }
  return reasons;
}
