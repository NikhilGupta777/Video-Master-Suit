import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger";

const router = Router();

const PYTHON_BIN = process.env.PYTHON_BIN ?? "uv";
const PYTHON_ENV = { ...process.env, PYTHONUNBUFFERED: "1" };
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/tmp/ytgrabber";

// ── In-memory job store ──────────────────────────────────────────────────────
type JobStatus = "pending" | "audio" | "uploading" | "generating" | "correcting" | "done" | "error";
interface SrtJob {
  status: JobStatus;
  message: string;
  srt?: string;
  error?: string;
  filename: string;
  createdAt: number;
}
const jobs = new Map<string, SrtJob>();

// Clean up jobs older than 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

// Disk storage for uploaded files
const uploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = join(DOWNLOAD_DIR, "srt-uploads");
    mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.split(".").pop() ?? "bin";
    cb(null, `${randomUUID()}.${ext}`);
  },
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function audioMimeType(ext: string): string {
  const map: Record<string, string> = {
    m4a: "audio/mp4", mp4: "audio/mp4", webm: "audio/webm",
    ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg",
    flac: "audio/flac", wav: "audio/wav", aac: "audio/aac",
    mkv: "video/x-matroska", avi: "video/x-msvideo", mov: "video/quicktime",
  };
  return map[ext.toLowerCase()] ?? "audio/mpeg";
}

function isAiConfigured(): boolean {
  return !!(
    (process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY) ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY
  );
}

function getGenAI(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function buildSrtPrompt(language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio may be in any language — transcribe it in the original language spoken, do NOT translate."
      : `The audio is in ${language}. Transcribe it in ${language} exactly as spoken — do NOT translate.`;

  return `You are a professional subtitle creator. Listen to the ENTIRE audio carefully and produce a complete, accurate SRT subtitle file.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. All timestamps MUST be within 00:00:00,000 to ${durationSrt},000. Do NOT generate any timestamp beyond ${durationSrt}.

STRICT SRT FORMAT RULES:
1. Each entry has exactly 3 parts, followed by a blank line:
   (a) A sequential number (1, 2, 3 ...)
   (b) A timestamp: HH:MM:SS,mmm --> HH:MM:SS,mmm  (use COMMA for milliseconds, NOT dot)
   (c) The spoken text — 1 to 2 lines, max ~42 characters per line
2. Each subtitle should cover 3-7 seconds of audio
3. Transcribe EVERY word — do not skip or summarize anything
4. For unclear words, make your best guess based on context and language
5. Do NOT translate — keep the original spoken language
6. Return ONLY the SRT content — no explanations, no markdown fences, no extra text

Example of correct format:
1
00:00:01,000 --> 00:00:04,500
First line of speech here.

2
00:00:04,600 --> 00:00:08,200
Second subtitle entry text.

Now transcribe the entire audio:`;
}

function buildCorrectionPrompt(rawSrt: string, language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio and subtitles are in their original language — do NOT translate anything."
      : `The audio and subtitles are in ${language} — do NOT translate anything.`;

  return `You are an expert subtitle proofreader and corrector. I will give you an audio recording and a draft SRT subtitle file that was auto-generated from it.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. All timestamps MUST be within 00:00:00,000 to ${durationSrt},000. If you see any timestamp beyond ${durationSrt}, it is a hallucination — fix it to match the actual audio timing.

Your task: Listen to the ENTIRE audio very carefully, then fix ALL errors in the SRT file.

Common errors to fix:
- Wrong words (mishearings, similar-sounding words mixed up)
- Missing words or phrases that are clearly spoken but not in the SRT
- Hallucinated words (text in the SRT that is NOT actually spoken in the audio)
- Incorrect use of foreign language words when the correct native word was spoken (e.g., English "to" written instead of the correct native particle)
- Wrong word forms (e.g., wrong verb endings, missing particles/suffixes)
- Filler sounds or stumbles mistakenly transcribed as real words
- Timestamp mismatches (subtitle appearing too early or too late by more than 0.5 seconds)
- Timestamps that go BEYOND the audio duration (hallucinated timestamps — correct them)
- Incorrect word order

IMPORTANT RULES:
- Keep the exact same SRT format (number, timestamp, text, blank line)
- Preserve all correct entries exactly as they are — only change what is wrong
- Fix any timestamp that exceeds ${durationSrt}
- Do NOT add translation or explanations
- Do NOT summarize or shorten any entries
- Return ONLY the corrected SRT content — no explanations, no markdown fences, no extra text

Here is the draft SRT to correct:
---
${rawSrt}
---

Now listen to the audio and return the fully corrected SRT:`;
}

// ── Normalize SRT timestamps ─────────────────────────────────────────────────
// Fixes single-digit minutes/seconds like "01:00:2,700" → "01:00:02,700"
function normalizeSrtTimestamps(srt: string): string {
  return srt.replace(
    /(\d{2}):(\d{1,2}):(\d{1,2}),(\d{3})/g,
    (_m, h, mm, ss, ms) =>
      `${h}:${mm.padStart(2, "0")}:${ss.padStart(2, "0")},${ms}`,
  );
}

// ── Get audio duration via ffprobe ───────────────────────────────────────────
function getAudioDuration(audioPath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("close", () => {
      const secs = parseFloat(out.trim());
      resolve(isNaN(secs) ? 0 : secs);
    });
    proc.on("error", () => resolve(0));
  });
}

