# Sécurité

## Versions supportées

| Version | Support |
|---|---|
| 1.1.x | ✅ |
| < 1.1 | ❌ |

## Signaler une vulnérabilité

**N'ouvre pas d'issue publique.** Utilise
[GitHub Security Advisories](https://github.com/djeel/omp-goose-bridge/security/advisories/new).

Réponse sous 7 jours. Merci d'inclure : version, OS, étapes de reproduction, impact.

## Modèle de menace

Le bridge est un outil **local** :

- le serveur MCP parle stdio avec Goose (pas de réseau) ;
- le panneau HTTP écoute sur `127.0.0.1` par défaut ;
- l'écriture est impossible hors session `developer`, avec un verrou unique par workspace ;
- les workspaces sont validés contre une allowlist (`OMP_BRIDGE_ROOTS`), symlinks résolus.

Ce qui **n'est pas** couvert :

- exposition volontaire du panneau sur le LAN (`OMP_BRIDGE_HTTP_HOST=0.0.0.0`) sans reverse-proxy authentifié ;
- code exécuté par OMP lui-même (le bridge ne sandboxe pas le binaire OMP) ;
- permissions du système de fichiers de l'utilisateur.
