const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const upload = multer({ dest: "/tmp" });

// ==== 원하는 timing ====
const VOICE_DELAY_SEC = 3;        // รอ 3 วิ แล้วค่อยเริ่มเสียงพูด+ซับ
const TAIL_AFTER_VOICE_SEC = 5;   // พูดจบแล้วเล่นต่อ 5 วิค่อยจบ

// ====== Performance / RAM knobs ======
// ลด log ของ ffmpeg (ช่วยลด I/O และลดโอกาส memory spike จาก log)
const FFMPEG_LOGLEVEL = "warning"; // "error" / "warning" / "info"

// จำกัด threads (ช่วยลด peak RAM บางเคส) - ถ้าต้องการเร็วขึ้นค่อยลองเพิ่ม
const FFMPEG_THREADS = "1";

// ถ้าต้องการประหยัดมากขึ้น: ลดความละเอียดลง (720x1280)
// ถ้าคุณต้องการ 1080x1920 คงเดิม ให้ใช้ 1080,1920
const OUT_W = 1080;
const OUT_H = 1920;

// ===== Utils =====
function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

// ✅ แก้ RAM หลัก: เก็บ stdout/stderr แค่ "ท้ายสุด" จำกัดขนาด
function runCmd(bin, args, { maxLogKB = 64 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    const MAX = maxLogKB * 1024;
    let stderrBuf = Buffer.alloc(0);
    let stdoutBuf = Buffer.alloc(0);

    const append = (buf, chunk) => {
      // เก็บท้ายสุดอย่างเดียว
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

// ใช้ ffprobe หา duration (วินาที)
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

// ===== SRT SHIFT (เลื่อนซับ +3s ให้ตรงกับเสียงพูดที่เริ่มช้า) =====
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

function shiftSrtContent(srtText, offsetMs) {
  const lines = srtText.split(/\r?\n/);
  return lines.map((line) => {
    const idx = line.indexOf("-->");
    if (idx === -1) return line;

    const parts = line.split("-->");
    if (parts.length !== 2) return line;

    const a = parts[0].trim();
    const bFull = parts[1].trim();
    const b = bFull.split(/\s+/)[0]; // เวลา end
    const trailing = bFull.slice(b.length);

    const aMs = parseTimeToMs(a);
    const bMs = parseTimeToMs(b);
    if (aMs === null || bMs === null) return line;

    return `${msToTime(aMs + offsetMs)} --> ${msToTime(bMs + offsetMs)}${trailing}`;
  }).join("\n");
}

/**
 * POST /render
 * form-data binary fields:
 * - video (required): background video (mp4/mov)
 * - voice (required): TTS voice (mp3/wav)
 * - music (optional): background music (wav/mp3)  <-- เริ่มทันที + loop
 * - subtitle (optional): .srt ที่ timestamp ตรงกับเสียงพูดเริ่มที่ 0s
 * - logo (optional): .png
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
    const offsetMs = VOICE_DELAY_SEC * 1000;

    let shiftedSubtitlePath = null;

    const cleanupAll = () => {
      safeUnlink(outPath);
      safeUnlink(videoFile?.path);
      safeUnlink(voiceFile?.path);
      safeUnlink(musicFile?.path);
      safeUnlink(logoFile?.path);
      safeUnlink(subtitleFile?.path);
      safeUnlink(shiftedSubtitlePath);
    };

    try {
      // 1) duration ของ voice
      const voiceDur = await getMediaDurationSeconds(voiceFile.path);
      const totalDur = voiceDur + VOICE_DELAY_SEC + TAIL_AFTER_VOICE_SEC;

      // 2) shift subtitle +3s
      if (subtitleFile) {
        const raw = fs.readFileSync(subtitleFile.path, "utf8");
        const shifted = shiftSrtContent(raw, offsetMs);
        shiftedSubtitlePath = path.join("/tmp", `shifted_${Date.now()}.srt`);
        fs.writeFileSync(shiftedSubtitlePath, shifted, "utf8");
      }

      // 3) ffmpeg inputs
      // 0: video (loop)
      // 1: voice
      // 2: music (loop) optional
      // 3: logo optional (index จะเปลี่ยนตามมี music)
      const args = [];

      // ลด log เพื่อความนิ่ง
      args.push("-hide_banner", "-loglevel", FFMPEG_LOGLEVEL);

      // loop video ไปเรื่อย ๆ
      args.push("-stream_loop", "-1", "-i", videoFile.path);

      // voice
      args.push("-i", voiceFile.path);

      // music loop
      if (musicFile) args.push("-stream_loop", "-1", "-i", musicFile.path);

      // logo
      if (logoFile) args.push("-i", logoFile.path);

      // 4) filter graph
      const vf = [];
      const af = [];

      // --- Video: 9:16 + trim ตาม totalDur
      vf.push(
        `[0:v]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,` +
        `crop=${OUT_W}:${OUT_H},setsar=1,fps=30,` +
        `trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
      );

      // --- Subtitles
      if (shiftedSubtitlePath) {
        const forceStyle =
          "FontName=Arial,FontSize=54,PrimaryColour=&H00FFFFFF," +
          "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1," +
          "Alignment=2,MarginV=140";

        // NOTE: path ที่มีอักขระพิเศษ/ช่องว่าง บางทีต้อง escape
        // /tmp/... ปกติปลอดภัย
        vf.push(`[v0]subtitles=${shiftedSubtitlePath}:force_style='${forceStyle}'[v1]`);
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

      // --- Audio timeline
      af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalDur}[a_sil]`);
      af.push(`[1:a]aresample=48000,atrim=0:${voiceDur},adelay=${offsetMs}|${offsetMs}[a_voice_d]`);

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
        "-preset", "veryfast",      // ถ้ายัง OOM/ช้า ลอง "ultrafast"
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-threads", FFMPEG_THREADS, // ช่วยคุม peak RAM
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-t", String(totalDur),     // ล็อกจบตาม totalDur
        outPath
      );

      await runCmd("ffmpeg", args, { maxLogKB: 64 });

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

      const stream = fs.createReadStream(outPath);
      stream.pipe(res);

      // cleanup หลังส่งเสร็จ
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
