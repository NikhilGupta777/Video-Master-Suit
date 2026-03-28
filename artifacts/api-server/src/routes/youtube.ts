import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync, statSync, createReadStream, readFileSync, readdirSync, rmdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { GoogleGenerativeAI } from "@google/generative-ai";

const router: IRouter = Router();

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
function scheduleAutoDelete(jobId: string, jobRef: { filePath: string | null; status: string }) {
  setTimeout(() => {
    if (jobRef.filePath) {
      try { unlinkSync(jobRef.filePath); } catch {}
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
  "--js-runtimes", "node",
  "--remote-components", "ejs:github",
];

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args], {
      env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => { stdout += d.toString(); });
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`));
    });
    proc.on("error", (err) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));
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
    2160: 10, 1440: 9, 1080: 8, 720: 7, 480: 6, 360: 5, 240: 4, 144: 3,
  };

  const videoAudioFormats: VideoFormatOut[] = [];
  const mergeFormats: VideoFormatOut[] = [];
  let audioFormat: VideoFormatOut | null = null;

  const seenHeights = new Set<number>();
  const seenCombined = new Set<number>();

  // Find best audio itag for merging
  const bestAudioFmt = ytFormats
    .filter((f) => f.acodec !== "none" && f.vcodec === "none" && f.ext === "m4a")
    .sort((a, b) => (b.abr ?? 0) - (a.abr ?? 0))[0]
    ?? ytFormats.find((f) => f.acodec !== "none" && f.vcodec === "none");

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
      const mergeId = audioItag ? `${fmt.format_id}+${audioItag}` : `${fmt.format_id}+bestaudio`;
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

  if (!extractVideoId(url) && !url.includes("youtube.com") && !url.includes("youtu.be")) {
    res.status(400).json({ error: "Invalid YouTube URL. Use a link like https://www.youtube.com/watch?v=..." });
    return;
  }

  try {
    const json = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
    const data = JSON.parse(json);

    const formats = buildFormats(data.formats ?? []);

    const thumbnail =
      data.thumbnail ??
      (Array.isArray(data.thumbnails) ? data.thumbnails[data.thumbnails.length - 1]?.url : null) ??
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
    res.status(500).json({ error: "Failed to fetch video information", details: message });
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
    const proc = spawn("python3", ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args], {
      env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Parse progress lines: [download]  xx.x% of ~xx.xxMiB at xx.xxMiB/s ETA xx:xx
        const progressMatch = trimmed.match(
          /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)([\w]+)\s+at\s+([\d.]+)([\w/]+)\s+ETA\s+(\S+)/
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
            "B": 1, "KiB": 1024, "MiB": 1024 * 1024, "GiB": 1024 * 1024 * 1024,
            "KB": 1000, "MB": 1000000, "GB": 1000000000,
          };
          if (sizeUnit in mult) {
            jobRef.filesize = Math.round(sizeNum * mult[sizeUnit]);
          }
          continue;
        }

        // Destination file (may appear multiple times: first for raw, then for converted)
        const destMatch = trimmed.match(/\[(?:download|ExtractAudio|Merger)\] Destination:\s+(.+)/);
        if (destMatch) {
          const destPath = destMatch[1].trim();
          const fname = destPath.split("/").pop() ?? destPath;
          // Always update filePath (last Destination wins — e.g. mp3 after m4a)
          jobRef.filename = fname;
          jobRef.filePath = destPath;
        }

        // Merging
        if (trimmed.includes("Merging formats") || trimmed.includes("[Merger]")) {
          jobRef.status = "merging";
          jobRef.message = "Merging video and audio...";
          jobRef.percent = Math.max(jobRef.percent ?? 0, 90);
        }

        // Already downloaded
        if (trimmed.includes("has already been downloaded")) {
          const alreadyMatch = trimmed.match(/\[download\] (.+) has already been downloaded/);
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
      else reject(new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`));
    });

    proc.on("error", (err: Error) => reject(new Error(`Failed to start yt-dlp: ${err.message}`)));
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
    res.status(410).json({ error: "File has expired. Please download the video again.", expired: true });
    return;
  }
  if (job.status !== "done" || !job.filePath) {
    res.status(404).json({ error: "File not found or download not complete" });
    return;
  }

  if (!existsSync(job.filePath)) {
    res.status(410).json({ error: "File has expired. Please download the video again.", expired: true });
    return;
  }

  const stats = statSync(job.filePath);
  const filename = job.filename ?? `video.${job.ext}`;

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", stats.size);

  const readStream = createReadStream(job.filePath);
  readStream.pipe(res);

  readStream.on("close", () => {
    try { unlinkSync(job.filePath!); } catch {}
    jobs.delete(jobId);
  });
});

// ─── Best Clips Feature ────────────────────────────────────────────────────

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

interface VttCue {
  startSec: number;
  endSec: number;
  text: string;
}

function vttTimeToSec(t: string): number {
  const parts = t.split(":");
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  }
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

