"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

// Mirrors builder src/control/intentKinds.js PROPOSAL_REQUEST (separate repo —
// keep in sync). Used by the "Code issue" triage to re-enqueue a clarified note.
const PROPOSAL_REQUEST = "template_change_proposal_request";

export type Proposal = {
  id: string;
  component_name: string;
  diff_unified: string;
  llm_rationale: string | null;
  test_status: "passed" | "failed" | "skipped";
  test_log: string | null;
  approval_status: "pending" | "approved" | "rejected";
  created_at: string;
};

export type Bounce = {
  intentId: string;
  noteId: string | null;
  componentName: string | null;
  clarification: string;
  noteText: string | null;
  businessSlug: string | null;
  createdAt: string;
};

type Toast = { id: number; text: string; kind: "info" | "ok" | "warn" };

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function TestBadge({ status }: { status: Proposal["test_status"] }) {
  if (status === "passed") {
    return (
      <span className="shrink-0 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
        ✓ compiles + prop-contract preserved
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="shrink-0 rounded-full bg-red-50 border border-red-200 px-2.5 py-0.5 text-xs font-medium text-red-700">
        ✕ test failed
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-slate-100 border border-slate-200 px-2.5 py-0.5 text-xs font-medium text-slate-500">
      untested
    </span>
  );
}

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed font-mono">
      {lines.map((line, i) => {
        let cls = "text-slate-600";
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-emerald-700 bg-emerald-50";
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-700 bg-red-50";
        else if (line.startsWith("@@")) cls = "text-indigo-600";
        else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")) cls = "text-slate-400";
        return (
          <div key={i} className={"whitespace-pre " + cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export default function ChangesHost({
  proposals,
  bounces = [],
}: {
  proposals: Proposal[];
  bounces?: Bounce[];
}) {
  const router = useRouter();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  function getSupabase() {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  }

  const pushToast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2400);
  }, []);

  async function handleApprove(p: Proposal) {
    if (submittingId) return;
    if (p.test_status !== "passed") return; // button is disabled; double-guard
    setSubmittingId(p.id);

    const supabase = getSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSubmittingId(null);
      pushToast("Not signed in — not saved", "warn");
      return;
    }

    const res = await supabase
      .from("template_change_proposals")
      .update({
        approval_status: "approved",
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq("id", p.id)
      .eq("approval_status", "pending");
    if (res.error) {
      console.error("[changes] approve failed", res.error);
      pushToast("Approve failed: " + res.error.message, "warn");
      setSubmittingId(null);
      return;
    }

    pushToast("Approved", "ok");
    setSubmittingId(null);
    router.refresh();
  }

  async function handleReject(p: Proposal) {
    if (submittingId) return;
    const reason = window.prompt(
      "Reject the " + p.component_name + " change?\n\nOptional reason (leave blank to reject without one):",
    );
    if (reason === null) return; // Cancel
    setSubmittingId(p.id);

    const supabase = getSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setSubmittingId(null);
      pushToast("Not signed in — not saved", "warn");
      return;
    }

    const res = await supabase
      .from("template_change_proposals")
      .update({
        approval_status: "rejected",
        approval_reason: reason.trim() || null,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
      })
      .eq("id", p.id)
      .eq("approval_status", "pending");
    if (res.error) {
      console.error("[changes] reject failed", res.error);
      pushToast("Reject failed: " + res.error.message, "warn");
      setSubmittingId(null);
      return;
    }

    pushToast("Rejected", "ok");
    setSubmittingId(null);
    router.refresh();
  }

  // Triage: this code_fix note is really architect/memory material. Flip it to
  // note_action='architect' (the lessons retriever handles vague notes fine) and
  // delete the bounced intent so it drops off the list.
  async function handleLlmRule(b: Bounce) {
    if (submittingId) return;
    if (!b.noteId) { pushToast("No source note found — cannot reroute", "warn"); return; }
    setSubmittingId(b.intentId);
    const supabase = getSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSubmittingId(null); pushToast("Not signed in — not saved", "warn"); return; }

    const up = await supabase.from("section_notes").update({ note_action: "architect" }).eq("id", b.noteId);
    if (up.error) {
      console.error("[changes] reroute failed", up.error);
      pushToast("Reroute failed: " + up.error.message, "warn");
      setSubmittingId(null);
      return;
    }
    const del = await supabase.from("control_intents").delete().eq("id", b.intentId);
    if (del.error) {
      console.error("[changes] bounce clear failed", del.error);
      pushToast("Rerouted, but the bounce did not clear: " + del.error.message, "warn");
      setSubmittingId(null);
      router.refresh();
      return;
    }
    pushToast("Sent to architect memory", "ok");
    setSubmittingId(null);
    router.refresh();
  }

  // Triage: this genuinely needs a code change but lacked a desired end-state.
  // Collect the missing detail, fold it into the note, enqueue a fresh
  // proposal-request (same shape as the PWA producer), drop the old bounce.
  async function handleCodeIssue(b: Bounce) {
    if (submittingId) return;
    if (!b.noteId) { pushToast("No source note found — cannot re-queue", "warn"); return; }
    const endState = window.prompt(
      "What should this section actually do? Describe the desired end-state the draft was missing.\n\n" +
        (b.noteText ? "Original note: " + b.noteText : ""),
    );
    if (endState === null) return;
    if (!endState.trim()) { pushToast("Need a desired end-state to re-queue", "warn"); return; }
    setSubmittingId(b.intentId);
    const supabase = getSupabase();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setSubmittingId(null); pushToast("Not signed in — not saved", "warn"); return; }

    const clarified = (b.noteText ? b.noteText.trim() + " " : "") + "Desired: " + endState.trim();
    const up = await supabase.from("section_notes").update({ note_text: clarified }).eq("id", b.noteId);
    if (up.error) {
      console.error("[changes] note clarify failed", up.error);
      pushToast("Update failed: " + up.error.message, "warn");
      setSubmittingId(null);
      return;
    }

    const payload: { note_id: string; component_name?: string } = { note_id: b.noteId };
    if (b.componentName) payload.component_name = b.componentName;
    const ins = await supabase.from("control_intents").insert({
      kind: PROPOSAL_REQUEST,
      payload,
      requested_by: user.id,
    });
    if (ins.error) {
      console.error("[changes] re-queue failed", ins.error);
      pushToast("Note updated, but re-queue failed: " + ins.error.message, "warn");
      setSubmittingId(null);
      router.refresh();
      return;
    }
    const del = await supabase.from("control_intents").delete().eq("id", b.intentId);
    if (del.error) console.error("[changes] old bounce clear failed", del.error); // non-fatal
    pushToast("Re-queued for drafting", "ok");
    setSubmittingId(null);
    router.refresh();
  }

  return (
    <div className="relative">
      {proposals.length === 0 ? (
        <div className="text-sm text-slate-500 bg-white border border-slate-200 rounded-md px-4 py-8 text-center">
          No proposals awaiting review.
        </div>
      ) : (
        <ul className="space-y-4">
          {proposals.map((p) => {
            const busy = submittingId === p.id;
            const canApprove = p.test_status === "passed" && !submittingId;
            return (
              <li key={p.id} className="bg-white border border-slate-200 rounded-md p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{p.component_name}</p>
                    <p className="text-xs text-slate-500">{formatDate(p.created_at)}</p>
                  </div>
                  <TestBadge status={p.test_status} />
                </div>

                {p.llm_rationale && (
                  <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap">{p.llm_rationale}</p>
                )}

                <DiffView diff={p.diff_unified} />

                {p.test_status !== "passed" && p.test_log && (
                  <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">
                    <p className="font-medium">Test output</p>
                    <pre className="mt-1 font-mono whitespace-pre-wrap">{p.test_log}</pre>
                  </div>
                )}

                <div className="mt-4 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => handleReject(p)}
                    disabled={busy}
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy ? "…" : "Reject"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprove(p)}
                    disabled={!canApprove || busy}
                    title={p.test_status !== "passed" ? "Can't approve — proposal didn't pass the auto-test" : undefined}
                    className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 active:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-emerald-600"
                  >
                    {busy ? "Saving…" : "Approve"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {bounces.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold text-slate-900 mb-1">
            Notes needing clarification ({bounces.length})
          </h2>
          <p className="text-xs text-slate-500 mb-4">
            These code-fix notes did not state a clear desired end-state, so no draft was made. Decide each: send it to the architect as a memory rule, or treat it as a code issue and add the missing detail.
          </p>
          <ul className="space-y-4">
            {bounces.map((b) => {
              const busy = submittingId === b.intentId;
              const locked = submittingId !== null;
              return (
                <li key={b.intentId} className="bg-white border border-amber-200 rounded-md p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">
                        {b.componentName ?? "(unknown component)"}
                      </p>
                      <p className="text-xs text-slate-500">bounced {formatDate(b.createdAt)}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                      needs clarification
                    </span>
                  </div>

                  {b.noteText && (
                    <p className="mt-3 text-sm text-slate-700 whitespace-pre-wrap">
                      <span className="text-slate-400">Note: </span>
                      {b.noteText}
                    </p>
                  )}

                  <div className="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    <span className="font-medium">Classifier asked: </span>
                    {b.clarification}
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-3">
                    {b.businessSlug ? (
                      <Link
                        href={`/review/${b.businessSlug}`}
                        className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
                      >
                        View on site
                      </Link>
                    ) : (
                      <span />
                    )}
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleLlmRule(b)}
                        disabled={locked}
                        className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy ? "…" : "LLM rule"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCodeIssue(b)}
                        disabled={locked}
                        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 active:bg-black disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {busy ? "Saving…" : "Code issue"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={
              "pointer-events-auto rounded-md px-3 py-2 text-xs font-medium shadow-lg " +
              (t.kind === "ok" ? "bg-emerald-600 text-white" : t.kind === "warn" ? "bg-rose-600 text-white" : "bg-slate-900 text-white")
            }
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
