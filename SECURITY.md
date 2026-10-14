# Security Policy

## Reporting a vulnerability

Report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/MarcinWolnyEU/ai-image-router-mcp/security/advisories/new):

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability** (or use the
   [new advisory form](https://github.com/MarcinWolnyEU/ai-image-router-mcp/security/advisories/new)
   directly).
3. Describe the problem, how to reproduce it, and the affected version.

Do not open public issues, discussions or pull requests for security problems. That exposes users
before a fix exists.

## What matters most here

This server holds gateway API tokens and reads and writes files on the machine it runs on. Reports
about these are the most useful:

- a token leaking into logs, tool results or error messages;
- the HTTP transport accepting requests it should refuse (missing or wrong token, a foreign `Host` or
  `Origin`, session handling);
- a tool reading or writing outside the paths the caller was meant to reach;
- a crafted image, ICO or video file that crashes the server or exhausts memory.

## Supported versions

Only the latest release is supported.

## Response time

Reports are acknowledged within 48 hours. You get updates while the issue is investigated and a fix
is prepared.

## Coordinated disclosure

Disclosure is coordinated through the
[GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories) for this
repository. Reporters who want credit are named in the published advisory once a fix is released.
