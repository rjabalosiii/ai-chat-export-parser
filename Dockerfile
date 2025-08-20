# Match Playwright version to the NPM dependency (1.54.2)
FROM mcr.microsoft.com/playwright:v1.54.2-jammy

WORKDIR /app

# Copy package metadata (no lockfile required)
COPY package*.json ./

# Install only production deps
RUN npm install --omit=dev

# Copy app source
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.mjs"]
