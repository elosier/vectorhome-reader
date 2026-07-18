# Remote HTTPS access (free cert, ISP blocks 80/443)

How to reach the reader securely from anywhere when your ISP blocks the standard
HTTP(S) ports — using a free, auto‑renewing certificate and a non‑standard port.

This is the setup that's running in production: **acme.sh (DNS‑01 via DuckDNS) →
Caddy on :8443 (TLS) → the reader on 127.0.0.1:3000.**

## How it fits together

```
phone / browser
      │  https://example.duckdns.org:8443   (valid cert; the app shows its own login)
      ▼
router  ──forward TCP 8443──▶  Caddy (:8443)  ──reverse_proxy──▶  reader (127.0.0.1:3000, plain HTTP)
                                  ▲
                                  └── cert from acme.sh (/etc/caddy/certs), DNS-01 via DuckDNS
```

- The reader stays **plain HTTP, localhost-only**. Caddy adds TLS + a password.
- The cert is obtained with the **DNS‑01** challenge, which writes a DNS TXT
  record — so it needs **no inbound ports** (works even with 80/443 blocked).

## Prerequisites

- A **public IP** (not CGNAT). Check: `curl -s ifconfig.me` should equal your
  router's WAN IP. If they differ you're behind CGNAT — port‑forwarding can't
  work; use a tunnel/VPN (e.g. Tailscale) instead.
- **One inbound port the ISP doesn't block** (we use `8443`).
- A free **DuckDNS** account (afraid.org *public* domains can't do automated
  DNS‑01 — see Troubleshooting).

## 1. DuckDNS

1. Sign in at https://www.duckdns.org and create a subdomain, e.g. `example`
   (→ `example.duckdns.org`). Point it at your current public IP.
2. Copy your **token** (top of the page). Keep it secret.

## 2. Issue the certificate (as root)

```bash
sudo -i
curl https://get.acme.sh | sh -s email=you@example.com
export DuckDNS_Token='YOUR-REAL-DUCKDNS-TOKEN'
/root/.acme.sh/acme.sh --issue --dns dns_duckdns -d example.duckdns.org
```
acme.sh installs a renewal cron automatically. (If you hit a rate limit, add
`--server letsencrypt` or `--server zerossl` to switch CA.)

## 3. Install Caddy

Use your distro's package so it creates the `caddy` user/group and a systemd
service (Debian/Ubuntu: the official Caddy apt repo; Fedora: `dnf install caddy`).

## 4. Caddyfile

Copy [`Caddyfile`](Caddyfile) to `/etc/caddy/Caddyfile`.

Key points in the file:
- Site address `example.duckdns.org:8443` (hostname + non‑standard port).
- `tls` points at the cert files installed in step 5.
- No `basic_auth` needed: the app has its own login page (+ optional TOTP 2FA).
- A global block disables HTTP/3 because only **TCP** 8443 is forwarded
  (QUIC needs UDP). Remove it if you also forward UDP 8443.

## 5. Install the cert into Caddy's path (as root)

Run **after** Caddy is installed (so the `caddy` group exists):

```bash
mkdir -p /etc/caddy/certs
/root/.acme.sh/acme.sh --install-cert -d example.duckdns.org \
  --key-file       /etc/caddy/certs/example.duckdns.org.key \
  --fullchain-file /etc/caddy/certs/example.duckdns.org.cer \
  --reloadcmd      "chown root:caddy /etc/caddy/certs/* && chmod 640 /etc/caddy/certs/* && systemctl restart caddy"
sudo systemctl enable --now caddy
```
The `reloadcmd` makes the key readable by the `caddy` user and restarts Caddy —
and re‑applies on every auto‑renewal.

## 6. Lock the reader to localhost

In `/etc/systemd/system/vectorhome-reader.service`:
```ini
Environment=HOST=127.0.0.1
```
```bash
sudo systemctl daemon-reload && sudo systemctl restart vectorhome-reader
```
Now port 3000 is only on localhost; Caddy reaches it, nothing else can.

## 7. Router port-forward

Forward **TCP 8443 → <box-LAN-IP>:8443** (e.g. `192.168.1.50`). Optionally also
**UDP 8443** if you want HTTP/3 (then remove the protocols block in the Caddyfile).

## 8. Keep DuckDNS pointed at your IP

```bash
( crontab -l 2>/dev/null; echo '*/5 * * * * curl -s "https://www.duckdns.org/update?domains=example&token=YOUR-TOKEN&ip="' ) | crontab -
```

## Access URLs

