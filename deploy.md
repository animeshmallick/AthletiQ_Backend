# Deploying AthletiQ

Production layout:

```
 Browser / Android app
        │ HTTPS
        ├──────────────► AWS Amplify  ── www.edupilots.in  (AthletiQ_Frontend, static React build)
        │                                (edupilots.in redirects to www)
        │
        └──────────────► EC2 (Amazon Linux) ── api.edupilots.in
                           nginx :443 (HTTPS)  →  Docker container "athletiq-api"  127.0.0.1:4000
                                                            │
                                                            └──► Neon Postgres (TLS)
```

- The **backend runs as a Docker container** built from this repo's `Dockerfile`. Docker restarts it
  if it crashes or the server reboots, and rotates its logs, so no PM2 is needed.
- **nginx** on the host terminates HTTPS with a free Let's Encrypt certificate and forwards to the
  container. HTTPS is required: login cookies are `Secure` and phones only allow GPS on HTTPS.
- **Deploys are automatic.** When CI passes on `mainline`, GitHub Actions SSHes into the server and
  runs `scripts/deploy.sh` (build → migrate → swap → health check → automatic rollback). You can
  also deploy by hand with the same script (section 9).

| Address                    | Serves                                   |
| -------------------------- | ---------------------------------------- |
| `https://www.edupilots.in` | Web app for coaches and admins (Amplify) |
| `https://edupilots.in`     | Redirects to `www`                       |
| `https://api.edupilots.in` | Backend API (EC2)                        |

Commands are for **Amazon Linux 2023** on EC2 (package manager `dnf`, login user `ec2-user`).
Check yours with `cat /etc/os-release`: it should say `Amazon Linux 2023`.

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
   - AMI: **Amazon Linux 2023 (64-bit x86)**
   - Type: **t3.micro** (2 vCPU, 1 GB RAM) works for a typical academy **with 2 GB swap** (step 3).
     The image build needs ~1.5 GB, and swap covers the difference. `t3.small` (2 GB) is more
     comfortable if builds feel slow.
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
ssh -i ~/path/to/key.pem ec2-user@api.edupilots.in

# System updates + basics (curl-minimal is preinstalled and is enough)
sudo dnf -y upgrade
sudo dnf -y install git nginx openssl nano dnf-automatic
sudo timedatectl set-timezone Asia/Kolkata              # host log times in IST (app logic is IST regardless)

# Automatic security updates
sudo sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer
```

### Add swap (needed on t3.micro)

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab      # keep it after reboots
free -h                                                         # "Swap: 2.0Gi"
```

> The **security group** is the firewall on EC2 (Amazon Linux has no `ufw`). Docker also edits
> iptables directly, so the run command binds the container to `127.0.0.1` only. Never publish it
> as `-p 4000:4000`.

### Install Docker

```bash
sudo dnf -y install docker
sudo systemctl enable --now docker   # start now and on every boot (the container restarts with it)
sudo usermod -aG docker ec2-user
newgrp docker                        # or log out and back in
docker run --rm hello-world          # should print "Hello from Docker!"
```

Amazon Linux's Docker package may not include `buildx`. `docker build` then prints a "legacy
builder is deprecated" warning. That's harmless; the image builds the same.

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
# Push notifications (Android app). Firebase console → Project settings → Service accounts →
# Generate new private key; paste the JSON base64-encoded on one line. Empty = push disabled.
FCM_SERVICE_ACCOUNT=
# Coaches get a "sessions today" push at this time (IST).
REMINDER_CRON=0 7 * * *

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
  --memory 512m \
  --log-opt max-size=20m --log-opt max-file=5 \
  athletiq-api:$TAG