/** Convert seconds → HH:MM:SS for use in prompts */
function secondsToSrtTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ── Core processing function ─────────────────────────────────────────────────
async function processAudio(
  jobId: string,
  audioPath: string,
  language: string,
  filename: string,
  cleanup?: () => void,
) {
  const job = jobs.get(jobId);
  if (!job) return;

  const genAI = getGenAI();
  if (!genAI) {
    job.status = "error";
    job.error = "Gemini API key not configured";
    return;
  }

  let geminiFileName: string | null = null;

  try {
    const ext = audioPath.split(".").pop()!.toLowerCase();
    const mimeType = audioMimeType(ext);
    const audioBuffer = readFileSync(audioPath);
    const audioBlob = new Blob([audioBuffer], { type: mimeType });

    // Measure exact audio duration so we can tell Gemini to stay within bounds
    const durationSecs = await getAudioDuration(audioPath);
    const durationSrt = durationSecs > 0 ? secondsToSrtTime(durationSecs) : "99:59:59";
    logger.info({ durationSecs, durationSrt }, "Audio duration measured");

    // Step 1: Upload to Gemini Files API
    job.status = "uploading";
    job.message = "Uploading audio to AI...";

    const uploadResult = await genAI.files.upload({
      file: audioBlob,
      config: { mimeType, displayName: filename },
    });
    geminiFileName = uploadResult.name!;

    // Poll until ACTIVE (up to 3 min)
    let fileInfo: any = uploadResult;
    let attempts = 0;
    while (fileInfo.state === "PROCESSING" && attempts < 90) {
      await new Promise((r) => setTimeout(r, 2000));
      fileInfo = await genAI.files.get({ name: geminiFileName });
      attempts++;
    }

    if (fileInfo.state !== "ACTIVE") {
      job.status = "error";
      job.error = "Audio processing timed out — please try again";
      return;
    }

    const fileUri: string = fileInfo.uri;

    // Step 2: Generate raw SRT
    job.status = "generating";
    job.message = "AI is transcribing audio...";

    const firstPass = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri } },
            { text: buildSrtPrompt(language, durationSrt) },
          ],
        },
      ],
      config: { temperature: 0.1, maxOutputTokens: 65536 },
    });

    const rawSrt = firstPass.text?.trim() ?? "";
    if (!rawSrt) {
      job.status = "error";
      job.error = "AI returned an empty transcript — please try again";
      return;
    }

    const cleanedRaw = rawSrt
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

    // Step 3: Auto-correction pass — same audio + draft SRT → Gemini corrects mistakes
    job.status = "correcting";
    job.message = "AI is auto-correcting errors...";

    const secondPass = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri } },
            { text: buildCorrectionPrompt(cleanedRaw, language, durationSrt) },
          ],
        },
      ],
      config: { temperature: 0.1, maxOutputTokens: 65536 },
    });

    const correctedSrt = secondPass.text?.trim() ?? "";

    // If the correction pass fails or returns garbage, fall back to the first pass
    const rawFinal = (correctedSrt && correctedSrt.length > 10)
      ? correctedSrt.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim()
      : cleanedRaw;

    // Normalize any malformed timestamps (e.g. single-digit seconds "01:00:2,700")
    const finalSrt = normalizeSrtTimestamps(rawFinal);

    job.status = "done";
    job.message = "Subtitles ready!";
    job.srt = finalSrt;
  } catch (err: any) {
    logger.error({ err }, "SRT generation error");
    job.status = "error";
    job.error = err.message || "Failed to generate subtitles";
  } finally {
    if (geminiFileName) {
      try { await genAI.files.delete({ name: geminiFileName }); } catch {}
    }
    if (cleanup) {
      try { cleanup(); } catch {}
    }
  }
}

