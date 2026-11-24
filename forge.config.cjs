module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "session-tape",
    appBundleId: "org.sessiontape.desktop",
    ignore: [/^\/(src|test|out)(\/|$)/, /^\/tsconfig\.json$/],
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin", "linux", "win32"] }],
};
