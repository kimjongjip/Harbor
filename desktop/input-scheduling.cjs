const deferredInputFeature = "DeferRendererTasksAfterInput";

/** Configure before app.whenReady(): terminal echo arrives over WebSocket.
 * Chromium can defer that response until a paint or its 50 ms input deadline,
 * although the response itself is needed to paint the newly typed character.
 * Leave other Chromium features and any caller-supplied switches untouched.
 */
function configureInputScheduling(commandLine) {
  const current = commandLine.getSwitchValue("disable-features");
  const disabled = current.split(",").map((entry) => entry.trim());
  if (
    disabled.some((entry) => entry.split(/[<:]/, 1)[0] === deferredInputFeature)
  )
    return;
  commandLine.appendSwitch(
    "disable-features",
    current ? `${current},${deferredInputFeature}` : deferredInputFeature,
  );
}

module.exports = { configureInputScheduling };
