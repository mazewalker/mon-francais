# Mon Français

French practice app for several users. Each user has their own account and their own saved progress. New accounts can only be created with an invite code.

- `public/index.html` – the app (served only to logged-in users)
- `public/login.html` – login / registration page
- `server.js` – zero-dependency Node server
- `store.js` – file-based storage shared by the server and the CLI
- `cli.js` – admin CLI, run through `make`

## Admin commands

```
make help                              list everything
make invite NOTE="Anna" [DAYS=14]      single-use invite code + link (DAYS=0: never expires)
make invites                           list invites and who used them
make revoke-invite CODE=ABCD...
make users                             users, last save, word count
make create-user NAME=anna [PASS=...]  create an account without an invite
make passwd NAME=anna [PASS=...]       reset password (random if omitted); logs them out
make logout NAME=anna                  log out on all devices
make delete-user NAME=anna [PURGE=1]   delete account (data kept unless PURGE=1)
make import-legacy NAME=anna [FORCE=1] give the old single-user data to an account
```

Where the command runs:

| You are…                                  | Run                                   |
|-------------------------------------------|---------------------------------------|
| in Coolify's **Terminal** for the app     | `make invite NOTE=Anna`               |
| on the Coolify host via SSH               | `make invite NOTE=Anna CONTAINER=<container-name>` (find it with `docker ps`) |
| local, with `docker compose up`           | `make invite NOTE=Anna COMPOSE=1`     |
| local, with `make run`                    | `make invite NOTE=Anna`               |

User names are passed as `NAME=`, not `USER=`, because `USER` is already your shell's login name.

## Deploy on Coolify

1. Push this folder to a Git repo.
2. In Coolify: **New Resource → Application → your repo**, build pack **Docker Compose**.
3. Set the domain for the `app` service (port 3000), e.g. `https://francia.example.com:3000`.
4. Optional: set the env var `PUBLIC_URL=https://francia.example.com` so `make invite` prints full links.
5. Deploy, open the app's **Terminal** in Coolify and run `make invite NOTE="…"`. Send the link.

### Upgrading from the single-user version

The old server data (`/data/state.json`) is still in the volume. Register your daughter's account with an invite, then run `make import-legacy NAME=<her-username>`.
If her browser still has the old local copy, it is also moved into her account the first time she logs in on that device.

## Data & persistence

Everything is stored in the named volume `mon-francais-data`, mounted at `/data`:

```
/data/accounts/<user>.json                       login (scrypt-hashed password)
/data/invites/<CODE>.json                        invites
/data/sessions/…                                 logins (1 year, extended on use)
/data/users/<user>/state.json                    current progress
/data/users/<user>/backups/state-YYYY-MM-DD.json one snapshot per day, kept forever
```

The volume survives redeploys, rebuilds and restarts. Never choose "delete volumes" when removing the resource.
If you use the **Dockerfile** build pack instead, add a Persistent Storage entry for `/data`.
For off-server safety, enable Coolify backups or copy `/data` elsewhere now and then.
Users can also download their own backup from Settings → "Mentés letöltése".

## Development

```
make run     # http://localhost:3000, data in ./data
make dev     # same, restarts on changes
make test    # end-to-end smoke test (throwaway data dir)
make up / make down / make logs   # docker compose
```
