import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  createReadStream,
  readFileSync,
  readdirSync,
  rmdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { get as httpsGet } from "https";
import { get as httpGet } from "http";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router: IRouter = Router();

// Make yt-dlp (installed in the uv venv) visible to the system Python
const PYTHON_ENV = {
  ...process.env,
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  PYTHONPATH: "/home/runner/workspace/.pythonlibs/lib/python3.11/site-packages",
};

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// Clean up files older than 1 hour every 30 minutes
const MAX_FILE_AGE_MS = 60 * 60 * 1000;
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const files = readdirSync(DOWNLOAD_DIR);
    for (const file of files) {
      const filePath = join(DOWNLOAD_DIR, file);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs > MAX_FILE_AGE_MS) {
          unlinkSync(filePath);
        }
      } catch {}
    }
  } catch {}
}
setInterval(cleanupOldFiles, 30 * 60 * 1000);
cleanupOldFiles();

// Auto-delete a job's file 5 minutes after it's ready
const AUTO_DELETE_MS = 5 * 60 * 1000;
function scheduleAutoDelete(
  jobId: string,
  jobRef: { filePath: string | null; status: string },
) {
  setTimeout(() => {
    if (jobRef.filePath) {
      try {
        unlinkSync(jobRef.filePath);
      } catch {}
      jobRef.filePath = null;
    }
    jobRef.status = "expired";
    setTimeout(() => jobs.delete(jobId), 60_000);
  }, AUTO_DELETE_MS);
}

