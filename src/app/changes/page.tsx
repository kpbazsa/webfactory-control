import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "../sign-out-button";
import ChangesHost, { type Proposal, type Bounce, type FailedCommit } from "./ChangesHost";

// Test phase: show ALL pending proposals regardless of is_test. Mirrors
// ReviewHost's IS_TEST_PHASE — flip both together at launch so the /changes
// queue stops showing test-phase proposals.
const IS_TEST_PHASE = true;

export default async function ChangesPage() {
  const supabase = createClient();

  let query = supabase
    .from("template_change_proposals")
    .select(
      "id, component_name, diff_unified, llm_rationale, test_status, test_log, approval_status, created_at",
    )
    .eq("approval_status", "pending")
    .order("created_at", { ascending: false });
  if (!IS_TEST_PHASE) query = query.eq("is_test", false);

  const { data, error } = await query;
  const proposals = (data ?? []) as Proposal[];

  // Bounces: code_fix notes the classifier rejected as symptom-only — no draft
  // was made. Two reads: the failed intents, then their source notes (note_id
  // lives in the intent's jsonb payload, so it cannot be a PostgREST embed).
  const { data: intentRows } = await supabase
    .from("control_intents")
    .select("id, payload, error, created_at")
    .eq("kind", "template_change_proposal_request")
    .eq("status", "failed")
    .like("error", "Note needs clarification%")
    .order("created_at", { ascending: false });
  const failedIntents = (intentRows ?? []) as Array<{
    id: string;
    payload: { note_id?: string; component_name?: string } | null;
    error: string | null;
    created_at: string;
  }>;

  const noteIds = failedIntents
    .map((i) => i.payload?.note_id)
    .filter((x): x is string => typeof x === "string");
  const notesById: Record<string, { note_text: string | null; business_slug: string | null; component_name: string | null }> = {};
  if (noteIds.length > 0) {
    const { data: noteRows } = await supabase
      .from("section_notes")
      .select("id, note_text, business_slug, component_name")
      .in("id", noteIds);
    for (const n of (noteRows ?? []) as Array<{ id: string; note_text: string | null; business_slug: string | null; component_name: string | null }>) {
      notesById[n.id] = { note_text: n.note_text, business_slug: n.business_slug, component_name: n.component_name };
    }
  }

  const bounces: Bounce[] = failedIntents.map((i) => {
    const note = i.payload?.note_id ? notesById[i.payload.note_id] : undefined;
    return {
      intentId: i.id,
      noteId: i.payload?.note_id ?? null,
      componentName: i.payload?.component_name ?? note?.component_name ?? null,
      clarification: (i.error ?? "").replace(/^Note needs clarification \(symptom-only\):\s*/, ""),
      noteText: note?.note_text ?? null,
      businessSlug: note?.business_slug ?? null,
      createdAt: i.created_at,
    };
  });

  // Failed commits: proposals the operator approved but whose commit to the
  // engine did not complete (commit_error set, commit_sha still null). The
  // commit handler stops retrying these; surface them for Retry/Reject.
  let fcQuery = supabase
    .from("template_change_proposals")
    .select(
      "id, component_name, diff_unified, llm_rationale, commit_error, approved_at, created_at",
    )
    .eq("approval_status", "approved")
    .is("commit_sha", null)
    .not("commit_error", "is", null)
    .order("approved_at", { ascending: false });
  if (!IS_TEST_PHASE) fcQuery = fcQuery.eq("is_test", false);
  const { data: fcData } = await fcQuery;
  const failedCommits = (fcData ?? []) as FailedCommit[];

  return (
    <main className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">
              Pending template changes
            </h1>
            <p className="text-sm text-slate-500">
              {error
                ? "Could not load proposals."
                : `${proposals.length} proposal${proposals.length === 1 ? "" : "s"} awaiting review`}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-sm text-slate-600 hover:text-slate-900 underline-offset-4 hover:underline"
            >
              Queue
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {error ? (
          <div className="mb-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-3">
            <p className="font-medium">Query error</p>
            <p className="mt-1 font-mono text-xs whitespace-pre-wrap">
              {error.message}
            </p>
          </div>
        ) : (
          <ChangesHost proposals={proposals} bounces={bounces} failedCommits={failedCommits} />
        )}
      </div>
    </main>
  );
}
