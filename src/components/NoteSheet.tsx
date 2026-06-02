"use client";

// Phase 2c review note bottom sheet. Opens when the operator long-presses
// a section in the iframe; collects:
//   - NOTE TYPE: "design" (→ section_notes corpus) or "defect" (→ section_defects)
//   - TAGS: layout / copy / color / spacing / image / other (multi-select)
//   - TEXT: free-text note
//
// No sentiment good/bad, no severity. Negative-only by design — every note
// captured is a "what not to do" constraint. The Save button is disabled
// until a type is chosen AND the text is non-empty.
//
// Mobile-first. Fixed to bottom of viewport, max-h-[70vh], own scroll. Dark
// to match the review chrome.

import { useState } from "react";

export type NoteType = "design" | "defect";
export type NoteTag = "layout" | "copy" | "color" | "spacing" | "image" | "other";
// Maps to section_notes.note_action (migration 016). UI labels Memory /
// Component fix; DB values architect / code_fix. Default 'architect' so the
// common path is zero extra taps. Only meaningful when type === "design" —
// defects don't have an architect-vs-code branching and write to a separate
// table.
export type NoteAction = "architect" | "code_fix";

const TAG_OPTIONS: NoteTag[] = ["layout", "copy", "color", "spacing", "image", "other"];

export type NoteSubmission = {
  type: NoteType;
  tags: NoteTag[];
  text: string;
  // Always populated; ReviewHost ignores it for type="defect" since
  // section_defects has no note_action column.
  action: NoteAction;
};

type Props = {
  open: boolean;
  sectionIndex: number;
  componentName: string;
  submitting: boolean;
  onSubmit: (note: NoteSubmission) => void;
  onCancel: () => void;
};

export default function NoteSheet({
  open,
  sectionIndex,
  componentName,
  submitting,
  onSubmit,
  onCancel,
}: Props) {
  const [type, setType] = useState<NoteType | null>(null);
  const [action, setAction] = useState<NoteAction>("architect");
  const [tags, setTags] = useState<Set<NoteTag>>(new Set());
  const [text, setText] = useState("");

  if (!open) return null;

  // Action defaults to 'architect' (Memory) and ALWAYS has a value, so it
  // never gates Save. Save-enable rule unchanged: type chosen AND text non-empty.
  const canSave = type !== null && text.trim().length > 0 && !submitting;

  function toggleTag(tag: NoteTag) {
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  // When the operator flips type design→defect→design, reset action to
  // 'architect' rather than preserving a stale code_fix selection — safer
  // default. handleCancel also resets via reset().
  function pickType(next: NoteType) {
    if (next !== type) setAction("architect");
    setType(next);
  }

  function reset() {
    setType(null);
    setAction("architect");
    setTags(new Set());
    setText("");
  }

  function handleSubmit() {
    if (!canSave || type === null) return;
    onSubmit({ type, tags: Array.from(tags), text: text.trim(), action });
    // The parent decides whether to close (on success) or keep open (on
    // failure). We optimistically clear local state on submit; if the
    // parent keeps us open (e.g. RLS reject), the text+selections are gone.
    // To keep them, parent should leave `open` true and we just stay
    // mounted — local state survives until unmount. So DO NOT reset here.
  }

  function handleCancel() {
    reset();
    onCancel();
  }

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-white/10 bg-black/95 text-white shadow-2xl backdrop-blur"
      style={{ maxHeight: "70vh" }}
      role="dialog"
      aria-label={`Note for section ${sectionIndex}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-white/50">
            Section {sectionIndex}
          </p>
          <p className="truncate text-sm font-medium">{componentName}</p>
        </div>
        <button
          type="button"
          onClick={handleCancel}
          className="shrink-0 rounded-md border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
        >
          Cancel
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* Type toggle — must pick one */}
        <div className="mb-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-white/50">
            Type
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => pickType("design")}
              className={
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors " +
                (type === "design"
                  ? "border-amber-400/60 bg-amber-500/20 text-amber-100"
                  : "border-white/20 bg-transparent text-white/80 hover:bg-white/10")
              }
            >
              Design issue
            </button>
            <button
              type="button"
              onClick={() => pickType("defect")}
              className={
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors " +
                (type === "defect"
                  ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
                  : "border-white/20 bg-transparent text-white/80 hover:bg-white/10")
              }
            >
              Defect
            </button>
          </div>
        </div>

        {/* Action sub-toggle — appears only under "Design issue". Defect
            writes to a separate table with no architect-vs-code branching,
            so the sub-toggle is hidden in that case. */}
        {type === "design" && (
          <div className="mb-4">
            <p className="mb-2 text-xs uppercase tracking-wider text-white/50">
              Action
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAction("architect")}
                className={
                  "rounded-md border px-3 py-2 text-sm font-medium transition-colors " +
                  (action === "architect"
                    ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
                    : "border-white/20 bg-transparent text-white/80 hover:bg-white/10")
                }
              >
                Memory
              </button>
              <button
                type="button"
                onClick={() => setAction("code_fix")}
                className={
                  "rounded-md border px-3 py-2 text-sm font-medium transition-colors " +
                  (action === "code_fix"
                    ? "border-fuchsia-400/60 bg-fuchsia-500/20 text-fuchsia-100"
                    : "border-white/20 bg-transparent text-white/80 hover:bg-white/10")
                }
              >
                Component fix
              </button>
            </div>
            {action === "code_fix" && (
              <p className="mt-2 text-xs text-white/50">
                Proposes a code change to the {componentName} template. Future
                builds only — existing sites untouched.
              </p>
            )}
          </div>
        )}

        {/* Tags — multi-select chips */}
        <div className="mb-4">
          <p className="mb-2 text-xs uppercase tracking-wider text-white/50">
            Tags
          </p>
          <div className="flex flex-wrap gap-2">
            {TAG_OPTIONS.map((tag) => {
              const active = tags.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className={
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                    (active
                      ? "border-sky-400/60 bg-sky-500/20 text-sky-100"
                      : "border-white/20 bg-transparent text-white/70 hover:bg-white/10")
                  }
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>

        {/* Free text */}
        <div className="mb-2">
          <label className="mb-2 block text-xs uppercase tracking-wider text-white/50">
            Note
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What's wrong with this section?"
            rows={4}
            className="w-full resize-none rounded-md border border-white/20 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
          />
        </div>
      </div>

      <div className="border-t border-white/10 px-4 py-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSave}
          className={
            "w-full rounded-md px-4 py-3 text-sm font-semibold transition-colors " +
            (canSave
              ? "bg-emerald-600 text-white hover:bg-emerald-500 active:bg-emerald-700"
              : "cursor-not-allowed bg-white/10 text-white/40")
          }
        >
          {submitting ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}
