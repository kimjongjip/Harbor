export interface TerminalNotice {
  id: string;
  terminalId: string;
  title: string;
  body: string;
  at: number;
  read: boolean;
}
