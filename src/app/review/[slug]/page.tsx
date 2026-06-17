import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReviewHost from "@/components/ReviewHost";

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
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, business_name, email, business_slug, live_url, build_date, industry, apify_category, location",
    )
    .eq("business_slug", slug)
    .maybeSingle();

  // Built sites serve only at lead.live_url (the per-deploy Vercel host). No
  // live_url means there's nothing to iframe — 404 rather than render a
  // broken review screen.
  if (error || !data || !data.live_url) {
    notFound();
  }

  return (
    <ReviewHost
      slug={slug}
      businessName={data.business_name}
      email={data.email ?? null}
      liveUrl={data.live_url}
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
