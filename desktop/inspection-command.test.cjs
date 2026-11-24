const test = require("node:test");
const assert = require("node:assert/strict");
const { isInspectionCommand } = require("./inspection-command.cjs");
const {allowOnce} = require("./antigravity.cjs");
test("Linux ACP may choose only a single allow-once option for the exact inspection", {skip:process.platform!=="linux"},()=>{
  const one={kind:"allow_once",optionId:"once"};
  const input={CommandLine:"free -h && ls -la /data/fixture/ && ls -la /data/fixture/runs/ 2>/dev/null | head -n 40",Cwd:process.cwd()};
  const request={toolCall:{kind:"execute",title:"Run command",rawInput:input},options:[one,{kind:"reject_once",optionId:"no"}]};
  assert.equal(allowOnce(request,"default"),one);
  assert.equal(allowOnce(request,"plan"),undefined);
  assert.equal(allowOnce({...request,options:[{kind:"allow_always",optionId:"yes"}]},"default"),undefined);
  assert.equal(allowOnce({...request,toolCall:{...request.toolCall,rawInput:{...input,command:"free -h"}}},"default"),undefined);
  assert.equal(allowOnce({...request,toolCall:{...request.toolCall,rawInput:{...input,Shell:"custom"}}},"default"),undefined);
});
test("only bounded Linux memory and literal directory listings qualify", () => {
  assert.ok(
    isInspectionCommand(
      "free -h && ls -la /data/fixture/ && ls -la /data/fixture/runs/t0/ 2>/dev/null | head -n 40",
    ),
  );
  for (const command of [
    "ls -la /",
    "free -h; echo foo",
    "ls -la /tmp/../private",
    "ls -la /tmp/.keys",
    "ls -la /tmp/*",
    "ls -la /tmp/ | sh",
    "ls -la /tmp/ > /tmp/file",
    "free -h\n",
    "free -h && rm -r /tmp/foo",
    "ls -la /tmp/$(whoami)",
    "ls -la /tmp/ | head -n 1000",
  ])
    assert.equal(isInspectionCommand(command), false, command);
});
