const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "/tmp" });

// ===================== Timing =====================
const VOICE_DELAY_SEC = 3;        // เสียงพูดเริ่มที่ 3 วิ
const TAIL_AFTER_VOICE_SEC = 5;   // พูดจบแล้วเล่นต่ออีก 5 วิ
const SUBTITLE_LEAD_SEC = 1;      // ซับนำหน้าเสียง 1 วิ => เริ่มที่ 2 วิ

// ===================== Performance / RAM =====================
const FFMPEG_LOGLEVEL = "warning";
const FFMPEG_THREADS = "1";
const OUT_W = 1080;
const OUT_H = 1920;

// ===================== Subtitle style knobs =====================
const SUBTITLE_FONT = "Arial";
const SUBTITLE_FONT_SIZE = 8;        // << ปรับขนาดซับ (คุณอยากลด 50% ก็ลดเลขนี้)
const SUBTITLE_MAX_LINES = 3;
const SUBTITLE_MAX_CHARS_PER_LINE = 40;
const SUBTITLE_MARGIN_LR = 15;

// ตำแหน่งซับ: 5 = กลางจอ (middle-center)
const SUBTITLE_ALIGNMENT = 5;

// เลื่อนขึ้น/ลงจากกลางจอ (0 = กลางเป๊ะ, ค่ามาก = ลงล่าง, ค่าติดลบ = ขึ้นบน)
const SUBTITLE_MARGIN_V = 180;

// ขอบ/สโตรก (Outline) + เงา (Shadow)
const SUBTITLE_OUTLINE = 1; // << ลด “ขอบดำ” ลดเลขนี้ เช่น 1 -> 0.5 หรือ 0
const SUBTITLE_SHADOW = 1;  // << ลดเงา เช่น 1 -> 0

// ===================== Queue / Jobs =====================
const JOB_DIR = "/tmp/ffmpeg_jobs";
if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });

const jobs = new Map(); // jobId -> { status, createdAt, files..., resultPath, error }
const queue = [];
let isWorking = false;

function genJobId() {
  return `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

function cleanupJobFiles(job) {
  safeUnlink(job?.videoPath);
  safeUnlink(job?.voicePath);
  safeUnlink(job?.musicPath);
  safeUnlink(job?.logoPath);
  safeUnlink(job?.subtitlePath);
  safeUnlink(job?.processedSubtitlePath);
  // resultPath เก็บไว้ให้ดาวน์โหลด (จะลบด้วย cron ด้านล่าง)
}

// ลบงานเก่าอัตโนมัติ (กัน /tmp เต็ม)
const JOB_TTL_MIN = 60; // เก็บไฟล์ผลลัพธ์ 60 นาที
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    const ageMin = (now - job.createdAt) / 60000;
    if (ageMin > JOB_TTL_MIN) {
      safeUnlink(job.resultPath);
      cleanupJobFiles(job);
      jobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000);

// ===================== Utils =====================
function runCmd(bin, args, { maxLogKB = 64 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const MAX = maxLogKB * 1024;
    let stderrBuf = Buffer.alloc(0);
    let stdoutBuf = Buffer.alloc(0);

    const append = (buf, chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX) buf = buf.slice(buf.length - MAX);
      return buf;
    };

    p.stderr.on("data", (d) => { stderrBuf = append(stderrBuf, d); });
    p.stdout.on("data", (d) => { stdoutBuf = append(stdoutBuf, d); });

    p.on("error", (err) => reject(err));
    p.on("close", (code) => {
      const stderr = stderrBuf.toString("utf8");
      const stdout = stdoutBuf.toString("utf8");
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${bin} failed (code=${code}):\n${stderr || stdout}`));
    });
  });
}

async function getMediaDurationSeconds(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  const { stdout } = await runCmd("ffprobe", args, { maxLogKB: 16 });
  const v = parseFloat(String(stdout).trim());
  if (!Number.isFinite(v) || v <= 0) throw new Error("Cannot read duration from ffprobe");
  return v;
}

