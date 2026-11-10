import { shellQuote } from "./ssh.js";

/**
 * Claude's native mod replaces only the drawing of a completed AssistantMessage.
 * The transcript and the model request remain unchanged. Harbor paints the
 * selectable typeset block over a native Box of the same measured height.
 *
 * This is an independent implementation of the documented mods API. The
 * ui.render/turn.step approach was compared with the MIT cc-intelligent-ui
 * project; none of that project's renderer, prompts or source is bundled.
 */
export const claudeRichPluginName = "harbor-rich";

export function claudeRichModModule() {
  return String.raw`const LIMIT = 128000;
const KEPT = 64;
const TTL = 1000;
const cache = new Map();
let running = 0;
let generation = 0;
let credentials;
let usagePending = false;
let latestUsage;
let usageTimer;

function watchUsage($) {
  usageTimer?.cancel();
  queueUsage($);
  // The UI animates locally; native metadata needs only a quiet status pulse.
  usageTimer = $.clock.every(2500, () => queueUsage($));
}

function keep(key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > KEPT) cache.delete(cache.keys().next().value);
}

async function connection($) {
  if (!credentials) credentials = Promise.all([
    $.env.get('HARBOR_HOOK_URL'),
    $.env.get('HARBOR_HOOK_TOKEN'),
    $.session.id(),
    $.session.cwd(),
  ]).then(([url, token, sessionId, cwd]) => {
    if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/bridge\/[a-z-]+$/.test(url)
      || typeof token !== 'string' || !token || typeof sessionId !== 'string' || !sessionId) return null;
    return {url: url.replace(/\/[^/]*$/, '/rich'), usageUrl: url.replace(/\/[^/]*$/, '/claude/usage'), token, sessionId, cwd};
  }).catch(() => null);
  return credentials;
}

// Same engine figures as Crew and /cost. No pane, model call or render wait.
// Coalesce bursts of session.measure and do I/O outside the engine hook.
function queueUsage($, value) {
  latestUsage = value;
  if (usagePending) return;
  usagePending = true;
  const epoch = generation;
  $.clock.after(100, async () => {
    try {
      const auth = await connection($);
      if (!auth || epoch !== generation) return;
      let usage = latestUsage || await $.session.usage();
      latestUsage = undefined;
      if (usage.context?.tokens === undefined) {
        usage = await $.session.usage({breakdown: 'summary'}).catch(() => usage);
      }
      if (epoch !== generation) return;
      const context = usage.context;
      const tokens = context?.tokens ?? context?.breakdown?.totalTokens;
      const known = typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0;
      const model = await $.session.model().catch(() => undefined);
      const facts = await $.agent.list().catch(() => undefined);
      if (epoch !== generation) return;
      const clean = (value, length) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, length) : undefined;
      const agents = Array.isArray(facts) ? facts.filter(agent => typeof agent?.id === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(agent.id))
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')).slice(0,32)
        .map(agent => ({id:agent.id,name:clean(agent.name || agent.type,48),status:clean(agent.status,24)})) : undefined;
      const payload = {session_id: auth.sessionId, model: {id: model},
        context_window: {context_window_size: context?.window,
          current_usage: known ? {input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0} : null},
        cost: {total_cost_usd: usage.cost?.usd},
        harbor_context_estimated: context?.tokens === undefined && known,
        harbor_compact_limit: context?.breakdown?.rawMaxTokens,
        harbor_updated_at: await $.clock.now(),
        ...(agents ? {harbor_agents: agents} : {}),
      };
      // A tiny, session-scoped fallback also survives a bridge reconnect and
      // lets an already running older Harbor read the figures without restart.
      const home = await $.env.get('HOME') || await $.env.get('USERPROFILE');
      if (typeof home === 'string' && /^(?:\/|[A-Za-z]:[\\/])/.test(home)
        && /^[A-Za-z0-9-]{1,128}$/.test(auth.sessionId)) {
        await $.fs.write(home.replace(/[\\/]$/, '') + '/.cache/harbor/usage/claude-' + auth.sessionId + '.json', JSON.stringify(payload)).catch(() => {});
      }
      if (epoch !== generation) return;
      await $.http.fetch(auth.usageUrl, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json'},
        body: JSON.stringify(payload),
      });
    } catch { /* Telemetry never interrupts the native session or input. */ }
    finally {
      if (epoch === generation) {
        usagePending = false;
        if (latestUsage) queueUsage($, latestUsage);
      }
    }
  });
}

function reservation(value, columns) {
  if (!value || value.enabled !== true || typeof value.id !== 'string'
    || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.id)
    || typeof value.marker !== 'string' || !/^~HBR:[a-zA-Z0-9_-]{8,40}~$/.test(value.marker)
    || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > 2048
    || !Number.isInteger(value.columns) || value.columns < 40 || value.columns > columns
    || value.marker.length > value.columns) return null;
  return {id: value.id, marker: value.marker, rows: value.rows, columns: value.columns};
}

function queue($, key, item, input, nativeGeneration) {
  if (item.pending) return;
  item.pending = true;
  // A clock callback is retained by Claude after the draw returns. Rendering
  // therefore never waits on a renderer, an SSH tunnel, or a missing window.
  $.clock.after(0, async () => {
    try {
      const auth = await connection($);
      if (!auth || nativeGeneration !== generation || cache.get(key) !== item) return;
      const response = await $.http.fetch(auth.url, {
        method: 'POST',
        headers: {'Authorization': 'Bearer ' + auth.token, 'Content-Type': 'application/json'},
        body: JSON.stringify({...input, sessionId: auth.sessionId, cwd: auth.cwd}),
      });
      const value = response.ok ? JSON.parse(response.text) : null;
      if (nativeGeneration !== generation || cache.get(key) !== item) return;
      item.value = reservation(value, input.columns);
    } catch {
      // Missing/disabled/failed rendering always leaves the native text usable.
      if (nativeGeneration === generation && cache.get(key) === item) item.value = null;
    } finally {
      item.pending = false;
      item.checkedAt = await $.clock.now().catch(() => 0);
      if (nativeGeneration === generation && cache.get(key) === item) $.ui.invalidate('ui.render');
    }
  });
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    generation++;
    cache.clear();
    credentials = undefined;
    running = 0;
    usagePending = false;
    latestUsage = undefined;
    watchUsage($);
    return next(e);
  });

  on('session.measure', ($, e, next) => {
    queueUsage($, e);
    return next(e);
  });

  // /clear and /resume keep the loaded module but change the session identity.
  on('classic.SessionStart', ($, e, next) => {
    generation++;
    cache.clear();
    credentials = undefined;
    running = 0;
    usagePending = false;
    latestUsage = undefined;
    watchUsage($);
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    usageTimer?.cancel();
    usageTimer = undefined;
    generation++;
    cache.clear();
    credentials = undefined;
    latestUsage = undefined;
    usagePending = false;
    return next(e);
  });

  // AssistantMessage has no isStreaming field. Use the real native stream's
  // completion, never an output-idle timer or an ANSI/text scrape. Tool calls,
  // thinking and subagents pass through untouched, with their original result.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e);
    running++;
    const stream = next(e);
    let ended = false;
    try {
      for (;;) {
        const chunk = await stream.next();
        if (chunk.done) {
          ended = true;
          return chunk.value;
        }
        yield chunk.value;
      }
    } finally {
      if (!ended) {
        try { await stream.return?.(); } catch {}
      }
      running = Math.max(0, running - 1);
      $.ui.invalidate('ui.render');
    }
  });

  on('ui.render', {component: 'AssistantMessage'}, async ($, e, next) => {
    const text = e.props?.text;
    const columns = Math.floor(e.viewport?.columns || 0);
    if (e.surface !== 'terminal' || e.props?.isSummary
      || typeof text !== 'string' || !text.trim() || text.length > LIMIT
      || typeof e.requestId !== 'string' || !e.requestId || e.requestId.length > 512
      || columns < 40 || columns > 1000) return next(e);
    const viewportRows = Math.floor(e.viewport?.rows || 0);
    const key = JSON.stringify([e.requestId, text, columns, viewportRows]);
    let item = cache.get(key);
    // Already completed blocks keep their picture while a later reply streams.
    // Only new/changed blocks wait for the active native stream to finish.
    if (running > 0 && !item?.value) return next(e);
    if (!item) {
      item = {value: null, checkedAt: -Infinity, pending: false};
      keep(key, item);
    }
    const now = await $.clock.now();
    if (running === 0 && !item.pending && now - item.checkedAt >= TTL) queue($, key, item, {
      component: 'AssistantMessage', requestId: e.requestId, text, columns, viewportRows, renderer: 'rows-v2',
    }, generation);
    if (!item.value) return next(e);
    const {Box, Text} = $.ui.resolve(e);
    return Box({
      key: 'harbor-rich-' + item.value.id,
      width: item.value.columns, height: item.value.rows,
      flexShrink: 0, flexDirection: 'column', overflow: 'hidden',
      children: Array.from({length: item.value.rows}, (_, row) => Box({
        key: 'harbor-row-' + row, height: 1, flexShrink: 0,
        children: [Text({children: [item.value.marker.slice(0, -1) + ':' + row + '~'], wrap: 'truncate-end'})],
      })),
    });
  }).catch(($, e, next) => next(e));
}
`;
}

