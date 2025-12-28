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

function safeUnlink(p) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch {}
}

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${bin} failed (code=${code}):\n${stderr}`));
    });
  });
}

// ใช้ ffprobe หา duration (วินาที)
async function getMediaDurationSeconds(filePath) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ];
  const { stdout } = await runCmd("ffprobe", args);
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
      args.push("-stream_loop", "-1", "-i", videoFile.path);
      args.push("-i", voiceFile.path);

      if (musicFile) args.push("-stream_loop", "-1", "-i", musicFile.path);
      if (logoFile) args.push("-i", logoFile.path);

      // 4) filter graph
      const vf = [];
      const af = [];

      // --- Video: 9:16 1080x1920 + ตัดความยาว = totalDur
      vf.push(
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,setsar=1,fps=30,trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
      );

      // --- Subtitles: สีขาว ตัวใหญ่ อ่านง่าย (ทีละบรรทัดตาม SRT)
      if (shiftedSubtitlePath) {
        const forceStyle =
          "FontName=Arial,FontSize=54,PrimaryColour=&H00FFFFFF," +
          "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1," +
          "Alignment=2,MarginV=140";
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

      // --- Audio timeline (แก้ delay/tail ให้เป๊ะ)
      // สร้าง silent bed ยาว totalDur แล้ว mix เสียงต่างๆ ลงไป
      // music เริ่มทันที, voice เริ่มหลัง 3s
      af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${totalDur}[a_sil]`);

      // voice -> resample -> delay 3s
      af.push(`[1:a]aresample=48000,atrim=0:${voiceDur},adelay=${offsetMs}|${offsetMs}[a_voice_d]`);

      if (musicFile) {
        // music เริ่มทันที และ loop มาแล้วจาก -stream_loop
        // ลดเสียงเพลงให้เบากว่าเสียงพูด
        af.push(`[2:a]aresample=48000,volume=0.22[am]`);

        // mix: silent bed + music + voice_delayed
        // แล้วตัดความยาวให้ totalDur เป๊ะ
        af.push(`[a_sil][am][a_voice_d]amix=inputs=3:duration=longest:dropout_transition=2,atrim=0:${totalDur}[aout]`);
      } else {
        // ไม่มีเพลง: silent bed + voice_delayed ก็พอ (จะได้มีช่วงก่อน 3s และท้าย 5s เป็นเงียบ)
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
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        "-t", String(totalDur),        // ล็อกจบทุกอย่างตาม totalDur
        outPath
      );

      await runCmd("ffmpeg", args);

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

      const stream = fs.createReadStream(outPath);
      stream.pipe(res);

      stream.on("close", () => {
        safeUnlink(outPath);
        safeUnlink(videoFile.path);
        safeUnlink(voiceFile.path);
        safeUnlink(musicFile?.path);
        safeUnlink(logoFile?.path);
        safeUnlink(subtitleFile?.path);
        safeUnlink(shiftedSubtitlePath);
      });

    } catch (err) {
      safeUnlink(outPath);
      safeUnlink(videoFile.path);
      safeUnlink(voiceFile.path);
      safeUnlink(musicFile?.path);
      safeUnlink(logoFile?.path);
      safeUnlink(subtitleFile?.path);
      safeUnlink(shiftedSubtitlePath);

      return res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

app.get("/", (req, res) => res.json({ ok: true, endpoint: "/render" }));

app.listen(3000, () => console.log("FFmpeg worker listening on :3000"));
