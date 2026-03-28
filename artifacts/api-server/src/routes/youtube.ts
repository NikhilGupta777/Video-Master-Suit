import { Router, type IRouter, type Request, type Response } from "express";
import { spawn } from "child_process";
import { existsSync, mkdirSync, unlinkSync, statSync, createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
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
  status: "pending" | "downloading" | "merging" | "done" | "error";
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

function runYtDlp(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-m", "yt_dlp", ...args], {
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
    const proc = spawn("python3", ["-m", "yt_dlp", ...args], {
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
  if (!job || job.status !== "done" || !job.filePath) {
    res.status(404).json({ error: "File not found or download not complete" });
    return;
  }

  if (!existsSync(job.filePath)) {
    res.status(404).json({ error: "File no longer exists on server" });
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

export default router;
