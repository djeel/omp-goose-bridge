# Utiliser les recipes depuis Goose

```bash
# Délégation routée (Goose décide du rôle)
goose run --recipe ~/.config/goose/recipes/omp-auto.yaml --params task="implémente la pagination"

# Review en lecture seule
goose run --recipe ~/.config/goose/recipes/omp-review.yaml --params target="le diff courant"

# Développement avec gate de review obligatoire
goose run --recipe ~/.config/goose/recipes/omp-develop.yaml --params objective="ajoute un cache LRU"
```

En CLI, les slash commands `omp-auto`, `omp-review`, `omp-develop` sont disponibles
après `bash scripts/install.sh`.
