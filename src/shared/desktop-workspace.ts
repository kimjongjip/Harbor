// Appearance only. Never copy drafts, credentials, editor contents or device tokens.
export const desktopPreferenceKeys = [
  "harbor.theme",
  "harbor.typography.v1",
  "harbor.crewAppearance",
  "harbor.sidebarWidth",
  "harbor.ideExplorerWidth",
  "harbor.serverOrder.v1",
  "harbor.usagePanelWidth",
  "harbor.terminalTree",
] as const;
export interface DesktopWorkspace {
  activeId: string;
  page: "hosts" | "terminals" | "files";
  workspaceView: "terminal" | "ide";
  sidebar: "servers" | "files" | "activity" | "research";
  sidebarVisible: boolean;
  preferences: Partial<Record<(typeof desktopPreferenceKeys)[number], string>>;
}
