import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReviewHost from "@/components/ReviewHost";
import { NEEDS_REVIEW, reviewReasons } from "@/lib/reviewReasons";

type PageProps = {
  params: { slug: string };
};

export default async function ReviewPage({ params }: PageProps) {
  const { slug } = params;

  const supabase = createClient();
  // Pull the columns the NoteSheet inserts need: id (FK on section_notes /
  // section_defects), build_date + the retrieval dimensions (industry,
  // apify_category, location) carried onto every note row, plus the
  // business_name and live_url the chrome already used. No insert is done
  // server-side; this lookup just feeds the client component its context.
  // Newest-built-row-wins: business_slug SHOULD be unique (builder-side
  // slugAllocator claims per-lead slugs), but historical duplicate groups
  // exist (same-name chain locations, e.g. keyme-locksmiths ×4) and
  // .maybeSingle() 406s on >1 rows — turning the whole review window into a
  // 404. Ordering by build_date desc + limit 1 is deterministic and matches
  // what the queue page (also build_date desc) visually presents as "the"
  // lead for a slug.
  const { data: rows, error } = await supabase
    .from("leads")
    .select(
      "id, business_name, email, business_slug, live_url, build_date, industry, apify_category, location, visual_qa_status, approval_status, subpage_failures",
    )
    .eq("business_slug", slug)
    .order("build_date", { ascending: false, nullsFirst: false })
    .limit(1);
  const data = rows?.[0];

  // Built sites serve only at lead.live_url (the per-deploy Vercel host). No
  // live_url means there's nothing to iframe — 404 rather than render a
  // broken review screen.
  if (error || !data || !data.live_url) {
    notFound();
  }

  // QA reason for the badge: the bare verdict lives on leads.visual_qa_status,
  // but the detail (score + issues) lives in visual_qa_runs — one row per QA
  // attempt. Pull the LATEST run for this lead. RLS is disabled on
  // visual_qa_runs (migration 006), so the operator-auth client reads it
  // directly. Fail-soft: a missing/erroring run just yields a status-only badge.
  const { data: qaRun } = await supabase
    .from("visual_qa_runs")
    .select("passed, overall_score, issues, error, created_at")
    .eq("lead_id", data.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <ReviewHost
      slug={slug}
      businessName={data.business_name}
      email={data.email ?? null}
      liveUrl={data.live_url}
      // needs_review: the builder's mark + its reasons (leads.subpage_failures).
      // Approve / Disapprove overwrite the mark exactly as they overwrite NULL.
      review={{
        needsReview: data.approval_status === NEEDS_REVIEW,
        reasons:     reviewReasons(data.subpage_failures),
      }}
      qa={{
        status: data.visual_qa_status ?? null,
        passed: qaRun?.passed ?? null,
        score:  qaRun?.overall_score ?? null,
        issues: qaRun?.issues ?? null,
        error:  qaRun?.error ?? null,
      }}
      lead={{
        leadId:         data.id,
        businessSlug:   data.business_slug ?? slug,
        buildDate:      data.build_date,
        industry:       data.industry,
        apifyCategory:  data.apify_category,
        location:       data.location,
      }}
    />
  );
}
