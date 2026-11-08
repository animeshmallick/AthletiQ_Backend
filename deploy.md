# Deploying AthletiQ

Production layout:

```
 Browser / Android app
        │ HTTPS
        ├──────────────► AWS Amplify  ── www.edupilots.in  (AthletiQ_Frontend, static React build)
        │                                (edupilots.in redirects to www)
        │
        └──────────────► EC2 (Ubuntu) ── api.edupilots.in
                           nginx :443 (HTTPS)  →  Docker container "athletiq-api"  127.0.0.1:4000
                                                            │
                                                            └──► Neon Postgres (TLS)
```

- The **backend runs as a Docker container** built from this repo's `Dockerfile`. Docker restarts it
  if it crashes or the server reboots, and rotates its logs, so no PM2 is needed.
- **nginx** on the host terminates HTTPS with a free Let's Encrypt certificate and forwards to the
  container. HTTPS is required: login cookies are `Secure` and phones only allow GPS on HTTPS.
- **Deploys are manual.** Pushing to GitHub never changes the server; CI only runs checks.

| Address                    | Serves                                   |
| -------------------------- | ---------------------------------------- |
| `https://www.edupilots.in` | Web app for coaches and admins (Amplify) |
| `https://edupilots.in`     | Redirects to `www`                       |
| `https://api.edupilots.in` | Backend API (EC2)                        |

Commands are for **Ubuntu 24.04 LTS** on EC2.

---

## 0. Before you start

You need:

- Access to the DNS settings of **edupilots.in** at your domain registrar (or Route 53).
- An AWS account, a GitHub account with access to both repos, and a Neon account.
- A public Mapbox token (`pk.…`), used by the web app for maps.

> The web app and API share the parent domain **edupilots.in**, so the login cookie works as a
> normal first-party cookie and `COOKIE_CROSS_SITE` stays `false`. If you ever test from Amplify's
> default `*.amplifyapp.com` address, add it to `CORS_ORIGINS` and expect Safari to block the
> login cookie there.

---

## 1. Database (Neon)

1. In Neon, create a project in the **AWS Asia Pacific (Mumbai / Singapore)** region (close to the
   EC2 host). Create a database, e.g. `athletiq`. Keep development and production in **separate
   projects or branches**.
2. From **Connect**, copy two connection strings:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **Direct** (no `-pooler`) → `DATABASE_URL_UNPOOLED`; used for migrations and the billing
     job's lock.
3. Change `sslmode=require` to `sslmode=verify-full` at the end of both URLs.
4. Under **Settings → Backups / Restore**, check that point-in-time restore covers at least 7 days.

---

## 2. EC2 instance

1. **Launch an instance** (EC2 → Instances → Launch):
   - AMI: **Ubuntu Server 24.04 LTS (64-bit x86)**
   - Type: **t3.small** (2 vCPU, 2 GB RAM). Building the image needs about 1.5 GB RAM, so avoid
     `t3.micro` unless you add swap (see Troubleshooting).
   - Key pair: create or select one (you will SSH with it).
   - Storage: **30 GB gp3** (Docker images and build cache take space).
   - Region: **ap-south-1 (Mumbai)**.
