# Deploying AthletiQ

Production layout:

```
 Browser / Android app
        │ HTTPS
        ├──────────────► AWS Amplify  ── app.example.com   (AthletiQ_Frontend, static React build)
        │
        └──────────────► EC2 (Ubuntu) ── api.example.com
                           nginx :443  →  PM2 (2 × Node, cluster)  :4000  (AthletiQ_Backend)
                                                    │
                                                    └──► Neon Postgres (TLS)
```

Replace `example.com` with your domain throughout. Commands are for **Ubuntu 24.04 LTS** on EC2.

---

## 0. Before you start

You need:

- A domain where you can add DNS records (two subdomains: `api.` and `app.`).
- An AWS account, a GitHub account with access to both repos, and a Neon account.
- A public Mapbox token (`pk.…`), used by the web app for maps.

> **Use the same parent domain for both apps** (`app.example.com` + `api.example.com`). The login
> refresh cookie then works as a normal first-party cookie. If you use Amplify's default
> `*.amplifyapp.com` domain instead, set `COOKIE_CROSS_SITE=true` (step 4). Safari can block
> cross-site cookies, so a custom domain is strongly recommended.

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
   - Type: **t3.small** (2 vCPU, 2 GB RAM) is plenty to start; `t3.micro` works for a small academy.
   - Key pair: create or select one (you will SSH with it).
   - Storage: 20 GB gp3.
   - Region: **ap-south-1 (Mumbai)**.
