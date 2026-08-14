"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

// Builder liveness strip — reads the controller_heartbeat singleton the
// builder upserts every 60s (builder src/heartbeat.js, migrations 013+052)
// and says at a glance whether approving a site will actually send anything.
// Exists because of the 2026-07-19 → 2026-08-13 outage: every approval was a
// fire-and-forget DB write while no sender ran anywhere, and no surface said
// so. The IDLE state below IS that outage rendered visible.
//
// Freshness column is last_heartbeat (the migration-013 name). The builder
// writes every 60s, so 3 minutes without a write means the process is gone
// (systemd restarts in seconds; a longer gap is a real outage).
//
// This strip must never break the queue below it: every fetch error is
// caught into state (UNKNOWN), polling continues, and render never touches
// row fields without a null guard.

const POLL_MS = 30_000; // re-fetch cadence
const TICK_MS = 10_000; // re-render cadence so "updated Xs ago" stays honest
const STALE_MS = 3 * 60 * 1000;

type HeartbeatRow = {
  last_heartbeat: string | null;
  commit_sha: string | null;
  flags: Record<string, string> | null;
  started_at: string | null;
};

type Status =
  | { kind: "unknown"; detail: string }
  | { kind: "dead"; lastSeen: string | null } // lastSeen null = no row ever
  | { kind: "idle"; row: HeartbeatRow; ageMs: number }
  | { kind: "live"; row: HeartbeatRow; ageMs: number };

// Pure so the state machine is testable without React or a network.
export function deriveStatus(
  row: HeartbeatRow | null,
  errorText: string | null,
  nowMs: number,
): Status {
  if (errorText) return { kind: "unknown", detail: errorText };
  const beatMs = row?.last_heartbeat ? Date.parse(row.last_heartbeat) : NaN;
  if (!row || !Number.isFinite(beatMs)) return { kind: "dead", lastSeen: null };
  const ageMs = nowMs - beatMs;
  if (ageMs > STALE_MS) return { kind: "dead", lastSeen: row.last_heartbeat };
  if (row.flags?.OUTREACH_RUNNER_ENABLED !== "true") return { kind: "idle", row, ageMs };
  return { kind: "live", row, ageMs };
}

function rel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export default function BuilderStatus() {
  const [row, setRow] = useState<HeartbeatRow | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);
  function getSupabase() {
    if (!supabaseRef.current) supabaseRef.current = createClient();
    return supabaseRef.current;
  }

  const fetchHeartbeat = useCallback(async () => {
    try {
      const { data, error } = await getSupabase()
        .from("controller_heartbeat")
        .select("last_heartbeat, commit_sha, flags, started_at")
        .eq("id", 1)
        .maybeSingle();
      if (error) {
        setErrorText(error.message);
      } else {
        setErrorText(null);
        setRow((data as HeartbeatRow) ?? null);
      }
    } catch (err) {
      // Never let a fetch failure escape — the queue below must render.
      setErrorText(err instanceof Error ? err.message : String(err));
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    fetchHeartbeat();
    const poll = setInterval(fetchHeartbeat, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [fetchHeartbeat]);

  const status = deriveStatus(row, errorText, now);

  // Per-state band tint + chip classes, following the repo's existing chip
  // language (TestBadge light tints: {color}-50 bg / {color}-200 border /
  // {color}-700 text; emerald=good, amber=degraded, red=bad, zinc=unknown).
  const band =
    status.kind === "live"
      ? "bg-white"
      : status.kind === "idle"
        ? "bg-amber-50"
        : status.kind === "dead"
          ? "bg-red-50"
          : "bg-white";
  const chip =
    status.kind === "live"
      ? "bg-emerald-50 border-emerald-200 text-emerald-700"
      : status.kind === "idle"
        ? "bg-amber-100 border-amber-300 text-amber-900"
        : status.kind === "dead"
          ? "bg-red-100 border-red-300 text-red-800"
          : "bg-zinc-50 border-zinc-200 text-zinc-600";
  const label =
    status.kind === "live"
      ? "● Builder live — outreach on"
      : status.kind === "idle"
        ? "● Builder alive — OUTREACH OFF"
        : status.kind === "dead"
          ? "● Builder OFFLINE"
          : "● Builder status unknown";

  const sha = row?.commit_sha ? row.commit_sha.slice(0, 7) : null;
  const uptime =
    row?.started_at && Number.isFinite(Date.parse(row.started_at))
      ? rel(now - Date.parse(row.started_at))
      : null;
  const flagEntries = row?.flags ? Object.entries(row.flags).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <div className={`border-b border-slate-200 ${band}`}>
      <div className="max-w-5xl mx-auto px-6 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${chip}`}>
            {label}
          </span>

          {(status.kind === "live" || status.kind === "idle") && (
            <span className="text-xs text-slate-500">
              updated {rel(status.ageMs)} ago
              {sha ? <> · <span className="font-mono">{sha}</span></> : null}
              {uptime ? <> · up {uptime}</> : null}
            </span>
          )}

          {status.kind === "dead" && (
            <span className="text-xs text-red-700">
              {status.lastSeen
                ? `last seen ${rel(now - Date.parse(status.lastSeen))} ago — approvals and paid-order delivery are NOT being processed`
                : "no heartbeat ever recorded — the builder has never reported in"}
            </span>
          )}

          {status.kind === "unknown" && (
            <span className="text-xs text-zinc-500">
              heartbeat read failed: {status.detail} — retrying every {POLL_MS / 1000}s
            </span>
          )}

          {flagEntries.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-slate-500 underline underline-offset-2 hover:text-slate-900"
            >
              {expanded ? "hide flags" : "flags"}
            </button>
          )}
        </div>

        {status.kind === "idle" && (
          <p className="mt-1 text-xs font-medium text-amber-900">
            Approving will NOT send any email — OUTREACH_RUNNER_ENABLED is{" "}
            {row?.flags?.OUTREACH_RUNNER_ENABLED === undefined
              ? "absent"
              : `"${row.flags.OUTREACH_RUNNER_ENABLED}"`}{" "}
            on the builder. Approvals will sit unsent until it is set to
            &quot;true&quot; and the service restarts.
          </p>
        )}

        {expanded && flagEntries.length > 0 && (
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {flagEntries.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2 font-mono text-xs">
                <dt className="truncate text-slate-600">{k}</dt>
                <dd
                  className={
                    v === "absent"
                      ? "italic text-zinc-400"
                      : v === "true"
                        ? "font-medium text-emerald-700"
                        : "text-slate-700"
                  }
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
