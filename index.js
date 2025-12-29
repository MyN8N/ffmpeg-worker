import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

const app = express();

// =====================
// CONFIG (ปรับตรงนี้)
// =====================
const TMP_DIR = process.env.TMP_DIR || "/tmp";

// Subtitle style
const SUBTITLE_FONT_NAME = "Arial";
const SUBTITLE_FONT_SIZE = 8;

const SUBTITLE_ALIGNMENT = 5;   // 5=กลางจอ, 2=ล่างกลาง, 8=บนกลาง
const SUBTITLE_MARGIN_L  = 15;
const SUBTITLE_MARGIN_R  = 15;
const SUBTITLE_MARGIN_V  = 180;   // กลางจอแนะนำ 0 (หรือ 40-120 ถ้าอยากขยับ)

const SUBTITLE_OUTLINE   = 1;   // ✅ stroke/ขอบดำ (เดิมมัก 3)
const SUBTITLE_SHADOW    = 0;   // ✅ เงา (เดิม 1)

// Logo
const LOGO_WIDTH = 320;         // ✅ ขยายโลโก้ (เดิม 220)
const LOGO_X_PAD = 40;
const LOGO_Y_PAD = 40;

// Video encode
const FFMPEG_THREADS = process.env.FFMPEG_THREADS || "2";
const CRF = "23";
const PRESET = "veryfast";

// Job storage (in-memory)
const JOB_TTL_MS = 1000 * 60 * 30; // 30 นาที
const jobs = new Map(); // jobId -> { status, createdAt, resultPath?, error?, resultUrl? }

// Clean old jobs
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      // cleanup files
      if (job.resultPath && fs.existsSync(job.resultPath)) {
        try { fs.unlinkSync(job.resultPath); } catch {}
      }
      jobs.delete(jobId);
    }
  }
}, 60_000).unref();

// =====================
// Multer (multipart)
// =====================
const upload = multer({ dest: path.join(TMP_DIR, "uploads") });

