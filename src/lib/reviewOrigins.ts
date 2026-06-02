// Origin constants and message-source allowlist for the Phase 2b review
// surface. The PWA iframes the engine and validates that every incoming
// postMessage originates from the engine; this is the mirror of the engine's
// own check that its parent is the PWA.
//
// DELIBERATELY DUPLICATED from the engine repo (lib/reviewOrigins.ts).
// The two repos are different framework generations — engine is
// Next 16 / React 19, PWA is Next 14 / React 18 — and do not share a
// package. The two copies validate OPPOSITE directions: engine checks
// parent === PWA, PWA checks message-source === engine. Keep in sync by
// hand when either side changes.

export const PWA_ORIGIN = "https://webfactory-control.vercel.app";
export const ENGINE_ORIGIN = "https://webfactory-engine.vercel.app";

const DEV_LOCALHOST_RE = /^http:\/\/localhost:\d+$/;

// WebFactory 2.0 builds serve from per-deploy Vercel hosts (the project
// alias webfactory-engine.vercel.app does NOT serve them — confirmed in
// ~/.claude/plans/webfactory-engine-serving-model-diagnosis-2026-06-01.md).
// Each lead.live_url has a host of the form
//   webfactory-engine-<alnum>-kpbazsa-8572s-projects.vercel.app
// (samples: -o1pnkjcvs-, -2qhfb6d11-, -kt6lvel3w-, -h56v65mh0-). postMessage
// event.origin is scheme+host only — no path — so the regex matches the host
// portion of live_url, not the full URL.
const PREVIEW_HOST_RE =
  /^https:\/\/webfactory-engine-[a-z0-9]+-kpbazsa-8572s-projects\.vercel\.app$/;

function devAllowed(): boolean {
  return process.env.NEXT_PUBLIC_ALLOW_DEV_REVIEW === "1";
}

// PWA-side validation: incoming messages must come from the ENGINE iframe.
// Note the direction — this is the mirror of the engine's
// isAllowedParentOrigin (which checks the parent is the PWA).
//
// Three origin classes are accepted:
//   1. ENGINE_ORIGIN — the project alias, kept for legacy pages-table-served
//      slugs (the alias still serves /<slug>/ for n8n-era slugs through
//      DynamicEngine).
//   2. PREVIEW_HOST_RE — per-deploy Vercel hosts where WebFactory 2.0 builds
//      live. This is the path every CURRENT build takes.
//   3. dev-localhost (when NEXT_PUBLIC_ALLOW_DEV_REVIEW=1) — for local
//      end-to-end testing with a local engine.
export function isAllowedEngineOrigin(origin: string): boolean {
  if (origin === ENGINE_ORIGIN) return true;
  if (PREVIEW_HOST_RE.test(origin)) return true;
  if (devAllowed() && DEV_LOCALHOST_RE.test(origin)) return true;
  return false;
}

// Build the iframe src that hosts the live engine site in review mode.
// Trailing slash is intentional — the engine has `trailingSlash: true` in
// next.config.js, so `/<slug>?review=1` would 308-redirect to
// `/<slug>/?review=1`. The query survives the redirect (verified during
// 2b-E pre-flight), but going through it adds an extra round-trip; using
// the trailing-slash form avoids it.
//
// In dev mode, NEXT_PUBLIC_ENGINE_DEV_ORIGIN can override the base so a
// local PWA can point at a local engine (e.g. http://localhost:3001).
export function engineReviewUrl(slug: string): string {
  const base =
    devAllowed() && process.env.NEXT_PUBLIC_ENGINE_DEV_ORIGIN
      ? process.env.NEXT_PUBLIC_ENGINE_DEV_ORIGIN.replace(/\/$/, "")
      : ENGINE_ORIGIN;
  return `${base}/${slug}/?review=1`;
}
