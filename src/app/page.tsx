import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";
import BuilderStatus from "@/components/BuilderStatus";
import { NEEDS_REVIEW, reviewReasons } from "@/lib/reviewReasons";
import { fetchContactChecks, fetchLiveHolds, fetchStuck, STUCK_AFTER_HOURS } from "@/lib/queueStrips";

type Lead = {
  id: string;
  business_name: string | null;
  industry: string | null;
  location: string | null;
  live_url: string | null;
  business_slug: string | null;
  build_date: string | null;
  approval_status: string | null;
  subpage_failures: unknown;
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Count-verified, paginated queue read — same idiom as the builder's
// leadFilter fetchSuppressionIndex: PostgREST silently truncates any single
// response at the project's max-rows cap (default 1000) with NO error, so an
// unpaged read past that size would quietly hide part of the review backlog —
// and unreviewed means never approved, never emailed. The
// count-vs-accumulated check fails closed (queue shows its error state) rather
// than render a silently partial list.
//
// The queue is every built, emailable lead with no operator verdict yet: NULL
// (never reviewed) OR needs_review (the builder marked the ship for a person —
// a missing page, a render crash, a broken image; reasons in subpage_failures).
// QUEUE_FILTER is the ONE filter both reads use, so the count and the pages can
// never disagree by construction. needs_review sorts first (text desc puts
// 'needs_review' above NULL), then newest build — in SQL, so paging is stable.
const QUEUE_FILTER = `approval_status.is.null,approval_status.eq.${NEEDS_REVIEW}`;

const QUEUE_PAGE = 1000;

async function fetchQueue(supabase: ReturnType<typeof createClient>) {
  // (1) Exact count first — the yardstick the accumulated pages must match.
  const { count, error: countError } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("status", "built")
    .not("email", "is", null)
    .or(QUEUE_FILTER);
  if (countError) return { data: null, error: countError };
  if (count == null)
    return { data: null, error: { message: "queue count unavailable (null count from PostgREST)" } };

  // (2) Page through the queue, preserving the display order.
  const rows: unknown[] = [];
  for (let from = 0; from < count; from += QUEUE_PAGE) {
    const { data, error } = await supabase
      .from("leads")
      .select(
        "id, business_name, industry, location, live_url, business_slug, build_date, visual_qa_status, approval_status, subpage_failures",
      )
      .eq("status", "built")
      .not("email", "is", null)
      .or(QUEUE_FILTER)
      .order("approval_status", { ascending: false, nullsFirst: false })
      .order("build_date", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + QUEUE_PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data ?? []));
    if (!data || data.length === 0) break; // queue shrank mid-read; count check below catches it
  }

  // (3) Count-vs-accumulated verification — disagreement means the queue moved
  // (or was truncated) mid-read; fail closed and let the operator reload.
  if (rows.length !== count) {
    return {
      data: null,
      error: {
        message: `queue read incomplete: accumulated ${rows.length} rows but exact count is ${count}`,
      },
    };
  }

  return { data: rows, error: null };
}

