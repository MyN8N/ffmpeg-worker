import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const app = express();

// multer เก็บไฟล์ลง /tmp (Render ใช้ได้)
const upload = multer({ dest: os.tmpdir() });

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

app.get("/", (req, res) => {
  res.json({ ok: true, service: "ffmpeg-worker", version: "binary-multipart-v1" });
});

/**
 * POST /render
 * multipart/form-data
 * files: image, voice, music(optional), logo(optional), subtitle(optional)
 * fields: duration, musicVol, voiceVol, logoScale, logoX, logoY
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
    try {
      // ----- validate -----
      const image = req.files?.image?.[0];
      const voice = req.files?.voice?.[0];
      if (!image || !voice) {
        return res.status(400).json({ error: "image and voice are required (binary form-data)" });
      }

      const duration = Number(req.body.duration || 30);
      const musicVol = Number(req.body.musicVol || 0.25);
      const voiceVol = Number(req.body.voiceVol || 1.0);

      const logoScale = Number(req.body.logoScale || 220);
      const logoX = req.body.logoX || "W-w-40";
      const logoY = req.body.logoY || "40";

      const music = req.files?.music?.[0] || null;
      const logo = req.files?.logo?.[0] || null;
      const subtitle = req.files?.subtitle?.[0] || null;

      const outFile = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

      /**
       * สร้าง filtergraph:
       * - ทำภาพนิ่งเป็นวิดีโอ 1080x1920
       * - ผสมเสียง: voice + (music optional)
       * - ใส่ logo overlay (optional)
       * - burn subtitle (optional)
       */

      // input index:
      // 0: image
      // 1: voice
      // 2: music (optional)
      // 3: logo (optional)
      const args = ["-y"];

      // image -> loop
      args.push("-loop", "1", "-i", image.path);

      // voice
      args.push("-i", voice.path);

      // music optional
      if (music) args.push("-i", music.path);

      // logo optional
      if (logo) args.push("-i", logo.path);

      // ---------- video base ----------
      // สร้าง background จากภาพ: scale/crop ให้พอดี 9:16
      // 1080x1920
      // fps 30
      let filter = [];
      filter.push(
        `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,fps=30,setsar=1[vbase]`
      );

      // ---------- audio mix ----------
      // voice volume
      // music volume + fade out เล็กน้อยท้ายคลิป
      // แล้ว amix
      if (music) {
        // voice = [1:a], music = [2:a]
        filter.push(`[1:a]volume=${voiceVol}[v1]`);
        filter.push(
          `[2:a]volume=${musicVol},afade=t=out:st=${Math.max(duration - 1, 0)}:d=1[m1]`
        );
        filter.push(`[v1][m1]amix=inputs=2:duration=first:dropout_transition=2[aout]`);
      } else {
        filter.push(`[1:a]volume=${voiceVol}[aout]`);
      }

      // ---------- logo overlay ----------
      // ถ้ามีโลโก้: scale แล้ว overlay มุมขวาบน
      let vLast = "vbase";
      if (logo) {
        const logoInputIndex = music ? 3 : 2; // logo เป็น input ลำดับไหน
        filter.push(
          `[${logoInputIndex}:v]scale=${logoScale}:-1:flags=lanczos[logo]`
        );
        filter.push(`[${vLast}][logo]overlay=${logoX}:${logoY}:format=auto[vlogo]`);
        vLast = "vlogo";
      }

      // ---------- subtitle burn-in ----------
      // ถ้ามี subtitle: ใช้ subtitles filter
      // NOTE: ควรมีฟอนต์ใน container (ดู Dockerfile ด้านล่าง)
      if (subtitle) {
        // subtitles ต้องการ path จริง
        // escape ":" บน windows ไม่ต้อง (Render เป็น linux)
        filter.push(`[${vLast}]subtitles=${subtitle.path}:force_style='FontName=DejaVu Sans,FontSize=44,Outline=2,Shadow=1,MarginV=120'[vsub]`);
        vLast = "vsub";
      }

      const filterComplex = filter.join(";");

      args.push(
        "-t",
        String(duration),
        "-filter_complex",
        filterComplex,
        "-map",
        `[${vLast}]`,
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        outFile
      );

      await runFFmpeg(args);

      // ส่งกลับเป็นไฟล์ mp4 (n8n จะรับเป็น binary)
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `attachment; filename="video.mp4"`);
      fs.createReadStream(outFile).pipe(res);

      // cleanup แบบง่าย (ปล่อยให้ OS/tmp เคลียร์เองก็ได้)
      // fs.unlink(outFile, () => {});
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FFmpeg worker running on port ${port}`));