2. **Security group (inbound rules):**

   | Port | Source      | Purpose                                  |
   | ---- | ----------- | ---------------------------------------- |
   | 22   | **My IP**   | SSH (never `0.0.0.0/0`)                  |
   | 80   | `0.0.0.0/0` | HTTP (Let's Encrypt + redirect to HTTPS) |
   | 443  | `0.0.0.0/0` | HTTPS                                    |

   Do **not** open port 4000. The container is bound to `127.0.0.1` and reachable only through
   nginx.

3. **Elastic IP:** EC2 → Elastic IPs → Allocate → Associate with the instance. This keeps the IP
   fixed across reboots.
4. **DNS for the API:** at your registrar, add a record for **edupilots.in**:

   | Type | Name / Host | Value             | TTL |
   | ---- | ----------- | ----------------- | --- |
   | A    | `api`       | _your Elastic IP_ | 300 |

   Check it resolves before requesting a certificate (step 6): `nslookup api.edupilots.in`.

---

## 3. Prepare the server

```bash
ssh -i ~/path/to/key.pem ubuntu@api.edupilots.in

# System updates + basics
sudo apt update && sudo apt -y upgrade
sudo apt -y install git nginx curl ufw unattended-upgrades openssl
sudo dpkg-reconfigure -plow unattended-upgrades        # automatic security patches
sudo timedatectl set-timezone Asia/Kolkata              # host log times in IST (app logic is IST regardless)

# Firewall (defence in depth on top of the security group)
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable
```

> Docker publishes ports by editing iptables directly, bypassing `ufw`. That's why the run command
> binds the container to `127.0.0.1` only. Never publish it as `-p 4000:4000`.

### Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker                       # or log out and back in
docker run --rm hello-world         # should print "Hello from Docker!"
sudo systemctl enable docker        # start Docker (and the container) on boot
```

### Get the code

Give the server **read-only** access with a deploy key:

```bash
ssh-keygen -t ed25519 -C "athletiq-ec2" -f ~/.ssh/athletiq_deploy -N ""
cat ~/.ssh/athletiq_deploy.pub
```

On GitHub, open **AthletiQ_Backend → Settings → Deploy keys → Add deploy key**, paste the key, and
leave _Allow write access_ **unchecked**. Then:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-athletiq
  HostName github.com
  User git
  IdentityFile ~/.ssh/athletiq_deploy
  IdentitiesOnly yes
EOF

mkdir -p ~/apps && cd ~/apps
git clone git@github-athletiq:animeshmallick/AthletiQ_Backend.git athletiq-api
cd athletiq-api
```

---

## 4. Configure environment

Create `~/apps/athletiq-api/.env` with `nano .env`. This file is **never committed** and is passed
to the container at runtime. It is **not** baked into the image.

Generate each secret with:

```bash
openssl rand -base64 48 | tr -d '\n/+='; echo
```

```dotenv
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
# nginx sits in front of the app (one proxy hop) — required for correct client IPs & rate limiting
TRUST_PROXY=1

# Web app origin(s) allowed to call the API, comma-separated
CORS_ORIGINS=https://www.edupilots.in

DATABASE_URL=postgresql://…-pooler….neon.tech/athletiq?sslmode=verify-full
DATABASE_URL_UNPOOLED=postgresql://….neon.tech/athletiq?sslmode=verify-full
DB_POOL_MAX=10

JWT_ACCESS_SECRET=<random secret #1>
ACCESS_TOKEN_TTL_MINUTES=15
REFRESH_TOKEN_TTL_DAYS=30
COOKIE_SECURE=true
# false: www.edupilots.in and api.edupilots.in share the parent domain
COOKIE_CROSS_SITE=false
COOKIE_DOMAIN=

SHARE_LINK_SECRET=<random secret #2>
SHARE_LINK_TTL_DAYS=30
PUBLIC_API_URL=https://api.edupilots.in
APP_URL=https://www.edupilots.in

SCHEDULER_ENABLED=true
# 00:00 IST daily: issues each student's prepaid invoice on the day their month starts
INVOICE_CRON=0 0 * * *

# Used once by the seed step (5.3), then delete these lines
SEED_ADMIN_EMAIL=you@yourdomain.com
SEED_ADMIN_NAME=Your Name
SEED_ADMIN_PASSWORD=<a strong temporary password>
```

```bash
chmod 600 .env
```

**Docker `.env` rules:** one `KEY=value` per line, **no quotes** around values (Docker passes them
literally), no `export`, and comments only on their own lines. The app validates every variable at
startup and refuses to start, naming the problem, if anything is missing or invalid.

---

## 5. First deploy

All commands run in `~/apps/athletiq-api`. Images are tagged with the **git commit**, so you always
know what is running and can roll back by tag.

### 5.1 Build the image

```bash
cd ~/apps/athletiq-api
TAG=$(git rev-parse --short HEAD)
docker build --build-arg GIT_SHA=$TAG -t athletiq-api:$TAG -t athletiq-api:latest .
```

The first build takes a few minutes; later builds reuse cached layers.

### 5.2 Apply database migrations

```bash
docker run --rm --env-file .env athletiq-api:$TAG node dist/db/migrate.js
# → "Migrations applied"
```

### 5.3 Create the first admin, then remove the temporary credentials

```bash
docker run --rm --env-file .env athletiq-api:$TAG node dist/db/seed.js
# → "Admin created…"
sed -i '/^SEED_ADMIN_/d' .env
```

### 5.4 Start the API container

```bash
docker run -d --name athletiq-api \
  --env-file .env \
  -p 127.0.0.1:4000:4000 \
  --restart unless-stopped \
  --init --stop-timeout 25 \
  --memory 768m \
  --log-opt max-size=20m --log-opt max-file=5 \
  athletiq-api:$TAG
```

What the flags do:

| Flag                       | Why                                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| `-p 127.0.0.1:4000:4000`   | Reachable only from the host (nginx), never directly from the internet |
| `--restart unless-stopped` | Restarts after crashes and server reboots                              |
| `--init --stop-timeout 25` | Proper signal handling; gives the API 25 s to finish requests on stop  |
| `--memory 768m`            | Caps memory so a leak can't take the whole server down                 |
| `--log-opt …`              | Rotates logs (5 × 20 MB)                                               |

### 5.5 Check it

```bash
docker ps                                   # STATUS: "Up … (healthy)" after ~20 s
curl -s http://127.0.0.1:4000/ready         # {"status":"ready","database":true}
docker logs --tail 50 athletiq-api
```

---

## 6. nginx + HTTPS

Create `/etc/nginx/sites-available/athletiq-api` with `sudo nano`:

```nginx
server {
    listen 80;
    server_name api.edupilots.in;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/athletiq-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Free TLS certificate with auto-renewal, plus HTTP→HTTPS redirect
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d api.edupilots.in --redirect -m <your-email> --agree-tos -n
sudo certbot renew --dry-run
```

Verify from your laptop:

```bash
curl -s https://api.edupilots.in/health   # {"status":"ok"}
curl -s https://api.edupilots.in/ready    # {"status":"ready","database":true}
```

---

## 7. Frontend on AWS Amplify

1. **Amplify → Create new app → GitHub**, choose **AthletiQ_Frontend**, branch **`mainline`**.
   Amplify detects `amplify.yml`; keep it.
2. **Environment variables** (App settings → Environment variables):

   | Variable            | Value                      |
   | ------------------- | -------------------------- |
   | `VITE_API_URL`      | `https://api.edupilots.in` |
   | `VITE_MAPBOX_TOKEN` | your `pk.…` token          |

   These are baked in at build time, so **redeploy after changing them**.

3. **Rewrites and redirects**: add a single-page-app rewrite so deep links like
   `/students/123` work:

   | Source                                                                                                   | Target        | Type          |
   | -------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
   | `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html` | 200 (Rewrite) |

4. **Custom domain** (Hosting → Custom domains → Add domain): enter **edupilots.in**, then:
   - map the subdomain **`www`** to the `mainline` branch;
   - keep the root **`edupilots.in`** entry and set it to **redirect to `https://www.edupilots.in`**.

   Amplify issues the certificate and lists the DNS records to add at your registrar: a `CNAME` for
   certificate validation, a `CNAME` for `www` pointing to the Amplify domain, and an
   `ANAME`/`ALIAS` (or `A`) record for the root. If your registrar can't create `ALIAS`/`ANAME`
   records for the root, use its URL-forwarding feature to redirect `edupilots.in` →
   `https://www.edupilots.in`, or move DNS to Route 53. Validation usually takes 15–30 minutes.

5. Security and caching headers come from `customHttp.yml` in the repo.
6. **Mapbox:** in the Mapbox dashboard, restrict the token's _URL restrictions_ to
   `https://www.edupilots.in` (and `http://localhost:5173` if you use the same token for development).

By default every push to `mainline` builds the frontend. To release it manually too, turn off _Auto
build_ for the branch (App settings → Branch settings) and use **Redeploy this version** when ready.

---

## 8. After the first deploy

1. Open `https://www.edupilots.in`, sign in with the seed admin, and **change the password**
   (avatar menu → Account).
2. **Settings:** fill in the academy name, address, phone, GSTIN (optional) and UPI ID. These appear
   on invoices and in WhatsApp messages.
3. Create **Locations** (pin + radius), **Fee plans**, and invite **Coaches** (Team → Invite); share
   the invite link with them.
4. Create **Batches**, then register **Students**. Billing is **prepaid**: each student's first
   invoice is generated immediately, then one is generated at the start of every month.
5. Share the public registration link (Registrations → _Copy public link_).
6. Test end to end: mark attendance, do a coach GPS check-in at the ground, share an invoice on
   WhatsApp and open the PDF link from a phone.

---

## 9. Manual deploy (every update)

Deploy when you choose to, ideally after the GitHub Actions checks are green for the commit. SSH into
the server, then:

```bash
cd ~/apps/athletiq-api

# 1. Get the new code and confirm what you're deploying
git fetch --prune origin
git checkout mainline
git pull --ff-only origin mainline
TAG=$(git rev-parse --short HEAD)
git log --oneline -1

# 2. Build the new image (the running container keeps serving meanwhile)
docker build --build-arg GIT_SHA=$TAG -t athletiq-api:$TAG -t athletiq-api:latest .

# 3. Apply database migrations (safe to run when there are none)
docker run --rm --env-file .env athletiq-api:$TAG node dist/db/migrate.js

# 4. Replace the running container (a few seconds of downtime)
docker stop athletiq-api && docker rm athletiq-api
docker run -d --name athletiq-api \
  --env-file .env \
  -p 127.0.0.1:4000:4000 \
  --restart unless-stopped \
  --init --stop-timeout 25 \
  --memory 768m \
  --log-opt max-size=20m --log-opt max-file=5 \
  athletiq-api:$TAG

# 5. Verify
sleep 5
curl -s http://127.0.0.1:4000/ready         # {"status":"ready","database":true}
docker ps --filter name=athletiq-api        # "(healthy)" after ~20 s
docker logs --tail 50 athletiq-api
```

Step 4 causes a few seconds of downtime, so prefer deploying outside training hours.

**Only changed `.env`?** Recreate the container (step 4) with the current tag; a plain
`docker restart` does **not** re-read `.env`:

```bash
TAG=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' athletiq-api)
# …then the two commands from step 4
```

**See which version is running:**

```bash
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' athletiq-api
```

### Rolling back

Every build stays on the server under its commit tag:

```bash
docker images athletiq-api                  # pick the previous tag, e.g. f770048
TAG=f770048
docker stop athletiq-api && docker rm athletiq-api
# …then the "docker run -d …" command from step 4
```

Migrations only move forward. If a release changed the database, either fix forward or restore a
Neon branch to a point in time.

### Cleaning up old images

Keep the last few tags for rollback, and remove older ones:

```bash
docker images athletiq-api                  # list tags
docker rmi athletiq-api:<old-tag>           # remove one
docker image prune -f && docker builder prune -f --filter until=168h   # dangling layers, week-old cache
df -h /                                     # check free disk space
```

---

## 10. Operating it

| Task                | How                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Status              | `docker ps` (look for `(healthy)`)                                                            |
| Live logs           | `docker logs -f athletiq-api` (JSON lines; rotated 5 × 20 MB)                                 |
| Resource usage      | `docker stats athletiq-api`                                                                   |
| Restart (same env)  | `docker restart athletiq-api`                                                                 |
| Shell inside        | `docker exec -it athletiq-api sh`                                                             |
| Billing job history | Web app → **Settings → Automatic billing** (or `GET /api/v1/admin/jobs/runs`)                 |
| Run billing now     | Settings → **Run now**, or `docker exec athletiq-api node dist/jobs/run-invoice-job.js`       |
| Who changed what    | Web app → **Audit log**                                                                       |
| Uptime checks       | Point a monitor (e.g. UptimeRobot, Route 53 health check) at `https://api.edupilots.in/ready` |
| Database backups    | Neon point-in-time restore; create a branch before risky changes                              |
| OS patches          | Automatic (unattended-upgrades). After `sudo reboot`, Docker restarts the container itself    |

**Billing job:** it runs inside the container at 00:00 IST, guarded by a Postgres advisory lock. It
also catches up 15 seconds after each start, so a server that was down at midnight bills the missed
days on boot. Students are billed instantly when they are accepted, whatever the job's schedule.

**Scaling:** one container on a t3.small handles a typical academy comfortably. If you outgrow it,
move to a bigger instance type first; running more containers behind nginx also works because the
billing lock keeps the job single-run.

---

## 11. Troubleshooting

| Symptom                                                  | Likely cause / fix                                                                                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container keeps restarting                               | `docker logs athletiq-api`. "Invalid environment configuration" names the bad `.env` variable.                                                                                    |
| Value in `.env` "looks right" but is rejected            | Remove quotes around it; Docker passes `"…"` literally. Recreate the container after editing.                                                                                     |
| `docker build` killed / "JavaScript heap out of memory"  | Instance too small. Add swap: `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` (add it to `/etc/fstab` to keep it). |
| `permission denied … docker.sock`                        | Run `newgrp docker` or log out/in after `usermod -aG docker ubuntu`.                                                                                                              |
| `Conflict. The container name "/athletiq-api" is in use` | Old container still exists: `docker stop athletiq-api && docker rm athletiq-api`.                                                                                                 |
| nginx 502 Bad Gateway                                    | Container down or unhealthy: `docker ps -a`, `curl 127.0.0.1:4000/health`.                                                                                                        |
| Browser shows CORS errors                                | `CORS_ORIGINS` must exactly match the web app origin (scheme + host, no trailing slash). Recreate the container.                                                                  |
| Signed out on every page refresh                         | `COOKIE_SECURE=true` needs HTTPS. Using `*.amplifyapp.com`? Set `COOKIE_CROSS_SITE=true` or use a custom domain.                                                                  |
| `/ready` says `"database": false`                        | Neon URL/password wrong, or the project is suspended. Check `DATABASE_URL`.                                                                                                       |
| Migrations fail                                          | They need the **direct** URL; check `DATABASE_URL_UNPOOLED`.                                                                                                                      |
| Rate-limit errors for every user                         | `TRUST_PROXY` isn't `1` behind nginx, so all requests appear to come from one IP.                                                                                                 |
| Disk full                                                | Clean old images/cache (section 9 → Cleaning up).                                                                                                                                 |
| Deep links 404 on the web app                            | Add the Amplify SPA rewrite (step 7.3).                                                                                                                                           |
| Maps don't load                                          | `VITE_MAPBOX_TOKEN` missing, or the token's URL restrictions don't include your domain; redeploy after fixing.                                                                    |
