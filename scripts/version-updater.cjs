/**
 * Teaches commit-and-tag-version how to bump src/version.ts.
 *
 * The version is deliberately a constant in source rather than read from
 * package.json: a compiled binary has no package.json at runtime. That makes it
 * a second place the version lives, and tests/version-updater.test.ts guards
 * this regex so a reformat of version.ts cannot silently desync a release.
 */
const VERSION = /(VERSION\s*=\s*")([^"]+)(")/;

module.exports.readVersion = (contents) => {
  const match = contents.match(VERSION);
  if (!match) throw new Error("no VERSION constant found in src/version.ts");
  return match[2];
};

module.exports.writeVersion = (contents, version) =>
  contents.replace(VERSION, `$1${version}$3`);