interface VideoFormatOut {
  formatId: string;
  ext: string;
  resolution: string;
  fps: number | null;
  filesize: number | null;
  vcodec: string | null;
  acodec: string | null;
  quality: string;
  label: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface DownloadJob {
  status: "pending" | "downloading" | "merging" | "done" | "error" | "expired";
  percent: number | null;
  speed: string | null;
  eta: string | null;
  filename: string | null;
  filesize: number | null;
  message: string | null;
  filePath: string | null;
  url: string;
  formatId: string;
  audioOnly: boolean;
  ext: string;
}

const jobs = new Map<string, DownloadJob>();

// Base args applied to every yt-dlp call for proper JS challenge solving
const BASE_YTDLP_ARGS = [
  "--js-runtimes",
  "node",
  "--remote-components",
  "ejs:github",
];

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "python3",
      ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args],
      {
        env: PYTHON_ENV,
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`),
        );
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
  });
}

// Fetch a URL and return its body as a string
function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith("https") ? httpsGet : httpGet;
    let data = "";
    const req = get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          fetchUrl(res.headers.location).then(resolve).catch(reject);
          return;
        }
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Subtitle fetch timed out"));
    });
  });
}

// Pick the best subtitle URL from yt-dlp dump-json subtitle maps
function pickBestSubtitleUrl(
  subtitles: Record<string, any[]>,
  automaticCaptions: Record<string, any[]>,
  videoLanguage?: string,
): string | null {
  const findVttUrl = (tracks: any[]): string | null => {
    if (!Array.isArray(tracks)) return null;
    // Prefer explicit VTT ext, then URL containing fmt=vtt
    const vtt =
      tracks.find((t: any) => t.ext === "vtt") ??
      tracks.find(
        (t: any) => typeof t.url === "string" && t.url.includes("fmt=vtt"),
      );
    return vtt?.url ?? null;
  };

  // Language priority: detected video language first, then Hindi variants, then English, then anything
  const preferredLangs = [
    ...(videoLanguage ? [videoLanguage] : []),
    "hi",
    "hi-IN",
    "hi-Latn",
    "hi-orig",
    "en",
    "en-US",
    "en-GB",
    "en-orig",
  ];

  // 1) Manual subtitles (highest quality)
  for (const lang of preferredLangs) {
    if (subtitles[lang]?.length) {
      const u = findVttUrl(subtitles[lang]);
      if (u) return u;
    }
  }
  // Any manual subtitle language
  for (const tracks of Object.values(subtitles)) {
    if (tracks?.length) {
      const u = findVttUrl(tracks);
      if (u) return u;
    }
  }

  // 2) Auto-generated captions
  for (const lang of preferredLangs) {
    if (automaticCaptions[lang]?.length) {
      const u = findVttUrl(automaticCaptions[lang]);
      if (u) return u;
    }
  }
  // Any auto-caption language
  for (const tracks of Object.values(automaticCaptions)) {
    if (tracks?.length) {
      const u = findVttUrl(tracks);
      if (u) return u;
    }
  }
  return null;
}

// Run yt-dlp WITHOUT the JS runtime args (safe for subtitle-only fetches)
function runYtDlpForSubs(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", "yt_dlp", ...args], {
      env: PYTHON_ENV,
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(stderr.slice(-600) || `yt-dlp subs exited ${code}`));
    });
    proc.on("error", (err) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
  });
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v");
    } else if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
  } catch {}
  return null;
}

function buildFormats(ytFormats: any[]): VideoFormatOut[] {
  const qualityOrder: Record<number, number> = {
    2160: 10,
    1440: 9,
    1080: 8,
    720: 7,
    480: 6,
    360: 5,
    240: 4,
    144: 3,
  };

  const videoAudioFormats: VideoFormatOut[] = [];
  const mergeFormats: VideoFormatOut[] = [];
  let audioFormat: VideoFormatOut | null = null;

  const seenHeights = new Set<number>();
  const seenCombined = new Set<number>();

  // Find best audio itag for merging
  const bestAudioFmt =
    ytFormats
      .filter(
        (f) => f.acodec !== "none" && f.vcodec === "none" && f.ext === "m4a",
      )
      .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0] ??
    ytFormats.find((f) => f.acodec !== "none" && f.vcodec === "none");

  for (const fmt of ytFormats) {
    const hasVideo = fmt.vcodec !== "none" && !!fmt.vcodec;
    const hasAudio = fmt.acodec !== "none" && !!fmt.acodec;
    const height: number | null = fmt.height ?? null;

    if (hasVideo && hasAudio) {
      // Combined format (e.g., itag 18, 22)
      if (height && seenCombined.has(height)) continue;
      if (height) seenCombined.add(height);

      const qual = height ? `${height}p` : (fmt.format_note ?? "unknown");
      videoAudioFormats.push({
        formatId: fmt.format_id,
        ext: fmt.ext ?? "mp4",
        resolution: height ? `${fmt.width ?? "?"}x${height}` : qual,
        fps: fmt.fps ?? null,
        filesize: fmt.filesize ?? fmt.filesize_approx ?? null,
        vcodec: fmt.vcodec ?? null,
        acodec: fmt.acodec ?? null,
        quality: qual,
        label: `${qual} (video+audio)`,
        hasVideo: true,
        hasAudio: true,
      });
    } else if (hasVideo && !hasAudio) {
      // Video-only: offer as merge with best audio
      if (!height) continue;
      if (seenHeights.has(height)) continue;
      seenHeights.add(height);

      const qual = `${height}p`;
      const audioItag = bestAudioFmt?.format_id;
      const mergeId = audioItag
        ? `${fmt.format_id}+${audioItag}`
        : `${fmt.format_id}+bestaudio`;
      mergeFormats.push({
        formatId: mergeId,
        ext: "mp4",
        resolution: `${fmt.width ?? "?"}x${height}`,
        fps: fmt.fps ?? null,
        filesize: null,
        vcodec: fmt.vcodec ?? null,
        acodec: "aac",
        quality: qual,
        label: `${qual} (merged, best quality)`,
        hasVideo: true,
        hasAudio: true,
      });
    }
  }

  // Best audio-only (MP3)
  if (bestAudioFmt) {
    const bitrateKbps = bestAudioFmt.abr
      ? `${Math.round(bestAudioFmt.abr)}kbps`
      : "best";
    audioFormat = {
      formatId: `audio:${bestAudioFmt.format_id}`,
      ext: "mp3",
      resolution: "audio only",
      fps: null,
      filesize: bestAudioFmt.filesize ?? bestAudioFmt.filesize_approx ?? null,
      vcodec: null,
      acodec: "mp3",
      quality: bitrateKbps,
      label: `Audio Only (MP3 ${bitrateKbps})`,
      hasVideo: false,
      hasAudio: true,
    };
  }

  const sortFn = (a: VideoFormatOut, b: VideoFormatOut) => {
    const aH = parseInt(a.quality) || 0;
    const bH = parseInt(b.quality) || 0;
    return (qualityOrder[bH] ?? bH) - (qualityOrder[aH] ?? aH);
  };

  return [
    ...videoAudioFormats.sort(sortFn),
    ...mergeFormats.sort(sortFn),
    ...(audioFormat ? [audioFormat] : []),
  ];
}

router.post("/youtube/info", async (req: Request, res: Response) => {
  const { url } = req.body as { url: string };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  if (
    !extractVideoId(url) &&
    !url.includes("youtube.com") &&
    !url.includes("youtu.be")
  ) {
    res.status(400).json({
      error:
        "Invalid YouTube URL. Use a link like https://www.youtube.com/watch?v=...",
    });
    return;
  }

  try {
    const json = await runYtDlp([
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      url,
    ]);
    const data = JSON.parse(json);

    const formats = buildFormats(data.formats ?? []);

    const thumbnail =
      data.thumbnail ??
      (Array.isArray(data.thumbnails)
        ? data.thumbnails[data.thumbnails.length - 1]?.url
        : null) ??
      null;

    res.json({
      id: data.id,
      title: data.title ?? "Unknown Title",
      duration: data.duration ?? null,
      thumbnail,
      uploader: data.uploader ?? data.channel ?? null,
      viewCount: data.view_count ?? null,
      uploadDate: data.upload_date ?? null,
      description: (data.description ?? "").slice(0, 500) || null,
      formats,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get video info");
    const message = err instanceof Error ? err.message : "Unknown error";
    res
      .status(500)
      .json({ error: "Failed to fetch video information", details: message });
  }
});

router.post("/youtube/download", async (req: Request, res: Response) => {
  const { url, formatId, audioOnly } = req.body as {
    url: string;
    formatId: string;
    audioOnly?: boolean;
  };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  if (!formatId) {
    res.status(400).json({ error: "formatId is required" });
    return;
  }

  const jobId = randomUUID();
  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: null,
    filesize: null,
    message: "Starting download...",
    filePath: null,
    url,
    formatId,
    audioOnly: audioOnly ?? false,
    ext: "mp4",
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Download started" });

  processDownload(jobId, job).catch((err) => {
    req.log.error({ err, jobId }, "Download job failed");
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.message = err instanceof Error ? err.message : "Download failed";
    }
  });
});

async function processDownload(jobId: string, job: DownloadJob): Promise<void> {
  const jobRef = jobs.get(jobId)!;

  const isAudioOnly = job.audioOnly || job.formatId.startsWith("audio:");

  const rawFormatId = isAudioOnly
    ? job.formatId.replace("audio:", "")
    : job.formatId;

  const ext = isAudioOnly ? "mp3" : "mp4";
  const outputPath = join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  jobRef.ext = ext;
  jobRef.status = "downloading";
  jobRef.message = isAudioOnly ? "Downloading audio..." : "Downloading...";

  const args: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
  ];

  if (isAudioOnly) {
    args.push("-f", rawFormatId);
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    args.push("-f", rawFormatId);
    args.push("--merge-output-format", "mp4");
  }

  args.push("-o", outputPath, job.url);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "python3",
      ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args],
      {
        env: PYTHON_ENV,
      },
    );
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse progress lines: [download]  xx.x% of ~xx.xxMiB at xx.xxMiB/s ETA xx:xx
        const progressMatch = trimmed.match(
          /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)([\w]+)\s+at\s+([\d.]+)([\w/]+)\s+ETA\s+(\S+)/,
        );
        if (progressMatch) {
          const percent = parseFloat(progressMatch[1]);
          const sizeNum = parseFloat(progressMatch[2]);
          const sizeUnit = progressMatch[3];
          const speedNum = parseFloat(progressMatch[4]);
          const speedUnit = progressMatch[5];
          const eta = progressMatch[6];

          jobRef.percent = Math.round(percent);
          jobRef.speed = `${speedNum}${speedUnit}`;
          jobRef.eta = eta === "Unknown" ? null : eta;

          const mult: Record<string, number> = {
            B: 1,
            KiB: 1024,
            MiB: 1024 * 1024,
            GiB: 1024 * 1024 * 1024,
            KB: 1000,
            MB: 1000000,
            GB: 1000000000,
          };
          if (sizeUnit in mult) {
            jobRef.filesize = Math.round(sizeNum * mult[sizeUnit]);
          }
          continue;
        }

        // Destination file (may appear multiple times: first for raw, then for converted)
        const destMatch = trimmed.match(
          /\[(?:download|ExtractAudio|Merger)\] Destination:\s+(.+)/,
        );
        if (destMatch) {
          const destPath = destMatch[1].trim();
          const fname = destPath.split("/").pop() ?? destPath;
          // Always update filePath (last Destination wins — e.g. mp3 after m4a)
          jobRef.filename = fname;
          jobRef.filePath = destPath;
        }

        // Merging
        if (
          trimmed.includes("Merging formats") ||
          trimmed.includes("[Merger]")
        ) {
          jobRef.status = "merging";
          jobRef.message = "Merging video and audio...";
          jobRef.percent = Math.max(jobRef.percent ?? 0, 90);
        }

        // Already downloaded
        if (trimmed.includes("has already been downloaded")) {
          const alreadyMatch = trimmed.match(
            /\[download\] (.+) has already been downloaded/,
          );
          if (alreadyMatch) {
            jobRef.filename = alreadyMatch[1].split("/").pop() ?? "";
            jobRef.filePath = alreadyMatch[1].trim();
          }
        }
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`),
        );
    });

    proc.on("error", (err: Error) =>
      reject(new Error(`Failed to start yt-dlp: ${err.message}`)),
    );
  });

  // Find the output file (yt-dlp may change extension)
  const possibleExts = isAudioOnly ? ["mp3"] : ["mp4", "mkv", "webm"];
  let finalPath: string | null = null;

  for (const e of possibleExts) {
    const p = join(DOWNLOAD_DIR, `${jobId}.${e}`);
    if (existsSync(p)) {
      finalPath = p;
      jobRef.ext = e;
      break;
    }
  }

  // If not found by ext, try to use the path set from stdout
  if (!finalPath && jobRef.filePath && existsSync(jobRef.filePath)) {
    finalPath = jobRef.filePath;
  }

  if (!finalPath) {
    throw new Error("Downloaded file not found on disk");
  }

  const stats = statSync(finalPath);
  jobRef.filesize = stats.size;
  jobRef.filePath = finalPath;
  if (!jobRef.filename) {
    jobRef.filename = finalPath.split("/").pop() ?? `video.${jobRef.ext}`;
  }
  jobRef.status = "done";
  jobRef.percent = 100;
  jobRef.speed = null;
  jobRef.eta = null;
  jobRef.message = null;
  scheduleAutoDelete(jobId, jobRef);
}