| URL | Result |
|---|---|
| `https://example.duckdns.org:8443` | ✅ the real entry point (valid cert; app login) |
| `http://<box-LAN-IP>:3000` | ✅ direct LAN access — only if `HOST` is **not** set to 127.0.0.1 |
| `https://<box-LAN-IP>:8443` | ❌ cert is for the hostname, not an IP |
| `http://example.duckdns.org:8443` | ❌ that's the HTTPS port; use `https://` |

For HTTPS **on the LAN** by hostname, your router must do hairpin NAT, or add a
local DNS / hosts override: `example.duckdns.org → <box-LAN-IP>`.

## Renewal (automatic)

acme.sh's root cron renews ~60 days before expiry and runs the `reloadcmd`
(re‑copies the cert, fixes perms, restarts Caddy). Check status:
```bash
/root/.acme.sh/acme.sh --list
```

---

## Troubleshooting

Quick health checks:
```bash
sudo systemctl status caddy
sudo journalctl -u caddy -n 30 --no-pager
sudo ss -ltnp | grep -E '8443|3000'        # caddy on 8443, reader on 3000/127.0.0.1
# Test the full chain locally, bypassing DNS/hairpin:
curl -k -i --resolve example.duckdns.org:8443:127.0.0.1 https://example.duckdns.org:8443/   # expect a 302 to /login
```

| Symptom | Cause | Fix |
|---|---|---|
| `FreeDNS requested security code` / "cannot use automatic DNS validation for FreeDNS public domains" | afraid.org *shared/public* domains (e.g. `qc.to`) block automated record changes | Use a DNS provider with an API — **DuckDNS** (this guide) or deSEC |
| acme.sh: `response=KO` (DuckDNS) | Wrong/placeholder `DuckDNS_Token`, or the subdomain isn't in that DuckDNS account | Use the real token; confirm the subdomain exists on duckdns.org |
| Caddy fails: `open …key: permission denied` | Cert key is `600 root:root`; Caddy runs as user `caddy` and can't read it | `chown root:caddy /etc/caddy/certs/* && chmod 640 /etc/caddy/certs/*` (already in the `reloadcmd`), then `systemctl restart caddy` |
| `cat: …/fullchain.cer: No such file` during install-cert | `--install-cert` ran before `--issue` succeeded | Issue the cert first, then install-cert |
| Browser: `SSL_ERROR_RX_RECORD_TOO_LONG` | Used `https://` against the **plain‑HTTP** reader port | Use `http://<ip>:3000` for the raw reader; HTTPS is only on Caddy `:8443` |
| Browser: cert authenticity / name mismatch on `https://<ip>:8443` | The cert is for `example.duckdns.org`, not for a bare IP | Use the hostname URL; for LAN add a hosts/local‑DNS override to the LAN IP |
| Logs in, then **spins forever** (esp. mobile) | Caddy advertises HTTP/3 on UDP 8443 but only **TCP** is forwarded; client stalls on QUIC | Disable HTTP/3 (`servers { protocols h1 h2 }` global block) + `systemctl reload caddy`; reopen in a fresh/private tab (the `alt-svc` hint is cached). Or forward UDP 8443. |
| `502 Bad Gateway` from Caddy | Caddy can't reach the reader | Reader running? `sudo systemctl status vectorhome-reader`; listening on `127.0.0.1:3000`? `sudo ss -ltnp | grep 3000`; `reverse_proxy` target matches |
| Works locally (`curl --resolve …`) but not from cellular | Router forward missing/wrong, or the ISP blocks 8443 | Verify the TCP 8443 forward → LAN IP; try another high port (e.g. 8444) in both the Caddyfile site address and the forward |
| Hostname unreachable from **inside** the LAN only | Router doesn't do hairpin NAT | Add local DNS / hosts: `example.duckdns.org → <box-LAN-IP>`, or use `http://<ip>:3000` at home |
| Stopped working after a while | Public IP changed and DuckDNS is stale, or cert lapsed | Check the DuckDNS updater cron; `--list` for cert dates; `journalctl -u caddy` |
| acme.sh: `too many certificates already issued` | CA rate limit (more likely on shared domains) | Switch CA: add `--server zerossl` (or `--server letsencrypt`) to `--issue` |

## Security notes

- The app has its own login (scrypt-hashed password, optional TOTP 2FA, login
  rate limiting). Use a strong password; set the first-run credential via
  `READER_USERNAME`/`READER_PASSWORD` in the systemd unit.
- Don't commit secrets: the DuckDNS token and acme.sh data live outside this repo;
  the committed `Caddyfile` only carries a bcrypt hash placeholder.
- For brute‑force defense, consider `fail2ban` on the Caddy access log or Caddy's
  rate‑limiting.