```

What the flags do:

| Flag                       | Why                                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| `-p 127.0.0.1:4000:4000`   | Reachable only from the host (nginx), never directly from the internet |
| `--restart unless-stopped` | Restarts after crashes and server reboots                              |
| `--init --stop-timeout 25` | Proper signal handling; gives the API 25 s to finish requests on stop  |
| `--memory 512m`            | Caps memory so a leak can't take the whole server down                 |
| `--log-opt …`              | Rotates logs (5 × 20 MB)                                               |

### 5.5 Check it

```bash
docker ps                                   # STATUS: "Up … (healthy)" after ~20 s
curl -s http://127.0.0.1:4000/ready         # {"status":"ready","database":true}
docker logs --tail 50 athletiq-api
```

---

## 6. nginx + HTTPS

Create `/etc/nginx/conf.d/athletiq-api.conf` with `sudo nano`:

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
sudo nginx -t
sudo systemctl enable --now nginx
curl -s http://api.edupilots.in/health          # {"status":"ok"}, served through nginx

# Certbot (Let's Encrypt), installed the way certbot recommends for Amazon Linux 2023
sudo dnf -y install python3 augeas-libs
sudo python3 -m venv /opt/certbot
sudo /opt/certbot/bin/pip install --upgrade pip certbot certbot-nginx
sudo ln -sf /opt/certbot/bin/certbot /usr/bin/certbot

# Free TLS certificate + HTTP→HTTPS redirect
sudo certbot --nginx -d api.edupilots.in --redirect -m <your-email> --agree-tos -n

# Automatic renewal (twice a day; renews only when close to expiry)
sudo tee /etc/systemd/system/certbot-renew.service >/dev/null <<'EOF'
[Unit]
Description=Renew Let's Encrypt certificates
[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
EOF
sudo tee /etc/systemd/system/certbot-renew.timer >/dev/null <<'EOF'
[Unit]
Description=Twice-daily certificate renewal
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now certbot-renew.timer
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

## 9. Deploying updates

### 9.1 Automatic deploys (GitHub Actions)

Every push to `mainline` runs **CI** (format, lint, typecheck, tests, Docker build). Only when it
passes does the **Deploy** workflow (`.github/workflows/deploy.yml`) SSH into the server, check out
that exact commit and run `scripts/deploy.sh`. That script:

1. builds the new image while the old container keeps serving,
2. applies database migrations,
3. replaces the container and waits up to 60 s for `/ready`,
4. **rolls back to the previous version by itself** if the new one doesn't become ready (the run
   then fails and GitHub emails you),
5. keeps the last 5 image tags for manual rollback and cleans older ones.

Deploys run one at a time and are never cancelled midway. A failed CI run never deploys.

#### One-time setup

Two SSH connections are involved, each with its own key:

```
 GitHub Actions ──(1) logs in to EC2──────► EC2 server
                                              │
 GitHub repo ◄──(2) server pulls the code─────┘
```

| Connection                        | Key                                                               | Set up in               |
| --------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| (2) Server pulls code from GitHub | **Deploy key** (private on EC2, public in GitHub → _Deploy keys_) | Step 3 → _Get the code_ |
| (1) GitHub Actions logs in to EC2 | **Actions key** (private in a GitHub secret, public on EC2)       | Steps A–F below         |

##### A. Create a key for GitHub Actions (on your own computer)

Windows PowerShell (macOS/Linux: same command with `-N ""`):

```powershell
cd $HOME\Downloads
ssh-keygen -t ed25519 -C "github-actions-deploy" -f athletiq_actions -N '""'
```

| File                   | What it is                 | Where it goes                          |
| ---------------------- | -------------------------- | -------------------------------------- |
| `athletiq_actions`     | **private** key (secret)   | GitHub secret `EC2_SSH_KEY`            |
| `athletiq_actions.pub` | **public** key (shareable) | `~/.ssh/authorized_keys` on the server |

- No passphrase, since GitHub can't type one.
- Use a **new** key, not your `.pem` or the deploy key, so GitHub's access can be revoked on its own.

##### B. Let that key log in to the server

Show the public key and copy the whole line (`ssh-ed25519 AAAA… github-actions-deploy`):

```powershell
Get-Content $HOME\Downloads\athletiq_actions.pub
```

SSH into the server as usual, then **append** it (`>>`, never `>`, which would erase your own key and
lock you out):

```bash
echo 'ssh-ed25519 AAAA...paste-the-whole-line... github-actions-deploy' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Check from your computer. It should print `it works`:

```powershell
ssh -i $HOME\Downloads\athletiq_actions ec2-user@api.edupilots.in "echo it works"
```

##### C. Get the server's fingerprint (known hosts)

GitHub checks the server's identity against this fingerprint, so it can't be tricked into talking to a fake server.
Either:

```powershell
# Option A (simple), on your computer: copy the line that is not a # comment
ssh-keyscan -t ed25519 api.edupilots.in
```

