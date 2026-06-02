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
  lead,
}: {
  slug: string;
  businessName: string | null;
  liveUrl: string;
  lead: LeadContext;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const [sheet, setSheet] = useState<SheetState>({ open: false });
  const [submitting, setSubmitting] = useState(false);
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

  function handleApprove() {
    // STUB — next chip wires this to site_reviews + leads.approval_status.
    // Do not add the Supabase write here.
    console.log("[review] approve", { slug });
    pushToast("Approved (stub)", "ok");
  }

  function handleDisapprove() {
    // STUB — next chip wires this to site_reviews + leads.approval_status.
    // Do not add the Supabase write here.
    console.log("[review] disapprove", { slug });
    pushToast("Disapproved (stub)", "warn");
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
    if (note.type === "design") {
      // design issue → section_notes (the learning corpus).
      // section_sentiment is NOT NULL with CHECK in ('positive','negative',
      // 'neutral'). We use 'negative' for every row — every captured note
      // is a constraint / "what not to do", per the 2c design.
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
        operator_id:       user.id,
        is_test:           IS_TEST_PHASE,
        // site_review_id intentionally null — Approve/Disapprove writes
        // site_reviews in the next chip; until then notes float free of any
        // verdict.
      };
      const res = await supabase.from("section_notes").insert(insert);
      error = res.error;
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
    pushToast(
      note.type === "design" ? "Note saved" : "Defect saved",
      "ok",
    );
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
        <Link
          href="/"
          className="shrink-0 rounded-md border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
        >
          ← Queue
        </Link>
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

      <footer className="flex items-center gap-3 border-t border-white/10 bg-black/90 px-4 py-3">
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
      </footer>
    </div>
  );
}