2. **Security group (inbound rules):**

   | Port | Source      | Purpose                                  |
   | ---- | ----------- | ---------------------------------------- |
   | 22   | **My IP**   | SSH (never `0.0.0.0/0`)                  |
   | 80   | `0.0.0.0/0` | HTTP (Let's Encrypt + redirect to HTTPS) |
   | 443  | `0.0.0.0/0` | HTTPS                                    |

   Do **not** open port 4000. The API is only reachable through nginx.

3. **Elastic IP:** EC2 → Elastic IPs → Allocate → Associate with the instance. This keeps the IP
   fixed across reboots.
4. **DNS:** add an `A` record for `api.example.com` pointing at the Elastic IP.

---

## 3. Prepare the server

```bash
ssh -i ~/path/to/key.pem ubuntu@api.example.com

# System updates + basics
sudo apt update && sudo apt -y upgrade
sudo apt -y install git nginx curl ufw unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades        # automatic security patches
sudo timedatectl set-timezone Asia/Kolkata              # log timestamps in IST (app logic is IST regardless)

# Firewall (defence in depth on top of the security group)
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw --force enable

# Node.js via nvm (version from the repo's .nvmrc)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 26 && nvm alias default 26
node -v && npm -v

# PM2 + log rotation
npm install -g pm2
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
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

Create `~/apps/athletiq-api/.env`. It is **never committed**. Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```dotenv
NODE_ENV=production
PORT=4000
LOG_LEVEL=info
# nginx sits in front of the app (one proxy hop) — required for correct client IPs & rate limiting
TRUST_PROXY=1

# Web app origin(s) allowed to call the API, comma-separated
CORS_ORIGINS=https://app.example.com

DATABASE_URL=postgresql://…-pooler….neon.tech/athletiq?sslmode=verify-full
DATABASE_URL_UNPOOLED=postgresql://….neon.tech/athletiq?sslmode=verify-full
DB_POOL_MAX=10

JWT_ACCESS_SECRET=<random secret #1>
ACCESS_TOKEN_TTL_MINUTES=15
REFRESH_TOKEN_TTL_DAYS=30
COOKIE_SECURE=true
# true ONLY if the web app is not under the same parent domain (e.g. *.amplifyapp.com)
COOKIE_CROSS_SITE=false
COOKIE_DOMAIN=

SHARE_LINK_SECRET=<random secret #2>
SHARE_LINK_TTL_DAYS=30
PUBLIC_API_URL=https://api.example.com
APP_URL=https://app.example.com

SCHEDULER_ENABLED=true
# 00:00 IST daily: issues each student's prepaid invoice on the day their month starts
INVOICE_CRON=0 0 * * *

# Used once by the seed script (step 5), then delete these lines
SEED_ADMIN_EMAIL=you@yourdomain.com
SEED_ADMIN_NAME=Your Name
SEED_ADMIN_PASSWORD=<a strong temporary password>
```

```bash
chmod 600 .env
```

The app validates `.env` at startup and refuses to start, listing what is wrong, if anything is
missing or invalid.

---

## 5. First deploy

```bash
cd ~/apps/athletiq-api
npm ci
npm run build
npm run db:migrate:prod          # creates/updates tables (uses DATABASE_URL_UNPOOLED)
npm run db:seed:prod             # creates the first admin from SEED_ADMIN_*
sed -i '/^SEED_ADMIN_/d' .env    # remove the temporary credentials
npm prune --omit=dev

mkdir -p logs
pm2 start ecosystem.config.cjs
pm2 save

# Start PM2 on boot: run the command this prints (it starts with "sudo env PATH=...")
pm2 startup
```

Check it:

```bash
pm2 status                       # 2 × athletiq-api, status "online"
curl -s http://127.0.0.1:4000/ready    # {"status":"ready","database":true}
pm2 logs athletiq-api --lines 50
```

---

## 6. nginx + HTTPS

Create `/etc/nginx/sites-available/athletiq-api`:

```nginx
server {
    listen 80;
    server_name api.example.com;

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
sudo certbot --nginx -d api.example.com --redirect -m you@yourdomain.com --agree-tos -n
sudo certbot renew --dry-run
```

Verify from your laptop:

```bash
curl -s https://api.example.com/health   # {"status":"ok"}
curl -s https://api.example.com/ready    # {"status":"ready","database":true}
```

---

## 7. Frontend on AWS Amplify

1. **Amplify → Create new app → GitHub**, choose **AthletiQ_Frontend**, branch **`mainline`**.
   Amplify detects `amplify.yml`; keep it.
2. **Environment variables** (App settings → Environment variables):

   | Variable            | Value                     |
   | ------------------- | ------------------------- |
   | `VITE_API_URL`      | `https://api.example.com` |
   | `VITE_MAPBOX_TOKEN` | your `pk.…` token         |

   These are baked in at build time, so **redeploy after changing them**.

3. **Rewrites and redirects**: add a single-page-app rewrite so deep links like
   `/students/123` work:

   | Source                                                                                                   | Target        | Type          |
   | -------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
   | `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html` | 200 (Rewrite) |

4. **Custom domain** (Hosting → Custom domains): add `app.example.com`. Amplify issues the
   certificate and shows the DNS records to create.
5. Security and caching headers come from `customHttp.yml` in the repo.
6. **Mapbox:** in the Mapbox dashboard, restrict the token's _URL restrictions_ to
   `https://app.example.com`.

Every push to `mainline` now builds and deploys the frontend automatically.

---

## 8. After the first deploy

1. Open `https://app.example.com`, sign in with the seed admin, and **change the password**
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

## 9. Updating (manual deploy)

The backend is **deployed manually**. Pushing to GitHub never changes the server: the GitHub Actions
workflow only runs checks (format, lint, typecheck, tests, build). Deploy when you choose to,
ideally after CI is green for the commit.

**Backend** (SSH into the EC2 host):

```bash
cd ~/apps/athletiq-api

# 1. Get the new code
git fetch --prune origin
git checkout mainline
git pull --ff-only origin mainline
git log --oneline -1                      # confirm the commit you are deploying

# 2. Install and build (dev dependencies are needed to compile TypeScript)
npm ci
npm run build

# 3. Apply database migrations (safe to run when there are none)
npm run db:migrate:prod

# 4. Drop dev dependencies again
npm prune --omit=dev

# 5. Reload with no downtime (PM2 restarts one process at a time)
pm2 reload ecosystem.config.cjs --update-env
pm2 save

# 6. Verify
pm2 status
curl -s http://127.0.0.1:4000/ready        # {"status":"ready","database":true}
pm2 logs athletiq-api --lines 50
```

If you changed only `.env`, steps 5–6 are enough.

**Frontend:** push or merge to `mainline` and Amplify deploys it automatically. Each build is listed
under the branch, and you can **redeploy a previous build** in one click. To make frontend releases
manual too, turn off _Auto build_ for the branch in Amplify (App settings → Branch settings) and use
**Redeploy this version** when ready.

**Rolling back the backend:**

```bash
cd ~/apps/athletiq-api
git checkout <previous-commit-sha>
npm ci && npm run build && npm prune --omit=dev
pm2 reload ecosystem.config.cjs --update-env
```

Migrations only move forward. If a release changed the database, either fix forward or restore a
Neon branch to a point in time.

---

## 10. Operating it

| Task                | How                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Status / restarts   | `pm2 status`, `pm2 reload athletiq-api`                                                      |
| Live logs           | `pm2 logs athletiq-api` (JSON lines; rotated daily / 20 MB, 14 kept)                         |
| Resource usage      | `pm2 monit`                                                                                  |
| Billing job history | Web app → **Settings → Automatic billing** (or `GET /api/v1/admin/jobs/runs`)                |
| Run billing now     | Settings → **Run now**, or `npm run jobs:invoices:prod` on the server                        |
| Who changed what    | Web app → **Audit log**                                                                      |
| Uptime checks       | Point a monitor (e.g. UptimeRobot, Route 53 health check) at `https://api.example.com/ready` |
| Database backups    | Neon point-in-time restore; create a branch before risky changes                             |
| OS patches          | Automatic (unattended-upgrades); `sudo reboot` occasionally — PM2 restarts on boot           |

**Billing job:** it runs at 00:00 IST in every PM2 process, but a Postgres advisory lock lets only one
of them do the work. It also catches up 15 seconds after each start, so a server that was down at
midnight bills the missed days on boot. Students are billed instantly when they are accepted, whatever
the job's schedule.

**Scaling:** increase the process count with `PM2_INSTANCES=4 pm2 reload ecosystem.config.cjs
--update-env`, or move to a larger instance. Keep `DB_POOL_MAX × instances` within your Neon plan's
connection limit.

---

## 11. Troubleshooting

| Symptom                                              | Likely cause / fix                                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App won't start, "Invalid environment configuration" | Read `pm2 logs`; it names the bad variable in `.env`.                                                            |
| Browser shows CORS errors                            | `CORS_ORIGINS` must exactly match the web app origin (scheme + host, no trailing slash). Reload PM2.             |
| Signed out on every page refresh                     | `COOKIE_SECURE=true` needs HTTPS. Using `*.amplifyapp.com`? Set `COOKIE_CROSS_SITE=true` or use a custom domain. |
| nginx 502 Bad Gateway                                | API not running or not on `PORT`: `pm2 status`, `curl 127.0.0.1:4000/health`.                                    |
| `/ready` says `"database": false`                    | Neon URL/password wrong, or the project is suspended. Check `DATABASE_URL`.                                      |
| Migrations fail                                      | They need the **direct** URL; check `DATABASE_URL_UNPOOLED`.                                                     |
| Rate-limit errors for every user                     | `TRUST_PROXY` isn't `1` behind nginx, so all requests appear to come from one IP.                                |
| Deep links 404 on the web app                        | Add the Amplify SPA rewrite (step 7.3).                                                                          |
| Maps don't load                                      | `VITE_MAPBOX_TOKEN` missing, or the token's URL restrictions don't include your domain; redeploy after fixing.   |
