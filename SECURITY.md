# Security

Winku can run commands, read and write files, and see your screen, so security problems matter a lot here.

## Reporting a problem

Please don't open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/RyderAsKing/Winku/security/advisories/new) instead. Include what an attacker could do, the steps to reproduce it, and the Winku version.

You'll get a reply within a week. Once a fix ships, the advisory is published with credit to you, unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets fixes. Winku updates itself, so most people are on it within a few hours of a release.

## In scope

- A web page, file, clipboard entry or other content that gets Winku to run a tool the user didn't ask for, or to get around "Ask before running".
- API keys leaving Windows Credential Manager, or anything leaving the machine except for the chosen model provider and Brave Search.
- An update that installs without a valid signature.
