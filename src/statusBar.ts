/** Status-bar entry behavior: reveal the chat first, then offer extension commands. */
import * as vscode from 'vscode'

export async function handleStatusBarClick(chatVisible: boolean): Promise<void> {
  if (!chatVisible) {
    await vscode.commands.executeCommand('dsh.focusChat')
    return
  }
  await vscode.commands.executeCommand('workbench.action.quickOpen', '>DSH ')
}
