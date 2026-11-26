import type { MessageItem } from "../shared/types.js";

export const agyId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
// Scope to a single tmux pane and same-account descendants. Only a live agy
// executable holding exactly one native presence lock can identify a session.
export const agyPresenceProbe = String.raw`import os,sys,re,glob
pending=[int(sys.argv[1])]; seen=set(); sessions=set()
presence=os.path.join(os.path.expanduser('~'),'.gemini','antigravity-cli','presence')
while pending and len(seen)<128:
 p=pending.pop()
 if p in seen: continue
 seen.add(p); root='/proc/'+str(p)
 try:
  if os.stat(root).st_uid!=os.getuid(): continue
  exe=os.path.basename(os.readlink(root+'/exe')).split(' (deleted)',1)[0]
  if exe=='agy':
   for fd in os.listdir(root+'/fd'):
    try: path=os.readlink(root+'/fd/'+fd)
    except OSError: continue
    if os.path.dirname(path)!=presence: continue
    m=re.fullmatch(r'([a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})\.lock',os.path.basename(path))
    if m: sessions.add(m.group(1))
   continue
  for f in glob.glob(root+'/task/*/children'):
   with open(f) as data: pending.extend(int(x) for x in data.read().split())
 except (OSError,ValueError): continue
print(next(iter(sessions)) if len(sessions)==1 else '')
`;

export function agyStep(line: string): MessageItem | undefined {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return;
  }
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