// ── Route: Generate from YouTube URL ────────────────────────────────────────
router.post("/subtitles/generate", async (req: Request, res: Response) => {
  const { url, language = "auto" } = req.body as { url: string; language?: string };

  if (!url?.trim()) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
    return;
  }

  const jobId = randomUUID();
  const audioDir = join(DOWNLOAD_DIR, `srt-yt-${jobId}`);

  jobs.set(jobId, {
    status: "audio",
    message: "Downloading audio from YouTube...",
    filename: "subtitles.srt",
    createdAt: Date.now(),
  });

  res.json({ jobId });

  // Process in background
  (async () => {
    const job = jobs.get(jobId)!;
    try {
      mkdirSync(audioDir, { recursive: true });
      const audioPattern = join(audioDir, "audio.%(ext)s");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(PYTHON_BIN, [
          "run", "yt-dlp",
          "-f", "bestaudio[ext=m4a]/bestaudio[ext=mp4]/bestaudio",
          "--no-playlist", "--no-warnings",
          "-o", audioPattern, url.trim(),
        ], { env: PYTHON_ENV });
        let stderr = "";
        proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) => {
          code === 0 ? resolve() : reject(new Error(stderr.slice(-400)));
        });
        proc.on("error", reject);
      });

      const audioFiles = existsSync(audioDir) ? readdirSync(audioDir) : [];
      const audioFile = audioFiles
        .map((f) => join(audioDir, f))
        .find((f) => /\.(m4a|mp4|webm|ogg|opus|mp3|flac|wav|aac)$/i.test(f));

      if (!audioFile) {
        job.status = "error";
        job.error = "Could not download audio — check the URL and try again";
        return;
      }

      await processAudio(jobId, audioFile, language, "subtitles.srt", () => {
        try { rmSync(audioDir, { recursive: true }); } catch {}
      });
    } catch (err: any) {
      logger.error({ err }, "SRT YouTube download error");
      job.status = "error";
      job.error = err.message || "Failed to download audio";
      try { rmSync(audioDir, { recursive: true }); } catch {}
    }
  })();
});

// ── Route: Generate from uploaded file ──────────────────────────────────────
router.post(
  "/subtitles/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    if (!isAiConfigured()) {
      res.status(503).json({ error: "AI not configured — add GEMINI_API_KEY" });
      return;
    }

    const language: string = (req.body as any).language ?? "auto";
    const baseName = req.file.originalname.replace(/\.[^.]+$/, "");
    const srtFilename = `${baseName}-subtitles.srt`;
    const jobId = randomUUID();

    jobs.set(jobId, {
      status: "uploading",
      message: "Uploading to AI...",
      filename: srtFilename,
      createdAt: Date.now(),
    });

    res.json({ jobId });

    // Process in background — delete the temp file after use
    (async () => {
      await processAudio(jobId, req.file!.path, language, srtFilename, () => {
        try { rmSync(req.file!.path); } catch {}
      });
    })();
  },
);

// ── Route: Poll job status ────────────────────────────────────────────────────
router.get("/subtitles/status/:jobId", (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  if (job.status === "done") {
    res.json({
      status: job.status,
      message: job.message,
      filename: job.filename,
      srt: job.srt,
    });
  } else if (job.status === "error") {
    res.json({ status: job.status, error: job.error });
  } else {
    res.json({ status: job.status, message: job.message });
  }
});

export default router;
