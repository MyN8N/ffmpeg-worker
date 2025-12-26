import express from "express";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

app.post("/render", async (req, res) => {
  const { imageUrl, audioUrl, duration = 60 } = req.body;

  if (!imageUrl || !audioUrl) {
    return res.status(400).json({ error: "imageUrl and audioUrl are required" });
  }

  const out = `output-${Date.now()}.mp4`;

  const cmd = `
    ffmpeg -y \
    -loop 1 -i "${imageUrl}" \
    -i "${audioUrl}" \
    -c:v libx264 -t ${duration} -pix_fmt yuv420p \
    -vf "scale=1080:1920,format=yuv420p" \
    -c:a aac -shortest ${out}
  `;

  exec(cmd, (err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "ffmpeg failed" });
    }
    res.sendFile(path.resolve(out), () => fs.unlinkSync(out));
  });
});

app.listen(3000, () => {
  console.log("FFmpeg worker running on port 3000");
});
