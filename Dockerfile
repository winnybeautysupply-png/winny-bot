FROM node:20-alpine

WORKDIR /app

# Instalar deps de compilación para better-sqlite3
RUN apk add --no-cache python3 make g++

# Copiar package.json e instalar dependencias
COPY package.json ./
RUN npm install --omit=dev

# Copiar código fuente
COPY src/ ./src/

# Crear directorios de datos
RUN mkdir -p ./data/comprobantes

# Puerto que expone
EXPOSE 3000

# Variables de entorno por default
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "src/index.js"]
