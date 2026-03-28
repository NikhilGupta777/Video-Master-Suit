import { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Scissors, Sparkles, Clock, Download, Play, ChevronDown, ChevronUp,
  Loader2, AlertCircle, CheckCircle2, Info, Film
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

export interface BestClip {
  durationLabel: string;
  durationSec: number;
  startSec: number;
  endSec: number;
  startFormatted: string;
  endFormatted: string;
  title: string;
  description: string;
  reason: string;
}

const DURATION_OPTIONS = [
  { label: "1 min",  value: 60,  color: "from-blue-500/30 to-blue-600/10",    badge: "text-blue-300 border-blue-500/30 bg-blue-500/10",    accent: "border-blue-500/20 bg-blue-500/5"    },
  { label: "3 min",  value: 180, color: "from-purple-500/30 to-purple-600/10", badge: "text-purple-300 border-purple-500/30 bg-purple-500/10", accent: "border-purple-500/20 bg-purple-500/5" },
  { label: "5 min",  value: 300, color: "from-emerald-500/30 to-emerald-600/10",badge:"text-emerald-300 border-emerald-500/30 bg-emerald-500/10",accent:"border-emerald-500/20 bg-emerald-500/5"},
  { label: "10 min", value: 600, color: "from-amber-500/30 to-amber-600/10",   badge: "text-amber-300 border-amber-500/30 bg-amber-500/10",   accent: "border-amber-500/20 bg-amber-500/5"  },
];

type ClipKey = string; // `${durationSec}|${startSec}`

interface DownloadState {
  status: "idle" | "downloading" | "done" | "error";
  percent: number;
  message?: string;
}

interface Props {
  url: string;
}

export function BestClips({ url }: Props) {
  const [selectedDurations, setSelectedDurations] = useState<number[]>([60, 180, 300, 600]);
  const [clips, setClips] = useState<BestClip[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasTranscript, setHasTranscript] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedClip, setExpandedClip] = useState<ClipKey | null>(null);
  const [downloadStates, setDownloadStates] = useState<Record<ClipKey, DownloadState>>({});
  const { toast } = useToast();

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "");

  const clipKey = (clip: BestClip): ClipKey => `${clip.durationSec}|${clip.startSec}`;

  const setDownload = useCallback((key: ClipKey, patch: Partial<DownloadState>) => {
    setDownloadStates(prev => ({
      ...prev,
      [key]: { ...(prev[key] ?? { status: "idle", percent: 0 }), ...patch },
    }));
  }, []);

  const toggleDuration = (value: number) => {
    setSelectedDurations(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]
    );
  };

  const handleAnalyze = async () => {
    if (!url.trim() || selectedDurations.length === 0) return;
    setIsLoading(true);
    setError(null);
    setClips([]);
    setExpandedClip(null);
    setDownloadStates({});

    try {
      const res = await fetch(`${BASE}/api/youtube/clips`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), durations: selectedDurations }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Analysis failed");
      setClips(data.clips ?? []);
      setHasTranscript(data.hasTranscript ?? false);
      if (!data.clips?.length) setError("No clips could be identified for this video.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze video");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownloadClip = async (clip: BestClip) => {
    const key = clipKey(clip);
    const current = downloadStates[key];
    if (current?.status === "downloading") return; // already in progress

    setDownload(key, { status: "downloading", percent: 0, message: "Starting…" });

    try {
      // Start the clip download job
      const startRes = await fetch(`${BASE}/api/youtube/download-clip`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          startSec: clip.startSec,
          endSec: clip.endSec,
          title: clip.title,
        }),
      });
      const startData = await startRes.json();
      if (!startRes.ok) throw new Error(startData.error ?? "Failed to start download");

      const { jobId } = startData;

      // Poll for progress until done
      for (let i = 0; i < 150; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const progRes = await fetch(`${BASE}/api/youtube/progress/${jobId}`);
        const prog = await progRes.json();

        if (prog.status === "done") {
          setDownload(key, { status: "done", percent: 100 });
          // Trigger browser download
          const link = document.createElement("a");
          link.href = `${BASE}/api/youtube/file/${jobId}`;
          link.download = `${clip.title}.mp4`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          toast({ title: "Clip downloaded!", description: `"${clip.title}" saved to your downloads.` });
          return;
        }

        if (prog.status === "error") {
          throw new Error(prog.message ?? "Download failed");
        }

        // Update progress
        const pct = prog.percent ?? 0;
        const statusMsg = prog.status === "merging"
          ? "Merging…"
          : pct > 0
            ? `Downloading… ${pct}%`
            : "Preparing…";
        setDownload(key, { status: "downloading", percent: pct, message: statusMsg });
      }

      throw new Error("Download timed out after 5 minutes");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setDownload(key, { status: "error", percent: 0, message: msg });
      toast({ title: "Download failed", description: msg, variant: "destructive" });
    }
  };

  const getDurationStyle = (durationSec: number) =>
    DURATION_OPTIONS.find(d => d.value === durationSec) ?? DURATION_OPTIONS[0];

  // Group clips by duration, preserving AI-returned order (best first)
  const groupedClips = clips.reduce<Array<{ durationSec: number; durationLabel: string; clips: BestClip[] }>>(
    (acc, clip) => {
      const existing = acc.find(g => g.durationSec === clip.durationSec);
      if (existing) existing.clips.push(clip);
      else acc.push({ durationSec: clip.durationSec, durationLabel: clip.durationLabel, clips: [clip] });
      return acc;
    },
    []
  );

  return (
    <div className="w-full space-y-6">
      {/* Duration Selector */}
      <div className="glass-panel rounded-2xl p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="bg-primary/20 p-2 rounded-xl border border-primary/30">
            <Scissors className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-white text-lg">Find Best Clips</h3>
            <p className="text-white/50 text-sm">AI analyzes the video to find all the most engaging segments</p>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-white/60 text-sm font-medium">Select clip durations to find:</p>
          <div className="flex flex-wrap gap-3">
            {DURATION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => toggleDuration(opt.value)}
                className={cn(
                  "px-4 py-2 rounded-xl border text-sm font-semibold transition-all duration-200",
                  selectedDurations.includes(opt.value)
                    ? "bg-primary/20 border-primary/50 text-white shadow-[0_0_12px_rgba(229,9,20,0.2)]"
                    : "bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <Button
          onClick={handleAnalyze}
          disabled={isLoading || !url.trim() || selectedDurations.length === 0}
          className="w-full h-12 rounded-xl"
          size="lg"
        >
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Analyzing video...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              Find Best Clips
            </span>
          )}
        </Button>
      </div>

      {/* Loading state */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-8 flex flex-col items-center gap-4 text-center"
          >
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Sparkles className="w-7 h-7 text-primary animate-pulse" />
              </div>
              <div className="absolute -inset-2 rounded-full border border-primary/20 animate-ping" />
            </div>
            <div>
              <p className="text-white font-semibold text-lg">AI is analyzing the video</p>
              <p className="text-white/50 text-sm mt-1">Downloading transcript and finding all the best moments…</p>
            </div>
            <div className="flex gap-1.5 mt-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error state */}
      <AnimatePresence>
        {error && !isLoading && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-2xl p-5 flex items-start gap-4 border-red-500/20"
          >
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-white font-medium">Analysis failed</p>
              <p className="text-white/60 text-sm mt-1">{error}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results — grouped by duration */}
      <AnimatePresence>
        {groupedClips.length > 0 && !isLoading && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-6">
            {/* Summary header */}
            <div className="flex items-center gap-3 px-1 flex-wrap">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <h3 className="text-lg font-display font-semibold text-white">
                {clips.length} clip{clips.length !== 1 ? "s" : ""} found across {groupedClips.length} duration{groupedClips.length !== 1 ? "s" : ""}
              </h3>
              {!hasTranscript && (
                <div className="flex items-center gap-1.5 text-amber-300 text-xs bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full ml-auto">
                  <Info className="w-3 h-3" />
                  Based on title &amp; description (no transcript)
                </div>
              )}
            </div>

            {/* Duration groups */}
            {groupedClips.map((group, groupIdx) => {
              const style = getDurationStyle(group.durationSec);
              return (
                <motion.div
                  key={group.durationSec}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: groupIdx * 0.07 }}
                  className="space-y-2"
                >
                  {/* Group header */}
                  <div className={cn("flex items-center gap-3 px-4 py-2.5 rounded-xl border", style.accent)}>
                    <Film className="w-4 h-4 text-white/40" />
                    <Badge className={cn("text-xs font-bold px-3 py-1 rounded-lg border", style.badge)}>
                      {group.durationLabel}
                    </Badge>
                    <span className="text-white/50 text-sm">
                      {group.clips.length} segment{group.clips.length !== 1 ? "s" : ""} found
                    </span>
                  </div>

                  {/* Clip cards */}
                  <div className="space-y-2 pl-2">
                    {group.clips.map((clip, clipIdx) => {
                      const key = clipKey(clip);
                      const dl = downloadStates[key] ?? { status: "idle", percent: 0 };
                      const isExpanded = expandedClip === key;

                      return (
                        <motion.div
                          key={key}
                          initial={{ opacity: 0, x: -12 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: groupIdx * 0.07 + clipIdx * 0.04 }}
                          className="group relative glass-panel rounded-xl overflow-hidden border-white/5 hover:border-white/10 transition-all duration-300"
                        >
                          <div className={cn("absolute inset-0 bg-gradient-to-br opacity-10 pointer-events-none", style.color)} />

                          {/* Download progress bar */}
                          {dl.status === "downloading" && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
                              <motion.div
                                className="h-full bg-primary"
                                initial={{ width: 0 }}
                                animate={{ width: `${dl.percent}%` }}
                                transition={{ duration: 0.4 }}
                              />
                            </div>
                          )}

                          <div className="relative p-4">
                            <div className="flex items-start gap-3">
                              {/* Rank */}
                              <div className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-white/30 text-xs font-bold">
                                {clipIdx + 1}
                              </div>

                              {/* Info */}
                              <div className="flex-1 min-w-0">
                                <h4 className="font-display font-bold text-white text-sm leading-snug mb-1 truncate">
                                  {clip.title}
                                </h4>
                                <div className="flex items-center gap-3 text-white/50 text-xs">
                                  <span className="flex items-center gap-1">
                                    <Play className="w-3 h-3" />{clip.startFormatted}
                                  </span>
                                  <span>→</span>
                                  <span className="flex items-center gap-1">
                                    <Clock className="w-3 h-3" />{clip.endFormatted}
                                  </span>
                                </div>
                                {/* Download status text */}
                                {dl.status === "downloading" && dl.message && (
                                  <p className="text-primary/70 text-xs mt-1 font-medium">{dl.message}</p>
                                )}
                                {dl.status === "error" && dl.message && (
                                  <p className="text-red-400 text-xs mt-1">{dl.message}</p>
                                )}
                              </div>

                              {/* Actions */}
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  onClick={() => setExpandedClip(isExpanded ? null : key)}
                                  className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors"
                                >
                                  {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                                </button>

                                <Button
                                  size="sm"
                                  variant={dl.status === "done" ? "glass" : "default"}
                                  onClick={() => handleDownloadClip(clip)}
                                  disabled={dl.status === "downloading"}
                                  className={cn(
                                    "rounded-xl h-8 px-3 text-xs font-semibold min-w-[90px]",
                                    dl.status === "done" && "bg-emerald-500/20 border-emerald-500/30 text-emerald-300",
                                    dl.status === "error" && "bg-red-500/10 border-red-500/30 text-red-300"
                                  )}
                                >
                                  {dl.status === "downloading" ? (
                                    <span className="flex items-center gap-1.5">
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      {dl.percent > 0 ? `${dl.percent}%` : "…"}
                                    </span>
                                  ) : dl.status === "done" ? (
                                    <span className="flex items-center gap-1.5">
                                      <CheckCircle2 className="w-3 h-3" /> Downloaded
                                    </span>
                                  ) : dl.status === "error" ? (
                                    <span className="flex items-center gap-1.5">
                                      <Download className="w-3 h-3" /> Retry
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1.5">
                                      <Download className="w-3 h-3" /> Download
                                    </span>
                                  )}
                                </Button>
                              </div>
                            </div>

                            {/* Expandable detail */}
                            <AnimatePresence>
                              {isExpanded && (
                                <motion.div
                                  initial={{ opacity: 0, height: 0 }}
                                  animate={{ opacity: 1, height: "auto" }}
                                  exit={{ opacity: 0, height: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="pt-3 mt-3 border-t border-white/5 space-y-2 ml-9">
                                    <p className="text-white/65 text-sm leading-relaxed">{clip.description}</p>
                                    {clip.reason && (
                                      <div className="flex items-start gap-2 bg-white/5 rounded-lg px-3 py-2">
                                        <Sparkles className="w-3 h-3 text-primary shrink-0 mt-0.5" />
                                        <p className="text-white/55 text-xs italic">{clip.reason}</p>
                                      </div>
                                    )}
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