function parseVtt(content: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = content.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find(l => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map(s => s.trim().split(" ")[0]);
    const text = lines
      .filter(l => !l.includes("-->") && !l.match(/^\d+$/) && l.trim())
      .map(l => l.replace(/<[^>]+>/g, "").trim())
      .filter(Boolean)
      .join(" ");
    if (text) {
      cues.push({ startSec: vttTimeToSec(startStr), endSec: vttTimeToSec(endStr), text });
    }
  }
  return cues;
}

function cuesToText(cues: VttCue[]): string {
  return cues
    .map(c => {
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
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
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

router.post("/youtube/clips", async (req: Request, res: Response) => {
  const { url, durations } = req.body as { url: string; durations?: number[] };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  const clipDurations: number[] = (durations && durations.length > 0)
    ? durations
    : [60, 180, 300, 600];

  const tmpId = randomUUID();
  const subDir = join(DOWNLOAD_DIR, `subs_${tmpId}`);

  try {
    req.log.info({ url }, "Fetching metadata and transcript for clips analysis");

    let transcript = "";
    let videoDuration = 0;
    let videoTitle = "";
    let videoDescription = "";

    // 1. Get video metadata
    try {
      const metaJson = await runYtDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
      const meta = JSON.parse(metaJson);
      videoDuration = meta.duration ?? 0;
      videoTitle = meta.title ?? "";
      videoDescription = (meta.description ?? "").slice(0, 1000);

      // Use chapters if available (rich timestamp data)
      if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
        transcript = meta.chapters
          .map((c: any) => `[${formatTime(c.start_time)}–${formatTime(c.end_time ?? c.start_time + 60)}] Chapter: ${c.title}`)
          .join("\n");
        req.log.info({ chapCount: meta.chapters.length }, "Using chapter data as transcript");
      }
    } catch (e) {
      req.log.warn({ e }, "Failed to fetch video metadata");
    }

    // 2. Try to get subtitles/captions — multiple strategies for robustness
    if (!transcript) {
      try {
        mkdirSync(subDir, { recursive: true });

        // Strategy A: auto-subs with wildcard English match (covers en, en-US, en-GB, a.en, etc.)
        const subArgs = [
          "--write-subs", "--write-auto-subs",
          "--sub-lang", "en.*",
          "--sub-format", "vtt",
          "--skip-download",
          "--no-warnings",
          "--no-playlist",
          "-o", join(subDir, "sub"),
          url,
        ];

        await runYtDlp(subArgs).catch(() => {
          // Strategy B: try without language restriction (get whatever is available)
          return runYtDlp([
            "--write-auto-subs",
            "--sub-format", "vtt",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            "-o", join(subDir, "sub"),
            url,
          ]).catch(() => {});
        });

        // Scan the temp directory for any .vtt file produced
        let vttContent: string | null = null;
        if (existsSync(subDir)) {
          const created = readdirSync(subDir);
          req.log.info({ created }, "Subtitle files created");
          const vttFile = created
            .map(f => join(subDir, f))
            .find(f => f.endsWith(".vtt"));
          if (vttFile) {
            vttContent = readFileSync(vttFile, "utf8");
          }
          // Cleanup
          for (const f of created) {
            try { unlinkSync(join(subDir, f)); } catch {}
          }
          try { rmdirSync(subDir); } catch {}
        }

        if (vttContent) {
          const cues = parseVtt(vttContent);
          // Deduplicate sequential identical lines (VTT often repeats)
          const deduped: VttCue[] = [];
          for (const cue of cues) {
            if (deduped.length === 0 || deduped[deduped.length - 1].text !== cue.text) {
              deduped.push(cue);
            }
          }
          transcript = cuesToText(deduped);
          req.log.info({ cueCount: deduped.length }, "Successfully extracted transcript from subtitles");
        }
      } catch (e) {
        req.log.warn({ e }, "Failed to get subtitles, proceeding without transcript");
      }
    }

    // 3. Build context and call AI
    const hasTranscript = transcript.length > 50;
    const validDurations = clipDurations.filter(d => !videoDuration || d < videoDuration);

    const durationLabels: Record<number, string> = {
      60: "1 minute", 180: "3 minutes", 300: "5 minutes", 600: "10 minutes",
    };

    // Determine how many clips per duration based on video length
    const videoMinutes = videoDuration / 60;
    let clipsPerDuration = 3;
    if (videoMinutes >= 30) clipsPerDuration = 7;
    else if (videoMinutes >= 15) clipsPerDuration = 5;
    else if (videoMinutes >= 5) clipsPerDuration = 4;

    const durationDescList = validDurations
      .map(d => `- ${durationLabels[d] ?? `${Math.round(d / 60)} minutes`} (exactly ${d} seconds each)`)
      .join("\n");

    const systemPrompt = `You are an expert video content analyst specializing in identifying viral, engaging clip segments.

Your task: For each requested clip duration, identify ALL high-quality segments in the video — not just one.

Rules:
1. For each duration, find ${clipsPerDuration} to ${clipsPerDuration + 3} non-overlapping segments (fewer only if the video is short or lacks enough content)
2. Segments of the same duration must NOT overlap with each other
3. Cover different parts of the video — spread clips across the full runtime
4. Sort clips within each duration group by quality/engagement score (best first)
5. endSec must equal startSec + durationSec exactly
6. startSec ≥ 0, endSec ≤ ${videoDuration || 99999}
7. Prefer segments that start at natural speech/scene boundaries when transcript is available

Respond with ONLY a valid JSON array (no markdown, no explanation). Each object:
{
  "durationSec": <number — the exact requested duration in seconds>,
  "startSec": <number — clip start in seconds>,
  "title": "<short compelling clip title>",
  "description": "<2-3 sentences describing what happens and why it's engaging>",
  "reason": "<one sentence: why this specific moment is great for this duration>"
}`;

    const userContent = `Video: "${videoTitle}"
Total Duration: ${videoDuration ? formatTime(videoDuration) : "unknown"} (${videoDuration}s)
${videoDescription ? `Description: ${videoDescription}\n` : ""}
${hasTranscript ? `\nTranscript (timestamped):\n${transcript.slice(0, 14000)}` : "\n[No transcript available — use the title, description, and typical video structure to estimate best segments]"}

Find ALL best clips for each of these durations:
${durationDescList}

Remember: Return MULTIPLE clips per duration — aim for ${clipsPerDuration}–${clipsPerDuration + 3} clips per duration. Cover different sections of the video.`;

    req.log.info({ validDurations, hasTranscript, clipsPerDuration }, "Calling Gemini for multi-clip analysis");

    if (!process.env.GEMINI_API_KEY) {
      res.status(503).json({ error: "AI not configured", details: "GEMINI_API_KEY is not set" });
      return;
    }

    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
    const result = await model.generateContent(systemPrompt + "\n\n" + userContent);
    const raw = result.response.text().trim();
    let parsed: any[];

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [parsed];
    } catch (e) {
      req.log.error({ raw, e }, "Failed to parse Gemini response as JSON");
      res.status(500).json({ error: "Failed to parse AI response", raw });
      return;
    }

    const clips: BestClip[] = parsed
      .filter((c: any) => typeof c.startSec === "number" && typeof c.durationSec === "number")
      .map((c: any): BestClip => {
        const durSec = c.durationSec;
        const durLabel = durationLabels[durSec] ?? `${Math.round(durSec / 60)} min`;
        const startSec = Math.max(0, Math.round(c.startSec));
        const endSec = Math.min(videoDuration || 99999, startSec + durSec);
        return {
          durationLabel: durLabel,
          durationSec: durSec,
          startSec,
          endSec,
          startFormatted: formatTime(startSec),
          endFormatted: formatTime(endSec),
          title: c.title ?? `Best ${durLabel} clip`,
          description: c.description ?? "",
          reason: c.reason ?? "",
        };
      })
      // Sort by duration first, then by start time within each duration
      .sort((a: BestClip, b: BestClip) => a.durationSec !== b.durationSec
        ? a.durationSec - b.durationSec
        : a.startSec - b.startSec
      );

    req.log.info({ totalClips: clips.length }, "Clips analysis complete");
    res.json({ clips, hasTranscript, videoDuration });

  } catch (err) {
    req.log.error({ err }, "Failed to find best clips");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "Failed to analyze video for clips", details: message });
  }
});

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
  const safeTitle = (title ?? "clip").replace(/[^\w\s\-_.()]/g, "_").slice(0, 60);
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
    "--no-playlist", "--no-warnings", "--newline", "--progress",
    "-f", "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
    "--merge-output-format", "mp4",
    "--download-sections", `*${start}-${end}`,
    "--force-keyframes-at-cuts",
    "-o", outputPath,
    url,
  ];

  new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", ["-m", "yt_dlp", ...BASE_YTDLP_ARGS, ...args], {
      env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const t = line.trim();
        const progressMatch = t.match(/\[download\]\s+([\d.]+)%/);
        if (progressMatch) {
          jobRef.percent = Math.round(parseFloat(progressMatch[1]));
        }
        const destMatch = t.match(/\[(?:download|Merger)\] Destination:\s+(.+)/);
        if (destMatch) {
          jobRef.filePath = destMatch[1].trim();
          jobRef.filename = destMatch[1].trim().split("/").pop() ?? `${safeTitle}.mp4`;
        }
        if (t.includes("[Merger]")) {
          jobRef.status = "merging";
          jobRef.message = "Merging clip...";
        }
      }
    });
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-400) || `yt-dlp exited with code ${code}`));
    });
    proc.on("error", (err: Error) => reject(err));
  })
    .then(() => {
      const ext = ["mp4", "mkv", "webm"].find(e => existsSync(join(DOWNLOAD_DIR, `${jobId}.${e}`)));
      const finalPath = ext ? join(DOWNLOAD_DIR, `${jobId}.${ext}`) : (jobRef.filePath ?? null);
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
