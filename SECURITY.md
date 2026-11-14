# Security

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/adrianjost/tickover/security/advisories/new),
not in a public issue. You'll get an answer within a week.

## Running the server safely

- Put the server behind a reverse proxy with HTTPS (for example Caddy or Traefik) before you
  reach it over the internet. The server itself only speaks plain HTTP, so without HTTPS
  passwords and session tokens travel unencrypted.
- Use a long, unique password for every account.
- Keep the container up to date. A new image is published for every change on `main`.
