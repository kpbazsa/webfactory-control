// Two read-only strips above the review queue (Step HG-38b, hg/74 Part 4.4/4.5).
// The queue itself lists only built, unreviewed leads, so two kinds of hold never
// reach it:
//   - STUCK: a lead left in 'processing' or 'provisioning_pending' — the build
//     finished or stopped without its DB row (arrow-exterminators 09-01,
//     landscape-maintenance-llc 09-03). The builder's stuck digest emails once a
//     week; this is where it stays visible.
//   - HELD ON LIVE SITES: an APPROVED lead (usually already pitched) whose record
//     carries a hold the needs_review mark may not touch ("never un-approve"):
//     a held rebuild, a refreshPreview phone conflict, service pages that did not
//     go live, a crashing page or a page that did not build.
// Neither strip writes anything and neither offers Approve / Disapprove.
import { reviewReasons } from "@/lib/reviewReasons";
import type { createClient } from "@/lib/supabase/server";

type Supabase = ReturnType<typeof createClient>;

export const STUCK_STATUSES = ["processing", "provisioning_pending"];
export const STUCK_AFTER_HOURS = 6;

/** The build_started_at a lead must be older than to count as stuck. */
export function stuckCutoff(nowMs: number): string {
  return new Date(nowMs - STUCK_AFTER_HOURS * 60 * 60 * 1000).toISOString();
}

// The kinds a live (approved) site's record can carry that mean "something was
// held or did not ship" — shipCompleteness's names, kept in step by hand.
export const LIVE_HOLD_KINDS = ["held", "phone_conflict", "subpages_not_deployed", "render_crash"];

type Row = { route?: unknown; kind?: unknown };

/** Does this subpage_failures array carry a live-site hold? Pure. */
export function hasLiveHold(failures: unknown): boolean {
  if (!Array.isArray(failures)) return false;
  return (failures as Row[]).some((r) => {
    if (!r || typeof r !== "object") return false;
    if (typeof r.kind === "string") return LIVE_HOLD_KINDS.includes(r.kind);
    // no kind on a real route = a planned page that did not build
    return typeof r.route === "string" && r.route.startsWith("/");
  });
}

export type StuckLead = {
  id: string;
  business_name: string | null;
  business_slug: string | null;
  status: string;
  build_started_at: string | null;
  stuck_alerted_at: string | null;
  live_url: string | null;
};

export type LiveHoldLead = {
  id: string;
  business_name: string | null;
  business_slug: string | null;
  status: string | null;
  live_url: string | null;
  reasons: string[];
};

type Result<T> = { data: T[]; error: { message: string } | null };

const PAGE = 1000;

// Count-verified paged read — the queue's idiom: PostgREST truncates silently at
// max-rows, so the rows must add up to the exact count or the strip shows an
// error rather than a partial list.
async function readAll<T>(
  count: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<Result<T>> {
  const c = await count();
  if (c.error) return { data: [], error: c.error };
  if (c.count == null) return { data: [], error: { message: "count unavailable (null count from PostgREST)" } };
  const rows: unknown[] = [];
  for (let from = 0; from < c.count; from += PAGE) {
    const r = await page(from, from + PAGE - 1);
    if (r.error) return { data: [], error: r.error };
    rows.push(...(r.data ?? []));
    if (!r.data || r.data.length === 0) break;
  }
  if (rows.length !== c.count) {
    return { data: [], error: { message: `read incomplete: accumulated ${rows.length} rows but exact count is ${c.count}` } };
  }
  return { data: rows as T[], error: null };
}

/**
 * STUCK: status IN (processing, provisioning_pending) AND build_started_at < now − 6 h.
 * PostgREST: status=in.(processing,provisioning_pending)&build_started_at=lt.<cutoff>
 */
export async function fetchStuck(supabase: Supabase, nowMs: number): Promise<Result<StuckLead>> {
  const cutoff = stuckCutoff(nowMs);
  return readAll<StuckLead>(
    () => supabase.from("leads").select("id", { count: "exact", head: true })
      .in("status", STUCK_STATUSES).lt("build_started_at", cutoff),
    (from, to) => supabase.from("leads")
      .select("id, business_name, business_slug, status, build_started_at, stuck_alerted_at, live_url")
      .in("status", STUCK_STATUSES).lt("build_started_at", cutoff)
      .order("build_started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
}

/**
 * HELD ON LIVE SITES: approval_status = 'approved' AND subpage_failures <> '[]'
 * (PostgREST: approval_status=eq.approved&subpage_failures=neq.[]), then
 * hasLiveHold() on each row — "a row with no kind on a real route" cannot be
 * said in a PostgREST filter, so the kinds are decided here, on the few approved
 * rows that carry any failure at all.
 */
export async function fetchLiveHolds(supabase: Supabase): Promise<Result<LiveHoldLead>> {
  const r = await readAll<{ id: string; business_name: string | null; business_slug: string | null; status: string | null; live_url: string | null; subpage_failures: unknown }>(
    () => supabase.from("leads").select("id", { count: "exact", head: true })
      .eq("approval_status", "approved").neq("subpage_failures", "[]"),
    (from, to) => supabase.from("leads")
      .select("id, business_name, business_slug, status, live_url, subpage_failures")
      .eq("approval_status", "approved").neq("subpage_failures", "[]")
      .order("business_slug", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (r.error) return { data: [], error: r.error };
  return {
    data: r.data
      .filter((l) => hasLiveHold(l.subpage_failures))
      .map((l) => ({
        id: l.id, business_name: l.business_name, business_slug: l.business_slug, status: l.status, live_url: l.live_url,
        reasons: reviewReasons(l.subpage_failures),
      })),
    error: null,
  };
}