```bash
# Option B (most secure), on the server itself
echo "api.edupilots.in $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

Both give one line like `api.edupilots.in ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA…`.

##### D. Add the secrets on GitHub

1. **AthletiQ_Backend → Settings → Environments → New environment**, name it exactly
   **`production`** → _Configure environment_.
2. Under **Environment secrets → Add environment secret**, add:

   | Secret            | Value                                                                                                                      |
   | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
   | `EC2_SSH_KEY`     | The whole private key file, including the `-----BEGIN/END OPENSSH PRIVATE KEY-----` lines (copy it with the command below) |
   | `EC2_KNOWN_HOSTS` | The line from step C                                                                                                       |

   ```powershell
   Get-Content $HOME\Downloads\athletiq_actions -Raw | Set-Clipboard   # copies the private key
   ```

3. Optional, same page:
   - **Required reviewers**: add yourself to approve each deploy with a click. Leave it off for fully
     automatic deploys.
   - **Deployment branches**: _Selected branches_ → `mainline`.
   - Environment variables `EC2_HOST` / `EC2_USER` are only needed if they differ from
     `api.edupilots.in` / `ec2-user`.

##### E. Open SSH (port 22) in the security group

GitHub's runners connect from many changing IP addresses, so a "My IP" rule won't work.

1. **AWS Console → EC2 → Instances →** your instance **→ Security** tab **→** the security group link.
2. **Edit inbound rules** → the **SSH / 22** rule → **Source: Anywhere-IPv4 (`0.0.0.0/0`)** →
   **Save rules**.

This is safe because Amazon Linux only accepts key logins, so passwords can't be guessed. Confirm on the server:

```bash
sudo sshd -T | grep -i passwordauthentication     # must print: passwordauthentication no
```

Bots will still try to connect and fill the logs with failed logins; that's harmless.

##### F. Delete the private key from your computer

It's stored in GitHub now:

```powershell
Remove-Item $HOME\Downloads\athletiq_actions, $HOME\Downloads\athletiq_actions.pub
```

To revoke GitHub's access later, delete the `github-actions-deploy` line from
`~/.ssh/authorized_keys` on the server.

##### G. First deploy and checking it

1. Push to `mainline`. **GitHub → AthletiQ_Backend → Actions** shows **CI** first (3–5 min).
2. When CI is green, **Deploy** starts by itself. Its log shows `building image…`,
   `applying database migrations`, `switching container…`, `healthy`, `done`.
3. The first build on a t3.micro takes 5–10 minutes. Later builds reuse Docker's cache and are faster.
4. Open **https://api.edupilots.in/ready**: `version.commit` should be the new commit and
   `deployment.rollback` should be `false`.

From then on every push to `mainline` deploys itself. To redeploy without a push, use **Actions → Deploy →
Run workflow** (branch `mainline`).

##### If the Deploy workflow fails

| Error in the Deploy log                           | Fix                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Set the EC2_SSH_KEY and EC2_KNOWN_HOSTS secrets` | Secrets missing, or not in an environment named exactly `production` (step D)                 |
| `Permission denied (publickey)`                   | Step B not done, or the private key was pasted without its BEGIN/END lines                    |
| `Host key verification failed`                    | `EC2_KNOWN_HOSTS` is wrong or the server was replaced; redo step C                            |
| `Connection timed out`                            | Port 22 isn't open to `0.0.0.0/0` (step E)                                                    |
| `.env not found` / `No such file or directory`    | The repo on the server must be at `~/apps/athletiq-api` with `.env` inside it                 |
| `commit is not on mainline`                       | The manual run was started from another branch; pick `mainline`                               |
| `another deploy is running`                       | A manual deploy was in progress on the server; re-run when it finishes                        |
| `new version did not become ready`                | The script already restored the previous version (site stays up); the log shows why it failed |
| Deploy didn't run at all                          | CI failed, or a newer push cancelled it; the newer push deploys once its CI passes            |

**What still needs you:** changes to `.env` (edit it on the server, then run the script again or
recreate the container as below), and anything in sections 2–6 (nginx, certificates, swap).

### 9.2 Manual deploy

Same thing by hand, e.g. if GitHub Actions is down. SSH into the server, then:

```bash
cd ~/apps/athletiq-api
git fetch --prune origin && git checkout -q --detach origin/mainline
bash scripts/deploy.sh
```

<details>
<summary>What the script does, step by step (if you ever need to do it without the script)</summary>

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
  --memory 512m \
  --log-opt max-size=20m --log-opt max-file=5 \
  athletiq-api:$TAG

# 5. Verify
sleep 5
curl -s http://127.0.0.1:4000/ready         # {"status":"ready","database":true}
docker ps --filter name=athletiq-api        # "(healthy)" after ~20 s
docker logs --tail 50 athletiq-api
```

</details>

Swapping the container causes a few seconds of downtime. Pushes to `mainline` deploy right away, so
prefer merging outside training hours.

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

### What's running? (`GET /ready`)

`https://api.edupilots.in/ready` shows the live version and how it got there:

```json
{
  "status": "ready",
  "database": true,
  "version": {
    "commit": "a1b2c3d",
    "commitMessage": "Show deployment info on /ready",
    "committedAt": "2026-11-08T18:40:12+05:30",
    "builtAt": "2026-11-08T13:12:05Z"
  },
  "deployment": {
    "deployedAt": "2026-11-08T13:14:40Z",
    "kind": "deploy",
    "rollback": false,
    "previousVersion": "f770048"
  },
  "server": {
    "startedAt": "2026-11-08T13:14:41.120Z",
    "uptimeSeconds": 5400,
    "uptime": "1h 30m",
    "node": "v26.13.0",
    "environment": "production",
    "memoryMb": 142
  }
}
```

