import type { MessageItem } from "../shared/types.js";

export const agyId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// Scope to a single tmux pane and same-account descendants. Only a live agy
// executable holding exactly one native presence lock can identify a session.
export const agyPresenceProbe = String.raw`import os,sys,re,glob
pending=[int(sys.argv[1])]; seen=set(); sessions=set(); uncertain=False; found_agy=False
presence=os.path.join(os.path.expanduser('~'),'.gemini','antigravity-cli','presence')
while pending and len(seen)<128:
 p=pending.pop()
 if p in seen: continue
 seen.add(p); root='/proc/'+str(p)
 try:
  if os.stat(root).st_uid!=os.getuid(): continue
  exe=os.path.basename(os.readlink(root+'/exe')).split(' (deleted)',1)[0]
  if exe=='agy':
   found_agy=True
   for fd in os.listdir(root+'/fd'):
    try: path=os.readlink(root+'/fd/'+fd)
    except OSError: continue
    if os.path.dirname(path)!=presence: continue
    m=re.fullmatch(r'([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\.lock',os.path.basename(path))
    if m: sessions.add(m.group(1))
   continue
  for f in glob.glob(root+'/task/*/children'):
   with open(f) as data: pending.extend(int(x) for x in data.read().split())
 except FileNotFoundError:
  if p==int(sys.argv[1]): uncertain=True
 except (OSError,ValueError): uncertain=True
print(next(iter(sessions)) if len(sessions)==1 and not pending and not uncertain else 'absent' if not found_agy and not pending and not uncertain else 'unknown')
`;

export function agyStep(line: string): MessageItem | undefined {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
  return speaker(r);
}

function speaker(r: any): MessageItem | undefined {
  if (
    !r ||
    !Number.isSafeInteger(r.step_index) ||
    r.step_index < 0 ||
    typeof r.content !== "string" ||
    !r.content.trim()
  )
    return;
  const id = "agy-step-" + r.step_index;
  if (r.type === "USER_INPUT" && r.source === "USER_EXPLICIT") {
    const wrapped = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(r.content);
    if (!wrapped && r.content.includes("<USER_REQUEST>")) return;
    const text = (
      wrapped ? wrapped[1] : r.content.split("<ADDITIONAL_METADATA>", 1)[0]
    ).trim();
    return text ? { id, kind: "user", text } : undefined;
  }
  if (
    r.type === "PLANNER_RESPONSE" &&
    r.source === "MODEL" &&
    r.status === "DONE"
  )
    return {
      id,
      kind: "assistant",
      text: r.content,
      phase: r.tool_calls?.length ? "commentary" : "final_answer",
      turnStatus: r.tool_calls?.length ? "inProgress" : "completed",
    };
}

/** Native planner calls are followed by ordered GENERIC result steps. IDs use
 * the native step index so overlapping pages and RUNNING -> DONE updates merge. */
export function agyTimelineStep(line: string): MessageItem[] {
  let r;
  try { r = JSON.parse(line); } catch { return []; }
  if (!r || !Number.isSafeInteger(r.step_index) || r.step_index < 0) return [];
  const message = speaker(r);
  const items = message ? [message] : [];
  if (r.source !== "MODEL") return items;
  const id = "agy-step-" + r.step_index;
  if (r.type === "PLANNER_RESPONSE" && r.status === "DONE") {
    if (typeof r.thinking === "string" && r.thinking.trim())
      items.unshift({id: id+"-thought", kind:"tool", text:"추론", status:"completed"});
    if (!Array.isArray(r.tool_calls)) return items;
    for (const [index, call] of r.tool_calls.slice(0, 128).entries()) {
      if (typeof call?.name !== "string") continue;
      const args = call.args || {};
      const label = call.name === "run_command" ? args.CommandLine :
        call.name === "manage_task" ? [args.Action,args.TaskId].filter(v=>typeof v==="string").join(" ") :
        args.Path ?? args.query ?? args.toolSummary;
      items.push({id: id+"-call-"+index, toolUseId:"agy-tool-"+(r.step_index+1+index),
        kind:call.name === "run_command" ? "command" : "tool",status:"started",
        text:(call.name === "run_command" && typeof label === "string" ? label :
          [call.name,typeof label === "string" ? label : ""].filter(Boolean).join(" ")).slice(0,2048)});
    }
  } else if (r.type === "GENERIC" && ["ERROR","DONE","RUNNING"].includes(r.status)) {
    const summary = typeof r.content === "string" ? r.content.match(/^Command exited with code (-?\d+)\./m) : null;
    const failed = r.status === "ERROR" || (!!summary && Number(summary[1]) !== 0);
    const detail = typeof r.error === "string" && r.error ? r.error.slice(0,2048) :
      summary?.[0] ?? (r.status === "RUNNING" ? "백그라운드 실행 중" : failed ? "실패" : "완료");
    items.push({id,kind:"tool",toolUseId:"agy-tool-"+r.step_index,text:"도구 결과",detail,
      status:failed ? "failed" : r.status === "RUNNING" ? "running" : "completed"});
  }
  return items;
}
