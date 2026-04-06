FROM node:20-slim

# Install system dependencies needed for canvas, sharp, ffmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    ffmpeg \
    curl \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# HuggingFace Spaces runs as non-root user 1000
RUN useradd -m -u 1000 user
USER user

ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860

WORKDIR /home/user/app

# Copy package files first for better layer caching
COPY --chown=user package*.json ./

# Install dependencies
RUN npm install --production

# Copy rest of the project
COPY --chown=user . .

# Create required directories
RUN mkdir -p data temp

# HuggingFace Spaces requires port 7860
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:7860/health || exit 1

CMD ["node", "index.js"]