/** Generated runtime files have no machine paths, credentials or source text. */
export function claudeRichModFiles(): Record<string, string> {
  return {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: claudeRichPluginName,
      version: "1.0.0",
      description: "Typeset completed replies in the original Harbor terminal",
      author: { name: "Harbor" },
    }),
    "hooks/hooks.json": JSON.stringify({ modules: ["./register.js"] }),
    "hooks/register.js": claudeRichModModule(),
  };
}

/**
 * Call only for an interactive, hook-enabled Claude invocation. The caller
 * appends --plugin-dir $harborRichPath (Windows) / "$harbor_rich" (Bash).
 * Files contain public adapter code; secrets are read only from inherited env.
 * A private temporary directory avoids global Claude settings or plugin state.
 */
export function claudeRichBootstrap(platform: "windows" | "posix") {
  const payload = Buffer.from(
    JSON.stringify(claudeRichModFiles()),
    "utf8",
  ).toString("base64");
  if (platform === "windows") {
    return `$harborRichPath=$null; try { $harborRichPath=[IO.Path]::Combine([IO.Path]::GetTempPath(),('harbor-rich-'+[Guid]::NewGuid().ToString('N'))); [IO.Directory]::CreateDirectory($harborRichPath) | Out-Null; $harborRichFiles=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; foreach($harborRichFile in $harborRichFiles.PSObject.Properties){$harborRichTarget=[IO.Path]::Combine($harborRichPath,$harborRichFile.Name.Replace('/',[IO.Path]::DirectorySeparatorChar)); [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($harborRichTarget)) | Out-Null; [IO.File]::WriteAllText($harborRichTarget,[string]$harborRichFile.Value,[Text.UTF8Encoding]::new($false))} } catch { $harborRichPath=$null };`;
  }
  const python = [
    "import base64,json,os,pathlib,tempfile",
    `files=json.loads(base64.b64decode('${payload}'))`,
    "root=pathlib.Path(tempfile.mkdtemp(prefix='harbor-rich-'))",
    "for name,text in files.items():",
    " path=root/name; path.parent.mkdir(parents=True,exist_ok=True); path.write_text(text,encoding='utf-8')",
    "print(root)",
  ].join("\n");
  return `local harbor_rich=; if command -v python3 >/dev/null 2>&1; then harbor_rich=$(python3 -X utf8 -c ${shellQuote(`exec(${JSON.stringify(python)})`)} 2>/dev/null) || harbor_rich=; fi;`;
}