// Utility
function id() {
  return `${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

function safeUnlink(p) {
  if (!p) return;
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(err || `ffmpeg failed: ${code}`));
    });
  });
}

// =====================
// POST /render (async)
// =====================
// expects multipart form-data:
// - video: mp4
// - voice: mp3 (optional)
// - subtitle: srt (optional)
// - logo: png (optional)
app.post(
  "/render",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "voice", maxCount: 1 },
    { name: "subtitle", maxCount: 1 },
    { name: "logo", maxCount: 1 },
  ]),
  async (req, res) => {
    const jobId = id();
    jobs.set(jobId, { status: "queued", createdAt: Date.now() });

    // respond immediately
    res.json({ jobId, status: "queued" });

    // run in background
    setImmediate(async () => {
      const job = jobs.get(jobId);
      if (!job) return;

      job.status = "processing";

      const videoFile = req.files?.video?.[0];
      const voiceFile = req.files?.voice?.[0];
      const subtitleFile = req.files?.subtitle?.[0];
      const logoFile = req.files?.logo?.[0];

      if (!videoFile) {
        job.status = "failed";
        job.error = "Missing video file";
        return;
      }

      const inputVideo = videoFile.path;
      const inputVoice = voiceFile?.path || null;
      const inputSubtitle = subtitleFile?.path || null;
      const inputLogo = logoFile?.path || null;

      const outPath = path.join(TMP_DIR, `result_${jobId}.mp4`);

      try {
        // Build filter_complex
        const vf = [];
        const af = [];

        // 1) Subtitle
        // ใช้ subtitles filter + force_style (ASS style)
        if (inputSubtitle) {
          const forceStyle =
            `FontName=${SUBTITLE_FONT_NAME},` +
            `FontSize=${SUBTITLE_FONT_SIZE},` +
            `Alignment=${SUBTITLE_ALIGNMENT},` +
            `MarginL=${SUBTITLE_MARGIN_L},` +
            `MarginR=${SUBTITLE_MARGIN_R},` +
            `MarginV=${SUBTITLE_MARGIN_V},` +
            `BorderStyle=1,` +
            `Outline=${SUBTITLE_OUTLINE},` +   // ✅ stroke thickness
            `Shadow=${SUBTITLE_SHADOW}`;       // ✅ shadow

          // escape path for ffmpeg
          const subEsc = inputSubtitle.replace(/\\/g, "/").replace(/:/g, "\\:");

          vf.push(
            `[0:v]subtitles='${subEsc}':force_style='${forceStyle}'[vsub]`
          );
        }

        // 2) Logo overlay
        // movie=logo.png, scale=LOGO_WIDTH:-1, overlay=top-right
        if (inputLogo) {
          const logoEsc = inputLogo.replace(/\\/g, "/").replace(/:/g, "\\:");
          if (vf.length === 0) {
            vf.push(`[0:v]null[vsub]`);
          }
          vf.push(
            `movie='${logoEsc}',scale=${LOGO_WIDTH}:-1[wm];` +
            `[vsub][wm]overlay=W-w-${LOGO_X_PAD}:${LOGO_Y_PAD}[vout]`
          );
        } else {
          if (vf.length === 0) vf.push(`[0:v]null[vout]`);
          else {
            // if subtitle exists but no logo, rename output
            vf[vf.length - 1] = vf[vf.length - 1].replace("[vsub]", "[vout]");
            // (ง่ายสุด: ทำให้สุดท้ายออก [vout])
            if (!vf.join(";").includes("[vout]")) {
              vf.push(`[vsub]null[vout]`);
            }
          }
        }

        // Audio: ถ้ามี voice ให้เอา voice เป็นหลัก + วิดีโอเดิมเบาๆ (ถ้าต้องการ)
        // ที่นี่ทำแบบ: ถ้ามี voice -> ใช้ voice ล้วน, ถ้าไม่มี -> ใช้ audio จาก video
        if (inputVoice) {
          af.push(`amovie='${inputVoice.replace(/\\/g, "/").replace(/:/g, "\\:")}'[aout]`);
        } else {
          af.push(`[0:a]anull[aout]`);
        }

        const filterComplex = [...vf, ...af].join(";");

        const args = [
          "-y",
          "-i", inputVideo,
          ...(inputVoice ? [] : []),
          "-filter_complex", filterComplex,
          "-map", "[vout]",
          "-map", "[aout]",
          "-c:v", "libx264",
          "-preset", PRESET,
          "-crf", CRF,
          "-pix_fmt", "yuv420p",
          "-threads", String(FFMPEG_THREADS),
          "-c:a", "aac",
          "-b:a", "192k",
          outPath,
        ];

        await runFFmpeg(args);

        job.status = "done";
        job.resultPath = outPath;
        job.resultUrl = `/result/${jobId}`;

      } catch (e) {
        job.status = "failed";
        job.error = String(e?.message || e);
        safeUnlink(outPath);
      } finally {
        // cleanup uploaded tmp inputs
        safeUnlink(inputVideo);
        safeUnlink(inputVoice);
        safeUnlink(inputSubtitle);
        safeUnlink(inputLogo);
      }
    });
  }
);

// =====================
// GET /status/:jobId
// =====================
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "not_found" });

  if (job.status === "done") {
    // สร้าง resultUrl แบบเต็ม (สะดวกกับ n8n)
    const base = `${req.protocol}://${req.get("host")}`;
    return res.json({
      status: "done",
      resultUrl: `${base}${job.resultUrl}`,
    });
  }

  if (job.status === "failed") {
    return res.json({ status: "failed", error: job.error || "unknown_error" });
  }

  return res.json({ status: job.status }); // queued | processing
});

// =====================
// GET /result/:jobId  (download mp4)
// =====================
app.get("/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send("not found");
  if (job.status !== "done" || !job.resultPath) return res.status(409).send("not ready");
  if (!fs.existsSync(job.resultPath)) return res.status(410).send("gone");

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="videolofi_${req.params.jobId}.mp4"`);
  fs.createReadStream(job.resultPath).pipe(res);
});

app.get("/", (req, res) => res.json({ ok: true, endpoints: ["/render", "/status/:jobId", "/result/:jobId"] }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg worker listening on :${PORT}`));
