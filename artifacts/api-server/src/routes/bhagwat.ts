import { Router, type Request, type Response } from "express";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  rmdirSync,
  statSync,
} from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleGenAI, Modality } from "@google/genai";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import multer from "multer";
import { AssemblyAI } from "assemblyai";

const router: Router = Router();

// Make yt-dlp (installed via uv sync) visible to the system Python.
// process.cwd() is always the workspace root (both dev and production).
const _workspaceRoot = process.env.REPL_HOME ?? process.cwd();

// Dynamically resolve the correct python3.x site-packages directory so this
// works regardless of which Python minor version is active in production.
function resolvePythonSitePackages(workspaceRoot: string): string {
  const libRoot = join(workspaceRoot, ".pythonlibs", "lib");
  try {
    const entries = readdirSync(libRoot);
    const pyDir = entries.find((e) => /^python3\.\d+$/.test(e));
    if (pyDir) return join(libRoot, pyDir, "site-packages");
  } catch {}
  return join(libRoot, "python3.11", "site-packages"); // safe fallback
}

const PYTHON_ENV = {
  ...process.env,
  PATH: `${_workspaceRoot}/.pythonlibs/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
  PYTHONPATH: resolvePythonSitePackages(_workspaceRoot),
};

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
const BHAGWAT_RENDERED_DIR = join(DOWNLOAD_DIR, "bhagwat_rendered");
const BHAGWAT_TMP_DIR = join(DOWNLOAD_DIR, "bhagwat_tmp");
const BHAGWAT_UPLOADS_DIR = join(DOWNLOAD_DIR, "bhagwat_uploads");

for (const d of [BHAGWAT_RENDERED_DIR, BHAGWAT_TMP_DIR, BHAGWAT_UPLOADS_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── Multer — audio file uploads ───────────────────────────────────────────────
const audioUploadStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BHAGWAT_UPLOADS_DIR),
  filename: (_req, _file, cb) => {
    const ext = _file.originalname.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? ".mp3";
    cb(null, `${randomUUID()}${ext}`);
  },
});
const audioUpload = multer({
  storage: audioUploadStorage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB (AssemblyAI max)
  fileFilter: (_req, file, cb) => {
    const okExt = /\.(mp3|wav|m4a|mp4|ogg|webm|flac|aac|opus|wma|amr)$/i.test(file.originalname);
    const okMime = file.mimetype.startsWith("audio/") || file.mimetype.startsWith("video/");
    okExt || okMime ? cb(null, true) : cb(new Error("Only audio/video files are supported"));
  },
});

// ── Uploaded audio store ──────────────────────────────────────────────────────
interface UploadedAudio {
  path: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number; // filled after AssemblyAI transcription
  createdAt: number;
}
const uploadedAudios = new Map<string, UploadedAudio>();

// Sweep old uploads after 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, audio] of uploadedAudios.entries()) {
    if (audio.createdAt < cutoff) {
      try { unlinkSync(audio.path); } catch {}
      uploadedAudios.delete(id);
    }
  }
}, 30 * 60 * 1000);

// ── Timeline segment — AI decides everything per segment ──────────────────────
export interface TimelineSegment {
  startSec: number;
  endSec: number;
  isBhajan: boolean;
  imageChangeEvery: number; // seconds between image changes within this segment — AI decides
  description: string; // brief human-readable label shown in UI
  imagePrompt: string; // specific Gemini image-gen prompt for this exact story moment
}

// Use Replit's built-in GOOGLE_API_KEY as fallback when GEMINI_API_KEY is not set
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
}
// Remove GOOGLE_API_KEY so the @google/generative-ai library doesn't log
// "Both GOOGLE_API_KEY and GEMINI_API_KEY are set" warnings
delete process.env.GOOGLE_API_KEY;

// ── Gemini image generation ───────────────────────────────────────────────────
function getImageGenClient(): GoogleGenAI {
  // Prefer direct API key — supports latest models like gemini-3.1-flash-image-preview
  if (process.env.GEMINI_API_KEY) {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  // Fallback to Replit AI integration
  const baseUrl = process.env.AI_INTEGRATIONS_GEMINI_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
  if (baseUrl && apiKey) {
    return new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: "", baseUrl },
    });
  }
  throw new Error(
    "No Gemini API key configured. Set GEMINI_API_KEY in secrets.",
  );
}

async function generateImage(
  prompt: string,
  outputPath: string,
): Promise<void> {
  const imageAI = getImageGenClient();

  const fullPrompt = `Create a UHD, cinematic, high-quality PHOTOREALISTIC image suitable for  video content with a spiritual and reverential tone.
The image should visually represent: ${prompt}

CRITICAL STYLE REQUIREMENTS (override any conflicting instructions):
- MUST be photorealistic - no abstract, digital, animated, or illustrated styles
- Use realistic lighting, natural depth of field, strong composition, and emotionally appropriate atmosphere
- Style: Professional, cinematic realism, documentary-grade, clean and context-aware
- Must look authentic, timeless, and suitable for high-quality B-roll usage
- Consistent with other images in the same video project
No subtitles, logos, watermarks, UI elements`;

  const response = await imageAI.models.generateContent({
    model: "gemini-3.1-flash-image-preview",
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
      imageConfig: {
        aspectRatio: "16:9",
        imageSize: "2K",
      } as any,
    },
  });

  const candidate = response.candidates?.[0];
  if (!candidate) throw new Error("Gemini returned no candidate");

  const imagePart = candidate.content?.parts?.find(
    (part: any) => part.inlineData?.data,
  );
  if (!imagePart?.inlineData?.data)
    throw new Error("Gemini returned no image data");

  writeFileSync(outputPath, Buffer.from(imagePart.inlineData.data, "base64"));
}

// Generate images for all segments — 1 per segment
async function generateAllSegmentImages(
  genAI: GoogleGenerativeAI,
  segments: TimelineSegment[],
  imgDir: string,
  onProgress: (done: number, total: number, msg: string) => void,
): Promise<string[][]> {
  // Build task list: each task is one image generation
  interface Task {
    segIdx: number;
    imgIdx: number;
    prompt: string;
    path: string;
  }
  const tasks: Task[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segDur = seg.endSec - seg.startSec;
    // Honour imageChangeEvery: generate one image per interval, capped at 6
    // so a long gap-filler segment doesn't spawn dozens of identical images.
    const count = Math.min(6, Math.max(1, Math.round(segDur / Math.max(1, seg.imageChangeEvery))));
    for (let j = 0; j < count; j++) {
      tasks.push({
        segIdx: i,
        imgIdx: j,
        prompt: seg.imagePrompt,
        path: join(imgDir, `seg_${i}_${j}.png`),
      });
    }
  }

  // Result: imagePaths[segIdx] = array of file paths
  const imagePaths: string[][] = segments.map(() => []);
  let done = 0;
  const total = tasks.length;

  // Process with concurrency = 4
  const CONCURRENCY = 4;
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (task) => {
        try {
          await generateImage(task.prompt, task.path);
          imagePaths[task.segIdx].push(task.path);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(
            `[bhagwat/render] Image gen failed (seg ${task.segIdx}/${task.imgIdx}):`,
            errMsg,
          );
          // Retry with a simpler fallback prompt
          const fallback = `${task.prompt}. MUST be photorealistic — no abstract, digital, animated, or illustrated styles`;
          try {
            await generateImage(fallback, task.path);
            imagePaths[task.segIdx].push(task.path);
          } catch (err2) {
            const errMsg2 = err2 instanceof Error ? err2.message : String(err2);
            console.error(
              `[bhagwat/render] Fallback image gen also failed (seg ${task.segIdx}/${task.imgIdx}):`,
              errMsg2,
            );
            // Skip this image slot — will use neighbor's image
          }
        }
        done++;
        onProgress(done, total, segments[task.segIdx].description);
      }),
    );
  }

  // Fill any empty pools with a neighbor's images so concat never has gaps
  for (let i = 0; i < imagePaths.length; i++) {
    if (imagePaths[i].length === 0) {
      // Find nearest segment with images
      for (let d = 1; d < imagePaths.length; d++) {
        if (i - d >= 0 && imagePaths[i - d].length > 0) {
          imagePaths[i] = imagePaths[i - d];
          break;
        }
        if (i + d < imagePaths.length && imagePaths[i + d].length > 0) {
          imagePaths[i] = imagePaths[i + d];
          break;
        }
      }
    }
  }

  return imagePaths;
}

// Base args: mweb is most reliable from cloud IPs in 2026; tv_embedded/android/ios are fallbacks.
// Includes retry logic, socket timeout, and full browser headers to bypass bot detection.
const YTDLP_BASE_ARGS = [
  "--extractor-args",
  "youtube:player_client=mweb,web,tv_embedded,android,ios",
  "--retries", "3",
  "--fragment-retries", "3",
  "--extractor-retries", "3",
  "--socket-timeout", "30",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// Subtitle-safe args: use mweb/android only (no tv_embedded — it breaks subtitle fetching)
const YTDLP_SUBS_ARGS = [
  "--extractor-args",
  "youtube:player_client=mweb,android,ios",
  "--retries", "3",
  "--extractor-retries", "3",
  "--socket-timeout", "30",
  "--add-headers",
  [
    "Accept-Language:en-US,en;q=0.9",
    "Referer:https://www.youtube.com/",
    "Origin:https://www.youtube.com",
  ].join(";"),
  "--user-agent",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// ── yt-dlp helpers ────────────────────────────────────────────────────────────
function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "",
      err = "";
    const proc = spawn("python3", ["-m", "yt_dlp", ...YTDLP_BASE_ARGS, ...args], {
      env: PYTHON_ENV,
    });
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) =>
      code === 0
        ? resolve(out.trim())
        : reject(new Error(err.slice(-1000) || `yt-dlp exited ${code}`)),
    );
  });
}

function runYtDlpForSubs(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "",
      err = "";
    const proc = spawn("python3", ["-m", "yt_dlp", ...YTDLP_SUBS_ARGS, ...args], {
      env: PYTHON_ENV,
    });
    proc.stdout.on("data", (d) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d) => {
      err += d.toString();
    });
    proc.on("close", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-500))),
    );
  });
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    get(url, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── VTT / transcript helpers ──────────────────────────────────────────────────
interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}
function vttTimeToSec(t: string): number {
  const p = t.split(":");
  return p.length === 3
    ? parseFloat(p[0]) * 3600 + parseFloat(p[1]) * 60 + parseFloat(p[2])
    : parseFloat(p[0]) * 60 + parseFloat(p[1]);
}
function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const tl = lines.find((l) => l.includes("-->"));
    if (!tl) continue;
    const [startStr] = tl.split("-->").map((s) => s.trim().split(" ")[0]);
    const endStr = tl.split("-->")[1].trim().split(" ")[0];
    const text = lines
      .filter((l) => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map((l) => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text)
      cues.push({
        startSec: vttTimeToSec(startStr),
        endSec: vttTimeToSec(endStr),
        text,
      });
  }
  return cues;
}
function cuesToText(cues: VttCue[]): string {
  return cues
    .map((c) => {
      const mm = Math.floor(c.startSec / 60),
        ss = Math.floor(c.startSec % 60);
      return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}
function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const lines = transcript.split("\n").filter(Boolean);
  const targetCount = Math.floor(maxChars / 85);
  if (lines.length <= targetCount) return transcript.slice(0, maxChars);
  const step = lines.length / targetCount;
  const out: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    const l = lines[Math.floor(i * step)];
    if (l) out.push(l);
  }
  return `[Transcript sampled from ${lines.length} total lines]\n${out.join("\n")}`;
}
function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
function pickBestSubtitleUrl(
  subs: Record<string, any[]>,
  autoCaps: Record<string, any[]>,
  videoLang?: string,
): string | null {
  const priority = videoLang ? [videoLang, "hi", "en"] : ["hi", "en"];
  for (const pool of [subs, autoCaps]) {
    for (const lang of priority) {
      const list = Object.entries(pool).find(
        ([k]) => k === lang || k.startsWith(lang + "-"),
      )?.[1];
      if (list?.length) {
        const vtt = list.find((f: any) => f.ext === "vtt") ?? list[0];
        if (vtt?.url) return vtt.url;
      }
    }
  }
  return null;
}

// ── Analysis job store ────────────────────────────────────────────────────────
interface AnalysisJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: {
    timeline: TimelineSegment[];
    videoDuration: number;
    videoTitle: string;
  };
  error?: string;
  createdAt: number;
}
const analysisJobs = new Map<string, AnalysisJob>();

// Clean up completed/failed analysis jobs older than 1 hour (memory leak fix)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of analysisJobs.entries()) {
    if (job.createdAt < cutoff) analysisJobs.delete(id);
  }
}, 30 * 60 * 1000);

// ── Password Auth ─────────────────────────────────────────────────────────────
// The password is stored server-side in BHAGWAT_PASSWORD env var so it is
// never exposed in client-side JavaScript.
router.post("/bhagwat/auth", (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
  const expected =
    process.env.BHAGWAT_PASSWORD ?? "bhagwatnarrationvideos@clips2026";
  if (!password || password !== expected) {
    res.status(401).json({ ok: false, message: "Incorrect password" });
    return;
  }
  res.json({ ok: true });
});

router.post("/bhagwat/analyze", async (req: Request, res: Response) => {
  const { url, mode, clipStartSec, clipEndSec } = req.body as {
    url: string;
    mode?: "smart" | "full";
    clipStartSec?: number;
    clipEndSec?: number;
  };
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  const jobId = randomUUID();
  const job: AnalysisJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  analysisJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatAnalysis(jobId, job, url, mode ?? "full", clipStartSec, clipEndSec).catch(() => {});
});

router.get("/bhagwat/analyze-status/:jobId", (req: Request, res: Response) => {
  const job = analysisJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") {
    send("done", job.result!);
    res.end();
    return;
  }
  if (job.status === "error") {
    send("jobError", { message: job.error });
    res.end();
    return;
  }
  job.emitter.on("step", (d) => send("step", d));
  job.emitter.on("done", (d) => {
    send("done", d);
    res.end();
  });
  job.emitter.on("jobError", (d) => {
    send("jobError", d);
    res.end();
  });
  req.on("close", () => job.emitter.removeAllListeners());
});

// ── Plan review ───────────────────────────────────────────────────────────────
interface ReviewJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  createdAt: number;
}
const reviewJobs = new Map<string, ReviewJob>();

setInterval(
  () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, job] of reviewJobs.entries()) {
      if (job.createdAt < cutoff) reviewJobs.delete(id);
    }
  },
  30 * 60 * 1000,
);

router.post("/bhagwat/review-plan", (req: Request, res: Response) => {
  const { timeline, videoTitle, videoDuration } = req.body as {
    timeline: TimelineSegment[];
    videoTitle: string;
    videoDuration: number;
  };
  if (!Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "timeline is required" });
    return;
  }
  const jobId = randomUUID();
  const job: ReviewJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  reviewJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatReview(
    jobId,
    job,
    timeline,
    videoTitle ?? "",
    videoDuration ?? 0,
  ).catch(() => {});
});

router.get("/bhagwat/review-status/:jobId", (req: Request, res: Response) => {
  const job = reviewJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  job.emitter.on("chunk", (d) => send("chunk", d));
  job.emitter.on("suggestions", (d) => {
    send("suggestions", d);
    res.end();
  });
  job.emitter.on("jobError", (d) => {
    send("jobError", d);
    res.end();
  });
  req.on("close", () => job.emitter.removeAllListeners());
});

async function runBhagwatReview(
  _jobId: string,
  job: ReviewJob,
  timeline: TimelineSegment[],
  videoTitle: string,
  videoDuration: number,
) {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  job.status = "running";
  try {
    if (!process.env.GEMINI_API_KEY)
      throw new Error("GEMINI_API_KEY is not configured");

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const segmentList = timeline
      .map(
        (seg, i) =>
          `[${i}] ${formatTime(seg.startSec)}–${formatTime(seg.endSec)} | ${seg.isBhajan ? "Bhajan" : "Katha"}\nDescription: ${seg.description}\nCurrent prompt: ${seg.imagePrompt}`,
      )
      .join("\n\n");

    const prompt = `You are an expert devotional video editor reviewing an AI-generated image timeline for a Bhagwat Katha video.

Video: "${videoTitle}" (${formatTime(videoDuration)})

Go through each segment one by one. Think out loud: is the prompt specific enough? Does it capture exactly what the speaker is narrating? Is the style vivid and accurate? Could it be more descriptive or better matched to the story moment?

${segmentList}

After reviewing each segment, end your response with EXACTLY this block (no extra text after END_SUGGESTIONS):

SUGGESTIONS_JSON
[{"segIdx": 0, "reason": "brief reason", "improvedPrompt": "full improved prompt here"}, ...]
END_SUGGESTIONS

Only include segments that genuinely need improvement. If the plan is good, the array can be empty.`;

    const result = await model.generateContentStream(prompt);

    let fullText = "";
    for await (const chunk of result.stream) {
      const text = chunk.text();
      if (text) {
        fullText += text;
        emit("chunk", { text });
      }
    }

    // Parse structured suggestions from the marker block
    let suggestions: any[] = [];
    const match = fullText.match(
      /SUGGESTIONS_JSON\s*([\s\S]*?)\s*END_SUGGESTIONS/,
    );
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (Array.isArray(parsed)) suggestions = parsed;
      } catch {}
    }

    emit("suggestions", { suggestions });
    job.status = "done";
  } catch (err) {
    const message = err instanceof Error ? err.message : "Review failed";
    console.error("[bhagwat/review] Error:", message);
    emit("jobError", { message });
    job.status = "error";
  }
}

// ── Render job store ──────────────────────────────────────────────────────────
interface RenderJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error" | "expired";
  outputPath?: string;
  filename?: string;
  error?: string;
  createdAt: number;
  deleteScheduled?: boolean;
}
const renderJobs = new Map<string, RenderJob>();

router.post("/bhagwat/render", async (req: Request, res: Response) => {
  const { url, timeline, videoDuration, clipStartSec, clipEndSec } = req.body as {
    url: string;
    timeline: TimelineSegment[];
    videoDuration?: number;
    clipStartSec?: number;
    clipEndSec?: number;
  };
  if (!url || !Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "url and timeline are required" });
    return;
  }
  const jobId = randomUUID();
  const job: RenderJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  renderJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatRender(jobId, job, url, timeline, videoDuration ?? 0, clipStartSec, clipEndSec).catch(() => {});
});

router.get("/bhagwat/render-status/:jobId", (req: Request, res: Response) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (job.status === "done") {
    send("done", {
      downloadUrl: `/api/bhagwat/download/${req.params.jobId}`,
      filename: job.filename,
    });
    res.end();
    return;
  }
  if (job.status === "error") {
    send("jobError", { message: job.error });
    res.end();
    return;
  }
  job.emitter.on("progress", (d) => send("progress", d));
  job.emitter.on("done", (d) => {
    send("done", d);
    res.end();
  });
  job.emitter.on("jobError", (d) => {
    send("jobError", d);
    res.end();
  });
  req.on("close", () => job.emitter.removeAllListeners());
});

const RENDER_DELETE_MS = 10 * 60 * 1000; // 10 minutes after download

router.get("/bhagwat/download/:jobId", (req: Request, res: Response) => {
  const job = renderJobs.get(req.params.jobId);
  if (!job?.outputPath || !existsSync(job.outputPath)) {
    res.status(404).json({ error: "File not ready or already deleted" });
    return;
  }
  res.download(job.outputPath, job.filename ?? "bhagwat_video.mp4");

  // Schedule file + job deletion 10 minutes after download is triggered
  if (!job.deleteScheduled) {
    job.deleteScheduled = true;
    setTimeout(() => {
      try {
        unlinkSync(job.outputPath!);
      } catch {}
      job.outputPath = undefined;
      job.status = "expired";
      setTimeout(() => renderJobs.delete(req.params.jobId), 60_000);
    }, RENDER_DELETE_MS);
  }
});

// Sweep render jobs older than 2 hours from memory (safety net)
setInterval(
  () => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, job] of renderJobs.entries()) {
      if (job.createdAt < cutoff) {
        if (job.outputPath) {
          try {
            unlinkSync(job.outputPath);
          } catch {}
        }
        renderJobs.delete(id);
      }
    }
  },
  30 * 60 * 1000,
);

// ── runBhagwatAnalysis ────────────────────────────────────────────────────────
async function runBhagwatAnalysis(
  jobId: string,
  job: AnalysisJob,
  url: string,
  mode: "smart" | "full",
  clipStartSec?: number,
  clipEndSec?: number,
): Promise<void> {
  const clipMode = clipStartSec !== undefined && clipEndSec !== undefined;
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (
    s: string,
    status: "running" | "done" | "warn",
    message: string,
  ) => emit("step", { step: s, status, message });

  job.status = "running";
  const tmpId = randomUUID();
  const subDir = join(BHAGWAT_TMP_DIR, `subs_${tmpId}`);

  try {
    if (!process.env.GEMINI_API_KEY)
      throw new Error("GEMINI_API_KEY is not configured");

    // ── Step 1: Metadata ──────────────────────────────────────────────────────
    step("metadata", "running", "Fetching video info…");
    let videoDuration = 0,
      videoTitle = "",
      videoDescription = "",
      transcript = "";
    let metaSubtitleUrl: string | null = null;

    try {
      const metaJson = await runYtDlp([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ]);
      const meta = JSON.parse(metaJson);
      videoDuration = meta.duration ?? 0;
      // In clip mode, restrict duration to the clip range
      if (clipMode) videoDuration = clipEndSec! - clipStartSec!;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 800);
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      metaSubtitleUrl = pickBestSubtitleUrl(
        subs,
        autoCaps,
        meta.language ?? meta.original_language,
      );
      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        const chapters = clipMode
          ? meta.chapters.filter((c: any) =>
              c.start_time < clipEndSec! &&
              (c.end_time ?? c.start_time + 60) > clipStartSec!
            )
          : meta.chapters;
        transcript = chapters
          .map((c: any) => {
            const start = clipMode
              ? Math.max(0, c.start_time - clipStartSec!)
              : c.start_time;
            const end = clipMode
              ? Math.max(0, (c.end_time ?? c.start_time + 60) - clipStartSec!)
              : (c.end_time ?? c.start_time + 60);
            return `[${formatTime(start)}–${formatTime(end)}] ${c.title}`;
          })
          .join("\n");
      }
      step(
        "metadata",
        "done",
        `"${videoTitle.slice(0, 55)}${videoTitle.length > 55 ? "…" : ""}" · ${formatTime(videoDuration)}`,
      );
    } catch (metaErr) {
      const metaMsg = metaErr instanceof Error ? metaErr.message : String(metaErr);
      console.error("[bhagwat/analyze] yt-dlp metadata failed:", metaMsg);
      step("metadata", "warn", `Could not load metadata: ${metaMsg.slice(0, 120)}`);
    }

    // If yt-dlp gave us nothing useful, fail early with a clear error instead of
    // passing empty context to Gemini and silently producing 0 clips.
    if (!videoTitle && videoDuration === 0 && !transcript) {
      throw new Error(
        "Could not fetch video metadata from YouTube. This is usually caused by bot-detection on cloud IPs. " +
        "Please try again in a few minutes, or check that the URL is a valid public YouTube video.",
      );
    }

    // ── Step 2: Transcript ────────────────────────────────────────────────────
    if (!transcript) {
      step("transcript", "running", "Downloading transcript…");
      let vttContent: string | null = null;
      if (metaSubtitleUrl) {
        try {
          const raw = await fetchUrl(metaSubtitleUrl);
          if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
        } catch {}
      }
      if (!vttContent) {
        try {
          mkdirSync(subDir, { recursive: true });
          const subBase = join(subDir, "sub");
          await runYtDlpForSubs([
            "--write-subs",
            "--write-auto-subs",
            "--sub-lang",
            "hi.*,en.*",
            "--sub-format",
            "vtt",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            "-o",
            subBase,
            url,
          ]).catch(() => {});
          if (!readdirSync(subDir).some((f) => f.endsWith(".vtt"))) {
            await runYtDlpForSubs([
              "--write-subs",
              "--write-auto-subs",
              "--sub-format",
              "vtt",
              "--skip-download",
              "--no-warnings",
              "--no-playlist",
              "-o",
              subBase,
              url,
            ]).catch(() => {});
          }
          const files = readdirSync(subDir);
          const vttFile = files
            .map((f) => join(subDir, f))
            .find((f) => f.endsWith(".vtt"));
          if (vttFile) vttContent = readFileSync(vttFile, "utf8");
          for (const f of files)
            try {
              unlinkSync(join(subDir, f));
            } catch {}
          try {
            rmdirSync(subDir);
          } catch {}
        } catch {}
      }
      if (vttContent) {
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text)
            deduped.push(cue);
        }
        // In clip mode: filter to the requested time range and reindex to relative 0-based time
        const finalCues = clipMode
          ? deduped
              .filter(c => c.startSec < clipEndSec! && c.endSec > clipStartSec!)
              .map(c => ({
                ...c,
                startSec: Math.max(0, c.startSec - clipStartSec!),
                endSec: Math.max(0, c.endSec - clipStartSec!),
              }))
          : deduped;
        transcript = cuesToText(finalCues);
        step("transcript", "done", `${finalCues.length} transcript lines loaded`);
      } else {
        step(
          "transcript",
          "warn",
          "No transcript — AI will work from title & description",
        );
      }
    } else {
      step(
        "transcript",
        "done",
        `${transcript.split("\n").length} chapter markers loaded`,
      );
    }

    // ── Step 3: AI timeline ───────────────────────────────────────────────────
    step(
      "ai",
      "running",
      "AI editor is reading the katha and planning image placements…",
    );

    const transcriptBlock =
      transcript.length > 50
        ? `\nTranscript (Hindi/English):\n${sampleTranscript(transcript, 400000)}`
        : "\n[No transcript — use video title and description to infer content]";

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are a professional devotional video editor with deep knowledge of Shreemad Bhagwat Mahapuran, Bhagwat Katha, Ramayan, Mahabharat, and all Hindu devotional stories and bhajans. You are fully fluent in Hindi and English.

Your task: Watch this video (via transcript) exactly like an expert editor sitting at a timeline, and decide the best image to place at every moment of the story. You must think like an editor: "what image best represents what the speaker is saying RIGHT NOW and from what time to which?"

WHAT YOU ARE EDITING:
- Shreemad Bhagwat Mahapuran Katha / krishna leela / any Hindu devotional katha
- The speaker narrates Bhagwat Katha, leelas, recites shlokas, and sometimes sings bhajans
- Your job: plan a sequence of images that visually brings the narration to life.

HOW TO THINK ABOUT EACH SEGMENT:
1. STORY NARRATION (katha/leela): Break into SHORT, specific story beats of 8–12 seconds each. CRITICAL RULE: NEVER make a single katha segment longer than 12 seconds. If the speaker narrates a section for 30 seconds, that must be 3 SEPARATE segments (~10s each) with 3 DIFFERENT image prompts, each showing a distinct moment of the story progressing. More segments = more visual variety = better video. Each segment gets ONE unique image prompt. Be specific — not "Lord Krishna" but "Lord Krishna as a young boy stealing butter from the pot, mother Yashoda watching, cozy village home in Vrindavan, 16th century devotional painting style". Set imageChangeEvery to match the segment duration (8–12).

2. BHAJAN / KIRTAN (when speaker sings a devotional song or plays music): Detect this by repeated devotional phrases, "Ram Hare Krishn Hare", "Madhab Madhab", "Jai Shri Ram", "Govind Bolo", song lyrics, musical patterns. For bhajans: use calm meditative devotional imagery — NOT the story scenes, but peaceful deity imagery (eg Radha krishna, Sita Ram or which fits the best to the bhajan,. etc.). Change images every 25–40 seconds (bhajans have a slow, meditative rhythm). Mark isBhajan: true.

3. SHLOKA RECITATION: Sanskrit verses being recited. Use sacred imagery — open scripture, deity, whatever fits best according to the narration. 

4. OPENING / CLOSING / TRANSITIONS: Use auspicious imagery. Change every 10–30 seconds or adjust accordingly.

THE STORY MUST FLOW: 
For example: If narrating Dhruv Bhakt's story, your segments should visually tell the WHOLE story in sequence (- Dhruv rejected by stepmother → forest with young boy walking → Narada Muni meeting Dhruv → Dhruv meditating → Lord Vishnu's divine appearance → Dhruv's elevation to Dhruv Loka etc) but according to how the narrator is narrating according to the narration pacing and all aspects:
Each scene gets its OWN carefully crafted image prompt.

IMAGE PROMPT RULES:
- Write in English, even if the transcript is Hindi
- Be specific and vivid: scene, characters, their appearance, setting, lighting, mood
- Include style: "traditional devotional Indian painting", "realistic", etc.
- Do NOT include: watermarks, logos, borders, modern photography
- if and only if generating image with lord (maha vishnu, lord krishna, etc) then use more detailed description of the lord and the scene.
- Bhajan prompts: peaceful, divine, deity-focused, bhajan specific.

${
  mode === "full"
    ? `FULL COVERAGE MODE: Every second of the video must be covered. No gaps allowed. Start at exactly 0 and end at exactly ${videoDuration}s. All segments must be contiguous with no spaces between them.`
    : `SMART PLACEMENT MODE: Do NOT cover the whole video. Select only the most visually impactful 30–55% of the video duration. Leave significant gaps — silence between images is fine and expected. Pick moments where a compelling image genuinely adds value: climactic story revelations, bhajans, key leela moments, emotional peaks, shloka recitations, and auspicious transitions. Skip repetitive narration, long explanations, Q&A sections, or sections where images add little value. Each selected segment should be a specific, clearly defined story beat with a vivid image opportunity. Gaps between segments can be 30 seconds to several minutes — that is correct and intentional.`
}

RESPOND with ONLY a valid JSON array, no markdown fences:
[
  {
    "startSec": 0,
    "endSec": 120,
    "isBhajan": false,
    "imageChangeEvery": 12,
    "description": "Opening — speaker introduces the katha",
    "imagePrompt": "Peaceful riverside setting at dawn, devotees sitting in a circle reading Shreemad Bhagwat Mahapuran, soft morning light, incense smoke drifting in the air, calm spiritual atmosphere, warm colors, serene and divine mood"
  }
]`,
    });

    const clipNote = clipMode
      ? `\nNOTE: This is a CLIP extracted from ${formatTime(clipStartSec!)} to ${formatTime(clipEndSec!)} of the original video. All timestamps in your response must be RELATIVE to the clip start (i.e., the clip starts at 0s, not at ${clipStartSec}s).`
      : "";

    const userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)${clipNote}
