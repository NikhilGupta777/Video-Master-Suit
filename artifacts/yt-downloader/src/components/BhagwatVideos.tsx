import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Lock, Unlock, Upload, Trash2, Image, Scissors, Film,
  ChevronDown, ChevronUp, Loader2, CheckCircle2, AlertCircle,
  Download, Sparkles, Wand2, Bot, FileText, Wifi, X, Eye, EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { BestClips } from "@/components/BestClips";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ImageMeta { id: string; name: string; category: string; ext: string; }
interface TimelineSegment {
  startSec: number; endSec: number; category: string;
  isBhajan: boolean; imageChangeEvery: number; description: string;
}
interface Category { id: string; label: string; }

const CATEGORY_COLORS: Record<string, string> = {
  krishna:       "text-blue-300 border-blue-500/40 bg-blue-500/10",
  radha_krishna: "text-pink-300 border-pink-500/40 bg-pink-500/10",
  ram:           "text-green-300 border-green-500/40 bg-green-500/10",
  sita_ram:      "text-emerald-300 border-emerald-500/40 bg-emerald-500/10",
  hanuman:       "text-orange-300 border-orange-500/40 bg-orange-500/10",
  bhagwat:       "text-yellow-300 border-yellow-500/40 bg-yellow-500/10",
  bhajan:        "text-violet-300 border-violet-500/40 bg-violet-500/10",
  general:       "text-white/50 border-white/20 bg-white/5",
};

function formatSec(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
  return `${m}:${String(sec).padStart(2,"0")}`;
}

const CORRECT_PASSWORD = "bhagwatnarrationvideos@clips2026";
const STORAGE_KEY = "bhagwat_unlocked";

// ── Password Gate ─────────────────────────────────────────────────────────────
function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

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

