# A device: browsers that the bench drives remotely, on a network it shapes like Wi-Fi.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /bench
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright@1.63.0
COPY shape.sh forward.ts ./
CMD ["sh", "-c", "node forward.ts & exec npx playwright run-server --port 4000 --host 0.0.0.0"]
