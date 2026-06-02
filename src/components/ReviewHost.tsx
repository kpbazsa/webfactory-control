"use client";

// Phase 2b-P review host. Iframes the live engine site with ?review=1,
// answers the engine's WF_REVIEW_HELLO with a nonce-bearing WF_REVIEW_ACK,
// and receives WF_SECTION_PRESS events. For 2b the press handler shows a
// transient toast — proof of transport. The note bottom sheet, tag input,
// and Supabase writes (section_notes / site_reviews / leads.approval_status)
// land in 2c.
//
// Origin discipline: every inbound message is rejected unless
// isAllowedEngineOrigin(event.origin) AND event.source ===
// iframeRef.current.contentWindow. The ACK is posted with targetOrigin =
// event.origin (the already-validated engine origin), never "*".

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isAllowedEngineOrigin } from "@/lib/reviewOrigins";

type Toast = { id: number; text: string; kind: "info" | "ok" | "warn" };

export default function ReviewHost({
  slug,
  businessName,
  liveUrl,
}: {
  slug: string;
  businessName: string | null;
  liveUrl: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

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
        pushToast(`Section ${idx} · ${comp}`, "info");
        return;
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pushToast]);

  function handleApprove() {
    // STUB — 2c wires this to site_reviews + leads.approval_status. Do not
    // add the Supabase write here.
    console.log("[review] approve", { slug });
    pushToast("Approved (stub)", "ok");
  }

  function handleDisapprove() {
    // STUB — 2c wires this to site_reviews + leads.approval_status. Do not
    // add the Supabase write here.
    console.log("[review] disapprove", { slug });
    pushToast("Disapproved (stub)", "warn");
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
