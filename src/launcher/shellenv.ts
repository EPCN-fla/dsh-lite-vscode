/**
 * Target-side shell bootstrap: make version-manager-managed Node.js visible
 * to non-interactive shells without polluting stdout (the ACP stream).
 *
 * Background: login shells spawned via wsl.exe source ~/.bash_profile/~/.profile,
 * which often lack nvm (nvm's installer typically edits ~/.bashrc). So we source
 * the version managers explicitly and quietly. PATH-only shims (volta/mise/asdf)
 * are safe; anything sourced gets stdout redirected to keep the protocol clean.
 */
export function posixBootstrap(): string {
  return [
    'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
    '[ -d "$HOME/.volta/bin" ] && export PATH="$HOME/.volta/bin:$PATH"',
    '[ -d "$HOME/.local/share/mise/shims" ] && export PATH="$HOME/.local/share/mise/shims:$PATH"',
    '[ -d "$HOME/.asdf/shims" ] && export PATH="$HOME/.asdf/shims:$PATH"',
    'true',
  ].join('; ')
}

/** Shell-side diagnostic used by the dsh.doctor command. */
export function posixDoctor(): string {
  return [
    posixBootstrap(),
    'echo "node: $(command -v node || echo MISSING)"',
    'node --version 2>&1 | head -1',
    'echo "npx:  $(command -v npx || echo MISSING)"',
    'echo "dsh:  $(command -v dsh || echo MISSING)"',
    'echo "pwd:  $(pwd)"',
  ].join('; ')
}
