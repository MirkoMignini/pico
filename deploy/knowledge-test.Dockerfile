# Disposable validation image, never an owner deployment.
FROM pico-app:0.1.0
USER root
COPY scripts/validate-knowledge.mjs /app/scripts/validate-knowledge.mjs
COPY scripts/check-knowledge-offline.mjs /app/scripts/check-knowledge-offline.mjs
COPY tests/fixtures/knowledge /app/tests/fixtures/knowledge
COPY eval/knowledge-gold.json /app/eval/knowledge-gold.json
USER 1000:1000
ENTRYPOINT ["node"]
