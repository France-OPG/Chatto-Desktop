# Chatto Desktop

Client desktop multi-serveurs pour Chatto (Windows / macOS / Linux), écrit en
Go + Wails v2.

## Ce qui est fait

- Écran de sélection de langue (10 langues) au tout premier lancement.
- Détection automatique d'un `base.cd` à côté de l'exécutable :
  - absent -> proposition de **créer** un nouveau coffre ou d'**importer** un `base.cd` existant
  - présent -> demande directement le mot de passe pour le déverrouiller
- `base.cd` chiffré en **AES-256-GCM**, clé dérivée du mot de passe via
  **Argon2id** (résistant au brute-force). Format sur disque :
  `salt(16) | nonce(12) | ciphertext`.
- Coffre = liste de serveurs Chatto (nom, URL, identifiant, mot de passe).
- Sidebar listant les serveurs, bouton `+` pour en ajouter.
- Export du `base.cd` (toujours chiffré) vers un autre emplacement.

## Ce qu'il reste à brancher

- **Connexion réelle aux serveurs** : au clic sur un serveur dans la sidebar
  (`app.js`, fonction `refreshServerList`), il faut appeler l'API GraphQL /
  NATS de Chatto avec les identifiants stockés. Prévoir un client Go
  (`nats.go`, `graphql.go`) exposé lui aussi via `Bind` dans `main.go`.
- **Logo** : dépose le fichier `Chatto-Desktop.png` dans
  `frontend/dist/logo.png` (il est déjà référencé dans `index.html`, avec un
  fallback silencieux s'il est absent). Pour l'icône de l'exécutable
  (`.ico` Windows / `.icns` macOS), voir `build/appicon.png` généré par
  `wails build` — remplace-le par ton logo avant de builder.
- **Dialogues natifs** : l'export utilise un `prompt()` basique pour
  l'instant. Remplace-le par `runtime.SaveFileDialog` (package
  `github.com/wailsapp/wails/v2/pkg/runtime`) pour une vraie boîte de
  dialogue système. Idem pour l'import (`runtime.OpenFileDialog`).

## Build

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
wails build            # build pour l'OS courant
wails build -platform windows/amd64
wails build -platform darwin/universal
wails build -platform linux/amd64
```

Le binaire attend un `base.cd` à côté de lui — aucune installation, aucune
config externe.