/** Delete only this invocation's known public files and now-empty directories. */
export function claudeRichCleanup(platform: "windows" | "posix") {
  if (platform === "windows")
    return `if($harborRichPath){try {$harborRichRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); $harborRichResolved=[IO.Path]::GetFullPath($harborRichPath).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar); if([string]::Equals([IO.Path]::GetDirectoryName($harborRichResolved),$harborRichRoot,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($harborRichResolved) -cmatch '^harbor-rich-[0-9a-f]{32}$'){$harborRichSafe=$true; foreach($harborRichDir in @($harborRichResolved,[IO.Path]::Combine($harborRichResolved,'hooks'),[IO.Path]::Combine($harborRichResolved,'.claude-plugin'))){if((Get-Item -LiteralPath $harborRichDir -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint){$harborRichSafe=$false}}; if($harborRichSafe){foreach($harborRichName in @('hooks/register.js','hooks/hooks.json','.claude-plugin/plugin.json')){[IO.File]::Delete([IO.Path]::Combine($harborRichResolved,$harborRichName.Replace('/',[IO.Path]::DirectorySeparatorChar)))}; [IO.Directory]::Delete([IO.Path]::Combine($harborRichResolved,'hooks'),$false); [IO.Directory]::Delete([IO.Path]::Combine($harborRichResolved,'.claude-plugin'),$false); [IO.Directory]::Delete($harborRichResolved,$false)}}}catch{}};`;
  const python = [
    "import pathlib,re,sys,tempfile",
    "root=pathlib.Path(sys.argv[1])",
    "assert root.parent.resolve()==pathlib.Path(tempfile.gettempdir()).resolve() and re.fullmatch(r'harbor-rich-[A-Za-z0-9_-]{8}',root.name)",
    "assert not root.is_symlink() and not (root/'hooks').is_symlink() and not (root/'.claude-plugin').is_symlink()",
    "for name in ['hooks/register.js','hooks/hooks.json','.claude-plugin/plugin.json']: (root/name).unlink(missing_ok=True)",
    "(root/'hooks').rmdir(); (root/'.claude-plugin').rmdir(); root.rmdir()",
  ].join("\n");
  return `if [[ -n "\${harbor_rich:-}" ]]; then command python3 -X utf8 -c ${shellQuote(`exec(${JSON.stringify(python)})`)} "$harbor_rich" >/dev/null 2>&1 || :; fi;`;
}
