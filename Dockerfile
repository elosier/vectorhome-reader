# Minimal image — no native build deps needed (uses Node's built-in node:sqlite).
FROM node:24-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Persist the SQLite database outside the image.
VOLUME /app/data
ENV PORT=3000
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