router.get("/youtube/progress/:jobId", (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({
    jobId,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    filesize: job.filesize,
    message: job.message,
  });
});

router.get("/youtube/file/:jobId", (req: Request, res: Response) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found", expired: true });
    return;
  }
  if (job.status === "expired") {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }
  if (job.status !== "done" || !job.filePath) {
    res.status(404).json({ error: "File not found or download not complete" });
    return;
  }

  if (!existsSync(job.filePath)) {
    res.status(410).json({
      error: "File has expired. Please download the video again.",
      expired: true,
    });
    return;
  }

  const stats = statSync(job.filePath);
  const filename = job.filename ?? `video.${job.ext}`;

  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`,
  );
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", stats.size);

  const readStream = createReadStream(job.filePath);
  readStream.pipe(res);

  readStream.on("close", () => {
    try {
      unlinkSync(job.filePath!);
    } catch {}
    jobs.delete(jobId);
  });
});

// ─── Best Clips Feature (streaming with SSE) ──────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}

function vttTimeToSec(t: string): number {
  const parts = t.split(":");
  if (parts.length === 3)
    return (
      parseFloat(parts[0]) * 3600 +
      parseFloat(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  for (const block of content.split(/\n\n+/)) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine
      .split("-->")
      .map((s) => s.trim().split(" ")[0]);
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
      const mm = Math.floor(c.startSec / 60);
      const ss = Math.floor(c.startSec % 60);
      return `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${c.text}`;
    })
    .join("\n");
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Smart transcript sampling: for very long transcripts, evenly sample lines
 * from across the ENTIRE timeline instead of hard-cutting at a char limit.
 * This guarantees the AI sees content from start, middle, and end of the video.
 */
function sampleTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;

  const lines = transcript.split("\n").filter(Boolean);
  // How many lines fit within our budget (avg ~85 chars/line including timestamp)?
  const targetLineCount = Math.floor(maxChars / 85);

  if (lines.length <= targetLineCount) return transcript.slice(0, maxChars);

  // Evenly stride across the full line array — preserves temporal spread
  const step = lines.length / targetLineCount;
  const sampled: string[] = [];
  for (let i = 0; i < targetLineCount; i++) {
    const idx = Math.floor(i * step);
    if (lines[idx]) sampled.push(lines[idx]);
  }

  const result = sampled.join("\n");
  // Prefix note so the AI knows some lines were sampled
  return `[Note: transcript sampled evenly from all ${lines.length} lines for full-video coverage]\n${result}`;
}

/**
 * Robust JSON array extractor: handles markdown fences, surrounding text,
 * and nested objects. Returns null if nothing parseable is found.
 */
function extractJsonArray(raw: string): any[] | null {
  // 1. Strip markdown fences (``` or ```json)
  let cleaned = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();

  // 2. Direct parse attempt
  try {
    const r = JSON.parse(cleaned);
    if (Array.isArray(r)) return r;
    if (r && typeof r === "object") return [r];
  } catch {}

  // 3. Try to extract the first [...] block from arbitrary surrounding text
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const r = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(r)) return r;
    } catch {}
  }

  // 4. Try extracting each {...} object individually and collect
  const objects: any[] = [];
  const objRe = /\{[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRe.exec(cleaned)) !== null) {
    try {
      const o = JSON.parse(match[0]);
      if (o && typeof o === "object") objects.push(o);
    } catch {}
  }
  if (objects.length > 0) return objects;

  return null;
}

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

interface ClipJob {
  emitter: EventEmitter;
  status: "pending" | "running" | "done" | "error";
  result?: { clips: BestClip[]; hasTranscript: boolean; videoDuration: number };
  error?: string;
  createdAt: number;
}

const clipJobs = new Map<string, ClipJob>();

// Clean up clip jobs older than 30 minutes
setInterval(
  () => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, job] of clipJobs.entries()) {
      if (job.createdAt < cutoff) clipJobs.delete(id);
    }
  },
  10 * 60 * 1000,
);

// POST: start a clip analysis job, return jobId immediately
router.post("/youtube/clips", async (req: Request, res: Response) => {
  const { url, durations, auto } = req.body as {
    url: string;
    durations?: number[];
    auto?: boolean;
  };
  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(503).json({
      error: "AI not configured",
      details: "GEMINI_API_KEY is not set",
    });
    return;
  }

  const jobId = randomUUID();
  const job: ClipJob = {
    emitter: new EventEmitter(),
    status: "pending",
    createdAt: Date.now(),
  };
  job.emitter.setMaxListeners(5);
  clipJobs.set(jobId, job);
  res.json({ jobId });

  // Run analysis in background
  runClipAnalysis(jobId, job, url, durations ?? [], req.log, auto ?? false).catch(() => {});
});

// GET: SSE stream for a clip job
router.get("/youtube/clips/stream/:jobId", (req: Request, res: Response) => {
  const job = clipJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // If already finished, send result immediately
  if (job.status === "done" && job.result) {
    send({ type: "done", ...job.result });
    res.end();
    return;
  }
  if (job.status === "error") {
    send({ type: "error", message: job.error });
    res.end();
    return;
  }

  const onStep = (d: any) => send({ type: "step", ...d });
  const onDone = (d: any) => {
    send({ type: "done", ...d });
    res.end();
  };
  const onError = (d: any) => {
    send({ type: "error", ...d });
    res.end();
  };

  job.emitter.on("step", onStep);
  job.emitter.on("done", onDone);
  job.emitter.on("error", onError);

  req.on("close", () => {
    job.emitter.off("step", onStep);
    job.emitter.off("done", onDone);
    job.emitter.off("error", onError);
  });
});

async function runClipAnalysis(
  jobId: string,
  job: ClipJob,
  url: string,
  durations: number[],
  log: any,
  autoMode: boolean = false,
): Promise<void> {
  const emit = (event: string, data: object) => job.emitter.emit(event, data);
  const step = (
    step: string,
    status: "running" | "done" | "warn",
    message: string,
    data?: object,
  ) => emit("step", { step, status, message, ...data });

  job.status = "running";

  const clipDurations = durations.length > 0 ? durations : [60, 180, 300];
  const tmpId = randomUUID();
  const subDir = join(DOWNLOAD_DIR, `subs_${tmpId}`);

  const durationLabels: Record<number, string> = {
    60: "1 minute",
    180: "3 minutes",
    300: "5 minutes",
    9999: "> 5 minutes (AI picks exact length)",
  };

  try {
    let transcript = "";
    let videoDuration = 0;
    let videoTitle = "";
    let videoDescription = "";
    let metaSubtitleUrl: string | null = null;

    // ── Step 1: Video metadata ─────────────────────────────────────────────
    step("metadata", "running", "Fetching video info...");
    try {
      const metaJson = await runYtDlp([
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        url,
      ]);
      const meta = JSON.parse(metaJson);
      videoDuration = meta.duration ?? 0;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 1000);

      // Extract subtitle URL from metadata so Step 2 can use it without another yt-dlp call
      const subs: Record<string, any[]> = meta.subtitles ?? {};
      const autoCaps: Record<string, any[]> = meta.automatic_captions ?? {};
      const videoLang: string | undefined =
        meta.language ?? meta.original_language ?? undefined;
      metaSubtitleUrl = pickBestSubtitleUrl(subs, autoCaps, videoLang);

      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        transcript = meta.chapters
          .map(
            (c: any) =>
              `[${formatTime(c.start_time)}–${formatTime(c.end_time ?? c.start_time + 60)}] Chapter: ${c.title}`,
          )
          .join("\n");
      }

      step(
        "metadata",
        "done",
        `"${videoTitle.slice(0, 60)}${videoTitle.length > 60 ? "…" : ""}"` +
          (videoDuration ? ` · ${formatTime(videoDuration)}` : ""),
        { videoTitle, videoDuration },
      );
    } catch (e) {
      step("metadata", "warn", "Could not load full metadata — trying anyway");
    }

    // ── Step 2: Transcript ────────────────────────────────────────────────
    if (!transcript) {
      step("transcript", "running", "Downloading transcript...");
      let vttContent: string | null = null;

      // Approach 1: Direct URL fetch from metadata subtitle map (fastest, no extra yt-dlp)
      if (metaSubtitleUrl && !vttContent) {
        try {
          const raw = await fetchUrl(metaSubtitleUrl);
          if (raw.includes("WEBVTT") || raw.includes("-->")) vttContent = raw;
        } catch (_e) {}
      }

      // Approach 2: yt-dlp subtitle download WITHOUT js-runtime args (they break sub fetching)
      if (!vttContent) {
        try {
          mkdirSync(subDir, { recursive: true });
          const subBase = join(subDir, "sub");

          // Try 1: language-specific (en + hi + any auto)
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

          // Try 2: any language auto-subs if first attempt got nothing
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

          if (existsSync(subDir)) {
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
          }
        } catch (_e) {
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

      if (vttContent) {
        const cues = parseVtt(vttContent);
        const deduped: VttCue[] = [];
        for (const cue of cues) {
          if (!deduped.length || deduped[deduped.length - 1].text !== cue.text)
            deduped.push(cue);
        }
        transcript = cuesToText(deduped);
        step(
          "transcript",
          "done",
          `Transcript ready — ${deduped.length} lines`,
          { hasTranscript: true },
        );
      } else {
        step(
          "transcript",
          "warn",
          "No transcript found — AI will use title & description",
          { hasTranscript: false },
        );
      }
    } else {
      step(
        "transcript",
        "done",
        `${transcript.split("\n").length} chapter markers found`,
        { hasTranscript: true },
      );
    }

    const hasTranscript = transcript.length > 50;
    const validDurations = clipDurations.filter((d) => {
      if (d === 9999) return !videoDuration || videoDuration > 300; // keep >5min if video is long enough
      return !videoDuration || d < videoDuration;
    });

    // ── Step 3: AI analysis ───────────────────────────────────────────────
    step(
      "ai",
      "running",
      autoMode
        ? `AI is deciding the best clip durations and scanning the entire video...`
        : `AI is scanning every segment of the video for all ${validDurations.map((d) => durationLabels[d] ?? `${Math.round(d / 60)}min`).join(", ")} clips...`,
    );

    // Use smart sampling so very long transcripts still cover the full video
    const MAX_TRANSCRIPT_CHARS = 500000;
    const transcriptForAI = hasTranscript
      ? sampleTranscript(transcript, MAX_TRANSCRIPT_CHARS)
      : "";

    const transcriptBlock = transcriptForAI
      ? `\nTranscript (may be Hindi, English, or mixed — sampled evenly from full video):\n${transcriptForAI}`
      : "\n[No transcript available — use video title, description, and typical content structure to infer segments. Distribute clips evenly across the full runtime.]";

    // Proportional coverage guidance (shared by both modes)
    const videoHours = videoDuration ? videoDuration / 3600 : 0;
    const videoDurationLabel = videoHours >= 1
      ? `${Math.round(videoHours * 10) / 10}-hour`
      : `${Math.round(videoDuration / 60)}-minute`;
    const expectedMinClips1min = videoDuration ? Math.max(5, Math.round(videoDuration / 240)) : 10;
    const coverageGuidance = videoDuration > 0
      ? `\nCOVERAGE MANDATE (${formatTime(videoDuration)} video):
