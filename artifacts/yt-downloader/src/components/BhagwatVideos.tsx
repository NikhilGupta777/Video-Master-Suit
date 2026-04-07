import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock, Unlock, Film, Loader2, CheckCircle2, AlertCircle,
  Download, Wand2, Bot, FileText, Wifi, Eye, EyeOff, Sparkles, ImageIcon,
  Pencil, X, Lightbulb, ChevronDown, ChevronUp, Clock, Check, Scissors,
  Upload, Music, Youtube, Headphones, Trash2, Square, Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { BestClips } from "@/components/BestClips";

// ── Types ─────────────────────────────────────────────────────────────────────
interface TimelineSegment {
  startSec: number; endSec: number;
  isBhajan: boolean; imageChangeEvery: number;
  description: string; imagePrompt: string;
}

interface Suggestion {
  segIdx: number;
  reason: string;
  improvedPrompt: string;
}

interface HistoryEntry {
  id: string;
  title: string;
  filename: string;
  downloadUrl: string;
  timestamp: number;
}

const HISTORY_KEY = "bhagwat_render_history";
const SESSION_KEY = "bhagwat_active_session";
const PENDING_RENDERS_KEY = "bhagwat_pending_renders";
const MAX_HISTORY = 20;
const STORAGE_KEY = "bhagwat_unlocked";

interface PendingRender {
  jobId: string;
  videoTitle: string;
  startedAt: number;
}

