# Ask the Spec as a container: the same handlers Vercel runs, served by
# server/index.mjs. The embedding index is built at start from
# data/chunks.json (see server/start.mjs), so no key is baked into the image.
#
#   docker build -t ask-the-spec .
#   docker run -p 8080:8080 --env-file .env ask-the-spec
#
# Runtime environment: VOYAGE_API_KEY, ANTHROPIC_API_KEY and BANNED_NAMES are
# required (without BANNED_NAMES every answer is refused, by design).
# LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY turn on tracing.

FROM node:22-slim

ENV NODE_ENV=production PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY api ./api
COPY lib ./lib
COPY public ./public
COPY server ./server
COPY scripts/build-index.mjs ./scripts/build-index.mjs
COPY data/chunks.json ./data/chunks.json

# Run as the image's unprivileged user; it needs to write data/index.json.
RUN chown -R node:node /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/start.mjs"]