- Spread clips proportionally across the ENTIRE runtime — beginning, every middle section, and end
- Do NOT cluster at the start — every 10-minute block of the ${videoDurationLabel} video deserves at least one clip
- A ${videoDurationLabel} video should yield at least ${expectedMinClips1min} clips total across all durations
- NEVER stop early — scan all the way to ${formatTime(videoDuration)}`
      : "";

    let systemPrompt: string;
    let userContent: string;

    // ── Shared cut-point rules (used in both modes) ───────────────────────
    const cutPointRules = `
HOW TO PICK startSec AND endSec — THIS IS THE MOST IMPORTANT PART:
- Use the transcript to read what the speaker says right up to your chosen endSec.
- startSec: the moment the segment's topic/idea/story actually begins — after any intro filler or transition.
- endSec: the LAST word of the speaker's complete thought, conclusion, punchline, or story beat — wherever the segment feels genuinely FINISHED.
- NEVER cut while someone is mid-sentence, mid-explanation, mid-story, or mid-argument.
- NEVER place endSec at a round number (e.g. exactly 60s, 180s, 300s) unless it genuinely coincides with a natural speech pause. Duration targets are guides, NOT cut points.
- If the natural ending of a segment is 40%, 60%, or even 100% longer than the target — that is CORRECT. Content quality beats duration precision. Always.
- Prefer ending on: a sentence-final pause, a punchline, a strong conclusion, a topic shift, applause, laughter, or a natural silence.
- For Hindi/mixed-language content: understand the language fully and find the natural linguistic boundary in whichever language is being spoken.`;

    if (autoMode) {
      // ── AUTO MODE: AI freely picks durations for every clip ───────────────
      systemPrompt = `You are a world-class video editor and content analyst. You are fluent in English and Hindi.