// ===== SRT helpers =====
function parseTimeToMs(t) {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(t.trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]), ms = Number(m[4]);
  return (((hh * 60 + mm) * 60 + ss) * 1000 + ms);
}
function msToTime(ms) {
  if (ms < 0) ms = 0;
  const hh = Math.floor(ms / 3600000); ms -= hh * 3600000;
  const mm = Math.floor(ms / 60000);   ms -= mm * 60000;
  const ss = Math.floor(ms / 1000);    ms -= ss * 1000;
  const mmm = ms;
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(mmm)}`;
}
function shiftSrtTimecodes(srtText, offsetMs) {
  const lines = srtText.split(/\r?\n/);
  return lines.map((line) => {
    if (!line.includes("-->")) return line;
    const parts = line.split("-->");
    if (parts.length !== 2) return line;

    const a = parts[0].trim();
    const bFull = parts[1].trim();
    const b = bFull.split(/\s+/)[0];
    const trailing = bFull.slice(b.length);

    const aMs = parseTimeToMs(a);
    const bMs = parseTimeToMs(b);
    if (aMs === null || bMs === null) return line;

    return `${msToTime(aMs + offsetMs)} --> ${msToTime(bMs + offsetMs)}${trailing}`;
  }).join("\n");
}
function getFirstCueStartMs(srtText) {
  const lines = srtText.split(/\r?\n/);
  for (const line of lines) {
    if (line.includes("-->")) {
      const a = line.split("-->")[0].trim();
      const aMs = parseTimeToMs(a);
      if (aMs !== null) return aMs;
    }
  }
  return null;
}
function wrapTextToMaxLines(text, maxCharsPerLine, maxLines) {
  // ✅ FIX: normalize spaces correctly (English subtitles)
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  const lines = [];
  let cur = "";

  const pushLine = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = "";
  };

  for (const w of words) {
    const word = w.length > maxCharsPerLine ? (w.slice(0, maxCharsPerLine - 1) + "…") : w;

    if (!cur) { cur = word; continue; }

    if ((cur + " " + word).length <= maxCharsPerLine) {
      cur += " " + word;
    } else {
      pushLine();
      if (lines.length >= maxLines) break;
      cur = word;
    }
  }

  if (lines.length < maxLines) pushLine();

  const usedWords = lines.join(" ").split(" ").length;
  if (usedWords < words.length && lines.length > 0) {
    if (!lines[lines.length - 1].endsWith("…")) lines[lines.length - 1] += "…";
  }

  return lines.slice(0, maxLines);
}
function normalizeSrtToMaxLines(srtText, maxCharsPerLine, maxLines) {
  const blocks = srtText.split(/\r?\n\r?\n/);
  const out = blocks.map((blk) => {
    const lines = blk.split(/\r?\n/).filter(l => l !== "");
    if (lines.length < 3) return blk;

    const idxLine = lines[0];
    const timeLine = lines[1];
    const mergedText = lines.slice(2).join(" ").replace(/\s+/g, " ").trim();

    const wrappedLines = wrapTextToMaxLines(mergedText, maxCharsPerLine, maxLines);
    const finalText = wrappedLines.join("\n");

    return `${idxLine}\n${timeLine}\n${finalText}`;
  });

  return out.join("\n\n") + "\n";
}
function escapeForSubtitlesFilter(p) {
  return String(p).replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

// ===================== Core Render (used by background worker) =====================
async function processJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = "processing";
  job.updatedAt = Date.now();

  const {
    videoPath, voicePath, musicPath, subtitlePath, logoPath,
    subtitle_offset_sec,
  } = job;

  const outPath = path.join(JOB_DIR, `out_${jobId}.mp4`);
  job.resultPath = outPath;

  try {
    const voiceDur = await getMediaDurationSeconds(voicePath);
    const totalDur = voiceDur + VOICE_DELAY_SEC + TAIL_AFTER_VOICE_SEC;

    // subtitle offset: default ให้เริ่ม 2s (3-1)
    let desiredSubtitleOffsetSec = Math.max(0, VOICE_DELAY_SEC - SUBTITLE_LEAD_SEC);
    if (subtitle_offset_sec !== undefined) {
      const v = Number(subtitle_offset_sec);
      if (Number.isFinite(v)) desiredSubtitleOffsetSec = Math.max(0, v);
    }
    const desiredSubtitleOffsetMs = Math.round(desiredSubtitleOffsetSec * 1000);

    // subtitle process
    let processedSubtitlePath = null;
    if (subtitlePath) {
      const raw = fs.readFileSync(subtitlePath, "utf8");

      const normalized = normalizeSrtToMaxLines(
        raw,
        SUBTITLE_MAX_CHARS_PER_LINE,
        SUBTITLE_MAX_LINES
      );

      // กัน shift ซ้อน: ถ้า cue แรก >= 1.5s ถือว่าเลื่อนมาแล้ว
      const firstStart = getFirstCueStartMs(normalized);
      const alreadyShifted = firstStart !== null && firstStart >= 1500;

      const finalSrt = alreadyShifted
        ? normalized
        : shiftSrtTimecodes(normalized, desiredSubtitleOffsetMs);

      processedSubtitlePath = path.join(JOB_DIR, `subtitle_${jobId}.srt`);
      fs.writeFileSync(processedSubtitlePath, finalSrt, "utf8");
      job.processedSubtitlePath = processedSubtitlePath;
    }

    // ffmpeg args
    const args = [];
    args.push("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL);

    // 0: video loop
    args.push("-stream_loop", "-1", "-i", videoPath);

    // 1: voice
    args.push("-i", voicePath);

    // 2: music loop (optional)
    if (musicPath) args.push("-stream_loop", "-1", "-i", musicPath);

    // logo (optional)
    if (logoPath) args.push("-i", logoPath);

    const vf = [];
    const af = [];

    vf.push(
      `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
      `crop=${OUT_W}:${OUT_H},setsar=1,fps=30,` +
      `trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
    );

    if (processedSubtitlePath) {
      const forceStyle =
        `FontName=${SUBTITLE_FONT},` +
        `FontSize=${SUBTITLE_FONT_SIZE},` +
        `PrimaryColour=&H00FFFFFF,` +
        `OutlineColour=&H00000000,` +
        `BorderStyle=1,` +
        `Outline=${SUBTITLE_OUTLINE},` +
        `Shadow=${SUBTITLE_SHADOW},` +
        `Alignment=${SUBTITLE_ALIGNMENT},` +
        `MarginL=${SUBTITLE_MARGIN_LR},` +
        `MarginR=${SUBTITLE_MARGIN_LR},` +
        `MarginV=${SUBTITLE_MARGIN_V},` +
        `WrapStyle=2`;

      const subPath = escapeForSubtitlesFilter(processedSubtitlePath);
      vf.push(`[v0]subtitles=${subPath}:charenc=UTF-8:force_style='${forceStyle}'[v1]`);
    } else {
      vf.push(`[v0]null[v1]`);
    }

    // Logo overlay
    if (logoPath) {
      const logoIndex = musicPath ? 3 : 2;
      const LOGO_W = 300;
      vf.push(`[${logoIndex}:v]scale=${LOGO_W}:-1[lg]`);
      vf.push(`[v1][lg]overlay=W-w-40:40:format=auto[vout]`);
    } else {
      vf.push(`[v1]null[vout]`);
    }

    // audio mix
    const voiceDelayMs = VOICE_DELAY_SEC * 1000;
    af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalDur}[a_sil]`);
    af.push(`[1:a]aresample=48000,atrim=0:${voiceDur},adelay=${voiceDelayMs}|${voiceDelayMs}[a_voice_d]`);

    if (musicPath) {
      af.push(`[2:a]aresample=48000,volume=0.22[am]`);
      af.push(`[a_sil][am][a_voice_d]amix=inputs=3:duration=longest:dropout_transition=2,atrim=0:${totalDur}[aout]`);
    } else {
      af.push(`[a_sil][a_voice_d]amix=inputs=2:duration=longest:dropout_transition=2,atrim=0:${totalDur}[aout]`);
    }

    const filterComplex = [...vf, ...af].join(";");

    args.push(
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      "-map", "[aout]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-threads", FFMPEG_THREADS,
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", String(totalDur),
      outPath
    );

    await runCmd("ffmpeg", args, { maxLogKB: 64 });

    job.status = "done";
    job.updatedAt = Date.now();
    job.error = null;

    cleanupJobFiles(job);

  } catch (err) {
    job.status = "failed";
    job.updatedAt = Date.now();
    job.error = String(err?.message || err);

    safeUnlink(job.resultPath);
    cleanupJobFiles(job);
  }
}

