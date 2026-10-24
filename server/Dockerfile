FROM python:3.12-slim
WORKDIR /app
COPY server /app/server
COPY crates/app-database/migrations /app/crates/app-database/migrations
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --create-home lenota && mkdir /data && chown lenota:lenota /data
USER lenota
EXPOSE 8787
VOLUME ["/data"]
CMD ["python", "server/sync_server.py", "--host", "0.0.0.0", "--data", "/data"]