Your task: Watch the ENTIRE video and extract EVERY segment worth clipping. You have COMPLETE creative freedom — pick any startSec and endSec that makes the clip feel perfectly complete from beginning to end. There are no duration presets. Each clip's length emerges entirely from where the content naturally starts and ends.
${coverageGuidance}
${cutPointRules}

Additional rules:
1. No duration presets, no clip count cap — return every worthwhile segment
2. Clips must NOT overlap each other
3. Spread clips across the FULL runtime — start, every middle section, and end
4. targetDuration = Math.round(endSec - startSec) — just reflect the actual clip length you chose
5. startSec ≥ 0, endSec ≤ ${videoDuration || 99999}, endSec > startSec — plain integers
6. Write ALL output fields (title, description, reason) in English

CRITICAL: Respond with ONLY a valid JSON array — no markdown, no code fences, no extra text:
[{"targetDuration": <endSec minus startSec rounded to nearest second>, "startSec": <integer>, "endSec": <integer>, "title": "<English title>", "description": "<2-3 sentences English>", "reason": "<one sentence: what makes this a natural, complete standalone clip>"}]`;

      userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}
${transcriptBlock}

Find EVERY worthwhile clip. For each one: read the transcript carefully, find where the idea begins, read forward until you reach the natural conclusion of that idea — that is your endSec. No duration constraints, no clip count limit. Cover the full ${videoDuration ? formatTime(videoDuration) : "video"}.`;

    } else {
      // ── MANUAL MODE: fixed duration categories chosen by user ─────────────
      const durationDescList = validDurations
        .map((d) => {
          if (d === 9999) {
            return `- CATEGORY ">5 min" (targetDuration=9999): find clips longer than 5 minutes. You decide each clip's exact length — 6 min, 10 min, 20 min, whatever the content demands. No upper cap.`;
          }
          const label = durationLabels[d] ?? `${Math.round(d / 60)} minutes`;
          return `- CATEGORY "${label}" (targetDuration=${d}s): find clips roughly around ${label} long. The target is a loose guide — the actual clip must end at a natural speech/scene boundary even if that makes it noticeably shorter or longer than ${label}.`;
        })
        .join("\n");

      systemPrompt = `You are a world-class video editor and content analyst. You are fluent in English and Hindi.

Your task: Scan the ENTIRE video timeline from 0s to ${videoDuration || 99999}s and identify EVERY genuinely engaging segment for each requested duration category. There is NO upper limit on clip count — return every worthwhile segment you find.
${coverageGuidance}
${cutPointRules}

Additional rules:
1. Find ALL non-overlapping segments per category — zero artificial cap
2. Segments of the same targetDuration must NOT overlap (across different targetDurations, overlap is fine)
3. Spread clips across the ENTIRE runtime — don't cluster at the beginning
4. startSec ≥ 0, endSec ≤ ${videoDuration || 99999}, endSec > startSec — plain integers
5. Understand the transcript in whatever language it is (Hindi, English, mixed)
6. Write ALL output fields (title, description, reason) in English

CRITICAL: Respond with ONLY a valid JSON array — no markdown, no code fences, no explanation:
[{"targetDuration": <integer category value from the list>, "startSec": <integer>, "endSec": <integer>, "title": "<English title>", "description": "<2-3 sentences English>", "reason": "<one sentence English>"}]`;

      userContent = `Video: "${videoTitle}"
Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}
${transcriptBlock}

Find EVERY worthwhile clip for these categories:
${durationDescList}

For each clip: read the transcript to find where the idea begins (startSec) and where the speaker's complete thought finishes (endSec). The transcript is your source of truth for cut points — not the duration target. Scan the WHOLE video. No clip count limit.`;
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const result = await model.generateContent(
      systemPrompt + "\n\n" + userContent,
    );
    const raw = result.response.text().trim();

    // Robust parsing — handles markdown fences, surrounding text, type coercion
    const parsed = extractJsonArray(raw);
    if (!parsed) {
      log.error({ raw: raw.slice(0, 500) }, "Failed to parse Gemini response as JSON");
      job.status = "error";
      job.error = "Failed to parse AI response — please try again";
      emit("error", { message: job.error });
      return;
    }

    const clips: BestClip[] = parsed
      .filter((c: any) => {
        if (!c || typeof c !== "object") return false;
        // Coerce strings to numbers — AI sometimes quotes numbers
        const startSec = parseFloat(c.startSec);
        const endSec = parseFloat(c.endSec);
        const hasSecs = !isNaN(startSec) && !isNaN(endSec) && endSec > startSec;
        const targetRaw = c.targetDuration ?? c.durationSec ?? c.duration;
        const hasTarget = targetRaw != null && !isNaN(parseFloat(targetRaw));
        return hasSecs && hasTarget;
      })
      .map((c: any): BestClip => {
        const targetDur: number = Math.round(
          parseFloat(c.targetDuration ?? c.durationSec ?? c.duration),
        );
        const startSec = Math.max(0, Math.round(parseFloat(c.startSec)));
        const endSec = Math.min(
          videoDuration || 99999,
          Math.max(startSec + 1, Math.round(parseFloat(c.endSec) ?? startSec + targetDur)),
        );
        const actualMins = Math.round((endSec - startSec) / 60);
        // For the open-ended >5 min category, use a friendly label with actual length
        const durationLabel =
          targetDur === 9999
            ? `> 5 min (${actualMins}m)`
            : (durationLabels[targetDur] ?? `~${Math.round(targetDur / 60)} min`);
        return {
          durationLabel,
          durationSec: targetDur,
          startSec,
          endSec,
          startFormatted: formatTime(startSec),
          endFormatted: formatTime(endSec),
          title:
            c.title ??
            `Best ${durationLabels[targetDur] ?? targetDur + "s"} clip`,
          description: c.description ?? "",
          reason: c.reason ?? "",
        };
      })
      .sort((a, b) =>
        a.durationSec !== b.durationSec
          ? a.durationSec - b.durationSec
          : a.startSec - b.startSec,
      );

    step(
      "ai",
      "done",
      `Found ${clips.length} clips across ${validDurations.length} duration${validDurations.length !== 1 ? "s" : ""}`,
      { clipCount: clips.length },
    );

    log.info({ totalClips: clips.length }, "Clips analysis complete");

    const resultData = { clips, hasTranscript, videoDuration };
    job.status = "done";
    job.result = resultData;
    emit("done", resultData);
  } catch (err) {
    log.error({ err }, "Clip analysis failed");
    const message = err instanceof Error ? err.message : "Unknown error";
    job.status = "error";
    job.error = message;
    emit("error", { message });
    // Cleanup subtitle dir if it exists
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

// ─── Clip Download (specific time range) ─────────────────────────────────────

router.post("/youtube/download-clip", async (req: Request, res: Response) => {
  const { url, startSec, endSec, title } = req.body as {
    url: string;
    startSec: number;
    endSec: number;
    title?: string;
  };

  if (!url || startSec == null || endSec == null) {
    res.status(400).json({ error: "url, startSec, and endSec are required" });
    return;
  }

  const jobId = randomUUID();
  const safeTitle = (title ?? "clip")
    .replace(/[^\w\s\-_.()]/g, "_")
    .slice(0, 60);
  const job: DownloadJob = {
    status: "pending",
    percent: 0,
    speed: null,
    eta: null,
    filename: `${safeTitle}.mp4`,
    filesize: null,
    message: "Starting clip download...",
    filePath: null,
    url,
    formatId: "bestvideo+bestaudio/best",
    audioOnly: false,
    ext: "mp4",
  };

  jobs.set(jobId, job);
  res.json({ jobId, status: "pending", message: "Clip download started" });

  const start = formatTime(Math.round(startSec));
  const end = formatTime(Math.round(endSec));
  const outputPath = join(DOWNLOAD_DIR, `${jobId}.%(ext)s`);
  const jobRef = jobs.get(jobId)!;
  jobRef.status = "downloading";

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--newline",
    "--progress",
    "-f",
    "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--merge-output-format",
    "mp4",
    "--download-sections",
    `*${start}-${end}`,
    "--force-keyframes-at-cuts",
    "-o",
    outputPath,
    url,
  ];

  new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "python3",
      ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args],
      {
        env: PYTHON_ENV,
      },
    );
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const t = line.trim();
        const progressMatch = t.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          jobRef.percent = Math.round(parseFloat(progressMatch[1]));
        }
        const destMatch = t.match(
          /\[(?:download|Merger)\] Destination:\s+(.+)/,
        );
        if (destMatch) {
          jobRef.filePath = destMatch[1].trim();
          jobRef.filename =
            destMatch[1].trim().split("/").pop() ?? `${safeTitle}.mp4`;
        }
        if (t.includes("[Merger]")) {
          jobRef.status = "merging";
          jobRef.message = "Merging clip...";
        }
      }
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(stderr.slice(-400) || `yt-dlp exited with code ${code}`),
        );
    });
    proc.on("error", (err: Error) => reject(err));
  })
    .then(() => {
      const ext = ["mp4", "mkv", "webm"].find((e) =>
        existsSync(join(DOWNLOAD_DIR, `${jobId}.${e}`)),
      );
      const finalPath = ext
        ? join(DOWNLOAD_DIR, `${jobId}.${ext}`)
        : (jobRef.filePath ?? null);
      if (!finalPath || !existsSync(finalPath)) {
        jobRef.status = "error";
        jobRef.message = "Clip file not found after download";
        return;
      }
      jobRef.filePath = finalPath;
      jobRef.filename = `${safeTitle}.mp4`;
      jobRef.filesize = statSync(finalPath).size;
      jobRef.status = "done";
      jobRef.percent = 100;
      jobRef.speed = null;
      jobRef.eta = null;
      jobRef.message = null;
      scheduleAutoDelete(jobId, jobRef);
    })
    .catch((err) => {
      req.log.error({ err, jobId }, "Clip download failed");
      jobRef.status = "error";
      jobRef.message = err instanceof Error ? err.message : "Download failed";
    });
});

export default router;
