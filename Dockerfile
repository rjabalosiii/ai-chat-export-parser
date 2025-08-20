FROM mcr.microsoft.com/playwright:v1.47.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.mjs"]