import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock, Unlock, Film, Loader2, CheckCircle2, AlertCircle,
  Download, Wand2, Bot, FileText, Wifi, Eye, EyeOff, Sparkles, ImageIcon,
  Pencil, X, Lightbulb, ChevronDown, ChevronUp, Clock, Check, Scissors,
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
const MAX_HISTORY = 8;
const CORRECT_PASSWORD = "bhagwatnarrationvideos@clips2026";
const STORAGE_KEY = "bhagwat_unlocked";

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

  const attempt = () => {
    if (pw === CORRECT_PASSWORD) {
      sessionStorage.setItem(STORAGE_KEY, "1");
      onUnlock();
    } else {
      setError("Incorrect password");
      setPw("");
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
          <Button onClick={attempt} className="w-full bg-amber-600 hover:bg-amber-500 border-amber-500/30">
            <Unlock className="w-4 h-4 mr-2" /> Unlock
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

// ── Render History ─────────────────────────────────────────────────────────────
function RenderHistory({ history, onClear }: { history: HistoryEntry[]; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  if (history.length === 0) return null;

  return (
    <div className="glass-panel rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-3 hover:bg-white/3 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm text-white/55 font-medium">
          <Clock className="w-4 h-4 text-white/25" />
          Recent renders ({history.length})
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
              {history.map(entry => (
                <div key={entry.id} className="flex items-center gap-2 rounded-lg bg-white/3 px-2.5 py-2">
                  <Film className="w-3.5 h-3.5 text-amber-400/60 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-white/70 truncate">{entry.title || entry.filename}</p>
                    <p className="text-xs text-white/30">{timeAgo(entry.timestamp)}</p>
                  </div>
                  <a
                    href={entry.downloadUrl}
                    download={entry.filename}
                    className="shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 bg-green-600/40 hover:bg-green-500/50 text-white/80 rounded-lg transition-colors"
                  >
                    <Download className="w-3 h-3" />
                  </a>
                </div>
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
  const [mode, setMode] = useState<"full" | "smart">("full");
  const [timeline, setTimeline] = useState<TimelineSegment[] | null>(null);
  const [videoTitle, setVideoTitle] = useState("");
  const [videoDuration, setVideoDuration] = useState(0);

  const [phase, setPhase] = useState<"idle" | "analyzing" | "analyzed" | "rendering" | "done" | "error">("idle");
  const [steps, setSteps] = useState<Record<string, { status: string; message: string }>>({});
  const [renderPercent, setRenderPercent] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadFilename, setDownloadFilename] = useState("bhagwat_video.mp4");
  const [errorMsg, setErrorMsg] = useState("");
  const { toast } = useToast();
  const esRef = useRef<EventSource | null>(null);

  const [reviewing, setReviewing] = useState(false);
  const [reviewText, setReviewText] = useState("");
  const [autoImprovedCount, setAutoImprovedCount] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const hasAutoReviewedRef = useRef(false);
  const reviewScrollRef = useRef<HTMLDivElement | null>(null);
  // Always tracks the latest timeline so SSE handlers don't use stale closures
  const timelineRef = useRef<TimelineSegment[] | null>(null);

  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
  });

  const saveHistory = useCallback((entries: HistoryEntry[]) => {
    setHistory(entries);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  }, []);

  const setStep = (name: string, status: string, message: string) =>
    setSteps(p => ({ ...p, [name]: { status, message } }));

  // Keep timelineRef in sync so SSE handlers never read a stale closure
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);

  // Cleanup: close any open EventSource when the component unmounts
  useEffect(() => { return () => { esRef.current?.close(); }; }, []);

  // Auto-trigger review as soon as analysis completes (but do NOT auto-render)
  useEffect(() => {
    if (phase === "analyzed" && timeline && !hasAutoReviewedRef.current) {
      hasAutoReviewedRef.current = true;
      handleReview();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, timeline]);

  useEffect(() => {
    if (phase === "done" && downloadUrl && downloadFilename) {
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        title: videoTitle || downloadFilename,
        filename: downloadFilename,
        downloadUrl,
        timestamp: Date.now(),
      };
      // Use functional update so we never close over a stale `history` value
      setHistory(prev => {
        const updated = [entry, ...prev].slice(0, MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
        return updated;
      });
    }
  }, [phase, downloadUrl, downloadFilename, videoTitle]);

  const handleAnalyze = async () => {
    if (!url.trim()) { toast({ title: "Paste a YouTube URL first", variant: "destructive" }); return; }
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
      const res = await fetch(`${BASE}/api/bhagwat/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, mode, ...(clipRange && { clipStartSec: clipRange.startSec, clipEndSec: clipRange.endSec }) }),
      });
      const { jobId } = await res.json();
      const es = new EventSource(`${BASE}/api/bhagwat/analyze-status/${jobId}`);
      esRef.current = es;

      es.addEventListener("step", e => {
        const d = JSON.parse(e.data);
        setStep(d.step, d.status, d.message);
      });
      es.addEventListener("done", e => {
        const d = JSON.parse(e.data);
        setTimeline(d.timeline);
        setVideoTitle(d.videoTitle ?? "");
        setVideoDuration(d.videoDuration ?? 0);
        setPhase("analyzed");
        es.close();
      });
      es.addEventListener("jobError", e => {
        const d = JSON.parse((e as MessageEvent).data);
        setErrorMsg(d.message ?? "Analysis failed");
        setPhase("error");
        es.close();
      });
      es.onerror = () => { setErrorMsg("Connection error during analysis — please try again"); setPhase("error"); es.close(); };
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
        body: JSON.stringify({ timeline, videoTitle, videoDuration }),
      });
      const { jobId } = await res.json();
      const es = new EventSource(`${BASE}/api/bhagwat/review-status/${jobId}`);

      es.addEventListener("chunk", e => {
        const d = JSON.parse(e.data);
        setReviewText(prev => prev + (d.text ?? ""));
      });
      es.addEventListener("suggestions", e => {
        const d = JSON.parse(e.data);
        const incoming: Suggestion[] = d.suggestions ?? [];

        // Use timelineRef.current (not the closed-over `timeline`) so any
        // edits the user made during the review period are preserved.
        const base = timelineRef.current ?? [];
        const updatedTl = base.map((seg, i) => {
          const match = incoming.find(s => s.segIdx === i);
          return match ? { ...seg, imagePrompt: match.improvedPrompt } : seg;
        });

        setTimeline(updatedTl);
        if (incoming.length > 0) setAutoImprovedCount(incoming.length);
        setSuggestions([]);
        setReviewing(false);
        es.close();
        // User reviews the improved timeline and clicks Render manually — no auto-render.
      });
      es.addEventListener("jobError", e => {
        const d = JSON.parse((e as MessageEvent).data);
        toast({ title: "Review failed", description: d.message, variant: "destructive" });
        setReviewing(false);
        es.close();
      });
      es.onerror = () => { setReviewing(false); es.close(); };
    } catch (err: any) {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
      setReviewing(false);
    }
  };

  const handleRender = async (timelineOverride?: TimelineSegment[]) => {
    const tl = timelineOverride ?? timeline;
    if (!tl) return;
    esRef.current?.close();
    setPhase("rendering");
    setRenderPercent(0);
    setRenderMessage("Starting…");

    try {
      const res = await fetch(`${BASE}/api/bhagwat/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeline: tl, videoDuration, ...(clipRange && { clipStartSec: clipRange.startSec, clipEndSec: clipRange.endSec }) }),
      });
      const { jobId } = await res.json();
      const es = new EventSource(`${BASE}/api/bhagwat/render-status/${jobId}`);
      esRef.current = es;

      es.addEventListener("progress", e => {
        const d = JSON.parse(e.data);
        setRenderPercent(d.percent ?? 0);
        setRenderMessage(d.message ?? "");
      });
      es.addEventListener("done", e => {
        const d = JSON.parse(e.data);
        setDownloadUrl(`${BASE}${d.downloadUrl}`);
        setDownloadFilename(d.filename ?? "bhagwat_video.mp4");
        setPhase("done");
        es.close();
      });
      es.addEventListener("jobError", e => {
        const d = JSON.parse((e as MessageEvent).data);
        setErrorMsg(d.message ?? "Render failed");
        setPhase("error");
        es.close();
      });
      es.onerror = () => { setErrorMsg("Connection error during render — please try again"); setPhase("error"); es.close(); };
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
      <RenderHistory history={history} onClear={() => saveHistory([])} />

      {/* URL + Mode */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-amber-400" />
          Create Devotional Image Video
        </h3>

        <div className="flex gap-2">
          {([
            { v: "full",  label: "Full Coverage", desc: "AI places images throughout the entire video from start to end" },
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

        <Button
          onClick={handleAnalyze}
          disabled={phase === "analyzing" || phase === "rendering"}
          className="w-full bg-amber-600 hover:bg-amber-500 border-amber-500/30"
        >
          {phase === "analyzing" ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing…</>
          ) : (
            <><Bot className="w-4 h-4 mr-2" /> Analyze & Generate Timeline</>
          )}
        </Button>
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
              onClick={handleRender}
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
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full"
                animate={{ width: `${renderPercent}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
            {autoImprovedCount !== null && autoImprovedCount > 0 && (
              <p className="text-xs text-yellow-400/60 text-center flex items-center justify-center gap-1">
                <Lightbulb className="w-3 h-3" />
                AI auto-improved {autoImprovedCount} scene prompt{autoImprovedCount !== 1 ? "s" : ""} before rendering
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
            className="glass-panel rounded-2xl p-5 space-y-4 border border-green-500/30 bg-green-500/5"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0" />
              <div>
                <p className="font-semibold text-white">Video Ready!</p>
                <p className="text-xs text-white/40">File deletes 10 min after you start downloading</p>
              </div>
            </div>
            <a
              href={downloadUrl}
              download={downloadFilename}
              className="flex items-center justify-center gap-2 w-full bg-green-600 hover:bg-green-500 text-white font-semibold py-3 rounded-xl transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Video
            </a>
            <Button
              size="sm"
              onClick={() => {
                setPhase("idle"); setTimeline(null); setDownloadUrl(null);
                setUrl(""); setSuggestions([]); setReviewText("");
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
