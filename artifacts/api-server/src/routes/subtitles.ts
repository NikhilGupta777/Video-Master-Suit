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
type JobStatus = "pending" | "audio" | "uploading" | "generating" | "correcting" | "translating" | "verifying" | "done" | "error";
interface SrtJob {
  status: JobStatus;
  message: string;
  srt?: string;
  error?: string;
  filename: string;
  createdAt: number;
  translateTo?: string;
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

  return `You are a professional subtitle creator. Listen to the ENTIRE audio from start to finish and produce a complete, accurate SRT subtitle file.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. You MUST transcribe ALL speech from 00:00:00 all the way to ${durationSrt}. Do NOT stop early. Even if there are quiet sections or pauses, continue listening — more speech follows.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts separated by colons
- CORRECT: 00:01:23,456  (hours:minutes:seconds,milliseconds)
- WRONG:   01:23,456     (missing hours — NEVER use this format)
- WRONG:   1:23,456      (missing hours — NEVER use this format)
- The hours part is ALWAYS required, even when it is 00
- Use COMMA for milliseconds separator (not dot)
- All timestamps MUST be within 00:00:00,000 to ${durationSrt},000

STRICT SRT FORMAT RULES:
1. Each entry has exactly 3 parts, followed by a blank line:
   (a) A sequential number (1, 2, 3 ...)
   (b) A timestamp line: HH:MM:SS,mmm --> HH:MM:SS,mmm
   (c) The spoken text — 1 to 2 lines, max ~42 characters per line
2. Each subtitle should cover 3-7 seconds of audio
3. Transcribe EVERY word spoken — do not skip, skip sections, or summarize anything
4. If there is a quiet section or pause, keep listening — do not stop — transcribe what comes after
5. For unclear words, make your best guess based on context and language
6. Do NOT translate — keep the original spoken language
7. Return ONLY the SRT content — no explanations, no markdown fences, no extra text

Example of CORRECT format (note all timestamps have HH:MM:SS,mmm):
1
00:00:01,000 --> 00:00:04,500
First line of speech here.

2
00:01:04,600 --> 00:01:08,200
Speech that starts at one minute four seconds.

3
00:10:22,300 --> 00:10:26,100
Speech near the ten-minute mark.

Now transcribe the ENTIRE audio from beginning to end:`;
}

function buildCorrectionPrompt(rawSrt: string, language: string, durationSrt: string): string {
  const langNote =
    language === "auto"
      ? "The audio and subtitles are in their original language — do NOT translate anything."
      : `The audio and subtitles are in ${language} — do NOT translate anything.`;

  return `You are an expert subtitle proofreader and corrector. I will give you an audio recording and a draft SRT subtitle file that was auto-generated from it.

${langNote}

AUDIO DURATION: The audio is exactly ${durationSrt} long. All timestamps MUST be within 00:00:00,000 to ${durationSrt},000. If you see any timestamp beyond ${durationSrt}, it is a hallucination — fix it.

CRITICAL TIMESTAMP FORMAT:
- Every timestamp MUST use HH:MM:SS,mmm format with ALL THREE parts (hours:minutes:seconds,milliseconds)
- CORRECT: 00:01:23,456  — WRONG: 01:23,456 (missing hours) — WRONG: 1:23,456 (missing hours)
- The hours part is ALWAYS required, even when it is 00

IMPORTANT: The draft SRT may be INCOMPLETE — it may only cover part of the audio. Listen to the ENTIRE audio from start to ${durationSrt} and ADD any speech that is missing from the draft. Do not stop at the last entry of the draft if there is more speech in the audio.

Your task: Listen to the ENTIRE audio, fix ALL errors in the SRT, and add any missing speech.

Common errors to fix:
- Wrong words (mishearings, similar-sounding words mixed up)
- Missing words or phrases that are clearly spoken but not in the SRT
- Hallucinated words (text in the SRT that is NOT actually spoken in the audio)
- Wrong word forms (e.g., wrong verb endings, missing particles/suffixes)
- Timestamp mismatches (subtitle appearing too early or too late)
- Timestamps using wrong format (MM:SS,mmm instead of HH:MM:SS,mmm — fix these)
- Timestamps that go BEYOND the audio duration
- MISSING ENTRIES: speech that occurs after the last SRT entry — add them

IMPORTANT RULES:
- Keep the exact same SRT format (number, timestamp, text, blank line)
- Re-number entries sequentially from 1 after adding missing entries
- Do NOT add translation or explanations
- Return ONLY the corrected and completed SRT content — no explanations, no markdown fences

Here is the draft SRT to correct and complete:
---
${rawSrt}
---

Now listen to the full audio from 00:00:00 to ${durationSrt} and return the fully corrected and completed SRT:`;
}

