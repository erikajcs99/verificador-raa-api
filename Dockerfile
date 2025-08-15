# Imagen oficial de Playwright con Chromium ya incluido
FROM mcr.microsoft.com/playwright:v1.54.1-jammy

WORKDIR /app

# Copia package.json y lock para instalar deps
COPY package*.json ./
RUN npm ci

# Copia el resto del código
COPY . .

# Puerto de la app
ENV PORT=3000
EXPOSE 3000

# Iniciar la API
CMD ["npm", "start"]