${videoDescription ? `Description: ${videoDescription}` : ""}
${transcriptBlock}

${
  mode === "full"
    ? `Plan the COMPLETE image timeline for this clip covering every second. Write specific image prompts for each story beat. For bhajans, write calm devotional imagery with longer durations. Cover every second from 0 to ${videoDuration}s with no gaps.`
    : `Select only the BEST moments for image placement — do not cover the whole clip. Choose 30–55% of the clip duration: the most visually compelling story beats, bhajans, and peak moments. Write vivid specific image prompts for each selected moment. Leave large gaps between segments where images are not needed. For bhajans, write calm devotional imagery.`
}`;

    const result = await model.generateContent(userContent);
    const raw = result.response.text().trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/im, "")
        .replace(/\s*```\s*$/im, "")
        .trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter(
            (s: any) =>
              s &&
              typeof s.startSec === "number" &&
              typeof s.endSec === "number" &&
              s.endSec > s.startSec &&
              s.imagePrompt,
          )
          .map(
            (s: any): TimelineSegment => ({
              startSec: Math.max(0, Math.round(s.startSec)),
              endSec: Math.min(videoDuration || 999999, Math.round(s.endSec)),
              isBhajan: s.isBhajan === true,
              imageChangeEvery:
                s.isBhajan === true
                  ? Math.max(
                      20,
                      Math.min(40, Math.round(s.imageChangeEvery ?? 30)),
                    )
                  : Math.max(
                      8,
                      Math.min(12, Math.round(s.imageChangeEvery ?? 10)),
                    ),
              description: (s.description ?? "").slice(0, 150),
              imagePrompt: (s.imagePrompt ?? "").slice(0, 600),
            }),
          )
          // Second pass: drop any segment where clamping made endSec ≤ startSec
          .filter((s) => s.endSec > s.startSec + 1);
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0)
      throw new Error("AI returned an empty timeline — please try again");

    // Sort and (for full mode) ensure coverage with no gaps
    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({
          startSec: 0,
          endSec: timeline[0].startSec,
          isBhajan: false,
          imageChangeEvery: 10,
          description: "Opening",
          imagePrompt:
            "Auspicious opening scene — ancient temple entrance, golden morning light, flowers and oil lamps, devotional atmosphere, traditional Indian painting style",
        });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        // Clip overlapping segment so it starts where the previous one ended
        const seg =
          timeline[i].startSec < prev.endSec
            ? { ...timeline[i], startSec: prev.endSec }
            : timeline[i];
        // Skip degenerate segments produced by clipping
        if (seg.endSec <= seg.startSec + 1) continue;
        if (seg.startSec > prev.endSec) {
          // Fill the gap
          filled.push({
            startSec: prev.endSec,
            endSec: seg.startSec,
            isBhajan: false,
            imageChangeEvery: 10,
            description: "Continuation",
            imagePrompt: prev.imagePrompt,
          });
        }
        filled.push(seg);
      }
      // Extend final segment to cover the full video (guard against startSec edge case)
      const last = filled[filled.length - 1];
      if (last.startSec < videoDuration) {
        last.endSec = videoDuration;
      } else {
        filled.pop(); // last segment starts beyond video end — discard
      }
      timeline = filled;
    }

    step(
      "ai",
      "done",
      `${timeline.length} segments planned · ${timeline.filter((s) => s.isBhajan).length} bhajan sections`,
    );

    const resultData = { timeline, videoDuration, videoTitle };
    job.status = "done";
    job.result = resultData;
    emit("done", resultData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/analyze] Error:", message);
    job.status = "error";
    job.error = message;
    emit("jobError", { message });
    try {
      if (existsSync(subDir)) {
        for (const f of readdirSync(subDir))
          try {
            unlinkSync(join(subDir, f));
          } catch {}
        rmdirSync(subDir);
      }
    } catch {}
  }
}