// worker loop (concurrency=1)
async function workLoop() {
  if (isWorking) return;
  isWorking = true;

  try {
    while (queue.length > 0) {
      const jobId = queue.shift();
      await processJob(jobId);
    }
  } finally {
    isWorking = false;
  }
}

// ===================== Routes =====================
// POST /render (async)
app.post(
  "/render",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 },
    { name: "subtitle", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const voiceFile = req.files?.voice?.[0];

    if (!videoFile || !voiceFile) {
      return res.status(400).json({ error: "Missing required files: video, voice" });
    }

    const musicFile = req.files?.music?.[0] || null;
    const subtitleFile = req.files?.subtitle?.[0] || null;
    const logoFile = req.files?.logo?.[0] || null;

    const jobId = genJobId();

    jobs.set(jobId, {
      jobId,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      // store file paths
      videoPath: videoFile.path,
      voicePath: voiceFile.path,
      musicPath: musicFile?.path || null,
      subtitlePath: subtitleFile?.path || null,
      logoPath: logoFile?.path || null,
      subtitle_offset_sec: req.body?.subtitle_offset_sec,
      resultPath: null,
      processedSubtitlePath: null,
      error: null,
    });

    queue.push(jobId);
    workLoop();

    return res.json({ jobId, status: "queued" });
  }
);

// GET /status/:jobId
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });

  const payload = { jobId: job.jobId, status: job.status };
  if (job.status === "failed") payload.error = job.error;
  if (job.status === "done") payload.resultUrl = `/result/${job.jobId}`;

  return res.json(payload);
});

// GET /result/:jobId (download)
app.get("/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job not found" });
  if (job.status !== "done") return res.status(409).json({ error: "not ready", status: job.status });

  if (!job.resultPath || !fs.existsSync(job.resultPath)) {
    return res.status(404).json({ error: "result file missing" });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="short_${job.jobId}.mp4"`);

  const stream = fs.createReadStream(job.resultPath);
  stream.pipe(res);
});

app.get("/", (req, res) => res.json({ ok: true, endpoints: ["/render", "/status/:jobId", "/result/:jobId"] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg worker listening on :${PORT}`));
