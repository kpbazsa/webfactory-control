import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import ReviewHost from "@/components/ReviewHost";

type PageProps = {
  params: { slug: string };
};

export default async function ReviewPage({ params }: PageProps) {
  const { slug } = params;

  const supabase = createClient();
  const { data, error } = await supabase
    .from("leads")
    .select("business_name, business_slug, live_url")
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
      liveUrl={data.live_url}
    />
  );
}
