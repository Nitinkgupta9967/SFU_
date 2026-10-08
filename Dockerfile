FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY client ./client
COPY test ./test
COPY vitest.config.ts vitest.integration.config.ts ./
RUN npm run build && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
# WebRTC UDP ports. Publish this range and set PUBLIC_IP at runtime.
EXPOSE 40000-40100/udp
CMD ["node", "dist/src/main.js"]
