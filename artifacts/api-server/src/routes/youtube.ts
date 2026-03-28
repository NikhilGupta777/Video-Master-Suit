import { Router, type IRouter, type Request, type Response } from "express";
import { Innertube } from "youtubei.js";
import { spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

const router: IRouter = Router();

let yt: Innertube | null = null;
async function getYt(): Promise<Innertube> {
  if (!yt) {
    yt = await Innertube.create({
      cache: undefined,
      generate_session_locally: true,
    });
  }
  return yt;
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

const DOWNLOAD_DIR = join(tmpdir(), "yt-downloader");
if (!existsSync(DOWNLOAD_DIR)) {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes.toFixed(0) + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatSeconds(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function parseCodecsFromMime(mimeType: string): { ext: string; vcodec: string | null; acodec: string | null } {
  const mimeMatch = mimeType.match(/^(video|audio)\/([^;]+)/);
  const codecsMatch = mimeType.match(/codecs="([^"]+)"/);
  const container = mimeMatch?.[2] ?? "mp4";
  const codecs = codecsMatch?.[1]?.split(",").map(c => c.trim()) ?? [];
  const mediaType = mimeMatch?.[1] ?? "video";
  let ext = container === "webm" ? "webm" : "mp4";
  let vcodec: string | null = null;
  let acodec: string | null = null;
  if (mediaType === "video") {
    vcodec = codecs[0] ?? null;
    acodec = codecs[1] ?? null;
  } else {
    acodec = codecs[0] ?? null;
    ext = "m4a";
  }
  return { ext, vcodec, acodec };
}

function buildFormats(streamingData: any): VideoFormatOut[] {
  const allFormats: any[] = [
    ...(streamingData?.adaptive_formats ?? []),
    ...(streamingData?.formats ?? []),
  ];

  const qualityOrder: Record<string, number> = {
    "2160p": 10, "1440p": 9, "1080p": 8, "720p": 7,
    "480p": 6, "360p": 5, "240p": 4, "144p": 3,
  };

  const videoAudioFormats: VideoFormatOut[] = [];
  const videoOnlyFormats: VideoFormatOut[] = [];
  const audioOnlyFormats: VideoFormatOut[] = [];

  const bestVaByQuality = new Map<string, any>();
  const bestVByQuality = new Map<string, any>();
  let bestAudioFmt: any = null;

  for (const fmt of allFormats) {
    const hasVideo = !!fmt.has_video;
    const hasAudio = !!fmt.has_audio;
    const qualityLabel: string = fmt.quality_label ?? fmt.quality ?? "unknown";

    if (hasVideo && hasAudio) {
      const existing = bestVaByQuality.get(qualityLabel);
      if (!existing || (fmt.average_bitrate ?? 0) > (existing.average_bitrate ?? 0)) {
        bestVaByQuality.set(qualityLabel, fmt);
      }
    } else if (hasVideo) {
      const existing = bestVByQuality.get(qualityLabel);
      if (!existing || (fmt.average_bitrate ?? 0) > (existing.average_bitrate ?? 0)) {
        bestVByQuality.set(qualityLabel, fmt);
      }
    } else if (hasAudio) {
      const mimeType = fmt.mime_type ?? "";
      if (mimeType.includes("mp4") || mimeType.includes("m4a")) {
        if (!bestAudioFmt || (fmt.average_bitrate ?? 0) > (bestAudioFmt.average_bitrate ?? 0)) {
          bestAudioFmt = fmt;
        }
      } else if (!bestAudioFmt) {
        bestAudioFmt = fmt;
      }
    }
  }

  for (const [qualityLabel, fmt] of bestVaByQuality.entries()) {
    const { ext, vcodec, acodec } = parseCodecsFromMime(fmt.mime_type ?? "video/mp4");
    videoAudioFormats.push({
      formatId: String(fmt.itag),
      ext,
      resolution: fmt.width && fmt.height ? `${fmt.width}x${fmt.height}` : qualityLabel,
      fps: fmt.fps ?? null,
      filesize: fmt.content_length ?? null,
      vcodec,
      acodec,
      quality: qualityLabel,
      label: `${qualityLabel} (video+audio)`,
      hasVideo: true,
      hasAudio: true,
    });
  }

  for (const [qualityLabel, fmt] of bestVByQuality.entries()) {
    const { vcodec } = parseCodecsFromMime(fmt.mime_type ?? "video/mp4");
    videoOnlyFormats.push({
      formatId: `merge:${fmt.itag}`,
      ext: "mp4",
      resolution: fmt.width && fmt.height ? `${fmt.width}x${fmt.height}` : qualityLabel,
      fps: fmt.fps ?? null,
      filesize: fmt.content_length ?? null,
      vcodec,
      acodec: "aac",
      quality: qualityLabel,
      label: `${qualityLabel} (merged with best audio)`,
      hasVideo: true,
      hasAudio: true,
    });
  }

  if (bestAudioFmt) {
    const bitrateKbps = bestAudioFmt.average_bitrate
      ? `${Math.round(bestAudioFmt.average_bitrate / 1000)}kbps`
      : "128kbps";
    audioOnlyFormats.push({
      formatId: `audio:${bestAudioFmt.itag}`,
      ext: "mp3",
      resolution: "audio only",
      fps: null,
      filesize: bestAudioFmt.content_length ?? null,
      vcodec: null,
      acodec: parseCodecsFromMime(bestAudioFmt.mime_type ?? "audio/mp4").acodec,
      quality: bitrateKbps,
      label: `Audio Only (MP3 ${bitrateKbps})`,
      hasVideo: false,
      hasAudio: true,
    });
  }

  const sortFn = (a: VideoFormatOut, b: VideoFormatOut) => {
    const aOrder = qualityOrder[a.quality] ?? 0;
    const bOrder = qualityOrder[b.quality] ?? 0;
    return bOrder - aOrder;
  };

  return [
    ...videoAudioFormats.sort(sortFn),
    ...videoOnlyFormats.sort(sortFn),
    ...audioOnlyFormats,
  ];
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

router.post("/youtube/info", async (req: Request, res: Response) => {
  const { url } = req.body as { url: string };

  if (!url) {
    res.status(400).json({ error: "URL is required" });
    return;
  }

  const videoId = extractVideoId(url);
  if (!videoId) {
    res.status(400).json({ error: "Invalid YouTube URL. Use a link like https://www.youtube.com/watch?v=..." });
    return;
  }

  try {
    const tube = await getYt();
    const info = await tube.getInfo(videoId);
    const details = info.basic_info;
    const streamingData = (info as any).streaming_data;

    const formats = buildFormats(streamingData);

    const thumbnail = Array.isArray(details.thumbnail)
      ? details.thumbnail[details.thumbnail.length - 1]?.url ?? null
      : (details.thumbnail as any)?.url ?? null;

    res.json({
      id: videoId,
      title: details.title ?? "Unknown Title",
      duration: details.duration ?? null,
      thumbnail,
      uploader: (details as any).channel?.name ?? (details as any).author ?? null,
      viewCount: details.view_count ?? null,
      uploadDate: null,
      description: ((details as any).short_description ?? "").slice(0, 500) || null,
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

  const videoId = extractVideoId(url);
  if (!videoId) {
    res.status(400).json({ error: "Invalid YouTube URL" });
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

  processDownload(jobId, job, videoId).catch((err) => {
    const j = jobs.get(jobId);
    if (j) {
      j.status = "error";
      j.message = err instanceof Error ? err.message : "Download failed";
    }
  });
});

async function processDownload(jobId: string, job: DownloadJob, videoId: string): Promise<void> {
  const jobRef = jobs.get(jobId)!;

  try {
    const tube = await getYt();
    const info = await tube.getInfo(videoId);
    const details = info.basic_info;
    const title = (details.title ?? "video").replace(/[^\w\s\-_.()]/g, "_").slice(0, 100);
    const streamingData = (info as any).streaming_data;

    const allFormats: any[] = [
      ...(streamingData?.adaptive_formats ?? []),
      ...(streamingData?.formats ?? []),
    ];

    const isAudioOnly = job.audioOnly || job.formatId.startsWith("audio:");
    const isMerge = job.formatId.startsWith("merge:");

    if (isAudioOnly) {
      const rawItag = parseInt(job.formatId.replace("audio:", ""));
      const fmt = allFormats.find((f: any) => f.itag === rawItag) ?? allFormats.find((f: any) => f.has_audio && !f.has_video);
      if (!fmt) throw new Error("Audio format not found");

      const ext = "mp3";
      const filename = `${title}.${ext}`;
      const filePath = join(DOWNLOAD_DIR, `${jobId}.${ext}`);
      jobRef.filename = filename;
      jobRef.ext = ext;
      jobRef.status = "downloading";

      const stream = await info.download({
        type: "audio",
        quality: "best",
        client: "WEB",
      } as any);

      await readableStreamToFile(stream, filePath, jobRef);
      jobRef.status = "done";
      jobRef.percent = 100;
      jobRef.filePath = filePath;
      jobRef.message = null;

    } else if (isMerge) {
      const videoItag = parseInt(job.formatId.replace("merge:", ""));
      const videoFmt = allFormats.find((f: any) => f.itag === videoItag);
      if (!videoFmt) throw new Error("Video format not found");

      const qualityLabel = videoFmt.quality_label ?? videoFmt.quality ?? "video";
      const filename = `${title}_${qualityLabel}.mp4`;
      const filePath = join(DOWNLOAD_DIR, `${jobId}.mp4`);
      const videoTmp = join(DOWNLOAD_DIR, `${jobId}_video.tmp`);
      const audioTmp = join(DOWNLOAD_DIR, `${jobId}_audio.tmp`);
      jobRef.filename = filename;
      jobRef.ext = "mp4";
      jobRef.status = "downloading";
      jobRef.message = "Downloading video stream...";

      const videoStream = await info.download({
        type: "video",
        quality: qualityLabel,
        client: "WEB",
      } as any);
      await readableStreamToFile(videoStream, videoTmp, jobRef, 0, 45);

      jobRef.message = "Downloading audio stream...";
      const audioStream = await info.download({
        type: "audio",
        quality: "best",
        client: "WEB",
      } as any);
      await readableStreamToFile(audioStream, audioTmp, jobRef, 45, 85);

      jobRef.status = "merging";
      jobRef.percent = 90;
      jobRef.message = "Merging video and audio with ffmpeg...";

      await ffmpegMerge(videoTmp, audioTmp, filePath);

      try { unlinkSync(videoTmp); } catch {}
      try { unlinkSync(audioTmp); } catch {}

      jobRef.status = "done";
      jobRef.percent = 100;
      jobRef.filePath = filePath;
      jobRef.message = null;

    } else {
      const itag = parseInt(job.formatId);
      const fmt = allFormats.find((f: any) => f.itag === itag);
      if (!fmt) throw new Error("Format not found");

      const qualityLabel = fmt.quality_label ?? fmt.quality ?? "video";
      const { ext } = parseCodecsFromMime(fmt.mime_type ?? "video/mp4");
      const filename = `${title}_${qualityLabel}.${ext}`;
      const filePath = join(DOWNLOAD_DIR, `${jobId}.${ext}`);
      jobRef.filename = filename;
      jobRef.ext = ext;
      jobRef.status = "downloading";
      jobRef.filesize = fmt.content_length ?? null;

      const stream = await info.download({
        type: "video+audio",
        itag,
        client: "WEB",
      } as any);

      await readableStreamToFile(stream, filePath, jobRef);
      jobRef.status = "done";
      jobRef.percent = 100;
      jobRef.filePath = filePath;
      jobRef.speed = null;
      jobRef.eta = null;
      jobRef.message = null;
    }
  } catch (err) {
    jobRef.status = "error";
    jobRef.message = err instanceof Error ? err.message : "Download failed";
    throw err;
  }
}

async function readableStreamToFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
  job: DownloadJob,
  progressStart = 0,
  progressEnd = 100
): Promise<void> {
  const writeStream = createWriteStream(filePath);
  const reader = stream.getReader();

  let downloaded = 0;
  let lastTime = Date.now();
  let lastBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      await new Promise<void>((res, rej) => {
        writeStream.write(value, (err) => (err ? rej(err) : res()));
      });
      downloaded += value.length;

      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.8) {
        const bps = (downloaded - lastBytes) / dt;
        const total = job.filesize ?? 0;

        if (bps > 0) {
          job.speed = formatBytes(bps) + "/s";
        }
        if (total > 0) {
          const pct = (downloaded / total) * (progressEnd - progressStart) + progressStart;
          job.percent = Math.min(progressEnd - 1, Math.round(pct));
          const remaining = total - downloaded;
          const eta = bps > 0 ? Math.round(remaining / bps) : null;
          job.eta = eta !== null ? formatSeconds(eta) : null;
        } else {
          job.percent = progressStart + Math.round((progressEnd - progressStart) * 0.5);
        }

        lastTime = now;
        lastBytes = downloaded;
      }
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: unknown) => (err ? reject(err) : resolve()));
    });
  }
}

async function ffmpegMerge(videoPath: string, audioPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
    const args = [
      "-i", videoPath,
      "-i", audioPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-movflags", "+faststart",
      "-y",
      outPath,
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on("error", reject);
  });
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createReadStream } = require("fs");
  const readStream = createReadStream(job.filePath);
  readStream.pipe(res);

  readStream.on("close", () => {
    try { unlinkSync(job.filePath!); } catch {}
    jobs.delete(jobId);
  });
});

export default router;
