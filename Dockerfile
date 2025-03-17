FROM node:16-slim

# Install dependencies for Puppeteer
RUN apt-get update && apt-get install -y \
    libgconf-2-4 \
    libxshmfence1 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libnspr4 \
    libnss3 \
    fonts-liberation \
    chromium \
    wget \
    gnupg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create cache directory with proper permissions
RUN mkdir -p /app/cache /app/price-history /app/uploads /app/user-state /app/logs \
    && chmod -R 777 /app/cache /app/price-history /app/uploads /app/user-state /app/logs

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy project files
COPY . .

# Expose the port that your app runs on
EXPOSE 3001

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start the server
CMD ["node", "server.js"]