FROM node:20-alpine AS build

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src ./src
COPY vite.config.ts tsconfig.json ./

RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache bash gettext

COPY deploy/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/dashboard/runtime-config.template.js /opt/browsersaving/runtime-config.template.js
COPY deploy/dashboard/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

COPY --from=build /app/dist /usr/share/nginx/html

ENV VITE_SERVER_URL=https://browsersaving-worker.yokthanwa1993-bc9.workers.dev
ENV VITE_BROWSERSAVING_API_URL=https://browsersaving-api.lslly.com
ENV VITE_COMMENT_TOKEN_SERVICE_URL=https://token.lslly.com/api/comment-token
ENV VITE_REMOTE_LAUNCHER_URL=https://browsersaving-api.lslly.com

EXPOSE 80
