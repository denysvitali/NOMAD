# Security Review: NOMAD Travel Application

**Date:** 2026-03-26
**Repository:** denysvitali/NOMAD (fork of mauriceboe/nomad)
**Scope:** Application source code and GitHub Actions CI/CD workflows

## Introduction

This document records the findings of a security review conducted against the NOMAD travel
application as present in this repository. The review treats the codebase as untrusted code —
meaning no assumption is made that the existing implementation follows secure defaults. All
findings were identified through static analysis of the server-side Node.js application, the
client-side code, and the GitHub Actions workflow definitions. Each finding is assigned a severity
rating (Critical, High, Medium, or Low/Informational), a reference to the affected file and line
range where applicable, and a description of the risk.

Findings within each severity tier are ordered by impact and include both application-layer and
CI/CD issues interleaved, reflecting the reality that supply-chain and infrastructure weaknesses
carry equivalent risk to runtime vulnerabilities.

---

## Critical

---

### 1. Fork CI Pipeline Pushes Docker Images to Upstream Author's Docker Hub

**File:** `.github/workflows/docker.yml:25`

The workflow pushes to `mauriceboe/nomad:latest` — the original upstream author's Docker Hub
namespace. This fork (`denysvitali/NOMAD`) retains this pipeline as-is, meaning that if DockerHub
secrets are configured in this fork's Actions environment, any push to `main` silently overwrites
the image that all existing downstream users pull. This is a textbook supply-chain hijack vector.
A fork should either remove this workflow entirely, change the push target to its own namespace, or
disable GitHub Actions for the repository.

---

### 2. Remote Code Execution via Admin Update Endpoint

**File:** `server/src/routes/admin.js:196-235`

`POST /api/admin/update` executes `git pull origin main`, `npm install`, and `npm run build` via
`child_process.execSync` with no sandboxing. If admin credentials are compromised, or if the
configured git remote or npm registry is poisoned, an attacker gains arbitrary code execution on
the host process under the same privileges as the Node.js server. There is no integrity check on
pulled commits, no package-lock enforcement, and no capability restriction before or after the
shell commands run.

---

### 3. Server-Side Request Forgery (SSRF) in Link Preview

**File:** `server/src/routes/collab.js:441-484`

`GET /collab/link-preview` accepts a user-supplied `url` parameter and performs a server-side HTTP
fetch against it with zero validation. Any authenticated user can use this to scan internal
networks, probe services on loopback or non-routable addresses, and access cloud instance metadata
endpoints such as `http://169.254.169.254/` (AWS/GCP/Azure IMDSv1). There is no protocol
allowlist, no IP-range blocklist, no DNS rebinding mitigation, and no restriction to public
addresses.

---

### 4. Uploaded Files Served Without Authentication

**File:** `server/src/index.js:54`

`app.use('/uploads', express.static(...))` makes the entire uploads directory publicly accessible
with no authentication middleware. Trip documents, passport scans, booking confirmations, and
profile photos are stored under this path. Anyone who can guess or enumerate a valid UUID-based
filename can retrieve private user files without credentials. UUID unpredictability is not a
substitute for access control.

---

### 5. No File Content Validation (Magic Bytes)

**Files:** `server/src/routes/files.js`, `server/src/routes/photos.js`, `server/src/routes/auth.js`, `server/src/routes/collab.js`

All upload handlers validate only file extensions and the `Content-Type` / MIME type fields
submitted by the client. Both are trivially spoofed. No handler performs magic byte inspection of
the actual file content. A malicious file (for example, a PHP script or ELF binary) renamed to
`.jpg` passes every filter and is stored on disk. If the server or a downstream process ever
executes or interprets these files, the impact is code execution.

---

## High

---

### 6. Password Change Without Current Password Verification

**File:** `server/src/routes/auth.js:192-203`

`PUT /api/auth/me/password` accepts a new password and updates the credential record without
requiring the caller to prove knowledge of the current password. A stolen or leaked JWT is
sufficient to silently change the account password and lock out the legitimate owner with no
additional factor required.

---

### 7. JWT Token Exposed in URL Fragment (OIDC Flow)

**File:** `server/src/routes/oidc.js:199`

After a successful OIDC login, the server issues `res.redirect(frontendUrl('/login#token=' + token))`.
Placing the token in the URL fragment makes it visible in browser history, browser extensions with
access to the active tab URL, server-side logs if the fragment leaks (some proxies record it), and
potentially `Referer` headers on subsequent navigations. Tokens delivered this way cannot be
rotated without re-authentication and persist in history after logout.

---

### 8. OIDC Redirect URI Built from Attacker-Controlled Headers

**File:** `server/src/routes/oidc.js:72-74`

The OAuth redirect URI is assembled from the `X-Forwarded-Proto` and `X-Forwarded-Host` request
headers. If the application is not deployed behind a reverse proxy that unconditionally strips and
rewrites these headers, an attacker can craft a request that causes the OIDC provider to redirect
the authorization code to an attacker-controlled host. This enables OAuth authorization-code
interception and token theft.

