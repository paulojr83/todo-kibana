# Config embutida na imagem (sem bind mount, funciona sem a integração WSL do
# Docker Desktop). Depois de editar tempo.yaml: `docker compose up -d --build tempo`.
#
# A imagem do Tempo é distroless e roda como 10001; o diretório de dados é criado
# aqui com esse dono para o volume nomeado herdar a permissão.
FROM busybox:1.36 AS data
RUN mkdir -p /var/tempo

FROM grafana/tempo:2.8.2
COPY --from=data --chown=10001:10001 /var/tempo /var/tempo
COPY tempo.yaml /etc/tempo.yaml
