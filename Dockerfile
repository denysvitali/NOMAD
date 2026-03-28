# Stage 1: React Client bauen
FROM node:22-alpine AS client-builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app/client
COPY client/package.json client/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY client/ ./
RUN pnpm run build

# Stage 2: Produktions-Server
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Server-Dependencies installieren (better-sqlite3 braucht Build-Tools)
COPY server/package.json server/pnpm-lock.yaml ./
RUN apk add --no-cache python3 make g++ && \
    pnpm install --frozen-lockfile --prod && \
    apk del python3 make g++

# Server-Code kopieren
COPY server/ ./

# Gebauten Client kopieren
COPY --from=client-builder /app/client/dist ./public

# Fonts für PDF-Export kopieren
COPY --from=client-builder /app/client/public/fonts ./public/fonts

# Verzeichnisse erstellen und Berechtigungen setzen
RUN mkdir -p /app/data /app/uploads/files /app/uploads/covers /app/uploads/photos /app/uploads/avatars && \
    addgroup -S nomad && adduser -S nomad -G nomad && \
    chown -R nomad:nomad /app

# Als non-root Benutzer ausführen
USER nomad

# Umgebung setzen
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/index.js"]