---

### 9. Collab Note Uploads Have No File Type Filtering

**File:** `server/src/routes/collab.js:11-17`

The `noteUpload` multer configuration omits a `fileFilter` entirely. Any file type — including
`.html`, `.svg`, `.js`, and `.exe` — can be uploaded to the server. Combined with finding #4
(unauthenticated static file serving), an attacker can upload an HTML or SVG file containing
JavaScript and share the direct `/uploads/` URL to execute stored XSS in the victim's browser
with no CSP to block it (see finding #12).

---

### 10. Docker Images Tagged Only as `:latest` — No Versioning

**File:** `.github/workflows/docker.yml:25`

Every push to `main` overwrites the single `:latest` tag. No version or commit-SHA tags are
created. There is no rollback path if a bad commit is pushed, no audit trail linking a running
container to a specific source commit, and no mechanism for downstream users to pin to a known-good
version. A single compromised commit immediately poisons every deployment that relies on the image.

---

### 11. Weak Rate Limiting

**File:** `server/src/routes/auth.js:32-48`

The login rate limiter is implemented as an in-memory `Map` (`loginAttempts`) that resets on every
process restart. It keys on `req.ip`, which, without `trust proxy` configured in Express, resolves
to the proxy's IP address rather than the real client IP when deployed behind a reverse proxy —
effectively disabling the limiter for all clients. There is no distributed backend (Redis or
similar), so the limiter provides no protection in multi-instance deployments or after any service
restart.

---

## Medium

---

### 12. Helmet CSP Disabled

**File:** `server/src/index.js:47`

The Helmet middleware is initialized with `contentSecurityPolicy: false`. Content Security Policy
is a primary browser-enforced defense against XSS. Disabling it means that any injected script —
including those exploitable via finding #9 — executes in users' browsers without restriction.

---

### 13. API Keys Stored in Plaintext in Database

**File:** `server/src/db/database.js`

Google Maps, OpenWeather, and Unsplash API keys, along with the OIDC client secret, are stored as
plaintext strings in the SQLite database. Anyone who obtains a copy of `travel.db` — through
finding #14, a path traversal, a file system backup, or a support dump — immediately has working
credentials for all integrated third-party services, and a valid OIDC client secret that can be
used to impersonate the application.

---

### 14. Backup Contains All Secrets

**File:** `server/src/routes/backup.js`

The backup download endpoint exports the full `travel.db` file, which contains password hashes for
all users, all API keys described in finding #13, and the OIDC client secret. No re-authentication
is required before the backup is served. A session-fixation attack, CSRF, or brief period of
unattended admin access is sufficient to exfiltrate the entire secret store.

---

### 15. `execSync` Import at Module Scope

**File:** `server/src/routes/admin.js:3`

`const { execSync } = require('child_process')` is imported at the top of the module and is
therefore available to every function in the file. If any future or existing code path in this
module is vulnerable to code injection, `execSync` is immediately reachable without any additional
import or capability escalation.

---

### 16. No CSRF Protection

JWT bearer tokens carried in the `Authorization` header provide partial CSRF resistance for JSON
API endpoints, but the OIDC callback route performs no `state` parameter validation and carries no
CSRF token. State-changing form submissions are not guarded. WebSocket upgrade requests pass the
JWT as a query parameter (see finding #17), which bypasses header-based CSRF mitigations
entirely.

---

### 17. WebSocket Token in Query String

**File:** `server/src/websocket.js:38`

The JWT credential is passed as a URL query parameter during the WebSocket handshake. Query
parameters are routinely captured in access logs by web servers, reverse proxies, and CDNs. A
leaked log file exposes valid tokens for all users who used the real-time collaboration feature.

---

### 18. GitHub Actions Pinned to Mutable Version Tags

**File:** `.github/workflows/docker.yml`

The workflow references upstream actions using mutable version tags (`@v4`, `@v3`, `@v6`) rather
than immutable commit SHAs. If an upstream action repository is compromised and its tag is
repointed to a malicious commit, the next CI run will execute attacker-controlled code inside the
Actions runner, which has access to all repository secrets including DockerHub push credentials.

---

### 19. No Security Gates in CI Pipeline

**File:** `.github/workflows/docker.yml`

The pipeline contains no security validation steps. There is no `npm audit` run to surface known
vulnerable dependencies, no SAST tool (CodeQL, Semgrep), no container image vulnerability scanner
(Trivy, Snyk), no Dockerfile linter (Hadolint), no automated tests, and no SBOM generation.
Every commit to `main` proceeds directly from source to a published, publicly pullable Docker
image with no automated checks applied.

---

### 20. Denial of Service via Unbounded In-Memory Caches

**Files:** `server/src/routes/auth.js`, `server/src/routes/maps.js`, `server/src/routes/weather.js`, `server/src/routes/oidc.js`, `server/src/websocket.js`

Multiple subsystems maintain in-memory `Map` objects with no maximum size or eviction policy:
`loginAttempts` (auth), `photoCache` (maps), `weatherCache` (weather), `pendingStates` (OIDC
state nonces), and WebSocket room membership maps. An attacker or high-traffic condition can grow
these structures until the Node.js process exhausts heap memory and crashes, causing a denial of
service.

---

### 21. `express.urlencoded({ extended: true })` Enabled

**File:** `server/src/index.js:51`

The `extended: true` option activates the `qs` library for parsing URL-encoded request bodies,
enabling deeply nested object and array syntax. The `qs` library has a historical record of
prototype pollution vulnerabilities. While recent versions are patched, enabling this parser
unnecessarily widens the attack surface; `extended: false` (the `querystring` module) is
sufficient for the application's use cases.

---

## Low / Informational

---

### 22. `reset-admin.js` Hardcoded Credentials

**File:** `server/reset-admin.js:8`

The admin reset script ships with a hardcoded password of `admin123`. If this script is
accidentally executed in a production environment — for example, during a misconfigured deployment
step — it creates or resets the admin account to a publicly known, trivially guessable credential.

---

### 23. Demo Credentials in Public Endpoint

**File:** `server/src/routes/auth.js:86-87`

When the `DEMO_MODE` environment variable is set to `true`, the `/app-config` endpoint returns
demo account credentials in its JSON response. If `DEMO_MODE` is inadvertently enabled in a
production deployment, any unauthenticated visitor receives working admin credentials directly from
the API.

---

### 24. Docker Container Runs as Root

**File:** `Dockerfile`

The Dockerfile contains no `USER` instruction, so the application process runs as root inside the
container. If a container escape vulnerability is exploited (for example, via a malicious file
upload processed by a vulnerable library), the attacker gains root-level access to the container
host.

---

### 25. `workflow_dispatch` Widens Attack Surface

**File:** `.github/workflows/docker.yml:6`

The `workflow_dispatch` trigger allows any repository collaborator with write access to manually
initiate a build-and-push cycle. This increases the set of individuals who can cause a new image
to be published to DockerHub beyond those who can push directly to `main`.

---

### 26. No Branch Protection Implied

**File:** `.github/workflows/docker.yml`

The workflow triggers on any direct push to `main` with no evidence of required code review,
required status checks, or linear history enforcement in the repository's branch protection rules.
A single developer — or an attacker who has obtained write credentials — can push directly to
`main` and immediately publish a new Docker image with no review gate.

---

## Summary Table

| # | Severity | Category | Issue |
|---|----------|----------|-------|
| 1 | Critical | CI/CD | Fork CI pushes images to upstream author's Docker Hub namespace |
| 2 | Critical | Application | RCE via admin update endpoint running shell commands |
| 3 | Critical | Application | SSRF in link-preview endpoint with no URL validation |
| 4 | Critical | Application | Uploaded files served unauthenticated via static middleware |
| 5 | Critical | Application | No magic byte validation on any file upload handler |
| 6 | High | Application | Password change accepted without verifying current password |
| 7 | High | Application | JWT delivered in URL fragment during OIDC login redirect |
| 8 | High | Application | OIDC redirect URI built from attacker-controllable request headers |
| 9 | High | Application | Collab note uploads have no file type filter (stored XSS vector) |
| 10 | High | CI/CD | Docker images tagged only as `:latest` with no version tags |
| 11 | High | Application | Rate limiter is in-memory only and breaks behind a reverse proxy |
| 12 | Medium | Application | Helmet Content-Security-Policy explicitly disabled |
| 13 | Medium | Application | Third-party API keys and OIDC secret stored in plaintext in SQLite |
| 14 | Medium | Application | Database backup (including all secrets) downloadable without re-auth |
| 15 | Medium | Application | `execSync` imported at module scope in admin route file |
| 16 | Medium | Application | No CSRF protection on OIDC callback or state-changing endpoints |
| 17 | Medium | Application | JWT passed as WebSocket URL query parameter, logged by proxies |
| 18 | Medium | CI/CD | Actions pinned to mutable version tags rather than commit SHAs |
| 19 | Medium | CI/CD | No security gates in CI pipeline (no audit, SAST, or scanning) |
| 20 | Medium | Application | Unbounded in-memory caches enable denial-of-service via memory exhaustion |
| 21 | Medium | Application | `express.urlencoded({ extended: true })` enables prototype-pollution-prone parser |
| 22 | Low | Application | `reset-admin.js` ships with hardcoded `admin123` password |
| 23 | Low | Application | Demo credentials returned in API response when `DEMO_MODE` is set |
| 24 | Low | CI/CD | Docker container runs as root (no `USER` instruction in Dockerfile) |
| 25 | Low | CI/CD | `workflow_dispatch` allows manual image publish by any write-access collaborator |
| 26 | Low | CI/CD | No branch protection implied; direct push to `main` triggers immediate publish |
