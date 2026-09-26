FROM node:20-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production || npm install

# Copy application source code
COPY . .

# Expose port
EXPOSE 5005

# Start application
CMD ["node", "server.js"]
