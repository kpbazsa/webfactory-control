import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

type Lead = {
  id: string;
  business_name: string | null;
  industry: string | null;
  location: string | null;
  live_url: string | null;
  business_slug: string | null;
  build_date: string | null;
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

export default async function QueuePage() {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, business_name, industry, location, live_url, business_slug, build_date",
    )
    .in("status", ["built", "manual_review"])
    .is("approval_status", null)
    .order("build_date", { ascending: false });

  const leads = (data ?? []) as Lead[];

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
                : `${leads.length} site${leads.length === 1 ? "" : "s"} awaiting review`}
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

      <div className="max-w-5xl mx-auto px-6 py-8">
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
                    {lead.business_name ?? "(unnamed)"}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    {[lead.industry, lead.location]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </p>
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
