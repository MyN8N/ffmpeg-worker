FROM node:20-bullseye

# ffmpeg + font สำหรับ subtitles
RUN apt-get update && apt-get install -y ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
