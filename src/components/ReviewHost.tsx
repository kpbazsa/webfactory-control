"use client";

// Phase 2c review host. Iframes the live engine site with ?review=1,
// answers the engine's WF_REVIEW_HELLO with a nonce-bearing WF_REVIEW_ACK,
// and on WF_SECTION_PRESS opens the NoteSheet to capture a design issue or
// defect (writes to section_notes or section_defects respectively).
// Approve/Disapprove are still stubs — leads.approval_status + site_reviews
// land in the next chip.
//
// Origin discipline: every inbound message is rejected unless
// isAllowedEngineOrigin(event.origin) AND event.source ===
// iframeRef.current.contentWindow. The ACK is posted with targetOrigin =
// event.origin (the already-validated engine origin), never "*".

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { isAllowedEngineOrigin } from "@/lib/reviewOrigins";
import { createClient } from "@/lib/supabase/client";
import {
  deriveSectionType,
  isCustomSection,
} from "@/lib/sectionTaxonomy";
import NoteSheet, { type NoteSubmission } from "./NoteSheet";

// Hard filter so test-phase notes never reach the architect. Flip to false
// at launch (and consider an UPDATE on existing test rows then). Mirrors
// the migration's default — they must match.
const IS_TEST_PHASE = true;

// Mirrors builder src/control/intentKinds.js PROPOSAL_REQUEST. The two repos
// don't share a package (different framework generations), so this string is
// duplicated by hand — keep in sync if the builder constant ever changes.
const PROPOSAL_REQUEST = "template_change_proposal_request";

type Toast = { id: number; text: string; kind: "info" | "ok" | "warn" };

type SheetState =
  | { open: false }
  | { open: true; sectionIndex: number; componentName: string };

export type LeadContext = {
  leadId: string;
  businessSlug: string;
  buildDate: string | null;
  industry: string | null;
  apifyCategory: string | null;
  location: string | null;
};