function buildTranslationPrompt(correctedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "its original language" : fromLanguage;
  return `You are a professional subtitle translator. I will give you an SRT subtitle file written in ${fromNote}. Translate the subtitle text into ${toLanguage}.

CRITICAL RULES:
1. Keep EVERY timestamp line EXACTLY as-is — do NOT change any HH:MM:SS,mmm timestamps
2. Keep EVERY entry number EXACTLY as-is
3. Keep the exact same SRT structure (number, timestamp, translated text, blank line)
4. Translate ONLY the subtitle text lines — nothing else
5. Produce natural, fluent ${toLanguage} — not a word-for-word literal translation
6. Preserve the meaning, tone, and context of the original speech
7. Keep names of people, places, and proper nouns as they are (or use the standard ${toLanguage} spelling)
8. Return ONLY the translated SRT — no explanations, no markdown fences, no extra text

Here is the SRT to translate:
---
${correctedSrt}
---

Now return the fully translated SRT in ${toLanguage}:`;
}

function buildTranslationVerifyPrompt(originalSrt: string, translatedSrt: string, fromLanguage: string, toLanguage: string): string {
  const fromNote = fromLanguage === "auto" ? "the original language" : fromLanguage;
  return `You are an expert bilingual subtitle proofreader. I will give you two SRT files: the ORIGINAL (in ${fromNote}) and a TRANSLATED version (in ${toLanguage}). Your task is to verify the translation and fix any errors.

Check every entry for:
- Mistranslations (wrong meaning)
- Missing content (original says something that is absent in the translation)
- Added content (translation says something not in the original)
- Unnatural or awkward ${toLanguage} phrasing
- Names/proper nouns that were incorrectly changed
- Timestamp or entry number changes (they must be identical to the original)

RULES:
- Keep ALL timestamps exactly as they appear in the original SRT — do NOT change them
- Keep ALL entry numbers exactly as they appear in the original SRT
- Fix ONLY the translation text — nothing else
- Return ONLY the corrected translated SRT — no explanations, no markdown fences

ORIGINAL SRT (${fromNote}):
---
${originalSrt}
---

TRANSLATED SRT (${toLanguage}) to verify and fix:
---
${translatedSrt}
---

Return the fully verified and corrected ${toLanguage} SRT:`;
}

