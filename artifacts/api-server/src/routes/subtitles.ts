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
type JobStatus = "pending" | "audio" | "uploading" | "generating" | "done" | "error";
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

function buildSrtPrompt(language: string): string {
  const langNote =
    language === "auto"
      ? "The audio may be in any language — transcribe it in the original language spoken, do NOT translate."
      : `The audio is in ${language}. Transcribe it in ${language} exactly as spoken — do NOT translate.`;

  return `You are a professional subtitle creator. Listen to the ENTIRE audio carefully and produce a complete, accurate SRT subtitle file.

${langNote}

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

    // Step: Upload to Gemini Files API
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

    // Step: Generate SRT
    job.status = "generating";
    job.message = "AI is transcribing audio...";

    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri: fileInfo.uri } },
            { text: buildSrtPrompt(language) },
          ],
        },
      ],
      config: { temperature: 0.1, maxOutputTokens: 65536 },
    });

    const srt = result.text?.trim() ?? "";
    if (!srt) {
      job.status = "error";
      job.error = "AI returned an empty transcript — please try again";
      return;
    }

    const cleaned = srt
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/i, "")
      .trim();

    job.status = "done";
    job.message = "Subtitles ready!";
    job.srt = cleaned;
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
