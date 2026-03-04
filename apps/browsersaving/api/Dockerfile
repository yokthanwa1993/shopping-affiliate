FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 80
ENV PORT=80
ENV WORKER_URL=https://browsersaving-worker.yokthanwa1993-bc9.workers.dev
ENV BROWSERLESS_WS=ws://srv-captain--browserless:3000
ENV BROWSERLESS_TOKEN=77482ddfd0ec44d1c1a8b55ddf352d98
CMD ["node", "index.js"]
