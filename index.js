const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "/tmp" });

// ==== timing ====
const VOICE_DELAY_SEC = 3;        // เสียงพูดเริ่มที่ 3 วิ
const TAIL_AFTER_VOICE_SEC = 5;   // พูดจบแล้วเล่นต่ออีก 5 วิ

// ===== Performance / RAM knobs =====
const FFMPEG_LOGLEVEL = "warning";
const FFMPEG_THREADS = "1";
const OUT_W = 1080;
const OUT_H = 1920;

// ===== Subtitle knobs =====
// ให้ซับเริ่มก่อนเสียงพูดเล็กน้อย: เริ่มที่ 2 วินาที (เสียงเริ่ม 3 วินาที)
const SUBTITLE_START_SEC = 2;

// ลดขนาดซับลง ~50% จากที่คุณใช้อยู่ (34 -> 18)
const SUBTITLE_FONT = "Arial";
const SUBTITLE_FONT_SIZE = 18;

// ซับได้สูงสุด 3 บรรทัด
const SUBTITLE_MAX_LINES = 3;

// จำกัดจำนวนตัวอักษรต่อบรรทัด (ช่วยบังคับความกว้างไม่ให้ล้นจอ)
// 1080x1920 แนวตั้ง ค่า 28–34 จะอ่านสบาย ลองเริ่มที่ 30
const SUBTITLE_MAX_CHARS_PER_LINE = 30;

// ระยะขอบซ้าย-ขวา (ยิ่งมาก ยิ่งไม่ชิดขอบ)
const SUBTITLE_MARGIN_LR = 90;

// ให้อยู่ “กลางจอ” และเรียงลงมา
// Alignment=5 (middle-center)
const SUBTITLE_ALIGNMENT = 5;
// MarginV มีผลกับตำแหน่งแนวตั้ง (แม้ Alignment=5 ก็ยังมีผลบางธีม)
// ปรับเลขนี้เพื่อเลื่อนขึ้น/ลงเล็กน้อย
const SUBTITLE_MARGIN_V = 0;

// ===== Utils =====
function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

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
    const idx = line.indexOf("-->");
    if (idx === -1) return line;

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

// word-wrap เป็น <=3 บรรทัด, ไม่หั่นกลางคำ, ถ้าเกินใส่ …
function wrapTextToMaxLines(text, maxCharsPerLine, maxLines) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";

  const pushLine = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = "";
  };

  for (const w of words) {
    // ถ้าคำเดี่ยวยาวมาก: ตัดให้พอ (กันล้นแบบสุดโต่ง)
    const word = w.length > maxCharsPerLine ? (w.slice(0, maxCharsPerLine - 1) + "…") : w;

    if (!cur) {
      cur = word;
      continue;
    }

    if ((cur + " " + word).length <= maxCharsPerLine) {
      cur += " " + word;
    } else {
      pushLine();
      if (lines.length >= maxLines) break;
      cur = word;
    }
  }

  if (lines.length < maxLines) pushLine();

  // ถ้ายังเหลือคำ แต่ครบ maxLines แล้ว -> เติม … ที่บรรทัดสุดท้าย
  const usedWords = lines.join(" ").split(" ").length;
  if (usedWords < words.length && lines.length > 0) {
    if (!lines[lines.length - 1].endsWith("…")) lines[lines.length - 1] += "…";
  }

  return lines.slice(0, maxLines);
}

// ทำให้ SRT แต่ละบล็อกเป็น 1–3 บรรทัด (แทนที่จะยาวบรรทัดเดียวล้นจอ)
function normalizeSrtToMaxLines(srtText, maxCharsPerLine, maxLines) {
  const blocks = srtText.split(/\r?\n\r?\n/);

  const out = blocks.map((blk) => {
    const lines = blk.split(/\r?\n/).filter(l => l !== "");
    if (lines.length < 3) return blk; // block แปลก ๆ ปล่อยผ่าน

    const idxLine = lines[0];
    const timeLine = lines[1];
    const mergedText = lines.slice(2).join(" ").replace(/\s+/g, " ").trim();

    const wrappedLines = wrapTextToMaxLines(mergedText, maxCharsPerLine, maxLines);
    const finalText = wrappedLines.join("\n");

    return `${idxLine}\n${timeLine}\n${finalText}`;
  });

  return out.join("\n\n") + "\n";
}

