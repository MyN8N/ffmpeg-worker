FROM node:18-slim

RUN apt-get update && apt-get install -y ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install

COPY index.js ./

EXPOSE 3000
CMD ["node", "index.js"]
