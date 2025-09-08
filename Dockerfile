FROM mcr.microsoft.com/playwright:v1.54.2-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
