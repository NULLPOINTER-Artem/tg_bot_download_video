FROM node:18-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg yt-dlp && \
    ln -s /usr/bin/python3 /usr/bin/python && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
