import React, { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  FileText, Youtube, Upload, Download, Loader2, CheckCircle2,
  AlertCircle, Globe, X, FileAudio, FileVideo, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

const BASE = () => (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

const LANGUAGES = [
  { value: "auto",    label: "Auto-detect" },
  { value: "Odia",    label: "Odia (ଓଡ଼ିଆ)" },
  { value: "Hindi",   label: "Hindi (हिन्दी)" },
  { value: "English", label: "English" },
  { value: "Bengali", label: "Bengali (বাংলা)" },
  { value: "Telugu",  label: "Telugu (తెలుగు)" },
  { value: "Tamil",   label: "Tamil (தமிழ்)" },
  { value: "Marathi", label: "Marathi (मराठी)" },
  { value: "Punjabi", label: "Punjabi (ਪੰਜਾਬੀ)" },
  { value: "Kannada", label: "Kannada (ಕನ್ನಡ)" },
];

const TRANSLATE_LANGUAGES = [
  { value: "none",    label: "No translation" },
  { value: "English", label: "Translate → English" },
  { value: "Hindi",   label: "Translate → Hindi (हिन्दी)" },
];

type InputMode = "url" | "file";

const STEP_LABELS: Record<string, string> = {
  audio:      "Downloading audio from YouTube...",
  uploading:  "Uploading to Gemini AI...",
  generating: "Transcribing audio to SRT...",
  correcting: "Auto-correcting errors (2nd AI pass)...",
  translating: "Translating subtitles (3rd AI pass)...",
  verifying:  "Verifying translation (4th AI pass)...",
  done:       "Subtitles ready!",
  error:      "Something went wrong",
};

const BASE_STEPS = ["audio", "uploading", "generating", "correcting"];
const TRANSLATE_STEPS = ["translating", "verifying"];

export function GetSubtitles() {
  const [inputMode, setInputMode] = useState<InputMode>("url");
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState("auto");
  const [translateTo, setTranslateTo] = useState("none");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [jobMessage, setJobMessage] = useState("");
  const [jobError, setJobError] = useState("");
  const [srtContent, setSrtContent] = useState<string | null>(null);
  const [srtFilename, setSrtFilename] = useState("subtitles.srt");
  const [loading, setLoading] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();

  const stepOrder = translateTo !== "none"
    ? [...BASE_STEPS, ...TRANSLATE_STEPS, "done"]
    : [...BASE_STEPS, "done"];

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollStatus = useCallback((id: string) => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${BASE()}/api/subtitles/status/${id}`);
        const data = await res.json();

        setJobStatus(data.status);
        setJobMessage(data.message ?? STEP_LABELS[data.status] ?? "");

        if (data.status === "done") {
          stopPolling();
          setLoading(false);
          setSrtContent(data.srt);
          setSrtFilename(data.filename ?? "subtitles.srt");
        } else if (data.status === "error") {
          stopPolling();
          setLoading(false);
          setJobError(data.error ?? "Unknown error");
          toast({ title: "Failed", description: data.error, variant: "destructive" });
        }
      } catch {
        // keep polling on transient network errors
      }
    }, 2500);
  }, [toast]);

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setSrtContent(null);
    setJobStatus("audio");
    setJobMessage("Downloading audio from YouTube...");
    setJobError("");
    setJobId(null);

    try {
      const res = await fetch(`${BASE()}/api/subtitles/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim(), language, translateTo }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start job");
      setJobId(data.jobId);
      pollStatus(data.jobId);
    } catch (err: any) {
      setLoading(false);
      setJobStatus("error");
      setJobError(err.message);
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleFileUpload = async () => {
    if (!file) return;

    setLoading(true);
    setSrtContent(null);
    setJobStatus("uploading");
    setJobMessage("Uploading to Gemini AI...");
    setJobError("");
    setJobId(null);

    try {
      const form = new FormData();
      form.append("file", file);
      form.append("language", language);
      form.append("translateTo", translateTo);

      const res = await fetch(`${BASE()}/api/subtitles/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to upload");
      setJobId(data.jobId);
      pollStatus(data.jobId);
    } catch (err: any) {
      setLoading(false);
      setJobStatus("error");
      setJobError(err.message);
      toast({ title: "Upload Failed", description: err.message, variant: "destructive" });
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const downloadSrt = () => {
    if (!srtContent) return;
    const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = srtFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  };

  const reset = () => {
    stopPolling();
    setJobId(null); setJobStatus(null); setJobMessage(""); setJobError("");
    setSrtContent(null); setLoading(false);
  };

  const selectedLang = LANGUAGES.find((l) => l.value === language);
  const isRunning = loading && jobStatus && jobStatus !== "done" && jobStatus !== "error";

  return (
    <div className="w-full max-w-2xl mx-auto flex flex-col gap-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="bg-teal-500/20 p-2.5 rounded-xl border border-teal-500/30">
          <FileText className="w-5 h-5 text-teal-400" />
        </div>
        <div>
          <h2 className="text-xl font-display font-bold text-white">Get Subtitles</h2>
          <p className="text-white/50 text-sm">Generate accurate SRT subtitles for any video using Gemini AI — supports Odia, Hindi, and 8 other languages</p>
        </div>
      </div>

      {/* Input mode toggle */}
      <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-xl p-1 w-fit">
        <button
          onClick={() => { setInputMode("url"); reset(); }}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
            inputMode === "url"
              ? "bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.3)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Youtube className="w-4 h-4" /> YouTube URL
        </button>
        <button
          onClick={() => { setInputMode("file"); reset(); }}
          className={cn(
            "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-semibold transition-all",
            inputMode === "file"
              ? "bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.3)]"
              : "text-white/50 hover:text-white/80"
          )}
        >
          <Upload className="w-4 h-4" /> Upload File
        </button>
      </div>

      {/* Language picker */}
      <div className="relative">
        <button
          onClick={() => setLangOpen((o) => !o)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white/80 hover:bg-white/8 hover:border-white/20 transition-all w-full sm:w-auto"
        >
          <Globe className="w-4 h-4 text-teal-400" />
          <span>{selectedLang?.label ?? "Auto-detect"}</span>
          <ChevronDown className={cn("w-4 h-4 text-white/40 ml-auto sm:ml-4 transition-transform", langOpen && "rotate-180")} />
        </button>
        <AnimatePresence>
          {langOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.15 }}
              className="absolute top-full left-0 mt-1 z-30 bg-zinc-900 border border-white/10 rounded-xl overflow-hidden shadow-2xl w-56"
            >
              {LANGUAGES.map((lang) => (
                <button
                  key={lang.value}
                  onClick={() => { setLanguage(lang.value); setLangOpen(false); }}
                  className={cn(
                    "w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-white/8",
                    language === lang.value ? "text-teal-400 font-semibold" : "text-white/70"
                  )}
                >
                  {lang.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input area */}
      <AnimatePresence mode="wait">
        {inputMode === "url" ? (
          <motion.form
            key="url-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onSubmit={handleUrlSubmit}
            className="flex flex-col sm:flex-row gap-3"
          >
            <div className="relative flex-1">
              <Youtube className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30 pointer-events-none" />
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Paste YouTube URL..."
                disabled={isRunning as boolean}
                className="w-full bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-3 text-white placeholder:text-white/30 text-sm focus:outline-none focus:border-teal-500/50 transition-colors disabled:opacity-50"
              />
            </div>
            <Button
              type="submit"
              disabled={!url.trim() || (isRunning as boolean)}
              className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl px-6 shrink-0 shadow-[0_0_16px_rgba(20,184,166,0.25)]"
            >
              {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : "Generate SRT"}
            </Button>
          </motion.form>
        ) : (
          <motion.div
            key="file-form"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex flex-col gap-3"
          >
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all",
                isDragging
                  ? "border-teal-500/70 bg-teal-500/10"
                  : file
                    ? "border-teal-500/40 bg-teal-500/5"
                    : "border-white/15 bg-white/3 hover:border-white/30 hover:bg-white/5"
              )}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,video/*,.mp4,.mkv,.avi,.mov,.webm,.mp3,.m4a,.wav,.flac,.ogg,.opus"
                className="hidden"
                onChange={(e) => { if (e.target.files?.[0]) setFile(e.target.files[0]); }}
              />
              {file ? (
                <div className="flex items-center justify-center gap-3">
                  {file.type.startsWith("video") ? (
                    <FileVideo className="w-8 h-8 text-teal-400 shrink-0" />
                  ) : (
                    <FileAudio className="w-8 h-8 text-teal-400 shrink-0" />
                  )}
                  <div className="text-left min-w-0">
                    <p className="text-white font-semibold text-sm truncate">{file.name}</p>
                    <p className="text-white/40 text-xs mt-0.5">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFile(null); reset(); }}
                    className="ml-auto p-1 rounded-lg hover:bg-white/10 text-white/40 hover:text-white/80 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <>
                  <Upload className="w-10 h-10 text-white/20 mx-auto mb-3" />
                  <p className="text-white/60 font-medium text-sm">Drop a video or audio file here</p>
                  <p className="text-white/30 text-xs mt-1">MP4, MKV, MOV, AVI, WebM, MP3, M4A, WAV, FLAC — up to 500MB</p>
                </>
              )}
            </div>

            <Button
              onClick={handleFileUpload}
              disabled={!file || (isRunning as boolean)}
              className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl shadow-[0_0_16px_rgba(20,184,166,0.25)] w-full sm:w-auto sm:self-end"
            >
              {isRunning ? (
                <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Processing...</span>
              ) : (
                "Generate SRT"
              )}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Progress panel */}
      <AnimatePresence>
        {jobStatus && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="glass-panel rounded-2xl p-5 flex flex-col gap-4"
          >
            {/* Step indicators */}
            <div className="flex items-center gap-2">
              {stepOrder.map((step, i) => {
                const currentIdx = stepOrder.indexOf(jobStatus ?? "audio");
                const isDone = i < currentIdx || jobStatus === "done";
                const isActive = i === currentIdx && jobStatus !== "done" && jobStatus !== "error";
                return (
                  <React.Fragment key={step}>
                    <div className={cn(
                      "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border transition-all",
                      isDone ? "bg-teal-500/30 border-teal-500/50 text-teal-300"
                        : isActive ? "bg-teal-600/20 border-teal-500/40 text-teal-400 animate-pulse"
                          : "bg-white/5 border-white/10 text-white/20"
                    )}>
                      {isDone ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
                    </div>
                    {i < stepOrder.length - 1 && (
                      <div className={cn("flex-1 h-[2px] rounded transition-all", isDone ? "bg-teal-500/40" : "bg-white/8")} />
                    )}
                  </React.Fragment>
                );
              })}
            </div>

            {/* Status message */}
            {jobStatus === "error" ? (
              <div className="flex items-start gap-3 text-red-300">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Failed</p>
                  <p className="text-red-300/70 text-sm mt-0.5">{jobError}</p>
                </div>
              </div>
            ) : jobStatus === "done" ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-teal-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-teal-300 font-semibold text-sm">Subtitles generated successfully!</p>
                  <p className="text-white/40 text-xs mt-0.5">{srtContent?.split("\n\n").filter(Boolean).length ?? 0} subtitle entries</p>
                </div>
                <Button
                  onClick={downloadSrt}
                  className="bg-teal-600 hover:bg-teal-500 text-white rounded-xl px-5 shrink-0 shadow-[0_0_14px_rgba(20,184,166,0.3)]"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Download SRT
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-teal-400 animate-spin shrink-0" />
                <div>
                  <p className="text-white/80 font-medium text-sm">{jobMessage || STEP_LABELS[jobStatus ?? "audio"] || "Processing..."}</p>
                  <p className="text-white/30 text-xs mt-0.5">This may take 1-3 minutes for long videos</p>
                </div>
              </div>
            )}

            {/* SRT preview */}
            {srtContent && (
              <div className="rounded-xl bg-black/30 border border-white/8 p-4 max-h-48 overflow-y-auto">
                <pre className="text-xs text-white/50 whitespace-pre-wrap font-mono leading-relaxed">
                  {srtContent.split("\n\n").slice(0, 8).join("\n\n")}
                  {srtContent.split("\n\n").length > 8 && "\n\n..."}
                </pre>
              </div>
            )}

            {/* Reset */}
            {(jobStatus === "done" || jobStatus === "error") && (
              <button
                onClick={reset}
                className="text-xs text-white/30 hover:text-white/60 transition-colors self-center"
              >
                Start over
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