// ── Normalize SRT timestamps ─────────────────────────────────────────────────
// Fixes two classes of Gemini timestamp mistakes:
//   1. Missing hours: "01:23,456" → "00:01:23,456"  (MM:SS,mmm → HH:MM:SS,mmm)
//   2. Single-digit parts: "00:1:2,700" → "00:01:02,700"
function normalizeTs(ts: string): string {
  const [timePart, ms = "000"] = ts.split(",");
  const parts = timePart.split(":");
  let h: string, m: string, s: string;
  if (parts.length === 3) {
    [h, m, s] = parts;
  } else if (parts.length === 2) {
    // MM:SS — Gemini omitted the hours component
    h = "00";
    [m, s] = parts;
  } else {
    // Just seconds — shouldn't happen but handle it
    h = "00"; m = "00"; s = parts[0];
  }
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}:${s.padStart(2, "0")},${ms.padStart(3, "0")}`;
}

function normalizeSrtTimestamps(srt: string): string {
  // Replace every timestamp line: "START --> END"
  return srt.replace(
    /^([\d:,]+)\s*-->\s*([\d:,]+)$/gm,
    (_m, start, end) => `${normalizeTs(start.trim())} --> ${normalizeTs(end.trim())}`,
  );
}

// ── Strip hallucinated entries at end of SRT ─────────────────────────────────
// When Gemini hits the token limit it sometimes repeats a word hundreds of times.
// Remove any entry whose text has a single unique word repeated >10 times.
function cleanupHallucinatedEntries(srt: string): string {
  const entries = srt.trim().split(/\n\n+/);
  const valid: string[] = [];
  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    if (lines.length < 3) continue;
    const text = lines.slice(2).join(" ");
    const words = text.trim().split(/\s+/);
    const unique = new Set(words);
    // Skip entry if >80% of words are the same word (and there are many words)
    if (words.length > 10 && unique.size <= 2) continue;
    // Also skip if the entry line doesn't start with a number
    if (!/^\d+$/.test(lines[0].trim())) continue;
    valid.push(entry.trim());
  }
  // Re-number the valid entries sequentially
  return valid
    .map((entry, i) => {
      const lines = entry.split("\n");
      lines[0] = String(i + 1);
      return lines.join("\n");
    })
    .join("\n\n") + "\n";
}

// ── Restore timestamps from original SRT into translated SRT ─────────────────
// Gemini sometimes reformats timestamps during translation (e.g. "00:10:50,066"
// becomes "10:50:000,000"). Since timestamps must NEVER change during translation,
// we overwrite every timestamp in the translated SRT with the corresponding
// timestamp from the original corrected SRT, matched by entry number.
function restoreTimestamps(originalSrt: string, translatedSrt: string): string {
  const parseEntries = (srt: string) => {
    return srt.trim().split(/\n\n+/).map((block) => {
      const lines = block.trim().split("\n");
      if (lines.length < 3) return null;
      const num = parseInt(lines[0].trim(), 10);
      if (isNaN(num)) return null;
      return { num, timestamp: lines[1].trim(), text: lines.slice(2).join("\n") };
    }).filter((e): e is { num: number; timestamp: string; text: string } => e !== null);
  };

  const origEntries = parseEntries(originalSrt);
  const transEntries = parseEntries(translatedSrt);

  const timestampMap = new Map<number, string>();
  for (const e of origEntries) timestampMap.set(e.num, e.timestamp);

  const restored = transEntries.map((e) => {
    const ts = timestampMap.get(e.num) ?? e.timestamp;
    return `${e.num}\n${ts}\n${e.text}`;
  });

  return restored.join("\n\n") + "\n";
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
  translateTo?: string,
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
      model: "gemini-2.5-pro",
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri } },
            { text: buildSrtPrompt(language, durationSrt) },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 65536,
      },
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
      model: "gemini-2.5-pro",
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { mimeType, fileUri } },
            { text: buildCorrectionPrompt(cleanedRaw, language, durationSrt) },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: 65536,
      },
    });

    const correctedSrt = secondPass.text?.trim() ?? "";

    // If the correction pass fails or returns garbage, fall back to the first pass
    const rawFinal = (correctedSrt && correctedSrt.length > 10)
      ? correctedSrt.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim()
      : cleanedRaw;

    // Normalize malformed timestamps then strip any hallucinated tail entries
    const correctedFinalSrt = cleanupHallucinatedEntries(normalizeSrtTimestamps(rawFinal));

    // Step 4 (optional): Translate the corrected SRT
    if (translateTo && translateTo !== "none") {
      job.status = "translating";
      job.message = `Translating subtitles to ${translateTo}...`;

      const translationPass = await genAI.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [
          {
            role: "user",
            parts: [{ text: buildTranslationPrompt(correctedFinalSrt, language, translateTo) }],
          },
        ],
        config: {
          temperature: 0.2,
          maxOutputTokens: 65536,
        },
      });

      const translatedRaw = translationPass.text?.trim() ?? "";
      const translatedClean = translatedRaw.length > 10
        ? translatedRaw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim()
        : correctedFinalSrt;
      // Always restore original timestamps — Gemini sometimes garbles them during translation
      const translatedSrt = restoreTimestamps(correctedFinalSrt, translatedClean);

      // Step 5: Verify the translation (text-only, no audio needed)
      job.status = "verifying";
      job.message = `Verifying ${translateTo} translation...`;

      const verifyPass = await genAI.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [
          {
            role: "user",
            parts: [{ text: buildTranslationVerifyPrompt(correctedFinalSrt, translatedSrt, language, translateTo) }],
          },
        ],
        config: {
          temperature: 0.1,
          maxOutputTokens: 65536,
        },
      });

      const verifiedRaw = verifyPass.text?.trim() ?? "";
      const verifiedClean = verifiedRaw.length > 10
        ? verifiedRaw.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim()
        : translatedSrt;
      // Restore timestamps again after verification pass (same Gemini behaviour)
      const verifiedSrt = restoreTimestamps(correctedFinalSrt, verifiedClean);

      const finalSrt = cleanupHallucinatedEntries(normalizeSrtTimestamps(verifiedSrt));
      job.status = "done";
      job.message = "Subtitles ready!";
      job.srt = finalSrt;
    } else {
      job.status = "done";
      job.message = "Subtitles ready!";
      job.srt = correctedFinalSrt;
    }
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
  const { url, language = "auto", translateTo } = req.body as { url: string; language?: string; translateTo?: string };

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
  const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;

  jobs.set(jobId, {
    status: "audio",
    message: "Downloading audio from YouTube...",
    filename: "subtitles.srt",
    createdAt: Date.now(),
    translateTo: translateLang,
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

      await processAudio(jobId, audioFile, language, "subtitles.srt", translateLang, () => {
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
    const translateTo: string | undefined = (req.body as any).translateTo;
    const translateLang = translateTo && translateTo !== "none" ? translateTo : undefined;
    const baseName = req.file.originalname.replace(/\.[^.]+$/, "");
    const srtFilename = `${baseName}-subtitles.srt`;
    const jobId = randomUUID();

    jobs.set(jobId, {
      status: "uploading",
      message: "Uploading to AI...",
      filename: srtFilename,
      createdAt: Date.now(),
      translateTo: translateLang,
    });

    res.json({ jobId });

    // Process in background — delete the temp file after use
    (async () => {
      await processAudio(jobId, req.file!.path, language, srtFilename, translateLang, () => {
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
