# Базовый образ Node.js
FROM node:18-slim

# Установим системные зависимости
RUN apt-get update && \
    apt-get install -y python3 python3-pip ffmpeg && \
    pip3 install -U yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Рабочая директория
WORKDIR /app

# Скопируем package.json и установим зависимости
COPY package*.json ./
RUN npm install

# Скопируем весь проект
COPY . .

# Запускаем бота
CMD ["npm", "start"]