/**
 * POST /render
 * form-data binary fields:
 * - video (required)
 * - voice (required)
 * - music (optional)
 * - subtitle (optional) .srt (timestamp เริ่มที่ 0s ของเสียงพูด)
 * - logo (optional) .png
 */
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

    const outPath = path.join("/tmp", `out_${Date.now()}.mp4`);

    // ✅ ซับเริ่มที่ 2 วินาที (ก่อนเสียงที่เริ่ม 3 วินาที)
    // เพราะ SRT ของคุณอิงจากเสียงพูดเริ่ม 0s -> เลื่อนทั้งชุดเป็น +2s
    const subtitleOffsetMs = SUBTITLE_START_SEC * 1000;

    let processedSubtitlePath = null;

    const cleanupAll = () => {
      safeUnlink(outPath);
      safeUnlink(videoFile?.path);
      safeUnlink(voiceFile?.path);
      safeUnlink(musicFile?.path);
      safeUnlink(logoFile?.path);
      safeUnlink(subtitleFile?.path);
      safeUnlink(processedSubtitlePath);
    };

    try {
      const voiceDur = await getMediaDurationSeconds(voiceFile.path);
      const totalDur = voiceDur + VOICE_DELAY_SEC + TAIL_AFTER_VOICE_SEC;

      // 1) subtitle: wrap <=3 lines + shift to start at 2s
      if (subtitleFile) {
        const raw = fs.readFileSync(subtitleFile.path, "utf8");

        const normalized = normalizeSrtToMaxLines(
          raw,
          SUBTITLE_MAX_CHARS_PER_LINE,
          SUBTITLE_MAX_LINES
        );

        const shifted = shiftSrtTimecodes(normalized, subtitleOffsetMs);

        processedSubtitlePath = path.join("/tmp", `subtitle_${Date.now()}.srt`);
        fs.writeFileSync(processedSubtitlePath, shifted, "utf8");
      }

      // 2) ffmpeg inputs
      const args = [];
      args.push("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL);

      // 0: video loop
      args.push("-stream_loop", "-1", "-i", videoFile.path);

      // 1: voice
      args.push("-i", voiceFile.path);

      // 2: music loop (optional)
      if (musicFile) args.push("-stream_loop", "-1", "-i", musicFile.path);

      // logo (optional)
      if (logoFile) args.push("-i", logoFile.path);

      // 3) filter graph
      const vf = [];
      const af = [];

      // --- Video base
      vf.push(
        `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
        `crop=${OUT_W}:${OUT_H},setsar=1,fps=30,` +
        `trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
      );

      // --- Subtitles style: กลางจอ, ขนาดเล็กลง, จำกัดขอบซ้าย-ขวา
      if (processedSubtitlePath) {
        const forceStyle =
          `FontName=${SUBTITLE_FONT},` +
          `FontSize=${SUBTITLE_FONT_SIZE},` +
          `PrimaryColour=&H00FFFFFF,` +
          `OutlineColour=&H00000000,` +
          `BorderStyle=1,Outline=2,Shadow=1,` +
          `Alignment=${SUBTITLE_ALIGNMENT},` +
          `MarginL=${SUBTITLE_MARGIN_LR},` +
          `MarginR=${SUBTITLE_MARGIN_LR},` +
          `MarginV=${SUBTITLE_MARGIN_V},` +
          `WrapStyle=0`; // 0 = smart wrapping (ใช้ได้กับหลายบรรทัด)

        vf.push(
          `[v0]subtitles=${processedSubtitlePath}:force_style='${forceStyle}'[v1]`
        );
      } else {
        vf.push(`[v0]null[v1]`);
      }

      // --- Logo overlay (มุมขวาบน)
      if (logoFile) {
        const logoIndex = musicFile ? 3 : 2;
        vf.push(`[${logoIndex}:v]scale=220:-1[lg]`);
        vf.push(`[v1][lg]overlay=W-w-40:40:format=auto[vout]`);
      } else {
        vf.push(`[v1]null[vout]`);
      }

      // --- Audio timeline: voice เริ่มที่ 3s เหมือนเดิม
      const voiceDelayMs = VOICE_DELAY_SEC * 1000;

      af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalDur}[a_sil]`);
      af.push(`[1:a]aresample=48000,atrim=0:${voiceDur},adelay=${voiceDelayMs}|${voiceDelayMs}[a_voice_d]`);

      if (musicFile) {
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

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

      const stream = fs.createReadStream(outPath);
      stream.pipe(res);

      const done = () => cleanupAll();
      stream.on("close", done);
      stream.on("error", done);
      res.on("close", done);
      res.on("finish", done);

    } catch (err) {
      cleanupAll();
      return res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

app.get("/", (req, res) => res.json({ ok: true, endpoint: "/render" }));
app.listen(3000, () => console.log("FFmpeg worker listening on :3000"));