function formatSec(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function timeAgo(ts: number) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ── Password Gate ─────────────────────────────────────────────────────────────
function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const attempt = async () => {
    if (!pw) return;
    setLoading(true);
    setError("");
    const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
    try {
      const res = await fetch(`${BASE}/api/bhagwat/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        sessionStorage.setItem(STORAGE_KEY, "1");
        onUnlock();
      } else {
        setError("Incorrect password");
        setPw("");
      }
    } catch {
      setError("Could not connect — try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center justify-center py-20 px-4"
    >
      <div className="w-full max-w-sm glass-panel rounded-3xl p-8 flex flex-col items-center gap-6">
        <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center shadow-[0_0_30px_rgba(245,158,11,0.2)]">
          <Lock className="w-8 h-8 text-amber-400" />
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-display font-bold text-white">Bhagwat Videos</h2>
          <p className="text-white/50 text-sm mt-1">This section is password protected</p>
        </div>
        <div className="w-full space-y-3">
          <div className="relative">
            <input
              type={show ? "text" : "password"}
              value={pw}
              onChange={e => { setPw(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Enter" && attempt()}
              placeholder="Enter password…"
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-amber-500/50 pr-10"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShow(s => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60"
            >
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <Button onClick={attempt} disabled={loading || !pw} className="w-full bg-amber-600 hover:bg-amber-500 border-amber-500/30">
            {loading
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Checking…</>
              : <><Unlock className="w-4 h-4 mr-2" /> Unlock</>}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Editable Timeline Preview ──────────────────────────────────────────────────
function EditableTimelinePreview({
  timeline, suggestions, onEditPrompt, onAcceptSuggestion, onDismissSuggestion, videoDuration,
}: {
  timeline: TimelineSegment[];
  suggestions: Suggestion[];
  onEditPrompt: (idx: number, newPrompt: string) => void;
  onAcceptSuggestion: (s: Suggestion) => void;
  onDismissSuggestion: (segIdx: number) => void;
  videoDuration: number;
}) {
  const totalDur = timeline.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0);
  // barDur: the full video length when we have it, otherwise just the covered duration
  const barDur = videoDuration > 0 ? videoDuration : totalDur;
  // hasGaps: true when selected segments don't cover the whole video (Smart mode)
  const hasGaps = videoDuration > 0 && Math.abs(totalDur - videoDuration) > 2;
  const bhajans = timeline.filter(s => s.isBhajan).length;
  const kathas = timeline.length - bhajans;

  // Build an ordered list of bar items that includes gap elements between segments.
  // This gives the user an accurate picture of WHERE in the video images appear.
  type BarItem =
    | { kind: "seg"; pct: number; seg: TimelineSegment; idx: number }
    | { kind: "gap"; pct: number };
  const barItems: BarItem[] = [];
  {
    let cursor = 0;
    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      if (seg.startSec > cursor + 0.5 && barDur > 0) {
        barItems.push({ kind: "gap", pct: ((seg.startSec - cursor) / barDur) * 100 });
      }
      barItems.push({ kind: "seg", pct: ((seg.endSec - seg.startSec) / barDur) * 100, seg, idx: i });
      cursor = seg.endSec;
    }
    if (cursor < barDur - 0.5 && barDur > 0) {
      barItems.push({ kind: "gap", pct: ((barDur - cursor) / barDur) * 100 });
    }
  }
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [expandedSugIdx, setExpandedSugIdx] = useState<number | null>(null);

  const sugByIdx = Object.fromEntries(suggestions.map(s => [s.segIdx, s]));

  const startEdit = (idx: number, current: string) => {
    setEditingIdx(idx);
    setEditDraft(current);
    setExpandedSugIdx(null);
  };
  const saveEdit = (idx: number) => {
    if (editDraft.trim()) onEditPrompt(idx, editDraft.trim());
    setEditingIdx(null);
  };

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Film className="w-4 h-4 text-amber-400" />
          AI Editor Plan
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-amber-300/70 text-xs">{kathas} katha scenes</span>
          {bhajans > 0 && <span className="text-violet-300/70 text-xs">· {bhajans} bhajan sections</span>}
          <span className="text-white/30 text-xs">· {formatSec(totalDur)}</span>
        </div>
      </div>

      {/* Timeline bar — shows segments positioned relative to the full video, with gaps */}
      <div className="flex h-4 rounded-lg overflow-hidden">
        {barItems.map((item, i) =>
          item.kind === "gap" ? (
            <div
              key={`gap-${i}`}
              style={{ width: `${item.pct}%` }}
              className="h-full bg-white/8 shrink-0"
              title="No image in this section"
            />
          ) : (
            <div
              key={`seg-${item.idx}`}
              style={{ width: `${item.pct}%` }}
              className={cn(
                "h-full min-w-[2px] shrink-0",
                item.seg.isBhajan ? "bg-violet-500/70" : "bg-amber-500/50",
                sugByIdx[item.idx] ? "ring-1 ring-yellow-400/60" : "",
              )}
              title={`${formatSec(item.seg.startSec)} – ${formatSec(item.seg.endSec)} · ${item.seg.description}`}
            />
          )
        )}
      </div>

      {/* Segment list */}
      <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
        {timeline.map((seg, i) => {
          const hasSuggestion = !!sugByIdx[i];
          const suggestion = sugByIdx[i];
          const isExpanded = expandedSugIdx === i;
          const isEditing = editingIdx === i;

          return (
            <div key={i} className={cn(
              "rounded-xl border p-2.5 space-y-1.5 transition-all",
              seg.isBhajan ? "border-violet-500/20 bg-violet-500/5" : "border-white/8 bg-white/3",
              hasSuggestion && "ring-1 ring-yellow-500/25",
            )}>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white/30 tabular-nums text-xs shrink-0">
                  {formatSec(seg.startSec)} – {formatSec(seg.endSec)}
                </span>
                {seg.isBhajan
                  ? <Badge className="text-xs border border-violet-500/40 bg-violet-500/10 text-violet-300">♪ Bhajan</Badge>
                  : <Badge className="text-xs border border-amber-500/30 bg-amber-500/8 text-amber-300/80">Katha</Badge>
                }
                {hasSuggestion && (
                  <button
                    onClick={() => setExpandedSugIdx(isExpanded ? null : i)}
                    className="ml-auto flex items-center gap-1 text-yellow-400 text-xs hover:text-yellow-300 transition-colors"
                  >
                    <Lightbulb className="w-3 h-3" />
                    suggestion
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                )}
              </div>

              <p className="text-white/70 text-xs font-medium leading-snug">{seg.description}</p>

              {/* Image prompt — editable */}
              {isEditing ? (
                <div className="space-y-1.5">
                  <textarea
                    value={editDraft}
                    onChange={e => setEditDraft(e.target.value)}
                    rows={3}
                    className="w-full bg-white/8 border border-amber-500/40 rounded-lg px-3 py-2 text-xs text-white/80 outline-none focus:border-amber-400/60 resize-none"
                    autoFocus
                  />
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => saveEdit(i)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 bg-amber-600/80 hover:bg-amber-500/80 text-white rounded-lg transition-colors"
                    >
                      <Check className="w-3 h-3" /> Save
                    </button>
                    <button
                      onClick={() => setEditingIdx(null)}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 bg-white/10 hover:bg-white/15 text-white/60 rounded-lg transition-colors"
                    >
                      <X className="w-3 h-3" /> Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="group flex items-start gap-1.5">
                  <p className="text-white/35 text-xs leading-snug italic flex-1">{seg.imagePrompt}</p>
                  <button
                    onClick={() => startEdit(i, seg.imagePrompt)}
                    className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-white/30 hover:text-amber-400 p-0.5 mt-0.5"
                    title="Edit prompt"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* Suggestion panel */}
              <AnimatePresence>
                {isExpanded && suggestion && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="mt-1 rounded-lg border border-yellow-500/25 bg-yellow-500/5 p-2.5 space-y-2">
                      <p className="text-yellow-300/70 text-xs">{suggestion.reason}</p>
                      <p className="text-white/60 text-xs italic leading-snug">{suggestion.improvedPrompt}</p>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => { onAcceptSuggestion(suggestion); setExpandedSugIdx(null); }}
                          className="flex items-center gap-1 text-xs px-2.5 py-1 bg-yellow-600/70 hover:bg-yellow-500/70 text-white rounded-lg transition-colors"
                        >
                          <Check className="w-3 h-3" /> Accept
                        </button>
                        <button
                          onClick={() => { onDismissSuggestion(suggestion.segIdx); setExpandedSugIdx(null); }}
                          className="flex items-center gap-1 text-xs px-2.5 py-1 bg-white/8 hover:bg-white/12 text-white/50 rounded-lg transition-colors"
                        >
                          <X className="w-3 h-3" /> Dismiss
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── History Download Row — checks if file is still alive before downloading ────
function HistoryDownloadRow({ entry }: { entry: HistoryEntry }) {
  const [expired, setExpired] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleDownload = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (expired) return;
    setChecking(true);
    try {
      const res = await fetch(entry.downloadUrl, { method: "HEAD" });
      if (!res.ok) { setExpired(true); setChecking(false); return; }
    } catch { setExpired(true); setChecking(false); return; }
    setChecking(false);
    // File exists — trigger download via programmatic click
    const a = document.createElement("a");
    a.href = entry.downloadUrl;
    a.download = entry.filename;
    a.click();
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/3 px-2.5 py-2">
      <Film className="w-3.5 h-3.5 text-amber-400/60 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white/70 truncate">{entry.title || entry.filename}</p>
        <p className="text-xs text-white/30">{timeAgo(entry.timestamp)}</p>
      </div>
      {expired ? (
        <span className="shrink-0 text-[10px] text-red-400/70 px-2">Expired</span>
      ) : (
        <a
          href={entry.downloadUrl}
          download={entry.filename}
          onClick={handleDownload}
          className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 bg-green-600/40 hover:bg-green-500/50 text-white/80 rounded-lg transition-colors"
        >
          {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        </a>
      )}
    </div>
  );
}

// ── Render History ─────────────────────────────────────────────────────────────
function RenderHistory({
  history,
  onClear,
  pendingRenders,
  currentRenderJobId,
}: {
  history: HistoryEntry[];
  onClear: () => void;
  pendingRenders: PendingRender[];
  currentRenderJobId: string | null;
}) {
  const [open, setOpen] = useState(false);

  // Background renders — exclude the one currently shown in main UI
  const backgroundPending = pendingRenders.filter(r => r.jobId !== currentRenderJobId);
  const total = history.length + backgroundPending.length;

  // Auto-open when background renders surface (user came back to check)
  useEffect(() => {
    if (backgroundPending.length > 0) setOpen(true);
  }, [backgroundPending.length]);

  if (total === 0) return null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-3 hover:bg-white/3 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm text-white/55 font-medium">
          <Clock className="w-4 h-4 text-white/25" />
          Recent renders ({total})
          {backgroundPending.length > 0 && (
            <span className="flex items-center gap-1 text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/25 px-1.5 py-0.5 rounded-full">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {backgroundPending.length} in&nbsp;progress
            </span>
          )}
        </span>
        {open ? <ChevronUp className="w-4 h-4 text-white/25" /> : <ChevronDown className="w-4 h-4 text-white/25" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 space-y-1.5 border-t border-white/8 pt-2.5">
              <p className="text-[10px] text-white/20 pt-1 pb-0.5">Downloads expire when the server restarts. Re-render if a link no longer works.</p>

              {/* Background renders in progress */}
              {backgroundPending.map(r => (
                <div key={r.jobId} className="flex items-center gap-2 rounded-lg bg-amber-500/5 border border-amber-500/20 px-2.5 py-2">
                  <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/70 truncate">{r.videoTitle || "Rendering…"}</p>
                    <p className="text-xs text-white/30">Started {timeAgo(r.startedAt)} · Running in background</p>
                  </div>
                </div>
              ))}

              {/* Completed entries */}
              {history.map(entry => (
                <HistoryDownloadRow key={entry.id} entry={entry} />
              ))}

              <button
                onClick={onClear}
                className="w-full text-xs text-white/20 hover:text-white/40 py-1 transition-colors"
              >
                Clear history
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Audio Upload Zone ──────────────────────────────────────────────────────────
function AudioUploadZone({
  uploadedFile,
  uploading,
  uploadError,
  onFileSelected,
  onRemove,
}: {
  uploadedFile: { audioId: string; filename: string; sizeBytes: number } | null;
  uploading: boolean;
  uploadError: string;
  onFileSelected: (file: File) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileSelected(file);
  };

  const formatBytes = (b: number) => {
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };

  if (uploadedFile) {
    return (
      <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
        <Music className="w-4 h-4 text-green-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-white/80 font-medium truncate">{uploadedFile.filename}</p>
          <p className="text-xs text-white/30">{formatBytes(uploadedFile.sizeBytes)} · Ready</p>
        </div>
        <button
          onClick={onRemove}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-red-400 transition-colors"
          title="Remove file"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all",
          dragging
            ? "border-amber-500/70 bg-amber-500/10"
            : "border-white/15 bg-white/3 hover:border-white/30 hover:bg-white/5",
          uploading && "pointer-events-none opacity-60",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,video/mp4,video/webm,.mp3,.wav,.m4a,.ogg,.flac,.aac,.opus,.wma,.amr"
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) onFileSelected(f); }}
        />
        {uploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
            <p className="text-sm text-white/60">Uploading…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="w-8 h-8 text-white/30" />
            <p className="text-sm text-white/60 font-medium">Drop audio file here or click to browse</p>
            <p className="text-xs text-white/30">MP3, WAV, M4A, MP4, OGG, FLAC, AAC, OPUS, WMA · up to 5 GB</p>
          </div>
        )}
      </div>
      {uploadError && <p className="text-red-400 text-xs mt-2 text-center">{uploadError}</p>}
    </div>
  );
}

// ── Main Bhagwat Editor ───────────────────────────────────────────────────────
function BhagwatEditor({
  BASE, url, setUrl,
  clipRange, onClearClip,
}: {
  BASE: string;
  url: string;
  setUrl: (v: string) => void;
  clipRange?: { startSec: number; endSec: number; title: string };
  onClearClip?: () => void;
}) {
  const [sourceMode, setSourceMode] = useState<"youtube" | "upload">("youtube");
  const [uploadedFile, setUploadedFile] = useState<{ audioId: string; filename: string; sizeBytes: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const [mode, setMode] = useState<"full" | "smart">("full");
  const [autonomousMode, setAutonomousMode] = useState(true);
  const [timeline, setTimeline] = useState<TimelineSegment[] | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);

  const [phase, setPhase] = useState<"idle" | "analyzing" | "analyzed" | "rendering" | "done" | "error">("idle");
  const [steps, setSteps] = useState<Record<string, { status: string; message: string }>>({});
  const [renderPercent, setRenderPercent] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState("bhagwat_video.mp4");
  const [downloadAlive, setDownloadAlive] = useState<boolean | null>(null); // null=checking, true=alive, false=expired
  const [errorMsg, setErrorMsg] = useState("");
  const { toast } = useToast();
  const esRef = useRef<EventSource | null>(null);
  const [sseReconnecting, setSseReconnecting] = useState(false);

  const [analyzeJobId, setAnalyzeJobId] = useState<string | null>(null);
  const [renderJobId, setRenderJobId] = useState<string | null>(null);

  const [transcriptText, setTranscriptText] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reviewText, setReviewText] = useState("");
  const [autoImprovedCount, setAutoImprovedCount] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const hasAutoReviewedRef = useRef(false);
  const reviewScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionHydratedRef = useRef(false);
  // Always tracks the latest timeline so SSE handlers don't use stale closures
  const timelineRef = useRef<TimelineSegment[] | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
  });

  const saveHistory = useCallback((entries: HistoryEntry[]) => {
    setHistory(entries);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  }, []);

  // ── Pending (background) renders ───────────────────────────────────────────
  const [pendingRenders, setPendingRenders] = useState<PendingRender[]>(() => {
    try { return JSON.parse(localStorage.getItem(PENDING_RENDERS_KEY) ?? "[]"); } catch { return []; }
  });

  const savePendingRenders = useCallback((renders: PendingRender[]) => {
    setPendingRenders(renders);
    localStorage.setItem(PENDING_RENDERS_KEY, JSON.stringify(renders));
  }, []);

  const addPendingRender = useCallback((jobId: string, title: string) => {
    setPendingRenders(prev => {
      const updated = [{ jobId, videoTitle: title, startedAt: Date.now() }, ...prev.filter(r => r.jobId !== jobId)].slice(0, 10);
      localStorage.setItem(PENDING_RENDERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const removePendingRender = useCallback((jobId: string) => {
    setPendingRenders(prev => {
      const updated = prev.filter(r => r.jobId !== jobId);
      localStorage.setItem(PENDING_RENDERS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  // On mount and periodically: check background renders for completion
  const checkPendingRenders = useCallback(async () => {
    const stored: PendingRender[] = (() => {
      try { return JSON.parse(localStorage.getItem(PENDING_RENDERS_KEY) ?? "[]"); } catch { return []; }
    })();
    if (stored.length === 0) return;

    const toKeep: PendingRender[] = [];
    for (const r of stored) {
      // Stale guard: if older than 4 hours, server has definitely cleaned it up
      if (Date.now() - r.startedAt > 4 * 60 * 60 * 1000) continue;
      try {
        const res = await fetch(`${BASE}/api/bhagwat/render-state/${r.jobId}`, { cache: "no-store" });
        if (!res.ok) { toKeep.push(r); continue; }
        const payload = await res.json();
        if (payload.status === "done" && payload.downloadUrl) {
          const absoluteUrl = payload.downloadUrl.startsWith("http")
            ? payload.downloadUrl : `${BASE}${payload.downloadUrl}`;
          const filename = payload.filename ?? "bhagwat_video.mp4";
          setHistory(prev => {
            const entry: HistoryEntry = {
              id: r.jobId,
              title: r.videoTitle || filename,
              filename,
              downloadUrl: absoluteUrl,
              timestamp: r.startedAt,
            };
            const deduped = prev.filter(e => e.id !== r.jobId && e.downloadUrl !== absoluteUrl);
            const updated = [entry, ...deduped].slice(0, MAX_HISTORY);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
            return updated;
          });
          // Resolved — do NOT push to toKeep
        } else if (payload.status === "error" || payload.status === "expired") {
          // Failed — silently dismiss
        } else {
          toKeep.push(r); // Still running
        }
      } catch {
        toKeep.push(r); // Network error — keep for next check
      }
    }
    savePendingRenders(toKeep);
  }, [BASE, savePendingRenders]);

  // Mount: resolve any pending renders from previous sessions
  useEffect(() => { void checkPendingRenders(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 30s while there are background renders not yet shown in main UI
  useEffect(() => {
    const backgroundCount = pendingRenders.filter(r => r.jobId !== renderJobId).length;
    if (backgroundCount === 0) return;
    const timer = setInterval(() => void checkPendingRenders(), 30_000);
    return () => clearInterval(timer);
  }, [pendingRenders.length, renderJobId, checkPendingRenders]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStep = (name: string, status: string, message: string) =>
    setSteps(p => ({ ...p, [name]: { status, message } }));

  // Keep timelineRef in sync so SSE handlers never read a stale closure
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);

  // Cleanup: close any open EventSource when the component unmounts
  useEffect(() => { return () => { esRef.current?.close(); }; }, []);

  const persistDoneState = useCallback((nextDownloadUrl: string, nextDownloadFilename: string, nextVideoTitle?: string) => {
    const session = {
      phase: "done",
      mode,
      url,
      sourceMode,
      savedAt: Date.now(),
      downloadUrl: nextDownloadUrl,
      downloadFilename: nextDownloadFilename,
      videoTitle: nextVideoTitle ?? videoTitle,
      ...(timeline && { timeline }),
      ...(videoDuration ? { videoDuration } : {}),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));

    // Reuse the jobId from the download URL so history entries cross-reference the actual render job
    const jobId = nextDownloadUrl.split("/").pop() ?? crypto.randomUUID();
    const entry: HistoryEntry = {
      id: jobId,
      title: (nextVideoTitle ?? videoTitle) || nextDownloadFilename,
      filename: nextDownloadFilename,
      downloadUrl: nextDownloadUrl,
      timestamp: Date.now(),
    };
    setHistory(prev => {
      const deduped = prev.filter(existing => existing.downloadUrl !== nextDownloadUrl);
      const updated = [entry, ...deduped].slice(0, MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      return updated;
    });
  }, [mode, sourceMode, timeline, url, videoDuration, videoTitle]);

  const tryResolveRenderJob = useCallback(async (jobId: string, nextVideoTitle?: string) => {
    try {
      const res = await fetch(`${BASE}/api/bhagwat/render-state/${jobId}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        return false;
      }
      const payload = await res.json();

      if (typeof payload.percent === "number") {
        setRenderPercent(payload.percent);
      }
      if (typeof payload.message === "string" && payload.message) {
        setRenderMessage(payload.message);
      }

      if (payload.status === "done" && payload.downloadUrl) {
        const absoluteDownloadUrl = `${BASE}${payload.downloadUrl}`;
        const filename = payload.filename ?? "bhagwat_video.mp4";
        setDownloadUrl(absoluteDownloadUrl);
        setDownloadFilename(filename);
        removePendingRender(jobId);
        persistDoneState(absoluteDownloadUrl, filename, nextVideoTitle);
        setSseReconnecting(false);
        setPhase("done");
        return true;
      }

      if (payload.status === "error" || payload.status === "expired") {
        removePendingRender(jobId);
        setSseReconnecting(false);
        setErrorMsg(payload.message ?? (payload.status === "expired" ? "Rendered file expired" : "Render failed"));
        setPhase("error");
        return true;
      }
    } catch {
      // Ignore transient probe failures and let the caller continue reconnect logic.
    }

    return false;
  }, [persistDoneState, removePendingRender]);

  useEffect(() => {
    let cancelled = false;
    const hydrateHistory = async () => {
      try {
        const res = await fetch(`${BASE}/api/bhagwat/render-history`, { cache: "no-store" });
        if (!res.ok) return;
        const payload = await res.json();
        if (cancelled || !Array.isArray(payload.entries)) return;
        setHistory(prev => {
          const merged = [...prev];
          for (const entry of payload.entries) {
            if (!entry || typeof entry.downloadUrl !== "string") continue;
            if (merged.some(existing => existing.downloadUrl === `${BASE}${entry.downloadUrl}` || existing.downloadUrl === entry.downloadUrl)) {
              continue;
            }
            merged.push({
              id: entry.id ?? crypto.randomUUID(),
              title: entry.title ?? entry.filename ?? "bhagwat_video.mp4",
              filename: entry.filename ?? "bhagwat_video.mp4",
              downloadUrl: entry.downloadUrl.startsWith("http") ? entry.downloadUrl : `${BASE}${entry.downloadUrl}`,
              timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
            });
          }
          const sorted = merged.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_HISTORY);
          localStorage.setItem(HISTORY_KEY, JSON.stringify(sorted));
          return sorted;
        });
      } catch {}
    };
    void hydrateHistory();
    return () => { cancelled = true; };
  }, []);

  // When we restore a "done" session, probe the server to confirm the file is still alive.
  // Also triggered on fresh renders: downloadAlive is set to true immediately by the SSE handler.
  useEffect(() => {
    if (phase !== "done" || !downloadUrl || downloadAlive !== null) return;
    let cancelled = false;
    const checkAlive = async () => {
      try {
        const res = await fetch(downloadUrl, { method: "HEAD", cache: "no-store" });
        if (!cancelled) setDownloadAlive(res.ok);
      } catch {
        if (!cancelled) setDownloadAlive(false);
      }
    };
    void checkAlive();
    return () => { cancelled = true; };
  }, [phase, downloadUrl, downloadAlive]);

  useEffect(() => {
    if (phase !== "rendering" || !renderJobId) return;

    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const resolved = await tryResolveRenderJob(renderJobId, videoTitle);
      if (!stopped && resolved) {
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
      }
    };

    const timer = window.setInterval(() => {
      void tick();
    }, 3000);

    void tick();

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase, renderJobId, tryResolveRenderJob, videoTitle]);

  // ── Session persistence: save active job to localStorage so refresh reconnects ─
  useEffect(() => {
    if (!sessionHydratedRef.current) return;
    if (phase === "idle" || phase === "error") {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    const session = {
      phase,
      mode,
      url,
      sourceMode,
      savedAt: Date.now(),
      ...(sourceMode === "upload" && uploadedFile && { uploadedFile }),
      ...(phase === "analyzing" && analyzeJobId && { analyzeJobId }),
      ...(phase === "analyzed" && { timeline, videoTitle, videoDuration, transcriptText }),
      ...(phase === "rendering" && {
        renderJobId,
        renderPercent,
        renderMessage,
        timeline,
        videoTitle,
        videoDuration,
      }),
      ...(phase === "done" && downloadUrl && downloadFilename && {
        downloadUrl,
        downloadFilename,
        timeline,
        videoTitle,
        videoDuration,
      }),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }, [phase, mode, url, sourceMode, uploadedFile, analyzeJobId, renderJobId, timeline, videoTitle, videoDuration, transcriptText, renderPercent, renderMessage, downloadUrl, downloadFilename]);

  // ── On mount: restore session and reconnect to running jobs ───────────────────
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const session = JSON.parse(raw);
      // Don't restore sessions older than 90 minutes
      if (Date.now() - session.savedAt > 90 * 60 * 1000) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }

      if (session.sourceMode === "upload") {
        setSourceMode("upload");
        if (session.uploadedFile?.audioId && session.uploadedFile?.filename) {
          setUploadedFile(session.uploadedFile);
        }
      }

      if (session.phase === "done" && session.downloadUrl && session.downloadFilename) {
        setMode(session.mode ?? "full");
        if (session.url) setUrl(session.url);
        setSourceMode(session.sourceMode ?? "youtube");
        if (Array.isArray(session.timeline)) {
          setTimeline(session.timeline);
        }
        setVideoTitle(session.videoTitle ?? "");
        setVideoDuration(session.videoDuration ?? 0);
        setDownloadUrl(session.downloadUrl);
        setDownloadFilename(session.downloadFilename);
        setPhase("done");
        return;
      }

      if (session.phase === "analyzed" && Array.isArray(session.timeline)) {
        setMode(session.mode ?? "full");
        if (session.url) setUrl(session.url);
        setSourceMode(session.sourceMode ?? "youtube");
        if (session.sourceMode === "upload" && session.uploadedFile?.audioId && session.uploadedFile?.filename) {
          setUploadedFile(session.uploadedFile);
        }
        setTimeline(session.timeline);
        setVideoTitle(session.videoTitle ?? "");
        setVideoDuration(session.videoDuration ?? 0);
        setTranscriptText(session.transcriptText ?? "");
        hasAutoReviewedRef.current = true; // don't auto-trigger review again
        setPhase("analyzed");
        return;
      }

      if (session.phase === "analyzing" && session.analyzeJobId) {
        setMode(session.mode ?? "full");
        if (session.url) setUrl(session.url);
        setSourceMode(session.sourceMode ?? "youtube");
        if (session.sourceMode === "upload" && session.uploadedFile?.audioId && session.uploadedFile?.filename) {
          setUploadedFile(session.uploadedFile);
        }
        setPhase("analyzing");
        setSteps({ metadata: { status: "idle", message: "" }, transcript: { status: "idle", message: "" }, ai: { status: "idle", message: "" } });
        setAnalyzeJobId(session.analyzeJobId);
        const es = new EventSource(`${BASE}/api/bhagwat/analyze-status/${session.analyzeJobId}`);
        esRef.current = es;
        es.addEventListener("step", e => { setSseReconnecting(false); const d = JSON.parse(e.data); setStep(d.step, d.status, d.message); });
        es.addEventListener("done", e => {
          setSseReconnecting(false);
          const d = JSON.parse(e.data);
          setTimeline(d.timeline); setVideoTitle(d.videoTitle ?? ""); setVideoDuration(d.videoDuration ?? 0); setTranscriptText(d.transcriptText ?? "");
          setPhase("analyzed"); es.close();
        });
        es.addEventListener("jobError", e => {
          setSseReconnecting(false);
          const d = JSON.parse((e as MessageEvent).data);
          setErrorMsg(d.message ?? "Analysis failed"); setPhase("error"); es.close();
        });
        es.onerror = () => {
          if (es.readyState === EventSource.CONNECTING) {
            setSseReconnecting(true);
            return;
          }
          localStorage.removeItem(SESSION_KEY); setPhase("idle");
        };
        return;
      }

      if (session.phase === "rendering" && session.renderJobId) {
        setMode(session.mode ?? "full");
        if (session.url) setUrl(session.url);
        setSourceMode(session.sourceMode ?? "youtube");
        if (session.sourceMode === "upload" && session.uploadedFile?.audioId && session.uploadedFile?.filename) {
          setUploadedFile(session.uploadedFile);
        }
        if (Array.isArray(session.timeline)) {
          setTimeline(session.timeline); setVideoTitle(session.videoTitle ?? ""); setVideoDuration(session.videoDuration ?? 0);
        }
        setRenderJobId(session.renderJobId);
        setRenderPercent(session.renderPercent ?? 0);
        setRenderMessage("Reconnecting to render job…");
        setPhase("rendering");
        void tryResolveRenderJob(session.renderJobId, session.videoTitle ?? "");
        const es = new EventSource(`${BASE}/api/bhagwat/render-status/${session.renderJobId}`);
        esRef.current = es;
        es.addEventListener("progress", e => { setSseReconnecting(false); const d = JSON.parse(e.data); setRenderPercent(d.percent ?? 0); setRenderMessage(d.message ?? ""); });
        es.addEventListener("done", e => {
          setSseReconnecting(false);
          const d = JSON.parse(e.data);
          const absoluteDownloadUrl = `${BASE}${d.downloadUrl}`;
          const filename = d.filename ?? "bhagwat_video.mp4";
          setDownloadUrl(absoluteDownloadUrl); setDownloadFilename(filename);
          setDownloadAlive(true); // file was just created — no HEAD probe needed
          removePendingRender(session.renderJobId);
          persistDoneState(absoluteDownloadUrl, filename, session.videoTitle ?? "");
          setPhase("done"); es.close();
        });
        es.addEventListener("jobError", e => {
          setSseReconnecting(false);
          const d = JSON.parse((e as MessageEvent).data);
          removePendingRender(session.renderJobId);
          setErrorMsg(d.message ?? "Render failed"); setPhase("error"); es.close();
        });
        es.onerror = async () => {
          if (es.readyState === EventSource.CONNECTING) {
            setSseReconnecting(true);
            if (await tryResolveRenderJob(session.renderJobId, session.videoTitle ?? "")) {
              es.close();
            }
            return;
          }
          if (await tryResolveRenderJob(session.renderJobId, session.videoTitle ?? "")) {
            es.close();
            return;
          }
          localStorage.removeItem(SESSION_KEY);
          setPhase("idle");
        };
      }
    } catch { localStorage.removeItem(SESSION_KEY); }
    finally { sessionHydratedRef.current = true; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFileSelected = async (file: File) => {
    setUploading(true);
    setUploadError("");
    // Delete previous upload if any
    if (uploadedFile) {
      fetch(`${BASE}/api/bhagwat/audio/${uploadedFile.audioId}`, { method: "DELETE" }).catch(() => {});
      setUploadedFile(null);
    }
    // Reset editor state
    setPhase("idle");
    setTimeline(null);
    setDownloadUrl(null);
    setErrorMsg("");
    setSuggestions([]);
    setReviewText("");
    setAutoImprovedCount(null);
    setReviewing(false);
    hasAutoReviewedRef.current = false;

    try {
      const formData = new FormData();
      formData.append("audio", file);
      const res = await fetch(`${BASE}/api/bhagwat/upload-audio`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error ?? "Upload failed");
      }
      const data = await res.json();
      setUploadedFile({ audioId: data.audioId, filename: data.filename ?? file.name, sizeBytes: data.sizeBytes ?? file.size });
    } catch (err: any) {
      setUploadError(err.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveFile = () => {
    if (uploadedFile) {
      fetch(`${BASE}/api/bhagwat/audio/${uploadedFile.audioId}`, { method: "DELETE" }).catch(() => {});
    }
    setUploadedFile(null);
    setUploadError("");
    setPhase("idle");
    setTimeline(null);
    setDownloadUrl(null);
    setErrorMsg("");
    setSuggestions([]);
    setReviewText("");
    setAutoImprovedCount(null);
    setReviewing(false);
    hasAutoReviewedRef.current = false;
  };

  const handleSwitchSource = (next: "youtube" | "upload") => {
    if (next === sourceMode) return;
    // Clean up uploaded file when switching back to YouTube
    if (next === "youtube" && uploadedFile) {
      fetch(`${BASE}/api/bhagwat/audio/${uploadedFile.audioId}`, { method: "DELETE" }).catch(() => {});
      setUploadedFile(null);
    }
    setSourceMode(next);
    setPhase("idle");
    setTimeline(null);
    setDownloadUrl(null);
    setErrorMsg("");
    setSuggestions([]);
    setReviewText("");
    setAutoImprovedCount(null);
    setReviewing(false);
    hasAutoReviewedRef.current = false;
  };

  // In autonomous mode: auto-trigger review as soon as analysis completes.
  // In manual mode: skip auto-review so user can inspect the timeline first.
  useEffect(() => {
    if (autonomousMode && phase === "analyzed" && timeline && !hasAutoReviewedRef.current) {
      hasAutoReviewedRef.current = true;
      handleReview();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, timeline, autonomousMode]);

  const handleAnalyze = async () => {
    if (sourceMode === "youtube") {
      if (!url.trim()) { toast({ title: "Paste a YouTube URL first", variant: "destructive" }); return; }
    } else {
      if (!uploadedFile) { toast({ title: "Upload an audio file first", variant: "destructive" }); return; }
    }
    esRef.current?.close();
    setPhase("analyzing");
    setTimeline(null);
    setDownloadUrl(null);
    setErrorMsg("");
    setSuggestions([]);
    setReviewText("");
    setAutoImprovedCount(null);
    setReviewing(false);
    hasAutoReviewedRef.current = false;
    setSteps({
      metadata:   { status: "idle", message: "" },
      transcript: { status: "idle", message: "" },
      ai:         { status: "idle", message: "" },
    });

    try {
      let jobId: string;
      if (sourceMode === "youtube") {
        const res = await fetch(`${BASE}/api/bhagwat/analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, mode, ...(clipRange && { clipStartSec: clipRange.startSec, clipEndSec: clipRange.endSec }) }),
        });
        const data = await res.json();
        jobId = data.jobId;
      } else {
        const res = await fetch(`${BASE}/api/bhagwat/analyze-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioId: uploadedFile!.audioId, mode }),
        });
        const data = await res.json();
        jobId = data.jobId;
      }
      setAnalyzeJobId(jobId);

      const es = new EventSource(`${BASE}/api/bhagwat/analyze-status/${jobId}`);
      esRef.current = es;

      es.addEventListener("step", e => {
        setSseReconnecting(false);
        const d = JSON.parse(e.data);
        setStep(d.step, d.status, d.message);
      });
      es.addEventListener("done", e => {
        setSseReconnecting(false);
        const d = JSON.parse(e.data);
        setTimeline(d.timeline);
        setVideoTitle(d.videoTitle ?? "");
        setVideoDuration(d.videoDuration ?? 0);
        setTranscriptText(d.transcriptText ?? "");
        setPhase("analyzed");
        es.close();
      });
      es.addEventListener("jobError", e => {
        setSseReconnecting(false);
        const d = JSON.parse((e as MessageEvent).data);
        setErrorMsg(d.message ?? "Analysis failed");
        setPhase("error");
        es.close();
      });
      es.onerror = () => {
        if (es.readyState === EventSource.CONNECTING) { setSseReconnecting(true); return; }
        setSseReconnecting(false);
        setErrorMsg("Connection error during analysis — please try again");
        setPhase("error"); es.close();
      };
    } catch (err: any) {
      setErrorMsg(err.message ?? "Failed to start analysis");
      setPhase("error");
    }
  };

  const handleReview = async () => {
    if (!timeline) return;
    setReviewing(true);
    setReviewText("");
    setSuggestions([]);

    try {
      const res = await fetch(`${BASE}/api/bhagwat/review-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline, videoTitle, videoDuration, transcriptText }),
      });
      const { jobId } = await res.json();
      const es = new EventSource(`${BASE}/api/bhagwat/review-status/${jobId}`);

      es.addEventListener("chunk", e => {
        const d = JSON.parse(e.data);
        setReviewText(prev => prev + (d.text ?? ""));
      });
      es.addEventListener("suggestions", e => {
        const d = JSON.parse(e.data);
        const improvements: Suggestion[] = d.suggestions ?? [];
        const newSegs: TimelineSegment[] = (d.newSegments ?? []).map((s: any) => ({
          startSec: s.startSec,
          endSec: s.endSec,
          isBhajan: s.isBhajan ?? false,
          imageChangeEvery: s.isBhajan ? 30 : 10,
          description: s.description ?? "",
          imagePrompt: s.imagePrompt ?? "",
        }));

        // Use timelineRef.current so any edits the user made during review are preserved
        const base = timelineRef.current ?? [];
        // Apply prompt improvements to existing segments
        const improved = base.map((seg, i) => {
          const match = improvements.find(s => s.segIdx === i);
          return match ? { ...seg, imagePrompt: match.improvedPrompt } : seg;
        });
        // Merge new segments (avoid overlapping existing ones)
        const existingRanges = improved.map(s => [s.startSec, s.endSec]);
        const validNewSegs = newSegs.filter(ns =>
          !existingRanges.some(([a, b]) => ns.startSec < b && ns.endSec > a)
        );
        const merged = [...improved, ...validNewSegs].sort((a, b) => a.startSec - b.startSec);

        const totalAdded = improvements.length + validNewSegs.length;
        setTimeline(merged);
        if (totalAdded > 0) setAutoImprovedCount(totalAdded);
        setSuggestions([]);
        setReviewing(false);
        es.close();
        // In autonomous mode: auto-render immediately with the improved timeline.
        // In manual mode: stay on the review screen so user can inspect and render manually.
        if (autonomousMode) {
          handleRender(merged);
        }
      });
      es.addEventListener("jobError", e => {
        const d = JSON.parse((e as MessageEvent).data);
        toast({ title: "Review failed", description: d.message, variant: "destructive" });
        setReviewing(false);
        es.close();
      });
      es.onerror = () => {
        if (es.readyState === EventSource.CONNECTING) return;
        setReviewing(false); es.close();
      };
    } catch (err: any) {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
      setReviewing(false);
    }
  };

  const handleStop = () => {
    esRef.current?.close();
    esRef.current = null;
    // Fire-and-forget cancel requests to kill FFmpeg/yt-dlp on the server
    if (analyzeJobId) fetch(`${BASE}/api/bhagwat/cancel-analyze/${analyzeJobId}`, { method: "POST" }).catch(() => {});
    if (renderJobId) {
      fetch(`${BASE}/api/bhagwat/cancel-render/${renderJobId}`, { method: "POST" }).catch(() => {});
      removePendingRender(renderJobId); // Cancelled — remove from background tracking
    }
    setPhase("idle");
    setReviewing(false);
    setSseReconnecting(false);
    setRenderPercent(0);
    setRenderMessage("");
    setAnalyzeJobId(null);
    setRenderJobId(null);
    localStorage.removeItem(SESSION_KEY);
    toast({ title: "Stopped", description: "Processing stopped. You can start again." });
  };

  const handleRender = async (timelineOverride?: TimelineSegment[]) => {
    const tl = timelineOverride ?? timeline;
    if (!tl) return;
    esRef.current?.close();
    setPhase("rendering");
    setRenderPercent(0);
    setRenderMessage("Starting…");
    setDownloadUrl(null);
    setDownloadAlive(null);

    try {
      const renderRes = await (sourceMode === "youtube"
        ? fetch(`${BASE}/api/bhagwat/render`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, timeline: tl, videoDuration, videoTitle, mode, ...(clipRange && { clipStartSec: clipRange.startSec, clipEndSec: clipRange.endSec }) }),
          })
        : fetch(`${BASE}/api/bhagwat/render-audio`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ audioId: uploadedFile!.audioId, timeline: tl, videoDuration, mode }),
          }));
      if (!renderRes.ok) {
        const errBody = await renderRes.json().catch(() => ({ error: "Render request failed" }));
        throw new Error(errBody.error ?? `Render request failed (${renderRes.status})`);
      }
      const { jobId } = await renderRes.json();
      setRenderJobId(jobId);
      // Track this job so it appears in history if the tab is closed before render completes
      addPendingRender(jobId, videoTitle);
      const es = new EventSource(`${BASE}/api/bhagwat/render-status/${jobId}`);
      esRef.current = es;

      es.addEventListener("progress", e => {
        setSseReconnecting(false);
        const d = JSON.parse(e.data);
        setRenderPercent(d.percent ?? 0);
        setRenderMessage(d.message ?? "");
      });
      es.addEventListener("done", e => {
        setSseReconnecting(false);
        const d = JSON.parse(e.data);
        const absoluteDownloadUrl = `${BASE}${d.downloadUrl}`;
        const filename = d.filename ?? "bhagwat_video.mp4";
        setDownloadUrl(absoluteDownloadUrl);
        setDownloadFilename(filename);
        setDownloadAlive(true);
        removePendingRender(jobId);
        persistDoneState(absoluteDownloadUrl, filename);
        setPhase("done");
        es.close();
      });
      es.addEventListener("jobError", e => {
        setSseReconnecting(false);
        const d = JSON.parse((e as MessageEvent).data);
        removePendingRender(jobId);
        setErrorMsg(d.message ?? "Render failed");
        setPhase("error");
        es.close();
      });
      es.onerror = async () => {
        if (es.readyState === EventSource.CONNECTING) {
          setSseReconnecting(true);
          if (await tryResolveRenderJob(jobId, videoTitle)) {
            es.close();
          }
          return;
        }
        if (await tryResolveRenderJob(jobId, videoTitle)) {
          es.close();
          return;
        }
        setSseReconnecting(false);
        setErrorMsg("Connection error during render — please try again");
        setPhase("error"); es.close();
      };
    } catch (err: any) {
      setErrorMsg(err.message ?? "Failed to start render");
      setPhase("error");
    }
  };

  const handleEditPrompt = (idx: number, newPrompt: string) => {
    setTimeline(prev =>
      prev ? prev.map((seg, i) => i === idx ? { ...seg, imagePrompt: newPrompt } : seg) : prev
    );
  };

  const handleAcceptSuggestion = (s: Suggestion) => {
    handleEditPrompt(s.segIdx, s.improvedPrompt);
    setSuggestions(prev => prev.filter(x => x.segIdx !== s.segIdx));
  };

  const handleDismissSuggestion = (segIdx: number) => {
    setSuggestions(prev => prev.filter(x => x.segIdx !== segIdx));
  };

  const handleAcceptAllSuggestions = () => {
    suggestions.forEach(s => handleEditPrompt(s.segIdx, s.improvedPrompt));
    setSuggestions([]);
  };

  const STEP_ICONS: Record<string, any> = { metadata: Wifi, transcript: FileText, ai: Bot };
  const STEP_LABELS: Record<string, string> = { metadata: "Video info", transcript: "Transcript", ai: "AI analysis" };

  return (
    <div className="space-y-4">

      {/* Clip Mode Banner */}
      {clipRange && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl px-4 py-3"
        >
          <Scissors className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-amber-200 text-sm font-semibold truncate">Clip Mode: {clipRange.title}</p>
            <p className="text-amber-400/70 text-xs">{formatSec(clipRange.startSec)} → {formatSec(clipRange.endSec)} · {formatSec(clipRange.endSec - clipRange.startSec)} clip</p>
          </div>
          {onClearClip && (
            <button
              onClick={onClearClip}
              className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors shrink-0"
              title="Exit clip mode"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </motion.div>
      )}

      {/* Render History */}
      <RenderHistory
        history={history}
        pendingRenders={pendingRenders}
        currentRenderJobId={renderJobId}
        onClear={() => {
          saveHistory([]);
          savePendingRenders([]);
          fetch(`${BASE}/api/bhagwat/render-history`, { method: "DELETE" }).catch(() => {});
        }}
      />

      {/* Audio Source + Mode */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-amber-400" />
          Create Devotional Image Video
        </h3>

        {/* Source toggle */}
        <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-xl p-1">
          <button
            onClick={() => handleSwitchSource("youtube")}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all",
              sourceMode === "youtube"
                ? "bg-amber-600/70 text-white shadow-sm"
                : "text-white/45 hover:text-white/70"
            )}
          >
            <Youtube className="w-3.5 h-3.5" />
            YouTube Video
          </button>
          <button
            onClick={() => handleSwitchSource("upload")}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all",
              sourceMode === "upload"
                ? "bg-violet-600/70 text-white shadow-sm"
                : "text-white/45 hover:text-white/70"
            )}
          >
            <Headphones className="w-3.5 h-3.5" />
            Upload Audio
          </button>
        </div>

        {/* Upload zone (only in upload mode) */}
        {sourceMode === "upload" && (
          <AudioUploadZone
            uploadedFile={uploadedFile}
            uploading={uploading}
            uploadError={uploadError}
            onFileSelected={handleFileSelected}
            onRemove={handleRemoveFile}
          />
        )}

        <div className="flex gap-2">
          {([
            { v: "full",  label: "Full Coverage", desc: "AI places images throughout the entire audio from start to end" },
            { v: "smart", label: "AI Smart Placement", desc: "AI selects the most impactful moments for image overlays" },
          ] as const).map(opt => (
            <button
              key={opt.v}
              onClick={() => setMode(opt.v)}
              className={cn(
                "flex-1 rounded-xl border p-3 text-left transition-all",
                mode === opt.v
                  ? "bg-amber-500/15 border-amber-500/50 text-amber-300"
                  : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/70"
              )}
            >
              <div className="font-semibold text-sm">{opt.label}</div>
              <div className="text-xs opacity-70 mt-0.5">{opt.desc}</div>
            </button>
          ))}
        </div>

        {/* Autonomous mode toggle */}
        <button
          onClick={() => setAutonomousMode(p => !p)}
          className={cn(
            "w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-all",
            autonomousMode
              ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
              : "border-white/10 text-white/50 hover:border-white/20 hover:text-white/70"
          )}
        >
          <div className={cn(
            "w-9 h-5 rounded-full flex items-center transition-all shrink-0",
            autonomousMode ? "bg-violet-500 justify-end" : "bg-white/15 justify-start"
          )}>
            <div className="w-4 h-4 rounded-full bg-white mx-0.5 shadow" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              Autonomous Mode
            </div>
            <div className="text-xs opacity-60 mt-0.5">
              {autonomousMode
                ? "Auto: analyse → AI review → render (one click)"
                : "Manual: review & edit timeline before rendering"}
            </div>
          </div>
        </button>

        <div className="flex gap-2">
          <Button
            onClick={handleAnalyze}
            disabled={
              phase === "analyzing" || phase === "rendering" || reviewing ||
              (sourceMode === "upload" && !uploadedFile) ||
              uploading
            }
            className="flex-1 bg-amber-600 hover:bg-amber-500 border-amber-500/30"
          >
            {phase === "analyzing" ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing…</>
            ) : reviewing ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> AI reviewing…</>
            ) : uploading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading…</>
            ) : (
              <><Bot className="w-4 h-4 mr-2" /> Analyze & Generate Timeline</>
            )}
          </Button>

          {/* Stop button — visible while actively processing */}
          {(phase === "analyzing" || phase === "rendering" || reviewing) && (
            <Button
              onClick={handleStop}
              className="bg-red-600 hover:bg-red-500 border-red-500/30 text-white px-4 shrink-0"
              title="Stop processing"
            >
              <Square className="w-4 h-4 fill-current" />
            </Button>
          )}
        </div>
      </div>

      {/* Analysis Steps */}
      <AnimatePresence>
        {(phase === "analyzing" || phase === "analyzed" || phase === "rendering" || phase === "done") && Object.keys(steps).length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-panel rounded-2xl p-4 space-y-3"
          >
            {["metadata", "transcript", "ai"].map(name => {
              const s = steps[name];
              const Icon = STEP_ICONS[name];
              const status = s?.status ?? "idle";
              return (
                <div key={name} className="flex items-center gap-3">
                  <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0",
                    status === "done" ? "bg-green-500/20" : status === "running" ? "bg-amber-500/20" : status === "warn" ? "bg-yellow-500/20" : "bg-white/5"
                  )}>
                    {status === "running" ? <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" /> :
                     status === "done" ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> :
                     status === "warn" ? <AlertCircle className="w-3.5 h-3.5 text-yellow-400" /> :
                     <Icon className="w-3.5 h-3.5 text-white/30" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-white/80">{STEP_LABELS[name]}</span>
                    {s?.message && <p className="text-xs text-white/40 truncate">{s.message}</p>}
                  </div>
                </div>
              );
            })}
            {sseReconnecting && phase === "analyzing" && (
              <div className="flex items-center gap-2 pt-1">
                <Wifi className="w-3.5 h-3.5 text-yellow-400 animate-pulse shrink-0" />
                <span className="text-xs text-yellow-400/80">Reconnecting…</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error */}
      <AnimatePresence>
        {phase === "error" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-4 border border-red-500/30 bg-red-500/5"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-red-300 mb-1">Something went wrong</p>
                <p className="text-xs text-white/50">{errorMsg}</p>
              </div>
            </div>
            <Button
              size="sm"
              onClick={() => { setPhase("idle"); setErrorMsg(""); }}
              className="mt-3 bg-white/10 hover:bg-white/15 border-white/10 text-white/70"
            >
              Try Again
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Timeline + Review + Render */}
      <AnimatePresence>
        {phase === "analyzed" && timeline && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            className="space-y-4"
          >
            {videoTitle && (
              <div className="px-1">
                <p className="text-white/60 text-sm">
                  <span className="text-amber-400 font-semibold">"{videoTitle}"</span>
                  {videoDuration > 0 && <span className="text-white/30 ml-2">· {formatSec(videoDuration)}</span>}
                </p>
              </div>
            )}

            {/* Editable Timeline */}
            <EditableTimelinePreview
              timeline={timeline}
              suggestions={suggestions}
              videoDuration={videoDuration}
              onEditPrompt={handleEditPrompt}
              onAcceptSuggestion={handleAcceptSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
            />

            {/* AI Plan Review panel */}
            <div className="glass-panel rounded-2xl overflow-hidden border border-yellow-500/15">
              <div className="p-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-yellow-400" />
                  <span className="text-sm font-medium text-white/80">AI Plan Review</span>
                  {suggestions.length > 0 && (
                    <span className="text-xs bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 px-2 py-0.5 rounded-full">
                      {suggestions.length} suggestion{suggestions.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={handleReview}
                  disabled={reviewing}
                  className="bg-yellow-600/60 hover:bg-yellow-500/70 border-yellow-500/30 text-white text-xs h-8"
                >
                  {reviewing
                    ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Reviewing…</>
                    : reviewText
                    ? <><Lightbulb className="w-3 h-3 mr-1.5" />Re-review</>
                    : <><Lightbulb className="w-3 h-3 mr-1.5" />Review with AI</>
                  }
                </Button>
              </div>

              {/* Live streaming review text */}
              {(reviewText || reviewing) && (
                <div
                  ref={reviewScrollRef}
                  className="border-t border-white/8 max-h-48 overflow-y-auto p-3 bg-black/20"
                >
                  <p className="text-xs text-white/50 leading-relaxed whitespace-pre-wrap font-mono">
                    {reviewText.replace(/SUGGESTIONS_JSON[\s\S]*?END_SUGGESTIONS/g, "").trimEnd()}
                    {reviewing && (
                      <span className="inline-block w-1.5 h-3.5 bg-yellow-400/70 animate-pulse ml-0.5 align-middle rounded-sm" />
                    )}
                  </p>
                </div>
              )}

              {/* Structured suggestions list — shown after review completes */}
              {!reviewing && suggestions.length > 0 && (
                <div className="border-t border-yellow-500/15 p-3 space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-yellow-300/80 font-medium">
                      {suggestions.length} improvement{suggestions.length !== 1 ? "s" : ""} suggested
                    </p>
                    <button
                      onClick={handleAcceptAllSuggestions}
                      className="flex items-center gap-1 text-xs px-2.5 py-1 bg-yellow-600/60 hover:bg-yellow-500/70 text-white rounded-lg transition-colors"
                    >
                      <Check className="w-3 h-3" /> Accept All
                    </button>
                  </div>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                    {suggestions.map((s) => (
                      <div key={s.segIdx} className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-2.5 space-y-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-yellow-400/90 font-semibold">Scene #{s.segIdx + 1}</span>
                          {timeline[s.segIdx] && (
                            <span className="text-xs text-white/30 tabular-nums">
                              {formatSec(timeline[s.segIdx].startSec)} – {formatSec(timeline[s.segIdx].endSec)}
                            </span>
                          )}
                          {timeline[s.segIdx] && (
                            <span className="text-xs text-white/30 truncate max-w-[140px]">{timeline[s.segIdx].description}</span>
                          )}
                        </div>
                        <p className="text-xs text-yellow-300/60 leading-snug">{s.reason}</p>
                        <p className="text-xs text-white/55 italic leading-snug">{s.improvedPrompt}</p>
                        <div className="flex gap-1.5 pt-0.5">
                          <button
                            onClick={() => handleAcceptSuggestion(s)}
                            className="flex items-center gap-1 text-xs px-2.5 py-1 bg-yellow-600/70 hover:bg-yellow-500/70 text-white rounded-lg transition-colors"
                          >
                            <Check className="w-3 h-3" /> Accept
                          </button>
                          <button
                            onClick={() => handleDismissSuggestion(s.segIdx)}
                            className="flex items-center gap-1 text-xs px-2.5 py-1 bg-white/8 hover:bg-white/12 text-white/50 rounded-lg transition-colors"
                          >
                            <X className="w-3 h-3" /> Dismiss
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!reviewText && !reviewing && suggestions.length === 0 && (
                <p className="px-3 pb-3 text-xs text-white/25">
                  Let AI review each scene prompt and suggest improvements before you render.
                </p>
              )}
            </div>

            {/* Image count info */}
            <div className="glass-panel rounded-xl p-3 flex items-center gap-3 border border-violet-500/20 bg-violet-500/5">
              <ImageIcon className="w-4 h-4 text-violet-400 shrink-0" />
              <p className="text-xs text-white/50 leading-relaxed">
                Gemini will generate <span className="text-violet-300 font-medium">~{timeline.length} devotional images</span> — a unique image for each scene — then render the full video.
              </p>
            </div>

            <Button
              onClick={() => handleRender()}
              disabled={reviewing}
              className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 border-amber-500/30 text-white shadow-[0_0_30px_rgba(217,119,6,0.3)]"
            >
              <Sparkles className="w-4 h-4 mr-2" />
              Generate Images &amp; Render Video
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Render Progress */}
      <AnimatePresence>
        {phase === "rendering" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">
                  {renderPercent < 10 ? "Starting parallel tasks…" :
                   renderPercent < 60 ? "Gemini is generating devotional images…" :
                   renderPercent < 65 ? "Building image sequence…" :
                   "Rendering with FFmpeg…"}
                </p>
                <p className="text-xs text-white/40 mt-0.5">{renderMessage}</p>
              </div>
              <span className="text-amber-400 font-bold text-sm tabular-nums">{renderPercent}%</span>
              <button
                onClick={handleStop}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-red-600/80 hover:bg-red-500 text-white rounded-lg transition-colors shrink-0"
                title="Stop rendering"
              >
                <Square className="w-3 h-3 fill-current" /> Stop
              </button>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full"
                animate={{ width: `${renderPercent}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
            {sseReconnecting && (
              <div className="flex items-center gap-2">
                <Wifi className="w-3.5 h-3.5 text-yellow-400 animate-pulse shrink-0" />
                <span className="text-xs text-yellow-400/80">Reconnecting…</span>
              </div>
            )}
            {autoImprovedCount !== null && autoImprovedCount > 0 && (
              <p className="text-xs text-yellow-400/60 text-center flex items-center justify-center gap-1">
                <Lightbulb className="w-3 h-3" />
                Rendering with {autoImprovedCount} AI improvement{autoImprovedCount !== 1 ? "s" : ""} applied (prompts & new scenes)
              </p>
            )}
            <p className="text-xs text-white/30 text-center">
              {renderPercent < 60
                ? "Audio downloading & AI images generating in parallel"
                : "Compositing images with the audio track using FFmpeg"}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Download Ready */}
      <AnimatePresence>
        {phase === "done" && downloadUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
            className={`glass-panel rounded-2xl p-5 space-y-4 border ${downloadAlive === false ? "border-red-500/30 bg-red-500/5" : "border-green-500/30 bg-green-500/5"}`}
          >
            <div className="flex items-center gap-3">
              {downloadAlive === null
                ? <Loader2 className="w-6 h-6 text-white/40 animate-spin shrink-0" />
                : downloadAlive
                  ? <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0" />
                  : <AlertCircle className="w-6 h-6 text-red-400 shrink-0" />}
              <div>
                <p className="font-semibold text-white">
                  {downloadAlive === null ? "Checking file…" : downloadAlive ? "Video Ready!" : "File Expired"}
                </p>
                <p className="text-xs text-white/40">
                  {downloadAlive === null
                    ? "Verifying the file is still available on the server"
                    : downloadAlive
                      ? "File deletes 10 min after you start downloading"
                      : "The server was restarted and the file was lost. Re-render to get a new copy."}
                </p>
              </div>
            </div>
            {downloadAlive !== false && (
              <a
                href={downloadAlive ? downloadUrl : undefined}
                download={downloadAlive ? downloadFilename : undefined}
                aria-disabled={!downloadAlive}
                className={`flex items-center justify-center gap-2 w-full font-semibold py-3 rounded-xl transition-colors ${
                  downloadAlive
                    ? "bg-green-600 hover:bg-green-500 text-white cursor-pointer"
                    : "bg-white/10 text-white/30 cursor-not-allowed pointer-events-none"
                }`}
              >
                {downloadAlive === null
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Checking…</>
                  : <><Download className="w-4 h-4" /> Download Video</>}
              </a>
            )}
            {downloadAlive === false && (
              <Button
                size="sm"
                onClick={() => {
                  setPhase("analyzed");
                  setDownloadUrl(null);
                  setDownloadAlive(null);
                  localStorage.removeItem(SESSION_KEY);
                }}
                className="w-full bg-amber-600/80 hover:bg-amber-500/80 border-amber-500/30 text-white"
              >
                Re-render Video
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => {
                localStorage.removeItem(SESSION_KEY);
                setPhase("idle"); setTimeline(null); setDownloadUrl(null); setDownloadAlive(null);
                setUrl(""); setSuggestions([]); setReviewText("");
                if (uploadedFile) {
                  fetch(`${BASE}/api/bhagwat/audio/${uploadedFile.audioId}`, { method: "DELETE" }).catch(() => {});
                  setUploadedFile(null);
                }
              }}
              className="w-full bg-white/5 hover:bg-white/10 border-white/10 text-white/50"
            >
              Start New Video
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

// ── BhagwatVideos (tab panels) ────────────────────────────────────────────────
export function BhagwatVideos() {
  const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem(STORAGE_KEY) === "1");
  const [tab, setTab] = useState<"clips" | "editor">("editor");
  // Lifted up so the Find Clips tab pre-fills the same URL the editor already has
  const [url, setUrl] = useState("");
  // Clip range set when user clicks "Edit with AI" on a found clip
  const [clipRange, setClipRange] = useState<{ startSec: number; endSec: number; title: string } | undefined>(undefined);
  // Key to force-reset BhagwatEditor when a new clip is selected
  const [editorKey, setEditorKey] = useState(0);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const handleEditClip = useCallback((clip: { startSec: number; endSec: number; title: string }) => {
    setClipRange({ startSec: clip.startSec, endSec: clip.endSec, title: clip.title });
    setEditorKey(k => k + 1); // reset editor state for new clip
    setTab("editor");
  }, []);

  const handleClearClip = useCallback(() => {
    setClipRange(undefined);
    setEditorKey(k => k + 1);
  }, []);

  if (!unlocked) {
    return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5"
    >
      {/* Shared YouTube URL input — visible on both tabs */}
      <div className="glass-panel rounded-2xl px-4 py-3 flex items-center gap-3">
        <Film className="w-4 h-4 text-amber-400 shrink-0" />
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Paste YouTube URL of Bhagwat Katha, Ram Katha, or any devotional video…"
          className="flex-1 bg-transparent text-white placeholder:text-white/30 outline-none text-sm"
        />
        {url && (
          <button
            onClick={() => setUrl("")}
            className="text-white/30 hover:text-white/60 transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-2xl p-1">
        <button
          onClick={() => setTab("editor")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold transition-all",
            tab === "editor"
              ? "bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-[0_0_20px_rgba(217,119,6,0.3)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Sparkles className="w-4 h-4" />
          AI Image Video
          {clipRange && <Badge className="ml-1 h-4 px-1.5 text-[10px] bg-amber-500/30 text-amber-200 border-0">Clip</Badge>}
        </button>
        <button
          onClick={() => setTab("clips")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 rounded-xl text-sm font-semibold transition-all",
            tab === "clips"
              ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-[0_0_20px_rgba(139,92,246,0.4)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Film className="w-4 h-4" />
          Find Clips
        </button>
      </div>

      <div className={tab === "editor" ? undefined : "hidden"}>
        <BhagwatEditor
          key={editorKey}
          BASE={BASE}
          url={url}
          setUrl={setUrl}
          clipRange={clipRange}
          onClearClip={handleClearClip}
        />
      </div>
      <div className={tab === "clips" ? undefined : "hidden"}>
        <BestClips
          url={url}
          onEditClip={handleEditClip}
          defaultInstructions="Find all complete devotional stories, Bhagwat Katha narratives, bhajan sequences, Krishna Leela episodes, Ram Katha stories, Mahabharat discussions, and spiritual discourses. Focus on segments that have a clear narrative arc — a complete story, teaching, or devotional moment from start to finish. Also find the best standalone bhajan or kirtan clips."
        />
      </div>
    </motion.div>
  );
}