export default async function QueuePage() {
  const supabase = createClient();

  const { data, error } = await fetchQueue(supabase);
  // Step HG-38b — two read-only strips for holds the queue cannot list. Each
  // read fails on its own: an error shows in its strip and never hides the queue.
  // Step L-21 — a third: sections that shipped failing the contact-render check.
  const [stuck, liveHolds, contactChecked] = await Promise.all([
    fetchStuck(supabase, Date.now()), fetchLiveHolds(supabase), fetchContactChecks(supabase),
  ]);

  const leads = (data ?? []) as Lead[];
  const needsReviewCount = leads.filter((l) => l.approval_status === NEEDS_REVIEW).length;

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Review queue
            </h1>
            <p className="text-sm text-slate-500">
              {error
                ? "Could not load queue."
                : `${leads.length} site${leads.length === 1 ? "" : "s"} awaiting review` +
                  (needsReviewCount ? ` · ${needsReviewCount} marked needs review` : "")}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/changes"
              className="text-sm text-slate-600 hover:text-slate-900 underline-offset-4 hover:underline"
            >
              Changes
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* Builder liveness — client island polling controller_heartbeat; a
          fetch failure renders its UNKNOWN state and never breaks the queue. */}
      <BuilderStatus />

      <div className="max-w-5xl mx-auto px-6 py-8">
        {(stuck.error || stuck.data.length > 0) && (
          <section className="mb-6 rounded-md border border-red-200 bg-red-50 px-4 py-3">
            <h2 className="text-sm font-semibold text-red-900">
              Stuck{stuck.error ? "" : ` — ${stuck.data.length}`}
            </h2>
            <p className="text-xs text-red-800">
              In &apos;processing&apos; or &apos;provisioning_pending&apos; for more than {STUCK_AFTER_HOURS} h — the build finished or stopped without its DB row. Read-only.
            </p>
            {stuck.error ? (
              <p className="mt-1 font-mono text-xs text-red-700">{stuck.error.message}</p>
            ) : (
              <ul className="mt-2 divide-y divide-red-200">
                {stuck.data.map((l) => (
                  <li key={l.id} className="py-1.5 flex items-center justify-between gap-4 text-xs">
                    <span className="min-w-0 truncate text-red-900">
                      <span className="font-medium">{l.business_name ?? "(unnamed)"}</span>
                      {` — stuck in ${l.status} since ${formatDate(l.build_started_at)}`}
                      {l.stuck_alerted_at ? ` · alerted ${formatDate(l.stuck_alerted_at)}` : " · not alerted"}
                    </span>
                    {l.business_slug && l.live_url ? (
                      <Link href={`/review/${l.business_slug}`} className="shrink-0 font-medium text-red-800 underline underline-offset-2">
                        Review
                      </Link>
                    ) : (
                      <span className="shrink-0 font-mono text-red-700">{l.business_slug ? `client/${l.business_slug} · no live_url` : "no slug"}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(liveHolds.error || liveHolds.data.length > 0) && (
          <section className="mb-6 rounded-md border border-orange-200 bg-orange-50 px-4 py-3">
            <h2 className="text-sm font-semibold text-orange-900">
              Held on live sites{liveHolds.error ? "" : ` — ${liveHolds.data.length}`}
            </h2>
            <p className="text-xs text-orange-800">
              Approved sites whose record carries a hold or a page that did not ship. Information only — nothing to approve here.
            </p>
            {liveHolds.error ? (
              <p className="mt-1 font-mono text-xs text-orange-700">{liveHolds.error.message}</p>
            ) : (
              <ul className="mt-2 divide-y divide-orange-200">
                {liveHolds.data.map((l) => (
                  <li key={l.id} className="py-1.5 flex items-start justify-between gap-4 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium text-orange-900 truncate">
                        {l.business_name ?? "(unnamed)"}
                        {l.status ? <span className="font-normal text-orange-700">{` · ${l.status}`}</span> : null}
                      </p>
                      <p className="text-orange-800">{l.reasons.join(" · ") || "Reason not recorded"}</p>
                    </div>
                    {l.business_slug && l.live_url ? (
                      <Link href={`/review/${l.business_slug}`} className="shrink-0 font-medium text-orange-800 underline underline-offset-2">
                        Review
                      </Link>
                    ) : (
                      <span className="shrink-0 text-orange-700">no url</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {(contactChecked.error || contactChecked.data.length > 0) && (
          <section className="mb-6 rounded-md border border-sky-200 bg-sky-50 px-4 py-3">
            <h2 className="text-sm font-semibold text-sky-900">
              Contact check{contactChecked.error ? "" : ` — ${contactChecked.data.length}`}
            </h2>
            <p className="text-xs text-sky-800">
              A generated section shipped still failing the contact check after its last attempt — a phone, email or address may be missing, or an owner&apos;s edit may not reach it. Information only.
            </p>
            {contactChecked.error ? (
              <p className="mt-1 font-mono text-xs text-sky-700">{contactChecked.error.message}</p>
            ) : (
              <ul className="mt-2 divide-y divide-sky-200">
                {contactChecked.data.map((l) => (
                  <li key={l.id} className="py-1.5 flex items-start justify-between gap-4 text-xs">
                    <div className="min-w-0">
                      <p className="font-medium text-sky-900 truncate">
                        {l.business_name ?? "(unnamed)"}
                        <span className="font-normal text-sky-700">{` · ${[l.status, l.approval_status].filter(Boolean).join(" · ") || "no status"}`}</span>
                      </p>
                      {l.checks.map((c, i) => (
                        <div key={i} className="mt-0.5">
                          <p className="text-sky-900">
                            {`${c.page === "/" ? "homepage" : c.page} · ${c.component}${c.attempts != null ? ` · ${c.attempts} attempt${c.attempts === 1 ? "" : "s"}` : ""}`}
                          </p>
                          {c.findings.map((f, j) => (
                            <p key={j} className="pl-3 text-sky-800">{f}</p>
                          ))}
                        </div>
                      ))}
                    </div>
                    {l.business_slug && l.live_url ? (
                      <Link href={`/review/${l.business_slug}`} className="shrink-0 font-medium text-sky-800 underline underline-offset-2">
                        Review
                      </Link>
                    ) : (
                      <span className="shrink-0 text-sky-700">no url</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {error && (
          <div className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
            <p className="font-medium">Query error</p>
            <p className="mt-1 font-mono text-xs whitespace-pre-wrap">
              {error.message}
            </p>
          </div>
        )}

        {!error && leads.length === 0 && (
          <div className="text-sm text-slate-500 bg-white border border-slate-200 rounded-md px-4 py-8 text-center">
            No sites awaiting review.
          </div>
        )}

        {!error && leads.length > 0 && (
          <ul className="bg-white border border-slate-200 rounded-md divide-y divide-slate-200">
            {leads.map((lead) => (
              <li
                key={lead.id}
                className="px-4 py-3 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">
                    {lead.approval_status === NEEDS_REVIEW && (
                      <span className="mr-2 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                        Needs review
                      </span>
                    )}
                    {lead.business_name ?? "(unnamed)"}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {[lead.industry, lead.location]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
                  {lead.approval_status === NEEDS_REVIEW && (() => {
                    const reasons = reviewReasons(lead.subpage_failures);
                    return (
                      <p className="text-xs text-amber-800">
                        {reasons.length ? reasons.join(" · ") : "No reason recorded (a held build, or the reasons were cleared)"}
                      </p>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <span className="text-xs text-slate-500">
                    {formatDate(lead.build_date)}
                  </span>
                  {lead.live_url ? (
                    <a
                      href={lead.live_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-slate-700 hover:text-slate-900 underline underline-offset-2"
                    >
                      View
                    </a>
                  ) : (
                    <span className="text-xs text-slate-400">no url</span>
                  )}
                  {lead.business_slug ? (
                    <Link
                      href={`/review/${lead.business_slug}`}
                      className="text-xs font-medium text-emerald-700 hover:text-emerald-900 underline underline-offset-2"
                    >
                      Review
                    </Link>
                  ) : (
                    <span className="text-xs text-slate-400">no slug</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
