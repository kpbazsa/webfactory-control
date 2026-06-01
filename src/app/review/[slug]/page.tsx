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
    .select("business_name, business_slug")
    .eq("business_slug", slug)
    .maybeSingle();

  if (error || !data) {
    notFound();
  }

  return <ReviewHost slug={slug} businessName={data.business_name} />;
}