`deployment.kind` is `deploy` (newer commit), `redeploy` (same commit again) or `rollback` (an
older commit, or the script's automatic rollback after a failed health check); `rollback` is then
`true`. Containers started by hand with `docker run` show `null` for the deployment fields.

### Rolling back

Run the script with an older commit. It reuses Docker's build cache, and `/ready` reports
`"rollback": true`:

```bash
cd ~/apps/athletiq-api
docker images athletiq-api                  # tags = commits, e.g. f770048
git checkout -q --detach f770048
bash scripts/deploy.sh
```

The next push to `mainline` deploys normally again. To stay on the old version, revert the bad
commit on GitHub (`git revert`), so the automatic deploy ships the revert.

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

| Task                | How                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Status              | `docker ps` (look for `(healthy)`)                                                                                |
| Live logs           | `docker logs -f athletiq-api` (JSON lines; rotated 5 × 20 MB)                                                     |
| Resource usage      | `docker stats athletiq-api`                                                                                       |
| Restart (same env)  | `docker restart athletiq-api`                                                                                     |
| Shell inside        | `docker exec -it athletiq-api sh`                                                                                 |
| Billing job history | Web app → **Settings → Automatic billing** (or `GET /api/v1/admin/jobs/runs`)                                     |
| Run billing now     | Settings → **Run now**, or `docker exec athletiq-api node dist/jobs/run-invoice-job.js`                           |
| Who changed what    | Web app → **Audit log**                                                                                           |
| Uptime checks       | Point a monitor (e.g. UptimeRobot, Route 53 health check) at `https://api.edupilots.in/ready`                     |
| Database backups    | Neon point-in-time restore; create a branch before risky changes                                                  |
| OS patches          | Security updates install automatically (dnf-automatic). After `sudo reboot`, Docker restarts the container itself |

**Billing job:** it runs inside the container at 00:00 IST, guarded by a Postgres advisory lock. It
also catches up 15 seconds after each start, so a server that was down at midnight bills the missed
days on boot. Students are billed instantly when they are accepted, whatever the job's schedule.

**Scaling:** one container on a t3.small handles a typical academy comfortably. If you outgrow it,
move to a bigger instance type first; running more containers behind nginx also works because the
billing lock keeps the job single-run.

---

## 11. Troubleshooting

| Symptom                                                  | Likely cause / fix                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Container keeps restarting                               | `docker logs athletiq-api`. "Invalid environment configuration" names the bad `.env` variable.                                              |
| Value in `.env` "looks right" but is rejected            | Remove quotes around it; Docker passes `"…"` literally. Recreate the container after editing.                                               |
| `docker build` killed / "JavaScript heap out of memory"  | Not enough memory: check swap is on with `free -h`, and re-add it (step 3) if it shows `0B`.                                                |
| `permission denied … docker.sock`                        | Run `newgrp docker` or log out/in after `usermod -aG docker ec2-user`.                                                                      |
| `Conflict. The container name "/athletiq-api" is in use` | Old container still exists: `docker stop athletiq-api && docker rm athletiq-api`.                                                           |
| nginx 502 Bad Gateway                                    | Container down or unhealthy: `docker ps -a`, `curl 127.0.0.1:4000/health`.                                                                  |
| Browser shows CORS errors                                | `CORS_ORIGINS` must exactly match the web app origin (scheme + host, no trailing slash). Recreate the container.                            |
| Signed out on every page refresh                         | `COOKIE_SECURE=true` needs HTTPS. Using `*.amplifyapp.com`? Set `COOKIE_CROSS_SITE=true` or use a custom domain.                            |
| `/ready` says `"database": false`                        | Neon URL/password wrong, or the project is suspended. Check `DATABASE_URL`.                                                                 |
| Migrations fail                                          | They need the **direct** URL; check `DATABASE_URL_UNPOOLED`.                                                                                |
| Rate-limit errors for every user                         | `TRUST_PROXY` isn't `1` behind nginx, so all requests appear to come from one IP.                                                           |
| Disk full                                                | Clean old images/cache (section 9 → Cleaning up old images).                                                                                |
| Deep links 404 on the web app                            | Add the Amplify SPA rewrite (step 7.3).                                                                                                     |
| Maps don't load                                          | `VITE_MAPBOX_TOKEN` missing, or the token's URL restrictions don't include your domain; redeploy after fixing.                              |
| `sudo: apt: command not found`                           | You're on Amazon Linux: use `dnf` as in this guide.                                                                                         |
| nginx shows its default page                             | The `server_name` in `/etc/nginx/conf.d/athletiq-api.conf` must be `api.edupilots.in`; then `sudo nginx -t && sudo systemctl reload nginx`. |