// ── runBhagwatRender ──────────────────────────────────────────────────────────
async function runBhagwatRender(
  jobId: string,
  job: RenderJob,
  url: string,
  timeline: TimelineSegment[],
  videoDuration: number = 0,
  clipStartSec?: number,
  clipEndSec?: number,
  localAudioPath?: string,
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  job.status = "running";

  const tmpId = randomUUID();
  const audioPath = join(BHAGWAT_TMP_DIR, `${tmpId}_audio`);
  const imgDir = join(BHAGWAT_TMP_DIR, `${tmpId}_imgs`);
  const outputPath = join(BHAGWAT_RENDERED_DIR, `${jobId}.mp4`);

  mkdirSync(imgDir, { recursive: true });

  try {
    if (!process.env.GEMINI_API_KEY)
      throw new Error("GEMINI_API_KEY is not configured");

    // ── 1+2. Download audio AND generate images in parallel ───────────────────
    emit("progress", {
      percent: 3,
      message: `Downloading audio & generating ${timeline.length} images in parallel…`,
    });

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

    const audioDownloadPromise: Promise<string> = localAudioPath
      ? Promise.resolve(localAudioPath)
      : (async (): Promise<string> => {
          let ytdlpError = "";
          try {
            await runYtDlp([
              "-f",
              "bestaudio/best",
              "--no-playlist",
              "--no-warnings",
              "--no-check-certificates",
              "-o",
              `${audioPath}.%(ext)s`,
              url,
            ]);
          } catch (err) {
            ytdlpError = err instanceof Error ? err.message : String(err);
            console.error(
              "[bhagwat/render] yt-dlp audio download error:",
              ytdlpError,
            );
          }
          const audioFiles = readdirSync(BHAGWAT_TMP_DIR).filter((f) =>
            f.startsWith(basename(audioPath)),
          );
          const resolved =
            audioFiles.length > 0 ? join(BHAGWAT_TMP_DIR, audioFiles[0]) : null;
          if (!resolved || !existsSync(resolved)) {
            throw new Error(
              ytdlpError
                ? `Audio download failed: ${ytdlpError.slice(0, 300)}`
                : "Failed to download audio from YouTube — please check the URL and try again",
            );
          }
          return resolved;
        })();

    let [audioFile, imagePaths] = await Promise.all([
      audioDownloadPromise,
      generateAllSegmentImages(genAI, timeline, imgDir, (done, total, desc) => {
        const pct = 8 + Math.round((done / total) * 52); // 8% → 60%
        emit("progress", {
          percent: pct,
          message: `Generating image ${done}/${total}: "${desc.slice(0, 50)}"…`,
        });
      }),
    ]);

    // Trim audio to clip range when editing a specific clip.
    // Always re-encode to aac (-c:a aac) instead of -c:a copy, because YouTube
    // audio is often webm/opus and copying opus into an .aac container causes
    // FFmpeg to fail or produce corrupt audio.
    if (clipStartSec !== undefined && clipEndSec !== undefined) {
      const trimmedPath = join(BHAGWAT_TMP_DIR, `${tmpId}_audio_trimmed.aac`);
      await new Promise<void>((resolve, reject) => {
        const ff = spawn("ffmpeg", [
          "-ss", String(clipStartSec),
          "-t", String(clipEndSec - clipStartSec),
          "-i", audioFile,
          "-c:a", "aac",
          "-b:a", "192k",
          "-y",
          trimmedPath,
        ]);
        let stderr = "";
        ff.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        ff.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Audio trim failed (${code}): ${stderr.slice(-300)}`)),
        );
      });
      try { unlinkSync(audioFile); } catch {}
      audioFile = trimmedPath;
    }

    const totalGenerated = imagePaths
      .flat()
      .filter((p) => p && existsSync(p)).length;
    if (totalGenerated === 0)
      throw new Error("Image generation failed — no images were created");

    emit("progress", {
      percent: 62,
      message: `${totalGenerated} images generated. Building video sequence…`,
    });

    // ── 3. Build clip list (image path + duration per display slot) ───────────
    interface Clip {
      imgPath: string;
      dur: number;
      startSec: number;
      endSec: number;
    }
    let clips: Clip[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const segDur = seg.endSec - seg.startSec;
      if (segDur <= 0) continue;
      const pool = imagePaths[i].filter((p) => p && existsSync(p));
      if (pool.length === 0) continue;

      if (pool.length === 1) {
        // Single image covers the whole segment
        clips.push({ imgPath: pool[0], dur: segDur, startSec: seg.startSec, endSec: seg.endSec });
      } else {
        // Multiple images — split segment into equal sub-clips (implements imageChangeEvery)
        const subDur = segDur / pool.length;
        for (let j = 0; j < pool.length; j++) {
          clips.push({
            imgPath: pool[j],
            dur: subDur,
            startSec: seg.startSec + j * subDur,
            endSec: seg.startSec + (j + 1) * subDur,
          });
        }
      }
    }

    // ── Gap filling — critical for Smart Placement mode ────────────────────────
    // In smart mode, selected segments cover only 30–55% of the video. Without
    // gap filling, the image track ends early and -shortest cuts the audio to
    // match, producing a video that is a fraction of the original length.
    // We fill every gap with the nearest segment's image so the full audio
    // track plays through to the end.
    if (videoDuration > 0 && clips.length > 0) {
      clips.sort((a, b) => a.startSec - b.startSec);
      const filled: Clip[] = [];
      let cursor = 0;

      for (const clip of clips) {
        if (clip.startSec > cursor + 0.5) {
          // Gap before this clip — fill with the previous image (or the first
          // clip's image if we haven't shown anything yet)
          const gapImg = filled.length > 0 ? filled[filled.length - 1].imgPath : clip.imgPath;
          filled.push({
            imgPath: gapImg,
            dur: clip.startSec - cursor,
            startSec: cursor,
            endSec: clip.startSec,
          });
        }
        filled.push(clip);
        cursor = clip.endSec;
      }

      // Fill any remaining time after the last clip up to the full video length
      if (cursor < videoDuration - 0.5 && filled.length > 0) {
        const lastImg = filled[filled.length - 1].imgPath;
        filled.push({
          imgPath: lastImg,
          dur: videoDuration - cursor,
          startSec: cursor,
          endSec: videoDuration,
        });
      }

      clips = filled;
    }

    if (clips.length === 0)
      throw new Error("Could not build image sequence from generated images");

    emit("progress", { percent: 65, message: "Rendering video with FFmpeg…" });

    // ── 4. FFmpeg render with xfade crossfade transitions ─────────────────────
    // Derive totalDuration from the clips array (which now covers the full
    // video after gap filling) so FFmpeg progress tracking is accurate.
    const totalDuration = clips.reduce((s, c) => s + c.dur, 0);
    job.filename = `bhagwat_${tmpId.slice(0, 6)}.mp4`;

    // Clamp fade so it never exceeds 80% of the shortest clip
    const FADE_DUR = Math.min(1.2, Math.min(...clips.map((c) => c.dur)) * 0.8);
    // Clamp first-image fade-in so it never exceeds 40% of the first clip's duration
    // (prevents fade-in from fighting the first xfade transition on short clips)
    const FIRST_FADEIN = Math.min(3.0, clips[0].dur * 0.4);

    const SCALE =
      "scale=1920:1080:force_original_aspect_ratio=decrease," +
      "pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p";

    // Build FFmpeg args and filter_complex
    const ffArgs: string[] = [];

    if (clips.length === 1) {
      // Single clip — no xfade, just 3s fade-in from black
      ffArgs.push(
        "-loop",
        "1",
        "-t",
        clips[0].dur.toFixed(3),
        "-i",
        clips[0].imgPath,
      );
      ffArgs.push("-i", audioFile);
      ffArgs.push(
        "-vf",
        `${SCALE},fade=t=in:st=0:d=${FIRST_FADEIN}`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-y",
        outputPath,
      );
    } else {
      // Multiple clips — chain xfade between each consecutive pair
      // Input 0: natural duration; inputs 1..N-1: duration + FADE_DUR (overlap padding)
      ffArgs.push(
        "-loop",
        "1",
        "-t",
        clips[0].dur.toFixed(3),
        "-i",
        clips[0].imgPath,
      );
      for (let i = 1; i < clips.length; i++) {
        ffArgs.push(
          "-loop",
          "1",
          "-t",
          (clips[i].dur + FADE_DUR).toFixed(3),
          "-i",
          clips[i].imgPath,
        );
      }
      ffArgs.push("-i", audioFile);

      // Build filter_complex:
      // 1. Scale each input; first image also gets 3s fade-in from black
      // 2. Chain fadeblack xfade between all clips
      const filterParts: string[] = [];

      filterParts.push(`[0]${SCALE},fade=t=in:st=0:d=${FIRST_FADEIN}[v0]`);
      for (let i = 1; i < clips.length; i++) {
        filterParts.push(`[${i}]${SCALE}[v${i}]`);
      }

      let cumDur = 0;
      let prevLabel = "v0";
      for (let i = 1; i < clips.length; i++) {
        cumDur += clips[i - 1].dur;
        const offset = Math.max(0, cumDur - FADE_DUR);
        const outLabel = i === clips.length - 1 ? "vout" : `x${i}`;
        filterParts.push(
          `[${prevLabel}][v${i}]xfade=transition=fadeblack:duration=${FADE_DUR.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`,
        );
        prevLabel = outLabel;
      }

      const audioInputIdx = clips.length;
      ffArgs.push(
        "-filter_complex",
        filterParts.join(";"),
        "-map",
        "[vout]",
        "-map",
        `${audioInputIdx}:a`,
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-profile:v",
        "high",
        "-movflags",
        "+faststart",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-y",
        outputPath,
      );
    }

    await new Promise<void>((resolve, reject) => {
      const ff = spawn("ffmpeg", ffArgs);
      let stderr = "";
      let resolved = false;

      // Watchdog: kill FFmpeg if it hangs for more than 30 minutes
      const watchdog = setTimeout(() => {
        if (!resolved) {
          ff.kill("SIGKILL");
          reject(new Error("FFmpeg timed out after 30 minutes"));
        }
      }, 30 * 60 * 1000);

      ff.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        const match = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g);
        if (match) {
          const last = match[match.length - 1];
          const [, h, m, s] = last.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/)!;
          const cur = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
          const pct =
            totalDuration > 0
              ? Math.min(98, 65 + Math.round((cur / totalDuration) * 33))
              : 80;
          emit("progress", {
            percent: pct,
            message: `Rendering… ${formatTime(cur)} / ${formatTime(totalDuration)}`,
          });
        }
      });
      ff.on("close", (code) => {
        resolved = true;
        clearTimeout(watchdog);
        code === 0
          ? resolve()
          : reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-400)}`));
      });
    });

    // ── 5. Cleanup ────────────────────────────────────────────────────────────
    // Don't delete user-uploaded audio; only clean up yt-dlp downloads / trimmed files we created
    if (audioFile !== localAudioPath) {
      try { unlinkSync(audioFile); } catch {}
    }
    try {
      for (const f of readdirSync(imgDir))
        try {
          unlinkSync(join(imgDir, f));
        } catch {}
      rmdirSync(imgDir);
    } catch {}

    emit("progress", { percent: 100, message: "Video ready for download!" });
    job.status = "done";
    job.outputPath = outputPath;
    emit("done", {
      downloadUrl: `/api/bhagwat/download/${jobId}`,
      filename: job.filename,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/render] Error:", message);
    job.status = "error";
    job.error = message;
    emit("jobError", { message });
    try {
      for (const f of readdirSync(imgDir))
        try {
          unlinkSync(join(imgDir, f));
        } catch {}
      rmdirSync(imgDir);
    } catch {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// AUDIO UPLOAD FEATURE
// ══════════════════════════════════════════════════════════════════════════════

// ── AssemblyAI transcription ──────────────────────────────────────────────────
interface AssemblyResult {
  transcript: string;
  durationSec: number;
  languageCode: string;
  chapters: Array<{ startSec: number; endSec: number; gist: string; headline: string; summary: string }>;
  utterances: Array<{ speaker: string; startSec: number; endSec: number; text: string }>;
}

async function transcribeWithAssemblyAI(
  audioPath: string,
  onProgress: (msg: string) => void,
): Promise<AssemblyResult> {
  if (!process.env.ASSEMBLYAI_API_KEY) throw new Error("ASSEMBLYAI_API_KEY is not configured — add it in Secrets");

  const client = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });

  onProgress("Uploading audio to AssemblyAI…");
  const transcript = await client.transcripts.transcribe({
    audio: audioPath,
    language_detection: true,
    speaker_labels: true,
    auto_chapters: true,
    sentiment_analysis: true,
    format_text: true,
    speech_model: "best",
  });

  if (transcript.status === "error") {
    throw new Error(`AssemblyAI transcription failed: ${transcript.error ?? "unknown error"}`);
  }

  const durationSec = transcript.audio_duration ?? 0; // seconds

  const chapters = (transcript.chapters ?? []).map((c: any) => ({
    startSec: (c.start ?? 0) / 1000,
    endSec: (c.end ?? 0) / 1000,
    gist: c.gist ?? "",
    headline: c.headline ?? "",
    summary: c.summary ?? "",
  }));

  const utterances = (transcript.utterances ?? []).map((u: any) => ({
    speaker: u.speaker ?? "A",
    startSec: (u.start ?? 0) / 1000,
    endSec: (u.end ?? 0) / 1000,
    text: u.text ?? "",
  }));

  // Build timed transcript — prefer chapters (rich context), fall back to speaker turns
  let builtTranscript = "";
  if (chapters.length > 0) {
    builtTranscript = chapters
      .map((c) => {
        const sm = Math.floor(c.startSec / 60), ss = Math.floor(c.startSec % 60);
        const em = Math.floor(c.endSec / 60), es = Math.floor(c.endSec % 60);
        return `[${String(sm).padStart(2, "0")}:${String(ss).padStart(2, "0")}–${String(em).padStart(2, "0")}:${String(es).padStart(2, "0")}] ${c.headline}\n${c.summary}`;
      })
      .join("\n\n");
  } else if (utterances.length > 0) {
    builtTranscript = utterances
      .map((u) => {
        const mm = Math.floor(u.startSec / 60), sec = Math.floor(u.startSec % 60);
        return `[${String(mm).padStart(2, "0")}:${String(sec).padStart(2, "0")}] ${utterances.length > 1 ? `[${u.speaker}] ` : ""}${u.text}`;
      })
      .join("\n");
  } else if (transcript.text) {
    builtTranscript = transcript.text;
  }

  return {
    transcript: builtTranscript,
    durationSec,
    languageCode: transcript.language_code ?? "en",
    chapters,
    utterances,
  };
}

