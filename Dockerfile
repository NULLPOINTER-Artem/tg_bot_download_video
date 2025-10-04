FROM node:18-slim

RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

CMD ["npm", "start"]
