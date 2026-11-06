# Playwright base image already contains Chromium and every OS dependency.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

USER root
WORKDIR /app

# Install only production dependencies (package-lock.json keeps it reproducible).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p ./data
ENV NODE_ENV=production
ENV TZ=UTC

# Unbuffered logs so Render shows lines immediately.
ENV NODE_OPTIONS=--enable-source-maps

CMD ["node", "src/bot.js"]
