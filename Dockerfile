FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Copy only package metadata first (no lockfile required)
COPY package*.json ./

# Install dependencies (production only, no lockfile needed)
RUN npm install --omit=dev

# Copy app source
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.mjs"]
