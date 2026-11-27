import type { AgentProvider } from "./agent-provider.js";
import { observedEffort } from "./terminal-usage.js";

export function terminalModelFooter(provider:AgentProvider|undefined, lines:string[]) {
  const rows=lines.map(l=>l.trim()).filter(Boolean);
  if(provider==="antigravity"){
    let rule=rows.length-1;
    while(rule>=0 && !/^[─━]{8,}$/.test(rows[rule])) rule--;
    if(rule<0 || rows.length-rule>5)return;
    const footer=rows.slice(rule+1).join(" ");
    const m=/(?:^|\s)(?:auto|plan|default|accept-edits|turbo|manual)\s*·\s*([^·]{1,100}?)\s*·\s*([\w-]+)(?:\s*·.*)?\s*$/i.exec(footer);
    if(m && observedEffort(m[2])) return {model:m[1].trim(),effort:observedEffort(m[2])};
  }
  if(provider==="codex"){
    for (const row of rows.slice(-4)){
      const match=/^(gpt-[\w.-]+)\s+(\w+)\s*[·•]/i.exec(row);
      if(match && observedEffort(match[2]))return {model:match[1],effort:observedEffort(match[2])};
    }
  }
}