// ── Image Library ─────────────────────────────────────────────────────────────
function ImageLibrary({
  images, categories, BASE,
  onImagesChange,
}: {
  images: ImageMeta[];
  categories: Category[];
  BASE: string;
  onImagesChange: (imgs: ImageMeta[]) => void;
}) {
  const [uploadCategory, setUploadCategory] = useState("krishna");
  const [uploading, setUploading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const handleUpload = async (files: FileList) => {
    setUploading(true);
    let added = 0;
    for (const file of Array.from(files)) {
      try {
        const fd = new FormData();
        fd.append("image", file);
        fd.append("category", uploadCategory);
        const res = await fetch(`${BASE}/api/bhagwat/upload-image`, { method: "POST", body: fd });
        if (res.ok) { added++; }
      } catch {}
    }
    setUploading(false);
    if (added > 0) {
      toast({ title: `${added} image${added > 1 ? "s" : ""} uploaded` });
      refreshImages();
    }
  };

  const refreshImages = async () => {
    try {
      const res = await fetch(`${BASE}/api/bhagwat/images`);
      if (res.ok) { const d = await res.json(); onImagesChange(d.images); }
    } catch {}
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`${BASE}/api/bhagwat/image/${id}`, { method: "DELETE" });
      onImagesChange(images.filter(i => i.id !== id));
    } catch {
      toast({ title: "Failed to delete image", variant: "destructive" });
    }
  };

  const grouped = categories.map(cat => ({
    ...cat,
    images: images.filter(i => i.category === cat.id),
  })).filter(cat => cat.images.length > 0);

  return (
    <div className="glass-panel rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Image className="w-5 h-5 text-amber-400" />
          <span className="font-semibold text-white">Image Library</span>
          <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-xs">
            {images.length} image{images.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 space-y-4">
              {/* Upload area */}
              <div
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) handleUpload(e.dataTransfer.files); }}
                className="border-2 border-dashed border-white/15 rounded-xl p-4 hover:border-amber-500/40 transition-colors"
              >
                <div className="flex flex-col sm:flex-row items-center gap-3">
                  <div className="flex flex-wrap gap-2 flex-1 justify-center sm:justify-start">
                    {categories.map(cat => (
                      <button
                        key={cat.id}
                        onClick={() => setUploadCategory(cat.id)}
                        className={cn(
                          "px-2.5 py-1 rounded-lg text-xs font-medium border transition-all",
                          uploadCategory === cat.id
                            ? CATEGORY_COLORS[cat.id] + " !border-current"
                            : "border-white/10 text-white/40 hover:text-white/70"
                        )}
                      >
                        {cat.label}
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="bg-amber-600/80 hover:bg-amber-500 shrink-0"
                  >
                    {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Upload className="w-3.5 h-3.5 mr-1.5" />}
                    Upload Images
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={e => { if (e.target.files?.length) handleUpload(e.target.files); e.target.value = ""; }}
                  />
                </div>
                <p className="text-white/30 text-xs text-center mt-2">
                  Select category first, then upload · Drag & drop supported
                </p>
              </div>

              {/* Uploaded images by category */}
              {grouped.length === 0 && (
                <p className="text-white/30 text-sm text-center py-2">
                  No images yet — upload some to get started
                </p>
              )}
              {grouped.map(cat => (
                <div key={cat.id}>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className={cn("text-xs border", CATEGORY_COLORS[cat.id])}>
                      {cat.label}
                    </Badge>
                    <span className="text-white/30 text-xs">{cat.images.length} image{cat.images.length !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {cat.images.map(img => (
                      <div key={img.id} className="relative group">
                        <img
                          src={`${BASE}/api/bhagwat/image-file/${img.id}${img.ext}`}
                          alt={img.name}
                          className="w-16 h-16 object-cover rounded-lg border border-white/10 group-hover:border-white/30 transition-colors"
                        />
                        <button
                          onClick={() => handleDelete(img.id)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg"
                        >
                          <X className="w-3 h-3 text-white" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Timeline Preview ──────────────────────────────────────────────────────────
function TimelinePreview({ timeline, categories }: { timeline: TimelineSegment[]; categories: Category[] }) {
  const catLabel = (id: string) => categories.find(c => c.id === id)?.label ?? id;
  const totalDur = timeline.reduce((s, seg) => s + (seg.endSec - seg.startSec), 0);

  return (
    <div className="glass-panel rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Film className="w-4 h-4 text-amber-400" />
          Image Timeline
        </h3>
        <span className="text-white/40 text-xs">{timeline.length} segments · {formatSec(totalDur)}</span>
      </div>

      {/* Visual timeline bar */}
      <div className="flex h-5 rounded-lg overflow-hidden gap-px">
        {timeline.map((seg, i) => {
          const pct = totalDur > 0 ? ((seg.endSec - seg.startSec) / totalDur) * 100 : 0;
          const color = seg.isBhajan ? "bg-violet-500/70" :
            seg.category === "krishna" ? "bg-blue-500/60" :
            seg.category === "ram" || seg.category === "sita_ram" ? "bg-green-500/60" :
            seg.category === "hanuman" ? "bg-orange-500/60" :
            seg.category === "bhagwat" ? "bg-yellow-500/60" :
            seg.category === "radha_krishna" ? "bg-pink-500/60" :
            "bg-white/20";
          return (
            <div
              key={i}
              style={{ width: `${pct}%` }}
              className={cn("h-full min-w-[2px] transition-all", color)}
              title={`${formatSec(seg.startSec)} – ${formatSec(seg.endSec)} · ${catLabel(seg.category)}`}
            />
          );
        })}
      </div>

      {/* Segment list (scrollable) */}
      <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
        {timeline.map((seg, i) => (
          <div key={i} className="flex items-start gap-3 text-sm">
            <span className="text-white/30 tabular-nums text-xs mt-0.5 shrink-0 w-20">
              {formatSec(seg.startSec)} – {formatSec(seg.endSec)}
            </span>
            <Badge className={cn("text-xs border shrink-0", CATEGORY_COLORS[seg.category])}>
              {catLabel(seg.category)}
              {seg.isBhajan && " ♪"}
            </Badge>
            <span className="text-white/50 text-xs leading-tight truncate">{seg.description}</span>
            <span className="text-white/25 text-xs shrink-0">↻{seg.imageChangeEvery}s</span>
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
  const [images, setImages] = useState<ImageMeta[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
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

  useEffect(() => {
    fetch(`${BASE}/api/bhagwat/images`)
      .then(r => r.json())
      .then(d => { setImages(d.images ?? []); setCategories(d.categories ?? []); })
      .catch(() => {});
  }, [BASE]);

  const setStep = (name: string, status: string, message: string) =>
    setSteps(p => ({ ...p, [name]: { status, message } }));

  const handleAnalyze = async () => {
    if (!url.trim()) { toast({ title: "Paste a YouTube URL first", variant: "destructive" }); return; }
    if (images.length === 0) { toast({ title: "Upload at least one image first", variant: "destructive" }); return; }
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
      {/* Image Library */}
      <ImageLibrary
        images={images}
        categories={categories}
        BASE={BASE}
        onImagesChange={setImages}
      />

      {/* URL + Mode */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <h3 className="font-semibold text-white flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-amber-400" />
          Create Image Video
        </h3>

        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="Paste YouTube URL…"
          className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/30 outline-none focus:border-amber-500/50 text-sm"
        />

        {/* Mode selection */}
        <div className="flex gap-2">
          {([
            { v: "full",  label: "Full Coverage", desc: "Images cover every second of the video" },
            { v: "smart", label: "AI Smart",       desc: "AI picks the best moments for images" },
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
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white/80">{STEP_LABELS[name]}</span>
                    </div>
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
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="glass-panel rounded-2xl p-4 border border-red-500/20">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-red-300 font-medium text-sm">Something went wrong</p>
                <p className="text-red-400/70 text-xs mt-0.5">{errorMsg}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Timeline Preview */}
      <AnimatePresence>
        {timeline && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <TimelinePreview timeline={timeline} categories={categories} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Render Section */}
      <AnimatePresence>
        {timeline && phase !== "analyzing" && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-panel rounded-2xl p-5 space-y-4">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <Film className="w-4 h-4 text-amber-400" />
              Render Video
              {videoTitle && <span className="text-white/40 font-normal text-sm truncate max-w-xs">— {videoTitle}</span>}
            </h3>

            {phase === "rendering" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/60">{renderMessage || "Rendering…"}</span>
                  <span className="text-white/40 tabular-nums">{renderPercent}%</span>
                </div>
                <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-amber-500 to-orange-500 rounded-full"
                    animate={{ width: `${renderPercent}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
              </div>
            )}

            {phase === "done" && downloadUrl && (
              <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/20 rounded-xl p-4">
                <CheckCircle2 className="w-6 h-6 text-green-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-green-300 font-medium text-sm">Video is ready!</p>
                  <p className="text-green-400/60 text-xs">{downloadFilename}</p>
                </div>
                <a href={downloadUrl} download={downloadFilename}>
                  <Button size="sm" className="bg-green-600 hover:bg-green-500">
                    <Download className="w-4 h-4 mr-1.5" /> Download
                  </Button>
                </a>
              </div>
            )}

            {phase !== "done" && (
              <Button
                onClick={handleRender}
                disabled={phase === "rendering" || phase === "analyzing"}
                className="w-full bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 border-amber-500/30"
              >
                {phase === "rendering" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Rendering…</>
                ) : (
                  <><Film className="w-4 h-4 mr-2" /> Render with Images</>
                )}
              </Button>
            )}

            {phase === "done" && (
              <Button
                variant="glass"
                onClick={() => { setPhase("analyzed"); setDownloadUrl(null); setRenderPercent(0); }}
                className="w-full"
              >
                Render Again
              </Button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────
export function BhagwatVideos({ initialUrl }: { initialUrl?: string }) {
  const [isUnlocked, setIsUnlocked] = useState(() => sessionStorage.getItem(STORAGE_KEY) === "1");
  const [subTab, setSubTab] = useState<"clips" | "editor">("editor");
  const [clipsUrl, setClipsUrl] = useState(initialUrl ?? "");
  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "");

  if (!isUnlocked) {
    return <PasswordGate onUnlock={() => setIsUnlocked(true)} />;
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5"
    >
      {/* Sub-tabs */}
      <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-2xl p-1">
        <button
          onClick={() => setSubTab("editor")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all",
            subTab === "editor"
              ? "bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-[0_0_20px_rgba(217,119,6,0.3)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Wand2 className="w-4 h-4" />
          Image Video Editor
        </button>
        <button
          onClick={() => setSubTab("clips")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all",
            subTab === "clips"
              ? "bg-gradient-to-r from-violet-600 to-purple-600 text-white shadow-[0_0_20px_rgba(139,92,246,0.4)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Scissors className="w-4 h-4" />
          Find Clips
          <Badge className="bg-violet-500/20 text-violet-300 border-violet-500/30 text-[10px] px-1.5 py-0">AI</Badge>
        </button>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {subTab === "editor" ? (
          <motion.div key="editor" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <BhagwatEditor BASE={BASE} />
          </motion.div>
        ) : (
          <motion.div key="clips" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <BestClips url={clipsUrl} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
