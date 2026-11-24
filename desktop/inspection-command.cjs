// A closed grammar for Linux memory and directory listings, not a shell parser.
function isInspectionCommand(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[^\x20-\x7e]/.test(value)
  )
    return false;
  const parts = value.trim().split(/ +&& +/);
  if (parts.length > 12) return false;
  return parts.every((part) => {
    if (part === "free -h") return true;
    const match =
      /^ls +-(?:la|al) +(\/[A-Za-z0-9_/-]+)(?: +2>\/dev\/null)?(?: +\| +head +-n +([1-9][0-9]?|100))?$/.exec(
        part,
      );
    return !!match && match[1].split("/").some(Boolean);
  });
}
module.exports = { isInspectionCommand };
