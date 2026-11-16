FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/auth2api-entrypoint.sh
EXPOSE 8317
VOLUME ["/data", "/config"]
ENV NODE_ENV=production
ENTRYPOINT ["auth2api-entrypoint.sh"]
CMD ["node", "dist/index.js", "--config=/config/config.yaml"]