// ── runBhagwatAnalysisFromFile ────────────────────────────────────────────────
async function runBhagwatAnalysisFromFile(
  jobId: string,
  job: AnalysisJob,
  audioId: string,
  mode: "smart" | "full",
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (s: string, status: "running" | "done" | "warn", message: string) =>
    emit("step", { step: s, status, message });
  job.status = "running";

  try {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    const audio = uploadedAudios.get(audioId);
    if (!audio) throw new Error("Uploaded audio file not found — please upload again");

    // ── Step 1: File metadata ─────────────────────────────────────────────────
    step("metadata", "running", "Reading audio file…");
    let videoDuration = 0;
    const videoTitle = audio.originalName.replace(/\.[^.]+$/, "");

    try {
      const ffOut = await new Promise<string>((resolve, reject) => {
        const ff = spawn("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          audio.path,
        ]);
        let out = "";
        ff.stdout.on("data", (d: Buffer) => { out += d.toString(); });
        ff.on("close", (code) => code === 0 ? resolve(out.trim()) : reject(new Error("ffprobe failed")));
      });
      videoDuration = parseFloat(ffOut) || 0;
    } catch {}

    const fileSizeMB = Math.round(audio.sizeBytes / 1024 / 1024);
    step("metadata", "done", `"${videoTitle}" · ${formatTime(videoDuration)} · ${fileSizeMB} MB`);

    // ── Step 2: AssemblyAI transcription ──────────────────────────────────────
    step("transcript", "running", "Uploading to AssemblyAI for transcription…");
    let transcript = "";

    try {
      const result = await transcribeWithAssemblyAI(audio.path, (msg) => {
        step("transcript", "running", msg);
      });

      // Update duration from AssemblyAI (more accurate)
      if (result.durationSec > 0) videoDuration = result.durationSec;
      audio.durationSec = videoDuration;
      transcript = result.transcript;

      if (result.chapters.length > 0) {
        step("transcript", "done",
          `${result.chapters.length} chapters detected · ${result.languageCode} · ${formatTime(videoDuration)}`);
      } else if (result.utterances.length > 0) {
        step("transcript", "done",
          `${result.utterances.length} speaker turns · ${result.languageCode} · ${formatTime(videoDuration)}`);
      } else {
        step("transcript", "warn", "Transcript generated but no structural data — AI will work from full text");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bhagwat/analyze-audio] AssemblyAI error:", msg);
      step("transcript", "warn", `Transcription failed: ${msg.slice(0, 120)}`);
    }

    if (videoDuration === 0 && !transcript) {
      throw new Error("Could not read audio file. Please ensure it is a valid audio format.");
    }

    // ── Step 3: Gemini AI timeline ─────────────────────────────────────────────
    step("ai", "running", "AI editor is reading the content and planning image placements…");

    const transcriptBlock = transcript.length > 50
      ? `\nTranscript:\n${sampleTranscript(transcript, 400000)}`
      : "\n[No transcript — use audio title to infer content]";

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-pro",
      systemInstruction: `You are a professional devotional video editor with deep knowledge of Shreemad Bhagwat Mahapuran, Bhagwat Katha, Ramayan, Mahabharat, and all Hindu devotional stories and bhajans. You are fully fluent in Hindi and English.

Your task: Listen to this audio (via transcript) exactly like an expert editor sitting at a timeline, and decide the best image to place at every moment. You must think like an editor: "what image best represents what the speaker is saying RIGHT NOW and from what time to which?"

HOW TO THINK ABOUT EACH SEGMENT:
1. STORY NARRATION (katha/leela): Break into SHORT, specific story beats of 8–12 seconds each. CRITICAL RULE: NEVER make a single katha segment longer than 12 seconds. More segments = more visual variety = better video. Each segment gets ONE unique image prompt. Be specific — not "Lord Krishna" but "Lord Krishna as a young boy stealing butter from the pot, mother Yashoda watching, cozy village home in Vrindavan, traditional devotional painting style". Set imageChangeEvery to match the segment duration (8–12).

2. BHAJAN / KIRTAN: Detect by repeated devotional phrases, song lyrics, musical patterns. For bhajans: calm meditative devotional imagery — peaceful deity imagery. Change images every 25–40 seconds. Mark isBhajan: true.

3. SHLOKA RECITATION: Sacred imagery — open scripture, deity. 

4. OPENING / CLOSING / TRANSITIONS: Auspicious imagery. 

IMAGE PROMPT RULES:
- Write in English even if transcript is Hindi
- Be specific and vivid: scene, characters, setting, lighting, mood
- Include style: "traditional devotional Indian painting", "realistic", etc.
- Do NOT include: watermarks, logos, borders, modern photography
- For deities: detailed description of appearance and scene

${
  mode === "full"
    ? `FULL COVERAGE MODE: Every second of the audio must be covered. No gaps. Start at 0 and end at exactly ${videoDuration}s.`
    : `SMART PLACEMENT MODE: Select only the most visually impactful 30–55% of the audio. Leave significant gaps. Pick bhajans, climactic story moments, key leela moments, shloka recitations. Gaps of 30 seconds to several minutes are correct and intentional.`
}

RESPOND with ONLY a valid JSON array, no markdown fences:
[
  {
    "startSec": 0,
    "endSec": 120,
    "isBhajan": false,
    "imageChangeEvery": 12,
    "description": "Opening narration",
    "imagePrompt": "Peaceful riverside setting at dawn, devotees reading Shreemad Bhagwat, soft morning light, incense smoke, warm devotional atmosphere"
  }
]`,
    });

    const userContent = `Audio: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${transcriptBlock}

${
  mode === "full"
    ? `Plan the COMPLETE image timeline covering every second from 0 to ${videoDuration}s with no gaps.`
    : `Select only the BEST moments for image placement — choose 30–55% of the duration. Leave large gaps between segments.`
}`;

    const result = await model.generateContent(userContent);
    const raw = result.response.text().trim();

    let timeline: TimelineSegment[] = [];
    try {
      const cleaned = raw
        .replace(/^```(?:json)?\s*/im, "")
        .replace(/\s*```\s*$/im, "")
        .trim();
      const arr = JSON.parse(cleaned);
      if (Array.isArray(arr)) {
        timeline = arr
          .filter((s: any) => s && typeof s.startSec === "number" && typeof s.endSec === "number" && s.endSec > s.startSec && s.imagePrompt)
          .map((s: any): TimelineSegment => ({
            startSec: Math.max(0, Math.round(s.startSec)),
            endSec: Math.min(videoDuration || 999999, Math.round(s.endSec)),
            isBhajan: s.isBhajan === true,
            imageChangeEvery: s.isBhajan === true
              ? Math.max(20, Math.min(40, Math.round(s.imageChangeEvery ?? 30)))
              : Math.max(8, Math.min(12, Math.round(s.imageChangeEvery ?? 10))),
            description: (s.description ?? "").slice(0, 150),
            imagePrompt: (s.imagePrompt ?? "").slice(0, 600),
          }))
          .filter((s: TimelineSegment) => s.endSec > s.startSec + 1);
      }
    } catch {
      throw new Error("AI returned invalid JSON — please try again");
    }

    if (timeline.length === 0) throw new Error("AI returned an empty timeline — please try again");

    timeline.sort((a, b) => a.startSec - b.startSec);
    if (mode === "full" && videoDuration > 0) {
      if (timeline[0].startSec > 0) {
        timeline.unshift({ startSec: 0, endSec: timeline[0].startSec, isBhajan: false, imageChangeEvery: 10, description: "Opening", imagePrompt: "Auspicious opening scene — ancient temple entrance, golden morning light, flowers and oil lamps, devotional atmosphere, traditional Indian painting style" });
      }
      const filled: TimelineSegment[] = [timeline[0]];
      for (let i = 1; i < timeline.length; i++) {
        const prev = filled[filled.length - 1];
        const seg = timeline[i].startSec < prev.endSec ? { ...timeline[i], startSec: prev.endSec } : timeline[i];
        if (seg.endSec <= seg.startSec + 1) continue;
        if (seg.startSec > prev.endSec) filled.push({ startSec: prev.endSec, endSec: seg.startSec, isBhajan: false, imageChangeEvery: 10, description: "Continuation", imagePrompt: prev.imagePrompt });
        filled.push(seg);
      }
      const last = filled[filled.length - 1];
      if (last.startSec < videoDuration) { last.endSec = videoDuration; } else { filled.pop(); }
      timeline = filled;
    }

    step("ai", "done", `${timeline.length} segments planned · ${timeline.filter((s) => s.isBhajan).length} bhajan sections`);

    const resultData = { timeline, videoDuration, videoTitle };
    job.status = "done";
    job.result = resultData;
    emit("done", resultData);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[bhagwat/analyze-audio] Error:", message);
    job.status = "error";
    job.error = message;
    emit("jobError", { message });
  }
}

