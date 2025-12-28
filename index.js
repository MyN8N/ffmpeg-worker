const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

// ใช้ /tmp รองรับ binary ได้ดีใน container
const upload = multer({ dest: "/tmp" });

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

async function getMediaDurationSeconds(filePath) {
  // ffprobe -> duration (seconds)
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ];
  const { stdout } = await runCmd("ffprobe", args);
  const v = parseFloat(String(stdout).trim());
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error("Cannot read duration from ffprobe");
  }
  return v;
}

// ===== SRT SHIFT +3s =====
// รับ SRT ที่เริ่มจาก 0:00 ของเสียงพูด แล้วเลื่อนเวลาไปข้างหน้า offsetMs
function parseTimeToMs(t) {
  // "HH:MM:SS,mmm"
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(t.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const ms = Number(m[4]);
  return (((hh * 60 + mm) * 60 + ss) * 1000 + ms);
}

function msToTime(ms) {
  if (ms < 0) ms = 0;
  const hh = Math.floor(ms / 3600000);
  ms -= hh * 3600000;
  const mm = Math.floor(ms / 60000);
  ms -= mm * 60000;
  const ss = Math.floor(ms / 1000);
  ms -= ss * 1000;
  const mmm = ms;

  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)},${pad3(mmm)}`;
}

function shiftSrtContent(srtText, offsetMs) {
  // เปลี่ยนทุกบรรทัด timing: "a --> b"
  const lines = srtText.split(/\r?\n/);
  const out = lines.map((line) => {
    const idx = line.indexOf("-->");
    if (idx === -1) return line;

    const parts = line.split("-->");
    if (parts.length !== 2) return line;

    const a = parts[0].trim();
    const b = parts[1].trim().split(/\s+/)[0]; // กันกรณีมี trailing settings
    const aMs = parseTimeToMs(a);
    const bMs = parseTimeToMs(b);
    if (aMs === null || bMs === null) return line;

    const newA = msToTime(aMs + offsetMs);
    const newB = msToTime(bMs + offsetMs);

    // รักษา trailing หลังเวลา (เช่น position) ถ้ามี
    const trailing = parts[1].trim().slice(b.length);
    return `${newA} --> ${newB}${trailing}`;
  });
  return out.join("\n");
}

app.post(
  "/render",
  upload.fields([
    { name: "video", maxCount: 1 },     // binary video background
    { name: "voice", maxCount: 1 },     // TTS voice
    { name: "music", maxCount: 1 },     // optional
    { name: "logo", maxCount: 1 },      // optional
    { name: "subtitle", maxCount: 1 }   // optional .srt (timestamp aligned with voice starting at 0)
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const voiceFile = req.files?.voice?.[0];

    if (!videoFile || !voiceFile) {
      return res.status(400).json({
        error: "Missing required files: video, voice"
      });
    }

    const musicFile = req.files?.music?.[0] || null;
    const logoFile = req.files?.logo?.[0] || null;
    const subtitleFile = req.files?.subtitle?.[0] || null;

    const outPath = path.join("/tmp", `out_${Date.now()}.mp4`);

    // Timing rules
    const VOICE_DELAY_SEC = 3;
    const TAIL_AFTER_VOICE_SEC = 5;
    const offsetMs = VOICE_DELAY_SEC * 1000;

    let shiftedSubtitlePath = null;

    try {
      // 1) หา duration เสียงพูด เพื่อคุมความยาวทั้งหมดแบบเป๊ะ
      const voiceDur = await getMediaDurationSeconds(voiceFile.path);
      const totalDur = voiceDur + VOICE_DELAY_SEC + TAIL_AFTER_VOICE_SEC;

      // 2) ถ้ามี subtitle -> shift +3s ให้ตรงกับเสียงพูดที่ดีเลย์
      if (subtitleFile) {
        const raw = fs.readFileSync(subtitleFile.path, "utf8");
        const shifted = shiftSrtContent(raw, offsetMs);
        shiftedSubtitlePath = path.join("/tmp", `shifted_${Date.now()}.srt`);
        fs.writeFileSync(shiftedSubtitlePath, shifted, "utf8");
      }

      // 3) เตรียม ffmpeg args
      // Inputs:
      // 0 = video (loop)
      // 1 = voice
      // 2 = music (loop) [optional]
      // 3 = logo [optional]  (index จะเปลี่ยนตามมี/ไม่มี music)
      const args = [];

      // loop background video
      args.push("-stream_loop", "-1", "-i", videoFile.path);

      // voice
      args.push("-i", voiceFile.path);

      // music (optional) loop
      if (musicFile) {
        args.push("-stream_loop", "-1", "-i", musicFile.path);
      }

      // logo (optional)
      if (logoFile) {
        args.push("-i", logoFile.path);
      }

      const vf = [];
      const af = [];

      // Video: force 9:16 1080x1920 + fps
      vf.push(
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,setsar=1,fps=30,trim=duration=${totalDur},setpts=PTS-STARTPTS[v0]`
      );

      // Subtitles (burn-in) -> สีขาว ตัวใหญ่ อ่านง่าย
      // NOTE: ใช้ libass force_style ได้แม้ไฟล์เป็น .srt
      if (shiftedSubtitlePath) {
        // ตัวอย่าง style: font ใหญ่, สีขาว, outline ดำให้อ่านง่าย
        // PrimaryColour ASS: &HAABBGGRR => white = &H00FFFFFF
        const forceStyle =
          "FontName=Arial,FontSize=54,PrimaryColour=&H00FFFFFF," +
          "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=1," +
          "Alignment=2,MarginV=140"; // Alignment=2 = bottom center, MarginV ดันขึ้นจากขอบล่าง

        // ใส่ subtitles หลังจากตัด/เซ็ต fps แล้ว
        vf.push(`[v0]subtitles=${shiftedSubtitlePath}:force_style='${forceStyle}'[v1]`);
      } else {
        vf.push(`[v0]null[v1]`);
      }

      // Logo overlay (top-right)
      if (logoFile) {
        const logoIndex = musicFile ? 3 : 2;
        vf.push(`[${logoIndex}:v]scale=220:-1[lg]`);
        vf.push(`[v1][lg]overlay=W-w-40:40:format=auto[vout]`);
      } else {
        vf.push(`[v1]null[vout]`);
      }

      // Audio:
      // - music starts immediately (0s)
      // - voice starts at +3s (adelay)
      // - after voice ends, music continues until totalDur (voice+8s)
      // - output trimmed exactly to totalDur
      af.push(`[1:a]atrim=0:${voiceDur},adelay=${offsetMs}|${offsetMs},asetpts=N/SR/TB[a_voice]`);

      if (musicFile) {
        af.push(`[2:a]volume=0.22,asetpts=N/SR/TB[a_music]`);
        // amix longest เพราะ music loop ยาวกว่า -> แล้วค่อย trim ทั้งหมดให้เท่ากับ totalDur
        af.push(`[a_music][a_voice]amix=inputs=2:duration=longest:dropout_transition=2,atrim=0:${totalDur}[aout]`);
      } else {
        // ไม่มีเพลง ก็ให้มี silence ก่อน 3s แล้วเสียงพูด แล้ว tail 5s
        // ทำ silence 3s + voice + silence 5s
        af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${VOICE_DELAY_SEC}[a_pre]`);
        af.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${TAIL_AFTER_VOICE_SEC}[a_tail]`);
        af.push(`[a_pre][a_voice][a_tail]concat=n=3:v=0:a=1[aout]`);
      }

      const filterComplex = [...vf, ...af].join(";");

      args.push(
        "-filter_complex", filterComplex,
        "-map", "[vout]",
        "-map", "[aout]",

        // Encode
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",

        // คุมความยาวเอาตาม totalDur ชัวร์ที่สุด
        "-t", String(totalDur),

        outPath
      );

      // 4) run ffmpeg
      await runCmd("ffmpeg", args);

      // 5) ส่งไฟล์ mp4 กลับแบบ binary
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

      return res.status(500).json({
        error: String(err?.message || err)
      });
    }
  }
);

app.get("/", (req, res) => {
  res.json({ ok: true, service: "ffmpeg-worker", endpoint: "/render" });
});

app.listen(3000, () => {
  console.log("FFmpeg worker listening on :3000");
});
