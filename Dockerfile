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

HEALTHCHECK --interval=30s --timeout=8s --start-period=90s --retries=3 \
  CMD node -e "const port=process.env.PORT||'10000'; fetch('http://127.0.0.1:'+port+'/healthz',{signal:AbortSignal.timeout(5000)}).then(async r=>{const d=await r.json().catch(()=>({})); process.exit(r.ok && d.healthy!==false ? 0 : 1);}).catch(()=>process.exit(1));"

CMD ["node", "src/bot.js"]
