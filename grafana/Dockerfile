# Provisioning embutido na imagem em vez de bind mount: funciona mesmo sem a
# integração WSL do Docker Desktop. Depois de editar algo em ./grafana, rode
# `docker compose up -d --build grafana`.
FROM grafana/grafana:12.2.0

COPY provisioning /etc/grafana/provisioning
COPY dashboards /etc/grafana/dashboards
