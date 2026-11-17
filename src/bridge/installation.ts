/** Target-side bridge package detection, independent of runtime discovery. */
import { readConfig } from '../config.js'
import { runTargetShell } from '../launcher/runTargetShell.js'

export type BridgeInstallationState = 'installed' | 'missing' | 'unknown'

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Check both the profile dependency and its installed package manifest. The
 * cordis.patch.yml contents deliberately play no part: a disabled or broken
 * activation row is a connection problem, not proof that the package is absent.
 */
export function buildBridgeInstallationProbeScript(profile: string, dshHome?: string): string {
  return `${dshHome ? `export DSH_HOME=${shellQuote(dshHome)}\n` : ''}DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME=${shellQuote(profile)}
PROFILE="$DSH_HOME/profiles/$PROFILE_NAME"
if [ -f "$PROFILE/node_modules/dsh-vscode-bridge/package.json" ] \\
  && grep -Eq '"dsh-vscode-bridge"[[:space:]]*:' "$PROFILE/package.json" 2>/dev/null; then
  printf 'installed\\n'
else
  printf 'missing\\n'
fi
`
}

export function parseBridgeInstallationProbe(stdout: string): BridgeInstallationState {
  const value = stdout.trim()
  return value === 'installed' || value === 'missing' ? value : 'unknown'
}

export async function probeBridgeInstallation(): Promise<BridgeInstallationState> {
  try {
    const cfg = readConfig()
    const result = await runTargetShell(buildBridgeInstallationProbeScript(cfg.profile, cfg.env['DSH_HOME']), 15_000)
    return parseBridgeInstallationProbe(result.stdout)
  } catch {
    return 'unknown'
  }
}

export function bridgeSetupPrompt(
  state: BridgeInstallationState,
  startupFailed: boolean,
  profile: string,
): { message: string, actionLabel: string } {
  if (state === 'installed') {
    return {
      message: startupFailed
        ? `DSH: the bridge package is installed in profile "${profile}", but dsh failed to start. Check cordis.patch.yml and the DSH output, or repair the bridge setup.`
        : `DSH: the bridge package is installed in profile "${profile}", but no bridge is connected to this workspace. Check cordis.patch.yml and restart DSH, or repair the bridge setup.`,
      actionLabel: '修复 Bridge',
    }
  }
  if (state === 'missing') {
    return {
      message: startupFailed
        ? `DSH: dsh failed to start and the bridge package was not detected in profile "${profile}". Install the required bridge plugin now?`
        : 'DSH: the dsh-vscode-bridge plugin is required for titles, delete, presets, permission modes and workspace grouping. Install it now?',
      actionLabel: '安装 Bridge',
    }
  }
  return {
    message: startupFailed
      ? 'DSH: dsh failed to start and the bridge installation could not be confirmed. Check DSH Doctor, or run Install/Repair Bridge Plugin.'
      : 'DSH: no bridge is connected to this workspace and the package installation could not be confirmed. Run DSH Doctor, or install/repair the bridge plugin.',
    actionLabel: '安装/修复 Bridge',
  }
}
