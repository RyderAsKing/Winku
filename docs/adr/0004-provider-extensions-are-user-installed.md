# Provider extensions are user-installed pi packages

Winku can use model providers that pi doesn't ship, such as a Claude subscription through Claude Code ([pi-claude-code](https://github.com/earendil-works/pi-claude-code)). In Settings > Model you paste an npm package name, a GitHub URL or a folder, and Winku installs that pi package into `extensions\` in its data folder. Its providers then show up in the provider list next to pi's own.

The engine installs the package by running its own binary as Bun (`BUN_BE_BUN=1 winku-engine add --omit peer --ignore-scripts …`), so the user needs no npm, git or pi install. Peer dependencies are skipped because pi's packages come from inside the engine: pi's extension loader maps `@earendil-works/pi-ai`, `pi-coding-agent` and `typebox` to the copies compiled into the binary. Install scripts never run.

Winku loads each package with pi's loader (`discoverAndLoadExtensions`), with both of pi's discovery folders pointed inside `extensions\`, so nothing comes from `~/.pi` or a project's `.pi`. It keeps only the providers the package registers. Its tools, commands and event handlers are never bound to a session. A package that registers no provider, or one whose provider id is already taken, is removed again and the install fails with the reason.

## Considered options

- **Bundle a chosen set.** Pin a few provider extensions in `engine/package.json` and compile them in. Safer and pinned, but every new provider needs a Winku release, and the user asked to install any extension.
- **Use pi's package manager (`DefaultPackageManager`).** It needs npm and git on PATH, and it records packages in pi's settings. Winku users don't have pi installed, and this would bring pi's config back in.
- **Load the whole extension (tools, hooks, commands).** Winku has its own tools, permission gate and prompt layout. Extension tools and hooks would get around "Ask before running", and they could change the system prompt and break prompt caching.

## Consequences

- An extension runs with the user's permissions, inside the engine process, as soon as it loads (at install, at startup when one is installed, and when providers are listed). Settings says to add only ones you trust. This is the one place Winku runs code it didn't ship.
- An extension provider can sign itself in through its own tool (Claude Code's login). The engine asks the provider (`checkAuth`). When it says it is signed in, the UI asks for no key, and a saved key, which would belong to another provider, isn't passed to it.
- A provider extension may reach its own services, and it may start programs (pi-claude-code runs `claude`). Winku can't vouch for what they send. PRIVACY.md says so.
- Extensions aren't pinned by Winku's lockfile: `extensions\bun.lock` records what was installed. To update one, remove it and add it again.
- SPEC §2's "nothing from pi extensions" now means nothing found on its own: only packages the user added in Settings load.
