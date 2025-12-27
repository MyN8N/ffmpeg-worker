import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();
const upload = multer({ dest: os.tmpdir() });

function runCmd(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve({ stdout, stderr });
    });
  });
}

function runFFmpeg(args) {
  return runCmd("ffmpeg", args);
}

async function getAudioDurationSeconds(filePath) {
  // คืนค่าเป็นเลขวินาที (float)
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
  const { stdout } = await runCmd("ffprobe", args);
  const d = parseFloat(String(stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error("ffprobe cannot read audio duration");
  return d;
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "ffmpeg-worker", version: "binary-multipart-v2" });
});

/**
 * POST /render
 * multipart/form-data
 * files: image, voice, music(optional), logo(optional), subtitle(optional)
 *
 * fields (optional):
 * - fps (default 30)
 * - musicVol (default 0.18)
 * - voiceVol (default 1.0)
 * - logoScale (default 220)
 * - logoX (default "W-w-40")
 * - logoY (default "40")
 * - motion ("kenburns" | "none") default "kenburns"
 * - zoomEnd (default 1.08) // ซูมสุดท้าย
 * - zoomSpeed (default 0.0007) // ความเร็วซูม (ยิ่งมากยิ่งซูมเร็ว)
 *
 * NOTE: ไม่ต้องส่ง duration แล้ว (ระบบยึดจากเสียงพูดจริง)
 */
app.post(
  "/render",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "voice", maxCount: 1 },
    { name: "music", maxCount: 1 },
    { name: "logo", maxCount: 1 },
    { name: "subtitle", maxCount: 1 },
  ]),
  async (req, res) => {
    let outFile = null;

    try {
      const image = req.files?.image?.[0];
      const voice = req.files?.voice?.[0];

      if (!image || !voice) {
        return res.status(400).json({ error: "image and voice are required (binary form-data)" });
      }

      const music = req.files?.music?.[0] || null;
      const logo = req.files?.logo?.[0] || null;
      const subtitle = req.files?.subtitle?.[0] || null;

      const fps = Number(req.body.fps || 30);
      const musicVol = Number(req.body.musicVol || 0.18);
      const voiceVol = Number(req.body.voiceVol || 1.0);

      const logoScale = Number(req.body.logoScale || 220);
      const logoX = req.body.logoX || "W-w-40";
      const logoY = req.body.logoY || "40";

      const motion = (req.body.motion || "kenburns").toLowerCase();
      const zoomEnd = Number(req.body.zoomEnd || 1.08);
      const zoomSpeed = Number(req.body.zoomSpeed || 0.0007);

      // ✅ 1) ยึดความยาวจากเสียงพูดจริง
      const voiceDuration = await getAudioDurationSeconds(voice.path);
      // กันไฟล์เพี้ยน: บวกเผื่อเล็กน้อย (เช่น encoder delay)
      const duration = Math.max(0.5, voiceDuration + 0.05);

      outFile = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

      // input index:
      // 0: image
      // 1: voice
      // 2: music (optional, loop)
      // 3: logo (optional)
      const args = ["-y"];

      // image -> loop
      args.push("-loop", "1", "-i", image.path);

      // voice
      args.push("-i", voice.path);

      // music optional (ให้ loop ไปเรื่อยๆ แล้วค่อย trim ตาม duration)
      if (music) args.push("-stream_loop", "-1", "-i", music.path);

      // logo optional
      if (logo) args.push("-i", logo.path);

      // ---------- filtergraph ----------
      const filter = [];

      // ✅ 2) วิดีโอจากภาพ + motion (Ken Burns)
      // ทำ scale/crop ให้ 1080x1920 แบบคุณภาพดี + motion zoompan
      if (motion === "none") {
        filter.push(
          `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,fps=${fps},setsar=1[vbase]`
        );
      } else {
        // Ken Burns: zoom เข้าเล็กน้อย + เคลื่อนช้าๆ
        // zoompan ใช้ d = จำนวนเฟรมทั้งหมด
        const totalFrames = Math.ceil(duration * fps);

        // ซูมจาก 1 ไปจนถึง zoomEnd ด้วย step zoomSpeed (คุมด้วย min)
        // x/y ทำให้ภาพอยู่กลาง (center) ตลอด
        filter.push(
          `[0:v]scale=1920:-2:flags=lanczos,` +
          `crop=1920:1920,` +
          `zoompan=` +
          `z='min(zoom+${zoomSpeed},${zoomEnd})':` +
          `x='iw/2-(iw/zoom/2)':` +
          `y='ih/2-(ih/zoom/2)':` +
          `d=${totalFrames}:` +
          `s=1080x1920:fps=${fps},` +
          `format=yuv420p,setsar=1[vbase]`
        );
      }

      // ✅ 3) Audio mix: voice เป็นหลัก + music loop แล้ว trim ให้เท่า voice
      if (music) {
        // music index = 2
        filter.push(`[1:a]volume=${voiceVol},atrim=0:${duration},asetpts=N/SR/TB[v1]`);
        filter.push(
          `[2:a]volume=${musicVol},atrim=0:${duration},asetpts=N/SR/TB,` +
          `afade=t=out:st=${Math.max(duration - 1.2, 0)}:d=1.2[m1]`
        );
        // duration=first => ยึดความยาวเสียงพูด (v1) เป็นหลัก
        filter.push(`[v1][m1]amix=inputs=2:duration=first:dropout_transition=0[aout]`);
      } else {
        filter.push(`[1:a]volume=${voiceVol},atrim=0:${duration},asetpts=N/SR/TB[aout]`);
      }

      // ✅ 4) logo overlay (optional)
      let vLast = "vbase";
      if (logo) {
        const logoInputIndex = music ? 3 : 2;
        filter.push(`[${logoInputIndex}:v]scale=${logoScale}:-1:flags=lanczos[logo]`);
        filter.push(`[${vLast}][logo]overlay=${logoX}:${logoY}:format=auto[vlogo]`);
        vLast = "vlogo";
      }

      // ✅ 5) subtitle burn-in (optional)
      if (subtitle) {
        // ระวังเรื่องฟอนต์ใน container
        filter.push(
          `[${vLast}]subtitles=${subtitle.path}:` +
          `force_style='FontName=DejaVu Sans,FontSize=44,Outline=2,Shadow=1,MarginV=120'[vsub]`
        );
        vLast = "vsub";
      }

      const filterComplex = filter.join(";");

      // ✅ 6) ยึด duration จากเสียงพูด + ให้จบพร้อมกัน
      args.push(
        "-t", String(duration),
        "-filter_complex", filterComplex,
        "-map", `[${vLast}]`,
        "-map", "[aout]",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-crf", "22",
        "-r", String(fps),
        "-c:a", "aac",
        "-b:a", "160k",
        "-shortest",
        outFile
      );

      await runFFmpeg(args);

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="video.mp4"`);

      const stream = fs.createReadStream(outFile);
      stream.pipe(res);

      stream.on("close", () => {
        try { fs.unlinkSync(outFile); } catch {}
      });
    } catch (err) {
      try {
        if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile);
      } catch {}
      res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FFmpeg worker running on port ${port}`));
