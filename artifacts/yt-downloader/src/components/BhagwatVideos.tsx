import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock, Unlock, Film, Loader2, CheckCircle2, AlertCircle,
  Download, Wand2, Bot, FileText, Wifi, Eye, EyeOff, Sparkles, ImageIcon,
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

function formatSec(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const CORRECT_PASSWORD = "bhagwatnarrationvideos@clips2026";
const STORAGE_KEY = "bhagwat_unlocked";

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

// ── Timeline Preview ──────────────────────────────────────────────────────────
function TimelinePreview({ timeline }: { timeline: TimelineSegment[] }) {
  const totalDur = timeline.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0);
  const bhajans = timeline.filter(s => s.isBhajan).length;
  const kathas = timeline.length - bhajans;

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

      {/* Visual timeline bar — amber=katha, violet=bhajan */}
      <div className="flex h-4 rounded-lg overflow-hidden gap-px">
        {timeline.map((seg, i) => {
          const pct = totalDur > 0 ? ((seg.endSec - seg.startSec) / totalDur) * 100 : 0;
          return (
            <div
              key={i}
              style={{ width: `${pct}%` }}
              className={cn(
                "h-full min-w-[2px]",
                seg.isBhajan ? "bg-violet-500/70" : "bg-amber-500/50"
              )}
              title={`${formatSec(seg.startSec)} – ${formatSec(seg.endSec)} · ${seg.description}`}
            />
          );
        })}
      </div>

      {/* Segment list */}
      <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
        {timeline.map((seg, i) => (
          <div key={i} className={cn(
            "rounded-xl border p-2.5 space-y-1",
            seg.isBhajan
              ? "border-violet-500/20 bg-violet-500/5"
              : "border-white/8 bg-white/3"
          )}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-white/30 tabular-nums text-xs shrink-0">
                {formatSec(seg.startSec)} – {formatSec(seg.endSec)}
              </span>
              {seg.isBhajan
                ? <Badge className="text-xs border border-violet-500/40 bg-violet-500/10 text-violet-300">♪ Bhajan</Badge>
                : <Badge className="text-xs border border-amber-500/30 bg-amber-500/8 text-amber-300/80">Katha</Badge>
              }
              <span className="text-white/25 text-xs ml-auto">↻{seg.imageChangeEvery}s</span>
            </div>
            <p className="text-white/70 text-xs font-medium leading-snug">{seg.description}</p>
            <p className="text-white/30 text-xs leading-snug italic line-clamp-2">{seg.imagePrompt}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Bhagwat Editor ───────────────────────────────────────────────────────
function BhagwatEditor({ BASE }: { BASE: string }) {
  const [url, setUrl] = useState("");
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

  const setStep = (name: string, status: string, message: string) =>
    setSteps(p => ({ ...p, [name]: { status, message } }));

  const handleAnalyze = async () => {
    if (!url.trim()) { toast({ title: "Paste a YouTube URL first", variant: "destructive" }); return; }
    esRef.current?.close();
    setPhase("analyzing");
    setTimeline(null);
    setDownloadUrl(null);
    setErrorMsg("");
    setSteps({
      metadata:   { status: "idle", message: "" },
      transcript: { status: "idle", message: "" },
      ai:         { status: "idle", message: "" },
    });

    try {
      const res = await fetch(`${BASE}/api/bhagwat/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, mode }),
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
      es.addEventListener("error", e => {
        const d = JSON.parse(e.data);
        setErrorMsg(d.message ?? "Analysis failed");
        setPhase("error");
        es.close();
      });
      es.onerror = () => { setErrorMsg("Connection error during analysis"); setPhase("error"); es.close(); };
    } catch (err: any) {
      setErrorMsg(err.message ?? "Failed to start analysis");
      setPhase("error");
    }
  };

  const handleRender = async () => {
    if (!timeline) return;
    esRef.current?.close();
    setPhase("rendering");
    setRenderPercent(0);
    setRenderMessage("Starting…");

    try {
      const res = await fetch(`${BASE}/api/bhagwat/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, timeline }),
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
      es.addEventListener("error", e => {
        const d = JSON.parse(e.data);
        setErrorMsg(d.message ?? "Render failed");
        setPhase("error");
        es.close();
      });
      es.onerror = () => { setErrorMsg("Connection error during render"); setPhase("error"); es.close(); };
    } catch (err: any) {
      setErrorMsg(err.message ?? "Failed to start render");
      setPhase("error");
    }
  };

  const STEP_ICONS: Record<string, any> = { metadata: Wifi, transcript: FileText, ai: Bot };
  const STEP_LABELS: Record<string, string> = { metadata: "Video info", transcript: "Transcript", ai: "AI analysis" };

  return (
    <div className="space-y-5">

      {/* URL + Mode */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-amber-400" />
          Create Devotional Image Video
        </h3>

        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Paste YouTube URL of Bhagwat Katha, Ram Katha, or any devotional video…"
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-amber-500/50 text-sm"
        />

        {/* Mode selection */}
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
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
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

      {/* Timeline Preview */}
      <AnimatePresence>
        {phase === "analyzed" && timeline && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
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

            <TimelinePreview timeline={timeline} />

            {/* AI Image Generation info */}
            <div className="glass-panel rounded-xl p-3 flex items-center gap-3 border border-violet-500/20 bg-violet-500/5">
              <ImageIcon className="w-4 h-4 text-violet-400 shrink-0" />
              <p className="text-xs text-white/50 leading-relaxed">
                Gemini will generate <span className="text-violet-300 font-medium">~{timeline.filter(s => !s.isBhajan).length * 2 + timeline.filter(s => s.isBhajan).length} devotional images</span> — a unique image crafted for each story beat and bhajan section above — then render the full video.
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
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-5 space-y-4"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-amber-400 animate-spin shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-white">
                  {renderPercent < 10 ? "Downloading audio…" :
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
            <p className="text-xs text-white/30 text-center">
              {renderPercent < 60
                ? "Generating unique AI images for each section of the katha — this takes a few minutes"
                : "Compositing images with the audio track using FFmpeg"}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Download Ready */}
      <AnimatePresence>
        {phase === "done" && downloadUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            className="glass-panel rounded-2xl p-5 space-y-4 border border-green-500/30 bg-green-500/5"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0" />
              <div>
                <p className="font-semibold text-white">Video Ready!</p>
                <p className="text-xs text-white/40">Devotional images generated and rendered successfully</p>
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
              onClick={() => { setPhase("idle"); setTimeline(null); setDownloadUrl(null); setUrl(""); }}
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

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  if (!unlocked) {
    return <PasswordGate onUnlock={() => setUnlocked(true)} />;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5"
    >
      {/* Sub-tabs */}
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

      {tab === "editor" && <BhagwatEditor BASE={BASE} />}
      {tab === "clips" && <BestClips url="" />}
    </motion.div>
  );
}