// ── Audio upload route ─────────────────────────────────────────────────────────
router.post("/bhagwat/upload-audio", (req: Request, res: Response) => {
  audioUpload.single("audio")(req as any, res as any, (err: any) => {
    if (err) {
      res.status(400).json({ error: err.message ?? "Upload failed" });
      return;
    }
    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ error: "No audio file provided" });
      return;
    }
    const audioId = randomUUID();
    uploadedAudios.set(audioId, {
      path: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      durationSec: 0,
      createdAt: Date.now(),
    });
    res.json({ audioId, filename: file.originalname, sizeBytes: file.size, mimeType: file.mimetype });
  });
});

// Delete uploaded audio
router.delete("/bhagwat/audio/:audioId", (req: Request, res: Response) => {
  const audio = uploadedAudios.get(req.params.audioId);
  if (!audio) { res.status(404).json({ error: "Audio not found" }); return; }
  try { unlinkSync(audio.path); } catch {}
  uploadedAudios.delete(req.params.audioId);
  res.json({ ok: true });
});

// ── Analyze uploaded audio (uses same analysisJobs + SSE endpoint as YouTube) ─
router.post("/bhagwat/analyze-audio", (req: Request, res: Response) => {
  const { audioId, mode } = req.body as { audioId: string; mode?: "smart" | "full" };
  if (!audioId) { res.status(400).json({ error: "audioId is required" }); return; }
  if (!uploadedAudios.has(audioId)) { res.status(404).json({ error: "Audio file not found — please upload again" }); return; }
  const jobId = randomUUID();
  const job: AnalysisJob = { emitter: new EventEmitter(), status: "pending", createdAt: Date.now() };
  analysisJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatAnalysisFromFile(jobId, job, audioId, mode ?? "full").catch(() => {});
});

// ── Render with uploaded audio (reuses same renderJobs + SSE endpoint) ─────────
router.post("/bhagwat/render-audio", async (req: Request, res: Response) => {
  const { audioId, timeline, videoDuration, clipStartSec, clipEndSec } = req.body as {
    audioId: string;
    timeline: TimelineSegment[];
    videoDuration?: number;
    clipStartSec?: number;
    clipEndSec?: number;
  };
  if (!audioId || !Array.isArray(timeline) || timeline.length === 0) {
    res.status(400).json({ error: "audioId and timeline are required" });
    return;
  }
  const audio = uploadedAudios.get(audioId);
  if (!audio) { res.status(404).json({ error: "Audio file not found — please upload again" }); return; }

  const jobId = randomUUID();
  const job: RenderJob = { emitter: new EventEmitter(), status: "pending", createdAt: Date.now() };
  renderJobs.set(jobId, job);
  res.json({ jobId });
  runBhagwatRender(jobId, job, "", timeline, videoDuration ?? 0, clipStartSec, clipEndSec, audio.path).catch(() => {});
});

export default router;
