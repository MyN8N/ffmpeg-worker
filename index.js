const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "/tmp" });

// ==== timing ====
const VOICE_DELAY_SEC = 3;        // รอ 3 วิ แล้วค่อยเริ่มเสียงพูด+ซับ
const TAIL_AFTER_VOICE_SEC = 5;   // พูดจบแล้วเล่นต่อ 5 วิค่อยจบ

// ===== Performance / RAM knobs =====
const FFMPEG_LOGLEVEL = "warning";
const FFMPEG_THREADS = "1";
const OUT_W = 1080;
const OUT_H = 1920;

// ===== Subtitle knobs (ปรับได้ง่าย) =====
// ทำให้ซับมาพร้อมเสียง: ซับ “นำ” เล็กน้อย (ms)
const SUBTITLE_LEAD_MS = 200; // ถ้ายังช้า เพิ่มเป็น 300-500 / ถ้าเร็วเกิน ลดเหลือ 0

// ขนาด/สไตล์ซับ
const SUBTITLE_FONT = "Arial";
const SUBTITLE_FONT_SIZE = 34;    // << ลดลงจาก 54
const SUBTITLE_MAX_CHARS = 42;    // << 1 บรรทัด ถ้ายาวกว่านี้จะตัดคำ + …

// ตำแหน่งกลางจอ (Alignment=5 = middle-center)
// ถ้าอยาก “ต่ำลงนิด” ใช้ Alignment=2 แล้วปรับ MarginV
const SUBTITLE_ALIGNMENT = 5; // 5 = กลางจอ, 2 = ล่างกลาง

// MarginV มีผลชัดเมื่อ Alignment=2 (ล่างกลาง)
const SUBTITLE_MARGIN_V = 160;

// ===== Utils =====
function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

// จำกัด log เพื่อกันกิน RAM จาก stderr/stdout
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

// ffprobe duration
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

// 1) Shift timecodes
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

// 2) Normalize subtitle text: รวมหลายบรรทัดให้เป็นบรรทัดเดียว + ตัดคำให้ไม่ยาวเกิน
function normalizeSrtToSingleLine(srtText, maxChars = 42) {
  // แยกเป็น blocks ด้วยบรรทัดว่าง
  const blocks = srtText.split(/\r?\n\r?\n/);

  const trimToWord = (str, limit) => {
    const s = str.replace(/\s+/g, " ").trim();
    if (s.length <= limit) return s;

    // ตัดแบบไม่หั่นกลางคำ
    const cut = s.slice(0, limit - 1);
    const lastSpace = cut.lastIndexOf(" ");
    const safeCut = lastSpace > 18 ? cut.slice(0, lastSpace) : cut; // กันกรณีคำยาวมาก
    return safeCut.trim() + "…";
  };

  const out = blocks.map((blk) => {
    const lines = blk.split(/\r?\n/).filter(l => l !== "");
    if (lines.length < 3) return blk; // block แปลก ๆ ปล่อยผ่าน

    const idxLine = lines[0];
    const timeLine = lines[1];

    // text อาจหลายบรรทัด -> รวมเป็นบรรทัดเดียว
    const textLines = lines.slice(2);
    const merged = textLines.join(" ").replace(/\s+/g, " ").trim();

    const finalText = trimToWord(merged, maxChars);

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

    // ซับควรเริ่มพร้อมเสียงที่ delay 3 วิ แต่ “นำ” นิดหน่อยให้รู้สึกมาทันเสียง
    const offsetMs = (VOICE_DELAY_SEC * 1000) - SUBTITLE_LEAD_MS;

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
      // 1) duration
      const voiceDur = await getMediaDurationSeconds(voiceFile.path);
      const totalDur = voiceDur + VOICE_DELAY_SEC + TAIL_AFTER_VOICE_SEC;

      // 2) process subtitle: normalize(1 line) + shift timecodes
      if (subtitleFile) {
        const raw = fs.readFileSync(subtitleFile.path, "utf8");

        // ทำให้เป็น 1 บรรทัด + ตัดคำให้อ่านรู้เรื่อง
        const normalized = normalizeSrtToSingleLine(raw, SUBTITLE_MAX_CHARS);

        // shift ให้เริ่มพร้อมเสียง (3s) และนำเล็กน้อย
        const shifted = shiftSrtTimecodes(normalized, offsetMs);

        processedSubtitlePath = path.join("/tmp", `subtitle_${Date.now()}.srt`);
        fs.writeFileSync(processedSubtitlePath, shifted, "utf8");
      }

      // 3) ffmpeg inputs
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

      // 4) filter graph
      const vf = [];
      const af = [];

      // --- Video base
      vf.push(
        `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
        `crop=${OUT_W}:${OUT_H},setsar=1,fps=30,` +
        `trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
      );

      // --- Subtitles style
      if (processedSubtitlePath) {
        const forceStyle =
          `FontName=${SUBTITLE_FONT},` +
          `FontSize=${SUBTITLE_FONT_SIZE},` +
          `PrimaryColour=&H00FFFFFF,` +
          `OutlineColour=&H00000000,` +
          `BorderStyle=1,Outline=3,Shadow=1,` +
          `Alignment=${SUBTITLE_ALIGNMENT},` +
          `MarginV=${SUBTITLE_MARGIN_V},` +
          `WrapStyle=2`; // 2 = no wrap (บังคับ 1 บรรทัด)

        vf.push(`[v0]subtitles=${processedSubtitlePath}:force_style='${forceStyle}'[v1]`);
      } else {
        vf.push(`[v0]null[v1]`);
      }

      // --- Logo overlay
      if (logoFile) {
        const logoIndex = musicFile ? 3 : 2;
        vf.push(`[${logoIndex}:v]scale=220:-1[lg]`);
        vf.push(`[v1][lg]overlay=W-w-40:40:format=auto[vout]`);
      } else {
        vf.push(`[v1]null[vout]`);
      }

      // --- Audio timeline
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