export default function ReviewHost({
  slug,
  businessName,
  liveUrl,
  email,
  lead,
}: {
  slug: string;
  businessName: string | null;
  liveUrl: string;
  email: string | null;
  lead: LeadContext;
}) {
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [sheet, setSheet] = useState<SheetState>({ open: false });
  const [submitting, setSubmitting] = useState(false);
  // Guards the verdict-write code path from re-entry on double-tap. Doesn't
  // affect the button styling — disapprove still requires confirm() first.
  const [verdictSubmitting, setVerdictSubmitting] = useState(false);
  // Lazy: build the browser Supabase client once. It picks up the operator's
  // auth session from cookies automatically, so RLS-authenticated inserts
  // work directly.
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  function getSupabase() {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  }

  const pushToast = useCallback(
    (text: string, kind: Toast["kind"] = "info") => {
      const id = ++toastSeq.current;
      setToasts((prev) => [...prev, { id, text, kind }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 2400);
    },
    [],
  );

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Origin allowlist FIRST, before reading e.data.
      if (!isAllowedEngineOrigin(e.origin)) return;
      // Tie the message to OUR iframe — not some other frame on the page.
      if (e.source !== iframeRef.current?.contentWindow) return;

      const data = e.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "WF_REVIEW_HELLO") {
        // Re-handshake is fine: the engine may remount on in-iframe nav and
        // send a fresh HELLO. We always answer with a freshly minted nonce.
        const nonce = crypto.randomUUID();
        nonceRef.current = nonce;
        iframeRef.current?.contentWindow?.postMessage(
          { type: "WF_REVIEW_ACK", nonce },
          e.origin,
        );
        return;
      }

      if (data.type === "WF_SECTION_PRESS") {
        // Reject any press whose nonce doesn't match what we last issued.
        if (
          typeof data.nonce !== "string" ||
          data.nonce !== nonceRef.current
        ) {
          return;
        }
        const idx = data.sectionIndex;
        const comp = data.componentName;
        if (typeof idx !== "number" || typeof comp !== "string") return;
        // If the sheet is already open mid-edit, ignore the press — don't
        // discard typed text. The operator finishes or cancels first.
        setSheet((prev) =>
          prev.open
            ? prev
            : { open: true, sectionIndex: idx, componentName: comp },
        );
        return;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Shared write path for both verdicts. Two writes, ordered:
  //   1. INSERT into site_reviews — the audit record.
  //   2. UPDATE leads.approval_status — the gate flip (removes the lead from
  //      the queue, lets Phase 3 outreach include it once approval_status='approved').
  // site_reviews first so a UPDATE failure leaves a recoverable audit trail.
  // The reverse (status flipped, no record) is the silent-corruption case.
  //
  // Retry after partial failure CAN produce a second site_reviews row — that's
  // acceptable: verdicts are append-only audit, last UPDATE wins on the lead.
  async function writeVerdict(verdict: "approved" | "disapproved") {
    if (verdictSubmitting) return;
    setVerdictSubmitting(true);

    const supabase = getSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setVerdictSubmitting(false);
      pushToast("Not signed in — verdict not saved", "warn");
      return;
    }

    const reviewInsert = {
      lead_id:       lead.leadId,
      business_slug: lead.businessSlug,
      build_date:    lead.buildDate,
      verdict,
      reason:        null,
      operator_id:   user.id,
      is_test:       IS_TEST_PHASE,
    };
    const reviewRes = await supabase.from("site_reviews").insert(reviewInsert);
    if (reviewRes.error) {
      console.error("[review] site_reviews insert failed", reviewRes.error);
      pushToast(`Save failed: ${reviewRes.error.message}`, "warn");
      setVerdictSubmitting(false);
      return;
    }

    const leadUpdate = {
      approval_status: verdict,
      approval_at:     new Date().toISOString(),
      approved_by:     user.id,
    };
    const leadRes = await supabase
      .from("leads")
      .update(leadUpdate)
      .eq("id", lead.leadId);
    if (leadRes.error) {
      console.error("[review] leads update failed", leadRes.error);
      // Audit row already exists; surface the partial-write so the operator
      // can retry. Staying put (no navigation) lets a re-tap re-attempt — the
      // duplicate site_reviews row from a retry is acceptable.
      pushToast(
        `Verdict recorded but status update failed: ${leadRes.error.message}`,
        "warn",
      );
      setVerdictSubmitting(false);
      return;
    }

    pushToast(verdict === "approved" ? "Approved" : "Disapproved", "ok");
    // Back to the queue — the lead is now non-NULL approval_status and the
    // queue's `.is("approval_status", null)` filter will exclude it.
    router.push("/");
  }

  function handleApprove() {
    void writeVerdict("approved");
  }

  function handleDisapprove() {
    // Confirm guard — disapprove sends the lead to the rejects bucket
    // (Phase 3 outreach gate will require approval_status='approved', so
    // 'disapproved' is functionally a soft delete from a sales POV). Approve
    // is one-tap; disapprove needs the operator to mean it.
    if (
      !window.confirm(
        `Disapprove "${businessName ?? slug}"? This removes it from the review queue.`,
      )
    ) {
      return;
    }
    void writeVerdict("disapproved");
  }

  async function handleNoteSubmit(note: NoteSubmission) {
    if (!sheet.open) return;
    setSubmitting(true);
    const supabase = getSupabase();

    // operator_id is NOT NULL on both tables. Pull it from the auth session
    // — the operator is signed in (middleware enforces it before reaching
    // this page).
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSubmitting(false);
      pushToast("Not signed in — note not saved", "warn");
      return;
    }

    const componentName = sheet.componentName;
    const sectionIndex = sheet.sectionIndex;

    let error: { message: string } | null = null;
    let newNoteId: string | null = null;
    if (note.type === "design") {
      // design issue → section_notes (the learning corpus).
      // section_sentiment is NOT NULL with CHECK in ('positive','negative',
      // 'neutral'). We use 'negative' for every row — every captured note
      // is a constraint / "what not to do", per the 2c design.
      // note_action splits the design corpus by operator-chosen destiny
      // (migration 016): 'architect' (Memory, default) feeds the lessons
      // retriever in homepageArchitect; 'code_fix' (Component fix) marks
      // a note for the future template-change-proposal loop (Part C).
      // code_fix notes are captured here but no system acts on them yet.
      const insert = {
        lead_id:           lead.leadId,
        business_slug:     lead.businessSlug,
        build_date:        lead.buildDate,
        industry:          lead.industry,
        apify_category:    lead.apifyCategory,
        location:          lead.location,
        section_index:     sectionIndex,
        section_type:      deriveSectionType(componentName),
        component_name:    componentName,
        is_custom_section: isCustomSection(componentName),
        section_sentiment: "negative" as const,
        note_text:         note.text,
        tags:              note.tags,
        note_action:       note.action,
        operator_id:       user.id,
        is_test:           IS_TEST_PHASE,
        // site_review_id intentionally null — Approve/Disapprove writes
        // site_reviews in the next chip; until then notes float free of any
        // verdict.
      };
      const res = await supabase.from("section_notes").insert(insert).select("id").single();
      error = res.error;
      newNoteId = res.data?.id ?? null;
    } else {
      // defect → section_defects (pipeline-health signal; architect never reads).
      const insert = {
        lead_id:        lead.leadId,
        business_slug:  lead.businessSlug,
        build_date:     lead.buildDate,
        industry:       lead.industry,
        apify_category: lead.apifyCategory,
        location:       lead.location,
        section_index:  sectionIndex,
        component_name: componentName,
        note_text:      note.text,
        tags:           note.tags,
        operator_id:    user.id,
        is_test:        IS_TEST_PHASE,
      };
      const res = await supabase.from("section_defects").insert(insert);
      error = res.error;
    }

    setSubmitting(false);
    if (error) {
      console.error("[review] note save failed", error);
      pushToast(`Save failed: ${error.message}`, "warn");
      // Leave the sheet open — don't lose the operator's typed text.
      return;
    }

    setSheet({ open: false });

    // Producer: a code_fix design note must enqueue a proposal-request intent
    // so the builder's proposalWorker has something to poll. Orphan-handling
    // (design doc Part C): the note is already saved at this point — if the
    // intent insert fails, log + warn but keep the note rather than rolling back.
    if (note.type === "design" && note.action === "code_fix" && newNoteId) {
      const intentRes = await supabase.from("control_intents").insert({
        kind: PROPOSAL_REQUEST,
        payload: { note_id: newNoteId, component_name: componentName },
        requested_by: user.id,
      });
      if (intentRes.error) {
        console.error("[review] code_fix intent enqueue failed", intentRes.error);
        pushToast("Note saved — fix request didn't queue (logged)", "warn");
      } else {
        pushToast("Fix request queued", "ok");
      }
      return;
    }

    pushToast(note.type === "design" ? "Note saved" : "Defect saved", "ok");
  }

  function handleNoteCancel() {
    setSheet({ open: false });
  }

  // Build the iframe src directly from the lead's live_url — the per-deploy
  // Vercel host where the actual build lives. live_url ends with
  // "/client/<slug>" (no trailing slash in storage); the engine
  // `trailingSlash: true` would 308-redirect "/client/<slug>?review=1" to
  // "/client/<slug>/?review=1" — appending the slash here skips the redirect.
  // Defensive handling of pre-existing query strings even though live_url has
  // none today.
  const reviewQuery = liveUrl.includes("?") ? "&review=1" : "?review=1";
  const iframeSrc = liveUrl.endsWith("/")
    ? `${liveUrl}${reviewQuery}`
    : `${liveUrl}/${reviewQuery}`;

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <header className="flex items-center justify-between gap-4 border-b border-white/10 bg-black/80 px-4 py-2 text-sm backdrop-blur">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {businessName ?? "(unnamed)"}
          </p>
          <p className="truncate text-xs text-white/50">{slug}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/changes"
            className="rounded-md border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
          >
            Changes
          </Link>
          <Link
            href="/"
            className="rounded-md border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
          >
            ← Queue
          </Link>
        </div>
      </header>

      <div className="relative flex-1 overflow-hidden">
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          title={`Review: ${businessName ?? slug}`}
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />

        {sheet.open && (
          <NoteSheet
            open={sheet.open}
            sectionIndex={sheet.sectionIndex}
            componentName={sheet.componentName}
            submitting={submitting}
            onSubmit={handleNoteSubmit}
            onCancel={handleNoteCancel}
          />
        )}

        <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={
                "pointer-events-auto rounded-md px-3 py-2 text-xs font-medium shadow-lg backdrop-blur " +
                (t.kind === "ok"
                  ? "bg-emerald-600/90 text-white"
                  : t.kind === "warn"
                    ? "bg-rose-600/90 text-white"
                    : "bg-slate-900/90 text-white")
              }
            >
              {t.text}
            </div>
          ))}
        </div>
      </div>

      <footer className="flex flex-col gap-2 border-t border-white/10 bg-black/90 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleDisapprove}
            className="flex-1 rounded-md bg-rose-600 px-4 py-3 text-sm font-semibold text-white hover:bg-rose-500 active:bg-rose-700"
          >
            Disapprove
          </button>
          <button
            type="button"
            onClick={handleApprove}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-3 text-sm font-semibold text-white hover:bg-emerald-500 active:bg-emerald-700"
          >
            Approve
          </button>
        </div>
        <p className="truncate text-center text-xs text-white/50">
          {IS_TEST_PHASE ? (
            email ? (
              <>Test phase — redirected to your test inbox; live target:{" "}
                <span className="font-medium text-white/80">{email}</span>
              </>
            ) : (
              <>Test phase — redirected to your test inbox</>
            )
          ) : (
            <>Pitch will be sent to{" "}
              <span className="font-medium text-white/80">
                {email ?? "— no email on file —"}
              </span>
            </>
          )}
        </p>
      </footer>
    </div>
  );
}
